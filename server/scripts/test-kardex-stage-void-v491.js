'use strict';
/**
 * v491 — voided stage issues leave the live kardex (and opening is fiscal start).
 * Run: node scripts/test-kardex-stage-void-v491.js
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
ok(/erp-taranom-v49[01]/.test(sw) || /erp-taranom-v\d+/.test(sw), 'SW present');
const ledgersSrc = fs.readFileSync(path.join(__dirname, '../lib/ledgers.js'), 'utf8');
ok(ledgersSrc.includes('حواله مرحله') && ledgersSrc.includes('production_return'),
  'legacy void hide covers stage issues');
const costingSrc = fs.readFileSync(path.join(__dirname, '../lib/production/costing.js'), 'utf8');
ok(costingSrc.includes('reverseIssueStock') && costingSrc.includes('findProductionIssueLedger'),
  'stage void reverses the original issue ledger');
const eng = fs.readFileSync(path.join(__dirname, '../lib/production/engine-advanced.js'), 'utf8');
ok(eng.includes('reverseIssueStock'), 'reverseStage uses reverseIssueStock');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kardex-stage-v491-'));
process.env.NODE_ENV = 'test';
process.env.ERP_TEST_ISOLATION = '1';
process.env.DB_PATH = path.join(dir, 't.db');
process.env.COMPANIES_DIR = path.join(dir, 'companies');
process.env.JWT_SECRET = 'test-kardex-stage-void-v491-secret32';
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
  const { retireOrphanVoidedProductionIssues } = require('../lib/inventory/ledger');
  const { buildStockLedger } = require('../lib/ledgers');
  const { fiscalOpeningDate } = require('../lib/opening-post');
  const adminId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
  const wh = db.prepare('SELECT id FROM warehouses WHERE active=1 ORDER BY id LIMIT 1').get().id;
  const fy = fiscalOpeningDate(db);

  const prod = db.prepare(`
    INSERT INTO products (user_id,name,code,price,stock,average_cost_rial,unit)
    VALUES (?,'آستری تست مرحله','K-491',0,1000,1000,'یارد')
  `).run(adminId).lastInsertRowid;
  db.prepare('UPDATE products SET stock=? WHERE id=?').run(1000, prod);
  db.prepare(
    'INSERT OR REPLACE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)'
  ).run(prod, wh, 1000);

  postInventoryMovement(db, {
    eventType: 'opening', productId: prod, warehouseId: wh,
    qtyIn: 600, unitCostRial: 1000, sourceType: 'opening_inventory', sourceId: prod,
    date: '1405/06/31', note: 'بهای اولیه موجودی — آستری تست', createdBy: adminId,
    skipStock: true,
  });
  const { redateOpeningDocsToFiscalStart } = require('../lib/opening-post');
  const dated = redateOpeningDocsToFiscalStart(db);
  ok(dated.ledger >= 1, 'mid-year opening redated to fiscal start');
  const openRow = db.prepare(
    "SELECT date FROM inventory_ledger WHERE product_id=? AND note LIKE 'بهای اولیه%' LIMIT 1"
  ).get(prod);
  ok(openRow && openRow.date === fy, 'opening date is fiscal start', openRow && openRow.date);

  // Seed stock so issues can post
  postInventoryMovement(db, {
    eventType: 'receipt', productId: prod, warehouseId: wh,
    qtyIn: 500, unitCostRial: 1000, sourceType: 'fabric_roll', sourceId: 1,
    date: fy, note: 'رسید پایه تست', createdBy: adminId,
  });

  const issue = postInventoryMovement(db, {
    eventType: 'production_issue', productId: prod, warehouseId: wh,
    qtyOut: 221, unitCostRial: 1000, sourceType: 'production_issue', sourceId: 13,
    date: '1405/07/05', note: 'مرحله 10 — PO-0013', createdBy: adminId,
  });
  postInventoryMovement(db, {
    eventType: 'production_return', productId: prod, warehouseId: wh,
    qtyIn: 221, unitCostRial: 1000, sourceType: 'production_material_return', sourceId: 99,
    date: '1405/07/06', note: 'ابطال مصرف PO-0013', createdBy: adminId,
  });
  // Manual حواله without PO in the note — void twin carries the PO + order id.
  let hawaleOrderId = null;
  try {
    const cols = db.prepare('PRAGMA table_info(production_orders)').all().map((c) => c.name);
    if (cols.includes('order_no')) {
      hawaleOrderId = db.prepare(
        "INSERT INTO production_orders (order_no, status) VALUES ('PO-0077','voided')"
      ).run().lastInsertRowid;
    }
  } catch (_) { hawaleOrderId = null; }
  let hawale = null;
  if (hawaleOrderId) {
    hawale = postInventoryMovement(db, {
      eventType: 'production_issue', productId: prod, warehouseId: wh,
      qtyOut: 50, unitCostRial: 1000, sourceType: 'production_issue', sourceId: hawaleOrderId,
      date: '1405/07/07', note: 'حواله مرحله 10', createdBy: adminId,
    });
    postInventoryMovement(db, {
      eventType: 'production_return', productId: prod, warehouseId: wh,
      qtyIn: 50, unitCostRial: 1000, sourceType: 'production_material_return', sourceId: 100,
      date: '1405/07/07', note: 'ابطال مصرف PO-0077', createdBy: adminId,
    });
  }
  ok(!!issue.id, 'stage issue seeded');

  const before = buildStockLedger(db, { product_id: prod, from: '1405/01/01', to: '1405/12/29' });
  const beforeNotes = (before.lines || []).map((l) => l.description || '');
  ok(!beforeNotes.some((n) => /مرحله 10 — PO-0013|ابطال مصرف PO-0013/.test(n)),
    'operational kardex hides voided stage issue and twin');
  if (hawale) {
    ok(!beforeNotes.some((n) => /حواله مرحله 10|ابطال مصرف PO-0077/.test(n)),
      'حواله without PO token is hidden via order_no on twin');
  }
  ok(Math.abs(Number(before.opening_qty) - 600) < 0.001, 'opening shows 600 even if from is before FY start', before.opening_qty);

  const heal = retireOrphanVoidedProductionIssues(db);
  ok(heal.count >= 1, 'heal retires orphan stage void pair', heal);
  const st = db.prepare('SELECT status FROM inventory_ledger WHERE id=?').get(issue.id);
  ok(st && st.status === 'reversed', 'original issue soft-retired');

  const after = buildStockLedger(db, { product_id: prod, from: fy, to: '1405/12/29' });
  ok(Math.abs(Number(after.opening_qty) - 600) < 0.001, 'opening still 600 after heal');
  ok(!(after.lines || []).some((l) => /مرحله 10/.test(l.description || '')),
    'healed issue absent from table');
} finally {
  try { db.close(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

finish();
