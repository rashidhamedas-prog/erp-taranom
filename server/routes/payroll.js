const router = require('express').Router();
const { getDB, audit, createJournalEntry, createPersonLedgerEntry, resolveCashAccount } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');

// Hourly payroll — employees are Persons (category "کارمند"). Each record
// accrues the salary as a real double-entry posting:
//   Dr 6104 هزینه حقوق و دستمزد   = gross_pay - deductions
//   Cr 1106 حساب اشخاص متفرقه     = net_pay        (what we now owe the employee)
//   Cr 2104 بدهی بیمه و مالیات    = insurance + tax withheld (owed to the authorities later)
// "deductions" is money that reduces both the expense and what's owed (e.g.
// unpaid leave) — it intentionally has no journal line of its own since it
// represents pay that was never earned, not a liability to anyone.
// Paying the salary is a separate step (POST /:id/pay) that debits the
// person's payable and credits cash/bank, exactly like a supplier payment.

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
  const { person_id, period_label, regular_hours, overtime_hours, hourly_rate, overtime_rate, bonuses, deductions, insurance_deduction, tax_deduction, date, note } = req.body;
  if (!person_id) return res.status(400).json({ error: 'کارمند الزامی است' });
  const db = getDB();
  const person = db.prepare('SELECT * FROM persons WHERE id=?').get(person_id);
  if (!person) return res.status(404).json({ error: 'شخص یافت نشد' });

  const regH = parseFloat(regular_hours) || 0, otH = parseFloat(overtime_hours) || 0;
  const hRate = parseFloat(hourly_rate) || 0, otRate = parseFloat(overtime_rate) || 0;
  const bon = parseFloat(bonuses) || 0, ded = parseFloat(deductions) || 0;
  const ins = parseFloat(insurance_deduction) || 0, tax = parseFloat(tax_deduction) || 0;
  const grossPay = regH * hRate + otH * otRate + bon;
  const netPay = grossPay - ded - ins - tax;
  if (netPay < 0) return res.status(400).json({ error: 'مجموع کسورات از حقوق ناخالص بیشتر است' });

  const recId = db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO payroll_records (person_id,period_label,regular_hours,overtime_hours,hourly_rate,overtime_rate,bonuses,deductions,insurance_deduction,tax_deduction,gross_pay,net_pay,date,note,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(person_id, period_label || '', regH, otH, hRate, otRate, bon, ded, ins, tax, grossPay, netPay, date || todayJalali(), note || '', req.user.id);
    const recId = result.lastInsertRowid;

    const lines = [
      { code: '6104', name: 'هزینه حقوق و دستمزد', debit: grossPay - ded, credit: 0, description: `حقوق ${person.name} - ${period_label || ''}` },
      { code: '1106', name: 'حساب اشخاص متفرقه', debit: 0, credit: netPay }
    ];
    if (ins + tax > 0) lines.push({ code: '2104', name: 'بدهی بیمه و مالیات کارکنان', debit: 0, credit: ins + tax });
    createJournalEntry(db, {
      date: date || todayJalali(), description: `حقوق ${person.name} (${period_label || ''})`,
      ref_type: 'payroll', ref_id: recId, created_by: req.user.id, lines
    });
    createPersonLedgerEntry(db, {
      person_id, date: date || todayJalali(), entry_type: 'payroll', ref_type: 'payroll', ref_id: recId,
      description: `حقوق ${period_label || ''}`, debit: 0, credit: netPay, user_id: req.user.id
    });
    return recId;
  })();

  audit(req.user.id, 'create', 'payroll_record', recId, `ثبت حقوق ${person.name}: خالص ${netPay}`);
  res.json({ id: recId, ok: true, gross_pay: grossPay, net_pay: netPay });
});

// Pay out an already-accrued payroll record
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
