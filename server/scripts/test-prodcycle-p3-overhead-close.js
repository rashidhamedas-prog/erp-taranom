'use strict';
/**
 * P3 — سربار و بستن دورهٔ تولید:
 *  (a) یکتایی جذب ثبت‌شده (cc1+cc8 در یک مرحله مجاز)
 *  (b) محرک درصدی برای مبنای ریالی (۲۰٪) + ویرایش نرخ فقط مدیر/حسابداری با audit
 *  (c) precheck: 5202=0 و 5203≠0 ⇒ fail + اجرای واقعی جذب معین‌ها و ابطال کامل
 *  (d) PRD-23 مانده‌های 5213/5214 را هم صفر می‌کند
 *  (e) producedInPeriod فقط FG
 * Run: node server/scripts/test-prodcycle-p3-overhead-close.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prodcycle-p3-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-prodcycle-p3-overhead-close-secret-32b!';
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
  ok(Math.abs(Number(actual) - Number(expected)) <= 1, label, { actual, expected });
}

const PERIOD = '1405/07';
const D = '1405/07/10';

(async () => {
  const oh = require('../lib/production/overhead');
  const { acct, resolvePostableLeaf } = require('../lib/coa-map');
  const { postToLedger } = require('../lib/ledger');
  const close = require('../lib/production/close');
  const absorb = require('../lib/production/cc-account-absorb');
  const { buildAllocationLines } = require('../lib/production/posting');

  const leaf = (code) => {
    try { return resolvePostableLeaf(db, code, { create: true })?.code || code; } catch { return code; }
  };
  const bal = (key) => close.accountBalance(db, key, `${PERIOD}/31`);
  const postJe = (lines, ref = 'manual_test') => postToLedger(db, {
    sourceType: ref, sourceId: 1, date: D, description: 'P3 test', createdBy: 1,
    voucherType: 'auto', status: 'approved',
    lines: lines.map((l) => ({ code: l.code, name: l.code, debit: (l.dr || 0) / 10, credit: (l.cr || 0) / 10 })),
  });

  // ── fixtures ──────────────────────────────────────────────
  const mkCc = (code, name) => db.prepare(`
    INSERT INTO cost_centers (code, name, entity, active, is_stage, seq, driver)
    VALUES (?,?, 'workshop', 1, 1, 900, 'output_qty')
  `).run(code, name).lastInsertRowid;
  const cc1 = mkCc('P3-CC1', 'کارگاه');
  const cc8 = mkCc('P3-CC8', 'اتو و بسته‌بندی');
  const cc2 = db.prepare(`
    INSERT INTO cost_centers (code, name, entity, active, is_stage, seq, driver)
    VALUES ('P3-CC2', 'دفتر توزیع', 'office', 1, 0, 950, 'output_qty')
  `).run().lastInsertRowid;
  for (const cc of [cc1, cc8]) {
    db.prepare(`
      INSERT INTO cost_center_rates (cost_center_id, period_label, driver, total_rate_rial, fixed_rate_rial,
        var_rate_rial, absorb_pct, status, budget_fixed_oh_rial)
      VALUES (?,?, 'output_qty', 1000, 1000, 0, 100, 'active', 0)
    `).run(cc, PERIOD);
  }
  const fg = db.prepare(`INSERT INTO products (name, stock, average_cost_rial, item_type, user_id) VALUES ('مانتو P3', 10, 100000, 'finished', 1)`).run().lastInsertRowid;
  const raw = db.prepare(`INSERT INTO products (name, stock, average_cost_rial, item_type, user_id) VALUES ('پارچه P3', 50, 5000, 'raw', 1)`).run().lastInsertRowid;
  const poId = db.prepare(`
    INSERT INTO production_orders (order_no, product_id, analysis_type, qty_planned, cost_center_id,
      status, date, period_label, manual_driver_qty)
    VALUES ('PO-P3', ?, 'fixed', 10, ?, 'released', ?, ?, 0)
  `).run(fg, cc1, D, PERIOD).lastInsertRowid;
  const po = db.prepare('SELECT * FROM production_orders WHERE id=?').get(poId);

  console.log('\n(a) یکتایی جذب سربار');
  const ins = (cc, stage, status = 'posted') => db.prepare(`
    INSERT INTO production_overhead_applications
      (doc_no, order_id, stage_id, cost_center_id, driver, driver_qty, rate_rial, amount_rial, date, period_label, status)
    VALUES ('T', ?, ?, ?, 'output_qty', 1, 1, 1, ?, ?, ?)
  `).run(poId, stage, cc, D, PERIOD, status);
  const idx = db.prepare("SELECT sql FROM sqlite_master WHERE name='ux_oh_posted_stage_driver_cc'").get();
  ok(!!idx && /WHERE status='posted'/i.test(idx.sql), 'partial UNIQUE index exists');
  ins(cc1, 7001);
  let dupErr = null;
  try { ins(cc1, 7001); } catch (e) { dupErr = e; }
  ok(dupErr && /UNIQUE/i.test(dupErr.message), 'duplicate posted (order,stage,driver,cc) rejected by index');
  let ccPairErr = null;
  try { ins(cc8, 7001); } catch (e) { ccPairErr = e; }
  ok(!ccPairErr, 'cc1 + cc8 on same stage both allowed (owner decision)');
  db.prepare("UPDATE production_overhead_applications SET status='reversed' WHERE stage_id=7001 AND cost_center_id=?").run(cc1);
  let repostErr = null;
  try { ins(cc1, 7001); } catch (e) { repostErr = e; }
  ok(!repostErr, 'reversed + reposted allowed');
  let legacyErr = null;
  try { ins(cc1, null); ins(cc1, null); } catch (e) { legacyErr = e; }
  ok(!legacyErr, 'legacy rows without stage (partial receipts) not blocked');

  const a1 = oh.applyOverhead(db, { po, qtyStarted: 10, laborRial: 0, matRial: 0, date: D, period: PERIOD, userId: 1, stageId: 8001 });
  const a2 = oh.applyOverhead(db, { po, qtyStarted: 10, laborRial: 0, matRial: 0, date: D, period: PERIOD, userId: 1, stageId: 8001 });
  eq(a1.amount_rial, 10000, 'applyOverhead first = 1000×10');
  ok(a2.existing === true && a2.amount_rial === 0 && a2.id === a1.id, 'applyOverhead repeat returns existing (no new absorb)', a2);
  eq(db.prepare("SELECT COUNT(*) c FROM production_overhead_applications WHERE stage_id=8001 AND status='posted'").get().c, 1, 'only one posted row for stage 8001');

  const poCc2 = { ...po, cost_center_id: cc2 };
  const p1 = oh.postPlantOverhead(db, { po: poCc2, stageId: 8002, qty: 5, laborRial: 0, matRial: 0, date: D, period: PERIOD, userId: 1, skipCcIds: [] });
  const p2 = oh.postPlantOverhead(db, { po: poCc2, stageId: 8002, qty: 5, laborRial: 0, matRial: 0, date: D, period: PERIOD, userId: 1, skipCcIds: [] });
  const p1cc = p1.lines.map((l) => Number(l.cost_center_id));
  ok(p1cc.includes(Number(cc1)) && p1cc.includes(Number(cc8)), 'plant OH posts cc1 and cc8 for same stage', p1cc);
  ok(p2.lines.length === 0 && p2.amount_rial === 0 && p2.skipped.length >= 2, 'plant OH repeat is idempotent', p2);

  console.log('\n(b) محرک درصدی برای مبنای ریالی');
  eq(oh.appliedOverheadRial({ rate_pct: 20, driver: 'direct_labor_rial', total_rate_rial: 0 }, 5_000_000 / 1e6, 'direct_labor_rial'), 1_000_000, '20% of 5,000,000 labor = 1,000,000');
  eq(oh.appliedOverheadRial({ rate_pct: 20, driver: 'material_rial', absorb_pct: 50 }, 3_000_000 / 1e6), 300_000, '20% × absorb 50% of 3M material');
  eq(oh.appliedOverheadRial({ rate_pct: 20, driver: 'direct_labor_rial', total_rate_rial: 200000 }, 4, 'output_qty'), 800_000, 'output_qty override keeps rial-per-unit');
  eq(oh.appliedOverheadRial({ total_rate_rial: 200000, driver: 'direct_labor_rial' }, 5), 1_000_000, 'legacy 200,000/million still = 20%');

  const ccPct = mkCc('P3-PCT', 'دوخت درصدی');
  db.prepare(`
    INSERT INTO cost_center_rates (cost_center_id, period_label, driver, total_rate_rial, fixed_rate_rial, var_rate_rial, status)
    VALUES (?, '1405/06', 'direct_labor_rial', 200000, 200000, 0, 'active')
  `).run(ccPct);
  require('../lib/production/schema').initProductionSchema(db);
  eq(db.prepare("SELECT rate_pct FROM cost_center_rates WHERE cost_center_id=? AND period_label='1405/06'").get(ccPct).rate_pct, 20, 'migration: 200000 rial/million → rate_pct 20');
  const outQtyPct = db.prepare('SELECT rate_pct FROM cost_center_rates WHERE cost_center_id=? AND period_label=?').get(cc1, PERIOD).rate_pct;
  ok(outQtyPct == null, 'migration leaves output_qty rates without percent');

  // ── HTTP ──
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const pmId = db.prepare(`
    INSERT INTO users (username, password, name, role, active, must_change_password)
    VALUES ('p3_pm', 'x', 'مدیر تولید P3', 'production_manager', 1, 0)
  `).run().lastInsertRowid;
  for (const action of ['view', 'edit']) {
    db.prepare('INSERT OR REPLACE INTO user_permissions (user_id, resource, action, allowed) VALUES (?,?,?,1)').run(pmId, 'production_cost', action);
  }
  const pm = db.prepare('SELECT * FROM users WHERE id=?').get(pmId);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const tok = (u, fp) => issueStaffSession(db, u, { device_kind: 'test', device_name: fp, device_fingerprint: fp }).token;
  const adminTok = tok(admin, 'p3-admin');
  const pmTok = tok(pm, 'p3-pm');

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
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  const created = await api(adminTok, 'POST', '/api/production/cost-centers/rates', {
    cost_center_id: ccPct, period_label: PERIOD, driver: 'direct_labor_rial', rate_pct: 25,
  });
  ok(created.status === 201 && Number(created.data.rate_pct) === 25 && Number(created.data.total_rate_rial) === 250000,
    'admin POST rate_pct 25 → total 250000/million', created.data);
  const auditRow = db.prepare("SELECT * FROM audit_log WHERE entity='cost_center_rate' AND entity_id=? ORDER BY id DESC LIMIT 1").get(created.data.id);
  ok(auditRow && /"rate_pct":25/.test(auditRow.detail), 'rate create audited with after.rate_pct', auditRow);

  const upd = await api(adminTok, 'PUT', `/api/production/cost-centers/rates/${created.data.id}`, { rate_pct: 18 });
  ok(upd.status === 200 && Number(upd.data.rate_pct) === 18 && Number(upd.data.total_rate_rial) === 180000, 'admin PUT rate_pct 18', upd.data);
  const auditUpd = db.prepare("SELECT * FROM audit_log WHERE entity='cost_center_rate' AND entity_id=? AND action='update' ORDER BY id DESC LIMIT 1").get(created.data.id);
  ok(auditUpd && /"before":\{[^}]*"rate_pct":25/.test(auditUpd.detail) && /"after":\{[^}]*"rate_pct":18/.test(auditUpd.detail), 'rate edit audited before/after', auditUpd && auditUpd.detail);

  const ccDef = mkCc('P3-DEF', 'مرکز پیش‌فرض');
  const def = await api(adminTok, 'POST', '/api/production/cost-centers/rates', {
    cost_center_id: ccDef, period_label: PERIOD, driver: 'material_rial',
  });
  ok(def.status === 201 && Number(def.data.rate_pct) === 20 && Number(def.data.total_rate_rial) === 200000, 'new rial rate defaults to 20%', def.data);

  const denied = await api(pmTok, 'PUT', `/api/production/cost-centers/rates/${created.data.id}`, { rate_pct: 50 });
  ok(denied.status === 403 && denied.data.code === 'E_FORBIDDEN', 'production_manager (even with grant) cannot edit rates', denied);
  const deniedPost = await api(pmTok, 'POST', '/api/production/cost-centers/rates', { cost_center_id: ccDef, period_label: '1405/08', driver: 'material_rial', rate_pct: 30 });
  ok(deniedPost.status === 403, 'production_manager cannot create rates', deniedPost.status);
  eq(db.prepare('SELECT rate_pct FROM cost_center_rates WHERE id=?').get(created.data.id).rate_pct, 18, 'denied edit left rate unchanged');

  console.log('\n(c) precheck + جذب واقعی معین‌ها');
  db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES ('610301','سربار تولید — اجاره کارگاه','expense','6103',3,1)").run();
  db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES ('610302','سربار تولید — برق کارگاه','expense','6103',3,1)").run();
  const cash = leaf('1101');
  const wip = acct(db, 'coa_wip').code;
  const c5203 = acct(db, 'coa_overhead_applied').code;
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_close_payroll_posted','1')").run();

  postJe([{ code: wip, dr: 10_000_000 }, { code: c5203, cr: 10_000_000 }], 'production_overhead');
  postJe([{ code: '610301', dr: 6_000_000 }, { code: '610302', dr: 2_000_000 }, { code: cash, cr: 8_000_000 }]);
  ok(bal('coa_overhead_control') === 0 && bal('coa_overhead_applied') === -10_000_000, 'fixture: 5202=0, 5203=-10M');
  let pre = close.precheck(db, { period: PERIOD });
  let chk = pre.checks.find((c) => c.code === 'OH_ACTUAL_ON_CONTROL');
  ok(chk && chk.status === 'fail' && pre.can_close === false, 'precheck fails when 5202=0 & 5203≠0', chk);
  ok(chk && /جذب/.test(chk.message), 'precheck message suggests running cc-account-absorb', chk && chk.message);

  absorb.replaceMaps(db, cc1, [
    { account_code: '610301', absorb_pct: 100, base_type: 'period_debit' },
    { account_code: '610302', absorb_pct: 50, base_type: 'period_debit' },
  ], 1);

  const deniedRun = await api(pmTok, 'POST', '/api/production/cost-centers/absorb-postings/run', { cost_center_id: cc1, period_label: PERIOD });
  ok(deniedRun.status === 403, 'absorb run restricted to admin/accounting', deniedRun.status);

  const run = await api(adminTok, 'POST', '/api/production/cost-centers/absorb-postings/run', { cost_center_id: cc1, period_label: PERIOD });
  ok(run.status === 200 && run.data.total_rial === 7_000_000 && run.data.je_id, 'absorb run posts 6M + 50%×2M = 7M', run.data);
  eq(bal('coa_overhead_control'), 7_000_000, '5202 debited 7M');
  eq(close.accountBalance(db, '610301', `${PERIOD}/31`), 0, '610301 fully absorbed');
  eq(close.accountBalance(db, '610302', `${PERIOD}/31`), 1_000_000, '610302 half absorbed');
  const jl = db.prepare('SELECT account_code, cost_center_id FROM journal_lines WHERE entry_id=?').all(run.data.je_id);
  ok(jl.some((l) => l.account_code === acct(db, 'coa_overhead_control').code && Number(l.cost_center_id) === Number(cc1)), 'Dr 5202 carries cost center', jl);
  ok(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE entity='cc_absorb_posting' AND action='create'").get().c >= 1, 'absorb run audited');

  const again = await api(adminTok, 'POST', '/api/production/cost-centers/absorb-postings/run', { cost_center_id: cc1, period_label: PERIOD });
  ok(again.status === 409 && again.data.code === 'E_ALREADY_POSTED', 'second run same period+maps blocked', again.data);
  let uxErr = null;
  try {
    const r = db.prepare("SELECT * FROM cc_absorb_postings WHERE status='posted' LIMIT 1").get();
    db.prepare(`INSERT INTO cc_absorb_postings (doc_no, period_label, cost_center_id, map_id, account_code, amount_rial, status)
      VALUES ('X', ?, ?, ?, ?, 1, 'posted')`).run(r.period_label, r.cost_center_id, r.map_id, r.account_code);
  } catch (e) { uxErr = e; }
  ok(uxErr && /UNIQUE/i.test(uxErr.message), 'DB guard: one posted absorb per period+map');

  pre = close.precheck(db, { period: PERIOD });
  chk = pre.checks.find((c) => c.code === 'OH_ACTUAL_ON_CONTROL');
  ok(chk && chk.status === 'pass', 'precheck passes after absorb', chk);

  const noReason = await api(adminTok, 'POST', `/api/production/cost-centers/absorb-postings/${run.data.doc_no}/reverse`, {});
  ok(noReason.status === 422, 'reverse requires reason', noReason.status);
  const rev = await api(adminTok, 'POST', `/api/production/cost-centers/absorb-postings/${run.data.doc_no}/reverse`, { reason: 'تست ابطال' });
  ok(rev.status === 200 && rev.data.count === 2, 'reverse absorb ok', rev.data);
  eq(bal('coa_overhead_control'), 0, 'R13: 5202 back to 0 after reverse');
  eq(close.accountBalance(db, '610301', `${PERIOD}/31`), 6_000_000, 'R13: 610301 restored');
  ok(db.prepare("SELECT COUNT(*) c FROM cc_absorb_postings WHERE doc_no=? AND status='reversed'").get(run.data.doc_no).c === 2, 'rows marked reversed');
  ok(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE entity='cc_absorb_posting' AND action='delete'").get().c >= 1, 'reverse audited');
  const rerun = await api(adminTok, 'POST', '/api/production/cost-centers/absorb-postings/run', { cost_center_id: cc1, period_label: PERIOD });
  ok(rerun.status === 200 && rerun.data.total_rial === 7_000_000, 'rerun after reverse posts same 7M (period_debit unaffected)', rerun.data);
  const listed = await api(adminTok, 'GET', `/api/production/cost-centers/absorb-postings?period=${PERIOD}`);
  ok(listed.status === 200 && listed.data.rows.length === 4, 'list shows posted + reversed rows', listed.data.rows && listed.data.rows.length);

  console.log('\n(d) PRD-23 شامل 5213/5214');
  const lines = buildAllocationLines(db, {
    total: { wip_rial: 0, fg_rial: 0, cogs_rial: 900, total_rial: 900 },
    labor: { total_rial: 300, components: { coa_var_labor_rate: 100, coa_var_labor_eff: 200 } },
    overhead: { total_rial: 600, components: { coa_var_oh_budget: 1000, coa_var_oh_volume: -400 } },
  });
  const byCode = Object.fromEntries(lines.map((l) => [l.code, Math.round((l.credit - l.debit) * 10)]));
  ok(byCode[acct(db, 'coa_var_labor_eff').code] === 200 && byCode[acct(db, 'coa_var_oh_budget').code] === 1000
    && byCode[acct(db, 'coa_var_oh_volume').code] === -400, 'buildAllocationLines credits each variance account', byCode);

  const c5213 = acct(db, 'coa_var_labor_eff').code;
  const c5214 = acct(db, 'coa_var_oh_budget').code;
  postJe([{ code: c5213, dr: 500_000 }, { code: cash, cr: 500_000 }]);
  postJe([{ code: cash, dr: 1_200_000 }, { code: c5214, cr: 1_200_000 }], 'cost_revaluation');
  db.prepare('UPDATE cost_center_rates SET budget_fixed_oh_rial=6000000 WHERE cost_center_id=? AND period_label=?').run(cc1, PERIOD);
  const calc = close.calculate(db, { period: PERIOD });
  ok(calc.overhead.budget_var_rial !== 0 && calc.overhead.components, 'calculate splits budget/volume variance', calc.overhead);
  ok(calc.preview_entries.some((e) => e.event === 'PRD-23' && e.lines.some((l) => l.code === c5213)), 'preview PRD-23 includes 5213');
  let execErr = null;
  let res = null;
  try { res = close.execute(db, { period: PERIOD, userId: admin.id }); } catch (e) { execErr = e; }
  ok(!execErr && res && res.ok, 'close execute succeeds (controls zero)', execErr && { code: execErr.code, extra: execErr.extra });
  for (const key of ['coa_overhead_control', 'coa_overhead_applied', 'coa_var_labor_rate', 'coa_var_labor_eff', 'coa_var_oh_budget', 'coa_var_oh_volume']) {
    ok(Math.abs(bal(key)) <= 5, `${key} zero after close`, bal(key));
  }

  console.log('\n(e) producedInPeriod فقط FG');
  let tx = 0;
  const led = (pid, src, qty) => db.prepare(`
    INSERT INTO inventory_ledger (tx_no, event_type, product_id, qty_in, amount_rial, source_type, status, date)
    VALUES (?, 'production_receipt', ?, ?, ?, ?, 'posted', ?)
  `).run(`P3-${++tx}`, pid, qty, qty * 1000, src, '1405/08/05');
  led(fg, 'production_receipt', 5);
  led(raw, 'production_receipt', 3);
  led(fg, 'cutting_remnant', 2);
  led(raw, 'cutting_roll_surplus', 4);
  const produced = close.producedInPeriod(db, '1405/08');
  ok(produced.length === 1 && Number(produced[0].product_id) === Number(fg) && Number(produced[0].qty) === 5,
    'only FG production receipts counted', produced);

  server.close();
  try { closeSessionStore && closeSessionStore(); } catch { /* optional */ }
  try { closeDB(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\nP3 overhead/close: ✅ ${pass} · ❌ ${fail}`);
  if (failures.length) failures.forEach((f) => console.log('  • ' + f));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
