'use strict';
const router = require('express').Router();
const { getDB } = require('../db');
const { auth, requirePermission } = require('../middleware/auth');
const reports = require('../lib/production/reports');
const { toCsv, toExcel, toPdf } = require('../lib/production/report-export');
const { sendSecureHtml } = require('../lib/secure-html-response');
const { err } = require('../lib/production/posting');

function handle(res, fn) {
  try {
    res.json(fn());
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({
      error: e.message,
      code: e.code || e.message,
      ...(e.extra || {}),
    });
  }
}

function qp(req) {
  const q = req.query || {};
  return {
    period: q.period,
    date: q.date,
    from: q.from,
    to: q.to,
    status: q.status,
    product_id: q.product_id ? Number(q.product_id) : undefined,
    productId: q.product_id ? Number(q.product_id) : undefined,
    order_id: q.order_id ? Number(q.order_id) : undefined,
    orderId: q.order_id ? Number(q.order_id) : undefined,
    cc_id: q.cc_id ? Number(q.cc_id) : undefined,
    type: q.type,
    page: q.page,
    limit: q.limit,
    months: q.months,
    compare: q.compare,
  };
}

function runNamed(req, res, name, extra = {}) {
  handle(res, () => reports.runReport(getDB(), {
    name,
    params: { ...qp(req), ...extra },
    user: req.user,
  }));
}

async function maybeExport(req, res, result) {
  const fmt = (req.query.format || 'json').toLowerCase();
  if (fmt === 'json') return res.json(result);
  if (fmt === 'csv') {
    res.type('text/csv; charset=utf-8');
    return res.send(toCsv(result));
  }
  if (fmt === 'excel' || fmt === 'xlsx') {
    const x = await toExcel(result);
    if (x.format === 'xlsx') {
      res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      return res.send(x.buffer);
    }
    res.type('text/csv; charset=utf-8');
    return res.send(x.data);
  }
  if (fmt === 'pdf') {
    const p = toPdf(result);
    return sendSecureHtml(res, p.html);
  }
  return res.json(result);
}

router.get('/', auth, requirePermission('production_reports', 'view'), (req, res) => {
  handle(res, () => ({ reports: reports.catalog() }));
});

router.get('/orders', auth, requirePermission('production_reports', 'view'), (req, res) => {
  runNamed(req, res, 'PR-01');
});

router.get('/cost-sheet', auth, requirePermission('production_reports', 'view'), async (req, res) => {
  if (!req.query.order_id) {
    return res.status(422).json({ error: 'order_id الزامی است', code: 'E_ORDER_REQUIRED' });
  }
  try {
    const result = reports.runReport(getDB(), {
      name: 'PR-02',
      params: qp(req),
      user: req.user,
    });
    return await maybeExport(req, res, result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code || e.message });
  }
});

router.get('/kanban', auth, requirePermission('production_reports', 'view'), (req, res) => {
  runNamed(req, res, 'PR-03');
});

router.get('/wip', auth, requirePermission('production_reports', 'view'), (req, res) => {
  runNamed(req, res, 'PR-10');
});

router.get('/variance-matrix', auth, requirePermission('production_reports', 'view'), (req, res) => {
  runNamed(req, res, 'PR-11');
});

router.get('/monthly-profit', auth, requirePermission('production_reports', 'view'), (req, res) => {
  runNamed(req, res, 'PR-23');
});

router.get('/dashboard', auth, requirePermission('production_reports', 'view'), (req, res) => {
  runNamed(req, res, 'PR-24');
});

router.get('/waste', auth, requirePermission('production_reports', 'view'), (req, res) => {
  runNamed(req, res, 'PR-15');
});

router.get('/overhead-variance', auth, requirePermission('production_reports', 'view'), (req, res) => {
  runNamed(req, res, 'PR-14');
});

router.get('/yield', auth, requirePermission('production_reports', 'view'), (req, res) => {
  runNamed(req, res, 'PR-16');
});

router.get('/material-usage', auth, requirePermission('production_reports', 'view'), (req, res) => {
  runNamed(req, res, 'PR-20');
});

router.get('/period-cost', auth, requirePermission('production_reports', 'view'), (req, res) => {
  runNamed(req, res, 'PR-06');
});

router.get('/std-vs-actual', auth, requirePermission('production_reports', 'view'), (req, res) => {
  runNamed(req, res, 'PR-08');
});

router.get('/unit-cost-trend', auth, requirePermission('production_reports', 'view'), (req, res) => {
  runNamed(req, res, 'PR-07');
});

router.get('/bottleneck', auth, requirePermission('production_reports', 'view'), (req, res) => {
  runNamed(req, res, 'PR-19');
});

router.get('/product-profitability', auth, requirePermission('production_reports', 'view'), (req, res) => {
  runNamed(req, res, 'PR-22');
});

router.get('/reconciliation', auth, requirePermission('production_reports', 'view'), (req, res) => {
  runNamed(req, res, 'PR-99');
});

router.get('/cycle-time', auth, requirePermission('production_reports', 'view'), (req, res) => {
  runNamed(req, res, 'PR-05');
});

router.get('/material-variance', auth, requirePermission('production_reports', 'view'), (req, res) => {
  runNamed(req, res, 'PR-12');
});

router.get('/variance-reasons', auth, requirePermission('production_reports', 'view'), (req, res) => {
  runNamed(req, res, 'PR-13');
});

router.get('/rework', auth, requirePermission('production_reports', 'view'), (req, res) => {
  runNamed(req, res, 'PR-17');
});

router.get('/cost-center-performance', auth, requirePermission('production_reports', 'view'), (req, res) => {
  runNamed(req, res, 'PR-18');
});

router.get('/subcontractor-performance', auth, requirePermission('production_reports', 'view'), (req, res) => {
  runNamed(req, res, 'PR-21');
});

router.get('/:code/export', auth, requirePermission('production_reports', 'export'), async (req, res) => {
  try {
    const code = String(req.params.code || '').toUpperCase();
    if (!reports.REPORTS[code]) throw err('E_NOT_FOUND', 404);
    const result = reports.runReport(getDB(), {
      name: code,
      params: qp(req),
      user: req.user,
    });
    return await maybeExport(req, res, result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code || e.message });
  }
});

module.exports = router;
