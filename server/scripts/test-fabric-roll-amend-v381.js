/**
 * Fabric roll amend v381 — metadata always; financial only when unused;
 * purchase-sourced financial blocked; live-based unused gate.
 * Run: node server/scripts/test-fabric-roll-amend-v381.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-amend-v381-'));
const dbFile = path.join(dir, 't.db');
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-fabric-amend-v381-secret-at-least-32b';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';

delete require.cache[require.resolve('../db')];
try { delete require.cache[require.resolve('../lib/coa-map')]; } catch (_) {}

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const {
  receiveFabricRoll,
  updateFabricRoll,
  voidFabricRoll,
  rollUnused,
  applyLiveRollQty,
  listFabricRolls,
} = require('../lib/inventory/fabric-rolls');
const { postInventoryMovement } = require('../lib/inventory/ledger');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

function expectHttp(fn, status, code) {
  try {
    fn();
    ok(false, 'expected throw ' + (code || status), 'no throw');
    return null;
  } catch (e) {
    ok(e && e.status === status, 'status ' + status + (code ? ' ' + code : ''), e && e.status);
    if (code) ok(e && e.code === code, 'code ' + code, e && e.code);
    return e;
  }
}

(async () => {
  const admin = db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get()
    || db.prepare('SELECT * FROM users LIMIT 1').get();
  ok(!!admin, 'admin user');

  const raw = db.prepare(`
    SELECT * FROM warehouses
    WHERE code='WH-RAW' OR warehouse_type='raw_material' OR kind='raw'
    LIMIT 1
  `).get();
  ok(!!(raw && raw.id), 'WH-RAW');

  let sup = db.prepare('SELECT id FROM suppliers LIMIT 1').get();
  if (!sup) {
    const r = db.prepare(`
      INSERT INTO suppliers (name, phone, coa_code) VALUES ('تأمین تست v381', '', '2101')
    `).run();
    sup = { id: r.lastInsertRowid };
  }

  const prodId = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, average_cost_rial, cost)
    VALUES (?, 'پارچه تست amend v381', 'FAB-V381', 0, 0, 'متر', 10000, 10000)
  `).run(admin.id).lastInsertRowid;

  const roll = receiveFabricRoll(db, {
    product_id: prodId,
    warehouse_id: raw.id,
    color: 'طوسی',
    pattern: 'ساده',
    width_cm: 150,
    meters: 100,
    unit: 'متر',
    unit_cost_rial: 10000,
    supplier_id: sup.id,
    roll_no: 'LOT-V381-A',
    date: '1405/07/01',
    idempotency_key: 'fab-v381-a',
  }, admin);
  ok(!!(roll && roll.id), 'receive roll');
  ok(rollUnused(applyLiveRollQty(db, roll)), 'unused after receive');

  const meta = updateFabricRoll(db, roll.id, {
    color: 'سرمه‌ای',
    pattern: 'راه راه',
    width_cm: 140,
    roll_no: 'LOT-V381-A2',
  }, admin);
  ok(meta.color === 'سرمه‌ای' && meta.pattern === 'راه راه' && Number(meta.width_cm) === 140, 'metadata patch');
  ok(meta.batch_no === 'LOT-V381-A2', 'roll_no rename');
  ok(Number(meta.qty_received) === 100 && Number(meta.unit_cost_rial) === 10000, 'financial untouched on metadata');

  const fin = updateFabricRoll(db, roll.id, {
    color: 'سرمه‌ای',
    meters: 80,
    unit_cost_rial: 12000,
    supplier_id: sup.id,
    date: '1405/07/02',
  }, admin);
  ok(Number(fin.qty_received) === 80 && Number(fin.unit_cost_rial) === 12000, 'financial amend meters/cost');
  const liveFin = applyLiveRollQty(db, fin);
  ok(Math.abs((Number(liveFin.qty_live) || 0) - 80) < 1e-6, 'live=80 after amend', liveFin.qty_live);

  // Simulate consumption: outbound ledger tagged to batch
  postInventoryMovement(db, {
    eventType: 'issue',
    productId: prodId,
    warehouseId: raw.id,
    qtyOut: 20,
    unitCostRial: 12000,
    amountRial: 240000,
    sourceType: 'test_consume',
    sourceId: roll.id,
    batchId: roll.id,
    date: '1405/07/03',
    note: 'مصرف تست v381',
    createdBy: admin.id,
  });
  const afterConsume = applyLiveRollQty(db, db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(roll.id));
  ok(!rollUnused(afterConsume), 'consumed → unused false', afterConsume.qty_live);

  const metaWhileUsed = updateFabricRoll(db, roll.id, {
    color: 'مشکی',
    pattern: 'ساده',
    width_cm: 150,
  }, admin);
  ok(metaWhileUsed.color === 'مشکی', 'metadata allowed while consumed');

  expectHttp(
    () => updateFabricRoll(db, roll.id, {
      color: 'مشکی',
      meters: 90,
      unit_cost_rial: 12000,
      supplier_id: sup.id,
    }, admin),
    409,
    'E_FABRIC_CONSUMED'
  );

  expectHttp(() => voidFabricRoll(db, roll.id, admin, { reason: 'test' }), 409, 'E_FABRIC_CONSUMED');

  // Purchase-sourced identity: financial amend blocked
  const purchProd = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, average_cost_rial, cost)
    VALUES (?, 'پارچه خرید v381', 'FAB-V381-P', 0, 0, 'متر', 5000, 5000)
  `).run(admin.id).lastInsertRowid;
  const purchBatch = db.prepare(`
    INSERT INTO inventory_batches (
      product_id, warehouse_id, batch_no, kind, color, pattern, width_cm, unit,
      unit_cost_rial, supplier_id, qty_received, qty_on_hand, status, source_type, source_id
    ) VALUES (?, ?, 'LOT-V381-P', 'fabric', 'کرم', '', 150, 'm', 5000, ?, 50, 50, 'active', 'purchase', 999001)
  `).run(purchProd, raw.id, sup.id);
  const purchId = purchBatch.lastInsertRowid;
  expectHttp(
    () => updateFabricRoll(db, purchId, {
      color: 'کرم',
      meters: 40,
      unit_cost_rial: 5000,
      supplier_id: sup.id,
    }, admin),
    409,
    'E_FABRIC_PURCHASE_AMEND'
  );
  const purchMeta = updateFabricRoll(db, purchId, { color: 'بژ', width_cm: 145 }, admin);
  ok(purchMeta.color === 'بژ' && Number(purchMeta.width_cm) === 145, 'purchase metadata ok');

  const listed = listFabricRolls(db, {});
  const listedRows = Array.isArray(listed) ? listed : (listed && listed.rows) || [];
  const rowA = listedRows.find((x) => x.id === roll.id);
  ok(!!rowA && rowA.color === 'مشکی', 'list shows edited color', rowA && rowA.color);

  // UI / Help static markers
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  ok(app.includes('ویرایش طاقه (R13)'), 'Help documents fabric edit');
  ok(/fabricRollEditModal\(b\)/.test(app) && /finLocked/.test(app), 'UI always offers edit + lock financial');
  ok(/qty_live/.test(app) && app.includes('مانده زنده'), 'unused gate uses qty_live');

  console.log('\nFabric amend v381: ' + (fail ? '❌ ' : '✅ ') + pass + ' پاس، ' + fail + ' رد');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
