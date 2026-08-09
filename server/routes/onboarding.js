/**
 * P1-M3 onboarding & migration MVP routes (central admin).
 */
const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOnly, centralOnly } = require('../middleware/auth');
const {
  bootstrapWorkspace,
  getChecklist,
  dryRunImport,
} = require('../lib/onboarding/bootstrap');

router.get('/checklist', auth, adminOnly, (req, res) => {
  try {
    const checklist = getChecklist(getDB());
    res.json({ ok: true, checklist });
  } catch (e) {
    res.status(500).json({ error: e.message || 'خطا در خواندن چک‌لیست' });
  }
});

router.post('/bootstrap', auth, adminOnly, centralOnly, (req, res) => {
  try {
    const body = req.body || {};
    const db = getDB();
    const result = bootstrapWorkspace(db, {
      company_name: body.company_name || body.name,
      fiscal_label: body.fiscal_label,
      start_date: body.start_date,
      warehouse_name: body.warehouse_name,
      warehouse_code: body.warehouse_code,
      cash_box_name: body.cash_box_name,
      created_by: req.user.id,
    });
    audit(
      req.user.id,
      'onboarding_bootstrap',
      'settings',
      null,
      `راه‌اندازی اولیه — FY:${result.created.fiscal_year ? 'new' : 'ok'} WH:${result.created.warehouse ? 'new' : 'ok'} BOX:${result.created.cash_box ? 'new' : 'ok'}`
    );
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message || 'خطا در bootstrap' });
  }
});

router.post('/import/dry-run', auth, adminOnly, centralOnly, (req, res) => {
  try {
    const result = dryRunImport(req.body || {});
    if (!result.ok && result.errors.some(e => e.row == null)) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message || 'خطا در dry-run', ok: false, errors: [], preview_count: 0 });
  }
});

module.exports = router;
