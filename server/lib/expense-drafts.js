'use strict';
/**
 * P8 — فرم ساده هزینهٔ روزانه (پیش‌نویس → تأیید حسابدار).
 *
 * - صندوق‌دار (store_retail) فقط «پیش‌نویس» می‌سازد: status='pending' و بدون هیچ سند حسابداری (JE).
 * - فقط admin/accounting می‌تواند ویرایش کامل + تأیید کند؛ تأیید یگانه مسیر ثبت سند است
 *   (Dr حساب دسته / Cr صندوق | تنخواه | جاری مالک) و سازندهٔ پیش‌نویس نمی‌تواند خودش تأیید کند.
 * - ابطال (R13): سند تأییدشده با soft-void برمی‌گردد؛ حذف فیزیکی ممنوع.
 * - منبع owner: حساب کنترلی کلید `coa_owner_current` + تفصیلی شخص مالک (detail_accounts → persons).
 */

const SOURCES = ['cash_box', 'petty_cash', 'owner'];
const STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'voided'];
const CREATOR_ROLES = new Set(['store_retail', 'accounting', 'admin']);
const REVIEWER_ROLES = new Set(['accounting', 'admin']);

function httpErr(status, message, code) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

function ensureExpenseDraftSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS expense_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      amount INTEGER NOT NULL,
      category TEXT NOT NULL DEFAULT 'admin',
      title TEXT DEFAULT '',
      note TEXT DEFAULT '',
      source TEXT NOT NULL DEFAULT 'cash_box',
      cash_box_id INTEGER,
      owner_person_id INTEGER,
      cost_center_id INTEGER,
      account_code TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_by INTEGER,
      updated_at INTEGER,
      reviewed_by INTEGER,
      reviewed_at INTEGER,
      reject_reason TEXT DEFAULT '',
      journal_entry_id INTEGER,
      voided_by INTEGER,
      voided_at INTEGER,
      void_reason TEXT DEFAULT ''
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_expense_drafts_status ON expense_drafts(status, date)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_expense_drafts_creator ON expense_drafts(created_by)');
}

function canCreateDraft(user) {
  return !!(user && CREATOR_ROLES.has(String(user.role || '')));
}

function isReviewer(user) {
  return !!(user && REVIEWER_ROLES.has(String(user.role || '')));
}

function normSource(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!SOURCES.includes(s)) {
    throw httpErr(400, 'منبع پرداخت باید یکی از صندوق، تنخواه یا مالک باشد', 'E_DRAFT_SOURCE');
  }
  return s;
}

/** صندوق‌دار فروشگاه به صندوق ثابت خودش قفل است (sales_cash_box_id). */
function lockedCashBoxFor(db, user) {
  if (!user || String(user.role) !== 'store_retail') return null;
  const u = db.prepare('SELECT sales_cash_box_id FROM users WHERE id=?').get(user.id);
  return u && u.sales_cash_box_id ? Number(u.sales_cash_box_id) : null;
}

function assertBoxForSource(db, source, cashBoxId) {
  const { assertActiveCashBox } = require('./treasury-guards');
  const box = assertActiveCashBox(db, cashBoxId);
  const petty = Number(box.is_petty_cash) === 1;
  if (source === 'petty_cash' && !petty) {
    throw httpErr(400, 'برای منبع «تنخواه» باید صندوق تنخواه انتخاب شود', 'E_DRAFT_PETTY');
  }
  if (source === 'cash_box' && petty) {
    throw httpErr(400, 'صندوق تنخواه را با منبع «تنخواه» انتخاب کنید', 'E_DRAFT_PETTY');
  }
  return box;
}

function assertOwnerPerson(db, personId) {
  const id = require('./cash-payment-contract').strictPositiveId(personId, 'E_DRAFT_OWNER');
  if (!id) throw httpErr(400, 'شخص مالک را انتخاب کنید', 'E_DRAFT_OWNER');
  const p = db.prepare('SELECT id, name, active FROM persons WHERE id=?').get(id);
  if (!p) throw httpErr(400, 'شخص مالک یافت نشد', 'E_DRAFT_OWNER');
  if (Number(p.active) === 0) throw httpErr(400, 'شخص مالک غیرفعال است', 'E_DRAFT_OWNER');
  return p;
}

