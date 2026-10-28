'use strict';
/**
 * گزارش فقط‌خواندنی تطبیق لایه‌های موجودی.
 * node server/scripts/inv-reconcile-report.js --db server/crm.db --readonly --out <prefix>
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { computeLayerReconcile } = require('../lib/inventory/layer-reconcile');
const { extraCounts, SYNC_ASSESSMENT } = require('../lib/inventory/wh-data-correction');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  return process.argv[i + 1];
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function writeCsv(file, headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

const dbPath = arg('--db');
const out = arg('--out');
if (!dbPath || !out || !process.argv.includes('--readonly')) {
  console.error('usage: inv-reconcile-report.js --db <path> --readonly --out <prefix>');
  process.exit(1);
}
const abs = path.resolve(dbPath);
const db = new Database(abs, { readonly: true, fileMustExist: true });
const before = db.prepare('SELECT total_changes() c').get().c;
const rec = computeLayerReconcile(db, {});
const extra = extraCounts(db);
const summary = Object.assign({}, rec.summary, extra);
const after = db.prepare('SELECT total_changes() c').get().c;
console.log(`total_changes ${before} ${after}`);
if (before !== after) {
  console.error('STOP: گزارش فقط‌خواندنی total_changes را عوض کرد');
  process.exit(1);
}

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out + '.json', JSON.stringify(Object.assign({}, rec, { summary, sync_assessment: SYNC_ASSESSMENT }), null, 2));

const rowHeaders = ['product_id', 'product_code', 'warehouse_id', 'ws_qty', 'vws_sum', 'ledger_qty', 'ledger_value_rial', 'drift_any'];
writeCsv(out + '-rows.csv', rowHeaders, (rec.rows || []).map((r) => ({
  product_id: r.product_id,
  product_code: r.product_code,
  warehouse_id: r.warehouse_id,
  ws_qty: r.ws_qty,
  vws_sum: r.vws_sum,
  ledger_qty: r.ledger_qty,
  ledger_value_rial: r.ledger_value_rial,
  drift_any: r.drift_any ? 1 : 0,
})));
writeCsv(out + '-products.csv', ['product_id', 'product_code', 'products_stock', 'ws_total', 'ledger_total_qty', 'drift_any'], rec.products || []);

const exceptions = [];
const ex = rec.exceptions || {};
for (const [kind, list] of Object.entries(ex)) {
  for (const item of list || []) {
    exceptions.push({ kind, product_id: item.product_id || '', warehouse_id: item.warehouse_id || '', detail: JSON.stringify(item) });
  }
}
writeCsv(out + '-exceptions.csv', ['kind', 'product_id', 'warehouse_id', 'detail'], exceptions);

const lines = [
  'inv-reconcile-report readonly',
  `db=${abs}`,
  `total_changes ${before} ${after}`,
  '',
  ...Object.keys(summary).sort().map((k) => `${k}=${summary[k]}`),
  '',
  SYNC_ASSESSMENT,
  '',
];
fs.writeFileSync(out + '-summary.txt', lines.join('\n'), 'utf8');
console.log(out + '-summary.txt');
for (const k of ['products_with_header_drift', 'ws_vs_ledger', 'ws_vs_vws', 'pv_vs_vws_variants', 'ws_negative', 'ledger_without_warehouse', 'duplicate_opening', 'zero_qty_nonzero_value', 'warehouse_moves_without_variant', 'cogs_vs_kardex_invoices']) {
  console.log(`${k}=${summary[k]}`);
}
db.close();
