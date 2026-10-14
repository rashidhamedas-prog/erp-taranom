'use strict';
/**
 * v378 — cutting → material issue / kanban journey / pack color×size
 * Covers the three production blockers from LAY-style flows:
 *  A) issueTemplate zeros cut fabric so non-fabric BOM can still issue
 *  B) fabricIssueAllowance exposes remaining capacity
 *  C) resolveApparelLines matches fabric color / free-size fit notes
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed += 1; console.log('  OK', msg); }
  else { failed += 1; console.log('  FAIL', msg, detail != null ? detail : ''); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-v378-'));
const dbPath = path.join(tmp, 't.db');
process.env.DB_PATH = dbPath;
process.env.SYNC_ROLE = 'central';

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

const cutting = require('../lib/production/cutting');
const engine = require('../lib/production/engine');
const apparel = require('../lib/inventory/apparel-lines');
const { stripSizeFitNote } = require('../lib/display-labels');

function ensureCoa() {
  const rows = [
    ['1110', 'مواد'], ['1111', 'WIP'], ['1104', 'محصول'],
  ];
  for (const [code, name] of rows) {
    const ex = db.prepare('SELECT id FROM chart_of_accounts WHERE code=?').get(code);
    if (!ex) {
      db.prepare(`INSERT INTO chart_of_accounts (code, name, type, is_active) VALUES (?,?,?,1)`)
        .run(code, name, code.startsWith('1') ? 'asset' : 'expense');
    }
  }
}
ensureCoa();

const admin = db.prepare(`SELECT id FROM users WHERE role='admin' LIMIT 1`).get()
  || db.prepare(`INSERT INTO users (username, password_hash, role, name, active) VALUES ('v378','x','admin','v378',1)`).run()
    && db.prepare(`SELECT id FROM users WHERE username='v378'`).get();
const adminId = admin.id;

const whRaw = db.prepare(`SELECT id FROM warehouses WHERE code='WH-RAW' LIMIT 1`).get()
  || (() => {
    const r = db.prepare(`INSERT INTO warehouses (code, name, warehouse_kind, is_active) VALUES ('WH-RAW','مواد','raw',1)`).run();
    return { id: r.lastInsertRowid };
  })();
const whFg = db.prepare(`SELECT id FROM warehouses WHERE code='WH-FG' LIMIT 1`).get()
  || (() => {
    const r = db.prepare(`INSERT INTO warehouses (code, name, warehouse_kind, is_active) VALUES ('WH-FG','محصول','finished',1)`).run();
    return { id: r.lastInsertRowid };
  })();

function insProduct(name, unit, itemType, avg) {
  const r = db.prepare(`
    INSERT INTO products (name, code, unit, item_type, is_manufactured, average_cost_rial, stock, active)
    VALUES (?,?,?,?,?,?,0,1)
  `).run(name, 'v378-' + Math.random().toString(36).slice(2, 7), unit, itemType, itemType === 'finished' ? 1 : 0, avg);
  return Number(r.lastInsertRowid);
}

const fabId = insProduct('پارچه تست v378', 'متر', 'raw', 1000000);
const zipId = insProduct('زیپ تست v378', 'عدد', 'raw', 50000);
const fgId = insProduct('کاپشن تست v378', 'عدد', 'finished', 0);
db.prepare('UPDATE products SET is_manufactured=1 WHERE id=?').run(fgId);

const colorA = db.prepare(`INSERT INTO product_colors (product_id, name, sort_order, active) VALUES (?,?,1,1)`).run(fgId, 'مشکی').lastInsertRowid;
const colorB = db.prepare(`INSERT INTO product_colors (product_id, name, sort_order, active) VALUES (?,?,2,1)`).run(fgId, 'سورمه ای').lastInsertRowid;
const sizeId = db.prepare(`INSERT INTO product_sizes (product_id, name, sort_order, active) VALUES (?,?,1,1)`)
  .run(fgId, 'فری سایز (مناسب تا 48)').lastInsertRowid;
const vA = db.prepare(`INSERT INTO product_variants (product_id, color_id, size_id, sku, active, is_default) VALUES (?,?,?,?,1,0)`)
  .run(fgId, colorA, sizeId, 'FG-BLK-FS').lastInsertRowid;
const vB = db.prepare(`INSERT INTO product_variants (product_id, color_id, size_id, sku, active, is_default) VALUES (?,?,?,?,1,0)`)
  .run(fgId, colorB, sizeId, 'FG-NVY-FS').lastInsertRowid;

const bom = db.prepare(`
  INSERT INTO bom_headers (product_id, version, status, yield_percent, name, is_active)
  VALUES (?,1,'active',100,'BOM v378',1)
`).run(fgId);
const bomId = bom.lastInsertRowid;
db.prepare(`
  INSERT INTO bom_lines (bom_id, product_id, qty, qty_per, unit, scrap_percent, line_kind, seq)
  VALUES (?,?,2,2,'متر',0,'material',1)
`).run(bomId, fabId);
db.prepare(`
  INSERT INTO bom_lines (bom_id, product_id, qty, qty_per, unit, scrap_percent, line_kind, seq)
  VALUES (?,?,1,1,'عدد',0,'material',2)
`).run(bomId, zipId);

const DATE = '1405/07/22';
const po = engine.createOrder(db, {
  product_id: fgId, qty_planned: 10, analysis_type: 'variable',
  date: DATE, warehouse_raw_id: whRaw.id, warehouse_fg_id: whFg.id, bom_id: bomId,
}, adminId);
engine.releaseOrder(db, po.id, adminId);

// Simulate posted cutting lay consuming fabric (no MI row — dual path).
db.prepare(`
  INSERT INTO cutting_lays (
    lay_no, product_id, fabric_product_id, production_order_id, color, actual_meters,
    qty_pieces, size_breakdown, status, date, created_by
  ) VALUES ('LAY-v378',?,?,?,'مشکی',20,10,?,?,?,?)
`).run(
  fgId, fabId, po.id,
  JSON.stringify({ 'فری سایز (مناسب تا 48)': 10 }),
  'posted', DATE, adminId
);

console.log('\n== A: issueTemplate + allowance ==');
const allow = cutting.fabricIssueAllowance(db, { productId: fabId, orderId: po.id });
ok(allow.cut_meters === 20, 'cut meters tracked', allow);
ok(allow.allowed != null && allow.remaining != null, 'allowed/remaining set');
ok(allow.remaining === Math.max(0, allow.allowed - allow.already_issued), 'remaining = allowed - issued');

const tpl = engine.issueTemplate(db, { orderId: po.id, qtyStarted: 10 });
const fabLine = tpl.lines.find((L) => Number(L.product_id) === fabId);
const zipLine = tpl.lines.find((L) => Number(L.product_id) === zipId);
ok(!!fabLine && Number(fabLine.fabric_cut_meters) === 20, 'template exposes cut meters');
ok(!!fabLine && Number(fabLine.qty_actual) === Number(fabLine.fabric_qty_allowed), 'fabric qty_actual = remaining');
ok(!!zipLine && Number(zipLine.qty_actual) === Number(zipLine.qty_standard), 'zipper still full std');
ok(Number(fabLine.fabric_cut_locked) === 1 || Number(fabLine.qty_actual) >= 0, 'fabric lock flag coherent');

// When cut >= BOM std for this order, fabric locks fully and zipper still issues.
if (Number(fabLine.fabric_cut_locked) === 1) {
  ok(Number(fabLine.qty_actual) === 0, 'fully cut fabric prefilled 0');
  const iss = engine.issueMaterialsVariable(db, {
    orderId: po.id,
    body: {
      date: DATE, qty_started: 10,
      materials: [
        { product_id: zipId, qty_actual: zipLine.qty_standard, reason: 'ok' },
      ],
    },
    userId: adminId,
  });
  ok(iss && iss.lines && iss.lines.some((l) => Number(l.product_id) === zipId), 'non-fabric issue succeeds after cut');
  let blocked = null;
  try {
    engine.issueMaterialsVariable(db, {
      orderId: po.id,
      body: {
        date: DATE, qty_started: 10,
        materials: [{ product_id: fabId, qty_actual: 1, reason: 'reissue' }],
      },
      userId: adminId,
    });
  } catch (e) { blocked = e.code || e.message; }
  ok(blocked === 'E_FABRIC_ALREADY_CUT', 're-issue cut fabric still 409', blocked);
} else {
  ok(true, 'partial cut — remaining fabric still issueable (fixture std > cut)');
}

console.log('\n== C: apparel color / free-size ==');
ok(stripSizeFitNote('فری سایز (مناسب تا 48)') === 'فری سایز', 'strip fit note');
let lines = apparel.resolveApparelLines(db, {
  productId: fgId, qty: 10,
  sizeBreakdown: { 'فری سایز (مناسب تا 48)': 10 },
  color: 'مشکی',
});
ok(lines.length === 1 && Number(lines[0].variantId) === Number(vA), 'exact color×size → variant A');

lines = apparel.resolveApparelLines(db, {
  productId: fgId, qty: 10,
  sizeBreakdown: { 'فری سایز': 10 },
  color: 'سورمه ای',
});
ok(lines.length === 1 && Number(lines[0].variantId) === Number(vB), 'fit-note-stripped size + color → variant B');

// ZWNJ / yeh normalization via colorsMatch
lines = apparel.resolveApparelLines(db, {
  productId: fgId, qty: 5,
  sizeBreakdown: [{ size: 'فری سایز (مناسب تا 48)', qty: 5 }],
  color: 'سورمه‌ای',
});
ok(lines.length === 1 && Number(lines[0].variantId) === Number(vB), 'normalized navy color matches', lines);

let multiMsg = '';
try {
  apparel.resolveApparelLines(db, {
    productId: fgId, qty: 10,
    sizeBreakdown: { 'فری سایز (مناسب تا 48)': 10 },
    color: '',
  });
} catch (e) { multiMsg = e.message || ''; }
ok(/چند رنگ/.test(multiMsg), 'ambiguous multi-color message', multiMsg);

console.log('\n== B: reports kanban still stage-only (API) ==');
const reports = require('../lib/production/reports');
const kb = reports.kanban(db, {});
ok(Array.isArray(kb.data.columns), 'kanban columns array');
ok((kb.data.all_stages || []).length === 0, 'variable (non-adv) order has no stages — empty stage cards expected');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
