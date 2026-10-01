'use strict';
/**
 * PROD-ACC PA-09 — F09 ایمنی بازگشایی دوره (close → reopen)
 * سناریوها:
 *   1) close → بدون drift → reopen برگشت کامل (JE معکوس + میانگین snapshot.old)
 *   2) close → تغییر میانگین توسط رویداد بعدی → reopen با E_CLOSE_SNAPSHOT_DRIFT رد و DB بدون تغییر
 *   3) سند close پاک/خارج از این اجرا → reopen fail-closed
 *   4) reason خالی → E_REASON_REQUIRED؛ reopen دوم → E_NOT_CLOSED
 * Run: node server/scripts/test-prod-acc-f09-reopen-v278.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-acc-f09-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(dir, 't.db');
process.env.JWT_SECRET = 'test-prod-acc-f09-secret-32-bytes-xx';
process.env.SYNC_ROLE = 'central';

let passed = 0, failed = 0;
function ok(c, m) {
  if (c) { passed++; console.log('  OK', m); }
  else { failed++; console.error('  FAIL', m); }
}
function finish() {
  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  if (failed) process.exit(1);
}

let db;
try {
  const { initDB, getDB } = require('../db');
  initDB();
  db = getDB();
} catch (e) {
  // better-sqlite3 بومی روی این Node لود نمی‌شود → SKIP محیطی
  // (طبق PA-09 دروازه نهایی، SKIP معادل PASS نیست.)
  console.log('SKIP — better-sqlite3 در دسترس نیست:', e.message);
  process.exit(0);
}
const close = require('../lib/production/close');
const { rebuildBaseCoa, acct } = require('../lib/coa-map');
const { postToLedger } = require('../lib/ledger');

if (!db.prepare('SELECT COUNT(*) c FROM chart_of_accounts').get().c) rebuildBaseCoa(db);

const PERIOD = '1405/05';
const END = '1405/05/31';
const uid = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()?.id || 1;
const code = (k) => acct(db, k).code;

// ── داده پایه ──────────────────────────────────────────────────────────────
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_close_payroll_posted','1')").run();

const ccId = db.prepare("INSERT INTO cost_centers (code,name,active) VALUES ('CC-F09','دوخت F09',1)")
  .run().lastInsertRowid;
try { db.prepare('UPDATE cost_centers SET is_stage=1, seq=1 WHERE id=?').run(ccId); } catch (_) {}
db.prepare(`
  INSERT INTO cost_center_rates (cost_center_id, period_label, driver, total_rate_rial, status)
  VALUES (?,?,'labor_hour',1000,'approved')
`).run(ccId, PERIOD);

const pA = db.prepare(`
  INSERT INTO products (user_id,name,code,stock,average_cost_rial,cost,unit,is_manufactured)
  VALUES (?,'مانتو F09-A','F09-A',10,100000,10000,'عدد',1)
`).run(uid).lastInsertRowid;
const pB = db.prepare(`
  INSERT INTO products (user_id,name,code,stock,average_cost_rial,cost,unit,is_manufactured)
  VALUES (?,'شومیز F09-B','F09-B',10,200000,20000,'عدد',1)
`).run(uid).lastInsertRowid;

// JEهای واقعی تا کنترل‌ها مانده بگیرند (مبالغ خط به تومان = ریال/۱۰)
const toman = (rial) => rial / 10;
function seed(lines, desc) {
  return postToLedger(db, {
    sourceType: 'production_seed', sourceId: 0, date: '1405/05/10',
    description: desc, createdBy: uid, lines, voucherType: 'auto', status: 'approved',
  });
}
seed([
  { code: code('coa_labor_control'), name: 'LC', debit: toman(1000000), credit: 0 },
  { code: code('coa_cash_default'), name: 'CASH', debit: 0, credit: toman(1000000) },
], 'دستمزد جذب‌شده F09');
seed([
  { code: code('coa_overhead_control'), name: 'OHC', debit: toman(2000000), credit: 0 },
  { code: code('coa_cash_default'), name: 'CASH', debit: 0, credit: toman(2000000) },
], 'سربار واقعی F09');
seed([
  { code: code('coa_wip'), name: 'WIP', debit: toman(1500000), credit: 0 },
  { code: code('coa_overhead_applied'), name: 'OHA', debit: 0, credit: toman(1500000) },
], 'سربار جذب‌شده F09');

// پایه تسهیم را قطعی می‌کنیم تا کل انحراف به FG برود (و میانگین‌ها تغییر کند)
close.openPeriod(db, { period: PERIOD, startDate: '1405/05/01', endDate: END, userId: uid });
const base = { wip_rial: 0, fg_rial: 1000000, cogs_rial: 0, total_rial: 1000000 };
db.prepare('UPDATE production_period_close SET checklist_json=? WHERE period_label=?')
  .run(JSON.stringify({ allocation_base: base, labor_allocation_base: base }), PERIOD);

// ── بستن دوره ──────────────────────────────────────────────────────────────
console.log('F09 — بستن دوره');
const closed = close.execute(db, { period: PERIOD, userId: uid, date: END });
ok(closed.status === 'closed', 'دوره بسته شد');
const closeJeIds = closed.journal_entries.map(j => j.je_id).filter(Boolean);
ok(closeJeIds.length >= 3, `حداقل ۳ سند close ثبت شد (${closeJeIds.length})`);
ok(closed.journal_entries.some(j => j.event === 'PRD-21')
  && closed.journal_entries.some(j => j.event === 'PRD-22')
  && closed.journal_entries.some(j => j.event === 'PRD-23'), 'هر سه رویداد close حاضرند');

const snap = closed.fg_avg_updates.filter(u => u.product_id === pA || u.product_id === pB);
ok(snap.length === 2, 'snapshot میانگین برای هر دو کالا ثبت شد');
const snapA = snap.find(u => u.product_id === pA);
const snapB = snap.find(u => u.product_id === pB);
ok(snapA.old_avg_rial === 100000 && snapA.new_avg_rial > 100000, `A: ${snapA.old_avg_rial} → ${snapA.new_avg_rial}`);
ok(snapB.old_avg_rial === 200000 && snapB.new_avg_rial > 200000, `B: ${snapB.old_avg_rial} → ${snapB.new_avg_rial}`);

const avg = (id) => Number(db.prepare('SELECT average_cost_rial FROM products WHERE id=?').get(id).average_cost_rial);
ok(avg(pA) === snapA.new_avg_rial && avg(pB) === snapB.new_avg_rial, 'میانگین جاری = snapshot.new بعد از بستن');

const jeCount = () => Number(db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c);
const revCount = () => Number(db.prepare(
  "SELECT COUNT(*) c FROM journal_entries WHERE ref_type LIKE 'production_close_%_reversal'",
).get().c);
const periodRow = () => db.prepare('SELECT * FROM production_period_close WHERE period_label=?').get(PERIOD);

function expectThrow(fn, codeWanted, label) {
  const before = { je: jeCount(), rev: revCount(), a: avg(pA), b: avg(pB), st: periodRow().status };
  let e = null;
  try { fn(); } catch (x) { e = x; }
  ok(!!e && (e.code === codeWanted || e.message === codeWanted),
    `${label} → ${codeWanted} (got ${e ? (e.code || e.message) : 'no throw'})`);
  const after = { je: jeCount(), rev: revCount(), a: avg(pA), b: avg(pB), st: periodRow().status };
  ok(JSON.stringify(before) === JSON.stringify(after), `${label} → DB بدون تغییر (fail-closed)`);
  return e;
}

// ── سناریو ۴الف: reason خالی ───────────────────────────────────────────────
console.log('F09 — reason خالی');
expectThrow(() => close.reopen(db, { period: PERIOD, reason: '   ', userId: uid }),
  'E_REASON_REQUIRED', 'reopen بدون دلیل');

// ── سناریو ۳: سند close خارج از دسترس (soft-delete) ────────────────────────
console.log('F09 — سند close ابطال‌شده قبل از بازگشایی');
db.prepare('UPDATE journal_entries SET deleted_at=? WHERE id=?').run(Math.floor(Date.now() / 1000), closeJeIds[0]);
const e3 = expectThrow(() => close.reopen(db, { period: PERIOD, reason: 'تست سند', userId: uid }),
  'E_CLOSE_SNAPSHOT_DRIFT', 'reopen با سند حذف‌شده');
ok(!!e3?.extra?.drift?.some(d => d.kind === 'je' && d.reason === 'je_deleted'), 'drift سند گزارش شد');
db.prepare('UPDATE journal_entries SET deleted_at=NULL WHERE id=?').run(closeJeIds[0]);

// ── سناریو ۲: drift میانگین بعد از بستن ────────────────────────────────────
console.log('F09 — drift میانگین بعد از بستن');
const driftedA = snapA.new_avg_rial + 7777;
db.prepare('UPDATE products SET average_cost_rial=? WHERE id=?').run(driftedA, pA);
const e2 = expectThrow(() => close.reopen(db, { period: PERIOD, reason: 'اصلاح داده', userId: uid }),
  'E_CLOSE_SNAPSHOT_DRIFT', 'reopen با میانگین تغییریافته');
ok(e2?.status === 409, `status=409 (got ${e2?.status})`);
const dA = (e2?.extra?.drift || []).find(d => d.product_id === pA);
ok(dA && dA.reason === 'avg_changed_after_close' && dA.current_rial === driftedA
  && dA.snapshot_new_rial === snapA.new_avg_rial, 'جزئیات drift دقیق است');
ok(avg(pA) === driftedA, 'میانگین drift‌شده A دست‌نخورده ماند');
ok(avg(pB) === snapB.new_avg_rial, 'میانگین B بازگردانی جزئی نشد (بدون تغییر جزئی)');
ok(periodRow().status === 'closed' && !periodRow().reopened_at, 'وضعیت دوره هنوز closed');

// ── سناریو ۱: بدون drift → بازگشت کامل ─────────────────────────────────────
console.log('F09 — بازگشایی بدون drift');
db.prepare('UPDATE products SET average_cost_rial=? WHERE id=?').run(snapA.new_avg_rial, pA);
const jeBefore = jeCount();
const res = close.reopen(db, { period: PERIOD, reason: 'اصلاح سربار مرداد', userId: uid });
ok(res.ok && res.status === 'open', 'reopen موفق');
ok(avg(pA) === 100000 && avg(pB) === 200000, `میانگین‌ها به snapshot.old برگشت (A=${avg(pA)} B=${avg(pB)})`);
ok(res.reversals.length === closeJeIds.length, `${closeJeIds.length} سند معکوس ثبت شد`);
ok(res.reversals.every(r => closeJeIds.includes(r.je_id)), 'فقط JEهای همین اجرای close معکوس شدند');
ok(jeCount() === jeBefore + closeJeIds.length, 'تعداد سند = قبلی + معکوس‌ها');
ok(revCount() === closeJeIds.length, 'اسناد معکوس با ref_type صحیح');

const live = db.prepare(
  `SELECT COUNT(*) c FROM journal_entries WHERE id IN (${closeJeIds.map(() => '?').join(',')}) AND COALESCE(deleted_at,0)=0`,
).get(...closeJeIds).c;
ok(Number(live) === closeJeIds.length, 'اسناد اصلی حذف فیزیکی/نرم نشدند');

for (const r of res.reversals) {
  const orig = db.prepare('SELECT COALESCE(SUM(debit_rial),0) d, COALESCE(SUM(credit_rial),0) c FROM journal_lines WHERE entry_id=?').get(r.je_id);
  const rev = db.prepare('SELECT COALESCE(SUM(debit_rial),0) d, COALESCE(SUM(credit_rial),0) c FROM journal_lines WHERE entry_id=?').get(r.reversal_je_id);
  ok(Number(rev.d) === Number(rev.c), `سند معکوس ${r.reversal_je_id} تراز است`);
  ok(Number(rev.d) === Number(orig.c) && Number(rev.c) === Number(orig.d), `معکوس ${r.reversal_je_id} قرینه اصل ${r.je_id} است`);
}

const rowAfter = periodRow();
ok(rowAfter.status === 'open', 'وضعیت دوره open');
ok(Number(rowAfter.reopened_by) === Number(uid) && !!rowAfter.reopened_at, 'actor/time ثبت شد');
ok(rowAfter.reopen_reason === 'اصلاح سربار مرداد', 'reason ذخیره شد');
ok(Number(rowAfter.reversed_je_id) === Number(res.reversals[res.reversals.length - 1].reversal_je_id),
  'reversed_je_id شناسه سند معکوس است (نه سند اصلی)');
const hist = JSON.parse(rowAfter.checklist_json || '{}').reopen_history || [];
ok(hist.length === 1 && hist[0].reversals.length === closeJeIds.length, 'تاریخچه بازگشایی ثبت شد');

// ── سناریو ۴ب: بازگشایی دوم ────────────────────────────────────────────────
console.log('F09 — بازگشایی دوم');
const je2 = jeCount();
let e4 = null;
try { close.reopen(db, { period: PERIOD, reason: 'دوباره', userId: uid }); } catch (x) { e4 = x; }
ok(!!e4 && e4.code === 'E_NOT_CLOSED' && e4.status === 409, `reopen دوم → 409 E_NOT_CLOSED (got ${e4 && e4.code})`);
ok(jeCount() === je2, 'reopen دوم هیچ سند تکراری نساخت');
ok(avg(pA) === 100000 && avg(pB) === 200000, 'میانگین‌ها پس از تلاش دوم تغییر نکرد');

finish();
