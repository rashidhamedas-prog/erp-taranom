'use strict';
const router = require('express').Router();
const { getDB } = require('../db');
const { auth, requirePermission } = require('../middleware/auth');
const {
  preview,
  postRevaluation,
  reverseRevaluation,
  listRevaluations,
  getRevaluation,
} = require('../lib/production/cost-revaluation');

function handle(res, fn) {
  try {
    res.json(fn());
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code || e.message, ...(e.extra || {}) });
  }
}

router.get('/', auth, requirePermission('production_cost', 'view'), (req, res) => {
  handle(res, () => ({ rows: listRevaluations(getDB(), { limit: req.query.limit }) }));
});

router.get('/:id', auth, requirePermission('production_cost', 'view'), (req, res) => {
  handle(res, () => getRevaluation(getDB(), req.params.id));
});

router.post('/preview', auth, requirePermission('production_cost', 'view'), (req, res) => {
  handle(res, () => preview(getDB(), req.body || {}));
});

router.post('/', auth, requirePermission('production_cost', 'edit'), (req, res) => {
  try {
    const out = postRevaluation(getDB(), req.body || {}, req.user);
    res.status(201).json(out);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code || e.message, ...(e.extra || {}) });
  }
});

router.post('/:id/reverse', auth, requirePermission('production_cost', 'edit'), (req, res) => {
  handle(res, () => reverseRevaluation(getDB(), req.params.id, req.user));
});

module.exports = router;
