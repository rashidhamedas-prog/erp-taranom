const router = require('express').Router();
const { getDB, audit, createJournalEntry, resolveCashAccount } = require('../db');
const { auth, adminOnly, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');
const {
  EXPENSE_CATEGORIES, isRepRole, addRepLedger, buildRepLedgerView, computeRepCommission, notifyRep
} = require('../lib/rep-ledger');

const REP_ROLES = "('field_sales','inside_sales')";

function repGuard(db, id) {
  const u = db.prepare(`SELECT * FROM users WHERE id=? AND active=1 AND role IN ${REP_ROLES}`).get(id);
  return u || null;
}

// List marketing representatives with summary metrics
router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { from, to } = req.query;
  const reps = db.prepare(`
    SELECT u.id,u.name,u.username,u.role,u.phone,u.rep_code,u.rep_subtype,u.territory,u.employment_status,
      u.commission_cash,u.commission_cheque,u.commission_basis,u.monthly_target,u.supervisor_id,s.name as supervisor_name
    FROM users u
    LEFT JOIN users s ON u.supervisor_id=s.id
    WHERE u.active=1 AND u.role IN ${REP_ROLES}
    ORDER BY u.name
  `).all();
  const custMap = Object.fromEntries(
    db.prepare('SELECT user_id, COUNT(*) c FROM customers GROUP BY user_id').all().map(r => [r.user_id, r.c])
  );
  const result = reps.map(r => {
    const comm = computeRepCommission(db, r.id, { from, to });
    const paid = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM incentive_payments WHERE rep_id=?').get(r.id).s;
    return {
      ...r,
      roleLabel: r.role === 'inside_sales' ? 'تلفنی' : 'میدانی',
      basisLabel: r.commission_basis === 'collection' ? 'وصول' : 'فاکتور',
      customers: custMap[r.id] || 0,
      ...comm,
      paid,
      payable: Math.max(0, comm.totalComm - paid)
    };
  });
  res.json(result);
});

// Representative detail + ledger
router.get('/:id/ledger', auth, adminOrAccounting, (req, res) => {
  const view = buildRepLedgerView(getDB(), +req.params.id, { from: req.query.from, to: req.query.to });
  if (!view) return res.status(404).json({ error: 'نماینده یافت نشد' });
  res.json(view);
});

