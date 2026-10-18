'use strict';
/**
 * Unified party turnover for UI «گردش» button.
 *
 * SoT (ADR-PARTY-001 + v439): ending balance MUST match partySignedBalanceDetailMap.
 * - Include header/suppliers opening fold as a synthetic line when missing from subledger.
 * - Union ALL linked customer/supplier ids (never Math.min-only).
 * - Default = merge all role books so net closing = dashboard مانده.
 * - Optional ?role=customer|supplier|person for a single leaf (closing = that leaf).
 * - Docs fallback (PO/payment) only when supplier_ledger empty; still gap-aligned to books.
 */
const { linkedCustomerIds, linkedSupplierIds } = require('./parties-sync');
const { personLedgerLineRial, personLedgerAliveSql } = require('./person-ledger-money');
const { sortReportRows, sumDebitCredit } = require('./report-order');
const { partySignedBalanceDetailMap } = require('./party-books');

function withTotals(payload) {
  if (!payload) return payload;
  return { ...payload, ...sumDebitCredit(payload.entries) };
}

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

function signedSum(entries) {
  let s = 0;
  for (const e of entries) s += (Number(e.debit) || 0) - (Number(e.credit) || 0);
  return Math.round(s);
}

/** Leaf signed balance from party-books detail (one source), or 0. */
function leafSignedFromDetail(detail, source) {
  if (!detail) return 0;
  const leaves = Array.isArray(detail.leaves) ? detail.leaves : [];
  const matched = leaves.filter((l) => l && l.source === source);
  if (matched.length) {
    return Math.round(matched.reduce((s, l) => s + (Number(l.balance) || 0), 0));
  }
  if (detail.source === source) return Math.round(Number(detail.balance) || 0);
  return 0;
}

/**
 * Prepend synthetic opening so entry stream sums to targetSigned (party-books leaf/net).
 * Positive target extras → بدهکار؛ negative → بستانکار.
 */
function alignEntriesToTarget(entries, targetSigned, meta) {
  const list = Array.isArray(entries) ? entries.slice() : [];
  const cur = signedSum(list);
  const gap = Math.round(Number(targetSigned) || 0) - cur;
  if (Math.abs(gap) <= 1) return list;
  const debit = gap > 0 ? gap : 0;
  const credit = gap < 0 ? -gap : 0;
  list.unshift({
    date: (meta && meta.date) || '',
    description: (meta && meta.description) || 'مانده اول دوره / تطبیق با دفتر زنده',
    type_label: 'opening',
    debit,
    credit,
    source: (meta && meta.source) || 'opening_fold',
    ref_type: 'opening_balance',
    ref_id: null,
    journal_id: null,
  });
  return list;
}

function finalizeTurnover(kind, title, entityId, rawEntries, closingTarget, extra) {
  const aligned = alignEntriesToTarget(rawEntries, closingTarget, {
    description: 'مانده اول دوره / تطبیق با دفتر زنده',
    source: 'opening_fold',
  });
  if (!aligned.length && Math.round(Number(closingTarget) || 0) === 0) return null;
  const out = [];
  for (const e of aligned) pushEntry(out, e);
  recomputeRunning(out);
  const closing = Math.round(Number(closingTarget) || 0);
  // Force last balance to SoT (≤1 rial noise already handled by align)
  if (out.length) out[out.length - 1].balance = closing;
  return withTotals({
    kind,
    title,
    entity_id: entityId,
    entries: out,
    closing,
    books_closing: closing,
    ...(extra || {}),
  });
}

