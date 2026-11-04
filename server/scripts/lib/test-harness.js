'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// Many production route tests `require('../routes/…')` after loading this harness.
// auth-sessions reads JWT_SECRET at module load — set a test secret early.
if (!process.env.JWT_SECRET || String(process.env.JWT_SECRET).length < 32) {
  process.env.JWT_SECRET = 'erp-test-isolation-jwt-secret-32chars!!';
}

let passed = 0, failed = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else {
    failed++;
    failures.push(name);
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

function eq(name, actual, expected, tol = 0) {
  const diff = Math.abs(Number(actual) - Number(expected));
  ok(name, diff <= tol,
    `انتظار ${Number(expected).toLocaleString()} · دریافت ${Number(actual).toLocaleString()} · اختلاف ${diff}`);
}

/** Documented prod defect tracked elsewhere: printed, never counted as pass or fail. */
function knownIssue(name, reason) {
  console.log(`  ⚠️  KNOWN ISSUE ${name} — ${reason}`);
}

function throws(name, fn, code) {
  try {
    fn();
    ok(name, false, 'خطایی رخ نداد');
  } catch (e) {
    ok(name, String(e.code || e.message).includes(code),
      `انتظار ${code} · دریافت ${e.code || e.message}`);
  }
}

/** Fresh temp DB + initDB (isolated from multi-company registry / shared Temp DBs). */
function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-prod-'));
  const tmp = path.join(tmpDir, 'crm.db');
  process.env.DB_PATH = tmp;
  process.env.COMPANIES_DIR = path.join(tmpDir, 'companies');
  process.env.ERP_TEST_ISOLATION = '1';
  // Route modules load auth → getJwtSecret(); production NODE_ENV needs ≥32 chars.
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    process.env.JWT_SECRET = 'erp-test-isolation-jwt-secret-32chars!!';
  }
  const bust = (rel) => {
    try { delete require.cache[require.resolve(rel)]; } catch { /* optional */ }
  };
  bust('../../db.js');
  bust('../../lib/coa-map');
  bust('../../lib/production/schema');
  bust('../../lib/company-workspace');
  bust('../../lib/clean-slate');
  bust('../../lib/ledger');
  bust('../../lib/money');
  bust('../../lib/security');
  bust('../../lib/auth-sessions');
  bust('../../middleware/auth');
  const dbMod = require('../../db');
  if (typeof dbMod.closeDB === 'function') {
    try { dbMod.closeDB(); } catch { /* first load */ }
  }
  dbMod.initDB();
  return {
    db: dbMod.getDB(),
    dbMod,
    cleanup: () => {
      try { dbMod.closeDB ? dbMod.closeDB() : dbMod.getDB().close(); } catch {}
      try { fs.unlinkSync(tmp); } catch {}
      try { fs.unlinkSync(tmp + '-wal'); } catch {}
      try { fs.unlinkSync(tmp + '-shm'); } catch {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  };
}

/**
 * Fixture stock via inventory documents only (P1 Kardex SSOT): products.stock / warehouse_stock
 * are ledger caches, so raw UPDATEs no longer change available qty.
 */
function seedOpeningStock(db, productId, warehouseId, qty, unitCostRial) {
  if (!warehouseId || !(Number(qty) > 0)) return;
  const unit = unitCostRial != null ? Number(unitCostRial)
    : Number(db.prepare('SELECT average_cost_rial FROM products WHERE id=?').get(productId)?.average_cost_rial) || 0;
  require('../../lib/inventory/ledger').postInventoryMovement(db, {
    eventType: 'opening', productId, warehouseId, qtyIn: Number(qty), unitCostRial: unit,
    sourceType: 'test_fixture', note: 'fixture opening', updateAvg: false,
  });
}

/** Adjust (product, warehouse) to `target` qty with an adjustment document; returns the delta posted. */
function setStockTo(db, productId, warehouseId, target) {
  const ledger = require('../../lib/inventory/ledger');
  const delta = Number(target) - ledger.warehouseQty(db, productId, warehouseId);
  if (Math.abs(delta) < 1e-9) return 0;
  const unit = Number(db.prepare('SELECT average_cost_rial FROM products WHERE id=?').get(productId)?.average_cost_rial) || 0;
  ledger.postInventoryMovement(db, {
    eventType: 'adjustment', productId, warehouseId,
    ...(delta > 0 ? { qtyIn: delta } : { qtyOut: -delta }),
    unitCostRial: unit, sourceType: 'test_fixture', note: 'fixture adjust', updateAvg: false,
  });
  return delta;
}

function seedTaranom(db) {
  try {
    require('./seed-taranom').seedTaranom(db);
  } catch {
    /* optional in P0 */
  }
}

function summary(title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${title}: ✅ ${passed} پاس · ${failed ? '❌ ' + failed + ' ناموفق' : '🎉 همه پاس'}`);
  if (failures.length) {
    console.log('\nناموفق‌ها:');
    failures.forEach(f => console.log('  • ' + f));
  }
  process.exit(failed === 0 ? 0 : 1);
}

function resetCounters() {
  passed = 0;
  failed = 0;
  failures.length = 0;
}

module.exports = { ok, eq, throws, knownIssue, freshDb, seedOpeningStock, setStockTo, seedTaranom, summary, resetCounters };
