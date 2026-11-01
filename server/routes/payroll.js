const router = require('express').Router();
const { getDB, audit, createPersonLedgerEntry, resolveCashAccount } = require('../db');
const { acct: coaAcct } = require('../lib/coa-map');
const { postToLedger } = require('../lib/ledger');
const { rialToLedger } = require('../lib/money');
const { calculatePayroll } = require('../lib/payroll/engine');
const { buildInsuranceListCsv, buildTaxDraftCsv } = require('../lib/payroll/export-legal');
const {
  buildPayrollParamsSnapshot,
  savePeriodParamsSnapshot,
  loadPeriodParamsSnapshot,
} = require('../lib/payroll/schema');
const {
  resolveActiveRuling,
  assertRulingDatesAllowed,
  assertRulingMutable,
  computeArrearsMonths,
  personHasPayrollInMonth,
} = require('../lib/payroll/rulings');
const {
  postPayrollPayments,
  voidAllPayrollPayments,
  voidOnePayrollPayment,
  enrichPayrollRow,
  remainingRial,
  sumPaidRial,
} = require('../lib/payroll/payments');
const { resolvePersonPayableAccount } = require('../lib/payroll/person-account');
const { assertExpenseDocumentCostCenter } = require('../lib/cost-center-policy');
const {
  buildManualExemptCalc,
  assertLaborPathAllowed,
  minWageWarning,
} = require('../lib/payroll/manual-exempt');
const { voidPayrollAccrual } = require('../lib/payroll/void-accrual');
const { seedLegalPack, legalPackForYear, insuranceCapMonthly } = require('../lib/payroll/legal-pack');
const {
  remittanceBalances,
  postRemittance,
  voidRemittance,
  listRemittances,
} = require('../lib/payroll/remittance');
const {
  listAdvances,
  issueAdvance,
  voidAdvance,
  personAdvanceBalance,
  allocateAdvanceRecovery,
  applyAdvanceRecoveries,
} = require('../lib/payroll/advances');
const {
  listLoans,
  listLoanInstallments,
  issueLoan,
  voidLoan,
  personLoanBalance,
  dueInstallmentRial,
  allocateLoanRecovery,
  applyLoanRecoveries,
} = require('../lib/payroll/loans');
const { postYearEndWithReserveRelease, sumUnreleased } = require('../lib/payroll/year-end-post');
const {
  postMonthlyLeaveAccrual,
  leaveBalanceRial,
  cashOutLeave,
  voidLeaveAccrual,
  ensureLeaveAccrualSchema,
} = require('../lib/payroll/leave-accrual');
const { auth, adminOrAccounting, requirePermission } = require('../middleware/auth');
const { pendingPayrollCommission, markConsumedByPayroll } = require('../lib/commissions-multi');
const { todayJalali } = require('../jalali');
const { createSecureUpload } = require('../lib/upload-policy');
const {
  parseFarankenouBuffer,
  calcPayrollFromAttendance,
  matchPerson
} = require('../lib/farankenou');

const lwteUpload = createSecureUpload('lwte');

function coercePersonTaxExemption(b, current) {
  const raw = String(b.tax_exemption_type ?? current?.tax_exemption_type ?? 'none');
  const flagged = Number(b.is_tax_exempt ?? current?.is_tax_exempt) === 1 || raw === 'tax_exempt';
  const allowed = ['none', 'tax_exempt', 'veteran', 'petroleum_zones'];
  const type = flagged ? 'tax_exempt' : (allowed.includes(raw) ? raw : 'none');
  return { tax_exemption_type: type, is_tax_exempt: flagged ? 1 : 0 };
}

// Legacy hourly payroll — Persons category "کارمند". Accrual JE (R13-aligned with /process):
//   Dr 6104 هزینه حقوق              = gross
//   Cr تفصیلی شخص                   = net
//   Cr 2105 بیمه پرداختنی           = employee SSO
//   Cr 2106 مالیات حقوق پرداختنی    = tax withheld
//   Cr 2108 سایر کسورات حقوق        = other deductions

