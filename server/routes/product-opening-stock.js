'use strict';
/**
 * موجودی اول دوره جدا از موجودی کل (/api/inventory/…) — قبل از routes/inventory سوار می‌شود.
 *   GET  /opening-stock?product_id=     → بخش موجودی اول دوره کارت کالا (view یا دسترسی کالا)
 *   POST /opening-stock/preview          → پیش‌نمایش فقط‌خواندنی (opening_stock:edit)
 *   POST /opening-stock/apply            → اجرا (opening_stock:edit + reason≥5 + confirm:true) — فقط مرکز
 *   GET  /opening-duplicates             → needs_review / no_je
 *   POST /opening-stock/migrate          → مهاجرت یک‌باره (admin + فقط مرکز؛ پیش‌فرض dry_run)
 */
const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, centralOnlyStrict } = require('../middleware/auth');
const POS = require('../lib/inventory/product-opening-stock');

function sendErr(res, e) {
  const status = e && e.status ? e.status : 500;
  if (status >= 500) console.error('product-opening-stock:', e);
  const body = { error: (e && e.message) || String(e), code: (e && e.code) || undefined };
  for (const k of ['errors', 'warnings', 'product_id', 'warehouse_id', 'variant_id', 'available', 'needed', 'doc_id', 'ledger_id', 'je_id', 'shortages']) {
    if (e && e[k] !== undefined) body[k] = e[k];
  }
  return res.status(status).json(body);
}

function requireView(req, res, next) {
  if (POS.canView(req.user, getDB())) return next();
  return res.status(403).json({ error: 'برای مشاهدهٔ موجودی اول دوره دسترسی لازم است', code: 'E_PERMISSION' });
}
function requireEdit(req, res, next) {
  if (POS.canEdit(req.user, getDB())) return next();
  return res.status(403).json({ error: 'برای اصلاح موجودی اول دوره مجوز «موجودی اول دوره: ویرایش» لازم است', code: 'E_PERMISSION' });
}
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  return res.status(403).json({ error: 'فقط مدیر سیستم', code: 'E_PERMISSION' });
}

router.get('/opening-stock', auth, requireView, (req, res) => {
  try {
    const pid = parseInt(req.query.product_id, 10);
    if (!pid) return res.status(400).json({ error: 'product_id الزامی است', code: 'E_OPENING_LINE' });
    res.json(POS.getProductOpening(getDB(), pid, req.user));
  } catch (e) { sendErr(res, e); }
});

router.post('/opening-stock/preview', auth, requireEdit, (req, res) => {
  try {
    res.json(POS.planOpeningChange(getDB(), req.body || {}, req.user));
  } catch (e) { sendErr(res, e); }
});

router.post('/opening-stock/apply', auth, requireEdit, centralOnlyStrict, (req, res) => {
  try {
    const out = POS.applyOpeningChange(getDB(), req.body || {}, req.user, {
      audit: (uid, action, entity, entityId, detail) => audit(uid, action, entity, entityId, detail, req),
    });
    res.json(out);
  } catch (e) { sendErr(res, e); }
});

router.get('/opening-duplicates', auth, requireView, (req, res) => {
  try {
    res.json(POS.listOpeningIssues(getDB(), req.user));
  } catch (e) { sendErr(res, e); }
});

router.post('/opening-stock/migrate', auth, requireAdmin, centralOnlyStrict, (req, res) => {
  try {
    const b = req.body || {};
    const dryRun = !(b.dry_run === false || b.dry_run === 0 || b.dry_run === '0' || b.dry_run === 'false');
    const rep = POS.migrateProductOpeningStock(getDB(), { dryRun, userId: req.user.id });
    if (!dryRun) {
      audit(req.user.id, 'opening_stock_migrate', 'product_opening_stock', null, JSON.stringify({
        combos_total: rep.combos_total, created: rep.created, skipped_existing: rep.skipped_existing, totals: rep.totals,
      }), req);
    }
    res.json(rep);
  } catch (e) { sendErr(res, e); }
});

module.exports = router;
