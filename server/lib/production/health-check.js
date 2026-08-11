'use strict';
/**
 * Production health checks — docs/Production/database-schema.md §9,
 * accounting-events.md §5 (H1..H5, C1..C7)
 */
const { acct } = require('../coa-map');
const close = require('./close');

function runQuery(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [{ _error: true }];
  }
}

function mkCheck(code, name, rows) {
  const err = rows.length === 1 && rows[0]._error;
  const count = err ? -1 : rows.length;
  return {
    code,
    name,
    status: err ? 'error' : (count === 0 ? 'pass' : 'fail'),
    rows: count < 0 ? 0 : count,
  };
}

function runHealthCheck(db) {
  const wipCode = acct(db, 'coa_wip').code;
  const subInvCode = acct(db, 'coa_subcontract_inventory').code;
  const varPriceCode = acct(db, 'coa_var_material_price').code;
  const varQtyCode = acct(db, 'coa_var_material_qty').code;
  const ctrlCodes = [
    acct(db, 'coa_labor_control').code,
    acct(db, 'coa_overhead_control').code,
    acct(db, 'coa_overhead_applied').code,
  ];
  const ctrlIn = ctrlCodes.map(() => '?').join(',');
  const wipExpr = `
    po.material_cost_rial + po.labor_cost_rial + po.overhead_cost_rial
    + po.subcontract_cost_rial + po.rework_cost_rial
    - po.abnormal_waste_rial - po.scrap_credit_rial - po.byproduct_credit_rial
    - po.total_cost_rial`;

  const checks = [
    mkCheck('H1', 'WIP سفارش‌های بسته صفر است', runQuery(db, `
      SELECT po.order_no, (${wipExpr}) AS wip_residual
      FROM production_orders po
      WHERE po.status = 'closed'
        AND ABS(${wipExpr}) > 5
    `)),
    mkCheck('H2', 'حساب‌های کنترلی صفر هستند', runQuery(db, `
      SELECT jl.account_code, SUM(jl.debit_rial) - SUM(jl.credit_rial) AS bal
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.account_code IN (${ctrlIn})
        AND COALESCE(je.deleted_at, 0) = 0
      GROUP BY jl.account_code
      HAVING ABS(bal) > 5
    `, ctrlCodes)),
    mkCheck('H3', 'تطابق products.stock با انبار', runQuery(db, `
      SELECT p.id, p.name, p.stock, COALESCE(SUM(ws.qty), 0) AS wh_total
      FROM products p
      LEFT JOIN warehouse_stock ws ON ws.product_id = p.id
      GROUP BY p.id
      HAVING p.stock <> wh_total
    `)),
    mkCheck('H4', 'همه تراکنش‌ها سند دارند', runQuery(db, `
      SELECT 'material_issue' AS t, id FROM production_material_issues WHERE je_id IS NULL AND status='posted'
      UNION ALL SELECT 'receipt', id FROM production_receipts WHERE je_id IS NULL AND status='posted'
      UNION ALL SELECT 'labor', id FROM production_labor_entries WHERE je_id IS NULL AND status='posted'
      UNION ALL SELECT 'overhead', id FROM production_overhead_applications WHERE je_id IS NULL AND status='posted'
    `)),
    mkCheck('H5', 'میانگین موزون معتبر', runQuery(db, `
      SELECT id, name, stock, average_cost_rial FROM products
      WHERE stock > 0 AND average_cost_rial <= 0 AND item_type IN ('raw','finished','semi')
    `)),
    mkCheck('C1', 'je_id همه تراکنش‌های posted', runQuery(db, `
      SELECT 'material_issue' AS t, id FROM production_material_issues WHERE status='posted' AND je_id IS NULL
      UNION ALL SELECT 'labor', id FROM production_labor_entries WHERE status='posted' AND je_id IS NULL
      UNION ALL SELECT 'overhead', id FROM production_overhead_applications WHERE status='posted' AND je_id IS NULL
      UNION ALL SELECT 'receipt', id FROM production_receipts WHERE status='posted' AND je_id IS NULL
      UNION ALL SELECT 'waste', id FROM production_waste
        WHERE status='posted' AND je_id IS NULL AND waste_type <> 'normal'
      UNION ALL SELECT 'subcontract', id FROM production_subcontract WHERE status='posted' AND je_id IS NULL
    `)),
    mkCheck('C2', 'بدون سند انتقال مرحله (ADR-012)', runQuery(db, `
      SELECT id, ref_type FROM journal_entries
      WHERE ref_type LIKE '%stage_transfer%' AND COALESCE(deleted_at, 0) = 0
    `)),
    mkCheck('C3', 'بدون سند انحراف مواد (ADR-011)', runQuery(db, `
      SELECT jl.entry_id, jl.account_code FROM journal_lines jl
      WHERE jl.account_code IN (?, ?)
    `, [varPriceCode, varQtyCode])),
    mkCheck('C4', 'همه اسناد تولیدی تراز', runQuery(db, `
      SELECT je.id, je.voucher_number,
             SUM(COALESCE(NULLIF(jl.debit_rial,0), ROUND(jl.debit), 0)) d,
             SUM(COALESCE(NULLIF(jl.credit_rial,0), ROUND(jl.credit), 0)) c
      FROM journal_entries je
      JOIN journal_lines jl ON jl.entry_id = je.id
      WHERE je.ref_type LIKE 'production_%' AND COALESCE(je.deleted_at, 0) = 0
      GROUP BY je.id
      HAVING ABS(d - c) > 5
    `)),
    mkCheck('C5', 'کنترلی‌ها پس از بستن صفر', runQuery(db, `
      SELECT jl.account_code, SUM(jl.debit_rial) - SUM(jl.credit_rial) bal
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.account_code IN (${ctrlIn}) AND COALESCE(je.deleted_at, 0) = 0
      GROUP BY jl.account_code
      HAVING ABS(bal) > 5
    `, ctrlCodes)),
    mkCheck('C6', 'WIP سفارش‌های closed صفر', runQuery(db, `
      SELECT po.order_no, SUM(jl.debit_rial) - SUM(jl.credit_rial) wip
      FROM production_orders po
      JOIN journal_entries je ON je.ref_type LIKE 'production_%'
      JOIN journal_lines jl ON jl.entry_id = je.id AND jl.account_code = ?
        AND jl.detail_account_id = po.coa_wip_tafsili
      WHERE po.status = 'closed' AND COALESCE(je.deleted_at, 0) = 0
      GROUP BY po.id
      HAVING ABS(wip) > 5
    `, [wipCode])),
    mkCheck('C7', 'مانده پیمانکاری سفارش‌های بسته صفر', runQuery(db, `
      SELECT po.order_no, SUM(jl.debit_rial) - SUM(jl.credit_rial) bal
      FROM production_orders po
      JOIN production_subcontract sc ON sc.order_id = po.id
      JOIN journal_entries je ON je.id = sc.je_id
      JOIN journal_lines jl ON jl.entry_id = je.id AND jl.account_code = ?
      WHERE po.status IN ('completed', 'closed') AND COALESCE(je.deleted_at, 0) = 0
      GROUP BY po.id
      HAVING ABS(bal) > 5
    `, [subInvCode])),
  ];

  // Lightweight schema sanity
  for (const t of ['production_orders', 'user_cost_centers', 'production_variances']) {
    try {
      db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get();
      checks.push({ code: 'T', name: `جدول ${t}`, status: 'pass', rows: 0 });
    } catch {
      checks.push({ code: 'T', name: `جدول ${t}`, status: 'fail', rows: 1 });
    }
  }

  // ADR-011: variance accounts must stay at zero balance
  for (const key of ['coa_var_material_price', 'coa_var_material_qty']) {
    const code = acct(db, key).code;
    const bal = close.accountBalance(db, code);
    checks.push({
      code: 'ADR',
      name: `مانده ${code} صفر (ADR-011)`,
      status: Math.abs(bal) <= 5 ? 'pass' : 'fail',
      rows: Math.abs(bal) <= 5 ? 0 : 1,
    });
  }

  const ok = checks.every(c => c.status === 'pass');
  return { ok, checks, at: new Date().toISOString() };
}

module.exports = { runHealthCheck };
