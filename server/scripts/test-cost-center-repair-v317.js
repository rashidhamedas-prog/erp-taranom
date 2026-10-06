'use strict';
/**
 * Historical cost-center repair, warehouse default, cheque expense section.
 * Run: node server/scripts/test-cost-center-repair-v317.js
 */
const { ok, eq, throws, freshDb, summary } = require('./lib/test-harness');

console.log('\n══ Cost-center repair v317 ══\n');

const ctx = freshDb();
const db = ctx.db;
const { repairHistoricalCostLinks } = require('../lib/cost-center-repair');
const { chequeExpensePosting } = require('../routes/cheque-records');

const workshop = db.prepare("SELECT id FROM cost_centers WHERE code='CC-WORKSHOP'").get();
const dist = db.prepare("SELECT id FROM cost_centers WHERE code='CC-DISTRIBUTION'").get();
const stage = db.prepare("SELECT id FROM cost_centers WHERE code='CC-30'").get();
ok('کارگاه و توزیع هستند', !!(workshop && dist && stage));

const fg = db.prepare("SELECT cost_center_id FROM warehouses WHERE code='WH-FG'").get();
const fg90 = db.prepare("SELECT id FROM cost_centers WHERE code='CC-90'").get();
eq('انبار محصول به CC-90 وصل است', fg && fg.cost_center_id, fg90 && fg90.id);

db.prepare("DELETE FROM settings WHERE key='cost_center_journal_repair_v317'").run();
db.prepare("UPDATE warehouses SET cost_center_id=NULL WHERE code='WH-RAW'").run();

const payId = db.prepare(`
  INSERT INTO expense_payments (category,title,amount,date,cost_center_id,is_overhead,account_code,status)
  VALUES ('admin','سربار قدیمی',1000,'1405/01/01',?,1,'6102','posted')
`).run(stage.id).lastInsertRowid;
const payJe = db.prepare(`
  INSERT INTO journal_entries (entry_date,description,ref_type,ref_id,status)
  VALUES ('1405/01/01','سربار قدیمی','expense_payment',?,'approved')
`).run(payId).lastInsertRowid;
db.prepare(`
  INSERT INTO journal_lines (entry_id,account_code,account_name,debit,credit)
  VALUES (?, '6102', 'هزینه اداری', 100, 0)
`).run(payJe);
db.prepare(`
  INSERT INTO journal_lines (entry_id,account_code,account_name,debit,credit)
  VALUES (?, '1101', 'صندوق', 0, 100)
`).run(payJe);

const custId = db.prepare("INSERT INTO customers (user_id,biz) VALUES (1,'مشتری تست')").run().lastInsertRowid;
const invId = db.prepare(`
  INSERT INTO invoices (user_id,cust_id,num,type,date,cost_center_id)
  VALUES (1,?,'T-TEST','final','1405/01/02',?)
`).run(custId, workshop.id).lastInsertRowid;
const invJe = db.prepare(`
  INSERT INTO journal_entries (entry_date,description,ref_type,ref_id,status)
  VALUES ('1405/01/02','فاکتور تست','invoice',?,'approved')
`).run(invId).lastInsertRowid;
db.prepare(`
  INSERT INTO journal_lines (entry_id,account_code,account_name,debit,credit)
  VALUES (?, '1103', 'دریافتنی', 50, 0)
`).run(invJe);

const productId = db.prepare("INSERT INTO products (user_id,name,code) VALUES (1,'کالای تست','P-317')").run().lastInsertRowid;
const raw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get();
const distWh = db.prepare("SELECT id FROM warehouses WHERE code IN ('WH-DIST','WH-DIST-FG') ORDER BY code LIMIT 1").get();
ok('انبار مبدأ و مقصد هستند', !!(raw && distWh));
const moveId = db.prepare(`
  INSERT INTO warehouse_moves (type,product_id,from_warehouse_id,to_warehouse_id,qty,date)
  VALUES ('transfer',?,?,?,1,'1405/01/03')
`).run(productId, raw.id, distWh.id).lastInsertRowid;
const xferJe = db.prepare(`
  INSERT INTO journal_entries (entry_date,description,ref_type,ref_id,status)
  VALUES ('1405/01/03','انتقال','warehouse_transfer_batch',?,'approved')
`).run(moveId).lastInsertRowid;
db.prepare(`
  INSERT INTO journal_lines (entry_id,account_code,account_name,debit,credit)
  VALUES (?, '1130', 'موجودی مقصد', 20, 0)
`).run(xferJe);
db.prepare(`
  INSERT INTO journal_lines (entry_id,account_code,account_name,debit,credit)
  VALUES (?, '1110', 'موجودی مبدأ', 0, 20)
`).run(xferJe);

