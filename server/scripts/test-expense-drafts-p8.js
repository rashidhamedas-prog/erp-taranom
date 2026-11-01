'use strict';
/**
 * P8 — فرم هزینهٔ روزانه: پیش‌نویس صندوق‌دار (pending، بدون JE) → تأیید حسابدار (JE تراز).
 * Run: node server/scripts/test-expense-drafts-p8.js
 */
const fs = require('fs');
const path = require('path');
const { ok, eq, summary, freshDb } = require('./lib/test-harness');
const { swAtLeast } = require('./lib/sw-at-least');

console.log('\n══ Expense drafts P8 ══\n');

const ctx = freshDb();
const db = ctx.db;
const D = require('../lib/expense-drafts');
const { LEGACY, acct, baseCoaTree, validateCoaKeyAssignment, clearCoaCache } = require('../lib/coa-map');

function rejects(name, fn, code) {
  try {
    fn();
    ok(name, false, 'خطایی رخ نداد');
  } catch (e) {
    ok(name, String(e.code || e.message).includes(code), `انتظار ${code} · دریافت ${e.code || e.message}`);
  }
}
const jeCount = (refType) => db.prepare(
  'SELECT COUNT(*) c FROM journal_entries WHERE ref_type=?'
).get(refType).c;
function jeLines(jeId) {
  return db.prepare(`
    SELECT account_code, debit, credit, detail_account_id FROM journal_lines WHERE entry_id=? ORDER BY id
  `).all(jeId);
}

// ── fixtures ────────────────────────────────────────────────
const mkUser = (username, role) => db.prepare(
  "INSERT INTO users (username,password,name,role,active) VALUES (?,?,?,?,1)"
).run(username, 'x', username, role).lastInsertRowid;
const cashierId = mkUser('p8-cashier', 'store_retail');
const acctId = mkUser('p8-acct', 'accounting');
const acct2Id = mkUser('p8-acct2', 'accounting');
const salesId = mkUser('p8-sales', 'field_sales');
const cashier = { id: cashierId, role: 'store_retail' };
const accountant = { id: acctId, role: 'accounting' };
const accountant2 = { id: acct2Id, role: 'accounting' };
const sales = { id: salesId, role: 'field_sales' };

const box = db.prepare("INSERT INTO cash_boxes (name,is_petty_cash,active) VALUES ('صندوق فروشگاه',0,1)").run().lastInsertRowid;
const petty = db.prepare("INSERT INTO cash_boxes (name,is_petty_cash,active) VALUES ('تنخواه دفتر',1,1)").run().lastInsertRowid;
const owner = db.prepare("INSERT INTO persons (name,active) VALUES ('آقای مالک',1)").run().lastInsertRowid;
const DATE = '1405/08/10';

// ── COA key coa_owner_current ───────────────────────────────
ok('coa_owner_current در LEGACY', !!LEGACY.coa_owner_current && LEGACY.coa_owner_current.code === '2115');
ok('2115 در درخت پایه', baseCoaTree().some((r) => r[0] === '2115'));
ok('2115 در دفتر حساب‌ها ساخته شد', !!db.prepare("SELECT 1 FROM chart_of_accounts WHERE code='2115'").get());
eq('acct(coa_owner_current) پیش‌فرض ۲۱۱۵', Number(acct(db, 'coa_owner_current').code), 2115);
ok('نگاشت به حساب هزینه رد می‌شود', validateCoaKeyAssignment(db, 'coa_owner_current', '6102').ok === false);
ok('نگاشت به حساب بدهی/سرمایه مجاز', validateCoaKeyAssignment(db, 'coa_owner_current', '3101').ok === true);

// ── cashier: draft only ─────────────────────────────────────
const je0 = db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c;
const d1 = D.createDraft(db, cashier, {
  amount: 500000, date: DATE, category: 'admin', title: 'خرید ملزومات', source: 'cash_box', cash_box_id: box,
});
eq('پیش‌نویس ساخته شد', d1.id > 0 ? 1 : 0, 1);
ok('وضعیت pending', d1.status === 'pending');
eq('هیچ JE ساخته نشد', db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c, je0);
ok('journal_entry_id خالی', d1.journal_entry_id == null);
eq('مبلغ ریال صحیح', d1.amount, 500000);

