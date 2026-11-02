'use strict';
/**
 * P2 — تسهیم برش مشترک بر پایهٔ cutting_batch_allocations + مراحل اختصاصی.
 * سناریوی شبیه PO-0014: دو محصول ۹۶ تایی، پارچهٔ نابرابر، دو مرحلهٔ اختصاصی برای هر محصول.
 * Run: node server/scripts/test-prodcycle-p2-shared-alloc.js
 */
const fs = require('fs');
const path = require('path');
const { ok, eq, freshDb, summary } = require('./lib/test-harness');

const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok('Help: تسهیم برش مشترک بر پایهٔ تخصیص', appSrc.includes('cutting_batch_allocations'));

const FABRIC_A = 502120062;
const FABRIC_B = 638802590;
const CUT_LABOR = 200000000;
const CUT_OH = 56628946;
const EX_A = [150000000, 147600000];
const EX_B = [150000000, 141840000];
const TOTAL = FABRIC_A + FABRIC_B + CUT_LABOR + CUT_OH
  + EX_A.reduce((s, x) => s + x, 0) + EX_B.reduce((s, x) => s + x, 0);
const EXPECT_A = 928034535;
const EXPECT_B = 1058957063;

let ctx;
try {
  ctx = freshDb();
} catch (e) {
  if (/bindings|better_sqlite3|NODE_MODULE_VERSION/i.test(String(e.message))) {
    console.log('  SKIP مسیر دیتابیس: better-sqlite3 روی این Node لود نشد');
    summary('prodcycle-p2');
  }
  throw e;
}
const { db, cleanup } = ctx;

