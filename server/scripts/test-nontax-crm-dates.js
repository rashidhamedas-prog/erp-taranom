#!/usr/bin/env node
'use strict';
/**
 * NONTAX-P1 CRM — Jalali recency math (FIX 5) + recurring follow-up reminders (FIX 6).
 *
 * Part A runs without sqlite: pure jalaliDaysBetween / window / rule-key helpers.
 * Part B needs better-sqlite3 (isolated temp DB via test-harness.freshDb). When the native
 * binding cannot load, every DB case is reported as SKIP with the real loader error.
 *
 * Run: node server/scripts/test-nontax-crm-dates.js
 */
const { ok, eq, summary } = require('./lib/test-harness');
const jal = require('../jalali');
const crmPro = require('../lib/crm-pro');

const {
  jalaliDaysBetween, jalaliEpochDay, parseJalaliParts, salesWindowStarts,
  overdueFollowupRuleKey, todayFollowupRuleKey, isFollowupReminderMuted,
  DEFAULT_REMIND_EVERY_DAYS,
} = crmPro;

const MS_DAY = 86400000;
const T = '1405/07/12'; // fixed "today" for deterministic window math (2026-10-04)
const plus = (d) => jal.addDaysToJalali(T, d);

console.log('══ NONTAX-P1 CRM dates & reminder cadence ══');
console.log('── A. Jalali day math (pure, no sqlite) ──');

// Month boundary: 31 Shahrivar → 1 Mehr.
eq('1405/06/31 → 1405/07/01 = 1 day', jalaliDaysBetween('1405/06/31', '1405/07/01'), 1);
eq('reverse pair is signed (-1), caller ignores it', jalaliDaysBetween('1405/07/01', '1405/06/31'), -1);
eq('same day = 0', jalaliDaysBetween('1405/07/01', '1405/07/01'), 0);
// Regression guard: the old code fed Jalali parts to Date.UTC as Gregorian → "June 31" == "July 1" → 0.
eq('legacy Gregorian math gave 0 for the same pair (bug reproduced)',
  (Date.UTC(1405, 6, 1) - Date.UTC(1405, 5, 31)) / MS_DAY, 0);

// Esfand / Nowruz, driven by the leap rule exported from jalali.js (no edit there).
ok('isJalaliLeapYear exported by jalali.js', typeof jal.isJalaliLeapYear === 'function');
const leap1403 = jal.isJalaliLeapYear(1403);
const leap1404 = jal.isJalaliLeapYear(1404);
ok('1403 leap / 1404 common (algorithm check)', leap1403 === true && leap1404 === false,
  `leap1403=${leap1403} leap1404=${leap1404}`);
if (leap1403) {
  eq('leap: 1403/12/30 → 1404/01/01 = 1 day', jalaliDaysBetween('1403/12/30', '1404/01/01'), 1);
  eq('leap: 1403/12/29 → 1404/01/01 = 2 days', jalaliDaysBetween('1403/12/29', '1404/01/01'), 2);
  const rt = jal.g2j(...jal.j2g(1403, 12, 30));
  ok('j2g/g2j round-trip keeps 1403/12/30', rt[0] === 1403 && rt[1] === 12 && rt[2] === 30);
}
if (!leap1404) {
  eq('common: 1404/12/29 → 1405/01/01 = 1 day', jalaliDaysBetween('1404/12/29', '1405/01/01'), 1);
}
eq('full year 1403 (leap) = 366', jalaliDaysBetween('1403/01/01', '1404/01/01'), leap1403 ? 366 : 365);
eq('full year 1404 (common) = 365', jalaliDaysBetween('1404/01/01', '1405/01/01'), leap1404 ? 366 : 365);
eq('second half months are 30 days: 1405/07/01 → 1405/08/01', jalaliDaysBetween('1405/07/01', '1405/08/01'), 30);
eq('first half months are 31 days: 1405/01/01 → 1405/02/01', jalaliDaysBetween('1405/01/01', '1405/02/01'), 31);

// Anchor to Gregorian: 1405/07/12 == 2026-10-04.
const g = jal.j2g(1405, 7, 12);
ok('1405/07/12 ↔ 2026-10-04 via j2g', g[0] === 2026 && g[1] === 10 && g[2] === 4, JSON.stringify(g));
eq('jalaliEpochDay matches Date.UTC of the Gregorian date', jalaliEpochDay(T), Math.round(Date.UTC(2026, 9, 4) / MS_DAY));

