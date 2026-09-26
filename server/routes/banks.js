const router = require('express').Router();
const { allocTafsili, releaseTafsili, acct } = require('../lib/coa-map');
const { getDB, audit, syncBankAccount } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { postToLedger } = require('../lib/ledger');
const { rialToLedger } = require('../lib/money');
const { todayJalali } = require('../jalali');
const { reverseJournalEntry } = require('../lib/void-journal');

// Unrestricted bank management — no limit on how many banks can be created.
// Every bank is simultaneously a real chart-of-accounts ledger row (see
// syncBankAccount in db.js), so it's reportable in General Ledger / Trial
// Balance / Balance Sheet exactly like any other account.

function postBankOpeningJe(db, bank, openingRial, userId) {
  const amt = Math.round(Number(openingRial) || 0);
  if (amt <= 0) return null;
  if (bank.opening_balance_je_id) {
    const live = db.prepare(
      "SELECT id FROM journal_entries WHERE id=? AND COALESCE(deleted_at,0)=0 AND COALESCE(status,'posted') NOT IN ('reversed','void')"
    ).get(bank.opening_balance_je_id);
    if (live) return bank.opening_balance_je_id;
    // Stale pointer (JE wiped / company reset) — clear and re-post
    db.prepare('UPDATE banks SET opening_balance_je_id=NULL WHERE id=?').run(bank.id);
    bank = { ...bank, opening_balance_je_id: null };
  }
  const existing = db.prepare(
    "SELECT id FROM journal_entries WHERE ref_type='bank_opening' AND ref_id=? AND COALESCE(deleted_at,0)=0 ORDER BY id DESC LIMIT 1"
  ).get(bank.id);
  if (existing) {
    db.prepare('UPDATE banks SET opening_balance_je_id=? WHERE id=?').run(existing.id, bank.id);
    return existing.id;
  }
  // Prefer instrument tafsili (1102-{id} or mapped coa), never the bare control 1102
  syncBankAccount(db, bank);
  const joinCode = resolveBankJoinCode(db, bank);
  const bankAcct = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(joinCode);
  const bankCode = bankAcct || { code: joinCode, name: bank.name };
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

function repairBankOpeningIfNeeded(db, bank, userId) {
  const amt = Math.round(Number(bank.opening_balance_rial) || 0);
  if (amt <= 0) return bank;
  try {
    postBankOpeningJe(db, bank, amt, userId || 1);
  } catch (e) {
    if (e && (e.status === 422 || /سال مالی|fiscal/i.test(String(e.message || '')))) {
      try {
        postBankOpeningJe(db, { ...bank, opening_balance_je_id: null, opening_balance_date: todayJalali() }, amt, userId || 1);
      } catch (e2) {
        console.error('bank opening repair retry', bank.id, e2 && e2.message);
      }
    } else {
      console.error('bank opening repair', bank.id, e && e.message);
    }
  }
  return db.prepare('SELECT * FROM banks WHERE id=?').get(bank.id) || bank;
}

router.get('/', auth, (req, res) => {
  const db = getDB();
  res.json(db.prepare('SELECT * FROM banks ORDER BY name').all());
});

function resolveBankJoinCode(db, bank) {
  let code = String(bank.coa_code || '').trim();
  if (code) return code;
  // Heal Mahak/legacy rows that never got coa_code but have a matching tafsili
  try {
    const name = String(bank.name || '').trim();
    if (name) {
      const hit = db.prepare(`
        SELECT code FROM chart_of_accounts
        WHERE name LIKE '%' || ? || '%'
          AND (code LIKE '206001%' OR code LIKE '1102%')
        ORDER BY CASE WHEN code LIKE '206001%' THEN 0 ELSE 1 END, length(code) DESC
        LIMIT 1
      `).get(name);
      if (hit && hit.code) {
        db.prepare("UPDATE banks SET coa_code=? WHERE id=? AND COALESCE(coa_code,'')=''").run(hit.code, bank.id);
        return hit.code;
      }
    }
  } catch (_) { /* */ }
  return '1102-' + bank.id;
}

function glBalanceOnCode(db, accountCode) {
  const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');
  const row = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}), 0) AS bal
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.account_code = ?
      AND COALESCE(je.deleted_at,0)=0
  `).get(accountCode);
  return Math.round(Number(row && row.bal) || 0);
}

// Live ledger balances for all banks (opening JE + subsequent movements).
router.get('/balances', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const banks = db.prepare('SELECT * FROM banks ORDER BY name').all();
  const rows = banks.map((raw) => {
    const b = repairBankOpeningIfNeeded(db, raw, req.user && req.user.id);
    const joinCode = resolveBankJoinCode(db, b);
    let balance = glBalanceOnCode(db, joinCode);
    // If mapped code is silent but orphan 1102-{id} has activity, surface that (legacy drift)
    if (balance === 0) {
      const legacy = '1102-' + b.id;
      if (legacy !== joinCode) {
        const legBal = glBalanceOnCode(db, legacy);
        if (legBal !== 0) balance = legBal;
      }
    }
    const openingStored = Math.round(Number(b.opening_balance_rial) || 0);
    return {
      ...b,
      coa_code: b.coa_code || (joinCode.startsWith('1102-') ? b.coa_code : joinCode),
      balance,
      opening_balance_rial: openingStored,
      // For Mahak imports: master opening is 0 but GL has the opening lines
      opening_effective_rial: openingStored > 0 ? openingStored : balance,
    };
  });
  res.json(rows);
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

router.post('/:id/void-opening', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM banks WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (!row.opening_balance_je_id) return res.status(400).json({ error: 'سند موجودی اول دوره برای این بانک وجود ندارد' });
  db.transaction(() => {
    reverseJournalEntry(db, row.opening_balance_je_id, {
      userId: req.user.id,
      reason: `ابطال موجودی اول دوره بانک ${row.name}`,
      sourceType: 'bank_opening_reversal',
    });
    db.prepare('UPDATE banks SET opening_balance_rial=0, opening_balance_je_id=NULL WHERE id=?').run(row.id);
  })();
  audit(req.user.id, 'reverse', 'bank_opening', row.id, `ابطال موجودی اول دوره بانک ${row.name}`);
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
  db.transaction(() => {
    if (row.opening_balance_je_id) {
      reverseJournalEntry(db, row.opening_balance_je_id, {
        userId: req.user.id,
        reason: `ابطال موجودی اول دوره بانک ${row.name} (حذف بانک)`,
        sourceType: 'bank_opening_reversal',
      });
    }
    db.prepare('DELETE FROM banks WHERE id=?').run(req.params.id);
    if (row.coa_code) releaseTafsili(db, row.coa_code);
    try { db.prepare('DELETE FROM chart_of_accounts WHERE code=?').run('1102-' + row.id); } catch (_) { /* legacy */ }
  })();
  audit(req.user.id, 'delete', 'bank', req.params.id, `حذف بانک ${row.name}`);
  res.json({ ok: true });
});

module.exports = router;
