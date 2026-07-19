const router = require('express').Router();
const multer = require('multer');
const { getDB, audit, createPersonLedgerEntry, resolveCashAccount } = require('../db');
const { acct: coaAcct } = require('../lib/coa-map');
const { postToLedger } = require('../lib/ledger');
const { calculatePayroll } = require('../lib/payroll/engine');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');
const {
  parseFarankenouBuffer,
  calcPayrollFromAttendance,
  matchPerson
} = require('../lib/farankenou');

const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

// Hourly payroll — employees are Persons (category "کارمند"). Each record
// accrues the salary as a real double-entry posting:
//   Dr 6104 هزینه حقوق و دستمزد   = gross_pay - deductions
//   Cr 1106 حساب اشخاص متفرقه     = net_pay        (what we now owe the employee)
//   Cr 2104 بدهی بیمه و مالیات    = insurance + tax withheld (owed to the authorities later)

function createPayrollRecord(db, userId, data) {
  const {
    person_id, period_label, regular_hours, overtime_hours, hourly_rate, overtime_rate,
    bonuses, deductions, insurance_deduction, tax_deduction, date, note
  } = data;

  const person = db.prepare('SELECT * FROM persons WHERE id=?').get(person_id);
  if (!person) throw new Error('شخص یافت نشد');

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
    "SELECT id FROM payroll_records WHERE person_id=? AND period_label=? AND paid=0"
  ).get(person_id, period_label || '');
  if (dup) throw new Error(`حقوق دوره ${period_label || ''} برای ${person.name} قبلاً ثبت شده (پرداخت‌نشده)`);

  return db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO payroll_records (person_id,period_label,regular_hours,overtime_hours,hourly_rate,overtime_rate,bonuses,deductions,insurance_deduction,tax_deduction,gross_pay,net_pay,date,note,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(person_id, period_label || '', regH, otH, hRate, otRate, bon, ded, ins, tax, grossPay, netPay, date || todayJalali(), note || '', userId);
    const recId = result.lastInsertRowid;

    const lines = [
      { ...coaAcct(db,'coa_payroll_expense'), debit: grossPay - ded, credit: 0, description: `حقوق ${person.name} - ${period_label || ''}` },
      { ...coaAcct(db,'coa_misc_persons'), debit: 0, credit: netPay }
    ];
    if (ins + tax > 0) {
      lines.push({ ...coaAcct(db,'coa_payroll_payable'), debit: 0, credit: ins + tax });
    }
    postToLedger(db, {
      sourceType: 'payroll', sourceId: recId, date: date || todayJalali(),
      description: `حقوق ${person.name} (${period_label || ''})`,
      createdBy: userId, lines
    });
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
  res.json(rows);
});

