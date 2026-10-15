'use strict';
/**
 * v400 — hide void/reversal + هم‌ترازی from operational kardex & journal list.
 * Run: node scripts/test-hide-audit-rows-v400.js
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

const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(appSrc.includes('نمایش ابطال و هم‌ترازی'), 'UI checkbox renamed for kardex audit');
ok(appSrc.includes('jdShowAudit') && appSrc.includes('include_audit'), 'journal docs audit toggle');
{
  const swSrc = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  const m = swSrc.match(/erp-taranom-v(\d+)/);
  ok(m && Number(m[1]) >= 400, `SW >= v400 (got ${m ? m[0] : 'none'})`);
}

const ledgersSrc = fs.readFileSync(path.join(__dirname, '../lib/ledgers.js'), 'utf8');
ok(ledgersSrc.includes('isAuditOnlyStockRow'), 'isAuditOnlyStockRow helper');
ok(ledgersSrc.includes('stock_reconcile'), 'stock_reconcile treated as audit-only');

const accSrc = fs.readFileSync(path.join(__dirname, '../routes/accounting.js'), 'utf8');
ok(accSrc.includes('include_audit') && accSrc.includes('همترازی'), 'journal API filters align docs');

const excelSrc = fs.readFileSync(path.join(__dirname, '../routes/excel.js'), 'utf8');
ok(excelSrc.includes("status,'posted')<>'reversed'") && excelSrc.includes('همترازی'),
  'excel journal-docs excludes void+align');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hide-audit-v400-'));
process.env.NODE_ENV = 'test';
process.env.ERP_TEST_ISOLATION = '1';
process.env.DB_PATH = path.join(dir, 't.db');
process.env.COMPANIES_DIR = path.join(dir, 'companies');
process.env.JWT_SECRET = 'test-hide-audit-v400-secret-32byt';
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
  const { buildStockLedger, isAuditOnlyStockRow } = require('../lib/ledgers');
  const adminId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
  const wh = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG' OR active=1 ORDER BY id LIMIT 1").get().id;
  const prod = db.prepare(`
    INSERT INTO products (user_id,name,code,price,stock,average_cost_rial,unit)
    VALUES (?,'کالای تست ممیزی','AUD-400',0,0,1000,'عدد')
  `).run(adminId).lastInsertRowid;

  // Receipt first so sale/void never hit E_NEGATIVE_STOCK on empty WH.
  const recv = postInventoryMovement(db, {
    eventType: 'production_receipt', productId: prod, warehouseId: wh,
    qtyIn: 10, unitCostRial: 1000, sourceType: 'production_receipt', sourceId: 2,
    date: '1405/07/20', note: 'تولید تست', createdBy: adminId,
  });
  const sale = postInventoryMovement(db, {
    eventType: 'sale', productId: prod, warehouseId: wh,
    qtyOut: 5, unitCostRial: 1000, sourceType: 'invoice', sourceId: 1,
    date: '1405/07/21', note: 'فروش تست', createdBy: adminId,
  });
  // Void a small extra receipt (not the main one) so stock stays non-negative.
  const recvVoid = postInventoryMovement(db, {
    eventType: 'production_receipt', productId: prod, warehouseId: wh,
    qtyIn: 2, unitCostRial: 1000, sourceType: 'production_receipt', sourceId: 3,
    date: '1405/07/22', note: 'تولید ابطالی', createdBy: adminId,
  });
  reverseInventoryMovement(db, recvVoid.id, {
    createdBy: adminId, date: '1405/07/22', note: 'ابطال رسید تولید تست',
  });
  postInventoryMovement(db, {
    eventType: 'adjustment', productId: prod, warehouseId: wh,
    qtyIn: 3, unitCostRial: 1000, sourceType: 'stock_reconcile', sourceId: null,
    date: '1405/07/23', note: 'هم‌ترازی کاردکس با موجودی انبار', createdBy: adminId,
    skipStock: true,
  });

  ok(!!recv && !!sale, 'seed movements posted');
  ok(isAuditOnlyStockRow({ event_type: 'reversal', status: 'posted', note: 'x' }), 'reversal is audit-only');
  ok(isAuditOnlyStockRow({ status: 'posted', note: 'هم‌ترازی کاردکس با موجودی انبار', source_type: 'opening' }),
    'هم‌ترازی note is audit-only');
  ok(!isAuditOnlyStockRow({ status: 'posted', event_type: 'sale', note: 'فروش تست' }),
    'real sale is not audit-only');

  const ops = buildStockLedger(db, { product_id: prod });
  const notes = (ops.lines || []).map((l) => l.description || '');
  ok(notes.some((n) => /فروش/.test(n)), 'operational view keeps real sale');
  ok(notes.some((n) => /تولید تست/.test(n)), 'operational view keeps live receipt');
  ok(!notes.some((n) => /ابطال|معکوس|هم[\u200c\s]*ترازی/.test(n)),
    'operational view hides void and align notes');
  ok(!notes.some((n) => /تولید ابطالی/.test(n)), 'voided original receipt hidden');

  const audit = buildStockLedger(db, { product_id: prod, show_cancelled: 1 });
  const aNotes = (audit.lines || []).map((l) => l.description || '');
  ok(aNotes.some((n) => /هم[\u200c\s]*ترازی|ابطال|معکوس/.test(n)),
    'audit toggle shows void/align history');
  ok(Number(ops.closing_qty) === Number(audit.closing_qty),
    'closing qty identical with/without audit rows in the table');
} finally {
  try { db.close(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

finish();