try {
  eq('جمع WIP سناریو = ۲ × ۹۹۳٬۴۹۵٬۷۹۹', TOTAL, 2 * 993495799);
  const engine = require('../lib/production/engine');
  const engAdv = require('../lib/production/engine-advanced');
  const { splitOrderCost } = require('../lib/production/order-cost-split');
  const { costSheet } = require('../lib/production/reports');
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get();

  const fg = (name, code) => Number(db.prepare(`
    INSERT INTO products (user_id, name, code, unit, item_type, is_manufactured)
    VALUES (?, ?, ?, 'عدد', 'finished', 1)
  `).run(admin.id, name, code).lastInsertRowid);
  const cc10 = db.prepare("SELECT id FROM cost_centers WHERE code='CC-10'").get().id;
  const cc30 = db.prepare("SELECT id FROM cost_centers WHERE code='CC-30'").get().id;
  const fabric = Number(db.prepare(`
    INSERT INTO products (user_id, name, code, unit, item_type, is_manufactured, average_cost_rial)
    VALUES (?, 'پارچه P2', 'RM-P2', 'عدد', 'raw', 0, 1000)
  `).run(admin.id).lastInsertRowid);
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
    db.prepare(`
      INSERT INTO bom_lines (bom_id, line_no, component_product_id, qty_per_base, line_type, stage_cost_center_id)
      VALUES (?, 1, ?, 1, 'material', ?)
    `).run(id, fabric, cc10);
    db.prepare("UPDATE bom_headers SET status='active' WHERE id=?").run(id);
    return Number(id);
  }
  const wh = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get()
    || db.prepare('SELECT id FROM warehouses LIMIT 1').get();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('production_wh_raw_id', ?)").run(String(wh.id));
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('production_wh_fg_id', ?)").run(String(wh.id));

  let layN = 0;
  function addBatch(orderId, productA, productB, amtA, amtB, status = 'posted') {
    layN++;
    const batchId = Number(db.prepare(`
      INSERT INTO cutting_batches (batch_no, status, date, common_rial) VALUES (?, ?, '1405/08/01', ?)
    `).run(`CB-P2-${layN}`, status, amtA + amtB).lastInsertRowid);
    const layId = Number(db.prepare(`
      INSERT INTO cutting_lays (lay_no, product_id, fabric_product_id, status, date, amount_rial, batch_id, production_order_id)
      VALUES (?, ?, ?, ?, '1405/08/01', ?, ?, ?)
    `).run(`LAY-P2-${layN}`, productA, fabric, status, amtA + amtB, batchId, orderId).lastInsertRowid);
    db.prepare('UPDATE cutting_batches SET lay_id=? WHERE id=?').run(layId, batchId);
    const ins = db.prepare(`
      INSERT INTO cutting_batch_allocations (batch_id, product_id, weight, amount_rial, basis)
      VALUES (?, ?, ?, ?, 'fabric')
    `);
    ins.run(batchId, productA, amtA, amtA);
    ins.run(batchId, productB, amtB, amtB);
  }

  function makeOrder(tag) {
    const a = fg(`یلدا ${tag}`, `FG-P2A-${tag}`);
    const b = fg(`آبان ${tag}`, `FG-P2B-${tag}`);
    const bomA = bomFor(a, `BOM-P2A-${tag}`);
    const bomB = bomFor(b, `BOM-P2B-${tag}`);
    const created = engine.createOrder(db, {
      product_id: a, bom_id: bomA, qty_planned: 96, date: '1405/08/01',
      analysis_type: 'fixed', warehouse_fg_id: wh.id,
      order_products: [{ product_id: b, bom_id: bomB, qty: 96 }],
    }, admin.id);
    engine.releaseOrder(db, created.id, admin.id);
    return { orderId: created.id, a, b, cc30 };
  }

  /** مراحل را مثل سفارش ۱۴ «انجام‌شده» با بهای معلوم می‌کند (برش مشترک + دو مرحلهٔ اختصاصی هر محصول). */
  function costStages(o) {
    const stages = db.prepare('SELECT * FROM production_order_stages WHERE order_id=? ORDER BY seq, id').all(o.orderId);
    const shared = stages.filter(s => s.product_scope === 'shared');
    const exA = stages.filter(s => s.product_scope === 'exclusive' && Number(s.scoped_product_id) === o.a);
    const exB = stages.filter(s => s.product_scope === 'exclusive' && Number(s.scoped_product_id) === o.b);
    ok(`${o.orderId}: یک برش مشترک`, shared.length === 1, shared.length);
    ok(`${o.orderId}: مرحلهٔ اختصاصی هر محصول`, exA.length >= 1 && exB.length >= 1, `${exA.length}/${exB.length}`);
    const insStage = db.prepare(`
      INSERT INTO production_order_stages
        (order_id, seq, cost_center_id, qty_planned_in, status, product_scope, scoped_product_id)
      VALUES (?, ?, ?, 96, 'pending', 'exclusive', ?)
    `);
    const maxSeq = stages.reduce((m, s) => Math.max(m, Number(s.seq) || 0), 0);
    if (exA.length < 2) insStage.run(o.orderId, maxSeq + 10, o.cc30, o.a);
    if (exB.length < 2) insStage.run(o.orderId, maxSeq + 20, o.cc30, o.b);
    const all = db.prepare('SELECT * FROM production_order_stages WHERE order_id=? ORDER BY seq, id').all(o.orderId);
    const queueA = EX_A.slice();
    const queueB = EX_B.slice();
    let carry = 0;
    const up = db.prepare(`
      UPDATE production_order_stages SET status='done', qty_in=96, qty_out=96,
        material_in_rial=?, material_added_rial=?, labor_rial=?, overhead_rial=?, subcontract_rial=0,
        cost_out_rial=? WHERE id=?
    `);
    for (const s of all) {
      let mat = 0; let lab = 0; let oh = 0;
      if (s.product_scope === 'shared') { mat = FABRIC_A + FABRIC_B; lab = CUT_LABOR; oh = CUT_OH; }
      else if (Number(s.scoped_product_id) === o.a) lab = queueA.shift() || 0;
      else if (Number(s.scoped_product_id) === o.b) lab = queueB.shift() || 0;
      const out = carry + mat + lab + oh;
      up.run(carry, mat, lab, oh, out, s.id);
      carry = out;
    }
    eq(`${o.orderId}: مانده WIP مرحلهٔ آخر`, carry, TOTAL);
  }

  // ── ۱) سفارش با تخصیص برش مشترک ──
  const o1 = makeOrder('ALLOC');
  costStages(o1);
  addBatch(o1.orderId, o1.a, o1.b, 250000000, 300000000);
  addBatch(o1.orderId, o1.a, o1.b, FABRIC_A - 250000000, FABRIC_B - 300000000);
  addBatch(o1.orderId, o1.a, o1.b, 999999999, 1, 'reversed');

  const po1 = db.prepare('SELECT * FROM production_orders WHERE id=?').get(o1.orderId);
  const sp = splitOrderCost(db, po1, {
    total: TOTAL,
    products: [{ product_id: o1.a, pct: 50 }, { product_id: o1.b, pct: 50 }],
    residueProductId: o1.a,
  });
  const rA = sp.rows.find(r => r.product_id === o1.a);
  const rB = sp.rows.find(r => r.product_id === o1.b);
  ok('منبع پارچه = تخصیص برش مشترک', sp.fabric_source === 'shared_cut_alloc', sp.fabric_source);
  eq('پارچهٔ A = Σ تخصیص (برش ابطالی نادیده)', rA.fabric_rial, FABRIC_A);
  eq('پارچهٔ B = Σ تخصیص', rB.fabric_rial, FABRIC_B);
  eq('اختصاصی A مستقیم', rA.exclusive_rial, 297600000);
  eq('اختصاصی B مستقیم', rB.exclusive_rial, 291840000);
  eq('باقی‌مانده (دستمزد+سربار برش) نصف‌نصف', rA.shared_rial, 128314473);

  const fin = engAdv.finalizeAdvancedOrder(db, {
    orderId: o1.orderId,
    body: { date: '1405/08/02', outputs: [{ product_id: o1.a, qty: 96 }, { product_id: o1.b, qty: 96 }] },
    userId: admin.id,
  });
  const recA = (fin.receipts || []).find(r => Number(r.product_id) === o1.a);
  const recB = (fin.receipts || []).find(r => Number(r.product_id) === o1.b);
  eq('رسید A = ۹۲۸٬۰۳۴٬۵۳۵', recA && recA.amount_rial, EXPECT_A);
  eq('رسید B = ۱٬۰۵۸٬۹۵۷٬۰۶۳', recB && recB.amount_rial, EXPECT_B);
  const recSum = db.prepare(`
    SELECT COALESCE(SUM(amount_rial),0) s FROM production_receipts WHERE order_id=? AND status='posted'
  `).get(o1.orderId).s;
  eq('Σ رسیدها = WIP مصرف‌شده', recSum, TOTAL);

  const cs1 = costSheet(db, { orderId: o1.orderId }).data.summary.products;
  const cA = cs1.find(p => Number(p.product_id) === o1.a);
  const cB = cs1.find(p => Number(p.product_id) === o1.b);
  eq('برگهٔ بها A = رسید', cA && cA.cost_rial, EXPECT_A);
  eq('برگهٔ بها B = رسید', cB && cB.cost_rial, EXPECT_B);
  ok('برگهٔ بها منبع تخصیص', cA && cA.cost_share_source === 'shared_cut_alloc');
  eq('برگهٔ بها پارچهٔ B', cB && cB.allocated_fabric_rial, FABRIC_B);

  // ── ۲) بازگشت: بدون ردیف تخصیص، پارچه با باقی‌مانده به نسبت تعداد ──
  const o2 = makeOrder('NOALLOC');
  costStages(o2);
  const fin2 = engAdv.finalizeAdvancedOrder(db, {
    orderId: o2.orderId,
    body: { date: '1405/08/02', outputs: [{ product_id: o2.a, qty: 96 }, { product_id: o2.b, qty: 96 }] },
    userId: admin.id,
  });
  const pool2 = TOTAL - 297600000 - 291840000;
  const r2A = (fin2.receipts || []).find(r => Number(r.product_id) === o2.a);
  const r2B = (fin2.receipts || []).find(r => Number(r.product_id) === o2.b);
  eq('بازگشت: A = اختصاصی + نصف باقی', r2A && r2A.amount_rial, 297600000 + pool2 / 2);
  eq('بازگشت: B = اختصاصی + نصف باقی', r2B && r2B.amount_rial, 291840000 + pool2 / 2);
  eq('بازگشت: Σ رسیدها = WIP', (r2A?.amount_rial || 0) + (r2B?.amount_rial || 0), TOTAL);
  const cs2 = costSheet(db, { orderId: o2.orderId }).data.summary.products;
  ok('بازگشت: برگهٔ بها منبع غیرتخصیص', cs2.every(p => p.cost_share_source === 'bom_percent'));
  eq('بازگشت: برگهٔ بها جمع = کل', cs2.reduce((s, p) => s + p.cost_rial, 0), TOTAL);

  // ── ۳) گرد کردن: جمع دقیق حتی با باقی‌ماندهٔ فرد ──
  const odd = splitOrderCost(db, po1, {
    total: TOTAL + 1,
    products: [{ product_id: o1.a, pct: 33.3333 }, { product_id: o1.b, pct: 66.6667 }],
    residueProductId: o1.b,
  });
  eq('گرد کردن: Σ سطرها = کل', odd.rows.reduce((s, r) => s + r.amount_rial, 0), TOTAL + 1);
} catch (e) {
  ok('سناریوی P2', false, e && (e.stack || e.message || e.code));
} finally {
  cleanup();
}

summary('prodcycle-p2 shared-cut alloc');
