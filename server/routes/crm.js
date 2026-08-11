const router = require('express').Router();
const { getDB } = require('../db');
const { auth } = require('../middleware/auth');
const {
  crmScopeUserId, buildDashboard, buildTimeline, buildDrilldown,
} = require('../lib/crm-analytics');

router.get('/dashboard', auth, (req, res) => {
  try {
    const db = getDB();
    const scope = crmScopeUserId(req);
    const data = buildDashboard(db, req.query, scope);
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'خطا در داشبورد CRM' });
  }
});

router.get('/timeline', auth, (req, res) => {
  try {
    const db = getDB();
    const scope = crmScopeUserId(req);
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const data = buildTimeline(db, {
      partyId: req.query.party_id,
      customerId: req.query.customer_id || req.query.cust_id,
      limit, offset, scopeUserId: scope,
    });
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'خطا در timeline' });
  }
});

router.get('/drilldown', auth, (req, res) => {
  try {
    const db = getDB();
    const scope = crmScopeUserId(req);
    const metric = String(req.query.metric || '').trim();
    if (!metric) return res.status(400).json({ error: 'metric الزامی است' });
    const rows = buildDrilldown(db, metric, req.query, scope);
    res.json({ metric, rows });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'خطا در drilldown' });
  }
});

module.exports = router;