/**
 * Normalise + validate the editable fields of a draft. Returns the clean row fields.
 * `existing` supplies defaults when only part of the body is sent (accountant edit).
 */
function normalizeDraftFields(db, body, { user, existing = null } = {}) {
  const c = require('./cash-payment-contract');
  const b = body || {};
  const pick = (k, fallback) => (b[k] !== undefined ? b[k] : fallback);
  const source = normSource(pick('source', existing ? existing.source : null));
  const amount = c.parseStrictRial(pick('amount', existing ? existing.amount : null), 'مبلغ');
  const date = c.assertPaymentDate(db, pick('date', existing ? existing.date : null));
  const category = String(pick('category', existing ? existing.category : '') || '').trim();
  if (!category) throw httpErr(400, 'دستهٔ هزینه را انتخاب کنید', 'E_DRAFT_CATEGORY');
  const chain = resolveCategoryOrThrow(db, category);
  const title = String(pick('title', existing ? existing.title : '') || '').trim();
  const note = String(pick('note', existing ? existing.note : '') || '').trim();
  if (!title && !note) throw httpErr(400, 'شرح هزینه الزامی است', 'E_DRAFT_TITLE');

  let cashBoxId = null;
  let ownerPersonId = null;
  if (source === 'owner') {
    ownerPersonId = assertOwnerPerson(db, pick('owner_person_id', existing ? existing.owner_person_id : null)).id;
  } else {
    let rawBox = pick('cash_box_id', existing ? existing.cash_box_id : null);
    const locked = existing ? null : lockedCashBoxFor(db, user);
    if (locked && source === 'cash_box') rawBox = locked;
    cashBoxId = c.strictPositiveId(rawBox, 'E_CASH_BOX');
    assertBoxForSource(db, source, cashBoxId);
  }
  const ccRaw = pick('cost_center_id', existing ? existing.cost_center_id : null);
  const costCenterId = ccRaw ? (parseInt(ccRaw, 10) || null) : null;
  // کد حساب صریح فقط توسط حسابدار تعیین می‌شود (صندوق‌دار فقط دسته را انتخاب می‌کند).
  let accountCode = existing ? (existing.account_code || null) : null;
  if (b.account_code !== undefined) {
    if (!isReviewer(user)) {
      if (String(b.account_code || '').trim()) {
        throw httpErr(403, 'تعیین کد حساب فقط برای حسابدار مجاز است', 'E_DRAFT_FORBIDDEN');
      }
    } else {
      accountCode = String(b.account_code || '').trim() || null;
    }
  }
  return {
    date, amount, category, title, note, source,
    cash_box_id: cashBoxId, owner_person_id: ownerPersonId,
    cost_center_id: costCenterId, account_code: accountCode,
    _section: chain.section,
  };
}

function resolveCategoryOrThrow(db, category) {
  const { resolveCategoryChain, findExpenseCategory } = expensesRoute();
  const row = findExpenseCategory(db, category);
  // دستهٔ پیش‌فرض قدیمی (admin / sales) ممکن است ردیف نداشته باشد؛ فقط همین دو مجازند.
  if (!row && !['admin', 'sales'].includes(String(category))) {
    throw httpErr(400, 'دستهٔ هزینه یافت نشد یا غیرفعال است', 'E_DRAFT_CATEGORY');
  }
  const chain = resolveCategoryChain(db, category);
  if (chain.section === 'production_overhead') {
    throw httpErr(
      400,
      'سربار ساخت از فرم پرداخت هزینه (با مرکز هزینه) ثبت می‌شود، نه از فرم هزینهٔ روزانه',
      'E_DRAFT_OVERHEAD'
    );
  }
  return chain;
}

function expensesRoute() {
  // lazy: routes/expenses → db; avoids load-order cycles at boot
  return require('../routes/expenses');
}

function stripInternal(fields) {
  const out = { ...fields };
  delete out._section;
  return out;
}

