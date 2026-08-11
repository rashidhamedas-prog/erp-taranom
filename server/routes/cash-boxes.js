const router = require('express').Router();
const { allocTafsili, releaseTafsili, acct } = require('../lib/coa-map');
const { getDB, audit, syncCashBoxAccount } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { postToLedger } = require('../lib/ledger');
const { rialToLedger } = require('../lib/money');
const { todayJalali } = require('../jalali');
const { reverseJournalEntry } = require('../lib/void-journal');

// Unrestricted cash box management — mirrors banks.js (opening balance + live ledger).

function postCashOpeningJe(db, box, openingRial, userId) {
  const amt = Math.round(Number(openingRial) || 0);
  if (amt <= 0) return null;
  if (box.opening_balance_je_id) return box.opening_balance_je_id;
  const cashAcct = box.coa_code
    ? db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(box.coa_code)
    : null;
  const cashCode = cashAcct || acct(db, 'coa_cash_default') || { code: box.coa_code || ('1101-' + box.id), name: box.name };
  const openingAccount = acct(db, 'coa_opening_balance');
  const valueToman = rialToLedger(amt);
  const journalId = postToLedger(db, {
    sourceType: 'cash_opening',
    sourceId: box.id,
    date: box.opening_balance_date || todayJalali(),
    description: `موجودی اول دوره صندوق ${box.name}`,
    createdBy: userId,
    voucherType: 'opening',
    lines: [
      { code: cashCode.code, name: cashCode.name || box.name, debit: valueToman, credit: 0 },
      { code: openingAccount.code, name: openingAccount.name, debit: 0, credit: valueToman },
    ],
  });
  db.prepare('UPDATE cash_boxes SET opening_balance_rial=?, opening_balance_je_id=?, opening_balance_date=COALESCE(opening_balance_date,?) WHERE id=?')
    .run(amt, journalId, todayJalali(), box.id);
  return journalId;
}

router.get('/', auth, (req, res) => {
  const db = getDB();
  res.json(db.prepare('SELECT * FROM cash_boxes ORDER BY name').all());
});

router.get('/balances', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');
  const rows = db.prepare(`
    SELECT cb.*,
      COALESCE((
        SELECT SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL})
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
        WHERE jl.account_code = COALESCE(NULLIF(cb.coa_code,''), '1101-' || cb.id)
          AND COALESCE(je.deleted_at,0)=0
      ), 0) as balance
    FROM cash_boxes cb
    ORDER BY cb.name
  `).all();
  res.json(rows);
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const { name, custodian, is_petty_cash, currency, is_foreign, opening_balance_rial, opening_balance_date } = req.body;
  if (!name) return res.status(400).json({ error: 'نام صندوق الزامی است' });
  const db = getDB();
  const cur = String(currency || 'IRR').toUpperCase();
  const foreign = is_foreign ? 1 : (cur !== 'IRR' ? 1 : 0);
  const openingRial = Math.round(Number(opening_balance_rial) || 0);
  const box = db.transaction(() => {
    const result = db.prepare(
      'INSERT INTO cash_boxes (name,custodian,is_petty_cash,currency,is_foreign,opening_balance_rial,opening_balance_date) VALUES (?,?,?,?,?,?,?)'
    ).run(
      name, custodian || '', is_petty_cash ? 1 : 0, cur, foreign,
      openingRial > 0 ? openingRial : 0, opening_balance_date || (openingRial > 0 ? todayJalali() : null)
    );
    try {
      const cc = allocTafsili(db, 'cashbox', name);
      if (cc) db.prepare('UPDATE cash_boxes SET coa_code=? WHERE id=?').run(cc, result.lastInsertRowid);
    } catch (_) { /* ignore */ }
    let row = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(result.lastInsertRowid);
    syncCashBoxAccount(db, row);
    row = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(result.lastInsertRowid);
    if (openingRial > 0) {
      postCashOpeningJe(db, row, openingRial, req.user.id);
      row = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(result.lastInsertRowid);
    }
    return row;
  })();
  audit(req.user.id, 'create', 'cash_box', box.id, `ساخت صندوق ${name}`);
  res.json(box);
});

