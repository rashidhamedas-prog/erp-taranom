'use strict';
/**
 * P6-fix — every journal entry born from an invoice settlement, resolved through
 * existing link columns (no extra schema):
 *   invoice JE / COGS / AR reclass  → journal_entries.ref_type in INVOICE_REF_TYPES, ref_id = invoice id
 *   cash / bank / cheque receipt    → ref_type='settlement',  ref_id ∈ settlements.invoice_id = invoice
 *   card receipt (coa_code or 1118) → ref_type='pos_receipt', ref_id ∈ pos_receipts.invoice_id = invoice
 *   cheque lifecycle                → cheque_records.{journal_entry_id,collection_je_id,cleared_je_id,bounced_je_id}
 *   closed-period counter vouchers  → journal_entries.reverses_je_id ∈ the ids above
 * Credit (نسیه) has no JE of its own: it is the AR left open on the invoice JE.
 */
const { jlDebitRial, jlCreditRial } = require('./money');

const INVOICE_REF_TYPES = ['invoice', 'invoice_cogs', 'invoice_ar_reclass', 'invoice_payment'];

function hasColumn(db, table, col) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col); }
  catch (_) { return false; }
}

function isLiveHead(je) {
  return !(Number(je.deleted_at || 0) > 0) && !['reversed', 'void'].includes(String(je.status || ''));
}

function safeAll(db, sql, params) {
  try { return db.prepare(sql).all(...(params || [])); } catch (_) { return []; }
}

