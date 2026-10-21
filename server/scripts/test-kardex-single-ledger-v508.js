'use strict';
/**
 * v508 — one stock ledger: kardex = every posted physical movement; WIP stage,
 * value-only and void rows out; no audit toggle; short invoice wording;
 * heal of netting «هم‌ترازی» pairs and short multi-colour amend ledger + COGS.
 * Run: node server/scripts/test-kardex-single-ledger-v508.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kardex-v508-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.JWT_SECRET = 'test-kardex-v508-secret-32chars!!!!';
process.env.SYNC_ROLE = 'central';
process.env.PORT = '0';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; console.log('  ✓', msg); }
  else { failed += 1; console.log('  ✗', msg); }
}

console.log('\n══ Kardex single ledger v508 ══\n');

const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(!appSrc.includes('kardexShowCanc'), 'kardex audit toggle removed');
ok(!appSrc.includes('frk-audit'), 'fabric turnover audit toggle removed');
ok(!appSrc.includes('نمایش ابطال و هم‌ترازی'), 'no «نمایش ابطال و هم‌ترازی» label');
ok(appSrc.includes('book_gap_qty'), 'UI shows ledger vs warehouse gap');

let getDB, initDB;
try {
  ({ getDB, initDB } = require('../db'));
  initDB();
} catch (e) {
  console.log('  ⚠ sqlite ABI unavailable locally — static checks only:', e.message.split('\n')[0]);
  console.log(`\n══ Result: ${passed} passed, ${failed} failed (DB skipped) ══\n`);
  process.exit(failed ? 1 : 0);
}
const db = getDB();
const adminId = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get()?.id || 1;
const whCols = db.prepare('PRAGMA table_info(warehouses)').all().map((c) => c.name);
const whA = db.prepare("INSERT INTO warehouses (name, active) VALUES ('WH-A-508',1)").run().lastInsertRowid;
const whW = db.prepare("INSERT INTO warehouses (name, active) VALUES ('WH-WIP-508',1)").run().lastInsertRowid;
if (whCols.includes('kind')) db.prepare("UPDATE warehouses SET kind='wip' WHERE id=?").run(whW);
if (whCols.includes('warehouse_type')) db.prepare("UPDATE warehouses SET warehouse_type='wip' WHERE id=?").run(whW);

const pid = db.prepare(
  "INSERT INTO products (name, code, unit, stock, warehouse_id, average_cost_rial, user_id) VALUES ('Coat','C508','عدد',0,?,1000,?)"
).run(whA, adminId).lastInsertRowid;
db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,0)').run(pid, whA);

const { postInventoryMovement } = require('../lib/inventory/ledger');
const { buildStockLedger } = require('../lib/ledgers');
const heal = require('../lib/kardex-heal-v508');

const mv = (o) => postInventoryMovement(db, { createdBy: adminId, updateAvg: false, allowNegative: true, ...o });
mv({ eventType: 'production_receipt', productId: pid, warehouseId: whA, qty: 10, unitCostRial: 1000,
  sourceType: 'production_receipt', sourceId: 1, date: '1405/07/05', note: 'تولید PO-0508' });
mv({ eventType: 'cutting_pack', productId: pid, warehouseId: whW, qty: 10, unitCostRial: 1000,
  sourceType: 'cutting_pack', sourceId: 1, date: '1405/07/04', note: 'بسته برش (WIP) PK-0508', warehouseOnly: true });
mv({ eventType: 'cutting_pack', productId: pid, warehouseId: whW, qtyOut: 10, unitCostRial: 1000,
  sourceType: 'cutting_pack', sourceId: 1, date: '1405/07/05', note: 'تخلیه WIP بسته برش', warehouseOnly: true });
mv({ eventType: 'production_receipt', productId: pid, warehouseId: whA, qty: 0, amountRial: -500, valueOnly: true,
  sourceType: 'cutting_lay_fg_delta', sourceId: 1, date: '1405/07/05', note: 'تعدیل بهای لایه‌چینی LAY-0508' });
// Netting align pair (seed +3 / reconcile −3) and one unpaired reconcile −1.
mv({ eventType: 'opening', productId: pid, warehouseId: whA, qty: 3, unitCostRial: 1000,
  sourceType: 'opening_inventory', sourceId: pid, date: '1405/06/31', note: 'موجودی اول دوره', skipStock: true });
mv({ eventType: 'adjustment', productId: pid, warehouseId: whA, qty: -3, unitCostRial: 1000,
  sourceType: 'stock_reconcile', sourceId: pid, date: '1405/07/06', note: 'هم‌ترازی کاردکس با موجودی انبار', skipStock: true });
mv({ eventType: 'adjustment', productId: pid, warehouseId: whA, qty: -1, unitCostRial: 1000,
  sourceType: 'stock_reconcile', sourceId: pid, date: '1405/07/07', note: 'هم‌ترازی کاردکس با موجودی انبار', skipStock: true });

// Pre-v508 amend defect: invoice 2+2 but ledger kept only 2.
const custId = db.prepare(
  "INSERT INTO customers (user_id, biz, owner, phone, status) VALUES (?, 'C508', 'T', '09000000508', 'active')"
).run(adminId).lastInsertRowid;
const invId = db.prepare(`
  INSERT INTO invoices (user_id, cust_id, num, type, date, rows, final, warehouse_id, stock_deducted, status)
  VALUES (?, ?, 'T-V508', 'normal', '1405/07/08', ?, 0, ?, 1, 'posted')
`).run(adminId, custId, JSON.stringify([
  { product_id: pid, qty: 2, color_name: 'مشکی', size_name: '1' },
  { product_id: pid, qty: 2, color_name: 'نقره‌ای', size_name: '1' },
]), whA).lastInsertRowid;
mv({ eventType: 'sale', productId: pid, warehouseId: whA, qtyOut: 2, unitCostRial: 1000,
  sourceType: 'invoice', sourceId: invId, date: '1405/07/08', note: 'فروش فاکتور معمولی T-V508 (مشکی/نقره‌ای سایز 1)' });
const { postToLedger } = require('../lib/ledger');
const { acct } = require('../lib/coa-map');
const cogsAcct = acct(db, 'coa_cogs');
const fgAcct = require('../lib/inventory/ledger').inventoryAccountForWarehouse(db, whA);
postToLedger(db, {
  sourceType: 'invoice_cogs', sourceId: invId, date: '1405/07/08', description: 'بهای تمام‌شده فاکتور T-V508',
  createdBy: adminId, lines: [
    { code: cogsAcct.code, name: cogsAcct.name, debit: 200, credit: 0 },
    { code: fgAcct.code, name: fgAcct.name, debit: 0, credit: 200 },
  ],
});
// Physical card: 10 produced − 4 sold − 1 adjusted = 5.
db.prepare('UPDATE warehouse_stock SET qty=5 WHERE product_id=? AND warehouse_id=?').run(pid, whA);

const before = buildStockLedger(db, { product_id: pid });
const descs = before.lines.map((l) => String(l.description || ''));
ok(!before.lines.some((l) => Number(l.warehouse_id) === Number(whW)), 'no WIP-warehouse rows in kardex');
ok(!descs.some((d) => d.includes('WIP') || d.includes('بسته برش')), 'no cutting-pack WIP rows');
ok(!before.lines.some((l) => !(Number(l.qty_in) || 0) && !(Number(l.qty_out) || 0)), 'no qty-0 value-only rows');
ok(!descs.some((d) => d.includes('هم‌ترازی')), 'no «هم‌ترازی» wording');
ok(descs.filter((d) => d === 'تعدیل موجودی').length === 2, 'reconcile rows shown as «تعدیل موجودی»');
ok(!('show_audit' in before) && !('show_cancelled' in before), 'payload has no audit toggle');
const inv0 = before.lines.find((l) => String(l.source_type) === 'invoice');
ok(inv0 && inv0.description === 'فروش T-V508', 'invoice description is short: ' + (inv0 && inv0.description));
const sumNet = before.lines.reduce((s, l) => s + (Number(l.qty_in) || 0) - (Number(l.qty_out) || 0), 0);
ok(Math.abs(before.closing_qty - sumNet) < 1e-6, 'closing equals the visible rows (no hidden rows) ' + before.closing_qty);
ok(before.closing_qty === 7, 'closing before heal = 10+3−3−1−2 = 7');
ok(before.book_gap_qty === 2, 'gap vs warehouse reported honestly (7−5=2)');

const dry = heal.healKardexSingleLedger(db, { apply: false });
ok(dry.align_pairs === 1, 'dry-run finds one netting pair');
ok(dry.invoice_lines === 1 && dry.invoice_qty === 2, 'dry-run finds 2 missing invoice qty');

// Boot already sealed the flag on the empty DB — force like an operator re-run.
const res = heal.healKardexSingleLedger(db, { apply: true, force: true });
ok(res.align_pairs === 1 && res.invoice_lines === 1, 'heal applied');
ok(res.cogs_vouchers === 1, 'COGS correction voucher posted');
const fixJe = db.prepare("SELECT id FROM journal_entries WHERE ref_type='invoice_cogs_fix' AND ref_id=?").get(invId);
ok(!!fixJe, 'invoice_cogs_fix voucher exists');
if (fixJe) {
  const bal = db.prepare('SELECT SUM(debit) d, SUM(credit) c FROM journal_lines WHERE entry_id=?').get(fixJe.id);
  ok(Math.abs((bal.d || 0) - (bal.c || 0)) < 1e-6 && bal.d > 0, 'correction voucher is balanced');
}
const invLed = db.prepare(`
  SELECT SUM(qty_out - qty_in) q FROM inventory_ledger WHERE source_type='invoice' AND source_id=? AND status='posted'
`).get(invId).q;
ok(invLed === 4, 'invoice ledger qty now equals document (4)');

const after = buildStockLedger(db, { product_id: pid });
ok(after.closing_qty === 5, 'closing after heal = 5 = warehouse card');
ok(after.book_gap_qty === 0, 'no ledger/warehouse gap after heal');
const inv1 = after.lines.find((l) => String(l.source_type) === 'invoice');
ok(inv1 && Number(inv1.qty_out) === 4 && inv1.description === 'فروش T-V508', 'invoice row 4 out, short label');
ok(after.lines.filter((l) => l.description === 'تعدیل موجودی').length === 1, 'only the real adjustment remains');

const again = heal.healKardexSingleLedger(db, { apply: true, force: true });
ok(again.align_pairs === 0 && again.invoice_lines === 0, 'heal is idempotent');
const once = heal.healKardexSingleLedger(db, { apply: true });
ok(once.skipped === true, 'boot heal runs once (settings flag)');

// Root cause: multi-colour amend must keep the summed qty in the ledger.
const { replaceSaleStockInPlace } = require('../lib/amend-invoice');
const pid2 = db.prepare(
  "INSERT INTO products (name, code, unit, stock, warehouse_id, average_cost_rial, user_id) VALUES ('Vest','V508','عدد',20,?,1000,?)"
).run(whA, adminId).lastInsertRowid;
db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,20)').run(pid2, whA);
const oldRows = [
  { product_id: pid2, qty: 2, variant_id: 9001 },
  { product_id: pid2, qty: 2, variant_id: 9002 },
];
const inv2 = db.prepare(`
  INSERT INTO invoices (user_id, cust_id, num, type, date, rows, final, warehouse_id, stock_deducted, status)
  VALUES (?, ?, 'T-V508B', 'normal', '1405/07/09', ?, 0, ?, 1, 'posted')
`).run(adminId, custId, JSON.stringify(oldRows), whA).lastInsertRowid;
for (const r of oldRows) {
  mv({ eventType: 'sale', productId: pid2, warehouseId: whA, qtyOut: r.qty, unitCostRial: 1000,
    sourceType: 'invoice', sourceId: inv2, date: '1405/07/09', note: 'فروش T-V508B' });
}
const row2 = db.prepare('SELECT * FROM invoices WHERE id=?').get(inv2);
db.transaction(() => {
  replaceSaleStockInPlace(db, {
    row: row2,
    newRows: [
      { product_id: pid2, qty: 3, variant_id: 9001 },
      { product_id: pid2, qty: 2, variant_id: 9002 },
    ],
    headerWh: whA, userId: adminId, date: '1405/07/09', num: 'T-V508B',
  });
})();
const led2 = db.prepare(`
  SELECT SUM(qty_out - qty_in) q FROM inventory_ledger WHERE source_type='invoice' AND source_id=? AND status='posted'
`).get(inv2).q;
ok(led2 === 5, 'amend keeps summed multi-colour qty in ledger (5) got=' + led2);
const ws2 = db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(pid2, whA).qty;
ok(ws2 === 15, 'warehouse moved by the extra unit only (16→15 from 20−4) got=' + ws2);

// Yalda pattern: a bogus align opening (+10) duplicates production; align
// reconciles (−4) chase a wrong warehouse card (3). Variant book (8) and the
// ledger's document rows (10 − 2 = 8) agree → align rows reversed, card fixed.
const pid3 = db.prepare(
  "INSERT INTO products (name, code, unit, stock, warehouse_id, average_cost_rial, user_id) VALUES ('Yalda','Y508','عدد',3,?,1000,?)"
).run(whA, adminId).lastInsertRowid;
db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,3)').run(pid3, whA);
const v3 = db.prepare('INSERT INTO product_variants (product_id, sku) VALUES (?,?)').run(pid3, 'Y508-1').lastInsertRowid;
db.prepare('INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,8)').run(v3, whA);
mv({ eventType: 'opening', productId: pid3, warehouseId: whA, qty: 10, unitCostRial: 1000,
  sourceType: 'opening_inventory', sourceId: pid3, date: '1405/06/31', note: 'موجودی اول دوره', skipStock: true });
mv({ eventType: 'production_receipt', productId: pid3, warehouseId: whA, qty: 10, unitCostRial: 1000,
  sourceType: 'production_receipt', sourceId: 3, date: '1405/07/05', note: 'تولید PO-Y508', skipStock: true });
mv({ eventType: 'sale', productId: pid3, warehouseId: whA, qtyOut: 2, unitCostRial: 1000,
  sourceType: 'invoice', sourceId: 999, date: '1405/07/06', note: 'فروش T-Y508', skipStock: true });
mv({ eventType: 'adjustment', productId: pid3, warehouseId: whA, qty: -4, unitCostRial: 1000,
  sourceType: 'stock_reconcile', sourceId: pid3, date: '1405/07/07', note: 'هم‌ترازی کاردکس با موجودی انبار', skipStock: true });
mv({ eventType: 'adjustment', productId: pid3, warehouseId: whA, qty: -11, unitCostRial: 1000,
  sourceType: 'stock_reconcile', sourceId: pid3, date: '1405/07/08', note: 'هم‌ترازی کاردکس با موجودی انبار', skipStock: true });
const y0 = buildStockLedger(db, { product_id: pid3 });
ok(y0.closing_qty === 3 && y0.book_gap_qty === 0, 'Yalda before: ledger chased the wrong card (3)');
const agreeDry = heal.healAgreedBooks(db, { apply: false });
// gap 0 here, so force the wrong card to differ from the ledger like production did
db.prepare('UPDATE warehouse_stock SET qty=2 WHERE product_id=? AND warehouse_id=?').run(pid3, whA);
const agreeDry2 = heal.healAgreedBooks(db, { apply: false });
ok(agreeDry.items === 0 && agreeDry2.items === 1 && agreeDry2.align_rows === 3,
  'agreed-books heal targets only drifted items with variant agreement');
const ag = heal.healAgreedBooks(db, { apply: true, force: true });
ok(ag.items === 1 && ag.align_rows === 3, 'agreed-books heal applied');
const y1 = buildStockLedger(db, { product_id: pid3 });
ok(y1.closing_qty === 8, 'Yalda after: kardex = documents = variant book (8) got=' + y1.closing_qty);
ok(y1.book_gap_qty === 0, 'Yalda after: no gap with warehouse card');
ok(!y1.lines.some((l) => l.is_opening || l.description === 'تعدیل موجودی'), 'bogus opening + align rows gone');
const ws3 = db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(pid3, whA).qty;
ok(ws3 === 8, 'warehouse card corrected to 8');
ok(heal.healAgreedBooks(db, { apply: true, force: true }).items === 0, 'agreed-books heal idempotent');

console.log(`\n══ Result: ${passed} passed, ${failed} failed ══\n`);
process.exit(failed ? 1 : 0);