rejects('صندوق‌دار تأیید نمی‌تواند', () => D.approveDraft(db, cashier, d1.id), 'E_DRAFT_FORBIDDEN');
rejects('صندوق‌دار رد نمی‌تواند', () => D.rejectDraft(db, cashier, d1.id, 'x'), 'E_DRAFT_FORBIDDEN');
rejects('صندوق‌دار ابطال نمی‌تواند', () => D.voidApprovedDraft(db, cashier, d1.id, 'x'), 'E_DRAFT_FORBIDDEN');
rejects('صندوق‌دار دسته نمی‌سازد', () => D.addLeafCategory(db, cashier, { name: 'دستهٔ من', parent_id: 1 }), 'E_DRAFT_FORBIDDEN');
rejects('صندوق‌دار کد حساب تعیین نمی‌کند', () => D.createDraft(db, cashier, {
  amount: 1000, date: DATE, category: 'admin', title: 'x', source: 'cash_box', cash_box_id: box, account_code: '6102',
}), 'E_DRAFT_FORBIDDEN');
rejects('نقش فروش اجازهٔ ثبت ندارد', () => D.createDraft(db, sales, {
  amount: 1000, date: DATE, category: 'admin', title: 'x', source: 'cash_box', cash_box_id: box,
}), 'E_DRAFT_FORBIDDEN');
ok('صندوق‌دار گزارش نمی‌بیند (نقش)', !D.isReviewer(cashier));
rejects('مبلغ اعشاری رد', () => D.createDraft(db, cashier, {
  amount: '1000.5', date: DATE, category: 'admin', title: 'x', source: 'cash_box', cash_box_id: box,
}), 'E_AMOUNT');
rejects('شرح الزامی', () => D.createDraft(db, cashier, {
  amount: 1000, date: DATE, category: 'admin', source: 'cash_box', cash_box_id: box,
}), 'E_DRAFT_TITLE');
rejects('منبع نامعتبر', () => D.createDraft(db, cashier, {
  amount: 1000, date: DATE, category: 'admin', title: 'x', source: 'bank', cash_box_id: box,
}), 'E_DRAFT_SOURCE');
rejects('تنخواه با صندوق عادی رد', () => D.createDraft(db, cashier, {
  amount: 1000, date: DATE, category: 'admin', title: 'x', source: 'petty_cash', cash_box_id: box,
}), 'E_DRAFT_PETTY');
rejects('مالک بدون شخص رد', () => D.createDraft(db, cashier, {
  amount: 1000, date: DATE, category: 'admin', title: 'x', source: 'owner',
}), 'E_DRAFT_OWNER');
rejects('دستهٔ ناموجود رد', () => D.createDraft(db, cashier, {
  amount: 1000, date: DATE, category: 'NO-SUCH', title: 'x', source: 'cash_box', cash_box_id: box,
}), 'E_DRAFT_CATEGORY');

// لیست: صندوق‌دار فقط پیش‌نویس‌های خودش
const accDraft = D.createDraft(db, accountant, {
  amount: 100000, date: DATE, category: 'admin', title: 'حسابدار', source: 'cash_box', cash_box_id: box,
});
eq('صندوق‌دار فقط خودش را می‌بیند', D.listDrafts(db, cashier).length, 1);
ok('حسابدار همه را می‌بیند', D.listDrafts(db, accountant).length >= 2);

// ویرایش توسط سازنده (pending) و ممنوعیت ویرایش دیگران
const e1 = D.editDraft(db, cashier, d1.id, { amount: 600000 });
eq('سازنده pending را ویرایش می‌کند', e1.amount, 600000);
rejects('صندوق‌دار draft حسابدار را ویرایش نمی‌کند', () => D.editDraft(db, cashier, accDraft.id, { amount: 5 }), 'E_DRAFT_FORBIDDEN');

// ── self-approve forbidden ──────────────────────────────────
rejects('سازنده نمی‌تواند خودش تأیید کند', () => D.approveDraft(db, accountant, accDraft.id), 'E_DRAFT_SELF_APPROVE');
eq('هنوز JE نیست', jeCount('expense_draft'), 0);

