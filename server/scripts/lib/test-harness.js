'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

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

/** Fresh temp DB + initDB */
function freshDb() {
  const tmp = path.join(os.tmpdir(), `test-prod-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  process.env.DB_PATH = tmp;
  const dbPath = path.resolve(__dirname, '../../db.js');
  delete require.cache[require.resolve(dbPath)];
  // coa-map / schema caches
  try { delete require.cache[require.resolve('../../lib/coa-map')]; } catch {}
  try { delete require.cache[require.resolve('../../lib/production/schema')]; } catch {}
  const dbMod = require('../../db');
  dbMod.initDB();
  return {
    db: dbMod.getDB(),
    dbMod,
    cleanup: () => {
      try { dbMod.getDB().close(); } catch {}
      try { fs.unlinkSync(tmp); } catch {}
      try { fs.unlinkSync(tmp + '-wal'); } catch {}
      try { fs.unlinkSync(tmp + '-shm'); } catch {}
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
