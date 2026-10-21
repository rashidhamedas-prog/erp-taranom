'use strict';
/**
 * v502 — opening هم‌ترازی inside the filter window is اول دوره (not alignOnly dead-zone).
 * Reproduces: audit toggle shows In=12 Balance=0, period 19/7, closing 0, stock 12.
 * Run: node scripts/test-kardex-align-audit-v502.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
let failed = 0;
function ok(cond, msg, extra) {
  if (cond) { passed++; console.log('  OK', msg); }
  else {
    failed++;
    console.error('  FAIL', msg, extra != null ? extra : '');
  }
}
function finish() {
  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
ok(/erp-taranom-v(502|\d{3,})/.test(sw), 'SW stamped >= v502');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(!app.includes('audit_only:!!l.audit_only') && app.includes('is_opening:!!l.is_opening'),
  'v508: UI maps is_opening, no audit_only');
ok(/پایان دوره = اول دوره \+ ورود( زنده)? − خروج( زنده)?/.test(app), 'kardex caption states the identity');
try { new Function(app); ok(true, 'app.js parses'); }
catch (e) { ok(false, 'app.js parse: ' + e.message); }

const ledgersSrc = fs.readFileSync(path.join(__dirname, '../lib/ledgers.js'), 'utf8');
ok(ledgersSrc.includes('alignOnly dead-zone') || ledgersSrc.includes('alignOnly'),
  'ledgers mentions alignOnly guard');
ok(ledgersSrc.includes('if (isOpeningStockRow(r)) return false'),
  'opening seeds are not audit-only');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kardex-align-v502-'));
process.env.NODE_ENV = 'test';
process.env.ERP_TEST_ISOLATION = '1';
process.env.DB_PATH = path.join(dir, 't.db');
process.env.COMPANIES_DIR = path.join(dir, 'companies');
process.env.JWT_SECRET = 'test-kardex-align-v502-secret32by';
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
  const {
    buildStockLedger, isOpeningStockRow, isAuditOnlyStockRow,
  } = require('../lib/ledgers');

  const adminId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
  const whA = db.prepare('SELECT id FROM warehouses WHERE active=1 ORDER BY id LIMIT 1').get().id;
  let whB = db.prepare('SELECT id FROM warehouses WHERE active=1 AND id<>? ORDER BY id LIMIT 1').get(whA)?.id;
  if (!whB) {
    whB = db.prepare(
      "INSERT INTO warehouses (name, code, active) VALUES ('انبار کیمیا تست','WH-KIMIA-501',1)"
    ).run().lastInsertRowid;
  }

  // Real bug shape: active FY often starts 1405/01/01 (seed default) while
  // reconcile posts opening seed on 1405/06/31. Old countsAsOpening missed it.
  const seedDate = '1405/06/31';
  try {
    db.prepare(`
      UPDATE fiscal_years SET start_date='1405/01/01', end_date='1405/12/29', status='open'
      WHERE id=(SELECT id FROM fiscal_years ORDER BY id LIMIT 1)
    `).run();
  } catch (e2) {
    console.log('  note: fiscal_years update skipped', e2.message);
  }

  const prod = db.prepare(`
    INSERT INTO products (user_id,name,code,price,stock,average_cost_rial,unit,warehouse_id)
    VALUES (?,'کاپشن تست ممیزی','7150-501',0,12,5779860,'عدد',?)
  `).run(adminId, whA).lastInsertRowid;
  db.prepare(
    'INSERT OR REPLACE INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,12)'
  ).run(prod, whA);

  // Seed row identical to reconcileProductStockLedger noteIn (هم‌ترازی in note).
  postInventoryMovement(db, {
    eventType: 'opening', productId: prod, warehouseId: whA,
    qtyIn: 12, unitCostRial: 5779860, sourceType: 'opening_inventory', sourceId: prod,
    date: seedDate, note: 'موجودی اول دوره (هم‌ترازی کاردکس)', createdBy: adminId,
    skipStock: true, updateAvg: false,
  });
  // Inter-warehouse transfer pair (net zero company-wide).
  postInventoryMovement(db, {
    eventType: 'transfer_out', productId: prod, warehouseId: whA,
    qtyOut: 7, unitCostRial: 5779860, sourceType: 'warehouse_move', sourceId: 413,
    date: '1405/07/06', note: 'خروج انتقال به انبار کیمیا', createdBy: adminId,
    skipStock: true, updateAvg: false,
  });
  postInventoryMovement(db, {
    eventType: 'transfer_in', productId: prod, warehouseId: whB,
    qtyIn: 7, unitCostRial: 5779860, sourceType: 'warehouse_move', sourceId: 414,
    date: '1405/07/06', note: 'ورود انتقال از انبار محصول', createdBy: adminId,
    skipStock: true, updateAvg: false,
  });

  const seed = {
    event_type: 'opening',
    source_type: 'opening_inventory',
    status: 'posted',
    note: 'موجودی اول دوره (هم‌ترازی کاردکس)',
  };
  ok(isOpeningStockRow(seed), 'seed note+event is opening');
  ok(!isAuditOnlyStockRow(seed), 'opening seed is NOT audit-only (no alignOnly dead-zone)');

  const ops = buildStockLedger(db, {
    product_id: prod, from: '1405/01/01', to: '1405/12/29',
  });
  ok(Math.abs(Number(ops.opening_qty) - 12) < 0.001, 'ops opening=12', ops.opening_qty);
  ok(Math.abs(Number(ops.period_qty_in) - 7) < 0.001, 'ops period in=7 (transfer only)', ops.period_qty_in);
  ok(Math.abs(Number(ops.period_qty_out) - 7) < 0.001, 'ops period out=7', ops.period_qty_out);
  ok(Math.abs(Number(ops.closing_qty) - 12) < 0.001, 'ops closing=12', ops.closing_qty);
  ok(Math.abs(Number(ops.control_gap_qty) || 0) < 0.001, 'ops control_gap=0', ops.control_gap_qty);
  ok(!(ops.lines || []).some((l) => /هم[\u200c\s]*ترازی|اول دوره/.test(l.description || '')),
    'ops hides opening seed row');

  const audit = buildStockLedger(db, {
    product_id: prod, from: '1405/01/01', to: '1405/12/29', show_cancelled: 1,
  });
  ok(Math.abs(Number(audit.opening_qty) - 12) < 0.001, 'audit opening=12', audit.opening_qty);
  ok(Math.abs(Number(audit.closing_qty) - 12) < 0.001, 'audit closing=12 (= stock)', audit.closing_qty);
  ok(Math.abs(Number(audit.period_qty_in) - 7) < 0.001,
    'audit period in still 7 (seed not period inflow)', audit.period_qty_in);
  ok(Math.abs(Number(audit.control_gap_qty) || 0) < 0.001, 'audit control_gap=0', audit.control_gap_qty);
  ok(!(audit.lines || []).some((l) => /موجودی اول دوره/.test(l.description || '')),
    'v508: opening folded into اول دوره (flag ignored)');
  const all = buildStockLedger(db, { product_id: prod });
  const openLine = (all.lines || []).find((l) => /موجودی اول دوره/.test(l.description || ''));
  ok(!!openLine, 'no from-date: opening seed row shown');
  ok(!!openLine && openLine.is_opening, 'opening line flagged is_opening');
  ok(Math.abs(Number(all.closing_qty) - 12) < 0.001, 'no from-date: closing=12', all.closing_qty);
  const last = audit.lines[audit.lines.length - 1];
  ok(last && Math.abs(Number(last.running_qty) - 12) < 0.001,
    'final running matches closing 12', last && last.running_qty);
} finally {
  try { db.close(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

finish();
