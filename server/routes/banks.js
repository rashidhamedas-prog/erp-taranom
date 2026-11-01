const router = require('express').Router();
const { allocTafsili, releaseTafsili, acct } = require('../lib/coa-map');
const { getDB, audit, syncBankAccount } = require('../db');
const { auth, adminOrAccounting, requirePermission } = require('../middleware/auth');
const { postToLedger, rewriteJournalEntry } = require('../lib/ledger');
const { rialToLedger, SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');
const { jeNotDraftFor } = require('../lib/je-live');
const { todayJalali } = require('../jalali');
const { reverseJournalEntry } = require('../lib/void-journal');
const { assertValidSheba } = require('../lib/treasury-guards');
const { getActiveFiscalYear } = require('../lib/fiscal-period');

// Unrestricted bank management — opening upsert mirrors parties (signed + retire duplicates).

function fiscalOpeningDate(db) {
  const fy = getActiveFiscalYear(db);
  return (fy && fy.start_date) || todayJalali();
}

function collectBankOpeningJournalIds(db, bankId) {
  return db.prepare(`
    SELECT id FROM journal_entries
    WHERE ref_type='bank_opening' AND ref_id=?
      AND COALESCE(deleted_at,0)=0
      AND COALESCE(status,'posted') NOT IN ('reversed','void')
    ORDER BY id ASC
  `).all(bankId).map((r) => Number(r.id));
}

function retireOtherBankOpenings(db, bank, keepId, userId) {
  const keep = Number(keepId) || 0;
  for (const id of collectBankOpeningJournalIds(db, bank.id)) {
    if (Number(id) === keep) continue;
    reverseJournalEntry(db, id, {
      userId: userId || 1,
      reason: `جمع شدن سند تکراری موجودی اول دوره بانک ${bank.name}`,
      sourceType: 'bank_opening_reversal',
    });
  }
}

function liveBankOpeningJeId(db, bank) {
  if (bank.opening_balance_je_id) {
    const live = db.prepare(
      "SELECT id FROM journal_entries WHERE id=? AND COALESCE(deleted_at,0)=0 AND COALESCE(status,'posted') NOT IN ('reversed','void')"
    ).get(bank.opening_balance_je_id);
    if (live) return live.id;
    db.prepare('UPDATE banks SET opening_balance_je_id=NULL WHERE id=?').run(bank.id);
    bank.opening_balance_je_id = null;
  }
  const existing = db.prepare(
    "SELECT id FROM journal_entries WHERE ref_type='bank_opening' AND ref_id=? AND COALESCE(deleted_at,0)=0 AND COALESCE(status,'posted') NOT IN ('reversed','void') ORDER BY id ASC LIMIT 1"
  ).get(bank.id);
  if (existing) {
    db.prepare('UPDATE banks SET opening_balance_je_id=? WHERE id=?').run(existing.id, bank.id);
    bank.opening_balance_je_id = existing.id;
    return existing.id;
  }
  return null;
}

/** amt>0 debit bank / credit opening; amt<0 credit bank / debit opening. */
function bankOpeningLines(db, bank, amtRial) {
  syncBankAccount(db, bank);
  const joinCode = resolveBankJoinCode(db, bank);
  const bankAcct = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(joinCode);
  const bankCode = bankAcct || { code: joinCode, name: bank.name };
  const openingAccount = acct(db, 'coa_opening_balance');
  const absToman = rialToLedger(Math.abs(Math.round(Number(amtRial) || 0)));
  const amt = Math.round(Number(amtRial) || 0);
  return amt >= 0
    ? [
      { code: bankCode.code, name: bankCode.name || bank.name, debit: absToman, credit: 0 },
      { code: openingAccount.code, name: openingAccount.name, debit: 0, credit: absToman },
    ]
    : [
      { code: openingAccount.code, name: openingAccount.name, debit: absToman, credit: 0 },
      { code: bankCode.code, name: bankCode.name || bank.name, debit: 0, credit: absToman },
    ];
}

function bankOpeningSideMatches(db, jeId, amtRial) {
  const amt = Math.round(Number(amtRial) || 0);
  if (!amt) return false;
  const opening = acct(db, 'coa_opening_balance');
  const line = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) AS d,
           COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) AS c
    FROM journal_lines jl
    WHERE jl.entry_id=? AND jl.account_code=?
  `).get(jeId, opening.code);
  const openDebit = Math.round(Number(line && line.d) || 0);
  const openCredit = Math.round(Number(line && line.c) || 0);
  if (amt > 0) return openCredit > 0 && openDebit === 0;
  return openDebit > 0 && openCredit === 0;
}

/** Upsert opening JE: create / rewrite amount+date+side / void when amt===0. */
function upsertBankOpening(db, bank, openingRial, userId, { dateOverride } = {}) {
  const amt = Math.round(Number(openingRial) || 0);
  const date = dateOverride || fiscalOpeningDate(db);
  let jeId = liveBankOpeningJeId(db, bank);

  if (!amt) {
    if (jeId) {
      reverseJournalEntry(db, jeId, {
        userId: userId || 1,
        reason: `ابطال موجودی اول دوره بانک ${bank.name}`,
        sourceType: 'bank_opening_reversal',
      });
    }
    retireOtherBankOpenings(db, bank, null, userId);
    db.prepare('UPDATE banks SET opening_balance_rial=0, opening_balance_je_id=NULL, opening_balance_date=? WHERE id=?')
      .run(date, bank.id);
    return null;
  }

  const lines = bankOpeningLines(db, bank, amt);
  const description = `موجودی اول دوره بانک ${bank.name}`;

  if (jeId) {
    const je = db.prepare('SELECT entry_date, total_debit_rial, ref_type FROM journal_entries WHERE id=?').get(jeId);
    const isBankOpening = String(je && je.ref_type || '') === 'bank_opening';
    if (!isBankOpening) {
      db.prepare('UPDATE banks SET opening_balance_je_id=NULL WHERE id=?').run(bank.id);
      jeId = null;
    } else {
      const currentAbs = Math.round(Number(je && je.total_debit_rial) || 0);
      const wantAbs = Math.abs(amt);
      const dateMismatch = String(je && je.entry_date || '') !== String(date);
      const sideMismatch = !bankOpeningSideMatches(db, jeId, amt);
      if (currentAbs !== wantAbs || dateMismatch || sideMismatch) {
        const rewritten = rewriteJournalEntry(db, {
          sourceType: 'bank_opening',
          sourceId: bank.id,
          date,
          description,
          lines,
        });
        if (!rewritten) {
          db.prepare('UPDATE banks SET opening_balance_je_id=NULL WHERE id=?').run(bank.id);
          jeId = null;
        } else {
          jeId = rewritten;
        }
      }
    }
  }

  if (!jeId) {
    jeId = postToLedger(db, {
      sourceType: 'bank_opening',
      sourceId: bank.id,
      date,
      description,
      createdBy: userId,
      voucherType: 'opening',
      lines,
    });
  }

  retireOtherBankOpenings(db, bank, jeId, userId);
  db.prepare('UPDATE banks SET opening_balance_rial=?, opening_balance_je_id=?, opening_balance_date=? WHERE id=?')
    .run(amt, jeId, date, bank.id);
  return jeId;
}

function postBankOpeningJe(db, bank, openingRial, userId) {
  return upsertBankOpening(db, bank, openingRial, userId);
}

function repairBankOpeningIfNeeded(db, bank, userId) {
  const amt = Math.round(Number(bank.opening_balance_rial) || 0);
  if (!amt) return bank;
  const liveId = liveBankOpeningJeId(db, bank);
  if (liveId) {
    retireOtherBankOpenings(db, bank, liveId, userId || 1);
    return db.prepare('SELECT * FROM banks WHERE id=?').get(bank.id) || bank;
  }
  try {
    upsertBankOpening(db, bank, amt, userId || 1);
  } catch (e) {
    if (e && (e.status === 422 || /سال مالی|fiscal/i.test(String(e.message || '')))) {
      try {
        upsertBankOpening(db, bank, amt, userId || 1, { dateOverride: todayJalali() });
      } catch (e2) {
        console.error('bank opening repair retry', bank.id, e2 && e2.message);
      }
    } else {
      console.error('bank opening repair', bank.id, e && e.message);
    }
  }
  return db.prepare('SELECT * FROM banks WHERE id=?').get(bank.id) || bank;
}

router.get('/', auth, requirePermission('banks', 'view'), (req, res) => {
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
      AND COALESCE(je.deleted_at,0)=0 AND ${jeNotDraftFor(db)}
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
      // Signed master wins; else GL (Mahak/legacy) — includes negative/credit openings
      opening_effective_rial: openingStored !== 0 ? openingStored : balance,
    };
  });
  res.json(rows);
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const {
    name, account_number, branch, account_type, phone, card_number, card_expiry, sheba, note,
    extra_accounts, currency, is_foreign, opening_balance_rial, opening_balance_date,
    overdraft_limit_rial,
  } = req.body;
  if (!name) return res.status(400).json({ error: 'نام بانک الزامی است' });
  let shebaNorm = '';
  try { shebaNorm = assertValidSheba(sheba); } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  const db = getDB();
  const extraJson = extra_accounts != null ? (typeof extra_accounts === 'string' ? extra_accounts : JSON.stringify(extra_accounts)) : '[]';
  const cur = String(currency || 'IRR').toUpperCase();
  const foreign = is_foreign ? 1 : (cur !== 'IRR' ? 1 : 0);
  const openingRial = Math.round(Number(opening_balance_rial) || 0);
  const openDate = fiscalOpeningDate(db);
  const odRaw = overdraft_limit_rial;
  const odLimit = (odRaw === null || odRaw === undefined || odRaw === '')
    ? null
    : Math.max(0, Math.round(Number(odRaw) || 0));
  const bank = db.transaction(() => {
    const result = db.prepare(
      'INSERT INTO banks (name,account_number,branch,account_type,phone,card_number,card_expiry,sheba,note,extra_accounts,currency,is_foreign,opening_balance_rial,opening_balance_date,overdraft_limit_rial) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      name, account_number || '', branch || '', account_type || '', phone || '', card_number || '',
      card_expiry || '', shebaNorm, note || '', extraJson, cur, foreign,
      openingRial, openingRial !== 0 ? openDate : (opening_balance_date || null),
      odLimit
    );
    try {
      const cc = allocTafsili(db, 'bank', name);
      if (cc) db.prepare('UPDATE banks SET coa_code=? WHERE id=?').run(cc, result.lastInsertRowid);
    } catch (_) { /* ignore */ }
    let row = db.prepare('SELECT * FROM banks WHERE id=?').get(result.lastInsertRowid);
    syncBankAccount(db, row);
    row = db.prepare('SELECT * FROM banks WHERE id=?').get(result.lastInsertRowid);
    if (openingRial !== 0) {
      upsertBankOpening(db, row, openingRial, req.user.id);
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
    overdraft_limit_rial,
  } = req.body;
  let shebaNorm;
  try {
    shebaNorm = sheba != null ? assertValidSheba(sheba) : (row.sheba || '');
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
  const extraJson = extra_accounts != null
    ? (typeof extra_accounts === 'string' ? extra_accounts : JSON.stringify(extra_accounts))
    : (row.extra_accounts || '[]');
  const cur = currency != null ? String(currency).toUpperCase() : (row.currency || 'IRR');
  const foreign = is_foreign != null ? (is_foreign ? 1 : 0) : (row.is_foreign || (cur !== 'IRR' ? 1 : 0));
  const odLimit = overdraft_limit_rial === undefined
    ? row.overdraft_limit_rial
    : ((overdraft_limit_rial === null || overdraft_limit_rial === '')
      ? null
      : Math.max(0, Math.round(Number(overdraft_limit_rial) || 0)));
  try {
    const updated = db.transaction(() => {
      db.prepare('UPDATE banks SET name=?,account_number=?,branch=?,active=?,account_type=?,phone=?,card_number=?,card_expiry=?,sheba=?,note=?,extra_accounts=?,currency=?,is_foreign=?,overdraft_limit_rial=? WHERE id=?')
        .run(
          name || row.name, account_number ?? row.account_number, branch ?? row.branch,
          active != null ? (active ? 1 : 0) : row.active,
          account_type ?? row.account_type ?? '', phone ?? row.phone ?? '',
          card_number ?? row.card_number ?? '', card_expiry ?? row.card_expiry ?? '',
          shebaNorm, note ?? row.note ?? '', extraJson, cur, foreign,
          odLimit, req.params.id
        );
      let next = db.prepare('SELECT * FROM banks WHERE id=?').get(req.params.id);
      syncBankAccount(db, next);
      next = db.prepare('SELECT * FROM banks WHERE id=?').get(req.params.id);
      // Editable opening: rewrite JE amount + pin date to fiscal-year start
      if (opening_balance_rial != null) {
        upsertBankOpening(db, next, opening_balance_rial, req.user.id);
        next = db.prepare('SELECT * FROM banks WHERE id=?').get(req.params.id);
      } else if (opening_balance_date != null && opening_balance_date !== '') {
        db.prepare('UPDATE banks SET opening_balance_date=? WHERE id=?').run(opening_balance_date, req.params.id);
        next = db.prepare('SELECT * FROM banks WHERE id=?').get(req.params.id);
      }
      return next;
    })();
    audit(req.user.id, 'update', 'bank', req.params.id, `ویرایش بانک ${name || row.name}`);
    res.json({ ok: true, bank: updated });
  } catch (e) {
    const status = e && e.status ? e.status : 500;
    res.status(status).json({ error: e.message || 'خطا در ذخیره بانک' });
  }
});

router.post('/:id/void-opening', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM banks WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const hasLive = liveBankOpeningJeId(db, row) || Math.round(Number(row.opening_balance_rial) || 0) !== 0;
  if (!hasLive) return res.status(400).json({ error: 'سند موجودی اول دوره برای این بانک وجود ندارد' });
  try {
    db.transaction(() => {
      upsertBankOpening(db, row, 0, req.user.id);
    })();
    audit(req.user.id, 'reverse', 'bank_opening', row.id, `ابطال موجودی اول دوره بانک ${row.name}`);
    res.json({ ok: true });
  } catch (e) {
    const status = e && e.status ? e.status : 500;
    res.status(status).json({ error: e.message || 'خطا در ابطال افتتاحیه' });
  }
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
    upsertBankOpening(db, row, 0, req.user.id);
    db.prepare('DELETE FROM banks WHERE id=?').run(req.params.id);
    if (row.coa_code) releaseTafsili(db, row.coa_code);
    try { db.prepare('DELETE FROM chart_of_accounts WHERE code=?').run('1102-' + row.id); } catch (_) { /* legacy */ }
  })();
  audit(req.user.id, 'delete', 'bank', req.params.id, `حذف بانک ${row.name}`);
  res.json({ ok: true });
});

module.exports = router;
