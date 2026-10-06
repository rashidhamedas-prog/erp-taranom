'use strict';
/**
 * Expense section ownership + cost center on journal lines (SW v315).
 */
const { ok, eq, throws, freshDb, summary } = require('./lib/test-harness');

console.log('\n══ Expense cost coding v315 ══\n');

const ctx = freshDb();
const db = ctx.db;
const { postToLedger } = require('../lib/ledger');
const { resolveExpensePosting } = require('../routes/expenses');

const workshop = db.prepare("SELECT id FROM cost_centers WHERE code='CC-WORKSHOP'").get();
const cut = db.prepare("SELECT parent_id, entity FROM cost_centers WHERE code='CC-10'").get();
ok('CC-WORKSHOP exists', !!workshop);
ok('برش زیر کارگاه است', !!(workshop && cut && cut.parent_id === workshop.id));
ok('برش واحد کارگاه دارد', cut && cut.entity === 'workshop');

const admin = resolveExpensePosting(db, { category: 'admin', is_overhead: false, cost_center_id: null });
eq('اداری پیش‌فرض ۶۱۰۲', admin.account.code, '6102');
ok('اداری سربار نیست', admin.isOverhead === 0);

const sales = resolveExpensePosting(db, { category: 'sales', is_overhead: false, cost_center_id: null });
eq('فروش پیش‌فرض ۶۱۰۳', sales.account.code, '6103');

db.prepare(
  `INSERT INTO chart_of_accounts (code,name,type,parent_code,is_active) VALUES ('6199','تست ارث هزینه','expense','6000',1)`
).run();
const parent = db.prepare(
  `INSERT INTO expense_categories (code,name,account_code,coa_code,parent_id,level,cost_section)
   VALUES ('GRP','گروه اجاره',NULL,'6199',NULL,1,'admin')`
).run();
db.prepare(
  `INSERT INTO expense_categories (code,name,account_code,coa_code,parent_id,level,cost_section)
   VALUES ('CHILD','اجاره دفتر',NULL,NULL,?,2,NULL)`
).run(parent.lastInsertRowid);
const inherited = resolveExpensePosting(db, {
  category: 'CHILD', is_overhead: false, cost_center_id: null,
});
eq('فرزند حساب والد را ارث می‌برد', inherited.account.code, '6199');

throws('سربار بدون مرکز رد می‌شود', () => {
  resolveExpensePosting(db, { category: 'admin', is_overhead: true, cost_center_id: null });
}, 'مرکز هزینه');

const cc = db.prepare("SELECT id FROM cost_centers WHERE code='CC-30'").get();
const oh = resolveExpensePosting(db, {
  category: 'admin', is_overhead: true, cost_center_id: cc.id,
});
eq('سربار به ۵۲۰۲ می‌رود', oh.account.code, '5202');
eq('سربار همان مرکز را نگه می‌دارد', oh.costCenterId, cc.id);
ok('پرچم سربار روشن است', oh.isOverhead === 1);

const other = db.prepare("INSERT INTO cost_centers (name,code,active) VALUES ('مرکز سطر','CC-LINE',1)").run();
const je = postToLedger(db, {
  sourceType: 'expense_payment', sourceId: 9001, date: '1405/01/15',
  description: 'تست مرکز هزینه', createdBy: 1,
  costCenterId: cc.id,
  lines: [
    { code: '5202', name: 'کنترل سربار ساخت', debit: 50, credit: 0 },
    { code: '1101', name: 'صندوق', debit: 0, credit: 50, cost_center_id: other.lastInsertRowid },
  ],
});
ok('سند ثبت شد', je > 0);
const lines = db.prepare('SELECT account_code, cost_center_id FROM journal_lines WHERE entry_id=? ORDER BY line_no').all(je);
eq('سطر هزینه مرکز سند را گرفت', lines[0].cost_center_id, cc.id);
eq('سطر صندوق مرکز خودش را نگه داشت', lines[1].cost_center_id, other.lastInsertRowid);
const header = db.prepare('SELECT cost_center_id FROM journal_entries WHERE id=?').get(je);
eq('سرسند مرکز را دارد', header.cost_center_id, cc.id);

ctx.cleanup();
summary('expense cost coding v315');
