const router = require('express').Router();
const { allocTafsili, releaseTafsili, acct } = require('../lib/coa-map');
const { getDB, audit, syncBankAccount } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { postToLedger } = require('../lib/ledger');
const { rialToLedger } = require('../lib/money');
const { todayJalali } = require('../jalali');

// Unrestricted bank management — no limit on how many banks can be created.
// Every bank is simultaneously a real chart-of-accounts ledger row (see
// syncBankAccount in db.js), so it's reportable in General Ledger / Trial
// Balance / Balance Sheet exactly like any other account.

function postBankOpeningJe(db, bank, openingRial, userId) {
  const amt = Math.round(Number(openingRial) || 0);
  if (amt <= 0) return null;
  if (bank.opening_balance_je_id) return bank.opening_balance_je_id;
  const bankAcct = bank.coa_code
    ? db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(bank.coa_code)
    : null;
  const bankCode = bankAcct || acct(db, 'coa_bank') || { code: bank.coa_code || ('1102-' + bank.id), name: bank.name };
  const openingAccount = acct(db, 'coa_opening_balance');
  const valueToman = rialToLedger(amt);
  const journalId = postToLedger(db, {
    sourceType: 'bank_opening',
    sourceId: bank.id,
    date: bank.opening_balance_date || todayJalali(),
    description: `موجودی اول دوره بانک ${bank.name}`,
    createdBy: userId,
    voucherType: 'opening',
    lines: [
      { code: bankCode.code, name: bankCode.name || bank.name, debit: valueToman, credit: 0 },
      { code: openingAccount.code, name: openingAccount.name, debit: 0, credit: valueToman },
    ],
  });
  db.prepare('UPDATE banks SET opening_balance_rial=?, opening_balance_je_id=?, opening_balance_date=COALESCE(opening_balance_date,?) WHERE id=?')
    .run(amt, journalId, todayJalali(), bank.id);
  return journalId;
}

router.get('/', auth, (req, res) => {
  const db = getDB();
  res.json(db.prepare('SELECT * FROM banks ORDER BY name').all());
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const {
    name, account_number, branch, account_type, phone, card_number, card_expiry, sheba, note,
    extra_accounts, currency, is_foreign, opening_balance_rial, opening_balance_date,
  } = req.body;
  if (!name) return res.status(400).json({ error: 'نام بانک الزامی است' });
  const db = getDB();
  const extraJson = extra_accounts != null ? (typeof extra_accounts === 'string' ? extra_accounts : JSON.stringify(extra_accounts)) : '[]';
  const cur = String(currency || 'IRR').toUpperCase();
  const foreign = is_foreign ? 1 : (cur !== 'IRR' ? 1 : 0);
  const openingRial = Math.round(Number(opening_balance_rial) || 0);
  const bank = db.transaction(() => {
    const result = db.prepare(
      'INSERT INTO banks (name,account_number,branch,account_type,phone,card_number,card_expiry,sheba,note,extra_accounts,currency,is_foreign,opening_balance_rial,opening_balance_date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      name, account_number || '', branch || '', account_type || '', phone || '', card_number || '',
      card_expiry || '', sheba || '', note || '', extraJson, cur, foreign,
      openingRial > 0 ? openingRial : 0, opening_balance_date || (openingRial > 0 ? todayJalali() : null)
    );
    try {
      const cc = allocTafsili(db, 'bank', name);
      if (cc) db.prepare('UPDATE banks SET coa_code=? WHERE id=?').run(cc, result.lastInsertRowid);
    } catch (_) { /* ignore */ }
    let row = db.prepare('SELECT * FROM banks WHERE id=?').get(result.lastInsertRowid);
    syncBankAccount(db, row);
    row = db.prepare('SELECT * FROM banks WHERE id=?').get(result.lastInsertRowid);
    if (openingRial > 0) {
      postBankOpeningJe(db, row, openingRial, req.user.id);
      row = db.prepare('SELECT * FROM banks WHERE id=?').get(result.lastInsertRowid);
    }
    return row;
  })();
  audit(req.user.id, 'create', 'bank', bank.id, `ساخت بانک ${name}`);
  res.json(bank);
});

router.put('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM banks WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const {
    name, account_number, branch, active, account_type, phone, card_number, card_expiry, sheba, note,
    extra_accounts, currency, is_foreign, opening_balance_rial, opening_balance_date,
  } = req.body;
  const extraJson = extra_accounts != null
    ? (typeof extra_accounts === 'string' ? extra_accounts : JSON.stringify(extra_accounts))
    : (row.extra_accounts || '[]');
  const cur = currency != null ? String(currency).toUpperCase() : (row.currency || 'IRR');
  const foreign = is_foreign != null ? (is_foreign ? 1 : 0) : (row.is_foreign || (cur !== 'IRR' ? 1 : 0));
  db.transaction(() => {
    db.prepare('UPDATE banks SET name=?,account_number=?,branch=?,active=?,account_type=?,phone=?,card_number=?,card_expiry=?,sheba=?,note=?,extra_accounts=?,currency=?,is_foreign=?,opening_balance_date=COALESCE(?,opening_balance_date) WHERE id=?')
      .run(
        name || row.name, account_number ?? row.account_number, branch ?? row.branch,
        active != null ? (active ? 1 : 0) : row.active,
        account_type ?? row.account_type ?? '', phone ?? row.phone ?? '',
        card_number ?? row.card_number ?? '', card_expiry ?? row.card_expiry ?? '',
        sheba ?? row.sheba ?? '', note ?? row.note ?? '', extraJson, cur, foreign,
        opening_balance_date || null, req.params.id
      );
    const updated = db.prepare('SELECT * FROM banks WHERE id=?').get(req.params.id);
    syncBankAccount(db, updated);
    // Opening balance JE only once (when not yet posted)
    if (opening_balance_rial != null && !updated.opening_balance_je_id) {
      const amt = Math.round(Number(opening_balance_rial) || 0);
      if (amt > 0) postBankOpeningJe(db, updated, amt, req.user.id);
    }
  })();
  audit(req.user.id, 'update', 'bank', req.params.id, `ویرایش بانک ${name || row.name}`);
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
  if (row.opening_balance_je_id) {
    return res.status(400).json({ error: 'این بانک سند موجودی اول دوره دارد — ابتدا سند را ابطال کنید یا بانک را غیرفعال کنید' });
  }
  db.transaction(() => {
    db.prepare('DELETE FROM banks WHERE id=?').run(req.params.id);
    if (row.coa_code) releaseTafsili(db, row.coa_code);
    try { db.prepare('DELETE FROM chart_of_accounts WHERE code=?').run('1102-' + row.id); } catch (_) { /* legacy */ }
  })();
  audit(req.user.id, 'delete', 'bank', req.params.id, `حذف بانک ${row.name}`);
  res.json({ ok: true });
});

module.exports = router;
