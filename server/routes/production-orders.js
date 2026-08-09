'use strict';
const router = require('express').Router();
const { getDB } = require('../db');
const { auth, requirePermission } = require('../middleware/auth');
const engine = require('../lib/production/engine');
const { varianceAnalysis } = require('../lib/production/variance');
const { canSeeCost, stripCostFields, applyCostPolicy } = require('../lib/production/access');

function handle(res, fn) {
  try {
    const data = fn();
    res.json(data);
  } catch (e) {
    const status = e.status || 500;
    const msg = String(e.message || '');
    const code = e.code || (msg.startsWith('E_') ? msg.split(':')[0] : msg);
    res.status(status).json({ error: msg, code, ...(e.extra || {}) });
  }
}

function withIdempotency(req, res, endpoint, fn) {
  const key = req.get('Idempotency-Key') || req.get('idempotency-key');
  const db = getDB();
  if (key) {
    const hit = db.prepare('SELECT response_json FROM production_idempotency WHERE key=?').get(key);
    if (hit?.response_json) {
      return res.json(JSON.parse(hit.response_json));
    }
  }
  try {
    let data = fn();
    if (!canSeeCost(db, req.user)) data = stripCostFields(data);
    if (key) {
      try {
        db.prepare(`
          INSERT OR IGNORE INTO production_idempotency (key, endpoint, user_id, response_json)
          VALUES (?,?,?,?)
        `).run(key, endpoint, req.user.id, JSON.stringify(data));
      } catch { /* ignore */ }
    }
    res.json(data);
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({
      error: e.message,
      code: e.code || e.message,
      ...(e.extra || {}),
    });
  }
}

router.get('/', auth, requirePermission('production', 'view'), (req, res) => {
  handle(res, () => engine.listOrders(getDB(), {
    status: req.query.status,
    productId: req.query.product_id ? Number(req.query.product_id) : null,
    period: req.query.period,
    page: req.query.page,
    limit: req.query.limit,
  }));
});

router.post('/', auth, requirePermission('production', 'create'), (req, res) => {
  if (req.user.role === 'production_operator') {
    return res.status(403).json({ error: 'اپراتور نمی‌تواند سفارش ایجاد کند', code: 'E_FORBIDDEN' });
  }
  try {
    const data = engine.createOrder(getDB(), req.body || {}, req.user.id);
    res.status(201).json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code || e.message });
  }
});

router.get('/:id/issue-template', auth, requirePermission('production', 'view'), (req, res) => {
  handle(res, () => {
    const db = getDB();
    const data = engine.issueTemplate(db, {
      orderId: Number(req.params.id),
      qtyStarted: req.query.qty_started,
    });
    return applyCostPolicy(db, req.user, data);
  });
});

router.get('/:id/issue-preview', auth, requirePermission('production', 'view'), (req, res) => {
  handle(res, () => {
    const db = getDB();
    const data = engine.previewMaterialIssue(db, {
      orderId: Number(req.params.id),
      body: req.body || {
        qty_started: req.query.qty_started,
        materials: req.query.materials ? JSON.parse(req.query.materials) : undefined,
      },
    });
    return applyCostPolicy(db, req.user, data);
  });
});

router.post('/:id/issue', auth, requirePermission('production', 'create'), (req, res) => {
  withIdempotency(req, res, 'issue', () =>
    engine.issueMaterialsVariable(getDB(), {
      orderId: Number(req.params.id),
      body: req.body || {},
      userId: req.user.id,
    })
  );
});

router.post('/:id/return', auth, requirePermission('production', 'create'), (req, res) => {
  withIdempotency(req, res, 'return', () =>
    engine.postMaterialReturn(getDB(), {
      orderId: Number(req.params.id),
      body: req.body || {},
      userId: req.user.id,
    })
  );
});

router.get('/:id/issues', auth, requirePermission('production', 'view'), (req, res) => {
  handle(res, () => {
    const db = getDB();
    const rows = engine.listIssues(db, Number(req.params.id));
    return applyCostPolicy(db, req.user, { order_id: Number(req.params.id), rows });
  });
});

router.get('/:id/variance-analysis', auth, requirePermission('production', 'view'), (req, res) => {
  handle(res, () => {
    const db = getDB();
    const data = varianceAnalysis(db, Number(req.params.id));
    return applyCostPolicy(db, req.user, data);
  });
});

router.get('/:id/preview', auth, requirePermission('production', 'view'), (req, res) => {
  handle(res, () => engine.previewReceiptFixed(getDB(), {
    orderId: Number(req.params.id),
    body: {
      qty_produced: Number(req.query.qty_produced),
      waste_normal: Number(req.query.waste_normal) || 0,
      waste_abnormal: Number(req.query.waste_abnormal) || 0,
      date: req.query.date,
      labor: req.query.labor ? JSON.parse(req.query.labor) : undefined,
      scrap: req.query.scrap ? JSON.parse(req.query.scrap) : undefined,
    },
  }));
});

router.post('/:id/receipt', auth, requirePermission('production', 'create'), (req, res) => {
  withIdempotency(req, res, 'receipt', () => {
    const db = getDB();
    const po = engine.getOrderDetail(db, Number(req.params.id));
    const fn = po.analysis_type === 'variable'
      ? engine.postReceiptVariable
      : engine.postReceiptFixed;
    return fn(db, {
      orderId: Number(req.params.id),
      body: req.body || {},
      userId: req.user.id,
    });
  });
});

router.post('/:id/release', auth, requirePermission('production', 'edit'), (req, res) => {
  handle(res, () => engine.releaseOrder(getDB(), Number(req.params.id), req.user.id));
});

router.post('/:id/cancel', auth, requirePermission('production', 'edit'), (req, res) => {
  handle(res, () => engine.cancelOrder(getDB(), Number(req.params.id), req.user.id, req.body?.reason));
});

router.post('/:id/close', auth, requirePermission('production_close', 'edit'), (req, res) => {
  handle(res, () => engine.closeOrder(getDB(), Number(req.params.id), req.user.id));
});

router.post('/:id/reopen', auth, requirePermission('production_close', 'edit'), (req, res) => {
  handle(res, () => engine.reopenOrder(getDB(), Number(req.params.id), req.user.id));
});

router.post('/:id/reverse', auth, requirePermission('production', 'delete'), (req, res) => {
  handle(res, () => engine.reverseOrder(
    getDB(), Number(req.params.id), req.user.id, req.body?.reason || ''
  ));
});

router.get('/:id/wip', auth, requirePermission('production', 'view'), (req, res) => {
  handle(res, () => ({
    order_id: Number(req.params.id),
    wip_residual_rial: engine.wipResidual(getDB(), Number(req.params.id)),
  }));
});

router.put('/:id', auth, requirePermission('production', 'edit'), (req, res) => {
  handle(res, () => engine.updateOrder(getDB(), Number(req.params.id), req.body || {}));
});

router.get('/:id', auth, requirePermission('production', 'view'), (req, res) => {
  handle(res, () => {
    const db = getDB();
    return applyCostPolicy(db, req.user, engine.getOrderDetail(db, Number(req.params.id)));
  });
});

module.exports = router;
