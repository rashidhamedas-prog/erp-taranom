'use strict';
const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, requirePermission } = require('../middleware/auth');
const {
  planCutting, listCuttingLays, getCuttingLay, postCuttingLay, voidCuttingLay,
} = require('../lib/production/cutting');
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
      marker_length_m: req.query.marker_length_m,
      ply_count: req.query.ply_count,
      actual_meters: req.query.actual_meters,
      size_breakdown: breakdown,
      date: req.query.date,
    }));
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

module.exports = router;
