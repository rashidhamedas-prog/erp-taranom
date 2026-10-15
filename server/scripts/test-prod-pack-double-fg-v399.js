'use strict';
/**
 * v399 — F06 ownership: never double-credit sellable FG via PACK + finalize.
 * Run from server/: node scripts/test-prod-pack-double-fg-v399.js
 *
 * 1. Open PO + pack without production_order_id → auto-link → WIP only
 * 2. Standalone FG pack then finalize → E_STANDALONE_PACK_FG
 * 3. Multiple open POs without explicit id → E_PACK_PO_REQUIRED
 * 4. cut_to_stock=true keeps legacy FG even with an open PO
 * 5. Linked pack does not bump product_variants.stock (matrix)
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-pack-dbl-'));
process.env.NODE_ENV = 'test';
process.env.ERP_TEST_ISOLATION = '1';
process.env.DB_PATH = path.join(dir, 'dbl.db');
process.env.COMPANIES_DIR = path.join(dir, 'companies');
process.env.JWT_SECRET = 'test-prod-pack-double-fg-v399-secret32';
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
  const advanced = require('../lib/production/engine-advanced');
  const adminId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
  const user = { id: adminId };
  const whRaw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get().id;
  const whFg = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get().id;
  let whWip = db.prepare("SELECT id FROM warehouses WHERE code='WH-WIP'").get();
  if (!whWip) {
    whWip = { id: db.prepare(`
      INSERT INTO warehouses (code,name,kind,warehouse_type,active)
      VALUES ('WH-WIP','انبار کار در جریان','wip','wip',1)
    `).run().lastInsertRowid };
  }
  const cc = db.prepare('SELECT id FROM cost_centers WHERE is_stage=1 ORDER BY id LIMIT 1').get().id;

  function qtyAt(productId, warehouseId) {
    return Number(db.prepare(`
      SELECT COALESCE(qty,0) qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?
    `).get(productId, warehouseId)?.qty) || 0;
  }
  function header(productId) {
    return db.prepare('SELECT stock, average_cost_rial FROM products WHERE id=?').get(productId);
  }
  function codeOf(fn) {
    try { fn(); return null; } catch (e) { return e && e.code; }
  }

  const fabric = db.prepare(`
    INSERT INTO products (user_id,name,code,price,stock,average_cost_rial,unit,item_type,is_manufactured)
    VALUES (?,'پارچه V399','V399-FAB',0,200,1000,'متر','raw',0)
  `).run(adminId).lastInsertRowid;
  db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,200)')
    .run(fabric, whRaw);

  let seq = 0;
  function makeFg(name) {
    seq += 1;
    return db.prepare(`
      INSERT INTO products (user_id,name,code,price,stock,average_cost_rial,unit,item_type,is_manufactured)
      VALUES (?,?,?,0,0,500,'عدد','finished',1)
    `).run(adminId, name || `FG-V399-${seq}`, `V399-FG-${seq}`).lastInsertRowid;
  }
  function makeBom(productId, code) {
    const bomId = db.prepare(`
      INSERT INTO bom_headers (code,product_id,version,status,base_qty,has_routing,yield_percent)
      VALUES (?,?,1,'draft',1,1,100)
    `).run(code, productId).lastInsertRowid;
    db.prepare(`
      INSERT INTO bom_lines (bom_id,line_no,component_product_id,qty_per_base,stage_cost_center_id,line_type)
      VALUES (?,1,?,1,?,'material')
    `).run(bomId, fabric, cc);
    const opId = db.prepare(`
      INSERT INTO bom_operations (bom_id,seq,cost_center_id,operation_name,labor_method,yield_percent)
      VALUES (?,10,?,'دوخت V399','contract',100)
    `).run(bomId, cc).lastInsertRowid;
    db.prepare("UPDATE bom_headers SET status='active' WHERE id=?").run(bomId);
    return { bomId, opId };
  }
  function makeOrder(productId, bomId, orderNo) {
    return db.prepare(`
      INSERT INTO production_orders
        (order_no,product_id,bom_id,bom_version,analysis_type,qty_planned,status,date,period_label,
         warehouse_raw_id,warehouse_fg_id,cost_center_id,created_by)
      VALUES (?,?,?,1,'fixed_adv',4,'in_progress','1405/07/23','1405/07',?,?,?,?)
    `).run(orderNo, productId, bomId, whRaw, whFg, cc, adminId).lastInsertRowid;
  }
  function seedStage(poId, bom) {
    db.prepare(`
      INSERT INTO production_order_stages
        (order_id,seq,cost_center_id,operation_id,operation_name,status,qty_in,qty_out,cost_out_rial,created_by)
      VALUES (?,10,?,?,'دوخت V399','done',4,4,4000,?)
    `).run(poId, cc, bom.opId, adminId);
  }
  function makeLay(productId, bomId, layNo, key, orderId) {
    const layId = db.prepare(`
      INSERT INTO cutting_lays
        (lay_no,product_id,bom_id,warehouse_id,fabric_product_id,color,marker_length_m,ply_count,
         planned_meters,actual_meters,matrix_meters,size_breakdown,qty_pieces,unit_cost_rial,
         amount_rial,waste_amount_rial,status,idempotency_key,date,created_by,production_order_id)
      VALUES (?,?,?,?,?,'مشکی',4,1,4,4,4,'{"38":4}',4,1000,4000,0,'posted',?,'1405/07/23',?,?)
    `).run(layNo, productId, bomId, whRaw, fabric, key, adminId, orderId || null).lastInsertRowid;
    const batch = db.prepare(`
      INSERT INTO inventory_batches
        (batch_no,product_id,warehouse_id,qty_on_hand,status,kind,color,unit,unit_cost_rial)
      VALUES (?,?,?,8,'active','fabric','مشکی','متر',1000)
    `).run(`${layNo}-ROLL`, fabric, whRaw).lastInsertRowid;
    db.prepare(`
      INSERT INTO cutting_lay_rolls (lay_id,batch_id,meters,unit_cost_rial,amount_rial,status)
      VALUES (?,?,4,1000,4000,'posted')
    `).run(layId, batch);
    return layId;
  }

  console.log('v399 — auto-link single open PO → WIP pack (no FG)');
  const fg1 = makeFg('کاپشن تست دوبل');
  const bom1 = makeBom(fg1, 'V399-BOM-1');
  const po1 = makeOrder(fg1, bom1.bomId, 'PD-V399-1');
  seedStage(po1, bom1);
  const lay1 = makeLay(fg1, bom1.bomId, 'LAY-V399-1', 'v399-lay-1', null);
  ok(!db.prepare('SELECT production_order_id FROM cutting_lays WHERE id=?').get(lay1).production_order_id,
    'fixture lay starts without PO');
  const pack1 = cutting.postCuttingPack(db, lay1, {
    idempotency_key: 'v399-auto-link', date: '1405/07/23',
  }, user);
  ok(Number(pack1.production_order_id) === Number(po1), 'pack auto-links the single open PO');
  ok(Number(header(fg1).stock) === 0, 'auto-linked pack does not increase products.stock');
  ok(qtyAt(fg1, whWip.id) === 4, 'auto-linked pack stages 4 in WH-WIP');
  ok(qtyAt(fg1, whFg) === 0, 'auto-linked pack does not touch WH-FG');
  const led1 = db.prepare(`
    SELECT event_type FROM inventory_ledger
    WHERE source_type='cutting_pack' AND source_id=? AND status='posted'
  `).get(pack1.id);
  ok(led1 && led1.event_type === 'cutting_pack', 'ledger event is cutting_pack not production_receipt');

  console.log('v399 — finalize after WIP pack is single FG credit');
  const fin1 = advanced.finalizeAdvancedOrder(db, {
    orderId: po1, body: { date: '1405/07/23', qty_produced: 4 }, userId: adminId,
  });
  ok(fin1.ok && fin1.receipt_id, 'finalize ok after WIP pack');
  ok(Number(header(fg1).stock) === 4, 'products.stock is 4 once after pack+finalize');
  ok(qtyAt(fg1, whFg) === 4, 'WH-FG is 4 once');

  console.log('v399 — standalone FG pack blocks finalize');
  const fg2 = makeFg('کالای cut-to-stock');
  const bom2 = makeBom(fg2, 'V399-BOM-2');
  const po2 = makeOrder(fg2, bom2.bomId, 'PD-V399-2');
  seedStage(po2, bom2);
  const lay2 = makeLay(fg2, bom2.bomId, 'LAY-V399-2', 'v399-lay-2', null);
  const pack2 = cutting.postCuttingPack(db, lay2, {
    cut_to_stock: true, warehouse_id: whFg,
    idempotency_key: 'v399-standalone', date: '1405/07/23',
  }, user);
  ok(Number(header(fg2).stock) === 4, 'cut_to_stock pack credits FG');
  ok(pack2.production_order_id == null, 'cut_to_stock pack stays unlinked');
  ok(codeOf(() => advanced.finalizeAdvancedOrder(db, {
    orderId: po2, body: { date: '1405/07/23', qty_produced: 4 }, userId: adminId,
  })) === 'E_STANDALONE_PACK_FG', 'finalize refused when orphan sellable pack exists');
  ok(Number(header(fg2).stock) === 4, 'refused finalize does not double stock');

  console.log('v399 — multiple open POs require explicit choice');
  const fg3 = makeFg('کالای چندسفارشی');
  const bom3 = makeBom(fg3, 'V399-BOM-3');
  makeOrder(fg3, bom3.bomId, 'PD-V399-3A');
  makeOrder(fg3, bom3.bomId, 'PD-V399-3B');
  const lay3 = makeLay(fg3, bom3.bomId, 'LAY-V399-3', 'v399-lay-3', null);
  ok(codeOf(() => cutting.postCuttingPack(db, lay3, {
    idempotency_key: 'v399-multi-po', date: '1405/07/23',
  }, user)) === 'E_PACK_PO_REQUIRED', 'multiple open POs → E_PACK_PO_REQUIRED');

  console.log('v399 — matrix: linked pack leaves variant.stock untouched');
  const fg4 = makeFg('ماتریس V399');
  const colorId = db.prepare(`
    INSERT INTO product_colors (product_id,name,code,active) VALUES (?,'مشکی','BLK',1)
  `).run(fg4).lastInsertRowid;
  const sizeId = db.prepare(`
    INSERT INTO product_sizes (product_id,name,code,active) VALUES (?,'38','38',1)
  `).run(fg4).lastInsertRowid;
  const vid = db.prepare(`
    INSERT INTO product_variants (product_id,color_id,size_id,sku,barcode,stock,active)
    VALUES (?,?,?,'V399-38','V399-38',0,1)
  `).run(fg4, colorId, sizeId).lastInsertRowid;
  const bom4 = makeBom(fg4, 'V399-BOM-4');
  const po4 = makeOrder(fg4, bom4.bomId, 'PD-V399-4');
  seedStage(po4, bom4);
  const lay4 = makeLay(fg4, bom4.bomId, 'LAY-V399-4', 'v399-lay-4', po4);
  cutting.postCuttingPack(db, lay4, {
    production_order_id: po4, warehouse_id: whWip.id,
    idempotency_key: 'v399-matrix', date: '1405/07/23',
  }, user);
  ok(Number(db.prepare('SELECT stock FROM product_variants WHERE id=?').get(vid).stock) === 0,
    'linked pack does not credit product_variants.stock');
  advanced.finalizeAdvancedOrder(db, {
    orderId: po4,
    body: {
      date: '1405/07/23', qty_produced: 4,
      variant_lines: [{ variant_id: vid, qty: 4 }],
    },
    userId: adminId,
  });
  ok(Number(db.prepare('SELECT stock FROM product_variants WHERE id=?').get(vid).stock) === 4,
    'finalize credits variant stock exactly once');
  ok(Number(header(fg4).stock) === 4, 'header stock is 4 after matrix finalize');
} finally {
  try { db.close(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

finish();
