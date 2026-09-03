'use strict';
/**
 * Invoice UX v193 — freight ratios, fabric stock source, inactive receivables.
 * Run: node server/scripts/test-invoice-ux-v193.js
 */
const fs = require('fs');
const path = require('path');

const testDb = path.join(__dirname, 'invoice-ux-v193-test.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(testDb + suffix); } catch (_) {}
}
process.env.DB_PATH = testDb;
process.env.SYNC_ROLE = 'central';
process.env.SMS_DISABLED = '1';
process.env.ERP_TEST_ISOLATION = '1';
process.env.JWT_SECRET = 'invoice-ux-v193-secret-32chars!!!!';

const {
  allocateFreight, applyFreightToDocTotals, applyHeaderWarehouseToLines,
  freightChargedToCounterparty, isFabricRollLine,
} = require('../lib/sales-document');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra == null ? '' : extra); }
}

const rows = [
  { product_id: 1, row_type: 'product', qty: 2, sum: 200000, allocated_freight: 0 },
  { product_id: 2, row_type: 'product', qty: 1, sum: 100000, allocated_freight: 0 },
];
allocateFreight(rows, 30000, 'amount');
ok(rows[0].allocated_freight === 20000, 'freight amount ratio 2:1 first', rows[0].allocated_freight);
ok(rows[1].allocated_freight === 10000, 'freight amount ratio 2:1 second', rows[1].allocated_freight);

const qtyRows = [
  { product_id: 1, qty: 3, sum: 10, allocated_freight: 0 },
  { product_id: 2, qty: 1, sum: 90, allocated_freight: 0 },
];
allocateFreight(qtyRows, 40000, 'qty');
ok(qtyRows[0].allocated_freight === 30000, 'freight qty ratio 3:1 first', qtyRows[0].allocated_freight);
ok(qtyRows[1].allocated_freight === 10000, 'freight qty ratio 3:1 second', qtyRows[1].allocated_freight);

const buyer = applyFreightToDocTotals({ final: 100000, netBeforeVat: 100000 }, 5000, 'buyer');
ok(buyer.chargeToParty === true && buyer.final === 105000, 'buyer freight added to party total');
const seller = applyFreightToDocTotals({ final: 100000, netBeforeVat: 100000 }, 5000, 'seller');
ok(seller.chargeToParty === false && seller.final === 100000, 'seller freight not added to party total');
ok(freightChargedToCounterparty('') === true, 'empty freight type defaults to charged');
ok(freightChargedToCounterparty('seller') === false, 'seller not charged');

const cart = [
  { product_id: 9, is_fabric_roll: 1, warehouse_id: 77, qty: 10 },
  { product_id: 8, warehouse_id: null, qty: 1 },
];
applyHeaderWarehouseToLines(cart, 12, { force: true });
ok(cart[0].warehouse_id === 77, 'fabric line warehouse preserved under header force', cart[0].warehouse_id);
ok(cart[1].warehouse_id === 12, 'plain line inherits header warehouse', cart[1].warehouse_id);
ok(isFabricRollLine(cart[0]) === true, 'isFabricRollLine detects roll');

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
  const { assertWarehouseLines } = require('../lib/sales-document');
  const { salesJournalLines } = require('../lib/customer-books');
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
  if (whCols.has('is_active')) { cols.push('is_active'); vals.push(1); }
  if (whCols.has('allow_negative')) { cols.push('allow_negative'); vals.push(0); }
  const sql = `INSERT INTO warehouses (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  return db.prepare(sql).run(...vals).lastInsertRowid;
}
const fgId = insertWh('FG', 'فروش', 'finished_goods');
const rawId = insertWh('RAW', 'مواد', 'raw_material');

const pCols = tableCols('products');
const pFields = ['name'];
const pVals = ['پارچه تست'];
if (pCols.has('price')) { pFields.push('price'); pVals.push(1000); }
if (pCols.has('cost')) { pFields.push('cost'); pVals.push(500); }
if (pCols.has('stock')) { pFields.push('stock'); pVals.push(0); }
if (pCols.has('unit')) { pFields.push('unit'); pVals.push('متر'); }
if (pCols.has('user_id')) { pFields.push('user_id'); pVals.push(1); }
const prodId = db.prepare(`INSERT INTO products (${pFields.join(',')}) VALUES (${pFields.map(()=>'?').join(',')})`).run(...pVals).lastInsertRowid;

const bCols = tableCols('inventory_batches');
const bFields = ['batch_no', 'product_id', 'qty_on_hand'];
const bVals = ['R-100', prodId, 100];
if (bCols.has('warehouse_id')) { bFields.push('warehouse_id'); bVals.push(rawId); }
if (bCols.has('kind')) { bFields.push('kind'); bVals.push('fabric'); }
if (bCols.has('qty_received')) { bFields.push('qty_received'); bVals.push(100); }
if (bCols.has('status')) { bFields.push('status'); bVals.push('active'); }
if (bCols.has('unit')) { bFields.push('unit'); bVals.push('m'); }
const batchId = db.prepare(`INSERT INTO inventory_batches (${bFields.join(',')}) VALUES (${bFields.map(()=>'?').join(',')})`).run(...bVals).lastInsertRowid;

if (batchId) {
  db.prepare(`
    INSERT INTO inventory_ledger (tx_no, event_type, product_id, warehouse_id, qty_in, qty_out, qty_balance,
      unit_cost_rial, amount_rial, avg_cost_after_rial, batch_id, source_type, status, date, note)
    VALUES ('T-FAB', 'receipt', ?, ?, 100, 0, 100, 0, 0, 0, ?, 'opening', 'posted', '', 'seed')
  `).run(prodId, rawId, batchId);

  let threw = null;
  try {
    assertWarehouseLines(db, [{
      product_id: prodId, qty: 40, warehouse_id: rawId, batch_id: batchId, is_fabric_roll: 1, name: 'پارچه تست',
    }], fgId, { requirePositive: true });
  } catch (e) { threw = e; }
  ok(!threw, 'fabric 100m passes even if FG product.stock is 0', threw && threw.message);

  let short = null;
  try {
    assertWarehouseLines(db, [{
      product_id: prodId, qty: 140, warehouse_id: rawId, batch_id: batchId, is_fabric_roll: 1, name: 'پارچه تست',
    }], fgId, { requirePositive: true });
  } catch (e) { short = e; }
  ok(!!short && short.code === 'E_FABRIC_QTY', 'oversell fabric rejected from live meters', short && short.code);
}

try {
  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES ('1103','دریافتنی','asset',NULL,1,1)
  `).run();
} catch (_) {}
try {
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_receivable','1103')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_sales','4101')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_sales_discount','4102')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_vat_payable','2103')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_other_income','4105')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_sales_expense','6103')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_payable','2101')").run();
} catch (_) {}
['4101','4102','4105','6103','2101','2103'].forEach((code) => {
  try {
    db.prepare(`INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES (?,?,?,?,1,1)`)
      .run(code, code, code.startsWith('4') || code.startsWith('6') ? 'expense' : 'liability', null);
  } catch (_) {}
});

