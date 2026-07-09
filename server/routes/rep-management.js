const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDB, audit, createJournalEntry, resolveCashAccount } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');
const {
  EXPENSE_CATEGORIES, REP_ROLES_SQL, isRepRole, addRepLedger, buildRepLedgerView, buildRepStatement,
  computeRepCommission, computeRepPayable, settleAdvancesAgainstPayment, notifyRep, getRepRanking,
  getRepAgingReceivables, getTeamRollup, canAccessRep
} = require('../lib/rep-ledger');

const UPLOADS = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
const repUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOADS, 'reps');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, `${Date.now()}-${(file.originalname || 'file').replace(/[^\w.-]/g, '_')}`)
  }),
  limits: { fileSize: 8 * 1024 * 1024 }
});

function repGuard(db, id) {
  return db.prepare(`SELECT * FROM users WHERE id=? AND active=1 AND role IN ${REP_ROLES_SQL}`).get(id) || null;
}

function repAccess(req, res, next) {
  const repId = +req.params.id || +req.params.repId || 0;
  if (!repId) return next();
  if (canAccessRep(getDB(), req.user, repId)) return next();
  return res.status(403).json({ error: 'دسترسی ندارید' });
}

function adminRepOrSelf(req, res, next) {
  if (req.user.role === 'admin' || req.user.role === 'accounting') return next();
  const repId = +req.params.id;
  if (isRepRole(req.user.role) && req.user.id === repId) return next();
  if (canAccessRep(getDB(), req.user, repId)) return next();
  return res.status(403).json({ error: 'دسترسی ندارید' });
}

// ---- Static routes first ----

router.get('/expense-categories', auth, (req, res) => {
  res.json(EXPENSE_CATEGORIES);
});

router.get('/ranking', auth, adminOrAccounting, (req, res) => {
  res.json(getRepRanking(getDB(), { from: req.query.from, to: req.query.to }));
});

router.get('/territories', auth, adminOrAccounting, (req, res) => {
  res.json(getDB().prepare('SELECT * FROM rep_territories WHERE active=1 ORDER BY name').all());
});

router.post('/territories', auth, adminOrAccounting, (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'نام منطقه الزامی است' });
  const r = getDB().prepare('INSERT INTO rep_territories (name,description) VALUES (?,?)').run(name, description || '');
  res.json({ id: r.lastInsertRowid, ok: true });
});

router.get('/expenses/pending', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  res.json(db.prepare(`
    SELECT e.*, u.name as rep_name, r.name as recorder
    FROM rep_expenses e JOIN users u ON e.rep_id=u.id LEFT JOIN users r ON e.created_by=r.id
    WHERE e.status='pending' ORDER BY e.created_at DESC LIMIT 100
  `).all());
});

router.get('/alerts', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const pendingExpenses = db.prepare("SELECT COUNT(*) c FROM rep_expenses WHERE status='pending'").get().c;
  const reps = db.prepare(`SELECT id,name,monthly_target FROM users WHERE active=1 AND role IN ${REP_ROLES_SQL} AND monthly_target>0`).all();
  const targetHits = [];
  for (const r of reps) {
    const comm = computeRepCommission(db, r.id, {});
    if (comm.targetPct >= 100) targetHits.push({ id: r.id, name: r.name, pct: comm.targetPct });
  }
  const overdueCheques = db.prepare(`
    SELECT COUNT(*) c FROM invoices i
    WHERE i.type='final' AND i.pay_type='cheque' AND i.cheque_status='pending'
    AND i.user_id IN (SELECT id FROM users WHERE role IN ${REP_ROLES_SQL})
  `).get().c;
  res.json({ pendingExpenses, targetHits, overdueCheques });
});

