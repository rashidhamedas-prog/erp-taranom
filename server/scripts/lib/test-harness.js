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

module.exports = { ok, eq, throws, freshDb, seedTaranom, summary, resetCounters };