router.put('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const { name, custodian, active, is_petty_cash, currency, is_foreign, opening_balance_rial, opening_balance_date } = req.body;
  const cur = currency != null ? String(currency).toUpperCase() : (row.currency || 'IRR');
  const foreign = is_foreign != null ? (is_foreign ? 1 : 0) : (row.is_foreign || (cur !== 'IRR' ? 1 : 0));
  db.transaction(() => {
    db.prepare('UPDATE cash_boxes SET name=?,custodian=?,active=?,is_petty_cash=?,currency=?,is_foreign=?,opening_balance_date=COALESCE(?,opening_balance_date) WHERE id=?')
      .run(name || row.name, custodian ?? row.custodian, active != null ? (active ? 1 : 0) : row.active,
           is_petty_cash != null ? (is_petty_cash ? 1 : 0) : row.is_petty_cash, cur, foreign,
           opening_balance_date || null, req.params.id);
    const updated = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(req.params.id);
    syncCashBoxAccount(db, updated);
    if (opening_balance_rial != null && !updated.opening_balance_je_id) {
      const amt = Math.round(Number(opening_balance_rial) || 0);
      if (amt > 0) postCashOpeningJe(db, updated, amt, req.user.id);
    }
  })();
  audit(req.user.id, 'update', 'cash_box', req.params.id, `ویرایش صندوق ${name || row.name}`);
  res.json({ ok: true });
});

router.get('/petty-cash/summary', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT cb.*, COALESCE(SUM(jl.debit - jl.credit), 0) as balance
    FROM cash_boxes cb
    LEFT JOIN journal_lines jl ON jl.account_code = COALESCE(NULLIF(cb.coa_code,''), '1101-' || cb.id)
    LEFT JOIN journal_entries je ON je.id = jl.entry_id AND COALESCE(je.deleted_at,0)=0
    WHERE cb.is_petty_cash=1 AND cb.active=1
    GROUP BY cb.id ORDER BY cb.name
  `).all();
  res.json({ success: true, data: rows });
});

router.post('/:id/void-opening', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (!row.opening_balance_je_id) return res.status(400).json({ error: 'سند موجودی اول دوره برای این صندوق وجود ندارد' });
  db.transaction(() => {
    reverseJournalEntry(db, row.opening_balance_je_id, {
      userId: req.user.id,
      reason: `ابطال موجودی اول دوره صندوق ${row.name}`,
      sourceType: 'cash_opening_reversal',
    });
    db.prepare('UPDATE cash_boxes SET opening_balance_rial=0, opening_balance_je_id=NULL WHERE id=?').run(row.id);
  })();
  audit(req.user.id, 'reverse', 'cash_opening', row.id, `ابطال موجودی اول دوره صندوق ${row.name}`);
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
    db.prepare('SELECT COUNT(*) c FROM expense_payments WHERE cash_box_id=?').get(req.params.id).c +
    db.prepare("SELECT COUNT(*) c FROM account_transfers WHERE (from_type='cash' AND from_id=?) OR (to_type='cash' AND to_id=?)").get(req.params.id, req.params.id).c;
  if (refs > 0) return res.status(400).json({ error: 'این صندوق در تراکنش‌ها استفاده شده و قابل حذف نیست — می‌توانید آن را غیرفعال کنید' });
  db.transaction(() => {
    if (row.opening_balance_je_id) {
      reverseJournalEntry(db, row.opening_balance_je_id, {
        userId: req.user.id,
        reason: `ابطال موجودی اول دوره صندوق ${row.name} (حذف صندوق)`,
        sourceType: 'cash_opening_reversal',
      });
    }
    db.prepare('DELETE FROM cash_boxes WHERE id=?').run(req.params.id);
    if (row.coa_code) releaseTafsili(db, row.coa_code);
    try { db.prepare('DELETE FROM chart_of_accounts WHERE code=?').run('1101-' + row.id); } catch (_) {}
  })();
  audit(req.user.id, 'delete', 'cash_box', req.params.id, `حذف صندوق ${row.name}`);
  res.json({ ok: true });
});

module.exports = router;