// ── approve with edit → balanced JE ─────────────────────────
const ap1 = D.approveDraft(db, accountant, d1.id, { amount: 650000, title: 'ملزومات اصلاح‌شده' });
ok('وضعیت approved', ap1.status === 'approved');
ok('journal_entry_id ثبت شد', ap1.journal_entry_id > 0);
eq('ویرایش پیش از تأیید اعمال شد', ap1.amount, 650000);
const l1 = jeLines(ap1.journal_entry_id);
eq('دو سطر سند', l1.length, 2);
eq('Dr حساب هزینه ۶۱۰۲', Number(l1[0].account_code), 6102);
eq('Dr = مبلغ (ریال)', l1.reduce((s, l) => s + Number(l.debit || 0), 0), l1.reduce((s, l) => s + Number(l.credit || 0), 0));
ok('Cr صندوق انتخاب‌شده', /^1101/.test(l1[1].account_code));
const head1 = db.prepare('SELECT ref_type, ref_id, entry_date, status FROM journal_entries WHERE id=?').get(ap1.journal_entry_id);
ok('ref_type=expense_draft', head1.ref_type === 'expense_draft' && head1.ref_id === d1.id);
ok('تاریخ سند = تاریخ هزینه', head1.entry_date === DATE);
rejects('تأیید دوباره رد', () => D.approveDraft(db, accountant2, d1.id), 'E_DRAFT_STATE');
rejects('ویرایش بعد از تأیید رد', () => D.editDraft(db, accountant2, d1.id, { amount: 1 }), 'E_DRAFT_STATE');
eq('فقط یک JE برای این هزینه', jeCount('expense_draft'), 1);

// ── second accountant approves accountant's draft ───────────
const ap2 = D.approveDraft(db, accountant2, accDraft.id);
ok('حسابدار دوم draft حسابدار اول را تأیید کرد', ap2.status === 'approved');

// ── petty cash ──────────────────────────────────────────────
const pd = D.createDraft(db, cashier, {
  amount: 200000, date: DATE, category: 'sales', title: 'پیک', source: 'petty_cash', cash_box_id: petty,
});
const pa = D.approveDraft(db, accountant, pd.id);
const pl = jeLines(pa.journal_entry_id);
eq('دسته فروش → ۶۱۰۳', Number(pl[0].account_code), 6103);
ok('Cr صندوق تنخواه', pl[1].account_code === db.prepare('SELECT coa_code FROM cash_boxes WHERE id=?').get(petty).coa_code
  || /^1101/.test(pl[1].account_code));

// ── owner source ────────────────────────────────────────────
const od = D.createDraft(db, cashier, {
  amount: 300000, date: DATE, category: 'admin', title: 'هزینه از جیب مالک', source: 'owner', owner_person_id: owner,
});
ok('owner بدون صندوق', od.source === 'owner' && od.cash_box_id == null);
const oa = D.approveDraft(db, accountant, od.id);
const ol = jeLines(oa.journal_entry_id);
eq('Cr حساب جاری مالک ۲۱۱۵', Number(ol[1].account_code), 2115);
ok('تفصیلی شخص مالک روی سطر', ol[1].detail_account_id > 0);
const da = db.prepare('SELECT * FROM detail_accounts WHERE id=?').get(ol[1].detail_account_id);
ok('تفصیلی به persons وصل است', da.linked_table === 'persons' && da.linked_id === owner);
const od2 = D.createDraft(db, cashier, {
  amount: 1000, date: DATE, category: 'admin', title: 'دوم', source: 'owner', owner_person_id: owner,
});
D.approveDraft(db, accountant, od2.id);
eq('تفصیلی مالک تکراری نشد', db.prepare("SELECT COUNT(*) c FROM detail_accounts WHERE linked_table='persons' AND linked_id=?").get(owner).c, 1);

// override کلید → حساب دیگر
db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,is_active) VALUES ('3150','جاری شرکا (سرمایه)','equity','3000',1)").run();
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_owner_current','3150')").run();
clearCoaCache();
const od3 = D.createDraft(db, cashier, {
  amount: 2000, date: DATE, category: 'admin', title: 'سوم', source: 'owner', owner_person_id: owner,
});
const oa3 = D.approveDraft(db, accountant, od3.id);
eq('کلید coa_owner_current قابل override', Number(jeLines(oa3.journal_entry_id)[1].account_code), 3150);
db.prepare("DELETE FROM settings WHERE key='coa_owner_current'").run();
clearCoaCache();

