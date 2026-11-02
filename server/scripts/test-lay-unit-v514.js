'use strict';
/**
 * v514 — لایه‌چینی به واحد طاقه (متر، یارد، کیلوگرم، متر مربع).
 * Run: node server/scripts/test-lay-unit-v514.js
 */
const fs = require('fs');
const path = require('path');
const { ok, eq, summary } = require('./lib/test-harness');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
try { new Function(app); ok('app.js parses', true); } catch (e) { ok('app.js parses', false, e.message); }
ok('UI probes lay unit', app.includes('/production/cutting-lays/lay-unit') && app.includes('function cuttingRefreshLayUnit'));
ok('UI factor field', app.includes('id="cl-factor"') && app.includes('marker_factor: cutMarkerInUnit()?undefined:cutMarkerFactor()'));
ok('help v514', app.includes('لایه‌چینی به واحد طاقه (v514)'));
ok('fabricLengthWord knows kg', /named=\{[^}]*kg:'کیلوگرم'/.test(app));
const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
ok('SW bumped', /erp-taranom-v5(1[4-9]|[2-9]\d)/.test(sw));
const route = fs.readFileSync(path.join(root, 'routes/production-cutting.js'), 'utf8');
ok('lay-unit route before /:id', route.indexOf("'/lay-unit'") > 0 && route.indexOf("'/lay-unit'") < route.indexOf("'/:id'"));
const schema = fs.readFileSync(path.join(root, 'lib/production/schema.js'), 'utf8');
ok('schema columns', (schema.match(/'marker_factor', 'REAL'/g) || []).length >= 2);

