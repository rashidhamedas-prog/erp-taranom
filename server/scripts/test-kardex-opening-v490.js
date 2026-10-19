'use strict';
/**
 * v490 — opening on fiscal from-date is اول دوره; void twins leave the live balance.
 * Run: node scripts/test-kardex-opening-v490.js
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

const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
ok(/erp-taranom-v490/.test(sw), 'SW v490');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(app.includes('پایان دوره = اول دوره + ورود − خروج'), 'kardex caption states the identity');
try { new Function(app); ok(true, 'app.js parses'); }
catch (e) { ok(false, 'app.js parse: ' + e.message); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kardex-open-v490-'));
process.env.NODE_ENV = 'test';
process.env.ERP_TEST_ISOLATION = '1';
process.env.DB_PATH = path.join(dir, 't.db');
process.env.COMPANIES_DIR = path.join(dir, 'companies');
process.env.JWT_SECRET = 'test-kardex-opening-v490-secret32';
process.env.SYNC_ROLE = 'central';

let db;
try {
  const dbMod = require('../db');
  dbMod.initDB();
  db = dbMod.getDB();
} catch (e) {
  if (/better-sqlite3|NODE_MODULE_VERSION/i.test(String(e && (e.stack || e)))) {
    console.log('SKIP ENV: better-sqlite3 unavailable');
    finish();
    process.exit(0);
  }
  throw e;
}

try {
  const { postInventoryMovement, reverseInventoryMovement } = require('../lib/inventory/ledger');
  const { buildStockLedger } = require('../lib/ledgers');
  const { fiscalOpeningDate } = require('../lib/opening-post');
  const adminId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
  const wh = db.prepare('SELECT id FROM warehouses WHERE active=1 ORDER BY id LIMIT 1').get().id;
  const fy = fiscalOpeningDate(db);

  const prod = db.prepare(`
    INSERT INTO products (user_id,name,code,price,stock,average_cost_rial,unit)
    VALUES (?,'پارچه تست اول دوره','K-490',0,0,1000,'متر')
  `).run(adminId).lastInsertRowid;

  postInventoryMovement(db, {
    eventType: 'opening', productId: prod, warehouseId: wh,
    qtyIn: 600, unitCostRial: 1000, sourceType: 'opening_inventory', sourceId: prod,
    date: fy, note: 'بهای اولیه موجودی — پارچه تست', createdBy: adminId, skipStock: true,
  });
  postInventoryMovement(db, {
    eventType: 'issue', productId: prod, warehouseId: wh,
    qtyOut: 80, unitCostRial: 1000, sourceType: 'fabric_roll', sourceId: 1,
    date: fy, note: 'مصرف زنده', createdBy: adminId, skipStock: true,
  });
  const voided = postInventoryMovement(db, {
    eventType: 'receipt', productId: prod, warehouseId: wh,
    qtyIn: 40, unitCostRial: 1000, sourceType: 'fabric_roll', sourceId: 2,
    date: fy, note: 'رسید ابطال‌شونده', createdBy: adminId,
  });
  reverseInventoryMovement(db, voided.id, {
    createdBy: adminId, date: fy, note: 'ابطال دریافت طاقه',
  });

  const ops = buildStockLedger(db, { product_id: prod, from: fy, to: '1405/12/29' });
  ok(Math.abs(Number(ops.opening_qty) - 600) < 0.001, 'opening on fiscal start is اول دوره', ops.opening_qty);
  ok(Math.abs(Number(ops.period_qty_in) || 0) < 0.001, 'opening is not period inflow', ops.period_qty_in);
  ok(Math.abs(Number(ops.period_qty_out) - 80) < 0.001, 'live issue is period out; void is not', ops.period_qty_out);
  ok(Math.abs(Number(ops.closing_qty) - 520) < 0.001, 'closing = opening + in − out', ops.closing_qty);
  const notes = (ops.lines || []).map((l) => l.description || '');
  ok(!notes.some((n) => /بهای اولیه|ابطال|رسید ابطال/.test(n)), 'opening and void pair are not table rows');
  ok(notes.some((n) => /مصرف زنده/.test(n)), 'live issue stays on the table');
  const last = ops.lines[ops.lines.length - 1];
  ok(last && Math.abs(Number(last.running_qty) - 520) < 0.001, 'running balance matches closing');

  const audit = buildStockLedger(db, { product_id: prod, from: fy, to: '1405/12/29', show_cancelled: 1 });
  ok(Number(audit.closing_qty) === Number(ops.closing_qty), 'audit toggle does not change closing');
  ok(Number(audit.period_qty_in) > Number(ops.period_qty_in), 'audit period in includes the voided receipt');
} finally {
  try { db.close(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

finish();