router.get('/assignment-history', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { customer_id, rep_id } = req.query;
  let where = '1=1';
  const params = [];
  if (customer_id) { where += ' AND h.customer_id=?'; params.push(+customer_id); }
  if (rep_id) { where += ' AND (h.from_rep_id=? OR h.to_rep_id=?)'; params.push(+rep_id, +rep_id); }
  res.json(db.prepare(`
    SELECT h.*, c.biz as customer_name, f.name as from_name, t.name as to_name, u.name as recorder
    FROM rep_assignment_history h
    LEFT JOIN customers c ON h.customer_id=c.id
    LEFT JOIN users f ON h.from_rep_id=f.id LEFT JOIN users t ON h.to_rep_id=t.id
    LEFT JOIN users u ON h.created_by=u.id
    WHERE ${where} ORDER BY h.created_at DESC LIMIT 300
  `).all(...params));
});

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
    db.prepare(`INSERT INTO rep_assignment_history (customer_id,from_rep_id,to_rep_id,date,note,created_by) VALUES (?,?,?,?,?,?)`)
      .run(customer_id, fromId, to_rep_id, todayJalali(), note || '', req.user.id);
  })();
  notifyRep(db, to_rep_id, `📌 مشتری «${cust.biz}» به شما منتقل شد.`, req.user.id);
  audit(req.user.id, 'update', 'customer', customer_id, `انتقال مشتری ${cust.biz} به نماینده ${toRep.name}`);
  res.json({ ok: true });
});

router.post('/bulk-transfer', auth, adminOrAccounting, (req, res) => {
  const { customer_ids, to_rep_id, note } = req.body;
  if (!Array.isArray(customer_ids) || !customer_ids.length || !to_rep_id) {
    return res.status(400).json({ error: 'لیست مشتریان و نماینده الزامی است' });
  }
  const db = getDB();
  const toRep = repGuard(db, +to_rep_id);
  if (!toRep) return res.status(400).json({ error: 'نماینده نامعتبر' });
  let n = 0;
  db.transaction(() => {
    for (const cid of customer_ids) {
      const cust = db.prepare('SELECT * FROM customers WHERE id=?').get(cid);
      if (!cust || cust.user_id === +to_rep_id) continue;
      db.prepare('UPDATE customers SET user_id=?, assigned_to=? WHERE id=?').run(to_rep_id, to_rep_id, cid);
      db.prepare(`INSERT INTO rep_assignment_history (customer_id,from_rep_id,to_rep_id,date,note,created_by) VALUES (?,?,?,?,?,?)`)
        .run(cid, cust.user_id, to_rep_id, todayJalali(), note || 'انتقال گروهی', req.user.id);
      n++;
    }
  })();
  res.json({ ok: true, transferred: n });
});

