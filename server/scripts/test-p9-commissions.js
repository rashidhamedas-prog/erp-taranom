'use strict';
/**
 * P9 — پورسانت چندنفره (سرپرست گروه کالا + چند فروشنده روی یک فاکتور).
 * Run: node server/scripts/test-p9-commissions.js
 *
 * Isolated temp DB. Covers: two supervisors on separate product groups, two sellers 50/50 on one invoice,
 * header+line discount in the base, sales return deducted, creator fallback seller, reversed/proforma excluded,
 * product rule beats group rule, share validation, rule overlap, employee → payroll (taxable/insurable gross),
 * payroll void releases commission, non-employee → draft JE (Dr expense / Cr person) + R13 void,
 * lock while transferred, sync wiring (tables append-only, FK, PATH_TABLE_MAP, backfill v34), leaf setting untouched.
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

console.log('\n══ P9 — multi-party commissions ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-comm-'));
process.env.DB_PATH = path.join(dir, 'p9.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'p9-commissions-test-secret-at-least-32-chars!!';
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
  const { SYNCABLE_TABLES, FK_COLUMNS } = require('../sync/tables');
  const { acct } = require('../lib/coa-map');
  const CM = require('../lib/commissions-multi');
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

  // ── seed ──
  const leafBefore = q1("SELECT value FROM settings WHERE key='ledger_leaf_enforcement'")?.value;
  const pSupA = insert('persons', { name: 'سرپرست الف', active: 1 });
  const pSupB = insert('persons', { name: 'سرپرست ب', active: 1 });
  const pSel1 = insert('persons', { name: 'فروشنده یک (کارمند)', active: 1, personnel_code: 'E-101', monthly_salary_rial: 100000000, insurance_type: 'sso' });
  const pSel2 = insert('persons', { name: 'فروشنده دو (بازاریاب آزاد)', active: 1 });
  const adminA = insert('users', { name: 'مدیر', username: 'p9_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
  const salesU = insert('users', { name: 'فروشنده یک', username: 'p9_sales', password: 'x', role: 'inside_sales', active: 1, must_change_password: 0, person_id: pSel1 });
  const cust = insert('customers', { user_id: adminA, name: 'مشتری', biz: 'مشتری', phone: '0912', city: 'مشهد', status: 'active' });
  const catA = insert('product_categories', { name: 'گروه مانتو' });
  const catB = insert('product_categories', { name: 'گروه شلوار' });
  const prodA = insert('products', { user_id: adminA, name: 'مانتو', code: 'P9-A', price: 100000, cost: 0, stock: 0, category_id: catA });
  const prodB = insert('products', { user_id: adminA, name: 'شلوار', code: 'P9-B', price: 200000, cost: 0, stock: 0, category_id: catB });
  const prodA2 = insert('products', { user_id: adminA, name: 'مانتو ویژه', code: 'P9-A2', price: 100000, cost: 0, stock: 0, category_id: catA });
  const cc = insert('cost_centers', { code: 'CC-S', name: 'فروش', active: 1 });

  const inv = (num, date, rows, extra = {}) => insert('invoices', Object.assign({
    user_id: adminA, cust_id: cust, num, type: 'final', date, rows: JSON.stringify(rows),
    subtotal: rows.reduce((a, r) => a + r.sum, 0), disc: 0, disc_amt: 0, final: 0, approved: 1,
  }, extra));
  // INV1: A 10×100,000 = 1,000,000 ; B 5×200,000 −10% = 900,000 ; header disc 190,000 → ratio 0.9
  const inv1 = inv('P9-1', '1405/07/05', [
    { product_id: prodA, qty: 10, price: 100000, disc: 0, disc_amt: 0, sum: 1000000 },
    { product_id: prodB, qty: 5, price: 200000, disc: 10, disc_amt: 100000, sum: 900000 },
  ], { disc_amt: 190000, final: 1710000 });
  // INV2: no parties → creator (salesU → pSel1) 100%
  const inv2 = inv('P9-2', '1405/07/06', [{ product_id: prodA, qty: 1, price: 100000, sum: 100000 }], { user_id: salesU, final: 100000 });
  // excluded docs
  inv('P9-X1', '1405/07/07', [{ product_id: prodA, qty: 50, price: 100000, sum: 5000000 }], { status: 'reversed', deleted_at: 1 });
  inv('P9-X2', '1405/07/07', [{ product_id: prodA, qty: 50, price: 100000, sum: 5000000 }], { type: 'proforma' });
  // INV3 in next month (outside report range)
  inv('P9-3', '1405/08/02', [{ product_id: prodA, qty: 1, price: 100000, sum: 100000 }], { user_id: salesU });
  // return of 2×A on INV1: goods 200,000, header share 20,000 → net 180,000
  insert('sales_returns', {
    user_id: adminA, cust_id: cust, invoice_id: inv1, date: '1405/07/10', note: '',
    rows: JSON.stringify([{ product_id: prodA, qty: 2, price: 100000, disc_amt: 0, sum: 200000 }]),
    amount: 180000, goods_amount: 200000, hdr_disc_amt: 20000, extra_disc_amt: 0, vat_amount: 0,
  });

  const tok = {};
  for (const [k, uid] of [['admin', adminA], ['sales', salesU]]) {
    const u = q1('SELECT * FROM users WHERE id=?', uid);
    tok[k] = issueStaffSession(db, u, { device_kind: 'test', device_name: 'p9-' + k, device_fingerprint: 'p9-fp-' + k }).token;
  }
  const app = express();
  app.use(express.json());
  app.use(capture.captureMiddleware);
  app.use('/api/commissions', require('../routes/commissions'));
  app.use('/api/payroll', require('../routes/payroll'));
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
    console.log('— schema & sync wiring —');
    for (const t of ['commission_rules', 'invoice_commission_parties', 'commission_transfers']) {
      ok(!!q1("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", t), `table ${t} exists`);
      ok(SYNCABLE_TABLES.some((s) => s.name === t), `${t} in SYNCABLE_TABLES`);
    }
    const names = SYNCABLE_TABLES.map((t) => t.name);
    const iRules = names.indexOf('commission_rules');
    ok(iRules > names.indexOf('expense_drafts') && iRules > names.indexOf('opening_stock_lines')
      && names.indexOf('invoice_commission_parties') === iRules + 1 && names.indexOf('commission_transfers') === iRules + 2,
      'P9 tables appended after expense_drafts, consecutive (append-only)');
    ok(FK_COLUMNS.some(([t, c]) => t === 'invoice_commission_parties' && c === 'invoice_id')
      && FK_COLUMNS.some(([t, c]) => t === 'commission_transfers' && c === 'je_id'), 'FK_COLUMNS remap for parties/transfers');
    ok(capture.tableForPath('/api/commissions/rules/3/deactivate') === 'commission_rules', 'capture: rules → commission_rules');
    ok(capture.tableForPath('/api/commissions/invoice-parties/7') === 'invoice_commission_parties', 'capture: invoice-parties');
    ok(capture.tableForPath('/api/commissions/transfers/2/void') === 'commission_transfers', 'capture: transfers');
    ok(q1("SELECT value FROM settings WHERE key='sync_seq_backfill_v35'")?.value === '1', 'sync_seq_backfill_v35 applied');
    ok(!!q1("SELECT 1 FROM number_sequences WHERE key='commission_transfer'"), 'number_sequences commission_transfer');
    ok(cols('payroll_records').has('commission_rial'), 'payroll_records.commission_rial column');

    console.log('— rules —');
    const mk = (b) => api('POST', '/api/commissions/rules', b);
    let r = await mk({ person_id: pSupA, role: 'supervisor', scope: 'product_group', scope_id: catA, pct: 2 });
    ok(r.status === 200 && r.data.id, 'supervisor A on group A 2%', r);
    r = await mk({ person_id: pSupB, role: 'supervisor', scope: 'product_group', scope_id: catB, pct: 3 });
    ok(r.status === 200, 'supervisor B on group B 3%', r);
    r = await mk({ person_id: pSel1, role: 'seller', scope: 'invoice', pct: 5 });
    ok(r.status === 200, 'seller 1 default 5%', r);
    const sel2Rule = await mk({ person_id: pSel2, role: 'seller', scope: 'invoice', pct: 4 });
    ok(sel2Rule.status === 200, 'seller 2 default 4%', sel2Rule);
    r = await mk({ person_id: pSupA, role: 'supervisor', scope: 'invoice', pct: 1 });
    ok(r.status === 400 && r.data.code === 'E_SCOPE', 'supervisor on invoice scope rejected', r);
    r = await mk({ person_id: pSel1, role: 'seller', scope: 'invoice', pct: 6 });
    ok(r.status === 409 && r.data.code === 'E_RULE_OVERLAP', 'overlapping active rule rejected', r);
    r = await mk({ person_id: pSel1, role: 'seller', scope: 'invoice', pct: 0 });
    ok(r.status === 400 && r.data.code === 'E_PCT', 'pct 0 rejected', r);
    // product rule beats group rule for supervisor A (prodA2 only, no sales on it in the range)
    r = await mk({ person_id: pSupA, role: 'supervisor', scope: 'product', scope_id: prodA2, pct: 7 });
    ok(r.status === 200, 'supervisor A product-specific rule', r);
    r = await mk({ person_id: pSel2, role: 'seller', scope: 'product', scope_code: 'NOPE', pct: 3 });
    ok(r.status === 400 && r.data.code === 'E_SCOPE_ID', 'unknown product code rejected', r);
    r = await mk({ person_id: pSupB, role: 'supervisor', scope: 'product', scope_code: 'P9-A2', pct: 1, from_date: '1405/09/01' });
    ok(r.status === 200 && r.data.scope_id === prodA2, 'product rule by code (future-dated)', r);
    r = await api('GET', '/api/commissions/meta');
    ok(r.status === 200 && r.data.persons.some((p) => p.id === pSel1 && p.is_employee === 1) && r.data.groups.length >= 2, 'meta: persons (employee flag) + groups', r.status);

    console.log('— invoice parties (two sellers 50/50) —');
    r = await api('PUT', `/api/commissions/invoice-parties/${inv1}`, { parties: [{ person_id: pSel1, role: 'seller', share_pct: 60 }, { person_id: pSel2, role: 'seller', share_pct: 30 }] });
    ok(r.status === 400 && r.data.code === 'E_SHARE_SUM', 'shares not summing to 100 rejected', r);
    r = await api('PUT', `/api/commissions/invoice-parties/${inv1}`, { parties: [{ person_id: pSel1, role: 'seller', share_pct: 50 }, { person_id: pSel2, role: 'seller', share_pct: 50 }] });
    ok(r.status === 200 && r.data.parties.length === 2, 'two sellers 50/50 saved', r);
    r = await api('GET', '/api/commissions/invoice-parties/P9-1');
    ok(r.status === 200 && r.data.invoice.id === inv1 && r.data.parties.length === 2, 'parties lookup by invoice number', r);
    r = await api('GET', `/api/commissions/invoice-parties/${inv2}`);
    ok(r.status === 200 && r.data.parties.length === 0 && r.data.default_seller && r.data.default_seller.person_id === pSel1, 'inv2 falls back to creator person', r);

    console.log('— report 1405/07 —');
    r = await api('GET', '/api/commissions/report?from=1405/07/01&to=1405/07/30&detail=1');
    ok(r.status === 200, 'report 200', r.status);
    const by = Object.fromEntries((r.data.rows || []).map((x) => [x.person_id, x]));
    // supA: (900,000 + 100,000)×2% = 20,000 − return 180,000×2% = 3,600 → 16,400
    ok(by[pSupA] && by[pSupA].supervisor_rial === 20000 && by[pSupA].returns_deduction_rial === 3600 && by[pSupA].total_rial === 16400, 'supervisor A = 16,400 (group A only, return deducted)', by[pSupA]);
    // supB: 810,000×3% = 24,300
    ok(by[pSupB] && by[pSupB].total_rial === 24300 && by[pSupB].returns_deduction_rial === 0, 'supervisor B = 24,300 (group B only)', by[pSupB]);
    // sel1: 1,710,000×50%×5% = 42,750 + inv2 100,000×5% = 5,000 − 180,000×50%×5% = 4,500 → 43,250
    ok(by[pSel1] && by[pSel1].seller_rial === 47750 && by[pSel1].total_rial === 43250, 'seller 1 = 43,250 (50% + creator fallback − return)', by[pSel1]);
    // sel2: 1,710,000×50%×4% = 34,200 − 180,000×50%×4% = 3,600 → 30,600
    ok(by[pSel2] && by[pSel2].total_rial === 30600, 'seller 2 = 30,600', by[pSel2]);
    ok(by[pSel1] && by[pSel1].is_employee === 1 && by[pSel2] && by[pSel2].is_employee === 0, 'employee flag from personnel code');
    ok(by[pSupA] && by[pSupA].sales_base_rial === 1000000 && by[pSupA].returns_base_rial === 180000, 'base = net after line+header discount, return separate', by[pSupA]);
    ok(r.data.total_rial === 16400 + 24300 + 43250 + 30600, 'grand total', r.data.total_rial);
    const ex = (by[pSupA].lines || []).some((l) => l.doc_no === 'P9-X1' || l.doc_no === 'P9-X2' || l.doc_no === 'P9-3');
    ok(!ex, 'reversed / proforma / out-of-range invoices excluded');

    // product rule precedence (unit, through engine)
    const lines = CM.computeContributions(db, { from: '1405/07/01', to: '1405/07/30' });
    ok(!lines.some((l) => l.person_id === pSupA && l.pct === 7), 'product rule unused when product not sold');
    const tmpInv = inv('P9-T', '1405/07/20', [{ product_id: prodA2, qty: 1, price: 100000, sum: 100000 }], { type: 'normal' });
    const lines2 = CM.computeContributions(db, { from: '1405/07/20', to: '1405/07/20' }).filter((l) => l.doc_id === tmpInv && l.role === 'supervisor');
    ok(lines2.length === 1 && lines2[0].pct === 7 && Math.round(lines2[0].amount) === 7000, 'product rule (7%) beats group rule (2%)', lines2);
    db.prepare("UPDATE invoices SET status='reversed', deleted_at=1 WHERE id=?").run(tmpInv);

    console.log('— transfer: non-employee → draft JE —');
    r = await api('POST', '/api/commissions/transfers', { person_id: pSel2, from: '1405/07/01', to: '1405/07/30', target: 'payroll' });
    ok(r.status === 400 && r.data.code === 'E_NOT_EMPLOYEE', 'non-employee cannot go to payroll', r);
    const t2 = await api('POST', '/api/commissions/transfers', { person_id: pSel2, from: '1405/07/01', to: '1405/07/30', cost_center_id: cc });
    ok(t2.status === 200 && t2.data.target === 'voucher' && t2.data.amount_rial === 30600 && /^CMT-\d{4}$/.test(t2.data.doc_no), 'non-employee → voucher transfer 30,600', t2);
    const je = t2.data && q1('SELECT * FROM journal_entries WHERE id=?', t2.data.je_id);
    ok(je && je.status === 'draft', 'JE is draft (not auto-posted)', je && je.status);
    const jl = je ? qa('SELECT account_code, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?', je.id) : [];
    const expCode = acct(db, 'coa_rep_commission_expense').code;
    const payCode = acct(db, 'coa_rep_commission_payable').code;
    ok(jl.length === 2 && jl.some((l) => l.account_code === expCode && l.debit_rial === 30600)
      && jl.some((l) => l.account_code === payCode && l.credit_rial === 30600), 'Dr commission expense / Cr person payable 30,600', jl);
    r = await api('POST', '/api/commissions/transfers', { person_id: pSel2, from: '1405/07/01', to: '1405/07/30' });
    ok(r.status === 409 && r.data.code === 'E_COMMISSION_DUP', 'double transfer of same period rejected', r);
    r = await api('POST', `/api/commissions/rules/${sel2Rule.data.id}/deactivate`);
    ok(r.status === 409 && r.data.code === 'E_COMMISSION_LOCKED', 'rule locked while transferred', r);
    r = await api('PUT', `/api/commissions/invoice-parties/${inv1}`, { parties: [{ person_id: pSel1, role: 'seller', share_pct: 100 }] });
    ok(r.status === 409 && r.data.code === 'E_COMMISSION_LOCKED', 'invoice parties locked while transferred', r);
    const noPay = q1("SELECT COUNT(*) c FROM journal_entries WHERE ref_type LIKE '%payment%' AND ref_id=?", t2.data.id).c;
    ok(noPay === 0, 'no automatic payment created');

    console.log('— R13 void of voucher transfer —');
    r = await api('POST', `/api/commissions/transfers/${t2.data.id}/void`, { reason: 'تست' });
    ok(r.status === 200 && r.data.status === 'void', 'voucher transfer voided', r);
    const jeAfter = q1('SELECT status, deleted_at FROM journal_entries WHERE id=?', t2.data.je_id);
    ok(jeAfter && (jeAfter.status === 'reversed' || Number(jeAfter.deleted_at) > 0), 'draft JE soft-voided', jeAfter);
    ok(q1('SELECT COUNT(*) c FROM commission_transfers WHERE id=?', t2.data.id).c === 1, 'no physical delete');
    r = await api('POST', `/api/commissions/rules/${sel2Rule.data.id}/deactivate`);
    ok(r.status === 200 && Number(r.data.active) === 0, 'rule deactivate allowed after void (no physical delete)', r);
    ok(q1('SELECT COUNT(*) c FROM commission_rules WHERE id=?', sel2Rule.data.id).c === 1, 'rule row kept');

    console.log('— transfer: employee → payroll —');
    const periodId = insert('payroll_periods', { fiscal_year: 1405, month_no: 7, label: '1405/07', start_date: '1405/07/01', end_date: '1405/07/30', status: 'open' });
    r = await api('POST', '/api/commissions/transfers', { person_id: pSel1, from: '1405/07/01', to: '1405/07/30' });
    ok(r.status === 400 && r.data.code === 'E_PAYROLL_PERIOD', 'payroll period required for employee', r);
    const t1 = await api('POST', '/api/commissions/transfers', { person_id: pSel1, from: '1405/07/01', to: '1405/07/30', payroll_period_id: periodId });
    ok(t1.status === 200 && t1.data.target === 'payroll' && t1.data.status === 'pending' && t1.data.amount_rial === 43250 && !t1.data.je_id,
      'employee → pending payroll row 43,250 (no separate JE)', t1);

    const calc = await api('POST', '/api/payroll/calculate', { person_id: pSel1, period_id: periodId, working_days_x100: 3000, regular_hours_x100: 0, overtime_hours_x100: 0, night_shift_hours_x100: 0, hardship_allowance_rial: 0, other_allowance_rial: 0, other_deductions_rial: 0, commission_rial: 999999 });
    ok(calc.status === 200 && calc.data.calculation.commission_rial === 43250 && calc.data.commission_pending_rial === 43250, 'payroll preview pulls commission from transfer (client value ignored)', calc.data);

    // engine: commission is taxable + insurable
    const baseCtx = {
      structure: { wage_basis: 'monthly', base_wage_rial: 100000000, housing_allowance_rial: 0, grocery_allowance_rial: 0, child_allowance_rial: 0, spouse_allowance_rial: 0, other_fixed_allowance_rial: 0, child_count: 0, marital_status: 0, insurance_type: 'sso', tax_exemption_percent_bp: 0 },
      period: { standard_days: 30, employee_insurance_bp: 700, employer_insurance_bp: 2300 },
      brackets: [{ bracket_order: 1, bracket_min_rial: 0, bracket_max_rial: null, tax_rate_bp: 1000 }],
    };
    const inp = { working_days_x100: 3000, regular_hours_x100: 0, overtime_hours_x100: 0, night_shift_hours_x100: 0, hardship_allowance_rial: 0, other_allowance_rial: 0, other_deductions_rial: 0 };
    const c0 = calculatePayroll({ ...baseCtx, input: inp });
    const c1 = calculatePayroll({ ...baseCtx, input: { ...inp, commission_rial: 1000000 } });
    ok(c1.gross_earnings_rial - c0.gross_earnings_rial === 1000000, 'engine: commission in gross');
    ok(c1.insurance_base_rial - c0.insurance_base_rial === 1000000, 'engine: commission insurable');
    ok(c1.taxable_income_rial > c0.taxable_income_rial && c1.income_tax_rial > c0.income_tax_rial, 'engine: commission taxable');

    const proc = await api('POST', '/api/payroll/process', { period_id: periodId, rows: [{ person_id: pSel1, working_days_x100: 3000, regular_hours_x100: 0, overtime_hours_x100: 0, night_shift_hours_x100: 0, hardship_allowance_rial: 0, other_allowance_rial: 0, other_deductions_rial: 0, cost_center_id: cc }] });
    ok(proc.status === 200 && proc.data.records && proc.data.records[0].commission_rial === 43250, 'payroll processed with commission row', proc.data);
    const recId = proc.data && proc.data.records && proc.data.records[0].id;
    const rec = recId ? q1('SELECT commission_rial, gross_earnings_rial FROM payroll_records WHERE id=?', recId) : null;
    ok(rec && rec.commission_rial === 43250, 'payroll_records.commission_rial stored', rec);
    const tAfter = q1('SELECT status, payroll_record_id FROM commission_transfers WHERE id=?', t1.data.id);
    ok(tAfter.status === 'in_payroll' && tAfter.payroll_record_id === recId, 'transfer consumed by payroll record', tAfter);
    r = await api('POST', `/api/commissions/transfers/${t1.data.id}/void`, {});
    ok(r.status === 409 && r.data.code === 'E_IN_PAYROLL', 'cannot void transfer while in processed payroll', r);

    console.log('— payroll void releases commission (R13 cascade) —');
    r = await api('POST', `/api/payroll/${recId}/void`, {});
    ok(r.status === 200, 'payroll record voided', r);
    const tRel = q1('SELECT status, payroll_record_id FROM commission_transfers WHERE id=?', t1.data.id);
    ok(tRel.status === 'pending' && tRel.payroll_record_id == null, 'commission back to pending after payroll void', tRel);
    r = await api('POST', `/api/commissions/transfers/${t1.data.id}/void`, { reason: 'اصلاح' });
    ok(r.status === 200 && r.data.status === 'void', 'pending payroll transfer voided', r);
    const calc2 = await api('POST', '/api/payroll/calculate', { person_id: pSel1, period_id: periodId, working_days_x100: 3000, regular_hours_x100: 0, overtime_hours_x100: 0, night_shift_hours_x100: 0, hardship_allowance_rial: 0, other_allowance_rial: 0, other_deductions_rial: 0 });
    ok(calc2.status === 200 && calc2.data.calculation.commission_rial === 0, 'voided transfer no longer reaches payroll', calc2.data && calc2.data.calculation && calc2.data.calculation.commission_rial);

    console.log('— permissions —');
    r = await api('GET', '/api/commissions/report?from=1405/07/01&to=1405/07/30', null, 'sales');
    ok(r.status === 403, 'sales rep cannot read the commission admin report', r.status);
    r = await api('POST', '/api/commissions/rules', { person_id: pSel1, role: 'seller', scope: 'product', scope_id: prodA, pct: 50 }, 'sales');
    ok(r.status === 403, 'sales rep cannot create rules', r.status);

    ok(q1("SELECT value FROM settings WHERE key='ledger_leaf_enforcement'")?.value === leafBefore, 'ledger_leaf_enforcement untouched');
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
