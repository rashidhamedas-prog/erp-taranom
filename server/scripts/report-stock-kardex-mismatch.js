#!/usr/bin/env node
'use strict';
/**
 * FR-P334-A — read-only report: warehouse_stock.qty ≠ live kardex qty (product × warehouse).
 * Usage: node scripts/report-stock-kardex-mismatch.js --db <path> [--product 334] [--warehouse 34] [--json]
 * Opens the DB read-only; never writes.
 */
const fs = require('fs');
const Database = require('better-sqlite3');
const { stockKardexMismatch } = require('../lib/inventory/stock-kardex-mismatch');

function arg(name) {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}

const dbPath = arg('db');
if (!dbPath) {
  console.error('Usage: node scripts/report-stock-kardex-mismatch.js --db <path> [--product 334] [--warehouse 34] [--json]');
  process.exit(2);
}
if (!fs.existsSync(dbPath)) {
  console.error('DB not found:', dbPath);
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const out = stockKardexMismatch(db, {
  productId: parseInt(arg('product'), 10) || null,
  warehouseId: parseInt(arg('warehouse'), 10) || null,
});
db.close();

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`stock vs kardex mismatches: ${out.count} (Σ|diff| = ${out.total_abs_diff_qty})`);
  for (const r of out.rows) {
    console.log([
      `product ${r.product_id} ${r.product_code || ''}`.trim(),
      `wh ${r.warehouse_id} ${r.warehouse_name || ''}`.trim(),
      `warehouse_stock=${r.warehouse_stock_qty}`,
      `kardex=${r.kardex_qty}`,
      `diff=${r.diff_qty}`,
      `kardex_value_rial=${r.kardex_value_rial}`,
    ].join(' | '));
  }
}
