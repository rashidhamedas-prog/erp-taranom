const router = require('express').Router();
const { getDB } = require('../db');
const { auth, requirePermission, centralOnlyStrict } = require('../middleware/auth');
const {
  crmScopeUserId, buildDashboard, buildTimeline, buildDrilldown,
} = require('../lib/crm-analytics');
const analytics = require('../lib/crm-pro-analytics');
const crmPro = require('../lib/crm-pro');

const crmView = [auth, requirePermission('followups', 'view')];
const crmEdit = [auth, requirePermission('followups', 'edit')];
const crmExport = [auth, requirePermission('followups', 'export')];

function sendErr(res, e) {
  res.status(e.status || 500).json({ error: e.message || 'خطا در CRM' });
}

router.get('/dashboard', ...crmView, (req, res) => {
  try {
    const data = buildDashboard(getDB(), req.query, crmScopeUserId(req));
    res.json(data);
  } catch (e) { sendErr(res, e); }
});

router.get('/kpis', ...crmView, (req, res) => {
  try { res.json(analytics.buildKpis(getDB(), req.query, crmScopeUserId(req))); }
  catch (e) { sendErr(res, e); }
});

router.get('/pipeline', ...crmView, (req, res) => {
  try { res.json(analytics.buildPipeline(getDB(), req.query, crmScopeUserId(req))); }
  catch (e) { sendErr(res, e); }
});

router.get('/conversion-funnel', ...crmView, (req, res) => {
  try { res.json(analytics.buildConversionFunnel(getDB(), req.query, crmScopeUserId(req))); }
  catch (e) { sendErr(res, e); }
});

router.get('/sales-trend', ...crmView, (req, res) => {
  try { res.json(analytics.buildSalesTrend(getDB(), req.query, crmScopeUserId(req))); }
  catch (e) { sendErr(res, e); }
});

router.get('/activity-trend', ...crmView, (req, res) => {
  try { res.json(analytics.buildActivityTrend(getDB(), req.query, crmScopeUserId(req))); }
  catch (e) { sendErr(res, e); }
});

router.get('/expert-performance', ...crmView, (req, res) => {
  try { res.json(analytics.buildExpertPerformance(getDB(), req.query, crmScopeUserId(req))); }
  catch (e) { sendErr(res, e); }
});

router.get('/campaign-performance', ...crmView, (req, res) => {
  try { res.json(analytics.buildCampaignPerformance(getDB(), req.query, crmScopeUserId(req))); }
  catch (e) { sendErr(res, e); }
});

router.get('/source-performance', ...crmView, (req, res) => {
  try { res.json(analytics.buildSourcePerformance(getDB(), req.query, crmScopeUserId(req))); }
  catch (e) { sendErr(res, e); }
});

router.get('/customer-segments', ...crmView, (req, res) => {
  try { res.json(analytics.buildSegmentReport(getDB(), req.query, crmScopeUserId(req))); }
  catch (e) { sendErr(res, e); }
});

router.get('/churn-risk', ...crmView, (req, res) => {
  try { res.json(analytics.buildChurnRisk(getDB(), req.query, crmScopeUserId(req))); }
  catch (e) { sendErr(res, e); }
});

router.get('/receivables', ...crmView, (req, res) => {
  try { res.json(analytics.buildReceivables(getDB(), req.query, crmScopeUserId(req))); }
  catch (e) { sendErr(res, e); }
});

router.get('/product-insights', ...crmView, (req, res) => {
  try { res.json(analytics.buildProductInsights(getDB(), req.query, crmScopeUserId(req))); }
  catch (e) { sendErr(res, e); }
});

router.get('/urgent', ...crmView, (req, res) => {
  try { res.json(analytics.buildUrgentActions(getDB(), req.query, crmScopeUserId(req))); }
  catch (e) { sendErr(res, e); }
});

router.get('/customer-profile/:id', ...crmView, (req, res) => {
  try { res.json(analytics.customerProfile(getDB(), parseInt(req.params.id, 10), crmScopeUserId(req))); }
  catch (e) { sendErr(res, e); }
});

router.get('/timeline', ...crmView, (req, res) => {
  try {
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const data = buildTimeline(getDB(), {
      partyId: req.query.party_id,
      customerId: req.query.customer_id || req.query.cust_id,
      limit, offset, scopeUserId: crmScopeUserId(req),
      kinds: req.query.kinds || req.query.kind || '',
    });
    res.json(data);
  } catch (e) { sendErr(res, e); }
});

