const router = require('express').Router();
const { getDB, audit, syncCashBoxAccount } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');

// Unrestricted cash box management — no limit on how many cash boxes (صندوق) can
// be created. Every cash box is simultaneously a real chart-of-accounts ledger
// row (see syncCashBoxAccount in db.js), so it's reportable in General Ledger /
// Trial Balance / Balance Sheet exactly like any other account — mirrors banks.js.

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  res.json(db.prepare('SELECT * FROM cash_boxes ORDER BY name').all());
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const { name, custodian } = req.body;
  if (!name) return res.status(400).json({ error: 'نام صندوق الزامی است' });
  const db = getDB();
  const result = db.prepare(
    'INSERT INTO cash_boxes (name,custodian) VALUES (?,?)'
  ).run(name, custodian || '');
  const box = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(result.lastInsertRowid);
  syncCashBoxAccount(db, box);
  audit(req.user.id, 'create', 'cash_box', box.id, `ساخت صندوق ${name}`);
  res.json(box);
});

router.put('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const { name, custodian, active } = req.body;
  db.prepare('UPDATE cash_boxes SET name=?,custodian=?,active=? WHERE id=?')
    .run(name || row.name, custodian ?? row.custodian, active != null ? (active ? 1 : 0) : row.active, req.params.id);
  const updated = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(req.params.id);
  syncCashBoxAccount(db, updated); // keep the linked ledger account's name in sync on rename
  audit(req.user.id, 'update', 'cash_box', req.params.id, `ویرایش صندوق ${updated.name}`);
  res.json({ ok: true });
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const refs =
    db.prepare('SELECT COUNT(*) c FROM settlements WHERE cash_box_id=?').get(req.params.id).c +
    db.prepare('SELECT COUNT(*) c FROM purchase_invoices WHERE cash_box_id=?').get(req.params.id).c +
    db.prepare('SELECT COUNT(*) c FROM supplier_payments WHERE cash_box_id=?').get(req.params.id).c +
    db.prepare('SELECT COUNT(*) c FROM incentive_payments WHERE cash_box_id=?').get(req.params.id).c +
    db.prepare("SELECT COUNT(*) c FROM account_transfers WHERE (from_type='cash' AND from_id=?) OR (to_type='cash' AND to_id=?)").get(req.params.id, req.params.id).c;
  if (refs > 0) return res.status(400).json({ error: 'این صندوق در تراکنش‌ها استفاده شده و قابل حذف نیست — می‌توانید آن را غیرفعال کنید' });
  db.prepare('DELETE FROM cash_boxes WHERE id=?').run(req.params.id);
  db.prepare('DELETE FROM chart_of_accounts WHERE code=?').run('1101-' + row.id);
  audit(req.user.id, 'delete', 'cash_box', req.params.id, `حذف صندوق ${row.name}`);
  res.json({ ok: true });
});

module.exports = router;