function createPayrollRecord(db, userId, data) {
  const {
    person_id, period_label, regular_hours, overtime_hours, hourly_rate, overtime_rate,
    bonuses, deductions, insurance_deduction, tax_deduction, date, note, cost_center_id
  } = data;

  const person = db.prepare('SELECT * FROM persons WHERE id=?').get(person_id);
  if (!person) throw new Error('شخص یافت نشد');
  const ccId = assertExpenseDocumentCostCenter(db, {
    cost_center_id,
    section: 'payroll',
  });

  const regH = parseFloat(regular_hours) || 0;
  const otH = parseFloat(overtime_hours) || 0;
  const hRate = parseFloat(hourly_rate) || 0;
  const otRate = parseFloat(overtime_rate) || 0;
  const bon = parseFloat(bonuses) || 0;
  const ded = parseFloat(deductions) || 0;
  const ins = parseFloat(insurance_deduction) || 0;
  const tax = parseFloat(tax_deduction) || 0;
  const grossPay = regH * hRate + otH * otRate + bon;
  const netPay = grossPay - ded - ins - tax;
  if (netPay < 0) throw new Error('مجموع کسورات از حقوق ناخالص بیشتر است');

  const dup = db.prepare(
    "SELECT id FROM payroll_records WHERE person_id=? AND period_label=? AND paid=0 AND COALESCE(status,'posted')<>'reversed'"
  ).get(person_id, period_label || '');
  if (dup) throw new Error(`حقوق دوره ${period_label || ''} برای ${person.name} قبلاً ثبت شده (پرداخت‌نشده)`);

  return db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO payroll_records (person_id,period_label,regular_hours,overtime_hours,hourly_rate,overtime_rate,bonuses,deductions,insurance_deduction,tax_deduction,gross_pay,net_pay,date,note,created_by,cost_center_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(person_id, period_label || '', regH, otH, hRate, otRate, bon, ded, ins, tax, grossPay, netPay, date || todayJalali(), note || '', userId, ccId);
    const recId = result.lastInsertRowid;

    const payable = resolvePersonPayableAccount(db, person);
    const lines = [
      { ...coaAcct(db,'coa_payroll_expense'), debit: rialToLedger(grossPay), credit: 0, cost_center_id: ccId, description: `حقوق ${person.name} - ${period_label || ''}` },
      { code: payable.code, name: payable.name, debit: 0, credit: rialToLedger(netPay) },
    ];
    if (ins > 0) lines.push({ ...coaAcct(db, 'coa_sso_payable'), debit: 0, credit: rialToLedger(ins) });
    if (tax > 0) lines.push({ ...coaAcct(db, 'coa_payroll_tax_payable'), debit: 0, credit: rialToLedger(tax) });
    if (ded > 0) lines.push({ ...coaAcct(db, 'coa_payroll_other_deductions'), debit: 0, credit: rialToLedger(ded) });
    const journalId = postToLedger(db, {
      sourceType: 'payroll', sourceId: recId, date: date || todayJalali(),
      description: `حقوق ${person.name} (${period_label || ''})`,
      createdBy: userId, costCenterId: ccId, lines
    });
    db.prepare('UPDATE payroll_records SET journal_entry_id=? WHERE id=?').run(journalId, recId);
    createPersonLedgerEntry(db, {
      person_id, date: date || todayJalali(), entry_type: 'payroll', ref_type: 'payroll', ref_id: recId,
      description: `حقوق ${period_label || ''}`, debit: 0, credit: netPay, user_id: userId
    });
    return { recId, grossPay, netPay, person };
  })();
}

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT r.*, p.name as person_name, u.name as recorder
    FROM payroll_records r LEFT JOIN persons p ON r.person_id=p.id LEFT JOIN users u ON r.created_by=u.id
    ORDER BY r.created_at DESC LIMIT 300
  `).all();
  res.json(rows.map((r) => enrichPayrollRow(db, r)));
});

router.post('/', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const { recId, grossPay, netPay, person } = createPayrollRecord(db, req.user.id, req.body);
    audit(req.user.id, 'create', 'payroll_record', recId, `ثبت حقوق ${person.name}: خالص ${netPay}`);
    res.json({ id: recId, ok: true, gross_pay: grossPay, net_pay: netPay });
  } catch (e) {
    res.status(400).json({ error: e.message || 'خطا در ثبت حقوق' });
  }
});

// Preview Farankenou .lwte import — match employees and calculate payroll
router.post('/farankenou/preview', auth, adminOrAccounting, lwteUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایل کارکرد (.lwte) الزامی است' });

  const defaultHourly = parseFloat(req.body.default_hourly_rate) || 0;
  const defaultOt = parseFloat(req.body.default_overtime_rate) || 0;
  const insurancePct = parseFloat(req.body.insurance_percent) || 0;
  const taxPct = parseFloat(req.body.tax_percent) || 0;

  let parsed;
  try {
    parsed = parseFarankenouBuffer(req.file.buffer);
  } catch (e) {
    return res.status(400).json({ error: 'فایل قابل خواندن نیست: ' + e.message });
  }
  if (!parsed.length) return res.status(400).json({ error: 'فایل خالی است یا فرمت نادرست دارد' });

  const db = getDB();
  const periodLabel = parsed[0].periodLabel || req.body.period_label || '';
  const periodId = Number(req.body.period_id) || null;

  const rows = parsed.map(row => {
    const person = matchPerson(db, row);
    const calcOpts = {
      hourly_rate: defaultHourly,
      overtime_rate: defaultOt,
      insurance_percent: insurancePct,
      tax_percent: taxPct
    };
    const attendance = person
      ? calcPayrollFromAttendance(row, person, calcOpts)
      : calcPayrollFromAttendance(row, {}, calcOpts);
    let calc = attendance;
    let payrollError = '';
    if (person && periodId) {
      try {
        const context = payrollContext(db, periodId, person.id);
        calc = {
          ...attendance,
          ...calculatePayroll({
            ...context,
            input: {
              working_days_x100: Math.round((Number(row.monthPresentDays) || 0) * 100),
              regular_hours_x100: Math.round((Number(attendance.regular_hours) || 0) * 100),
              overtime_hours_x100: Math.round((Number(attendance.overtime_hours) || 0) * 100),
              night_shift_hours_x100: Math.round((Number(row.nightHours) || Number(attendance.night_hours) || 0) * 100),
              friday_hours_x100: Math.round((Number(row.fridayHours) || Number(attendance.friday_hours) || 0) * 100),
              shift_hours_x100: Math.round((Number(row.shiftHours) || 0) * 100),
              absence_days_x100: Math.round((Number(row.absenceDays) || 0) * 100),
              unpaid_leave_days_x100: Math.round((Number(row.unpaidLeaveDays) || 0) * 100),
              hardship_allowance_rial: 0, other_allowance_rial: 0,
              mission_allowance_rial: 0, production_bonus_rial: 0,
              insurance_exempt_rial: 0, tax_exemption_rial: 0, other_deductions_rial: 0,
            },
          }),
        };
      } catch (e) {
        payrollError = e.message;
      }
    }

    return {
      line: row.line,
      employee_no: row.employeeNo,
      card_no: row.cardNo,
      full_name: row.fullName,
      period_label: row.periodLabel || periodLabel,
      work_rule: row.workRule,
      work_group: row.workGroup,
      month_present_days: row.monthPresentDays,
      absence_days: row.absenceDays,
      person_id: person ? person.id : null,
      person_name: person ? person.name : null,
      matched: !!person && !payrollError,
      selected: !!person && !payrollError,
      payroll_error: payrollError,
      ...calc,
      note: `ورود از فراننکو — ${row.fullName}`
    };
  });

  const unmatched = rows.filter(r => !r.matched).length;
  res.json({
    period_id: periodId,
    period_label: periodLabel,
    total: rows.length,
    matched: rows.length - unmatched,
    unmatched,
    rows
  });
});

// Commit approved Farankenou rows → payroll records + journal entries
router.post('/farankenou/commit', auth, requirePermission('payroll', 'create'), (req, res) => {
  const { period_label, date, rows } = req.body;
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: 'حداقل یک ردیف برای ثبت انتخاب کنید' });
  }

  const db = getDB();
  const created = [];
  const errors = [];

  for (const row of rows) {
    if (!row.selected || !row.person_id) continue;
    try {
      const { recId, grossPay, netPay, person } = createPayrollRecord(db, req.user.id, {
        person_id: row.person_id,
        period_label: row.period_label || period_label || '',
        regular_hours: row.regular_hours,
        overtime_hours: row.overtime_hours,
        hourly_rate: row.hourly_rate,
        overtime_rate: row.overtime_rate,
        bonuses: row.bonuses || 0,
        deductions: row.deductions || 0,
        insurance_deduction: row.insurance_deduction || 0,
        tax_deduction: row.tax_deduction || 0,
        date: date || todayJalali(),
        note: row.note || `ورود از فراننکو — ${row.full_name || person.name}`
      });
      audit(req.user.id, 'create', 'payroll_record', recId, `فراننکو: حقوق ${person.name}`);
      created.push({ id: recId, person_id: row.person_id, person_name: person.name, net_pay: netPay, gross_pay: grossPay });
    } catch (e) {
      errors.push({ person_id: row.person_id, full_name: row.full_name, error: e.message });
    }
  }

  if (!created.length && errors.length) {
    return res.status(400).json({ error: errors[0].error, errors });
  }
  res.json({ ok: true, created: created.length, records: created, errors });
});

function ensurePersonnelPartyGroup(db) {
  let g = db.prepare("SELECT id FROM party_groups WHERE name='پرسنل'").get();
  if (!g) {
    const nextCode = db.prepare('SELECT COALESCE(MAX(code),0)+1 AS c FROM party_groups').get().c;
    g = { id: db.prepare('INSERT INTO party_groups (code,name,entity_type,description) VALUES (?,?,?,?)')
      .run(nextCode, 'پرسنل', 'person', 'اشخاص این گروه در پرونده کارکنان ظاهر می‌شوند').lastInsertRowid };
  }
  return g.id;
}

router.get('/employees', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  ensurePersonnelPartyGroup(db);
  res.json(db.prepare(`
    SELECT p.id, p.name, p.personnel_code, p.employee_no, p.first_name, p.last_name, p.national_id,
           p.insurance_id, p.tax_id, p.employment_type, p.hire_date, p.termination_date,
           p.tax_exemption_type, p.insurance_type, p.department, p.bank_iban, p.active,
           p.party_group_id, p.employee_group_id, p.monthly_salary_rial,
           COALESCE(p.is_tax_exempt,0) AS is_tax_exempt,
           pg.name AS party_group_name, eg.name AS employee_group_name,
           CASE WHEN NULLIF(TRIM(p.personnel_code),'') IS NULL THEN 1 ELSE 0 END AS needs_profile
    FROM persons p
    LEFT JOIN party_groups pg ON pg.id=p.party_group_id
    LEFT JOIN employee_groups eg ON eg.id=p.employee_group_id
    WHERE NULLIF(TRIM(p.personnel_code),'') IS NOT NULL
       OR NULLIF(TRIM(p.employee_no),'') IS NOT NULL
       OR p.employee_group_id IS NOT NULL
       OR (pg.name IS NOT NULL AND pg.name LIKE '%پرسنل%')
       OR (p.party_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM parties pt WHERE pt.id=p.party_id
              AND (pt.party_roles LIKE '%"employee"%' OR pt.party_roles LIKE '%employee%')
          ))
    ORDER BY p.active DESC, p.name
  `).all());
});

router.post('/employees', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const b = req.body || {};
    const personnelCode = String(b.personnel_code || '').trim();
    const firstName = String(b.first_name || '').trim();
    const lastName = String(b.last_name || '').trim();
    const name = `${firstName} ${lastName}`.trim() || String(b.name || '').trim();
    if (!name) throw new Error('نام کارمند الزامی است');
    if (b.national_id && !/^\d{10}$/.test(String(b.national_id))) throw new Error('کد ملی باید ۱۰ رقم باشد');
    if (personnelCode) {
      const exists = db.prepare('SELECT id FROM persons WHERE personnel_code=? OR employee_no=?').get(personnelCode, personnelCode);
      if (exists) throw new Error('کد پرسنلی تکراری است');
    }
    const staffGid = ensurePersonnelPartyGroup(db);
    const tax = coercePersonTaxExemption(b, null);
    const id = db.transaction(() => {
      const newId = db.prepare(`
        INSERT INTO persons
          (name,personnel_code,employee_no,first_name,last_name,national_id,insurance_id,tax_id,
           employment_type,salary_type,hire_date,termination_date,tax_exemption_type,insurance_type,
           department,bank_iban,party_group_id,employee_group_id,monthly_salary_rial,active)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
      `).run(
        name, personnelCode || null, personnelCode || null, firstName, lastName, b.national_id || '',
        b.insurance_id || '', b.tax_id || '', b.employment_type || 'monthly',
        b.employment_type || 'monthly', b.hire_date || '', b.termination_date || null,
        tax.tax_exemption_type, b.insurance_type || 'sso',
        b.department || '', b.bank_iban || '', staffGid,
        b.employee_group_id ? Number(b.employee_group_id) : null,
        Math.max(0, Math.round(Number(b.monthly_salary_rial) || 0))
      ).lastInsertRowid;
      try { db.prepare('UPDATE persons SET is_tax_exempt=? WHERE id=?').run(tax.is_tax_exempt, newId); } catch (_) {}
      try { require('../lib/party-employee-sync').ensurePersonParty(db, newId); } catch (_) {}
      return newId;
    })();
    audit(req.user.id, 'create', 'employee', id, `ایجاد کارمند ${name}`);
    res.json({ ok: true, id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/employees/:id', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const current = db.prepare('SELECT * FROM persons WHERE id=?').get(req.params.id);
    if (!current) return res.status(404).json({ error: 'کارمند یافت نشد' });
    const b = req.body || {};
    const firstName = String(b.first_name ?? current.first_name ?? '').trim();
    const lastName = String(b.last_name ?? current.last_name ?? '').trim();
    const personnelCode = String(b.personnel_code ?? current.personnel_code ?? '').trim();
    const name = `${firstName} ${lastName}`.trim() || current.name;
    if (b.national_id && !/^\d{10}$/.test(String(b.national_id))) throw new Error('کد ملی باید ۱۰ رقم باشد');
    if (personnelCode) {
      const dup = db.prepare('SELECT id FROM persons WHERE (personnel_code=? OR employee_no=?) AND id<>?')
        .get(personnelCode, personnelCode, req.params.id);
      if (dup) throw new Error('کد پرسنلی تکراری است');
    }
    const staffGid = current.party_group_id || ensurePersonnelPartyGroup(db);
    const tax = coercePersonTaxExemption(b, current);
    db.transaction(() => {
      db.prepare(`
        UPDATE persons SET name=?,personnel_code=?,employee_no=?,first_name=?,last_name=?,
          national_id=?,insurance_id=?,tax_id=?,employment_type=?,salary_type=?,hire_date=?,
          termination_date=?,tax_exemption_type=?,insurance_type=?,department=?,bank_iban=?,
          party_group_id=?,employee_group_id=?,monthly_salary_rial=?,active=?
        WHERE id=?
      `).run(
        name, personnelCode || null, personnelCode || null, firstName, lastName,
        b.national_id ?? current.national_id ?? '', b.insurance_id ?? current.insurance_id ?? '',
        b.tax_id ?? current.tax_id ?? '', b.employment_type ?? current.employment_type ?? 'monthly',
        b.employment_type ?? current.employment_type ?? 'monthly', b.hire_date ?? current.hire_date ?? '',
        b.termination_date ?? current.termination_date, tax.tax_exemption_type,
        b.insurance_type ?? current.insurance_type ?? 'sso', b.department ?? current.department ?? '',
        b.bank_iban ?? current.bank_iban ?? '', staffGid,
        b.employee_group_id != null ? (b.employee_group_id ? Number(b.employee_group_id) : null) : current.employee_group_id,
        b.monthly_salary_rial != null ? Math.max(0, Math.round(Number(b.monthly_salary_rial) || 0)) : (current.monthly_salary_rial || 0),
        b.active == null ? current.active : (b.active ? 1 : 0),
        req.params.id
      );
      try { db.prepare('UPDATE persons SET is_tax_exempt=? WHERE id=?').run(tax.is_tax_exempt, req.params.id); } catch (_) {}
      try { require('../lib/party-employee-sync').ensurePersonParty(db, Number(req.params.id)); } catch (_) {}
    })();
    audit(req.user.id, 'update', 'employee', req.params.id, `ویرایش کارمند ${personnelCode || name}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/employees/:id', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const row = db.prepare('SELECT * FROM persons WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'کارمند یافت نشد' });
    const used = db.prepare("SELECT COUNT(*) c FROM payroll_records WHERE person_id=? AND status<>'reversed'").get(req.params.id).c;
    if (used > 0) {
      db.prepare('UPDATE persons SET active=0 WHERE id=?').run(req.params.id);
      audit(req.user.id, 'deactivate', 'employee', req.params.id, `غیرفعال‌سازی کارمند ${row.name}`);
      return res.json({ ok: true, deactivated: true });
    }
    db.prepare('UPDATE persons SET personnel_code=NULL, employee_no=NULL, employee_group_id=NULL, active=0 WHERE id=?').run(req.params.id);
    audit(req.user.id, 'delete', 'employee', req.params.id, `حذف از لیست کارکنان ${row.name}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/employee-groups', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  res.json(db.prepare(`
    SELECT g.*, (SELECT COUNT(*) FROM persons p WHERE p.employee_group_id=g.id AND p.active=1) AS member_count
    FROM employee_groups g ORDER BY g.active DESC, g.name
  `).all());
});

router.post('/employee-groups', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const name = String(req.body?.name || '').trim();
    if (!name) throw new Error('نام گروه الزامی است');
    const id = db.prepare('INSERT INTO employee_groups (name,description,active) VALUES (?,?,1)')
      .run(name, req.body?.description || '').lastInsertRowid;
    audit(req.user.id, 'create', 'employee_group', id, `گروه کارکنان ${name}`);
    res.json({ ok: true, id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/employee-groups/:id', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const row = db.prepare('SELECT * FROM employee_groups WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'گروه یافت نشد' });
    const name = String(req.body?.name ?? row.name).trim();
    if (!name) throw new Error('نام گروه الزامی است');
    db.prepare('UPDATE employee_groups SET name=?,description=?,active=? WHERE id=?').run(
      name, req.body?.description ?? row.description ?? '',
      req.body?.active == null ? row.active : (req.body.active ? 1 : 0), req.params.id
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/employee-groups/:id', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const members = db.prepare('SELECT COUNT(*) c FROM persons WHERE employee_group_id=?').get(req.params.id).c;
    if (members) throw new Error('گروه عضو دارد — ابتدا اعضا را جابه‌جا کنید');
    db.prepare('DELETE FROM group_salary_structures WHERE employee_group_id=?').run(req.params.id);
    db.prepare('DELETE FROM employee_groups WHERE id=?').run(req.params.id);
    audit(req.user.id, 'delete', 'employee_group', req.params.id, 'حذف گروه کارکنان');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/group-salary-structures', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const where = [], params = [];
  if (req.query.fiscal_year) { where.push('s.fiscal_year=?'); params.push(Number(req.query.fiscal_year)); }
  if (req.query.employee_group_id) { where.push('s.employee_group_id=?'); params.push(Number(req.query.employee_group_id)); }
  res.json(db.prepare(`
    SELECT s.*, g.name AS group_name
    FROM group_salary_structures s JOIN employee_groups g ON g.id=s.employee_group_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.fiscal_year DESC, g.name
  `).all(...params));
});

router.post('/group-salary-structures', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const b = req.body || {};
    const gid = Number(b.employee_group_id);
    if (!db.prepare('SELECT id FROM employee_groups WHERE id=?').get(gid)) throw new Error('گروه کارکنان یافت نشد');
    const year = Number(b.fiscal_year);
    if (!Number.isInteger(year)) throw new Error('سال مالی نامعتبر است');
    const money = key => Math.max(0, Math.round(Number(b[key]) || 0));
    db.prepare(`
      INSERT INTO group_salary_structures
        (employee_group_id,fiscal_year,wage_basis,base_wage_rial,housing_allowance_rial,grocery_allowance_rial,
         child_allowance_rial,spouse_allowance_rial,other_fixed_allowance_rial,child_count,marital_status,
         insurance_type,tax_exemption_type,tax_exemption_percent_bp,overtime_factor_bp,
         night_shift_factor_bp,active,effective_from,effective_to,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)
      ON CONFLICT(employee_group_id,fiscal_year) DO UPDATE SET
        wage_basis=excluded.wage_basis,base_wage_rial=excluded.base_wage_rial,
        housing_allowance_rial=excluded.housing_allowance_rial,grocery_allowance_rial=excluded.grocery_allowance_rial,
        child_allowance_rial=excluded.child_allowance_rial,spouse_allowance_rial=excluded.spouse_allowance_rial,
        other_fixed_allowance_rial=excluded.other_fixed_allowance_rial,child_count=excluded.child_count,
        marital_status=excluded.marital_status,insurance_type=excluded.insurance_type,
        tax_exemption_type=excluded.tax_exemption_type,tax_exemption_percent_bp=excluded.tax_exemption_percent_bp,
        overtime_factor_bp=excluded.overtime_factor_bp,night_shift_factor_bp=excluded.night_shift_factor_bp,
        active=1,effective_from=excluded.effective_from,effective_to=excluded.effective_to
    `).run(
      gid, year, b.wage_basis || 'monthly', money('base_wage_rial'), money('housing_allowance_rial'),
      money('grocery_allowance_rial'), money('child_allowance_rial'), money('spouse_allowance_rial'),
      money('other_fixed_allowance_rial'), Math.max(0, Math.round(Number(b.child_count) || 0)),
      b.marital_status ? 1 : 0, b.insurance_type || 'sso', b.tax_exemption_type || 'none',
      Math.round((Number(b.tax_exemption_percent) || 0) * 100),
      Math.round((Number(b.overtime_factor_percent) || 140) * 100),
      Math.round((Number(b.night_shift_factor_percent) || 115) * 100),
      b.effective_from || null, b.effective_to || null, req.user.id
    );
    audit(req.user.id, 'upsert', 'group_salary_structure', gid, `ساختار حقوق گروه ${year}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/group-salary-structures/:id', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    db.prepare('DELETE FROM group_salary_structures WHERE id=?').run(req.params.id);
    audit(req.user.id, 'delete', 'group_salary_structure', req.params.id, 'حذف ساختار حقوق گروه');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/salary-structures/:id', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    db.prepare('UPDATE salary_structures SET active=0 WHERE id=?').run(req.params.id);
    audit(req.user.id, 'delete', 'salary_structure', req.params.id, 'حذف/غیرفعال ساختار حقوق');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/periods/:id', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const period = db.prepare('SELECT * FROM payroll_periods WHERE id=?').get(req.params.id);
    if (!period) return res.status(404).json({ error: 'دوره یافت نشد' });
    const used = db.prepare("SELECT COUNT(*) c FROM payroll_records WHERE period_id=? AND status<>'reversed'").get(req.params.id).c;
    if (used) throw new Error('این دوره دارای رکورد حقوق است و قابل حذف نیست');
    if (period.status === 'closed') throw new Error('دوره بسته‌شده قابل حذف نیست');
    db.prepare('DELETE FROM payroll_periods WHERE id=?').run(req.params.id);
    audit(req.user.id, 'delete', 'payroll_period', req.params.id, `حذف دوره ${period.label}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/tax-brackets/:year', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const year = Number(req.params.year);
    db.prepare('UPDATE payroll_tax_brackets SET active=0 WHERE fiscal_year=?').run(year);
    audit(req.user.id, 'delete', 'payroll_tax_brackets', year, `حذف پلکان مالیات ${year}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/year-end/:id', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const row = db.prepare('SELECT * FROM payroll_year_end_bonuses WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'رکورد یافت نشد' });
    if (row.status !== 'draft') throw new Error('فقط پیش‌نویس قابل حذف است');
    db.prepare('DELETE FROM payroll_year_end_bonuses WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/periods', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const params = [];
  let where = '';
  if (req.query.fiscal_year) { where = 'WHERE fiscal_year=?'; params.push(Number(req.query.fiscal_year)); }
  res.json(db.prepare(`SELECT * FROM payroll_periods ${where} ORDER BY fiscal_year DESC,month_no DESC`).all(...params));
});

