const router = require('express').Router();
const { allocTafsili, releaseTafsili, acct } = require('../lib/coa-map');
const { getDB, audit, syncCashBoxAccount } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { postToLedger, rewriteJournalEntry } = require('../lib/ledger');
const { rialToLedger } = require('../lib/money');
const { todayJalali } = require('../jalali');
const { reverseJournalEntry } = require('../lib/void-journal');
const { getActiveFiscalYear } = require('../lib/fiscal-period');

// Unrestricted cash box management — mirrors banks.js (opening balance + live ledger).

function fiscalOpeningDate(db) {
  const fy = getActiveFiscalYear(db);
  return (fy && fy.start_date) || todayJalali();
}

function liveCashOpeningJeId(db, box) {
  if (box.opening_balance_je_id) {
    const live = db.prepare(
      "SELECT id FROM journal_entries WHERE id=? AND COALESCE(deleted_at,0)=0 AND COALESCE(status,'posted') NOT IN ('reversed','void')"
    ).get(box.opening_balance_je_id);
    if (live) return live.id;
    db.prepare('UPDATE cash_boxes SET opening_balance_je_id=NULL WHERE id=?').run(box.id);
    box.opening_balance_je_id = null;
  }
  const existing = db.prepare(
    "SELECT id FROM journal_entries WHERE ref_type='cash_opening' AND ref_id=? AND COALESCE(deleted_at,0)=0 AND COALESCE(status,'posted') NOT IN ('reversed','void') ORDER BY id DESC LIMIT 1"
  ).get(box.id);
  if (existing) {
    db.prepare('UPDATE cash_boxes SET opening_balance_je_id=? WHERE id=?').run(existing.id, box.id);
    box.opening_balance_je_id = existing.id;
    return existing.id;
  }
  return null;
}

function cashOpeningLines(db, box, amt) {
  syncCashBoxAccount(db, box);
  const joinCode = resolveCashJoinCode(db, box);
  const cashAcct = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(joinCode);
  const cashCode = cashAcct || { code: joinCode, name: box.name };
  const openingAccount = acct(db, 'coa_opening_balance');
  const valueToman = rialToLedger(amt);
  return [
    { code: cashCode.code, name: cashCode.name || box.name, debit: valueToman, credit: 0 },
    { code: openingAccount.code, name: openingAccount.name, debit: 0, credit: valueToman },
  ];
}

/** Upsert opening JE: create / rewrite amount+FY-start date / void when amt≤0. */
function upsertCashOpening(db, box, openingRial, userId, { dateOverride } = {}) {
  const amt = Math.round(Number(openingRial) || 0);
  const date = dateOverride || fiscalOpeningDate(db);
  let jeId = liveCashOpeningJeId(db, box);

  if (amt <= 0) {
    if (jeId) {
      reverseJournalEntry(db, jeId, {
        userId: userId || 1,
        reason: `ابطال موجودی اول دوره صندوق ${box.name}`,
        sourceType: 'cash_opening_reversal',
      });
    }
    db.prepare('UPDATE cash_boxes SET opening_balance_rial=0, opening_balance_je_id=NULL, opening_balance_date=? WHERE id=?')
      .run(date, box.id);
    return null;
  }

  const lines = cashOpeningLines(db, box, amt);
  const description = `موجودی اول دوره صندوق ${box.name}`;

  if (jeId) {
    const je = db.prepare('SELECT entry_date, total_debit_rial, ref_type FROM journal_entries WHERE id=?').get(jeId);
    const currentRial = Math.round(Number(je && je.total_debit_rial) || 0);
    const isCashOpening = String(je && je.ref_type || '') === 'cash_opening';
    if (!isCashOpening) {
      db.prepare('UPDATE cash_boxes SET opening_balance_je_id=NULL WHERE id=?').run(box.id);
      jeId = null;
    } else if (currentRial !== amt || String(je && je.entry_date || '') !== String(date)) {
      const rewritten = rewriteJournalEntry(db, {
        sourceType: 'cash_opening',
        sourceId: box.id,
        date,
        description,
        lines,
      });
      if (!rewritten) {
        db.prepare('UPDATE cash_boxes SET opening_balance_je_id=NULL WHERE id=?').run(box.id);
        jeId = null;
      } else {
        db.prepare('UPDATE cash_boxes SET opening_balance_rial=?, opening_balance_je_id=?, opening_balance_date=? WHERE id=?')
          .run(amt, rewritten, date, box.id);
        return rewritten;
      }
    } else {
      db.prepare('UPDATE cash_boxes SET opening_balance_rial=?, opening_balance_je_id=?, opening_balance_date=? WHERE id=?')
        .run(amt, jeId, date, box.id);
      return jeId;
    }
  }

  const journalId = postToLedger(db, {
    sourceType: 'cash_opening',
    sourceId: box.id,
    date,
    description,
    createdBy: userId,
    voucherType: 'opening',
    lines,
  });
  db.prepare('UPDATE cash_boxes SET opening_balance_rial=?, opening_balance_je_id=?, opening_balance_date=? WHERE id=?')
    .run(amt, journalId, date, box.id);
  return journalId;
}

