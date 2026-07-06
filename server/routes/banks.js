const router = require('express').Router();
const { getDB, audit, syncBankAccount } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');

// Unrestricted bank management — no limit on how many banks can be created.
// Every bank is simultaneously a real chart-of-accounts ledger row (see
// syncBankAccount in db.js), so it's reportable in General Ledger / Trial
// Balance / Balance Sheet exactly like any other account.

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  res.json(db.prepare('SELECT * FROM banks ORDER BY name').all());
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const { name, account_number, branch } = req.body;
  if (!name) return res.status(400).json({ error: 'نام بانک الزامی است' });
  const db = getDB();
  const result = db.prepare(
    'INSERT INTO banks (name,account_number,branch) VALUES (?,?,?)'
  ).run(name, account_number || '', branch || '');
  const bank = db.prepare('SELECT * FROM banks WHERE id=?').get(result.lastInsertRowid);
  syncBankAccount(db, bank);
  audit(req.user.id, 'create', 'bank', bank.id, `ساخت بانک ${name}`);
  res.json(bank);
});

router.put('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM banks WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const { name, account_number, branch, active } = req.body;
  db.prepare('UPDATE banks SET name=?,account_number=?,branch=?,active=? WHERE id=?')
    .run(name || row.name, account_number ?? row.account_number, branch ?? row.branch, active != null ? (active ? 1 : 0) : row.active, req.params.id);
  const updated = db.prepare('SELECT * FROM banks WHERE id=?').get(req.params.id);
  syncBankAccount(db, updated); // keep the linked ledger account's name in sync on rename
  audit(req.user.id, 'update', 'bank', req.params.id, `ویرایش بانک ${updated.name}`);
  res.json({ ok: true });
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM banks WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const refs =
    db.prepare('SELECT COUNT(*) c FROM settlements WHERE bank_id=?').get(req.params.id).c +
    db.prepare('SELECT COUNT(*) c FROM purchase_invoices WHERE bank_id=?').get(req.params.id).c +
    db.prepare('SELECT COUNT(*) c FROM supplier_payments WHERE bank_id=?').get(req.params.id).c +
    db.prepare('SELECT COUNT(*) c FROM incentive_payments WHERE bank_id=?').get(req.params.id).c +
    db.prepare('SELECT COUNT(*) c FROM check_categories WHERE bank_id=?').get(req.params.id).c;
  if (refs > 0) return res.status(400).json({ error: 'این بانک در تراکنش‌ها یا دسته‌چک‌ها استفاده شده و قابل حذف نیست — می‌توانید آن را غیرفعال کنید' });
  db.prepare('DELETE FROM banks WHERE id=?').run(req.params.id);
  db.prepare('DELETE FROM chart_of_accounts WHERE code=?').run('1102-' + row.id);
  audit(req.user.id, 'delete', 'bank', req.params.id, `حذف بانک ${row.name}`);
  res.json({ ok: true });
});

module.exports = router;
