'use strict';
/**
 * Manual-exempt payroll path: no SSO/tax, export exclusion, JE lines.
 * Run: node server/scripts/test-payroll-manual-exempt-v329.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payroll-manual-exempt-v329-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-payroll-manual-exempt-v329-secret!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

const {
  buildManualExemptCalc,
  assertLaborPathAllowed,
} = require('../lib/payroll/manual-exempt');
const { buildInsuranceListCsv, buildTaxDraftCsv } = require('../lib/payroll/export-legal');
const { postToLedger } = require('../lib/ledger');
const { acct } = require('../lib/coa-map');
const { resolvePersonPayableAccount } = require('../lib/payroll/person-account');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra != null ? extra : ''); }
}

function expectCode(fn, code, label) {
  try {
    fn();
    ok(false, label, `expected ${code}`);
  } catch (e) {
    ok(e.code === code, label, e.code || e.message);
  }
}

// --- 1. buildManualExemptCalc contractor + 50M gross ---
const gross = 50_000_000;
const built = buildManualExemptCalc({
  exempt_reason: 'contractor',
  gross_earnings_rial: gross,
  other_deductions_rial: 0,
  working_days: 30,
  regular_hours: 220,
});
ok(built.meta.settlement_mode === 'manual_exempt', 'meta settlement_mode manual_exempt');
ok(built.calc.net_pay_rial === gross, 'net equals gross', built.calc.net_pay_rial);
ok(built.calc.sso_employee_rial === 0 && built.calc.sso_employer_rial === 0, 'sso zero');
ok(built.calc.income_tax_rial === 0, 'tax zero');
ok(built.calc.insurance_base_rial === 0, 'insurance_base zero');

// --- 2–4. validation errors ---
expectCode(
  () => buildManualExemptCalc({ gross_earnings_rial: gross }),
  'E_PAYROLL_EXEMPT_REASON',
  'rejects missing exempt_reason',
);
expectCode(
  () => buildManualExemptCalc({
    exempt_reason: 'other',
    exempt_note: 'کوتاه',
    gross_earnings_rial: gross,
  }),
  'E_PAYROLL_EXEMPT_NOTE',
  'rejects other without note >=8 chars',
);
expectCode(
  () => buildManualExemptCalc({
    exempt_reason: 'contractor',
    gross_earnings_rial: gross,
    sso_employee_rial: 1,
  }),
  'E_PAYROLL_EXEMPT_HAS_STATUTORY',
  'rejects sso_employee_rial>0',
);

// --- 5. assertLaborPathAllowed uninsured ---
expectCode(
  () => assertLaborPathAllowed({ insurance_type: 'none' }, { insurance_type: 'none' }),
  'E_PAYROLL_UNINSURED_LABOR',
  'assertLaborPathAllowed blocks insurance_type none',
);
try {
  assertLaborPathAllowed({ insurance_type: 'sso' }, {});
  ok(true, 'assertLaborPathAllowed allows sso');
} catch (e) {
  ok(false, 'assertLaborPathAllowed allows sso', e.message);
}

// --- 6. process-style JE: expense + payable only (no 2105/2106) ---
const personId = db.prepare(`
  INSERT INTO persons (name, personnel_code, active, insurance_type)
  VALUES ('پیمانکار تست v329', 'V329-EX', 1, 'none')
`).run().lastInsertRowid;
const person = db.prepare('SELECT * FROM persons WHERE id=?').get(personId);

const periodId = db.prepare(`
  INSERT INTO payroll_periods
    (fiscal_year, month_no, label, start_date, end_date, standard_days, standard_hours_x100,
     employee_insurance_bp, employer_insurance_bp, status)
  VALUES (1405, 9, '1405/09', '1405/09/01', '1405/09/30', 30, 22000, 700, 2300, 'open')
`).run().lastInsertRowid;

const procBuilt = buildManualExemptCalc({
  exempt_reason: 'contractor',
  gross_earnings_rial: gross,
  other_deductions_rial: 0,
});
const calc = procBuilt.calc;
const exemptMeta = procBuilt.meta;
const payable = resolvePersonPayableAccount(db, person);
const expenseAcct = acct(db, 'coa_payroll_expense');

const recordId = db.prepare(`
  INSERT INTO payroll_records
    (person_id, period_id, period_label, gross_pay, net_pay, date, paid, created_by, status,
     gross_earnings_rial, net_pay_rial, sso_employee_rial, sso_employer_rial, income_tax_rial,
     insurance_base_rial, settlement_mode, exempt_reason, exempt_note)
  VALUES (?,?,?,?,?,?,0,1,'posted',?,?,0,0,0,0,'manual_exempt',?,?)
`).run(
  personId, periodId, '1405/09',
  calc.gross_earnings_rial / 10, calc.net_pay_rial / 10, '1405/09/30',
  calc.gross_earnings_rial, calc.net_pay_rial,
  exemptMeta.exempt_reason, exemptMeta.exempt_note,
).lastInsertRowid;

const journalId = db.transaction(() => postToLedger(db, {
  sourceType: 'payroll',
  sourceId: recordId,
  date: '1405/09/30',
  description: `پرداخت بدون بیمه و مالیات (${exemptMeta.reason_label}) ${person.name}`,
  createdBy: 1,
  status: 'approved',
  lines: [
    { ...expenseAcct, debit: calc.gross_earnings_rial / 10, credit: 0 },
    { code: payable.code, name: payable.name, debit: 0, credit: calc.net_pay_rial / 10 },
  ],
}))();

db.prepare('UPDATE payroll_records SET journal_entry_id=? WHERE id=?').run(journalId, recordId);

const jeLines = db.prepare(`
  SELECT account_code, debit_rial, credit_rial FROM journal_lines WHERE entry_id=? ORDER BY id
`).all(journalId);
ok(jeLines.length === 2, 'manual exempt JE has exactly 2 lines', jeLines.length);
ok(
  !jeLines.some(l => l.account_code === '2105' || l.account_code === '2106'),
  'no 2105/2106 on manual exempt JE',
  jeLines.map(l => l.account_code),
);
ok(
  jeLines.some(l => l.account_code === expenseAcct.code && Number(l.debit_rial) === gross),
  'expense debit_rial matches gross',
);
ok(
  jeLines.some(l => l.account_code === payable.code && Number(l.credit_rial) === gross),
  'payable credit_rial matches net',
);

// --- 7. export CSV excludes manual_exempt ---
const statPersonId = db.prepare(`
  INSERT INTO persons (name, personnel_code, national_id, tax_id, active)
  VALUES ('کارمند مشمول v329', 'V329-ST', '0011223344', 'TAX-V329', 1)
`).run().lastInsertRowid;

db.prepare(`
  INSERT INTO payroll_records
    (person_id, period_id, period_label, gross_pay, net_pay, date, paid, created_by, status,
     gross_earnings_rial, insurance_base_rial, sso_employee_rial, sso_employer_rial,
     taxable_income_rial, income_tax_rial, net_pay_rial, settlement_mode)
  VALUES (?,?,?,?,?,?,0,1,'posted',?,?,?,?,?,?,?,'labor')
`).run(
  statPersonId, periodId, '1405/09',
  10_000_000, 8_000_000, '1405/09/30',
  100_000_000, 100_000_000, 7_000_000, 23_000_000,
  90_000_000, 5_000_000, 80_000_000,
);

const insuranceCsv = buildInsuranceListCsv(db, periodId);
const taxCsv = buildTaxDraftCsv(db, periodId);
ok(insuranceCsv.includes('excluded_manual_exempt=1'), 'insurance header notes 1 excluded');
ok(taxCsv.includes('excluded_manual_exempt=1'), 'tax header notes 1 excluded');
ok(insuranceCsv.includes('V329-ST'), 'insurance CSV includes statutory personnel');
ok(!insuranceCsv.includes('V329-EX'), 'insurance CSV excludes manual_exempt personnel');
ok(taxCsv.includes('V329-ST'), 'tax CSV includes statutory personnel');
ok(!taxCsv.includes('V329-EX'), 'tax CSV excludes manual_exempt personnel');

const insDataRows = insuranceCsv.split(/\r?\n/).filter(l => l && !l.startsWith('#') && !l.startsWith('period_label'));
ok(insDataRows.length === 1, 'insurance CSV one data row only', insDataRows.length);

try { closeDB(); } catch (_) {}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
