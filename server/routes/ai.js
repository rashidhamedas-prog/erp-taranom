const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const ai = require('../services/ai');

// Insights feed — admins see everything; salespeople see their own + their customers'
router.get('/insights', auth, (req, res) => {
  const db = getDB();
  const kind = req.query.kind || null;
  const isManager = ['admin', 'accounting'].includes(req.user.role);
  let rows;
  if (isManager) {
    rows = db.prepare(`
      SELECT a.*, c.biz as cust_biz, u.name as rep_name FROM ai_insights a
      LEFT JOIN customers c ON a.customer_id=c.id
      LEFT JOIN users u ON a.user_id=u.id
      WHERE a.tenant_id=? ${kind ? 'AND a.kind=?' : ''}
      ORDER BY a.created_at DESC, a.score DESC LIMIT 100
    `).all(...(kind ? [req.tenantId, kind] : [req.tenantId]));
  } else {
    rows = db.prepare(`
      SELECT a.*, c.biz as cust_biz FROM ai_insights a
      LEFT JOIN customers c ON a.customer_id=c.id
      WHERE a.tenant_id=? AND a.kind<>'weekly_summary'
        AND (a.user_id=? OR a.customer_id IN (SELECT id FROM customers WHERE tenant_id=? AND user_id=?))
        ${kind ? 'AND a.kind=?' : ''}
      ORDER BY a.created_at DESC, a.score DESC LIMIT 50
    `).all(...(kind ? [req.tenantId, req.user.id, req.tenantId, req.user.id, kind] : [req.tenantId, req.user.id, req.tenantId, req.user.id]));
  }
  res.json(rows);
});

// Insights + churn score for one customer
router.get('/insights/customer/:id', auth, (req, res) => {
  const db = getDB();
  const cust = db.prepare('SELECT id,biz,churn_score,user_id FROM customers WHERE id=? AND tenant_id=?').get(req.params.id, req.tenantId);
  if (!cust) return res.status(404).json({ error: 'مشتری یافت نشد' });
  if (!['admin', 'accounting'].includes(req.user.role) && cust.user_id !== req.user.id) {
    return res.status(403).json({ error: 'دسترسی ندارید' });
  }
  const rows = db.prepare('SELECT * FROM ai_insights WHERE tenant_id=? AND customer_id=? ORDER BY created_at DESC LIMIT 20').all(req.tenantId, cust.id);
  res.json({ customer: cust, insights: rows });
});

// Latest weekly summary (admin)
router.get('/weekly-summary', auth, adminOnly, (req, res) => {
  const db = getDB();
  const row = db.prepare("SELECT * FROM ai_insights WHERE tenant_id=? AND kind='weekly_summary' ORDER BY created_at DESC LIMIT 1").get(req.tenantId);
  res.json(row || null);
});

// Manual refresh — recompute scores + insights for this tenant now (admin)
router.post('/insights/refresh', auth, adminOnly, async (req, res) => {
  const db = getDB();
  try {
    await ai.runNightlyAnalysis(db, { tenantId: req.tenantId, weekly: !!req.body?.weekly });
    audit(req.tenantId, req.user.id, 'ai_refresh', 'ai_insights', null, 'بازتولید دستی تحلیل AI', req.ip);
    const count = db.prepare('SELECT COUNT(*) c FROM ai_insights WHERE tenant_id=?').get(req.tenantId).c;
    res.json({ ok: true, insights: count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
