'use strict';
/**
 * P8a item5 — رسید 13 (PO-0015) با تاریخ 1405/07/05 در حالی که آخرین فعالیت سفارش 1405/07/28 است.
 * فقط گزارش (read-only، بدون apply): گزینهٔ «تغییر تاریخ به آخرین فعالیت» در برابر «بدون تغییر».
 *   node server/scripts/p8a-item5-receipt13-date.js [--db=PATH] [--out=DIR]
 */
const path = require('path');
const fs = require('fs');
const C = require('./lib/p8a-common');

const ORDER_ID = 15;
const RECEIPT_ID = 13;

const args = C.parseArgs();
const outDir = args.out || C.defaultOutDir();
const src = path.resolve(args.db || process.env.DB_PATH || path.join(C.ROOT, 'crm.db'));
const Database = C.R('node_modules/better-sqlite3');
const db = new Database(src, { readonly: true, fileMustExist: true });
const q = (sql, ...p) => { try { return db.prepare(sql).all(...p); } catch (e) { return []; } };
const one = (sql, ...p) => q(sql, ...p)[0] || null;

const RDG = C.R('lib/production/receipt-date-guard');
const rec = one('SELECT * FROM production_receipts WHERE id=?', RECEIPT_ID);
const po = one('SELECT * FROM production_orders WHERE id=?', ORDER_ID);
const last = RDG.lastOrderActivity(db, ORDER_ID);
const proposed = last ? String(last.date) : null;
const docs = [];
const add = (table, id, field, oldV, note) => docs.push({ table, id, field, old: oldV, note });
if (rec) add('production_receipts', rec.id, 'date', rec.date, `${rec.doc_no} — ${rec.qty} عدد کالای ${rec.product_id}`);
for (const je of q(`SELECT id, entry_date, voucher_number, status, ref_type, ref_id FROM journal_entries
  WHERE COALESCE(deleted_at,0)=0 AND COALESCE(status,'') NOT IN ('reversed','void')
    AND ((ref_type='production_receipt' AND ref_id=?) OR (ref_type IN ('order_cost_receipt_align','production_close','PRD-07') AND ref_id=?) OR id=?)`,
RECEIPT_ID, ORDER_ID, rec ? rec.je_id || 0 : 0)) {
  add('journal_entries', je.id, 'entry_date', je.entry_date, `${je.voucher_number} ${je.ref_type}:${je.ref_id} (${je.status})`);
}
for (const l of q(`SELECT id, event_type, source_type, source_id, date, qty_in, amount_rial FROM inventory_ledger
  WHERE status='posted' AND reversed_of IS NULL AND ((source_type='production_receipt' AND source_id=?) OR (source_type='order_cost_receipt_align' AND source_id=?))`,
ORDER_ID, ORDER_ID)) {
  add('inventory_ledger', l.id, 'date', l.date, `${l.event_type} ${l.source_type}:${l.source_id} qty=${l.qty_in} amt=${l.amount_rial}`);
}
const month = (d) => String(d || '').slice(0, 7);
const locks = q('SELECT * FROM inventory_period_locks WHERE period IN (?,?)', month(rec && rec.date), month(proposed));
const prodClose = q('SELECT * FROM production_period_close');
const whClose = q('SELECT * FROM warehouse_period_closes');
const fy = q('SELECT * FROM fiscal_years');
const salesBetween = rec && proposed ? q(`
  SELECT id, event_type, warehouse_id, qty_out, amount_rial, date, source_type, source_id FROM inventory_ledger
  WHERE product_id=? AND status='posted' AND reversed_of IS NULL AND qty_out>0
    AND date>=? AND date<? ORDER BY date, id`, rec.product_id, rec.date, proposed) : [];
db.close();

