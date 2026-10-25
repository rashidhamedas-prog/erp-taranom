const { swAtLeast } = require('./lib/sw-at-least');
/**
 * Static regression guards for warehouse audit Wave-1 (v305).
 * Run: node server/scripts/test-warehouse-audit-v305.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed += 1;
  console.log('  ✓', msg);
}

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const whDocs = read('lib/warehouse-docs.js');
const invoices = read('routes/invoices.js');
const sales = read('lib/sales-document.js');
const lc = read('lib/inventory/landed-cost.js');
const invRoutes = read('routes/inventory.js');
const consign = read('lib/consignments.js');
const orders = read('routes/orders.js');
const rsv = read('lib/inventory/reservation.js');
const cycle = read('lib/inventory/cycle-count.js');
const batch = read('lib/inventory/batch-serial.js');
const fabric = read('lib/inventory/fabric-rolls.js');
const whRoutes = read('routes/warehouses.js');
const voidMove = read('lib/void-warehouse-move.js');
const appJs = read('public/app.js');
const sw = read('public/sw.js');

console.log('warehouse audit v305 static checks');

// WH-01/02 periodic
ok(whDocs.includes('isPeriodicWarehouse'), 'warehouse-docs skips JE for periodic WH');
ok(invoices.includes('defer COGS to period-close') || !invoices.includes('postCogsVoucher(db, invId, num, entryDate'),
  'invoice create does not postCogsVoucher on periodic branch');
ok(!invoices.includes('postCogsVoucher(db, inv.id, inv.num, inv.date, rows'),
  'convert path does not postCogsVoucher on periodic branch');

// WH-03/04 transfer reclass + typed inventory acct
ok(whDocs.includes('warehouse_transfer_batch'), 'transfer reclass JE source');
ok(whDocs.includes('inventoryAccountForWarehouse'), 'receipt/issue use typed inventory COA');

// WH-05 allow_negative
ok(whDocs.includes('allowNegative(db, fromWh)'), 'issue/transfer respect allow_negative');

// WH-06/07 report
ok(whRoutes.includes('buildWarehouseStockRows'), 'pure warehouse_stock report helper');
ok(whRoutes.includes('FROM warehouse_stock ws'), 'report query starts from warehouse_stock');
ok(whRoutes.includes('unitCostRialOf'), 'valuation from average_cost_rial');
ok(whRoutes.includes("UPDATE warehouses SET is_default=0"), 'unique default warehouse');

// Landed cost
ok(lc.includes('function voidLandedCost'), 'landed cost R13 void');
ok(lc.includes('E_LC_NO_STOCK'), 'reject capitalize with zero stock');
ok(lc.includes('bumpOpenLayersValue'), 'value bump without phantom qty layer');
ok(invRoutes.includes("/landed-cost/:id/void"), 'void route mounted');
ok(appJs.includes('invLandedVoid'), 'UI void for landed cost');

// Consignment IN sale + shortage cost
ok(consign.includes('buy-then-sell') || consign.includes('خرید از امانت‌گذار پیش از فروش'),
  'IN sale posts purchase before revenue');
ok(consign.includes('postSaleStockMovements'), 'IN sale deducts stock after purchase receipt');
ok(consign.includes("row.direction === 'out'") && consign.includes('inventoryCostRial(product, row.qty)'),
  'OUT shortage uses inventory cost');

// Reservations
ok(rsv.includes('consumeOpenReservationsForSale'), 'consume soft-lock on sale');
ok(rsv.includes('releaseBySource'), 'release by source helper');
ok(sales.includes('consumeOpenReservationsForSale'), 'sale path consumes reservations');
ok(sales.includes("require('./inventory/reservation')"), 'reservedQty uses canonical open qty');
ok(orders.includes("nextStatus === 'cancel'"), 'order cancel releases reservation');
ok(orders.includes('maybeDeductStock() { /* no-op'), 'legacy order stock deduct disabled');

// Stocktaking race
ok(cycle.includes("SET status='adjusted'") && cycle.includes('E_STK_ALREADY'),
  'cycle count claims adjusted inside TX');
ok(cycle.includes('assertJournalIdempotent'), 'stocktaking JE idempotent');
ok(cycle.includes('E_STK_ZERO_COST'), 'reject zero-cost variance');

// Batch / fabric
ok(batch.includes('E_BATCH_QTY_VIA_RECEIPT'), 'generic batch create cannot invent qty');
ok(batch.includes("!='fabric'"), 'generic batch list excludes fabric');
ok(sales.includes('adjustBatchQty'), 'generic lot sale adjusts batch qty');
ok(whDocs.includes('touchBatchQty') || whDocs.includes('adjustBatchQty'), 'WH docs adjust batch qty');
ok(fabric.includes('runByBatch'), 'fabric kardex running meters per roll');
ok(voidMove.includes('reverseBatchSideEffects'), 'void restores batch qty');

// Help + SW
ok(appJs.includes('warehouse-report'), 'warehouse-report in ACC_NOFILTER_TABS');
ok(appJs.includes('Landed Cost') || appJs.includes('هزینه حمل (Landed Cost)'), 'help mentions landed cost');
ok(swAtLeast(sw, 305), 'SW bumped to v305');

try {
  // eslint-disable-next-line no-new-func
  new Function(appJs);
  ok(true, 'app.js parses with new Function');
} catch (e) {
  ok(false, 'app.js parse: ' + e.message);
}

for (const rel of [
  'lib/warehouse-docs.js', 'lib/inventory/landed-cost.js', 'lib/consignments.js',
  'routes/warehouses.js', 'routes/invoices.js', 'routes/orders.js',
]) {
  try {
    require('child_process').execFileSync(process.execPath, ['--check', path.join(root, rel)], { stdio: 'pipe' });
    ok(true, `syntax ${rel}`);
  } catch (e) {
    ok(false, `syntax ${rel}: ${e.stderr || e.message}`);
  }
}

console.log(`\n${passed} checks passed`);
