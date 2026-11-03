#!/usr/bin/env node
'use strict';
/**
 * v621 — هر پارچهٔ طاقه‌ای BOM باید لایهٔ مستقل داشته باشد؛ شمارش قطعه بین
 * پارچه‌ها MIN است، نه SUM. ابطال پارچهٔ دوم پوشش را دوباره باز می‌کند.
 *
 * Run: node server/scripts/test-multi-fabric-lay-v621.js
 */
const fs = require('fs');
const path = require('path');
const { ok, eq, summary } = require('./lib/test-harness');

const root = path.join(__dirname, '..');
const cuttingPath = path.join(root, 'lib/production/cutting.js');
const advancedPath = path.join(root, 'lib/production/engine-advanced.js');
const routePath = path.join(root, 'routes/production-cutting.js');
const appPath = path.join(root, 'public/app.js');
const cuttingSrc = fs.readFileSync(cuttingPath, 'utf8');
const advancedSrc = fs.readFileSync(advancedPath, 'utf8');
const routeSrc = fs.readFileSync(routePath, 'utf8');
const appSrc = fs.readFileSync(appPath, 'utf8');

// قراردادهای استاتیک؛ این‌ها عمداً تا فرود هم‌زمان backend/UI قرمز می‌شوند.
for (const name of [
  'rollFabricLinesForBom',
  'orderRollFabricProductIds',
  'cuttingQtyForOrder',
  'cuttingQtyForOrderProduct',
  'cuttingFabricCoverage',
]) {
  ok(`cutting.js exports ${name}`,
    new RegExp(`module\\.exports\\s*=\\s*\\{[\\s\\S]*\\b${name}\\b`).test(cuttingSrc));
}
ok('engine coverage exposes missing_fabrics',
  /function cuttingStageCoverage[\s\S]*missing_fabrics/.test(advancedSrc));