// ── reject ──────────────────────────────────────────────────
const rd = D.createDraft(db, cashier, {
  amount: 9000, date: DATE, category: 'admin', title: 'ردی', source: 'cash_box', cash_box_id: box,
});
rejects('رد بدون دلیل', () => D.rejectDraft(db, accountant, rd.id, ''), 'E_DRAFT_REASON');
const jeBeforeReject = db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c;
const rr = D.rejectDraft(db, accountant, rd.id, 'فاکتور ندارد');
ok('وضعیت rejected + دلیل', rr.status === 'rejected' && rr.reject_reason === 'فاکتور ندارد');
eq('رد سند نمی‌سازد', db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c, jeBeforeReject);
rejects('تأیید ردشده رد', () => D.approveDraft(db, accountant2, rd.id), 'E_DRAFT_STATE');

// ── cancel (own pending) ────────────────────────────────────
const cd = D.createDraft(db, cashier, {
  amount: 7000, date: DATE, category: 'admin', title: 'انصراف', source: 'cash_box', cash_box_id: box,
});
eq('انصراف سازنده', D.cancelDraft(db, cashier, cd.id).status === 'cancelled' ? 1 : 0, 1);
ok('ردیف فیزیکی حذف نشد', !!D.getDraft(db, cd.id));

// ── category add: only accounting, under 61xx ───────────────
const opts = D.draftOptions(db, accountant);
ok('گزینه‌های والد ۶۱xx موجود', opts.parents61.length >= 2);
ok('حسابدار can_add_category', opts.can_add_category === true);
ok('صندوق‌دار can_add_category=false', D.draftOptions(db, cashier).can_add_category === false);
const adminCat = db.prepare("SELECT id FROM expense_categories WHERE code='admin'").get();
const leaf = D.addLeafCategory(db, accountant, { name: 'هزینه نظافت', parent_id: adminCat.id });
ok('برگ جدید زیر والد', leaf.parent_id === adminCat.id && leaf.level >= 2);
rejects('دستهٔ تکراری رد', () => D.addLeafCategory(db, accountant, { name: 'هزینه نظافت', parent_id: adminCat.id }), 'E_CATEGORY_DUP');
rejects('بدون والد رد', () => D.addLeafCategory(db, accountant, { name: 'بی‌والد' }), 'E_CATEGORY_PARENT');
const nonSixty = db.prepare("INSERT INTO expense_categories (code,name,account_code,coa_code) VALUES ('X5','پنجاه‌ویک','5101','5101')").run().lastInsertRowid;
rejects('والد غیر ۶۱xx رد', () => D.addLeafCategory(db, accountant, { name: 'x', parent_id: nonSixty }), 'E_CATEGORY_PARENT');
const ld = D.createDraft(db, cashier, {
  amount: 40000, date: DATE, category: String(leaf.id), title: 'نظافت', source: 'cash_box', cash_box_id: box,
});
const la = D.approveDraft(db, accountant, ld.id);
eq('دستهٔ جدید حساب والد (۶۱۰۲) را ارث می‌برد', Number(jeLines(la.journal_entry_id)[0].account_code), 6102);

// سربار ساخت از این فرم ممنوع
const ohCat = db.prepare(`INSERT INTO expense_categories (code,name,account_code,coa_code,cost_section)
  VALUES ('OHX','سربار تست','5202','5202','production_overhead')`).run().lastInsertRowid;
rejects('دستهٔ سربار ساخت رد', () => D.createDraft(db, cashier, {
  amount: 1000, date: DATE, category: String(ohCat), title: 'x', source: 'cash_box', cash_box_id: box,
}), 'E_DRAFT_OVERHEAD');

