'use strict';
/**
 * /api/inventory-valuation — valuation policy, buckets, dirty queue, revaluation documents
 * and auto-revaluation rules (v521). Reads: production_cost.view. Mutations: admin/accounting
 * on the central server only (tables are central-only, not synced).
 */
const router = require('express').Router();
const { getDB } = require('../db');
const { auth, requirePermission, adminOrAccounting, centralOnlyStrict } = require('../middleware/auth');
const V = require('../lib/inventory/valuation');
const R = require('../lib/inventory/revaluation');

function sendErr(res, e) {
  const status = e.status || 500;
  const msg = status >= 500 && !e.code ? 'خطای داخلی سرور' : e.message;
  res.status(status).json({ error: msg, code: e.code || 'E_INTERNAL', ...(e.extra || {}) });
}

function handle(res, fn, okStatus = 200) {
  try {
    const db = getDB();
    V.ready(db);
    res.status(okStatus).json(fn(db));
  } catch (e) {
    sendErr(res, e);
  }
}

const canView = [auth, requirePermission('production_cost', 'view')];
const canEdit = [auth, centralOnlyStrict, adminOrAccounting];

router.get('/policy', ...canView, (req, res) => {
  handle(res, (db) => V.getPolicy(db));
});

router.put('/policy', ...canEdit, (req, res) => {
  handle(res, (db) => V.setPolicy(db, req.body || {}));
});

router.get('/effective', ...canView, (req, res) => {
  handle(res, (db) => {
    const productId = parseInt(req.query.product_id, 10);
    if (!productId) throw Object.assign(new Error('شناسه کالا الزامی است'), { status: 400, code: 'E_PRODUCT_REQUIRED' });
    return V.explainEffective(db, {
      productId,
      warehouseId: parseInt(req.query.warehouse_id, 10) || null,
    });
  });
});

router.get('/buckets', ...canView, (req, res) => {
  handle(res, (db) => ({ rows: V.listBuckets(db, { productId: parseInt(req.query.product_id, 10) || null }) }));
});

router.get('/queue', ...canView, (req, res) => {
  handle(res, (db) => ({
    rows: V.listQueue(db, {
      status: req.query.status || 'pending',
      productId: parseInt(req.query.product_id, 10) || null,
      limit: req.query.limit,
    }),
  }));
});

router.post('/queue/:id/ignore', ...canEdit, (req, res) => {
  handle(res, (db) => V.ignoreQueueItem(db, req.params.id));
});

router.post('/revaluations/preview', ...canView, (req, res) => {
  handle(res, (db) => R.preview(db, req.body || {}));
});

router.post('/revaluations', ...canEdit, (req, res) => {
  handle(res, (db) => R.post(db, req.body || {}, req.user), 201);
});

router.get('/revaluations', ...canView, (req, res) => {
  handle(res, (db) => ({ rows: R.list(db, { limit: req.query.limit, status: req.query.status || null }) }));
});

router.get('/revaluations/:id', ...canView, (req, res) => {
  handle(res, (db) => R.get(db, req.params.id));
});

router.post('/revaluations/:id/reverse', ...canEdit, (req, res) => {
  handle(res, (db) => R.reverse(db, req.params.id, req.user, { reason: req.body && req.body.reason }));
});

router.get('/rules', ...canView, (req, res) => {
  handle(res, (db) => ({ rows: R.listRules(db), semantics: R.AUTO_SEMANTICS }));
});

router.post('/rules', ...canEdit, (req, res) => {
  handle(res, (db) => R.createRule(db, req.body || {}, req.user), 201);
});

router.put('/rules/:id', ...canEdit, (req, res) => {
  handle(res, (db) => R.updateRule(db, req.params.id, req.body || {}));
});

router.post('/rules/:id/toggle', ...canEdit, (req, res) => {
  handle(res, (db) => R.toggleRule(db, req.params.id, req.body && req.body.enabled != null ? !!req.body.enabled : null));
});

router.post('/auto/run', ...canEdit, (req, res) => {
  handle(res, (db) => R.runAutoRules(db, {
    dryRun: !(req.body && (req.body.dry_run === false || req.body.dry_run === 0 || req.body.dry_run === '0')),
    ruleId: req.body && req.body.rule_id ? parseInt(req.body.rule_id, 10) : null,
    user: req.user,
  }));
});

module.exports = router;
