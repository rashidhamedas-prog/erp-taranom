#!/usr/bin/env node
'use strict';
/**
 * Read-only report: cross-warehouse sales lines + COGS inventory credits vs warehouses.
 * Usage: node scripts/report-cross-warehouse-sales.js --db=/path/to/crm.db
 * Never writes to the DB.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { listCrossWarehouseLines } = require('../lib/sales-document');
const { inventoryAccountForWarehouse, inventoryAmountLinesByWarehouse } = require('../lib/inventory/ledger');
const { jlCreditRial } = require('../lib/money');
const { acct } = require('../lib/coa-map');

const args = process.argv.slice(2);
const dbArg = args.find((a) => a.startsWith('--db='));
const dbPath = dbArg ? dbArg.slice(5) : '';
if (!dbPath) {
  console.error('Usage: node scripts/report-cross-warehouse-sales.js --db=/path/to/crm.db');
  process.exit(2);
}
if (!fs.existsSync(dbPath)) {
  console.error('DB not found:', dbPath);
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

function tableExists(name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch (_) {
    return false;
  }
}

function whName(id) {
  if (!id) return '';
  try {
    const w = db.prepare('SELECT name, code FROM warehouses WHERE id=?').get(id);
    return (w && (w.name || w.code)) || String(id);
  } catch (_) {
    return String(id);
  }
}

function cogsAccountCode() {
  try {
    return String(acct(db, 'coa_cogs').code || '5101');
  } catch (_) {
    return '5101';
  }
}

/** @returns {Map<number, number>} warehouseId → cogs rial from ledger rows */
function movementCogsByWarehouse(invoiceId) {
  const map = new Map();
  if (tableExists('inventory_ledger')) {
    const rows = db.prepare(`
      SELECT warehouse_id, SUM(COALESCE(amount_rial, 0)) AS amt
      FROM inventory_ledger
      WHERE source_type='invoice' AND source_id=?
        AND COALESCE(qty_out, 0) > 0
        AND COALESCE(status, 'posted') = 'posted'
        AND COALESCE(reversed_of, 0) = 0
      GROUP BY warehouse_id
    `).all(invoiceId);
    for (const r of rows) {
      const wh = parseInt(r.warehouse_id, 10);
      if (!Number.isFinite(wh) || wh <= 0) continue;
      map.set(wh, (map.get(wh) || 0) + Math.round(Number(r.amt) || 0));
    }
    return map;
  }
  if (tableExists('inventory_movements')) {
    const cols = db.prepare('PRAGMA table_info(inventory_movements)').all().map((c) => c.name);
    const hasAmt = cols.includes('amount_rial');
    const rows = db.prepare(`
      SELECT warehouse_id, ${hasAmt ? 'SUM(ABS(COALESCE(amount_rial,0)))' : '0'} AS amt
      FROM inventory_movements
      WHERE doc_id=? AND doc_type LIKE 'invoice%' AND COALESCE(qty_delta, 0) < 0
      GROUP BY warehouse_id
    `).all(invoiceId);
    for (const r of rows) {
      const wh = parseInt(r.warehouse_id, 10);
      if (!Number.isFinite(wh) || wh <= 0) continue;
      map.set(wh, (map.get(wh) || 0) + Math.round(Number(r.amt) || 0));
    }
  }
  return map;
}

function expectedInventoryCredits(invoiceId, movByWh) {
  const items = [];
  for (const [warehouseId, amountRial] of movByWh.entries()) {
    if (amountRial > 0) items.push({ warehouseId, amountRial });
  }
  if (!items.length) return [];
  return inventoryAmountLinesByWarehouse(db, items);
}

function actualInventoryCredits(invoiceId) {
  const cogsCode = cogsAccountCode();
  const je = db.prepare(`
    SELECT id FROM journal_entries
    WHERE ref_type='invoice_cogs' AND ref_id=? AND COALESCE(deleted_at, 0)=0
    LIMIT 1
  `).get(invoiceId);
  if (!je) return { lines: [], missingJe: true };
  const jlCols = db.prepare('PRAGMA table_info(journal_lines)').all().map((c) => c.name);
  const acctCol = jlCols.includes('account_code') ? 'account_code' : 'code';
  const rows = db.prepare(`
    SELECT ${acctCol} AS account_code, debit, credit, debit_rial, credit_rial, name
    FROM journal_lines WHERE entry_id=?
  `).all(je.id);
  const invCredits = [];
  for (const l of rows) {
    const code = String(l.account_code || '').trim();
    if (!code || code === cogsCode) continue;
    const credit = jlCreditRial(l);
    if (credit > 0) invCredits.push({ code, name: l.name || '', creditRial: credit });
  }
  const merged = new Map();
  for (const l of invCredits) {
    const prev = merged.get(l.code) || { code: l.code, name: l.name, creditRial: 0 };
    prev.creditRial += l.creditRial;
    if (l.name) prev.name = l.name;
    merged.set(l.code, prev);
  }
  return { lines: [...merged.values()], missingJe: false };
}