const oldChq = db.prepare(`
  INSERT INTO journal_entries (entry_date,description,ref_type,ref_id,status)
  VALUES ('1405/01/04','خرج قدیمی','cheque_expense',9001,'approved')
`).run().lastInsertRowid;
db.prepare(`
  INSERT INTO journal_lines (entry_id,account_code,account_name,debit,credit)
  VALUES (?, '6102', 'هزینه اداری', 30, 0)
`).run(oldChq);

const result = repairHistoricalCostLinks(db);
ok('تعمیر یک‌بار اجرا شد', result && result.skipped === false);

const rawAfter = db.prepare("SELECT cost_center_id FROM warehouses WHERE code='WH-RAW'").get();
eq('مواد اولیه به کارگاه برگشت', rawAfter.cost_center_id, workshop.id);

const ohLines = db.prepare('SELECT account_code, cost_center_id, debit FROM journal_lines WHERE entry_id=? ORDER BY id').all(payJe);
eq('سربار قبلی به ۵۲۰۲ رفت', ohLines[0].account_code, '5202');
eq('سطر بدهکار سربار مرکز دوخت گرفت', ohLines[0].cost_center_id, stage.id);
eq('سطر صندوق هم همان مرکز را گرفت', ohLines[1].cost_center_id, stage.id);
eq('خود پرداخت هزینه ۵۲۰۲ شد', db.prepare('SELECT account_code FROM expense_payments WHERE id=?').get(payId).account_code, '5202');

const invLine = db.prepare('SELECT cost_center_id FROM journal_lines WHERE entry_id=?').get(invJe);
eq('فاکتور قبلی مرکز کارگاه گرفت', invLine.cost_center_id, workshop.id);

const xferLines = db.prepare('SELECT cost_center_id, debit FROM journal_lines WHERE entry_id=? ORDER BY id').all(xferJe);
const destCc = db.prepare('SELECT cost_center_id FROM warehouses WHERE id=?').get(distWh.id).cost_center_id;
eq('بدهکار انتقال مرکز مقصد است', xferLines[0].cost_center_id, destCc);
eq('بستانکار انتقال مرکز مبدأ است', xferLines[1].cost_center_id, workshop.id);
ok('دو مرکز انتقال یکی نشدند', xferLines[0].cost_center_id !== xferLines[1].cost_center_id);

eq('خرج چک قدیمی اداری ماند', db.prepare('SELECT account_code FROM journal_lines WHERE entry_id=?').get(oldChq).account_code, '6102');

const plain = chequeExpensePosting(db, {});
eq('خرج چک بدون بخش همان ۶۱۰۲ است', plain.account.code, '6102');
const selling = chequeExpensePosting(db, { cost_section: 'selling', cost_center_id: dist.id });
eq('خرج چک فروش ۶۱۰۳ است', selling.account.code, '6103');
eq('خرج چک فروش مرکز را نگه می‌دارد', selling.costCenterId, dist.id);
throws('سربار چک بدون مرکز رد می‌شود', () => {
  chequeExpensePosting(db, { cost_section: 'production_overhead' });
}, 'مرکز هزینه');
const overhead = chequeExpensePosting(db, { cost_section: 'production_overhead', cost_center_id: stage.id });
eq('خرج چک سربار ۵۲۰۲ است', overhead.account.code, '5202');

db.prepare("UPDATE warehouses SET cost_center_id=NULL WHERE code='WH-SCRAP'").run();
const again = repairHistoricalCostLinks(db);
ok('تعمیر سند دوباره اجرا نمی‌شود', again && again.skipped === true);
const scrap = db.prepare("SELECT cost_center_id FROM warehouses WHERE code='WH-SCRAP'").get();
eq('انبار بی‌مرکز در بوت بعدی پر می‌شود', scrap && scrap.cost_center_id, workshop.id);

const lateJe = db.prepare(`
  INSERT INTO journal_entries (entry_date,description,ref_type,ref_id,status)
  VALUES ('1405/01/05','دیر','invoice',?,'approved')
`).run(invId).lastInsertRowid;
db.prepare(`
  INSERT INTO journal_lines (entry_id,account_code,account_name,debit,credit)
  VALUES (?, '1103', 'دریافتنی', 1, 0)
`).run(lateJe);
repairHistoricalCostLinks(db);
const late = db.prepare('SELECT cost_center_id FROM journal_lines WHERE entry_id=?').get(lateJe);
ok('سند بعد از پرچم تعمیر دست نمی‌خورد', late.cost_center_id == null);

ctx.cleanup();
summary();
