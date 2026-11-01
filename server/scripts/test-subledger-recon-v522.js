/**
 * v522 — recon follow-ups:
 *  - nightly run (central cron tick): time gate, once-per-day dedupe, bell notification
 *  - zero tolerance: toman↔rial rounding classified «rounding», a real 1-rial gap is «warn»
 *  - fixed assets without acquisition voucher: one-off opening voucher fix, per-asset release, R13 reverse
 *  - rep expense/advance void: statement shows voided rows, balances unchanged
 *  - canDo: code defaults, role overrides, per-user grants/denials; route 403s
 * Run: node server/scripts/test-subledger-recon-v522.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subledger-recon-v522-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-subledger-recon-v522-secret-32chars!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra != null ? JSON.stringify(extra) : ''); }
}

const authMw = require('../middleware/auth');
const ADMIN = db.prepare("SELECT id, role, name FROM users WHERE role='admin' ORDER BY id LIMIT 1").get()
  || { id: 1, role: 'admin', name: 'admin' };
let CURRENT = { id: ADMIN.id, role: 'admin', name: ADMIN.name };
authMw.auth = (req, _res, next) => { req.user = { ...CURRENT }; next(); };

const recon = require('../lib/subledger-recon');
recon.ensureReconSchema(db);
try { require('../lib/inventory/valuation').ensureValuationSchema(db); } catch (_) { /* optional module */ }
const rbac = require('../lib/rbac');
const { acct } = require('../lib/coa-map');
const { todayJalali } = require('../jalali');
const { buildRepStatement } = require('../lib/rep-ledger');

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/accounting/subledger-recon', require('../routes/subledger-recon'));
app.use('/api/fixed-assets', require('../routes/fixed-assets'));
app.use('/api/reps', require('../routes/rep-management'));
app.use('/api/rbac', require('../routes/rbac'));

const today = todayJalali();

function liveJe(id) {
  const r = db.prepare('SELECT * FROM journal_entries WHERE id=?').get(id);
  return !!r && !Number(r.deleted_at || 0) && !['reversed', 'void'].includes(String(r.status || ''));
}