router.post('/expenses/:expenseId/approve', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT e.*, u.name as rep_name FROM rep_expenses e JOIN users u ON e.rep_id=u.id WHERE e.id=?').get(+req.params.expenseId);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.status === 'approved') return res.json({ ok: true });
  const { pay_type, bank_id, cash_box_id } = req.body;
  db.transaction(() => {
    db.prepare("UPDATE rep_expenses SET status='approved',approved_by=?,approved_at=strftime('%s','now') WHERE id=?").run(req.user.id, row.id);
    addRepLedger(db, {
      rep_id: row.rep_id, date: row.date, entry_type: 'expense', ref_type: 'rep_expense', ref_id: row.id,
      description: `هزینه: ${EXPENSE_CATEGORIES[row.category] || row.category}`, debit: row.amount, credit: 0, created_by: req.user.id
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
  notifyRep(db, row.rep_id, `✅ هزینه ${row.amount} تومان تأیید شد.`, req.user.id);
  res.json({ ok: true });
});

router.post('/expenses/:expenseId/reject', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM rep_expenses WHERE id=?').get(+req.params.expenseId);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.status !== 'pending') return res.status(400).json({ error: 'فقط pending' });
  db.prepare("UPDATE rep_expenses SET status='rejected',approved_by=?,approved_at=strftime('%s','now') WHERE id=?").run(req.user.id, row.id);
  notifyRep(db, row.rep_id, `❌ هزینه ${row.amount} تومان رد شد.${req.body.note ? ' — ' + req.body.note : ''}`, req.user.id);
  res.json({ ok: true });
});

router.delete('/commission-rules/:ruleId', auth, adminOrAccounting, (req, res) => {
  getDB().prepare('UPDATE rep_commission_rules SET active=0 WHERE id=?').run(+req.params.ruleId);
  res.json({ ok: true });
});

router.delete('/commission-tiers/:tierId', auth, adminOrAccounting, (req, res) => {
  getDB().prepare('UPDATE rep_commission_tiers SET active=0 WHERE id=?').run(+req.params.tierId);
  res.json({ ok: true });
});

router.get('/export/all-excel', auth, adminOrAccounting, (req, res) => {
  const XLSX = require('xlsx');
  const db = getDB();
  const { from, to } = req.query;
  const rows = getRepRanking(db, { from, to }).map(r => ({
    'نماینده': r.name, 'نوع': r.roleLabel, 'فروش': r.salesTotal, 'انگیزه': Math.round(r.totalComm),
    'وصول': r.collected, 'مشتریان': r.customers, 'هدف٪': r.targetPct, 'مانده پرداخت': Math.round(r.payable)
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'نمایندگان');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=reps-all.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// Self-service
router.get('/my/dashboard', auth, (req, res) => {
  if (!isRepRole(req.user.role)) return res.status(403).json({ error: 'فقط نمایندگان' });
  const db = getDB();
  const repId = req.user.id;
  const view = buildRepLedgerView(db, repId, {});
  const dash = db.prepare(`SELECT COUNT(*) c FROM followups WHERE user_id=? AND status='open'`).get(repId).c;
  res.json({ ...view, openFollowups: dash });
});

router.get('/my/ledger', auth, (req, res) => {
  if (!isRepRole(req.user.role)) return res.status(403).json({ error: 'فقط نمایندگان' });
  const stmt = buildRepStatement(getDB(), req.user.id, { from: req.query.from, to: req.query.to });
  if (!stmt) return res.status(404).json({ error: 'یافت نشد' });
  res.json(stmt);
});

// List reps
router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { from, to } = req.query;
  const reps = db.prepare(`
    SELECT u.id,u.name,u.username,u.role,u.phone,u.rep_code,u.rep_subtype,u.territory,u.employment_status,
      u.commission_cash,u.commission_cheque,u.commission_basis,u.monthly_target,u.quarterly_target,u.annual_target,
      u.supervisor_id,s.name as supervisor_name
    FROM users u LEFT JOIN users s ON u.supervisor_id=s.id
    WHERE u.active=1 AND u.role IN ${REP_ROLES_SQL} ORDER BY u.name
  `).all();
  const custMap = Object.fromEntries(db.prepare('SELECT user_id, COUNT(*) c FROM customers GROUP BY user_id').all().map(r => [r.user_id, r.c]));
  const result = reps.map(r => {
    const view = buildRepLedgerView(db, r.id, { from, to });
    return {
      ...r,
      roleLabel: r.role === 'inside_sales' ? 'تلفنی' : 'میدانی',
      basisLabel: r.commission_basis === 'collection' ? 'وصول' : 'فاکتور',
      customers: custMap[r.id] || 0,
      ...(view?.commission || {}),
      paid: view?.paid || 0,
      payable: view?.payable || 0,
      balance: view?.balance || 0,
      advancesRemaining: view?.advancesRemaining || 0
    };
  });
  res.json(result);
});

router.get('/team/:supervisorId', auth, (req, res) => {
  const supId = +req.params.supervisorId;
  if (req.user.role !== 'admin' && req.user.role !== 'accounting' && req.user.id !== supId) {
    return res.status(403).json({ error: 'دسترسی ندارید' });
  }
  res.json(getTeamRollup(getDB(), supId, { from: req.query.from, to: req.query.to }));
});

// ---- Per-rep routes ----

router.get('/:id/ledger', auth, adminRepOrSelf, (req, res) => {
  const view = buildRepLedgerView(getDB(), +req.params.id, { from: req.query.from, to: req.query.to });
  if (!view) return res.status(404).json({ error: 'نماینده یافت نشد' });
  res.json(view);
});

router.get('/:id/statement', auth, adminRepOrSelf, (req, res) => {
  const stmt = buildRepStatement(getDB(), +req.params.id, { from: req.query.from, to: req.query.to });
  if (!stmt) return res.status(404).json({ error: 'نماینده یافت نشد' });
  res.json(stmt);
});

router.get('/:id/dashboard', auth, adminRepOrSelf, (req, res) => {
  const db = getDB();
  const rep = repGuard(db, +req.params.id);
  if (!rep) return res.status(404).json({ error: 'نماینده یافت نشد' });
  const { from, to } = req.query;
  let invWhere = "user_id=? AND type='final'";
  const p = [rep.id];
  if (from) { invWhere += ' AND date>=?'; p.push(from); }
  if (to) { invWhere += ' AND date<=?'; p.push(to); }
  const sales = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(final),0) s FROM invoices WHERE ${invWhere}`).get(...p);
  const prevWhere = invWhere.replace('date>=', 'date>=\'0000\' AND date>=\'').replace('date<=', 'date<=\'0000\' AND date<=');
  const customers = db.prepare('SELECT COUNT(*) c FROM customers WHERE user_id=?').get(rep.id).c;
  const newCust = db.prepare("SELECT COUNT(*) c FROM customers WHERE user_id=? AND status='new'").get(rep.id).c;
  const silentCust = db.prepare("SELECT COUNT(*) c FROM customers WHERE user_id=? AND status='silent'").get(rep.id).c;
  const openFup = db.prepare("SELECT COUNT(*) c FROM followups WHERE user_id=? AND status='open'").get(rep.id).c;
  const collected = db.prepare(`
    SELECT COALESCE(SUM(s.amount),0) s FROM settlements s JOIN invoices i ON s.invoice_id=i.id WHERE i.user_id=?
    ${from ? ' AND s.date>=?' : ''}${to ? ' AND s.date<=?' : ''}
  `).get(rep.id, ...(from ? [from] : []), ...(to ? [to] : [])).s;
  const view = buildRepLedgerView(db, rep.id, { from, to });
  const aging = getRepAgingReceivables(db, rep.id);
  const rank = getRepRanking(db, { from, to }).findIndex(r => r.id === rep.id) + 1;
  res.json({
    rep: { id: rep.id, name: rep.name, role: rep.role, territory: rep.territory, supervisor_id: rep.supervisor_id },
    salesCount: sales.c, salesTotal: sales.s, customers, newCustomers: newCust, lostCustomers: silentCust,
    openFollowups: openFup, collected, commission: view.commission, paid: view.paid, payable: view.payable,
    balance: view.balance, advancesRemaining: view.advancesRemaining, aging, rank,
    conversionRate: customers > 0 ? Math.round((sales.c / customers) * 100) : 0
  });
});

router.get('/:id/expenses', auth, adminRepOrSelf, (req, res) => {
  const db = getDB();
  if (!repGuard(db, +req.params.id)) return res.status(404).json({ error: 'نماینده یافت نشد' });
  res.json(db.prepare(`
    SELECT e.*, u.name as recorder FROM rep_expenses e LEFT JOIN users u ON e.created_by=u.id
    WHERE e.rep_id=? ORDER BY e.created_at DESC LIMIT 200
  `).all(+req.params.id));
});

router.post('/:id/expenses', auth, adminRepOrSelf, (req, res) => {
  const db = getDB();
  const repId = +req.params.id;
  if (!repGuard(db, repId)) return res.status(404).json({ error: 'نماینده یافت نشد' });
  const { category, amount, date, description, receipt_file, cost_center_id } = req.body;
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'مبلغ معتبر الزامی است' });
  const r = db.prepare(`
    INSERT INTO rep_expenses (rep_id,category,amount,date,description,receipt_file,cost_center_id,status,created_by)
    VALUES (?,?,?,?,?,?,?,'pending',?)
  `).run(repId, category || 'other', amt, date || todayJalali(), description || '', receipt_file || '', cost_center_id || null, req.user.id);
  audit(req.user.id, 'create', 'rep_expense', r.lastInsertRowid, `هزینه نماینده: ${amt}`);
  res.json({ id: r.lastInsertRowid, ok: true });
});

router.get('/:id/advances', auth, adminRepOrSelf, (req, res) => {
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
    const r = db.prepare(`INSERT INTO rep_advances (rep_id,amount,pay_type,date,note,bank_id,cash_box_id,created_by) VALUES (?,?,?,?,?,?,?,?)`)
      .run(repId, amt, pay_type || 'cash', date || todayJalali(), note || '', bank_id || null, cash_box_id || null, req.user.id);
    addRepLedger(db, {
      rep_id: repId, date: date || todayJalali(), entry_type: 'advance', ref_type: 'rep_advance', ref_id: r.lastInsertRowid,
      description: `مساعده — ${note || ''}`, debit: amt, credit: 0, created_by: req.user.id
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
  notifyRep(db, repId, `💰 مساعده ${amt} تومان به حساب شما ثبت شد.`, req.user.id);
  audit(req.user.id, 'create', 'rep_advance', result.lastInsertRowid, `مساعده ${amt}`);
  res.json({ id: result.lastInsertRowid, ok: true });
});

router.post('/:id/settle', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const repId = +req.params.id;
  const rep = repGuard(db, repId);
  if (!rep) return res.status(404).json({ error: 'نماینده یافت نشد' });
  const view = buildRepLedgerView(db, repId, {});
  const { amount, pay_type, date, note, bank_id, cash_box_id, settle_advances } = req.body;
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'مبلغ الزامی است' });
  const balanceBefore = view.balance;
  const result = db.transaction(() => {
    const pay = db.prepare('INSERT INTO incentive_payments (rep_id,amount,pay_type,date,note,created_by,bank_id,cash_box_id) VALUES (?,?,?,?,?,?,?,?)')
      .run(repId, amt, pay_type || 'cash', date || todayJalali(), note || 'تسویه نماینده', req.user.id, bank_id || null, cash_box_id || null);
    const { recordIncentivePaymentLedger } = require('../lib/rep-ledger');
    recordIncentivePaymentLedger(db, { rep_id: repId, amount: amt, date: date || todayJalali(), payment_id: pay.lastInsertRowid, created_by: req.user.id });
    let advSettled = 0;
    if (settle_advances !== false) advSettled = settleAdvancesAgainstPayment(db, repId, amt, pay.lastInsertRowid, req.user.id);
    const cash = resolveCashAccount(db, pay_type || 'cash', bank_id, cash_box_id);
    createJournalEntry(db, {
      date: date || todayJalali(), description: `تسویه نماینده ${rep.name}`,
      ref_type: 'rep_settlement', ref_id: pay.lastInsertRowid, created_by: req.user.id,
      lines: [
        { code: '6101', name: 'هزینه انگیزه فروش', debit: amt, credit: 0 },
        { code: cash.code, name: cash.name, debit: 0, credit: amt }
      ]
    });
    db.prepare(`
      INSERT INTO rep_settlements (rep_id,date,settlement_type,commission_paid,advance_settled,total_amount,balance_before,balance_after,note,ref_payment_id,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(repId, date || todayJalali(), 'combined', amt, advSettled, amt, balanceBefore, balanceBefore - amt, note || '', pay.lastInsertRowid, req.user.id);
    return { paymentId: pay.lastInsertRowid, advSettled };
  })();
  notifyRep(db, repId, `💵 تسویه ${amt} تومان انجام شد.${result.advSettled ? ` (مساعده: ${result.advSettled})` : ''}`, req.user.id);
  res.json({ ok: true, ...result });
});

router.get('/:id/settlements', auth, adminRepOrSelf, (req, res) => {
  const db = getDB();
  if (!repGuard(db, +req.params.id)) return res.status(404).json({ error: 'نماینده یافت نشد' });
  res.json(db.prepare('SELECT * FROM rep_settlements WHERE rep_id=? ORDER BY created_at DESC LIMIT 100').all(+req.params.id));
});

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

router.post('/:id/contract', auth, adminOrAccounting, repUpload.single('file'), (req, res) => {
  const db = getDB();
  const rep = repGuard(db, +req.params.id);
  if (!rep) return res.status(404).json({ error: 'نماینده یافت نشد' });
  if (!req.file) return res.status(400).json({ error: 'فایل الزامی است' });
  db.prepare('UPDATE users SET contract_file=? WHERE id=?').run(req.file.filename, rep.id);
  res.json({ ok: true, file: req.file.filename });
});

router.get('/:id/commission-rules', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  if (!repGuard(db, +req.params.id)) return res.status(404).json({ error: 'نماینده یافت نشد' });
  res.json(db.prepare('SELECT * FROM rep_commission_rules WHERE rep_id=? AND active=1 ORDER BY scope_type').all(+req.params.id));
});

router.post('/:id/commission-rules', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const repId = +req.params.id;
  if (!repGuard(db, repId)) return res.status(404).json({ error: 'نماینده یافت نشد' });
  const { scope_type, scope_id, scope_label, rate_cash, rate_cheque } = req.body;
  if (!['product', 'category', 'brand', 'customer'].includes(scope_type)) {
    return res.status(400).json({ error: 'نوع محدوده نامعتبر' });
  }
  const r = db.prepare(`INSERT INTO rep_commission_rules (rep_id,scope_type,scope_id,scope_label,rate_cash,rate_cheque) VALUES (?,?,?,?,?,?)`)
    .run(repId, scope_type, scope_id ? parseInt(scope_id) : null, scope_label || '', parseFloat(rate_cash) || 0, parseFloat(rate_cheque) || 0);
  res.json({ id: r.lastInsertRowid, ok: true });
});