router.post('/', auth, adminOrAccounting, (req, res) => {
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
router.post('/farankenou/preview', auth, adminOrAccounting, memUpload.single('file'), (req, res) => {
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
              night_shift_hours_x100: 0,
              hardship_allowance_rial: 0, other_allowance_rial: 0,
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
router.post('/farankenou/commit', auth, adminOrAccounting, (req, res) => {
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

router.get('/employees', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  res.json(db.prepare(`
    SELECT id, name, personnel_code, employee_no, first_name, last_name, national_id,
           insurance_id, tax_id, employment_type, hire_date, termination_date,
           tax_exemption_type, insurance_type, department, bank_iban, active
    FROM persons
    WHERE NULLIF(TRIM(personnel_code),'') IS NOT NULL
       OR NULLIF(TRIM(employee_no),'') IS NOT NULL
    ORDER BY active DESC, name
  `).all());
});

router.post('/employees', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const b = req.body || {};
    const personnelCode = String(b.personnel_code || '').trim();
    const firstName = String(b.first_name || '').trim();
    const lastName = String(b.last_name || '').trim();
    const name = `${firstName} ${lastName}`.trim();
    if (!personnelCode || !name) throw new Error('کد پرسنلی، نام و نام خانوادگی الزامی است');
    if (b.national_id && !/^\d{10}$/.test(String(b.national_id))) throw new Error('کد ملی باید ۱۰ رقم باشد');
    const exists = db.prepare('SELECT id FROM persons WHERE personnel_code=? OR employee_no=?').get(personnelCode, personnelCode);
    if (exists) throw new Error('کد پرسنلی تکراری است');
    const id = db.prepare(`
      INSERT INTO persons
        (name,personnel_code,employee_no,first_name,last_name,national_id,insurance_id,tax_id,
         employment_type,salary_type,hire_date,termination_date,tax_exemption_type,insurance_type,
         department,bank_iban,active)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
    `).run(
      name, personnelCode, personnelCode, firstName, lastName, b.national_id || '',
      b.insurance_id || '', b.tax_id || '', b.employment_type || 'monthly',
      b.employment_type || 'monthly', b.hire_date || '', b.termination_date || null,
      b.tax_exemption_type || 'none', b.insurance_type || 'sso',
      b.department || '', b.bank_iban || ''
    ).lastInsertRowid;
    audit(req.user.id, 'create', 'employee', id, `ایجاد کارمند ${name}`);
    res.json({ ok: true, id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/employees/:id', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const current = db.prepare('SELECT * FROM persons WHERE id=?').get(req.params.id);
    if (!current) return res.status(404).json({ error: 'کارمند یافت نشد' });
    const b = req.body || {};
    const firstName = String(b.first_name ?? current.first_name ?? '').trim();
    const lastName = String(b.last_name ?? current.last_name ?? '').trim();
    const personnelCode = String(b.personnel_code ?? current.personnel_code ?? '').trim();
    if (!personnelCode || !`${firstName} ${lastName}`.trim()) throw new Error('اطلاعات هویتی ناقص است');
    if (b.national_id && !/^\d{10}$/.test(String(b.national_id))) throw new Error('کد ملی باید ۱۰ رقم باشد');
    db.prepare(`
      UPDATE persons SET name=?,personnel_code=?,employee_no=?,first_name=?,last_name=?,
        national_id=?,insurance_id=?,tax_id=?,employment_type=?,salary_type=?,hire_date=?,
        termination_date=?,tax_exemption_type=?,insurance_type=?,department=?,bank_iban=?,active=?
      WHERE id=?
    `).run(
      `${firstName} ${lastName}`.trim(), personnelCode, personnelCode, firstName, lastName,
      b.national_id ?? current.national_id ?? '', b.insurance_id ?? current.insurance_id ?? '',
      b.tax_id ?? current.tax_id ?? '', b.employment_type ?? current.employment_type ?? 'monthly',
      b.employment_type ?? current.employment_type ?? 'monthly', b.hire_date ?? current.hire_date ?? '',
      b.termination_date ?? current.termination_date, b.tax_exemption_type ?? current.tax_exemption_type ?? 'none',
      b.insurance_type ?? current.insurance_type ?? 'sso', b.department ?? current.department ?? '',
      b.bank_iban ?? current.bank_iban ?? '', b.active == null ? current.active : (b.active ? 1 : 0),
      req.params.id
    );
    audit(req.user.id, 'update', 'employee', req.params.id, `ویرایش کارمند ${personnelCode}`);
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

router.post('/periods', auth, adminOrAccounting, (req, res) => {
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

router.post('/salary-structures', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const b = req.body || {};
    const person = db.prepare('SELECT id FROM persons WHERE id=?').get(Number(b.person_id));
    if (!person) throw new Error('کارمند یافت نشد');
    const year = Number(b.fiscal_year);
    if (!Number.isInteger(year)) throw new Error('سال مالی نامعتبر است');
    const money = key => Math.max(0, Math.round(Number(b[key]) || 0));
    db.prepare(`
      INSERT INTO salary_structures
        (person_id,fiscal_year,wage_basis,base_wage_rial,housing_allowance_rial,grocery_allowance_rial,
         child_allowance_rial,spouse_allowance_rial,other_fixed_allowance_rial,child_count,marital_status,
         insurance_type,tax_exemption_type,tax_exemption_percent_bp,overtime_factor_bp,
         night_shift_factor_bp,active,effective_from,effective_to,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)
      ON CONFLICT(person_id,fiscal_year) DO UPDATE SET
        wage_basis=excluded.wage_basis,base_wage_rial=excluded.base_wage_rial,
        housing_allowance_rial=excluded.housing_allowance_rial,grocery_allowance_rial=excluded.grocery_allowance_rial,
        child_allowance_rial=excluded.child_allowance_rial,spouse_allowance_rial=excluded.spouse_allowance_rial,
        other_fixed_allowance_rial=excluded.other_fixed_allowance_rial,child_count=excluded.child_count,
        marital_status=excluded.marital_status,insurance_type=excluded.insurance_type,
        tax_exemption_type=excluded.tax_exemption_type,tax_exemption_percent_bp=excluded.tax_exemption_percent_bp,
        overtime_factor_bp=excluded.overtime_factor_bp,night_shift_factor_bp=excluded.night_shift_factor_bp,
        active=1,effective_from=excluded.effective_from,effective_to=excluded.effective_to
    `).run(
      b.person_id, year, b.wage_basis || 'monthly', money('base_wage_rial'), money('housing_allowance_rial'),
      money('grocery_allowance_rial'), money('child_allowance_rial'), money('spouse_allowance_rial'),
      money('other_fixed_allowance_rial'), Math.max(0, Math.round(Number(b.child_count) || 0)),
      b.marital_status ? 1 : 0, b.insurance_type || 'sso', b.tax_exemption_type || 'none',
      Math.round((Number(b.tax_exemption_percent) || 0) * 100),
      Math.round((Number(b.overtime_factor_percent) || 140) * 100),
      Math.round((Number(b.night_shift_factor_percent) || 115) * 100),
      b.effective_from || null, b.effective_to || null, req.user.id
    );
    audit(req.user.id, 'upsert', 'salary_structure', b.person_id, `ساختار حقوق ${year}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/tax-brackets/:year', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  res.json(db.prepare(`
    SELECT * FROM payroll_tax_brackets WHERE fiscal_year=? AND active=1 ORDER BY bracket_order
  `).all(Number(req.params.year)));
});

router.put('/tax-brackets/:year', auth, adminOrAccounting, (req, res) => {
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

function payrollContext(db, periodId, personId) {
  const period = db.prepare('SELECT * FROM payroll_periods WHERE id=?').get(periodId);
  if (!period) throw new Error('دوره حقوق یافت نشد');
  if (period.status === 'closed') throw new Error('دوره حقوق بسته است');
  const structure = db.prepare(`
    SELECT * FROM salary_structures WHERE person_id=? AND fiscal_year=? AND active=1
  `).get(personId, period.fiscal_year);
  if (!structure) throw new Error('ساختار حقوق کارمند برای این سال ثبت نشده است');
  const brackets = db.prepare(`
    SELECT * FROM payroll_tax_brackets WHERE fiscal_year=? AND active=1 ORDER BY bracket_order
  `).all(period.fiscal_year);
  if (!brackets.length) throw new Error('پله‌های مالیات حقوق این سال ثبت نشده است');
  return { period, structure, brackets };
}

router.post('/calculate', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const context = payrollContext(db, Number(req.body.period_id), Number(req.body.person_id));
    res.json({ ok: true, calculation: calculatePayroll({ ...context, input: req.body }) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/process', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const periodId = Number(req.body.period_id);
    const inputs = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!inputs.length) throw new Error('حداقل یک کارمند برای پردازش انتخاب کنید');
    const created = db.transaction(() => {
      const records = inputs.map(input => {
      const personId = Number(input.person_id);
      const person = db.prepare('SELECT * FROM persons WHERE id=? AND active=1').get(personId);
      if (!person) throw new Error('کارمند فعال یافت نشد');
      const context = payrollContext(db, periodId, personId);
      const duplicate = db.prepare(`
        SELECT id FROM payroll_records WHERE person_id=? AND period_id=? AND status<>'reversed'
      `).get(personId, periodId);
      if (duplicate) throw new Error(`حقوق ${person.name} در این دوره قبلاً پردازش شده است`);
      const calc = calculatePayroll({ ...context, input });
      const result = db.prepare(`
        INSERT INTO payroll_records
          (person_id,period_id,period_label,regular_hours,overtime_hours,gross_pay,net_pay,
           insurance_deduction,tax_deduction,date,note,paid,created_by,
           working_days_x100,regular_hours_x100,overtime_hours_x100,night_shift_hours_x100,
           base_pay_rial,housing_allowance_rial,grocery_allowance_rial,child_allowance_rial,
           spouse_allowance_rial,hardship_allowance_rial,other_allowance_rial,overtime_pay_rial,
           night_shift_pay_rial,gross_earnings_rial,insurance_base_rial,taxable_income_rial,
           income_tax_rial,sso_employee_rial,sso_employer_rial,other_deductions_rial,
           net_pay_rial,employer_cost_rial,status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'posted')
      `).run(
        personId, periodId, context.period.label, calc.regular_hours_x100 / 100,
        calc.overtime_hours_x100 / 100, calc.gross_earnings_rial / 10, calc.net_pay_rial / 10,
        calc.sso_employee_rial / 10, calc.income_tax_rial / 10,
        input.date || context.period.end_date, input.note || '', 0, req.user.id,
        calc.working_days_x100, calc.regular_hours_x100, calc.overtime_hours_x100,
        calc.night_shift_hours_x100, calc.base_pay_rial, calc.housing_allowance_rial,
        calc.grocery_allowance_rial, calc.child_allowance_rial, calc.spouse_allowance_rial,
        calc.hardship_allowance_rial, calc.other_allowance_rial, calc.overtime_pay_rial,
        calc.night_shift_pay_rial, calc.gross_earnings_rial, calc.insurance_base_rial,
        calc.taxable_income_rial, calc.income_tax_rial, calc.sso_employee_rial,
        calc.sso_employer_rial, calc.other_deductions_rial, calc.net_pay_rial,
        calc.employer_cost_rial
      );
      const recordId = result.lastInsertRowid;
      const lines = [
        { ...coaAcct(db, input.is_direct_labor ? 'coa_labor_control' : 'coa_payroll_expense'), debit: calc.gross_earnings_rial / 10, credit: 0, cost_center_id: input.cost_center_id || null },
        { ...coaAcct(db, 'coa_employer_insurance_expense'), debit: calc.sso_employer_rial / 10, credit: 0, cost_center_id: input.cost_center_id || null },
        { ...coaAcct(db, 'coa_payroll_payable'), debit: 0, credit: calc.net_pay_rial / 10 },
        { ...coaAcct(db, 'coa_sso_payable'), debit: 0, credit: (calc.sso_employee_rial + calc.sso_employer_rial) / 10 },
        { ...coaAcct(db, 'coa_payroll_tax_payable'), debit: 0, credit: calc.income_tax_rial / 10 },
      ];
      if (calc.other_deductions_rial) {
        lines.push({ ...coaAcct(db, 'coa_payroll_other_deductions'), debit: 0, credit: calc.other_deductions_rial / 10 });
      }
      const journalId = postToLedger(db, {
        sourceType: 'payroll', sourceId: recordId, date: input.date || context.period.end_date,
        description: `حقوق ${person.name} (${context.period.label})`, createdBy: req.user.id,
        lines, status: 'approved',
      });
      db.prepare('UPDATE payroll_records SET journal_entry_id=? WHERE id=?').run(journalId, recordId);
      createPersonLedgerEntry(db, {
        person_id: personId, date: input.date || context.period.end_date, entry_type: 'payroll',
        ref_type: 'payroll', ref_id: recordId, description: `حقوق ${context.period.label}`,
        debit: 0, credit: calc.net_pay_rial / 10, user_id: req.user.id,
      });
        return { id: recordId, person_id: personId, person_name: person.name, ...calc, journal_entry_id: journalId };
      });
      db.prepare("UPDATE payroll_periods SET status='processed',processed_at=strftime('%s','now') WHERE id=?").run(periodId);
      return records;
    })();
    created.forEach(row => audit(req.user.id, 'create', 'payroll_record', row.id, `پردازش حقوق ${row.person_name}`));
    res.json({ ok: true, count: created.length, records: created });
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

router.post('/year-end/calculate', auth, adminOrAccounting, (req, res) => {
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
    if (!brackets.length) throw new Error('پله‌های مالیات این سال ثبت نشده است');
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

router.post('/year-end/:id/post', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const row = db.prepare(`
      SELECT y.*,p.name person_name FROM payroll_year_end_bonuses y JOIN persons p ON p.id=y.person_id WHERE y.id=?
    `).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'رکورد یافت نشد' });
    if (row.status !== 'draft') throw new Error('فقط رکورد پیش‌نویس قابل ثبت است');
    const journalId = db.transaction(() => {
      const lines = [
        { ...coaAcct(db, 'coa_eidi_expense'), debit: row.eidi_rial / 10, credit: 0 },
        { ...coaAcct(db, 'coa_severance_expense'), debit: row.severance_rial / 10, credit: 0 },
        { ...coaAcct(db, 'coa_payroll_payable'), debit: 0, credit: row.net_pay_rial / 10 },
      ];
      if (row.income_tax_rial) lines.push({ ...coaAcct(db, 'coa_payroll_tax_payable'), debit: 0, credit: row.income_tax_rial / 10 });
      const id = postToLedger(db, {
        sourceType: 'payroll_year_end', sourceId: row.id, date: req.body.date || todayJalali(),
        description: `عیدی و سنوات ${row.person_name} سال ${row.fiscal_year}`,
        createdBy: req.user.id, lines,
      });
      db.prepare(`
        UPDATE payroll_year_end_bonuses SET status='posted',journal_entry_id=?,posted_at=strftime('%s','now') WHERE id=?
      `).run(id, row.id);
      createPersonLedgerEntry(db, {
        person_id: row.person_id, date: req.body.date || todayJalali(), entry_type: 'payroll_year_end',
        ref_type: 'payroll_year_end', ref_id: row.id, description: `عیدی و سنوات ${row.fiscal_year}`,
        debit: 0, credit: row.net_pay_rial / 10, user_id: req.user.id,
      });
      return id;
    })();
    audit(req.user.id, 'post', 'payroll_year_end', row.id, `ثبت عیدی و سنوات ${row.person_name}`);
    res.json({ ok: true, journal_entry_id: journalId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/legal-reports', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const year = Number(req.query.fiscal_year);
  const rows = db.prepare(`
    SELECT r.period_label,p.name person_name,p.personnel_code,p.national_id,p.insurance_id,p.tax_id,
           r.gross_earnings_rial,r.insurance_base_rial,r.sso_employee_rial,r.sso_employer_rial,
           r.taxable_income_rial,r.income_tax_rial,r.net_pay_rial
    FROM payroll_records r
    JOIN persons p ON p.id=r.person_id
    LEFT JOIN payroll_periods pp ON pp.id=r.period_id
    WHERE r.status<>'reversed' AND (? IS NULL OR pp.fiscal_year=?)
    ORDER BY r.period_label,p.name
  `).all(Number.isInteger(year) ? year : null, Number.isInteger(year) ? year : null);
  const totals = rows.reduce((sum, row) => {
    for (const key of ['gross_earnings_rial','insurance_base_rial','sso_employee_rial','sso_employer_rial','taxable_income_rial','income_tax_rial','net_pay_rial']) {
      sum[key] = (sum[key] || 0) + (row[key] || 0);
    }
    return sum;
  }, {});
  res.json({ fiscal_year: Number.isInteger(year) ? year : null, rows, totals });
});

router.post('/:id/pay', auth, adminOrAccounting, (req, res) => {
  const { pay_type, bank_id, cash_box_id, date } = req.body;
  const db = getDB();
  const row = db.prepare('SELECT * FROM payroll_records WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.paid) return res.status(400).json({ error: 'این حقوق قبلاً پرداخت شده است' });
  const person = db.prepare('SELECT * FROM persons WHERE id=?').get(row.person_id);

  db.transaction(() => {
    const cash = resolveCashAccount(db, pay_type || 'cash', bank_id, cash_box_id);
    const netRial = Math.round(row.net_pay_rial || (row.net_pay || 0) * 10);
    const paymentJournalId = postToLedger(db, {
      date: date || todayJalali(), description: `پرداخت حقوق ${person ? person.name : ''} (${row.period_label || ''})`,
      sourceType: 'payroll_payment', sourceId: row.id, createdBy: req.user.id,
      lines: [
        { ...coaAcct(db, row.journal_entry_id ? 'coa_payroll_payable' : 'coa_misc_persons'), debit: netRial / 10, credit: 0 },
        { code: cash.code, name: cash.name, debit: 0, credit: netRial / 10 }
      ]
    });
    createPersonLedgerEntry(db, {
      person_id: row.person_id, date: date || todayJalali(), entry_type: 'payroll_payment', ref_type: 'payroll_payment', ref_id: row.id,
      description: `پرداخت حقوق ${row.period_label || ''}`, debit: row.net_pay, credit: 0, user_id: req.user.id
    });
    db.prepare(`
      UPDATE payroll_records SET paid=1,status='paid',payment_journal_id=?,paid_at=strftime('%s','now')
      WHERE id=?
    `).run(paymentJournalId, row.id);
  })();
  audit(req.user.id, 'update', 'payroll_record', row.id, `پرداخت حقوق ${person ? person.name : ''}`);
  res.json({ ok: true });
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM payroll_records WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.paid) return res.status(400).json({ error: 'حقوق پرداخت‌شده ابتدا باید با سند پرداخت معکوس اصلاح شود' });
  if (row.status === 'reversed') return res.status(400).json({ error: 'این رکورد قبلاً ابطال شده است' });
  try {
    const reversalId = db.transaction(() => {
      const entry = db.prepare(`
        SELECT * FROM journal_entries
        WHERE id=COALESCE(?,id) AND ref_type='payroll' AND ref_id=?
        ORDER BY id DESC LIMIT 1
      `).get(row.journal_entry_id || null, row.id);
      if (!entry) throw new Error('سند مبنای حقوق یافت نشد');
      const lines = db.prepare('SELECT * FROM journal_lines WHERE entry_id=? ORDER BY line_no,id').all(entry.id);
      const reversal = postToLedger(db, {
        sourceType: 'payroll_reversal', sourceId: row.id, date: todayJalali(),
        description: `ابطال ${entry.description || `حقوق #${row.id}`}`, createdBy: req.user.id,
        lines: lines.map(line => ({
          code: line.account_code, name: line.account_name,
          debit: (line.credit_rial || Math.round((line.credit || 0) * 10)) / 10,
          credit: (line.debit_rial || Math.round((line.debit || 0) * 10)) / 10,
          description: `معکوس ${line.description || ''}`,
          detail_account_id: line.detail_account_id, cost_center_id: line.cost_center_id,
          project_id: line.project_id, tax_type: line.tax_type,
        })),
        status: 'approved',
      });
      db.prepare("UPDATE journal_entries SET status='reversed' WHERE id=?").run(entry.id);
      db.prepare(`
        UPDATE payroll_records SET status='reversed',reversal_journal_id=?,reversed_at=strftime('%s','now')
        WHERE id=?
      `).run(reversal, row.id);
      createPersonLedgerEntry(db, {
        person_id: row.person_id, date: todayJalali(), entry_type: 'payroll_reversal',
        ref_type: 'payroll_reversal', ref_id: row.id, description: `ابطال حقوق ${row.period_label || ''}`,
        debit: row.net_pay || 0, credit: 0, user_id: req.user.id,
      });
      return reversal;
    })();
    audit(req.user.id, 'reverse', 'payroll_record', row.id, `ابطال رکورد حقوق #${row.id}`);
    res.json({ ok: true, reversal_journal_id: reversalId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Monthly salary batch — persons with salary_type=monthly
router.post('/monthly-batch', auth, adminOrAccounting, (req, res) => {
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
    const grossToman = Math.round((p.monthly_salary_rial || 0) / 10);
    const ins = Math.round(grossToman * (p.insurance_percent || 0) / 100);
    const tax = Math.round(grossToman * (p.tax_percent || 0) / 100);
    try {
      const { recId, netPay } = createPayrollRecord(db, req.user.id, {
        person_id: p.id, period_label: period, regular_hours: 0, overtime_hours: 0,
        hourly_rate: 0, overtime_rate: 0, bonuses: grossToman, deductions: 0,
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

module.exports = router;