router.post('/periods', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const b = req.body || {};
    const year = Number(b.fiscal_year);
    const month = Number(b.month_no);
    if (!Number.isInteger(year) || year < 1300 || year > 1600 || !Number.isInteger(month) || month < 1 || month > 12) {
      throw new Error('سال یا ماه دوره نامعتبر است');
    }
    const label = `${year}/${String(month).padStart(2, '0')}`;
    const id = db.prepare(`
      INSERT INTO payroll_periods
        (fiscal_year,month_no,label,start_date,end_date,standard_days,standard_hours_x100,
         employee_insurance_bp,employer_insurance_bp,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      year, month, label, b.start_date || `${label}/01`, b.end_date || `${label}/${month <= 6 ? '31' : month === 12 ? '29' : '30'}`,
      Math.round(Number(b.standard_days) || 30), Math.round((Number(b.standard_hours) || 220) * 100),
      Math.round((Number(b.employee_insurance_percent ?? 7)) * 100),
      Math.round((Number(b.employer_insurance_percent ?? 23)) * 100), req.user.id
    ).lastInsertRowid;
    audit(req.user.id, 'create', 'payroll_period', id, `ایجاد دوره ${label}`);
    res.json({ ok: true, id, label });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/salary-structures', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const where = [], params = [];
  if (req.query.fiscal_year) { where.push('s.fiscal_year=?'); params.push(Number(req.query.fiscal_year)); }
  if (req.query.person_id) { where.push('s.person_id=?'); params.push(Number(req.query.person_id)); }
  res.json(db.prepare(`
    SELECT s.*,p.name person_name,p.personnel_code
    FROM salary_structures s JOIN persons p ON p.id=s.person_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.fiscal_year DESC,p.name
  `).all(...params));
});

router.post('/salary-structures', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const b = req.body || {};
    const personId = Number(b.person_id);
    const person = db.prepare('SELECT id FROM persons WHERE id=?').get(personId);
    if (!person) throw new Error('کارمند یافت نشد');
    const year = Number(b.fiscal_year);
    if (!Number.isInteger(year)) throw new Error('سال مالی نامعتبر است');
    const money = key => Math.max(0, Math.round(Number(b[key]) || 0));
    const issueDate = b.issue_date || b.effective_from || `${year}/01/01`;
    const effectiveFrom = b.effective_from || issueDate;
    const effectiveTo = b.effective_to || null;
    assertRulingDatesAllowed(db, personId, issueDate, effectiveFrom, null);
    const id = db.prepare(`
      INSERT INTO salary_structures
        (person_id,fiscal_year,wage_basis,base_wage_rial,housing_allowance_rial,grocery_allowance_rial,
         child_allowance_rial,spouse_allowance_rial,other_fixed_allowance_rial,child_count,marital_status,
         insurance_type,tax_exemption_type,tax_exemption_percent_bp,overtime_factor_bp,
         night_shift_factor_bp,active,effective_from,effective_to,issue_date,ruling_no,arrears_note,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)
    `).run(
      personId, year, b.wage_basis || 'monthly', money('base_wage_rial'), money('housing_allowance_rial'),
      money('grocery_allowance_rial'), money('child_allowance_rial'), money('spouse_allowance_rial'),
      money('other_fixed_allowance_rial'), Math.max(0, Math.round(Number(b.child_count) || 0)),
      b.marital_status ? 1 : 0, b.insurance_type || 'sso', b.tax_exemption_type || 'none',
      Math.round((Number(b.tax_exemption_percent) || 0) * 100),
      Math.round((Number(b.overtime_factor_percent) || 140) * 100),
      Math.round((Number(b.night_shift_factor_percent) || 115) * 100),
      effectiveFrom, effectiveTo, issueDate,
      b.ruling_no || null, b.arrears_note || null, req.user.id
    ).lastInsertRowid;
    audit(req.user.id, 'create', 'salary_structure', id, `حکم حقوق ${year} شخص #${personId}`);
    res.json({ ok: true, id });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.put('/salary-structures/:id', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM salary_structures WHERE id=?').get(id);
    if (!existing) return res.status(404).json({ error: 'حکم یافت نشد' });
    assertRulingMutable(db, existing);
    const b = req.body || {};
    const money = key => Math.max(0, Math.round(Number(b[key] != null ? b[key] : existing[key]) || 0));
    const issueDate = b.issue_date || existing.issue_date || existing.effective_from;
    const effectiveFrom = b.effective_from || existing.effective_from || issueDate;
    const effectiveTo = b.effective_to !== undefined ? (b.effective_to || null) : existing.effective_to;
    assertRulingDatesAllowed(db, existing.person_id, issueDate, effectiveFrom, id);
    db.prepare(`
      UPDATE salary_structures SET
        fiscal_year=?, wage_basis=?, base_wage_rial=?, housing_allowance_rial=?, grocery_allowance_rial=?,
        child_allowance_rial=?, spouse_allowance_rial=?, other_fixed_allowance_rial=?, child_count=?,
        marital_status=?, insurance_type=?, tax_exemption_type=?, tax_exemption_percent_bp=?,
        overtime_factor_bp=?, night_shift_factor_bp=?, effective_from=?, effective_to=?,
        issue_date=?, ruling_no=?, arrears_note=?, active=COALESCE(?,active)
      WHERE id=?
    `).run(
      Number(b.fiscal_year) || existing.fiscal_year,
      b.wage_basis || existing.wage_basis,
      money('base_wage_rial'), money('housing_allowance_rial'), money('grocery_allowance_rial'),
      money('child_allowance_rial'), money('spouse_allowance_rial'), money('other_fixed_allowance_rial'),
      Math.max(0, Math.round(Number(b.child_count != null ? b.child_count : existing.child_count) || 0)),
      (b.marital_status != null ? b.marital_status : existing.marital_status) ? 1 : 0,
      b.insurance_type || existing.insurance_type,
      b.tax_exemption_type || existing.tax_exemption_type,
      b.tax_exemption_percent != null
        ? Math.round(Number(b.tax_exemption_percent) * 100)
        : existing.tax_exemption_percent_bp,
      b.overtime_factor_percent != null
        ? Math.round(Number(b.overtime_factor_percent) * 100)
        : existing.overtime_factor_bp,
      b.night_shift_factor_percent != null
        ? Math.round(Number(b.night_shift_factor_percent) * 100)
        : existing.night_shift_factor_bp,
      effectiveFrom, effectiveTo, issueDate,
      b.ruling_no !== undefined ? b.ruling_no : existing.ruling_no,
      b.arrears_note !== undefined ? b.arrears_note : existing.arrears_note,
      b.active != null ? (b.active ? 1 : 0) : null,
      id
    );
    audit(req.user.id, 'update', 'salary_structure', id, 'ویرایش حکم حقوق');
    res.json({ ok: true, id });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.get('/tax-brackets/:year', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  res.json(db.prepare(`
    SELECT * FROM payroll_tax_brackets WHERE fiscal_year=? AND active=1 ORDER BY bracket_order
  `).all(Number(req.params.year)));
});

router.put('/tax-brackets/:year', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const year = Number(req.params.year);
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!rows.length) throw new Error('حداقل یک پله مالیاتی الزامی است');
    db.transaction(() => {
      db.prepare('UPDATE payroll_tax_brackets SET active=0 WHERE fiscal_year=?').run(year);
      const upsert = db.prepare(`
        INSERT INTO payroll_tax_brackets
          (fiscal_year,bracket_order,bracket_min_rial,bracket_max_rial,tax_rate_bp,active,created_by)
        VALUES (?,?,?,?,?,1,?)
        ON CONFLICT(fiscal_year,bracket_order) DO UPDATE SET
          bracket_min_rial=excluded.bracket_min_rial,bracket_max_rial=excluded.bracket_max_rial,
          tax_rate_bp=excluded.tax_rate_bp,active=1
      `);
      let previousMax = 0;
      rows.forEach((row, index) => {
        const min = Math.round(Number(row.bracket_min_rial) || 0);
        const max = row.bracket_max_rial === '' || row.bracket_max_rial == null ? null : Math.round(Number(row.bracket_max_rial));
        if (min < previousMax || (max != null && max <= min)) throw new Error(`بازه پله ${index + 1} نامعتبر است`);
        upsert.run(year, index + 1, min, max, Math.round((Number(row.tax_rate_percent) || 0) * 100), req.user.id);
        previousMax = max == null ? min : max;
      });
    })();
    audit(req.user.id, 'update', 'payroll_tax_brackets', year, `پله‌های مالیات حقوق ${year}`);
    res.json({ ok: true, count: rows.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function payrollContext(db, periodId, personId, opts = {}) {
  const period = db.prepare('SELECT * FROM payroll_periods WHERE id=?').get(periodId);
  if (!period) throw new Error('دوره حقوق یافت نشد');
  if (period.status === 'closed') throw new Error('دوره حقوق بسته است');
  const person = db.prepare('SELECT * FROM persons WHERE id=?').get(personId);
  if (personHasPayrollInMonth(db, personId, period.fiscal_year, period.month_no) && !opts.allowExisting) {
    throw Object.assign(
      new Error(`برای ${person?.name || 'کارمند'} در دوره ${period.label} سند حقوق ثبت شده؛ محاسبه/حکم جدید مجاز نیست`),
      { status: 409, code: 'E_PAYROLL_MONTH_LOCKED' }
    );
  }
  let structure = resolveActiveRuling(db, personId, period);
  if (!structure && person?.employee_group_id) {
    structure = db.prepare(`
      SELECT * FROM group_salary_structures WHERE employee_group_id=? AND fiscal_year=? AND active=1
    `).get(person.employee_group_id, period.fiscal_year);
  }
  if (!structure && person?.monthly_salary_rial > 0) {
    structure = {
      person_id: personId,
      fiscal_year: period.fiscal_year,
      wage_basis: 'monthly',
      base_wage_rial: person.monthly_salary_rial,
      housing_allowance_rial: 0, grocery_allowance_rial: 0, child_allowance_rial: 0,
      spouse_allowance_rial: 0, other_fixed_allowance_rial: 0, child_count: 0, marital_status: 0,
      insurance_type: person.insurance_type || 'sso',
      tax_exemption_type: person.tax_exemption_type || 'none',
      tax_exemption_percent_bp: 0, overtime_factor_bp: 14000, night_shift_factor_bp: 11500, active: 1,
      _synthetic: true,
    };
  }
  if (opts.manual_base_wage_rial > 0) {
    structure = {
      ...(structure || {
        wage_basis: 'monthly', housing_allowance_rial: 0, grocery_allowance_rial: 0,
        child_allowance_rial: 0, spouse_allowance_rial: 0, other_fixed_allowance_rial: 0,
        child_count: 0, marital_status: 0, insurance_type: 'sso', tax_exemption_type: 'none',
        tax_exemption_percent_bp: 0, overtime_factor_bp: 14000, night_shift_factor_bp: 11500, active: 1,
      }),
      base_wage_rial: Math.round(Number(opts.manual_base_wage_rial) || 0),
      wage_basis: 'monthly',
    };
  }
  if (!structure && !opts.manual_mode) throw new Error('ساختار حقوق کارمند برای این سال ثبت نشده است');
  const fullyExempt = Number(person?.is_tax_exempt) === 1
    || String(structure?.tax_exemption_type || person?.tax_exemption_type || '') === 'tax_exempt'
    || Number(structure?.tax_exemption_percent_bp) >= 10000;
  if (structure && fullyExempt) structure = { ...structure, is_tax_exempt: 1, tax_exemption_percent_bp: 10000 };
  if (!opts.manual_mode && !opts.manual_exempt) assertLaborPathAllowed(structure, person);
  let brackets = db.prepare(`
    SELECT * FROM payroll_tax_brackets WHERE fiscal_year=? AND active=1 ORDER BY bracket_order
  `).all(period.fiscal_year);
  // W1-HR1: processed/closed periods prefer immutable snapshot brackets
  if (period.status === 'processed' || period.status === 'closed') {
    const snap = loadPeriodParamsSnapshot(db, period.id);
    if (snap && Array.isArray(snap.brackets) && snap.brackets.length) {
      brackets = snap.brackets;
    }
  }
  const laborSettings = require('../lib/payroll/schema').resolveLaborSettingsForPeriod(db, period);
  const arrearsMonths = structure && !structure._synthetic
    ? computeArrearsMonths(db, personId, structure, period)
    : [];
  return { period, person, structure, brackets, laborSettings, arrearsMonths };
}

/** Snapshot yearly labor params + period rates onto payroll_periods.params_json. */
function snapshotPeriodParams(db, period) {
  const laborSettings = db.prepare('SELECT * FROM payroll_labor_settings WHERE year=?')
    .get(period.fiscal_year) || null;
  const payload = {
    snapshot_at: Math.floor(Date.now() / 1000),
    fiscal_year: period.fiscal_year,
    month_no: period.month_no,
    employee_insurance_bp: period.employee_insurance_bp,
    employer_insurance_bp: period.employer_insurance_bp,
    standard_days: period.standard_days,
    standard_hours_x100: period.standard_hours_x100,
    labor_settings: laborSettings,
  };
  db.prepare('UPDATE payroll_periods SET params_json=? WHERE id=?')
    .run(JSON.stringify(payload), period.id);
  return payload;
}

router.post('/calculate', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const personId = Number(req.body.person_id);
    const manual = !!(req.body.manual_exempt || req.body.manual_mode);
    const context = payrollContext(db, Number(req.body.period_id), personId, {
      manual_mode: manual,
      manual_exempt: manual,
      manual_base_wage_rial: req.body.manual_base_wage_rial,
    });
    const advBalance = personAdvanceBalance(db, personId);
    let advRequest = Math.round(Number(req.body.advance_recovery_rial) || 0);
    const autoAdv = req.body.auto_recover_advance == null
      ? false
      : Number(req.body.auto_recover_advance) === 1;
    if (!advRequest && autoAdv) advRequest = advBalance;
    advRequest = Math.min(Math.max(0, advRequest), advBalance);
    const loanDue = dueInstallmentRial(db, personId, context.period.label);
    const loanBalance = personLoanBalance(db, personId);
    let loanRequest = Math.round(Number(req.body.loan_recovery_rial) || 0);
    // Default ON: installment loans auto-recover unless explicitly disabled
    const autoLoan = req.body.auto_recover_loan == null
      ? true
      : Number(req.body.auto_recover_loan) === 1;
    if (!loanRequest && autoLoan) loanRequest = loanDue;
    loanRequest = Math.min(Math.max(0, loanRequest), loanDue, loanBalance);
    const otherOnly = Math.round(Number(req.body.other_deductions_rial) || 0);
    // Cap recoveries so net does not go negative (esp. manual_exempt)
    if (manual) {
      const grossCap = Math.max(0, Math.round(Number(req.body.gross_earnings_rial) || 0) - otherOnly);
      let room = grossCap;
      advRequest = Math.min(advRequest, room);
      room -= advRequest;
      loanRequest = Math.min(loanRequest, room);
    }
    const pendingComm = pendingPayrollCommission(db, personId, Number(req.body.period_id));
    const inputForCalc = {
      ...req.body,
      other_deductions_rial: otherOnly + advRequest + loanRequest,
      commission_rial: manual ? 0 : pendingComm.amount_rial,
    };
    if (manual) {
      const built = buildManualExemptCalc(inputForCalc);
      return res.json({
        ok: true,
        manual_exempt: true,
        calculation: built.calc,
        exempt: built.meta,
        advance_balance_rial: advBalance,
        advance_recovery_rial: advRequest,
        loan_due_rial: loanDue,
        loan_balance_rial: loanBalance,
        loan_recovery_rial: loanRequest,
        warnings: [],
      });
    }
    const calculation = calculatePayroll({ ...context, input: inputForCalc });
    const warning = minWageWarning(context.structure, context.period, context.laborSettings);
    res.json({
      ok: true,
      calculation,
      advance_balance_rial: advBalance,
      advance_recovery_rial: advRequest,
      loan_due_rial: loanDue,
      loan_balance_rial: loanBalance,
      loan_recovery_rial: loanRequest,
      commission_pending_rial: pendingComm.amount_rial,
      labor_settings: context.laborSettings || null,
      structure: context.structure ? {
        wage_basis: context.structure.wage_basis,
        marital_status: context.structure.marital_status,
        child_count: context.structure.child_count,
        insurance_type: context.structure.insurance_type,
      } : null,
      warnings: warning ? [warning] : [],
    });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.post('/process', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const periodId = Number(req.body.period_id);
    const inputs = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!inputs.length) throw new Error('حداقل یک کارمند برای پردازش انتخاب کنید');
    const warnings = [];
    const created = db.transaction(() => {
      const records = inputs.map(input => {
      const personId = Number(input.person_id);
      const person = db.prepare('SELECT * FROM persons WHERE id=? AND active=1').get(personId);
      if (!person) throw new Error('کارمند فعال یافت نشد');
      const manual = !!(input.manual_exempt || input.manual_mode);
      const context = payrollContext(db, periodId, personId, {
        manual_mode: manual,
        manual_exempt: manual,
        manual_base_wage_rial: input.manual_base_wage_rial,
      });
      const duplicate = db.prepare(`
        SELECT id FROM payroll_records WHERE person_id=? AND period_id=? AND status<>'reversed'
      `).get(personId, periodId);
      if (duplicate) throw new Error(`حقوق ${person.name} در این دوره قبلاً پردازش شده است`);
      const ccId = assertExpenseDocumentCostCenter(db, {
        cost_center_id: input.cost_center_id,
        section: 'payroll',
      });
      const advBalance = personAdvanceBalance(db, personId);
      let advRequest = Math.round(Number(input.advance_recovery_rial) || 0);
      const autoAdv = input.auto_recover_advance == null
        ? false
        : Number(input.auto_recover_advance) === 1;
      if (!advRequest && autoAdv) {
        advRequest = advBalance;
      }
      advRequest = Math.min(Math.max(0, advRequest), advBalance);
      const loanDue = dueInstallmentRial(db, personId, context.period.label);
      const loanBalance = personLoanBalance(db, personId);
      let loanRequest = Math.round(Number(input.loan_recovery_rial) || 0);
      const autoLoan = input.auto_recover_loan == null
        ? true
        : Number(input.auto_recover_loan) === 1;
      if (!loanRequest && autoLoan) {
        loanRequest = loanDue;
      }
      loanRequest = Math.min(Math.max(0, loanRequest), loanDue, loanBalance);
      const otherOnly = Math.round(Number(input.other_deductions_rial) || 0);
      if (manual) {
        const grossCap = Math.max(0, Math.round(Number(input.gross_earnings_rial) || 0) - otherOnly);
        let room = grossCap;
        advRequest = Math.min(advRequest, room);
        room -= advRequest;
        loanRequest = Math.min(loanRequest, room);
      }
      const pendingComm = pendingPayrollCommission(db, personId, periodId);
      if (manual && pendingComm.amount_rial > 0) {
        warnings.push(`${person.name}: پورسانت منتقل‌شده (${pendingComm.amount_rial.toLocaleString('fa-IR')} ریال) در حالت بدون بیمه/مالیات اعمال نشد و در انتظار می‌ماند`);
      }
      const inputForCalc = {
        ...input,
        other_deductions_rial: otherOnly + advRequest + loanRequest,
        commission_rial: manual ? 0 : pendingComm.amount_rial,
      };
      let calc;
      let exemptMeta = null;
      if (manual) {
        const built = buildManualExemptCalc(inputForCalc);
        calc = built.calc;
        exemptMeta = built.meta;
      } else {
        calc = calculatePayroll({ ...context, input: inputForCalc });
        const wageWarning = minWageWarning(context.structure, context.period, context.laborSettings);
        if (wageWarning) warnings.push(`${person.name}: ${wageWarning}`);
      }
      const result = db.prepare(`
        INSERT INTO payroll_records
          (person_id,period_id,period_label,regular_hours,overtime_hours,gross_pay,net_pay,
           insurance_deduction,tax_deduction,date,note,paid,created_by,
           working_days_x100,regular_hours_x100,overtime_hours_x100,night_shift_hours_x100,
           friday_hours_x100,seniority_days_x100,
           base_pay_rial,housing_allowance_rial,grocery_allowance_rial,child_allowance_rial,
           spouse_allowance_rial,hardship_allowance_rial,other_allowance_rial,overtime_pay_rial,
           night_shift_pay_rial,friday_pay_rial,seniority_rial,
           gross_earnings_rial,insurance_base_rial,taxable_income_rial,
           income_tax_rial,sso_employee_rial,sso_employer_rial,other_deductions_rial,
           net_pay_rial,employer_cost_rial,cost_center_id,status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'posted')
      `).run(
        personId, periodId, context.period.label, calc.regular_hours_x100 / 100,
        calc.overtime_hours_x100 / 100, calc.gross_earnings_rial / 10, calc.net_pay_rial / 10,
        calc.sso_employee_rial / 10, calc.income_tax_rial / 10,
        input.date || context.period.end_date,
        input.note || (exemptMeta ? `بدون بیمه و مالیات — ${exemptMeta.reason_label}` : ''),
        0, req.user.id,
        calc.working_days_x100, calc.regular_hours_x100, calc.overtime_hours_x100,
        calc.night_shift_hours_x100, calc.friday_hours_x100 || 0, calc.seniority_days_x100 || 0,
        calc.base_pay_rial, calc.housing_allowance_rial,
        calc.grocery_allowance_rial, calc.child_allowance_rial, calc.spouse_allowance_rial,
        calc.hardship_allowance_rial, calc.other_allowance_rial, calc.overtime_pay_rial,
        calc.night_shift_pay_rial, calc.friday_pay_rial || 0, calc.seniority_rial || 0,
        calc.gross_earnings_rial, calc.insurance_base_rial,
        calc.taxable_income_rial, calc.income_tax_rial, calc.sso_employee_rial,
        calc.sso_employer_rial, calc.other_deductions_rial, calc.net_pay_rial,
        calc.employer_cost_rial, ccId
      );
      const recordId = result.lastInsertRowid;
      const arrearsMonths = context.arrearsMonths || [];
      let arrearsRial = 0;
      if (!exemptMeta && arrearsMonths.length && context.structure && !context.structure._synthetic) {
        // Bundle arrears with this ruling: one month of base package × unpaid months
        const monthlyPkg = (Number(context.structure.base_wage_rial) || 0)
          + (Number(context.structure.housing_allowance_rial) || 0)
          + (Number(context.structure.grocery_allowance_rial) || 0)
          + (Number(context.structure.spouse_allowance_rial) || 0)
          + (Number(context.structure.other_fixed_allowance_rial) || 0)
          + ((Number(context.structure.child_allowance_rial) || 0) * (Number(context.structure.child_count) || 0));
        arrearsRial = monthlyPkg * arrearsMonths.length;
      }
      try {
        db.prepare(`
          UPDATE payroll_records SET
            salary_structure_id=?,
            arrears_rial=?,
            structure_snapshot_json=?
          WHERE id=?
        `).run(
          context.structure?.id || null,
          arrearsRial,
          context.structure ? JSON.stringify(context.structure) : null,
          recordId
        );
      } catch (_) {}
      db.prepare(`
        UPDATE payroll_records SET settlement_mode=?, exempt_reason=?, exempt_note=? WHERE id=?
      `).run(
        exemptMeta ? 'manual_exempt' : 'labor',
        exemptMeta ? exemptMeta.exempt_reason : null,
        exemptMeta ? exemptMeta.exempt_note : null,
        recordId
      );
      try {
        db.prepare(`
          UPDATE payroll_records SET
            shift_hours_x100=?, unpaid_leave_days_x100=?, absence_days_x100=?,
            mission_allowance_rial=?, production_bonus_rial=?, shift_pay_rial=?,
            insurance_exempt_rial=?, sso_employer_base_rial=?, sso_unemployment_rial=?
          WHERE id=?
        `).run(
          calc.shift_hours_x100 || 0,
          calc.unpaid_leave_days_x100 || 0,
          calc.absence_days_x100 || 0,
          calc.mission_allowance_rial || 0,
          calc.production_bonus_rial || 0,
          calc.shift_pay_rial || 0,
          calc.insurance_exempt_rial || 0,
          calc.sso_employer_base_rial || 0,
          calc.sso_unemployment_rial || 0,
          recordId
        );
      } catch (_) { /* columns may be mid-migrate */ }
      if (!manual && calc.commission_rial > 0) {
        db.prepare('UPDATE payroll_records SET commission_rial=? WHERE id=?').run(calc.commission_rial, recordId);
        markConsumedByPayroll(db, pendingComm.ids, recordId);
      }
      const payable = resolvePersonPayableAccount(db, person);
      // Loan/advance recovery applies to BOTH labor and manual_exempt (SSO/tax stay zero on exempt)
      const advAlloc = advRequest > 0
        ? allocateAdvanceRecovery(db, personId, advRequest)
        : { allocated_rial: 0, legs: [] };
      const loanAlloc = loanRequest > 0
        ? allocateLoanRecovery(db, personId, context.period.label, loanRequest)
        : { allocated_rial: 0, legs: [] };
      const recover1119 = (advAlloc.allocated_rial || 0) + (loanAlloc.allocated_rial || 0);
      const otherDedRest = Math.max(0, (calc.other_deductions_rial || 0) - recover1119);
      const lines = [
        { ...coaAcct(db, input.is_direct_labor ? 'coa_labor_control' : 'coa_payroll_expense'), debit: (calc.gross_earnings_rial + arrearsRial) / 10, credit: 0, cost_center_id: ccId },
      ];
      if (!exemptMeta) {
        lines.push({ ...coaAcct(db, 'coa_employer_insurance_expense'), debit: calc.sso_employer_rial / 10, credit: 0, cost_center_id: ccId });
      }
      lines.push({ code: payable.code, name: payable.name, debit: 0, credit: (calc.net_pay_rial + arrearsRial) / 10 });
      if (!exemptMeta) {
        // کارگر ۷٪ + کارفرما ۲۰٪ → ۲۱۰۵؛ بیکاری ۳٪ → ۲۱۱۳ (تفکیک تحلیلی ۱۴۰۵)
        const empSso = calc.sso_employee_rial || 0;
        const empBase = calc.sso_employer_base_rial != null
          ? calc.sso_employer_base_rial
          : Math.round((calc.sso_employer_rial || 0) * 2000 / 2300);
        const unemployment = calc.sso_unemployment_rial != null
          ? calc.sso_unemployment_rial
          : Math.max(0, (calc.sso_employer_rial || 0) - empBase);
        lines.push({ ...coaAcct(db, 'coa_sso_payable'), debit: 0, credit: (empSso + empBase) / 10 });
        if (unemployment > 0) {
          lines.push({ ...coaAcct(db, 'coa_unemployment_payable'), debit: 0, credit: unemployment / 10 });
        }
        lines.push({ ...coaAcct(db, 'coa_payroll_tax_payable'), debit: 0, credit: calc.income_tax_rial / 10 });
      }
      if (recover1119 > 0) {
        lines.push({ ...coaAcct(db, 'coa_employee_advance'), debit: 0, credit: recover1119 / 10 });
      }
      if (otherDedRest > 0) {
        lines.push({ ...coaAcct(db, 'coa_payroll_other_deductions'), debit: 0, credit: otherDedRest / 10 });
      }
      const journalId = postToLedger(db, {
        sourceType: 'payroll', sourceId: recordId, date: input.date || context.period.end_date,
        description: (exemptMeta
          ? `پرداخت بدون بیمه و مالیات (${exemptMeta.reason_label}) ${person.name} (${context.period.label})`
          : `حقوق ${person.name} (${context.period.label})${arrearsRial ? ` + معوقه ${arrearsMonths.length} ماه` : ''}`)
            + (advAlloc.allocated_rial ? ` + تسویه مساعده ${advAlloc.allocated_rial.toLocaleString('fa-IR')}` : '')
            + (loanAlloc.allocated_rial ? ` + قسط وام ${loanAlloc.allocated_rial.toLocaleString('fa-IR')}` : ''),
        createdBy: req.user.id,
        costCenterId: ccId,
        lines, status: 'approved',
      });
      db.prepare('UPDATE payroll_records SET journal_entry_id=? WHERE id=?').run(journalId, recordId);
      if (advAlloc.legs && advAlloc.legs.length) {
        applyAdvanceRecoveries(db, recordId, personId, advAlloc.legs);
      }
      if (loanAlloc.legs && loanAlloc.legs.length) {
        applyLoanRecoveries(db, recordId, loanAlloc.legs);
      }
      createPersonLedgerEntry(db, {
        person_id: personId, date: input.date || context.period.end_date, entry_type: 'payroll',
        ref_type: 'payroll', ref_id: recordId, description: `حقوق ${context.period.label}`,
        debit: 0, credit: (calc.net_pay_rial + arrearsRial) / 10, user_id: req.user.id,
      });
        return {
          id: recordId, person_id: personId, person_name: person.name, ...calc,
          settlement_mode: exemptMeta ? 'manual_exempt' : 'labor',
          exempt_reason: exemptMeta ? exemptMeta.exempt_reason : null,
          journal_entry_id: journalId,
        };
      });
      db.prepare("UPDATE payroll_periods SET status='processed',processed_at=strftime('%s','now') WHERE id=?").run(periodId);
      const periodRow = db.prepare('SELECT * FROM payroll_periods WHERE id=?').get(periodId);
      if (periodRow) {
        const snap = buildPayrollParamsSnapshot(db, periodRow.fiscal_year);
        savePeriodParamsSnapshot(db, periodId, snap);
      }
      return records;
    })();
    created.forEach(row => audit(req.user.id, 'create', 'payroll_record', row.id, `پردازش حقوق ${row.person_name}`));
    res.json({ ok: true, count: created.length, records: created, warnings });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.get('/periods/:id/export/insurance-csv', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const periodId = Number(req.params.id);
    const csv = buildInsuranceListCsv(db, periodId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="payroll-insurance-DRAFT-period-${periodId}.csv"`
    );
    res.send(csv);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/periods/:id/export/tax-csv', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const periodId = Number(req.params.id);
    const csv = buildTaxDraftCsv(db, periodId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="payroll-tax-DRAFT-period-${periodId}.csv"`
    );
    res.send(csv);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/year-end', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const year = Number(req.query.fiscal_year);
  const params = [];
  let where = '';
  if (Number.isInteger(year)) { where = 'WHERE y.fiscal_year=?'; params.push(year); }
  res.json(db.prepare(`
    SELECT y.*,p.name person_name,p.personnel_code
    FROM payroll_year_end_bonuses y JOIN persons p ON p.id=y.person_id
    ${where} ORDER BY y.fiscal_year DESC,p.name
  `).all(...params));
});

router.post('/year-end/calculate', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const year = Number(req.body.fiscal_year);
    const minimumDaily = Math.round(Number(req.body.minimum_daily_wage_rial) || 0);
    const exemptLimit = Math.round(Number(req.body.tax_exempt_bonus_rial) || 0);
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!Number.isInteger(year) || minimumDaily <= 0 || !rows.length) throw new Error('سال، حداقل مزد روزانه و کارکنان الزامی است');
    const brackets = db.prepare(`
      SELECT * FROM payroll_tax_brackets WHERE fiscal_year=? AND active=1 ORDER BY bracket_order
    `).all(year);
    const { calculateProgressiveTax } = require('../lib/payroll/engine');
    const result = db.transaction(() => rows.map(input => {
      const personId = Number(input.person_id);
      const structure = db.prepare(`
        SELECT * FROM salary_structures WHERE person_id=? AND fiscal_year=? AND active=1
      `).get(personId, year);
      if (!structure) throw new Error(`ساختار حقوق کارمند #${personId} موجود نیست`);
      const serviceDays = Math.max(0, Math.min(365, Math.round(Number(input.service_days) || 365)));
      let dailyWage;
      if (structure.wage_basis === 'daily') dailyWage = structure.base_wage_rial;
      else if (structure.wage_basis === 'hourly') dailyWage = Math.round(structure.base_wage_rial * 733 / 100);
      else dailyWage = Math.round(structure.base_wage_rial / 30);
      const eidi = Math.round(Math.min(dailyWage * 60, minimumDaily * 90) * serviceDays / 365);
      const severance = Math.round(dailyWage * 30 * serviceDays / 365);
      const exempt = Math.min(eidi, exemptLimit);
      const taxable = Math.max(0, eidi - exempt);
      const tax = calculateProgressiveTax(taxable, brackets);
      const net = eidi + severance - tax;
      db.prepare(`
        INSERT INTO payroll_year_end_bonuses
          (person_id,fiscal_year,service_days,eidi_rial,severance_rial,tax_exempt_rial,
           taxable_rial,income_tax_rial,net_pay_rial,status,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,'draft',?)
        ON CONFLICT(person_id,fiscal_year) DO UPDATE SET
          service_days=excluded.service_days,eidi_rial=excluded.eidi_rial,
          severance_rial=excluded.severance_rial,tax_exempt_rial=excluded.tax_exempt_rial,
          taxable_rial=excluded.taxable_rial,income_tax_rial=excluded.income_tax_rial,
          net_pay_rial=excluded.net_pay_rial
      `).run(personId, year, serviceDays, eidi, severance, exempt, taxable, tax, net, req.user.id);
      return { person_id: personId, service_days: serviceDays, eidi_rial: eidi, severance_rial: severance, income_tax_rial: tax, net_pay_rial: net };
    }))();
    audit(req.user.id, 'calculate', 'payroll_year_end', year, `محاسبه عیدی و سنوات ${year}`);
    res.json({ ok: true, count: result.length, rows: result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/year-end/:id/post', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const row = db.prepare(`
      SELECT y.*,p.name person_name FROM payroll_year_end_bonuses y JOIN persons p ON p.id=y.person_id WHERE y.id=?
    `).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'رکورد یافت نشد' });
    if (row.status !== 'draft') throw new Error('فقط رکورد پیش‌نویس قابل ثبت است');
    const result = db.transaction(() => {
      const personRow = db.prepare('SELECT * FROM persons WHERE id=?').get(row.person_id);
      return postYearEndWithReserveRelease(db, {
        row,
        person: personRow,
        date: req.body.date || todayJalali(),
        userId: req.user.id,
        createPersonLedgerEntry,
      });
    })();
    audit(req.user.id, 'post', 'payroll_year_end', row.id, `ثبت عیدی و سنوات ${row.person_name}`);
    res.json({ ok: true, journal_entry_id: result.journal_id, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/legal-reports', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const year = Number(req.query.fiscal_year);
  const rows = db.prepare(`
    SELECT r.period_id,r.period_label,p.name person_name,p.personnel_code,p.national_id,p.insurance_id,p.tax_id,
           r.gross_earnings_rial,r.insurance_base_rial,r.sso_employee_rial,r.sso_employer_rial,
           r.taxable_income_rial,r.income_tax_rial,r.net_pay_rial,
           COALESCE(r.settlement_mode,'labor') AS settlement_mode, r.exempt_reason, r.exempt_note
    FROM payroll_records r
    JOIN persons p ON p.id=r.person_id
    LEFT JOIN payroll_periods pp ON pp.id=r.period_id
    WHERE r.status<>'reversed' AND (? IS NULL OR pp.fiscal_year=?)
    ORDER BY r.period_label,p.name
  `).all(Number.isInteger(year) ? year : null, Number.isInteger(year) ? year : null);
  const statutory = rows.filter(row => row.settlement_mode !== 'manual_exempt');
  const exemptRows = rows.filter(row => row.settlement_mode === 'manual_exempt');
  const totals = statutory.reduce((sum, row) => {
    for (const key of ['gross_earnings_rial','insurance_base_rial','sso_employee_rial','sso_employer_rial','taxable_income_rial','income_tax_rial','net_pay_rial']) {
      sum[key] = (sum[key] || 0) + (row[key] || 0);
    }
    return sum;
  }, {});
  res.json({
    fiscal_year: Number.isInteger(year) ? year : null,
    rows: statutory,
    exempt_rows: exemptRows,
    totals,
  });
});

/** List payment legs for one payroll accrual (posted + reversed). */
router.get('/:id/payments', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM payroll_records WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const payments = db.prepare(`
    SELECT pp.*, b.name AS bank_name, cb.name AS cash_box_name
    FROM payroll_payments pp
    LEFT JOIN banks b ON b.id = pp.bank_id
    LEFT JOIN cash_boxes cb ON cb.id = pp.cash_box_id
    WHERE pp.payroll_record_id=?
    ORDER BY pp.id ASC
  `).all(row.id);
  res.json({
    ...enrichPayrollRow(db, row),
    payments,
  });
});

/** Void a single payment leg (R13) — before /:id/* catch-alls. */
router.post('/payments/:paymentId/void', auth, requirePermission('payroll', 'create'), (req, res) => {
  const db = getDB();
  const payment = db.prepare('SELECT * FROM payroll_payments WHERE id=?').get(req.params.paymentId);
  if (!payment) return res.status(404).json({ error: 'پرداخت یافت نشد' });
  try {
    const updated = db.transaction(() =>
      voidOnePayrollPayment(db, payment, req.user.id, createPersonLedgerEntry)
    )();
    audit(req.user.id, 'reverse', 'payroll_payment', payment.id, `ابطال قسط حقوق #${payment.id}`);
    res.json({
      ok: true,
      paid_rial: updated.paid_rial,
      remaining_rial: remainingRial(db, updated),
      paid: !!updated.paid,
      status: updated.status,
    });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

/**
 * Pay wages payable — full, partial, or multi-leg (legs[]).
 * Body: { amount_rial?, pay_type, bank_id, cash_box_id, date, note?, legs?: [...] }
 */
router.post('/:id/pay', auth, requirePermission('payroll', 'create'), (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM payroll_records WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.status === 'reversed') return res.status(400).json({ error: 'این رکورد ابطال شده است' });
  const person = db.prepare('SELECT * FROM persons WHERE id=?').get(row.person_id);
  try {
    const result = db.transaction(() => postPayrollPayments(db, {
      row,
      person,
      body: req.body || {},
      userId: req.user.id,
      resolveCashAccount,
      createPersonLedgerEntry,
    }))();
    audit(
      req.user.id, 'update', 'payroll_record', row.id,
      `پرداخت حقوق ${person ? person.name : ''} — ${result.paid_rial} ریال (مانده ${result.remaining_rial})`
    );
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

/** Reverse all active payment legs (R13) — restores unpaid so accrual can then be voided. */
router.post('/:id/void-payment', auth, requirePermission('payroll', 'create'), (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM payroll_records WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.status === 'reversed') return res.status(400).json({ error: 'این رکورد قبلاً ابطال شده است' });
  const person = db.prepare('SELECT * FROM persons WHERE id=?').get(row.person_id);
  try {
    const updated = db.transaction(() =>
      voidAllPayrollPayments(db, row, req.user.id, createPersonLedgerEntry)
    )();
    audit(req.user.id, 'reverse', 'payroll_payment', row.id, `ابطال همه پرداخت‌های حقوق ${person ? person.name : ''}`);
    res.json({
      ok: true,
      paid_rial: updated.paid_rial || 0,
      remaining_rial: remainingRial(db, updated),
      paid: !!updated.paid,
      status: updated.status,
    });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

/** ابطال همهٔ محاسبات پرداخت‌نشدهٔ یک دوره (R13 — قبل از /:id تا مسیر periods گیر نکند) */
router.delete('/periods/:id/calculations', auth, requirePermission('payroll', 'create'), (req, res) => {
  const db = getDB();
  const period = db.prepare('SELECT * FROM payroll_periods WHERE id=?').get(req.params.id);
  if (!period) return res.status(404).json({ error: 'دوره یافت نشد' });
  if (period.status === 'closed') return res.status(400).json({ error: 'دوره بسته‌شده؛ ابطال محاسبات مجاز نیست' });
  try {
    const result = db.transaction(() => {
      const rows = db.prepare(`
        SELECT * FROM payroll_records
        WHERE period_id=? AND COALESCE(status,'posted')<>'reversed'
      `).all(period.id);
      let voided = 0;
      for (const row of rows) {
        if (row.paid || sumPaidRial(db, row.id) > 0) {
          throw new Error(`رکورد #${row.id} دارای پرداخت فعال است؛ ابتدا ابطال پرداخت کنید`);
        }
        voidPayrollAccrual(db, {
          row,
          userId: req.user.id,
          reason: `ابطال محاسبات دوره ${period.label}`,
          cascadePayments: false,
          allowAlreadyReversed: false,
        });
        voided += 1;
      }
      db.prepare("UPDATE payroll_periods SET status='open', processed_at=NULL WHERE id=?").run(period.id);
      return voided;
    })();
    audit(req.user.id, 'reverse', 'payroll_calculations', period.id, `ابطال ${result} محاسبه دوره ${period.label}`);
    res.json({ ok: true, voided: result, deleted: result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function voidPayrollRecordHttp(req, res) {
  const db = getDB();
  const row = db.prepare('SELECT * FROM payroll_records WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  try {
    const updated = db.transaction(() => voidPayrollAccrual(db, {
      row,
      userId: req.user.id,
      reason: `ابطال سند حقوق #${row.id}`,
      cascadePayments: true,
      allowAlreadyReversed: false,
    }))();
    audit(req.user.id, 'reverse', 'payroll_record', row.id, `ابطال سند حقوق #${row.id}`);
    res.json({ ok: true, status: updated.status, remaining_rial: 0 });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
}

router.post('/:id/void', auth, requirePermission('payroll', 'create'), voidPayrollRecordHttp);
router.delete('/:id', auth, requirePermission('payroll', 'create'), voidPayrollRecordHttp);

// Monthly salary batch — persons with salary_type=monthly
router.post('/monthly-batch', auth, requirePermission('payroll', 'create'), (req, res) => {
  const db = getDB();
  const { period_label, date, person_ids } = req.body;
  const period = period_label || todayJalali().slice(0, 7);
  let employees = db.prepare("SELECT * FROM persons WHERE active=1 AND salary_type='monthly' AND monthly_salary_rial>0").all();
  if (Array.isArray(person_ids) && person_ids.length) {
    const ids = new Set(person_ids.map(Number));
    employees = employees.filter(p => ids.has(p.id));
  }
  const results = [];
  const errors = [];
  for (const p of employees) {
    const grossRial = Math.round(p.monthly_salary_rial || 0);
    const ins = Math.round(grossRial * (p.insurance_percent || 0) / 100);
    const tax = Math.round(grossRial * (p.tax_percent || 0) / 100);
    try {
      const { recId, netPay } = createPayrollRecord(db, req.user.id, {
        person_id: p.id, period_label: period, regular_hours: 0, overtime_hours: 0,
        hourly_rate: 0, overtime_rate: 0, bonuses: grossRial, deductions: 0,
        insurance_deduction: ins, tax_deduction: tax, date: date || todayJalali(),
        note: `حقوق ماهانه ${period}`
      });
      results.push({ person_id: p.id, name: p.name, record_id: recId, net_pay: netPay });
    } catch (e) {
      errors.push({ person_id: p.id, name: p.name, error: e.message });
    }
  }
  res.json({ success: true, data: { period, created: results.length, results, errors } });
});

router.get('/labor-settings/:year', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const year = parseInt(req.params.year, 10);
  const row = db.prepare('SELECT * FROM payroll_labor_settings WHERE year=?').get(year);
  const pack = legalPackForYear(year);
  const defaults = pack ? {
    year,
    min_wage_daily_rial: pack.min_wage_daily_rial,
    housing_allowance_rial: pack.housing_allowance_rial,
    food_allowance_rial: pack.food_allowance_rial,
    child_allowance_rial: pack.child_allowance_rial,
    spouse_allowance_rial: pack.spouse_allowance_rial,
    seniority_base_rial: pack.seniority_base_rial,
    insurance_cap_monthly_rial: insuranceCapMonthly(pack, 30),
    overtime_factor: pack.overtime_factor,
    night_factor: pack.night_factor,
    friday_factor: pack.friday_factor,
    shift_factor: pack.shift_factor,
    tax_exemption_rial: pack.tax_exemption_rial,
    pack_label: pack.label,
    has_legal_pack: true,
  } : { year, has_legal_pack: false };
  res.json(row ? { ...row, has_legal_pack: !!pack, pack_label: pack?.label || null } : defaults);
});

router.put('/labor-settings/:year', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const year = parseInt(req.params.year, 10);
    if (!Number.isInteger(year)) throw new Error('سال نامعتبر است');
    const b = req.body || {};
    const money = k => Math.max(0, Math.round(Number(b[k]) || 0));
    db.prepare(`
      INSERT INTO payroll_labor_settings
        (year, min_wage_daily_rial, housing_allowance_rial, food_allowance_rial, child_allowance_rial,
         spouse_allowance_rial, seniority_base_rial, insurance_cap_monthly_rial, overtime_factor, night_factor, friday_factor,
         shift_factor, tax_exemption_rial)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(year) DO UPDATE SET
        min_wage_daily_rial=excluded.min_wage_daily_rial,
        housing_allowance_rial=excluded.housing_allowance_rial,
        food_allowance_rial=excluded.food_allowance_rial,
        child_allowance_rial=excluded.child_allowance_rial,
        spouse_allowance_rial=excluded.spouse_allowance_rial,
        seniority_base_rial=excluded.seniority_base_rial,
        insurance_cap_monthly_rial=excluded.insurance_cap_monthly_rial,
        overtime_factor=excluded.overtime_factor, night_factor=excluded.night_factor,
        friday_factor=excluded.friday_factor, shift_factor=excluded.shift_factor,
        tax_exemption_rial=excluded.tax_exemption_rial
    `).run(
      year, money('min_wage_daily_rial'), money('housing_allowance_rial'), money('food_allowance_rial'),
      money('child_allowance_rial'), money('spouse_allowance_rial'), money('seniority_base_rial'),
      money('insurance_cap_monthly_rial'),
      Number(b.overtime_factor) || 1.4, Number(b.night_factor) || 1.35,
      Number(b.friday_factor) || 1.4, Number(b.shift_factor) || 1.225, money('tax_exemption_rial')
    );
    audit(req.user.id, 'update', 'payroll_labor_settings', year, `تنظیمات کار ${year}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Seed canonical legal pack (labor floors + tax brackets) for a fiscal year. */
router.post('/legal-pack/:year/seed', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const year = parseInt(req.params.year, 10);
    const force = !!(req.body && req.body.force);
    const result = seedLegalPack(db, year, { force });
    if (!result.seeded) {
      return res.status(400).json({ error: result.error || 'بسته قانونی موجود نیست' });
    }
    audit(req.user.id, 'seed', 'payroll_legal_pack', year, `بسته قانونی ${year}${force ? ' (بازنویسی)' : ''}`);
    res.json({ ok: true, ...result, labor: result.labor, pack: undefined });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/legal-pack/:year', auth, adminOrAccounting, (req, res) => {
  const year = parseInt(req.params.year, 10);
  const pack = legalPackForYear(year);
  if (!pack) return res.status(404).json({ error: `بسته قانونی سال ${year} تعریف نشده` });
  res.json({
    year,
    ...pack,
    insurance_cap_monthly_rial: insuranceCapMonthly(pack, 30),
  });
});

function monthlyAccrualAmounts(db, personId, year, laborSettings) {
  const structure = db.prepare(`
    SELECT * FROM salary_structures WHERE person_id=? AND fiscal_year=? AND active=1
  `).get(personId, year);
  const person = db.prepare('SELECT * FROM persons WHERE id=?').get(personId);
  let dailyWage = 0;
  if (structure) {
    if (structure.wage_basis === 'daily') dailyWage = structure.base_wage_rial;
    else if (structure.wage_basis === 'hourly') dailyWage = Math.round(structure.base_wage_rial * 733 / 100);
    else dailyWage = Math.round(structure.base_wage_rial / 30);
  } else if (person?.monthly_salary_rial) {
    dailyWage = Math.round(person.monthly_salary_rial / 30);
  }
  if (dailyWage <= 0) return null;

  const minDaily = laborSettings?.min_wage_daily_rial || dailyWage;
  const annualSeverance = Math.round(dailyWage * 30);
  const annualEidi = Math.round(Math.min(dailyWage * 60, minDaily * 90));
  return {
    severance_rial: Math.round(annualSeverance / 12),
    eidi_rial: Math.round(annualEidi / 12),
  };
}

router.get('/remittances/balances', auth, adminOrAccounting, (req, res) => {
  try {
    res.json({ ok: true, ...remittanceBalances(getDB()) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/remittances', auth, adminOrAccounting, (req, res) => {
  try {
    res.json(listRemittances(getDB(), { kind: req.query.kind, limit: req.query.limit }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/remittances', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const result = db.transaction(() => postRemittance(db, {
      kind: req.body.kind,
      amount_rial: req.body.amount_rial,
      pay_type: req.body.pay_type,
      bank_id: req.body.bank_id,
      cash_box_id: req.body.cash_box_id,
      date: req.body.date,
      note: req.body.note,
      period_label: req.body.period_label,
      userId: req.user.id,
      resolveCashAccount,
    }))();
    audit(req.user.id, 'create', 'payroll_remittance', result.id, `${result.kind} ${result.amount_rial}`);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.post('/remittances/:id/void', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const result = db.transaction(() => voidRemittance(db, Number(req.params.id), req.user.id))();
    audit(req.user.id, 'void', 'payroll_remittance', result.id, 'ابطال پرداخت بیمه/مالیات');
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.get('/advances', auth, adminOrAccounting, (req, res) => {
  try {
    res.json(listAdvances(getDB(), {
      person_id: req.query.person_id,
      limit: req.query.limit,
    }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/advances/balance/:personId', auth, adminOrAccounting, (req, res) => {
  try {
    const personId = Number(req.params.personId);
    res.json({ ok: true, person_id: personId, balance_rial: personAdvanceBalance(getDB(), personId) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/advances', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const result = db.transaction(() => issueAdvance(db, {
      person_id: req.body.person_id,
      amount_rial: req.body.amount_rial,
      pay_type: req.body.pay_type,
      bank_id: req.body.bank_id,
      cash_box_id: req.body.cash_box_id,
      date: req.body.date,
      note: req.body.note,
      userId: req.user.id,
      resolveCashAccount,
      createPersonLedgerEntry,
    }))();
    audit(req.user.id, 'create', 'payroll_advance', result.id, `مساعده ${result.amount_rial}`);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.post('/advances/:id/void', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const result = db.transaction(() => voidAdvance(db, Number(req.params.id), req.user.id, createPersonLedgerEntry))();
    audit(req.user.id, 'void', 'payroll_advance', result.id, 'ابطال مساعده');
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.get('/loans', auth, adminOrAccounting, (req, res) => {
  try {
    res.json(listLoans(getDB(), {
      person_id: req.query.person_id,
      limit: req.query.limit,
    }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/loans/due/:personId', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const personId = Number(req.params.personId);
    const periodLabel = String(req.query.period_label || '').trim();
    res.json({
      ok: true,
      person_id: personId,
      due_rial: dueInstallmentRial(db, personId, periodLabel),
      balance_rial: personLoanBalance(db, personId),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/loans/:id/installments', auth, adminOrAccounting, (req, res) => {
  try {
    res.json(listLoanInstallments(getDB(), Number(req.params.id)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/loans', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const result = issueLoan(db, {
      person_id: req.body.person_id,
      principal_rial: req.body.principal_rial,
      installment_count: req.body.installment_count,
      start_period_label: req.body.start_period_label,
      pay_type: req.body.pay_type,
      bank_id: req.body.bank_id,
      cash_box_id: req.body.cash_box_id,
      date: req.body.date,
      note: req.body.note,
      userId: req.user.id,
      resolveCashAccount,
      createPersonLedgerEntry,
    });
    audit(req.user.id, 'create', 'payroll_loan', result.id, `وام ${result.principal_rial}`);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.post('/loans/:id/void', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const result = db.transaction(() => voidLoan(db, Number(req.params.id), req.user.id))();
    audit(req.user.id, 'void', 'payroll_loan', result.id, 'ابطال وام');
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.get('/accruals/monthly', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const period = req.query.period_label;
    const lim = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    if (period) {
      return res.json(db.prepare(`
        SELECT a.*, p.name person_name FROM payroll_monthly_accruals a
        JOIN persons p ON p.id=a.person_id
        WHERE a.period_label=? ORDER BY a.id DESC LIMIT ?
      `).all(period, lim));
    }
    res.json(db.prepare(`
      SELECT a.*, p.name person_name FROM payroll_monthly_accruals a
      JOIN persons p ON p.id=a.person_id
      ORDER BY a.id DESC LIMIT ?
    `).all(lim));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/accruals/unreleased', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const year = Number(req.query.fiscal_year) || Number(String(todayJalali()).slice(0, 4));
    const personId = Number(req.query.person_id) || 0;
    if (personId) {
      return res.json({ ok: true, fiscal_year: year, ...sumUnreleased(db, personId, year) });
    }
    const persons = db.prepare(`
      SELECT DISTINCT person_id FROM payroll_monthly_accruals
      WHERE period_label LIKE ? AND released_year_end_id IS NULL
    `).all(`${year}/%`);
    const rows = persons.map(p => ({ person_id: p.person_id, ...sumUnreleased(db, p.person_id, year) }));
    res.json({ ok: true, fiscal_year: year, rows });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/accruals/monthly', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const periodLabel = req.body.period_label || todayJalali().slice(0, 7);
    const year = parseInt(req.body.year, 10) || parseInt(String(periodLabel).slice(0, 4), 10);
    const laborSettings = db.prepare('SELECT * FROM payroll_labor_settings WHERE year=?').get(year);

    const employees = db.prepare(`
      SELECT id, name FROM persons WHERE active=1
        AND (monthly_salary_rial > 0 OR id IN (SELECT person_id FROM salary_structures WHERE fiscal_year=? AND active=1))
    `).all(year);

    const severanceExp = coaAcct(db, 'coa_severance_expense');
    const eidiExp = coaAcct(db, 'coa_eidi_expense');
    const severancePay = coaAcct(db, 'coa_severance_payable');
    const eidiPay = coaAcct(db, 'coa_eidi_payable');

    const records = db.transaction(() => {
      const out = [];
      let totalSeverance = 0;
      let totalEidi = 0;
      for (const emp of employees) {
        const dup = db.prepare(`
          SELECT id FROM payroll_monthly_accruals WHERE person_id=? AND period_label=?
        `).get(emp.id, periodLabel);
        if (dup) continue;

        const amounts = monthlyAccrualAmounts(db, emp.id, year, laborSettings);
        if (!amounts || (amounts.severance_rial <= 0 && amounts.eidi_rial <= 0)) continue;

        totalSeverance += amounts.severance_rial;
        totalEidi += amounts.eidi_rial;
        out.push({ person_id: emp.id, person_name: emp.name, ...amounts });
      }
      if (!out.length) throw new Error('ردیفی برای ثبت تعهد ماهانه یافت نشد');

      const lines = [];
      if (totalSeverance > 0) {
        lines.push({ ...severanceExp, debit: totalSeverance / 10, credit: 0, debit_rial: totalSeverance });
        lines.push({ ...severancePay, debit: 0, credit: totalSeverance / 10, credit_rial: totalSeverance });
      }
      if (totalEidi > 0) {
        lines.push({ ...eidiExp, debit: totalEidi / 10, credit: 0, debit_rial: totalEidi });
        lines.push({ ...eidiPay, debit: 0, credit: totalEidi / 10, credit_rial: totalEidi });
      }

      const jeId = postToLedger(db, {
        sourceType: 'payroll_monthly_accrual', sourceId: 0,
        date: req.body.date || todayJalali(),
        description: `تعهد ماهانه عیدی و سنوات — ${periodLabel}`,
        createdBy: req.user.id, lines,
      });

      const ins = db.prepare(`
        INSERT INTO payroll_monthly_accruals (period_label, person_id, severance_rial, eidi_rial, je_id, created_by)
        VALUES (?,?,?,?,?,?)
      `);
      for (const row of out) {
        ins.run(periodLabel, row.person_id, row.severance_rial, row.eidi_rial, jeId, req.user.id);
      }
      return { je_id: jeId, rows: out, total_severance_rial: totalSeverance, total_eidi_rial: totalEidi };
    })();

    audit(req.user.id, 'create', 'payroll_monthly_accrual', records.je_id, periodLabel);
    res.json({ ok: true, period_label: periodLabel, ...records });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ——— Wave3: leave reserve + bank salary file ———

router.post('/accruals/leave', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const periodLabel = req.body.period_label || todayJalali().slice(0, 7);
    const year = parseInt(req.body.year, 10) || parseInt(String(periodLabel).slice(0, 4), 10);
    const laborSettings = db.prepare('SELECT * FROM payroll_labor_settings WHERE year=?').get(year);
    const result = postMonthlyLeaveAccrual(db, {
      period_label: periodLabel,
      year,
      date: req.body.date || todayJalali(),
      userId: req.user.id,
      laborSettings,
    });
    audit(req.user.id, 'create', 'payroll_leave_accrual', result.je_id, periodLabel);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

router.get('/accruals/leave', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    ensureLeaveAccrualSchema(db);
    const lim = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const period = String(req.query.period_label || '').trim();
    if (period) {
      return res.json(db.prepare(`
        SELECT a.*, p.name person_name FROM payroll_leave_accruals a
        JOIN persons p ON p.id=a.person_id
        WHERE a.period_label=? ORDER BY a.id DESC LIMIT ?
      `).all(period, lim));
    }
    res.json(db.prepare(`
      SELECT a.*, p.name person_name FROM payroll_leave_accruals a
      JOIN persons p ON p.id=a.person_id
      ORDER BY a.id DESC LIMIT ?
    `).all(lim));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/accruals/leave/balance/:personId', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const personId = Number(req.params.personId);
    res.json({ ok: true, person_id: personId, balance_rial: leaveBalanceRial(db, personId) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/accruals/leave/cash-out', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const db = getDB();
    const result = cashOutLeave(db, {
      person_id: req.body.person_id,
      amount_rial: req.body.amount_rial,
      date: req.body.date,
      userId: req.user.id,
      resolvePersonPayable: resolvePersonPayableAccount,
    });
    audit(req.user.id, 'create', 'payroll_leave_cashout', result.journal_id, `بازخرید مرخصی ${result.amount_rial}`);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

router.post('/accruals/leave/:id/void', auth, requirePermission('payroll', 'create'), (req, res) => {
  try {
    const result = voidLeaveAccrual(getDB(), Number(req.params.id), req.user.id);
    audit(req.user.id, 'void', 'payroll_leave_accrual', result.id, 'ابطال ذخیره مرخصی');
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

/** Bank salary payment file (CSV) for a processed period — IBAN + net pay. */
router.get('/periods/:id/export/bank-csv', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const periodId = Number(req.params.id);
    const period = db.prepare('SELECT * FROM payroll_periods WHERE id=?').get(periodId);
    if (!period) return res.status(404).json({ error: 'دوره یافت نشد' });
    const rows = db.prepare(`
      SELECT r.id, r.net_pay_rial, r.paid_rial, p.name, p.personnel_code, p.bank_iban
      FROM payroll_records r
      JOIN persons p ON p.id=r.person_id
      WHERE r.period_id=? AND COALESCE(r.status,'posted')<>'reversed'
      ORDER BY p.name
    `).all(periodId);
    const lines = ['personnel_code,name,iban,net_rial,remaining_rial,note'];
    for (const r of rows) {
      const net = Math.round(Number(r.net_pay_rial) || 0);
      const paid = Math.round(Number(r.paid_rial) || 0);
      const remain = Math.max(0, net - paid);
      if (remain <= 0) continue;
      const iban = String(r.bank_iban || '').replace(/,/g, '');
      const name = String(r.name || '').replace(/,/g, ' ');
      const code = String(r.personnel_code || '').replace(/,/g, '');
      lines.push(`${code},${name},${iban},${remain},${remain},salary ${period.label || periodId}`);
    }
    const csv = '\uFEFF' + lines.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="payroll-bank-${periodId}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