const rows = docs.map((d) => ({
  item: 'item5', mode: 'report', target_table: d.table, target_id: d.id, action: 'proposal_redate',
  field: d.field, old_value: d.old, new_value: proposed, note: d.note,
}));
for (const s of salesBetween) {
  rows.push({
    item: 'item5', mode: 'report', target_table: 'inventory_ledger', target_id: s.id, action: 'info_outbound_between',
    warehouse_id: s.warehouse_id, product_id: rec.product_id, qty: -s.qty_out, amount_rial: -s.amount_rial,
    note: `${s.event_type} ${s.source_type}:${s.source_id} ${s.date} — بین تاریخ فعلی و پیشنهادی (ترتیب کاردکس عوض می‌شود؛ بهای ثبت‌شده عوض نمی‌شود)`,
  });
}
fs.mkdirSync(outDir, { recursive: true });
C.writeCsv(path.join(outDir, 'p8a-item5-receipt13-date.csv'), rows);
const sameMonth = rec && proposed && month(rec.date) === month(proposed);
const md = [
  '# item5 — تاریخ رسید 13 (PO-0015)',
  '',
  `- رسید: ${rec ? `${rec.doc_no} تاریخ ${rec.date}، ${rec.qty} عدد کالای ${rec.product_id}، مبلغ ${rec.amount_rial}` : 'یافت نشد'}`,
  `- سفارش: ${po ? `${po.order_no} (${po.status})` : '-'}`,
  `- آخرین فعالیت سفارش: ${last ? `${last.date} (${last.label})` : '-'}`,
  `- همان ماه؟ ${sameMonth ? 'بله (1405/07) — دوره/سال مالی عوض نمی‌شود' : 'خیر'}`,
  `- قفل ماه ارزش‌گذاری برای ${month(rec && rec.date)}/${month(proposed)}: ${locks.length ? JSON.stringify(locks) : 'ندارد'}`,
  `- بستن دورهٔ تولید: ${prodClose.length ? prodClose.map((p) => `${p.period_label}=${p.status}`).join('، ') : 'ردیفی ندارد'}`,
  `- بستن دورهٔ انبار: ${whClose.length ? whClose.map((p) => `${p.period || p.period_label || p.id}=${p.status}`).join('، ') : 'ردیفی ندارد'}`,
  `- سال مالی: ${JSON.stringify(fy.map((f) => ({ id: f.id, label: f.label || f.name, status: f.status || f.is_closed })))}`,
  `- خروجی‌های کالای ${rec && rec.product_id} بین دو تاریخ: ${salesBetween.length} ردیف`,
  '',
  '## گزینه‌ها',
  '1. **بدون تغییر (پیشنهادی):** هر دو تاریخ در 1405/07 است، قفل دوره ندارد، دورهٔ تولید 1405/07 هنوز باز است و اثر مالی صفر است (سود ماهانه عوض نمی‌شود). تنها ایراد: در کاردکس، رسید قبل از فروش‌های 07/05 تا 07/28 نمایش داده می‌شود. یک یادداشت audit کافی است. گارد تاریخ P4 فقط برای ثبت/ویرایش‌های بعدی اعمال می‌شود.',
  '2. **تغییر تاریخ به ' + (proposed || '?') + ':** طبق R13 ویرایش تاریخ سند تأییدشده درجا مجاز نیست ⇒ باید رسید ابطال و دوباره ثبت شود (reverseOrder ⇒ خروج FG، برگشت WIP، ابطال JE رسید و JE تطبیق، سپس ثبت مجدد با تاریخ جدید و شمارهٔ سند جدید). مبلغ‌ها همان می‌ماند؛ میانگین متحرک کالا دوباره حساب می‌شود و چون فروش‌های بین دو تاریخ بهای ثبت‌شدهٔ خود را نگه می‌دارند، اختلاف میانگین بعدی به‌صورت تعدیل ارزش ظاهر می‌شود. ریسک بالاتر، فایدهٔ حسابداری نزدیک صفر.',
  '',
];
fs.writeFileSync(path.join(outDir, 'p8a-item5-receipt13-date-summary.md'), md.join('\n'), 'utf8');
console.log(md.join('\n'));
