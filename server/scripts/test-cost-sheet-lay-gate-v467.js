'use strict';
/**
 * v467 — Cost sheet is provisional until fabric lay (waste/variance) is posted.
 * Run from server/: node scripts/test-cost-sheet-lay-gate-v467.js
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-lay-gate-'));
process.env.NODE_ENV = 'test';
process.env.ERP_TEST_ISOLATION = '1';
process.env.DB_PATH = path.join(dir, 'gate.db');
process.env.COMPANIES_DIR = path.join(dir, 'companies');
process.env.JWT_SECRET = 'test-cost-sheet-lay-gate-v467-secret';
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
  const reports = require('../lib/production/reports');
  const adminId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
  const whRaw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get().id;
  const whFg = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get().id;
  const cc = db.prepare('SELECT id FROM cost_centers WHERE is_stage=1 ORDER BY id LIMIT 1').get()
    || db.prepare('SELECT id FROM cost_centers ORDER BY id LIMIT 1').get();

  const fabric = db.prepare(`
    INSERT INTO products (user_id,name,code,price,stock,average_cost_rial,unit,item_type,is_manufactured)
    VALUES (?,'پارچه V467','V467-FAB',0,200,3000,'متر','raw',0)
  `).run(adminId).lastInsertRowid;
  db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,200)')
    .run(fabric, whRaw);

  const zip = db.prepare(`
    INSERT INTO products (user_id,name,code,price,stock,average_cost_rial,unit,item_type,is_manufactured)
    VALUES (?,'زیپ V467','V467-ZIP',0,50,400,'عدد','raw',0)
  `).run(adminId).lastInsertRowid;

  const fg = db.prepare(`
    INSERT INTO products (user_id,name,code,price,stock,average_cost_rial,unit,item_type,is_manufactured)
    VALUES (?,'کاپشن V467','V467-FG',0,0,0,'عدد','finished',1)
  `).run(adminId).lastInsertRowid;

  const bomId = db.prepare(`
    INSERT INTO bom_headers (code,product_id,version,status,base_qty,has_routing,yield_percent)
    VALUES ('V467-BOM',?,1,'draft',1,0,100)
  `).run(fg).lastInsertRowid;
  const blCols = db.prepare('PRAGMA table_info(bom_lines)').all().map((c) => c.name);
  const compCol = blCols.includes('component_product_id') ? 'component_product_id' : 'product_id';
  const typeCol = blCols.includes('line_type') ? 'line_type' : (blCols.includes('line_kind') ? 'line_kind' : null);
  db.prepare(`
    INSERT INTO bom_lines (bom_id,line_no,${compCol},qty_per_base,stage_cost_center_id${typeCol ? ',' + typeCol : ''})
    VALUES (?,1,?,1.2,?${typeCol ? ",'material'" : ''})
  `).run(bomId, fabric, cc.id);
  db.prepare(`
    INSERT INTO bom_lines (bom_id,line_no,${compCol},qty_per_base,stage_cost_center_id${typeCol ? ',' + typeCol : ''})
    VALUES (?,2,?,1,?${typeCol ? ",'material'" : ''})
  `).run(bomId, zip, cc.id);
  db.prepare("UPDATE bom_headers SET status='active' WHERE id=?").run(bomId);

  const poId = db.prepare(`
    INSERT INTO production_orders
      (order_no,product_id,bom_id,bom_version,analysis_type,qty_planned,qty_produced,status,date,period_label,
       warehouse_raw_id,warehouse_fg_id,cost_center_id,material_cost_rial,labor_cost_rial,overhead_cost_rial,
       total_cost_rial,unit_cost_rial,created_by)
    VALUES ('PO-V467',?,?,1,'variable',10,10,'completed','1405/07/27','1405/07',?,?,?,500000,100000,50000,650000,65000,?)
  `).run(fg, bomId, whRaw, whFg, cc.id, adminId).lastInsertRowid;

  const po = db.prepare('SELECT * FROM production_orders WHERE id=?').get(poId);
  ok(cutting.orderRequiresFabricCutting(db, po) === true, 'meter fabric BOM requires cutting');

  console.log('v467 — cost sheet without lay is provisional');
  let sheet = reports.costSheet(db, { orderId: poId });
  ok(sheet.data.incomplete === true, 'incomplete without lay');
  ok(sheet.data.cost_final === false, 'not cost_final without lay');
  ok(sheet.data.cutting && sheet.data.cutting.requires_fabric_cutting === true, 'cutting flag set');
  ok(
    (sheet.data.incomplete_reasons || []).some((r) => r.code === 'E_COST_NO_LAY'),
    'reason E_COST_NO_LAY'
  );
  ok(sheet.data.balanced === true || sheet.data.balanced === false, 'balanced still present (WIP only)');

  db.prepare(`
    INSERT INTO cutting_lays
      (lay_no,product_id,bom_id,warehouse_id,fabric_product_id,color,marker_length_m,ply_count,
       planned_meters,actual_meters,matrix_meters,size_breakdown,qty_pieces,unit_cost_rial,
       amount_rial,waste_amount_rial,waste_normal_m,waste_abnormal_m,status,idempotency_key,date,created_by,production_order_id)
    VALUES ('LAY-V467',?,?,?,?,'مشکی',1.2,10,12,12.5,12,'{"38":10}',10,3000,37500,1500,0.4,0.1,'posted','v467-lay','1405/07/27',?,?)
  `).run(fg, bomId, whRaw, fabric, adminId, poId);

  db.prepare(`
    INSERT INTO cutting_packs
      (pack_no,lay_id,product_id,warehouse_id,qty,production_order_id,status,date,created_by,idempotency_key)
    VALUES ('PACK-V467', (SELECT id FROM cutting_lays WHERE lay_no='LAY-V467'), ?, ?, 10, ?, 'posted', '1405/07/27', ?, 'v467-pack')
  `).run(fg, whFg, poId, adminId);

  sheet = reports.costSheet(db, { orderId: poId });
  ok(sheet.data.incomplete === false, 'complete after lay+pack covering produced qty');
  ok(sheet.data.cost_final === true, 'cost_final after lay+pack');
  ok(Number(sheet.data.cutting.actual_meters) === 12.5, 'actual meters on sheet');
  ok(Number(sheet.data.cutting.fabric_variance_m) === 0.5, 'fabric variance meters');
  ok(Number(sheet.data.cutting.waste_abnormal_m) === 0.1, 'abnormal waste meters');
  ok(Number(sheet.data.cutting.lay_waste_rial) === 1500, 'lay waste rial on sheet');

  console.log('v467 — non-fabric BOM stays final without lay');
  const zipOnly = db.prepare(`
    INSERT INTO products (user_id,name,code,price,stock,average_cost_rial,unit,item_type,is_manufactured)
    VALUES (?,'FG فقط زیپ','V467-FG2',0,0,0,'عدد','finished',1)
  `).run(adminId).lastInsertRowid;
  const bom2 = db.prepare(`
    INSERT INTO bom_headers (code,product_id,version,status,base_qty,has_routing,yield_percent)
    VALUES ('V467-BOM2',?,1,'draft',1,0,100)
  `).run(zipOnly).lastInsertRowid;
  db.prepare(`
    INSERT INTO bom_lines (bom_id,line_no,${compCol},qty_per_base,stage_cost_center_id${typeCol ? ',' + typeCol : ''})
    VALUES (?,1,?,1,?${typeCol ? ",'material'" : ''})
  `).run(bom2, zip, cc.id);
  db.prepare("UPDATE bom_headers SET status='active' WHERE id=?").run(bom2);
  const po2Id = db.prepare(`
    INSERT INTO production_orders
      (order_no,product_id,bom_id,bom_version,analysis_type,qty_planned,qty_produced,status,date,period_label,
       warehouse_raw_id,warehouse_fg_id,cost_center_id,total_cost_rial,unit_cost_rial,created_by)
    VALUES ('PO-V467B',?,?,1,'fixed',5,5,'completed','1405/07/27','1405/07',?,?,?,10000,2000,?)
  `).run(zipOnly, bom2, whRaw, whFg, cc.id, adminId).lastInsertRowid;
  const sheet2 = reports.costSheet(db, { orderId: po2Id });
  ok(sheet2.data.cost_final === true && sheet2.data.incomplete === false,
    'non-meter BOM cost_final without lay');
  ok(sheet2.data.cutting.requires_fabric_cutting === false, 'non-fabric requires_fabric_cutting false');
} finally {
  try { db.close(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

finish();