router.get('/:id/commission-tiers', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  if (!repGuard(db, +req.params.id)) return res.status(404).json({ error: 'نماینده یافت نشد' });
  res.json(db.prepare('SELECT * FROM rep_commission_tiers WHERE rep_id=? AND active=1 ORDER BY from_amount').all(+req.params.id));
});

router.post('/:id/commission-tiers', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const repId = +req.params.id;
  if (!repGuard(db, repId)) return res.status(404).json({ error: 'نماینده یافت نشد' });
  const { from_amount, to_amount, rate_cash, rate_cheque } = req.body;
  const r = db.prepare(`INSERT INTO rep_commission_tiers (rep_id,from_amount,to_amount,rate_cash,rate_cheque) VALUES (?,?,?,?,?)`)
    .run(repId, parseFloat(from_amount) || 0, to_amount != null ? parseFloat(to_amount) : null, parseFloat(rate_cash) || 0, parseFloat(rate_cheque) || 0);
  res.json({ id: r.lastInsertRowid, ok: true });
});

router.get('/:id/reports/sales', auth, adminRepOrSelf, (req, res) => {
  const db = getDB();
  if (!repGuard(db, +req.params.id)) return res.status(404).json({ error: 'نماینده یافت نشد' });
  const { from, to } = req.query;
  let where = 'i.user_id=?';
  const p = [+req.params.id];
  if (from) { where += ' AND i.date>=?'; p.push(from); }
  if (to) { where += ' AND i.date<=?'; p.push(to); }
  res.json(db.prepare(`
    SELECT i.id,i.num,i.date,i.type,i.final,i.approved,i.pay_type,c.biz as cust_biz,i.sales_channel,i.lead_source,i.campaign
    FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE ${where} ORDER BY i.date DESC LIMIT 500
  `).all(...p));
});

