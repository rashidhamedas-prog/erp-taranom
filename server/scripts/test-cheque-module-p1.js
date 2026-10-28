#!/usr/bin/env node
'use strict';
/**
 * Phase 1 UI — register filters, export route, no free-text cheque status in app.js.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { buildChequeRegisterQuery, runChequeRegister } = require('../lib/cheque-register-query');
const { buildOpeningChequeReconciliation } = require('../lib/cheque-reconciliation');
const Database = require('better-sqlite3');
const os = require('os');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const accNav = fs.readFileSync(path.join(__dirname, '../public/acc-nav.js'), 'utf8');

let passed = 0;
function ok(cond, msg) {
  assert.strictEqual(!!cond, true, msg);
  passed += 1;
  console.log('  ✓', msg);
}

console.log('test-cheque-module-p1');

ok(accNav.includes("'acc-cheques-pay': 'cheques-pay'"), 'acc-nav maps pay tab to cheques-pay');
ok(accNav.includes("'acc-cheques-recv': 'cheques-recv'"), 'acc-nav maps recv tab to cheques-recv');
ok(appJs.includes("ROUTES['acc-cheques-pay']"), 'ROUTES acc-cheques-pay wired');
ok(appJs.includes("ROUTES['acc-cheques-recv']"), 'ROUTES acc-cheques-recv wired');
ok(appJs.includes('chq.filters.v564'), 'shared filter localStorage key v564');
ok(appJs.includes('opening-reconciliation'), 'opening recon API used in UI');
ok(appJs.includes('lifecycle-labels'), 'lifecycle-labels fetched in register UI');
ok(!appJs.includes('>تغییر وضعیت<') && !appJs.includes('updateChequeStatus('), 'no free-text status dropdown in UI');
ok(!appJs.includes("/cheque-records/'+id+'/status") && !appJs.includes('/cheque-records/"+id+"/status'), 'no PATCH cheque-records status from UI');
ok(!appJs.includes("PATCH','/accounting/cheques/") && !appJs.includes('PATCH","/accounting/cheques/'), 'no PATCH legacy accounting cheques status from UI');
ok(appJs.includes('function chqExportXlsx') && appJs.includes('/cheque-records/export.xlsx'), 'register export uses filtered xlsx route');
ok(appJs.includes('title="واگذاری به بانک"') && appJs.includes('title="عملیات بیشتر"'), 'row actions have title as well as aria-label');
ok(appJs.includes('جمع کل فیلتر') && appJs.includes('tin.amount') && appJs.includes('tout.amount'), 'filter footer shows amount not only count');
const routeJs = fs.readFileSync(path.join(__dirname, '../routes/cheque-records.js'), 'utf8');
ok(routeJs.includes('/export.xlsx'), 'export.xlsx route exists');

const q = buildChequeRegisterQuery({
  direction: 'out',
  lifecycle: 'registered',
  branch_q: 'مرکزی',
  party_q: 'الف',
  due_from: '1404/01/01',
  due_to: '1404/12/29',
  amount_min: '1000',
  quality: 'dup_sayad',
  overdue: '1',
});
ok(q.params.length >= 5, 'filter builder binds branch/party/dates/amount/quality');
ok(q.whereSql.includes('branch LIKE'), 'branch_q in SQL');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chq-p1-'));
const db = new Database(path.join(tmp, 't.db'));
db.exec(`
  CREATE TABLE cheque_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT, amount REAL, branch TEXT, party_name TEXT, due_date TEXT,
    lifecycle_status TEXT, record_status TEXT DEFAULT 'posted',
    note TEXT, status TEXT, journal_entry_id INTEGER
  );
  CREATE TABLE journal_entries (id INTEGER PRIMARY KEY, ref_type TEXT, ref_id INTEGER, deleted_at INTEGER DEFAULT 0);
  CREATE TABLE journal_lines (id INTEGER PRIMARY KEY, entry_id INTEGER, account_code TEXT, debit REAL, credit REAL, debit_rial REAL, credit_rial REAL);
`);
db.prepare(`INSERT INTO cheque_records (direction,amount,branch,note,status,lifecycle_status)
  VALUES ('in',5000,'مرکزی','مانده اول دوره','','registered')`).run();
db.prepare(`INSERT INTO journal_entries (id,ref_type,ref_id) VALUES (1,'opening_cheque',1)`).run();
db.prepare(`INSERT INTO journal_lines (entry_id,account_code,debit_rial,credit_rial) VALUES (1,'1109',5000,0)`).run();
const openRecon = buildOpeningChequeReconciliation(db, 'in');
ok(openRecon.cheques_rial === 5000 && openRecon.gl_opening_rial === 5000, 'opening recon sums match');
ok(openRecon.variance_rial === 0, 'opening recon variance zero');

db.prepare(`INSERT INTO cheque_records (direction,amount,branch,party_name,due_date,lifecycle_status,record_status)
  VALUES ('out',2000,'شعبه ۲','ب','1404/06/01','registered','posted')`).run();
const reg = runChequeRegister(db, { direction: 'out', branch_q: 'شعبه' }, null);
ok(reg.total_count === 1, 'register list respects branch filter');

console.log(`\n${passed} passed`);
