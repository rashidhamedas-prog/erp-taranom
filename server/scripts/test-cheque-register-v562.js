#!/usr/bin/env node
'use strict';
/**
 * Cheque register complete — quality, filters, totals, transitions, recon.
 * DB in os.tmpdir() only — never crm.db.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const quality = require('../lib/cheque-quality');
const { buildChequeRegisterQuery, runChequeRegister, runChequeSummary } = require('../lib/cheque-register-query');
const { assertTransition, allowedTargets, STATUS_LABEL } = require('../lib/cheque-lifecycle');
const { buildChequeReconciliation } = require('../lib/cheque-reconciliation');
const { insertChequeEvent, lastReversibleEvent } = require('../lib/cheque-events');

let passed = 0;
function ok(cond, msg) {
  assert.strictEqual(!!cond, true, msg);
  passed += 1;
  console.log('  ✓', msg);
}

console.log('test-cheque-register-v562');

/* ---- validateSayadi ---- */
{
  const good = quality.validateSayadi('2215300887814712');
  ok(good.ok && good.digits === '2215300887814712', 'valid 16-digit ascii');
  const fa = quality.validateSayadi('۲۲۱۵۳۰۰۸۸۷۸۱۴۷۱۲');
  ok(fa.ok && fa.digits === '2215300887814712', 'valid 16-digit persian digits');
  ok(quality.validateSayadi('1234567891234567').code === 'E_SAYAD_DUMMY', 'dummy sayadi rejected');
  ok(quality.validateSayadi('0000000000000000').code === 'E_SAYAD_DUMMY', 'zeros rejected');
  ok(quality.validateSayadi('1111111111111111').code === 'E_SAYAD_DUMMY', 'repeated digit rejected');
  ok(quality.validateSayadi('12345').code === 'E_SAYAD_INVALID', 'short rejected');
  ok(quality.validateSayadi('').code === 'E_SAYAD_INVALID', 'empty rejected');
}