router.get('/:id/reports/collections', auth, adminRepOrSelf, (req, res) => {
  const db = getDB();
  const repId = +req.params.id;
  if (!repGuard(db, repId)) return res.status(404).json({ error: 'نماینده یافت نشد' });
  const { from, to } = req.query;
  let w = 'i.user_id=?';
  const p = [repId];
  if (from) { w += ' AND s.date>=?'; p.push(from); }
  if (to) { w += ' AND s.date<=?'; p.push(to); }
  res.json(db.prepare(`
    SELECT s.id,s.date,s.amount,s.pay_type,c.biz as cust_biz,i.num as invoice_num
    FROM settlements s JOIN invoices i ON s.invoice_id=i.id LEFT JOIN customers c ON i.cust_id=c.id
    WHERE ${w} ORDER BY s.date DESC LIMIT 500
  `).all(...p));
});

router.get('/:id/reports/customers', auth, adminRepOrSelf, (req, res) => {
  const db = getDB();
  if (!repGuard(db, +req.params.id)) return res.status(404).json({ error: 'نماینده یافت نشد' });
  res.json(db.prepare(`
    SELECT c.*, COALESCE(lb.balance,0) as balance
    FROM customers c
    LEFT JOIN (SELECT customer_id, COALESCE(SUM(debit)-SUM(credit),0) AS balance FROM customer_ledger GROUP BY customer_id) lb ON lb.customer_id=c.id
    WHERE c.user_id=? ORDER BY c.biz
  `).all(+req.params.id));
});