// Performance dashboard
router.get('/:id/dashboard', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rep = repGuard(db, +req.params.id);
  if (!rep) return res.status(404).json({ error: 'نماینده یافت نشد' });
  const { from, to } = req.query;
  let invWhere = "user_id=? AND type='final'";
  const p = [rep.id];
  if (from) { invWhere += ' AND date>=?'; p.push(from); }
  if (to) { invWhere += ' AND date<=?'; p.push(to); }
  const sales = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(final),0) s FROM invoices WHERE ${invWhere}`).get(...p);
  const approved = db.prepare(`SELECT COALESCE(SUM(final),0) s FROM invoices WHERE ${invWhere} AND approved=1`).get(...p);
  const customers = db.prepare('SELECT COUNT(*) c FROM customers WHERE user_id=?').get(rep.id).c;
  const newCust = db.prepare("SELECT COUNT(*) c FROM customers WHERE user_id=? AND status='new'").get(rep.id).c;
  const openFup = db.prepare("SELECT COUNT(*) c FROM followups WHERE user_id=? AND status='open'").get(rep.id).c;
  const collected = db.prepare(`
    SELECT COALESCE(SUM(s.amount),0) s FROM settlements s
    JOIN invoices i ON s.invoice_id=i.id WHERE i.user_id=?
    ${from ? ' AND s.date>=?' : ''}${to ? ' AND s.date<=?' : ''}
  `).get(rep.id, ...(from ? [from] : []), ...(to ? [to] : [])).s;
  const comm = computeRepCommission(db, rep.id, { from, to });
  const paid = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM incentive_payments WHERE rep_id=?').get(rep.id).s;
  res.json({
    rep: { id: rep.id, name: rep.name, role: rep.role, territory: rep.territory },
    salesCount: sales.c,
    salesTotal: sales.s,
    approvedSales: approved.s,
    customers,
    newCustomers: newCust,
    openFollowups: openFup,
    collected,
    commission: comm,
    paid,
    payable: Math.max(0, comm.totalComm - paid)
  });
});

// Customer assignment history
router.get('/assignment-history', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { customer_id, rep_id } = req.query;
  let where = '1=1';
  const params = [];
  if (customer_id) { where += ' AND h.customer_id=?'; params.push(+customer_id); }
  if (rep_id) { where += ' AND (h.from_rep_id=? OR h.to_rep_id=?)'; params.push(+rep_id, +rep_id); }
  const rows = db.prepare(`
    SELECT h.*, c.biz as customer_name, f.name as from_name, t.name as to_name, u.name as recorder
    FROM rep_assignment_history h
    LEFT JOIN customers c ON h.customer_id=c.id
    LEFT JOIN users f ON h.from_rep_id=f.id
    LEFT JOIN users t ON h.to_rep_id=t.id
    LEFT JOIN users u ON h.created_by=u.id
    WHERE ${where}
    ORDER BY h.created_at DESC LIMIT 300
  `).all(...params);
  res.json(rows);
});

// Transfer customer to another representative
router.post('/transfer-customer', auth, adminOrAccounting, (req, res) => {
  const { customer_id, to_rep_id, note } = req.body;
  if (!customer_id || !to_rep_id) return res.status(400).json({ error: 'مشتری و نماینده مقصد الزامی است' });
  const db = getDB();
  const cust = db.prepare('SELECT * FROM customers WHERE id=?').get(customer_id);
  if (!cust) return res.status(404).json({ error: 'مشتری یافت نشد' });
  const toRep = repGuard(db, +to_rep_id);
  if (!toRep) return res.status(400).json({ error: 'نماینده مقصد نامعتبر است' });
  const fromId = cust.user_id;
  if (fromId === +to_rep_id) return res.status(400).json({ error: 'مشتری از قبل نزد این نماینده است' });
  db.transaction(() => {
    db.prepare('UPDATE customers SET user_id=?, assigned_to=? WHERE id=?').run(to_rep_id, to_rep_id, customer_id);
    db.prepare(`
      INSERT INTO rep_assignment_history (customer_id,from_rep_id,to_rep_id,date,note,created_by)
      VALUES (?,?,?,?,?,?)
    `).run(customer_id, fromId, to_rep_id, todayJalali(), note || '', req.user.id);
  })();
  audit(req.user.id, 'update', 'customer', customer_id, `انتقال مشتری ${cust.biz} به نماینده ${toRep.name}`);
  res.json({ ok: true });
});

// Rep expenses
router.get('/:id/expenses', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  if (!repGuard(db, +req.params.id)) return res.status(404).json({ error: 'نماینده یافت نشد' });
  const rows = db.prepare(`
    SELECT e.*, u.name as recorder FROM rep_expenses e
    LEFT JOIN users u ON e.created_by=u.id
    WHERE e.rep_id=? ORDER BY e.created_at DESC LIMIT 200
  `).all(+req.params.id);
  res.json(rows);
});

router.post('/:id/expenses', auth, (req, res) => {
  const db = getDB();
  const repId = +req.params.id;
  const rep = repGuard(db, repId);
  if (!rep) return res.status(404).json({ error: 'نماینده یافت نشد' });
  if (req.user.role !== 'admin' && req.user.role !== 'accounting' && req.user.id !== repId) {
    return res.status(403).json({ error: 'دسترسی ندارید' });
  }
  const { category, amount, date, description, receipt_file, cost_center_id } = req.body;
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'مبلغ معتبر الزامی است' });
  const result = db.prepare(`
    INSERT INTO rep_expenses (rep_id,category,amount,date,description,receipt_file,cost_center_id,status,created_by)
    VALUES (?,?,?,?,?,?,?,'pending',?)
  `).run(repId, category || 'other', amt, date || todayJalali(), description || '', receipt_file || '', cost_center_id || null, req.user.id);
  audit(req.user.id, 'create', 'rep_expense', result.lastInsertRowid, `هزینه نماینده ${rep.name}: ${amt}`);
  res.json({ id: result.lastInsertRowid, ok: true });
});

router.post('/expenses/:expenseId/approve', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT e.*, u.name as rep_name FROM rep_expenses e JOIN users u ON e.rep_id=u.id WHERE e.id=?').get(+req.params.expenseId);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.status === 'approved') return res.json({ ok: true });
  const { pay_type, bank_id, cash_box_id } = req.body;
  db.transaction(() => {
    db.prepare("UPDATE rep_expenses SET status='approved',approved_by=?,approved_at=strftime('%s','now') WHERE id=?")
      .run(req.user.id, row.id);
    addRepLedger(db, {
      rep_id: row.rep_id, date: row.date, entry_type: 'expense', ref_type: 'rep_expense', ref_id: row.id,
      description: `هزینه: ${EXPENSE_CATEGORIES[row.category] || row.category} — ${row.description || ''}`,
      debit: row.amount, credit: 0, created_by: req.user.id
    });
    const cash = resolveCashAccount(db, pay_type || 'cash', bank_id, cash_box_id);
    createJournalEntry(db, {
      date: row.date, description: `بازپرداخت هزینه نماینده ${row.rep_name}`,
      ref_type: 'rep_expense', ref_id: row.id, created_by: req.user.id,
      lines: [
        { code: '6103', name: 'هزینه‌های توزیع و فروش', debit: row.amount, credit: 0 },
        { code: cash.code, name: cash.name, debit: 0, credit: row.amount }
      ]
    });
  })();
  notifyRep(db, row.rep_id, `✅ هزینه شما به مبلغ ${row.amount} تومان تأیید شد.`, req.user.id);
  res.json({ ok: true });
});

router.post('/expenses/:expenseId/reject', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM rep_expenses WHERE id=?').get(+req.params.expenseId);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.status !== 'pending') return res.status(400).json({ error: 'فقط هزینه‌های در انتظار قابل رد هستند' });
  db.prepare("UPDATE rep_expenses SET status='rejected',approved_by=?,approved_at=strftime('%s','now') WHERE id=?")
    .run(req.user.id, row.id);
  notifyRep(db, row.rep_id, `❌ هزینه ${row.amount} تومان رد شد.${req.body.note ? ' — ' + req.body.note : ''}`, req.user.id);
  res.json({ ok: true });
});

router.get('/expenses/pending', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  res.json(db.prepare(`
    SELECT e.*, u.name as rep_name, r.name as recorder
    FROM rep_expenses e
    JOIN users u ON e.rep_id=u.id
    LEFT JOIN users r ON e.created_by=r.id
    WHERE e.status='pending' ORDER BY e.created_at DESC LIMIT 100
  `).all());
});

router.get('/alerts', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const pendingExpenses = db.prepare("SELECT COUNT(*) c FROM rep_expenses WHERE status='pending'").get().c;
  const reps = db.prepare(`SELECT id,name,monthly_target FROM users WHERE active=1 AND role IN ${REP_ROLES} AND monthly_target>0`).all();
  const targetHits = [];
  for (const r of reps) {
    const comm = computeRepCommission(db, r.id, {});
    if (comm.targetPct >= 100) targetHits.push({ id: r.id, name: r.name, pct: comm.targetPct });
  }
  res.json({ pendingExpenses, targetHits });
});

// Advances
router.get('/:id/advances', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  if (!repGuard(db, +req.params.id)) return res.status(404).json({ error: 'نماینده یافت نشد' });
  res.json(db.prepare('SELECT * FROM rep_advances WHERE rep_id=? ORDER BY created_at DESC').all(+req.params.id));
});

router.post('/:id/advances', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const repId = +req.params.id;
  const rep = repGuard(db, repId);
  if (!rep) return res.status(404).json({ error: 'نماینده یافت نشد' });
  const { amount, pay_type, date, note, bank_id, cash_box_id } = req.body;
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'مبلغ معتبر الزامی است' });
  const result = db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO rep_advances (rep_id,amount,pay_type,date,note,bank_id,cash_box_id,created_by)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(repId, amt, pay_type || 'cash', date || todayJalali(), note || '', bank_id || null, cash_box_id || null, req.user.id);
    addRepLedger(db, {
      rep_id: repId, date: date || todayJalali(), entry_type: 'advance', ref_type: 'rep_advance', ref_id: r.lastInsertRowid,
      description: `مساعده نقدی — ${note || ''}`, debit: amt, credit: 0, created_by: req.user.id
    });
    const cash = resolveCashAccount(db, pay_type || 'cash', bank_id, cash_box_id);
    createJournalEntry(db, {
      date: date || todayJalali(), description: `مساعده به نماینده ${rep.name}`,
      ref_type: 'rep_advance', ref_id: r.lastInsertRowid, created_by: req.user.id,
      lines: [
        { code: '1107', name: 'مساعده نمایندگان فروش', debit: amt, credit: 0 },
        { code: cash.code, name: cash.name, debit: 0, credit: amt }
      ]
    });
    return r;
  })();
  audit(req.user.id, 'create', 'rep_advance', result.lastInsertRowid, `مساعده ${amt} به ${rep.name}`);
  res.json({ id: result.lastInsertRowid, ok: true });
});

// Manual ledger adjustment
router.post('/:id/ledger/adjustment', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rep = repGuard(db, +req.params.id);
  if (!rep) return res.status(404).json({ error: 'نماینده یافت نشد' });
  const { date, description, debit, credit } = req.body;
  const d = parseFloat(debit) || 0, c = parseFloat(credit) || 0;
  if (!d && !c) return res.status(400).json({ error: 'بدهکار یا بستانکار الزامی است' });
  const r = addRepLedger(db, {
    rep_id: rep.id, date: date || todayJalali(), entry_type: 'adjustment', ref_type: 'manual', ref_id: null,
    description: description || 'تعدیل دستی', debit: d, credit: c, created_by: req.user.id
  });
  res.json({ id: r.lastInsertRowid, ok: true });
});

// Sales report by rep
router.get('/:id/reports/sales', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  if (!repGuard(db, +req.params.id)) return res.status(404).json({ error: 'نماینده یافت نشد' });
  const { from, to } = req.query;
  let where = 'i.user_id=?';
  const p = [+req.params.id];
  if (from) { where += ' AND i.date>=?'; p.push(from); }
  if (to) { where += ' AND i.date<=?'; p.push(to); }
  const rows = db.prepare(`
    SELECT i.id,i.num,i.date,i.type,i.final,i.approved,i.pay_type,c.biz as cust_biz,
      i.sales_channel,i.lead_source,i.campaign
    FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id
    WHERE ${where} ORDER BY i.date DESC LIMIT 500
  `).all(...p);
  res.json(rows);
});

router.get('/expense-categories', auth, (req, res) => {
  res.json(EXPENSE_CATEGORIES);
});

router.get('/:id/commission-rules', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  if (!repGuard(db, +req.params.id)) return res.status(404).json({ error: 'نماینده یافت نشد' });
  res.json(db.prepare('SELECT * FROM rep_commission_rules WHERE rep_id=? ORDER BY scope_type, scope_id').all(+req.params.id));
});

router.post('/:id/commission-rules', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const repId = +req.params.id;
  if (!repGuard(db, repId)) return res.status(404).json({ error: 'نماینده یافت نشد' });
  const { scope_type, scope_id, rate_cash, rate_cheque } = req.body;
  if (!scope_type || !['product', 'category'].includes(scope_type)) {
    return res.status(400).json({ error: 'نوع محدوده باید product یا category باشد' });
  }
  const r = db.prepare(`
    INSERT INTO rep_commission_rules (rep_id,scope_type,scope_id,rate_cash,rate_cheque) VALUES (?,?,?,?,?)
  `).run(repId, scope_type, scope_id ? parseInt(scope_id) : null, parseFloat(rate_cash) || 0, parseFloat(rate_cheque) || 0);
  res.json({ id: r.lastInsertRowid, ok: true });
});

router.delete('/commission-rules/:ruleId', auth, adminOrAccounting, (req, res) => {
  getDB().prepare('UPDATE rep_commission_rules SET active=0 WHERE id=?').run(+req.params.ruleId);
  res.json({ ok: true });
});

router.get('/:id/export/excel', auth, adminOrAccounting, (req, res) => {
  const XLSX = require('xlsx');
  const db = getDB();
  const repId = +req.params.id;
  const rep = repGuard(db, repId);
  if (!rep) return res.status(404).json({ error: 'نماینده یافت نشد' });
  const { from, to } = req.query;
  let where = 'i.user_id=?';
  const p = [repId];
  if (from) { where += ' AND i.date>=?'; p.push(from); }
  if (to) { where += ' AND i.date<=?'; p.push(to); }
  const invRows = db.prepare(`
    SELECT i.num as 'شماره', i.date as 'تاریخ', c.biz as 'مشتری', i.final as 'مبلغ',
      i.pay_type as 'نوع پرداخت', i.approved as 'تأیید', i.sales_channel as 'کانال'
    FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id
    WHERE ${where} ORDER BY i.date DESC
  `).all(...p);
  const comm = computeRepCommission(db, repId, { from, to });
  const summary = [{
    'نماینده': rep.name, 'فروش نقد': comm.cashSales, 'فروش چک': comm.chequeSales,
    'انگیزه': Math.round(comm.totalComm), 'مبنای محاسبه': comm.basis === 'collection' ? 'وصول' : 'فاکتور',
    'هدف ماهانه': comm.monthlyTarget, 'درصد هدف': comm.targetPct + '%'
  }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'خلاصه');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(invRows), 'فاکتورها');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename=rep-${repId}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

module.exports = router;
