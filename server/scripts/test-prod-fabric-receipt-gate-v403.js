'use strict';
/**
 * v403 — Roll-fabric PO cannot FG-receipt before lay + PACK.
 * Run from server/: node scripts/test-prod-fabric-receipt-gate-v403.js
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-fab-gate-'));
process.env.NODE_ENV = 'test';
process.env.ERP_TEST_ISOLATION = '1';
process.env.DB_PATH = path.join(dir, 'gate.db');
process.env.COMPANIES_DIR = path.join(dir, 'companies');
process.env.JWT_SECRET = 'test-prod-fabric-receipt-gate-v403-secret';
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
  const engine = require('../lib/production/engine');
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
  function header(id) {
    return db.prepare('SELECT stock FROM products WHERE id=?').get(id);
  }

  const fabric = db.prepare(`
    INSERT INTO products (user_id,name,code,price,stock,average_cost_rial,unit,item_type,is_manufactured)
    VALUES (?,'پارچه V403','V403-FAB',0,500,2000,'متر','raw',0)
  `).run(adminId).lastInsertRowid;
  db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,500)')
    .run(fabric, whRaw);
  // Roll-tracked fabric batch → orderRequiresFabricCutting
  db.prepare(`
    INSERT INTO inventory_batches
      (batch_no,product_id,warehouse_id,qty_on_hand,status,kind,color,unit,unit_cost_rial)
    VALUES ('LOT-V403',?,? ,200,'active','fabric','مشکی','متر',2000)
  `).run(fabric, whRaw);

  const zip = db.prepare(`
    INSERT INTO products (user_id,name,code,price,stock,average_cost_rial,unit,item_type,is_manufactured)
    VALUES (?,'زیپ V403','V403-ZIP',0,100,500,'عدد','raw',0)
  `).run(adminId).lastInsertRowid;
  db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,100)')
    .run(zip, whRaw);

  const fg = db.prepare(`
    INSERT INTO products (user_id,name,code,price,stock,average_cost_rial,unit,item_type,is_manufactured)
    VALUES (?,'کاپشن V403','V403-FG',0,0,0,'عدد','finished',1)
  `).run(adminId).lastInsertRowid;

  const bomId = db.prepare(`
    INSERT INTO bom_headers (code,product_id,version,status,base_qty,has_routing,yield_percent)
    VALUES ('V403-BOM',?,1,'draft',1,0,100)
  `).run(fg).lastInsertRowid;
  const blCols = db.prepare('PRAGMA table_info(bom_lines)').all().map((c) => c.name);
  const compCol = blCols.includes('component_product_id') ? 'component_product_id' : 'product_id';
  const typeCol = blCols.includes('line_type') ? 'line_type' : (blCols.includes('line_kind') ? 'line_kind' : null);
  db.prepare(`
    INSERT INTO bom_lines (bom_id,line_no,${compCol},qty_per_base,stage_cost_center_id${typeCol ? ',' + typeCol : ''})
    VALUES (?,1,?,1.5,?${typeCol ? ",'material'" : ''})
  `).run(bomId, fabric, cc.id);
  db.prepare(`
    INSERT INTO bom_lines (bom_id,line_no,${compCol},qty_per_base,stage_cost_center_id${typeCol ? ',' + typeCol : ''})
    VALUES (?,2,?,1,?${typeCol ? ",'material'" : ''})
  `).run(bomId, zip, cc.id);
  db.prepare("UPDATE bom_headers SET status='active' WHERE id=?").run(bomId);

  const poId = db.prepare(`
    INSERT INTO production_orders
      (order_no,product_id,bom_id,bom_version,analysis_type,qty_planned,qty_produced,status,date,period_label,
       warehouse_raw_id,warehouse_fg_id,cost_center_id,material_cost_rial,created_by)
    VALUES ('PO-V403',?,?,1,'variable',4,0,'in_progress','1405/07/23','1405/07',?,?,?,8000,?)
  `).run(fg, bomId, whRaw, whFg, cc.id, adminId).lastInsertRowid;

  // Seed a material issue so variable receipt is not blocked by E_NO_MATERIAL_ISSUED
  db.prepare(`
    INSERT INTO production_material_issues
      (doc_no,order_id,cost_center_id,product_id,issue_type,qty_standard,qty_actual,qty_variance,
       unit_cost_rial,std_cost_rial,amount_rial,std_amount_rial,var_price_rial,var_qty_rial,
       warehouse_id,date,period_label,status,created_by)
    VALUES ('MI-V403',?,? ,?, 'manual',1,1,0,500,500,500,500,0,0,?,'1405/07/23','1405/07','posted',?)
  `).run(poId, cc.id, zip, whRaw, adminId);

  const po = db.prepare('SELECT * FROM production_orders WHERE id=?').get(poId);
  ok(cutting.orderRequiresFabricCutting(db, po) === true, 'PO with meter fabric + roll requires cutting');
  const gate0 = cutting.fabricCuttingGateInfo(db, po);
  ok(gate0.requires_fabric_cutting && !gate0.cutting_receipt_ready, 'receipt not ready before lay/pack');

  console.log('v403 — direct variable receipt blocked without lay');
  ok(codeOf(() => engine.postReceiptVariable(db, {
    orderId: poId,
    body: { qty_produced: 4, date: '1405/07/23', is_partial: 0, auto_labor: false },
    userId: adminId,
  })) === 'E_CUTTING_LAY_REQUIRED', 'E_CUTTING_LAY_REQUIRED before lay');

  const layId = db.prepare(`
    INSERT INTO cutting_lays
      (lay_no,product_id,bom_id,warehouse_id,fabric_product_id,color,marker_length_m,ply_count,
       planned_meters,actual_meters,matrix_meters,size_breakdown,qty_pieces,unit_cost_rial,
       amount_rial,waste_amount_rial,status,idempotency_key,date,created_by,production_order_id)
    VALUES ('LAY-V403',?,?,?,?,'مشکی',4,1,4,4,4,'{"38":4}',4,2000,8000,0,'posted','v403-lay','1405/07/23',?,?)
  `).run(fg, bomId, whRaw, fabric, adminId, poId).lastInsertRowid;
  const batchId = db.prepare(`
    INSERT INTO inventory_batches
      (batch_no,product_id,warehouse_id,qty_on_hand,status,kind,color,unit,unit_cost_rial)
    VALUES ('LOT-V403-B',?,?,4,'active','fabric','مشکی','متر',2000)
  `).run(fabric, whRaw).lastInsertRowid;
  db.prepare(`
    INSERT INTO cutting_lay_rolls (lay_id,batch_id,meters,unit_cost_rial,amount_rial,status)
    VALUES (?,?,4,2000,8000,'posted')
  `).run(layId, batchId);

  ok(codeOf(() => engine.postReceiptVariable(db, {
    orderId: poId,
    body: { qty_produced: 4, date: '1405/07/23', is_partial: 0, auto_labor: false },
    userId: adminId,
  })) === 'E_CUTTING_PACK_REQUIRED', 'E_CUTTING_PACK_REQUIRED after lay without pack');

  cutting.postCuttingPack(db, layId, {
    production_order_id: poId,
    warehouse_id: whWip.id,
    idempotency_key: 'v403-pack',
    date: '1405/07/23',
  }, user);
  ok(Number(header(fg).stock) === 0, 'linked PACK does not credit FG yet');

  const rec = engine.postReceiptVariable(db, {
    orderId: poId,
    body: { qty_produced: 4, date: '1405/07/23', is_partial: 1, auto_labor: false },
    userId: adminId,
  });
  ok(rec && rec.ok && rec.receipt_id, 'receipt allowed after lay+pack');
  ok(Number(header(fg).stock) === 4, 'FG stock credited once on receipt');
  const st = db.prepare('SELECT status,qty_produced FROM production_orders WHERE id=?').get(poId);
  ok(st.status === 'completed' && Number(st.qty_produced) === 4,
    'full qty completes order even when is_partial was set');

  console.log('v403 — non-roll fabric BOM does not force gate');
  const fabric2 = db.prepare(`
    INSERT INTO products (user_id,name,code,price,stock,average_cost_rial,unit,item_type,is_manufactured)
    VALUES (?,'پارچه بدون طاقه','V403-FAB2',0,50,1000,'متر','raw',0)
  `).run(adminId).lastInsertRowid;
  const fg2 = db.prepare(`
    INSERT INTO products (user_id,name,code,price,stock,average_cost_rial,unit,item_type,is_manufactured)
    VALUES (?,'FG بدون طاقه','V403-FG2',0,0,0,'عدد','finished',1)
  `).run(adminId).lastInsertRowid;
  const bom2 = db.prepare(`
    INSERT INTO bom_headers (code,product_id,version,status,base_qty,has_routing,yield_percent)
    VALUES ('V403-BOM2',?,1,'draft',1,0,100)
  `).run(fg2).lastInsertRowid;
  db.prepare(`
    INSERT INTO bom_lines (bom_id,line_no,${compCol},qty_per_base,stage_cost_center_id${typeCol ? ',' + typeCol : ''})
    VALUES (?,1,?,1,?${typeCol ? ",'material'" : ''})
  `).run(bom2, fabric2, cc.id);
  db.prepare("UPDATE bom_headers SET status='active' WHERE id=?").run(bom2);
  const po2 = {
    id: 0, product_id: fg2, bom_id: bom2, size_breakdown: null, date: '1405/07/23',
  };
  ok(cutting.orderRequiresFabricCutting(db, po2) === false,
    'meter fabric without any fabric batch does not require cutting gate');
} finally {
  try { db.close(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

finish();
