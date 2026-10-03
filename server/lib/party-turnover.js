'use strict';
/**
 * Unified party turnover for UI «گردش» button.
 * Prefer customer/supplier books; for other parties merge person_ledger + GL tafsili + rep_ledger.
 */
const { linkedCustomerIds, linkedSupplierIds } = require('./parties-sync');

function ensurePersonForParty(db, partyId) {
  const party = db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
  if (!party) return null;
  const byParty = db.prepare('SELECT id FROM persons WHERE party_id=?').get(partyId);
  if (byParty) return byParty.id;
  try {
    const synced = require('./party-employee-sync').syncPartyToPerson(db, partyId);
    if (synced) return synced;
  } catch (_) { /* optional */ }
  const name = party.full_name || party.biz || party.company_name || '';
  if (!name) return null;
  const r = db.prepare(`
    INSERT INTO persons (name, phone, address, note, party_id, party_group_id, national_id, birth_date, coa_code, active)
    VALUES (?,?,?,?,?,?,?,?,?,1)
  `).run(
    name, party.phone || '', party.address || '', party.notes || '', partyId,
    party.party_group_id || null, party.national_id || '', party.birth_date || '', party.coa_code || ''
  );
  return r.lastInsertRowid;
}

function resolvePersonIdFromVoucherLine(db, line) {
  // UI partySelect emits parties.id — prefer party_id so we never credit the wrong persons.id
  const partyId = line && line.party_id != null ? Number(line.party_id) : 0;
  if (partyId > 0) return ensurePersonForParty(db, partyId);
  const personId = line && line.person_id != null ? Number(line.person_id) : 0;
  if (personId > 0) {
    const row = db.prepare('SELECT id FROM persons WHERE id=?').get(personId);
    if (row) return row.id;
  }
  return null;
}

function pushEntry(out, e) {
  out.push({
    date: e.date || '',
    description: e.description || e.type_label || '-',
    type_label: e.type_label || e.entry_type || '',
    debit: Math.round(Number(e.debit) || 0),
    credit: Math.round(Number(e.credit) || 0),
    balance: Math.round(Number(e.balance != null ? e.balance : e.running_balance) || 0),
    source: e.source || '',
    ref_type: e.ref_type || '',
    ref_id: e.ref_id != null ? e.ref_id : null,
  });
}

function recomputeRunning(rows) {
  let run = 0;
  for (const e of rows) {
    run += (e.debit || 0) - (e.credit || 0);
    e.balance = run;
  }
  return rows;
}