let dbOk = false;
try {
  const { freshDb } = require('./lib/test-harness');
  const { resolveLayUnit, markerToUnit, metresToUnit } = require('../lib/production/lay-unit');
  const { previewSharedCut, postSharedCut } = require('../lib/production/shared-cut');
  const { voidCuttingLay, isRollFabricProduct } = require('../lib/production/cutting');
  const uom = require('../lib/uom');
  const ctx = freshDb();
  const { db, cleanup } = ctx;
  try {
    db.prepare("INSERT INTO settings (key,value) VALUES ('production_shared_cut','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    const unit = (code) => db.prepare('SELECT * FROM units_of_measure WHERE UPPER(code)=?').get(code);
    const M = unit('M'); const YD = unit('YD'); const KG = unit('KG');
    ok('catalog M/YD/KG', !!(M && YD && KG));
    const M2 = unit('M2');
    ok('catalog seeds متر مربع', !!M2 && M2.dimension === 'area', M2 && M2.dimension);

    const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get();
    const raw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get();
    if (!db.prepare("SELECT id FROM warehouses WHERE code='WH-WIP'").get()) {
      db.prepare("INSERT INTO warehouses (code,name,kind,warehouse_type,active) VALUES ('WH-WIP','WIP','wip','wip',1)").run();
    }
    if (!db.prepare("SELECT id FROM warehouses WHERE code='WH-SCRAP'").get()) {
      db.prepare("INSERT INTO warehouses (code,name,kind,warehouse_type,active) VALUES ('WH-SCRAP','ضایعات','scrap','scrap',1)").run();
    }
    const fabric = (code, unitText, unitId) => {
      const id = db.prepare(`
        INSERT INTO products (user_id, name, code, price, stock, unit, unit_id, average_cost_rial, cost, item_type)
        VALUES (?, ?, ?, 0, 1000, ?, ?, 1000, 1000, 'raw')
      `).run(admin.id, 'پارچه ' + code, code, unitText, unitId).lastInsertRowid;
      db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,1000)').run(id, raw.id);
      return id;
    };
    let lot = 0;
    const roll = (pid, unitTok, qty, extra = {}) => {
      lot += 1;
      return db.prepare(`
        INSERT INTO inventory_batches (batch_no, product_id, warehouse_id, qty_on_hand, qty_received, status, kind, unit,
          unit_cost_rial, color, width_cm, entry_unit_id, entry_factor)
        VALUES (?,?,?,?,?,'active','fabric',?,1000,'مشکی',?,?,?)
      `).run('V514-' + lot, pid, raw.id, qty, qty, unitTok, extra.width_cm || 150,
        extra.entry_unit_id || null, extra.entry_factor || null).lastInsertRowid;
    };

    const fM = fabric('V514-M', 'متر', M.id);
    const fY = fabric('V514-Y', 'یارد', YD.id);
    const fK = fabric('V514-K', 'کیلوگرم', KG.id);
    const fA = fabric('V514-A', 'متر مربع', M2.id);
    const rM = roll(fM, 'm', 80);
    const rY1 = roll(fY, 'yd', 60);
    const rY2 = roll(fY, 'yd', 40);
    const rK = roll(fK, 'kg', 20, { entry_unit_id: M.id, entry_factor: 0.25 });
    const rK2 = roll(fK, 'kg', 15);
    const rA = roll(fA, 'm2', 50, { width_cm: 160 });
    const rMx = roll(fK, 'm', 30);

    const lm = resolveLayUnit(db, { batchIds: [rM] });
    ok('metre roll: same unit, factor 1', lm.qty_unit === 'm' && lm.marker_in_unit === 1 && lm.marker_factor === 1, JSON.stringify(lm));
    const ly = resolveLayUnit(db, { batchIds: [rY1, rY2] });
    ok('yard rolls: marker in yards', ly.qty_unit === 'yd' && ly.marker_unit === 'yd' && ly.marker_factor === 1, JSON.stringify(ly));
    eq('yard: 1 m remnant policy = 1.0936 yd', metresToUnit(ly, 1), 1.093613, 0.0001);
    const lk = resolveLayUnit(db, { batchIds: [rK] });
    ok('kg roll: marker in metres, factor from receipt', lk.qty_unit === 'kg' && lk.marker_unit === 'm' && lk.factor_source === 'roll_receipt', JSON.stringify(lk));
    eq('kg factor 0.25 kg per metre', lk.marker_factor, 0.25, 1e-9);
    eq('3 m marker = 0.75 kg', markerToUnit(lk, 3), 0.75, 1e-9);
    const lkU = resolveLayUnit(db, { batchIds: [rK2], markerFactor: 0.3 });
    ok('kg roll: user factor wins', lkU.factor_source === 'user' && lkU.marker_factor === 0.3);
    let code = '';
    try { resolveLayUnit(db, { batchIds: [rK2] }); } catch (e) { code = e.code; }
    ok('kg roll without factor → E_CUT_MARKER_FACTOR', code === 'E_CUT_MARKER_FACTOR', code);
    const soft = resolveLayUnit(db, { batchIds: [rK2], soft: true });
    ok('soft probe asks for factor', soft.need_factor === 1 && soft.factor_source === 'missing');
    const la = resolveLayUnit(db, { batchIds: [rA] });
    ok('m² roll: factor from width', la.qty_unit === 'm2' && la.factor_source === 'width', JSON.stringify(la));
    eq('160 cm width = 1.6 m² per metre', la.marker_factor, 1.6, 1e-9);
    code = '';
    // P9: roll qty is in the product unit; an «m» label on a kg product is only flagged.
    let mixed = null;
    try { mixed = resolveLayUnit(db, { batchIds: [rK, rMx] }); } catch (e) { code = e.code; }
    ok('P9: mislabelled roll of a kg product follows the product unit (flagged)',
      !code && mixed && mixed.qty_unit === 'kg' && (mixed.label_mismatch_batch_ids || []).includes(rMx), code || JSON.stringify(mixed && mixed.label_mismatch_batch_ids));
    const lp = resolveLayUnit(db, { fabricProductId: fK, soft: true });
    ok('no rolls: product stock unit', lp.qty_unit === 'kg', lp.qty_unit);

    ok('kg fabric with rolls is roll fabric', isRollFabricProduct(db, fK) === true);
    const prodK = db.prepare('SELECT * FROM products WHERE id=?').get(fK);
    ok('kg stock allowed for receipt', uom.fabricReceiptUnits(db, prodK).stock_ok === 1);

    const fgA = db.prepare(`INSERT INTO products (user_id, name, code, unit, item_type, is_manufactured) VALUES (?,'تیشرت','FG-V514-A','عدد','finished',1)`).run(admin.id).lastInsertRowid;
    const body = {
      marker_length_m: 3,
      fabric_product_id: fK,
      warehouse_id: raw.id,
      width_cm: 150,
      color: 'مشکی',
      date: '1405/07/29',
      idempotency_key: 'v514-kg-1',
      outputs: [
        { product_id: fgA, size_code: 'S', pieces_per_ply: 2 },
        { product_id: fgA, size_code: 'M', pieces_per_ply: 2 },
      ],
      rolls: [{ batch_id: rK, opening_m: 20, ply_count: 10 }],
      actual_meters: 7.6,
    };
    const pv = previewSharedCut(db, body);
    ok('kg preview unit', pv.qty_unit === 'kg' && pv.marker_unit === 'm', JSON.stringify({ u: pv.qty_unit, m: pv.marker_unit }));
    eq('kg marker per ply', pv.marker_in_unit_qty, 0.75, 1e-6);
    eq('kg laid = measured 7.6', pv.rolls[0].laid_m, 7.6, 1e-6);
    ok('remnant threshold expressed in kg', pv.policy && pv.policy.threshold_unit === 'kg', JSON.stringify(pv.policy));
    const posted = postSharedCut(db, body, { id: admin.id });
    ok('kg shared lay posted', posted && posted.status === 'posted');
    const lay = db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(posted.lay_id);
    ok('lay stores kg + metre marker + factor', lay.qty_unit === 'kg' && lay.marker_unit === 'm' && Math.abs(lay.marker_factor - 0.25) < 1e-9,
      JSON.stringify({ u: lay.qty_unit, m: lay.marker_unit, f: lay.marker_factor }));
    const left = Number(db.prepare('SELECT qty_on_hand q FROM inventory_batches WHERE id=?').get(rK).q);
    ok('roll balance consumed in kg (< 20)', left < 20 && left >= 0, left);
    const lastLay = resolveLayUnit(db, { batchIds: [rK2] , fabricProductId: fK });
    ok('next kg lay without receipt factor uses last lay', lastLay.factor_source === 'last_lay' && Math.abs(lastLay.marker_factor - 0.25) < 1e-9, JSON.stringify(lastLay));
    voidCuttingLay(db, posted.lay_id, { id: admin.id }, { reason: 'آزمون v514' });
    eq('void restores kg roll', Number(db.prepare('SELECT qty_on_hand q FROM inventory_batches WHERE id=?').get(rK).q), 20, 0.0001);
    dbOk = true;
  } finally {
    cleanup();
  }
} catch (e) {
  if (/bindings|better_sqlite3|NODE_MODULE_VERSION/i.test(String(e.message) + e)) {
    console.log('  SKIP db path: better-sqlite3 not loaded on this Node');
    ok('db path skipped (static assertions still ran)', true);
  } else {
    ok('db path', false, e.stack || e.message);
  }
}
if (dbOk) ok('db lay-unit path', true);

summary('lay-unit-v514');
