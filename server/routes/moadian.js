const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOnly, adminOrAccounting, centralOnly } = require('../middleware/auth');
const { getPublicSettings, updateSettings } = require('../lib/secret-settings');

const MOADIAN_SETTING_KEYS = ['moadian_enabled', 'moadian_fiscal_id', 'moadian_private_key_path', 'moadian_adapter'];

function enqueueMoadian(db, docType, docId) {
  const enabled = db.prepare("SELECT value FROM settings WHERE key='moadian_enabled'").get()?.value;
  if (enabled !== '1') return;
  const exists = db.prepare('SELECT id FROM moadian_queue WHERE doc_type=? AND doc_id=?').get(docType, docId);
  if (exists) return;

  let invoiceType = 1;
  if (docType === 'sales') {
    const inv = db.prepare('SELECT moadian_invoice_type FROM invoices WHERE id=?').get(docId);
    invoiceType = parseInt(inv?.moadian_invoice_type, 10) || 1;
  }
  const adapter = db.prepare("SELECT value FROM settings WHERE key='moadian_adapter'").get()?.value || 'stub';
  db.prepare(`
    INSERT INTO moadian_queue (doc_type, doc_id, status, invoice_type, adapter)
    VALUES (?,?,?,?,?)
  `).run(docType, docId, 'pending', invoiceType, adapter);
}

router.get('/queue', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { status } = req.query;
  let sql = `
    SELECT q.*, i.num as invoice_num, i.final, i.date as invoice_date,
           i.moadian_invoice_type, c.biz as cust_biz
    FROM moadian_queue q
    LEFT JOIN invoices i ON q.doc_type='sales' AND q.doc_id=i.id
    LEFT JOIN customers c ON i.cust_id=c.id
  `;
  const params = [];
  if (status) { sql += ' WHERE q.status=?'; params.push(status); }
  sql += ' ORDER BY q.id DESC LIMIT 200';
  res.json({ success: true, data: db.prepare(sql).all(...params) });
});

router.get('/queue/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare(`
    SELECT q.*, i.num as invoice_num, i.moadian_invoice_type, i.moadian_ref_tax_id,
           i.moadian_correction_type, c.biz as cust_biz
    FROM moadian_queue q
    LEFT JOIN invoices i ON q.doc_type='sales' AND q.doc_id=i.id
    LEFT JOIN customers c ON i.cust_id=c.id
    WHERE q.id=?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  res.json({ success: true, data: row });
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

  const adapterSetting = db.prepare("SELECT value FROM settings WHERE key='moadian_adapter'").get()?.value || 'stub';
  const fiscalId = db.prepare("SELECT value FROM settings WHERE key='moadian_fiscal_id'").get()?.value || '';
  const adapter = (adapterSetting === 'live' && fiscalId) ? 'live' : 'stub';
  const invoiceType = parseInt(inv?.moadian_invoice_type || row.invoice_type, 10) || 1;

  const taxId = 'MOADIAN-' + Date.now().toString(36).toUpperCase();
  const responsePayload = adapter === 'live'
    ? { adapter: 'live', stub_fallback: true, message: 'اتصال live فعال است — فعلاً stub استفاده شد' }
    : { adapter: 'stub', message: 'ارسال آزمایشی — اتصال SDK مودیان در فاز بعد' };

  db.prepare(`
    UPDATE moadian_queue SET status='sent', tax_id=?, invoice_type=?, adapter=?, sent_at=strftime('%s','now'), response_json=?
    WHERE id=?
  `).run(taxId, invoiceType, adapter, JSON.stringify(responsePayload), req.params.id);

  if (inv) {
    db.prepare('UPDATE invoices SET moadian_tax_id=?, moadian_status=? WHERE id=?').run(taxId, 'sent', inv.id);
  }
  audit(req.user.id, 'moadian_submit', 'moadian_queue', req.params.id, taxId);
  res.json({ success: true, data: { tax_id: taxId, status: 'sent', invoice_type: invoiceType, adapter } });
});

router.post('/queue/:id/correct', auth, adminOnly, (req, res) => {
  try {
    const db = getDB();
    const orig = db.prepare('SELECT * FROM moadian_queue WHERE id=?').get(req.params.id);
    if (!orig) return res.status(404).json({ error: 'یافت نشد' });
    if (orig.doc_type !== 'sales') throw new Error('اصلاح فقط برای فاکتور فروش پشتیبانی می‌شود');

    const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(orig.doc_id);
    if (!inv) throw new Error('فاکتور مبنا یافت نشد');

    const refTaxId = req.body.moadian_ref_tax_id || inv.moadian_tax_id || orig.tax_id;
    if (!refTaxId) throw new Error('شناسه مالیاتی مرجع الزامی است');

    const correctionType = req.body.correction_type || 'correct';
    const invoiceType = parseInt(req.body.moadian_invoice_type || inv.moadian_invoice_type || 1, 10) || 1;
    const adapter = db.prepare("SELECT value FROM settings WHERE key='moadian_adapter'").get()?.value || 'stub';

    const result = db.transaction(() => {
      db.prepare(`
        UPDATE invoices SET moadian_ref_tax_id=?, moadian_correction_type=?, moadian_invoice_type=?
        WHERE id=?
      `).run(refTaxId, correctionType, invoiceType, inv.id);

      const ins = db.prepare(`
        INSERT INTO moadian_queue (doc_type, doc_id, status, invoice_type, adapter, response_json)
        VALUES ('sales', ?, 'pending', ?, ?, ?)
      `).run(
        inv.id, invoiceType, adapter,
        JSON.stringify({ correction: true, ref_tax_id: refTaxId, correction_type: correctionType })
      );
      return ins.lastInsertRowid;
    })();

    audit(req.user.id, 'moadian_correct', 'moadian_queue', result, `اصلاح ${refTaxId}`);
    res.json({ success: true, data: { queue_id: result, moadian_ref_tax_id: refTaxId, invoice_type: invoiceType } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/settings', auth, adminOrAccounting, (req, res) => {
  res.json({ success: true, data: getPublicSettings(getDB(), MOADIAN_SETTING_KEYS) });
});

router.put('/settings', auth, adminOnly, centralOnly, (req, res) => {
  const db = getDB();
  updateSettings(db, Object.entries(req.body || {}), new Set(MOADIAN_SETTING_KEYS));
  res.json({ success: true });
});

module.exports = router;
module.exports.enqueueMoadian = enqueueMoadian;
