'use strict';
/**
 * PROD-ACC PA-12 G2 — golden sole/shared material assignment acceptance.
 * Run from server/: node scripts/test-prod-acc-golden-g2-assignments-v278.js
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-acc-g2-'));
process.env.NODE_ENV = 'test';
process.env.ERP_TEST_ISOLATION = '1';
process.env.DB_PATH = path.join(dir, 'g2.db');
process.env.COMPANIES_DIR = path.join(dir, 'companies');
process.env.JWT_SECRET = 'test-prod-acc-golden-g2-secret-32-bytes';
process.env.SYNC_ROLE = 'central';

let db;
try {
  const dbMod = require('../db');
  dbMod.initDB();
  db = dbMod.getDB();
} catch (e) {
  if (/better-sqlite3|NODE_MODULE_VERSION|was compiled against/i.test(String(e && (e.stack || e)))) {
    console.log('SKIP ENV: better-sqlite3 is unavailable for this Node ABI; run under server Node 20.');
    skip('all native SQLite G2 assertions');
    finish();
    process.exit(0);
  }
  throw e;
}

try {
  const assignments = require('../lib/production/bom-assignments');
  const advancedBom = require('../lib/production/bom-advanced');
  const adminId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;

  function product(code, name, avg, type, manufactured = 0) {
    return db.prepare(`
      INSERT INTO products
        (user_id,name,code,price,stock,average_cost_rial,unit,item_type,is_manufactured)
      VALUES (?,?,?,?,1000,?,'عدد',?,?)
    `).run(adminId, name, code, 0, avg, type, manufactured).lastInsertRowid;
  }

  const fg = product('G2-FG', 'محصول G2', 0, 'finished', 1);
  const solePart = product('G2-SOLE', 'جزء sole', 101, 'raw');
  const sharedPart = product('G2-SHARED', 'جزء shared', 1001, 'raw');
  const cc = db.prepare(`
    INSERT INTO cost_centers (code,name,is_stage,active,seq)
    VALUES ('G2-CC','مرکز مشترک G2',1,1,999)
  `).run().lastInsertRowid;
  const bomId = db.prepare(`
    INSERT INTO bom_headers (code,product_id,version,status,base_qty,has_routing,yield_percent)
    VALUES ('G2-BOM',?,1,'draft',1,1,100)
  `).run(fg).lastInsertRowid;
  const soleLine = db.prepare(`
    INSERT INTO bom_lines
      (bom_id,line_no,component_product_id,qty_per_base,stage_cost_center_id,line_type)
    VALUES (?,1,?,1,?,'material')
  `).run(bomId, solePart, cc).lastInsertRowid;
  const sharedLine = db.prepare(`
    INSERT INTO bom_lines
      (bom_id,line_no,component_product_id,qty_per_base,stage_cost_center_id,line_type)
    VALUES (?,2,?,1,?,'material')
  `).run(bomId, sharedPart, cc).lastInsertRowid;
  const op1 = db.prepare(`
    INSERT INTO bom_operations (bom_id,seq,cost_center_id,operation_name,labor_method)
    VALUES (?,10,?,'عملیات الف','contract')
  `).run(bomId, cc).lastInsertRowid;
  const op2 = db.prepare(`
    INSERT INTO bom_operations (bom_id,seq,cost_center_id,operation_name,labor_method)
    VALUES (?,20,?,'عملیات ب','contract')
  `).run(bomId, cc).lastInsertRowid;

  console.log('G2 — ownership is operation_id, not cost center');
  assignments.replaceAssignments(db, bomId, [
    { bom_line_id: soleLine, operation_id: op2, allocation_mode: 'sole' },
    { bom_line_id: sharedLine, operation_id: op1, allocation_mode: 'shared', share_percent: 60 },
    { bom_line_id: sharedLine, operation_id: op2, allocation_mode: 'shared', share_percent: 40 },
  ]);
  const byOp = assignments.materialsByOperation(db, bomId);
  ok(byOp.size === 2, 'two operations sharing one cost center remain distinct');
  ok(!(byOp.get(Number(op1)) || []).some(r => Number(r.bom_line_id) === Number(soleLine)),
    'sole material is absent from unselected operation');
  ok((byOp.get(Number(op2)) || []).some(r => Number(r.bom_line_id) === Number(soleLine)),
    'sole material belongs to selected operation_id');

  advancedBom.clearRollUpMemo();
  const roll = advancedBom.rollUpBom(db, { bomId, qtyTarget: 1, period: '' });
  const s1 = roll.stages.find(s => Number(s.operation_id) === Number(op1) || Number(s.seq) === 10);
  const s2 = roll.stages.find(s => Number(s.operation_id) === Number(op2) || Number(s.seq) === 20);
  ok(s1 && s2, 'roll-up returns both same-cost-center operations');
  ok(s1 && Number(s1.material_rial) === 601,
    `shared 60% deterministic rounding = 601 (got ${s1 && s1.material_rial})`);
  ok(s2 && Number(s2.material_rial) === 501,
    `op2 gets shared 400 + sole 101 = 501 (got ${s2 && s2.material_rial})`);
  ok(s1 && s2 && Number(s1.material_rial) + Number(s2.material_rial) === 1102,
    'shared+sole operation amounts reconcile exactly to exploded BOM amount');
  skip('PENDING: issue rows do not expose per-operation shared quantities, so qty 60/40 cannot yet be proven end-to-end');

  console.log('G2 — replace-all validation is fail-closed');
  const before = JSON.stringify(assignments.listAssignments(db, bomId).map(r => [
    r.bom_line_id, r.operation_id, r.allocation_mode, r.share_percent,
  ]));
  let shareErr;
  try {
    assignments.replaceAssignments(db, bomId, [
      { bom_line_id: sharedLine, operation_id: op1, allocation_mode: 'shared', share_percent: 50 },
      { bom_line_id: sharedLine, operation_id: op2, allocation_mode: 'shared', share_percent: 30 },
    ]);
  } catch (e) { shareErr = e; }
  ok(shareErr && shareErr.code === 'E_SHARE_SUM', '50/30 is rejected with E_SHARE_SUM');
  ok(JSON.stringify(assignments.listAssignments(db, bomId).map(r => [
    r.bom_line_id, r.operation_id, r.allocation_mode, r.share_percent,
  ])) === before, 'invalid share replace leaves prior assignments untouched');

  const otherFg = product('G2-FG-OTHER', 'محصول دیگر G2', 0, 'finished', 1);
  const otherBom = db.prepare(`
    INSERT INTO bom_headers (code,product_id,version,status,base_qty,has_routing)
    VALUES ('G2-BOM-OTHER',?,1,'draft',1,1)
  `).run(otherFg).lastInsertRowid;
  const otherLine = db.prepare(`
    INSERT INTO bom_lines (bom_id,line_no,component_product_id,qty_per_base)
    VALUES (?,1,?,1)
  `).run(otherBom, solePart).lastInsertRowid;
  const otherOp = db.prepare(`
    INSERT INTO bom_operations (bom_id,seq,cost_center_id,operation_name)
    VALUES (?,1,?,'عملیات بیگانه')
  `).run(otherBom, cc).lastInsertRowid;
  let lineErr;
  let opErr;
  try {
    assignments.replaceAssignments(db, bomId, [
      { bom_line_id: otherLine, operation_id: op1, allocation_mode: 'sole' },
    ]);
  } catch (e) { lineErr = e; }
  try {
    assignments.replaceAssignments(db, bomId, [
      { bom_line_id: soleLine, operation_id: otherOp, allocation_mode: 'sole' },
    ]);
  } catch (e) { opErr = e; }
  ok(lineErr && lineErr.code === 'E_BOM_LINE_MISMATCH', 'foreign BOM line rejected');
  ok(opErr && opErr.code === 'E_BOM_OP_MISMATCH', 'foreign BOM operation rejected');
  ok(JSON.stringify(assignments.listAssignments(db, bomId).map(r => [
    r.bom_line_id, r.operation_id, r.allocation_mode, r.share_percent,
  ])) === before, 'cross-BOM rejections preserve prior assignments');
  skip('PENDING: offline replay equality awaits PA-10 capture.js ownership patch');
} finally {
  try { db.close(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

finish();