function createDraft(db, user, body) {
  if (!canCreateDraft(user)) throw httpErr(403, 'دسترسی ثبت پیش‌نویس هزینه ندارید', 'E_DRAFT_FORBIDDEN');
  const f = stripInternal(normalizeDraftFields(db, body, { user }));
  const r = db.prepare(`
    INSERT INTO expense_drafts
      (date, amount, category, title, note, source, cash_box_id, owner_person_id,
       cost_center_id, account_code, status, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?)
  `).run(f.date, f.amount, f.category, f.title, f.note, f.source, f.cash_box_id,
    f.owner_person_id, f.cost_center_id, f.account_code, user.id);
  return getDraft(db, r.lastInsertRowid);
}

function getDraft(db, id) {
  return db.prepare('SELECT * FROM expense_drafts WHERE id=?').get(id) || null;
}

function updateDraftRow(db, id, f, userId) {
  db.prepare(`
    UPDATE expense_drafts SET date=?, amount=?, category=?, title=?, note=?, source=?,
      cash_box_id=?, owner_person_id=?, cost_center_id=?, account_code=?,
      updated_by=?, updated_at=strftime('%s','now')
    WHERE id=?
  `).run(f.date, f.amount, f.category, f.title, f.note, f.source, f.cash_box_id,
    f.owner_person_id, f.cost_center_id, f.account_code, userId, id);
}

/** Edit while pending: reviewer = full edit; creator = own draft only (no account_code). */
function editDraft(db, user, id, body) {
  const d = getDraft(db, id);
  if (!d) throw httpErr(404, 'پیش‌نویس یافت نشد', 'E_DRAFT_NOT_FOUND');
  if (d.status !== 'pending') throw httpErr(409, 'فقط پیش‌نویس در انتظار قابل ویرایش است', 'E_DRAFT_STATE');
  if (!isReviewer(user) && Number(d.created_by) !== Number(user.id)) {
    throw httpErr(403, 'فقط سازندهٔ پیش‌نویس یا حسابدار می‌تواند آن را ویرایش کند', 'E_DRAFT_FORBIDDEN');
  }
  const f = stripInternal(normalizeDraftFields(db, body, { user, existing: d }));
  updateDraftRow(db, id, f, user.id);
  return getDraft(db, id);
}

/** Dr expense account / Cr cash box | petty cash | owner current (+ owner tafsili). */
function buildApprovalLines(db, d, posting) {
  const { rialToLedger } = require('./money');
  const amount = Math.round(Number(d.amount) || 0);
  const desc = d.title || d.note || posting.account.name;
  const lines = [{
    code: posting.account.code, name: posting.account.name,
    debit: rialToLedger(amount), credit: 0, description: desc,
  }];
  if (d.source === 'owner') {
    const { acct } = require('./coa-map');
    const owner = acct(db, 'coa_owner_current');
    const person = db.prepare('SELECT id, name FROM persons WHERE id=?').get(d.owner_person_id);
    const detail = ensureOwnerDetailAccount(db, person);
    lines.push({
      code: owner.code, name: owner.name, debit: 0, credit: rialToLedger(amount),
      description: `هزینه پرداخت‌شده توسط ${person ? person.name : 'مالک'}`,
      detail_account_id: detail ? detail.id : null,
    });
  } else {
    const { resolveCashAccount } = require('../db');
    const cash = resolveCashAccount(db, 'cash', null, d.cash_box_id);
    lines.push({ code: cash.code, name: cash.name, debit: 0, credit: rialToLedger(amount), description: desc });
  }
  return lines;
}

/** Idempotent تفصیلی شخص مالک (linked_table=persons). */
function ensureOwnerDetailAccount(db, person) {
  if (!person) return null;
  const existing = db.prepare(
    "SELECT * FROM detail_accounts WHERE linked_table='persons' AND linked_id=? AND is_active=1"
  ).get(person.id);
  if (existing) return existing;
  try {
    db.prepare("INSERT OR IGNORE INTO detail_categories (code,name) VALUES ('owner','مالک / شرکا')").run();
  } catch (_) { /* optional */ }
  const cat = db.prepare("SELECT id FROM detail_categories WHERE code='owner'").get();
  let code = 'OWN-' + String(person.id).padStart(5, '0');
  for (let i = 0; i < 20; i += 1) {
    if (!db.prepare('SELECT id FROM detail_accounts WHERE code=?').get(code)) break;
    code = 'OWN-' + String(person.id).padStart(5, '0') + '-' + (i + 1);
  }
  const r = db.prepare(`
    INSERT INTO detail_accounts (code,name,detail_category_id,linked_table,linked_id,is_active)
    VALUES (?,?,?,?,?,1)
  `).run(code, person.name, cat ? cat.id : null, 'persons', person.id);
  return db.prepare('SELECT * FROM detail_accounts WHERE id=?').get(r.lastInsertRowid);
}

