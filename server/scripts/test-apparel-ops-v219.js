#!/usr/bin/env node
'use strict';
/**
 * Production, stocktaking, and consignment follow the variant ledger
 * without moving header stock twice.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apparel-ops-'));
process.env.DB_PATH = path.join(tmpDir, 't.db');
process.env.COMPANIES_DIR = path.join(tmpDir, 'companies');
process.env.ERP_TEST_ISOLATION = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'erp-test-isolation-jwt-secret-32chars!!';
process.env.SYNC_ROLE = 'central';

const { ok, summary } = require('./lib/test-harness');
for (const rel of ['../db', '../lib/inventory/apparel-lines', '../lib/production/costing', '../lib/consignments', '../lib/inventory/cycle-count']) {
  try { delete require.cache[require.resolve(rel)]; } catch (_) {}
}
const dbMod = require('../db');
dbMod.initDB();
const db = dbMod.getDB();
const { resolveApparelLines } = require('../lib/inventory/apparel-lines');
const { issueFromStock } = require('../lib/production/costing');
const { createConsignment, voidConsignment } = require('../lib/consignments');
const { applyCycleCount, voidCycleCount, syncSessionVariantLines } = require('../lib/inventory/cycle-count');

function variantQty(id) {
  return db.prepare('SELECT stock FROM product_variants WHERE id=?').get(id).stock;
}
function headerQty(id) {
  return db.prepare('SELECT stock FROM products WHERE id=?').get(id).stock;
}

try {
  const wh = db.prepare("INSERT INTO warehouses (name, active) VALUES ('اصلی',1)").run().lastInsertRowid;
  const color = db.prepare("INSERT INTO product_colors (name, active, sort_order) VALUES ('مشکی',1,1)").run().lastInsertRowid;
  const sizeA = db.prepare("INSERT INTO product_sizes (name, active, sort_order) VALUES ('38',1,1)").run().lastInsertRowid;
  const sizeB = db.prepare("INSERT INTO product_sizes (name, active, sort_order) VALUES ('40',1,2)").run().lastInsertRowid;
  const userId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
  const pid = db.prepare(
    "INSERT INTO products (user_id, name, code, stock, warehouse_id, average_cost_rial, cost) VALUES (?, 'مانتو','M-1',20,?,1000,100)"
  ).run(userId, wh).lastInsertRowid;
  db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,20)').run(pid, wh);
  const v1 = db.prepare(
    'INSERT INTO product_variants (product_id, color_id, size_id, stock, active, is_default) VALUES (?,?,?,10,1,0)'
  ).run(pid, color, sizeA).lastInsertRowid;
  const v2 = db.prepare(
    'INSERT INTO product_variants (product_id, color_id, size_id, stock, active, is_default) VALUES (?,?,?,10,1,0)'
  ).run(pid, color, sizeB).lastInsertRowid;
  db.prepare('INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,10)').run(v1, wh);
  db.prepare('INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,10)').run(v2, wh);

  let threw = false;
  try { resolveApparelLines(db, { productId: pid, qty: 2 }); }
  catch (e) { threw = e.code === 'E_VARIANT_REQUIRED'; }
  ok(threw, 'matrix without color/size is rejected');

  const lines = resolveApparelLines(db, {
    productId: pid, qty: 3,
    sizeBreakdown: { '38': 1, '40': 2 }, color: 'مشکی',
  });
  ok(lines.length === 2 && lines[0].qty === 1 && lines[1].qty === 2, 'size breakdown maps to two SKUs');

  let issueThrew = false;
  try { issueFromStock(db, { productId: pid, warehouseId: wh, qty: 1, userId: 1 }); }
  catch (e) { issueThrew = e.code === 'E_VARIANT_REQUIRED'; }
  ok(issueThrew && headerQty(pid) === 20, 'production issue does not move header before a variant is named');

  const issued = issueFromStock(db, {
    productId: pid, warehouseId: wh, qty: 1, userId: 1, variantId: v1,
  });
  ok(headerQty(pid) === 19 && variantQty(v1) === 10, 'header drops once and variant waits for the document id');
  require('../lib/inventory/apparel-lines').postApparelLines(db, {
    productId: pid, warehouseId: wh, lines: issued.variantLines,
    docType: 'production_issue', docId: 9001, userId: 1, sign: -1, allowNegative: false,
  });
  ok(variantQty(v1) === 9 && headerQty(pid) === 19, 'variant layer does not drop the header again');

  const plain = db.prepare(
    "INSERT INTO products (user_id, name, code, stock, warehouse_id) VALUES (?, 'نخ','Y-1',5,?)"
  ).run(userId, wh).lastInsertRowid;
  issueFromStock(db, { productId: plain, warehouseId: wh, qty: 2, userId: 1 });
  ok(headerQty(plain) === 3, 'non-matrix material still issues by header');

  const personId = db.prepare("INSERT INTO persons (name, active) VALUES ('امانت‌گیر',1)").run().lastInsertRowid;
  let consThrew = false;
  try {
    createConsignment(db, { direction: 'out', person_id: personId, product_id: pid, qty: 1, warehouse_id: wh }, { id: userId });
  } catch (e) { consThrew = e.code === 'E_VARIANT_REQUIRED'; }
  ok(consThrew, 'consignment of a matrix product needs one color/size');

  const before = headerQty(pid);
  const row = createConsignment(db, {
    direction: 'out', person_id: personId, product_id: pid, qty: 1, warehouse_id: wh, variant_id: v2,
  }, { id: userId });
  ok(row.variant_id === v2 && headerQty(pid) === before - 1 && variantQty(v2) === 9, 'consignment issue moves header and that SKU once');
  voidConsignment(db, row.id, { id: userId });
  ok(headerQty(pid) === before && variantQty(v2) === 10, 'void consignment restores header and SKU');

  const countPid = db.prepare(
    "INSERT INTO products (user_id, name, code, stock, warehouse_id, average_cost_rial, cost) VALUES (?, 'شلوار','M-2',20,?,1000,100)"
  ).run(userId, wh).lastInsertRowid;
  db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,20)').run(countPid, wh);
  const c1 = db.prepare(
    'INSERT INTO product_variants (product_id, color_id, size_id, stock, active, is_default) VALUES (?,?,?,0,1,0)'
  ).run(countPid, color, sizeA).lastInsertRowid;
  const c2 = db.prepare(
    'INSERT INTO product_variants (product_id, color_id, size_id, stock, active, is_default) VALUES (?,?,?,0,1,0)'
  ).run(countPid, color, sizeB).lastInsertRowid;
  const sid = db.prepare(
    "INSERT INTO stocktaking_sessions (warehouse_id, date, status, created_by) VALUES (?, '1405/06/31', 'completed', ?)"
  ).run(wh, userId).lastInsertRowid;
  db.prepare(
    'INSERT INTO stocktaking_items (session_id, product_id, variant_id, system_qty, counted_qty) VALUES (?,?,?,?,?)'
  ).run(sid, countPid, c1, 0, 10);
  db.prepare(
    'INSERT INTO stocktaking_items (session_id, product_id, variant_id, system_qty, counted_qty) VALUES (?,?,?,?,?)'
  ).run(sid, countPid, c2, 0, 10);
  applyCycleCount(db, sid, { createdBy: userId });
  ok(headerQty(countPid) === 20, 'count that matches the header does not add a second header qty');
  ok(variantQty(c1) === 10 && variantQty(c2) === 10, 'count writes each SKU from zero');
  voidCycleCount(db, sid, { createdBy: userId });
  ok(variantQty(c1) === 0 && variantQty(c2) === 0 && headerQty(countPid) === 20, 'void count reverses only the SKU layer');

  const oldPid = db.prepare(
    "INSERT INTO products (user_id, name, code, stock, warehouse_id, average_cost_rial, cost) VALUES (?, 'کت','M-3',20,?,1000,100)"
  ).run(userId, wh).lastInsertRowid;
  db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,20)').run(oldPid, wh);
  const o1 = db.prepare(
    'INSERT INTO product_variants (product_id, color_id, size_id, stock, active, is_default) VALUES (?,?,?,8,1,0)'
  ).run(oldPid, color, sizeA).lastInsertRowid;
  const o2 = db.prepare(
    'INSERT INTO product_variants (product_id, color_id, size_id, stock, active, is_default) VALUES (?,?,?,12,1,0)'
  ).run(oldPid, color, sizeB).lastInsertRowid;
  const oldSid = db.prepare(
    "INSERT INTO stocktaking_sessions (warehouse_id, date, status, created_by) VALUES (?, '1405/07/01', 'draft', ?)"
  ).run(wh, userId).lastInsertRowid;
  db.prepare(
    'INSERT INTO stocktaking_items (session_id, product_id, system_qty, counted_qty, count1_qty) VALUES (?,?,?,?,?)'
  ).run(oldSid, oldPid, 20, 20, 20);
  const exploded = syncSessionVariantLines(db, oldSid);
  const countLines = db.prepare('SELECT variant_id, system_qty, counted_qty FROM stocktaking_items WHERE session_id=? ORDER BY variant_id').all(oldSid);
  ok(exploded.replaced === 1 && countLines.length === 2, 'an old style-level count becomes one row per color and size');
  ok(countLines.every((row) => row.variant_id) && countLines[0].variant_id === o1 && countLines[1].variant_id === o2, 'exploded rows name each SKU');
  applyCycleCount(db, oldSid, { createdBy: userId });
  ok(headerQty(oldPid) === 20 && variantQty(o1) === 8 && variantQty(o2) === 12, 'untouched exploded count does not write off the header');
} catch (e) {
  console.error(e);
  process.exit(1);
}
summary('apparel-ops');
