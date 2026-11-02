'use strict';
/**
 * P2 — اسناد موجودی اول دوره (/api/opening-stock).
 *   GET  /meta            → مجوزهای کاربر
 *   GET  /                → فهرست اسناد (?status=draft|posted|void)
 *   GET  /:id             → سند + ردیف‌ها
 *   POST /                → پیش‌نویس (acc_warehouse_ops:create) — بدون اثر روی موجودی/دفتر
 *   POST /:id/post        → ثبت قطعی (کاربر غیر از سازنده — maker-checker)
 *   POST /:id/void        → ابطال کامل R13 (acc_warehouse_ops:delete) — حذف فیزیکی ندارد
 *   POST /rolls           → P7: پیش‌نویس اول دورهٔ مواد/طاقه (چند طاقه زیر یک خط کالا×انبار) — مدیر/حسابداری
 *   POST /:id/rolls-amend → P7: ویرایش = ابطال کامل سند + پیش‌نویس جدید (amends_doc_id) — مدیر/حسابداری
 */
const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth } = require('../middleware/auth');
const OS = require('../lib/inventory/opening-stock');

function sendErr(res, e) {
  const status = e && e.status ? e.status : 500;
  if (status >= 500) console.error('opening-stock:', e);
  return res.status(status).json({ error: (e && e.message) || String(e), code: (e && e.code) || undefined });
}

function need(check, message) {
  return (req, res, next) => {
    if (check(req.user, getDB())) return next();
    return res.status(403).json({ error: message, code: 'E_PERMISSION' });
  };
}
const requireView = need(OS.canView, 'برای مشاهدهٔ اسناد افتتاحیهٔ انبار دسترسی لازم است');
const requireCreate = need(OS.canCreate, 'برای ثبت سند افتتاحیهٔ انبار مجوز «انبار: ایجاد» لازم است');
const requirePost = need(OS.canPost, 'برای ثبت قطعی سند افتتاحیه مجوز «انبار: ایجاد» لازم است');
const requireVoid = need(OS.canVoid, 'برای ابطال سند افتتاحیه مجوز «انبار: حذف/ابطال» لازم است');

router.get('/meta', auth, (req, res) => {
  const db = getDB();
  res.json({
    can_view: OS.canView(req.user, db),
    can_create: OS.canCreate(req.user, db),
    can_post: OS.canPost(req.user, db),
    can_void: OS.canVoid(req.user, db),
  });
});

router.get('/', auth, requireView, (req, res) => {
  try {
    res.json({ rows: OS.listDocs(getDB(), { status: req.query.status, limit: req.query.limit }) });
  } catch (e) { sendErr(res, e); }
});

router.get('/:id', auth, requireView, (req, res) => {
  try {
    const doc = OS.getDoc(getDB(), parseInt(req.params.id, 10));
    if (!doc) return res.status(404).json({ error: 'سند افتتاحیه یافت نشد', code: 'E_OPENING_NOT_FOUND' });
    res.json(doc);
  } catch (e) { sendErr(res, e); }
});

router.post('/', auth, requireCreate, (req, res) => {
  try {
    const doc = OS.createDraft(getDB(), req.body || {}, req.user);
    audit(req.user.id, 'create', 'opening_stock_doc', doc.id, `پیش‌نویس ${doc.doc_no} — ${doc.lines.length} ردیف`);
    res.json(doc);
  } catch (e) { sendErr(res, e); }
});

// P7 — حالت «اول دوره» در دریافت مواد / طاقه (فقط مدیر و حسابداری).
const OR = require('../lib/inventory/opening-rolls');
function requireAdminOrAccounting(req, res, next) {
  if (OR.isAdminOrAccounting(req.user)) return next();
  return res.status(403).json({ error: 'موجودی اول دوره مواد/طاقه فقط برای مدیر و حسابداری مجاز است', code: 'E_PERMISSION' });
}

router.post('/rolls', auth, requireAdminOrAccounting, requireCreate, (req, res) => {
  try {
    const doc = OR.createRollsDraft(getDB(), req.body || {}, req.user);
    const rolls = doc.lines.reduce((a, l) => a + ((l.rolls && l.rolls.length) || 0), 0);
    audit(req.user.id, 'create', 'opening_stock_doc', doc.id, `پیش‌نویس اول دوره مواد/طاقه ${doc.doc_no} — ${doc.lines.length} ردیف، ${rolls} طاقه/بچ`);
    res.json(doc);
  } catch (e) { sendErr(res, e); }
});

// POST (نه PUT): پاسخ سند جدید با id است تا سینک شناسهٔ موقت دستگاه را remap کند.
router.post('/:id/rolls-amend', auth, requireAdminOrAccounting, requireCreate, requireVoid, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const out = OR.amendRollsDoc(getDB(), id, req.body || {}, req.user);
    const reason = String((req.body || {}).reason || '').trim();
    audit(req.user.id, 'void', 'opening_stock_doc', id, `ابطال برای ویرایش ${out.voided.doc_no} — ${reason}`);
    audit(req.user.id, 'update', 'opening_stock_doc', out.doc.id, `ویرایش ${out.voided.doc_no} ⇒ پیش‌نویس ${out.doc.doc_no} — ${reason}`);
    res.json({ ...out.doc, voided_doc: { id: out.voided.id, doc_no: out.voided.doc_no, status: out.voided.status } });
  } catch (e) { sendErr(res, e); }
});

router.post('/:id/post', auth, requirePost, (req, res) => {
  try {
    const doc = OS.postDoc(getDB(), parseInt(req.params.id, 10), req.user);
    audit(req.user.id, 'post', 'opening_stock_doc', doc.id, `ثبت قطعی ${doc.doc_no} — JE ${doc.je_id}`);
    res.json(doc);
  } catch (e) { sendErr(res, e); }
});

router.post('/:id/void', auth, requireVoid, (req, res) => {
  try {
    const doc = OS.voidDoc(getDB(), parseInt(req.params.id, 10), req.user, { reason: (req.body || {}).reason });
    audit(req.user.id, 'void', 'opening_stock_doc', doc.id, `ابطال ${doc.doc_no} — ${doc.void_reason || ''}`);
    res.json(doc);
  } catch (e) { sendErr(res, e); }
});

module.exports = router;
