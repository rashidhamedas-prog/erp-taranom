// Sub-ledger ↔ GL reconciliation (R1–R11) — mounted at /api/accounting/subledger-recon.
// Reads: admin/accounting. Fixes: admin/accounting role only (no delegation), central server only.
const router = require('express').Router();
const { getDB } = require('../db');
const { auth, adminOrAccounting, centralOnlyStrict } = require('../middleware/auth');
const recon = require('../lib/subledger-recon');

function strictRole(req, res, next) {
  if (req.user && (req.user.role === 'admin' || req.user.role === 'accounting')) return next();
  return res.status(403).json({ error: 'دسترسی ندارید' });
}

function sendErr(res, e) {
  res.status(e.status || 500).json({ error: e.message || 'خطای تطبیق', code: e.code });
}

function dbReady() {
  const db = getDB();
  recon.ensureReconSchemaOnce(db);
  return db;
}

function dateToParam(v) {
  const s = String(v || '').trim();
  return /^\d{4}\/\d{2}\/\d{2}$/.test(s) ? s : null;
}

const read = [auth, adminOrAccounting, centralOnlyStrict];
const write = [auth, strictRole, centralOnlyStrict];

router.get('/', ...read, (req, res) => {
  try {
    const db = dbReady();
    const checks = String(req.query.checks || '').split(',').map((s) => s.trim()).filter(Boolean);
    res.json(recon.runRecon(db, {
      dateTo: dateToParam(req.query.date_to),
      checks: checks.length ? checks : null,
      userId: req.user && req.user.id,
    }));
  } catch (e) { sendErr(res, e); }
});

router.get('/checks', ...read, (req, res) => {
  res.json({ checks: recon.CHECKS.map(([code, name]) => ({ code, name })) });
});

router.get('/last', ...read, (req, res) => {
  try {
    const last = recon.lastRun(dbReady());
    if (!last) return res.status(404).json({ error: 'هنوز تطبیقی اجرا نشده است', code: 'E_RECON_NO_RUN' });
    res.json(last);
  } catch (e) { sendErr(res, e); }
});

router.get('/fixes', ...read, (req, res) => {
  try {
    res.json({ fixes: recon.listFixes(dbReady(), { limit: req.query.limit }) });
  } catch (e) { sendErr(res, e); }
});

router.post('/fixes/:id/reverse', ...write, (req, res) => {
  try {
    const fix = recon.reverseFix(dbReady(), +req.params.id, {
      user: req.user,
      reason: (req.body && req.body.reason) || '',
    });
    res.json({ ok: true, fix });
  } catch (e) { sendErr(res, e); }
});

router.get('/:code/rows', ...read, (req, res) => {
  try {
    const out = recon.checkRows(dbReady(), req.params.code, {
      dateTo: dateToParam(req.query.date_to),
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json(out);
  } catch (e) { sendErr(res, e); }
});

router.post('/:code/fix', ...write, (req, res) => {
  try {
    const b = req.body || {};
    const out = recon.applyFix(dbReady(), req.params.code, {
      ids: b.ids,
      dryRun: b.dry_run === undefined ? true : b.dry_run,
      confirm: b.confirm,
      reason: b.reason,
      date: dateToParam(b.date) || undefined,
      dateTo: dateToParam(b.date_to),
      user: req.user,
    });
    res.json(out);
  } catch (e) { sendErr(res, e); }
});

module.exports = router;