router.get('/:id/reports/aging', auth, adminRepOrSelf, (req, res) => {
  if (!repGuard(getDB(), +req.params.id)) return res.status(404).json({ error: 'نماینده یافت نشد' });
  res.json(getRepAgingReceivables(getDB(), +req.params.id));
});

router.get('/:id/reports/activity', auth, adminRepOrSelf, (req, res) => {
  const db = getDB();
  const repId = +req.params.id;
  if (!repGuard(db, repId)) return res.status(404).json({ error: 'نماینده یافت نشد' });
  const visits = db.prepare('SELECT v.*, c.biz as customer_name FROM rep_visit_logs v LEFT JOIN customers c ON v.customer_id=c.id WHERE v.rep_id=? ORDER BY v.created_at DESC LIMIT 100').all(repId);
  const calls = db.prepare('SELECT cl.*, c.biz as customer_name FROM rep_call_logs cl LEFT JOIN customers c ON cl.customer_id=c.id WHERE cl.rep_id=? ORDER BY cl.created_at DESC LIMIT 100').all(repId);
  const transfers = db.prepare('SELECT * FROM rep_assignment_history WHERE from_rep_id=? OR to_rep_id=? ORDER BY created_at DESC LIMIT 50').all(repId, repId);
  res.json({ visits, calls, transfers });
});