// Parsing robustness.
ok('Persian digits parse', JSON.stringify(parseJalaliParts('۱۴۰۵/۰۷/۰۱')) === '[1405,7,1]');
eq('non-padded parts still correct', jalaliDaysBetween('1405/6/31', '1405/7/1'), 1);
ok('empty → null', jalaliDaysBetween('', '1405/01/01') === null);
ok('garbage → null', jalaliDaysBetween('abc', '1405/01/01') === null);
ok('month 13 → null', jalaliDaysBetween('1405/13/01', '1405/01/01') === null);
ok('two parts → null', parseJalaliParts('1405/07') === null);

// 30 / 90 / 365 windows with a fixed today.
const w = salesWindowStarts(T);
eq('d30 is exactly 30 Jalali days before today', jalaliDaysBetween(w.d30, T), 30);
eq('d90 is exactly 90 Jalali days before today', jalaliDaysBetween(w.d90, T), 90);
eq('d365 is exactly 365 Jalali days before today', jalaliDaysBetween(w.d365, T), 365);
ok('purchase exactly 30 days ago is inside sales_30 (date >= d30)', plus(-30) >= w.d30);
ok('purchase 31 days ago is outside sales_30', !(plus(-31) >= w.d30));
ok('purchase 31 days ago is inside sales_90', plus(-31) >= w.d90);
ok('d30 string for 1405/07/12 is 1405/06/13', w.d30 === '1405/06/13', w.d30);

console.log('── A2. Reminder cadence keys (pure) ──');
eq('default cadence is 7 days', DEFAULT_REMIND_EVERY_DAYS, 7);
ok('1 day overdue → window 0', overdueFollowupRuleKey(5, '1405/07/11', 1, 7).endsWith(':win:0'));
ok('6 days overdue → window 0', overdueFollowupRuleKey(5, '1405/07/06', 6, 7).endsWith(':win:0'));
ok('7 days overdue → window 1', overdueFollowupRuleKey(5, '1405/07/05', 7, 7).endsWith(':win:1'));
ok('13 days overdue → window 1', overdueFollowupRuleKey(5, '1405/06/30', 13, 7).endsWith(':win:1'));
ok('14 days overdue → window 2', overdueFollowupRuleKey(5, '1405/06/29', 14, 7).endsWith(':win:2'));
ok('key embeds id + due date + window',
  overdueFollowupRuleKey(5, '1405/07/01', 8, 7) === 'overdue_followup:5:due:1405/07/01:win:1');
ok('cadence 0 is clamped to 1 (no division by zero)', overdueFollowupRuleKey(5, '1405/07/01', 8, 0).endsWith(':win:8'));
ok('today key is per due date', todayFollowupRuleKey(5, T) === `today_followup:5:due:${T}`);
ok('opt_out=1 mutes', isFollowupReminderMuted({ reminder_opt_out: 1 }, T) === true);
ok('snooze_until = today mutes', isFollowupReminderMuted({ reminder_snooze_until: T }, T) === true);
ok('snooze_until = tomorrow mutes', isFollowupReminderMuted({ reminder_snooze_until: plus(1) }, T) === true);
ok('snooze_until = yesterday does not mute', isFollowupReminderMuted({ reminder_snooze_until: plus(-1) }, T) === false);
ok('empty snooze does not mute', isFollowupReminderMuted({ reminder_snooze_until: '' }, T) === false);
ok('garbage snooze does not mute forever', isFollowupReminderMuted({ reminder_snooze_until: 'x' }, T) === false);

console.log('── B. Database cases (isolated temp DB) ──');
const DB_CASES = [
  'schema: followups.reminder_opt_out / reminder_snooze_until + cadence setting',
  'metrics: 31 Shahrivar → 1 Mehr cycle = 1, inactive_days Jalali, last_purchase_date Jalali string',
  'metrics: Esfand → Nowruz cycle = 1',
  'metrics: out-of-order dates never yield negative gaps',
  'metrics: forward-dated purchase clamps inactive_days at 0',
  'metrics: 30/90/365 window inclusion',
  'metrics: no-purchase customer uses created_at',
  'segmentation consumes the same arithmetic',
  'automation: overdue one occurrence per window, same-window retry suppressed',
  'automation: reschedule allows a new alert',
  'automation: completed follow-up never alerts',
  'automation: opt-out and snooze',
  'automation: due-today reminder per due date',
  'automation: reminders rows actually written',
  'route: PATCH /api/followups/:id/reminder',
];