router.get('/drilldown', ...crmView, (req, res) => {
  try {
    const metric = String(req.query.metric || '').trim();
    if (!metric) return res.status(400).json({ error: 'metric الزامی است' });
    const rows = buildDrilldown(getDB(), metric, req.query, crmScopeUserId(req));
    res.json({
      metric,
      rows,
      total: rows.total ?? rows.length,
      page: rows.page || 1,
      page_size: rows.page_size || rows.length,
      applied_filters: analytics.appliedFilters(analytics.parseFilters(req.query, crmScopeUserId(req))),
    });
  } catch (e) { sendErr(res, e); }
});

router.get('/export/excel', ...crmExport, async (req, res) => {
  try {
    const { XLSX } = require('../lib/excel-safe');
    const data = buildDashboard(getDB(), req.query, crmScopeUserId(req));
    const k = data.kpis || {};
    const sheet = Object.keys(k).map((key) => ({ شاخص: key, مقدار: k[key] }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet), 'CRM');
    const buf = await XLSX.write(wb);
    const { audit } = require('../db');
    audit(req.user.id, 'crm_export', 'crm_dashboard', 0, JSON.stringify(req.query || {}), req);
    res.setHeader('Content-Disposition', 'attachment; filename=crm-dashboard.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(Buffer.from(buf));
  } catch (e) { sendErr(res, e); }
});

router.get('/opportunities', ...crmView, (req, res) => {
  try {
    const db = getDB();
    const f = analytics.parseFilters(req.query, crmScopeUserId(req));
    const where = ['1=1']; const params = [];
    analytics.addOppFilters(where, params, f);
    const limit = analytics.parseLimit(req.query.limit, 50);
    const offset = Math.max(0, ((f.page || 1) - 1) * limit);
    const total = db.prepare(`SELECT COUNT(*) AS c FROM crm_opportunities o WHERE ${where.join(' AND ')}`).get(...params)?.c || 0;
    const rows = db.prepare(`
      SELECT o.*, c.biz AS cust_biz FROM crm_opportunities o
      LEFT JOIN customers c ON c.id=o.customer_id
      WHERE ${where.join(' AND ')} ORDER BY o.updated_at DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    res.json({ rows, total, page: f.page, page_size: limit, applied_filters: analytics.appliedFilters(f) });
  } catch (e) { sendErr(res, e); }
});

router.post('/opportunities', ...crmEdit, (req, res) => {
  try {
    const db = getDB();
    const scope = crmScopeUserId(req);
    const customerId = parseInt(req.body.customer_id || req.body.cust_id, 10);
    if (!customerId) return res.status(400).json({ error: 'مشتری الزامی است' });
    if (scope) {
      const own = db.prepare('SELECT user_id FROM customers WHERE id=?').get(customerId);
      if (own && own.user_id !== scope) return res.status(403).json({ error: 'دسترسی ندارید' });
    }
    const stage = crmPro.normalizeStage(req.body.pipeline_stage || 'lead');
    if (stage === 'lost' && !String(req.body.lost_reason || '').trim()) {
      return res.status(400).json({ error: 'دلیل باخت الزامی است' });
    }
    const now = Math.floor(Date.now() / 1000);
    const prob = crmPro.clampProb(req.body.probability_percent);
    const amt = Math.round(Number(req.body.estimated_amount_rial) || 0);
    const cust = db.prepare('SELECT party_id, user_id, biz FROM customers WHERE id=?').get(customerId);
    const r = db.prepare(`
      INSERT INTO crm_opportunities (
        party_id, customer_id, owner_user_id, title, pipeline_stage, status,
        estimated_amount_rial, probability_percent, weighted_amount_rial,
        expected_close_date, lead_source, campaign, lost_reason, entered_stage_at, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      cust?.party_id || null, customerId, scope || req.user.id,
      String(req.body.title || cust?.biz || 'فرصت').slice(0, 200),
      stage, stage === 'lost' ? 'lost' : (crmPro.CLOSED_STAGES.has(stage) ? 'won' : 'open'),
      amt, prob, crmPro.weightedRial(amt, prob),
      req.body.expected_close_date || '', req.body.lead_source || '', req.body.campaign || '',
      req.body.lost_reason || '', now, now, now
    );
    db.prepare(`
      INSERT INTO crm_stage_history (opportunity_id, from_stage, to_stage, changed_by, changed_at, reason)
      VALUES (?,?,?,?,?,?)
    `).run(r.lastInsertRowid, null, stage, req.user.id, now, 'create');
    res.json(db.prepare('SELECT * FROM crm_opportunities WHERE id=?').get(r.lastInsertRowid));
  } catch (e) { sendErr(res, e); }
});

router.patch('/opportunities/:id/stage', ...crmEdit, (req, res) => {
  try {
    const db = getDB();
    const opp = db.prepare('SELECT * FROM crm_opportunities WHERE id=?').get(req.params.id);
    if (!opp) return res.status(404).json({ error: 'فرصت یافت نشد' });
    crmPro.assertOpportunityAccess(db, opp, crmScopeUserId(req));
    const result = crmPro.changeOpportunityStage(db, opp.id, req.body.pipeline_stage || req.body.stage, {
      userId: req.user.id,
      reason: req.body.reason || '',
      lostReason: req.body.lost_reason || '',
      wonInvoiceId: req.body.won_invoice_id || null,
      force: req.user.role === 'admin' && !!req.body.force,
    });
    res.json(result);
  } catch (e) { sendErr(res, e); }
});

router.get('/activities', ...crmView, (req, res) => {
  try {
    const db = getDB();
    const f = analytics.parseFilters(req.query, crmScopeUserId(req));
    const where = ['1=1']; const params = [];
    if (f.user_id) { where.push('a.owner_user_id=?'); params.push(f.user_id); }
    if (f.customer_id) { where.push('a.customer_id=?'); params.push(f.customer_id); }
    if (f.activity_type) { where.push('a.type=?'); params.push(f.activity_type); }
    if (f.status) { where.push('a.status=?'); params.push(f.status); }
    const limit = analytics.parseLimit(req.query.limit, 50);
    const offset = Math.max(0, ((f.page || 1) - 1) * limit);
    const total = db.prepare(`SELECT COUNT(*) AS c FROM crm_activities a WHERE ${where.join(' AND ')}`).get(...params)?.c || 0;
    const rows = db.prepare(`
      SELECT a.*, c.biz AS cust_biz FROM crm_activities a
      LEFT JOIN customers c ON c.id=a.customer_id
      WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    res.json({ rows, total, page: f.page, page_size: limit, applied_filters: analytics.appliedFilters(f) });
  } catch (e) { sendErr(res, e); }
});

router.post('/activities', ...crmEdit, (req, res) => {
  try {
    const db = getDB();
    const scope = crmScopeUserId(req);
    const customerId = parseInt(req.body.customer_id || req.body.cust_id, 10);
    if (!customerId) return res.status(400).json({ error: 'مشتری الزامی است' });
    if (scope) {
      const own = db.prepare('SELECT user_id FROM customers WHERE id=?').get(customerId);
      if (own && own.user_id !== scope) return res.status(403).json({ error: 'دسترسی ندارید' });
    }
    const now = Math.floor(Date.now() / 1000);
    const cust = db.prepare('SELECT party_id FROM customers WHERE id=?').get(customerId);
    let oppId = req.body.opportunity_id || null;
    if (oppId) {
      const opp = db.prepare('SELECT customer_id FROM crm_opportunities WHERE id=?').get(oppId);
      if (!opp || Number(opp.customer_id) !== Number(customerId)) {
        return res.status(400).json({ error: 'فرصت به این مشتری تعلق ندارد' });
      }
    }
    const r = db.prepare(`
      INSERT INTO crm_activities (
        party_id, customer_id, opportunity_id, owner_user_id, type, subject, description,
        status, priority, activity_date, due_date, result, next_action, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      cust?.party_id || null, customerId, oppId, scope || req.user.id,
      req.body.type || 'note', req.body.subject || '', req.body.description || '',
      req.body.status || 'open', req.body.priority || 'mid',
      req.body.activity_date || '', req.body.due_date || '',
      req.body.result || '', req.body.next_action || '', now, now
    );
    res.json(db.prepare('SELECT * FROM crm_activities WHERE id=?').get(r.lastInsertRowid));
  } catch (e) { sendErr(res, e); }
});

router.post('/segmentation/run', ...crmEdit, (req, res) => {
  try {
    if (!['admin', 'accounting', 'sales_manager'].includes(req.user.role)) {
      return res.status(403).json({ error: 'اجرای سگمنت‌بندی برای نقش شما مجاز نیست' });
    }
    res.json(crmPro.runSegmentation(getDB(), { customerId: req.body?.customer_id || null }));
  } catch (e) { sendErr(res, e); }
});

router.post('/automations/run', ...crmEdit, centralOnlyStrict, (req, res) => {
  try {
    if (!['admin', 'accounting', 'sales_manager'].includes(req.user.role)) {
      return res.status(403).json({ error: 'اجرای اتوماسیون برای نقش شما مجاز نیست' });
    }
    res.json(crmPro.runAutomations(getDB()));
  } catch (e) { sendErr(res, e); }
});

module.exports = router;