function collectInvoiceJeLinks(db, invoiceId) {
  const invId = Number(invoiceId);
  const linkOf = new Map();
  const add = (id, link) => { if (id && !linkOf.has(Number(id))) linkOf.set(Number(id), link); };

  const invTypes = [...INVOICE_REF_TYPES, ...INVOICE_REF_TYPES.map((t) => `${t}_reversal_cv`)];
  for (const r of safeAll(db, `
    SELECT id, ref_type FROM journal_entries
    WHERE ref_id=? AND ref_type IN (${invTypes.map(() => '?').join(',')})
  `, [invId, ...invTypes])) {
    add(r.id, r.ref_type.replace(/_reversal_cv$/, ''));
  }

  const settlements = safeAll(db, 'SELECT id, pay_type, status, amount_rial, amount FROM settlements WHERE invoice_id=?', [invId]);
  const posReceipts = safeAll(db, 'SELECT id, settlement_id, status, amount_rial, journal_id FROM pos_receipts WHERE invoice_id=?', [invId]);
  const settIds = settlements.map((s) => s.id);
  const posIds = posReceipts.map((p) => p.id);
  const byRef = (refType, ids, link) => {
    if (!ids.length) return;
    const q = ids.map(() => '?').join(',');
    for (const r of safeAll(db, `
      SELECT id FROM journal_entries WHERE ref_type IN (?, ?) AND ref_id IN (${q})
    `, [refType, `${refType}_reversal_cv`, ...ids])) add(r.id, link);
  };
  byRef('settlement', settIds, 'settlement');
  byRef('pos_receipt', posIds, 'pos_receipt');
  for (const p of posReceipts) add(p.journal_id, 'pos_receipt');

  const chequeWhere = settIds.length
    ? `invoice_id=? OR settlement_id IN (${settIds.map(() => '?').join(',')})`
    : 'invoice_id=?';
  const cheques = safeAll(db, `
    SELECT id, record_status, journal_entry_id, collection_je_id, cleared_je_id, bounced_je_id, settlement_id
    FROM cheque_records WHERE ${chequeWhere}
  `, [invId, ...settIds]);
  for (const c of cheques) {
    for (const col of ['journal_entry_id', 'collection_je_id', 'cleared_je_id', 'bounced_je_id']) add(c[col], 'cheque_record');
  }

  if (hasColumn(db, 'journal_entries', 'reverses_je_id') && linkOf.size) {
    const base = [...linkOf.keys()];
    const q = base.map(() => '?').join(',');
    for (const r of safeAll(db, `SELECT id, reverses_je_id FROM journal_entries WHERE reverses_je_id IN (${q})`, base)) {
      add(r.id, `${linkOf.get(Number(r.reverses_je_id))}_counter`);
    }
  }

  const ids = [...linkOf.keys()].sort((a, b) => a - b);
  const entries = [];
  const net = new Map();
  let liveDebit = 0;
  let liveCredit = 0;
  for (const id of ids) {
    const head = db.prepare(`
      SELECT id, entry_date, ref_type, ref_id, status, deleted_at, description FROM journal_entries WHERE id=?
    `).get(id);
    if (!head) continue;
    const lines = db.prepare('SELECT account_code, debit, credit, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?').all(id);
    let d = 0;
    let c = 0;
    const live = isLiveHead(head);
    for (const l of lines) {
      const ld = Math.round(jlDebitRial(l));
      const lc = Math.round(jlCreditRial(l));
      d += ld;
      c += lc;
      if (live) net.set(l.account_code, (net.get(l.account_code) || 0) + ld - lc);
    }
    if (live) { liveDebit += d; liveCredit += c; }
    entries.push({
      id: head.id, link: linkOf.get(id), ref_type: head.ref_type, ref_id: head.ref_id,
      entry_date: head.entry_date, status: head.status || 'posted', live,
      debit_rial: d, credit_rial: c, balanced: d === c, description: head.description || '',
    });
  }
  const netByAccount = {};
  for (const [code, v] of net) if (v !== 0) netByAccount[code] = v;

  const liveSett = settlements.filter((s) => String(s.status || 'posted') !== 'reversed');
  const livePos = posReceipts.filter((p) => !['reversed', 'void'].includes(String(p.status || '')));
  const liveCheques = cheques.filter((c) => String(c.record_status || 'posted') !== 'reversed');
  const liveRefIds = (refType) => new Set(entries.filter((e) => e.live && e.ref_type === refType).map((e) => Number(e.ref_id)));
  const liveSettJe = liveRefIds('settlement');
  const livePosJe = liveRefIds('pos_receipt');
  const posSettIds = new Set(posReceipts.map((p) => Number(p.settlement_id)).filter(Boolean));
  // Receipts that move money must be backed by a live linked JE (POS shadow settlements post on pos_receipt).
  const receiptsWithoutJe = [
    ...liveSett.filter((s) => !posSettIds.has(Number(s.id)) && !liveSettJe.has(Number(s.id)))
      .map((s) => ({ kind: 'settlement', id: s.id, pay_type: s.pay_type })),
    ...livePos.filter((p) => !livePosJe.has(Number(p.id))).map((p) => ({ kind: 'pos_receipt', id: p.id })),
  ];

  return {
    invoice_id: invId,
    entries,
    all_balanced: entries.every((e) => e.balanced),
    live: { count: entries.filter((e) => e.live).length, debit_rial: liveDebit, credit_rial: liveCredit, balanced: liveDebit === liveCredit },
    net_by_account: netByAccount,
    receipts: {
      settlements_live: liveSett.length, pos_live: livePos.length, cheques_live: liveCheques.length,
    },
    receipts_without_je: receiptsWithoutJe,
  };
}

/**
 * Inside the void transaction, after every reverse step: nothing linked to the
 * invoice may still move the books. Throws → caller's db.transaction rolls back.
 */
function assertInvoiceVoidComplete(db, invoiceId) {
  const r = collectInvoiceJeLinks(db, invoiceId);
  const leftAccounts = Object.keys(r.net_by_account);
  const live = r.receipts;
  if (leftAccounts.length || live.settlements_live || live.pos_live || live.cheques_live) {
    const e = new Error('ابطال فاکتور کامل نشد — سند یا دریافت مرتبط با فاکتور هنوز فعال است؛ هیچ تغییری ثبت نشد');
    e.status = 409;
    e.code = 'E_INVOICE_VOID_INCOMPLETE';
    e.net_by_account = r.net_by_account;
    e.receipts = live;
    throw e;
  }
  return r;
}

module.exports = { collectInvoiceJeLinks, assertInvoiceVoidComplete, INVOICE_REF_TYPES };