function buildCustomerTurnover(db, partyId, custIds, detail) {
  const ids = (custIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) return null;
  try {
    const { ensureCustomerBooksRepaired } = require('./customer-books');
    ensureCustomerBooksRepaired(db);
  } catch (_) { /* repair best-effort */ }

  const ENTRY_LABEL = {
    invoice: 'فاکتور فروش', settlement: 'دریافت وجه', sales_return: 'برگشت از فروش',
    reversal: 'ابطال/اصلاح',
    opening: 'مانده اول دوره', invoice_payment: 'دریافت هنگام فاکتور',
    cheque: 'ثبت چک دریافتی', cheque_in: 'ثبت چک دریافتی',
    cheque_endorse: 'خرج/ظهرنویسی چک', cheque_clear: 'وصول چک', cheque_bounce: 'برگشت چک',
    journal: 'سند حسابداری',
  };

  let tagged = [];
  const primaryCust = Math.min(...ids);
  try {
    const { attachMissingInvoiceRows, stmtEntryType, normalizeStmtRefType, hideVoidedBookRows } = require('./customer-books');
    for (const custId of ids) {
      const rows = db.prepare(`
        SELECT id, date, created_at, entry_type, ref_type, ref_id, description, debit, credit
        FROM customer_ledger WHERE customer_id=?
        ORDER BY date ASC, created_at ASC, id ASC
      `).all(custId);
      if (!rows.length) continue;
      const part = hideVoidedBookRows(db, rows.slice());
      attachMissingInvoiceRows(db, custId, part);
      tagged = tagged.concat(part);
    }
    sortReportRows(tagged, { date: 'date', dir: 'asc' });
    const raw = [];
    for (const e of tagged) {
      let et = e.entry_type || stmtEntryType(e.ref_type, normalizeStmtRefType(e.ref_type));
      if (String(e.ref_type || '') === 'sales_return') et = 'sales_return';
      const label = ENTRY_LABEL[et] || ENTRY_LABEL[e.ref_type] || et || '';
      raw.push({
        date: e.date || '',
        description: [label, e.description].filter(Boolean).join(' — ') || '-',
        type_label: label,
        debit: Math.round(Number(e.debit) || 0),
        credit: Math.round(Number(e.credit) || 0),
        source: 'customer_ledger',
        ref_type: e.ref_type || '',
        ref_id: e.ref_id != null ? e.ref_id : null,
      });
    }
    const hasLeaf = !!(detail && (
      detail.source === 'customer'
      || (detail.leaves || []).some((l) => l && l.source === 'customer')
    ));
    const target = leafSignedFromDetail(detail, 'customer');
    if (!raw.length) {
      if (hasLeaf && Math.abs(target) > 1) {
        return finalizeTurnover('customer', 'گردش مشتری', primaryCust, [], target, { customer_ids: ids });
      }
      return null;
    }
    const closing = hasLeaf ? target : signedSum(raw);
    return finalizeTurnover('customer', 'گردش مشتری', primaryCust, raw, closing, { customer_ids: ids });
  } catch (_) {
    const raw = [];
    for (const custId of ids) {
      const rows = db.prepare(`
        SELECT id, date, created_at, entry_type, ref_type, ref_id, description, debit, credit
        FROM customer_ledger WHERE customer_id=?
        ORDER BY date ASC, created_at ASC, id ASC
      `).all(custId);
      for (const e of rows) {
        raw.push({
          date: e.date, description: e.description, type_label: e.entry_type,
          debit: Math.round(Number(e.debit) || 0), credit: Math.round(Number(e.credit) || 0),
          source: 'customer_ledger', ref_type: e.ref_type, ref_id: e.ref_id,
        });
      }
    }
    const hasLeaf = !!(detail && (
      detail.source === 'customer'
      || (detail.leaves || []).some((l) => l && l.source === 'customer')
    ));
    const target = leafSignedFromDetail(detail, 'customer');
    if (!raw.length) {
      if (hasLeaf && Math.abs(target) > 1) {
        return finalizeTurnover('customer', 'گردش مشتری', primaryCust, [], target, { customer_ids: ids });
      }
      return null;
    }
    sortReportRows(raw, { date: 'date', dir: 'asc' });
    const closing = hasLeaf ? target : signedSum(raw);
    return finalizeTurnover('customer', 'گردش مشتری', primaryCust, raw, closing, { customer_ids: ids });
  }
}