let env = null;
let loadErr = null;
try {
  env = require('./lib/test-harness').freshDb();
} catch (e) {
  loadErr = e;
}

if (!env) {
  const why = String(loadErr && (loadErr.message || loadErr)).split('\n')[0];
  console.log(`  ⚠️  better-sqlite3 unavailable → DB cases SKIPPED (${why})`);
  for (const c of DB_CASES) console.log(`  ⏭️  SKIP ${c}`);
  summary('NONTAX-P1 CRM dates (DB part skipped)');
} else {
  runDbCases(env).then(() => {
    env.cleanup();
    summary('NONTAX-P1 CRM dates');
  }).catch((e) => {
    console.error(e);
    ok('DB cases threw', false, String(e && e.stack || e));
    try { env.cleanup(); } catch (_) { /* best effort */ }
    summary('NONTAX-P1 CRM dates');
  });
}

async function runDbCases({ db, dbMod }) {
  const now = Math.floor(Date.now() / 1000);
  const uid = db.prepare(`INSERT INTO users (username,password,name,role,active) VALUES ('fs1','x','فروشنده','field_sales',1)`).run().lastInsertRowid;
  const uid2 = db.prepare(`INSERT INTO users (username,password,name,role,active) VALUES ('fs2','x','دیگری','field_sales',1)`).run().lastInsertRowid;
  const cust = (biz, extra = {}) => db.prepare(
    `INSERT INTO customers (user_id,biz,phone,city,status,created_at) VALUES (?,?,?,?,?,?)`
  ).run(extra.user_id || uid, biz, '0915', 'مشهد', 'active', extra.created_at || now).lastInsertRowid;
  const inv = (custId, date, amount, type = 'normal', status = 'posted') => db.prepare(
    `INSERT INTO invoices (user_id,cust_id,num,type,date,rows,subtotal,disc,disc_amt,final,pay_type,status)
     VALUES (?,?,?,?,?,'[]',?,0,0,?,'cash',?)`
  ).run(uid, custId, `N-${custId}-${date}`, type, date, amount, amount, status).lastInsertRowid;
  const metrics = (custId, today = T) => crmPro.computeCustomerMetrics(db, custId, { today });

  // ── schema ──
  const cols = db.prepare('PRAGMA table_info(followups)').all().map((c) => c.name);
  ok('followups.reminder_opt_out column exists', cols.includes('reminder_opt_out'));
  ok('followups.reminder_snooze_until column exists', cols.includes('reminder_snooze_until'));
  eq('setting crm_followup_remind_every_days defaults to 7',
    db.prepare("SELECT value FROM settings WHERE key='crm_followup_remind_every_days'").get()?.value, 7);
  eq('followupRemindCadence reads the setting', crmPro.followupRemindCadence(db), 7);

  // ── metrics: month boundary ──
  const cA = cust('الف');
  inv(cA, '1405/06/31', 1000);
  inv(cA, '1405/07/01', 2000);
  inv(cA, '1405/07/02', 50, 'proforma'); // not firm → ignored
  inv(cA, '1405/07/03', 70, 'normal', 'reversed'); // reversed → ignored
  const mA = metrics(cA);
  eq('cycle 31 Shahrivar → 1 Mehr = 1 day', mA.avg_cycle_days, 1);
  eq('purchase_count counts firm only', mA.purchase_count, 2);
  ok('last_purchase_date stays the Jalali string', mA.last_purchase_date === '1405/07/01', mA.last_purchase_date);
  eq('inactive_days = 11 (1405/07/01 → 1405/07/12)', mA.inactive_days, 11);
  eq('avg_purchase_rial', mA.avg_purchase_rial, 1500);

  // ── metrics: Esfand → Nowruz ──
  const cB = cust('ب');
  if (leap1403) { inv(cB, '1403/12/30', 100); inv(cB, '1404/01/01', 100); }
  else { inv(cB, '1403/12/29', 100); inv(cB, '1404/01/01', 100); }
  eq('cycle across Nowruz = 1 day', metrics(cB).avg_cycle_days, 1);

  // ── metrics: out-of-order (non-padded strings sort wrongly: 10/01, 11/01, 9/01) ──
  const cC = cust('ج');
  inv(cC, '1405/9/01', 10);
  inv(cC, '1405/10/01', 10);
  inv(cC, '1405/11/01', 10);
  const mC = metrics(cC, '1405/12/01');
  ok('out-of-order pair ignored, no negative gap', mC.avg_cycle_days != null && mC.avg_cycle_days > 0, String(mC.avg_cycle_days));
  eq('only the ordered gap (10/01 → 11/01 = 30) is averaged', mC.avg_cycle_days, 30);
  ok('inactive_days never negative', mC.inactive_days >= 0);

  // ── metrics: forward-dated purchase ──
  const cD = cust('د');
  inv(cD, plus(5), 500);
  eq('last purchase after today → inactive_days 0', metrics(cD).inactive_days, 0);

  // ── metrics: windows ──
  const cE = cust('ه');
  inv(cE, plus(-30), 100);
  inv(cE, plus(-31), 200);
  inv(cE, plus(-90), 300);
  inv(cE, plus(-91), 400);
  inv(cE, plus(-365), 500);
  inv(cE, plus(-366), 600);
  const mE = metrics(cE);
  eq('sales_30 includes exactly-30-days-ago, excludes 31', mE.sales_30_rial, 100);
  eq('sales_90 includes exactly-90-days-ago, excludes 91', mE.sales_90_rial, 600);
  eq('sales_365 includes exactly-365-days-ago, excludes 366', mE.sales_365_rial, 1500);
  eq('inactive_days = 30', mE.inactive_days, 30);
  ok('avg cycle is a whole-day average (1 or 59-ish days, never NaN)', Number.isFinite(mE.avg_cycle_days));

  // ── metrics: no purchases ──
  const cF = cust('و', { created_at: now - 10 * 86400 });
  const mF = metrics(cF);
  eq('no-purchase inactive_days from created_at (10 days)', mF.inactive_days, 10, 1);
  eq('no-purchase count 0', mF.purchase_count, 0);
  ok('no-purchase last_purchase_date empty', mF.last_purchase_date === '');

  // ── segmentation uses the same arithmetic ──
  crmPro.runSegmentation(db);
  const segA = db.prepare('SELECT * FROM crm_customer_segments WHERE customer_id=?').get(cA);
  const liveA = crmPro.computeCustomerMetrics(db, cA);
  ok('segment row written', !!segA);
  eq('segment inactive_days == computeCustomerMetrics (real today)', segA.inactive_days, liveA.inactive_days);
  eq('segment avg_cycle_days == 1', segA.avg_cycle_days, 1);
  ok('segment last_purchase_date Jalali', segA.last_purchase_date === '1405/07/01');
  const cls = crmPro.classifySegment(db, liveA);
  ok('classifySegment yields a segment', typeof cls.segment === 'string' && cls.segment.length > 0, cls.segment);

  // ── automation: isolate follow-up rules ──
  const setSetting = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(k, v);
  setSetting('crm_auto_alert_stale_opp', '0');
  setSetting('crm_auto_alert_churn', '0');
  setSetting('crm_auto_alert_cheque', '0');
  const fup = (custId, nextDate, status = 'open') => db.prepare(
    `INSERT INTO followups (user_id,cust_id,date,type,subject,status,priority,pipeline_stage,purchase_prob,next_date)
     VALUES (?,?,?,'call','پیگیری',?,'mid','proposal',40,?)`
  ).run(uid, custId, T, status, nextDate).lastInsertRowid;
  const run = (today) => crmPro.runAutomations(db, { today });
  const rulesFor = (res, id, prefix = 'overdue_followup') => res.rules.filter((r) => r.startsWith(`${prefix}:${id}:`));
  const logCount = (id) => db.prepare(
    "SELECT COUNT(*) AS c FROM crm_automation_log WHERE entity_type='followup' AND entity_id=?"
  ).get(id).c;
  const remindersCount = () => db.prepare('SELECT COUNT(*) AS c FROM reminders').get().c;

  const remindersBefore = remindersCount();
  const f1 = fup(cA, plus(-1));
  let r = run(T);
  eq('day 1 overdue → one reminder', rulesFor(r, f1).length, 1);
  ok('key = overdue_followup:<id>:due:<next_date>:win:0', r.rules.includes(`overdue_followup:${f1}:due:${plus(-1)}:win:0`), r.rules.join(','));
  r = run(T);
  eq('same day re-run → 0 (INSERT OR IGNORE)', rulesFor(r, f1).length, 0);
  r = run(plus(3));
  eq('day 4 (same window 0) → 0', rulesFor(r, f1).length, 0);
  r = run(plus(6));
  eq('day 7 overdue (window 1) → 1', rulesFor(r, f1).length, 1);
  r = run(plus(7));
  eq('day 8 (window 1 again) → 0', rulesFor(r, f1).length, 0);
  r = run(plus(13));
  eq('day 14 (window 2) → 1', rulesFor(r, f1).length, 1);
  eq('15 days overdue with cadence 7 → 3 reminders total (no spam)', logCount(f1), 3);
  ok('logAutomation returns false on duplicate key',
    crmPro.logAutomation(db, `overdue_followup:${f1}:due:${plus(-1)}:win:0`, 'followup', f1) === false);

  // cadence setting honoured
  setSetting('crm_followup_remind_every_days', '3');
  r = run(plus(16)); // 17 days overdue / 3 → window 5
  ok('cadence setting 3 → window 5 key', r.rules.includes(`overdue_followup:${f1}:due:${plus(-1)}:win:5`), r.rules.join(','));
  setSetting('crm_followup_remind_every_days', '7');

  // reschedule → new key even in a window index already used
  db.prepare('UPDATE followups SET next_date=? WHERE id=?').run(plus(8), f1);
  r = run(plus(16)); // 8 days overdue vs new due → window 1 (window 1 already used for the old due date)
  eq('reschedule → new alert allowed', rulesFor(r, f1).length, 1);
  ok('rescheduled key carries the new due date', r.rules.includes(`overdue_followup:${f1}:due:${plus(8)}:win:1`), r.rules.join(','));

  // completed never alerts
  const f2 = fup(cB, plus(-10), 'done');
  r = run(T);
  eq('done follow-up with past due → 0', rulesFor(r, f2).length, 0);
  db.prepare("UPDATE followups SET status='done' WHERE id=?").run(f1);
  r = run(plus(40));
  eq('completing an alerting follow-up stops further windows', rulesFor(r, f1).length, 0);
  db.prepare("UPDATE followups SET status='cancel' WHERE id=?").run(f2);
  r = run(plus(40));
  eq('cancelled → 0', rulesFor(r, f2).length, 0);

  // opt-out / snooze
  const f3 = fup(cC, plus(-1));
  let prefs = crmPro.setFollowupReminderPrefs(db, f3, { optOut: 1 }, { today: T });
  eq('opt_out stored', prefs.reminder_opt_out, 1);
  r = run(T);
  eq('opted-out → 0', rulesFor(r, f3).length, 0);
  prefs = crmPro.setFollowupReminderPrefs(db, f3, { optOut: 0 }, { today: T });
  eq('opt back in', prefs.reminder_opt_out, 0);
  r = run(T);
  eq('opted back in → alert in window 0', rulesFor(r, f3).length, 1);
  prefs = crmPro.setFollowupReminderPrefs(db, f3, { snoozeUntil: plus(10) }, { today: T });
  ok('snooze_until stored canonical', prefs.reminder_snooze_until === plus(10), prefs.reminder_snooze_until);
  r = run(plus(7));
  eq('snoozed (window 1 would be due) → 0', rulesFor(r, f3).length, 0);
  r = run(plus(10));
  eq('snooze_until == today → still muted', rulesFor(r, f3).length, 0);
  r = run(plus(11));
  eq('day after snooze → alert resumes', rulesFor(r, f3).length, 1);
  ok('resumed key is window 1 (12 days / 7)', r.rules.includes(`overdue_followup:${f3}:due:${plus(-1)}:win:1`), r.rules.join(','));
  prefs = crmPro.setFollowupReminderPrefs(db, f3, { snoozeUntil: '' }, { today: T });
  ok('snooze cleared with empty string', prefs.reminder_snooze_until === '');
  prefs = crmPro.setFollowupReminderPrefs(db, f3, { snoozeDays: 5 }, { today: T });
  ok('snooze_days → today + 5', prefs.reminder_snooze_until === plus(5), prefs.reminder_snooze_until);
  prefs = crmPro.setFollowupReminderPrefs(db, f3, { snoozeUntil: '۱۴۰۵/۰۸/۰۱' }, { today: T });
  ok('Persian digits normalised', prefs.reminder_snooze_until === '1405/08/01', prefs.reminder_snooze_until);
  let bad = 0;
  try { crmPro.setFollowupReminderPrefs(db, f3, { snoozeUntil: 'garbage' }, { today: T }); } catch (e) { bad = e.status; }
  eq('garbage snooze → 400', bad, 400);
  bad = 0;
  try { crmPro.setFollowupReminderPrefs(db, f3, { snoozeUntil: plus(-1) }, { today: T }); } catch (e) { bad = e.status; }
  eq('past snooze → 400', bad, 400);
  bad = 0;
  try { crmPro.setFollowupReminderPrefs(db, f3, { snoozeDays: 0 }, { today: T }); } catch (e) { bad = e.status; }
  eq('snooze_days 0 → 400', bad, 400);
  bad = 0;
  try { crmPro.setFollowupReminderPrefs(db, 999999, { optOut: 1 }); } catch (e) { bad = e.status; }
  eq('unknown follow-up → 404', bad, 404);
  const rowF3 = db.prepare('SELECT * FROM followups WHERE id=?').get(f3);
  ok('prefs do not touch other columns', rowF3.subject === 'پیگیری' && rowF3.status === 'open' && rowF3.next_date === plus(-1));

  // due-today reminder per due date
  const f4 = fup(cD, T);
  r = run(T);
  eq('due today → 1', rulesFor(r, f4, 'today_followup').length, 1);
  ok('today key embeds due date', r.rules.includes(`today_followup:${f4}:due:${T}`));
  r = run(T);
  eq('due today re-run → 0', rulesFor(r, f4, 'today_followup').length, 0);
  db.prepare('UPDATE followups SET next_date=? WHERE id=?').run(plus(1), f4);
  r = run(plus(1));
  eq('rescheduled to tomorrow → alerts again tomorrow', rulesFor(r, f4, 'today_followup').length, 1);
  crmPro.setFollowupReminderPrefs(db, f4, { optOut: 1 });
  db.prepare('UPDATE followups SET next_date=? WHERE id=?').run(plus(2), f4);
  r = run(plus(2));
  eq('opted-out due-today → 0', rulesFor(r, f4, 'today_followup').length, 0);

  // reminders rows are really written (canonical schema user_id,cust_id,title,body,remind_at,done)
  const totalLogged = db.prepare("SELECT COUNT(*) AS c FROM crm_automation_log WHERE entity_type='followup'").get().c;
  eq('one reminders row per logged follow-up occurrence', remindersCount() - remindersBefore, totalLogged);
  const lastRem = db.prepare('SELECT * FROM reminders ORDER BY id DESC LIMIT 1').get();
  ok('reminder carries cust_id and Jalali remind_at', lastRem && lastRem.cust_id != null && /^\d{4}\/\d{2}\/\d{2}$/.test(String(lastRem.remind_at)), JSON.stringify(lastRem));
  ok('reminder body mentions days overdue', db.prepare("SELECT COUNT(*) AS c FROM reminders WHERE body LIKE '%روز تأخیر%'").get().c >= 1);
  const beforeLast = remindersCount();
  const last = run(plus(100));
  eq('automation result count == reminders rows created in that run', remindersCount() - beforeLast, last.created);

  // ── route: PATCH /api/followups/:id/reminder (auth middleware stubbed; real RBAC + scope) ──
  await routeCases({ db, dbMod, uid, uid2, cA, f3 });
}

