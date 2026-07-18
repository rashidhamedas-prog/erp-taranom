const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOnly, adminOrAccounting } = require('../middleware/auth');

// Moadian e-invoicing queue — Phase 3 (submit stub; wire real SDK later)

router.get('/queue', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { status } = req.query;
  let sql = `
    SELECT q.*, i.num as invoice_num, i.final, i.date as invoice_date, c.biz as cust_biz
    FROM moadian_queue q
    LEFT JOIN invoices i ON q.doc_type='sales' AND q.doc_id=i.id
    LEFT JOIN customers c ON i.cust_id=c.id
  `;
  const params = [];
  if (status) { sql += ' WHERE q.status=?'; params.push(status); }
  sql += ' ORDER BY q.id DESC LIMIT 200';
  res.json({ success: true, data: db.prepare(sql).all(...params) });
});

router.post('/queue/:id/submit', auth, adminOnly, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM moadian_queue WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.status === 'accepted') return res.status(422).json({ error: 'قبلاً پذیرفته شده' });

  const inv = row.doc_type === 'sales'
    ? db.prepare('SELECT i.*, c.national_id, c.economic_code, c.biz FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.id=?').get(row.doc_id)
    : null;
  if (inv && inv.type === 'final') {
    if (!inv.economic_code && !inv.national_id) {
      return res.status(422).json({ error: 'کد ملی/اقتصادی مشتری برای مودیان الزامی است' });
    }
  }

  const taxId = 'MOADIAN-' + Date.now().toString(36).toUpperCase();
  db.prepare(`
    UPDATE moadian_queue SET status='sent', tax_id=?, sent_at=strftime('%s','now'), response_json=?
    WHERE id=?
  `).run(taxId, JSON.stringify({ stub: true, message: 'ارسال آزمایشی — اتصال SDK مودیان در فاز بعد' }), req.params.id);

  if (inv) {
    db.prepare('UPDATE invoices SET moadian_tax_id=?, moadian_status=? WHERE id=?').run(taxId, 'sent', inv.id);
  }
  audit(req.user.id, 'moadian_submit', 'moadian_queue', req.params.id, taxId);
  res.json({ success: true, data: { tax_id: taxId, status: 'sent' } });
});

router.get('/settings', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const keys = ['moadian_enabled', 'moadian_fiscal_id', 'moadian_private_key_path'];
  const out = {};
  for (const k of keys) {
    out[k] = db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value || '';
  }
  res.json({ success: true, data: out });
});

router.put('/settings', auth, adminOnly, (req, res) => {
  const db = getDB();
  for (const [k, v] of Object.entries(req.body || {})) {
    if (['moadian_enabled', 'moadian_fiscal_id', 'moadian_private_key_path'].includes(k)) {
      db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(k, String(v ?? ''));
    }
  }
  res.json({ success: true });
});

function enqueueMoadian(db, docType, docId) {
  const enabled = db.prepare("SELECT value FROM settings WHERE key='moadian_enabled'").get()?.value;
  if (enabled !== '1') return;
  const exists = db.prepare('SELECT id FROM moadian_queue WHERE doc_type=? AND doc_id=?').get(docType, docId);
  if (exists) return;
  db.prepare('INSERT INTO moadian_queue (doc_type, doc_id, status) VALUES (?,?,?)').run(docType, docId, 'pending');
}

module.exports = router;
module.exports.enqueueMoadian = enqueueMoadian;
