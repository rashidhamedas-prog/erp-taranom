'use strict';
/**
 * P0-الف — باگ کاما در کد حساب (610,401):
 *  - normalizeAccountCode / tryNormalizeAccountCode
 *  - migration coa_code_separator_normalize_v1 (idempotent + audit_log)
 *  - PUT /settings و POST/PUT /warehouses
 *  - گارد کلاینت: isMoneyField/wantsEnDigits برای فیلد کد حساب false
 * Run: node server/scripts/test-coa-code-normalize-p0.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const express = require('express');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : JSON.stringify(extra)); }
}

console.log('\n══ P0-الف — کد حساب بدون کاما ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coa-norm-p0-'));
process.env.DB_PATH = path.join(dir, 'coa-norm.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'coa-norm-p0-test-secret-at-least-32-chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const realWarn = console.warn;
console.warn = () => {};

const dbMods = require('../db');
dbMods.initDB();
const db = dbMods.getDB();

async function main() {
  const {
    normalizeAccountCode, tryNormalizeAccountCode, migrateCoaCodeSeparators,
  } = require('../lib/coa-map');
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');

  console.log('— normalizeAccountCode —');
  ok(normalizeAccountCode('610,401') === '610401', 'comma removed');
  ok(normalizeAccountCode('۶۱۰۴۰۱') === '610401', 'Persian digits → latin');
  ok(normalizeAccountCode('٦١٠٤٠١') === '610401', 'Arabic digits → latin');
  ok(normalizeAccountCode('۶۱۰٬۴۰۱') === '610401', 'Arabic thousands sep removed');
  ok(normalizeAccountCode('610،401') === '610401', 'Arabic comma removed');
  ok(normalizeAccountCode(' 610 401 ') === '610401', 'spaces removed');
  ok(normalizeAccountCode('610.401') === '610401', 'dot removed');
  ok(normalizeAccountCode('') === '' && normalizeAccountCode(null) === '' && normalizeAccountCode(undefined) === '', 'empty ok');
  let err = null;
  try { normalizeAccountCode('61a'); } catch (e) { err = e; }
  ok(err && err.status === 422 && err.code === 'E_COA_CODE_FORMAT', 'invalid → 422 E_COA_CODE_FORMAT', err && err.code);
  ok(tryNormalizeAccountCode('61a') === null, 'try: invalid → null');
  ok(tryNormalizeAccountCode('standard') === null, 'try: mode flag value → null (untouched by migration)');

  console.log('— migration coa_code_separator_normalize_v1 —');
  // وضعیت تولید: فلگ migration در initDB روی دیتابیس خالی ست شده؛ برای شبیه‌سازی پاکش می‌کنیم.
  db.prepare("DELETE FROM settings WHERE key='coa_code_separator_normalize_v1'").run();
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_payroll_expense','610,401')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_admin_expense','۶۱۰۲۰۵')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_cogs','5101')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('coa_mode','standard')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('company_name','شرکت 1,000')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('ledger_leaf_enforcement','warn')").run();
  const whId = db.prepare(
    "INSERT INTO warehouses (name,code,inventory_coa_code,cogs_coa_code) VALUES ('انبار تست','WH-P0','110,401','5,101')"
  ).run().lastInsertRowid;
  const auditBefore = db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='coa_code_normalize'").get().c;

  const m1 = migrateCoaCodeSeparators(db);
  ok(m1.skipped === false && m1.changed === 4, 'first run changes 4 values', m1);
  const val = (k) => (db.prepare('SELECT value FROM settings WHERE key=?').get(k) || {}).value;
  ok(val('coa_payroll_expense') === '610401', 'coa_payroll_expense normalized', val('coa_payroll_expense'));
  ok(val('coa_admin_expense') === '610205', 'Persian-digit value normalized', val('coa_admin_expense'));
  ok(val('coa_cogs') === '5101', 'clean value untouched');
  ok(val('coa_mode') === 'standard', 'coa_mode untouched');
  ok(val('company_name') === 'شرکت 1,000', 'non-coa setting untouched');
  ok(val('ledger_leaf_enforcement') === 'warn', 'ledger_leaf_enforcement stays warn');
  const wh = db.prepare('SELECT inventory_coa_code i, cogs_coa_code c FROM warehouses WHERE id=?').get(whId);
  ok(wh.i === '110401' && wh.c === '5101', 'warehouse coa columns normalized', wh);
  ok(val('coa_code_separator_normalize_v1') === '1', 'flag set');
  const auditAfter = db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='coa_code_normalize'").get().c;
  ok(auditAfter - auditBefore === 4, 'one audit_log row per change', auditAfter - auditBefore);
  const aRow = db.prepare("SELECT detail FROM audit_log WHERE action='coa_code_normalize' AND detail LIKE '%coa_payroll_expense%' ORDER BY id DESC LIMIT 1").get();
  const aDet = aRow ? JSON.parse(aRow.detail) : {};
  ok(aDet.key === 'coa_payroll_expense' && aDet.old === '610,401' && aDet.new === '610401', 'audit has key/old/new', aDet);

  const m2 = migrateCoaCodeSeparators(db);
  ok(m2.skipped === true && m2.changed === 0, 'second run is a no-op');
  ok(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='coa_code_normalize'").get().c === auditAfter, 'no extra audit rows on 2nd run');
  // flag پاک + داده تمیز = باز هم بی‌اثر
  db.prepare("DELETE FROM settings WHERE key='coa_code_separator_normalize_v1'").run();
  const m3 = migrateCoaCodeSeparators(db);
  ok(m3.changed === 0, 're-run without flag on clean data changes nothing', m3);

  console.log('— PUT /settings & warehouses —');
  const insCoa = db.prepare(
    'INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES (?,?,?,?,?,1)'
  );
  insCoa.run('610401', 'حقوق — برگ آزمایشی', 'expense', '6104', 3);
  insCoa.run('610205', 'هزینه اداری — برگ آزمایشی', 'expense', '6102', 3);

  const cols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  const adminObj = { name: 'مدیر', username: 'coa_norm_admin', password: 'x', role: 'admin', active: 1 };
  if (cols.has('must_change_password')) adminObj.must_change_password = 0;
  const uk = Object.keys(adminObj).filter((k) => cols.has(k));
  const adminId = db.prepare(`INSERT INTO users (${uk.join(',')}) VALUES (${uk.map(() => '?').join(',')})`)
    .run(...uk.map((k) => adminObj[k])).lastInsertRowid;
  const admin = db.prepare('SELECT * FROM users WHERE id=?').get(adminId);
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'p0', device_fingerprint: 'coa-norm-p0',
  }).token;

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/settings', require('../routes/settings'));
  app.use('/api/warehouses', require('../routes/warehouses'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  async function api(method, p, body) {
    const res = await fetch(BASE + p, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { status: res.status, data };
  }

  let r = await api('PUT', '/api/settings', { coa_payroll_expense: '610,401' });
  ok(r.status === 200 && val('coa_payroll_expense') === '610401', "PUT '610,401' → stored 610401", { s: r.status, v: val('coa_payroll_expense') });
  r = await api('PUT', '/api/settings', { coa_admin_expense: '۶۱۰۲۰۵' });
  ok(r.status === 200 && val('coa_admin_expense') === '610205', "PUT Persian digits → stored 610205", { s: r.status, v: val('coa_admin_expense') });
  r = await api('PUT', '/api/settings', { coa_payroll_expense: '61a' });
  ok(r.status === 422 && r.data.code === 'E_COA_CODE_FORMAT' && r.data.key === 'coa_payroll_expense', "PUT '61a' → 422 E_COA_CODE_FORMAT", r.data);
  ok(val('coa_payroll_expense') === '610401', 'invalid PUT did not change stored value');
  r = await api('PUT', '/api/settings', { coa_payroll_expense: '' });
  ok(r.status === 200, 'PUT empty clears override');
  r = await api('PUT', '/api/settings', { company_name: 'ترنم 1,000' });
  ok(r.status === 200 && val('company_name') === 'ترنم 1,000', 'non-coa setting not normalized');

  r = await api('POST', '/api/warehouses', { name: 'انبار کاما', inventory_system: 'periodic', inventory_coa_code: '1,104', cogs_coa_code: 'x9' });
  ok(r.status === 422 && r.data.code === 'E_COA_CODE_FORMAT', 'POST warehouse invalid cogs code → 422', r.data);
  r = await api('POST', '/api/warehouses', { name: 'انبار کاما', inventory_system: 'periodic', inventory_coa_code: '1,104', cogs_coa_code: '' });
  ok(r.status === 200 && r.data.inventory_coa_code === '1104', 'POST warehouse normalizes inventory_coa_code', r.data);
  if (r.data && r.data.id) {
    const newWh = r.data.id;
    r = await api('PUT', '/api/warehouses/' + newWh, { inventory_coa_code: '۱۱,۰۴' });
    const stored = db.prepare('SELECT inventory_coa_code c FROM warehouses WHERE id=?').get(newWh).c;
    ok(r.status === 200 && stored === '1104', 'PUT warehouse normalizes Persian digits + comma', { s: r.status, stored });
    r = await api('PUT', '/api/warehouses/' + newWh, { cogs_coa_code: '5x1' });
    ok(r.status === 422 && r.data.code === 'E_COA_CODE_FORMAT', 'PUT warehouse invalid → 422', r.data);
  }

  server.close();
  closeSessionStore();

  console.log('— گارد کلاینت (app.js) —');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const a = src.indexOf('const RE_COA_FIELD_KEY');
  const b = src.indexOf('function ensureMoneyField');
  ok(a > 0 && b > a, 'guard block found in app.js');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src.slice(a, b) + '\nthis.isMoneyField=isMoneyField;this.wantsEnDigits=wantsEnDigits;this.isAccountCodeField=isAccountCodeField;', sandbox);
  function fakeInput(o) {
    const classes = new Set(o.classes || []);
    const attrs = o.attrs || {};
    return {
      tagName: 'INPUT', id: o.id || '', name: o.name || '', type: o.type || 'text',
      dataset: o.dataset || {},
      classList: { contains: (c) => classes.has(c) },
      hasAttribute: (k) => Object.prototype.hasOwnProperty.call(attrs, k),
      getAttribute: (k) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null),
    };
  }
  const payroll = fakeInput({ id: 's-coa_payroll_expense', classes: ['mono', 'coa-map-input'], attrs: { 'data-coa-key': 'coa_payroll_expense' } });
  ok(sandbox.isMoneyField(payroll) === false, 's-coa_payroll_expense is NOT a money field');
  ok(sandbox.wantsEnDigits(payroll) === false, 's-coa_payroll_expense: wantsEnDigits=false');
  ok(sandbox.isMoneyField(fakeInput({ id: 'x', classes: ['coa-code'] })) === false, 'class coa-code → not money');
  ok(sandbox.isMoneyField(fakeInput({ id: 'x', dataset: { kind: 'account-code' } })) === false, 'dataset.kind=account-code → not money');
  ok(sandbox.isMoneyField(fakeInput({ id: 'wh-cogs-coa' })) === false, 'id wh-cogs-coa → not money');
  ok(sandbox.isMoneyField(fakeInput({ id: 'ex-account-code' })) === false, 'id *-account-code → not money');
  ok(sandbox.isMoneyField(fakeInput({ id: 's-coa_payroll_expense' })) === false, 'id only (no class) → not money');
  ok(sandbox.isMoneyField(fakeInput({ id: 'inv-pay-amount' })) === true, 'regular amount field still money');
  ok(sandbox.isMoneyField(fakeInput({ id: 'x-salary' })) === true, 'salary field still money');
  ok(sandbox.isAccountCodeField(fakeInput({ id: 'u-bank-account' })) === false, 'bank account number is not a COA code field');

  // ورودی‌های کد حساب باید کلاس coa-code + inputmode داشته باشند
  for (const id of ['wh-inv-coa', 'wh-cogs-coa', 'fa-coa', 'ec-account', 'coa-code']) {
    const re = new RegExp('<input[^>]*id="' + id + '"[^>]*>');
    const m = src.match(re);
    ok(m && /coa-code/.test(m[0]) && /inputmode="numeric"/.test(m[0]) && /dir="ltr"/.test(m[0]), `input#${id} has coa-code + inputmode + dir`, m && m[0].slice(0, 120));
  }
  const mapIn = src.match(/<input id="s-\$\{esc\(d\.key\)\}"[^>]*>/);
  ok(mapIn && /coa-code/.test(mapIn[0]) && /inputmode="numeric"/.test(mapIn[0]), 'coa-map inputs have coa-code + inputmode');
  ok(/erp-taranom-v59\d/.test(fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8')), 'sw.js CACHE is ≥ v590');

  console.warn = realWarn;
  console.log(`\n${fail ? '💥' : '🎉'} ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => {
  console.warn = realWarn;
  console.error('TEST HARNESS ERROR:', e);
  process.exitCode = 1;
});