async function routeCases({ db, dbMod, uid, uid2, cA, f3 }) {
  let express;
  try { express = require('express'); } catch (e) {
    console.log(`  ⏭️  SKIP route: express unavailable (${String(e.message).split('\n')[0]})`);
    return;
  }
  const { hasPermission } = require('../lib/rbac');
  const authPath = require.resolve('../middleware/auth');
  const actor = { current: null };
  const prevAuth = require.cache[authPath];
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true, exports: {
      auth: (req, res, next) => {
        if (!actor.current) return res.status(401).json({ error: 'توکن یافت نشد' });
        req.user = actor.current; next();
      },
      adminOnly: (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'x' })),
      requirePermission: (resource, action) => (req, res, next) => (
        hasPermission(dbMod.getDB(), req.user, resource, action) ? next() : res.status(403).json({ error: 'دسترسی ندارید' })
      ),
    },
  };
  const routerPath = require.resolve('../routes/followups');
  delete require.cache[routerPath];
  let router;
  try { router = require('../routes/followups'); }
  catch (e) {
    console.log(`  ⏭️  SKIP route: followups router failed to load (${String(e.message).split('\n')[0]})`);
    if (prevAuth) require.cache[authPath] = prevAuth; else delete require.cache[authPath];
    return;
  }
  const app = express();
  app.use(express.json());
  app.use('/api/followups', router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (user, id, body, method = 'PATCH') => {
    actor.current = user;
    const res = await fetch(`${base}/api/followups/${id}/reminder`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* empty */ }
    return { status: res.status, json };
  };
  const owner = { id: uid, role: 'field_sales', username: 'fs1', name: 'فروشنده' };
  const stranger = { id: uid2, role: 'field_sales', username: 'fs2', name: 'دیگری' };
  const admin = { id: 1, role: 'admin', username: 'admin', name: 'مدیر' };
  const viewer = { id: uid2, role: 'accounting', username: 'acc', name: 'حسابدار' };
  try {
    const auditBefore = db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE entity='followup_reminder'").get().c;
    let resp = await call(null, f3, { opt_out: 1 });
    eq('unauthenticated → 401', resp.status, 401);
    resp = await call(stranger, f3, { opt_out: 1 });
    eq('other salesperson (customer not visible) → 403', resp.status, 403);
    resp = await call(viewer, f3, { opt_out: 1 });
    eq('accounting (followups view-only by RBAC) → 403', resp.status, 403);
    resp = await call(owner, f3, {});
    eq('empty body → 400', resp.status, 400);
    resp = await call(owner, f3, { snooze_until: 'nope' });
    eq('invalid snooze_until → 400', resp.status, 400);
    resp = await call(owner, f3, { opt_out: 1 });
    eq('owner opt-out → 200', resp.status, 200);
    eq('response echoes opt_out', resp.json?.reminder_opt_out, 1);
    eq('row updated', db.prepare('SELECT reminder_opt_out FROM followups WHERE id=?').get(f3).reminder_opt_out, 1);
    const far = jal.addDaysToJalali(jal.todayJalali(), 20);
    resp = await call(admin, f3, { opt_out: 0, snooze_until: far });
    eq('admin sets snooze → 200', resp.status, 200);
    ok('snooze stored', resp.json?.reminder_snooze_until === far && resp.json?.reminder_opt_out === 0, JSON.stringify(resp.json));
    resp = await call(owner, f3, { snooze_days: 3 });
    eq('snooze_days → 200', resp.status, 200);
    ok('snooze_days relative to real today', resp.json?.reminder_snooze_until === jal.addDaysToJalali(jal.todayJalali(), 3), JSON.stringify(resp.json));
    resp = await call(owner, 987654, { opt_out: 1 });
    eq('unknown id → 404', resp.status, 404);
    // assigned_to visibility: stranger becomes assignee of the customer → allowed
    db.prepare('UPDATE customers SET assigned_to=? WHERE id=?').run(uid2, cA);
    const fA = db.prepare(`INSERT INTO followups (user_id,cust_id,date,type,subject,status,priority,next_date)
      VALUES (?,?,?,'call','x','open','mid',?)`).run(uid, cA, T, T).lastInsertRowid;
    resp = await call(stranger, fA, { opt_out: 1 });
    eq('assignee of the customer may snooze/opt-out → 200', resp.status, 200);
    const auditAfter = db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE entity='followup_reminder'").get().c;
    eq('audit_log rows written for successful updates', auditAfter - auditBefore, 4);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (prevAuth) require.cache[authPath] = prevAuth; else delete require.cache[authPath];
    delete require.cache[routerPath];
  }
}
