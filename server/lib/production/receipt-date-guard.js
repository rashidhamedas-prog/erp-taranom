'use strict';
/**
 * A production receipt closes the order's cost: it must not be dated before the
 * latest posted consumption / lay / pack / labor / overhead of that order.
 */
const { reportDateKey } = require('../report-order');

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Sortable YYYYMMDD key of a Jalali date string (Persian/Arabic digits, unpadded parts). */
function dateKey(value) {
  const s = String(value == null ? '' : value).trim()
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));
  const k = reportDateKey(s);
  return /^\d{8}$/.test(k) ? k : '';
}

function tableHas(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  } catch (_) {
    return false;
  }
}

const SOURCES = [
  { table: 'production_material_issues', orderCol: 'order_id', label: 'مصرف مواد' },
  { table: 'cutting_lays', orderCol: 'production_order_id', label: 'لایه‌چینی' },
  { table: 'cutting_packs', orderCol: 'production_order_id', label: 'رسید برش (PACK)' },
  { table: 'production_labor_entries', orderCol: 'order_id', label: 'دستمزد' },
  { table: 'production_overhead_applications', orderCol: 'order_id', label: 'سربار' },
];

/** Latest posted activity date of the order: { date, key, label } or null. */
function lastOrderActivity(db, orderId) {
  let best = null;
  for (const src of SOURCES) {
    if (!tableHas(db, src.table, src.orderCol) || !tableHas(db, src.table, 'date')) continue;
    const rows = db.prepare(`
      SELECT DISTINCT date FROM ${src.table}
      WHERE ${src.orderCol}=? AND COALESCE(status,'posted')='posted' AND COALESCE(date,'')<>''
    `).all(Number(orderId));
    for (const r of rows) {
      const key = dateKey(r.date);
      if (key && (!best || key > best.key)) best = { date: r.date, key, label: src.label };
    }
  }
  return best;
}

/**
 * Receipt date to use: an explicit date is kept as-is (and checked);
 * without one, the later of the order date and its last activity.
 */
function defaultReceiptDate(db, orderId, fallback) {
  const last = lastOrderActivity(db, orderId);
  const fk = dateKey(fallback);
  if (last && (!fk || last.key > fk)) return String(last.date).trim();
  return fallback;
}

function assertReceiptNotBeforeLastActivity(db, orderId, date) {
  const last = lastOrderActivity(db, orderId);
  const key = dateKey(date);
  if (!last || !key || key >= last.key) return last;
  const e = new Error(
    `تاریخ رسید تولید (${date}) نمی‌تواند قبل از آخرین ${last.label} این سفارش (${last.date}) باشد`
  );
  e.code = 'E_RECEIPT_BEFORE_LAST_ACTIVITY';
  e.status = 422;
  e.extra = { receipt_date: date, last_activity_date: last.date, last_activity: last.label };
  throw e;
}

module.exports = {
  dateKey,
  lastOrderActivity,
  defaultReceiptDate,
  assertReceiptNotBeforeLastActivity,
};
