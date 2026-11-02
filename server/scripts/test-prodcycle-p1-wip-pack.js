'use strict';
/**
 * P1 prodcycle — WIP pack exit is valued at the pack's own cost, never the FG average.
 * Run from server/: node scripts/test-prodcycle-p1-wip-pack.js
 *
 *  1. finalize (full receipt) → WIP kardex value of the order's packs = 0, exit = pack amount.
 *  2. partial receipts → proportional exits; the exit that empties a pack takes the exact
 *     remaining amount (no rounding residue); open order WIP value = Σ remaining pack amounts.
 *  3. receipts spanning two packs never re-relieve an already-emptied pack.
 *  4. reverseOrder puts the relieved packs back in WIP at the same amounts.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
let failed = 0;
function ok(cond, msg, extra) {
  if (cond) { passed++; console.log('  OK', msg); }
  else { failed++; console.error('  FAIL', msg, extra !== undefined ? JSON.stringify(extra) : ''); }
}
function finish() {
  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prodcycle-p1-'));
process.env.NODE_ENV = 'test';
process.env.ERP_TEST_ISOLATION = '1';
process.env.DB_PATH = path.join(dir, 'p1.db');
process.env.COMPANIES_DIR = path.join(dir, 'companies');
process.env.JWT_SECRET = 'test-prodcycle-p1-wip-pack-secret-32b';
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
  const engine = require('../lib/production/engine');
  const adminId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
  const user = { id: adminId };
  const whRaw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get().id;
  const whFg = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get().id;
  let whWip = db.prepare("SELECT id FROM warehouses WHERE code='WH-WIP'").get();
  whWip = whWip ? whWip.id : db.prepare(`
    INSERT INTO warehouses (code,name,kind,warehouse_type,active)
    VALUES ('WH-WIP','انبار کار در جریان','wip','wip',1)
  `).run().lastInsertRowid;
  const cc = db.prepare('SELECT id FROM cost_centers WHERE is_stage=1 ORDER BY id LIMIT 1').get().id;
  const DATE = '1405/08/10';
  const FG_AVG = 777;

  function qtyAt(productId, warehouseId) {
    return Number(db.prepare(`
      SELECT COALESCE(qty,0) qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?
    `).get(productId, warehouseId)?.qty) || 0;
  }
  function packIdsOf(orderId) {
    return db.prepare('SELECT id FROM cutting_packs WHERE production_order_id=? ORDER BY id').all(orderId).map((r) => r.id);
  }
  /** WIP kardex value of an order = Σ in − Σ out over every cutting_pack ledger row of its packs. */
  function wipValue(orderId) {
    const ids = packIdsOf(orderId);
    if (!ids.length) return 0;
    const rows = db.prepare(`
      SELECT qty_in, qty_out, amount_rial FROM inventory_ledger
      WHERE warehouse_id=? AND source_type='cutting_pack' AND source_id IN (${ids.map(() => '?').join(',')})
    `).all(whWip, ...ids);
    return rows.reduce((s, r) => {
      const amt = Math.round(Number(r.amount_rial) || 0);
      if (Number(r.qty_in) > 0) return s + amt;
      if (Number(r.qty_out) > 0) return s - amt;
      return s;
    }, 0);
  }
  function openPackAmount(orderId) {
    return db.prepare(`
      SELECT id, amount_rial FROM cutting_packs WHERE production_order_id=? AND status='posted'
    `).all(orderId).reduce((s, p) => {
      const out = db.prepare(`
        SELECT COALESCE(SUM(amount_rial),0) a FROM inventory_ledger
        WHERE source_type='cutting_pack' AND source_id=? AND event_type='cutting_pack'
          AND qty_out>0 AND status='posted' AND reversed_of IS NULL
      `).get(p.id).a;
      return s + Math.round(Number(p.amount_rial) || 0) - Math.round(Number(out) || 0);
    }, 0);
  }
  function exitsOf(packId) {
    return db.prepare(`
      SELECT qty_out, amount_rial FROM inventory_ledger
      WHERE source_type='cutting_pack' AND source_id=? AND event_type='cutting_pack'
        AND qty_out>0 AND status='posted' AND reversed_of IS NULL ORDER BY id
    `).all(packId);
  }

  const fabric = db.prepare(`
    INSERT INTO products (user_id,name,code,price,stock,average_cost_rial,unit,item_type,is_manufactured)
    VALUES (?,'پارچه P1','P1-FAB',0,200,1000,'متر','raw',0)
  `).run(adminId).lastInsertRowid;
  db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,200)')
    .run(fabric, whRaw);

  let seq = 0;
  function makeFg() {
    seq += 1;
    return db.prepare(`
      INSERT INTO products (user_id,name,code,price,stock,average_cost_rial,unit,item_type,is_manufactured)
      VALUES (?,?,?,0,0,?,'عدد','finished',1)
    `).run(adminId, `محصول P1-${seq}`, `P1-FG-${seq}`, FG_AVG).lastInsertRowid;
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
      VALUES (?,10,?,'دوخت P1','contract',100)
    `).run(bomId, cc).lastInsertRowid;
    db.prepare("UPDATE bom_headers SET status='active' WHERE id=?").run(bomId);
    return { bomId, opId };
  }
  function makeOrder(productId, bom, orderNo, qty) {
    const id = db.prepare(`
      INSERT INTO production_orders
        (order_no,product_id,bom_id,bom_version,analysis_type,qty_planned,status,date,period_label,
         warehouse_raw_id,warehouse_fg_id,cost_center_id,created_by)
      VALUES (?,?,?,1,'fixed_adv',?,'in_progress',?,'1405/08',?,?,?,?)
    `).run(orderNo, productId, bom.bomId, qty, DATE, whRaw, whFg, cc, adminId).lastInsertRowid;
    db.prepare(`
      INSERT INTO production_order_stages
        (order_id,seq,cost_center_id,operation_id,operation_name,status,qty_in,qty_out,cost_out_rial,created_by)
      VALUES (?,10,?,?,'دوخت P1','done',?,?,4000,?)
    `).run(id, cc, bom.opId, qty, qty, adminId);
    return id;
  }
  function makePack(productId, bomId, orderId, key, qty, amount) {
    const layId = db.prepare(`
      INSERT INTO cutting_lays
        (lay_no,product_id,bom_id,warehouse_id,fabric_product_id,color,marker_length_m,ply_count,
         planned_meters,actual_meters,matrix_meters,size_breakdown,qty_pieces,unit_cost_rial,
         amount_rial,waste_amount_rial,status,idempotency_key,date,created_by,production_order_id)
      VALUES (?,?,?,?,?,'مشکی',4,1,4,4,4,?,?,1000,?,0,'posted',?,?,?,?)
    `).run(`LAY-${key}`, productId, bomId, whRaw, fabric, JSON.stringify({ 38: qty }), qty, amount,
      `lay-${key}`, DATE, adminId, orderId).lastInsertRowid;
    const batch = db.prepare(`
      INSERT INTO inventory_batches
        (batch_no,product_id,warehouse_id,qty_on_hand,status,kind,color,unit,unit_cost_rial)
      VALUES (?,?,?,8,'active','fabric','مشکی','متر',1000)
    `).run(`ROLL-${key}`, fabric, whRaw).lastInsertRowid;
    db.prepare(`
      INSERT INTO cutting_lay_rolls (lay_id,batch_id,meters,unit_cost_rial,amount_rial,status)
      VALUES (?,?,4,1000,?,'posted')
    `).run(layId, batch, amount);
    return cutting.postCuttingPack(db, layId, {
      production_order_id: orderId, warehouse_id: whWip, idempotency_key: `pack-${key}`, date: DATE,
    }, user);
  }
  function relieve(orderId, productId, qty, receiptId) {
    db.transaction(() => cutting.relieveStagedPackQty(db, {
      orderId, productId, qtyGood: qty, userId: adminId, date: DATE, receiptId,
    }))();
  }

  console.log('P1 — full receipt (finalize) exits WIP at the pack cost');
  const fgA = makeFg();
  const bomA = makeBom(fgA, 'P1-BOM-A');
  const poA = makeOrder(fgA, bomA, 'P1-PO-A', 3);
  const packA = makePack(fgA, bomA.bomId, poA, 'a', 3, 1000);
  ok(Number(packA.amount_rial) === 1000 && qtyAt(fgA, whWip) === 3, 'pack A staged 3 @ 1000 in WIP');
  ok(wipValue(poA) === 1000 && wipValue(poA) === openPackAmount(poA), 'open order WIP value = Σ open pack amount', wipValue(poA));
  const fin = advanced.finalizeAdvancedOrder(db, {
    orderId: poA, body: { date: DATE, qty_produced: 3 }, userId: adminId,
  });
  ok(fin.ok && fin.receipt_id, 'finalize posts the receipt');
  const exA = exitsOf(packA.id);
  ok(exA.length === 1 && Number(exA[0].qty_out) === 3 && Number(exA[0].amount_rial) === 1000,
    'single WIP exit carries the pack amount (not FG avg × qty)', exA);
  ok(Number(exA[0] && exA[0].amount_rial) !== FG_AVG * 3, 'exit is not valued at the FG moving average');
  ok(qtyAt(fgA, whWip) === 0, 'WIP qty is 0 after full receipt');
  ok(wipValue(poA) === 0, 'WIP kardex value of a fully received order is 0', wipValue(poA));
  ok(openPackAmount(poA) === 0, 'no residue left on the pack');

  console.log('P1 — reverseOrder restores the WIP pack at the same amount');
  engine.reverseOrder(db, poA, adminId, 'تست P1');
  ok(qtyAt(fgA, whWip) === 3, 'WIP qty back to 3 after reverseOrder', qtyAt(fgA, whWip));
  ok(wipValue(poA) === 1000, 'WIP value back to the pack amount after reverseOrder', wipValue(poA));
  const revRow = db.prepare(`
    SELECT qty_in, amount_rial FROM inventory_ledger
    WHERE source_type='cutting_pack' AND source_id=? AND event_type='reversal' AND qty_in>0
  `).get(packA.id);
  ok(revRow && Number(revRow.qty_in) === 3 && Number(revRow.amount_rial) === 1000,
    'reversal row mirrors the exit amount (not re-priced at average)', revRow);
  ok(exitsOf(packA.id).length === 0, 'original exit row is marked reversed');

  console.log('P1 — three partial receipts empty one pack with no rounding residue');
  const fgB = makeFg();
  const bomB = makeBom(fgB, 'P1-BOM-B');
  const poB = makeOrder(fgB, bomB, 'P1-PO-B', 3);
  const packB = makePack(fgB, bomB.bomId, poB, 'b', 3, 1000);
  relieve(poB, fgB, 1, 'B1');
  ok(exitsOf(packB.id).map((r) => Number(r.amount_rial)).join() === '333', 'first partial exit = round(1000×1/3)');
  ok(wipValue(poB) === 667 && wipValue(poB) === openPackAmount(poB), 'open order WIP value = remaining pack amount', wipValue(poB));
  relieve(poB, fgB, 1, 'B2');
  ok(wipValue(poB) === 334 && qtyAt(fgB, whWip) === 1, 'second partial leaves 1 @ 334');
  relieve(poB, fgB, 1, 'B3');
  ok(exitsOf(packB.id).map((r) => Number(r.amount_rial)).join() === '333,333,334',
    'last exit takes the exact remaining amount', exitsOf(packB.id));
  ok(wipValue(poB) === 0 && qtyAt(fgB, whWip) === 0, 'pack fully consumed → WIP value 0 and qty 0');
  relieve(poB, fgB, 2, 'B4');
  ok(exitsOf(packB.id).length === 3 && qtyAt(fgB, whWip) === 0, 'an emptied pack is never relieved again');

  console.log('P1 — receipts spanning two packs');
  const fgC = makeFg();
  const bomC = makeBom(fgC, 'P1-BOM-C');
  const poC = makeOrder(fgC, bomC, 'P1-PO-C', 7);
  const packC1 = makePack(fgC, bomC.bomId, poC, 'c1', 3, 1000);
  const packC2 = makePack(fgC, bomC.bomId, poC, 'c2', 4, 2001);
  ok(wipValue(poC) === 3001 && qtyAt(fgC, whWip) === 7, 'two packs staged 7 @ 3001');
  relieve(poC, fgC, 2, 'C1');
  ok(wipValue(poC) === 3001 - 667 && wipValue(poC) === openPackAmount(poC), 'partial 2 from pack 1 → 667 out', wipValue(poC));
  relieve(poC, fgC, 3, 'C2');
  ok(exitsOf(packC1.id).map((r) => Number(r.amount_rial)).join() === '667,333', 'pack 1 closes with its exact remainder');
  ok(exitsOf(packC2.id).map((r) => Number(r.amount_rial)).join() === '1001', 'pack 2 partial = round(2001×2/4)');
  ok(wipValue(poC) === 1000 && wipValue(poC) === openPackAmount(poC) && qtyAt(fgC, whWip) === 2,
    'open order WIP value = Σ open pack amounts (1000 for 2 pcs)', wipValue(poC));
  relieve(poC, fgC, 2, 'C3');
  ok(exitsOf(packC2.id).map((r) => Number(r.amount_rial)).join() === '1001,1000', 'pack 2 closes with its exact remainder');
  ok(wipValue(poC) === 0 && qtyAt(fgC, whWip) === 0, 'both packs consumed → WIP value 0');
  const totalOut = db.prepare(`
    SELECT COALESCE(SUM(amount_rial),0) a FROM inventory_ledger
    WHERE source_type='cutting_pack' AND source_id IN (?,?) AND event_type='cutting_pack' AND qty_out>0
  `).get(packC1.id, packC2.id).a;
  ok(Number(totalOut) === 3001, 'Σ WIP exits == Σ pack amounts (== net lay WIP)');
} finally {
  try { db.close(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

finish();