/** Raw JE so toman and rial columns can disagree (legacy rounding). */
function insertRawJe(refType, refId, lines) {
  const id = Number(db.prepare(`
    INSERT INTO journal_entries (entry_date, description, ref_type, ref_id, created_by, status)
    VALUES (?, 'test v522', ?, ?, ?, 'approved')
  `).run(today, refType, refId, ADMIN.id).lastInsertRowid);
  let n = 1;
  for (const l of lines) {
    db.prepare(`
      INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial, line_no)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(id, l.code, l.code, l.debit || 0, l.credit || 0, l.debit_rial || 0, l.credit_rial || 0, n++);
  }
  return id;
}

function newUser(username, role) {
  return Number(db.prepare("INSERT INTO users (name, username, password, role, active) VALUES (?, ?, 'x', ?, 1)")
    .run(username, username, role).lastInsertRowid);
}

async function main() {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch (_) { json = null; }
    return { status: res.status, body: json };
  };
  const asAdmin = () => { CURRENT = { id: ADMIN.id, role: 'admin', name: ADMIN.name }; };

  try {
    // ── 1. nightly ──
    console.log('\n[nightly]');
    const s0 = recon.nightlySettings(db);
    ok(s0.enabled === true && s0.time === '02:00' && s0.last_date === null, 'defaults: enabled 02:00, never ran', s0);
    const early = new Date(); early.setHours(1, 30, 0, 0);
    const late = new Date(); late.setHours(3, 5, 0, 0);
    const r0 = recon.maybeRunNightlyRecon(db, { now: early });
    ok(r0.ran === false && r0.reason === 'not_yet', 'before configured time → not_yet', r0);
    const nBefore = db.prepare("SELECT COUNT(*) c FROM app_notifications WHERE kind='subledger_recon_nightly'").get().c;
    const r1 = recon.maybeRunNightlyRecon(db, { now: late });
    ok(r1.ran === true && r1.run_id && r1.summary && 'rounding' in r1.summary, 'after time → runs and persists', r1);
    const notif = db.prepare("SELECT * FROM app_notifications WHERE kind='subledger_recon_nightly' ORDER BY id DESC LIMIT 1").get();
    ok(db.prepare("SELECT COUNT(*) c FROM app_notifications WHERE kind='subledger_recon_nightly'").get().c === nBefore + 1,
      'one bell notification');
    ok(notif && notif.entity_type === 'subledger_recon_run' && Number(notif.entity_id) === Number(r1.run_id)
      && notif.title.includes(r1.date) && /سالم \d+ · هشدار \d+ · خطا \d+ · گرد کردن \d+/.test(notif.body), 'notification title/body', notif);
    const roles = notif ? JSON.parse(notif.target_roles || '[]') : [];
    ok(roles.includes('admin') && roles.includes('accounting'), 'targets admin + accounting', roles);
    const r2 = recon.maybeRunNightlyRecon(db, { now: late });
    ok(r2.ran === false && r2.reason === 'already_ran', 'same day → deduped', r2);
    ok(db.prepare("SELECT COUNT(*) c FROM app_notifications WHERE kind='subledger_recon_nightly'").get().c === nBefore + 1, 'no second notification');
    const s1 = recon.nightlySettings(db);
    ok(s1.last_date === r1.date && Number(s1.last_run_id) === Number(r1.run_id), 'last date/run stored', s1);
    const bad = await call('PUT', '/api/accounting/subledger-recon/nightly', { time: '25:00' });
    ok(bad.status === 400 && bad.body.code === 'E_RECON_NIGHTLY_TIME', 'invalid time → 400', bad.body);
    const put = await call('PUT', '/api/accounting/subledger-recon/nightly', { enabled: false, time: '04:15' });
    ok(put.status === 200 && put.body.enabled === false && put.body.time === '04:15', 'PUT /nightly saves', put.body);
    const r3 = recon.maybeRunNightlyRecon(db, { now: late });
    ok(r3.ran === false && r3.reason === 'disabled', 'disabled → skipped', r3);
    const get = await call('GET', '/api/accounting/subledger-recon/nightly');
    ok(get.status === 200 && get.body.time === '04:15' && get.body.enabled === false, 'GET /nightly', get.body);
    const runNow = await call('POST', '/api/accounting/subledger-recon/nightly/run', {});
    ok(runNow.status === 200 && runNow.body.run_id, 'POST /nightly/run runs on demand', runNow.body);
    await call('PUT', '/api/accounting/subledger-recon/nightly', { enabled: true, time: '02:00' });

    // ── 2. rounding vs real ──
    console.log('\n[rounding]');
    ok(recon.classifyDiff(0, 0) === 'ok' && recon.classifyDiff(1, 0) === 'real', 'no bound → 1 rial is real');
    ok(recon.classifyDiff(5, 5) === 'rounding' && recon.classifyDiff(-5, 5) === 'rounding' && recon.classifyDiff(6, 5) === 'real', 'within bound → rounding, beyond → real');
    const adj = acct(db, 'coa_adjustment');
    const cash = acct(db, 'coa_cash_default');
    // Dr 12,345 rial stored as 1,234 toman (residue 5); Cr 12,340 rial = 1,234 toman → balance 5 rial.
    insertRawJe('manual_round_test', 1, [
      { code: adj.code, debit: 1234, debit_rial: 12345 },
      { code: adj.code, credit: 1234, credit_rial: 12340 },
    ]);
    const bound = recon.glRoundingBound(db, [adj.code], '');
    ok(bound === 5, 'rounding bound = 5 rial from the toman/rial disagreement', bound);
    let sus = recon.runRecon(db, { checks: ['suspense_accounts'], persist: false }).checks[0];
    const susRow = sus.sample && sus.sample.find((r) => r.account_code === adj.code);
    ok(sus.status === 'rounding' && susRow && susRow.diff_class === 'rounding' && susRow.balance_rial === 5,
      'suspense 5 rial → «rounding» status', sus);
    ok(sus.rounding_rial === 5, 'rounding amount reported separately', sus.rounding_rial);
    const sumRun = recon.runRecon(db, { persist: false });
    ok(sumRun.summary.rounding >= 1, 'summary counts rounding separately', sumRun.summary);
    // A real 1-rial difference on top (clean columns) — exceeds the bound.
    insertRawJe('manual_real_test', 1, [
      { code: adj.code, debit: 0.1, debit_rial: 1 },
      { code: cash.code, credit: 0.1, credit_rial: 1 },
    ]);
    sus = recon.runRecon(db, { checks: ['suspense_accounts'], persist: false }).checks[0];
    ok(sus.status === 'warn', 'real 1 rial beyond bound → warn', sus);

    // ── 3. fixed-asset opening fix ──
    console.log('\n[fixed-asset opening]');
    const freshCandidates = recon.fixedAssetOpeningCandidates(db).length;
    console.log(`   · fresh DB qualifying assets: ${freshCandidates}`);
    ok(freshCandidates === 0, 'fresh DB: no qualifying assets', freshCandidates);
    const a1 = await call('POST', '/api/fixed-assets', { name: 'میز برش قدیمی', cost_rial: 5000000, purchase_date: '1400/01/01', funding: 'none' });
    const a2 = await call('POST', '/api/fixed-assets', { name: 'کمپرسور قدیمی', cost_rial: 3000000, purchase_date: '1401/01/01', funding: 'none' });
    ok(a1.status === 200 && a2.status === 200 && !a1.body.acq_je_id && !a2.body.acq_je_id, 'legacy assets without voucher', [a1.body, a2.body]);
    let faCheck = recon.runRecon(db, { checks: ['fixed_assets'], persist: false }).checks[0];
    ok(faCheck.fixable === true && faCheck.status !== 'ok', 'R9 flags legacy assets as fixable', faCheck);
    const dry = await call('POST', '/api/accounting/subledger-recon/fixed_assets/fix', {});
    ok(dry.status === 200 && dry.body.dry_run === true && dry.body.plan.length === 2
      && dry.body.summary.total_rial === 8000000 && dry.body.summary.assets === 2, 'dry run: 2 assets, 8,000,000 rial', dry.body);
    const opening = acct(db, 'coa_opening_balance');
    ok(dry.body.summary.credit_account === opening.code && /^\d{4}\/\d{2}\/01$/.test(dry.body.summary.date), 'dry run: Cr opening, first-of-year date', dry.body.summary);
    const noConfirm = await call('POST', '/api/accounting/subledger-recon/fixed_assets/fix', { dry_run: false });
    ok(noConfirm.status === 400 && noConfirm.body.code === 'E_RECON_CONFIRM_REQUIRED', 'apply requires confirm + reason', noConfirm.body);
    const applied = await call('POST', '/api/accounting/subledger-recon/fixed_assets/fix', { dry_run: false, confirm: true, reason: 'افتتاحیه دارایی‌های قدیمی' });
    ok(applied.status === 200 && applied.body.applied.length === 1 && applied.body.applied[0].je_id, 'apply posts one combined JE', applied.body);
    const fixJeId = applied.body.applied && applied.body.applied[0].je_id;
    const fixId = applied.body.applied && applied.body.applied[0].fix_id;
    const je = db.prepare('SELECT * FROM journal_entries WHERE id=?').get(fixJeId);
    ok(je && je.ref_type === 'fixed_asset_opening_recon' && Number(je.ref_id) === Number(fixId) && je.entry_date === dry.body.summary.date,
      'JE ref fixed_asset_opening_recon/fix id, dated fiscal-year start', je);
    const jl = db.prepare('SELECT account_code, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?').all(fixJeId);
    ok(jl.filter((l) => Number(l.debit_rial) > 0).length === 2
      && jl.some((l) => l.account_code === opening.code && Number(l.credit_rial) === 8000000), 'Dr per asset / Cr opening 8,000,000 (cost only)', jl);
    const rows = db.prepare('SELECT id, acq_je_id, acq_funding FROM fixed_assets WHERE id IN (?,?)').all(a1.body.id, a2.body.id);
    ok(rows.every((r) => Number(r.acq_je_id) === Number(fixJeId) && r.acq_funding === 'opening'), 'assets linked (acq_je_id + opening)', rows);
    const fixRow = db.prepare('SELECT * FROM subledger_recon_fixes WHERE id=?').get(fixId);
    ok(fixRow && fixRow.code === 'fixed_assets' && Number(fixRow.je_id) === Number(fixJeId), 'subledger_recon_fixes row', fixRow);
    faCheck = recon.runRecon(db, { checks: ['fixed_assets'], persist: false }).checks[0];
    ok(faCheck.status === 'ok' && !faCheck.fixable, 'R9 ok after opening voucher', faCheck);
    ok(recon.checkRows(db, 'je_on_dead_document', {}).rows.every((r) => r.ref_type !== 'fixed_asset_opening_recon'), 'R4 treats live fix JE as alive');

    // deactivate one asset → per-asset release JE; combined voucher stays live
    const del = await call('DELETE', `/api/fixed-assets/${a2.body.id}`);
    ok(del.status === 200 && del.body.opening_release_je_id && liveJe(fixJeId), 'deactivate posts release JE, combined JE stays', del.body);
    const relLines = del.body.opening_release_je_id
      ? db.prepare('SELECT account_code, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?').all(del.body.opening_release_je_id) : [];
    ok(relLines.some((l) => l.account_code === opening.code && Number(l.debit_rial) === 3000000), 'release: Dr opening 3,000,000', relLines);
    faCheck = recon.runRecon(db, { checks: ['fixed_assets'], persist: false }).checks[0];
    ok(faCheck.status === 'ok', 'R9 ok after deactivating one asset', faCheck);

    // reverse the fix → voucher + release voided, links restored
    const rev = await call('POST', `/api/accounting/subledger-recon/fixes/${fixId}/reverse`, { reason: 'تست ابطال افتتاحیه', confirm: true });
    ok(rev.status === 200 && rev.body.fix.status === 'reversed', 'fix reversed', rev.body);
    ok(!liveJe(fixJeId) && !liveJe(del.body.opening_release_je_id), 'combined + release JEs voided');
    const after = db.prepare('SELECT id, acq_je_id, acq_funding, acq_release_je_id FROM fixed_assets WHERE id IN (?,?)').all(a1.body.id, a2.body.id);
    ok(after.every((r) => !r.acq_je_id && !r.acq_release_je_id), 'asset links cleared', after);
    ok(recon.fixedAssetOpeningCandidates(db).map((a) => a.id).join() === String(a1.body.id), 'active legacy asset is a candidate again');
    ok(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='recon_fix' AND entity_id=?").get(fixId).c >= 1, 'fix audited');

    // GL already carries the cost → refuse unless force
    const { postToLedger } = require('../lib/ledger');
    const { rialToLedger } = require('../lib/money');
    const faAcct = acct(db, 'coa_fixed_assets');
    postToLedger(db, {
      sourceType: 'manual_fa_test', sourceId: 1, date: today, description: 'سند دستی دارایی', createdBy: ADMIN.id,
      lines: [
        { code: faAcct.code, name: faAcct.name, debit: rialToLedger(5000000), credit: 0 },
        { code: opening.code, name: opening.name, debit: 0, credit: rialToLedger(5000000) },
      ],
    });
    const covered = await call('POST', '/api/accounting/subledger-recon/fixed_assets/fix', { dry_run: false, confirm: true, reason: 'دوباره' });
    ok(covered.status === 409 && covered.body.code === 'E_RECON_FA_GL_COVERED' && covered.body.gl_shortfall_rial === 0, 'GL already covers → 409', covered.body);

    // ── 4. rep void + statement ──
    console.log('\n[rep void]');
    const repId = newUser('rep_v522', 'field_sales');
    const bal0 = buildRepStatement(db, repId).closing;
    const adv = await call('POST', `/api/reps/${repId}/advances`, { amount: 400000, pay_type: 'cash', note: 'مساعده تست' });
    ok(adv.status === 200 && adv.body.id, 'advance created', adv.body);
    ok(buildRepStatement(db, repId).closing === bal0 - 400000, 'advance reduces balance');
    const advVoid = await call('POST', `/api/reps/${repId}/advances/${adv.body.id}/void`, { reason: 'ثبت اشتباه' });
    ok(advVoid.status === 200, 'advance voided', advVoid.body);
    let st = buildRepStatement(db, repId);
    const vAdv = st.entries.find((e) => e.type === 'advance_voided' && e.reference === `#${adv.body.id}`);
    ok(vAdv && vAdv.voided === true && vAdv.debit === 0 && vAdv.credit === 0 && vAdv.original_amount === 400000, 'statement: advance shown as voided, zero amount', vAdv);
    ok(!st.entries.some((e) => e.type === 'advance' && e.reference === `#${adv.body.id}`), 'statement: no live advance row');
    ok(st.closing === bal0 && st.advancesRemaining === 0, 'balance restored after advance void', { closing: st.closing, bal0 });
    const expId = Number(db.prepare(`
      INSERT INTO rep_expenses (rep_id, date, category, amount, description, status) VALUES (?, ?, 'fuel', 150000, 'سوخت', 'pending')
    `).run(repId, today).lastInsertRowid);
    await call('POST', `/api/reps/expenses/${expId}/approve`, { pay_type: 'cash' });
    ok(buildRepStatement(db, repId).closing === bal0 - 150000, 'approved expense reduces balance');

    // delegated user without the grant cannot void
    const delegated = newUser('deleg_v522', 'field_sales');
    CURRENT = { id: delegated, role: 'field_sales', name: 'deleg' };
    const denied = await call('POST', `/api/reps/expenses/${expId}/void`, { reason: 'x' });
    ok(denied.status === 403 && denied.body.code === 'E_PERMISSION', 'rep void without acc_reps.delete → 403', denied.body);
    asAdmin();
    const expVoid = await call('POST', `/api/reps/expenses/${expId}/void`, { reason: 'تکراری' });
    ok(expVoid.status === 200, 'expense voided', expVoid.body);
    st = buildRepStatement(db, repId);
    const vExp = st.entries.find((e) => e.type === 'expense_voided' && e.reference === `#${expId}`);
    ok(vExp && vExp.voided && vExp.debit === 0 && vExp.original_amount === 150000, 'statement: expense shown as voided', vExp);
    ok(st.closing === bal0, 'balance restored after expense void', { closing: st.closing, bal0 });
    ok(!st.entries.some((e) => ['rep_expense', 'rep_advance'].includes(e.type)), 'netted rep_ledger pairs hidden');

    // ── 5. canDo ──
    console.log('\n[canDo]');
    const accUser = { id: newUser('acc_v522', 'accounting'), role: 'accounting' };
    const dUser = { id: delegated, role: 'field_sales' };
    const admin = { id: ADMIN.id, role: 'admin' };
    ok(['view', 'create', 'approve', 'edit', 'delete'].every((a) => rbac.canDo(admin, 'acc_inv_valuation', a, db))
      && rbac.canDo(admin, 'acc_inv_period_lock', 'approve', db), 'admin: everything');
    ok(['view', 'create', 'approve', 'delete'].every((a) => rbac.canDo(accUser, 'acc_inv_valuation', a, db)), 'accounting: valuation view/create/approve/delete');
    ok(!rbac.canDo(accUser, 'acc_inv_valuation', 'edit', db), 'accounting: no policy edit by default');
    ok(!rbac.canDo(accUser, 'acc_inv_period_lock', 'approve', db), 'accounting: no period lock by default');
    ok(rbac.canDo(accUser, 'acc_subledger_recon', 'edit', db) && rbac.canDo(accUser, 'acc_subledger_recon', 'delete', db), 'accounting: recon fix + reverse');
    ok(rbac.canDo(accUser, 'acc-subledger-recon', 'edit', db), 'menu id accepted');
    ok(rbac.canDo(accUser, 'acc_reps', 'delete', db), 'accounting: rep void');
    ok(!rbac.canDo(dUser, 'acc_subledger_recon', 'edit', db) && !rbac.canDo(dUser, 'acc_inv_valuation', 'create', db), 'delegated: nothing by default');

    CURRENT = { id: delegated, role: 'field_sales', name: 'deleg' };
    const d403 = await call('POST', '/api/accounting/subledger-recon/fixed_assets/fix', {});
    ok(d403.status === 403 && d403.body.code === 'E_PERMISSION', 'delegated without grant: fix → 403', d403.body);
    const grant = db.prepare('INSERT OR REPLACE INTO user_permissions (user_id, resource, action, allowed) VALUES (?,?,?,?)');
    grant.run(delegated, 'acc_subledger_recon', 'edit', 1);
    ok(rbac.canDo(dUser, 'acc_subledger_recon', 'edit', db) && !rbac.canDo(dUser, 'acc_subledger_recon', 'delete', db), 'delegated with edit grant: edit only');
    const d200 = await call('POST', '/api/accounting/subledger-recon/fixed_assets/fix', {});
    ok(d200.status === 200 && d200.body.dry_run === true, 'delegated with grant: fix dry run allowed', d200.body);
    const dRev = await call('POST', `/api/accounting/subledger-recon/fixes/${fixId}/reverse`, { reason: 'تست مجوز ابطال', confirm: true });
    ok(dRev.status === 403, 'delegated without delete: reverse → 403', dRev.body);
    asAdmin();

    rbac.saveRoleOverrides(db, { accounting: { acc_inv_valuation: { edit: true } }, admin: { acc_inv_valuation: { view: false } } });
    ok(rbac.canDo(accUser, 'acc_inv_valuation', 'edit', db), 'role override grants accounting policy edit');
    ok(rbac.canDo(admin, 'acc_inv_valuation', 'view', db), 'admin override ignored');
    grant.run(accUser.id, 'acc_inv_valuation', 'edit', 0);
    ok(!rbac.canDo(accUser, 'acc_inv_valuation', 'edit', db), 'per-user denial beats role override');

    const rd = await call('GET', '/api/rbac/role-defaults/accounting');
    ok(rd.status === 200 && rd.body.permissions.acc_inv_valuation.edit === true && rd.body.code_defaults.acc_inv_valuation.edit === false,
      'GET role-defaults: effective vs code defaults', rd.body && rd.body.permissions && rd.body.permissions.acc_inv_valuation);
    const perms = rd.body.permissions;
    perms.acc_inv_period_lock.approve = true;
    perms.acc_inv_valuation.edit = false;
    const rdPut = await call('PUT', '/api/rbac/role-defaults/accounting', { permissions: perms });
    ok(rdPut.status === 200, 'PUT role-defaults', rdPut.body);
    const stored = rbac.getRoleOverrides(db).accounting || {};
    ok(stored.acc_inv_period_lock && stored.acc_inv_period_lock.approve === true && !(stored.acc_inv_valuation && 'edit' in stored.acc_inv_valuation),
      'only the diff from code defaults is stored', stored);
    ok(rbac.canDo({ id: newUser('acc2_v522', 'accounting'), role: 'accounting' }, 'acc_inv_period_lock', 'approve', db), 'new accounting user inherits role default');
    const rdAdmin = await call('PUT', '/api/rbac/role-defaults/admin', { permissions: {} });
    ok(rdAdmin.status === 400, 'admin role defaults not editable', rdAdmin.body);
    CURRENT = { id: accUser.id, role: 'accounting', name: 'acc' };
    const rdAcc = await call('PUT', '/api/rbac/role-defaults/accounting', { permissions: perms });
    ok(rdAcc.status === 403, 'non-admin cannot edit role defaults', rdAcc.status);
    asAdmin();
  } catch (e) {
    fail++;
    console.log(' FAIL unexpected exception', e && e.stack);
  } finally {
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