function buildSupplierTurnoverFromDocs(db, supIds) {
  const entries = [];
  const ids = (supIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  for (const supId of ids) {
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
          id: p.id,
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
          id: p.id,
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
          id: r.id,
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
  }
  if (!entries.length) return [];
  sortReportRows(entries, { date: 'date', dir: 'asc' });
  return entries;
}

function buildSupplierTurnover(db, partyId, softIds, detail) {
  const supIds = (softIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!supIds.length) return null;
  const primarySup = Math.min(...supIds);

  let rows = [];
  try {
    for (const sid of supIds) {
      const part = db.prepare(`
        SELECT id, date, created_at, description, debit, credit, balance, ref_type, ref_id, entry_type
        FROM supplier_ledger WHERE supplier_id=? ORDER BY date ASC, created_at ASC, id ASC
      `).all(sid);
      rows = rows.concat(part.map((r) => ({ ...r, _supplier_id: sid })));
    }
  } catch (_) {
    rows = [];
  }

  const target = leafSignedFromDetail(detail, 'supplier');
  // Opening-only supplier leaf: detail may report source=opening with balance on header coa
  let closingTarget = target;
  if (!closingTarget && detail) {
    const hasSupLeaf = (detail.leaves || []).some((l) => l.source === 'supplier');
    if (!hasSupLeaf && detail.source === 'opening' && Math.abs(Number(detail.balance) || 0) > 0 && softIds.length) {
      closingTarget = Math.round(Number(detail.balance) || 0);
    }
  }

  let raw = [];
  let fromDocs = false;
  if (rows.length) {
    sortReportRows(rows, { date: 'date', dir: 'asc' });
    for (const r of rows) {
      raw.push({
        date: r.date || '',
        description: r.description || '-',
        type_label: r.entry_type || r.ref_type || '',
        debit: Math.round(Number(r.debit) || 0),
        credit: Math.round(Number(r.credit) || 0),
        source: 'supplier_ledger',
        ref_type: r.ref_type || '',
        ref_id: r.ref_id != null ? r.ref_id : null,
      });
    }
  } else if (Math.abs(closingTarget) <= 1) {
    // No ledger and no books leaf — last-resort document formula (legacy)
    raw = buildSupplierTurnoverFromDocs(db, supIds);
    fromDocs = raw.length > 0;
    if (fromDocs) closingTarget = signedSum(raw);
  }
  // else: ledger empty but books has opening/leaf → synthetic opening only (SoT);
  // orphan purchase/payment docs are NOT mixed into the running balance.

  if (!raw.length && Math.abs(closingTarget) <= 1) return null;
  if (!closingTarget && raw.length) closingTarget = signedSum(raw);

  return finalizeTurnover(
    'supplier',
    'گردش تأمین‌کننده',
    primarySup,
    raw,
    closingTarget,
    { supplier_ids: supIds, from_docs: fromDocs }
  );
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

function buildMergedPersonTurnover(db, party, partyId, detail) {
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
        id: r.je_id,
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
        id: r.id,
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
          id: r.id,
        });
      }
    } catch (_) { /* rep_ledger optional */ }
  }

  sortReportRows(merged, { date: 'date', dir: 'asc' });
  const raw = merged.map((r) => ({
    date: r.date,
    description: r.description,
    type_label: r.type_label,
    debit: r.debit,
    credit: r.credit,
    source: r.source,
    ref_type: r.ref_type,
    ref_id: r.ref_id,
    journal_id: r.journal_id,
  }));

  let closingTarget = leafSignedFromDetail(detail, 'person');
  if (!closingTarget && detail && (detail.source === 'person' || detail.source === 'gl' || detail.source === 'opening')) {
    closingTarget = Math.round(Number(detail.balance) || 0);
  }
  if (!closingTarget && raw.length) closingTarget = signedSum(raw);

  return finalizeTurnover('person', 'گردش شخص', personId, raw, closingTarget, {
    user_id: user ? user.id : null,
  });
}

function stripRunning(payload) {
  if (!payload || !payload.entries) return [];
  return payload.entries.map((e) => ({
    date: e.date,
    description: e.description,
    type_label: e.type_label,
    debit: e.debit,
    credit: e.credit,
    source: e.source,
    ref_type: e.ref_type,
    ref_id: e.ref_id,
    journal_id: e.journal_id,
  }));
}

