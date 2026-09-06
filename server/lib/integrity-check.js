// System integrity checks — spec §10.19

const { DELETED_FILTER } = require('./ledger');
const { firmSaleTypeSql } = require('./sales-document');

function runIntegrityCheck(db) {
  const issues = [];
  const checks = [];

  // (a) Balanced journal vouchers
  const unbalanced = db.prepare(`
    SELECT je.id, je.entry_date, je.ref_type,
      ROUND(COALESCE(SUM(jl.debit),0),2) AS d,
      ROUND(COALESCE(SUM(jl.credit),0),2) AS c
    FROM journal_entries je
    JOIN journal_lines jl ON jl.entry_id=je.id
    WHERE ${DELETED_FILTER}
    GROUP BY je.id
    HAVING ABS(d - c) > 0.01
  `).all();
  checks.push({ id: 'journal_balance', ok: unbalanced.length === 0, count: unbalanced.length });
  if (unbalanced.length) issues.push({ check: 'journal_balance', message: `${unbalanced.length} سند تراز نیست`, sample: unbalanced.slice(0, 5) });

  // (b) Final invoices should have journal
  const invNoJournal = db.prepare(`
    SELECT i.id, i.num FROM invoices i
    WHERE ${firmSaleTypeSql('i')} AND COALESCE(i.deleted_at,0)=0 AND COALESCE(i.stock_deducted,0)=1
    AND NOT EXISTS (
      SELECT 1 FROM journal_entries je
      WHERE je.ref_type='invoice' AND je.ref_id=i.id AND ${DELETED_FILTER}
    )
  `).all();
  checks.push({ id: 'invoice_journal', ok: invNoJournal.length === 0, count: invNoJournal.length });
  if (invNoJournal.length) issues.push({ check: 'invoice_journal', message: `${invNoJournal.length} فاکتور نهایی بدون سند`, sample: invNoJournal.slice(0, 5) });

  // (c) Warehouse stock vs stock_logs (approximate)
  const stockDrift = db.prepare(`
    SELECT p.id, p.name, p.stock AS product_stock,
      COALESCE((SELECT SUM(change) FROM stock_logs sl WHERE sl.product_id=p.id),0) AS log_sum
    FROM products p
    WHERE ABS(p.stock - COALESCE((SELECT SUM(change) FROM stock_logs sl WHERE sl.product_id=p.id),0)) > 1
    LIMIT 20
  `).all();
  checks.push({ id: 'stock_logs', ok: stockDrift.length === 0, count: stockDrift.length });
  if (stockDrift.length) issues.push({ check: 'stock_logs', message: `${stockDrift.length} کالا اختلاف موجودی/لاگ`, sample: stockDrift.slice(0, 5) });

  // (d) Orphaned journal lines
  const orphanLines = db.prepare(`
    SELECT COUNT(*) c FROM journal_lines jl
    WHERE NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.id=jl.entry_id)
  `).get().c;
  checks.push({ id: 'orphan_lines', ok: orphanLines === 0, count: orphanLines });
  if (orphanLines) issues.push({ check: 'orphan_lines', message: `${orphanLines} سطر سند یتیم` });

  // (e) Missing CoA accounts referenced in journal
  const missingCoa = db.prepare(`
    SELECT DISTINCT jl.account_code FROM journal_lines jl
    JOIN journal_entries je ON je.id=jl.entry_id
    WHERE ${DELETED_FILTER}
    AND NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.code=jl.account_code)
    LIMIT 20
  `).all();
  checks.push({ id: 'coa_references', ok: missingCoa.length === 0, count: missingCoa.length });
  if (missingCoa.length) issues.push({ check: 'coa_references', message: `${missingCoa.length} کد حساب در سند بدون تعریف در کدینگ`, sample: missingCoa });

  const passed = checks.every(c => c.ok);
  const result = { passed, checks, issues, checked_at: new Date().toISOString() };
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('last_integrity_check',?)")
      .run(JSON.stringify(result));
  } catch (_) { /* settings may not exist yet */ }
  return result;
}

function getLastIntegrityResult(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key='last_integrity_check'").get();
  if (!row?.value) return null;
  try { return JSON.parse(row.value); } catch (_) { return null; }
}

module.exports = { runIntegrityCheck, getLastIntegrityResult };
