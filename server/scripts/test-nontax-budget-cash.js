/**
 * NONTAX-P1 reports — Jalali budget year · split cash-flow (proportional, reconciled) · truthful close labels.
 * Run: node server/scripts/test-nontax-budget-cash.js
 *
 * Pure parts (allocator, entry classifier, Jalali helpers, acc-nav labels) always run.
 * DB/HTTP parts need better-sqlite3; when the native module cannot load (ABI mismatch) they are
 * reported as SKIP with the loader error instead of failing.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

// Isolated temp DB — must be set before the first require of ../db (DB_PATH is read at module load).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nontax-budget-cash-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-nontax-budget-cash-secret-at-least-32b';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';

let pass = 0;
let fail = 0;
let skipped = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : JSON.stringify(extra)); }
}
function skip(label, reason) {
  skipped += 1;
  console.log('  SKIP', label, reason ? '— ' + reason : '');
}
function sum(arr) { return arr.reduce((a, b) => a + b, 0); }

// ───────────────────────────── pure: allocator ─────────────────────────────
const cashFlow = require('../lib/cash-flow');
const { allocateProportional, classifyEntryLines, classifyCashFlowCounterpart } = cashFlow;

console.log('\n— allocateProportional (largest remainder, integer rial) —');
{
  const a = allocateProportional(-500000, [800000, 300000]);
  ok(Array.isArray(a) && sum(a) === -500000, 'parts sum exactly to total (negative)', a);
  ok(a && a[0] === -363636 && a[1] === -136364, 'remainder unit goes to the largest remainder', a);
  const b = allocateProportional(100, [1, 1, 1]);
  ok(b && sum(b) === 100 && b[0] === 34 && b[1] === 33 && b[2] === 33, 'ties broken by input order (deterministic)', b);
  const c = allocateProportional(7, [0, 5]);
  ok(c && c[0] === 0 && c[1] === 7, 'zero-weight line receives nothing', c);
  ok(allocateProportional(7, [0, 0]) === null, 'all-zero weights → null (unallocatable)');
  ok(allocateProportional(7, []) === null, 'no counterparts → null');
  const z = allocateProportional(0, [3, 4]);
  ok(z && z[0] === 0 && z[1] === 0, 'zero total → zeros');
  const big = allocateProportional(9007199254740000, [7, 3, 11]);
  ok(big && sum(big) === 9007199254740000, 'large rial stays exact (BigInt intermediates)', big);
  const same1 = allocateProportional(1234567, [13, 29, 7, 101]);
  const same2 = allocateProportional(1234567, [13, 29, 7, 101]);
  ok(JSON.stringify(same1) === JSON.stringify(same2) && sum(same1) === 1234567, 'deterministic across runs', same1);
}

// ───────────────────────────── pure: entry classifier ─────────────────────────────
console.log('\n— classifyEntryLines —');
{
  const cashSet = new Set(['1101', '1102']);
  const typeMap = { T4101: 'income', T2105: 'liability', T2201: 'liability', T6101: 'expense', T3101: 'equity' };
  const L = (code, d, c) => ({ account_code: code, debit_rial: d, credit_rial: c });

  const sale = classifyEntryLines([L('1101', 1100000, 0), L('T4101', 0, 1000000), L('T2105', 0, 100000)], cashSet, typeMap);
  ok(sale.kind === 'allocated' && sale.cash_net === 1100000, 'cash sale → allocated', sale);
  ok(sale.parts && sum(sale.parts.map((p) => p.amount_rial)) === 1100000, 'allocated parts sum to cash net', sale.parts);
  const op = sale.parts.find((p) => p.account_code === 'T4101');
  const fin = sale.parts.find((p) => p.account_code === 'T2105');
  ok(op && op.section === 'operating' && op.amount_rial === 1000000, 'income counterpart → operating share by weight', op);
  ok(fin && fin.section === classifyCashFlowCounterpart('T2105', typeMap) && fin.amount_rial === 100000,
    'liability counterpart classified by existing classifier', fin);

  const compound = classifyEntryLines([L('1299', 800000, 0), L('1101', 0, 500000), L('T2201', 0, 300000)], cashSet, typeMap);
  const inv = compound.parts.find((p) => p.account_code === '1299');
  const loan = compound.parts.find((p) => p.account_code === 'T2201');
  ok(inv && inv.section === 'investing' && inv.amount_rial === -363636, 'compound: investing share', inv);
  ok(loan && loan.section === 'financing' && loan.amount_rial === -136364, 'compound: financing share', loan);

  const transfer = classifyEntryLines([L('1102', 200000, 0), L('1101', 0, 200000)], cashSet, typeMap);
  ok(transfer.kind === 'transfer' && transfer.cash_net === 0 && transfer.moved_rial === 200000, 'bank↔cash → transfer, net 0', transfer);

  const emptyCode = classifyEntryLines([L('1101', 50000, 0), L('', 0, 50000)], cashSet, typeMap);
  ok(emptyCode.kind === 'allocated' && emptyCode.parts.length === 0 && emptyCode.residual.length === 1
    && emptyCode.residual[0].amount_rial === 50000 && emptyCode.residual[0].reason === 'empty_account_code',
  'empty-code counterpart → residual, not operating', emptyCode);

  const mixed = classifyEntryLines([L('1101', 500, 0), L('T6101', 0, 300), L('', 0, 200)], cashSet, typeMap);
  ok(mixed.parts.length === 1 && mixed.parts[0].amount_rial === 300 && mixed.residual[0].amount_rial === 200,
    'mixed classifiable + empty → split by weight', mixed);

  const cashOnly = classifyEntryLines([L('1101', 10000, 0)], cashSet, typeMap);
  ok(cashOnly.kind === 'residual' && cashOnly.reason === 'no_counterpart' && cashOnly.cash_net === 10000,
    'cash-only unbalanced → residual no_counterpart', cashOnly);

  const none = classifyEntryLines([L('T6101', 100, 0), L('T2201', 0, 100)], cashSet, typeMap);
  ok(none.kind === 'none', 'non-cash entry → none');
  const zeroNoise = classifyEntryLines([L('', 0, 0), L('1101', 250000, 0), L('1103', 0, 250000)], cashSet, { 1103: 'asset' });
  ok(zeroNoise.kind === 'allocated' && zeroNoise.residual.length === 0 && zeroNoise.parts[0].amount_rial === 250000,
    'zero-amount empty-code line is ignored (v179 probe entry)', zeroNoise);
}

// ───────────────────────────── pure: report with stub db (failed / incomplete) ─────────────────────────────
console.log('\n— buildCashFlowReport failure contract (stub db) —');
{
  const throwingDb = { prepare() { throw new Error('boom'); } };
  const failed = cashFlow.buildCashFlowReport(throwingDb, '1403/01/01', '1403/12/29');
  ok(failed.status === 'failed' && failed.sections === null && failed.total_net_rial === null,
    'exception → status failed, no sections/totals', failed);
  ok(typeof failed.error === 'string' && /ناموفق|قابل محاسبه/.test(failed.error), 'failed error is Persian', failed.error);
  const badRange = cashFlow.buildCashFlowReport(throwingDb, '1403/12/29', '1403/01/01');
  ok(badRange.status === 'failed' && badRange.code === 'bad_range', 'from > to → failed/bad_range', badRange);

  // Period scan and balance queries that disagree → identity broken → 'incomplete'
  const inconsistentDb = {
    prepare(sql) {
      return {
        all() {
          if (/PRAGMA/i.test(sql)) return [];
          if (/FROM banks|FROM cash_boxes/.test(sql)) throw new Error('absent');
          if (/chart_of_accounts/.test(sql)) return [];
          if (/je\.id AS entry_id/.test(sql)) {
            return [
              { entry_id: 1, date: '1403/01/05', description: 'x', account_code: '1101', debit_rial: 100, credit_rial: 0 },
              { entry_id: 1, date: '1403/01/05', description: 'x', account_code: '6101', debit_rial: 0, credit_rial: 100 },
            ];
          }
          if (/GROUP BY jl\.account_code/.test(sql)) {
            return [{ account_code: '1101', bal: /</.test(sql) && !/<=/.test(sql) ? 0 : 999 }];
          }
          return [];
        },
      };
    },
  };
  const incomplete = cashFlow.buildCashFlowReport(inconsistentDb, '1403/01/01', '1403/12/29');
  ok(incomplete.status === 'incomplete' && incomplete.reconciliation && incomplete.reconciliation.ok === false
    && incomplete.reconciliation.difference_rial === 899, 'identity broken → status incomplete with difference', incomplete.reconciliation);
}

// ───────────────────────────── pure: budgeting helpers ─────────────────────────────
console.log('\n— budgeting Jalali helpers —');
let budgetingRouter = null;
let routerLoadError = null;
try {
  budgetingRouter = require('../routes/budgeting');
} catch (e) {
  routerLoadError = (e && e.message) || String(e);
}
const { j2g, g2j } = require('../jalali');
if (!budgetingRouter) {
  skip('budgeting helper unit tests', 'routes/budgeting could not load: ' + routerLoadError);
} else {
  const { jalaliYearInText, jalaliMonthInYear, resolveBudgetJalaliYear, gregorianBoundsOfJalaliYear } = budgetingRouter;
  ok(jalaliYearInText('1405') === '1405', "year '1405'");
  ok(jalaliYearInText('1405/01') === '1405', "year '1405/01' (UI hint format)");
  ok(jalaliYearInText('سال مالی ۱۴۰۵') === '1405', 'Persian digits in label');
  ok(jalaliYearInText('2026') === null, "Gregorian '2026' is not a Jalali year");
  ok(jalaliYearInText('14051') === null, '5-digit token rejected');
  ok(jalaliYearInText('') === null && jalaliYearInText(null) === null, 'blank → null');

  ok(jalaliMonthInYear('1405/01/01', '1405') === 1, 'Nowruz 1405/01/01 → month 1 of 1405');
  ok(jalaliMonthInYear('1404/12/29', '1405') === null, '1404/12/29 is not in 1405');
  ok(jalaliMonthInYear('1404/12/29', '1404') === 12, '1404/12/29 → month 12 of 1404');
  ok(jalaliMonthInYear('1405/1/5', '1405') === 1, 'unpadded month parsed');
  ok(jalaliMonthInYear('۱۴۰۵/۰۷/۰۱', '1405') === 7, 'Persian-digit entry_date → month 7');
  const [gy, gm, gd] = j2g(1405, 1, 1);
  const iso = `${gy}-${String(gm).padStart(2, '0')}-${String(gd).padStart(2, '0')}`;
  ok(jalaliMonthInYear(iso, '1405') === 1, `ISO Gregorian Nowruz (${iso}) → month 1 of 1405, not month 12`);
  const back = g2j(gy, gm, gd);
  ok(back[0] === 1405 && back[1] === 1 && back[2] === 1, 'j2g/g2j round-trip for Nowruz');
  const bounds = gregorianBoundsOfJalaliYear('1405');
  ok(bounds.start === iso, 'Gregorian bounds start at Nowruz', bounds);

  const noDb = { prepare() { throw new Error('no fiscal_years'); } };
  const blank = resolveBudgetJalaliYear(noDb, { year_label: '', fiscal_year_id: null });
  ok(!blank.ok && /سال مالی بودجه مشخص نیست/.test(blank.error), 'blank label + no period → error (no Gregorian fallback)', blank);
  const malformed = resolveBudgetJalaliYear(noDb, { year_label: '2026', fiscal_year_id: null });
  ok(!malformed.ok && /معتبر نیست/.test(malformed.error), "label '2026' → malformed error", malformed);
  const fromLabel = resolveBudgetJalaliYear(noDb, { year_label: '1405/01', fiscal_year_id: null });
  ok(fromLabel.ok && fromLabel.year === '1405' && fromLabel.source === 'year_label', 'label resolves without period', fromLabel);
  const fyDb = { prepare() { return { get() { return { id: 7, label: 'سال مالی ۱۴۰۵', start_date: '1405/01/01', end_date: '1405/12/29' }; } }; } };
  const fromPeriod = resolveBudgetJalaliYear(fyDb, { year_label: '', fiscal_year_id: 7 });
  ok(fromPeriod.ok && fromPeriod.year === '1405' && fromPeriod.source === 'fiscal_period', 'fiscal period start_date wins when label blank', fromPeriod);
  const conflict = resolveBudgetJalaliYear(fyDb, { year_label: '1404', fiscal_year_id: 7 });
  ok(!conflict.ok && /هم‌خوان نیست/.test(conflict.error), 'period/label year conflict → error', conflict);
  const labelOnlyFy = { prepare() { return { get() { return { id: 8, label: 'سال مالی 1403', start_date: '', end_date: '' }; } }; } };
  const fromFyLabel = resolveBudgetJalaliYear(labelOnlyFy, { year_label: '', fiscal_year_id: 8 });
  ok(fromFyLabel.ok && fromFyLabel.year === '1403', 'fiscal period label used when start_date blank', fromFyLabel);
  const gregFy = { prepare() { return { get() { return { id: 9, label: 'FY', start_date: '2026-03-21', end_date: '' }; } }; } };
  const unproven = resolveBudgetJalaliYear(gregFy, { year_label: '', fiscal_year_id: 9 });
  ok(!unproven.ok, 'period that does not prove a Jalali year + blank label → error', unproven);
}

// ───────────────────────────── pure: acc-nav labels ─────────────────────────────
console.log('\n— acc-nav: manual-template labels for opening/close/revaluation —');
{
  const navSrc = fs.readFileSync(path.join(__dirname, '../public/acc-nav.js'), 'utf8');
  const labelOf = (id) => {
    const m = navSrc.match(new RegExp(`\\{\\s*id:\\s*'${id}'[^}]*label:\\s*'([^']*)'`));
    return m ? m[1] : null;
  };
  const resolveOf = (id) => {
    const m = navSrc.match(new RegExp(`'${id}':\\s*'([^']+)'`));
    return m ? m[1] : null;
  };
  const oldLabels = {
    'acc-opening-voucher': 'سند افتتاحیه',
    'acc-close-temp': 'اختتامیه حساب‌های موقت',
    'acc-close-perm': 'اختتامیه حساب‌های دائم',
    'acc-revaluation': 'سند تسعیر',
  };
  for (const id of Object.keys(oldLabels)) {
    const label = labelOf(id);
    ok(typeof label === 'string' && label.includes('دستی'), `${id} label says دستی`, label);
    ok(label !== oldLabels[id], `${id} label is not the old automated-sounding "${oldLabels[id]}"`, label);
    ok(!/خودکار/.test(label || ''), `${id} label does not claim خودکار`, label);
    const target = resolveOf(id);
    ok(target === 'vouchers', `${id} still resolves to the vouchers page (not warehouse/production close)`, target);
  }
  ok(/قالب سند دستی: بستن حساب‌های موقت/.test(navSrc), 'temp-close label wording');
  ok(/قالب سند دستی: بستن حساب‌های دائم/.test(navSrc), 'perm-close label wording');
  ok(/قالب سند دستی: تسعیر/.test(navSrc), 'revaluation label wording');
}

// ───────────────────────────── DB + HTTP ─────────────────────────────
(async () => {
  console.log('\n— DB-backed cases —');
  let db;
  try {
    if (!budgetingRouter) throw new Error('routes/budgeting did not load: ' + routerLoadError);
    const Database = require('better-sqlite3');
    new Database(':memory:').close(); // forces the native binding to load (ABI check)
    const { initDB, getDB } = require('../db'); // same module instance the routers hold
    initDB();
    db = getDB();
  } catch (e) {
    const reason = 'better-sqlite3 / initDB unavailable: ' + ((e && e.message) || e).toString().split('\n')[0];
    for (const label of [
      'variance 422 when year_label blank and no fiscal period',
      'variance 422 when year_label malformed',
      'variance 200 from fiscal period; Nowruz month bucketing',
      'variance 200 from year_label',
      'variance 422 on period/label conflict',
      'cash-flow 200 ok on valid empty period',
      'cash-flow 200 ok with sections/transfers/residual + reconciliation identity',
      'cash-flow 422 failed on bad range',
      'cash-flow 500 failed when GL table missing (no zero report)',
    ]) skip(label, reason);
    finish();
    return;
  }

  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'nontax-budget-cash', device_fingerprint: 'nontax-budget-cash-fp',
  }).token;

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/budgeting', budgetingRouter);
  app.use('/api/adv-reports', require('../routes/adv-reports'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  async function api(method, p, body) {
    const res = await fetch(BASE + p, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, data };
  }

  // fixtures: test COA codes (types drive the existing classifier)
  const insCoa = db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code, name, type) VALUES (?,?,?)');
  insCoa.run('T4101', 'فروش تست', 'income');
  insCoa.run('T2105', 'مالیات ارزش افزوده پرداختنی تست', 'liability');
  insCoa.run('T2201', 'تسهیلات تست', 'liability');
  insCoa.run('T6101', 'هزینه تست', 'expense');
  insCoa.run('T3101', 'سرمایه تست', 'equity');
  insCoa.run('1299', 'دارایی ثابت تست', 'asset');

  const insJe = db.prepare('INSERT INTO journal_entries (entry_date, description, ref_type, ref_id, created_by) VALUES (?,?,?,?,?)');
  const insJl = db.prepare('INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial) VALUES (?,?,?,0,0,?,?)');
  function je(date, description, lines) {
    const id = insJe.run(date, description, 'nontax_test', 0, admin.id).lastInsertRowid;
    for (const [code, d, c] of lines) insJl.run(id, code, code || 'بدون کد', d, c);
    return id;
  }

  // ── budgeting ──
  const fyId = db.prepare("INSERT INTO fiscal_years (label, start_date, end_date, status) VALUES (?,?,?,'closed')")
    .run('سال مالی ۱۴۰۵', '1405/01/01', '1405/12/29').lastInsertRowid;
  const [gy, gm, gd] = j2g(1405, 1, 1);
  const isoNowruz = `${gy}-${String(gm).padStart(2, '0')}-${String(gd).padStart(2, '0')}`;
  je('1405/01/01', 'هزینه نوروز', [['T6101', 300000, 0], ['1101', 0, 300000]]);
  je('1404/12/29', 'هزینه آخر سال قبل', [['T6101', 999000, 0], ['1101', 0, 999000]]);
  je(isoNowruz, 'هزینه با تاریخ میلادی ذخیره‌شده', [['T6101', 100000, 0], ['1101', 0, 100000]]);
  je('1405/7/5', 'هزینه مهر (ماه بدون صفر)', [['T6101', 70000, 0], ['1101', 0, 70000]]);
  const budgetLines = [
    { account_code: 'T6101', month: 1, amount_rial: 500000 },
    { account_code: 'T6101', month: 7, amount_rial: 100000 },
    { account_code: 'T6101', month: 12, amount_rial: 50000 },
  ];

  let r = await api('POST', '/api/budgeting', { name: 'بدون سال', year_label: '' });
  ok(r.status === 200 && r.data && r.data.id, 'create budget with blank year_label', r);
  const blankId = r.data && r.data.id;
  await api('PUT', `/api/budgeting/${blankId}`, { lines: budgetLines });
  r = await api('GET', `/api/budgeting/${blankId}/variance`);
  ok(r.status === 422 && r.data && r.data.code === 'budget_year_unresolved' && /سال مالی بودجه مشخص نیست/.test(r.data.error),
    'variance 422 when year_label blank and no fiscal period', r);
  ok(!(r.data && Array.isArray(r.data.rows)), '422 body carries no zero-actual rows', r.data);

  r = await api('POST', '/api/budgeting', { name: 'سال میلادی', year_label: '2026' });
  const malId = r.data && r.data.id;
  r = await api('GET', `/api/budgeting/${malId}/variance`);
  ok(r.status === 422 && /معتبر نیست/.test((r.data && r.data.error) || ''), 'variance 422 when year_label malformed', r);

  r = await api('POST', '/api/budgeting', { name: 'از دورهٔ مالی', year_label: '', fiscal_year_id: fyId });
  const fyBudgetId = r.data && r.data.id;
  await api('PUT', `/api/budgeting/${fyBudgetId}`, { lines: budgetLines });
  r = await api('GET', `/api/budgeting/${fyBudgetId}/variance`);
  ok(r.status === 200 && r.data && r.data.fiscal_year === '1405' && r.data.year_source === 'fiscal_period',
    'variance 200 from fiscal period; Nowruz month bucketing', r.status + ' ' + JSON.stringify(r.data && { fy: r.data.fiscal_year, src: r.data.year_source, err: r.data.error }));
  if (r.status === 200) {
    const rows = r.data.rows || [];
    const m1 = rows.find((x) => x.month === 1);
    const m7 = rows.find((x) => x.month === 7);
    const m12 = rows.find((x) => x.month === 12);
    ok(m1 && m1.actual_rial === 400000, 'month 1 actual = 1405/01/01 + ISO Nowruz entry (400,000), 1404/12/29 excluded', m1);
    ok(m1 && m1.variance_rial === 100000, 'month 1 variance = budget − actual', m1);
    ok(m7 && m7.actual_rial === 70000, "unpadded '1405/7/5' lands in month 7", m7);
    ok(m12 && m12.actual_rial === 0, 'month 12 has no 1404 spill-over', m12);
    ok(r.data.totals && r.data.totals.actual_rial === 470000 && r.data.totals.budget_rial === 650000, 'totals in integer rial', r.data.totals);
    ok(r.data.fiscal_period && r.data.fiscal_period.id === fyId, 'fiscal_period echoed', r.data.fiscal_period);
  }

  r = await api('POST', '/api/budgeting', { name: 'از برچسب', year_label: '1405/01' });
  const labelBudgetId = r.data && r.data.id;
  await api('PUT', `/api/budgeting/${labelBudgetId}`, { lines: budgetLines });
  r = await api('GET', `/api/budgeting/${labelBudgetId}/variance`);
  ok(r.status === 200 && r.data && r.data.fiscal_year === '1405' && r.data.year_source === 'year_label'
    && (r.data.rows || []).find((x) => x.month === 1 && x.actual_rial === 400000), 'variance 200 from year_label', r);

  r = await api('POST', '/api/budgeting', { name: 'تعارض', year_label: '1404', fiscal_year_id: fyId });
  const conflictId = r.data && r.data.id;
  r = await api('GET', `/api/budgeting/${conflictId}/variance`);
  ok(r.status === 422 && /هم‌خوان نیست/.test((r.data && r.data.error) || ''), 'variance 422 on period/label conflict', r);

  // ── cash-flow ──
  r = await api('GET', '/api/adv-reports/cash-flow?from=1399/01/01&to=1399/12/29');
  ok(r.status === 200 && r.data && r.data.status === 'ok' && r.data.total_net_rial === 0
    && r.data.reconciliation && r.data.reconciliation.ok === true && r.data.residual_rial === 0,
  'cash-flow 200 ok on valid empty period', r);

  je('1402/12/29', 'سرمایه اولیه', [['1101', 1000000, 0], ['T3101', 0, 1000000]]);
  const e1 = je('1403/01/05', 'فروش نقدی با ارزش افزوده', [['1101', 1100000, 0], ['T4101', 0, 1000000], ['T2105', 0, 100000]]);
  const e2 = je('1403/02/10', 'خرید دارایی ثابت با وام', [['1299', 800000, 0], ['1101', 0, 500000], ['T2201', 0, 300000]]);
  const e3 = je('1403/03/01', 'انتقال صندوق به بانک', [['1102', 200000, 0], ['1101', 0, 200000]]);
  const e4 = je('1403/04/01', 'دریافت بدون کد حساب', [['1101', 50000, 0], ['', 0, 50000]]);
  const e5 = je('1403/05/01', 'ردیف نقد بدون طرف حساب', [['1101', 10000, 0]]);
  const e6 = je('1403/06/01', 'سند برگشت‌خورده', [['1101', 5000000, 0], ['T4101', 0, 5000000]]);
  db.prepare("UPDATE journal_entries SET status='reversed' WHERE id=?").run(e6);
  const e7 = je('1403/06/02', 'سند حذف‌شده', [['1101', 7000000, 0], ['T4101', 0, 7000000]]);
  db.prepare("UPDATE journal_entries SET deleted_at=strftime('%s','now') WHERE id=?").run(e7);

  r = await api('GET', '/api/adv-reports/cash-flow?from=1403/01/01&to=1403/12/29');
  ok(r.status === 200 && r.data && r.data.status === 'ok', 'cash-flow 200 ok with sections/transfers/residual + reconciliation identity',
    r.status + ' ' + JSON.stringify(r.data && { status: r.data.status, error: r.data.error, rec: r.data.reconciliation }));
  if (r.status === 200 && r.data && r.data.sections) {
    const d = r.data;
    const s = d.sections;
    ok(s.operating.net_rial === 1000000, 'operating net = income share of cash sale', s.operating);
    ok(s.investing.net_rial === -363636, 'investing net = proportional fixed-asset share', s.investing);
    ok(s.financing.net_rial === 100000 - 136364, 'financing net = VAT share − loan share', s.financing);
    ok(d.total_net_rial === 600000, 'total_net_rial = sum of classified nets', d.total_net_rial);
    ok(d.transfers && d.transfers.count === 1 && d.transfers.gross_rial === 200000 && d.transfers.net_rial === 0
      && d.transfers.lines[0].entry_id === e3, 'cash↔bank transfer isolated with net 0', d.transfers);
    ok(d.residual_rial === 60000, 'residual_rial = empty-code share + cash-only entry', d.residual_rial);
    const exIds = (d.exceptions || []).map((x) => x.entry_id).sort();
    ok(exIds.length === 2 && exIds.includes(e4) && exIds.includes(e5), 'exceptions[] carry entry_id of unclassifiable entries', d.exceptions);
    const reasons = (d.exceptions || []).map((x) => x.reason).sort();
    ok(reasons.join(',') === 'empty_account_code,no_counterpart', 'exception reasons', reasons);
    const rec = d.reconciliation;
    ok(rec.opening_cash_rial === 1000000, 'opening cash = Σ cash/bank before from-date', rec);
    ok(rec.closing_cash_rial === 1660000, 'closing cash = Σ cash/bank through to-date (reversed/deleted excluded)', rec);
    ok(rec.ok === true && rec.difference_rial === 0
      && rec.opening_cash_rial + rec.total_net_rial + rec.residual_rial + rec.transfer_net_rial === rec.closing_cash_rial,
    'identity: opening + classified nets + residual + transfer_net(0) = closing', rec);
    ok(typeof rec.formula === 'string' && rec.formula.includes('residual_rial'), 'identity stated in JSON', rec.formula);
    ok(typeof d.warning === 'string' && /residual/.test(d.warning) && /60000/.test(d.warning), 'warning mentions residual amount', d.warning);
    const e1Lines = ['operating', 'investing', 'financing'].flatMap((n) => s[n].lines.filter((l) => l.entry_id === e1));
    ok(e1Lines.length === 2 && sum(e1Lines.map((l) => l.amount_rial)) === 1100000, 'entry split across sections sums to its cash net', e1Lines);
    const e2Lines = ['operating', 'investing', 'financing'].flatMap((n) => s[n].lines.filter((l) => l.entry_id === e2));
    ok(sum(e2Lines.map((l) => l.amount_rial)) === -500000, 'compound purchase parts sum to −500,000', e2Lines);
    ok(!s.operating.lines.some((l) => l.entry_id === e4 || l.entry_id === e5), 'residual entries are not inside operating');
  }

  r = await api('GET', '/api/adv-reports/cash-flow?from=1403/12/29&to=1403/01/01');
  ok(r.status === 422 && r.data && r.data.status === 'failed' && r.data.code === 'bad_range' && r.data.sections === null,
    'cash-flow 422 failed on bad range', r);

  // Direct builder on the live DB (treasury-dashboard path): same contract.
  const direct = cashFlow.buildCashFlowReport(db, '1403/01/01', '1403/12/29');
  ok(direct.status === 'ok' && direct.total_net_rial === 600000 && direct.reconciliation.ok, 'buildCashFlowReport direct call matches route', direct.reconciliation);

  // Computation failure → 500 with status failed (not a zero report).
  db.prepare('ALTER TABLE journal_lines RENAME TO journal_lines__nontax_hidden').run();
  try {
    r = await api('GET', '/api/adv-reports/cash-flow?from=1403/01/01&to=1403/12/29');
    ok(r.status === 500 && r.data && r.data.status === 'failed' && r.data.sections === null && r.data.total_net_rial === null,
      'cash-flow 500 failed when GL table missing (no zero report)', r);
    ok(typeof (r.data && r.data.error) === 'string' && r.data.error.length > 0, 'failure body has Persian error', r.data && r.data.error);
  } finally {
    db.prepare('ALTER TABLE journal_lines__nontax_hidden RENAME TO journal_lines').run();
  }
  r = await api('GET', '/api/adv-reports/cash-flow?from=1403/01/01&to=1403/12/29');
  ok(r.status === 200 && r.data.status === 'ok', 'report recovers after table restored');

  await new Promise((resolve) => server.close(resolve));
  try { closeSessionStore(); } catch (_) { /* */ }
  finish();
})().catch((e) => {
  console.error('harness error:', e && e.stack);
  fail += 1;
  finish();
});

function finish() {
  console.log(`\nNONTAX budget/cash: ${fail ? '❌' : '✅'} ${pass} پاس، ${fail} رد، ${skipped} رد‌شده(SKIP)`);
  process.exit(fail ? 1 : 0);
}
