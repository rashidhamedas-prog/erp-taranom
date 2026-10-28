'use strict';
/**
 * جمع بهای تمام‌شدهٔ ثبت‌شده برای یک فاکتور — شامل سند اصلی، اصلاحی و برگشت.
 * ref_typeهای شناخته‌شده از کد تولید: invoice_cogs / invoice_cogs_fix / invoice_cogs_reversal
 * به‌علاوهٔ aliasهای قدیمی invoice و sales_invoice (همان الگوی قبلی invoiceCogsDiffs).
 *
 * علامت: Σ(بدهکار − بستانکار) روی حساب coa_cogs و فرزندان مستقیم آن.
 * reversal با بستانکار ۵۱۰۱ اثر منفی می‌گذارد و درست کم می‌شود.
 */

const { acct } = require('../coa-map');
const { jlDebitRial, jlCreditRial } = require('../money');

/** انواع سند بهای تمام‌شدهٔ فروش که به invoices.id وصل می‌شوند (ref_id). */
const COGS_JE_REF_TYPES = Object.freeze([
  'invoice_cogs',
  'invoice_cogs_fix',
  'invoice_cogs_reversal',
  'invoice',
  'sales_invoice',
]);

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch (_) {
    return false;
  }
}

function colSet(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  } catch (_) {
    return new Set();
  }
}

/** کد حساب بهای تمام‌شده + فرزندان مستقیم (مثل الگوی اصلاح دادهٔ انبار). */
function cogsAccountCodes(db) {
  const root = acct(db, 'coa_cogs');
  const codes = new Set([String(root.code)]);
  if (tableExists(db, 'chart_of_accounts')) {
    for (const r of db.prepare('SELECT code FROM chart_of_accounts WHERE parent_code=?').all(root.code)) {
      codes.add(String(r.code));
    }
    // v585: per-warehouse leaf COGS accounts (warehouses.cogs_coa_code) count as COGS too.
    if (colSet(db, 'warehouses').has('cogs_coa_code')) {
      for (const r of db.prepare(
        "SELECT DISTINCT TRIM(cogs_coa_code) AS code FROM warehouses WHERE TRIM(COALESCE(cogs_coa_code,''))<>''",
      ).all()) {
        codes.add(String(r.code));
      }
    }
  }
  return { root, codes };
}

function liveJeWhereSql(db, alias = 'e') {
  const cols = colSet(db, 'journal_entries');
  const parts = [];
  if (cols.has('deleted_at')) parts.push(`COALESCE(${alias}.deleted_at,0)=0`);
  if (cols.has('status')) {
    parts.push(`COALESCE(${alias}.status,'approved') NOT IN ('reversed','void')`);
  }
  return parts.length ? parts.join(' AND ') : '1=1';
}

function accountCol(db) {
  const jlCols = colSet(db, 'journal_lines');
  return jlCols.has('account_code') ? 'account_code' : 'code';
}

/**
 * جمع خالص بهای تمام‌شدهٔ دفتر برای یک فاکتور (ریال).
 * @returns {number} ریال صحیح (debit − credit روی حساب COGS)
 */
function cogsPostedForInvoice(db, invoiceId) {
  const id = Number(invoiceId);
  if (!Number.isFinite(id) || id <= 0) return 0;
  if (!tableExists(db, 'journal_entries') || !tableExists(db, 'journal_lines')) return 0;
  const { codes } = cogsAccountCodes(db);
  const acctCol = accountCol(db);
  const live = liveJeWhereSql(db, 'e');
  const ph = COGS_JE_REF_TYPES.map(() => '?').join(',');
  const jlCols = colSet(db, 'journal_lines');
  const lines = db.prepare(`
    SELECT l.${acctCol} AS code, l.debit, l.credit
           ${jlCols.has('debit_rial') ? ', l.debit_rial' : ', NULL AS debit_rial'}
           ${jlCols.has('credit_rial') ? ', l.credit_rial' : ', NULL AS credit_rial'}
    FROM journal_entries e
    JOIN journal_lines l ON l.entry_id = e.id
    WHERE e.ref_id = ?
      AND e.ref_type IN (${ph})
      AND ${live}
  `).all(id, ...COGS_JE_REF_TYPES);
  let sum = 0;
  for (const l of lines) {
    if (!codes.has(String(l.code || ''))) continue;
    sum += jlDebitRial(l) - jlCreditRial(l);
  }
  return Math.round(sum);
}