/* ---- temp DB schema + filters ---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chq-reg-'));
const dbPath = path.join(tmp, 't.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, role TEXT, is_active INTEGER DEFAULT 1);
  CREATE TABLE banks (id INTEGER PRIMARY KEY, name TEXT, coa_code TEXT);
  CREATE TABLE parties (id INTEGER PRIMARY KEY, full_name TEXT, company_name TEXT, biz TEXT, legacy_table TEXT, legacy_id INTEGER, is_active INTEGER DEFAULT 1);
  CREATE TABLE journal_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, entry_date TEXT, description TEXT,
    ref_type TEXT, ref_id INTEGER, created_at INTEGER, created_by INTEGER,
    deleted_at INTEGER DEFAULT 0, voucher_number TEXT, status TEXT
  );
  CREATE TABLE journal_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id INTEGER, account_code TEXT, account_name TEXT,
    debit REAL, credit REAL, debit_rial REAL, credit_rial REAL
  );
  CREATE TABLE cheque_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT NOT NULL, cheque_number TEXT DEFAULT '', issue_date TEXT DEFAULT '',
    receive_date TEXT DEFAULT '', due_date TEXT DEFAULT '', bank_name TEXT DEFAULT '',
    branch TEXT DEFAULT '', sayadi TEXT DEFAULT '', sheba TEXT DEFAULT '', account_number TEXT DEFAULT '',
    party_name TEXT DEFAULT '', party_id INTEGER, customer_id INTEGER,
    status TEXT DEFAULT '', status_note TEXT DEFAULT '', amount REAL NOT NULL DEFAULT 0,
    note TEXT DEFAULT '', created_by_name TEXT DEFAULT '', created_at INTEGER DEFAULT (strftime('%s','now')),
    record_status TEXT NOT NULL DEFAULT 'posted', journal_entry_id INTEGER,
    lifecycle_status TEXT DEFAULT '', collection_bank_id INTEGER, settlement_id INTEGER,
    check_category_id INTEGER, replaces_cheque_id INTEGER
  );
  CREATE TABLE cheque_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT, cheque_id INTEGER NOT NULL,
    from_status TEXT, to_status TEXT NOT NULL, event_date TEXT NOT NULL,
    journal_entry_id INTEGER, reverses_event_id INTEGER, bank_id INTEGER, party_id INTEGER,
    note TEXT, created_by INTEGER, created_at INTEGER DEFAULT (strftime('%s','now')),
    client_request_id TEXT UNIQUE
  );
`);
db.prepare("INSERT INTO users (id,name,role) VALUES (1,'حامد رشید','admin')").run();
db.prepare("INSERT INTO parties (id,full_name) VALUES (10,'مشتری الف')").run();
db.prepare("INSERT INTO banks (id,name) VALUES (1,'ملت')").run();

const TODAY = '1405/08/05';

function ins(row) {
  return db.prepare(`
    INSERT INTO cheque_records (
      direction, cheque_number, amount, due_date, sayadi, party_name, party_id,
      bank_name, branch, lifecycle_status, record_status, status, journal_entry_id, note
    ) VALUES (@direction,@cheque_number,@amount,@due_date,@sayadi,@party_name,@party_id,
      @bank_name,@branch,@lifecycle_status,@record_status,@status,@journal_entry_id,@note)
  `).run({
    direction: 'in', cheque_number: 'N', amount: 0, due_date: '', sayadi: '',
    party_name: 'مشتری الف', party_id: 10, bank_name: 'ملت', branch: 'مرکزی',
    lifecycle_status: 'registered', record_status: 'posted', status: 'نزد صندوق',
    journal_entry_id: null, note: '',
    ...row,
  });
}

ins({ cheque_number: 'A1', amount: 1000, due_date: '1405/07/01', sayadi: '', lifecycle_status: 'registered' });
ins({ cheque_number: 'A2', amount: 2000, due_date: '1405/08/10', sayadi: '2215300887814712', lifecycle_status: 'registered' });
ins({ cheque_number: 'A3', amount: 3000, due_date: '1405/08/01', sayadi: '1234567891234567', lifecycle_status: 'in_collection', party_name: 'حامد رشید', party_id: 10, branch: '0' });
ins({ cheque_number: 'R1', amount: 1900000000, due_date: '1404/01/01', sayadi: '', lifecycle_status: 'registered', record_status: 'reversed', status: 'نزد صندوق' });
ins({ direction: 'out', cheque_number: 'O1', amount: 5000, due_date: '1405/09/01', sayadi: '2215300887814713', lifecycle_status: 'registered', status: 'ثبت‌شده' });

/* JE for 1109 matching A1+A2 registered in */
const je1 = db.prepare(`INSERT INTO journal_entries (entry_date,description,ref_type,ref_id) VALUES (?,?,?,?)`)
  .run(TODAY, 'open', 'cheque_in', 1).lastInsertRowid;
db.prepare(`INSERT INTO journal_lines (entry_id,account_code,account_name,debit,credit,debit_rial,credit_rial) VALUES (?,?,?,?,?,?,?)`)
  .run(je1, '1109', 'اسناد دریافتنی', 300, 0, 3000, 0);
db.prepare(`INSERT INTO journal_lines (entry_id,account_code,account_name,debit,credit,debit_rial,credit_rial) VALUES (?,?,?,?,?,?,?)`)
  .run(je1, '1103', 'دریافتنی', 0, 300, 0, 3000);
db.prepare('UPDATE cheque_records SET journal_entry_id=? WHERE id IN (1,2)').run(je1);

{
  const flags = quality.chequeQualityFlags(
    db.prepare('SELECT * FROM cheque_records WHERE id=1').get(),
    { today: TODAY, adminNames: quality.buildAdminNameSet(db), dupSayads: quality.buildDupSayadSet(db) }
  );
  ok(flags.includes('missing_sayad'), 'flag missing_sayad');
  ok(flags.includes('overdue'), 'flag overdue');
}
{
  const flags = quality.chequeQualityFlags(
    db.prepare('SELECT * FROM cheque_records WHERE id=3').get(),
    { today: TODAY, adminNames: quality.buildAdminNameSet(db), dupSayads: new Set(['1234567891234567']) }
  );
  ok(flags.includes('dummy_sayad'), 'flag dummy_sayad');
  ok(flags.includes('suspicious_party'), 'flag suspicious_party (=admin name)');
  ok(flags.includes('branch_placeholder'), 'flag branch_placeholder');
}