function compareCredits(expected, actualLines) {
  const expMap = new Map(expected.map((e) => [e.code, Math.round(Number(e.amountRial) || 0)]));
  const actMap = new Map(actualLines.map((a) => [a.code, a.creditRial]));
  const codes = new Set([...expMap.keys(), ...actMap.keys()]);
  const mismatches = [];
  for (const code of codes) {
    const exp = expMap.get(code) || 0;
    const act = actMap.get(code) || 0;
    if (exp !== act) mismatches.push({ account_code: code, expected_credit_rial: exp, actual_credit_rial: act });
  }
  return mismatches;
}

const invCols = tableExists('invoices')
  ? db.prepare('PRAGMA table_info(invoices)').all().map((c) => c.name)
  : [];
if (!invCols.length) {
  console.error('invoices table missing');
  db.close();
  process.exit(1);
}

const statusSql = invCols.includes('status')
  ? " AND COALESCE(status,'') NOT IN ('cancelled','void','deleted')"
  : '';
const typeSql = invCols.includes('type')
  ? " AND type IN ('normal','final')"
  : '';

const invoices = db.prepare(`
  SELECT id, num, date, warehouse_id, rows, stock_deducted
  FROM invoices
  WHERE 1=1 ${statusSql} ${typeSql}
  ORDER BY id
`).all();

const crossLineRows = [];
const cogsReports = [];

for (const inv of invoices) {
  let rows = [];
  try { rows = JSON.parse(inv.rows || '[]'); } catch (_) { rows = []; }
  const cross = listCrossWarehouseLines(rows, inv.warehouse_id);
  if (!cross.length) continue;

  for (const x of cross) {
    crossLineRows.push({
      invoice_id: inv.id,
      num: inv.num,
      date: inv.date,
      header_wh_id: inv.warehouse_id,
      header_wh_name: whName(inv.warehouse_id),
      line_index: x.line,
      product_id: x.product_id,
      from_wh_id: x.from_wh,
      from_wh_name: whName(x.from_wh),
      qty: x.qty,
    });
  }

  const movByWh = movementCogsByWarehouse(inv.id);
  const expected = expectedInventoryCredits(inv.id, movByWh);
  const { lines: actual, missingJe } = actualInventoryCredits(inv.id);
  const mismatches = compareCredits(expected, actual);

  cogsReports.push({
    invoice_id: inv.id,
    num: inv.num,
    date: inv.date,
    stock_deducted: inv.stock_deducted,
    movement_by_wh: [...movByWh.entries()].map(([warehouse_id, cogs_rial]) => ({
      warehouse_id,
      warehouse_name: whName(warehouse_id),
      cogs_rial,
      inventory_account: inventoryAccountForWarehouse(db, warehouse_id).code,
    })),
    expected_inventory_credits: expected,
    actual_inventory_credits: actual,
    missing_invoice_cogs_je: missingJe,
    credit_mismatches: mismatches,
  });
}

console.log('=== Cross-warehouse invoice lines ===');
if (!crossLineRows.length) {
  console.log('(none)');
} else {
  for (const r of crossLineRows) {
    console.log(
      `#${r.invoice_id} ${r.num} (${r.date}) header=${r.header_wh_name} line[${r.line_index}]`
      + ` product=${r.product_id} from=${r.from_wh_name} qty=${r.qty}`
    );
  }
}

console.log('\n=== COGS JE inventory credits vs movement warehouses ===');
for (const r of cogsReports) {
  console.log(`\n--- Invoice ${r.num} (#${r.invoice_id}) ---`);
  if (r.missing_invoice_cogs_je) {
    console.log('  (no invoice_cogs journal entry)');
  }
  if (r.movement_by_wh.length) {
    console.log('  Movements (COGS rial by warehouse):');
    for (const m of r.movement_by_wh) {
      console.log(`    WH ${m.warehouse_name} (#${m.warehouse_id}) → acct ${m.inventory_account} : ${m.cogs_rial} rial`);
    }
  } else {
    console.log('  (no outbound inventory ledger rows for this invoice)');
  }
  if (r.expected_inventory_credits.length) {
    console.log('  Expected JE inventory credits:');
    for (const e of r.expected_inventory_credits) {
      console.log(`    ${e.code} ${e.name}: ${e.amountRial} rial`);
    }
  }
  if (r.actual_inventory_credits.length) {
    console.log('  Actual JE inventory credits:');
    for (const a of r.actual_inventory_credits) {
      console.log(`    ${a.code} ${a.name}: ${a.creditRial} rial`);
    }
  }
  if (r.credit_mismatches.length) {
    console.log('  ** MISMATCH **');
    for (const m of r.credit_mismatches) {
      console.log(`    ${m.account_code}: expected ${m.expected_credit_rial}, actual ${m.actual_credit_rial}`);
    }
  } else if (!r.missing_invoice_cogs_je && r.expected_inventory_credits.length) {
    console.log('  OK — credits match movement buckets');
  }
}

console.log('\n=== Summary JSON ===');
console.log(JSON.stringify({
  cross_line_count: crossLineRows.length,
  invoices_with_cross_lines: cogsReports.length,
  invoices_with_credit_mismatch: cogsReports.filter((r) => r.credit_mismatches.length).length,
  cross_lines: crossLineRows,
  cogs: cogsReports,
}, null, 2));

db.close();