/**
 * نقشهٔ invoice_id → جمع COGS دفتر (ریال) برای همهٔ فاکتورهایی که حداقل یک سند COGS دارند.
 */
function cogsPostedByInvoiceMap(db) {
  const out = new Map();
  if (!tableExists(db, 'journal_entries') || !tableExists(db, 'journal_lines')) return out;
  const { codes } = cogsAccountCodes(db);
  const acctCol = accountCol(db);
  const live = liveJeWhereSql(db, 'e');
  const ph = COGS_JE_REF_TYPES.map(() => '?').join(',');
  const jlCols = colSet(db, 'journal_lines');
  const lines = db.prepare(`
    SELECT e.ref_id AS invoice_id, l.${acctCol} AS code, l.debit, l.credit
           ${jlCols.has('debit_rial') ? ', l.debit_rial' : ', NULL AS debit_rial'}
           ${jlCols.has('credit_rial') ? ', l.credit_rial' : ', NULL AS credit_rial'}
    FROM journal_entries e
    JOIN journal_lines l ON l.entry_id = e.id
    WHERE e.ref_type IN (${ph})
      AND ${live}
  `).all(...COGS_JE_REF_TYPES);
  for (const l of lines) {
    if (!codes.has(String(l.code || ''))) continue;
    const id = l.invoice_id;
    if (id == null) continue;
    out.set(id, (out.get(id) || 0) + (jlDebitRial(l) - jlCreditRial(l)));
  }
  for (const [k, v] of out) out.set(k, Math.round(v));
  return out;
}

/**
 * جمع خروج فروش کاردکس زنده برای یک فاکتور (ریال) — همان معیار invoiceCogsDiffs.
 */
function kardexSaleOutForInvoice(db, invoiceId) {
  const id = Number(invoiceId);
  if (!Number.isFinite(id) || id <= 0) return 0;
  if (!tableExists(db, 'inventory_ledger')) return 0;
  const { LEDGER_LIVE_SQL } = require('./layer-reconcile');
  const row = db.prepare(`
    SELECT SUM(COALESCE(amount_rial,0)) AS amt
    FROM inventory_ledger
    WHERE ${LEDGER_LIVE_SQL}
      AND source_type IN ('invoice','sale','sales_invoice')
      AND COALESCE(qty_out,0) > 0
      AND source_id = ?
  `).get(id);
  return Math.round(Number(row && row.amt) || 0);
}

/**
 * نقشهٔ invoice_id → مبلغ خروج فروش کاردکس.
 */
function kardexSaleOutByInvoiceMap(db) {
  const out = new Map();
  if (!tableExists(db, 'inventory_ledger')) return out;
  const { LEDGER_LIVE_SQL } = require('./layer-reconcile');
  for (const r of db.prepare(`
    SELECT source_id, SUM(COALESCE(amount_rial,0)) AS amt
    FROM inventory_ledger
    WHERE ${LEDGER_LIVE_SQL}
      AND source_type IN ('invoice','sale','sales_invoice')
      AND COALESCE(qty_out,0) > 0
    GROUP BY source_id
  `).all()) {
    if (r.source_id == null) continue;
    out.set(r.source_id, Math.round(Number(r.amt) || 0));
  }
  return out;
}

/**
 * اختلاف کاردکس − COGS دفتر برای یک فاکتور (ریال). صفر = تطبیق.
 */
function cogsVsKardexDiff(db, invoiceId) {
  const kardex = kardexSaleOutForInvoice(db, invoiceId);
  const cogs = cogsPostedForInvoice(db, invoiceId);
  return { invoice_id: Number(invoiceId), kardex_rial: kardex, cogs_rial: cogs, diff_rial: kardex - cogs };
}

module.exports = {
  COGS_JE_REF_TYPES,
  cogsAccountCodes,
  cogsPostedForInvoice,
  cogsPostedByInvoiceMap,
  kardexSaleOutForInvoice,
  kardexSaleOutByInvoiceMap,
  cogsVsKardexDiff,
};
