'use strict';
/**
 * PROD-ACC PA-04 — operation material assignments + allowed variants
 * Run: node server/scripts/test-prod-acc-bom-matrix-v278.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-acc-pa04-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(dir, 't.db');
process.env.JWT_SECRET = 'test-prod-acc-pa04-secret-32-bytes-x';
process.env.SYNC_ROLE = 'central';

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const asg = require('../lib/production/bom-assignments');
const { initProductionSchema } = require('../lib/production/schema');
initProductionSchema(db);

let passed = 0, failed = 0;
function ok(c, m) {
  if (c) { passed++; console.log('  OK', m); }
  else { failed++; console.error('  FAIL', m); }
}

ok(!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='bom_material_assignments'").get(), 'assignments table');
ok(!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='bom_allowed_variants'").get(), 'allowed variants table');
ok(!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='production_order_lines'").get(), 'order lines table');

const adminId = db.prepare("SELECT id FROM users ORDER BY id LIMIT 1").get().id;
const fg = db.prepare(`
  INSERT INTO products (user_id, name, code, stock, average_cost_rial, unit, is_manufactured)
  VALUES (?,'مانتو ماتریس','FG-MX',0,0,'عدد',1)
`).run(adminId).lastInsertRowid;
const yarn = db.prepare(`
  INSERT INTO products (user_id, name, code, stock, average_cost_rial, unit, is_manufactured)
  VALUES (?,'نخ','YARN-MX',1000,100,'متر',0)
`).run(adminId).lastInsertRowid;
const cc = db.prepare(`
  INSERT INTO cost_centers (code, name, is_stage, active)
  VALUES ('CC-MX','دوخت ماتریس',1,1)
`).run().lastInsertRowid;

const bomId = db.prepare(`
  INSERT INTO bom_headers (code, product_id, version, status, base_qty, has_routing)
  VALUES ('BOM-MX',?,1,'draft',1,1)
`).run(fg).lastInsertRowid;
const lineId = db.prepare(`
  INSERT INTO bom_lines (bom_id, line_no, component_product_id, qty_per_base, stage_cost_center_id)
  VALUES (?,?,?,0.2,?)
`).run(bomId, 1, yarn, cc).lastInsertRowid;
const op1 = db.prepare(`
  INSERT INTO bom_operations (bom_id, seq, cost_center_id, operation_name)
  VALUES (?,1,?,'دوخت اصلی')
`).run(bomId, cc).lastInsertRowid;
const op2 = db.prepare(`
  INSERT INTO bom_operations (bom_id, seq, cost_center_id, operation_name)
  VALUES (?,2,?,'تقویت درز')
`).run(bomId, cc).lastInsertRowid;

function expectErr(fn, code, msg) {
  let caught = null;
  try { fn(); } catch (e) { caught = e; }
  ok(!!caught && caught.code === code, `${msg} (${caught ? caught.code : 'no error'})`);
}

console.log('F19 — legacy fallback before any assignment');
ok(asg.materialsByOperation(db, bomId).size === 0, 'materialsByOperation empty without assignments');
ok(asg.operationIdForLine(db, bomId, lineId) === Number(op1), 'legacy stage CC → earliest op');

console.log('F19 — shared assignment 60/40 on same CC two ops');
const rows = asg.replaceAssignments(db, bomId, [
  { bom_line_id: lineId, operation_id: op1, allocation_mode: 'shared', share_percent: 60 },
  { bom_line_id: lineId, operation_id: op2, allocation_mode: 'shared', share_percent: 40 },
]);
ok(rows.length === 2, '2 assignments stored');
const byOp = asg.materialsByOperation(db, bomId);
ok(byOp.get(Number(op1)) && byOp.get(Number(op2)), 'both ops have materials');

let shareErr = null;
try {
  asg.replaceAssignments(db, bomId, [
    { bom_line_id: lineId, operation_id: op1, allocation_mode: 'shared', share_percent: 50 },
    { bom_line_id: lineId, operation_id: op2, allocation_mode: 'shared', share_percent: 30 },
  ]);
} catch (e) { shareErr = e; }
ok(!!shareErr && shareErr.code === 'E_SHARE_SUM', 'share sum != 100 rejected');

console.log('F19b — assignment guards + atomicity');
let modeErr = null;
try {
  asg.replaceAssignments(db, bomId, [
    { bom_line_id: lineId, operation_id: op1, allocation_mode: 'sole' },
    { bom_line_id: lineId, operation_id: op2, allocation_mode: 'sole' },
  ]);
} catch (e) { modeErr = e; }
ok(!!modeErr && modeErr.code === 'E_ASSIGN_MODE', 'one line on two ops must be shared');

let dupErr = null;
try {
  asg.replaceAssignments(db, bomId, [
    { bom_line_id: lineId, operation_id: op1, allocation_mode: 'shared', share_percent: 50 },
    { bom_line_id: lineId, operation_id: op1, allocation_mode: 'shared', share_percent: 50 },
  ]);
} catch (e) { dupErr = e; }
ok(!!dupErr && dupErr.code === 'E_ASSIGN_DUPLICATE', 'duplicate line+op rejected');

const fg2 = db.prepare(`
  INSERT INTO products (user_id, name, code, stock, average_cost_rial, unit, is_manufactured)
  VALUES (?,'شومیز ماتریس','FG-MX2',0,0,'عدد',1)
`).run(adminId).lastInsertRowid;
const otherBom = db.prepare(`
  INSERT INTO bom_headers (code, product_id, version, status, base_qty, has_routing)
  VALUES ('BOM-MX2',?,1,'draft',1,1)
`).run(fg2).lastInsertRowid;
const otherLine = db.prepare(`
  INSERT INTO bom_lines (bom_id, line_no, component_product_id, qty_per_base)
  VALUES (?,1,?,0.5)
`).run(otherBom, yarn).lastInsertRowid;
let fkErr = null;
try {
  asg.replaceAssignments(db, bomId, [{ bom_line_id: otherLine, operation_id: op1 }]);
} catch (e) { fkErr = e; }
ok(!!fkErr && fkErr.code === 'E_BOM_LINE_MISMATCH', 'line from another BOM rejected');

ok(asg.listAssignments(db, bomId).length === 2, 'rejected payloads keep previous assignments');

console.log('F19c — two ops on one cost center stay independent');
const button = db.prepare(`
  INSERT INTO products (user_id, name, code, stock, average_cost_rial, unit, is_manufactured)
  VALUES (?,'دکمه','BTN-MX',1000,250,'عدد',0)
`).run(adminId).lastInsertRowid;
const line2 = db.prepare(`
  INSERT INTO bom_lines (bom_id, line_no, component_product_id, qty_per_base, stage_cost_center_id)
  VALUES (?,2,?,4,?)
`).run(bomId, button, cc).lastInsertRowid;
asg.replaceAssignments(db, bomId, [
  { bom_line_id: lineId, operation_id: op1, allocation_mode: 'sole' },
  { bom_line_id: line2, operation_id: op2, allocation_mode: 'sole' },
]);
const perOp = asg.materialsByOperation(db, bomId);
ok((perOp.get(Number(op1)) || []).length === 1 && (perOp.get(Number(op2)) || []).length === 1,
  'each op owns exactly its own line');

const adv = require('../lib/production/bom-advanced');
db.prepare("UPDATE bom_operations SET labor_method='contract' WHERE bom_id=?").run(bomId);
adv.clearRollUpMemo();
const roll = adv.rollUpBom(db, { bomId, qtyTarget: 10, period: '' });
const st1 = roll.stages.find(s => s.seq === 1);
const st2 = roll.stages.find(s => s.seq === 2);
// 10 × 0.2 × 100 = 200 on op1, 10 × 4 × 250 = 10000 on op2
ok(st1 && st1.material_rial === 200, `op1 material = 200 (got ${st1 && st1.material_rial})`);
ok(st2 && st2.material_rial === 10000, `op2 material = 10000 (got ${st2 && st2.material_rial})`);
ok(st1 && st2 && (st1.material_rial + st2.material_rial) === 10200, 'no double counting across ops');

console.log('F20 — allowed variants');
const vars = asg.replaceAllowedVariants(db, bomId, [
  { color_id: 1, size_id: 10 },
  { color_id: 1, size_id: 11 },
  { color_id: 2, size_id: 10 },
]);
ok(vars.length === 3, '3 allowed variants');
ok(asg.replaceAllowedVariants(db, bomId, [
  { color_id: 1, size_id: 10 },
  { color_id: 1, size_id: 10 },
]).length === 1, 'duplicate color×size deduped');
expectErr(() => asg.replaceAllowedVariants(db, bomId, [{ color_id: 0, size_id: 10 }]),
  'E_VARIANT_ARGS', 'non-positive color_id rejected');

const otherFg = db.prepare(`
  INSERT INTO products (user_id, name, code, stock, average_cost_rial, unit, is_manufactured)
  VALUES (?,'مانتو دیگر','FG-MX3',0,0,'عدد',1)
`).run(adminId).lastInsertRowid;
const colorId = db.prepare("INSERT INTO product_colors (code, name) VALUES ('C-MX','سرمه‌ای')").run().lastInsertRowid;
const sizeId = db.prepare("INSERT INTO product_sizes (code, name) VALUES ('S-MX','38')").run().lastInsertRowid;
const foreignVariant = db.prepare(`
  INSERT INTO product_variants (product_id, color_id, size_id, active) VALUES (?,?,?,1)
`).run(otherFg, colorId, sizeId).lastInsertRowid;
expectErr(() => asg.replaceAllowedVariants(db, bomId, [{ variant_id: foreignVariant }]),
  'E_VARIANT_PRODUCT_MISMATCH', 'variant of another product rejected');

console.log('F19d — field-level guards');
expectErr(() => asg.replaceAssignments(db, bomId, [
  { bom_line_id: lineId, operation_id: op1, allocation_mode: 'shared', share_percent: 150 },
  { bom_line_id: lineId, operation_id: op2, allocation_mode: 'shared', share_percent: -50 },
]), 'E_SHARE_RANGE', 'negative share rejected before sum check');
expectErr(() => asg.replaceAssignments(db, bomId, [
  { bom_line_id: lineId, operation_id: op1, allocation_mode: 'split', share_percent: 100 },
]), 'E_ASSIGN_MODE', 'unknown allocation_mode rejected');
expectErr(() => asg.replaceAssignments(db, bomId, [
  { bom_line_id: lineId, operation_id: op1, qty_override: 'x' },
]), 'E_ASSIGN_QTY', 'non-numeric qty_override rejected');
expectErr(() => asg.replaceAssignments(db, bomId, [
  { bom_line_id: lineId, operation_id: op1, component_color_mode: 'fixed' },
]), 'E_BOM_COMP_COLOR', 'fixed component color without color_id rejected');
ok(asg.operationIdForLine(db, bomId, lineId) === Number(op1), 'sole assignment wins over legacy');

console.log('Lock — active BOM rejects matrix edits');
db.prepare("UPDATE bom_headers SET status='active' WHERE id=?").run(bomId);
expectErr(() => asg.replaceAssignments(db, bomId, []), 'E_BOM_LOCKED', 'assignments locked on active BOM');
expectErr(() => asg.replaceAllowedVariants(db, bomId, []), 'E_BOM_LOCKED', 'allowed variants locked on active BOM');
db.prepare("UPDATE bom_headers SET status='draft' WHERE id=?").run(bomId);
ok(asg.listAssignments(db, bomId).length === 2, 'assignments survived every rejection');

console.log(`\nResult: ${passed} passed, ${failed} failed`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
if (failed) process.exit(1);
