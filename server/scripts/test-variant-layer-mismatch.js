#!/usr/bin/env node
/**
 * Variant-layer mismatch (phantom-sale guard).
 * Run: node server/scripts/test-variant-layer-mismatch.js
 *
 * Mismatch per product × warehouse = active colour×size matrix, no matrix SKU with vws > 0 there,
 * yet the product layer (ledger.warehouseQty) > 0. Such stock must never be sold:
 *   1. variantLayerMismatch helper: flags / no flag when one SKU is stocked / non-matrix product
 *   2. line-availability: variant_layer_mismatch + block_reason/block_note, numbers untouched
 *   3. ATP: E_VARIANT_LAYER_MISMATCH even with allow_negative=1 / forceAllowNegative / backorder
 *   4. normal shortage still E_ATP_INSUFFICIENT; stocked SKU sells
 *   5. HTTP POST /api/invoices → 409 with code + message passthrough, nothing written
 *
 * Isolated temp DB only.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'variant-layer-mismatch-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'test-variant-layer-mismatch-secret-32ch!!';
process.env.AUTH_SESSION_DB_PATH = path.join(tmp, 'sessions.db');
process.env.NODE_ENV = 'test';
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const { getDB, initDB } = require('../db');
initDB();
const db = getDB();

const { variantLayerMismatch } = require('../lib/inventory/variant-layer');
const { lineAvailability, lineAvailabilityBatch } = require('../lib/inventory/line-availability');
const atp = require('../lib/inventory/available-to-promise');
const { seedStock } = require('./lib/stock-fixture');

let pass = 0;
let fail = 0;
function ok(cond, msg, detail) {
  if (cond) { pass += 1; console.log('  ✓', msg); }
  else { fail += 1; console.log('  ✗', msg, detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail))); }
}
function insert(table, obj) {
  const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  const keys = Object.keys(obj).filter((k) => cols.has(k));
  return db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => obj[k])).lastInsertRowid;
}
function catchErr(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

async function main() {
  console.log('\n=== variant-layer mismatch (phantom-sale guard) ===\n');
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('inventory_allow_negative','0')").run();
  const adminId = Number(insert('users', { name: 'مدیر', username: 'vlm_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0 }));
  const custId = Number(insert('customers', { user_id: adminId, biz: 'مشتری تست', owner: 'م', city: 'مشهد', phone: '0511', status: 'active' }));
  const whA = Number(insert('warehouses', { name: 'انبار اصلی', code: 'VLM-A', active: 1, allow_negative: 0, is_default: 1, warehouse_type: 'finished_goods', inventory_system: 'perpetual' }));
  const whN = Number(insert('warehouses', { name: 'انبار منفی‌مجاز', code: 'VLM-N', active: 1, allow_negative: 1, is_default: 0, warehouse_type: 'finished_goods', inventory_system: 'perpetual' }));

  const mk = (name, code) => Number(insert('products', {
    user_id: adminId, name, code, price: 100000, cost: 1000, average_cost_rial: 1000, stock: 0, warehouse_id: whA, unit: 'عدد',
  }));
  const red = Number(insert('product_colors', { name: 'قرمز', code: 'VLM-R', active: 1 }));
  const sM = Number(insert('product_sizes', { name: 'M', code: 'VLM-M', active: 1 }));
  const sL = Number(insert('product_sizes', { name: 'L', code: 'VLM-L', active: 1 }));
  const variant = (pid, sizeId, sku) => Number(insert('product_variants', {
    product_id: pid, color_id: red, size_id: sizeId, sku, stock: 0, active: 1, is_default: 0,
  }));

  // PM: product-level stock (no colour/size attribution) received BEFORE the matrix existed → mismatch in A and N.
  const PM = mk('مانتو ناهمخوان', 'VLM-PM');
  seedStock(db, { productId: PM, warehouseId: whA, qty: 4 });
  seedStock(db, { productId: PM, warehouseId: whN, qty: 3 });
  const VM1 = variant(PM, sM, 'VLM-PM-M');
  const VM2 = variant(PM, sL, 'VLM-PM-L');
  db.prepare('INSERT OR REPLACE INTO variant_warehouse_stock (variant_id,warehouse_id,qty) VALUES (?,?,0)').run(VM1, whA);

  // PS: matrix product, one SKU stocked in A → no mismatch there.
  const PS = mk('مانتو سالم', 'VLM-PS');
  const VS1 = variant(PS, sM, 'VLM-PS-M');
  const VS2 = variant(PS, sL, 'VLM-PS-L');
  seedStock(db, { productId: PS, variantId: VS1, warehouseId: whA, qty: 2 });

  // PP: plain product (no matrix), 1 in A.
  const PP = mk('کالای ساده', 'VLM-PP');
  seedStock(db, { productId: PP, warehouseId: whA, qty: 1 });

  // ── 1) helper ───────────────────────────────────────────────────────────────
  console.log('— 1) variantLayerMismatch helper —');
  const hM = variantLayerMismatch(db, PM, whA);
  ok(hM.mismatch === true && hM.stocked_sku_count === 0 && hM.product_wh_qty === 4, 'PM@A: matrix, vws all 0, ws 4 → mismatch', hM);
  ok(variantLayerMismatch(db, PM, whN).mismatch === true, 'PM@N: mismatch too (no vws rows at all)');
  const hS = variantLayerMismatch(db, PS, whA);
  ok(hS.mismatch === false && hS.stocked_sku_count === 1, 'PS@A: one SKU stocked → no mismatch', hS);
  ok(variantLayerMismatch(db, PS, whN).mismatch === false, 'PS@N: ws 0 → no mismatch (nothing to sell)');
  const hP = variantLayerMismatch(db, PP, whA);
  ok(hP.mismatch === false && hP.has_matrix === false && hP.stocked_sku_count === null, 'PP: no matrix → no mismatch', hP);
  ok(variantLayerMismatch(db, PM, null).mismatch === false, 'no warehouse → no mismatch');

  // ── 2) line-availability ────────────────────────────────────────────────────
  console.log('\n— 2) line-availability flags —');
  const byWh = (arr, id) => arr.find((r) => r.warehouse_id === id);
  const lv = byWh(lineAvailability(db, { productId: PM, variantId: VM1 }), whA);
  ok(lv.variant_layer_mismatch === true && lv.stocked_sku_count === 0, 'variant row PM/M@A flagged', lv);
  ok(lv.block_reason === 'variant_layer_mismatch' && /ناهمخوانی لایهٔ رنگ\/سایز/.test(lv.block_note) && /variant layer mismatch/.test(lv.block_note) && /4/.test(lv.block_note),
    'block_reason + Persian block_note with product qty', lv.block_note);
  ok(lv.on_hand === 0 && lv.available === 0 && lv.product_wh_qty === 4, 'numbers untouched (variant on_hand 0, product_wh_qty 4)', lv);
  const lp = byWh(lineAvailability(db, { productId: PM }), whA);
  ok(lp.variant_layer_mismatch === true && lp.block_reason === 'variant_layer_mismatch' && lp.on_hand === 4 && lp.available === 4,
    'product row of matrix product flagged; on_hand/available stay 4', lp);
  const ls = byWh(lineAvailability(db, { productId: PS, variantId: VS2 }), whA);
  ok(ls.variant_layer_mismatch === false && ls.block_reason === null && ls.block_note === '' && ls.stocked_sku_count === 1,
    'PS (one SKU stocked): no flag even on the empty SKU', ls);
  const lpp = byWh(lineAvailability(db, { productId: PP }), whA);
  ok(lpp.variant_layer_mismatch === false && lpp.stocked_sku_count === null, 'plain product: no flag, stocked_sku_count null', lpp);
  const batch = lineAvailabilityBatch(db, [{ product_id: PM, variant_id: VM1 }, { product_id: PM, variant_id: VM2 }, { product_id: PS }]);
  ok(byWh(batch[0].warehouses, whA).variant_layer_mismatch && byWh(batch[1].warehouses, whA).variant_layer_mismatch && !byWh(batch[2].warehouses, whA).variant_layer_mismatch,
    'batch: memoised per product×warehouse, flags consistent');

  // ── 3) ATP blocks mismatch regardless of negative policy ─────────────────────
  console.log('\n— 3) ATP gate —');
  const line = (pid, qty, extra = {}) => ({ product_id: pid, qty, price: 100000, ...extra });
  const ev = atp.evaluateAvailableToPromise(db, [line(PM, 1, { variant_id: VM1, warehouse_id: whA })], whA, { custId });
  ok(ev.mismatches.length === 1 && ev.shortages[0].reason === 'variant_layer_mismatch' && ev.shortages[0].scope === 'variant_layer',
    'evaluate: mismatch entry sorted first', ev.shortages.map((s) => s.reason || s.scope));
  ok(ev.shortages[0].name === 'مانتو ناهمخوان' && ev.shortages[0].warehouse_name === 'انبار اصلی' && ev.shortages[0].stocked_sku_count === 0,
    'mismatch entry carries describe() fields', ev.shortages[0]);

  let e = catchErr(() => atp.assertAvailableToPromise(db, [line(PM, 1, { variant_id: VM1, warehouse_id: whN })], whN, { custId }));
  ok(e && e.code === 'E_VARIANT_LAYER_MISMATCH' && e.status === 409, 'assert: allow_negative=1 warehouse still → 409 E_VARIANT_LAYER_MISMATCH', e && { code: e.code, msg: e.message });
  ok(e && /ناهمخوانی لایهٔ رنگ\/سایز/.test(e.message) && /variant layer mismatch/.test(e.message) && !/کافی نیست/.test(e.message),
    'message: «ناهمخوانی لایهٔ رنگ/سایز» + "variant layer mismatch", never «کافی نیست»', e && e.message);
  ok(e && /مانتو ناهمخوان/.test(e.message) && /قرمز\/M/.test(e.message) && /انبار منفی‌مجاز/.test(e.message), 'message names product, colour/size and warehouse', e && e.message);
  ok(e && Array.isArray(e.mismatches) && e.mismatches.length === 1 && Array.isArray(e.shortages), 'error carries shortages + mismatches');

  e = catchErr(() => atp.assertAvailableToPromise(db, [line(PM, 1, { warehouse_id: whA })], whA, { custId, forceAllowNegative: true }));
  ok(e && e.code === 'E_VARIANT_LAYER_MISMATCH', 'assert: product-level line + forceAllowNegative → E_VARIANT_LAYER_MISMATCH', e && e.code);

  e = catchErr(() => atp.decideSaleFulfillment(db, {
    rows: [line(PM, 1, { variant_id: VM1, warehouse_id: whA })], headerWarehouseId: whA, custId,
    backorderRequested: true, role: 'admin', forceAllowNegative: true,
  }));
  ok(e && e.code === 'E_VARIANT_LAYER_MISMATCH', 'decide: admin backorder request never converts a mismatch into a backorder', e && e.code);
  e = catchErr(() => atp.decideSaleFulfillment(db, {
    rows: [line(PM, 1, { variant_id: VM1, warehouse_id: whA })], headerWarehouseId: whA, custId, provisional: true,
  }));
  ok(e && e.code === 'E_VARIANT_LAYER_MISMATCH', 'decide: provisional (device) request → E_VARIANT_LAYER_MISMATCH', e && e.code);

  // ── 4) normal shortage + healthy SKU ─────────────────────────────────────────
  console.log('\n— 4) unchanged behaviour —');
  e = catchErr(() => atp.assertAvailableToPromise(db, [line(PP, 2, { warehouse_id: whA })], whA, { custId }));
  ok(e && e.code === 'E_ATP_INSUFFICIENT' && /کافی نیست/.test(e.message) && !e.mismatches, 'plain product over stock → E_ATP_INSUFFICIENT (unchanged)', e && { code: e.code, msg: e.message });
  const okRes = atp.assertAvailableToPromise(db, [line(PS, 1, { variant_id: VS1, warehouse_id: whA })], whA, { custId });
  ok(okRes.shortages.length === 0 && okRes.mismatches.length === 0, 'stocked SKU of healthy matrix product → passes');
  e = catchErr(() => atp.assertAvailableToPromise(db, [line(PS, 1, { variant_id: VS2, warehouse_id: whA })], whA, { custId }));
  ok(e && e.code === 'E_ATP_INSUFFICIENT', 'empty SKU of healthy matrix product → E_ATP_INSUFFICIENT (not mismatch)', e && e.code);
  const mixed = atp.evaluateAvailableToPromise(db, [line(PP, 2, { warehouse_id: whA }), line(PM, 1, { variant_id: VM1, warehouse_id: whA })], whA, { custId });
  ok(mixed.shortages[0].reason === 'variant_layer_mismatch' && mixed.shortages.some((s) => s.product_id === PP), 'mixed invoice: mismatch first, shortage still listed');
  ok(atp.shortageMessage(mixed.shortages[0]) === atp.mismatchMessage(mixed.shortages[0]), 'shortageMessage on a mismatch entry returns the mismatch text');

  // ── 5) HTTP passthrough ─────────────────────────────────────────────────────
  console.log('\n— 5) HTTP POST /api/invoices —');
  const express = require('express');
  const http = require('http');
  const { issueStaffSession } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, db.prepare('SELECT * FROM users WHERE id=?').get(adminId), {
    device_kind: 'test', device_name: 'vlm-admin', device_fingerprint: 'vlm-fp-admin',
  }).token;
  const app = express();
  app.use(express.json());
  app.use('/api/invoices', require('../routes/invoices'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  async function post(body) {
    const res = await fetch(BASE + '/api/invoices', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'X-Client-Request-Id': 'vlm-' + Math.random().toString(36).slice(2) },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, data };
  }
  const invCount = () => db.prepare('SELECT COUNT(*) c FROM invoices').get().c;
  const ledCount = () => db.prepare('SELECT COUNT(*) c FROM inventory_ledger').get().c;
  const before = [invCount(), ledCount()];
  const r = await post({
    cust_id: custId, type: 'normal', date: '1405/07/12', pay_type: 'credit', warehouse_id: whN, backorder: true,
    client_request_id: 'vlm-http-1',
    rows: [line(PM, 1, { variant_id: VM1, warehouse_id: whN })],
  });
  ok(r.status === 409 && r.data && r.data.code === 'E_VARIANT_LAYER_MISMATCH', 'admin + backorder + allow_negative warehouse → 409 E_VARIANT_LAYER_MISMATCH', r);
  ok(r.data && /variant layer mismatch/.test(r.data.error || '') && !/کافی نیست/.test(r.data.error || ''), 'HTTP error text passes through', r.data && r.data.error);
  ok(r.data && Array.isArray(r.data.variant_layer_mismatches) && r.data.variant_layer_mismatches.length === 1 && Array.isArray(r.data.atp_shortages),
    'payload: variant_layer_mismatches + atp_shortages', r.data && Object.keys(r.data));
  ok(invCount() === before[0] && ledCount() === before[1], 'nothing written (invoice/ledger counts unchanged)', [before, invCount(), ledCount()]);

  server.close();
  console.log(`\nResult: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