/**
 * Approve = یگانه مسیر ثبت سند. Atomic. `overrides` = ویرایش کامل پیش از تأیید.
 * Creator can never approve their own draft (maker ≠ checker).
 */
function approveDraft(db, user, id, overrides) {
  if (!isReviewer(user)) throw httpErr(403, 'فقط حسابدار می‌تواند پیش‌نویس هزینه را تأیید کند', 'E_DRAFT_FORBIDDEN');
  return db.transaction(() => {
    let d = getDraft(db, id);
    if (!d) throw httpErr(404, 'پیش‌نویس یافت نشد', 'E_DRAFT_NOT_FOUND');
    if (d.status !== 'pending') throw httpErr(409, 'این پیش‌نویس دیگر در انتظار تأیید نیست', 'E_DRAFT_STATE');
    if (Number(d.created_by) === Number(user.id)) {
      throw httpErr(403, 'سازندهٔ پیش‌نویس نمی‌تواند همان را تأیید کند', 'E_DRAFT_SELF_APPROVE');
    }
    if (overrides && Object.keys(overrides).length) {
      const f = stripInternal(normalizeDraftFields(db, overrides, { user, existing: d }));
      updateDraftRow(db, id, f, user.id);
      d = getDraft(db, id);
    }
    const posting = expensesRoute().resolveExpensePosting(db, {
      category: d.category, account_code: d.account_code, is_overhead: false,
      cost_center_id: d.cost_center_id, amount: d.amount,
    });
    if (posting.isOverhead) {
      throw httpErr(400, 'سربار ساخت از فرم هزینهٔ روزانه ثبت نمی‌شود', 'E_DRAFT_OVERHEAD');
    }
    const { postToLedger } = require('./ledger');
    const entryId = postToLedger(db, {
      sourceType: 'expense_draft', sourceId: d.id, date: d.date,
      description: `هزینهٔ روزانه: ${d.title || posting.account.name}`,
      createdBy: user.id, costCenterId: posting.costCenterId,
      lines: buildApprovalLines(db, d, posting),
    });
    db.prepare(`
      UPDATE expense_drafts SET status='approved', journal_entry_id=?, reviewed_by=?,
        reviewed_at=strftime('%s','now'), reject_reason='', account_code=?
      WHERE id=? AND status='pending'
    `).run(entryId, user.id, posting.account.code, d.id);
    return getDraft(db, d.id);
  })();
}

function rejectDraft(db, user, id, reason) {
  if (!isReviewer(user)) throw httpErr(403, 'فقط حسابدار می‌تواند پیش‌نویس را رد کند', 'E_DRAFT_FORBIDDEN');
  const why = String(reason || '').trim();
  if (!why) throw httpErr(400, 'دلیل رد الزامی است', 'E_DRAFT_REASON');
  const d = getDraft(db, id);
  if (!d) throw httpErr(404, 'پیش‌نویس یافت نشد', 'E_DRAFT_NOT_FOUND');
  if (d.status !== 'pending') throw httpErr(409, 'این پیش‌نویس دیگر در انتظار تأیید نیست', 'E_DRAFT_STATE');
  db.prepare(`
    UPDATE expense_drafts SET status='rejected', reject_reason=?, reviewed_by=?,
      reviewed_at=strftime('%s','now') WHERE id=? AND status='pending'
  `).run(why, user.id, id);
  return getDraft(db, id);
}

/** Creator withdraws own pending draft (status only — no physical delete). */
function cancelDraft(db, user, id) {
  const d = getDraft(db, id);
  if (!d) throw httpErr(404, 'پیش‌نویس یافت نشد', 'E_DRAFT_NOT_FOUND');
  if (d.status !== 'pending') throw httpErr(409, 'فقط پیش‌نویس در انتظار قابل انصراف است', 'E_DRAFT_STATE');
  if (!isReviewer(user) && Number(d.created_by) !== Number(user.id)) {
    throw httpErr(403, 'فقط سازنده یا حسابدار می‌تواند پیش‌نویس را لغو کند', 'E_DRAFT_FORBIDDEN');
  }
  db.prepare(`
    UPDATE expense_drafts SET status='cancelled', updated_by=?, updated_at=strftime('%s','now')
    WHERE id=? AND status='pending'
  `).run(user.id, id);
  return getDraft(db, id);
}

