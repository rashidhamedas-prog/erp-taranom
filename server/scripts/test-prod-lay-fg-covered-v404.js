'use strict';
/**
 * v404 — Lays whose FG already entered via order receipt must not show as
 * pending PACK and must reject postCuttingPack (E_LAY_FG_COVERED).
 * Run from server/: node scripts/test-prod-lay-fg-covered-v404.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  OK', msg); }
  else { failed++; console.error('  FAIL', msg); }
}
function finish() {
  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-lay-fg-cov-'));
process.env.NODE_ENV = 'test';
process.env.ERP_TEST_ISOLATION = '1';
process.env.DB_PATH = path.join(dir, 'cov.db');
process.env.COMPANIES_DIR = path.join(dir, 'companies');
process.env.JWT_SECRET = 'test-prod-lay-fg-covered-v404-secret';
process.env.SYNC_ROLE = 'central';

let db;
try {
  const dbMod = require('../db');
  dbMod.initDB();
  db = dbMod.getDB();
} catch (e) {
  if (/better-sqlite3|NODE_MODULE_VERSION|was compiled against/i.test(String(e && (e.stack || e)))) {
    console.log('SKIP ENV: better-sqlite3 unavailable for this Node ABI');
    finish();
    process.exit(0);
  }
  throw e;
}

try {
  const cutting = require('../lib/production/cutting');
  const adminId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
  const user = { id: adminId };
  const whRaw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get().id;
  const whFg = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get().id;
  let whWip = db.prepare("SELECT id FROM warehouses WHERE code='WH-WIP'").get();
  if (!whWip) {
    whWip = {
      id: db.prepare(`
        INSERT INTO warehouses (code,name,kind,warehouse_type,active)
        VALUES ('WH-WIP','انبار کار در جریان','wip','wip',1)
      `).run().lastInsertRowid,
    };
  }
  const cc = db.prepare('SELECT id FROM cost_centers WHERE is_stage=1 ORDER BY id LIMIT 1').get()
    || db.prepare('SELECT id FROM cost_centers ORDER BY id LIMIT 1').get();

  function codeOf(fn) {
    try { fn(); return null; } catch (e) { return e && e.code; }
  }

  function makeLay(opts) {
    const {
      layNo, key, productId, bomId, fabricId, qty, orderId,
    } = opts;
    return db.prepare(`
      INSERT INTO cutting_lays
        (lay_no,product_id,bom_id,warehouse_id,fabric_product_id,color,marker_length_m,ply_count,
         planned_meters,actual_meters,matrix_meters,size_breakdown,qty_pieces,unit_cost_rial,
         amount_rial,waste_amount_rial,status,idempotency_key,date,created_by,production_order_id)
      VALUES (?,?,?,?,?,'مشکی',1,?, ?,?,?,?,?,1000,?,?, 'posted',?,'1405/07/23',?,?)
    `).run(
      layNo, productId, bomId, whRaw, fabricId, qty,
      qty, qty, qty, JSON.stringify({ 38: qty }), qty,
      qty * 1000, 0, key, adminId, orderId == null ? null : orderId
    ).lastInsertRowid;
  }

  const fabric = db.prepare(`
    INSERT INTO products (user_id,name,code,price,stock,average_cost_rial,unit,item_type,is_manufactured)
    VALUES (?,'پارچه V404','V404-FAB',0,100,1000,'متر','raw',0)
  `).run(adminId).lastInsertRowid;
  const fg = db.prepare(`
    INSERT INTO products (user_id,name,code,price,stock,average_cost_rial,unit,item_type,is_manufactured)
    VALUES (?,'کاپشن V404','V404-FG',0,40,0,'عدد','finished',1)
  `).run(adminId).lastInsertRowid;

  const bomId = db.prepare(`
    INSERT INTO bom_headers (code,product_id,version,status,base_qty,has_routing,yield_percent)
    VALUES ('V404-BOM',?,1,'active',1,0,100)
  `).run(fg).lastInsertRowid;

  const poId = db.prepare(`
    INSERT INTO production_orders
      (order_no,product_id,bom_id,bom_version,analysis_type,qty_planned,qty_produced,status,date,period_label,
       warehouse_raw_id,warehouse_fg_id,cost_center_id,material_cost_rial,created_by)
    VALUES ('PO-V404',?,?,1,'variable',40,40,'closed','1405/07/23','1405/07',?,?,?,0,?)
  `).run(fg, bomId, whRaw, whFg, cc.id, adminId).lastInsertRowid;

  db.prepare(`
    INSERT INTO production_receipts
      (doc_no, order_id, product_id, output_type, qty, unit_cost_rial, amount_rial,
       warehouse_id, size_breakdown, is_partial, date, period_label, status, created_by)
    VALUES ('PR-V404',?,?,'main',40,0,0,?,'',0,'1405/07/23','1405/07','posted',?)
  `).run(poId, fg, whFg, adminId);

  console.log('v404 — unlinked lay covered by unique closed order');
  const layUnlinked = makeLay({
    layNo: 'LAY-V404-U', key: 'v404-u', productId: fg, bomId, fabricId: fabric, qty: 40, orderId: null,
  });
  const covU = cutting.layFgCoveredByOrder(db, db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(layUnlinked));
  ok(covU.fg_covered_by_order === 1, 'unlinked lay covered by unique closed order');
  ok(covU.covered_order_no === 'PO-V404', 'covered_order_no PO-V404');

  const listed = cutting.listCuttingLays(db, { product_id: fg });
  const rowU = listed.find((r) => r.id === layUnlinked);
  ok(rowU && rowU.fg_covered_by_order === 1, 'list exposes fg_covered_by_order');
  ok(rowU && rowU.pack_posted === 1, 'list marks pack_posted for covered lay');
  ok(rowU && rowU.pack_via_order_fg === 1, 'list marks pack_via_order_fg');

  const packCode = codeOf(() => cutting.postCuttingPack(db, layUnlinked, {
    idempotency_key: 'v404-pack-u',
    warehouse_id: whWip.id,
  }, user));
  ok(packCode === 'E_LAY_FG_COVERED', 'postCuttingPack blocked E_LAY_FG_COVERED for unlinked covered lay');

  console.log('v404 — linked lay on same PO');
  const layLinked = makeLay({
    layNo: 'LAY-V404-L', key: 'v404-l', productId: fg, bomId, fabricId: fabric, qty: 40, orderId: poId,
  });
  const covL = cutting.layFgCoveredByOrder(db, db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(layLinked));
  ok(covL.fg_covered_by_order === 1, 'linked lay covered by own order receipt');
  const packCodeL = codeOf(() => cutting.postCuttingPack(db, layLinked, {
    idempotency_key: 'v404-pack-l',
    warehouse_id: whWip.id,
  }, user));
  ok(packCodeL === 'E_LAY_FG_COVERED', 'postCuttingPack blocked for linked covered lay');

  console.log('v404 — open order not covered');
  const poOpen = db.prepare(`
    INSERT INTO production_orders
      (order_no,product_id,bom_id,bom_version,analysis_type,qty_planned,qty_produced,status,date,period_label,
       warehouse_raw_id,warehouse_fg_id,cost_center_id,material_cost_rial,created_by)
    VALUES ('PO-V404-OPEN',?,?,1,'variable',10,0,'in_progress','1405/07/23','1405/07',?,?,?,0,?)
  `).run(fg, bomId, whRaw, whFg, cc.id, adminId).lastInsertRowid;
  const layOpen = makeLay({
    layNo: 'LAY-V404-O', key: 'v404-o', productId: fg, bomId, fabricId: fabric, qty: 10, orderId: poOpen,
  });
  // With two completed/closed? Only PO-V404 is closed; open linked lay uses its own PO status
  const covO = cutting.layFgCoveredByOrder(db, db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(layOpen));
  ok(covO.fg_covered_by_order === 0, 'open order lay not covered');

  console.log('v404 — lay qty > receipt not covered');
  const fg2 = db.prepare(`
    INSERT INTO products (user_id,name,code,price,stock,average_cost_rial,unit,item_type,is_manufactured)
    VALUES (?,'کاپشن V404B','V404-FG2',0,5,0,'عدد','finished',1)
  `).run(adminId).lastInsertRowid;
  const bom2 = db.prepare(`
    INSERT INTO bom_headers (code,product_id,version,status,base_qty,has_routing,yield_percent)
    VALUES ('V404-BOM2',?,1,'active',1,0,100)
  `).run(fg2).lastInsertRowid;
  const poSmall = db.prepare(`
    INSERT INTO production_orders
      (order_no,product_id,bom_id,bom_version,analysis_type,qty_planned,qty_produced,status,date,period_label,
       warehouse_raw_id,warehouse_fg_id,cost_center_id,material_cost_rial,created_by)
    VALUES ('PO-V404-S',?,?,1,'variable',5,5,'completed','1405/07/23','1405/07',?,?,?,0,?)
  `).run(fg2, bom2, whRaw, whFg, cc.id, adminId).lastInsertRowid;
  db.prepare(`
    INSERT INTO production_receipts
      (doc_no, order_id, product_id, output_type, qty, unit_cost_rial, amount_rial,
       warehouse_id, size_breakdown, is_partial, date, period_label, status, created_by)
    VALUES ('PR-V404-S',?,?,'main',5,0,0,?,'',0,'1405/07/23','1405/07','posted',?)
  `).run(poSmall, fg2, whFg, adminId);
  const layBig = makeLay({
    layNo: 'LAY-V404-B', key: 'v404-b', productId: fg2, bomId: bom2, fabricId: fabric, qty: 20, orderId: poSmall,
  });
  const covB = cutting.layFgCoveredByOrder(db, db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(layBig));
  ok(covB.fg_covered_by_order === 0, 'lay qty > receipt not covered');
} finally {
  try { db.close(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

finish();
