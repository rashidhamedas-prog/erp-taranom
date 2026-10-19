'use strict';
/**
 * v475 — یک سفارش، دو محصول، دو فرمول تک‌محصولی، یک برش مشترک.
 * Run: node server/scripts/test-order-peer-boms-v475.js
 */
const fs = require('fs');
const path = require('path');
const { ok, eq, summary } = require('./lib/test-harness');

const root = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
ok('SW v475+', /erp-taranom-v47[5-9]/.test(sw));
ok('peer matrix', appSrc.includes('prodOrderLoadPeerMatrix'));
ok('peer add button', appSrc.includes('prodOrderAddPeer'));
ok('Help v477', appSrc.includes('v475 / v477'));
try { new Function(appSrc); ok('app.js parse', true); }
catch (e) { ok('app.js parse', false, e.message); }

try {
  const { freshDb } = require('./lib/test-harness');
  const engine = require('../lib/production/engine');
  const { db, cleanup } = freshDb();
  try {
    const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get();
    function fg(name, code) {
      return db.prepare(`
        INSERT INTO products (user_id, name, code, unit, item_type, is_manufactured)
        VALUES (?, ?, ?, 'عدد', 'finished', 1)
      `).run(admin.id, name, code).lastInsertRowid;
    }
    const a = fg('یلدا', 'FG-475A');
    const b = fg('آبان', 'FG-475B');
    const cc10 = db.prepare("SELECT id FROM cost_centers WHERE code='CC-10'").get().id;
    const cc30 = db.prepare("SELECT id FROM cost_centers WHERE code='CC-30'").get().id;
    function bomFor(productId, code) {
      const id = db.prepare(`
        INSERT INTO bom_headers
          (code, product_id, name, base_qty, status, is_default, has_routing, has_coproducts, created_by)
        VALUES (?, ?, ?, 1, 'draft', 1, 1, 0, ?)
      `).run(code, productId, code, admin.id).lastInsertRowid;
      db.prepare(`
        INSERT INTO bom_operations (bom_id, seq, cost_center_id, operation_name, yield_percent, labor_method)
        VALUES (?,?,?,?,100,'contract')
      `).run(id, 10, cc10, 'برش');
      db.prepare(`
        INSERT INTO bom_operations (bom_id, seq, cost_center_id, operation_name, yield_percent, labor_method)
        VALUES (?,?,?,?,100,'contract')
      `).run(id, 20, cc30, 'دوخت');
      return id;
    }
    const fabric = db.prepare(`
      INSERT INTO products (user_id, name, code, unit, item_type, is_manufactured, average_cost_rial)
      VALUES (?, 'پارچه', 'RM-475', 'متر', 'raw', 0, 1000)
    `).run(admin.id).lastInsertRowid;
    const bomA = bomFor(a, 'BOM-475A');
    const bomB = bomFor(b, 'BOM-475B');
    for (const id of [bomA, bomB]) {
      db.prepare(`
        INSERT INTO bom_lines (bom_id, line_no, component_product_id, qty_per_base, line_type)
        VALUES (?, 1, ?, 1.2, 'material')
      `).run(id, fabric);
      db.prepare("UPDATE bom_headers SET status='active' WHERE id=?").run(id);
    }
    const wh = db.prepare('SELECT id FROM warehouses LIMIT 1').get();
    if (wh) {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('production_wh_raw_id', ?)").run(String(wh.id));
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('production_wh_fg_id', ?)").run(String(wh.id));
    }
    const created = engine.createOrder(db, {
      product_id: a,
      bom_id: bomA,
      qty_planned: 4,
      date: '1405/07/27',
      analysis_type: 'fixed',
      order_products: [{ product_id: b, bom_id: bomB, qty: 6 }],
    }, admin.id);
    ok('analysis upgraded', created.analysis_type === 'fixed_adv', created.analysis_type);
    const detail = engine.getOrderDetail(db, created.id);
    eq('two products on the order', detail.fg_plan.length, 2);
    ok('two different formulas', detail.fg_plan.every((p) => p.bom_id) && new Set(detail.fg_plan.map((p) => p.bom_id)).size === 2);
    const released = engine.releaseOrder(db, created.id, admin.id);
    const stages = released.stages || db.prepare('SELECT * FROM production_order_stages WHERE order_id=? ORDER BY seq').all(created.id);
    const shared = stages.filter((s) => s.product_scope === 'shared');
    const exclusive = stages.filter((s) => s.product_scope === 'exclusive');
    eq('one shared cut', shared.length, 1);
    eq('shared cut qty is 4+6', shared[0] && shared[0].qty_planned_in, 10);
    eq('two exclusive sew stages', exclusive.length, 2);
  } finally {
    cleanup();
  }
} catch (e) {
  ok('db peer order', false, `${e.code || ''} ${e.message || ''}`);
}

summary();