/** R13 — ابطال هزینهٔ تأییدشده: reverse کامل سند در یک تراکنش. */
function voidApprovedDraft(db, user, id, reason) {
  if (!isReviewer(user)) throw httpErr(403, 'فقط حسابدار می‌تواند هزینهٔ تأییدشده را ابطال کند', 'E_DRAFT_FORBIDDEN');
  return db.transaction(() => {
    const d = getDraft(db, id);
    if (!d) throw httpErr(404, 'پیش‌نویس یافت نشد', 'E_DRAFT_NOT_FOUND');
    if (d.status !== 'approved') throw httpErr(409, 'فقط هزینهٔ تأییدشده قابل ابطال است', 'E_DRAFT_STATE');
    const { postToLedger } = require('./ledger');
    const { todayJalali } = require('../jalali');
    postToLedger(db, {
      sourceType: 'expense_draft_reversal', sourceId: d.id, date: todayJalali(),
      description: `ابطال هزینهٔ روزانه #${d.id}`, createdBy: user.id, lines: [],
    });
    db.prepare(`
      UPDATE expense_drafts SET status='voided', voided_by=?, voided_at=strftime('%s','now'),
        void_reason=? WHERE id=? AND status='approved'
    `).run(user.id, String(reason || '').trim(), d.id);
    return getDraft(db, d.id);
  })();
}

function listDrafts(db, user, q = {}) {
  const where = [];
  const params = [];
  if (!isReviewer(user)) { where.push('d.created_by=?'); params.push(user.id); }
  if (q.status && STATUSES.includes(String(q.status))) { where.push('d.status=?'); params.push(String(q.status)); }
  if (q.from) { where.push('d.date>=?'); params.push(String(q.from)); }
  if (q.to) { where.push('d.date<=?'); params.push(String(q.to)); }
  return db.prepare(`
    SELECT d.*, u.name AS creator_name, rv.name AS reviewer_name, cb.name AS cash_box_name,
      p.name AS owner_name,
      COALESCE(
        (SELECT c.name FROM expense_categories c WHERE c.code=d.category AND c.active=1 LIMIT 1),
        (SELECT c.name FROM expense_categories c WHERE c.id=CAST(d.category AS INTEGER) LIMIT 1),
        d.category
      ) AS category_name
    FROM expense_drafts d
    LEFT JOIN users u ON u.id=d.created_by
    LEFT JOIN users rv ON rv.id=d.reviewed_by
    LEFT JOIN cash_boxes cb ON cb.id=d.cash_box_id
    LEFT JOIN persons p ON p.id=d.owner_person_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY (d.status='pending') DESC, d.date DESC, d.id DESC
    LIMIT 500
  `).all(...params);
}

/** گزارش هزینهٔ تأییدشده بر اساس دسته / منبع در بازه. */
function expenseDraftReport(db, { from, to } = {}) {
  const where = ["d.status='approved'"];
  const params = [];
  if (from) { where.push('d.date>=?'); params.push(String(from)); }
  if (to) { where.push('d.date<=?'); params.push(String(to)); }
  const w = where.join(' AND ');
  const catName = `COALESCE(
      (SELECT c.name FROM expense_categories c WHERE c.code=d.category AND c.active=1 LIMIT 1),
      (SELECT c.name FROM expense_categories c WHERE c.id=CAST(d.category AS INTEGER) LIMIT 1),
      d.category)`;
  const by_category = db.prepare(`
    SELECT d.category AS category, ${catName} AS category_name,
      COUNT(*) AS count, COALESCE(SUM(d.amount),0) AS total
    FROM expense_drafts d WHERE ${w} GROUP BY d.category ORDER BY total DESC
  `).all(...params);
  const by_source = db.prepare(`
    SELECT d.source AS source, COUNT(*) AS count, COALESCE(SUM(d.amount),0) AS total
    FROM expense_drafts d WHERE ${w} GROUP BY d.source ORDER BY total DESC
  `).all(...params);
  const total = db.prepare(`SELECT COALESCE(SUM(d.amount),0) AS t, COUNT(*) AS c FROM expense_drafts d WHERE ${w}`)
    .get(...params);
  return { from: from || null, to: to || null, total: total.t, count: total.c, by_category, by_source };
}

