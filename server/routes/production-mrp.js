'use strict';
const router = require('express').Router();
const { getDB } = require('../db');
const { auth, requirePermission } = require('../middleware/auth');
const { estimateCost, saveEstimate } = require('../lib/production/estimate');
const { mrpRun } = require('../lib/production/mrp');
const { canSeeCost, stripCostFields } = require('../lib/production/access');

function handle(res, fn, req) {
  try {
    let data = fn();
    if (req && !canSeeCost(getDB(), req.user)) data = stripCostFields(data);
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message,
      code: e.code || e.message,
      ...(e.extra || {}),
    });
  }
}

router.post('/estimate', auth, requirePermission('production', 'view'), (req, res) => {
  handle(res, () => estimateCost(getDB(), req.body || {}), req);
});

router.get('/estimate', auth, requirePermission('production', 'view'), (req, res) => {
  handle(res, () => estimateCost(getDB(), {
    productId: Number(req.query.product_id),
    qty: Number(req.query.qty),
    period: req.query.period,
    date: req.query.date,
    bomId: req.query.bom_id ? Number(req.query.bom_id) : null,
    priceBasis: req.query.price_basis || 'average',
  }), req);
});

router.post('/estimates', auth, requirePermission('production', 'create'), (req, res) => {
  handle(res, () => saveEstimate(getDB(), req.body || {}, req.user.id), req);
});

router.post('/run', auth, requirePermission('production', 'view'), (req, res) => {
  handle(res, () => mrpRun(getDB(), {
    horizonDays: req.body?.horizon_days || req.query.horizon_days,
    date: req.body?.date || req.query.date,
    demandSource: req.body?.demand_source || 'orders',
    userId: req.user.id,
  }));
});

router.get('/runs/:id', auth, requirePermission('production', 'view'), (req, res) => {
  handle(res, () => {
    const db = getDB();
    const run = db.prepare('SELECT * FROM mrp_runs WHERE id=?').get(Number(req.params.id));
    if (!run) throw Object.assign(new Error('E_NOT_FOUND'), { code: 'E_NOT_FOUND', status: 404 });
    const requirements = db.prepare(`
      SELECT mr.*, p.name AS product_name FROM mrp_requirements mr
      LEFT JOIN products p ON p.id = mr.product_id WHERE mr.run_id=?
    `).all(run.id);
    return { run, requirements };
  });
});

module.exports = router;
