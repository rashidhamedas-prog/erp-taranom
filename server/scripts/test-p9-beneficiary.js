'use strict';
/**
 * P9-fix — یک موتور برای هر شخص + نوع ذی‌نفع پورسانت (employee | agent).
 * Run: node server/scripts/test-p9-beneficiary.js
 *
 * Isolated temp DB. Covers: engine exclusion both ways (P9 rule/party vs legacy incentive on admin users /
 * rep rules / rep tiers), legacy both-active → skipped + reported + transfer 409, beneficiary derivation +
 * payroll-file default flags, employee commission deductions only when flags are on (rates from payroll
 * period / tax brackets — changed mid-test), agent JE balanced (tax 0 default, >0 path) + full reverse,
 * monthly review report, read-only account suggestions (settings untouched), capture wiring.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : JSON.stringify(extra)); }
}

console.log('\n══ P9-fix — commission beneficiary + single engine ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-ben-'));
process.env.DB_PATH = path.join(dir, 'p9b.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'p9-beneficiary-test-secret-at-least-32-chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const dbMods = require('../db');
dbMods.initDB();
const db = dbMods.getDB();

async function main() {
  const express = require('express');
  const http = require('http');
  const { issueStaffSession } = require('../lib/auth-sessions');
  const capture = require('../sync/capture');
  const { acct, clearCoaCache } = require('../lib/coa-map');
  const CB = require('../lib/commission-beneficiary');
  const { calculatePayroll } = require('../lib/payroll/engine');

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
  const settingsSnapshot = () => JSON.stringify(qa('SELECT key, value FROM settings ORDER BY key'));
  const coaKeySnapshot = () => JSON.stringify(qa("SELECT key, value FROM settings WHERE key LIKE 'coa_%' ORDER BY key"));

  // ── seed ──
  const leafBefore = q1("SELECT value FROM settings WHERE key='ledger_leaf_enforcement'")?.value;
  const coaBefore = coaKeySnapshot();
  const pEmp = insert('persons', { name: 'کارمند فروش', active: 1, personnel_code: 'E-201', monthly_salary_rial: 100000000, insurance_type: 'sso' });
  const pEmpNoIns = insert('persons', { name: 'کارمند بدون بیمه', active: 1, personnel_code: 'E-202' });
  insert('salary_structures', { person_id: pEmpNoIns, fiscal_year: 1405, base_wage_rial: 50000000, insurance_type: 'none' });
  const pAgent = insert('persons', { name: 'نماینده آزاد', active: 1 });
  const pLegacy = insert('persons', { name: 'نماینده با انگیزه فروش', active: 1 });
  const adminA = insert('users', { name: 'مدیر', username: 'p9b_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
  const accU = insert('users', { name: 'حسابدار', username: 'p9b_acc', password: 'x', role: 'accounting', active: 1, must_change_password: 0 });
  const uEmp = insert('users', { name: 'کارمند فروش', username: 'p9b_emp', password: 'x', role: 'inside_sales', active: 1, must_change_password: 0, person_id: pEmp });
  const uAgent = insert('users', { name: 'نماینده آزاد', username: 'p9b_agent', password: 'x', role: 'field_sales', active: 1, must_change_password: 0, person_id: pAgent });
  const uLegacy = insert('users', { name: 'نماینده قدیمی', username: 'p9b_legacy', password: 'x', role: 'field_sales', active: 1, must_change_password: 0, person_id: pLegacy, commission_cash: 2 });
  const cust = insert('customers', { user_id: adminA, name: 'مشتری', biz: 'مشتری', phone: '0912', city: 'مشهد', status: 'active' });
  const cat = insert('product_categories', { name: 'گروه تست' });
  const cc = insert('cost_centers', { code: 'CC-B', name: 'فروش', active: 1 });
  const prod = insert('products', { user_id: adminA, name: 'مانتو', code: 'P9B-A', price: 1000000, cost: 0, stock: 0, category_id: cat });
  const inv = (num, date, userId, amount) => insert('invoices', {
    user_id: userId, cust_id: cust, num, type: 'final', date,
    rows: JSON.stringify([{ product_id: prod, qty: 1, price: amount, disc: 0, disc_amt: 0, sum: amount }]),
    subtotal: amount, disc: 0, disc_amt: 0, final: amount, approved: 1,
  });
  inv('P9B-1', '1405/07/05', uEmp, 10000000); // employee 5% → 500,000
  inv('P9B-2', '1405/07/06', uAgent, 2000000); // agent 4% → 80,000
  const invLegacy = inv('P9B-3', '1405/07/07', uLegacy, 1000000);

  const tok = {};
  for (const [k, uid] of [['admin', adminA], ['acc', accU]]) {
    const u = q1('SELECT * FROM users WHERE id=?', uid);
    tok[k] = issueStaffSession(db, u, { device_kind: 'test', device_name: 'p9b-' + k, device_fingerprint: 'p9b-fp-' + k }).token;
  }
  const app = express();
  app.use(express.json());
  app.use(capture.captureMiddleware);
  app.use('/api/commissions', require('../routes/commissions'));
  app.use('/api/payroll', require('../routes/payroll'));
  app.use('/api/admin', require('../routes/admin'));
  app.use('/api/reps', require('../routes/rep-management'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  async function api(method, p, body, who = 'admin') {
    const res = await fetch(BASE + p, {
      method,
      headers: { Authorization: 'Bearer ' + tok[who], 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, data };
  }

  try {
    console.log('— schema, backfill, derivation —');
    for (const c of ['commission_beneficiary_type', 'insurance_applicable', 'payroll_tax_applicable']) {
      ok(cols('persons').has(c), `persons.${c} column`);
    }
    for (const c of ['beneficiary_type', 'tax_rate_pct', 'withholding_tax_rial']) ok(cols('commission_transfers').has(c), `commission_transfers.${c} column`);
    ok(q1("SELECT value FROM settings WHERE key='commission_beneficiary_backfill_v1'")?.value === '1', 'backfill marker set (idempotent)');
    ok(q1("SELECT value FROM settings WHERE key='commission_agent_tax_rate'") == null && CB.agentTaxRatePct(db) === 0, 'agent tax rate default 0 (no setting written)');
    let b = CB.beneficiaryOf(db, pEmp);
    ok(b.beneficiary_type === 'employee' && b.beneficiary_type_derived === 1 && b.insurance_applicable === 1 && b.payroll_tax_applicable === 1, 'employee derived from personnel code; flags default 1', b);
    b = CB.beneficiaryOf(db, pEmpNoIns);
    ok(b.insurance_applicable === 0 && b.payroll_tax_applicable === 1, 'insurance flag default from payroll file (insurance_type=none ⇒ 0)', b);
    ok(CB.beneficiaryOf(db, pAgent).beneficiary_type === 'agent', 'no employee record ⇒ agent');
    // backfill on a fresh flag: fills NULL only, never overwrites
    db.prepare("UPDATE persons SET insurance_applicable=0 WHERE id=?").run(pEmp);
    db.prepare("DELETE FROM settings WHERE key='commission_beneficiary_backfill_v1'").run();
    const bf = CB.backfillBeneficiaries(db);
    ok(!bf.skipped && q1('SELECT insurance_applicable, commission_beneficiary_type FROM persons WHERE id=?', pEmp).insurance_applicable === 0
      && q1('SELECT commission_beneficiary_type FROM persons WHERE id=?', pEmp).commission_beneficiary_type === 'employee', 'backfill keeps non-null, fills NULL', bf);
    ok(q1('SELECT commission_beneficiary_type FROM persons WHERE id=?', pAgent).commission_beneficiary_type == null, 'backfill leaves non-employee without P9 data NULL (stays derived)');
    ok(CB.backfillBeneficiaries(db).skipped === true, 'backfill second run skipped');
    db.prepare("UPDATE persons SET insurance_applicable=1 WHERE id=?").run(pEmp);

    console.log('— exclusion: P9 → legacy incentive —');
    let r = await api('POST', '/api/commissions/rules', { person_id: pLegacy, role: 'seller', scope: 'invoice', pct: 5 });
    ok(r.status === 409 && r.data.code === 'E_COMMISSION_ENGINE_CONFLICT' && /انگیزه فروش/.test(r.data.error), 'P9 rule for person with active incentive ⇒ 409', r);
    r = await api('PUT', `/api/commissions/invoice-parties/${invLegacy}`, { parties: [{ person_id: pLegacy, role: 'seller', share_pct: 100 }] });
    ok(r.status === 409 && r.data.code === 'E_COMMISSION_ENGINE_CONFLICT', 'P9 invoice party with active incentive ⇒ 409', r);
    r = await api('POST', '/api/commissions/rules', { person_id: pEmp, role: 'seller', scope: 'invoice', pct: 5 });
    ok(r.status === 200, 'P9 rule for employee (no incentive) ok', r);
    const agentRule = await api('POST', '/api/commissions/rules', { person_id: pAgent, role: 'seller', scope: 'invoice', pct: 4 });
    ok(agentRule.status === 200, 'P9 rule for agent ok', agentRule);

    console.log('— exclusion: legacy incentive → P9 —');
    r = await api('PUT', `/api/admin/users/${uAgent}`, { name: 'نماینده آزاد', role: 'field_sales', active: 1, commission_cash: 3, commission_cheque: 0 });
    ok(r.status === 409 && r.data.code === 'E_COMMISSION_ENGINE_CONFLICT', 'admin: activating incentive for person with P9 rules ⇒ 409', r);
    ok(Number(q1('SELECT commission_cash FROM users WHERE id=?', uAgent).commission_cash) === 0, 'incentive rate not saved');
    r = await api('PUT', `/api/admin/users/${uAgent}`, { name: 'نماینده آزاد ۲', role: 'field_sales', active: 1, commission_cash: 0, commission_cheque: 0 });
    ok(r.status === 200, 'admin: editing user without incentive still allowed', r);
    r = await api('POST', `/api/reps/${uAgent}/commission-rules`, { scope_type: 'product', scope_id: prod, rate_cash: 1, rate_cheque: 0 });
    ok(r.status === 409 && r.data.code === 'E_COMMISSION_ENGINE_CONFLICT', 'rep commission rule (rate>0) for P9 person ⇒ 409', r);
    r = await api('POST', `/api/reps/${uAgent}/commission-tiers`, { from_amount: 0, rate_cash: 1, rate_cheque: 1 });
    ok(r.status === 409 && r.data.code === 'E_COMMISSION_ENGINE_CONFLICT', 'rep commission tier (rate>0) for P9 person ⇒ 409', r);
    ok(!q1('SELECT 1 FROM rep_commission_rules WHERE rep_id=?', uAgent) && !q1('SELECT 1 FROM rep_commission_tiers WHERE rep_id=?', uAgent), 'no legacy rule/tier rows written');

    console.log('— legacy data with both engines → skip + report —');
    db.prepare("INSERT INTO commission_rules (person_id, role, scope, pct, active) VALUES (?, 'seller', 'invoice', 5, 1)").run(pLegacy);
    r = await api('GET', '/api/commissions/report?from=1405/07/01&to=1405/07/31');
    const rowsBy = Object.fromEntries((r.data.rows || []).map((x) => [x.person_id, x]));
    const conf = (r.data.engine_conflicts || []).find((c) => c.person_id === pLegacy);
    ok(r.status === 200 && !rowsBy[pLegacy] && conf && conf.skipped_rial === 50000 && conf.user_ids.includes(uLegacy), 'conflicting person skipped and listed in engine_conflicts', r.data.engine_conflicts);
    ok(rowsBy[pEmp] && rowsBy[pEmp].total_rial === 500000 && rowsBy[pEmp].beneficiary_type === 'employee', 'employee commission 500,000', rowsBy[pEmp]);
    ok(rowsBy[pAgent] && rowsBy[pAgent].total_rial === 80000 && rowsBy[pAgent].beneficiary_type === 'agent', 'agent commission 80,000', rowsBy[pAgent]);
    ok(!require('../lib/commissions-multi').computeContributions(db, { from: '1405/07/01', to: '1405/07/31' }).some((c) => c.person_id === pLegacy), 'computeContributions skips conflicting person');
    r = await api('POST', '/api/commissions/transfers', { person_id: pLegacy, from: '1405/07/01', to: '1405/07/31' });
    ok(r.status === 409 && r.data.code === 'E_COMMISSION_ENGINE_CONFLICT', 'transfer for conflicting person ⇒ 409', r);
    r = await api('GET', '/api/commissions/beneficiaries');
    ok(r.status === 200 && r.data.rows.some((x) => x.person_id === pLegacy && x.engine_conflict === 1), 'beneficiaries list flags conflict', r.data);

    console.log('— review report (flags on, agent tax 0) —');
    r = await api('GET', '/api/commissions/review?month=1405/07');
    const rv = Object.fromEntries((r.data.rows || []).map((x) => [x.person_id, x]));
    ok(r.status === 200 && r.data.agent_tax_rate_pct === 0 && rv[pAgent] && rv[pAgent].reasons.includes('agent_tax_zero'), 'review: agent with tax rate 0 listed', r.data);
    ok(!rv[pEmp], 'review: employee with both flags on not listed');
    ok((r.data.engine_conflicts || []).some((c) => c.person_id === pLegacy), 'review: engine conflict listed');
    r = await api('GET', '/api/commissions/review?month=1405-7');
    ok(r.status === 400 && r.data.code === 'E_MONTH', 'review: invalid month ⇒ 400', r);

    console.log('— agent: JE balanced, tax 0, reverse —');
    r = await api('POST', '/api/commissions/transfers', { person_id: pAgent, from: '1405/07/01', to: '1405/07/31', target: 'payroll' });
    ok(r.status === 400 && r.data.code === 'E_NOT_EMPLOYEE', 'agent cannot go to payroll', r);
    const expCode = acct(db, 'coa_rep_commission_expense').code;
    const payCode = acct(db, 'coa_rep_commission_payable').code;
    const taxCode = acct(db, 'coa_payroll_tax_payable').code;
    let t = await api('POST', '/api/commissions/transfers', { person_id: pAgent, from: '1405/07/01', to: '1405/07/31' });
    ok(t.status === 200 && t.data.target === 'voucher' && t.data.amount_rial === 80000 && t.data.withholding_tax_rial === 0 && t.data.beneficiary_type === 'agent', 'agent → voucher 80,000, tax 0', t.data);
    let jl = qa('SELECT account_code, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?', t.data.je_id);
    const sum = (ls, k) => ls.reduce((a, l) => a + (Number(l[k]) || 0), 0);
    ok(jl.length === 2 && sum(jl, 'debit_rial') === sum(jl, 'credit_rial')
      && jl.some((l) => l.account_code === expCode && l.debit_rial === 80000) && jl.some((l) => l.account_code === payCode && l.credit_rial === 80000),
      'JE balanced: Dr expense 80,000 / Cr payable 80,000', jl);
    ok(q1('SELECT status FROM journal_entries WHERE id=?', t.data.je_id).status === 'draft', 'JE keeps P9 draft convention');
    r = await api('POST', `/api/commissions/transfers/${t.data.id}/void`, { reason: 'تست' });
    let je = q1('SELECT status, deleted_at FROM journal_entries WHERE id=?', t.data.je_id);
    ok(r.status === 200 && r.data.status === 'void' && je && (je.status === 'reversed' || Number(je.deleted_at) > 0), 'void reverses JE (R13)', { r: r.data, je });

    console.log('— agent tax rate setting (admin only) + >0 path —');
    r = await api('PUT', '/api/commissions/settings', { agent_tax_rate_pct: 10 }, 'acc');
    ok(r.status === 403, 'accounting cannot change agent tax rate', r.status);
    r = await api('PUT', '/api/commissions/settings', { agent_tax_rate_pct: 150 });
    ok(r.status === 400 && r.data.code === 'E_TAX_RATE', 'rate > 100 rejected', r);
    r = await api('PUT', '/api/commissions/settings', { agent_tax_rate_pct: 10 });
    ok(r.status === 200 && r.data.agent_tax_rate_pct === 10, 'admin sets agent tax rate 10%', r);
    t = await api('POST', '/api/commissions/transfers', { person_id: pAgent, from: '1405/07/01', to: '1405/07/31' });
    ok(t.status === 200 && t.data.withholding_tax_rial === 8000 && Number(t.data.tax_rate_pct) === 10, 'transfer withholds 8,000 (10%)', t.data);
    jl = qa('SELECT account_code, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?', t.data.je_id);
    ok(jl.length === 3 && sum(jl, 'debit_rial') === 80000 && sum(jl, 'credit_rial') === 80000
      && jl.some((l) => l.account_code === expCode && l.debit_rial === 80000)
      && jl.some((l) => l.account_code === payCode && l.credit_rial === 72000)
      && jl.some((l) => l.account_code === taxCode && l.credit_rial === 8000),
      'JE: Dr expense 80,000 (full) / Cr payable 72,000 / Cr tax payable 8,000', jl);
    r = await api('POST', `/api/commissions/transfers/${t.data.id}/void`, {});
    je = q1('SELECT status, deleted_at FROM journal_entries WHERE id=?', t.data.je_id);
    ok(r.status === 200 && r.data.status === 'void' && (je.status === 'reversed' || Number(je.deleted_at) > 0), 'void reverses 3-line JE', je);
    r = await api('GET', '/api/commissions/review?month=1405/07');
    ok(r.status === 200 && !(r.data.rows || []).some((x) => x.person_id === pAgent), 'review: agent no longer listed when tax rate > 0');

    console.log('— employee: payroll only, flags gate deductions —');
    r = await api('POST', '/api/commissions/transfers', { person_id: pEmp, from: '1405/07/01', to: '1405/07/31', target: 'voucher' });
    ok(r.status === 400 && r.data.code === 'E_EMPLOYEE_PAYROLL_ONLY', 'employee cannot get a direct JE', r);
    // fiscal year without seeded labor settings/brackets → no cap/exemption noise; rates come only from these rows
    const FY = 1499;
    const periodId = insert('payroll_periods', { fiscal_year: FY, month_no: 7, label: '1405/07', start_date: '1405/07/01', end_date: '1405/07/30', status: 'open', employee_insurance_bp: 700, employer_insurance_bp: 2300 });
    insert('payroll_tax_brackets', { fiscal_year: FY, bracket_order: 1, bracket_min_rial: 0, bracket_max_rial: null, tax_rate_bp: 1000, active: 1 });
    t = await api('POST', '/api/commissions/transfers', { person_id: pEmp, from: '1405/07/01', to: '1405/07/31', payroll_period_id: periodId });
    ok(t.status === 200 && t.data.target === 'payroll' && t.data.status === 'pending' && t.data.amount_rial === 500000 && !t.data.je_id, 'employee → pending payroll row 500,000 (no JE)', t.data);
    const calcBody = { person_id: pEmp, period_id: periodId, working_days_x100: 3000, regular_hours_x100: 0, overtime_hours_x100: 0, night_shift_hours_x100: 0, hardship_allowance_rial: 0, other_allowance_rial: 0, other_deductions_rial: 0, commission_insurance_applicable: 0, commission_tax_applicable: 0 };
    const cOn = await api('POST', '/api/payroll/calculate', calcBody);
    ok(cOn.status === 200 && cOn.data.calculation.commission_rial === 500000 && cOn.data.calculation.commission_insurance_applicable === 1
      && cOn.data.calculation.commission_tax_applicable === 1, 'flags on (client flag values ignored — server reads person)', cOn.data && cOn.data.calculation);
    r = await api('PUT', `/api/commissions/beneficiaries/${pEmp}`, { insurance_applicable: 0, payroll_tax_applicable: 0 });
    ok(r.status === 200 && r.data.insurance_applicable === 0 && r.data.payroll_tax_applicable === 0 && r.data.beneficiary_type === 'employee', 'flags turned off', r.data);
    const cOff = await api('POST', '/api/payroll/calculate', calcBody);
    const on = cOn.data.calculation;
    const off = cOff.data.calculation;
    ok(off.commission_insurance_applicable === 0 && off.commission_tax_applicable === 0 && off.gross_earnings_rial === on.gross_earnings_rial, 'flags off: same gross', off);
    ok(on.insurance_base_rial - off.insurance_base_rial === 500000 && Math.abs((on.sso_employee_rial - off.sso_employee_rial) - 35000) <= 1, 'insurance on commission only when flag on (7% from payroll period = 35,000)', { on: on.sso_employee_rial, off: off.sso_employee_rial });
    ok(on.income_tax_rial > off.income_tax_rial, 'tax on commission only when flag on', { on: on.income_tax_rial, off: off.income_tax_rial });
    // baseline (no commission) through the engine with the same inputs → off-flags commission is gross = net
    const ctxStruct = { wage_basis: 'monthly', base_wage_rial: 100000000, housing_allowance_rial: 0, grocery_allowance_rial: 0, child_allowance_rial: 0, spouse_allowance_rial: 0, other_fixed_allowance_rial: 0, child_count: 0, marital_status: 0, insurance_type: 'sso', tax_exemption_percent_bp: 0 };
    const ctxPeriod = { standard_days: 30, employee_insurance_bp: 700, employer_insurance_bp: 2300 };
    const brackets = [{ bracket_order: 1, bracket_min_rial: 0, bracket_max_rial: null, tax_rate_bp: 1000 }];
    const inp = { working_days_x100: 3000, regular_hours_x100: 0, overtime_hours_x100: 0, night_shift_hours_x100: 0, hardship_allowance_rial: 0, other_allowance_rial: 0, other_deductions_rial: 0 };
    const e0 = calculatePayroll({ structure: ctxStruct, period: ctxPeriod, brackets, input: inp });
    const eOff = calculatePayroll({ structure: ctxStruct, period: ctxPeriod, brackets, input: { ...inp, commission_rial: 500000, commission_insurance_applicable: 0, commission_tax_applicable: 0 } });
    const eOn = calculatePayroll({ structure: ctxStruct, period: ctxPeriod, brackets, input: { ...inp, commission_rial: 500000, commission_insurance_applicable: 1, commission_tax_applicable: 1 } });
    const eLegacy = calculatePayroll({ structure: ctxStruct, period: ctxPeriod, brackets, input: { ...inp, commission_rial: 500000 } });
    ok(eOff.net_pay_rial - e0.net_pay_rial === 500000 && eOff.sso_employee_rial === e0.sso_employee_rial && eOff.income_tax_rial === e0.income_tax_rial,
      'engine: both flags off ⇒ commission gross = net, no deduction', { e0: e0.net_pay_rial, eOff: eOff.net_pay_rial });
    ok(eOn.net_pay_rial < eOff.net_pay_rial && eLegacy.net_pay_rial === eOn.net_pay_rial, 'engine: flags default on (P9 behaviour unchanged)');
    const eInsOnly = calculatePayroll({ structure: ctxStruct, period: ctxPeriod, brackets, input: { ...inp, commission_rial: 500000, commission_insurance_applicable: 1, commission_tax_applicable: 0 } });
    ok(eInsOnly.sso_employee_rial - e0.sso_employee_rial === 35000 && eInsOnly.taxable_income_rial <= e0.taxable_income_rial, 'engine: insurance-only flag deducts insurance, no extra tax');
    // rates are read from payroll settings: change the period rate → deduction changes
    r = await api('PUT', `/api/commissions/beneficiaries/${pEmp}`, { insurance_applicable: 1, payroll_tax_applicable: 1 });
    db.prepare('UPDATE payroll_periods SET employee_insurance_bp=1000 WHERE id=?').run(periodId);
    const cOn10 = await api('POST', '/api/payroll/calculate', calcBody);
    r = await api('PUT', `/api/commissions/beneficiaries/${pEmp}`, { insurance_applicable: 0 });
    const cOff10 = await api('POST', '/api/payroll/calculate', calcBody);
    ok(Math.abs((cOn10.data.calculation.sso_employee_rial - cOff10.data.calculation.sso_employee_rial) - 50000) <= 1, 'insurance on commission follows payroll setting (10% ⇒ 50,000)', { on: cOn10.data.calculation.sso_employee_rial, off: cOff10.data.calculation.sso_employee_rial });
    db.prepare('UPDATE payroll_tax_brackets SET tax_rate_bp=2000 WHERE fiscal_year=?').run(FY);
    const cTax20 = await api('POST', '/api/payroll/calculate', calcBody);
    ok(cTax20.data.calculation.income_tax_rial > cOn10.data.calculation.income_tax_rial, 'tax follows payroll tax brackets (changed in settings)', { before: cOn10.data.calculation.income_tax_rial, after: cTax20.data.calculation.income_tax_rial });
    db.prepare('UPDATE payroll_tax_brackets SET tax_rate_bp=1000 WHERE fiscal_year=?').run(FY);
    db.prepare('UPDATE payroll_periods SET employee_insurance_bp=700 WHERE id=?').run(periodId);

    console.log('— review report (employee flags off) —');
    r = await api('PUT', `/api/commissions/beneficiaries/${pEmp}`, { insurance_applicable: 0, payroll_tax_applicable: 1 });
    r = await api('GET', '/api/commissions/review?month=1405/07');
    let rvE = (r.data.rows || []).find((x) => x.person_id === pEmp);
    ok(rvE && rvE.reasons.join(',') === 'insurance_off' && rvE.total_rial === 500000, 'review: employee with insurance off listed', rvE);
    r = await api('PUT', `/api/commissions/beneficiaries/${pEmp}`, { insurance_applicable: 1, payroll_tax_applicable: 0 });
    r = await api('GET', '/api/commissions/review?month=1405/07');
    rvE = (r.data.rows || []).find((x) => x.person_id === pEmp);
    ok(rvE && rvE.reasons.join(',') === 'payroll_tax_off', 'review: employee with payroll tax off listed', rvE);

    console.log('— payroll process with flags + R13 cascade —');
    const proc = await api('POST', '/api/payroll/process', { period_id: periodId, rows: [{ person_id: pEmp, working_days_x100: 3000, regular_hours_x100: 0, overtime_hours_x100: 0, night_shift_hours_x100: 0, hardship_allowance_rial: 0, other_allowance_rial: 0, other_deductions_rial: 0, cost_center_id: cc }] });
    const recId = proc.data && proc.data.records && proc.data.records[0].id;
    ok(proc.status === 200 && recId && q1('SELECT commission_rial FROM payroll_records WHERE id=?', recId).commission_rial === 500000, 'payroll processed with commission row', proc.data);
    r = await api('PUT', `/api/commissions/beneficiaries/${pEmp}`, { commission_beneficiary_type: 'agent' });
    ok(r.status === 409 && r.data.code === 'E_COMMISSION_LOCKED', 'beneficiary type locked while payroll transfer live', r);
    r = await api('POST', `/api/payroll/${recId}/void`, {});
    ok(r.status === 200 && q1('SELECT status FROM commission_transfers WHERE id=?', t.data.id).status === 'pending', 'payroll void ⇒ commission back to pending', r);
    r = await api('POST', `/api/commissions/transfers/${t.data.id}/void`, {});
    ok(r.status === 200 && r.data.status === 'void', 'pending payroll transfer voided', r);
    r = await api('PUT', `/api/commissions/beneficiaries/${pEmp}`, { commission_beneficiary_type: 'bogus' });
    ok(r.status === 400 && r.data.code === 'E_BENEFICIARY_TYPE', 'invalid beneficiary type ⇒ 400', r);
    r = await api('PUT', `/api/commissions/beneficiaries/${pAgent}`, { commission_beneficiary_type: 'employee' });
    ok(r.status === 200 && r.data.beneficiary_type === 'employee' && r.data.beneficiary_type_derived === 0, 'explicit beneficiary type overrides derivation', r.data);
    r = await api('POST', '/api/commissions/transfers', { person_id: pAgent, from: '1405/07/01', to: '1405/07/31' });
    ok(r.status === 400 && r.data.code === 'E_PAYROLL_PERIOD', 'explicit employee ⇒ payroll target (period required)', r);

    console.log('— account suggestions (read-only) —');
    insert('chart_of_accounts', { code: '610199', name: 'هزینه پورسانت فروش', type: 'expense', level: 3 });
    insert('chart_of_accounts', { code: '210699', name: 'مالیات تکلیفی حق‌العمل', type: 'liability', level: 3 });
    clearCoaCache();
    const sBefore = settingsSnapshot();
    r = await api('GET', '/api/commissions/account-suggestions');
    const sAfter = settingsSnapshot();
    ok(r.status === 200 && sBefore === sAfter, 'suggestion endpoint does not mutate settings');
    ok(r.data.current.expense.code === expCode && r.data.current.payable.code === payCode && r.data.current.tax.code === taxCode, 'reports current mapping', r.data.current);
    ok((r.data.suggestions.expense || [])[0] && r.data.suggestions.expense[0].code === '610199', 'expense suggestion by name heuristic', r.data.suggestions.expense);
    ok((r.data.suggestions.tax || [])[0] && r.data.suggestions.tax[0].code === '210699', 'tax suggestion by name heuristic', r.data.suggestions.tax);
    r = await api('GET', '/api/commissions/account-suggestions', null, 'acc');
    ok(r.status === 200, 'accounting can read suggestions');

    console.log('— wiring & invariants —');
    ok(capture.tableForPath('/api/commissions/beneficiaries/5') === 'persons', 'capture: beneficiaries → persons');
    ok(capture.tableForPath('/api/commissions/transfers/2/void') === 'commission_transfers', 'capture: transfers unchanged');
    ok(q1("SELECT value FROM settings WHERE key='ledger_leaf_enforcement'")?.value === leafBefore, 'ledger_leaf_enforcement untouched');
    ok(coaKeySnapshot() === coaBefore, 'no coa_* key setting changed during the whole run');
  } finally {
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { db.close(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