/** Options for the form: boxes, categories, owner persons, eligible 61xx parents. */
function draftOptions(db, user) {
  const { resolveCategoryChain } = expensesRoute();
  const locked = lockedCashBoxFor(db, user);
  const boxes = db.prepare(
    'SELECT id, name, is_petty_cash FROM cash_boxes WHERE active=1 ORDER BY is_petty_cash, id'
  ).all().filter((b) => !locked || b.id === locked || Number(b.is_petty_cash) === 1);
  const categories = db.prepare('SELECT * FROM expense_categories WHERE active=1 ORDER BY id').all()
    .map((c) => {
      const chain = resolveCategoryChain(db, String(c.id));
      return {
        id: c.id, code: c.code, name: c.name, parent_id: c.parent_id || null,
        account_code: chain.accountCode || c.coa_code || c.account_code || null,
        section: chain.section || null,
      };
    })
    .filter((c) => c.section !== 'production_overhead');
  const owners = db.prepare('SELECT id, name FROM persons WHERE COALESCE(active,1)=1 ORDER BY name LIMIT 500').all();
  const parents61 = categories.filter((c) => String(c.account_code || '').startsWith('61'));
  return {
    sources: SOURCES, boxes, categories, owners, parents61,
    locked_cash_box_id: locked,
    can_review: isReviewer(user),
    can_add_category: isReviewer(user),
  };
}

/** افزودن دستهٔ (برگ) جدید زیر یک دستهٔ 61xx — فقط حسابدار/ادمین. حساب را از والد ارث می‌برد. */
function addLeafCategory(db, user, body) {
  if (!isReviewer(user)) throw httpErr(403, 'افزودن دسته فقط برای حسابدار مجاز است', 'E_DRAFT_FORBIDDEN');
  const name = String((body && body.name) || '').trim();
  if (!name) throw httpErr(400, 'نام دسته الزامی است', 'E_CATEGORY_NAME');
  const parentId = parseInt(body && body.parent_id, 10);
  const parent = parentId ? db.prepare('SELECT * FROM expense_categories WHERE id=? AND active=1').get(parentId) : null;
  if (!parent) throw httpErr(400, 'دستهٔ والد (۶۱xx) را انتخاب کنید', 'E_CATEGORY_PARENT');
  const chain = expensesRoute().resolveCategoryChain(db, String(parent.id));
  if (!String(chain.accountCode || '').startsWith('61')) {
    throw httpErr(400, 'دستهٔ والد باید زیر حساب‌های ۶۱xx باشد', 'E_CATEGORY_PARENT');
  }
  if (chain.section === 'production_overhead') {
    throw httpErr(400, 'زیر دستهٔ سربار ساخت نمی‌توان دستهٔ روزانه ساخت', 'E_CATEGORY_PARENT');
  }
  const dup = db.prepare(
    'SELECT 1 FROM expense_categories WHERE active=1 AND parent_id=? AND name=?'
  ).get(parent.id, name);
  if (dup) throw httpErr(409, 'این دسته قبلاً زیر همین والد ثبت شده است', 'E_CATEGORY_DUP');
  const r = db.prepare(`
    INSERT INTO expense_categories (code,name,account_code,coa_code,parent_id,level,cost_section)
    VALUES (NULL,?,NULL,NULL,?,?,NULL)
  `).run(name, parent.id, (parent.level || 1) + 1);
  return db.prepare('SELECT * FROM expense_categories WHERE id=?').get(r.lastInsertRowid);
}

module.exports = {
  SOURCES, STATUSES, httpErr,
  ensureExpenseDraftSchema, canCreateDraft, isReviewer,
  createDraft, editDraft, approveDraft, rejectDraft, cancelDraft, voidApprovedDraft,
  listDrafts, getDraft, expenseDraftReport, draftOptions, addLeafCategory,
  ensureOwnerDetailAccount, buildApprovalLines,
};
