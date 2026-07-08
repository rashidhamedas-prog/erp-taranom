const router = require('express').Router();
const multer = require('multer');
const { getDB, audit, createJournalEntry, createPersonLedgerEntry, resolveCashAccount } = require('../db');
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
      { code: '6104', name: 'هزینه حقوق و دستمزد', debit: grossPay - ded, credit: 0, description: `حقوق ${person.name} - ${period_label || ''}` },
      { code: '1106', name: 'حساب اشخاص متفرقه', debit: 0, credit: netPay }
    ];
    if (ins + tax > 0) {
      lines.push({ code: '2104', name: 'بدهی بیمه و مالیات کارکنان', debit: 0, credit: ins + tax });
    }
    createJournalEntry(db, {
      date: date || todayJalali(),
      description: `حقوق ${person.name} (${period_label || ''})`,
      ref_type: 'payroll', ref_id: recId, created_by: userId, lines
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

  const rows = parsed.map(row => {
    const person = matchPerson(db, row);
    const calcOpts = {
      hourly_rate: defaultHourly,
      overtime_rate: defaultOt,
      insurance_percent: insurancePct,
      tax_percent: taxPct
    };
    const calc = person
      ? calcPayrollFromAttendance(row, person, calcOpts)
      : calcPayrollFromAttendance(row, {}, calcOpts);

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
      matched: !!person,
      selected: !!person,
      ...calc,
      note: `ورود از فراننکو — ${row.fullName}`
    };
  });

  const unmatched = rows.filter(r => !r.matched).length;
  res.json({
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

router.post('/:id/pay', auth, adminOrAccounting, (req, res) => {
  const { pay_type, bank_id, cash_box_id, date } = req.body;
  const db = getDB();
  const row = db.prepare('SELECT * FROM payroll_records WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.paid) return res.status(400).json({ error: 'این حقوق قبلاً پرداخت شده است' });
  const person = db.prepare('SELECT * FROM persons WHERE id=?').get(row.person_id);

  db.transaction(() => {
    const cash = resolveCashAccount(db, pay_type || 'cash', bank_id, cash_box_id);
    createJournalEntry(db, {
      date: date || todayJalali(), description: `پرداخت حقوق ${person ? person.name : ''} (${row.period_label || ''})`,
      ref_type: 'payroll_payment', ref_id: row.id, created_by: req.user.id,
      lines: [
        { code: '1106', name: 'حساب اشخاص متفرقه', debit: row.net_pay, credit: 0 },
        { code: cash.code, name: cash.name, debit: 0, credit: row.net_pay }
      ]
    });
    createPersonLedgerEntry(db, {
      person_id: row.person_id, date: date || todayJalali(), entry_type: 'payroll_payment', ref_type: 'payroll_payment', ref_id: row.id,
      description: `پرداخت حقوق ${row.period_label || ''}`, debit: row.net_pay, credit: 0, user_id: req.user.id
    });
    db.prepare('UPDATE payroll_records SET paid=1 WHERE id=?').run(row.id);
  })();
  audit(req.user.id, 'update', 'payroll_record', row.id, `پرداخت حقوق ${person ? person.name : ''}`);
  res.json({ ok: true });
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM payroll_records WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.paid) return res.status(400).json({ error: 'این حقوق پرداخت شده و قابل حذف نیست' });
  db.transaction(() => {
    db.prepare("DELETE FROM person_ledger WHERE ref_type='payroll' AND ref_id=?").run(row.id);
    const entry = db.prepare("SELECT id FROM journal_entries WHERE ref_type='payroll' AND ref_id=?").get(row.id);
    if (entry) {
      db.prepare('DELETE FROM journal_lines WHERE entry_id=?').run(entry.id);
      db.prepare('DELETE FROM journal_entries WHERE id=?').run(entry.id);
    }
    db.prepare('DELETE FROM payroll_records WHERE id=?').run(row.id);
  })();
  audit(req.user.id, 'delete', 'payroll_record', req.params.id, `حذف رکورد حقوق #${req.params.id}`);
  res.json({ ok: true });
});

module.exports = router;
