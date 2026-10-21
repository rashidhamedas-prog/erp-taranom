'use strict';
/**
 * v517 — خطاهای لاگ سرور:
 *  - salary_structures با نام نقل‌قول‌شده: UNIQUE(person_id, fiscal_year) در بوت حذف شود و تریگرهای سینک بمانند.
 *  - stock_logs.user_id NOT NULL: حرکت/ابطال بدون createdBy نباید خطا دهد.
 *  - ADR-011: سند «اضافه طاقه» (PRD-18) و اسناد ابطال‌شده هشدار سلامت تولید نسازند.
 * Run: node server/scripts/test-log-fixes-v517.js
 */
const fs = require('fs');
const path = require('path');
const { ok, eq, summary } = require('./lib/test-harness');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

{
  const srv = read('server.js');
  ok('cron uses adr011ViolationLines', srv.includes("require('./lib/production/health-check').adr011ViolationLines(db)"));
  ok('error handler: 4xx → warn with route', /console\.warn\(`request rejected \$\{status\}:`, where/.test(srv));
  ok('go-live check uses shared ADR-011 helper', read('scripts/production-go-live-check.js').includes('adr011ViolationLines(db)'));
  const app = read('public/app.js');
  try { new Function(app); ok('app.js parses', true); } catch (e) { ok('app.js parses', false, e.message); }
  ok('help v517', app.includes('پایش لاگ سرور (v517)'));
}

let dbOk = false;
try {
  const { freshDb } = require('./lib/test-harness');
  const { db, dbMod, cleanup } = freshDb();
  try {
    const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get();

    // ── salary_structures: rebuild with a quoted name + UNIQUE, as on production ──
    const cur = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='salary_structures'").get().sql;
    const body = cur.slice(cur.indexOf('('));
    const legacy = 'CREATE TABLE "salary_structures" ' + body.replace(/\)\s*$/, ',\n      UNIQUE(person_id, fiscal_year)\n    )');
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec('DROP TABLE salary_structures');
    db.exec(legacy);
    const sqlBefore = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='salary_structures'").get().sql;
    ok('setup: quoted name + UNIQUE', /^CREATE TABLE "salary_structures"/.test(sqlBefore) && /UNIQUE\(person_id, fiscal_year\)/.test(sqlBefore));
    db.prepare('INSERT INTO salary_structures (person_id, fiscal_year) VALUES (?, ?)').run(901, 1405);
    db.exec('PRAGMA foreign_keys=ON');

    const errs = [];
    const origErr = console.error;
    console.error = (...a) => { errs.push(a.join(' ')); origErr(...a); };
    try { dbMod.initDB(); } finally { console.error = origErr; }

    ok('no dropUniquePersonYear error on boot', !errs.some((l) => l.includes('dropUniquePersonYear')), errs.join(' | '));
    const sqlAfter = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='salary_structures'").get().sql;
    ok('UNIQUE(person_id, fiscal_year) removed', !/UNIQUE\s*\(\s*person_id\s*,\s*fiscal_year\s*\)/i.test(sqlAfter));
    eq('rows preserved', db.prepare('SELECT COUNT(*) c FROM salary_structures WHERE person_id=901').get().c, 1);
    db.exec('PRAGMA foreign_keys=OFF');
    db.prepare('INSERT INTO salary_structures (person_id, fiscal_year) VALUES (?, ?)').run(901, 1405);
    db.exec('PRAGMA foreign_keys=ON');
    eq('second ruling same person/year allowed', db.prepare('SELECT COUNT(*) c FROM salary_structures WHERE person_id=901').get().c, 2);
    const objs = db.prepare("SELECT name FROM sqlite_master WHERE tbl_name='salary_structures'").all().map((r) => r.name);
    for (const n of ['trg_sync_ins_salary_structures', 'trg_sync_upd_salary_structures', 'trg_sync_del_salary_structures',
      'idx_salary_structures_sync_seq', 'idx_salary_structures_person_eff']) {
      ok(`object kept: ${n}`, objs.includes(n));
    }
    const seq = db.prepare('SELECT MAX(sync_seq) s FROM salary_structures WHERE person_id=901').get().s;
    ok('sync trigger stamps new rows', Number(seq) > 0, String(seq));
    ok('no leftover temp table', !db.prepare("SELECT 1 FROM sqlite_master WHERE name='salary_structures__multi'").get());

    // ── stock_logs.user_id: movement + reversal without createdBy ──
    const { postInventoryMovement, reverseInventoryMovement } = require('../lib/inventory/ledger');
    const wh = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get() || db.prepare('SELECT id FROM warehouses LIMIT 1').get();
    const pid = db.prepare(`
      INSERT INTO products (user_id, name, code, price, stock, unit, average_cost_rial, cost, item_type)
      VALUES (?, 'آزمون v517', 'V517-1', 0, 0, 'm', 1000, 1000, 'raw')
    `).run(admin.id).lastInsertRowid;
    let led = null;
    try {
      led = postInventoryMovement(db, {
        eventType: 'production_receipt', productId: pid, warehouseId: wh.id, qtyIn: 5,
        unitCostRial: 1000, amountRial: 5000, sourceType: 'test_v517', sourceId: 1, date: '1405/07/29',
      });
      ok('movement without createdBy', !!(led && led.id));
    } catch (e) { ok('movement without createdBy', false, e.message); }
    try {
      reverseInventoryMovement(db, led.id, { note: 'ابطال آزمون v517' });
      ok('reversal without createdBy', true);
    } catch (e) { ok('reversal without createdBy', false, e.message); }
    eq('stock_logs rows use user 0', db.prepare('SELECT COUNT(*) c FROM stock_logs WHERE product_id=? AND user_id=0').get(pid).c, 2);

    // ── ADR-011: roll surplus (PRD-18) and voided entries are exempt ──
    const hc = require('../lib/production/health-check');
    const before = hc.adr011ViolationLines(db).length;
    const je = (refType, deleted) => {
      const id = db.prepare(`
        INSERT INTO journal_entries (entry_date, description, ref_type, ref_id, deleted_at)
        VALUES ('1405/07/29', 'آزمون v517', ?, 1, ?)
      `).run(refType, deleted ? 1 : null).lastInsertRowid;
      db.prepare(`INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial)
        VALUES (?, '5211', 'انحراف مقدار مواد', 0, 100, 0, 100)`).run(id);
      return id;
    };
    je('cutting_roll_surplus', false);
    je('production_material_issue', true);
    eq('surplus + voided entries exempt', hc.adr011ViolationLines(db).length, before);
    ok('5211 balance ignores surplus', Math.abs(hc.adr011Balance(db, '5211')) < 1);
    je('production_material_issue', false);
    eq('real variance still flagged', hc.adr011ViolationLines(db).length, before + 1);
    const c3 = hc.runHealthCheck(db).checks.find((c) => c.code === 'C3');
    eq('health C3 counts only the real variance line', c3 && c3.rows, before + 1);

    dbOk = true;
  } finally {
    cleanup();
  }
} catch (e) {
  if (/bindings|better_sqlite3|NODE_MODULE_VERSION/i.test(String(e.message) + e)) {
    console.log('  SKIP db path: better-sqlite3 not loaded on this Node');
    ok('db path skipped (static assertions still ran)', true);
  } else {
    ok('db path', false, e.stack || e.message);
  }
}
if (dbOk) ok('db log-fixes path', true);

summary('log-fixes-v517');
