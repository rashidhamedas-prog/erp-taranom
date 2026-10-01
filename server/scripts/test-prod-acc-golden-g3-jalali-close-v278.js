'use strict';
/**
 * PROD-ACC PA-12 G3 — Jalali leap close and closed-period mutation guards.
 * Run from server/: node scripts/test-prod-acc-golden-g3-jalali-close-v278.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { periodEndJalali } = require('../jalali');

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

console.log('G3 — pure Jalali leap boundaries');
ok(periodEndJalali('1403/12') === '1403/12/30', '1403/12 ends on leap day 30');
ok('1403/12/30' <= periodEndJalali('1403/12'), '1403/12/30 is inside the close boundary');
ok('1404/01/01' > periodEndJalali('1403/12'), '1404/01/01 is outside the 1403/12 boundary');
ok(periodEndJalali('1404/12') === '1404/12/29', '1404/12 common Esfand ends on day 29');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-acc-g3-'));
process.env.NODE_ENV = 'test';
process.env.ERP_TEST_ISOLATION = '1';
process.env.DB_PATH = path.join(dir, 'g3.db');
process.env.COMPANIES_DIR = path.join(dir, 'companies');
process.env.JWT_SECRET = 'test-prod-acc-golden-g3-secret-32-bytes';
process.env.SYNC_ROLE = 'central';

let db;
try {
  const dbMod = require('../db');
  dbMod.initDB();
  db = dbMod.getDB();
} catch (e) {
  if (/better-sqlite3|NODE_MODULE_VERSION|was compiled against/i.test(String(e && (e.stack || e)))) {
    console.log('SKIP ENV: better-sqlite3 is unavailable for this Node ABI; pure Jalali checks still ran.');
    skip('native SQLite close/period-lock assertions');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    finish();
    process.exit(failed ? 1 : 0);
  }
  throw e;
}

try {
  const close = require('../lib/production/close');
  const engine = require('../lib/production/engine');
  const adminId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
  const fg = db.prepare(`
    INSERT INTO products
      (user_id,name,code,price,stock,average_cost_rial,unit,item_type,is_manufactured)
    VALUES (?,'محصول G3','G3-FG',0,0,0,'عدد','finished',1)
  `).run(adminId).lastInsertRowid;
  const raw = db.prepare(`
    INSERT INTO products
      (user_id,name,code,price,stock,average_cost_rial,unit,item_type,is_manufactured)
    VALUES (?,'ماده G3','G3-RAW',0,100,1000,'عدد','raw',0)
  `).run(adminId).lastInsertRowid;
  const whRaw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get().id;
  const whFg = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get().id;
  const cc = db.prepare("SELECT id FROM cost_centers WHERE is_stage=1 ORDER BY id LIMIT 1").get().id;
  const supplier = db.prepare("INSERT INTO suppliers (name) VALUES ('تأمین‌کننده G3')").run().lastInsertRowid;
  const po = db.prepare(`
    INSERT INTO production_orders
      (order_no,product_id,qty_planned,status,date,period_label,warehouse_raw_id,warehouse_fg_id,created_by)
    VALUES ('G3-PO',?,1,'in_progress','1403/12/30','1403/12',?,?,?)
  `).run(fg, whRaw, whFg, adminId).lastInsertRowid;

  console.log('G3 — close helpers use one persisted Jalali end date');
  const period = close.openPeriod(db, { period: '1403/12', userId: adminId });
  ok(period.end_date === '1403/12/30', `openPeriod persisted 1403/12/30 (got ${period.end_date})`);
  const status = close.getPeriodStatus(db, '1403/12');
  ok(status.end_date === periodEndJalali('1403/12'), 'status and Jalali helper agree on end date');
  db.prepare(`
    UPDATE production_period_close
    SET status='closed', closed_by=?, closed_at=strftime('%s','now')
    WHERE period_label='1403/12'
  `).run(adminId);

  let engineErr;
  try { engine.assertPeriodOpen(db, '1403/12'); } catch (e) { engineErr = e; }
  ok(engineErr && engineErr.code === 'E_PERIOD_CLOSED', 'engine guard rejects closed production period');

  console.log('G3 — every schema-level production writer is fail-closed');
  const writes = [
    ['production_material_issues', `
      INSERT INTO production_material_issues
        (order_id,product_id,qty_actual,unit_cost_rial,amount_rial,warehouse_id,date,period_label)
      VALUES (?,?,1,1000,1000,?,'1403/12/30','1403/12')
    `, [po, raw, whRaw]],
    ['production_labor_entries', `
      INSERT INTO production_labor_entries
        (order_id,cost_center_id,method,amount_rial,date,period_label)
      VALUES (?,?,'piece',1000,'1403/12/30','1403/12')
    `, [po, cc]],
    ['production_overhead_applications', `
      INSERT INTO production_overhead_applications
        (order_id,cost_center_id,driver,driver_qty,rate_rial,amount_rial,date,period_label)
      VALUES (?,?,'output_qty',1,1000,1000,'1403/12/30','1403/12')
    `, [po, cc]],
    ['production_receipts', `
      INSERT INTO production_receipts
        (order_id,product_id,qty,unit_cost_rial,amount_rial,warehouse_id,date,period_label)
      VALUES (?,?,1,1000,1000,?,'1403/12/30','1403/12')
    `, [po, fg, whFg]],
    ['production_waste', `
      INSERT INTO production_waste
        (order_id,product_id,waste_type,qty,date,period_label)
      VALUES (?,?,'normal',1,'1403/12/30','1403/12')
    `, [po, raw]],
    ['production_rework', `
      INSERT INTO production_rework (order_id,qty,date,period_label)
      VALUES (?,1,'1403/12/30','1403/12')
    `, [po]],
    ['production_subcontract', `
      INSERT INTO production_subcontract
        (order_id,supplier_id,direction,product_id,qty,date,period_label)
      VALUES (?,?,'send',?,1,'1403/12/30','1403/12')
    `, [po, supplier, raw]],
  ];
  for (const [table, sql, args] of writes) {
    let caught;
    try { db.prepare(sql).run(...args); } catch (e) { caught = e; }
    ok(caught && /E_PERIOD_CLOSED/.test(String(caught.message || caught.code)),
      `${table} insert rejected with E_PERIOD_CLOSED`);
    ok(Number(db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE period_label='1403/12'`).get().c) === 0,
      `${table} remains unchanged after rejection`);
  }

  skip('PENDING: execute close JE/snapshot completeness needs a fully seeded close fixture');
  skip('PENDING: PA-09 compare-and-swap drift-safe reopen is not implemented in wave1');
  skip('PENDING: close→reopen→reclose reconciliation remains dependent on PA-09');
} finally {
  try { db.close(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

finish();
