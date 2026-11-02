'use strict';
/**
 * تسهیم سربار واقعی 61030x بین مراکز (تصمیم مالک: کارگاه cc1 / اتو و بسته‌بندی cc8):
 *  (a) نسبت تسهیم: پیش‌فرض ۵۰/۵۰، اعتبارسنجی جمع > ۱۰۰٪ با پیام فارسی
 *  (b) اعمال نسبت به معین‌ها (upsert + غیرفعال‌سازی مراکز دیگر) + audit
 *  (c) مجموع درصد یک معین در همهٔ مراکز ≤ ۱۰۰٪ (ذخیرهٔ نگاشت رد می‌شود)
 *  (d) اجرای دوره: یک بد 5202 برای هر مرکز، یک بس برای هر معین، باقیماندهٔ گرد کردن به آخرین مرکز
 *  (e) ۷۰/۳۰ + ابطال کامل (R13) + اجرای مجدد
 *  (f) محدودیت نقش (فقط مدیر/حسابداری) + audit ویرایش نگاشت
 * Run: node server/scripts/test-prodcycle-oh-split.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prodcycle-ohsplit-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-prodcycle-oh-split-secret-32-bytes!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; failures.push(label); console.log('  ❌', label, extra != null ? JSON.stringify(extra) : ''); }
}
function eq(actual, expected, label) {
  ok(Number(actual) === Number(expected), label, { actual, expected });
}

const PERIOD = '1405/07';
const D = '1405/07/10';

(async () => {
  const { acct, resolvePostableLeaf } = require('../lib/coa-map');
  const { postToLedger } = require('../lib/ledger');
  const close = require('../lib/production/close');
  const absorb = require('../lib/production/cc-account-absorb');

  const leaf = (code) => {
    try { return resolvePostableLeaf(db, code, { create: true })?.code || code; } catch { return code; }
  };
  const endBal = (code) => close.accountBalance(db, code, `${PERIOD}/31`);
  const postJe = (lines) => postToLedger(db, {
    sourceType: 'manual_test', sourceId: 1, date: D, description: 'OH split test', createdBy: 1,
    voucherType: 'auto', status: 'approved',
    lines: lines.map((l) => ({ code: l.code, name: l.code, debit: (l.dr || 0) / 10, credit: (l.cr || 0) / 10 })),
  });
  const mkCc = (code, name, seq, stage = 1) => db.prepare(`
    INSERT INTO cost_centers (code, name, entity, active, is_stage, seq, driver)
    VALUES (?,?, 'workshop', 1, ?, ?, 'output_qty')
  `).run(code, name, stage, seq).lastInsertRowid;
  const cc1 = mkCc('OHS-CC1', 'کارگاه تولید — نبوت', 910);
  const cc8 = mkCc('OHS-CC8', 'اتو و بسته‌بندی', 980);
  const cc2 = mkCc('OHS-CC2', 'دفتر توزیع', 950, 0);
  for (const [code, name] of [['610301', 'اجاره کارگاه'], ['610303', 'برق کارگاه'], ['610307', 'بسته‌بندی']]) {
    db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES (?,?,'expense','6103',3,1)").run(code, name);
  }
  const cash = leaf('1101');
  const c5202 = acct(db, 'coa_overhead_control').code;
  // مبالغ فرد تا باقیماندهٔ گرد کردن دیده شود
  postJe([{ code: '610301', dr: 1_000_001 }, { code: '610303', dr: 333_333 }, { code: '610307', dr: 4_212_000 },
    { code: cash, cr: 5_545_334 }]);

  console.log('\n(a) نسبت تسهیم');
  const def = absorb.getSplit(db);
  ok(def.is_default && def.split[1] === 50 && def.split[8] === 50, 'default split = {1:50, 8:50}', def);
  let e1 = null;
  try { absorb.normalizeSplit(db, { [cc1]: 70, [cc8]: 40 }); } catch (e) { e1 = e; }
  ok(e1 && e1.code === 'E_SPLIT_OVER_100' && /۱۰۰٪/.test(e1.message), 'split sum 110% rejected (Persian)', e1 && e1.message);
  let e2 = null;
  try { absorb.normalizeSplit(db, { 999999: 50 }); } catch (e) { e2 = e; }
  ok(e2 && e2.code === 'E_CC_NOT_FOUND', 'unknown cost center rejected', e2 && e2.code);
  let e3 = null;
  try { absorb.normalizeSplit(db, { [cc1]: -5 }); } catch (e) { e3 = e; }
  ok(e3 && e3.code === 'E_SPLIT_PCT', 'negative share rejected', e3 && e3.code);

  console.log('\n(b) اعمال نسبت به معین‌ها');
  absorb.replaceMaps(db, cc2, [
    { account_code: '610301', absorb_pct: 50, base_type: 'period_debit' },
    { account_code: '610303', absorb_pct: 100, base_type: 'ending_balance' },
  ], 1);
  const cc2MapId = db.prepare('SELECT id FROM cost_center_account_maps WHERE cost_center_id=? AND account_code=?').get(cc2, '610301').id;
  const applied = absorb.applySplit(db, {
    split: { [cc1]: 50, [cc8]: 50 },
    accounts: [
      { account_code: '610301', base_type: 'period_debit' },
      { account_code: '610303', base_type: 'ending_balance' },
      { account_code: '610307', base_type: 'period_debit' },
    ],
    userId: 1,
  });
  ok(applied.ok && applied.maps.filter((m) => m.active).length === 6, 'six active maps (3 accounts × 2 centers)', applied.maps);
  ok(db.prepare('SELECT COUNT(*) c FROM cost_center_account_maps WHERE cost_center_id=? AND active=1').get(cc2).c === 0,
    'cc2 maps of the same accounts deactivated');
  ok(!!db.prepare('SELECT id FROM cost_center_account_maps WHERE id=?').get(cc2MapId), 'R13: cc2 map not physically deleted');
  const saved = absorb.getSplit(db);
  ok(!saved.is_default && saved.split[cc1] === 50 && saved.split[cc8] === 50, 'split persisted to settings', saved);
  const splitAudit = db.prepare("SELECT * FROM audit_log WHERE entity='oh_actual_split' ORDER BY id DESC LIMIT 1").get();
  ok(splitAudit && /"before"/.test(splitAudit.detail) && /"after"/.test(splitAudit.detail), 'applySplit audited with before/after');
  const pre0 = close.precheck(db, { period: PERIOD });
  ok(pre0.checks.find((c) => c.code === 'SHARED_MOEIN')?.status === 'pass', 'SHARED_MOEIN passes at 50+50');

  console.log('\n(c) مجموع درصد معین ≤ ۱۰۰٪');
  let over = null;
  try {
    absorb.replaceMaps(db, cc2, [{ account_code: '610301', absorb_pct: 10, base_type: 'period_debit' }], 1);
  } catch (e) { over = e; }
  ok(over && over.code === 'E_ACCOUNT_PCT_OVER_100' && /610301/.test(over.message) && /۱۰۰٪/.test(over.message),
    'replaceMaps rejects 50+50+10 for 610301 (Persian)', over && over.message);
  ok(db.prepare('SELECT active FROM cost_center_account_maps WHERE id=?').get(cc2MapId).active === 0, 'rejected save rolled back');
  let over2 = null;
  try { absorb.applySplit(db, { split: { [cc1]: 60, [cc8]: 50 }, accounts: ['610301'], userId: 1 }); } catch (e) { over2 = e; }
  ok(over2 && over2.code === 'E_SPLIT_OVER_100', 'applySplit 60/50 rejected');
  ok(absorb.getSplit(db).split[cc1] === 50, 'rejected applySplit left setting unchanged');

  console.log('\n(d) اجرای دوره ۵۰/۵۰');
  const pv = absorb.previewAbsorbPeriod(db, PERIOD);
  const pvCc = Object.fromEntries(pv.debit_by_cc.map((c) => [c.cost_center_id, c.amount_rial]));
  // 610301: 1,000,001 → cc1 round(500000.5)=500001, cc8=500000 ; 610303: 333,333 → 166667 / 166666 ; 610307: 4,212,000 → 2,106,000×2
  eq(pvCc[cc1], 500_001 + 166_667 + 2_106_000, 'preview cc1 share');
  eq(pvCc[cc8], 500_000 + 166_666 + 2_106_000, 'preview cc8 share (rounding residue on last)');
  eq(pv.total_rial, 5_545_334, 'preview total = full 61030x activity');
  const run = absorb.runAbsorbPeriod(db, { period: PERIOD, userId: 1 });
  ok(run.ok && run.je_id && run.total_rial === 5_545_334, 'run-period posted', run);
  const jl = db.prepare('SELECT account_code, cost_center_id, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?').all(run.je_id);
  const dr = jl.filter((l) => l.account_code === c5202 && Number(l.debit_rial) > 0);
  ok(dr.length === 2, 'one Dr 5202 line per center', dr);
  eq(dr.find((l) => Number(l.cost_center_id) === Number(cc1))?.debit_rial, pvCc[cc1], 'Dr 5202 cc1 amount');
  eq(dr.find((l) => Number(l.cost_center_id) === Number(cc8))?.debit_rial, pvCc[cc8], 'Dr 5202 cc8 amount');
  for (const [code, amt] of [['610301', 1_000_001], ['610303', 333_333], ['610307', 4_212_000]]) {
    const crs = jl.filter((l) => l.account_code === code);
    ok(crs.length === 1 && Number(crs[0].credit_rial) === amt, `single Cr line for ${code} = ${amt}`, crs);
  }
  eq(endBal('610301'), 0, '610301 fully absorbed');
  eq(endBal(c5202), 5_545_334, '5202 = total');
  ok(db.prepare("SELECT COUNT(*) c FROM cc_absorb_postings WHERE doc_no=? AND status='posted'").get(run.doc_no).c === 6,
    'six posting rows (one per map)');
  ok(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE entity='cc_absorb_posting' AND action='create'").get().c >= 1, 'run audited');
  let again = null;
  try { absorb.runAbsorbPeriod(db, { period: PERIOD, userId: 1 }); } catch (e) { again = e; }
  ok(again && again.code === 'E_ALREADY_POSTED', 'second run same period blocked');

  console.log('\n(e) ابطال کامل + ۷۰/۳۰');
  const rev = absorb.reverseAbsorb(db, { docNo: run.doc_no, reason: 'تغییر نسبت', userId: 1 });
  ok(rev.ok && rev.count === 6, 'reverse whole doc', rev);
  eq(endBal(c5202), 0, 'R13: 5202 back to 0');
  eq(endBal('610301'), 1_000_001, 'R13: 610301 restored');
  eq(endBal('610307'), 4_212_000, 'R13: 610307 restored');
  absorb.applySplit(db, { split: { [cc1]: 70, [cc8]: 30 }, accounts: ['610301', { account_code: '610307' }], userId: 1 });
  const run2 = absorb.runAbsorbPeriod(db, { period: PERIOD, userId: 1 });
  const jl2 = db.prepare('SELECT account_code, cost_center_id, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?').all(run2.je_id);
  const d2 = (cc) => Number(jl2.find((l) => l.account_code === c5202 && Number(l.cost_center_id) === Number(cc))?.debit_rial || 0);
  // 610301: 700000.7→700001 / 300000 ; 610303 still 50/50 → 166667/166666 ; 610307: 2,948,400 / 1,263,600
  eq(d2(cc1), 700_001 + 166_667 + 2_948_400, '70/30: cc1 Dr');
  eq(d2(cc8), 300_000 + 166_666 + 1_263_600, '70/30: cc8 Dr (residue)');
  eq(run2.total_rial, 5_545_334, '70/30 total unchanged');

  console.log('\n(f) اجرای تک‌مرکز + نقش + audit (HTTP)');
  absorb.reverseAbsorb(db, { docNo: run2.doc_no, reason: 'تست تک‌مرکز', userId: 1 });
  const one = absorb.runAbsorb(db, { costCenterId: cc1, period: PERIOD, userId: 1 });
  eq(one.total_rial, 700_001 + 166_667 + 2_948_400, 'per-center run uses same share as period run');
  const rest = absorb.runAbsorbPeriod(db, { period: PERIOD, userId: 1 });
  ok(rest.debit_by_cc.length === 1 && Number(rest.debit_by_cc[0].cost_center_id) === Number(cc8), 'period run then posts only remaining cc8', rest.debit_by_cc);
  eq(endBal(c5202), 5_545_334, 'cc1 + cc8 runs sum to total');

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const mkUser = (u, role) => {
    const id = db.prepare(`INSERT INTO users (username, password, name, role, active, must_change_password) VALUES (?, 'x', ?, ?, 1, 0)`)
      .run(u, u, role).lastInsertRowid;
    for (const action of ['view', 'edit']) {
      db.prepare('INSERT OR REPLACE INTO user_permissions (user_id, resource, action, allowed) VALUES (?,?,?,1)').run(id, 'production_cost', action);
    }
    return db.prepare('SELECT * FROM users WHERE id=?').get(id);
  };
  const pm = mkUser('ohs_pm', 'production_manager');
  const accUser = mkUser('ohs_acc', 'accounting');
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const tok = (u, fp) => issueStaffSession(db, u, { device_kind: 'test', device_name: fp, device_fingerprint: fp }).token;
  const adminTok = tok(admin, 'ohs-admin');
  const pmTok = tok(pm, 'ohs-pm');
  const accTok = tok(accUser, 'ohs-acc');

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/production/cost-centers', require('../routes/production-cost-centers'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  async function api(token, method, url, body) {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }
  const base = '/api/production/cost-centers';

  const g = await api(pmTok, 'GET', `${base}/account-maps/split?period=${PERIOD}`);
  ok(g.status === 200 && g.data.can_edit === false && g.data.split[cc1] === 70, 'pm can view split (read-only)', g.data);
  ok(Array.isArray(g.data.accounts) && g.data.accounts.some((a) => a.account_code === '610307'), 'split view lists 61030x with activity');
  const pmPut = await api(pmTok, 'PUT', `${base}/account-maps/split`, { split: { [cc1]: 50, [cc8]: 50 } });
  ok(pmPut.status === 403 && pmPut.data.code === 'E_FORBIDDEN', 'production_manager cannot edit split', pmPut);
  const pmMaps = await api(pmTok, 'PUT', `${base}/account-maps/${cc2}`, { maps: [] });
  ok(pmMaps.status === 403, 'production_manager cannot edit account maps', pmMaps.status);
  const pmDel = await api(pmTok, 'DELETE', `${base}/account-maps/${cc2MapId}`);
  ok(pmDel.status === 403, 'production_manager cannot deactivate account maps', pmDel.status);
  const pmRun = await api(pmTok, 'POST', `${base}/absorb-postings/run-period`, { period_label: PERIOD });
  ok(pmRun.status === 403, 'production_manager cannot run period absorb', pmRun.status);

  const badPut = await api(adminTok, 'PUT', `${base}/account-maps/split`, { split: { [cc1]: 80, [cc8]: 30 } });
  ok(badPut.status === 400 && badPut.data.code === 'E_SPLIT_OVER_100', 'HTTP: >100% split rejected', badPut.data);
  const accPut = await api(accTok, 'PUT', `${base}/account-maps/split`, { split: { [cc1]: 50, [cc8]: 50 }, accounts: [] });
  ok(accPut.status === 200 && accPut.data.split[cc1] === 50, 'accounting can edit split', accPut.data);
  const auditHttp = db.prepare("SELECT * FROM audit_log WHERE entity='oh_actual_split' AND user_id=? ORDER BY id DESC LIMIT 1").get(accUser.id);
  ok(!!auditHttp, 'HTTP split edit audited with user');

  const mapPut = await api(adminTok, 'PUT', `${base}/account-maps/${cc2}`, { maps: [{ account_code: '610303', absorb_pct: 0, base_type: 'ending_balance' }] });
  ok(mapPut.status === 200, 'admin can edit account maps', mapPut.data);
  const mapAudit = db.prepare("SELECT * FROM audit_log WHERE entity='cost_center_account_map' AND action='update' ORDER BY id DESC LIMIT 1").get();
  ok(mapAudit && /"before"/.test(mapAudit.detail) && /"after"/.test(mapAudit.detail), 'account-map edit audited');
  const mapBad = await api(adminTok, 'PUT', `${base}/account-maps/${cc2}`, { maps: [{ account_code: '610303', absorb_pct: 1, base_type: 'ending_balance' }] });
  ok(mapBad.status === 400 && mapBad.data.code === 'E_ACCOUNT_PCT_OVER_100', 'HTTP: 50+50+1 on 610303 rejected', mapBad.data);
  const pvHttp = await api(pmTok, 'POST', `${base}/absorb-postings/preview-period`, { period_label: PERIOD });
  ok(pvHttp.status === 200 && pvHttp.data.already_posted_count >= 1 && !pvHttp.data.pending_lines, 'preview-period readable by viewer', pvHttp.data);

  console.log('\n(g) اسکریپت dry-run / apply نگاشت (روی کپی موقت)');
  {
    const { execFileSync } = require('child_process');
    const Database = require('better-sqlite3');
    const copy = path.join(dir, 'copy.db');
    await db.backup(copy);
    const c = new Database(copy);
    c.prepare('UPDATE cost_center_account_maps SET active=0').run();
    c.prepare("DELETE FROM settings WHERE key='oh_actual_split'").run();
    for (const [code, pct, base] of [['610301', 50, 'period_debit'], ['610303', 100, 'ending_balance']]) {
      c.prepare(`INSERT INTO cost_center_account_maps (cost_center_id, account_code, absorb_pct, base_type, active)
        VALUES (?,?,?,?,1) ON CONFLICT(cost_center_id, account_code) DO UPDATE SET absorb_pct=excluded.absorb_pct,
        base_type=excluded.base_type, active=1`).run(cc2, code, pct, base);
    }
    c.prepare("UPDATE cc_absorb_postings SET status='reversed'").run();
    c.close();
    const script = path.join(__dirname, 'oh-split-maps-dryrun.js');
    const csvPath = path.join(dir, 'dry.csv');
    const splitArg = JSON.stringify({ [cc1]: 50, [cc8]: 50 });
    const hashBefore = require('crypto').createHash('sha1').update(fs.readFileSync(copy)).digest('hex');
    execFileSync(process.execPath, [script, '--db', copy, '--period', PERIOD, '--split', splitArg, '--out', csvPath], { stdio: 'pipe' });
    const hashAfter = require('crypto').createHash('sha1').update(fs.readFileSync(copy)).digest('hex');
    ok(hashBefore === hashAfter, 'dry-run does not modify the DB file');
    const csv = fs.readFileSync(csvPath, 'utf8');
    const lines = csv.split('\n');
    ok(lines.filter((l) => l.startsWith('proposed_map,')).length === 6, 'dry-run CSV: 3 accounts × 2 proposed maps');
    ok(lines.filter((l) => l.startsWith('deactivate_map,')).length === 2, 'dry-run CSV: 2 cc2 maps to deactivate');
    ok(lines.some((l) => l.startsWith('account,') && l.includes('610307') && l.includes('period_debit')), '610307 proposed on period_debit');
    ok(lines.some((l) => l.startsWith('account,') && l.includes('610303') && l.includes('ending_balance')), '610303 keeps ending_balance');
    let refused = null;
    try { execFileSync(process.execPath, [script, '--db', copy, '--apply'], { stdio: 'pipe' }); } catch (e) { refused = e; }
    ok(refused && refused.status === 2, 'apply without --i-have-approval refused');
    execFileSync(process.execPath, [script, '--db', copy, '--period', PERIOD, '--split', splitArg, '--apply', '--i-have-approval', '--out', path.join(dir, 'ap.csv')], { stdio: 'pipe' });
    const c2 = new Database(copy, { readonly: true });
    const act = c2.prepare("SELECT cost_center_id, account_code, absorb_pct FROM cost_center_account_maps WHERE active=1 AND account_code LIKE '61030%'").all();
    ok(act.length === 6 && act.every((r) => [Number(cc1), Number(cc8)].includes(Number(r.cost_center_id)) && Number(r.absorb_pct) === 50),
      'apply: only cc1/cc8 50% maps active', act);
    ok(!!c2.prepare("SELECT 1 FROM audit_log WHERE entity='oh_actual_split' AND detail LIKE '%oh-split-maps-dryrun%'").get(), 'apply audited');
    ok(JSON.parse(c2.prepare("SELECT value FROM settings WHERE key='oh_actual_split'").get().value)[cc1] === 50, 'apply saved split setting');
    c2.close();
  }

  server.close();
  try { closeSessionStore && closeSessionStore(); } catch { /* optional */ }
  try { closeDB(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\nOH split cc1/cc8: ✅ ${pass} · ❌ ${fail}`);
  if (failures.length) failures.forEach((f) => console.log('  • ' + f));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
