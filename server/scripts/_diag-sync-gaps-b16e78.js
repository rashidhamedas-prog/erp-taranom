/* Debug-session b16e78: PATH_TABLE_MAP + SYNCABLE_TABLES gap probe */
const fs = require('fs');
const path = require('path');
const logPath = path.resolve(__dirname, '../../../debug-b16e78.log');

function log(hypothesisId, location, message, data) {
  const payload = {
    sessionId: 'b16e78',
    runId: process.env.DIAG_RUN_ID || 'pre-fix',
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  };
  const line = JSON.stringify(payload);
  fs.appendFileSync(logPath, line + '\n');
  fetch('http://127.0.0.1:7289/ingest/f0bd7efb-e01b-4c84-91db-1073bbd1ced1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'b16e78' },
    body: line,
  }).catch(() => {});
}

const { tableForPath } = require('../sync/capture');
const { SYNCABLE_TABLES } = require('../sync/tables');

const paths = [
  '/api/parties', '/api/parties/12',
  '/api/detail-accounts', '/api/detail-accounts/categories', '/api/detail-accounts/5',
  '/api/units', '/api/units/3',
  '/api/product-categories', '/api/product-categories/2',
  '/api/warehouses/moves/receipt', '/api/warehouses/moves/transfer', '/api/warehouses',
  '/api/production/user-cost-centers', '/api/production/user-cost-centers/4', '/api/production/orders',
  '/api/reps/payments', '/api/reps/payments/9/approve', '/api/fixed-assets', '/api/customers',
];

const expected = {
  '/api/parties': 'parties',
  '/api/parties/12': 'parties',
  '/api/detail-accounts': 'detail_accounts',
  '/api/detail-accounts/categories': 'detail_categories',
  '/api/detail-accounts/5': 'detail_accounts',
  '/api/units': 'units_of_measure',
  '/api/units/3': 'units_of_measure',
  '/api/product-categories': 'product_categories',
  '/api/product-categories/2': 'product_categories',
  '/api/warehouses/moves/receipt': 'warehouse_moves',
  '/api/warehouses/moves/transfer': 'warehouse_moves',
  '/api/warehouses': 'warehouses',
  '/api/production/user-cost-centers': 'user_cost_centers',
  '/api/production/user-cost-centers/4': 'user_cost_centers',
  '/api/production/orders': 'production_orders',
  '/api/reps/payments': 'rep_payment_submissions',
  '/api/reps/payments/9/approve': 'rep_payment_submissions',
  '/api/fixed-assets': 'fixed_assets',
  '/api/customers': 'customers',
};

const results = [];
for (const p of paths) {
  const got = tableForPath(p);
  const want = expected[p];
  const ok = got === want;
  results.push({ path: p, got, want, ok });
  log(ok ? 'MAP_OK' : 'A', 'diag:tableForPath', ok ? 'map ok' : 'map mismatch', { path: p, got, want });
}

const need = [
  'fixed_assets',
  'fixed_asset_depreciation',
  'user_cost_centers',
  'rep_payment_submissions',
  'party_groups',
  'cheque_records',
];
const names = SYNCABLE_TABLES.map((t) => t.name);
for (const n of need) {
  const present = names.includes(n);
  log(
    present ? 'REG_OK' : 'D',
    'diag:registry',
    present ? 'table registered' : 'table missing from SYNCABLE',
    { table: n, index: names.indexOf(n), count: names.length }
  );
}

const client = fs.readFileSync(path.join(__dirname, '../sync/client.js'), 'utf8');
const hasOldDebug = client.includes('7550/ingest');
log(hasOldDebug ? 'E' : 'E_OK', 'diag:client.js', hasOldDebug ? 'old debug ingest present' : 'old debug ingest absent', {
  hasOldDebug,
});

const summary = {
  mismatches: results.filter((r) => !r.ok),
  registryMissing: need.filter((n) => !names.includes(n)),
  hasOldDebug,
  count: names.length,
};
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.mismatches.length || summary.registryMissing.length || summary.hasOldDebug ? 1 : 0);