function postCashOpeningJe(db, box, openingRial, userId) {
  return upsertCashOpening(db, box, openingRial, userId);
}

function repairCashOpeningIfNeeded(db, box, userId) {
  const amt = Math.round(Number(box.opening_balance_rial) || 0);
  if (amt <= 0) return box;
  if (liveCashOpeningJeId(db, box)) return db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(box.id) || box;
  try {
    upsertCashOpening(db, box, amt, userId || 1);
  } catch (e) {
    if (e && (e.status === 422 || /سال مالی|fiscal/i.test(String(e.message || '')))) {
      try {
        upsertCashOpening(db, box, amt, userId || 1, { dateOverride: todayJalali() });
      } catch (e2) {
        console.error('cash opening repair retry', box.id, e2 && e2.message);
      }
    } else {
      console.error('cash opening repair', box.id, e && e.message);
    }
  }
  return db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(box.id) || box;
}

router.get('/', auth, (req, res) => {
  const db = getDB();
  res.json(db.prepare('SELECT * FROM cash_boxes ORDER BY name').all());
});

function resolveCashJoinCode(db, box) {
  let code = String(box.coa_code || '').trim();
  if (code) return code;
  try {
    const name = String(box.name || '').trim();
    if (name) {
      const hit = db.prepare(`
        SELECT code FROM chart_of_accounts
        WHERE name LIKE '%' || ? || '%'
          AND (code LIKE '206002%' OR code LIKE '1101%')
        ORDER BY CASE WHEN code LIKE '206002%' THEN 0 ELSE 1 END, length(code) DESC
        LIMIT 1
      `).get(name);
      if (hit && hit.code) {
        db.prepare("UPDATE cash_boxes SET coa_code=? WHERE id=? AND COALESCE(coa_code,'')=''").run(hit.code, box.id);
        return hit.code;
      }
    }
  } catch (_) { /* */ }
  return '1101-' + box.id;
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

router.get('/balances', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const boxes = db.prepare('SELECT * FROM cash_boxes ORDER BY name').all();
  const rows = boxes.map((raw) => {
    const b = repairCashOpeningIfNeeded(db, raw, req.user && req.user.id);
    const joinCode = resolveCashJoinCode(db, b);
    let balance = glBalanceOnCode(db, joinCode);
    if (balance === 0) {
      const legacy = '1101-' + b.id;
      if (legacy !== joinCode) {
        const legBal = glBalanceOnCode(db, legacy);
        if (legBal !== 0) balance = legBal;
      }
    }
    const openingStored = Math.round(Number(b.opening_balance_rial) || 0);
    return {
      ...b,
      coa_code: String(b.coa_code || '').trim() || (joinCode.startsWith('1101-') ? b.coa_code : joinCode),
      balance,
      opening_balance_rial: openingStored,
      opening_effective_rial: openingStored > 0 ? openingStored : balance,
    };
  });
  res.json(rows);
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const {
    name, custodian, is_petty_cash, currency, is_foreign, opening_balance_rial, opening_balance_date,
    float_ceiling_rial,
  } = req.body;
  if (!name) return res.status(400).json({ error: 'نام صندوق الزامی است' });
  const db = getDB();
  const cur = String(currency || 'IRR').toUpperCase();
  const foreign = is_foreign ? 1 : (cur !== 'IRR' ? 1 : 0);
  const openingRial = Math.round(Number(opening_balance_rial) || 0);
  const openDate = fiscalOpeningDate(db);
  const ceilRaw = float_ceiling_rial;
  const floatCeil = (ceilRaw === null || ceilRaw === undefined || ceilRaw === '')
    ? null
    : Math.max(0, Math.round(Number(ceilRaw) || 0));
  const box = db.transaction(() => {
    const result = db.prepare(
      'INSERT INTO cash_boxes (name,custodian,is_petty_cash,currency,is_foreign,opening_balance_rial,opening_balance_date,float_ceiling_rial) VALUES (?,?,?,?,?,?,?,?)'
    ).run(
      name, custodian || '', is_petty_cash ? 1 : 0, cur, foreign,
      openingRial > 0 ? openingRial : 0, openingRial > 0 ? openDate : (opening_balance_date || null),
      floatCeil
    );
    try {
      const cc = allocTafsili(db, 'cashbox', name);
      if (cc) db.prepare('UPDATE cash_boxes SET coa_code=? WHERE id=?').run(cc, result.lastInsertRowid);
    } catch (_) { /* ignore */ }
    let row = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(result.lastInsertRowid);
    syncCashBoxAccount(db, row);
    row = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(result.lastInsertRowid);
    if (openingRial > 0) {
      upsertCashOpening(db, row, openingRial, req.user.id);
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
  const {
    name, custodian, active, is_petty_cash, currency, is_foreign, opening_balance_rial, opening_balance_date,
    float_ceiling_rial,
  } = req.body;
  const cur = currency != null ? String(currency).toUpperCase() : (row.currency || 'IRR');
  const foreign = is_foreign != null ? (is_foreign ? 1 : 0) : (row.is_foreign || (cur !== 'IRR' ? 1 : 0));
  const floatCeil = float_ceiling_rial === undefined
    ? row.float_ceiling_rial
    : ((float_ceiling_rial === null || float_ceiling_rial === '')
      ? null
      : Math.max(0, Math.round(Number(float_ceiling_rial) || 0)));
  try {
    const updated = db.transaction(() => {
      db.prepare('UPDATE cash_boxes SET name=?,custodian=?,active=?,is_petty_cash=?,currency=?,is_foreign=?,float_ceiling_rial=? WHERE id=?')
        .run(name || row.name, custodian ?? row.custodian, active != null ? (active ? 1 : 0) : row.active,
             is_petty_cash != null ? (is_petty_cash ? 1 : 0) : row.is_petty_cash, cur, foreign,
             floatCeil, req.params.id);
      let next = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(req.params.id);
      syncCashBoxAccount(db, next);
      next = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(req.params.id);
      if (opening_balance_rial != null) {
        upsertCashOpening(db, next, opening_balance_rial, req.user.id);
        next = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(req.params.id);
      } else if (opening_balance_date != null && opening_balance_date !== '') {
        db.prepare('UPDATE cash_boxes SET opening_balance_date=? WHERE id=?').run(opening_balance_date, req.params.id);
        next = db.prepare('SELECT * FROM cash_boxes WHERE id=?').get(req.params.id);
      }
      return next;
    })();
    audit(req.user.id, 'update', 'cash_box', req.params.id, `ویرایش صندوق ${name || row.name}`);
    res.json({ ok: true, cash_box: updated });
  } catch (e) {
    const status = e && e.status ? e.status : 500;
    res.status(status).json({ error: e.message || 'خطا در ذخیره صندوق' });
  }
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
