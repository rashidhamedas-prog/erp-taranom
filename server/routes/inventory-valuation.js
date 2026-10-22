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
const VAP = require('../lib/inventory/value-approval');
const PL = require('../lib/inventory/period-lock');
const VA = require('../lib/inventory/value-accounts');

/**
 * v522 — single gate for valuation actions: view | post | approve | policy | reverse | period_lock.
 * Today: admin/accounting (period_lock: admin only). Finer RBAC plugs in here only.
 */
const VALUATION_CAPS = {
  post: ['acc_inv_valuation', 'create'],
  approve: ['acc_inv_valuation', 'approve'],
  policy: ['acc_inv_valuation', 'edit'],
  reverse: ['acc_inv_valuation', 'delete'],
  period_lock: ['acc_inv_period_lock', 'approve'],
};

function requireValuationAction(req, action) {
  const user = req.user;
  if (!user) return false;
  if (action === 'view') return true;
  if (user.role === 'admin') return true;
  const cap = VALUATION_CAPS[action];
  if (!cap) return false;
  try {
    const rbac = require('../lib/rbac');
    if (typeof rbac.canDo === 'function') return !!rbac.canDo(user, cap[0], cap[1]);
  } catch (_) { /* fall back to role defaults */ }
  if (action === 'period_lock' || action === 'policy') return false;
  return user.role === 'accounting';
}

function gate(action) {
  return (req, res, next) => {
    if (requireValuationAction(req, action)) return next();
    return res.status(403).json({
      error: action === 'period_lock' ? 'بستن/بازکردن قفل ماهانه فقط برای مدیر مجاز است' : 'دسترسی ندارید',
      code: 'E_VALUATION_FORBIDDEN',
      action,
    });
  };
}

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
const can = (action) => [auth, centralOnlyStrict, gate(action)];
void adminOrAccounting;

function reasonAccountsOut(db) {
  return {
    reasons: VA.ADJUST_REASONS,
    mapping: VA.getReasonAccounts(db),
    stage_defaults: {
      materials: VA.shortageSurplusAccount(db),
      wip: require('../lib/coa-map').acct(db, 'coa_overhead_control'),
      goods: require('../lib/coa-map').acct(db, 'coa_cogs'),
    },
    clearing_account: VA.clearingAccount(db),
    price_variance_account: VA.priceVarianceAccount(db),
  };
}

router.get('/policy', ...canView, (req, res) => {
  handle(res, (db) => ({ ...V.getPolicy(db), adjust_reason_accounts: reasonAccountsOut(db) }));
});

router.put('/policy', ...can('policy'), (req, res) => {
  handle(res, (db) => {
    const body = req.body || {};
    const out = db.transaction(() => {
      if (body.adjust_reason_accounts !== undefined) VA.setReasonAccounts(db, body.adjust_reason_accounts);
      const rest = { ...body };
      delete rest.adjust_reason_accounts;
      return Object.keys(rest).length ? V.setPolicy(db, rest) : V.getPolicy(db);
    })();
    return { ...out, adjust_reason_accounts: reasonAccountsOut(db) };
  });
});

router.get('/adjust-reasons', ...canView, (req, res) => {
  handle(res, (db) => reasonAccountsOut(db));
});

/* ── v522 value-change approvals ── */
router.get('/approvals', ...canView, (req, res) => {
  handle(res, (db) => ({ rows: VAP.list(db, { status: req.query.status || 'pending', reason: req.query.reason, limit: req.query.limit }) }));
});

router.get('/approvals/:id', ...canView, (req, res) => {
  handle(res, (db) => VAP.get(db, req.params.id));
});

router.post('/approvals/:id/approve', ...can('approve'), (req, res) => {
  handle(res, (db) => VAP.approve(db, req.params.id, req.user, req.body || {}));
});

router.post('/approvals/:id/reject', ...can('approve'), (req, res) => {
  handle(res, (db) => VAP.reject(db, req.params.id, req.user, req.body || {}));
});

router.post('/approvals/:id/reopen', ...can('reverse'), (req, res) => {
  handle(res, (db) => VAP.reopen(db, req.params.id, req.user, { reason: req.body && req.body.reason }));
});

/* ── v522 monthly inventory lock ── */
router.get('/periods', ...canView, (req, res) => {
  handle(res, (db) => ({ rows: PL.listPeriods(db, { limit: req.query.limit }) }));
});

router.post('/periods/:y/:m/close', ...can('period_lock'), (req, res) => {
  handle(res, (db) => PL.closePeriod(db, `${req.params.y}/${req.params.m}`, req.user, { reason: req.body && req.body.reason }));
});

router.post('/periods/:y/:m/reopen', ...can('period_lock'), (req, res) => {
  handle(res, (db) => PL.reopenPeriod(db, `${req.params.y}/${req.params.m}`, req.user, { reason: req.body && req.body.reason }));
});

router.post('/periods/:period/close', ...can('period_lock'), (req, res) => {
  handle(res, (db) => PL.closePeriod(db, req.params.period, req.user, { reason: req.body && req.body.reason }));
});

router.post('/periods/:period/reopen', ...can('period_lock'), (req, res) => {
  handle(res, (db) => PL.reopenPeriod(db, req.params.period, req.user, { reason: req.body && req.body.reason }));
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

router.post('/queue/:id/ignore', ...can('post'), (req, res) => {
  handle(res, (db) => V.ignoreQueueItem(db, req.params.id));
});

router.post('/revaluations/preview', ...canView, (req, res) => {
  handle(res, (db) => R.preview(db, req.body || {}));
});

router.post('/revaluations', ...can('post'), (req, res) => {
  handle(res, (db) => R.post(db, req.body || {}, req.user), 201);
});

router.get('/revaluations', ...canView, (req, res) => {
  handle(res, (db) => ({ rows: R.list(db, { limit: req.query.limit, status: req.query.status || null }) }));
});

router.get('/revaluations/:id', ...canView, (req, res) => {
  handle(res, (db) => R.get(db, req.params.id));
});

router.post('/revaluations/:id/reverse', ...can('reverse'), (req, res) => {
  handle(res, (db) => R.reverse(db, req.params.id, req.user, { reason: req.body && req.body.reason }));
});

router.get('/rules', ...canView, (req, res) => {
  handle(res, (db) => ({ rows: R.listRules(db), semantics: R.AUTO_SEMANTICS }));
});

router.post('/rules', ...can('policy'), (req, res) => {
  handle(res, (db) => R.createRule(db, req.body || {}, req.user), 201);
});

router.put('/rules/:id', ...can('policy'), (req, res) => {
  handle(res, (db) => R.updateRule(db, req.params.id, req.body || {}));
});

router.post('/rules/:id/toggle', ...can('policy'), (req, res) => {
  handle(res, (db) => R.toggleRule(db, req.params.id, req.body && req.body.enabled != null ? !!req.body.enabled : null));
});

router.post('/auto/run', ...can('post'), (req, res) => {
  handle(res, (db) => R.runAutoRules(db, {
    dryRun: !(req.body && (req.body.dry_run === false || req.body.dry_run === 0 || req.body.dry_run === '0')),
    ruleId: req.body && req.body.rule_id ? parseInt(req.body.rule_id, 10) : null,
    user: req.user,
  }));
});

module.exports = router;
module.exports.requireValuationAction = requireValuationAction;
