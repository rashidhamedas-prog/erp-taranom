'use strict';
/**
 * PROD-ACC F07 — legacy production_runs writes must be gated
 * Run: node server/scripts/test-prod-acc-legacy-gate-v279.js
 *
 * Part A (static) always runs: asserts the gate is wired onto the mutating
 * routes and that the legacy UI/help reflect it.
 * Part B (live DB) needs a better-sqlite3 binary matching the running Node ABI;
 * if it is missing the DB assertions are SKIPped and the script still passes on
 * part A (same convention as test-prod-acc-f01-issue-v278.js).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
let passed = 0, failed = 0, skipped = 0;
function ok(c, m) {
  if (c) { passed++; console.log('  OK', m); }
  else { failed++; console.error('  FAIL', m); }
}
function skip(m) { skipped++; console.log('  SKIP', m); }

/* ---------- Part A — static wiring ---------- */
console.log('A) static — gate wiring in routes/production.js');
const routeSrc = fs.readFileSync(path.join(root, 'routes/production.js'), 'utf8');

ok(/router\.post\('\/',\s*auth,\s*adminOrAccounting,\s*legacyWriteGate,/.test(routeSrc),
  'POST / runs through legacyWriteGate');
ok(/router\.delete\('\/:id',\s*auth,\s*adminOrAccounting,\s*legacyWriteGate,/.test(routeSrc),
  'DELETE /:id runs through legacyWriteGate');
ok(/E_LEGACY_PRODUCTION_DISABLED/.test(routeSrc), 'E_LEGACY_PRODUCTION_DISABLED code present');
ok(/res\.status\(409\)\.json\(\{\s*\n?\s*code: 'E_LEGACY_PRODUCTION_DISABLED'/.test(routeSrc),
  'gate answers 409 (not 403/500)');
ok(/production_legacy_runs_enabled/.test(routeSrc), 'escape-hatch setting key present');

const getRoot = routeSrc.match(/router\.get\('\/',([^)]*)\)/);
ok(!!getRoot && !/legacyWriteGate/.test(getRoot[1]), 'GET / (history) is NOT gated');
const getConfig = routeSrc.match(/router\.get\('\/config',([^)]*)\)/);
ok(!!getConfig && !/legacyWriteGate/.test(getConfig[1]), 'GET /config is NOT gated');

ok((routeSrc.match(/assertLegacyPeriodOpen\(db,/g) || []).length >= 2,
  'period lock asserted on both POST and DELETE');
ok(/req\.user\.role !== 'admin'/.test(routeSrc), 'flipping the flag is admin-only');
ok(/legacy_blocked/.test(routeSrc), 'config payload exposes legacy_blocked for the UI');

console.log('A) static — legacy UI + help');
const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
ok(/const legacyBlocked=!!c\.legacy_blocked/.test(appSrc), 'legacy tab reads legacy_blocked from config');
ok(/\$\{legacyBlocked\?''\:`<div class="toolbar"[\s\S]{0,400}?productionModal\(\)/.test(appSrc),
  'ثبت اجرای تولید button hidden when blocked');
ok(/legacyBlocked\?`<span class="muted">—<\/span>`/.test(appSrc), 'ابطال button hidden when blocked');
ok(/ثبت اجرای تولید قدیمی غیرفعال است/.test(appSrc), 'Persian banner on the legacy tab');
ok(/E_LEGACY_PRODUCTION_DISABLED/.test(appSrc), 'help bullet documents the 409 code');
ok(/legacy_runs_enabled=el\('oh-legacy'\)\.checked/.test(appSrc), 'admin toggle posts legacy_runs_enabled');

/* ---------- Part B — live DB behaviour ---------- */
console.log('B) live DB — gate behaviour');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-acc-legacy-gate-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(dir, 't.db');
process.env.JWT_SECRET = 'test-prod-acc-legacy-gate-secret-32b';
process.env.SYNC_ROLE = 'central';

let db = null;
try {
  const { initDB, getDB } = require('../db');
  initDB();
  db = getDB();
} catch (e) {
  const native = /better_sqlite3|bindings file|NODE_MODULE_VERSION|was compiled against/i.test(e.message || '');
  if (!native) throw e;
  skip(`better-sqlite3 not loadable on this Node (${process.version}, abi ${process.versions.modules})`);
  skip('live gate assertions — run on Node20 / Iran VPS');
}

if (db) {
  const L = require('../routes/production')._legacy;
  const setFlag = v => db.prepare(
    'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(L.LEGACY_FLAG_KEY, v);
  const setSetting = (k, v) => db.prepare(
    'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(k, v);

  function runGate() {
    let nexted = false;
    const res = {
      _status: 200, _body: null,
      status(c) { this._status = c; return this; },
      json(b) { this._body = b; return this; },
    };
    L.legacyWriteGate({}, res, () => { nexted = true; });
    return { nexted, status: res._status, body: res._body };
  }

  ok(L.advancedProductionAvailable(db), 'advanced module detected on a fresh DB');
  ok(!L.legacyRunsEnabled(db), 'escape hatch defaults to off');
  ok(L.legacyBlocked(db), 'legacy writes blocked by default');

  let g = runGate();
  ok(!g.nexted, 'gate does not call next()');
  ok(g.status === 409, `gate status 409 (got ${g.status})`);
  ok(g.body && g.body.code === 'E_LEGACY_PRODUCTION_DISABLED', 'gate body code E_LEGACY_PRODUCTION_DISABLED');
  ok(g.body && /سفارش‌های تولید/.test(g.body.error || ''), 'gate error text points to سفارش‌های تولید');

  setFlag('1');
  g = runGate();
  ok(L.legacyRunsEnabled(db) && g.nexted, 'admin escape hatch (=1) lets the write through');

  setFlag('0');
  setSetting('production_module_enabled', '0');
  ok(!L.advancedProductionAvailable(db), 'production_module_enabled=0 → advanced not available');
  g = runGate();
  ok(g.nexted, 'with the advanced module off, legacy stays usable (no regression for old installs)');
  setSetting('production_module_enabled', '1');

  console.log('B) live DB — period lock (escape hatch on)');
  ok(L.jalaliPeriod('1405/7/15') === '1405/07', `jalaliPeriod pads month (got ${L.jalaliPeriod('1405/7/15')})`);
  db.prepare(`
    INSERT INTO production_period_close (period_label, start_date, end_date, status)
    VALUES ('1405/06','1405/06/01','1405/06/31','closed')
  `).run();
  let threw = null;
  try { L.assertLegacyPeriodOpen(db, '1405/06/20'); } catch (e) { threw = e; }
  ok(threw && threw.code === 'E_PERIOD_CLOSED', 'closed period rejects a legacy run');
  ok(threw && threw.status === 409, 'period rejection is 409');
  let threwOpen = null;
  try { L.assertLegacyPeriodOpen(db, '1405/07/02'); } catch (e) { threwOpen = e; }
  ok(!threwOpen, 'open period accepts a legacy run');

  const runs = db.prepare('SELECT COUNT(*) c FROM production_runs').get();
  ok(Number(runs.c) === 0, 'gate test wrote no production_runs rows');
}

/* ---------- Part C — gate semantics on a stub DB (no native module) ---------- */
console.log('C) stub DB — gate semantics (runs everywhere)');
function stubDb({ settings = {}, tables = ['production_orders', 'production_period_close'], closed = [] } = {}) {
  return {
    prepare(sql) {
      if (/FROM settings WHERE key=\?/.test(sql)) {
        return { get: k => (settings[k] == null ? undefined : { value: settings[k] }) };
      }
      if (/FROM sqlite_master/.test(sql)) {
        return { get: n => (tables.includes(n) ? { 1: 1 } : undefined) };
      }
      if (/FROM production_period_close/.test(sql)) {
        return { get: p => (closed.includes(p) ? { 1: 1 } : undefined) };
      }
      throw new Error('stubDb: unexpected sql ' + sql);
    },
  };
}

// Load the route module against a stubbed ../db so the middleware can be driven
// without better-sqlite3. Must come after part B, which needs the real module.
let current = stubDb();
for (const m of ['../routes/production', '../middleware/auth', '../db']) {
  try { delete require.cache[require.resolve(m)]; } catch (_) {}
}
const dbId = require.resolve('../db');
require.cache[dbId] = {
  id: dbId, filename: dbId, loaded: true, children: [], paths: [],
  exports: { getDB: () => current, audit: () => {}, isDevice: () => false, allocateNumber: () => 1 },
};
const S = require('../routes/production')._legacy;

function gateOn(fake) {
  current = fake;
  let nexted = false;
  const res = {
    _status: 200, _body: null,
    status(c) { this._status = c; return this; },
    json(b) { this._body = b; return this; },
  };
  S.legacyWriteGate({}, res, () => { nexted = true; });
  return { nexted, status: res._status, body: res._body };
}

let s = gateOn(stubDb());
ok(!s.nexted && s.status === 409 && s.body.code === 'E_LEGACY_PRODUCTION_DISABLED',
  'advanced installed + flag unset → 409 E_LEGACY_PRODUCTION_DISABLED');
ok(/سند حسابداری/.test(s.body.error || ''), 'error explains the missing journal entry');
ok(/admin/.test(s.body.hint || ''), 'hint names the admin escape hatch');

s = gateOn(stubDb({ settings: { production_legacy_runs_enabled: '1' } }));
ok(s.nexted, 'production_legacy_runs_enabled=1 → write passes');

s = gateOn(stubDb({ settings: { production_legacy_runs_enabled: '0', production_module_enabled: '0' } }));
ok(s.nexted, 'production_module_enabled=0 → legacy still allowed (old installs keep working)');

s = gateOn(stubDb({ tables: [] }));
ok(s.nexted, 'advanced tables absent → legacy still allowed');

s = gateOn(stubDb({ tables: ['production_orders'] }));
ok(s.nexted, 'half-installed advanced schema is not treated as available');

s = gateOn(stubDb({ settings: { production_legacy_runs_enabled: 'yes' } }));
ok(!s.nexted && s.status === 409, 'only the exact value 1 opens the hatch');

const closedDb = stubDb({ closed: ['1405/06'] });
let t = null;
try { S.assertLegacyPeriodOpen(closedDb, '1405/6/20'); } catch (e) { t = e; }
ok(t && t.code === 'E_PERIOD_CLOSED' && t.status === 409, 'unpadded jalali month still matches a closed period');
t = null;
try { S.assertLegacyPeriodOpen(closedDb, '1405/07/02'); } catch (e) { t = e; }
ok(!t, 'open month passes the period lock');
t = null;
try { S.assertLegacyPeriodOpen(stubDb({ tables: [] }), '1405/06/20'); } catch (e) { t = e; }
ok(!t, 'no production_period_close table → period lock is a no-op');

console.log(`\nResult: ${passed} passed, ${failed} failed, ${skipped} skipped`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
if (failed) process.exit(1);
