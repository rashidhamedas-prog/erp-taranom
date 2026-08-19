'use strict';
const router = require('express').Router();
const { getDB } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const {
  listConsignments,
  createConsignment,
  settleConsignment,
  voidConsignment,
} = require('../lib/consignments');

function sendErr(res, e) {
  const status = e.status || 400;
  return res.status(status).json({ error: e.message, code: e.code || undefined });
}

router.get('/', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const rows = listConsignments(db, {
      direction: req.query.direction,
      status: req.query.status,
    });
    res.json(rows);
  } catch (e) {
    sendErr(res, e);
  }
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    res.json(createConsignment(db, req.body || {}, req.user));
  } catch (e) {
    sendErr(res, e);
  }
});

router.post('/:id/settle', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    res.json(settleConsignment(db, req.params.id, req.body || {}, req.user));
  } catch (e) {
    sendErr(res, e);
  }
});

router.post('/:id/cancel', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    res.json(voidConsignment(db, req.params.id, req.user, { reason: (req.body && req.body.reason) || '' }));
  } catch (e) {
    sendErr(res, e);
  }
});

// Legacy PATCH status → settle paths (no physical status-only close).
router.patch('/:id/status', auth, adminOrAccounting, (req, res) => {
  const status = req.body && req.body.status;
  const map = { returned: 'return', settled: 'sale', sold: 'sale' };
  const path = map[status];
  if (!path) return res.status(400).json({ error: 'وضعیت نامعتبر — از مسیرهای تسویه استفاده کنید', code: 'E_CONSIGNMENT_PATH' });
  try {
    const db = getDB();
    res.json(settleConsignment(db, req.params.id, {
      path,
      date: req.body.date,
      note: req.body.note,
      cust_id: req.body.cust_id,
      buyer_person_id: req.body.buyer_person_id,
    }, req.user));
  } catch (e) {
    sendErr(res, e);
  }
});

// R13: DELETE is void, never physical delete.
router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    res.json(voidConsignment(db, req.params.id, req.user, { reason: 'delete' }));
  } catch (e) {
    sendErr(res, e);
  }
});

module.exports = router;