{
  const q = buildChequeRegisterQuery({ direction: 'in', today: TODAY });
  ok(q.whereSql.includes('direction=?'), 'filter direction parameterized');
  const payload = runChequeRegister(db, { direction: 'in', today: TODAY, page_size: 50 });
  ok(payload.total_count === 3, 'in posted count excludes reversed');
  ok(payload.totals.by_direction.in.amount === 6000, 'in amount excludes reversed 1.9bn');
  ok(payload.totals.by_direction.out.amount === 0, 'out zero when filtered in');
}
{
  const payload = runChequeRegister(db, { direction: 'out', today: TODAY });
  ok(payload.totals.by_direction.out.amount === 5000, 'out total separate');
  ok(payload.totals.by_direction.in.amount === 0, 'in zero when filtered out');
}
{
  const sum = runChequeSummary(db, TODAY);
  ok(sum.cards.in_hand.count === 2, 'summary in_hand count');
  ok(sum.cards.in_collection.count === 1, 'summary in_collection');
  ok(sum.cards.overdue.count >= 1, 'summary overdue');
  ok(sum.aging && sum.aging.past && sum.aging.future, 'aging buckets present');
}

/* transitions */
{
  const row = { direction: 'in', lifecycle_status: 'registered' };
  ok(allowedTargets(row).includes('in_collection'), 'allowed send-to-bank');
  ok(allowedTargets(row).includes('returned_to_drawer'), 'allowed return-to-drawer');
  let threw = false;
  try { assertTransition(row, 'cleared'); } catch (e) { threw = e.code === 'E_CHEQUE_LIFECYCLE'; }
  ok(threw, 'illegal transition throws');
  ok(STATUS_LABEL.registered === 'نزد صندوق', 'lifecycle fa label');
}

/* events + reverse pointer */
{
  const ev = insertChequeEvent(db, {
    chequeId: 2, fromStatus: 'registered', toStatus: 'in_collection',
    eventDate: TODAY, journalEntryId: je1, createdBy: 1, clientRequestId: 'idem-1',
  });
  ok(ev && ev.id, 'insert cheque_event');
  const again = insertChequeEvent(db, {
    chequeId: 2, fromStatus: 'registered', toStatus: 'in_collection',
    eventDate: TODAY, journalEntryId: je1, createdBy: 1, clientRequestId: 'idem-1',
  });
  ok(again.id === ev.id, 'idempotent client_request_id');
  const last = lastReversibleEvent(db, 2);
  ok(last && last.id === ev.id, 'last reversible event');
}

/* reconciliation: reversed not in ops */
{
  const recon = buildChequeReconciliation(db);
  const a1109 = recon.accounts.find((a) => a.code === '1109');
  ok(a1109 && a1109.ops_rial === 3000, 'recon ops 1109 = registered in only (not reversed)');
  ok(a1109.ops_count === 2, 'recon count excludes reversed');
}

/* migration idempotent — re-run CREATE */
{
  db.exec(`CREATE TABLE IF NOT EXISTS cheque_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT, cheque_id INTEGER NOT NULL,
    from_status TEXT, to_status TEXT NOT NULL, event_date TEXT NOT NULL,
    journal_entry_id INTEGER, reverses_event_id INTEGER, bank_id INTEGER, party_id INTEGER,
    note TEXT, created_by INTEGER, created_at INTEGER DEFAULT (strftime('%s','now')),
    client_request_id TEXT UNIQUE
  )`);
  const n = db.prepare('SELECT COUNT(*) c FROM cheque_records').get().c;
  ok(n === 5, 'migration re-run does not alter rows');
}

/* CSP: no raw style=/onclick= in new register helpers of app.js (spot-check markers) */
{
  const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const start = appSrc.indexOf('async function renderChequeRegisterTab');
  const end = appSrc.indexOf('async function openChequeLeafModal');
  ok(start > 0 && end > start, 'register tab function present');
  const chunk = appSrc.slice(start, end);
  ok(!/\sstyle="/.test(chunk), 'no raw style= in register tab');
  ok(!/\sonclick=/.test(chunk), 'no raw onclick= in register tab');
  ok(chunk.includes('data-csp-click') && chunk.includes('data-csp-style'), 'uses CSP helpers');
}

db.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* */ }

console.log(`\nOK ${passed} assertions`);
process.exit(0);
