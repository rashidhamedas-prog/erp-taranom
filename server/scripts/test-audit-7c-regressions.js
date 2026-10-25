'use strict';
/**
 * Audit 7C — turn known red/regression accounting tests green (or document skip).
 *
 * Suite (findings #78–#82 from compliance canvas):
 *   - test-cheque-books-v339.js          (#78 phantom opening cheque)
 *   - test-cheque-resend-softvoid-v496.js (#79 soft-void resend / v497 redeposit)
 *   - test-cheque-opening-bounce-v186.js  (#78/#79 bounce→resend books)
 *   - test-payroll-accounting.js         (#80 SSO child-exempt fixture)
 *   - test-cutting-lay-covered-void-v468.js (#81 live PACK blocks void)
 *   - test-settlement-leaf-je-v351.js     (#82 books reverse retire)
 *
 * Run:
 *   $env:DB_PATH="server/.tmp-test-artifacts/wave-test-7c.db"
 *   npm --prefix server run test:audit-7c
 *
 * Uses throw-away DB under .tmp-test-artifacts. Refuses crm*.db.
 * Exits non-zero if any child fails (unless ABI skip for better-sqlite3).
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

(function guardDbPath() {
  const raw = process.env.DB_PATH || '';
  if (!raw) {
    console.error('FATAL: DB_PATH is required under server/.tmp-test-artifacts, e.g.');
    console.error('  $env:DB_PATH="server/.tmp-test-artifacts/wave-test-7c.db"');
    process.exit(1);
  }
  if (/^crm.*\.db$/i.test(path.basename(raw))) {
    console.error('FATAL: DB_PATH looks like production crm*.db:', path.basename(raw));
    process.exit(1);
  }
  if (!/\.tmp-test-artifacts/i.test(raw.replace(/\\/g, '/'))) {
    console.error('FATAL: DB_PATH must live under .tmp-test-artifacts');
    process.exit(1);
  }
})();

let Database;
try {
  const Better = require('better-sqlite3');
  new Better(':memory:').close();
  Database = Better;
} catch (e) {
  console.log('SKIP — better-sqlite3 binding missing for this Node:', e.message.split('\n')[0]);
  console.log('  Use Node 20/22 with a rebuilt native module, or run on Iran runtime.');
  console.log('  Ticket note: AUDIT-7C ABI skip — suite not executed on this host.');
  process.exit(0);
}
void Database;

const artDir = path.resolve(path.dirname(process.env.DB_PATH));
fs.mkdirSync(artDir, { recursive: true });

const SUITE = [
  { id: '#78', name: 'cheque-books-v339', script: 'test-cheque-books-v339.js' },
  { id: '#79', name: 'cheque-resend-softvoid-v496', script: 'test-cheque-resend-softvoid-v496.js' },
  { id: '#78/#79', name: 'cheque-opening-bounce-v186', script: 'test-cheque-opening-bounce-v186.js' },
  { id: '#80', name: 'payroll-accounting', script: 'test-payroll-accounting.js' },
  { id: '#81', name: 'cutting-lay-covered-void-v468', script: 'test-cutting-lay-covered-void-v468.js' },
  { id: '#82', name: 'settlement-leaf-je-v351', script: 'test-settlement-leaf-je-v351.js' },
];

console.log('\n══ Audit 7C — red/regression accounting suite ══\n');

let failed = 0;
let passed = 0;
for (const t of SUITE) {
  const childDb = path.join(artDir, `7c-harness-${t.name}.db`);
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(childDb + ext); } catch (_) { /* none */ }
  }
  console.log(`—— ${t.id} ${t.name} ——`);
  const r = spawnSync(process.execPath, [path.join(__dirname, t.script)], {
    env: {
      ...process.env,
      DB_PATH: childDb,
      SYNC_ROLE: process.env.SYNC_ROLE || 'central',
      ERP_TEST_ISOLATION: '1',
      JWT_SECRET: process.env.JWT_SECRET || 'audit-7c-harness-secret-32bytes!!',
    },
    encoding: 'utf8',
    timeout: 120000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const tail = out.split(/\r?\n/).slice(-8).join('\n');
  if (r.status === 0) {
    passed += 1;
    console.log(`  ✅ PASS ${t.name}`);
    if (tail) console.log(tail.split('\n').map((l) => '     ' + l).join('\n'));
  } else {
    failed += 1;
    console.log(`  ❌ FAIL ${t.name} (exit ${r.status == null ? 'signal' : r.status})`);
    if (tail) console.log(tail.split('\n').map((l) => '     ' + l).join('\n'));
  }
  console.log('');
}

console.log(`══ 7C result: ${passed} pass, ${failed} fail (of ${SUITE.length}) ══`);
process.exit(failed ? 1 : 0);
