// Sub-ledger ↔ GL reconciliation (R1–R11) — mounted at /api/accounting/subledger-recon.
// Reads: admin/accounting/delegated view. Mutations (v522): canDo acc_subledger_recon
// edit (apply fix) / delete (reverse fix + its read-only reverse-preview), central server only. Nightly settings: admin.
const router = require('express').Router();
const { getDB } = require('../db');
const { auth, adminOnly, adminOrAccounting, centralOnlyStrict } = require('../middleware/auth');
const { requireCan } = require('../lib/rbac');
const recon = require('../lib/subledger-recon');

function sendErr(res, e) {
  const body = { error: e.message || 'خطای تطبیق', code: e.code };
  if (e.gl_shortfall_rial != null) { body.gl_shortfall_rial = e.gl_shortfall_rial; body.total_rial = e.total_rial; }
  res.status(e.status || 500).json(body);
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
const applyFix = [auth, requireCan('acc_subledger_recon', 'edit'), centralOnlyStrict];
const reverseFix = [auth, requireCan('acc_subledger_recon', 'delete'), centralOnlyStrict];

router.get('/nightly', ...read, (req, res) => {
  try { res.json(recon.nightlySettings(dbReady())); } catch (e) { sendErr(res, e); }
});

router.put('/nightly', auth, adminOnly, centralOnlyStrict, (req, res) => {
  try {
    const b = req.body || {};
    res.json(recon.saveNightlySettings(dbReady(), { enabled: b.enabled, time: b.time }, { userId: req.user && req.user.id }));
  } catch (e) { sendErr(res, e); }
});

router.post('/nightly/run', auth, adminOnly, centralOnlyStrict, (req, res) => {
  try { res.json(recon.runNightlyRecon(dbReady())); } catch (e) { sendErr(res, e); }
});

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

// Read-only: what POST /fixes/:id/reverse would do (same permission; never writes).
router.get('/fixes/:id/reverse-preview', ...reverseFix, (req, res) => {
  try {
    const wh = String(req.query.warehouses || '').split(',').map((s) => parseInt(s, 10)).filter((x) => x > 0);
    res.json(recon.previewReverseFix(dbReady(), +req.params.id, { warehouses: wh.length ? wh : null }));
  } catch (e) { sendErr(res, e); }
});

// Body: {"confirm": true, "reason": "<≥5 chars>"} — otherwise 400 E_RECON_REVERSE_{REASON,CONFIRM}_REQUIRED, nothing written.
router.post('/fixes/:id/reverse', ...reverseFix, (req, res) => {
  try {
    const b = req.body || {};
    recon.requireReverseConfirm(b);
    const fix = recon.reverseFix(dbReady(), +req.params.id, {
      user: req.user,
      reason: b.reason,
      confirm: b.confirm,
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

router.post('/:code/fix', ...applyFix, (req, res) => {
  try {
    const b = req.body || {};
    const out = recon.applyFix(dbReady(), req.params.code, {
      ids: b.ids,
      dryRun: b.dry_run === undefined ? true : b.dry_run,
      confirm: b.confirm,
      reason: b.reason,
      force: b.force,
      counterAccount: b.counter_account,
      counterAccounts: b.counter_accounts,
      date: dateToParam(b.date) || undefined,
      dateTo: dateToParam(b.date_to),
      user: req.user,
    });
    res.json(out);
  } catch (e) { sendErr(res, e); }
});

module.exports = router;
