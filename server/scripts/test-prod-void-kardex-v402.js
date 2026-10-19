'use strict';
/**
 * v402 — voided production receipts must not linger in operational kardex.
 * Run: node scripts/test-prod-void-kardex-v402.js
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

const costingSrc = fs.readFileSync(path.join(__dirname, '../lib/production/costing.js'), 'utf8');
ok(costingSrc.includes('findProductionReceiptLedger'), 'findProductionReceiptLedger helper');
ok(costingSrc.includes('reverseInventoryMovement'), 'void uses reverseInventoryMovement');

const ledgersSrc = fs.readFileSync(path.join(__dirname, '../lib/ledgers.js'), 'utf8');
ok(ledgersSrc.includes('collectLegacyVoidedReceiptIds'), 'legacy void pair hide');
ok(ledgersSrc.includes("endsWith('_reversal')"), '*_reversal treated as audit-only');

const swSrc = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const m = swSrc.match(/erp-taranom-v(\d+)/);
ok(m && Number(m[1]) >= 402, `SW >= v402 (got ${m ? m[0] : 'none'})`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-void-kardex-v402-'));
process.env.NODE_ENV = 'test';
process.env.ERP_TEST_ISOLATION = '1';
process.env.DB_PATH = path.join(dir, 't.db');
process.env.COMPANIES_DIR = path.join(dir, 'companies');
process.env.JWT_SECRET = 'test-prod-void-kardex-v402-secret32';
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
  const { postInventoryMovement } = require('../lib/inventory/ledger');
  const { reverseReceiptStock } = require('../lib/production/costing');
  const { buildStockLedger, isAuditOnlyStockRow } = require('../lib/ledgers');

  const adminId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
  const wh = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG' OR active=1 ORDER BY id LIMIT 1").get().id;
  const prod = db.prepare(`
    INSERT INTO products (user_id,name,code,price,stock,average_cost_rial,unit)
    VALUES (?,'کالای تست ابطال تولید','PV-402',0,0,1000,'عدد')
  `).run(adminId).lastInsertRowid;

  // --- Path A: proper reverse marks original reversed ---
  const live = postInventoryMovement(db, {
    eventType: 'production_receipt', productId: prod, warehouseId: wh,
    qtyIn: 10, unitCostRial: 1000, sourceType: 'production_receipt', sourceId: 9001,
    date: '1405/07/20', note: 'تولید PO-9001', createdBy: adminId,
  });
  reverseReceiptStock(db, {
    productId: prod, warehouseId: wh, qty: 10, unitCostRial: 1000,
    amountRial: 10000, prevAvgRial: 0, userId: adminId,
    note: 'ابطال رسید PO-9001', orderId: 9001, orderNo: 'PO-9001',
    date: '1405/07/21',
  });
  const liveAfter = db.prepare('SELECT status FROM inventory_ledger WHERE id=?').get(live.id);
  ok(liveAfter.status === 'reversed', 'proper void marks original ledger reversed');

  const opsA = buildStockLedger(db, { product_id: prod });
  const notesA = (opsA.lines || []).map((l) => l.description || '');
  ok(!notesA.some((n) => /PO-9001/.test(n)), 'proper void pair hidden from operational kardex');

  // --- Path B: legacy orphan (posted receipt + separate *_reversal outbound) ---
  const orphan = postInventoryMovement(db, {
    eventType: 'production_receipt', productId: prod, warehouseId: wh,
    qtyIn: 164, unitCostRial: 1000, sourceType: 'production_receipt', sourceId: 6,
    date: '1405/07/22', note: 'تولید PO-0006', createdBy: adminId,
  });
  postInventoryMovement(db, {
    eventType: 'production_receipt_reversal', productId: prod, warehouseId: wh,
    qtyOut: 164, unitCostRial: 1000, sourceType: 'production_receipt_reversal', sourceId: 2,
    date: '1405/07/22', note: 'ابطال رسید PO-0006', createdBy: adminId,
  });
  ok(isAuditOnlyStockRow({ event_type: 'production_receipt_reversal', note: 'ابطال رسید PO-0006' }),
    'production_receipt_reversal is audit-only');

  const opsB = buildStockLedger(db, { product_id: prod });
  const notesB = (opsB.lines || []).map((l) => l.description || '');
  ok(!notesB.some((n) => /PO-0006/.test(n)), 'legacy void pair (original+ابطال) hidden operationally');
  ok(db.prepare('SELECT status FROM inventory_ledger WHERE id=?').get(orphan.id).status === 'posted',
    'legacy original still posted in DB (soft-hide, not hard delete)');

  const audit = buildStockLedger(db, { product_id: prod, show_cancelled: 1 });
  const aNotes = (audit.lines || []).map((l) => l.description || '');
  ok(aNotes.some((n) => /PO-0006/.test(n)), 'audit toggle reveals legacy void pair');

  // Live closed-order style receipt must remain visible
  postInventoryMovement(db, {
    eventType: 'production_receipt', productId: prod, warehouseId: wh,
    qtyIn: 50, unitCostRial: 1000, sourceType: 'production_receipt', sourceId: 8,
    date: '1405/07/23', note: 'تولید PO-0008', createdBy: adminId,
  });
  const opsC = buildStockLedger(db, { product_id: prod });
  ok((opsC.lines || []).some((l) => /PO-0008/.test(l.description || '')),
    'live closed PO receipt stays in operational kardex');
  ok(Math.abs(Number(opsC.closing_qty) - 50) < 0.001,
    'closing qty = live PO-0008 only (void pairs net to zero)');
  ok(Math.abs(Number(opsC.period_qty_in) - 50) < 0.001,
    'period in is the live receipt only', opsC.period_qty_in);
  ok(Math.abs(Number(opsC.period_qty_out) || 0) < 0.001,
    'period out excludes voided issues', opsC.period_qty_out);
  const audit2 = buildStockLedger(db, { product_id: prod, show_cancelled: 1 });
  ok(Number(opsC.closing_qty) === Number(audit2.closing_qty),
    'closing identical with/without audit rows in the table');
  ok(Number(audit2.period_qty_in) > Number(opsC.period_qty_in),
    'audit toggle puts voided receipts back into period in', audit2.period_qty_in);
} finally {
  try { db.close(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

finish();
