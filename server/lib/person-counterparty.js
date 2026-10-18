'use strict';
/**
 * Cash and accrual that belong to a named rep must hit that person's leaf
 * COA + person_ledger (same rule as payroll / پرداخت به شخص).
 *
 * Pooled 2107 / 1107 never appear on گردش شخص, so a bank payment can show on
 * the bank statement and the incentive report while the person's statement
 * stays empty. v449 moves the counterparty line onto the leaf when the rep
 * is linked to a party with its own coa_code. No leaf → pooled account stays.
 *
 * rep_ledger remains the operational commission book. It is not merged into
 * گردش (ADR-PARTY-001 §13). The statement shows the document because the
 * journal line is on the person's own account.
 */

const { acct } = require('./coa-map');

const POOLED_KEYS = ['coa_rep_commission_payable', 'coa_rep_advance'];

const RECLASS_REF_TYPES = [
  'incentive_payment',
  'rep_settlement',
  'rep_advance',
  'commission_accrual_invoice',
  'commission_accrual_settlement',
];

function pooledCodes(db) {
  const codes = new Set();
  for (const key of POOLED_KEYS) {
    try {
      const a = acct(db, key);
      if (a && a.code) codes.add(String(a.code));
    } catch (_) { /* mapping optional */ }
  }
  return codes;
}

function resolveRepPersonLeaf(db, repId) {
  const id = Number(repId);
  if (!id) return null;
  const user = db.prepare('SELECT id, name, party_id FROM users WHERE id=?').get(id);
  if (!user || !user.party_id) return null;
  let person = db.prepare(
    'SELECT * FROM persons WHERE party_id=? ORDER BY id ASC LIMIT 1'
  ).get(user.party_id);
  if (!person) {
    try {
      const { ensurePersonForParty } = require('./party-turnover');
      const pid = ensurePersonForParty(db, user.party_id);
      if (pid) person = db.prepare('SELECT * FROM persons WHERE id=?').get(pid);
    } catch (_) { /* optional */ }
  }
  if (!person) return null;
  let code = person.coa_code ? String(person.coa_code) : '';
  if (!code) {
    const party = db.prepare('SELECT coa_code FROM parties WHERE id=?').get(user.party_id);
    code = party && party.coa_code ? String(party.coa_code) : '';
  }
  if (!code) return null;
  const account = db.prepare(
    'SELECT code, name FROM chart_of_accounts WHERE code=?'
  ).get(code);
  if (!account) return null;
  return { user, person, account: { code: account.code, name: account.name } };
}

/** Person leaf when linked; otherwise the pooled control (2107 / 1107 / …). */
function counterpartyAccount(db, repId, fallbackKey) {
  const leaf = resolveRepPersonLeaf(db, repId);
  if (leaf) return { ...leaf, pooled: false };
  return { user: null, person: null, account: acct(db, fallbackKey), pooled: true };
}

