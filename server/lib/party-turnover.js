'use strict';
/**
 * Unified party turnover for UI «گردش» button.
 * Prefer non-empty customer/supplier books; otherwise merge person_ledger + GL tafsili + rep_ledger.
 * Never short-circuit to an empty customer/supplier book when dual-role / GL / person books have activity.
 */
const { linkedCustomerIds, linkedSupplierIds } = require('./parties-sync');
const { personLedgerLineRial, personLedgerAliveSql } = require('./person-ledger-money');

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
    journal_id: e.journal_id != null ? e.journal_id : null,
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

function buildCustomerTurnover(db, partyId, custIds) {
  const custId = Math.min(...custIds.map(Number));
  try {
    const { ensureCustomerBooksRepaired } = require('./customer-books');
    ensureCustomerBooksRepaired(db);
  } catch (_) { /* repair best-effort */ }
  const rows = db.prepare(`
    SELECT date, entry_type, ref_type, ref_id, description, debit, credit
    FROM customer_ledger WHERE customer_id=?
    ORDER BY created_at ASC, id ASC
  `).all(custId);
  if (!rows.length) return null;
  try {
    const { attachMissingInvoiceRows, stmtEntryType, normalizeStmtRefType, hideVoidedBookRows } = require('./customer-books');
    const tagged = hideVoidedBookRows(db, rows.slice());
    attachMissingInvoiceRows(db, custId, tagged);
    const ENTRY_LABEL = {
      invoice: 'فاکتور فروش', settlement: 'دریافت وجه', sales_return: 'برگشت از فروش',
      reversal: 'ابطال/اصلاح',
      opening: 'مانده اول دوره', invoice_payment: 'دریافت هنگام فاکتور',
      cheque: 'ثبت چک دریافتی', cheque_in: 'ثبت چک دریافتی',
      cheque_endorse: 'خرج/ظهرنویسی چک', cheque_clear: 'وصول چک', cheque_bounce: 'برگشت چک',
      journal: 'سند حسابداری',
    };
    const entries = [];
    let run = 0;
    for (const e of tagged) {
      run += (Number(e.debit) || 0) - (Number(e.credit) || 0);
      let et = e.entry_type || stmtEntryType(e.ref_type, normalizeStmtRefType(e.ref_type));
      if (String(e.ref_type || '') === 'sales_return') et = 'sales_return';
      const label = ENTRY_LABEL[et] || ENTRY_LABEL[e.ref_type] || et || '';
      entries.push({
        date: e.date || '',
        description: [label, e.description].filter(Boolean).join(' — ') || '-',
        type_label: label,
        debit: Math.round(Number(e.debit) || 0),
        credit: Math.round(Number(e.credit) || 0),
        balance: Math.round(run),
        source: 'customer_ledger',
        ref_type: e.ref_type || '',
        ref_id: e.ref_id != null ? e.ref_id : null,
      });
    }
    if (!entries.length) return null;
    return {
      kind: 'customer',
      title: 'گردش مشتری',
      entity_id: custId,
      entries,
      closing: entries[entries.length - 1].balance,
    };
  } catch (_) {
    const entries = [];
    let run = 0;
    for (const e of rows) {
      run += (Number(e.debit) || 0) - (Number(e.credit) || 0);
      pushEntry(entries, {
        date: e.date, description: e.description, type_label: e.entry_type,
        debit: e.debit, credit: e.credit, balance: run, source: 'customer_ledger',
        ref_type: e.ref_type, ref_id: e.ref_id,
      });
    }
    if (!entries.length) return null;
    return {
      kind: 'customer', title: 'گردش مشتری', entity_id: custId,
      entries, closing: entries[entries.length - 1].balance,
    };
  }
}