// ── report ──────────────────────────────────────────────────
const rep = D.expenseDraftReport(db, { from: '1405/08/01', to: '1405/08/30' });
const approvedSum = db.prepare("SELECT SUM(amount) s, COUNT(*) c FROM expense_drafts WHERE status='approved'").get();
eq('جمع گزارش = جمع تأییدشده‌ها', rep.total, approvedSum.s);
eq('تعداد گزارش', rep.count, approvedSum.c);
ok('گزارش بر اساس منبع شامل owner/petty/cash', ['owner', 'petty_cash', 'cash_box'].every((s) => rep.by_source.some((r) => r.source === s)));
ok('گزارش بر اساس دسته', rep.by_category.length >= 3);
eq('بازهٔ خالی = ۰', D.expenseDraftReport(db, { from: '1400/01/01', to: '1400/01/02' }).total, 0);

// ── void (R13) ──────────────────────────────────────────────
const vId = ap1.journal_entry_id;
rejects('ابطال pending رد', () => D.voidApprovedDraft(db, accountant, accDraft.id + 999, 'x'), 'E_DRAFT_NOT_FOUND');
const vd = D.voidApprovedDraft(db, accountant, d1.id, 'اشتباه ثبت شد');
ok('وضعیت voided', vd.status === 'voided' && vd.void_reason === 'اشتباه ثبت شد');
const vHead = db.prepare('SELECT status, deleted_at FROM journal_entries WHERE id=?').get(vId);
ok('سند اصلی soft-void شد', ['reversed', 'void'].includes(String(vHead.status)) || Number(vHead.deleted_at) > 0);
rejects('ابطال دوباره رد', () => D.voidApprovedDraft(db, accountant, d1.id, 'x'), 'E_DRAFT_STATE');
ok('ردیف فیزیکی حذف نشد (void)', !!D.getDraft(db, d1.id));
eq('گزارش بعد از ابطال کم شد', D.expenseDraftReport(db, {}).total, rep.total - 650000);

