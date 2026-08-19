'use strict';
/**
 * LED-01 — shared financial + stock ledger (read-only).
 * GET /api/ledgers/financial  GET /api/ledgers/stock
 * GET /api/ledgers/financial/export?format=csv
 * GET /api/ledgers/stock/export?format=csv
 */
const router = require('express').Router();
const { getDB } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const {
  assertJalaliQuery,
  buildFinancialLedger,
  buildStockLedger,
  financialToCsv,
  stockToCsv,
} = require('../lib/ledgers');

function sendLedgerError(res, e) {
  const status = e.status || 500;
  return res.status(status).json({ error: e.error || e.message || String(e) });
}

function financialQuery(req) {
  const { from, to } = assertJalaliQuery(req.query.from, req.query.to);
  return buildFinancialLedger(getDB(), {
    entity_type: req.query.entity_type,
    entity_id: req.query.entity_id,
    from,
    to,
  });
}

function stockQuery(req) {
  const { from, to } = assertJalaliQuery(req.query.from, req.query.to);
  return buildStockLedger(getDB(), {
    product_id: req.query.product_id || req.query.entity_id,
    warehouse_id: req.query.warehouse_id,
    from,
    to,
  }, { stripCost: req.user?.role === 'field_sales' });
}

router.get('/financial', auth, adminOrAccounting, (req, res) => {
  try {
    if (String(req.query.format || '').toLowerCase() === 'csv') {
      const data = financialQuery(req);
      res.setHeader('Content-Disposition', 'attachment; filename=financial-ledger.csv');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return res.send('\uFEFF' + financialToCsv(data));
    }
    res.json(financialQuery(req));
  } catch (e) { sendLedgerError(res, e); }
});

router.get('/financial/export', auth, adminOrAccounting, (req, res) => {
  try {
    const data = financialQuery(req);
    if (String(req.query.format || 'csv').toLowerCase() !== 'csv') {
      return res.status(400).json({ error: 'فقط format=csv پشتیبانی می‌شود' });
    }
    res.setHeader('Content-Disposition', 'attachment; filename=financial-ledger.csv');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send('\uFEFF' + financialToCsv(data));
  } catch (e) { sendLedgerError(res, e); }
});

router.get('/stock', auth, adminOrAccounting, (req, res) => {
  try {
    if (String(req.query.format || '').toLowerCase() === 'csv') {
      const data = stockQuery(req);
      res.setHeader('Content-Disposition', 'attachment; filename=stock-ledger.csv');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return res.send('\uFEFF' + stockToCsv(data));
    }
    res.json(stockQuery(req));
  } catch (e) { sendLedgerError(res, e); }
});

router.get('/stock/export', auth, adminOrAccounting, (req, res) => {
  try {
    const data = stockQuery(req);
    if (String(req.query.format || 'csv').toLowerCase() !== 'csv') {
      return res.status(400).json({ error: 'فقط format=csv پشتیبانی می‌شود' });
    }
    res.setHeader('Content-Disposition', 'attachment; filename=stock-ledger.csv');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send('\uFEFF' + stockToCsv(data));
  } catch (e) { sendLedgerError(res, e); }
});

module.exports = router;
