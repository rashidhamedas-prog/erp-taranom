'use strict';
const router = require('express').Router();
const { getDB } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const {
  listTerminals,
  createTerminal,
  updateTerminal,
  deactivateTerminal,
  listReceipts,
  postReceipt,
  voidReceipt,
  listBatches,
  settleBatch,
  voidBatch,
  buildPosReport,
  posReportCsv,
} = require('../lib/pos');

function sendErr(res, e) {
  const status = e.status || 400;
  return res.status(status).json({ error: e.message, code: e.code || undefined, id: e.id });
}

const gate = [auth, adminOrAccounting];

router.get('/terminals', ...gate, (req, res) => {
  try {
    res.json(listTerminals(getDB(), { includeInactive: req.query.all === '1' }));
  } catch (e) { sendErr(res, e); }
});

router.post('/terminals', ...gate, (req, res) => {
  try { res.json(createTerminal(getDB(), req.body || {}, req.user)); }
  catch (e) { sendErr(res, e); }
});

router.put('/terminals/:id', ...gate, (req, res) => {
  try { res.json(updateTerminal(getDB(), req.params.id, req.body || {}, req.user)); }
  catch (e) { sendErr(res, e); }
});

router.delete('/terminals/:id', ...gate, (req, res) => {
  try { res.json(deactivateTerminal(getDB(), req.params.id, req.user)); }
  catch (e) { sendErr(res, e); }
});

router.get('/receipts', ...gate, (req, res) => {
  try { res.json(listReceipts(getDB(), req.query || {})); }
  catch (e) { sendErr(res, e); }
});

router.post('/receipts', ...gate, (req, res) => {
  try { res.json(postReceipt(getDB(), req.body || {}, req.user)); }
  catch (e) { sendErr(res, e); }
});

router.post('/receipts/:id/void', ...gate, (req, res) => {
  try { res.json(voidReceipt(getDB(), req.params.id, req.user, req.body || {})); }
  catch (e) { sendErr(res, e); }
});

router.get('/batches', ...gate, (req, res) => {
  try { res.json(listBatches(getDB(), req.query || {})); }
  catch (e) { sendErr(res, e); }
});

router.get('/report', ...gate, (req, res) => {
  try { res.json(buildPosReport(getDB(), req.query || {})); }
  catch (e) { sendErr(res, e); }
});

router.get('/report/export', ...gate, (req, res) => {
  try {
    const report = buildPosReport(getDB(), req.query || {});
    const csv = posReportCsv(report);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=pos-report.csv');
    res.send('\uFEFF' + csv);
  } catch (e) { sendErr(res, e); }
});

router.post('/batches', ...gate, (req, res) => {
  try { res.json(settleBatch(getDB(), req.body || {}, req.user)); }
  catch (e) { sendErr(res, e); }
});

router.post('/batches/:id/void', ...gate, (req, res) => {
  try { res.json(voidBatch(getDB(), req.params.id, req.user, req.body || {})); }
  catch (e) { sendErr(res, e); }
});

module.exports = router;