function buildPartyTurnover(db, partyId) {
  const party = db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
  if (!party) return null;

  const custIds = linkedCustomerIds(db, partyId);
  if (custIds.length) {
    const custId = Math.min(...custIds.map(Number));
    const { buildStatement } = require('../routes/accounting');
    const data = buildStatement(db, custId, {});
    if (!data) {
      return { kind: 'customer', title: 'گردش مشتری', entity_id: custId, entries: [], closing: 0 };
    }
    const entries = (data.entries || []).map((e) => ({
      date: e.date || '',
      description: [e.type_label, e.description].filter(Boolean).join(' — ') || '-',
      type_label: e.type_label || '',
      debit: Math.round(Number(e.debit) || 0),
      credit: Math.round(Number(e.credit) || 0),
      balance: Math.round(Number(e.running_balance) || 0),
      source: 'customer_ledger',
      ref_type: e.ref_type || '',
      ref_id: e.ref_id != null ? e.ref_id : null,
    }));
    return {
      kind: 'customer',
      title: 'گردش مشتری',
      entity_id: custId,
      entries,
      closing: Math.round(Number(data.closing) || 0),
      books_mismatch: !!data.books_mismatch,
    };
  }

  const supIds = linkedSupplierIds(db, partyId);
  if (supIds.length) {
    const supId = Math.min(...supIds.map(Number));
    let rows = [];
    try {
      rows = db.prepare(`
        SELECT date, description, debit, credit, balance, ref_type, ref_id
        FROM supplier_ledger WHERE supplier_id=? ORDER BY date ASC, id ASC
      `).all(supId);
    } catch (_) {
      rows = [];
    }
    const entries = [];
    for (const r of rows) {
      pushEntry(entries, { ...r, source: 'supplier_ledger' });
    }
    if (entries.length && entries.every((e) => e.balance === 0 || e.balance == null)) {
      recomputeRunning(entries);
    }
    return {
      kind: 'supplier',
      title: 'گردش تأمین‌کننده',
      entity_id: supId,
      entries,
      closing: entries.length ? entries[entries.length - 1].balance : 0,
    };
  }

  const personId = ensurePersonForParty(db, partyId);
  const merged = [];
  const seenPlRefs = new Set();

  if (personId) {
    const pl = db.prepare(`
      SELECT date, entry_type, ref_type, ref_id, description, debit, credit, created_at, id
      FROM person_ledger WHERE person_id=? ORDER BY date ASC, id ASC
    `).all(personId);
    for (const r of pl) {
      seenPlRefs.add(`${r.ref_type}|${r.ref_id}|${Math.round(Number(r.debit) || 0)}|${Math.round(Number(r.credit) || 0)}`);
      merged.push({
        date: r.date || '',
        description: r.description || r.entry_type || 'دفتر شخص',
        type_label: r.entry_type || '',
        debit: Math.round(Number(r.debit) || 0),
        credit: Math.round(Number(r.credit) || 0),
        created_at: r.created_at || 0,
        source: 'person_ledger',
        ref_type: r.ref_type || '',
        ref_id: r.ref_id,
      });
    }
  }

  const person = personId ? db.prepare('SELECT coa_code FROM persons WHERE id=?').get(personId) : null;
  const coa = (person && person.coa_code) || party.coa_code;
  if (coa) {
    const glRows = db.prepare(`
      SELECT je.entry_date AS date, je.ref_type, je.ref_id, je.description, je.created_at, je.id AS je_id,
             COALESCE(jl.debit_rial, ROUND(COALESCE(jl.debit,0)*10), 0) AS debit,
             COALESCE(jl.credit_rial, ROUND(COALESCE(jl.credit,0)*10), 0) AS credit
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.account_code = ?
        AND COALESCE(je.deleted_at,0)=0
        AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
      ORDER BY je.entry_date ASC, je.id ASC, jl.id ASC
    `).all(String(coa));
    for (const r of glRows) {
      const refKey = `${r.ref_type}|${r.ref_id}|${Math.round(Number(r.debit) || 0)}|${Math.round(Number(r.credit) || 0)}`;
      if (seenPlRefs.has(refKey)) continue;
      merged.push({
        date: r.date || '',
        description: r.description || 'سند دفتر کل',
        type_label: r.ref_type || 'journal',
        debit: Math.round(Number(r.debit) || 0),
        credit: Math.round(Number(r.credit) || 0),
        created_at: r.created_at || 0,
        source: 'gl',
        ref_type: r.ref_type || '',
        ref_id: r.ref_id,
      });
    }
  }

  const user = db.prepare('SELECT id, name, role FROM users WHERE party_id=?').get(partyId);
  if (user) {
    try {
      const rl = db.prepare(`
        SELECT date, entry_type, ref_type, ref_id, description, debit, credit, created_at, id
        FROM rep_ledger WHERE rep_id=? ORDER BY date ASC, id ASC
      `).all(user.id);
      for (const r of rl) {
        merged.push({
          date: r.date || '',
          description: `${r.description || r.entry_type || 'دفتر بازاریاب'} — ${user.name || ''}`.trim(),
          type_label: r.entry_type || '',
          debit: Math.round(Number(r.debit) || 0),
          credit: Math.round(Number(r.credit) || 0),
          created_at: r.created_at || 0,
          source: 'rep_ledger',
          ref_type: r.ref_type || '',
          ref_id: r.ref_id,
        });
      }
    } catch (_) { /* rep_ledger optional */ }
  }

  merged.sort((a, b) => {
    const da = String(a.date || '');
    const dbDate = String(b.date || '');
    if (da !== dbDate) return da.localeCompare(dbDate);
    return (Number(a.created_at) || 0) - (Number(b.created_at) || 0);
  });

  recomputeRunning(merged);
  const entries = [];
  for (const r of merged) pushEntry(entries, r);

  return {
    kind: 'person',
    title: 'گردش شخص',
    entity_id: personId,
    user_id: user ? user.id : null,
    entries,
    closing: entries.length ? entries[entries.length - 1].balance : 0,
  };
}

module.exports = {
  ensurePersonForParty,
  resolvePersonIdFromVoucherLine,
  buildPartyTurnover,
};
