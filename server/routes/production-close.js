'use strict';
const router = require('express').Router();
const { getDB } = require('../db');
const { auth, adminOnly, requirePermission } = require('../middleware/auth');
const close = require('../lib/production/close');

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
    const data = fn();
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

router.get('/', auth, requirePermission('production_close', 'view'), (req, res) => {
  handle(res, () => ({ periods: close.listPeriods(getDB()) }));
});

router.get('/:period', auth, requirePermission('production_close', 'view'), (req, res) => {
  handle(res, () => close.getPeriodStatus(getDB(), req.params.period));
});

router.post('/:period/open', auth, requirePermission('production_close', 'approve'), (req, res) => {
  handle(res, () => close.openPeriod(getDB(), {
    period: req.params.period,
    startDate: req.body?.start_date,
    endDate: req.body?.end_date,
    userId: req.user.id,
  }));
});

router.post('/:period/precheck', auth, requirePermission('production_close', 'approve'), (req, res) => {
  handle(res, () => close.precheck(getDB(), { period: req.params.period }));
});

router.post('/:period/calculate', auth, requirePermission('production_close', 'approve'), (req, res) => {
  handle(res, () => close.calculate(getDB(), {
    period: req.params.period,
    method: req.body?.method,
  }));
});

router.post('/:period/execute', auth, requirePermission('production_close', 'approve'), (req, res) => {
  if (req.user.role === 'production_manager') {
    return res.status(403).json({ error: 'مدیر تولید نمی‌تواند دوره را ببندد', code: 'E_FORBIDDEN' });
  }
  withIdempotency(req, res, `close-execute-${req.params.period}`, () => close.execute(getDB(), {
    period: req.params.period,
    method: req.body?.method,
    userId: req.user.id,
    date: req.body?.date,
  }));
});

router.post('/:period/reopen', auth, adminOnly, requirePermission('production_close', 'approve'), (req, res) => {
  const reason = req.body?.reason;
  if (!reason || !String(reason).trim()) {
    return res.status(422).json({ error: 'دلیل بازکردن دوره الزامی است', code: 'E_REASON_REQUIRED' });
  }
  handle(res, () => close.reopen(getDB(), {
    period: req.params.period,
    reason: String(reason).trim(),
    userId: req.user.id,
  }));
});

router.get('/:period/variances', auth, requirePermission('production_close', 'view'), (req, res) => {
  handle(res, () => close.getVariances(getDB(), req.params.period));
});

router.get('/:period/journal', auth, requirePermission('production_close', 'view'), (req, res) => {
  handle(res, () => close.getJournal(getDB(), req.params.period));
});

module.exports = router;
