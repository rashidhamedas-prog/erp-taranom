const { XLSX, readWorkbook } = require('../lib/excel-safe');
const router = require('express').Router();
const { getDB, audit, resolveCashAccount, createLedgerEntry } = require('../db');
const { postToLedger } = require('../lib/ledger');
const { rialToLedger } = require('../lib/money');
const { acct } = require('../lib/coa-map');
const { auth, adminOrAccounting, repModuleAdmin } = require('../middleware/auth');
const { todayJalali } = require('../jalali');
const {
  EXPENSE_CATEGORIES, REP_ROLES_SQL, isRepRole, addRepLedger, buildRepLedgerView, buildRepStatement,
  computeRepCommission, computeRepPayable, settleAdvancesAgainstPayment, notifyRep, getRepRanking,
  getRepAgingReceivables, getTeamRollup, canAccessRep, getRepProfitReport, recordSettlementCommissionAccrual
} = require('../lib/rep-ledger');
const { createSecureUpload, assertNoClientFileReferences } = require('../lib/upload-policy');
const { persistPrivateUpload, persistPrivateUploadWithCommit, removeStoredFile, sendPrivateFile } = require('../lib/private-uploads');
const { sendSecureHtml } = require('../lib/secure-html-response');
const repImageUpload = createSecureUpload('messageImage');
const repDocumentUpload = createSecureUpload('document');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function paymentFileUrl(row) {
  return row && row.receipt_file ? { ...row, receipt_url: `/api/reps/payments/${row.id}/receipt` } : row;
}

function expenseFileUrl(row) {
  return row && row.receipt_file ? { ...row, receipt_url: `/api/reps/expenses/${row.id}/receipt` } : row;
}

function canReadRepFile(db, user, repId) {
  return user.role === 'admin' || user.role === 'accounting' || user.id === repId || canAccessRep(db, user, repId);
}

function repGuard(db, id) {
  return db.prepare(`SELECT * FROM users WHERE id=? AND active=1 AND role IN ${REP_ROLES_SQL}`).get(id) || null;
}

