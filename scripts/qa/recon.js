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

  try {
    const hasLedger = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inventory_ledger'").get();
    const hasWh = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='warehouse_stock'").get();
    if (hasLedger && hasWh) {
      const colNames = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
      const ledCols = colNames('inventory_ledger');
      const wsCols = colNames('warehouse_stock');
      const dims = ['company_id', 'warehouse_id', 'product_id', 'variant_id']
        .filter((c) => ledCols.has(c) || wsCols.has(c));
      const selectList = (avail) => dims.map((c) => (avail.has(c) ? c : `NULL AS ${c}`)).join(', ');
      const groupList = (avail) => {
        const g = dims.filter((c) => avail.has(c));
        return g.length ? g.join(', ') : 'NULL';
      };
      const keyOf = (row) => dims.map((c) => (row[c] == null || row[c] === '' ? '∅' : String(row[c]))).join('|');
      const qtyByKey = new Map();
      const bump = (row, side, qty) => {
        const k = keyOf(row);
        const cur = qtyByKey.get(k) || { ledger: 0, warehouse: 0 };
        cur[side] += Number(qty) || 0;
        qtyByKey.set(k, cur);
      };
      for (const r of db.prepare(`
        SELECT ${selectList(ledCols)}, ROUND(SUM(qty_in - qty_out), 6) AS q
        FROM inventory_ledger GROUP BY ${groupList(ledCols)}
      `).all()) bump(r, 'ledger', r.q);
      for (const r of db.prepare(`
        SELECT ${selectList(wsCols)}, ROUND(SUM(qty), 6) AS q
        FROM warehouse_stock GROUP BY ${groupList(wsCols)}
      `).all()) bump(r, 'warehouse', r.q);
      let mismatch = 0;
      for (const v of qtyByKey.values()) {
        if (Math.abs(v.warehouse - v.ledger) > 0.001) mismatch += 1;
      }
      add('stock.ledger_vs_warehouse', mismatch === 0, 0, mismatch, 'union company/warehouse/product/variant');
    } else if (hasLedger) {
      add('stock.ledger_vs_warehouse', true, 'n/a', 'no warehouse_stock');
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
