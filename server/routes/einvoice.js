const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const einvoice = require('../services/einvoice');

router.use(auth, adminOrAccounting);

// Manually submit (queue) a final invoice
router.post('/submit/:invoiceId', (req, res) => {
  const db = getDB();
  if (!einvoice.isEnabled(req.tenantId)) return res.status(400).json({ error: 'ماژول مودیان فعال نیست (تنظیمات → مودیان)' });
  const inv = db.prepare('SELECT * FROM invoices WHERE id=? AND tenant_id=?').get(req.params.invoiceId, req.tenantId);
  if (!inv) return res.status(404).json({ error: 'فاکتور یافت نشد' });
  if (inv.type !== 'final') return res.status(400).json({ error: 'فقط فاکتور رسمی به مودیان ارسال می‌شود' });
  const result = einvoice.queueSubmission(db, req.tenantId, inv.id);
  audit(req.tenantId, req.user.id, 'einvoice_submit', 'invoice', inv.id, `ارسال دستی فاکتور ${inv.num} به صف مودیان`, req.ip);
  // process immediately so the user sees fast feedback (sandbox is instant)
  einvoice.processQueue(db).catch(() => {});
  res.json({ ok: true, ...result });
});

// Submission status for one invoice
router.get('/status/:invoiceId', (req, res) => {
  const db = getDB();
  const rows = db.prepare('SELECT * FROM einvoice_submissions WHERE tenant_id=? AND invoice_id=? ORDER BY id DESC').all(req.tenantId, req.params.invoiceId);
  res.json(rows);
});

// Full submission log with filters
router.get('/log', (req, res) => {
  const db = getDB();
  const where = ['s.tenant_id=?'];
  const params = [req.tenantId];
  if (req.query.status) { where.push('s.status=?'); params.push(req.query.status); }
  const rows = db.prepare(`
    SELECT s.*, i.num as invoice_num, i.final as invoice_total, i.date as invoice_date, c.biz as cust_biz
    FROM einvoice_submissions s
    JOIN invoices i ON s.invoice_id=i.id
    LEFT JOIN customers c ON i.cust_id=c.id
    WHERE ${where.join(' AND ')}
    ORDER BY s.created_at DESC LIMIT 300
  `).all(...params);
  res.json(rows);
});

// Retry a failed/errored submission now
router.post('/retry/:submissionId', async (req, res) => {
  const db = getDB();
  const sub = db.prepare('SELECT * FROM einvoice_submissions WHERE id=? AND tenant_id=?').get(req.params.submissionId, req.tenantId);
  if (!sub) return res.status(404).json({ error: 'یافت نشد' });
  if (sub.status === 'confirmed') return res.status(400).json({ error: 'این ارسال قبلاً تأیید شده' });
  db.prepare("UPDATE einvoice_submissions SET status='pending', next_attempt_at=0 WHERE id=?").run(sub.id);
  const processed = await einvoice.processQueue(db, { onlyId: sub.id });
  const updated = db.prepare('SELECT * FROM einvoice_submissions WHERE id=? AND tenant_id=?').get(sub.id, req.tenantId);
  audit(req.tenantId, req.user.id, 'einvoice_retry', 'einvoice_submission', sub.id, `تلاش مجدد ارسال مودیان`, req.ip);
  res.json({ ok: true, processed, status: updated.status, tax_id: updated.tax_id, error: updated.error });
});

module.exports = router;
