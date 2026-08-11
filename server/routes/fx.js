'use strict';
/**
 * Currencies + exchange rates API (Update 11 / D2).
 */
const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');
const {
  ensureFxTables, getCachedRate, setManualRate, toRial, fetchAndCacheRate,
} = require('../lib/fx-rate');

router.get('/currencies', auth, (req, res) => {
  const db = getDB();
  ensureFxTables(db);
  const activeOnly = String(req.query.active || '1') !== '0';
  const rows = activeOnly
    ? db.prepare('SELECT * FROM currencies WHERE active=1 ORDER BY is_base DESC, code').all()
    : db.prepare('SELECT * FROM currencies ORDER BY is_base DESC, code').all();
  res.json(rows);
});

router.post('/currencies', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  ensureFxTables(db);
  const { code, name, symbol } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'کد و نام ارز الزامی است' });
  const c = String(code).toUpperCase().trim();
  try {
    const r = db.prepare(
      'INSERT INTO currencies (code,name,symbol,is_base) VALUES (?,?,?,0)'
    ).run(c, String(name).trim(), symbol || '');
    audit(req.user.id, 'create', 'currency', r.lastInsertRowid, `ارز ${c}`);
    res.json(db.prepare('SELECT * FROM currencies WHERE id=?').get(r.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: 'این کد ارز قبلاً ثبت شده' });
  }
});

router.get('/rates', auth, (req, res) => {
  const db = getDB();
  ensureFxTables(db);
  const currency = (req.query.currency || '').toUpperCase();
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  let rows;
  if (currency) {
    rows = db.prepare(
      'SELECT * FROM exchange_rates WHERE currency=? ORDER BY date DESC, id DESC LIMIT ?'
    ).all(currency, limit);
  } else {
    rows = db.prepare('SELECT * FROM exchange_rates ORDER BY date DESC, id DESC LIMIT ?').all(limit);
  }
  res.json(rows);
});

router.get('/rates/latest', auth, async (req, res) => {
  const db = getDB();
  ensureFxTables(db);
  const currency = String(req.query.currency || 'USD').toUpperCase();
  const date = req.query.date || todayJalali();
  const cached = getCachedRate(db, currency, date);
  const live = await fetchAndCacheRate(db, currency, date);
  res.json({
    currency,
    date,
    rate_rial: live.rate_rial || cached,
    source: live.source,
  });
});

router.post('/rates', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  ensureFxTables(db);
  try {
    const row = setManualRate(
      db,
      req.body.currency,
      req.body.date || todayJalali(),
      req.body.rate_rial,
      req.body.source || 'manual'
    );
    audit(req.user.id, 'create', 'exchange_rate', null, `${row.currency} @ ${row.rate_rial}`);
    res.json(row);
  } catch (e) {
    res.status(400).json({ error: e.message || 'خطا در ثبت نرخ' });
  }
});

/** Convert foreign amount → rial using cache/manual rate. */
router.post('/convert', auth, (req, res) => {
  const db = getDB();
  ensureFxTables(db);
  const currency = String(req.body.currency || 'IRR').toUpperCase();
  const amount = parseFloat(req.body.amount) || 0;
  const date = req.body.date || todayJalali();
  let rate = parseInt(req.body.rate_rial, 10);
  if (!rate || rate <= 0) rate = getCachedRate(db, currency, date);
  if (currency !== 'IRR' && (!rate || rate <= 0)) {
    return res.status(400).json({ error: 'نرخ ارز برای این تاریخ موجود نیست — ابتدا نرخ را ثبت کنید' });
  }
  const rial = currency === 'IRR' ? Math.round(amount) : toRial(amount, rate);
  res.json({ currency, amount, rate_rial: rate || 1, amount_rial: rial });
});

module.exports = router;
