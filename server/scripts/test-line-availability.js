#!/usr/bin/env node
/**
 * v580 invoice-stock-display Phase 1 — unified sellable quantity (server, read-only).
 *
 * Fixture reproduces product 131 «بارونی مموری 110» from the 25-Oct audit DB:
 *   warehouse 34 / 35 (کیمیا), variant 421 (vws 1/1), 422 (vws 3/1), ws 11/14,
 *   kardex 27/14 (duplicate opening 13+16−2), movements only in warehouse 34,
 *   default variant 412 with product_variants.stock=32 (header sum 57).
 *
 *  1. on_hand variant = vws of THAT SKU (1/1) — not group sum 4/2, not 32/57
 *  2. product-level on_hand = warehouse_stock (11/14); kardex 27/14; drift only where they differ
 *  3. variant drift_variant (vws vs inventory_movements) → warehouse 35 has no movements
 *  4. own_doc_qty add-back: deducted normal invoice (effective wh = row.warehouse_id || header)
 *  5. proforma / not deducted / reversed / deleted → own_doc_qty = 0
 *  6. active reservation lowers available (product scope for variant rows)
 *  7. legacy stock-by-warehouse API keeps qty === on_hand (+ kardex fields, source=kardex)
 *  8. POST /line-availability/batch: RBAC, limits, exclude_invoice_id access, read-only
 *
 * Isolated temp DB. Run with Node 20 (better-sqlite3).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'line-avail-v580-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'test-line-avail-v580-secret-32chars!!!!';
process.env.AUTH_SESSION_DB_PATH = path.join(tmp, 'sessions.db');
process.env.NODE_ENV = 'test';
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const { getDB, initDB } = require('../db');
initDB();
const db = getDB();

const { lineAvailability, lineAvailabilityBatch } = require('../lib/inventory/line-availability');

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
let txSeq = 0;
function led(o) {
  txSeq += 1;
  return insert('inventory_ledger', {
    tx_no: `LA-${txSeq}`, event_type: 'receipt', status: 'posted', source_type: 'manual_test', source_id: 9000 + txSeq,
    qty_in: 0, qty_out: 0, amount_rial: 0, unit_cost_rial: 0, date: '1405/05/01', note: 'تست', ...o,
  });
}

async function main() {
  console.log('\n=== line availability v580 (invoice-stock-display phase 1) ===\n');
  const adminId = Number(insert('users', { name: 'مدیر', username: 'la_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0 }));
  const salesAId = Number(insert('users', { name: 'فروش الف', username: 'la_sales_a', password: 'x', role: 'sales', active: 1, must_change_password: 0 }));
  const salesBId = Number(insert('users', { name: 'فروش ب', username: 'la_sales_b', password: 'x', role: 'sales', active: 1, must_change_password: 0 }));
  const noRepId = Number(insert('users', { name: 'بدون دسترسی', username: 'la_norep', password: 'x', role: 'sales', active: 1, must_change_password: 0 }));
  const setPerm = db.prepare('INSERT OR REPLACE INTO user_permissions (user_id,resource,action,allowed) VALUES (?,?,?,?)');
  setPerm.run(noRepId, 'reports', 'view', 0);
  setPerm.run(noRepId, 'acc_warehouse_ops', 'view', 0);
  setPerm.run(noRepId, 'invoices', 'create', 0);

  const wh34 = Number(insert('warehouses', { name: 'انبار محصول', code: 'LA-34', active: 1, allow_negative: 0, warehouse_type: 'finished_goods', inventory_system: 'perpetual' }));
  const wh35 = Number(insert('warehouses', { name: 'کیمیا', code: 'LA-35', active: 1, allow_negative: 0, warehouse_type: 'finished_goods', inventory_system: 'perpetual' }));
  const whOff = Number(insert('warehouses', { name: 'انبار غیرفعال', code: 'LA-OFF', active: 0, allow_negative: 0, warehouse_type: 'finished_goods', inventory_system: 'perpetual' }));
  const custId = Number(insert('customers', { user_id: adminId, biz: 'مشتری تست', owner: 'م' }));

  const mk = (name, code, extra = {}) => Number(insert('products', {
    user_id: adminId, name, code, price: 5000000, cost: 1000, average_cost_rial: 1000, stock: 0, warehouse_id: wh34, unit: 'عدد', ...extra,
  }));
  const color = (n) => Number(insert('product_colors', { name: n, code: 'LA' + n, active: 1 }));
  const size = (n) => Number(insert('product_sizes', { name: n, code: 'LAS' + n, active: 1 }));
  const vwsSet = db.prepare('INSERT OR REPLACE INTO variant_warehouse_stock (variant_id,warehouse_id,qty) VALUES (?,?,?)');
  const wsSet = db.prepare('INSERT OR REPLACE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)');
  const mv = (pid, vid, wh, q) => insert('inventory_movements', { product_id: pid, variant_id: vid, warehouse_id: wh, qty_delta: q, doc_type: 'test_fixture', doc_id: null, note: 'fixture' });

  // ── product 131 fixture ─────────────────────────────────────────────────────
  const p131 = mk('بارونی مموری 110', 'LA-131');
  const olive = color('زیتونی');
  const s1 = size('سایز1');
  const s2 = size('سایز2');
  const s3 = size('سایز3');
  // Stock single source: every figure is a LEDGER document (receipt rows stamped with variant_id).
  // warehouse_stock / variant_warehouse_stock / *.stock are derived caches (rebuilt by postInventoryMovement).
  // The old fixture also forged cache-vs-kardex DRIFT (header 57, ws 11/14 vs kardex 27/14); that state can no
  // longer exist — the assertions below carry the SSOT expectation (one number in every layer).
  const { seedStock } = require('./lib/stock-fixture');
  const v412 = Number(insert('product_variants', { product_id: p131, color_id: null, size_id: null, sku: 'LA-131-DEF', stock: 0, active: 1, is_default: 1 }));
  const v421 = Number(insert('product_variants', { product_id: p131, color_id: olive, size_id: s1, sku: 'LA-131-O1', stock: 0, active: 1, is_default: 0 }));
  const v422 = Number(insert('product_variants', { product_id: p131, color_id: olive, size_id: s2, sku: 'LA-131-O2', stock: 0, active: 1, is_default: 0 }));
  const v423 = Number(insert('product_variants', { product_id: p131, color_id: olive, size_id: s3, sku: 'LA-131-O3', stock: 0, active: 1, is_default: 0 }));
  // 421: 1/1 · 422: 3/1 · 423: 7/12 → product 11 / 14
  seedStock(db, { productId: p131, variantId: v421, warehouseId: wh34, qty: 1 }); seedStock(db, { productId: p131, variantId: v421, warehouseId: wh35, qty: 1 });
  seedStock(db, { productId: p131, variantId: v422, warehouseId: wh34, qty: 3 }); seedStock(db, { productId: p131, variantId: v422, warehouseId: wh35, qty: 1 });
  seedStock(db, { productId: p131, variantId: v423, warehouseId: wh34, qty: 7 }); seedStock(db, { productId: p131, variantId: v423, warehouseId: wh35, qty: 12 });
  // movements only in warehouse 34 (kimia has stock without any inventory_movements document)
  mv(p131, v421, wh34, 1); mv(p131, v422, wh34, 3); mv(p131, v423, wh34, 7);
  const byWh = (arr, id) => arr.find((r) => r.warehouse_id === id);

  // ── 1) variant on_hand = that SKU's vws ──────────────────────────────────────
  console.log('— 1) variant on_hand (vws of the SKU) —');
  const a421 = lineAvailability(db, { productId: p131, variantId: v421 });
  const activeN = db.prepare('SELECT COUNT(*) c FROM warehouses WHERE active=1').get().c;
  ok(a421.length === activeN && byWh(a421, wh34) && byWh(a421, wh35) && !byWh(a421, whOff), 'only active warehouses returned (inactive excluded)', a421.map((r) => r.warehouse_id));
  ok(byWh(a421, wh34).on_hand === 1 && byWh(a421, wh35).on_hand === 1, '421 → on_hand 1 / 1 (not group 4/2, not 32/57)', a421.map((r) => r.on_hand));
  ok(byWh(a421, wh34).source === 'vws', 'source = vws');
  const a422 = lineAvailability(db, { productId: p131, variantId: v422 });
  ok(byWh(a422, wh34).on_hand === 3 && byWh(a422, wh35).on_hand === 1, '422 → 3 / 1', a422.map((r) => r.on_hand));
  const a412 = lineAvailability(db, { productId: p131, variantId: v412 });
  ok(a412.every((r) => r.on_hand === 0), 'default variant 412 (product_variants.stock=32) → 0 in a specified warehouse (no global fallback)', a412.map((r) => r.on_hand));
  ok(byWh(a421, wh34).available === 1 && byWh(a421, wh34).own_doc_qty === 0 && byWh(a421, wh34).reserved === 0, 'no edit/reservation → available = on_hand');

  // ── 2) product level + kardex drift ─────────────────────────────────────────
  console.log('\n— 2) product level on_hand + kardex drift —');
  const aP = lineAvailability(db, { productId: p131 });
  ok(byWh(aP, wh34).on_hand === 11 && byWh(aP, wh35).on_hand === 14 && byWh(aP, wh34).source === 'warehouse_stock', 'product on_hand = warehouse_stock 11 / 14', aP.map((r) => r.on_hand));
  ok(byWh(aP, wh34).kardex_qty === 11 && byWh(aP, wh35).kardex_qty === 14, 'kardex 11 / 14 (SSOT: same documents → same number as ws)', aP.map((r) => r.kardex_qty));
  ok(byWh(aP, wh34).drift === false && byWh(aP, wh34).drift_product === false && byWh(aP, wh34).drift_qty === 0, 'warehouse 34: no product drift (ws derived from the ledger: 11 = 11)', byWh(aP, wh34));
  ok(byWh(aP, wh35).drift === false && byWh(aP, wh35).layer_note === '', 'warehouse 35: aligned (14 vs 14) → no drift, empty note', byWh(aP, wh35));
  ok(byWh(aP, wh34).layer_note === '', 'layer_note empty (nothing to explain under SSOT)', byWh(aP, wh34).layer_note);
  ok(aP.every((r) => r.movements_qty === null && r.reserved_scope === 'product_warehouse'), 'product rows: no movements_qty, reserved_scope product_warehouse');

  // ── 3) variant drift (vws vs movements) ─────────────────────────────────────
  console.log('\n— 3) variant drift vs inventory_movements —');
  ok(byWh(a421, wh34).movements_qty === 1 && byWh(a421, wh34).drift_variant === false, '421@34: vws 1 = movements 1', byWh(a421, wh34));
  ok(byWh(a421, wh34).drift_product === false && byWh(a421, wh34).drift === false, '421@34: no product-level drift (ws = ledger = 11)');
  ok(byWh(a421, wh35).movements_qty === 0 && byWh(a421, wh35).drift_variant === true, '421@35: vws 1 but no movements → drift_variant', byWh(a421, wh35));
  ok(byWh(a421, wh35).drift === false && byWh(a421, wh35).drift_product === false, '421@35: drift_variant is informational → drift stays false', byWh(a421, wh35));
  ok(/بدون سند حرکت/.test(byWh(a421, wh35).variant_info_note) && /^ℹ/.test(byWh(a421, wh35).variant_info_note) && !/⚠/.test(byWh(a421, wh35).variant_info_note),
    'variant text moved to variant_info_note (ℹ, no ⚠)', byWh(a421, wh35).variant_info_note);
  ok(!/بدون سند حرکت/.test(byWh(a421, wh35).layer_note) && byWh(a421, wh35).layer_note === '', 'layer_note no longer carries the variant drift text', byWh(a421, wh35).layer_note);
  ok(byWh(a421, wh34).variant_info_note === '', '421@34 (consistent) → empty variant_info_note');
  ok(byWh(a421, wh35).on_hand === 1 && byWh(a421, wh35).available === 1 && byWh(a421, wh35).reserved === 0, 'drift never changes the number');
  ok(a421.every((r) => r.variant_layer_mismatch === false && r.block_reason === null && r.block_note === ''), 'p131 has stocked SKUs → no variant-layer mismatch');
  ok(byWh(a421, wh34).stocked_sku_count === 3 && byWh(aP, wh35).stocked_sku_count === 3, 'stocked_sku_count = 3 SKUs with vws > 0', a421.map((r) => r.stocked_sku_count));

  // ── 4) own_doc_qty add-back ─────────────────────────────────────────────────
  console.log('\n— 4) own_doc_qty (edit mode) —');
  const mkInv = (extra, rows) => Number(insert('invoices', {
    user_id: salesAId, cust_id: custId, num: 'LA-' + Math.random().toString(36).slice(2, 8), type: 'normal', date: '1405/05/02',
    rows: JSON.stringify(rows), stock_deducted: 1, warehouse_id: wh34, ...extra,
  }));
  const rowsEdit = [
    { product_id: p131, variant_id: v421, qty: 1 },                       // header warehouse 34
    { product_id: p131, variant_id: v422, qty: 2, warehouse_id: wh35 },   // row warehouse 35
    { product_id: p131, variant_id: v421, qty: 2, warehouse_id: wh34 },   // same SKU, second line → sums to 3
    { product_id: p131, row_type: 'income', qty: 9 },                     // ignored
  ];
  const invEdit = mkInv({}, rowsEdit);
  const e421 = lineAvailability(db, { productId: p131, variantId: v421, excludeInvoiceId: invEdit });
  ok(byWh(e421, wh34).own_doc_qty === 3 && byWh(e421, wh34).available === 1 + 3, '421@34 own 3 (1+2 lines) → available on_hand+3 = 4', byWh(e421, wh34));
  ok(byWh(e421, wh35).own_doc_qty === 0 && byWh(e421, wh35).available === 1, '421@35 own 0');
  const e422 = lineAvailability(db, { productId: p131, variantId: v422, excludeInvoiceId: invEdit });
  ok(byWh(e422, wh35).own_doc_qty === 2 && byWh(e422, wh35).available === 1 + 2, '422@35 uses ROW warehouse (not header) → own 2, available 3', byWh(e422, wh35));
  ok(byWh(e422, wh34).own_doc_qty === 0, '422@34 own 0');
  const eP = lineAvailability(db, { productId: p131, excludeInvoiceId: invEdit });
  ok(byWh(eP, wh34).own_doc_qty === 3 && byWh(eP, wh35).own_doc_qty === 2, 'product level own = all variant lines of the product per warehouse (3 / 2)', eP.map((r) => r.own_doc_qty));
  ok(byWh(eP, wh34).available === 11 + 3, 'product level available = ws + own');
  const noExcl = lineAvailability(db, { productId: p131, variantId: v421 });
  ok(byWh(noExcl, wh34).own_doc_qty === 0, 'without exclude_invoice_id → own 0');
  const otherInv = mkInv({}, [{ product_id: p131, variant_id: v421, qty: 1 }]);
  ok(byWh(lineAvailability(db, { productId: p131, variantId: v422, excludeInvoiceId: otherInv }), wh34).own_doc_qty === 0, 'other SKU of another invoice → 0');

  // ── 5) not-counted invoices ─────────────────────────────────────────────────
  console.log('\n— 5) proforma / undeducted / reversed / deleted → 0 —');
  const row1 = [{ product_id: p131, variant_id: v421, qty: 1 }];
  const own0 = (id) => byWh(lineAvailability(db, { productId: p131, variantId: v421, excludeInvoiceId: id }), wh34).own_doc_qty;
  ok(own0(mkInv({ type: 'proforma' }, row1)) === 0, 'proforma → 0');
  ok(own0(mkInv({ stock_deducted: 0 }, row1)) === 0, 'stock_deducted=0 → 0');
  const invCols = new Set(db.prepare('PRAGMA table_info(invoices)').all().map((c) => c.name));
  if (invCols.has('status')) ok(own0(mkInv({ status: 'reversed' }, row1)) === 0, 'reversed → 0');
  else ok(true, 'invoices.status column absent on this schema (reversed check n/a)');
  ok(own0(mkInv({ deleted_at: 1700000000 }, row1)) === 0, 'deleted_at set → 0');
  ok(own0(987654) === 0, 'unknown invoice id → 0 (lib never throws)');
  ok(own0(mkInv({ warehouse_id: null }, row1)) === 1, 'no header + no row warehouse → falls back to product header warehouse (34)');

  // ── 6) reservations ─────────────────────────────────────────────────────────
  console.log('\n— 6) reservations —');
  insert('inventory_reservations', { reservation_no: 'LA-RSV-1', kind: 'sales', product_id: p131, warehouse_id: wh34, qty: 2, status: 'active' });
  insert('inventory_reservations', { reservation_no: 'LA-RSV-2', kind: 'sales', product_id: p131, warehouse_id: wh34, qty: 5, qty_released: 5, status: 'released' });
  insert('inventory_reservations', { reservation_no: 'LA-RSV-3', kind: 'sales', product_id: p131, warehouse_id: wh34, qty: 4, qty_consumed: 1, status: 'active' });
  const rP = lineAvailability(db, { productId: p131 });
  ok(byWh(rP, wh34).reserved === 5 && byWh(rP, wh34).available === 11 - 5, 'active 2 + (4−1 consumed) = 5 reserved; released ignored → available 6', byWh(rP, wh34));
  ok(byWh(rP, wh35).reserved === 0 && byWh(rP, wh35).available === 14, 'other warehouse untouched');
  const rV = lineAvailability(db, { productId: p131, variantId: v421 });
  ok(byWh(rV, wh34).reserved === 5 && byWh(rV, wh34).reserved_scope === 'product' && byWh(rV, wh34).available === 1 - 5, 'variant row: reserved at PRODUCT scope, flagged reserved_scope=product', byWh(rV, wh34));
  const rE = lineAvailability(db, { productId: p131, variantId: v421, excludeInvoiceId: invEdit });
  ok(byWh(rE, wh34).available === 1 - 5 + 3, 'available = on_hand − reserved + own_doc', byWh(rE, wh34));
  db.prepare("UPDATE inventory_reservations SET status='released', qty_released=qty WHERE product_id=?").run(p131);

  // ── 7) legacy + warehouseIds filter ─────────────────────────────────────────
  console.log('\n— 7) legacy header fallback / warehouseIds —');
  // deliberate stale header cache (products.stock=5, no ledger doc): SSOT says the ledger decides → 0.
  const pLeg = mk('کالای قدیمی بدون ردیف انبار', 'LA-LEG', { stock: 5, warehouse_id: wh34 });
  const aLeg = lineAvailability(db, { productId: pLeg });
  ok(byWh(aLeg, wh34).on_hand === 0 && byWh(aLeg, wh34).legacy_header_fallback === false, 'SSOT: no ledger document → 0 (a bare header figure is no longer a fallback source)', byWh(aLeg, wh34));
  ok(byWh(aLeg, wh35).on_hand === 0 && byWh(aLeg, wh35).legacy_header_fallback === false, 'other warehouse → 0');
  const only35 = lineAvailability(db, { productId: p131, variantId: v422, warehouseIds: [wh35] });
  ok(only35.length === 1 && only35[0].warehouse_id === wh35, 'warehouseIds filter');
  ok(lineAvailability(db, { productId: 0 }).length === 0 && lineAvailability(db, {}).length === 0, 'invalid product → []');
  const bt = lineAvailabilityBatch(db, [{ product_id: p131, variant_id: v421 }, { product_id: p131 }, { product_id: 'x' }, { product_id: p131, variant_id: v422 }]);
  ok(bt.length === 3 && bt[0].variant_id === v421 && bt[1].variant_id === null, 'batch skips invalid items, keeps order', bt.map((b) => [b.product_id, b.variant_id]));

  // ── 7b) variant-layer mismatch ──────────────────────────────────────────────
  console.log('\n— 7b) variant-layer mismatch —');
  const pMis = mk('مانتو بدون تفکیک رنگ', 'LA-MIS');
  seedStock(db, { productId: pMis, warehouseId: wh34, qty: 5 }); // product-level receipt before the matrix existed
  const vMis1 = Number(insert('product_variants', { product_id: pMis, color_id: olive, size_id: s1, sku: 'LA-MIS-1', stock: 0, active: 1, is_default: 0 }));
  insert('product_variants', { product_id: pMis, color_id: olive, size_id: s2, sku: 'LA-MIS-2', stock: 0, active: 1, is_default: 0 });
  vwsSet.run(vMis1, wh34, 0);
  const mV = lineAvailability(db, { productId: pMis, variantId: vMis1 });
  ok(byWh(mV, wh34).variant_layer_mismatch === true && byWh(mV, wh34).stocked_sku_count === 0 && byWh(mV, wh34).block_reason === 'variant_layer_mismatch',
    'vws all 0 + warehouse_stock 5 → variant_layer_mismatch', byWh(mV, wh34));
  ok(/ناهمخوانی لایهٔ رنگ\/سایز/.test(byWh(mV, wh34).block_note) && /variant layer mismatch/.test(byWh(mV, wh34).block_note), 'block_note Persian + English tag', byWh(mV, wh34).block_note);
  ok(byWh(mV, wh34).on_hand === 0 && byWh(mV, wh34).available === 0, 'variant numbers unchanged (0)');
  ok(byWh(mV, wh35).variant_layer_mismatch === false && byWh(mV, wh35).block_reason === null, 'other warehouse (ws 0) → no mismatch');
  const mP = lineAvailability(db, { productId: pMis });
  ok(byWh(mP, wh34).variant_layer_mismatch === true && byWh(mP, wh34).on_hand === 5 && byWh(mP, wh34).available === 5,
    'product row of matrix product also flagged; on_hand/available stay 5', byWh(mP, wh34));
  ok(byWh(mP, wh34).drift === false && byWh(mP, wh34).layer_note === '', 'mismatch is not drift (layer_note untouched)', byWh(mP, wh34));
  const plainP = lineAvailability(db, { productId: pLeg });
  ok(plainP.every((r) => r.variant_layer_mismatch === false && r.stocked_sku_count === null), 'non-matrix product → no flag, stocked_sku_count null');

  // ── 8) HTTP ─────────────────────────────────────────────────────────────────
  console.log('\n— 8) HTTP + RBAC —');
  const express = require('express');
  const http = require('http');
  const { issueStaffSession } = require('../lib/auth-sessions');
  const tokenFor = (uid, tag) => issueStaffSession(db, db.prepare('SELECT * FROM users WHERE id=?').get(uid), {
    device_kind: 'test', device_name: 'la-' + tag, device_fingerprint: 'la-fp-' + tag,
  }).token;
  const tok = { admin: tokenFor(adminId, 'admin'), salesA: tokenFor(salesAId, 'a'), salesB: tokenFor(salesBId, 'b'), norep: tokenFor(noRepId, 'norep') };
  const app = express();
  app.use(express.json());
  app.use('/api/inventory', require('../routes/inventory'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  async function api(method, p, body, who = 'admin') {
    const headers = { 'Content-Type': 'application/json' };
    if (who) headers.Authorization = 'Bearer ' + tok[who];
    const res = await fetch(BASE + p, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, data };
  }
  const snapshot = () => ['warehouse_stock', 'variant_warehouse_stock', 'inventory_ledger', 'inventory_movements', 'inventory_reservations', 'products', 'invoices', 'sync_outbox']
    .map((t) => { try { return db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch (_) { return -1; } }).join(',')
    + '|' + db.prepare('SELECT COALESCE(SUM(qty),0) s FROM warehouse_stock').get().s
    + ':' + db.prepare('SELECT COALESCE(SUM(qty),0) s FROM variant_warehouse_stock').get().s
    + ':' + db.prepare('SELECT COALESCE(SUM(stock),0) s FROM products').get().s;
  const before = snapshot();

  // legacy API unchanged (qty === on_hand)
  const sbwP = await api('GET', `/api/inventory/stock-by-warehouse?product_id=${p131}`);
  const wP = sbwP.data && sbwP.data.warehouses;
  ok(sbwP.status === 200 && wP.length === db.prepare('SELECT COUNT(*) c FROM warehouses WHERE active=1').get().c, 'legacy GET stock-by-warehouse 200 (all active warehouses)', sbwP.status);
  ok(byWh(wP, wh34).qty === 11 && byWh(wP, wh35).qty === 14 && byWh(wP, wh34).source === 'warehouse_stock', 'legacy product qty = 11 / 14 (on_hand)', wP);
  ok(byWh(wP, wh34).kardex_qty === 11 && byWh(wP, wh34).drift === false && byWh(wP, wh34).drift_qty === 0 && byWh(wP, wh34).declared_source === 'kardex' && byWh(wP, wh35).drift === false,
    'legacy product keeps kardex_qty / drift / drift_qty / declared_source', byWh(wP, wh34));
  ok(byWh(wP, wh34).kardex_value_rial === 11000 && Math.round(byWh(wP, wh34).weighted_avg_unit_rial) === 1000, 'legacy kardex value + weighted avg preserved', byWh(wP, wh34));
  ok(!('on_hand' in wP[0]) && !('available' in wP[0]), 'legacy shape unchanged (no new keys)');
  const sbwK = await api('GET', `/api/inventory/stock-by-warehouse?product_id=${p131}&source=kardex`);
  ok(byWh(sbwK.data.warehouses, wh34).qty === 11 && byWh(sbwK.data.warehouses, wh34).source === 'kardex', 'legacy source=kardex → qty 11');
  const sbwV = await api('GET', `/api/inventory/stock-by-warehouse?product_id=${p131}&variant_id=${v421}`);
  ok(byWh(sbwV.data.warehouses, wh34).qty === 1 && byWh(sbwV.data.warehouses, wh35).qty === 1 && byWh(sbwV.data.warehouses, wh34).source === 'vws' && !('kardex_qty' in sbwV.data.warehouses[0]),
    'legacy variant qty = vws 1 / 1, no kardex keys', sbwV.data);
  const sbwB = await api('POST', '/api/inventory/stock-by-warehouse/batch', { items: [{ product_id: p131 }, { product_id: p131, variant_id: v422 }] });
  ok(sbwB.status === 200 && sbwB.data.results.length === 2 && byWh(sbwB.data.results[1].warehouses, wh34).qty === 3, 'legacy batch still works (422 → 3)', sbwB.data);

  // new endpoint
  const nb = await api('POST', '/api/inventory/line-availability/batch', { items: [{ product_id: p131, variant_id: v421 }, { product_id: p131 }] });
  ok(nb.status === 200 && nb.data.results.length === 2 && nb.data.exclude_invoice_id === null, 'POST line-availability/batch 200', nb);
  ok(byWh(nb.data.results[0].warehouses, wh34).on_hand === 1 && byWh(nb.data.results[1].warehouses, wh34).on_hand === 11, 'batch values: 421 → 1, product → 11');
  const nbEdit = await api('POST', '/api/inventory/line-availability/batch', { items: [{ product_id: p131, variant_id: v421 }], exclude_invoice_id: invEdit }, 'salesA');
  ok(nbEdit.status === 200 && byWh(nbEdit.data.results[0].warehouses, wh34).own_doc_qty === 3 && byWh(nbEdit.data.results[0].warehouses, wh34).available === 4, 'owner sales may use own invoice → add-back 3', nbEdit);
  const nbForbid = await api('POST', '/api/inventory/line-availability/batch', { items: [{ product_id: p131, variant_id: v421 }], exclude_invoice_id: invEdit }, 'salesB');
  ok(nbForbid.status === 403 && nbForbid.data.code === 'E_INVOICE_FORBIDDEN', 'other sales user cannot exclude someone else’s invoice → 403', nbForbid);
  const nbPlain = await api('POST', '/api/inventory/line-availability/batch', { items: [{ product_id: p131, variant_id: v421 }] }, 'salesB');
  ok(nbPlain.status === 200, 'same user without exclude_invoice_id → 200 (stock gate only)');
  const nbAdmin = await api('POST', '/api/inventory/line-availability/batch', { items: [{ product_id: p131, variant_id: v421 }], exclude_invoice_id: invEdit }, 'admin');
  ok(nbAdmin.status === 200 && byWh(nbAdmin.data.results[0].warehouses, wh34).own_doc_qty === 3, 'admin may use any invoice');
  const nb404 = await api('POST', '/api/inventory/line-availability/batch', { items: [], exclude_invoice_id: 987654 });
  ok(nb404.status === 404 && nb404.data.code === 'E_INVOICE_NOT_FOUND', 'unknown exclude_invoice_id → 404');
  const nbBad = await api('POST', '/api/inventory/line-availability/batch', { items: [], exclude_invoice_id: 'abc' });
  ok(nbBad.status === 400 && nbBad.data.code === 'E_EXCLUDE_INVOICE_INVALID', 'garbage exclude_invoice_id → 400');
  const nbNo = await api('POST', '/api/inventory/line-availability/batch', {});
  ok(nbNo.status === 400 && nbNo.data.code === 'E_ITEMS_REQUIRED', 'missing items → 400');
  const items101 = Array.from({ length: 101 }, () => ({ product_id: p131 }));
  const nbMax = await api('POST', '/api/inventory/line-availability/batch', { items: items101 });
  ok(nbMax.status === 400 && nbMax.data.code === 'E_ITEMS_LIMIT', '101 items → 400');
  const items100 = Array.from({ length: 100 }, () => ({ product_id: p131, variant_id: v421 }));
  const nb100 = await api('POST', '/api/inventory/line-availability/batch', { items: items100 });
  ok(nb100.status === 200 && nb100.data.results.length === 100, '100 items → 200');
  const nbNoAuth = await api('POST', '/api/inventory/line-availability/batch', { items: [] }, null);
  ok(nbNoAuth.status === 401, 'no token → 401', nbNoAuth.status);
  const nbNoRep = await api('POST', '/api/inventory/line-availability/batch', { items: [{ product_id: p131 }] }, 'norep');
  ok(nbNoRep.status === 403, 'user without reports/warehouse-ops/invoice-create → 403 (same gate as stock-by-warehouse)', nbNoRep.status);
  ok(snapshot() === before, 'all reads left the database untouched (counts + sums + empty outbox)', before + ' vs ' + snapshot());

  // sync hygiene: read-only POST is blocklisted so a device never replays it
  const { BLOCKLIST } = require('../sync/capture');
  ok(BLOCKLIST.some((p) => '/api/inventory/line-availability/batch'.startsWith(p + '/') || p === '/api/inventory/line-availability/batch'), 'capture BLOCKLIST covers /api/inventory/line-availability/batch');

  server.close();
  console.log(`\nResult: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
