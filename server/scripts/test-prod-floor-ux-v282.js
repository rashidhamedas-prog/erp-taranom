'use strict';
/**
 * v282 — stage material issue + order purge UX fixes.
 * Run: node server/scripts/test-prod-floor-ux-v282.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
let failed = 0;
let skipped = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  OK', msg); }
  else { failed++; console.error('  FAIL', msg); }
}
function skip(reason) {
  skipped++;
  console.log('  SKIP', reason);
}
function finish() {
  console.log(`\nResult: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed) process.exitCode = 1;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-floor-v282-'));
process.env.NODE_ENV = 'test';
process.env.ERP_TEST_ISOLATION = '1';
process.env.DB_PATH = path.join(dir, 'v282.db');
process.env.COMPANIES_DIR = path.join(dir, 'companies');
process.env.JWT_SECRET = 'test-prod-floor-ux-v282-secret-32bytes!!';
process.env.SYNC_ROLE = 'central';

let db;
try {
  const dbMod = require('../db');
  dbMod.initDB();
  db = dbMod.getDB();
} catch (e) {
  if (/better-sqlite3|NODE_MODULE_VERSION|was compiled against/i.test(String(e && (e.stack || e)))) {
    console.log('SKIP ENV: better-sqlite3 unavailable for this Node ABI');
    skip('all native assertions');
    finish();
    process.exit(0);
  }
  throw e;
}

try {
  const adv = require('../lib/production/engine-advanced');
  const engine = require('../lib/production/engine');
  const assignments = require('../lib/production/bom-assignments');
  const adminId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;

  function product(code, name, avg, type, manufactured = 0) {
    return db.prepare(`
      INSERT INTO products
        (user_id,name,code,price,stock,average_cost_rial,unit,item_type,is_manufactured)
      VALUES (?,?,?,?,1000,?,'عدد',?,?)
    `).run(adminId, name, code, 0, avg, type, manufactured).lastInsertRowid;
  }

  const fg = product('V282-FG', 'محصول کف کارگاه', 0, 'finished', 1);
  const fabric = product('V282-FAB', 'پارچه تست', 250000, 'raw');
  const zipper = product('V282-ZIP', 'زیپ تست', 50000, 'raw');
  const whRaw = db.prepare(`
    INSERT INTO warehouses (name,code,active,warehouse_type) VALUES ('مواد v282','WH-V282-R',1,'raw')
  `).run().lastInsertRowid;
  const whFg = db.prepare(`
    INSERT INTO warehouses (name,code,active,warehouse_type) VALUES ('محصول v282','WH-V282-F',1,'finished')
  `).run().lastInsertRowid;
  try {
    db.prepare('INSERT OR IGNORE INTO warehouse_stock (warehouse_id,product_id,qty) VALUES (?,?,?)')
      .run(whRaw, fabric, 500);
    db.prepare('INSERT OR IGNORE INTO warehouse_stock (warehouse_id,product_id,qty) VALUES (?,?,?)')
      .run(whRaw, zipper, 500);
  } catch (_) { /* optional schema */ }

  const ccCut = db.prepare(`
    INSERT INTO cost_centers (code,name,is_stage,active,seq) VALUES ('CC-V282-10','برش v282',1,1,10)
  `).run().lastInsertRowid;
  const ccSew = db.prepare(`
    INSERT INTO cost_centers (code,name,is_stage,active,seq) VALUES ('CC-V282-30','دوخت v282',1,1,30)
  `).run().lastInsertRowid;

  const bomId = db.prepare(`
    INSERT INTO bom_headers (code,product_id,version,status,base_qty,has_routing,yield_percent)
    VALUES ('BOM-V282',?,1,'draft',1,1,100)
  `).run(fg).lastInsertRowid;
  const lineFab = db.prepare(`
    INSERT INTO bom_lines
      (bom_id,line_no,component_product_id,qty_per_base,stage_cost_center_id,line_type)
    VALUES (?,1,?,1.5,?,'material')
  `).run(bomId, fabric, ccCut).lastInsertRowid;
  const lineZip = db.prepare(`
    INSERT INTO bom_lines
      (bom_id,line_no,component_product_id,qty_per_base,stage_cost_center_id,line_type)
    VALUES (?,2,?,1,?,'material')
  `).run(bomId, zipper, null).lastInsertRowid;

  const opCut = db.prepare(`
    INSERT INTO bom_operations
      (bom_id,seq,cost_center_id,operation_name,labor_method,labor_rate_rial,yield_percent)
    VALUES (?,10,?,'برش','piece',1000,100)
  `).run(bomId, ccCut).lastInsertRowid;
  const opSew = db.prepare(`
    INSERT INTO bom_operations
      (bom_id,seq,cost_center_id,operation_name,labor_method,labor_rate_rial,yield_percent)
    VALUES (?,30,?,'دوخت','piece',2000,100)
  `).run(bomId, ccSew).lastInsertRowid;
  db.prepare(`UPDATE bom_headers SET status='active' WHERE id=?`).run(bomId);

  const orderId = db.prepare(`
    INSERT INTO production_orders
      (order_no,product_id,bom_id,analysis_type,qty_planned,warehouse_raw_id,warehouse_fg_id,
       status,date,period_label,created_by)
    VALUES ('PO-V282',?,?, 'variable_adv',10,?,?, 'in_progress', '1405/07/10','1405/07',?)
  `).run(fg, bomId, whRaw, whFg, adminId).lastInsertRowid;

  const stCut = db.prepare(`
    INSERT INTO production_order_stages
      (order_id,seq,cost_center_id,operation_id,operation_name,status,qty_in,created_by)
    VALUES (?,?,?,?,?,'in_progress',10,?)
  `).run(orderId, 10, ccCut, opCut, 'برش', adminId).lastInsertRowid;
  const stSew = db.prepare(`
    INSERT INTO production_order_stages
      (order_id,seq,cost_center_id,operation_id,operation_name,status,qty_in,created_by)
    VALUES (?,?,?,?,?,'pending',0,?)
  `).run(orderId, 30, ccSew, opSew, 'دوخت', adminId).lastInsertRowid;

  // A) No assignments: zipper has null CC — v527 strict routing: it lands on NO stage
  //    (before v527 the first stage silently received it); cut still gets the CC-bound fabric.
  let tpl = adv.getStageIssueTemplate(db, orderId, stCut);
  ok(Array.isArray(tpl.lines) && tpl.lines.some(L => Number(L.product_id) === Number(fabric)),
    'cut stage gets fabric via stage_cost_center');
  ok(!tpl.lines.some(L => Number(L.product_id) === Number(zipper)),
    'v527: cut stage (first) does NOT receive the unassigned zipper');
  ok(Array.isArray(tpl.bom_gaps) && tpl.bom_gaps.some(g => Number(g.component_product_id) === Number(zipper)),
    'v527: unassigned zipper reported in bom_gaps');

  tpl = adv.getStageIssueTemplate(db, orderId, stSew);
  ok(!tpl.lines.length, 'sew stage empty before assignment');
  ok(/وصل|مرکز|اولین|بدون عملیات/i.test(String(tpl.empty_hint || '')), 'empty_hint explains why');

  // B) Explicit operation assignment wins
  db.prepare(`UPDATE bom_headers SET status='draft' WHERE id=?`).run(bomId);
  assignments.replaceAssignments(db, bomId, [
    { bom_line_id: lineFab, operation_id: opCut, allocation_mode: 'sole' },
    { bom_line_id: lineZip, operation_id: opSew, allocation_mode: 'sole' },
  ]);
  db.prepare(`UPDATE bom_headers SET status='active' WHERE id=?`).run(bomId);

  tpl = adv.getStageIssueTemplate(db, orderId, stCut);
  ok(tpl.lines.length === 1 && Number(tpl.lines[0].product_id) === Number(fabric),
    'after assign: cut only fabric');
  tpl = adv.getStageIssueTemplate(db, orderId, stSew);
  ok(tpl.lines.length === 1 && Number(tpl.lines[0].product_id) === Number(zipper),
    'after assign: sew only zipper');

  // C) listOrders hides voided by default
  const cancelled = db.prepare(`
    INSERT INTO production_orders
      (order_no,product_id,bom_id,analysis_type,qty_planned,status,date,created_by)
    VALUES ('PO-V282-C',?,?, 'fixed',1,'cancelled','1405/07/10',?)
  `).run(fg, bomId, adminId).lastInsertRowid;
  engine.purgeOrder(db, cancelled, adminId, 'تست حذف کامل');
  const listed = engine.listOrders(db, {});
  ok(!listed.rows.some(r => Number(r.id) === Number(cancelled)), 'voided hidden from default list');
  const withVoid = engine.listOrders(db, { includeVoided: true });
  ok(withVoid.rows.some(r => Number(r.id) === Number(cancelled) && r.status === 'voided'),
    'voided visible with includeVoided');

  // D) static UI markers
  const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  ok(appJs.includes('prodOrderPurge'), 'UI has purge helper');
  ok(appJs.includes('empty_hint'), 'UI reads empty_hint');
  ok(appJs.includes('ماتریس سایز هر قلم'), 'UI documents size matrix path');
  const badge = fs.readFileSync(path.join(__dirname, '../public/prod-ui.js'), 'utf8');
  ok(badge.includes("done: '✅ انجام شد'"), 'stage badge localized');

  finish();
} catch (e) {
  console.error(e);
  failed++;
  finish();
}