function customerAssignedToRep(db, customerId, repId) {
  const id = Number(customerId);
  if (!Number.isInteger(id) || id <= 0) return false;
  return !!db.prepare(`
    SELECT 1 FROM customers
    WHERE id=? AND (user_id=? OR assigned_to=?)
  `).get(id, Number(repId), Number(repId));
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

router.get('/ranking', auth, repModuleAdmin, (req, res) => {
  res.json(getRepRanking(getDB(), { from: req.query.from, to: req.query.to }));
});

router.get('/territories', auth, repModuleAdmin, (req, res) => {
  res.json(getDB().prepare(`
    SELECT t.*, u.name as rep_name FROM rep_territories t
    LEFT JOIN users u ON t.rep_id=u.id WHERE t.active=1 ORDER BY t.name
  `).all());
});

router.post('/territories', auth, repModuleAdmin, (req, res) => {
  const { name, description, rep_id, cities } = req.body;
  if (!name) return res.status(400).json({ error: 'نام منطقه الزامی است' });
  const r = getDB().prepare('INSERT INTO rep_territories (name,description,rep_id,cities) VALUES (?,?,?,?)')
    .run(name, description || '', rep_id ? parseInt(rep_id) : null, cities || '');
  res.json({ id: r.lastInsertRowid, ok: true });
});

router.put('/territories/:id', auth, repModuleAdmin, (req, res) => {
  const { name, description, rep_id, cities, active } = req.body;
  const db = getDB();
  const row = db.prepare('SELECT * FROM rep_territories WHERE id=?').get(+req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  db.prepare('UPDATE rep_territories SET name=?,description=?,rep_id=?,cities=?,active=? WHERE id=?')
    .run(name || row.name, description ?? row.description, rep_id != null ? parseInt(rep_id) : row.rep_id,
      cities ?? row.cities, active != null ? (active ? 1 : 0) : row.active, row.id);
  res.json({ ok: true });
});

router.get('/expenses/pending', auth, repModuleAdmin, (req, res) => {
  const db = getDB();
  res.json(db.prepare(`
    SELECT e.*, u.name as rep_name, r.name as recorder
    FROM rep_expenses e JOIN users u ON e.rep_id=u.id LEFT JOIN users r ON e.created_by=r.id
    WHERE e.status='pending' ORDER BY e.created_at DESC LIMIT 100
  `).all().map(expenseFileUrl));
});

function applyRepPaymentAsSettlement(db, sub, userId) {
  const pay_type = sub.pay_type === 'cheque' ? 'cheque' : 'cash';
  const amount = parseFloat(sub.amount) || 0;
  const noteParts = [sub.note || ''];
  if (sub.pay_type === 'bank_transfer' && sub.bank_ref) noteParts.push('شماره پیگیری: ' + sub.bank_ref);
  const note = noteParts.filter(Boolean).join(' — ');
  const result = db.prepare(
    `INSERT INTO settlements
      (user_id,cust_id,invoice_id,amount,pay_type,date,note,bank_id,cash_box_id,
       cheque_bank,cheque_sayadi,cheque_number,cheque_account,
       cheque_amount,cheque_owner,cheque_due,cheque_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(userId, sub.cust_id, null, amount, pay_type, sub.date || todayJalali(), note,
    null, null,
    sub.cheque_bank || '', sub.cheque_sayadi || '', sub.cheque_number || '', sub.cheque_account || '',
    parseFloat(sub.cheque_amount || sub.amount) || amount, sub.cheque_owner || '', sub.cheque_due || '',
    pay_type === 'cheque' ? 'pending' : '');
  const settlementId = result.lastInsertRowid;
  const payLabel = pay_type === 'cheque' ? 'چک' : (sub.pay_type === 'bank_transfer' ? 'واریز بانکی' : 'نقد');
  createLedgerEntry(db, {
    customer_id: sub.cust_id, date: sub.date || '', entry_type: 'settlement',
    ref_type: 'settlement', ref_id: settlementId,
    description: `تسویه ${payLabel} (تأیید پرداخت میدانی) - ${amount.toLocaleString('fa-IR')} ریال`,
    debit: 0, credit: amount, user_id: userId
  });
  const cash = resolveCashAccount(db, pay_type, null, null);
  const receivable = acct(db, 'coa_receivable');
  postToLedger(db, {
    sourceType: 'settlement', sourceId: settlementId,
    date: sub.date || todayJalali(), description: `تسویه ${payLabel} مشتری (نماینده میدانی)`, createdBy: userId,
    lines: [
      { code: cash.code, name: cash.name, debit: rialToLedger(amount), credit: 0 },
      { code: receivable.code, name: receivable.name, debit: 0, credit: rialToLedger(amount) }
    ]
  });
  return settlementId;
}

router.get('/payments/pending', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  res.json(db.prepare(`
    SELECT p.*, u.name as rep_name, c.biz as cust_biz, c.owner as cust_owner, c.phone as cust_phone
    FROM rep_payment_submissions p
    JOIN users u ON p.rep_id=u.id
    JOIN customers c ON p.cust_id=c.id
    WHERE p.status='pending'
    ORDER BY p.created_at DESC LIMIT 200
  `).all().map(paymentFileUrl));
});

router.get('/payments/mine', auth, (req, res) => {
  if (req.user.role !== 'field_sales') return res.status(403).json({ error: 'فقط کارشناس میدانی' });
  const db = getDB();
  res.json(db.prepare(`
    SELECT p.*, c.biz as cust_biz FROM rep_payment_submissions p
    LEFT JOIN customers c ON p.cust_id=c.id
    WHERE p.rep_id=? ORDER BY p.created_at DESC LIMIT 100
  `).all(req.user.id).map(paymentFileUrl));
});

router.get('/payments/:id/receipt', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT id,rep_id,receipt_file FROM rep_payment_submissions WHERE id=?').get(+req.params.id);
  if (!row || !row.receipt_file) return res.status(404).json({ error: 'رسید یافت نشد' });
  if (!canReadRepFile(db, req.user, row.rep_id)) return res.status(403).json({ error: 'دسترسی ندارید' });
  return sendPrivateFile(res, 'reps', row.receipt_file, { inline: true });
});

router.post('/payments', auth, repImageUpload.single('receipt'), (req, res) => {
  if (req.user.role !== 'field_sales') return res.status(403).json({ error: 'فقط کارشناس میدانی' });
  const db = getDB();
  const {
    cust_id, pay_type, amount, date, note, bank_ref,
    cheque_bank, cheque_sayadi, cheque_number, cheque_account,
    cheque_amount, cheque_owner, cheque_due
  } = req.body;
  const custId = parseInt(cust_id);
  const amt = parseFloat(amount);
  if (!custId || !amt || amt <= 0) return res.status(400).json({ error: 'مشتری و مبلغ الزامی است' });
  if (!customerAssignedToRep(db, custId, req.user.id)) {
    audit(req.user.id, 'idor_denied', 'customer', custId, 'رد ثبت پرداخت برای مشتری خارج از مالکیت نماینده', req);
    return res.status(403).json({ error: 'این مشتری به شما تخصیص داده نشده است' });
  }
  const pt = ['cash', 'cheque', 'bank_transfer'].includes(pay_type) ? pay_type : 'cash';
  if (pt === 'cheque' && (!cheque_bank || !cheque_sayadi || !cheque_due)) {
    return res.status(400).json({ error: 'اطلاعات چک ناقص است' });
  }
  if (!req.file) return res.status(400).json({ error: 'عکس رسید/چک الزامی است' });
  const { filename: receiptName, result: r } = persistPrivateUploadWithCommit(req.file, 'reps', 'payment', (storedName) =>
    db.prepare(`
      INSERT INTO rep_payment_submissions
        (rep_id,cust_id,pay_type,amount,date,note,receipt_file,bank_ref,
         cheque_bank,cheque_sayadi,cheque_number,cheque_account,cheque_amount,cheque_owner,cheque_due,status,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)
    `).run(req.user.id, custId, pt, amt, date || todayJalali(), note || '', storedName, bank_ref || '',
      cheque_bank || '', cheque_sayadi || '', cheque_number || '', cheque_account || '',
      parseFloat(cheque_amount || amt) || amt, cheque_owner || '', cheque_due || '', req.user.id));
  audit(req.user.id, 'create', 'rep_payment', r.lastInsertRowid, `ثبت پرداخت میدانی ${amt} ت — مشتری ${custId}`);
  res.json({ id: r.lastInsertRowid, ok: true, receipt_url: `/api/reps/payments/${r.lastInsertRowid}/receipt` });
});

router.post('/payments/:id/approve', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare(`
    SELECT p.*, c.biz as cust_biz FROM rep_payment_submissions p
    LEFT JOIN customers c ON p.cust_id=c.id WHERE p.id=?
  `).get(+req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.status !== 'pending') return res.json({ ok: true, status: row.status });
  const settlementId = db.transaction(() => {
    const sid = applyRepPaymentAsSettlement(db, row, req.user.id);
    db.prepare("UPDATE rep_payment_submissions SET status='approved',settlement_id=?,approved_by=?,approved_at=strftime('%s','now') WHERE id=?")
      .run(sid, req.user.id, row.id);
    return sid;
  })();
  audit(req.user.id, 'approve', 'rep_payment', row.id, `تأیید پرداخت میدانی → تسویه #${settlementId}`);
  res.json({ ok: true, settlement_id: settlementId });
});

router.post('/payments/:id/reject', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM rep_payment_submissions WHERE id=?').get(+req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.status !== 'pending') return res.json({ ok: true });
  db.prepare("UPDATE rep_payment_submissions SET status='rejected',approved_by=?,approved_at=strftime('%s','now'),rejection_note=? WHERE id=?")
    .run(req.user.id, req.body.note || '', row.id);
  audit(req.user.id, 'reject', 'rep_payment', row.id, 'رد پرداخت میدانی');
  res.json({ ok: true });
});

router.get('/alerts', auth, repModuleAdmin, (req, res) => {
  const db = getDB();
  try {
    const pendingExpenses = db.prepare("SELECT COUNT(*) c FROM rep_expenses WHERE status='pending'").get().c;
    const reps = db.prepare(`SELECT id,name,monthly_target FROM users WHERE active=1 AND role IN ${REP_ROLES_SQL} AND monthly_target>0`).all();
    const targetHits = [];
    for (const r of reps) {
      const comm = computeRepCommission(db, r.id, {});
      if (comm.targetPct >= 100) targetHits.push({ id: r.id, name: r.name, pct: comm.targetPct });
    }
    // چک‌های معوق روی settlements است (نه invoices) — ستون cheque_status فقط آنجا وجود دارد
    let overdueCheques = 0;
    try {
      overdueCheques = db.prepare(`
        SELECT COUNT(*) c FROM settlements s
        JOIN invoices i ON s.invoice_id=i.id
        WHERE s.pay_type='cheque' AND COALESCE(s.cheque_status,'pending')='pending'
          AND i.user_id IN (SELECT id FROM users WHERE role IN ${REP_ROLES_SQL})
          AND s.cheque_due IS NOT NULL AND s.cheque_due <> '' AND s.cheque_due < ?
      `).get(todayJalali()).c;
    } catch {
      overdueCheques = 0;
    }
    res.json({ pendingExpenses, targetHits, overdueCheques });
  } catch (e) {
    res.status(500).json({ error: e.message, code: e.code || 'E_REPS_ALERTS' });
  }
});

router.get('/assignment-history', auth, repModuleAdmin, (req, res) => {
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

router.post('/transfer-customer', auth, repModuleAdmin, (req, res) => {
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

router.post('/bulk-transfer', auth, repModuleAdmin, (req, res) => {
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

router.post('/expenses/:expenseId/approve', auth, repModuleAdmin, (req, res) => {
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
    const expense = acct(db, 'coa_sales_expense');
    postToLedger(db, {
      sourceType: 'rep_expense', sourceId: row.id,
      date: row.date || todayJalali(), description: `بازپرداخت هزینه نماینده ${row.rep_name}`, createdBy: req.user.id,
      lines: [
        { code: expense.code, name: expense.name, debit: rialToLedger(row.amount), credit: 0 },
        { code: cash.code, name: cash.name, debit: 0, credit: rialToLedger(row.amount) }
      ]
    });
  })();
  notifyRep(db, row.rep_id, `✅ هزینه ${row.amount} ریال تأیید شد.`, req.user.id, { sms: true });
  res.json({ ok: true });
});

router.post('/expenses/:expenseId/reject', auth, repModuleAdmin, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM rep_expenses WHERE id=?').get(+req.params.expenseId);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.status !== 'pending') return res.status(400).json({ error: 'فقط pending' });
  db.prepare("UPDATE rep_expenses SET status='rejected',approved_by=?,approved_at=strftime('%s','now') WHERE id=?").run(req.user.id, row.id);
  notifyRep(db, row.rep_id, `❌ هزینه ${row.amount} ریال رد شد.${req.body.note ? ' — ' + req.body.note : ''}`, req.user.id);
  res.json({ ok: true });
});

router.get('/expenses/:expenseId/receipt', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT id,rep_id,receipt_file FROM rep_expenses WHERE id=?').get(+req.params.expenseId);
  if (!row || !row.receipt_file) return res.status(404).json({ error: 'رسید یافت نشد' });
  if (!canReadRepFile(db, req.user, row.rep_id)) return res.status(403).json({ error: 'دسترسی ندارید' });
  return sendPrivateFile(res, 'reps', row.receipt_file, { inline: true });
});

router.delete('/commission-rules/:ruleId', auth, adminOrAccounting, (req, res) => {
  getDB().prepare('UPDATE rep_commission_rules SET active=0 WHERE id=?').run(+req.params.ruleId);
  res.json({ ok: true });
});

router.delete('/commission-tiers/:tierId', auth, adminOrAccounting, (req, res) => {
  getDB().prepare('UPDATE rep_commission_tiers SET active=0 WHERE id=?').run(+req.params.tierId);
  res.json({ ok: true });
});

router.get('/export/all-excel', auth, repModuleAdmin, async (req, res) => {
  const db = getDB();
  const { from, to } = req.query;
  const rows = getRepRanking(db, { from, to }).map(r => ({
    'نماینده': r.name, 'نوع': r.roleLabel, 'فروش': r.salesTotal, 'انگیزه': Math.round(r.totalComm),
    'وصول': r.collected, 'مشتریان': r.customers, 'هدف٪': r.targetPct, 'مانده پرداخت': Math.round(r.payable)
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'نمایندگان');
  const buf = await XLSX.write(wb);
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
router.get('/', auth, repModuleAdmin, (req, res) => {
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
      basisLabel: r.commission_basis === 'collection' ? 'وصول' : r.commission_basis === 'profit' ? 'سود' : 'فاکتور',
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
  if (!['admin', 'accounting', 'sales_manager'].includes(req.user.role) && req.user.id !== supId) {
    return res.status(403).json({ error: 'دسترسی ندارید' });
  }
  res.json(getTeamRollup(getDB(), supId, { from: req.query.from, to: req.query.to }));
});

router.post('/assign-by-type', auth, repModuleAdmin, (req, res) => {
  const { customer_type, to_rep_id, note } = req.body;
  if (!customer_type || !to_rep_id) return res.status(400).json({ error: 'نوع مشتری و نماینده الزامی است' });
  const db = getDB();
  const toRep = repGuard(db, +to_rep_id);
  if (!toRep) return res.status(400).json({ error: 'نماینده نامعتبر' });
  const customers = db.prepare('SELECT id,user_id,biz FROM customers WHERE type=?').all(customer_type);
  let n = 0;
  db.transaction(() => {
    for (const c of customers) {
      if (c.user_id === +to_rep_id) continue;
      db.prepare('UPDATE customers SET user_id=?, assigned_to=? WHERE id=?').run(to_rep_id, to_rep_id, c.id);
      db.prepare(`INSERT INTO rep_assignment_history (customer_id,from_rep_id,to_rep_id,date,note,created_by) VALUES (?,?,?,?,?,?)`)
        .run(c.id, c.user_id, to_rep_id, todayJalali(), note || `انتساب گروهی نوع ${customer_type}`, req.user.id);
      n++;
    }
  })();
  notifyRep(db, +to_rep_id, `📦 ${n} مشتری نوع «${customer_type}» به شما اختصاص یافت.`, req.user.id, { sms: true });
  res.json({ ok: true, transferred: n });
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
  `).all(+req.params.id).map(expenseFileUrl));
});

router.post('/:id/expenses', auth, adminRepOrSelf, repImageUpload.single('receipt'), (req, res) => {
  const db = getDB();
  const repId = +req.params.id;
  if (!repGuard(db, repId)) return res.status(404).json({ error: 'نماینده یافت نشد' });
  const { category, amount, date, description, receipt_file, cost_center_id } = req.body;
  try { assertNoClientFileReferences(req.body, ['receipt_file']); }
  catch (error) { return res.status(400).json({ error: error.message, code: error.code }); }
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'مبلغ معتبر الزامی است' });
  let receiptName = '';
  let r;
  if (req.file) {
    const persisted = persistPrivateUploadWithCommit(req.file, 'reps', 'expense', (storedName) => db.prepare(`
      INSERT INTO rep_expenses (rep_id,category,amount,date,description,receipt_file,cost_center_id,status,created_by)
      VALUES (?,?,?,?,?,?,?,'pending',?)
    `).run(repId, category || 'other', amt, date || todayJalali(), description || '', storedName, cost_center_id || null, req.user.id));
    receiptName = persisted.filename;
    r = persisted.result;
  } else {
    r = db.prepare(`
      INSERT INTO rep_expenses (rep_id,category,amount,date,description,receipt_file,cost_center_id,status,created_by)
      VALUES (?,?,?,?,?,?,?,'pending',?)
    `).run(repId, category || 'other', amt, date || todayJalali(), description || '', '', cost_center_id || null, req.user.id);
  }
  audit(req.user.id, 'create', 'rep_expense', r.lastInsertRowid, `هزینه نماینده: ${amt}`, req);
  res.json({ id: r.lastInsertRowid, ok: true, receipt_file: receiptName,
    receipt_url: receiptName ? `/api/reps/expenses/${r.lastInsertRowid}/receipt` : null });
});

router.post('/:id/expenses/:expenseId/receipt', auth, adminRepOrSelf, repImageUpload.single('file'), (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM rep_expenses WHERE id=? AND rep_id=?').get(+req.params.expenseId, +req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (!req.file) return res.status(400).json({ error: 'فایل الزامی است' });
  const { filename } = persistPrivateUploadWithCommit(req.file, 'reps', 'expense', (storedName) =>
    db.prepare('UPDATE rep_expenses SET receipt_file=? WHERE id=?').run(storedName, row.id));
  if (row.receipt_file) removeStoredFile('reps', row.receipt_file);
  res.json({ ok: true, file: filename, receipt_url: `/api/reps/expenses/${row.id}/receipt` });
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
    const advance = acct(db, 'coa_rep_advance');
    postToLedger(db, {
      sourceType: 'rep_advance', sourceId: r.lastInsertRowid,
      date: date || todayJalali(), description: `مساعده به نماینده ${rep.name}`, createdBy: req.user.id,
      lines: [
        { code: advance.code, name: advance.name, debit: rialToLedger(amt), credit: 0 },
        { code: cash.code, name: cash.name, debit: 0, credit: rialToLedger(amt) }
      ]
    });
    return r;
  })();
  notifyRep(db, repId, `💰 مساعده ${amt} ریال به حساب شما ثبت شد.`, req.user.id);
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
    const payable = acct(db, 'coa_rep_commission_payable');
    postToLedger(db, {
      sourceType: 'rep_settlement', sourceId: pay.lastInsertRowid,
      date: date || todayJalali(), description: `تسویه نماینده ${rep.name}`, createdBy: req.user.id,
      lines: [
        { code: payable.code, name: payable.name, debit: rialToLedger(amt), credit: 0 },
        { code: cash.code, name: cash.name, debit: 0, credit: rialToLedger(amt) }
      ]
    });
    db.prepare(`
      INSERT INTO rep_settlements (rep_id,date,settlement_type,commission_paid,advance_settled,total_amount,balance_before,balance_after,note,ref_payment_id,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(repId, date || todayJalali(), 'combined', amt, advSettled, amt, balanceBefore, balanceBefore - amt, note || '', pay.lastInsertRowid, req.user.id);
    return { paymentId: pay.lastInsertRowid, advSettled };
  })();
  notifyRep(db, repId, `💵 تسویه ${amt} ریال انجام شد.${result.advSettled ? ` (مساعده: ${result.advSettled})` : ''}`, req.user.id, { sms: true });
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

router.get('/:id/contract', auth, adminRepOrSelf, (req, res) => {
  const db = getDB();
  const rep = repGuard(db, +req.params.id);
  if (!rep) return res.status(404).json({ error: 'نماینده یافت نشد' });
  const u = db.prepare('SELECT contract_file FROM users WHERE id=?').get(rep.id);
  if (!u?.contract_file) return res.json({ file: null });
  res.json({ file: u.contract_file, url: `/api/reps/${rep.id}/contract/file` });
});

router.get('/:id/contract/file', auth, adminRepOrSelf, (req, res) => {
  const db = getDB();
  const rep = repGuard(db, +req.params.id);
  if (!rep) return res.status(404).json({ error: 'نماینده یافت نشد' });
  const row = db.prepare('SELECT contract_file FROM users WHERE id=?').get(rep.id);
  if (!row?.contract_file) return res.status(404).json({ error: 'قرارداد یافت نشد' });
  return sendPrivateFile(res, 'reps', row.contract_file, { inline: false });
});

router.post('/:id/contract', auth, adminOrAccounting, repDocumentUpload.single('file'), (req, res) => {
  const db = getDB();
  const rep = repGuard(db, +req.params.id);
  if (!rep) return res.status(404).json({ error: 'نماینده یافت نشد' });
  if (!req.file) return res.status(400).json({ error: 'فایل الزامی است' });
  const previous = db.prepare('SELECT contract_file FROM users WHERE id=?').get(rep.id)?.contract_file;
  const { filename } = persistPrivateUploadWithCommit(req.file, 'reps', 'contract', (storedName) =>
    db.prepare('UPDATE users SET contract_file=? WHERE id=?').run(storedName, rep.id));
  if (previous) removeStoredFile('reps', previous);
  audit(req.user.id, 'update', 'user', rep.id, `آپلود قرارداد نماینده ${rep.name}`, req);
  res.json({ ok: true, file: filename, url: `/api/reps/${rep.id}/contract/file` });
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

router.get('/:id/reports/profit', auth, adminRepOrSelf, (req, res) => {
  const db = getDB();
  if (!repGuard(db, +req.params.id)) return res.status(404).json({ error: 'نماینده یافت نشد' });
  res.json(getRepProfitReport(db, +req.params.id, { from: req.query.from, to: req.query.to }));
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
  const rows = db.prepare('SELECT v.*, c.biz as customer_name FROM rep_visit_logs v LEFT JOIN customers c ON v.customer_id=c.id WHERE v.rep_id=? ORDER BY v.created_at DESC LIMIT 200').all(+req.params.id);
  res.json(rows.map((row) => ({
    ...row,
    photo_url: row.photo_file ? `/api/reps/${req.params.id}/visits/${row.id}/photo` : null,
    signature_url: row.signature_file ? `/api/reps/${req.params.id}/visits/${row.id}/signature` : null,
  })));
});

router.get('/:id/visits/:visitId/photo', auth, adminRepOrSelf, (req, res) => {
  const row = getDB().prepare('SELECT photo_file FROM rep_visit_logs WHERE id=? AND rep_id=?').get(+req.params.visitId, +req.params.id);
  if (!row?.photo_file) return res.status(404).json({ error: 'تصویر بازدید یافت نشد' });
  return sendPrivateFile(res, 'reps', row.photo_file, { inline: true });
});

router.get('/:id/visits/:visitId/signature', auth, adminRepOrSelf, (req, res) => {
  const row = getDB().prepare('SELECT signature_file FROM rep_visit_logs WHERE id=? AND rep_id=?').get(+req.params.visitId, +req.params.id);
  if (!row?.signature_file) return res.status(404).json({ error: 'امضای بازدید یافت نشد' });
  return sendPrivateFile(res, 'reps', row.signature_file, { inline: true });
});

router.post('/:id/visits', auth, adminRepOrSelf, repImageUpload.fields([{ name: 'photo', maxCount: 1 }, { name: 'signature', maxCount: 1 }]), (req, res) => {
  const db = getDB();
  const repId = +req.params.id;
  if (!repGuard(db, repId)) return res.status(404).json({ error: 'نماینده یافت نشد' });
  const { customer_id, date, note, lat, lng, check_in_at, check_out_at, signature_file, photo_file } = req.body;
  if (customer_id && !customerAssignedToRep(db, customer_id, repId)) {
    audit(req.user.id, 'idor_denied', 'customer', customer_id, 'رد ثبت ویزیت برای مشتری خارج از مالکیت نماینده', req);
    return res.status(403).json({ error: 'این مشتری به نماینده انتخاب‌شده تخصیص ندارد' });
  }
  try { assertNoClientFileReferences(req.body, ['signature_file', 'photo_file']); }
  catch (error) { return res.status(400).json({ error: error.message, code: error.code }); }
  const photo = req.files?.photo?.[0] ? persistPrivateUpload(req.files.photo[0], 'reps', 'visit-photo') : '';
  const signature = req.files?.signature?.[0] ? persistPrivateUpload(req.files.signature[0], 'reps', 'visit-signature') : '';
  try {
    const r = db.prepare(`
      INSERT INTO rep_visit_logs (rep_id,customer_id,date,note,lat,lng,check_in_at,check_out_at,signature_file,photo_file)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(repId, customer_id || null, date || todayJalali(), note || '', lat || null, lng || null,
      check_in_at || Math.floor(Date.now() / 1000), check_out_at || null, signature, photo);
    res.json({ id: r.lastInsertRowid, ok: true,
      photo_url: photo ? `/api/reps/${repId}/visits/${r.lastInsertRowid}/photo` : null,
      signature_url: signature ? `/api/reps/${repId}/visits/${r.lastInsertRowid}/signature` : null });
  } catch (error) {
    if (photo) removeStoredFile('reps', photo);
    if (signature) removeStoredFile('reps', signature);
    throw error;
  }
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
  if (customer_id && !customerAssignedToRep(db, customer_id, repId)) {
    audit(req.user.id, 'idor_denied', 'customer', customer_id, 'رد ثبت تماس برای مشتری خارج از مالکیت نماینده', req);
    return res.status(403).json({ error: 'این مشتری به نماینده انتخاب‌شده تخصیص ندارد' });
  }
  const r = db.prepare(`INSERT INTO rep_call_logs (rep_id,customer_id,date,duration_min,outcome,note) VALUES (?,?,?,?,?,?)`)
    .run(repId, customer_id || null, date || todayJalali(), parseInt(duration_min) || 0, outcome || '', note || '');
  res.json({ id: r.lastInsertRowid, ok: true });
});

router.get('/:id/export/excel', auth, adminRepOrSelf, async (req, res) => {
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
  const buf = await XLSX.write(wb);
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
  const repName = escapeHtml(rep.name);
  const rowsHtml = stmt.entries.map((e, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(e.date || '-')}</td><td>${escapeHtml(e.type_label)}</td><td>${escapeHtml(e.description || '')}</td><td>${e.debit ? faNum(e.debit) : '-'}</td><td>${e.credit ? faNum(e.credit) : '-'}</td></tr>`).join('');
  const html = `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="UTF-8"><title>صورت‌حساب ${repName}</title>
<link href="/vendor/vazirmatn/vazirmatn.css" rel="stylesheet">
<style>*{font-family:Vazirmatn,sans-serif}body{padding:24px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px;text-align:center}th{background:#1A5C38;color:#fff}.head{margin-bottom:16px}.pbtn{margin-top:16px;background:#1A5C38;color:#fff;border:none;padding:10px 24px;border-radius:8px;cursor:pointer}@media print{.pbtn{display:none}}</style></head><body>
<div class="head"><h1>صورت‌حساب نماینده: ${repName}</h1>
<p>انگیزه: ${faNum(Math.round(stmt.commission.totalComm))} | پرداخت: ${faNum(stmt.paid)} | مانده: ${faNum(Math.round(stmt.closing))}</p></div>
<table><thead><tr><th>#</th><th>تاریخ</th><th>نوع</th><th>شرح</th><th>بدهکار</th><th>بستانکار</th></tr></thead><tbody>${rowsHtml || '<tr><td colspan="6">—</td></tr>'}</tbody></table>
<button class="pbtn" type="button" data-print>🖨️ چاپ / PDF</button><script src="/print-page.js"></script></body></html>`;
  return sendSecureHtml(res, html, { allowPrintScript: true });
});

module.exports = router;
