'use strict';
/**
 * v515 — لایه‌چینی تک‌محصولی به واحد طاقه (یارد، کیلوگرم) روی DB واقعی:
 * planCutting / postCuttingLay / updateCuttingLay / voidCuttingLay + getCuttingLay / listCuttingLays.
 * Run: node server/scripts/test-lay-unit-single-v515.js
 */
const { ok, eq, summary } = require('./lib/test-harness');

let dbOk = false;
try {
  const { freshDb } = require('./lib/test-harness');
  const ctx = freshDb();
  const { db, cleanup } = ctx;
  const {
    planCutting, postCuttingLay, updateCuttingLay, voidCuttingLay, getCuttingLay, listCuttingLays,
  } = require('../lib/production/cutting');
  const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../lib/money');
  try {
    const unit = (code) => db.prepare('SELECT * FROM units_of_measure WHERE UPPER(code)=?').get(code);
    const M = unit('M'); const YD = unit('YD'); const KG = unit('KG');
    ok('catalog M/YD/KG', !!(M && YD && KG));

    const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get();
    const user = { id: admin.id };
    const raw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get();
    ok('WH-RAW exists', !!raw);
    if (!db.prepare("SELECT id FROM warehouses WHERE code='WH-WIP'").get()) {
      db.prepare("INSERT INTO warehouses (code,name,kind,warehouse_type,active) VALUES ('WH-WIP','WIP','wip','wip',1)").run();
    }
    if (!db.prepare("SELECT id FROM warehouses WHERE code='WH-SCRAP'").get()) {
      db.prepare("INSERT INTO warehouses (code,name,kind,warehouse_type,active) VALUES ('WH-SCRAP','ضایعات','scrap','scrap',1)").run();
    }

    const fabric = (code, unitText, unitId) => {
      const id = db.prepare(`
        INSERT INTO products (user_id, name, code, price, stock, unit, unit_id, average_cost_rial, cost, item_type)
        VALUES (?, ?, ?, 0, 0, ?, ?, 1000, 1000, 'raw')
      `).run(admin.id, 'پارچه ' + code, code, unitText, unitId).lastInsertRowid;
      return id;
    };
    let lot = 0;
    // Rolls need a batch-tagged ledger inbound: the single-lay path re-syncs
    // warehouse_stock from live batch meters (ledger), not from qty_on_hand.
    const { postInventoryMovement } = require('../lib/inventory/ledger');
    const roll = (pid, unitTok, qty, extra = {}) => {
      lot += 1;
      const bid = db.prepare(`
        INSERT INTO inventory_batches (batch_no, product_id, warehouse_id, qty_on_hand, qty_received, status, kind, unit,
          unit_cost_rial, color, width_cm, entry_unit_id, entry_factor)
        VALUES (?,?,?,?,?,'active','fabric',?,1000,'مشکی',150,?,?)
      `).run('V515-' + lot, pid, raw.id, qty, qty, unitTok,
        extra.entry_unit_id || null, extra.entry_factor || null).lastInsertRowid;
      postInventoryMovement(db, {
        eventType: 'opening', productId: pid, warehouseId: raw.id, qtyIn: qty,
        unitCostRial: 1000, amountRial: qty * 1000, sourceType: 'opening_v515', sourceId: bid,
        batchId: bid, date: '1405/07/01', note: 'v515 roll', createdBy: admin.id,
      });
      return bid;
    };
    const bal = (id) => Number(db.prepare('SELECT qty_on_hand q FROM inventory_batches WHERE id=?').get(id).q);
    const layRow = (id) => db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(id);
    const glAll = () => {
      const out = {};
      for (const r of db.prepare(`
        SELECT jl.account_code AS code, COALESCE(SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}),0) AS b
        FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
        WHERE COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
        GROUP BY jl.account_code
      `).all()) out[r.code] = Math.round(Number(r.b) || 0);
      return out;
    };
    const glDiff = (a, b) => {
      const codes = new Set([...Object.keys(a), ...Object.keys(b)]);
      const d = [];
      for (const c of codes) if ((a[c] || 0) !== (b[c] || 0)) d.push(`${c}:${a[c] || 0}→${b[c] || 0}`);
      return d;
    };
    const codeOf = (fn) => { try { fn(); return ''; } catch (e) { return e.code || e.message; } };

    const fY = fabric('V515-Y', 'یارد', YD.id);
    const fK = fabric('V515-K', 'کیلوگرم', KG.id);
    const fK2 = fabric('V515-K2', 'کیلوگرم', KG.id);
    const rY1 = roll(fY, 'yd', 60);
    const rY2 = roll(fY, 'yd', 40);
    const rK = roll(fK, 'kg', 20, { entry_unit_id: M.id, entry_factor: 0.25 });
    const rKm = roll(fK, 'm', 30);
    const rK2 = roll(fK2, 'kg', 15);

    const fg = db.prepare(`
      INSERT INTO products (user_id, name, code, price, stock, unit, item_type, is_manufactured)
      VALUES (?, 'مانتو v515', 'FG-V515', 0, 0, 'عدد', 'finished', 1)
    `).run(admin.id).lastInsertRowid;
    const sizes = { S: 10, M: 10 };
    const gl0 = glAll();

    // ── yard rolls ────────────────────────────────────────────────
    const yBody = {
      product_id: fg, fabric_product_id: fY, warehouse_id: raw.id, color: 'مشکی', width_cm: 150,
      marker_length_m: 2.5, ply_count: 8, actual_meters: 21, size_breakdown: sizes,
      rolls: [{ batch_id: rY1, meters: 15 }, { batch_id: rY2, meters: 6 }],
      date: '1405/07/29', idempotency_key: 'v515-yd-1',
    };
    const yPlan = planCutting(db, yBody);
    ok('yd plan unit', yPlan.qty_unit === 'yd' && yPlan.marker_unit === 'yd' && yPlan.marker_factor === 1,
      JSON.stringify({ u: yPlan.qty_unit, m: yPlan.marker_unit, f: yPlan.marker_factor }));
    eq('yd planned = 2.5 yd × 8 = 20 yd', yPlan.planned_meters, 20, 1e-9);
    eq('yd actual 21', yPlan.actual_meters, 21, 1e-9);
    const yLay = postCuttingLay(db, yBody, user);
    ok('yd lay posted', yLay && yLay.status === 'posted', yLay && yLay.status);
    ok('yd lay row qty_unit=yd, marker yd, factor 1',
      yLay.qty_unit === 'yd' && yLay.marker_unit === 'yd' && Number(yLay.marker_factor) === 1,
      JSON.stringify({ u: yLay.qty_unit, m: yLay.marker_unit, f: yLay.marker_factor }));
    eq('yd lay planned stored 20', yLay.planned_meters, 20, 1e-9);
    eq('yd roll1 60 → 45', bal(rY1), 45, 1e-6);
    eq('yd roll2 40 → 34', bal(rY2), 34, 1e-6);
    ok('getCuttingLay rolls carry yd balances',
      Array.isArray(yLay.rolls) && yLay.rolls.length === 2 && yLay.rolls.some((r) => Math.abs(r.qty_on_hand - 45) < 1e-6));
    const yList = listCuttingLays(db, { product_id: fg }).find((r) => r.id === yLay.id);
    ok('listCuttingLays exposes yd unit fields',
      !!yList && yList.qty_unit === 'yd' && yList.marker_unit === 'yd' && Number(yList.marker_factor) === 1);
    const yAgain = postCuttingLay(db, yBody, user);
    ok('yd idempotent repost returns same lay', yAgain.id === yLay.id);
    eq('yd idempotent repost does not consume', bal(rY1), 45, 1e-6);

    const yUpd = updateCuttingLay(db, yLay.id, {
      ...yBody, ply_count: 10, actual_meters: 25,
      rolls: [{ batch_id: rY1, meters: 20 }, { batch_id: rY2, meters: 5 }],
      reason: 'v515 yd edit',
    }, user);
    eq('yd update planned = 25 yd', yUpd.planned_meters, 25, 1e-9);
    ok('yd update keeps yd unit', yUpd.qty_unit === 'yd' && Number(yUpd.marker_factor) === 1);
    eq('yd roll1 after update 40', bal(rY1), 40, 1e-6);
    eq('yd roll2 after update 35', bal(rY2), 35, 1e-6);

    // ── kg rolls with receipt factor ─────────────────────────────
    const glBeforeK = glAll();
    const kBody = {
      product_id: fg, fabric_product_id: fK, warehouse_id: raw.id, color: 'مشکی', width_cm: 150,
      marker_length_m: 3, ply_count: 10, actual_meters: 7.6, size_breakdown: sizes,
      rolls: [{ batch_id: rK, meters: 7.6 }],
      date: '1405/07/29', idempotency_key: 'v515-kg-1',
    };
    const kPlan = planCutting(db, kBody);
    ok('kg plan: qty kg, marker m, factor from receipt',
      kPlan.qty_unit === 'kg' && kPlan.marker_unit === 'm' && kPlan.lay_unit.factor_source === 'roll_receipt',
      JSON.stringify({ u: kPlan.qty_unit, m: kPlan.marker_unit, s: kPlan.lay_unit.factor_source }));
    eq('kg factor 0.25', kPlan.marker_factor, 0.25, 1e-9);
    eq('kg planned = 0.75 × 10 = 7.5', kPlan.planned_meters, 7.5, 1e-9);
    const kLay = postCuttingLay(db, kBody, user);
    ok('kg lay posted', kLay && kLay.status === 'posted');
    const kRow = layRow(kLay.id);
    ok('kg lay row: qty_unit kg, marker_unit m, factor 0.25',
      kRow.qty_unit === 'kg' && kRow.marker_unit === 'm' && Math.abs(kRow.marker_factor - 0.25) < 1e-9,
      JSON.stringify({ u: kRow.qty_unit, m: kRow.marker_unit, f: kRow.marker_factor }));
    eq('kg lay planned stored 7.5', kRow.planned_meters, 7.5, 1e-9);
    eq('kg roll 20 → 12.4', bal(rK), 12.4, 1e-6);
    eq('kg lay amount = 7.6 × 1000', kRow.amount_rial, 7600, 0);
    ok('kg lay posted a material journal (GL moved)', !!kRow.journal_id && glDiff(glBeforeK, glAll()).length > 0);
    const kGet = getCuttingLay(db, kLay.id);
    ok('getCuttingLay kg fields', kGet.qty_unit === 'kg' && kGet.marker_unit === 'm' && Math.abs(kGet.marker_factor - 0.25) < 1e-9);
    const kList = listCuttingLays(db, {}).find((r) => r.id === kLay.id);
    ok('listCuttingLays kg fields', !!kList && kList.qty_unit === 'kg' && Math.abs(kList.marker_factor - 0.25) < 1e-9);

    // update without marker_factor must keep the stored 0.25 even if receipt factor changes
    db.prepare('UPDATE inventory_batches SET entry_factor=0.5 WHERE id=?').run(rK);
    const kUpdBody = { ...kBody, ply_count: 12, actual_meters: 9, rolls: [{ batch_id: rK, meters: 9 }], reason: 'v515 kg edit' };
    delete kUpdBody.marker_factor;
    delete kUpdBody.idempotency_key;
    const kUpd = updateCuttingLay(db, kLay.id, kUpdBody, user);
    const kRow2 = layRow(kLay.id);
    ok('kg update keeps stored factor 0.25', Math.abs(kRow2.marker_factor - 0.25) < 1e-9, kRow2.marker_factor);
    eq('kg update planned = 0.75 × 12 = 9', kRow2.planned_meters, 9, 1e-9);
    ok('kg update keeps qty_unit/marker_unit', kRow2.qty_unit === 'kg' && kRow2.marker_unit === 'm');
    ok('kg update same lay', kUpd.id === kLay.id && kUpd.lay_no === kLay.lay_no);
    eq('kg roll after update 11', bal(rK), 11, 1e-6);
    ok('kg update: one posted roll line', db.prepare("SELECT COUNT(*) c FROM cutting_lay_rolls WHERE lay_id=? AND status='posted'").get(kLay.id).c === 1);
    db.prepare('UPDATE inventory_batches SET entry_factor=0.25 WHERE id=?').run(rK);

    // explicit marker_factor on update overrides
    const kUpd2 = updateCuttingLay(db, kLay.id, { ...kUpdBody, marker_factor: 0.3, actual_meters: 10.8, rolls: [{ batch_id: rK, meters: 10.8 }] }, user);
    eq('kg update with marker_factor 0.3 → planned 10.8', kUpd2.planned_meters, 10.8, 1e-9);
    ok('kg update stores factor 0.3', Math.abs(layRow(kLay.id).marker_factor - 0.3) < 1e-9);
    eq('kg roll after 2nd update 9.2', bal(rK), 9.2, 1e-6);

    // void → roll and GL back to pre-post state
    const kVoid = voidCuttingLay(db, kLay.id, user, { reason: 'v515 void' });
    ok('kg lay reversed', kVoid.status === 'reversed');
    eq('kg void restores roll to 20', bal(rK), 20, 1e-9);
    const kDiff = glDiff(glBeforeK, glAll());
    ok('kg void: material journal nets to zero', kDiff.length === 0, kDiff.join(', '));
    ok('kg void: no live PRD-01 JE', db.prepare(`
      SELECT COUNT(*) c FROM journal_entries WHERE ref_type='production_material_issue' AND ref_id=?
        AND COALESCE(deleted_at,0)=0 AND COALESCE(status,'posted') NOT IN ('reversed','void')
    `).get(kLay.id).c === 0);
    ok('kg void: all roll lines reversed', db.prepare("SELECT COUNT(*) c FROM cutting_lay_rolls WHERE lay_id=? AND status='posted'").get(kLay.id).c === 0);
    ok('reversed kg lay hidden from default list', !listCuttingLays(db, {}).some((r) => r.id === kLay.id));

    // ── kg rolls without factor ──────────────────────────────────
    const k2Body = {
      product_id: fg, fabric_product_id: fK2, warehouse_id: raw.id, color: 'مشکی', width_cm: 150,
      marker_length_m: 2, ply_count: 5, actual_meters: 3, size_breakdown: sizes,
      rolls: [{ batch_id: rK2, meters: 3 }],
      date: '1405/07/29', idempotency_key: 'v515-kg2-1',
    };
    ok('kg without factor: plan → E_CUT_MARKER_FACTOR', codeOf(() => planCutting(db, k2Body)) === 'E_CUT_MARKER_FACTOR');
    const laysBefore = db.prepare('SELECT COUNT(*) c FROM cutting_lays').get().c;
    ok('kg without factor: post → E_CUT_MARKER_FACTOR', codeOf(() => postCuttingLay(db, k2Body, user)) === 'E_CUT_MARKER_FACTOR');
    ok('kg without factor: nothing written', db.prepare('SELECT COUNT(*) c FROM cutting_lays').get().c === laysBefore);
    eq('kg without factor: roll untouched', bal(rK2), 15, 0);
    const k2Plan = planCutting(db, { ...k2Body, marker_factor: 0.3 });
    ok('kg with body.marker_factor: source user', k2Plan.lay_unit.factor_source === 'user' && k2Plan.marker_factor === 0.3);
    eq('kg user factor planned = 2 × 0.3 × 5 = 3', k2Plan.planned_meters, 3, 1e-9);
    const k2Lay = postCuttingLay(db, { ...k2Body, marker_factor: 0.3 }, user);
    ok('kg user-factor lay stored', k2Lay.qty_unit === 'kg' && k2Lay.marker_unit === 'm' && Math.abs(k2Lay.marker_factor - 0.3) < 1e-9);
    eq('kg user-factor roll 15 → 12', bal(rK2), 12, 1e-6);
    voidCuttingLay(db, k2Lay.id, user, { reason: 'v515 void k2' });
    eq('kg user-factor void restores 15', bal(rK2), 15, 1e-9);

    // ── mixed-unit rolls ─────────────────────────────────────────
    // P9: an «m»-labelled roll of a kg product is in kg (product unit); a real mix is kg + yd.
    const mixBody = {
      ...kBody, idempotency_key: 'v515-mix-1', actual_meters: 8,
      rolls: [{ batch_id: rK, meters: 4 }, { batch_id: rY1, meters: 4 }],
    };
    ok('mixed units: plan → E_CUT_ROLL_UNIT', codeOf(() => planCutting(db, mixBody)) === 'E_CUT_ROLL_UNIT');
    const laysBeforeMix = db.prepare('SELECT COUNT(*) c FROM cutting_lays').get().c;
    ok('mixed units: post → E_CUT_ROLL_UNIT', codeOf(() => postCuttingLay(db, mixBody, user)) === 'E_CUT_ROLL_UNIT');
    ok('mixed units: nothing written', db.prepare('SELECT COUNT(*) c FROM cutting_lays').get().c === laysBeforeMix);
    ok('mixed units: rolls untouched', bal(rK) === 20 && bal(rKm) === 30 && Math.abs(bal(rY1) - 40) < 1e-6);
    ok('mixed units on update → E_CUT_ROLL_UNIT', codeOf(() => updateCuttingLay(db, yLay.id, {
      ...yBody, rolls: [{ batch_id: rY1, meters: 10 }, { batch_id: rKm, meters: 11 }],
    }, user)) === 'E_CUT_ROLL_UNIT');
    eq('failed update leaves yd roll1 at 40', bal(rY1), 40, 1e-6);
    ok('failed update leaves yd lay posted', layRow(yLay.id).status === 'posted');

    // ── void yard lay → full GL back to start ────────────────────
    voidCuttingLay(db, yLay.id, user, { reason: 'v515 void yd' });
    eq('yd void restores roll1 60', bal(rY1), 60, 1e-9);
    eq('yd void restores roll2 40', bal(rY2), 40, 1e-9);
    const allDiff = glDiff(gl0, glAll());
    ok('all lays voided: GL back to opening', allDiff.length === 0, allDiff.join(', '));

    // ── BOM-backed yard plan (E_SPEC_FG_SIZE fixture) ────────────
    {
      const fg2 = db.prepare(`
        INSERT INTO products (user_id, name, code, price, stock, unit, item_type, is_manufactured)
        VALUES (?, 'مانتو BOM v515', 'FG-V515-B', 0, 0, 'عدد', 'finished', 1)
      `).run(admin.id).lastInsertRowid;
      for (const [i, code] of ['38', '40'].entries()) {
        let sz = db.prepare('SELECT id FROM product_sizes WHERE code=?').get(code);
        if (!sz) sz = { id: db.prepare('INSERT INTO product_sizes (code,name,sort_order,active) VALUES (?,?,?,1)').run(code, code, i).lastInsertRowid };
        db.prepare('INSERT OR IGNORE INTO product_style_sizes (product_id,size_id,sort_order) VALUES (?,?,?)').run(fg2, sz.id, i);
      }
      const bomLib = require('../lib/production/bom');
      const bom = bomLib.createBom(db, { product_id: fg2, name: 'BOM v515 yd', base_qty: 1, yield_percent: 100 }, admin.id);
      bomLib.addLine(db, bom.id, {
        component_product_id: fY, qty_per_base: 1.5, scrap_percent: 0,
        line_type: 'material', size_matrix: JSON.stringify({ 38: 1.5, 40: 1.5 }),
      }, admin.id);
      const act = codeOf(() => bomLib.activateBom(db, bom.id, '1405/01/01', admin.id));
      ok('BOM with size_matrix activates once FG sizes exist (no E_SPEC_FG_SIZE)', act === '', act);
      const bPlan = planCutting(db, {
        product_id: fg2, fabric_product_id: fY, warehouse_id: raw.id, color: 'مشکی', width_cm: 150,
        marker_length_m: 3, ply_count: 2, actual_meters: 6.5, size_breakdown: { 38: 2, 40: 2 },
        rolls: [{ batch_id: rY1, meters: 6.5 }], date: '1405/07/29',
      });
      ok('BOM plan in yd', bPlan.bom_id === bom.id && bPlan.qty_unit === 'yd', JSON.stringify({ b: bPlan.bom_id, u: bPlan.qty_unit }));
      eq('BOM plan planned 6 yd', bPlan.planned_meters, 6, 1e-9);
      eq('BOM matrix standard 4 × 1.5 = 6 yd', bPlan.matrix_meters, 6, 1e-6);
      eq('BOM leftover 0.5 yd → waste', bPlan.waste_normal_m + bPlan.waste_abnormal_m, 0.5, 1e-6);
      const bLay = postCuttingLay(db, {
        product_id: fg2, fabric_product_id: fY, warehouse_id: raw.id, color: 'مشکی', width_cm: 150,
        marker_length_m: 3, ply_count: 2, actual_meters: 6.5, size_breakdown: { 38: 2, 40: 2 },
        rolls: [{ batch_id: rY1, meters: 6.5 }], date: '1405/07/29', idempotency_key: 'v515-bom-1',
      }, user);
      ok('BOM yd lay posted', bLay.status === 'posted' && bLay.qty_unit === 'yd' && bLay.bom_id === bom.id);
      eq('BOM yd roll1 60 → 53.5', bal(rY1), 53.5, 1e-6);
      voidCuttingLay(db, bLay.id, user, { reason: 'v515 void bom' });
      eq('BOM yd void restores 60', bal(rY1), 60, 1e-9);
    }
    dbOk = true;
  } finally {
    cleanup();
  }
} catch (e) {
  if (/bindings|better_sqlite3|NODE_MODULE_VERSION/i.test(String(e.message) + e)) {
    console.log('  SKIP db path: better-sqlite3 not loaded on this Node');
    ok('db path skipped', true);
  } else {
    ok('db path', false, e.stack || e.message);
  }
}
if (dbOk) ok('db single-lay unit path', true);

summary('lay-unit-single-v515');