ok('route GET /fabric-lines exists',
  /router\.get\(\s*['"]\/fabric-lines['"]/.test(routeSrc));
ok('UI has cl-fabric-line', appSrc.includes('cl-fabric-line'));
ok('UI calls fabric-lines', appSrc.includes('fabric-lines'));

let dbOk = false;
try {
  const { freshDb } = require('./lib/test-harness');
  const ctx = freshDb();
  const { db, cleanup } = ctx;
  try {
    const bomLib = require('../lib/production/bom');
    const advBom = require('../lib/production/bom-advanced');
    const assignments = require('../lib/production/bom-assignments');
    const engine = require('../lib/production/engine');
    const advanced = require('../lib/production/engine-advanced');
    const cutting = require('../lib/production/cutting');
    const { postInventoryMovement } = require('../lib/inventory/ledger');

    const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get();
    const user = { id: admin.id };
    const raw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get();
    const fgWh = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get();
    const ccCut = db.prepare("SELECT id FROM cost_centers WHERE code='CC-10'").get();
    ok('fixture: admin, WH-RAW/FG and CC-10 exist', !!(admin && raw && fgWh && ccCut));
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_raw_id',?)")
      .run(String(raw.id));
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_fg_id',?)")
      .run(String(fgWh.id));

    const product = (name, code, unit, type, manufactured, avg = 1000) =>
      Number(db.prepare(`
        INSERT INTO products
          (user_id,name,code,price,stock,unit,average_cost_rial,cost,item_type,is_manufactured)
        VALUES (?,?,?,0,0,?,?,?,?,?)
      `).run(admin.id, name, code, unit, avg, avg, type, manufactured ? 1 : 0).lastInsertRowid);

    const ensureSize = (fgId, code, sort) => {
      let size = db.prepare('SELECT id FROM product_sizes WHERE code=?').get(code);
      if (!size) {
        size = {
          id: db.prepare(
            'INSERT INTO product_sizes (code,name,sort_order,active) VALUES (?,?,?,1)'
          ).run(code, code, sort).lastInsertRowid,
        };
      }
      db.prepare(`
        INSERT OR IGNORE INTO product_style_sizes (product_id,size_id,sort_order)
        VALUES (?,?,?)
      `).run(fgId, size.id, sort);
    };

    let rollSeq = 0;
    const makeRoll = (productId, qty, color = 'مشکی') => {
      rollSeq += 1;
      const batchId = Number(db.prepare(`
        INSERT INTO inventory_batches
          (batch_no,product_id,warehouse_id,qty_on_hand,qty_received,status,kind,unit,
           unit_cost_rial,color,width_cm)
        VALUES (?,?,?,?,?,'active','fabric','متر',1000,?,150)
      `).run(`V621-R${rollSeq}`, productId, raw.id, qty, qty, color).lastInsertRowid);
      postInventoryMovement(db, {
        eventType: 'opening',
        productId,
        warehouseId: raw.id,
        qtyIn: qty,
        unitCostRial: 1000,
        amountRial: qty * 1000,
        sourceType: 'opening_v621',
        sourceId: batchId,
        batchId,
        date: '1405/08/12',
        note: 'طاقه تست v621',
        createdBy: admin.id,
      });
      return batchId;
    };
    const rollQty = (batchId) => Number(
      db.prepare('SELECT qty_on_hand FROM inventory_batches WHERE id=?').get(batchId).qty_on_hand
    );

    const makeRoutedBom = ({ fgId, name, fabrics }) => {
      const draft = bomLib.createBom(db, {
        product_id: fgId,
        name,
        base_qty: 1,
        yield_percent: 100,
        has_routing: 1,
      }, admin.id);
      const operation = advBom.addOperation(db, draft.id, {
        seq: 10,
        cost_center_id: ccCut.id,
        operation_name: 'برش',
        labor_method: 'contract',
        yield_percent: 100,
        machine_minutes_per_unit: 0,
        run_minutes_per_unit: 0,
      }, admin.id);
      const links = [];
      for (const f of fabrics) {
        const line = bomLib.addLine(db, draft.id, {
          component_product_id: f.productId,
          qty_per_base: f.qty,
          scrap_percent: 0,
          line_type: 'material',
          stage_cost_center_id: ccCut.id,
          size_matrix: f.matrix || null,
        }, admin.id);
        links.push({
          bom_line_id: line.id,
          operation_id: operation.id,
          allocation_mode: 'sole',
        });
      }
      assignments.replaceAssignments(db, draft.id, links, admin.id);
      bomLib.activateBom(db, draft.id, '1405/01/01', admin.id);
      return draft;
    };

    const fg = product('هودی دوپارچه v621', 'V621-FG-MULTI', 'عدد', 'finished', true, 0);
    ensureSize(fg, '38', 1);
    ensureSize(fg, '40', 2);
    const fabricA = product('دورس v621', 'V621-FAB-A', 'متر', 'raw', false);
    const fabricB = product('کشبافت v621', 'V621-FAB-B', 'متر', 'raw', false);
    const rollA = makeRoll(fabricA, 30);
    const rollB = makeRoll(fabricB, 20);
    const multiBom = makeRoutedBom({
      fgId: fg,
      name: 'BOM دوپارچه v621',
      fabrics: [
        { productId: fabricA, qty: 1.5, matrix: { 38: 1.5, 40: 1.5 } },
        { productId: fabricB, qty: 0.2 },
      ],
    });

    const discovered = cutting.rollFabricLinesForBom(db, {
      productId: fg,
      bomId: multiBom.id,
      date: '1405/08/12',
      sizeBreakdown: { 38: 5, 40: 5 },
    });
    ok('دو خط پارچهٔ طاقه‌ای کشف می‌شود', discovered.lines.length === 2,
      JSON.stringify(discovered.lines));
    ok('پارچه‌های کشف‌شده A و B هستند',
      discovered.lines.some((x) => Number(x.product_id) === fabricA)
      && discovered.lines.some((x) => Number(x.product_id) === fabricB));
    eq('پارچهٔ دارای size_matrix اصلی است', discovered.primary_fabric_product_id, fabricA);
    ok('فقط A پرچم primary دارد',
      discovered.lines.filter((x) => Number(x.is_primary) === 1).length === 1
      && Number(discovered.lines.find((x) => Number(x.is_primary) === 1).product_id) === fabricA);

    const N = 10;
    const po = engine.createOrder(db, {
      product_id: fg,
      bom_id: multiBom.id,
      qty_planned: N,
      analysis_type: 'variable_adv',
      date: '1405/08/12',
      warehouse_raw_id: raw.id,
      warehouse_fg_id: fgWh.id,
      cost_center_id: ccCut.id,
    }, admin.id);
    engine.releaseOrder(db, po.id, admin.id);
    let poRow = db.prepare('SELECT * FROM production_orders WHERE id=?').get(po.id);
    let cutStage = advanced.resolveCuttingStage(db, po.id);
    ok('سفارش پیشرفته مرحلهٔ برش دارد', !!cutStage);
    ok('شناسه پارچه‌های سفارش هر دو پارچه را می‌دهد',
      JSON.stringify(cutting.orderRollFabricProductIds(db, poRow).sort((a, b) => a - b))
      === JSON.stringify([fabricA, fabricB].sort((a, b) => a - b)));

    const baseLay = {
      product_id: fg,
      bom_id: multiBom.id,
      production_order_id: po.id,
      warehouse_id: raw.id,
      color: 'مشکی',
      width_cm: 150,
      size_breakdown: { 38: 5, 40: 5 },
      date: '1405/08/12',
    };
    const layA = cutting.postCuttingLay(db, {
      ...baseLay,
      fabric_product_id: fabricA,
      marker_length_m: 1.5,
      ply_count: N,
      actual_meters: 15,
      rolls: [{ batch_id: rollA, meters: 15 }],
      idempotency_key: 'v621-multi-a',
    }, user);
    ok('لایه A پارچهٔ درخواستی را ذخیره می‌کند', Number(layA.fabric_product_id) === fabricA);
    cutStage = db.prepare('SELECT * FROM production_order_stages WHERE id=?').get(cutStage.id);
    ok('بعد از فقط A مرحلهٔ برش هنوز done نیست', cutStage.status !== 'done', cutStage.status);
    poRow = db.prepare('SELECT * FROM production_orders WHERE id=?').get(po.id);
    let coverage = advanced.cuttingStageCoverage(db, poRow, cutStage);
    ok('بعد از فقط A پوشش false است', coverage.covered === false);
    ok('missing_fabrics شامل B است',
      Array.isArray(coverage.missing_fabrics)
      && coverage.missing_fabrics.some((x) => Number(x.product_id) === fabricB),
      JSON.stringify(coverage.missing_fabrics));
    ok('پیام پوشش نام B را دارد', String(coverage.message || '').includes('کشبافت v621'),
      coverage.message);
    eq('MIN قطعه بعد از A صفر است', cutting.cuttingQtyForOrder(db, po.id).lay_qty, 0);

    let manualError = null;
    try {
      advanced.postStageOutputVariable(db, {
        orderId: po.id,
        stageId: cutStage.id,
        userId: admin.id,
        body: {
          date: '1405/08/12',
          qty_out: Number(cutStage.qty_in),
          waste_normal: 0,
          waste_abnormal: 0,
          rework: 0,
          qc_passed: 1,
        },
      });
    } catch (e) {
      manualError = e;
    }
    ok('تکمیل دستی با E_LAY_REQUIRED_ON_CUT رد می‌شود',
      manualError && manualError.code === 'E_LAY_REQUIRED_ON_CUT',
      manualError && (manualError.code || manualError.message));
    ok('خطای تکمیل دستی نام B را دارد',
      manualError && String((manualError.extra && manualError.extra.message) || manualError.message)
        .includes('کشبافت v621'));
    ok('خطا missing_fabrics دارد',
      manualError && Array.isArray(manualError.extra && manualError.extra.missing_fabrics)
      && manualError.extra.missing_fabrics.some((x) => Number(x.product_id) === fabricB));

    const bBefore = rollQty(rollB);
    const layB = cutting.postCuttingLay(db, {
      ...baseLay,
      fabric_product_id: fabricB,
      marker_length_m: 0.2,
      ply_count: N,
      actual_meters: 2,
      rolls: [{ batch_id: rollB, meters: 2 }],
      idempotency_key: 'v621-multi-b',
    }, user);
    ok('لایه B پارچهٔ غیر اصلی را ذخیره می‌کند', Number(layB.fabric_product_id) === fabricB);
    eq('طاقه B واقعاً مصرف شده', rollQty(rollB), bBefore - 2, 1e-9);
    cutStage = db.prepare('SELECT * FROM production_order_stages WHERE id=?').get(cutStage.id);
    poRow = db.prepare('SELECT * FROM production_orders WHERE id=?').get(po.id);
    coverage = advanced.cuttingStageCoverage(db, poRow, cutStage);
    ok('پس از B پوشش کامل است', coverage.covered === true, coverage.message);
    ok('پس از B مرحله خودکار done است', cutStage.status === 'done', cutStage.status);
    eq('دو لایه N قطعه‌ای جمع نمی‌شوند؛ MIN=N', cutting.cuttingQtyForOrder(db, po.id).lay_qty, N);
    const fabricCoverage = cutting.cuttingFabricCoverage(db, poRow);
    ok('پوشش پارچه هر دو را covered می‌داند',
      fabricCoverage.fabrics.length === 2 && fabricCoverage.fabrics.every((x) => x.covered));

    cutting.voidCuttingLay(db, layB.id, user, { reason: 'آزمون R13 پارچه دوم v621' });
    eq('ابطال B طاقه را کامل برمی‌گرداند', rollQty(rollB), bBefore, 1e-9);
    cutStage = db.prepare('SELECT * FROM production_order_stages WHERE id=?').get(cutStage.id);
    poRow = db.prepare('SELECT * FROM production_orders WHERE id=?').get(po.id);
    coverage = advanced.cuttingStageCoverage(db, poRow, cutStage);
    ok('پس از ابطال B پوشش دوباره false است', coverage.covered === false);
    ok('پس از ابطال B مرحله باز است', cutStage.status !== 'done', cutStage.status);
    ok('پس از ابطال B دوباره missing است',
      coverage.missing_fabrics.some((x) => Number(x.product_id) === fabricB));
    eq('پس از ابطال B MIN دوباره صفر است', cutting.cuttingQtyForOrder(db, po.id).lay_qty, 0);

    // رگرسیون تک‌پارچه: رفتار قدیمی SUM حفظ می‌شود و همان یک لایه مرحله را می‌بندد.
    const fgSingle = product('هودی تک‌پارچه v621', 'V621-FG-SINGLE', 'عدد', 'finished', true, 0);
    ensureSize(fgSingle, '38', 1);
    ensureSize(fgSingle, '40', 2);
    const fabricC = product('ملانژ تک v621', 'V621-FAB-C', 'متر', 'raw', false);
    const rollC = makeRoll(fabricC, 20);
    const singleBom = makeRoutedBom({
      fgId: fgSingle,
      name: 'BOM تک‌پارچه v621',
      fabrics: [{ productId: fabricC, qty: 1, matrix: { 38: 1, 40: 1 } }],
    });
    const poSingle = engine.createOrder(db, {
      product_id: fgSingle,
      bom_id: singleBom.id,
      qty_planned: 4,
      analysis_type: 'variable_adv',
      date: '1405/08/12',
      warehouse_raw_id: raw.id,
      warehouse_fg_id: fgWh.id,
      cost_center_id: ccCut.id,
    }, admin.id);
    engine.releaseOrder(db, poSingle.id, admin.id);
    const singleLay = cutting.postCuttingLay(db, {
      product_id: fgSingle,
      bom_id: singleBom.id,
      production_order_id: poSingle.id,
      fabric_product_id: fabricC,
      warehouse_id: raw.id,
      color: 'مشکی',
      width_cm: 150,
      marker_length_m: 1,
      ply_count: 4,
      actual_meters: 4,
      size_breakdown: { 38: 2, 40: 2 },
      rolls: [{ batch_id: rollC, meters: 4 }],
      date: '1405/08/12',
      idempotency_key: 'v621-single-c',
    }, user);
    const singlePoRow = db.prepare('SELECT * FROM production_orders WHERE id=?').get(poSingle.id);
    const singleStage = advanced.resolveCuttingStage(db, poSingle.id);
    const singleCoverage = advanced.cuttingStageCoverage(db, singlePoRow, singleStage);
    ok('تک‌پارچه با یک لایه covered است', singleCoverage.covered === true);
    eq('تک‌پارچه lay_qty همان ۴ است', cutting.cuttingQtyForOrder(db, poSingle.id).lay_qty, 4);
    ok('تک‌پارچه مرحله done می‌شود',
      db.prepare('SELECT status FROM production_order_stages WHERE id=?').get(singleStage.id).status === 'done');
    ok('لایه تک‌پارچه ثبت شده', singleLay && singleLay.status === 'posted');

    dbOk = true;
  } finally {
    cleanup();
  }
} catch (e) {
  if (/bindings|better_sqlite3|NODE_MODULE_VERSION/i.test(String(e && e.message) + e)) {
    console.log('  SKIP db path: better-sqlite3 not loaded on this Node');
    ok('db path skipped (static assertions still ran)', true);
  } else {
    ok('db fixture/contract path', false, e && (e.stack || e.message) || String(e));
  }
}
if (dbOk) ok('db multi-fabric path completed', true);

summary('multi-fabric-lay-v621');
