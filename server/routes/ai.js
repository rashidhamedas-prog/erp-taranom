const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOnly, centralOnly } = require('../middleware/auth');
const ai = require('../services/ai');

// Insights feed — admins/accounting see everything; salespeople see their own + their customers'
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
      ${kind ? 'WHERE a.kind=?' : ''}
      ORDER BY a.created_at DESC, a.score DESC LIMIT 100
    `).all(...(kind ? [kind] : []));
  } else {
    rows = db.prepare(`
      SELECT a.*, c.biz as cust_biz FROM ai_insights a
      LEFT JOIN customers c ON a.customer_id=c.id
      WHERE a.kind<>'weekly_summary'
        AND (a.user_id=? OR a.customer_id IN (SELECT id FROM customers WHERE user_id=?))
        ${kind ? 'AND a.kind=?' : ''}
      ORDER BY a.created_at DESC, a.score DESC LIMIT 50
    `).all(...(kind ? [req.user.id, req.user.id, kind] : [req.user.id, req.user.id]));
  }
  res.json(rows);
});

// Insights + churn score for one customer
router.get('/insights/customer/:id', auth, (req, res) => {
  const db = getDB();
  const cust = db.prepare('SELECT id,biz,churn_score,user_id FROM customers WHERE id=?').get(req.params.id);
  if (!cust) return res.status(404).json({ error: 'مشتری یافت نشد' });
  if (!['admin', 'accounting'].includes(req.user.role) && cust.user_id !== req.user.id) {
    return res.status(403).json({ error: 'دسترسی ندارید' });
  }
  const rows = db.prepare('SELECT * FROM ai_insights WHERE customer_id=? ORDER BY created_at DESC LIMIT 20').all(cust.id);
  res.json({ customer: cust, insights: rows });
});

// Personal performance summary — any authenticated user, ALWAYS scoped to
// their own user id (spec 1.0.9 §6). ?narrative=1 additionally produces the
// AI/heuristic text analysis.
router.get('/my-summary', auth, async (req, res) => {
  const db = getDB();
  try {
    const out = await ai.buildMySummary(db, req.user.id, { narrative: req.query.narrative === '1' });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Latest weekly summary (admin)
router.get('/weekly-summary', auth, adminOnly, (req, res) => {
  const db = getDB();
  const row = db.prepare("SELECT * FROM ai_insights WHERE kind='weekly_summary' ORDER BY created_at DESC LIMIT 1").get();
  res.json(row || null);
});

// Manual refresh — recompute scores + insights now (admin, central only:
// insights must have one source of truth; devices pull churn_score via customer sync)
router.post('/insights/refresh', auth, adminOnly, centralOnly, async (req, res) => {
  const db = getDB();
  try {
    await ai.runNightlyAnalysis(db, { weekly: !!req.body?.weekly });
    audit(req.user.id, 'ai_refresh', 'ai_insights', null, 'بازتولید دستی تحلیل AI', req);
    const count = db.prepare('SELECT COUNT(*) c FROM ai_insights').get().c;
    res.json({ ok: true, insights: count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
