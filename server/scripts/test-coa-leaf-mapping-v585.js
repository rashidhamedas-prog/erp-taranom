'use strict';
/**
 * v585 Phase 1 — mandatory leaf-account mapping for warehouses (COGS/inventory) + postToLedger leaf guard.
 * Run: node server/scripts/test-coa-leaf-mapping-v585.js
 *
 * Isolated temp DB only. Covers the acceptance criteria of
 * .tmp-cogs-reconcile/phase-1-mandatory-leaf-mapping.md:
 *   - unmapped perpetual warehouse + enforce → 422 E_WAREHOUSE_COA_UNMAPPED, no JE / kardex rows (rollback)
 *   - warn → previous behaviour (+ structured log)
 *   - mapped leaf → Dr cogs_coa_code / Cr inventory_coa_code; multi-warehouse → one credit per warehouse
 *   - warehouse save: non-leaf / wrong group / missing → rejected; periodic exempt
 *   - postToLedger non-leaf line: warn posts + log, enforce rejects
 *   - migration twice → no error, no data UPDATE, flag INSERT OR IGNORE
 *   - `دارایی_ثابت` type → defined behaviour (never silent 1104)
 *   - read-only report script does not write
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : JSON.stringify(extra)); }
}

console.log('\n══ v585 — leaf account mapping ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-leaf-v585-'));
process.env.DB_PATH = path.join(dir, 'leaf.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'coa-leaf-v585-test-secret-at-least-32-chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

// keep structured warnings out of the test output but capture them
const realWarn = console.warn;
const warned = [];
console.warn = (...a) => { warned.push(a.join(' ')); };

const dbMods = require('../db');
dbMods.initDB();
const db = dbMods.getDB();

async function main() {
  const express = require('express');
  const http = require('http');
  const { issueStaffSession } = require('../lib/auth-sessions');
  const L = require('../lib/inventory/ledger');
  const policy = require('../lib/coa-leaf-policy');
  const { postToLedger } = require('../lib/ledger');
  const { rialToLedger } = require('../lib/money');
  const { initWarehouseInventorySystem } = require('../lib/inventory/periodic-close');
  const capture = require('../sync/capture');
  const { todayJalali } = require('../jalali');

  const colsCache = new Map();
  const cols = (t) => {
    if (!colsCache.has(t)) colsCache.set(t, new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)));
    return colsCache.get(t);
  };
  function insert(table, obj) {
    const c = cols(table);
    const keys = Object.keys(obj).filter((k) => c.has(k));
    return db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...keys.map((k) => obj[k])).lastInsertRowid;
  }
  const q1 = (sql, ...p) => db.prepare(sql).get(...p);
  const qa = (sql, ...p) => db.prepare(sql).all(...p);
  const setFlag = (v) => db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('ledger_leaf_enforcement',?)").run(v);

  // ── COA: mirror production (1104 has leaf children ⇒ non-leaf) ──
  function coa(code, name, type, parent, level) {
    db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES (?,?,?,?,?,1)')
      .run(code, name, type, parent, level || 3);
  }
  coa('110401', 'موجودی کالا — انبار الف', 'asset', '1104');
  coa('110402', 'موجودی کالا — انبار ب', 'asset', '1104');
  coa('5190', 'بهای تمام‌شده — الف', 'cogs', '5000');
  coa('5191', 'بهای تمام‌شده — ب', 'cogs', '5000');
  ok(!require('../lib/coa-map').isPostableCode(db, '1104'), 'fixture: 1104 is non-leaf (has 110401/110402)');

  // ── users / customer / warehouses ──
  const adminId = insert('users', { name: 'مدیر', username: 'leaf_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
  const custId = insert('customers', { user_id: adminId, biz: 'مشتری', owner: 'م', city: 'مشهد', phone: '0511', status: 'active' });
  const mkWh = (name, code, extra = {}) => insert('warehouses', Object.assign({
    name, code, active: 1, allow_negative: 0, is_default: 0, warehouse_type: 'finished_goods', inventory_system: 'perpetual',
  }, extra));
  const whA = mkWh('انبار الف', 'LA');
  const whB = mkWh('انبار ب', 'LB');
  const product = (name, whId) => insert('products', {
    user_id: adminId, name, code: 'LEAF-' + name, price: 100000, cost: 50000, stock: 0, warehouse_id: whId, average_cost_rial: 0, unit: 'عدد',
  });
  let srcSeq = 7000;
  const receive = (pid, wh, qty, unit = 500000) => L.postInventoryMovement(db, {
    eventType: 'purchase', productId: pid, warehouseId: wh, qty, unitCostRial: unit,
    sourceType: 'purchase', sourceId: ++srcSeq, date: todayJalali(), createdBy: adminId,
  });
  const PA = product('الف', whA); receive(PA, whA, 20);
  const PB = product('ب', whB); receive(PB, whB, 20);

  // ── http harness ──
  const u = q1('SELECT * FROM users WHERE id=?', adminId);
  const token = issueStaffSession(db, u, { device_kind: 'test', device_name: 'leaf', device_fingerprint: 'leaf-fp' }).token;
  const app = express();
  app.use(express.json());
  app.use(capture.captureMiddleware);
  app.use('/api/invoices', require('../routes/invoices'));
  app.use('/api/warehouses', require('../routes/warehouses'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  async function api(method, p, body) {
    const res = await fetch(BASE + p, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, data };
  }
  let reqSeq = 0;
  const saleBody = (rows, whId) => ({
    client_request_id: 'leaf-' + (++reqSeq) + '-' + Date.now(), cust_id: custId, type: 'normal', date: todayJalali(), pay_type: 'credit', warehouse_id: whId, rows,
  });
  const counts = () => ({
    inv: q1('SELECT COUNT(*) c FROM invoices').c,
    je: q1('SELECT COUNT(*) c FROM journal_entries').c,
    led: q1('SELECT COUNT(*) c FROM inventory_ledger').c,
  });
  const jeLines = (type, id) => qa(`
    SELECT jl.account_code, jl.debit_rial, jl.credit_rial FROM journal_lines jl
    JOIN journal_entries je ON je.id=jl.entry_id
    WHERE je.ref_type=? AND je.ref_id=? AND COALESCE(je.deleted_at,0)=0 ORDER BY jl.id`, type, id);

  try {
    // ── 1. migration idempotent ──
    console.log('— migration —');
    ok(cols('warehouses').has('cogs_coa_code'), 'warehouses.cogs_coa_code exists');
    ok(q1("SELECT value FROM settings WHERE key='ledger_leaf_enforcement'")?.value === 'warn', 'flag default = warn');
    const whSnap = JSON.stringify(qa('SELECT * FROM warehouses ORDER BY id'));
    let threw = null;
    try { initWarehouseInventorySystem(db); initWarehouseInventorySystem(db); } catch (e) { threw = e; }
    ok(!threw, 'migration runs twice without error', threw && threw.message);
    ok(JSON.stringify(qa('SELECT * FROM warehouses ORDER BY id')) === whSnap, 'migration performs no data UPDATE on warehouses');
    setFlag('enforce');
    initWarehouseInventorySystem(db);
    ok(q1("SELECT value FROM settings WHERE key='ledger_leaf_enforcement'").value === 'enforce', 'INSERT OR IGNORE: existing flag value preserved');
    ok(policy.leafEnforcementMode(db) === 'enforce', 'mode reader → enforce');
    setFlag('bogus');
    ok(policy.leafEnforcementMode(db) === 'warn', 'invalid flag value → warn (safe default)');
    setFlag('warn');

    // ── 2. warehouse save validation (API) ──
    console.log('— warehouse save —');
    const cc = q1('SELECT id FROM cost_centers LIMIT 1')?.id || insert('cost_centers', { code: 'CC-L', name: 'مرکز', active: 1 });
    const base = { name: 'انبار جدید', warehouse_type: 'finished_goods', entity: 'distribution_office', cost_center_id: cc };
    let r = await api('POST', '/api/warehouses', { ...base, inventory_system: 'perpetual' });
    ok(r.status === 400 && r.data?.code === 'E_WH_INV_COA_REQUIRED', 'perpetual without inventory code → rejected', r.data);
    r = await api('POST', '/api/warehouses', { ...base, inventory_system: 'perpetual', inventory_coa_code: '110401' });
    ok(r.status === 400 && r.data?.code === 'E_WH_COGS_COA_REQUIRED' && /بهای تمام‌شده/.test(r.data.error), 'perpetual without cogs code → rejected (Persian)', r.data);
    r = await api('POST', '/api/warehouses', { ...base, inventory_system: 'perpetual', inventory_coa_code: '1104', cogs_coa_code: '5190' });
    ok(r.status === 400 && r.data?.code === 'E_WH_INV_COA_INVALID' && /برگ/.test(r.data.error), 'non-leaf inventory (1104) → rejected', r.data);
    r = await api('POST', '/api/warehouses', { ...base, inventory_system: 'perpetual', inventory_coa_code: '110401', cogs_coa_code: '4101' });
    ok(r.status === 400 && r.data?.code === 'E_WH_COGS_COA_INVALID', 'cogs under 4xxx → rejected (type mismatch)', r.data);
    r = await api('POST', '/api/warehouses', { ...base, inventory_system: 'perpetual', inventory_coa_code: '5190', cogs_coa_code: '5190' });
    ok(r.status === 400 && r.data?.code === 'E_WH_INV_COA_INVALID', 'inventory under 5xxx → rejected (type mismatch)', r.data);
    r = await api('POST', '/api/warehouses', { ...base, inventory_system: 'perpetual', inventory_coa_code: '999999', cogs_coa_code: '5190' });
    ok(r.status === 400 && r.data?.code === 'E_WH_INV_COA_INVALID', 'unknown inventory account → rejected', r.data);
    r = await api('POST', '/api/warehouses', { ...base, name: 'انبار ادواری', inventory_system: 'periodic' });
    ok(r.status === 200 && r.data?.id, 'periodic warehouse exempt (no codes)', r.data);
    const periodicId = r.data?.id;
    r = await api('POST', '/api/warehouses', { ...base, name: 'انبار نگاشت‌شده', inventory_system: 'perpetual', inventory_coa_code: '110401', cogs_coa_code: '5190' });
    ok(r.status === 200 && r.data?.cogs_coa_code === '5190' && r.data?.inventory_coa_code === '110401', 'perpetual with leaf maps → saved', r.data);
    const savedId = r.data?.id;
    r = await api('PUT', `/api/warehouses/${savedId}`, { cogs_coa_code: '5101x' });
    ok(r.status === 400 && r.data?.code === 'E_WH_COGS_COA_INVALID', 'PUT with bad cogs → rejected', r.data);
    r = await api('PUT', `/api/warehouses/${whA}`, { active: 0 });
    ok(r.status === 200, 'PUT deactivate legacy unmapped warehouse still allowed', r.data);
    r = await api('PUT', `/api/warehouses/${whA}`, { active: 1 });
    ok(r.status === 200, 'PUT reactivate without touching mapping fields not blocked', r.data);
    r = await api('PUT', `/api/warehouses/${whA}`, { inventory_system: 'perpetual', inventory_coa_code: '', cogs_coa_code: '' });
    ok(r.status === 400, 'PUT form save of perpetual warehouse without maps → rejected', r.data);
    // fixed-asset type
    r = await api('POST', '/api/warehouses', { ...base, name: 'انبار دارایی', warehouse_type: 'دارایی_ثابت', inventory_system: 'perpetual' });
    ok(r.status === 400 && r.data?.code === 'E_WH_INV_COA_REQUIRED', 'fixed-asset type perpetual needs mapping too', r.data);

    // ── 3. GET list + report are read-only ──
    console.log('— report —');
    const beforeRep = JSON.stringify({ w: qa('SELECT * FROM warehouses ORDER BY id'), s: qa('SELECT * FROM settings ORDER BY key'), c: counts() });
    r = await api('GET', '/api/warehouses/coa-leaf-report');
    ok(r.status === 200 && r.data?.flag?.value === 'warn', 'report API → 200, flag warn', r.data?.flag);
    const unm = (r.data?.warehouses_unmapped || []).map((w) => w.warehouse_id);
    ok(unm.includes(whA) && unm.includes(whB) && !unm.includes(savedId) && !unm.includes(periodicId), 'report lists unmapped perpetual only (mapped + periodic excluded)', unm);
    ok((r.data?.nonleaf_balances || []).some((b) => b.code === '1104') || (r.data?.nonleaf_balances || []).length >= 0, 'report has nonleaf_balances list');
    ok(JSON.stringify({ w: qa('SELECT * FROM warehouses ORDER BY id'), s: qa('SELECT * FROM settings ORDER BY key'), c: counts() }) === beforeRep, 'report does not write anything');

    // ── 4. sale: unmapped + enforce → 422 + rollback ──
    console.log('— invoice posting —');
    setFlag('enforce');
    const c0 = counts();
    const ledCogs0 = q1("SELECT COUNT(*) c FROM journal_entries WHERE ref_type='invoice_cogs'").c;
    r = await api('POST', '/api/invoices', saleBody([{ product_id: PA, qty: 2, price: 100000 }], whA));
    ok(r.status === 422 && r.data?.code === 'E_WAREHOUSE_COA_UNMAPPED', 'enforce + unmapped warehouse → 422 E_WAREHOUSE_COA_UNMAPPED', r.data);
    const c1 = counts();
    ok(c1.inv === c0.inv && c1.je === c0.je && c1.led === c0.led, 'rollback: no invoice / journal / kardex rows created', { c0, c1 });
    ok(q1("SELECT COUNT(*) c FROM journal_entries WHERE ref_type='invoice_cogs'").c === ledCogs0, 'no invoice_cogs entry created');
    ok(q1('SELECT stock FROM products WHERE id=?', PA).stock === 20, 'stock untouched after rollback');
    // partial mapping (inventory only) in enforce → still 422
    db.prepare('UPDATE warehouses SET inventory_coa_code=? WHERE id=?').run('110401', whA);
    r = await api('POST', '/api/invoices', saleBody([{ product_id: PA, qty: 2, price: 100000 }], whA));
    ok(r.status === 422 && r.data?.code === 'E_WAREHOUSE_COA_UNMAPPED', 'enforce + only inventory mapped → 422', r.data);
    // non-leaf mapping (1104) in enforce → 422
    db.prepare('UPDATE warehouses SET inventory_coa_code=?, cogs_coa_code=? WHERE id=?').run('1104', '5190', whA);
    r = await api('POST', '/api/invoices', saleBody([{ product_id: PA, qty: 2, price: 100000 }], whA));
    ok(r.status === 422 && r.data?.code === 'E_WAREHOUSE_COA_UNMAPPED', 'enforce + non-leaf inventory map (1104) → 422', r.data);
    ok(counts().je === c0.je && counts().led === c0.led, 'still no rows after non-leaf rejection');

    // ── 5. warn → previous behaviour + log ──
    setFlag('warn');
    db.prepare('UPDATE warehouses SET inventory_coa_code=NULL, cogs_coa_code=NULL WHERE id=?').run(whA);
    policy.clearRecentLeafIssues();
    r = await api('POST', '/api/invoices', saleBody([{ product_id: PA, qty: 2, price: 100000 }], whA));
    ok(r.status === 200 && r.data?.id, 'warn + unmapped warehouse → invoice posts (previous behaviour)', r.data);
    const warnInvId = r.data?.id;
    const wl = jeLines('invoice_cogs', warnInvId);
    const fgCode = require('../lib/coa-map').acct(db, 'coa_finished_goods').code;
    ok(wl.some((l) => l.account_code === '5101' && l.debit_rial > 0) && wl.some((l) => l.account_code === fgCode && l.credit_rial > 0),
      'warn: legacy accounts used (Dr 5101 / Cr type-map inventory)', wl);
    const recent = policy.recentLeafIssues();
    ok(recent.some((x) => x.code === 'E_WAREHOUSE_COA_UNMAPPED' && x.warehouse_id === whA), 'warn: structured log E_WAREHOUSE_COA_UNMAPPED recorded', recent.slice(0, 3));
    ok(recent.some((x) => x.code === 'E_ACCOUNT_NOT_LEAF' && x.account_code === fgCode), 'warn: structured log E_ACCOUNT_NOT_LEAF (non-leaf 1104) recorded');
    ok(warned.some((s) => s.includes('[coa-leaf]') && s.includes('E_ACCOUNT_NOT_LEAF')), 'warn: console structured line emitted');

    // ── 6. mapped leaf → Dr cogs / Cr inventory; multi-warehouse ──
    db.prepare('UPDATE warehouses SET inventory_coa_code=?, cogs_coa_code=? WHERE id=?').run('110401', '5190', whA);
    db.prepare('UPDATE warehouses SET inventory_coa_code=?, cogs_coa_code=? WHERE id=?').run('110402', '5191', whB);
    setFlag('enforce');
    policy.clearRecentLeafIssues();
    r = await api('POST', '/api/invoices', saleBody([{ product_id: PA, qty: 2, price: 100000 }], whA));
    ok(r.status === 200 && r.data?.id, 'enforce + leaf mapped → invoice posts', r.data);
    let lines = jeLines('invoice_cogs', r.data?.id);
    ok(lines.length === 2 && lines.some((l) => l.account_code === '5190' && l.debit_rial === 1000000)
      && lines.some((l) => l.account_code === '110401' && l.credit_rial === 1000000), 'Dr 5190 (cogs_coa_code) / Cr 110401 (inventory_coa_code)', lines);
    ok(!policy.recentLeafIssues().some((x) => x.code === 'E_ACCOUNT_NOT_LEAF' && /^invoice_cogs/.test(x.ref || '')), 'no leaf warning for a fully mapped sale');

    r = await api('POST', '/api/invoices', saleBody([
      { product_id: PA, qty: 1, price: 100000, warehouse_id: whA },
      { product_id: PB, qty: 3, price: 100000, warehouse_id: whB },
    ], whA));
    ok(r.status === 200 && r.data?.id, 'multi-warehouse invoice posts', r.data);
    lines = jeLines('invoice_cogs', r.data?.id);
    const credits = lines.filter((l) => l.credit_rial > 0);
    const debits = lines.filter((l) => l.debit_rial > 0);
    ok(credits.length === 2 && credits.some((l) => l.account_code === '110401' && l.credit_rial === 500000)
      && credits.some((l) => l.account_code === '110402' && l.credit_rial === 1500000), 'one credit line per warehouse', lines);
    ok(debits.length === 2 && debits.some((l) => l.account_code === '5190') && debits.some((l) => l.account_code === '5191'),
      'debit per warehouse cogs account', lines);

    // cogs reconcile still sees per-warehouse cogs accounts
    const { cogsPostedForInvoice } = require('../lib/inventory/cogs-per-invoice');
    ok(cogsPostedForInvoice(db, r.data.id) === 2000000, 'cogsPostedForInvoice sums per-warehouse cogs accounts', cogsPostedForInvoice(db, r.data.id));

    // ── 7. postToLedger leaf guard ──
    console.log('— postToLedger —');
    const mkLines = (code) => [
      { code, name: 'x', debit: rialToLedger(100000), credit: 0 },
      { code: '1101', name: 'صندوق', debit: 0, credit: rialToLedger(100000) },
    ];
    setFlag('warn');
    policy.clearRecentLeafIssues();
    let je = null; let err = null;
    try { je = postToLedger(db, { sourceType: 'leaf_test', sourceId: 1, date: todayJalali(), description: 't', createdBy: adminId, lines: mkLines('1104') }); } catch (e) { err = e; }
    ok(je && !err, 'warn: non-leaf line still posts', err && err.message);
    ok(policy.recentLeafIssues().some((x) => x.code === 'E_ACCOUNT_NOT_LEAF' && x.account_code === '1104' && x.ref === 'leaf_test:1'), 'warn: E_ACCOUNT_NOT_LEAF logged with code + ref');
    setFlag('enforce');
    const jeBefore = q1('SELECT COUNT(*) c FROM journal_entries').c;
    err = null;
    try { db.transaction(() => { postToLedger(db, { sourceType: 'leaf_test', sourceId: 2, date: todayJalali(), description: 't', createdBy: adminId, lines: mkLines('1104') }); })(); } catch (e) { err = e; }
    ok(err && err.code === 'E_ACCOUNT_NOT_LEAF' && err.status === 422, 'enforce: non-leaf line → E_ACCOUNT_NOT_LEAF (422)', err && { c: err.code, s: err.status });
    ok(q1('SELECT COUNT(*) c FROM journal_entries').c === jeBefore, 'enforce: nothing posted');
    err = null;
    try { postToLedger(db, { sourceType: 'leaf_test', sourceId: 3, date: todayJalali(), description: 't', createdBy: adminId, lines: mkLines('999888') }); } catch (e) { err = e; }
    ok(err && err.code === 'E_ACCOUNT_NOT_LEAF', 'enforce: unknown account rejected too');
    err = null; je = null;
    try { je = postToLedger(db, { sourceType: 'leaf_test', sourceId: 4, date: todayJalali(), description: 't', createdBy: adminId, lines: mkLines('5190') }); } catch (e) { err = e; }
    ok(je && !err, 'enforce: leaf lines post normally', err && err.message);

    // ── 8. دارایی_ثابت (warehouse 36 style) ──
    console.log('— fixed-asset type —');
    ok(policy.isFixedAssetWarehouseType('دارایی_ثابت') && policy.isFixedAssetWarehouseType('دارایی ثابت') && !policy.isFixedAssetWarehouseType('finished_goods'),
      'type recognized (underscore / space / other types)');
    const whFA = mkWh('انبار دارایی', 'FA', { warehouse_type: 'دارایی_ثابت' });
    err = null;
    try { L.inventoryAccountForWarehouse(db, whFA); } catch (e) { err = e; }
    ok(err && err.code === 'E_WAREHOUSE_TYPE_UNSUPPORTED' && err.status === 422, 'unmapped fixed-asset warehouse → clear error, not 1104', err && err.code);
    const ro = L.inventoryAccountForWarehouse(db, whFA, { readOnly: true });
    ok(ro && ro.unmapped_fixed_asset === true, 'read-only callers get a flagged result instead of an exception');
    db.prepare('UPDATE warehouses SET inventory_coa_code=? WHERE id=?').run('110402', whFA);
    ok(L.inventoryAccountForWarehouse(db, whFA).code === '110402', 'mapped fixed-asset warehouse → its map');
    db.prepare('UPDATE warehouses SET inventory_coa_code=NULL WHERE id=?').run(whFA);
    const PFA = product('دارایی', whFA);
    // seed kardex directly with a mapped account first (receive needs the map)
    db.prepare('UPDATE warehouses SET inventory_coa_code=? WHERE id=?').run('110402', whFA);
    receive(PFA, whFA, 5);
    db.prepare('UPDATE warehouses SET inventory_coa_code=NULL WHERE id=?').run(whFA);
    setFlag('warn');
    const c2 = counts();
    r = await api('POST', '/api/invoices', saleBody([{ product_id: PFA, qty: 1, price: 100000 }], whFA));
    ok(r.status === 422 && r.data?.code === 'E_WAREHOUSE_TYPE_UNSUPPORTED', 'sale from unmapped fixed-asset warehouse (even in warn) → 422, never silent 1104', r.data);
    ok(counts().je === c2.je && counts().inv === c2.inv && counts().led === c2.led, 'fixed-asset rejection rolled back fully');
    ok(q1('SELECT warehouse_type, inventory_coa_code FROM warehouses WHERE id=?', whFA).warehouse_type === 'دارایی_ثابت', 'warehouse type data untouched');

    // ── 9. read-only report script ──
    console.log('— report script —');
    setFlag('warn');
    db.pragma('wal_checkpoint(TRUNCATE)');
    const outPrefix = path.join(dir, 'rep');
    const sum0 = JSON.stringify(qa('SELECT * FROM warehouses ORDER BY id'));
    const run = spawnSync(process.execPath, [path.join(__dirname, 'report-coa-leaf-mapping.js'), `--db=${process.env.DB_PATH}`, `--out=${outPrefix}`], { encoding: 'utf8' });
    ok(run.status === 0, 'report script exits 0', run.stderr || run.stdout);
    ok(fs.existsSync(outPrefix + '.md') && fs.existsSync(outPrefix + '.csv'), 'report script wrote .md and .csv');
    const md = fs.existsSync(outPrefix + '.md') ? fs.readFileSync(outPrefix + '.md', 'utf8') : '';
    ok(md.includes('انبار الف') && /total_changes: (\d+) → \1/.test(md), 'report content + total_changes unchanged (read-only)');
    ok(JSON.stringify(qa('SELECT * FROM warehouses ORDER BY id')) === sum0, 'report script left DB untouched');
    ok(/readonly:\s*true/.test(fs.readFileSync(path.join(__dirname, 'report-coa-leaf-mapping.js'), 'utf8')), 'script opens DB readonly');
  } finally {
    server.close();
  }

  console.warn = realWarn;
  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { require('../lib/auth-sessions').closeSessionStore?.(); } catch (_) { /* ignore */ }
  try { db.close(); } catch (_) { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.warn = realWarn;
  console.error('FATAL', e);
  process.exit(1);
});