/**
 * @param {object} [opts]
 * @param {string} [opts.role] customer|supplier|person — single leaf; default = unified net
 */
function buildPartyTurnover(db, partyId, opts) {
  const party = db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
  if (!party) return null;
  const options = opts && typeof opts === 'object' ? opts : {};
  const prefer = String(options.role || options.preferRole || '').toLowerCase().trim();
  const detail = partySignedBalanceDetailMap(db).get(Number(partyId)) || null;
  const netClosing = detail ? Math.round(Number(detail.balance) || 0) : Math.round(Number(party.opening_balance) || 0);

  const custIds = linkedCustomerIds(db, partyId);
  const supIds = linkedSupplierIds(db, partyId);

  if (prefer === 'supplier') {
    return buildSupplierTurnover(db, partyId, supIds, detail);
  }
  if (prefer === 'customer') {
    return buildCustomerTurnover(db, partyId, custIds, detail);
  }
  if (prefer === 'person') {
    return buildMergedPersonTurnover(db, party, partyId, detail);
  }

  const parts = [];
  if (custIds.length) {
    const cust = buildCustomerTurnover(db, partyId, custIds, detail);
    if (cust && cust.entries && cust.entries.length) parts.push({ role: 'customer', payload: cust });
  }
  if (supIds.length) {
    const sup = buildSupplierTurnover(db, partyId, supIds, detail);
    if (sup && sup.entries && sup.entries.length) parts.push({ role: 'supplier', payload: sup });
  }

  if (parts.length === 1) {
    // Single role book — already leaf-aligned; if net equals leaf, fine.
    // Dual-role with only one active leaf: closing already leaf SoT.
    const only = parts[0].payload;
    // When party net differs (other leaf silent opening), align to net for list parity
    if (Math.abs((only.closing || 0) - netClosing) > 2) {
      return finalizeTurnover(
        only.kind,
        only.title,
        only.entity_id,
        stripRunning(only),
        netClosing,
        { books_net: netClosing, leaf_closing: only.closing, unified: true }
      );
    }
    return only;
  }

  if (parts.length > 1) {
    // Merge role streams without double-counting each leaf's opening_fold:
    // rebuild from raw ledgers by stripping prior align, then one net align.
    const mergedRaw = [];
    for (const p of parts) {
      for (const e of stripRunning(p.payload)) {
        if (e.source === 'opening_fold' || e.ref_type === 'opening_balance') continue;
        mergedRaw.push(e);
      }
    }
    // Re-include opening once via net align
    sortReportRows(mergedRaw, { date: 'date', dir: 'asc' });
    return finalizeTurnover('party', 'گردش شخص', Number(partyId), mergedRaw, netClosing, {
      books_net: netClosing,
      roles: parts.map((p) => p.role),
      unified: true,
    });
  }

  const personTurn = buildMergedPersonTurnover(db, party, partyId, detail);
  if (personTurn) {
    if (Math.abs((personTurn.closing || 0) - netClosing) > 2) {
      return finalizeTurnover(
        'person',
        'گردش شخص',
        personTurn.entity_id,
        stripRunning(personTurn),
        netClosing,
        { books_net: netClosing, unified: true }
      );
    }
    return personTurn;
  }

  // Opening-only party with no subledger lines yet
  if (Math.abs(netClosing) > 1) {
    return finalizeTurnover('party', 'گردش شخص', Number(partyId), [], netClosing, {
      books_net: netClosing,
      opening_only: true,
    });
  }
  return withTotals({
    kind: 'party',
    title: 'گردش شخص',
    entity_id: Number(partyId),
    entries: [],
    closing: 0,
    books_closing: 0,
  });
}

module.exports = {
  ensurePersonForParty,
  resolvePersonIdFromVoucherLine,
  buildPartyTurnover,
  personLedgerCoveredByGl,
  alignEntriesToTarget,
  leafSignedFromDetail,
};
