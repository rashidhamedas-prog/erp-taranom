'use strict';
/** Optional production health checks — non-blocking in main suite */
const { ok, freshDb, summary } = require('./lib/test-harness');
const close = require('../lib/production/close');
const { runHealthCheck } = require('../lib/production/health-check');

console.log('\n══ Production Health (optional) ══\n');

const { db, cleanup } = freshDb();

const tables = [
  'production_orders', 'production_period_close', 'production_variances',
  'user_cost_centers', 'v_wip_by_order',
];
for (const t of tables) {
  ok(`table/view ${t}`, (() => {
    try {
      db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get();
      return true;
    } catch {
      return t.startsWith('v_') ? db.prepare("SELECT name FROM sqlite_master WHERE type='view' AND name=?").get(t) != null : false;
    }
  })());
}

for (const code of ['5201', '5202', '5203']) {
  const bal = close.accountBalance(db, code);
  ok(`control ${code} zero on fresh db`, Math.abs(bal) <= 5, `bal=${bal}`);
}

const bad5210 = db.prepare(`
  SELECT COUNT(*) c FROM journal_lines WHERE account_code IN ('5210','5211')
`).get()?.c || 0;
ok('no 5210/5211 journal lines', bad5210 === 0);

const hc = runHealthCheck(db);
ok('runHealthCheck ok on fresh db', hc.ok === true);
ok('runHealthCheck returns checks array', Array.isArray(hc.checks) && hc.checks.length >= 12);

cleanup();
summary('Production Health');
