'use strict';

function runRecon(db) {
  const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../../server/lib/money');
  const issues = [];
  const checks = [];

  function add(id, ok, expected, actual, extra) {
    checks.push({ id, ok, expected, actual, extra: extra || '' });
    if (!ok) issues.push({ id, expected, actual, extra });
  }

  const je = db.prepare(`
    SELECT je.id,
      SUM(${SQL_JL_DEBIT_RIAL}) AS dr,
      SUM(${SQL_JL_CREDIT_RIAL}) AS cr
    FROM journal_entries je
    JOIN journal_lines jl ON jl.entry_id = je.id
    WHERE COALESCE(je.deleted_at,0)=0
    GROUP BY je.id
  `).all();
  const unbalanced = je.filter((r) => Math.round(Number(r.dr) || 0) !== Math.round(Number(r.cr) || 0));
  add('je.balanced', unbalanced.length === 0, 0, unbalanced.length,
    unbalanced.slice(0, 5).map((r) => r.id).join(','));

  const fk = db.prepare('PRAGMA foreign_key_check').all();
  add('fk.zero', fk.length === 0, 0, fk.length);

  const invoicesNoParty = db.prepare(`
    SELECT COUNT(*) c FROM invoices i
    LEFT JOIN customers c ON c.id = i.cust_id
    WHERE c.id IS NULL
  `).get().c;
  add('invoice.has_customer', invoicesNoParty === 0, 0, invoicesNoParty);

  let firmNoWh = 0;
  try {
    firmNoWh = db.prepare(`
      SELECT COUNT(*) c FROM invoices
      WHERE type IN ('final','normal') AND (warehouse_id IS NULL OR warehouse_id=0)
        AND COALESCE(status,'') NOT IN ('reversed','void','cancelled')
    `).get().c;
  } catch {
    firmNoWh = -1;
  }
  if (firmNoWh >= 0) add('firm_invoice.has_warehouse', firmNoWh === 0, 0, firmNoWh);

  let ledgerVsWh = { ok: true, extra: 'skipped' };
  try {
    const hasLedger = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inventory_ledger'").get();
    if (hasLedger) {
      const rows = db.prepare(`
        SELECT warehouse_id, product_id, ROUND(SUM(qty_in - qty_out), 6) AS q
        FROM inventory_ledger GROUP BY warehouse_id, product_id
      `).all();
      let mismatch = 0;
      for (const r of rows) {
        const ws = db.prepare(
          'SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND product_id=?'
        ).get(r.warehouse_id, r.product_id);
        const wq = Number(ws?.qty || 0);
        if (Math.abs(wq - Number(r.q || 0)) > 0.001) mismatch += 1;
      }
      add('stock.ledger_vs_warehouse', mismatch === 0, 0, mismatch, 'opening stock may live only on warehouse_stock');
    } else {
      add('stock.ledger_vs_warehouse', true, 'n/a', 'no inventory_ledger');
    }
  } catch (e) {
    add('stock.ledger_vs_warehouse', false, 'recon', String(e.message));
  }

  try {
    const orphans = db.prepare(`
      SELECT COUNT(*) c FROM journal_lines jl
      LEFT JOIN journal_entries je ON je.id = jl.entry_id
      WHERE je.id IS NULL
    `).get().c;
    add('je.no_orphan_lines', orphans === 0, 0, orphans);
  } catch (e) {
    add('je.no_orphan_lines', false, 0, e.message);
  }

  return { checks, issues, journal_count: je.length, unbalanced: unbalanced.length };
}

module.exports = { runRecon };