function mirrorPersonMovement(db, row) {
  const personId = Number(row && row.personId);
  const refId = Number(row && row.refId);
  const refType = String((row && row.refType) || '');
  const entryType = String((row && row.entryType) || refType);
  if (!personId || !refId || !refType) return 0;
  const debit = Math.round(Number(row.debit) || 0);
  const credit = Math.round(Number(row.credit) || 0);
  const date = row.date || '';
  const description = row.description || '';
  const userId = row.userId || null;
  let existing = null;
  try {
    existing = db.prepare(`
      SELECT id FROM person_ledger
      WHERE person_id=? AND ref_type=? AND ref_id=? AND entry_type=?
        AND COALESCE(deleted_at,0)=0
      ORDER BY id ASC LIMIT 1
    `).get(personId, refType, refId, entryType);
  } catch (_) {
    existing = db.prepare(`
      SELECT id FROM person_ledger
      WHERE person_id=? AND ref_type=? AND ref_id=? AND entry_type=?
      ORDER BY id ASC LIMIT 1
    `).get(personId, refType, refId, entryType);
  }
  if (existing) {
    db.prepare(`
      UPDATE person_ledger
      SET date=?, description=?, debit=?, credit=?, user_id=COALESCE(?, user_id)
      WHERE id=?
    `).run(date, description, debit, credit, userId, existing.id);
    return existing.id;
  }
  const info = db.prepare(`
    INSERT INTO person_ledger
      (person_id, date, entry_type, ref_type, ref_id, description, debit, credit, user_id)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(personId, date, entryType, refType, refId, description, debit, credit, userId);
  return info.lastInsertRowid;
}

function repIdForEntry(db, je) {
  const id = Number(je && je.ref_id);
  const refType = String((je && je.ref_type) || '');
  if (!id) return null;
  try {
    if (refType === 'incentive_payment' || refType === 'rep_settlement') {
      const row = db.prepare('SELECT rep_id FROM incentive_payments WHERE id=?').get(id);
      return row ? row.rep_id : null;
    }
    if (refType === 'rep_advance') {
      const row = db.prepare('SELECT rep_id FROM rep_advances WHERE id=?').get(id);
      return row ? row.rep_id : null;
    }
    if (refType === 'commission_accrual_invoice') {
      const row = db.prepare('SELECT user_id FROM invoices WHERE id=?').get(id);
      return row ? row.user_id : null;
    }
    if (refType === 'commission_accrual_settlement') {
      const row = db.prepare(`
        SELECT i.user_id AS rep_id
        FROM settlements s
        JOIN invoices i ON i.id = s.invoice_id
        WHERE s.id=?
      `).get(id);
      return row ? row.rep_id : null;
    }
  } catch (_) {
    return null;
  }
  return null;
}

/**
 * One-shot: live rep cash/accrual lines sitting on 2107/1107 move onto the
 * person's leaf, and person_ledger receives the same rial amount.
 * Bank, fee, and expense lines are left alone. Amounts do not change.
 */
function reclassRepCounterpartyToPerson(db) {
  const pooled = pooledCodes(db);
  const stats = { moved: 0, mirrored: 0, skipped: 0 };
  if (!pooled.size) return stats;
  const ph = RECLASS_REF_TYPES.map(() => '?').join(',');
  let entries = [];
  try {
    entries = db.prepare(`
      SELECT id, ref_type, ref_id, entry_date, description
      FROM journal_entries
      WHERE ref_type IN (${ph})
        AND COALESCE(deleted_at,0)=0
        AND COALESCE(status,'posted') NOT IN ('reversed','void')
    `).all(...RECLASS_REF_TYPES);
  } catch (_) {
    return stats;
  }
  const run = () => {
    for (const je of entries) {
      const repId = repIdForEntry(db, je);
      const leaf = repId ? resolveRepPersonLeaf(db, repId) : null;
      if (!leaf) {
        stats.skipped += 1;
        continue;
      }
      const lines = db.prepare(`
        SELECT id, account_code, debit_rial, credit_rial, debit, credit
        FROM journal_lines WHERE entry_id=?
      `).all(je.id);
      for (const line of lines) {
        if (!pooled.has(String(line.account_code))) continue;
        if (String(line.account_code) !== String(leaf.account.code)) {
          db.prepare(`
            UPDATE journal_lines SET account_code=?, account_name=? WHERE id=?
          `).run(leaf.account.code, leaf.account.name, line.id);
          stats.moved += 1;
        }
        let debit = Math.round(Number(line.debit_rial) || 0);
        let credit = Math.round(Number(line.credit_rial) || 0);
        if (!debit && !credit) {
          debit = Math.round((Number(line.debit) || 0) * 10);
          credit = Math.round((Number(line.credit) || 0) * 10);
        }
        mirrorPersonMovement(db, {
          personId: leaf.person.id,
          date: je.entry_date,
          entryType: je.ref_type,
          refType: je.ref_type,
          refId: je.ref_id,
          description: je.description,
          debit,
          credit,
        });
        stats.mirrored += 1;
      }
    }
    return stats;
  };
  if (db.inTransaction) return run();
  return db.transaction(run)();
}

module.exports = {
  POOLED_KEYS,
  RECLASS_REF_TYPES,
  pooledCodes,
  resolveRepPersonLeaf,
  counterpartyAccount,
  mirrorPersonMovement,
  repIdForEntry,
  reclassRepCounterpartyToPerson,
};
