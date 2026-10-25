'use strict';
const { swAtLeast } = require('./lib/sw-at-least');
/**
 * Invoice stock warn-only + live fabric-roll picker (SW v203).
 * Run: node server/scripts/test-invoice-stock-warn-v203.js
 */
const fs = require('fs');
const path = require('path');

const testDb = path.join(__dirname, 'invoice-stock-warn-v203-test.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(testDb + suffix); } catch (_) {}
}
process.env.DB_PATH = testDb;
process.env.SYNC_ROLE = 'central';
process.env.SMS_DISABLED = '1';
process.env.ERP_TEST_ISOLATION = '1';
process.env.JWT_SECRET = 'invoice-stock-warn-v203-secret-32ch!!';

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

console.log('\n══ Invoice stock warn v203 ══\n');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const invoicesSrc = fs.readFileSync(path.join(__dirname, '../routes/invoices.js'), 'utf8');
const salesSrc = fs.readFileSync(path.join(__dirname, '../lib/sales-document.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(__dirname, '../public/app.css'), 'utf8');

ok(appJs.includes('function collectInvoiceStockWarnings'), 'UI جمع هشدار موجودی');
ok(appJs.includes('id="invStockWarn"'), 'نوار هشدار زنده در سبد');
ok(appJs.includes('ذخیره مسدود نیست'), 'متن هشدار بدون منع');
ok(/function invoiceNegativeStockWarn[\s\S]*return true;/.test(appJs)
  && !appJs.includes("confirm('با ثبت این فاکتور موجودی این کالاها منفی می‌شود"),
  'ذخیره دیگر confirm مسدودکننده ندارد');
ok(appJs.includes('id="ifr-live"') && appJs.includes('syncInvoiceFabricRollLive'), 'پنل مانده زنده طاقه');
ok(appJs.includes('refreshInvoiceFabricRollSelect') && appJs.includes('بروزرسانی مانده زنده'), 'تازه‌سازی مانده طاقه');
ok(appJs.includes('invoiceFabricSaleRolls()') && !/filter\(b=>b\.qty_available>0\)/.test(appJs.slice(appJs.indexOf('function invoiceFabricSaleRolls'), appJs.indexOf('function syncInvoiceFabricRollLive'))),
  'لیست طاقه مانده صفر را هم نشان می‌دهد');
ok(cssSrc.includes('.inv-stock-warn') && cssSrc.includes('.ifr-live-box'), 'استایل هشدار و پنل طاقه');
ok(invoicesSrc.includes('allowNegativeProduct: true'), 'ثبت/تبدیل فاکتور کالا را به‌خاطر کمبود مسدود نمی‌کند');
ok(salesSrc.includes('allowNegative: !isFabric'), 'کسر دائمی فروش کالا می‌تواند منفی شود');
ok(salesSrc.includes('allowNegativeProduct'), 'assertWarehouseLines گزینه هشدار-فقط کالا دارد');

let db = null;
try {
  delete require.cache[require.resolve('../db')];
  const { initDB, getDB } = require('../db');
  initDB();
  db = getDB();
} catch (e) {
  console.log('  SKIP sqlite DB tests:', e.message.split('\n')[0]);
}

if (db) {
  const { assertWarehouseLines, postSaleStockMovements } = require('../lib/sales-document');
  const { applyStockDelta } = require('../lib/inventory/ledger');

  function tableCols(name) {
    return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
  }
  const whCols = tableCols('warehouses');
  function insertWh(code, name, type) {
    const cols = ['name'];
    const vals = [name];
    if (whCols.has('code')) { cols.push('code'); vals.push(code); }
    if (whCols.has('warehouse_type')) { cols.push('warehouse_type'); vals.push(type); }
    if (whCols.has('active')) { cols.push('active'); vals.push(1); }
    if (whCols.has('allow_negative')) { cols.push('allow_negative'); vals.push(0); }
    const sql = `INSERT INTO warehouses (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
    return db.prepare(sql).run(...vals).lastInsertRowid;
  }
  const fgId = insertWh('FG-W', 'فروش تست', 'finished_goods');
  const rawId = insertWh('RAW-W', 'مواد تست', 'raw_material');

  const pCols = tableCols('products');
  const pFields = ['name'];
  const pVals = ['مانتو تست'];
  if (pCols.has('price')) { pFields.push('price'); pVals.push(100000); }
  if (pCols.has('cost')) { pFields.push('cost'); pVals.push(50000); }
  if (pCols.has('stock')) { pFields.push('stock'); pVals.push(1); }
  if (pCols.has('warehouse_id')) { pFields.push('warehouse_id'); pVals.push(fgId); }
  if (pCols.has('user_id')) { pFields.push('user_id'); pVals.push(1); }
  const prodId = db.prepare(`INSERT INTO products (${pFields.join(',')}) VALUES (${pFields.map(() => '?').join(',')})`).run(...pVals).lastInsertRowid;
  db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)').run(prodId, fgId, 1);
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('inventory_allow_negative','0')").run();

  let blocked = null;
  try {
    assertWarehouseLines(db, [{
      product_id: prodId, qty: 5, warehouse_id: fgId, name: 'مانتو تست',
    }], fgId, { requirePositive: true });
  } catch (e) { blocked = e; }
  ok(!!blocked && blocked.code === 'E_WH_INSUFFICIENT', 'بدون فلگ، کمبود کالا هنوز رد می‌شود', blocked && blocked.code);

  let allowed = null;
  try {
    assertWarehouseLines(db, [{
      product_id: prodId, qty: 5, warehouse_id: fgId, name: 'مانتو تست',
    }], fgId, { requirePositive: true, allowNegativeProduct: true });
  } catch (e) { allowed = e; }
  ok(!allowed, 'با allowNegativeProduct کمبود کالا رد نمی‌شود', allowed && allowed.message);

  const after = applyStockDelta(db, {
    productId: prodId, warehouseId: fgId, qtyDelta: -4, allowNegative: true,
  });
  ok(after.qtyAfter < 0, 'کسر فروش می‌تواند موجودی کالا را منفی کند', after.qtyAfter);

  const fabricFields = ['name'];
  const fabricVals = ['پارچه تست'];
  if (pCols.has('stock')) { fabricFields.push('stock'); fabricVals.push(0); }
  if (pCols.has('user_id')) { fabricFields.push('user_id'); fabricVals.push(1); }
  const fabricPid = db.prepare(`INSERT INTO products (${fabricFields.join(',')}) VALUES (${fabricFields.map(() => '?').join(',')})`).run(...fabricVals).lastInsertRowid;
  const bCols = tableCols('inventory_batches');
  const bFields = ['batch_no', 'product_id', 'qty_on_hand'];
  const bVals = ['R-203', fabricPid, 10];
  if (bCols.has('warehouse_id')) { bFields.push('warehouse_id'); bVals.push(rawId); }
  if (bCols.has('kind')) { bFields.push('kind'); bVals.push('fabric'); }
  if (bCols.has('qty_received')) { bFields.push('qty_received'); bVals.push(10); }
  if (bCols.has('status')) { bFields.push('status'); bVals.push('active'); }
  const batchId = db.prepare(`INSERT INTO inventory_batches (${bFields.join(',')}) VALUES (${bFields.map(() => '?').join(',')})`).run(...bVals).lastInsertRowid;
  db.prepare(`
    INSERT INTO inventory_ledger (tx_no, event_type, product_id, warehouse_id, qty_in, qty_out, qty_balance,
      unit_cost_rial, amount_rial, avg_cost_after_rial, batch_id, source_type, status, date, note)
    VALUES ('T-203', 'receipt', ?, ?, 10, 0, 10, 0, 0, 0, ?, 'opening', 'posted', '', 'seed')
  `).run(fabricPid, rawId, batchId);

  let fabricShort = null;
  try {
    assertWarehouseLines(db, [{
      product_id: fabricPid, qty: 40, warehouse_id: rawId, batch_id: batchId, is_fabric_roll: 1, name: 'پارچه تست',
    }], fgId, { requirePositive: true, allowNegativeProduct: true });
  } catch (e) { fabricShort = e; }
  ok(!!fabricShort && fabricShort.code === 'E_FABRIC_QTY', 'طاقه بیش از مانده زنده همچنان رد می‌شود', fabricShort && fabricShort.code);

  ok(typeof postSaleStockMovements === 'function', 'postSaleStockMovements در دسترس است');
}

try {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  ok(html.includes('app.js?v=203') && html.includes('app.css?v=203'), 'کش فرانت v203');
  const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  ok(swAtLeast(sw, 203), 'SW v203');
} catch (e) {
  ok(false, 'نسخه فرانت', e.message);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