function buildSupplierTurnoverFromDocs(db, supId) {
  const entries = [];
  try {
    const purchases = db.prepare(`
      SELECT id, date, num, COALESCE(final,0) AS final, note
      FROM purchase_invoices WHERE supplier_id=? AND pay_type='credit'
      ORDER BY date ASC, id ASC
    `).all(supId);
    for (const p of purchases) {
      const amt = Math.round(Number(p.final) || 0);
      if (!amt) continue;
      entries.push({
        date: p.date || '',
        description: `خرید ${p.num || '#' + p.id}${p.note ? ' — ' + p.note : ''}`,
        type_label: 'purchase',
        debit: 0,
        credit: amt,
        source: 'purchase_invoice',
        ref_type: 'purchase',
        ref_id: p.id,
      });
    }
  } catch (_) { /* optional */ }
  try {
    const pays = db.prepare(`
      SELECT id, date, COALESCE(amount,0) AS amount, note
      FROM supplier_payments WHERE supplier_id=?
      ORDER BY date ASC, id ASC
    `).all(supId);
    for (const p of pays) {
      const amt = Math.round(Number(p.amount) || 0);
      if (!amt) continue;
      entries.push({
        date: p.date || '',
        description: `پرداخت به تأمین‌کننده${p.note ? ' — ' + p.note : ''}`,
        type_label: 'payment',
        debit: amt,
        credit: 0,
        source: 'supplier_payment',
        ref_type: 'supplier_payment',
        ref_id: p.id,
      });
    }
  } catch (_) { /* optional */ }
  try {
    const rets = db.prepare(`
      SELECT id, date, COALESCE(amount,0) AS amount, note
      FROM purchase_returns WHERE supplier_id=?
      ORDER BY date ASC, id ASC
    `).all(supId);
    for (const r of rets) {
      const amt = Math.round(Number(r.amount) || 0);
      if (!amt) continue;
      entries.push({
        date: r.date || '',
        description: `برگشت خرید${r.note ? ' — ' + r.note : ''}`,
        type_label: 'return',
        debit: amt,
        credit: 0,
        source: 'purchase_return',
        ref_type: 'purchase_return',
        ref_id: r.id,
      });
    }
  } catch (_) { /* optional */ }
  if (!entries.length) return null;
  entries.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  const out = [];
  for (const e of entries) pushEntry(out, e);
  recomputeRunning(out);
  return {
    kind: 'supplier',
    title: 'گردش تأمین‌کننده',
    entity_id: supId,
    entries: out,
    closing: out.length ? out[out.length - 1].balance : 0,
  };
}

function buildSupplierTurnover(db, partyId, supIds) {
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
  if (rows.length) {
    const entries = [];
    for (const r of rows) {
      pushEntry(entries, { ...r, source: 'supplier_ledger' });
    }
    if (entries.every((e) => e.balance === 0 || e.balance == null)) {
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
  // Legacy / incomplete books: derive from purchase docs so UI is never empty while balance exists
  return buildSupplierTurnoverFromDocs(db, supId);
}

/**
 * person_ledger rows often mirror JE with ref_id = journal_entries.id while JE.ref_id
 * may be null (manual vouchers) or a business id. Prefer matching journal_id.
 */
function personLedgerCoveredByGl(merged, plRow, amt) {
  const rid = plRow.ref_id != null ? String(plRow.ref_id) : '';
  const rt = String(plRow.ref_type || '');
  const payrollish = /payroll/.test(rt);
  return merged.some((e) => {
    if (e.source !== 'gl') return false;
    if (rid) {
      if (e.journal_id != null && String(e.journal_id) === rid) return true;
      if (rt && e.ref_type === rt && e.ref_id != null && String(e.ref_id) === rid) return true;
    }
    // Payroll often shares amounts across JE/PL when ref_id points at payment row not JE id
    if (
      payrollish
      && String(e.date || '') === String(plRow.date || '')
      && Math.abs(e.debit - amt.debit) <= 1
      && Math.abs(e.credit - amt.credit) <= 1
    ) {
      return true;
    }
    return false;
  });
}

function buildMergedPersonTurnover(db, party, partyId) {
  const personId = ensurePersonForParty(db, partyId);
  const merged = [];

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
        journal_id: r.je_id,
      });
    }
  }

  if (personId) {
    const alive = personLedgerAliveSql(db);
    const pl = db.prepare(`
      SELECT date, entry_type, ref_type, ref_id, description, debit, credit, created_at, id
      FROM person_ledger pl WHERE person_id=? AND ${alive} ORDER BY date ASC, id ASC
    `).all(personId);
    for (const r of pl) {
      const amt = personLedgerLineRial(db, r);
      if (personLedgerCoveredByGl(merged, r, amt)) continue;
      merged.push({
        date: r.date || '',
        description: r.description || r.entry_type || 'دفتر شخص',
        type_label: r.entry_type || '',
        debit: amt.debit,
        credit: amt.credit,
        created_at: r.created_at || 0,
        source: 'person_ledger',
        ref_type: r.ref_type || '',
        ref_id: r.ref_id,
        journal_id: null,
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
          journal_id: null,
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

function buildPartyTurnover(db, partyId) {
  const party = db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
  if (!party) return null;

  const custIds = linkedCustomerIds(db, partyId);
  if (custIds.length) {
    const cust = buildCustomerTurnover(db, partyId, custIds);
    if (cust && cust.entries && cust.entries.length) return cust;
  }

  const supIds = linkedSupplierIds(db, partyId);
  if (supIds.length) {
    const sup = buildSupplierTurnover(db, partyId, supIds);
    if (sup && sup.entries && sup.entries.length) return sup;
  }

  return buildMergedPersonTurnover(db, party, partyId);
}

module.exports = {
  ensurePersonForParty,
  resolvePersonIdFromVoucherLine,
  buildPartyTurnover,
  personLedgerCoveredByGl,
};
