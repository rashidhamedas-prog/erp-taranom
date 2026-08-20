'use strict';
const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, requirePermission } = require('../middleware/auth');
const {
  planCutting, listCuttingLays, getCuttingLay, postCuttingLay, voidCuttingLay,
  postCuttingPack, voidCuttingPackByLay, getCuttingPack, linkCuttingLayOrder,
} = require('../lib/production/cutting');
const { listFabricRolls } = require('../lib/inventory/fabric-rolls');
const { canSeeCost, stripCostFields } = require('../lib/production/access');

function sendRow(req, res, data) {
  if (!canSeeCost(getDB(), req.user)) data = stripCostFields(data);
  return res.json(data);
}

function sendErr(res, e) {
  const status = e.status || 400;
  return res.status(status).json({ error: e.message || String(e), code: e.code || undefined });
}

router.get('/preview', auth, requirePermission('production', 'view'), (req, res) => {
  try {
    const db = getDB();
    let breakdown = req.query.size_breakdown;
    if (typeof breakdown === 'string') {
      try { breakdown = JSON.parse(breakdown); } catch (_) { breakdown = {}; }
    }
    sendRow(req, res, planCutting(db, {
      product_id: req.query.product_id,
      bom_id: req.query.bom_id,
      fabric_product_id: req.query.fabric_product_id,
      marker_length_m: req.query.marker_length_m,
      ply_count: req.query.ply_count,
      actual_meters: req.query.actual_meters,
      size_breakdown: breakdown,
      date: req.query.date,
    }));
  } catch (e) { sendErr(res, e); }
});

router.get('/rolls', auth, requirePermission('production', 'view'), (req, res) => {
  try {
    const rows = listFabricRolls(getDB(), req.query).map((b) => ({
      id: b.id,
      batch_no: b.batch_no,
      color: b.color,
      pattern: b.pattern,
      width_cm: b.width_cm,
      qty_on_hand: b.qty_on_hand,
      product_id: b.product_id,
      product_name: b.product_name,
      warehouse_id: b.warehouse_id,
      warehouse_code: b.warehouse_code,
      status: b.status,
    }));
    sendRow(req, res, { rows });
  } catch (e) { sendErr(res, e); }
});

router.get('/', auth, requirePermission('production', 'view'), (req, res) => {
  try {
    sendRow(req, res, { rows: listCuttingLays(getDB(), req.query) });
  } catch (e) { sendErr(res, e); }
});

router.get('/:id', auth, requirePermission('production', 'view'), (req, res) => {
  try {
    sendRow(req, res, getCuttingLay(getDB(), req.params.id));
  } catch (e) { sendErr(res, e); }
});

router.post('/', auth, requirePermission('production', 'create'), (req, res) => {
  try {
    const db = getDB();
    const row = postCuttingLay(db, req.body || {}, req.user);
    audit(req.user.id, 'create', 'cutting_lay', row.id, `لایه‌چینی ${row.lay_no}`);
    sendRow(req, res, row);
  } catch (e) { sendErr(res, e); }
});

router.post('/:id/void', auth, requirePermission('production', 'create'), (req, res) => {
  try {
    const db = getDB();
    const row = voidCuttingLay(db, req.params.id, req.user, { reason: req.body && req.body.reason });
    audit(req.user.id, 'reverse', 'cutting_lay', row.id, 'ابطال لایه‌چینی');
    sendRow(req, res, row);
  } catch (e) { sendErr(res, e); }
});

router.post('/:id/link-order', auth, requirePermission('production', 'create'), (req, res) => {
  try {
    const db = getDB();
    const row = linkCuttingLayOrder(db, req.params.id, req.body && req.body.production_order_id, req.user);
    audit(req.user.id, 'update', 'cutting_lay', row.id, `پیوند سفارش ${row.production_order_id}`);
    sendRow(req, res, row);
  } catch (e) { sendErr(res, e); }
});

router.get('/:id/pack', auth, requirePermission('production', 'view'), (req, res) => {
  try {
    const db = getDB();
    const lay = getCuttingLay(db, req.params.id);
    const pack = (lay.packs || []).find((p) => p.status === 'posted');
    if (!pack) return res.status(404).json({ error: 'رسید برش فعال نیست', code: 'E_PACK' });
    sendRow(req, res, getCuttingPack(db, pack.id));
  } catch (e) { sendErr(res, e); }
});

router.post('/:id/pack', auth, requirePermission('production', 'create'), (req, res) => {
  try {
    const db = getDB();
    const row = postCuttingPack(db, req.params.id, req.body || {}, req.user);
    audit(req.user.id, 'create', 'cutting_pack', row.id, `رسید برش ${row.pack_no}`);
    sendRow(req, res, row);
  } catch (e) { sendErr(res, e); }
});

router.post('/:id/pack/void', auth, requirePermission('production', 'create'), (req, res) => {
  try {
    const db = getDB();
    const row = voidCuttingPackByLay(db, req.params.id, req.user, { reason: req.body && req.body.reason });
    audit(req.user.id, 'reverse', 'cutting_pack', row.id, 'ابطال رسید برش');
    sendRow(req, res, row);
  } catch (e) { sendErr(res, e); }
});

module.exports = router;
