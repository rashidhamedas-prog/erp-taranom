'use strict';
/**
 * amend-invoice.replaceSaleStockInPlace — ledger is APPEND-ONLY for quantity.
 * A qty change is a reversal movement + a fresh posting (variant-stamped, same unit cost) inside the
 * caller's transaction; an existing posted row's qty/amount is never edited in place.
 * Run: node server/scripts/test-amend-invoice-append-only.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amend-append-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'test-amend-append-only-secret-32chars!!!!';
process.env.AUTH_SESSION_DB_PATH = path.join(tmp, 'sessions.db');
process.env.NODE_ENV = 'test';

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : JSON.stringify(extra)); }
}

const { getDB, initDB } = require('../db');
initDB();
const db = getDB();
const { postInventoryMovement } = require('../lib/inventory/ledger');
const { replaceSaleStockInPlace } = require('../lib/amend-invoice');
const { seedStock, qtyOf } = require('./lib/stock-fixture');

console.log('\n══ amend-invoice: append-only ledger ══\n');

const adminId = Number(db.prepare("INSERT INTO users (name, username, password, role, active, must_change_password) VALUES ('مدیر','aao_admin','x','admin',1,0)").run().lastInsertRowid);
const wh = Number(db.prepare("INSERT INTO warehouses (name, code, active, allow_negative, warehouse_type, inventory_system) VALUES ('FG','AAO-FG',1,0,'finished_goods','perpetual')").run().lastInsertRowid);
const pid = Number(db.prepare(
  "INSERT INTO products (user_id, name, code, unit, stock, warehouse_id, price, cost, average_cost_rial) VALUES (?,?,?,?,0,?,5000,1000,1000)"
).run(adminId, 'کت', 'AAO-1', 'عدد', wh).lastInsertRowid);
const col = Number(db.prepare("INSERT INTO product_colors (name, code, active) VALUES ('مشکی','AAOB',1)").run().lastInsertRowid);
const sz1 = Number(db.prepare("INSERT INTO product_sizes (name, code, active) VALUES ('M','AAOM',1)").run().lastInsertRowid);
const sz2 = Number(db.prepare("INSERT INTO product_sizes (name, code, active) VALUES ('L','AAOL',1)").run().lastInsertRowid);
const mkV = (size, sku) => Number(db.prepare(
  'INSERT INTO product_variants (product_id, color_id, size_id, sku, stock, active, is_default) VALUES (?,?,?,?,0,1,0)'
).run(pid, col, size, sku).lastInsertRowid);
const v1 = mkV(sz1, 'AAO-M');
const v2 = mkV(sz2, 'AAO-L');
seedStock(db, { productId: pid, variantId: v1, warehouseId: wh, qty: 20, unitCostRial: 1000 });
seedStock(db, { productId: pid, variantId: v2, warehouseId: wh, qty: 20, unitCostRial: 1000 });

const INV = 7701;
const sale = (variantId, qty) => postInventoryMovement(db, {
  eventType: 'sale', productId: pid, warehouseId: wh, qtyOut: qty, variantId,
  sourceType: 'invoice', sourceId: INV, date: '1405/07/09', note: 'فروش T-AAO', updateAvg: false, allowNegative: true,
});
sale(v1, 2); sale(v2, 2);
const row = { id: INV, warehouse_id: wh, rows: JSON.stringify([
  { product_id: pid, qty: 2, variant_id: v1 },
  { product_id: pid, qty: 2, variant_id: v2 },
]) };
ok(qtyOf(db, { productId: pid, warehouseId: wh }) === 36, 'before amend: 40 − 4 = 36');
const before = db.prepare("SELECT id, qty_out, amount_rial, status, variant_id, unit_cost_rial FROM inventory_ledger WHERE source_type='invoice' AND source_id=? ORDER BY id").all(INV);

const live = () => db.prepare(`
  SELECT * FROM inventory_ledger WHERE source_type='invoice' AND source_id=?
    AND status='posted' AND COALESCE(reversed_of,0)=0 ORDER BY id`).all(INV);
const liveQty = (variantId) => live().filter((r) => Number(r.variant_id) === variantId)
  .reduce((a, r) => a + (Number(r.qty_out) || 0) - (Number(r.qty_in) || 0), 0);

// ── 1) v1: 2 → 3 (increase) ; v2 unchanged ─────────────────────────────────────
const res = db.transaction(() => replaceSaleStockInPlace(db, {
  row,
  newRows: [{ product_id: pid, qty: 3, variant_id: v1 }, { product_id: pid, qty: 2, variant_id: v2 }],
  headerWh: wh, userId: adminId, date: '', num: 'T-AAO',
}))();
const origV1 = db.prepare('SELECT * FROM inventory_ledger WHERE id=?').get(before[0].id);
ok(Number(origV1.qty_out) === 2 && Number(origV1.amount_rial) === 2000, 'original v1 row qty/amount NOT edited in place', origV1);
ok(origV1.status === 'reversed', 'original v1 row marked reversed (pair leaves the live set)', origV1.status);
const revRow = db.prepare("SELECT * FROM inventory_ledger WHERE reversed_of=?").get(before[0].id);
ok(revRow && Number(revRow.qty_in) === 2 && Number(revRow.variant_id) === v1, 'a reversal row (qty_in 2, variant v1) was appended', revRow);
const newV1 = live().find((r) => Number(r.variant_id) === v1);
ok(newV1 && Number(newV1.qty_out) === 3 && Number(newV1.unit_cost_rial) === 1000 && Number(newV1.amount_rial) === 3000,
  'fresh v1 row: qty 3, same unit cost 1000, amount 3000 (variant-stamped)', newV1);
ok(liveQty(v1) === 3 && liveQty(v2) === 2, 'live Σ per variant: v1=3, v2=2', { v1: liveQty(v1), v2: liveQty(v2) });
const untouchedV2 = db.prepare('SELECT status FROM inventory_ledger WHERE id=?').get(before[1].id);
ok(untouchedV2.status === 'posted', 'unchanged v2 line is left alone (no churn)', untouchedV2);
ok(res.cogsRial === 3000 + 2000, 'COGS = unit × new qty over all lines (5000)', res.cogsRial);
ok(qtyOf(db, { productId: pid, variantId: v1, warehouseId: wh }) === 17
  && qtyOf(db, { productId: pid, variantId: v2, warehouseId: wh }) === 18, 'derived stock v1=17, v2=18');
const cache = db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?').get(v1, wh);
ok(cache && Number(cache.qty) === 17, 'variant_warehouse_stock cache follows the ledger (17)', cache);
ok(Number(db.prepare('SELECT stock FROM products WHERE id=?').get(pid).stock) === 35, 'products.stock cache = 35');

// ── 2) v1 line removed, v2: 2 → 1 ──────────────────────────────────────────────
const row2 = { id: INV, warehouse_id: wh, rows: JSON.stringify([
  { product_id: pid, qty: 3, variant_id: v1 }, { product_id: pid, qty: 2, variant_id: v2 }]) };
const res2 = db.transaction(() => replaceSaleStockInPlace(db, {
  row: row2,
  newRows: [{ product_id: pid, qty: 1, variant_id: v2 }],
  headerWh: wh, userId: adminId, date: '1405/07/10', num: 'T-AAO',
}))();
ok(liveQty(v1) === 0 && liveQty(v2) === 1, 'removed line leaves the live set; v2 now 1', { v1: liveQty(v1), v2: liveQty(v2) });
ok(res2.cogsRial === 1000, 'COGS only for the remaining line (1000)', res2.cogsRial);
ok(qtyOf(db, { productId: pid, warehouseId: wh }) === 39, 'derived warehouse stock = 40 − 1 = 39');
const v2Row = live().find((r) => Number(r.variant_id) === v2);
ok(v2Row && v2Row.date === '1405/07/10', 'reposted row carries the invoice date given to the amend', v2Row && v2Row.date);

// ── 3) no row's qty was ever rewritten: every non-reversal row keeps its original numbers ─────────
const all = db.prepare("SELECT id, qty_out, qty_in, amount_rial FROM inventory_ledger WHERE source_type='invoice' AND source_id=? ORDER BY id").all(INV);
const firstTwo = before.map((b) => all.find((r) => r.id === b.id));
ok(firstTwo.every((r, i) => r && Number(r.qty_out) === Number(before[i].qty_out) && Number(r.amount_rial) === Number(before[i].amount_rial)),
  'rows that existed before the amend kept their qty/amount (append-only)');
const src = fs.readFileSync(path.join(__dirname, '../lib/amend-invoice.js'), 'utf8');
ok(!/UPDATE\s+inventory_ledger/i.test(src), 'amend-invoice.js has no UPDATE inventory_ledger statement');

console.log(`\n══ ${pass} passed, ${fail} failed ══\n`);
process.exit(fail ? 1 : 0);
