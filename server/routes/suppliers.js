const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');

// Suppliers are shared company-wide (not owned by a salesperson) — accounting/admin only
router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare('SELECT * FROM suppliers ORDER BY name').all();
  res.json(rows);
});

router.get('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM suppliers WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'تأمین‌کننده یافت نشد' });
  res.json(row);
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const { name, phone, address, note, balance } = req.body;
  if (!name) return res.status(400).json({ error: 'نام تأمین‌کننده الزامی است' });
  const db = getDB();
  const bal = parseFloat(balance) || 0;
  const result = db.prepare(
    'INSERT INTO suppliers (name,phone,address,note,balance) VALUES (?,?,?,?,?)'
  ).run(name, phone || '', address || '', note || '', bal);
  const supplierId = result.lastInsertRowid;
  // Opening balance becomes the first supplier-ledger entry (credit = we owe them)
  if (bal !== 0) {
    db.prepare('INSERT INTO supplier_ledger (supplier_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(supplierId, todayJalali(), 'opening', 'opening', supplierId, 'مانده اولیه حساب', bal < 0 ? -bal : 0, bal > 0 ? bal : 0, req.user.id);
  }
  audit(req.user.id, 'create', 'supplier', supplierId, `ساخت تأمین‌کننده ${name}`);
  res.json(db.prepare('SELECT * FROM suppliers WHERE id=?').get(supplierId));
});

router.put('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM suppliers WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const { name, phone, address, note } = req.body;
  db.prepare('UPDATE suppliers SET name=?,phone=?,address=?,note=? WHERE id=?')
    .run(name || row.name, phone || '', address || '', note || '', req.params.id);
  res.json({ ok: true });
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM suppliers WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const hasInvoices = db.prepare('SELECT COUNT(*) c FROM purchase_invoices WHERE supplier_id=?').get(req.params.id).c;
  if (hasInvoices) return res.status(400).json({ error: 'این تأمین‌کننده دارای فاکتور خرید است و قابل حذف نیست' });
  db.prepare('DELETE FROM suppliers WHERE id=?').run(req.params.id);
  audit(req.user.id, 'delete', 'supplier', req.params.id, `حذف تأمین‌کننده ${row.name}`);
  res.json({ ok: true });
});

// Payable balances (mirrors /customers/balances for receivables)
router.get('/balances/list', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT s.id, s.name, s.phone, s.balance as opening_balance,
      COALESCE((SELECT SUM(final) FROM purchase_invoices WHERE supplier_id=s.id AND pay_type='credit'),0) as total_purchased,
      COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_id=s.id),0) as total_paid,
      COALESCE((SELECT SUM(amount) FROM purchase_returns WHERE supplier_id=s.id),0) as total_returned
    FROM suppliers s
  `).all();
  rows.forEach(r => { r.payable = (r.opening_balance || 0) + r.total_purchased - r.total_paid - r.total_returned; });
  res.json(rows.filter(r => r.payable !== 0));
});

module.exports = router;