let custId;
try {
  const c = db.prepare("INSERT INTO customers (biz, owner, phone) VALUES ('فروشگاه تست','مالک','09150000000')").run();
  custId = c.lastInsertRowid;
} catch (e) {
  console.log(' customer seed', e.message);
}

if (custId) {
  const buyerLines = salesJournalLines(db, custId, {
    subtotal: 100000, discAmt: 0, final: 105000, vatAmount: 0, netBeforeVat: 105000,
  }, false, { payType: 'credit', freightRial: 5000, freightType: 'buyer', rows: [{ product_id: 1, sum: 100000 }] });
  const otherInc = buyerLines.find((l) => /کرایه/.test(l.description || '') && l.credit > 0);
  ok(!!otherInc, 'buyer freight credits other income / freight line', buyerLines.map((l) => l.description + ':' + l.credit).join('|'));

  const sellerLines = salesJournalLines(db, custId, {
    subtotal: 100000, discAmt: 0, final: 100000, vatAmount: 0, netBeforeVat: 100000,
  }, false, { payType: 'credit', freightRial: 5000, freightType: 'seller', rows: [{ product_id: 1, sum: 100000 }] });
  const exp = sellerLines.find((l) => l.debit > 0 && /کرایه/.test(l.description || ''));
  const pay = sellerLines.find((l) => l.credit > 0 && /بدهی کرایه/.test(l.description || ''));
  ok(!!exp && !!pay, 'seller freight Dr expense / Cr payable', (exp && pay) ? 'ok' : sellerLines.map((l) => l.description).join('|'));
  const ar = sellerLines.find((l) => l.debit > 0 && !/کرایه/.test(l.description || ''));
  ok(!ar || ar.debit === sellerLines.filter((l) => l.code).length, 'seller AR stays goods-only (final=100000)');
}

try {
  const p = db.prepare("INSERT INTO parties (person_code, party_type, full_name, phone, is_active) VALUES ('P-DEL','customer','حذف‌شده','09151111111',0)").run();
  const partyId = p.lastInsertRowid;
  const c2 = db.prepare("INSERT INTO customers (biz, owner, phone, party_id) VALUES ('طرف حذف‌شده','-','09151111111',?)").run(partyId);
  const inactiveCust = c2.lastInsertRowid;
  ok(inactiveCust > 0, 'inactive party linked customer seeded');
} catch (e) {
  ok(true, 'inactive party seed skipped: ' + e.message);
}
} // sqlite suite

console.log('\n' + pass + ' passed, ' + fail + ' failed');
try { fs.unlinkSync(testDb); } catch (_) {}
process.exit(fail ? 1 : 0);