router.get('/:id/visits', auth, adminRepOrSelf, (req, res) => {
  const db = getDB();
  if (!repGuard(db, +req.params.id)) return res.status(404).json({ error: 'نماینده یافت نشد' });
  res.json(db.prepare('SELECT v.*, c.biz as customer_name FROM rep_visit_logs v LEFT JOIN customers c ON v.customer_id=c.id WHERE v.rep_id=? ORDER BY v.created_at DESC LIMIT 200').all(+req.params.id));
});

router.post('/:id/visits', auth, adminRepOrSelf, (req, res) => {
  const db = getDB();
  const repId = +req.params.id;
  if (!repGuard(db, repId)) return res.status(404).json({ error: 'نماینده یافت نشد' });
  const { customer_id, date, note, lat, lng, check_in_at, check_out_at, signature_file, photo_file } = req.body;
  const r = db.prepare(`
    INSERT INTO rep_visit_logs (rep_id,customer_id,date,note,lat,lng,check_in_at,check_out_at,signature_file,photo_file)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(repId, customer_id || null, date || todayJalali(), note || '', lat || null, lng || null,
    check_in_at || Math.floor(Date.now() / 1000), check_out_at || null, signature_file || '', photo_file || '');
  res.json({ id: r.lastInsertRowid, ok: true });
});

router.get('/:id/calls', auth, adminRepOrSelf, (req, res) => {
  const db = getDB();
  if (!repGuard(db, +req.params.id)) return res.status(404).json({ error: 'نماینده یافت نشد' });
  res.json(db.prepare('SELECT cl.*, c.biz as customer_name FROM rep_call_logs cl LEFT JOIN customers c ON cl.customer_id=c.id WHERE cl.rep_id=? ORDER BY cl.created_at DESC LIMIT 200').all(+req.params.id));
});

router.post('/:id/calls', auth, adminRepOrSelf, (req, res) => {
  const db = getDB();
  const repId = +req.params.id;
  if (!repGuard(db, repId)) return res.status(404).json({ error: 'نماینده یافت نشد' });
  const { customer_id, date, duration_min, outcome, note } = req.body;
  const r = db.prepare(`INSERT INTO rep_call_logs (rep_id,customer_id,date,duration_min,outcome,note) VALUES (?,?,?,?,?,?)`)
    .run(repId, customer_id || null, date || todayJalali(), parseInt(duration_min) || 0, outcome || '', note || '');
  res.json({ id: r.lastInsertRowid, ok: true });
});

router.get('/:id/export/excel', auth, adminRepOrSelf, (req, res) => {
  const XLSX = require('xlsx');
  const db = getDB();
  const repId = +req.params.id;
  const rep = repGuard(db, repId);
  if (!rep) return res.status(404).json({ error: 'نماینده یافت نشد' });
  const { from, to } = req.query;
  const stmt = buildRepStatement(db, repId, { from, to });
  const comm = computeRepCommission(db, repId, { from, to });
  const summary = [{
    'نماینده': rep.name, 'فروش': comm.salesTotal, 'انگیزه': Math.round(comm.totalComm),
    'پرداخت‌شده': stmt.paid, 'مانده': Math.round(stmt.closing), 'هدف٪': comm.targetPct
  }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'خلاصه');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(stmt.entries.map(e => ({
    'تاریخ': e.date, 'نوع': e.type_label, 'شرح': e.description, 'بدهکار': e.debit || 0, 'بستانکار': e.credit || 0
  }))), 'گردش');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename=rep-${repId}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.get('/:id/export/pdf', auth, adminRepOrSelf, (req, res) => {
  const db = getDB();
  const repId = +req.params.id;
  const rep = repGuard(db, repId);
  if (!rep) return res.status(404).json({ error: 'نماینده یافت نشد' });
  const stmt = buildRepStatement(db, repId, { from: req.query.from, to: req.query.to });
  const faNum = n => Number(n || 0).toLocaleString('fa-IR');
  const rowsHtml = stmt.entries.map((e, i) => `<tr><td>${i + 1}</td><td>${e.date || '-'}</td><td>${e.type_label}</td><td>${(e.description || '').replace(/</g, '&lt;')}</td><td>${e.debit ? faNum(e.debit) : '-'}</td><td>${e.credit ? faNum(e.credit) : '-'}</td></tr>`).join('');
  const html = `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="UTF-8"><title>صورت‌حساب ${rep.name}</title>
<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;600;800&display=swap" rel="stylesheet">
<style>*{font-family:Vazirmatn,sans-serif}body{padding:24px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px;text-align:center}th{background:#1A5C38;color:#fff}.head{margin-bottom:16px}.pbtn{margin-top:16px;background:#1A5C38;color:#fff;border:none;padding:10px 24px;border-radius:8px;cursor:pointer}@media print{.pbtn{display:none}}</style></head><body>
<div class="head"><h1>صورت‌حساب نماینده: ${rep.name}</h1>
<p>انگیزه: ${faNum(Math.round(stmt.commission.totalComm))} | پرداخت: ${faNum(stmt.paid)} | مانده: ${faNum(Math.round(stmt.closing))}</p></div>
<table><thead><tr><th>#</th><th>تاریخ</th><th>نوع</th><th>شرح</th><th>بدهکار</th><th>بستانکار</th></tr></thead><tbody>${rowsHtml || '<tr><td colspan="6">—</td></tr>'}</tbody></table>
<button class="pbtn" onclick="window.print()">🖨️ چاپ / PDF</button></body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

module.exports = router;
