const router = require('express').Router();
const { allocTafsili } = require('../lib/coa-map');
const { getDB, audit, syncCashBoxAccount } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');

// Unrestricted cash box management — no limit on how many cash boxes (صندوق) can
// be created. Every cash box is simultaneously a real chart-of-accounts ledger
// row (see syncCashBoxAccount in db.js), so it's reportable in General Ledger /
// Trial Balance / Balance Sheet exactly like any other account — mirrors banks.js.

router.get('/', auth, (req, res) => {
  const db = getDB();
  res.json(db.prepare('SELECT * FROM cash_boxes ORDER BY name').all());
});

// Batch ledger balances for all cash boxes — avoids N separate general-ledger calls from the UI.
router.get('/balances', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT cb.*,
      COALESCE(SUM(jl.debit - jl.credit), 0) as balance
    FROM cash_boxes cb
    LEFT JOIN journal_lines jl ON jl.account_code = '1101-' || cb.id
    GROUP BY cb.id
    ORDER BY cb.name
  `).all();
  res.json(rows);
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const { name, custodian, is_petty_cash, currency, is_foreign } = req.body;
  if (!name) return res.status(400).json({ error: 'نام صندوق الزامی است' });
  const db = getDB();
  const cur = String(currency || 'IRR').toUpperCase();
  const foreign = is_foreign ? 1 : (cur !== 'IRR' ? 1 : 0);
  const result = db.prepare(
    'INSERT INTO cash_boxes (name,custodian,is_petty_cash,currency,is_foreign) VALUES (?,?,?,?,?)'
  ).run(name, custodian || '', is_petty_cash ? 1 : 0, cur, foreign);
  try { const cc = allocTafsili(db, 'cashbox', name); if (cc) db.prepare('UPDATE cash_boxes SET coa_code=? WHERE id=?').run(cc, result.lastInsertRowid); } catch (_) {}
  const box = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(result.lastInsertRowid);
  syncCashBoxAccount(db, box);
  audit(req.user.id, 'create', 'cash_box', box.id, `ساخت صندوق ${name}`);
  res.json(box);
});

router.put('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const { name, custodian, active, is_petty_cash, currency, is_foreign } = req.body;
  const cur = currency != null ? String(currency).toUpperCase() : (row.currency || 'IRR');
  const foreign = is_foreign != null ? (is_foreign ? 1 : 0) : (row.is_foreign || (cur !== 'IRR' ? 1 : 0));
  db.prepare('UPDATE cash_boxes SET name=?,custodian=?,active=?,is_petty_cash=?,currency=?,is_foreign=? WHERE id=?')
    .run(name || row.name, custodian ?? row.custodian, active != null ? (active ? 1 : 0) : row.active,
         is_petty_cash != null ? (is_petty_cash ? 1 : 0) : row.is_petty_cash, cur, foreign, req.params.id);
  const updated = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(req.params.id);
  syncCashBoxAccount(db, updated); // keep the linked ledger account's name in sync on rename
  audit(req.user.id, 'update', 'cash_box', req.params.id, `ویرایش صندوق ${updated.name}`);
  res.json({ ok: true });
});

router.get('/petty-cash/summary', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT cb.*, COALESCE(SUM(jl.debit - jl.credit), 0) as balance
    FROM cash_boxes cb
    LEFT JOIN journal_lines jl ON jl.account_code = '1101-' || cb.id
    WHERE cb.is_petty_cash=1 AND cb.active=1
    GROUP BY cb.id ORDER BY cb.name
  `).all();
  res.json({ success: true, data: rows });
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
    db.prepare('SELECT COUNT(*) c FROM expense_payments WHERE cash_box_id=?').get(req.params.id).c +
    db.prepare("SELECT COUNT(*) c FROM account_transfers WHERE (from_type='cash' AND from_id=?) OR (to_type='cash' AND to_id=?)").get(req.params.id, req.params.id).c;
  if (refs > 0) return res.status(400).json({ error: 'این صندوق در تراکنش‌ها استفاده شده و قابل حذف نیست — می‌توانید آن را غیرفعال کنید' });
  db.prepare('DELETE FROM cash_boxes WHERE id=?').run(req.params.id);
  db.prepare('DELETE FROM chart_of_accounts WHERE code=?').run('1101-' + row.id);
  audit(req.user.id, 'delete', 'cash_box', req.params.id, `حذف صندوق ${row.name}`);
  res.json({ ok: true });
});

module.exports = router;
