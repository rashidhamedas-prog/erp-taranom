const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { acct } = require('../lib/coa-map');
const { postToLedger } = require('../lib/ledger');
const { rialToLedger, SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');
const { todayJalali, j2g } = require('../jalali');
const { postLegalReserve } = require('../lib/reserves/legal-reserve');
const { firmSaleTypeSql } = require('../lib/sales-document');

function daysSinceJalali(dateStr) {
  try {
    const [jy, jm, jd] = (dateStr || '').split('/').map(Number);
    if (!jy || !jm || !jd) return 0;
    const [gy, gm, gd] = j2g(jy, jm, jd);
    const then = new Date(gy, gm - 1, gd);
    return Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24));
  } catch { return 0; }
}

function computeArBalance(db) {
  const receivable = acct(db, 'coa_receivable');
  const row = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}), 0) bal
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.account_code LIKE ?
      AND COALESCE(je.deleted_at, 0) = 0
      AND COALESCE(je.status, 'approved') <> 'reversed'
  `).get(receivable.code + '%');
  return Math.max(0, Math.round(row?.bal || 0));
}

function computeAgingProvision(db, asOfDate, percentBp) {
  const customers = db.prepare('SELECT id FROM customers').all();
  let total = 0;
  const buckets = { b0_30: 0, b31_60: 0, b61_90: 0, b90plus: 0 };
  for (const c of customers) {
    const invoices = db.prepare(`
      SELECT id, date, COALESCE(NULLIF(final_rial, 0), ROUND(final), 0) final_rial
      FROM invoices WHERE cust_id=? AND ${firmSaleTypeSql()}
      ORDER BY date ASC, id ASC
    `).all(c.id);
    if (!invoices.length) continue;
    let settledPool = db.prepare(`
      SELECT COALESCE(SUM(COALESCE(NULLIF(amount_rial, 0), ROUND(amount), 0)), 0) s
      FROM settlements WHERE cust_id=?
    `).get(c.id).s;
    for (const inv of invoices) {
      let remaining = inv.final_rial;
      if (settledPool > 0) {
        const applied = Math.min(settledPool, remaining);
        remaining -= applied;
        settledPool -= applied;
      }
      if (remaining <= 0) continue;
      const age = daysSinceJalali(inv.date);
      if (age <= 30) buckets.b0_30 += remaining;
      else if (age <= 60) buckets.b31_60 += remaining;
      else if (age <= 90) buckets.b61_90 += remaining;
      else buckets.b90plus += remaining;
    }
  }
  if (percentBp != null) {
    total = Math.round(computeArBalance(db) * (Number(percentBp) || 0) / 10000);
  } else {
    total = Math.round(
      buckets.b0_30 * 0.01 +
      buckets.b31_60 * 0.05 +
      buckets.b61_90 * 0.20 +
      buckets.b90plus * 0.50
    );
  }
  return { total_rial: total, buckets, ar_balance_rial: computeArBalance(db), as_of_date: asOfDate };
}

router.post('/legal-reserve', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const result = postLegalReserve(db, req.user.id, req.body || {});
    audit(req.user.id, 'create', 'legal_reserve', result.id, `اندوخته ${result.reserve_rial} ریال`);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/doubtful', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const asOfDate = req.body.as_of_date || todayJalali();
    const percentBp = req.body.percent_bp != null ? Math.round(Number(req.body.percent_bp)) : null;
    const calc = computeAgingProvision(db, asOfDate, percentBp);
    if (calc.total_rial <= 0) throw new Error('مبلغ ذخیره محاسبه‌شده صفر است');

    const expense = acct(db, 'coa_doubtful_expense');
    const reserve = acct(db, 'coa_doubtful_debts');
    const amt = rialToLedger(calc.total_rial);

    const result = db.transaction(() => {
      const jeId = postToLedger(db, {
        sourceType: 'doubtful_debt_provision', sourceId: 0, date: asOfDate,
        description: `ذخیره مطالبات مشکوک‌الوصول — ${asOfDate}`,
        createdBy: req.user.id,
        lines: [
          { code: expense.code, name: expense.name, debit: amt, credit: 0, debit_rial: calc.total_rial },
          { code: reserve.code, name: reserve.name, debit: 0, credit: amt, credit_rial: calc.total_rial },
        ],
      });
      const ins = db.prepare(`
        INSERT INTO doubtful_debt_provisions (as_of_date, method, total_rial, je_id, notes, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(asOfDate, percentBp != null ? 'percent' : 'aging', calc.total_rial, jeId, req.body.notes || '', req.user.id);
      return { id: ins.lastInsertRowid, je_id: jeId, ...calc };
    })();

    audit(req.user.id, 'create', 'doubtful_provision', result.id, `${calc.total_rial} ریال`);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/inventory-nrv', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const asOfDate = req.body.as_of_date || todayJalali();
    const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
    if (!lines.length) throw new Error('حداقل یک ردیف کالا الزامی است');

    const detailLines = lines.map(l => {
      const qty = Number(l.qty) || 0;
      const costRial = Math.round(Number(l.cost_rial) || 0);
      const nrvRial = Math.round(Number(l.nrv_rial) || 0);
      const perUnit = Math.max(0, costRial - nrvRial);
      const writedown = Math.round(perUnit * qty);
      return { product_id: l.product_id, qty, cost_rial: costRial, nrv_rial: nrvRial, writedown_rial: writedown };
    }).filter(l => l.writedown_rial > 0);

    const totalRial = detailLines.reduce((s, l) => s + l.writedown_rial, 0);
    if (totalRial <= 0) throw new Error('مبلغ کاهش ارزش محاسبه‌شده صفر است');

    const expense = acct(db, 'coa_inventory_writedown_exp');
    const reserve = acct(db, 'coa_inventory_writedown');
    const amt = rialToLedger(totalRial);

    const result = db.transaction(() => {
      const jeId = postToLedger(db, {
        sourceType: 'inventory_nrv_provision', sourceId: 0, date: asOfDate,
        description: `ذخیره کاهش ارزش موجودی — ${asOfDate}`,
        createdBy: req.user.id,
        lines: [
          { code: expense.code, name: expense.name, debit: amt, credit: 0, debit_rial: totalRial },
          { code: reserve.code, name: reserve.name, debit: 0, credit: amt, credit_rial: totalRial },
        ],
      });
      const prov = db.prepare(`
        INSERT INTO inventory_nrv_provisions (as_of_date, total_rial, je_id, notes, created_by)
        VALUES (?,?,?,?,?)
      `).run(asOfDate, totalRial, jeId, req.body.notes || '', req.user.id);
      const insLine = db.prepare(`
        INSERT INTO inventory_nrv_lines (provision_id, product_id, qty, cost_rial, nrv_rial, writedown_rial)
        VALUES (?,?,?,?,?,?)
      `);
      for (const l of detailLines) {
        insLine.run(prov.lastInsertRowid, l.product_id, l.qty, l.cost_rial, l.nrv_rial, l.writedown_rial);
      }
      return { id: prov.lastInsertRowid, je_id: jeId, total_rial: totalRial, lines: detailLines };
    })();

    audit(req.user.id, 'create', 'inventory_nrv', result.id, `${totalRial} ریال`);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/stale-products', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const months = Math.max(1, parseInt(req.query.months, 10) || 6);
  const cutoff = Math.floor(Date.now() / 1000) - months * 30 * 24 * 3600;

  const hasInventoryLedger = !!db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='inventory_ledger'
  `).get();

  const rows = db.prepare(`
    SELECT p.id, p.code, p.name, p.stock,
      COALESCE(
        (SELECT MAX(created_at) FROM stock_logs sl WHERE sl.product_id=p.id),
        0
      ) last_stock_log_at,
      COALESCE(
        (SELECT MAX(created_at) FROM warehouse_moves wm WHERE wm.product_id=p.id),
        0
      ) last_move_at
      ${hasInventoryLedger ? `, COALESCE(
        (SELECT MAX(created_at) FROM inventory_ledger il WHERE il.product_id=p.id),
        0
      ) last_ledger_at` : ', 0 AS last_ledger_at'}
    FROM products p
    WHERE COALESCE(p.stock, 0) > 0
  `).all().map(p => {
    const lastAt = Math.max(p.last_stock_log_at || 0, p.last_move_at || 0, p.last_ledger_at || 0);
    return { ...p, last_movement_at: lastAt, stale: lastAt < cutoff };
  }).filter(p => p.stale);

  res.json({ months, cutoff_epoch: cutoff, count: rows.length, rows });
});

module.exports = router;
module.exports.postLegalReserve = postLegalReserve;
module.exports.computeAgingProvision = computeAgingProvision;
