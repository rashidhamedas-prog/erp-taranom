'use strict';
/**
 * P7 — qty-only supplier receipts (/api/warehouses/qty-receipts).
 * Cashier: qty_receipt:create (or acc_warehouse_ops:create) — never receives amounts.
 * Costing (ریالی‌سازی): cost_visibility:view + acc_purchases:create.
 */
const router = require('express').Router();
const { getDB } = require('../db');
const { auth } = require('../middleware/auth');
const { hasPermission } = require('../lib/rbac');
const { canSeeCostVisibility } = require('../lib/cost-visibility');
const QR = require('../lib/inventory/qty-receipt');

function anyOf(...pairs) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'توکن یافت نشد' });
    const db = getDB();
    if (pairs.some(([r, a]) => hasPermission(db, req.user, r, a))) return next();
    return res.status(403).json({ error: 'دسترسی ندارید', code: 'E_PERMISSION', resource: pairs[0][0], action: pairs[0][1] });
  };
}

const canView = anyOf(['qty_receipt', 'view'], ['acc_warehouse_ops', 'view']);
const canCreate = anyOf(['qty_receipt', 'create'], ['acc_warehouse_ops', 'create']);
const canVoid = anyOf(['qty_receipt', 'delete'], ['acc_warehouse_ops', 'delete']);

function canCost(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'توکن یافت نشد' });
  const db = getDB();
  if (canSeeCostVisibility(db, req.user) && hasPermission(db, req.user, 'acc_purchases', 'create')) return next();
  return res.status(403).json({
    error: 'ریالی‌سازی رسید نیاز به مجوز «مشاهدهٔ بها» و «ایجاد فاکتور خرید» دارد',
    code: 'E_PERMISSION', resource: 'cost_visibility+acc_purchases', action: 'view+create',
  });
}

function sendErr(res, e) {
  res.status(e.status || 400).json({ error: e.message, code: e.code });
}

/** Form options without any monetary field: active warehouses + suppliers (id, name). */
router.get('/options', auth, canCreate, (req, res) => {
  try {
    const db = getDB();
    res.json({
      warehouses: db.prepare('SELECT id, name, code FROM warehouses WHERE COALESCE(active,1)=1 ORDER BY name').all(),
      suppliers: db.prepare('SELECT id, name FROM suppliers ORDER BY name').all(),
    });
  } catch (e) { sendErr(res, e); }
});

/** Product picker (name / code / barcode / SKU) — same search as warehouse docs, no cost columns. */
router.get('/products', auth, canCreate, (req, res) => {
  try {
    const { searchWarehouseLineProducts } = require('../lib/inventory/product-line-search');
    const db = getDB();
    const out = searchWarehouseLineProducts(db, req.user, req.query);
    const rows = (Array.isArray(out) ? out : (out.data || [])).map((p) => ({
      id: p.id, code: p.code, name: p.name, barcode: p.barcode, unit: p.unit,
    }));
    res.json(rows);
  } catch (e) { sendErr(res, e); }
});

router.get('/', auth, canView, (req, res) => {
  try {
    const db = getDB();
    const withCost = canSeeCostVisibility(db, req.user);
    const docs = QR.listQtyReceipts(db, {
      status: String(req.query.status || ''),
      limit: req.query.limit,
      includeReversed: req.query.include_reversed === '1',
    });
    res.json(docs.map((d) => QR.presentQtyReceipt(db, d, { withCost })));
  } catch (e) { sendErr(res, e); }
});

router.get('/:id', auth, canView, (req, res) => {
  try {
    const db = getDB();
    const doc = QR.loadQtyDoc(db, req.params.id);
    res.json(QR.presentQtyReceipt(db, doc, { withCost: canSeeCostVisibility(db, req.user) }));
  } catch (e) { sendErr(res, e); }
});

router.post('/', auth, canCreate, (req, res) => {
  try {
    const db = getDB();
    const created = QR.createQtyReceipt(db, req.body || {}, req.user);
    const withCost = canSeeCostVisibility(db, req.user);
    res.json({
      ok: true,
      id: created.id,
      doc_id: created.id,
      num: created.num,
      ...(created.stocktake_warning ? { stocktake_warning: true, warning: created.warning } : {}),
      receipt: QR.presentQtyReceipt(db, created.doc, { withCost }),
    });
  } catch (e) { sendErr(res, e); }
});

router.post('/:id/void', auth, canVoid, (req, res) => {
  try {
    const db = getDB();
    const r = QR.voidQtyReceipt(db, req.params.id, req.user, { reason: req.body && req.body.reason });
    res.json({ ok: true, doc_id: r.doc_id, num: r.num, count: r.count });
  } catch (e) { sendErr(res, e); }
});

router.post('/:id/cost', auth, canCost, (req, res) => {
  try {
    const db = getDB();
    const inv = QR.costQtyReceipt(db, req.params.id, req.body || {}, req.user);
    res.json({ ok: true, id: inv.id, purchase_invoice_id: inv.id, num: inv.num, purchase: inv });
  } catch (e) { sendErr(res, e); }
});

module.exports = router;
