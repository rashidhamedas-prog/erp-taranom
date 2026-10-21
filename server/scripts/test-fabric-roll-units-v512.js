/**
 * v512 — واحد دریافت طاقه از کاتالوگ واحدها؛ موجودی به واحد طولی کارت کالا.
 * Run: node server/scripts/test-fabric-roll-units-v512.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}
function near(a, b) { return Math.abs(Number(a) - Number(b)) < 1e-6; }

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
try { new Function(app); ok(true, 'app.js parses'); } catch (e) { ok(false, 'app.js parses', e.message); }
ok(app.includes('id="fr-unit"') && app.includes('/inventory/fabric-rolls/units'), 'receipt form has catalog unit picker');
ok(app.includes('واحد طاقه (v512)'), 'help explains roll units');
const tables = fs.readFileSync(path.join(root, 'sync/tables.js'), 'utf8');
ok(tables.includes("['inventory_batches', 'entry_unit_id']"), 'entry_unit_id remapped on sync');
const route = fs.readFileSync(path.join(root, 'routes/inventory.js'), 'utf8');
ok(route.includes("'/fabric-rolls/units'"), 'units endpoint');

let Database;
try { Database = require('better-sqlite3'); new Database(':memory:').close(); }
catch (e) {
  console.log('  - skip db part:', e.message.split('\n')[0]);
  console.log(`PASS ${pass} FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roll-units-v512-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-roll-units-v512-secret-at-least-32b';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';

delete require.cache[require.resolve('../db')];
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const uom = require('../lib/uom');
const {
  receiveFabricRoll, updateFabricRoll, voidFabricRoll, listFabricRolls, applyLiveRollQty,
} = require('../lib/inventory/fabric-rolls');

function expectCode(fn, code) {
  try { fn(); ok(false, 'expected ' + code, 'no throw'); }
  catch (e) { ok(e && e.code === code, 'rejects ' + code, e && (e.code || e.message)); }
}

const admin = db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get()
  || db.prepare('SELECT * FROM users LIMIT 1').get();
const raw = db.prepare(`
  SELECT * FROM warehouses WHERE code='WH-RAW' OR warehouse_type='raw_material' OR kind='raw' LIMIT 1
`).get();
ok(!!(admin && raw), 'admin + WH-RAW');
const unit = (code) => db.prepare('SELECT * FROM units_of_measure WHERE code=?').get(code);
const M = unit('M');
const YD = unit('YD');
const KG = unit('KG');
ok(!!(M && YD && KG), 'catalog seeded (M, YD, KG)');
let CM = unit('CM');
if (!CM) {
  db.prepare(`INSERT INTO units_of_measure (code, name, dimension, factor_to_ref, decimal_places, is_active)
    VALUES ('CM','سانتی‌متر','length',0.01,0,1)`).run();
  CM = unit('CM');
}

function product(code, unitText, unitId) {
  return db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, unit_id, average_cost_rial, cost)
    VALUES (?, ?, ?, 0, 0, ?, ?, 10000, 10000)
  `).run(admin.id, 'پارچه ' + code, code, unitText, unitId).lastInsertRowid;
}
const pM = product('FAB-V511-M', 'متر', M.id);
const pKg = product('FAB-V511-KG', 'کیلوگرم', KG.id);

const info = uom.fabricReceiptUnits(db, db.prepare('SELECT * FROM products WHERE id=?').get(pM));
ok(info.stock_ok === 1 && info.stock_unit.token === 'm', 'metre product: stock unit = m');
const yOpt = info.units.find((u) => u.id === YD.id);
const kOpt = info.units.find((u) => u.id === KG.id);
ok(yOpt && yOpt.mode === 'convert' && near(yOpt.factor_to_stock, 0.9144), 'yard converts by catalog factor');
ok(kOpt && kOpt.mode === 'factor', 'kg needs per-roll factor');
ok(!info.units.some((u) => u.dimension === 'count'), 'count units not offered');
const infoKg = uom.fabricReceiptUnits(db, db.prepare('SELECT * FROM products WHERE id=?').get(pKg));
ok(infoKg.stock_ok === 0 && infoKg.reason, 'kg-stock product blocked with reason');

let k = 0;
function recv(extra) {
  k += 1;
  return receiveFabricRoll(db, {
    product_id: pM, warehouse_id: raw.id, color: 'مشکی', width_cm: 150,
    date: '1405/07/29', idempotency_key: 'v512-' + k, roll_no: 'V511-' + k, ...extra,
  }, admin);
}

const r1 = recv({ entry_unit_id: YD.id, entry_qty: 100, unit_cost_rial: 9144 });
ok(near(r1.qty_received, 91.44) && r1.unit === 'm', '100 yd → 91.44 m on stock', r1.qty_received);
const b1 = db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(r1.id);
ok(b1.entry_unit_id === YD.id && near(b1.entry_qty, 100) && near(b1.entry_factor, 0.9144), 'entry yard kept on roll');
ok(Number(b1.entry_unit_cost_rial) === 9144, 'entry unit cost kept');
ok(near(applyLiveRollQty(db, b1).qty_live, 91.44), 'ledger balance in metres');

const r2 = recv({ entry_unit_id: CM.id, entry_qty: 2500, unit_cost_rial: 100 });
ok(near(r2.qty_received, 25), '2500 cm → 25 m', r2.qty_received);

expectCode(() => recv({ entry_unit_id: KG.id, entry_qty: 20, unit_cost_rial: 50000 }), 'E_FABRIC_ENTRY_FACTOR');
const r3 = recv({ entry_unit_id: KG.id, entry_qty: 20, entry_factor: 4.2, unit_cost_rial: 50000 });
ok(near(r3.qty_received, 84), '20 kg × 4.2 → 84 m', r3.qty_received);
const b3 = db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(r3.id);
const lineAmt = db.prepare(`
  SELECT COALESCE(SUM(amount_rial),0) s FROM inventory_ledger WHERE batch_id=? AND COALESCE(qty_in,0)>0
`).get(r3.id);
ok(Number(lineAmt.s) === 1000000, 'value = 20 kg × 50,000', lineAmt.s);
ok(near(b3.entry_factor, 4.2), 'per-roll factor kept');

const legacy = recv({ meters: 30, unit: 'متر', unit_cost_rial: 10000 });
ok(near(legacy.qty_received, 30) && legacy.unit === 'm', 'legacy meters/unit text still works');

const pcs = unit('PCS');
expectCode(() => recv({ entry_unit_id: pcs.id, entry_qty: 3, unit_cost_rial: 1 }), 'E_FABRIC_ENTRY_UNIT');
expectCode(() => receiveFabricRoll(db, {
  product_id: pKg, warehouse_id: raw.id, color: 'سفید', width_cm: 150, meters: 10,
  unit_cost_rial: 1000, date: '1405/07/29', idempotency_key: 'v512-kg', roll_no: 'V511-KG',
}, admin), 'E_FABRIC_STOCK_UNIT');

const up = updateFabricRoll(db, r3.id, {
  color: 'مشکی', entry_unit_id: KG.id, entry_qty: 25, entry_factor: 4, unit_cost_rial: 50000, date: '1405/07/29',
}, admin);
ok(near(up.qty_received, 100), 'amend kg roll → 100 m', up.qty_received);
const b3u = db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(r3.id);
ok(near(b3u.entry_qty, 25) && near(b3u.entry_factor, 4), 'amend writes entry columns');

const list = listFabricRolls(db, { product_id: pM });
const rows = Array.isArray(list) ? list : (list.rows || list.items || []);
const l1 = rows.find((r) => r.id === r1.id);
ok(l1 && l1.entry_unit_code === 'YD' && Number(l1.unit_mismatch) === 0, 'list exposes entry unit, no mismatch', l1 && l1.unit_mismatch);
ok(l1 && Number(l1.amount_rial) === 914400, 'list amount = entry qty × entry cost', l1 && l1.amount_rial);

voidFabricRoll(db, r3.id, admin, { reason: 'تست v512' });
const rev = db.prepare(`
  SELECT COALESCE(SUM(qty_in),0)-COALESCE(SUM(qty_out),0) q, COALESCE(SUM(CASE WHEN qty_out>0 THEN amount_rial ELSE 0 END),0) outAmt
  FROM inventory_ledger WHERE batch_id=?
`).get(r3.id);
ok(near(rev.q, 0), 'void returns stock to zero', rev.q);
ok(Number(rev.outAmt) === 1250000, 'void reverses entry value (25 kg × 50,000)', rev.outAmt);

try {
  ok(Number(uom.countInUse(db, YD.id)) > 0, 'yard on a roll counts as in use');
} catch (e) { ok(false, 'countInUse', e.message); }

console.log(`PASS ${pass} FAIL ${fail}`);
process.exit(fail ? 1 : 0);