// ── static wiring ───────────────────────────────────────────
const root = path.join(__dirname, '..');
const tables = fs.readFileSync(path.join(root, 'sync/tables.js'), 'utf8');
const capture = fs.readFileSync(path.join(root, 'sync/capture.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const { SYNCABLE_TABLES } = require('../sync/tables');
ok('expense_drafts در SYNCABLE_TABLES (append انتها)', SYNCABLE_TABLES.findIndex((t) => t.name === 'expense_drafts') > SYNCABLE_TABLES.findIndex((t) => t.name === 'opening_stock_lines'));
ok('cheque_book_leaves و opening_stock_* قبل از آن‌اند (ترتیب دست‌نخورده)',
  SYNCABLE_TABLES.findIndex((t) => t.name === 'opening_stock_lines') > SYNCABLE_TABLES.findIndex((t) => t.name === 'cheque_book_leaves'));
ok('PATH_TABLE_MAP: drafts قبل از expenses عمومی',
  capture.indexOf("'/api/expenses/drafts'") > 0
  && capture.indexOf("'/api/expenses/drafts'") < capture.indexOf("['/api/expenses', 'expense_payments']"));
ok('PATH_TABLE_MAP: drafts/categories قبل از drafts',
  capture.indexOf("'/api/expenses/drafts/categories'") < capture.indexOf("'/api/expenses/drafts'"));
ok('server.js: drafts قبل از /api/expenses',
  serverSrc.indexOf("'/api/expenses/drafts'") > 0
  && serverSrc.indexOf("'/api/expenses/drafts'") < serverSrc.indexOf("app.use('/api/expenses', require"));
ok('جدول expense_drafts ساخته شد و sync_seq دارد',
  db.prepare('PRAGMA table_info(expense_drafts)').all().some((c) => c.name === 'sync_seq'));
ok('flag sync_seq_backfill_v34', !!db.prepare("SELECT 1 FROM settings WHERE key='sync_seq_backfill_v34'").get());
ok('UI: ROUTES[expense-drafts]', /ROUTES\['expense-drafts'\]\s*=/.test(app));
ok('UI: منوی صندوق فروشگاه + حسابداری', /NAV_STORE = \[[^\]]*expense-drafts/.test(app) && /NAV_ACCOUNTING = \[[^\]]*expense-drafts/.test(app));
ok('راهنما: بخش هزینهٔ روزانه (ادمین + فروش)', (app.match(/هزینهٔ روزانه \(پیش‌نویس/g) || []).length >= 2);
ok('SW ≥ v591', swAtLeast(sw, 591));

// فرانت: بلوک script با new Function پارس شود
try { new Function(app); ok('app.js سینتکس معتبر', true); } catch (e) { ok('app.js سینتکس معتبر', false, e.message); }

// ── HTTP: گیت نقش در روتر (auth تقلبی با هدر x-test-user) ──────
async function httpTests() {
  const express = require('express');
  const authPath = require.resolve('../middleware/auth');
  const real = require(authPath);
  const byId = { [cashierId]: cashier, [acctId]: accountant, [acct2Id]: accountant2, [salesId]: sales };
  require.cache[authPath].exports = {
    ...real,
    auth: (req, res, next) => {
      const u = byId[Number(req.headers['x-test-user'])];
      if (!u) return res.status(401).json({ error: 'no user' });
      req.user = u;
      next();
    },
  };
  delete require.cache[require.resolve('../routes/expense-drafts')];
  const router = require('../routes/expense-drafts');
  const app2 = express();
  app2.use(express.json());
  app2.use('/api/expenses/drafts', router);
  const srv = await new Promise((r) => { const s = app2.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api/expenses/drafts`;
  const call = async (method, p, user, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-user': String(user || '') },
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = null;
    try { j = await res.json(); } catch (_) { /* empty */ }
    return { status: res.status, body: j };
  };
  try {
    const jeBefore = db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c;
    const c1 = await call('POST', '/', cashierId, {
      amount: 12000, date: DATE, category: 'admin', title: 'HTTP', source: 'cash_box', cash_box_id: box,
    });
    ok('HTTP: صندوق‌دار POST پیش‌نویس ۲۰۰', c1.status === 200 && c1.body.draft.status === 'pending');
    eq('HTTP: JE ساخته نشد', db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c, jeBefore);
    const id = c1.body.id;
    ok('HTTP: بدون توکن ۴۰۱', (await call('POST', '/', null, {})).status === 401);
    ok('HTTP: نقش فروش ۴۰۳', (await call('POST', '/', salesId, { amount: 1 })).status === 403);
    ok('HTTP: صندوق‌دار approve ۴۰۳', (await call('POST', `/${id}/approve`, cashierId, {})).status === 403);
    ok('HTTP: صندوق‌دار reject ۴۰۳', (await call('POST', `/${id}/reject`, cashierId, { reason: 'x' })).status === 403);
    ok('HTTP: صندوق‌دار categories ۴۰۳', (await call('POST', '/categories', cashierId, { name: 'x', parent_id: 1 })).status === 403);
    ok('HTTP: صندوق‌دار report ۴۰۳', (await call('GET', '/report', cashierId)).status === 403);
    const opt = await call('GET', '/options', cashierId);
    ok('HTTP: options برای صندوق‌دار', opt.status === 200 && opt.body.can_review === false && opt.body.categories.length > 0);
    const lst = await call('GET', '/', cashierId);
    ok('HTTP: لیست فقط مال خودش', lst.status === 200 && lst.body.every((r) => r.created_by === cashierId));
    const ap = await call('POST', `/${id}/approve`, acctId, {});
    ok('HTTP: حسابدار approve ۲۰۰ + JE', ap.status === 200 && ap.body.journal_entry_id > 0);
    ok('HTTP: approve دوباره ۴۰۹', (await call('POST', `/${id}/approve`, acct2Id, {})).status === 409);
    const rp = await call('GET', '/report?from=1405/08/01&to=1405/08/30', acctId);
    ok('HTTP: گزارش حسابدار', rp.status === 200 && rp.body.total > 0);
    const cat = await call('POST', '/categories', acctId, { name: 'دستهٔ HTTP', parent_id: adminCat.id });
    ok('HTTP: حسابدار دسته می‌سازد', cat.status === 200 && cat.body.parent_id === adminCat.id);
    const vv = await call('POST', `/${id}/void`, acctId, { reason: 'تست' });
    ok('HTTP: ابطال ۲۰۰', vv.status === 200 && vv.body.draft.status === 'voided');
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

httpTests().then(() => {
  ctx.cleanup();
  summary('expense drafts P8');
}).catch((e) => {
  console.error(e);
  ok('HTTP tests crashed', false, e.message);
  ctx.cleanup();
  summary('expense drafts P8');
});
