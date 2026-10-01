'use strict';
/**
 * PROD-ACC F06 residual — a cutting pack linked to a production order is true WIP.
 * Run from server/: node scripts/test-prod-acc-pack-po-wip-v279.js
 *
 * Contract under test:
 *  1. linked PO → qty lands in the WIP warehouse only; sellable products.stock, the FG
 *     warehouse, the moving average and stock_logs do not move, and no WIP→FG JE is posted.
 *  2. no WIP warehouse / an FG warehouse → E_WIP_WAREHOUSE_REQUIRED (never stage in FG).
 *  3. voiding a linked pack gives the WIP warehouse qty back without pushing the header negative.
 *  4. standalone pack (no PO) keeps the legacy FG receipt + WIP→FG journal.
 *  5. finalize is the single increase of sellable FG stock.
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-acc-packwip-'));
process.env.NODE_ENV = 'test';
process.env.ERP_TEST_ISOLATION = '1';
process.env.DB_PATH = path.join(dir, 'packwip.db');
process.env.COMPANIES_DIR = path.join(dir, 'companies');
process.env.JWT_SECRET = 'test-prod-acc-pack-wip-secret-32-byt';
process.env.SYNC_ROLE = 'central';

let db;
try {
  const dbMod = require('../db');
  dbMod.initDB();
  db = dbMod.getDB();
} catch (e) {
  if (/better-sqlite3|NODE_MODULE_VERSION|was compiled against/i.test(String(e && (e.stack || e)))) {
    console.log('SKIP ENV: better-sqlite3 is unavailable for this Node ABI; run under server Node 20.');
    skip('all native SQLite pack-WIP assertions');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
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
  const cc = db.prepare('SELECT id FROM cost_centers WHERE is_stage=1 ORDER BY id LIMIT 1').get().id;

  function qtyAt(productId, warehouseId) {
    return Number(db.prepare(`
      SELECT COALESCE(qty,0) qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?
    `).get(productId, warehouseId)?.qty) || 0;
  }
  function header(productId) {
    return db.prepare('SELECT stock, average_cost_rial FROM products WHERE id=?').get(productId);
  }
  function stockLogs(productId) {
    return Number(db.prepare('SELECT COUNT(*) c FROM stock_logs WHERE product_id=?').get(productId).c) || 0;
  }
  function codeOf(fn) {
    try { fn(); return null; } catch (e) { return e && e.code; }
  }

  const fabric = db.prepare(`
    INSERT INTO products (user_id,name,code,price,stock,average_cost_rial,unit,item_type,is_manufactured)
    VALUES (?,'پارچه F06','F06-FAB',0,60,1000,'متر','raw',0)
  `).run(adminId).lastInsertRowid;
  db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,60)')
    .run(fabric, whRaw);

  let fgSeq = 0;
  function makeFg() {
    fgSeq += 1;
    return db.prepare(`
      INSERT INTO products (user_id,name,code,price,stock,average_cost_rial,unit,item_type,is_manufactured)
      VALUES (?,?,?,0,0,777,'عدد','finished',1)
    `).run(adminId, `محصول F06-${fgSeq}`, `F06-FG-${fgSeq}`).lastInsertRowid;
  }
  function makeBom(productId, code) {
    // Lines/operations must be written while the BOM is still draft (active BOMs are locked).
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
      VALUES (?,10,?,'دوخت F06','contract',100)
    `).run(bomId, cc).lastInsertRowid;
    db.prepare("UPDATE bom_headers SET status='active' WHERE id=?").run(bomId);
    return { bomId, opId };
  }
  function makeOrder(productId, bomId, orderNo) {
    return db.prepare(`
      INSERT INTO production_orders
        (order_no,product_id,bom_id,bom_version,analysis_type,qty_planned,status,date,period_label,
         warehouse_raw_id,warehouse_fg_id,cost_center_id,created_by)
      VALUES (?,?,?,1,'fixed_adv',4,'in_progress','1405/06/15','1405/06',?,?,?,?)
    `).run(orderNo, productId, bomId, whRaw, whFg, cc, adminId).lastInsertRowid;
  }
  function makeLay(productId, bomId, layNo, key, orderId) {
    const layId = db.prepare(`
      INSERT INTO cutting_lays
        (lay_no,product_id,bom_id,warehouse_id,fabric_product_id,color,marker_length_m,ply_count,
         planned_meters,actual_meters,matrix_meters,size_breakdown,qty_pieces,unit_cost_rial,
         amount_rial,waste_amount_rial,status,idempotency_key,date,created_by,production_order_id)
      VALUES (?,?,?,?,?,'مشکی',4,1,4,4,4,'{"38":4}',4,1000,4000,0,'posted',?,'1405/06/15',?,?)
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

  console.log('F06 — no WIP warehouse configured must refuse the pack, not stage in FG');
  const fgA = makeFg();
  const bomA = makeBom(fgA, 'F06-BOM-A');
  const poA = makeOrder(fgA, bomA.bomId, 'F06-PO-A');
  db.prepare(`
    INSERT INTO production_order_stages
      (order_id,seq,cost_center_id,operation_id,operation_name,status,qty_in,qty_out,cost_out_rial,created_by)
    VALUES (?,10,?,?,'دوخت F06','done',4,4,4000,?)
  `).run(poA, cc, bomA.opId, adminId);
  const layA = makeLay(fgA, bomA.bomId, 'F06-LAY-A', 'f06-lay-a', poA);
  ok(!db.prepare(`
    SELECT 1 FROM warehouses
    WHERE code IN ('WH-WIP','WH-CUT')
       OR COALESCE(warehouse_type,'') IN ('wip','work_in_process','semi')
       OR COALESCE(kind,'') IN ('wip','work_in_process','semi')
  `).get(), 'fixture starts with no WIP warehouse');
  ok(codeOf(() => cutting.postCuttingPack(db, layA, {
    production_order_id: poA, idempotency_key: 'f06-pack-no-wip', date: '1405/06/15',
  }, user)) === 'E_WIP_WAREHOUSE_REQUIRED', 'pack without a WIP warehouse throws E_WIP_WAREHOUSE_REQUIRED');
  ok(Number(db.prepare("SELECT COUNT(*) c FROM cutting_packs WHERE idempotency_key='f06-pack-no-wip'").get().c) === 0,
    'refused pack writes no cutting_packs row');
  ok(Number(header(fgA).stock) === 0 && qtyAt(fgA, whFg) === 0,
    'refused pack leaves products.stock and WH-FG at zero');

  const whWip = db.prepare(`
    INSERT INTO warehouses (code,name,kind,warehouse_type,active)
    VALUES ('WH-WIP','انبار کار در جریان','wip','wip',1)
  `).run().lastInsertRowid;

  ok(codeOf(() => cutting.postCuttingPack(db, layA, {
    production_order_id: poA, warehouse_id: whFg,
    idempotency_key: 'f06-pack-fg', date: '1405/06/15',
  }, user)) === 'E_WIP_WAREHOUSE_REQUIRED', 'explicit FG warehouse for a linked pack throws E_WIP_WAREHOUSE_REQUIRED');

  console.log('F06 — linked pack stages qty in WIP only');
  const avgBefore = header(fgA).average_cost_rial;
  const logsBefore = stockLogs(fgA);
  const pack = cutting.postCuttingPack(db, layA, {
    production_order_id: poA, warehouse_id: whWip,
    idempotency_key: 'f06-pack-wip', date: '1405/06/15',
  }, user);
  ok(Number(pack.warehouse_id) === Number(whWip), 'pack is stored in WH-WIP');
  ok(Number(header(fgA).stock) === 0, 'FG products.stock unchanged after pack with PO');
  ok(qtyAt(fgA, whWip) === 4, 'WIP warehouse qty up by 4');
  ok(qtyAt(fgA, whFg) === 0, 'FG warehouse qty unchanged');
  ok(Number(header(fgA).average_cost_rial) === Number(avgBefore), 'FG moving average unchanged');
  ok(stockLogs(fgA) === logsBefore, 'no legacy kardex row for staged WIP');
  ok(pack.journal_id == null, 'linked pack has no journal');
  ok(Number(db.prepare(`
    SELECT COUNT(*) c FROM journal_entries WHERE ref_type='cutting_pack' AND ref_id=?
  `).get(pack.id).c) === 0, 'no WIP→FG journal entry for a linked pack');
  const packLed = db.prepare(`
    SELECT * FROM inventory_ledger WHERE source_type='cutting_pack' AND source_id=? AND status='posted'
  `).get(pack.id);
  ok(packLed && packLed.event_type === 'cutting_pack' && Number(packLed.warehouse_id) === Number(whWip),
    'pack ledger row is cutting_pack on WH-WIP');
  ok(Number(db.prepare(`
    SELECT COUNT(*) c FROM inventory_cost_layers WHERE product_id=? AND warehouse_id=?
  `).get(fgA, whWip).c) === 0, 'staged WIP creates no FG cost layer');

  console.log('F06 — finalize is the only increase of sellable FG stock');
  const finalized = advanced.finalizeAdvancedOrder(db, {
    orderId: poA, body: { date: '1405/06/15', qty_produced: 4 }, userId: adminId,
  });
  ok(finalized.ok && finalized.receipt_id, 'finalize posts one production receipt');
  ok(Number(header(fgA).stock) === 4, 'products.stock is 4 after pack+finalize (no double count)');
  ok(qtyAt(fgA, whFg) === 4, 'WH-FG gets the four units exactly once');
  ok(qtyAt(fgA, whWip) === 0, 'finalize relieves the staged WIP quantity');

  console.log('F06 — voiding a linked pack returns WIP qty without touching the header');
  const fgC = makeFg();
  const bomC = makeBom(fgC, 'F06-BOM-C');
  const poC = makeOrder(fgC, bomC.bomId, 'F06-PO-C');
  const layC = makeLay(fgC, bomC.bomId, 'F06-LAY-C', 'f06-lay-c', poC);
  const packC = cutting.postCuttingPack(db, layC, {
    production_order_id: poC, warehouse_id: whWip,
    idempotency_key: 'f06-pack-void', date: '1405/06/15',
  }, user);
  ok(qtyAt(fgC, whWip) === 4 && Number(header(fgC).stock) === 0, 'second linked pack stages 4 in WIP only');
  cutting.voidCuttingPack(db, packC.id, user, { reason: 'تست ابطال' });
  ok(qtyAt(fgC, whWip) === 0, 'void gives the WIP qty back');
  ok(Number(header(fgC).stock) === 0, 'void does not push products.stock negative');
  const revLed = db.prepare(`
    SELECT * FROM inventory_ledger
    WHERE source_type='cutting_pack' AND source_id=? AND event_type='reversal'
  `).get(packC.id);
  ok(revLed && Number(revLed.qty_out) === 4, 'reversal ledger row carries qty_out 4');

  console.log('F06 — standalone pack keeps the legacy FG receipt');
  const fgB = makeFg();
  const bomB = makeBom(fgB, 'F06-BOM-B');
  const layB = makeLay(fgB, bomB.bomId, 'F06-LAY-B', 'f06-lay-b', null);
  const packB = cutting.postCuttingPack(db, layB, {
    warehouse_id: whFg, idempotency_key: 'f06-pack-standalone', date: '1405/06/15',
  }, user);
  ok(Number(header(fgB).stock) === 4, 'standalone pack still increases products.stock');
  ok(qtyAt(fgB, whFg) === 4, 'standalone pack receipts into WH-FG');
  ok(packB.journal_id != null, 'standalone pack still posts the WIP→FG journal');
} finally {
  try { db.close(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

finish();
