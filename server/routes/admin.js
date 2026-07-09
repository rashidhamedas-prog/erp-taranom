const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { getDB, audit } = require('../db');
const { auth, adminOnly, centralOnly } = require('../middleware/auth');

// Get all users (include incentive fields)
router.get('/users', auth, adminOnly, (req, res) => {
  const db = getDB();
  const users = db.prepare('SELECT id,name,username,role,phone,active,last_login,commission_cash,commission_cheque,commission_basis,monthly_target,incentive_locked,created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

// Create user (salesperson or admin) — incentive is locked immediately after creation
router.post('/users', auth, adminOnly, centralOnly, (req, res) => {
  const { name, username, password, phone, role = 'salesperson', commission_cash = 0, commission_cheque = 0,
    commission_basis = 'invoice', monthly_target = 0, quarterly_target = 0, annual_target = 0, bonus_pct = 0, commission_fixed = 0, penalty_pct = 0, supervisor_commission_pct = 0,
    rep_code, rep_subtype, territory, supervisor_id, employment_status, bank_name, bank_account, bank_iban, rep_opening_balance } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: 'اطلاعات ناقص' });
  const db = getDB();
  const exists = db.prepare('SELECT id FROM users WHERE username=?').get(username);
  if (exists) return res.status(400).json({ error: 'این نام کاربری قبلاً ثبت شده' });
  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare(`
    INSERT INTO users (name,username,password,phone,role,commission_cash,commission_cheque,commission_basis,monthly_target,quarterly_target,annual_target,bonus_pct,commission_fixed,penalty_pct,supervisor_commission_pct,incentive_locked,
      rep_code,rep_subtype,territory,supervisor_id,employment_status,bank_name,bank_account,bank_iban,rep_opening_balance)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?)
  `).run(name, username, hash, phone || '', role, parseFloat(commission_cash) || 0, parseFloat(commission_cheque) || 0,
    ['collection', 'profit'].includes(commission_basis) ? commission_basis : 'invoice',
    parseFloat(monthly_target) || 0,
    parseFloat(quarterly_target) || 0, parseFloat(annual_target) || 0, parseFloat(bonus_pct) || 0, parseFloat(commission_fixed) || 0,
    parseFloat(penalty_pct) || 0, parseFloat(supervisor_commission_pct) || 0,
    rep_code || '', rep_subtype || '', territory || '', supervisor_id ? parseInt(supervisor_id) : null,
    employment_status || 'active', bank_name || '', bank_account || '', bank_iban || '', parseFloat(rep_opening_balance) || 0);
  audit(req.user.id, 'create', 'user', result.lastInsertRowid, `ساخت کاربر ${name} با انگیزه فروش نقد ${commission_cash}٪ چک ${commission_cheque}٪`);
  res.json({ id: result.lastInsertRowid, name, username, phone: phone || '', role, commission_cash: parseFloat(commission_cash) || 0, commission_cheque: parseFloat(commission_cheque) || 0, incentive_locked: 1 });
});

// Update user — if incentive rate changed on a locked user, require force:true
router.put('/users/:id', auth, adminOnly, centralOnly, (req, res) => {
  const { name, password, active, role, phone, commission_cash = 0, commission_cheque = 0, force,
    commission_basis, monthly_target, quarterly_target, annual_target, bonus_pct, commission_fixed, penalty_pct, supervisor_commission_pct,
    rep_code, rep_subtype, territory, supervisor_id, employment_status,
    bank_name, bank_account, bank_iban, rep_opening_balance } = req.body;
  const db = getDB();
  const existing = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'کاربر یافت نشد' });
  const basis = ['collection', 'profit', 'invoice'].includes(commission_basis) ? commission_basis : (existing.commission_basis || 'invoice');
  const target = monthly_target != null ? parseFloat(monthly_target) || 0 : (existing.monthly_target || 0);
  const qTarget = quarterly_target != null ? parseFloat(quarterly_target) || 0 : (existing.quarterly_target || 0);
  const aTarget = annual_target != null ? parseFloat(annual_target) || 0 : (existing.annual_target || 0);
  const bonus = bonus_pct != null ? parseFloat(bonus_pct) || 0 : (existing.bonus_pct || 0);
  const fixed = commission_fixed != null ? parseFloat(commission_fixed) || 0 : (existing.commission_fixed || 0);
  const penalty = penalty_pct != null ? parseFloat(penalty_pct) || 0 : (existing.penalty_pct || 0);
  const supComm = supervisor_commission_pct != null ? parseFloat(supervisor_commission_pct) || 0 : (existing.supervisor_commission_pct || 0);

  const newCash = parseFloat(commission_cash) || 0;
  const newCheque = parseFloat(commission_cheque) || 0;
  const rateChanged = Math.abs(newCash - (existing.commission_cash || 0)) > 0.001 ||
                      Math.abs(newCheque - (existing.commission_cheque || 0)) > 0.001;

  if (existing.incentive_locked && rateChanged && !force) {
    return res.status(409).json({ locked: true, message: 'نرخ انگیزه فروش این کارشناس قفل شده است. لطفاً تأیید کنید.' });
  }

  if (password) {
    db.prepare(`UPDATE users SET name=?,active=?,role=?,phone=?,password=?,commission_cash=?,commission_cheque=?,commission_basis=?,monthly_target=?,quarterly_target=?,annual_target=?,bonus_pct=?,commission_fixed=?,penalty_pct=?,supervisor_commission_pct=?,incentive_locked=1,
      rep_code=?,rep_subtype=?,territory=?,supervisor_id=?,employment_status=?,bank_name=?,bank_account=?,bank_iban=?,rep_opening_balance=? WHERE id=?`)
      .run(name, active, role, phone || '', bcrypt.hashSync(password, 10), newCash, newCheque, basis, target, qTarget, aTarget, bonus, fixed, penalty, supComm,
        rep_code || existing.rep_code || '', rep_subtype || existing.rep_subtype || '', territory || existing.territory || '',
        supervisor_id ? parseInt(supervisor_id) : existing.supervisor_id,
        employment_status || existing.employment_status || 'active',
        bank_name || existing.bank_name || '', bank_account || existing.bank_account || '', bank_iban || existing.bank_iban || '',
        rep_opening_balance != null ? parseFloat(rep_opening_balance) : (existing.rep_opening_balance || 0),
        req.params.id);
  } else {
    db.prepare(`UPDATE users SET name=?,active=?,role=?,phone=?,commission_cash=?,commission_cheque=?,commission_basis=?,monthly_target=?,quarterly_target=?,annual_target=?,bonus_pct=?,commission_fixed=?,penalty_pct=?,supervisor_commission_pct=?,incentive_locked=1,
      rep_code=?,rep_subtype=?,territory=?,supervisor_id=?,employment_status=?,bank_name=?,bank_account=?,bank_iban=?,rep_opening_balance=? WHERE id=?`)
      .run(name, active, role, phone || '', newCash, newCheque, basis, target, qTarget, aTarget, bonus, fixed, penalty, supComm,
        rep_code || existing.rep_code || '', rep_subtype || existing.rep_subtype || '', territory || existing.territory || '',
        supervisor_id ? parseInt(supervisor_id) : existing.supervisor_id,
        employment_status || existing.employment_status || 'active',
        bank_name || existing.bank_name || '', bank_account || existing.bank_account || '', bank_iban || existing.bank_iban || '',
        rep_opening_balance != null ? parseFloat(rep_opening_balance) : (existing.rep_opening_balance || 0),
        req.params.id);
  }
  if (rateChanged) {
    audit(req.user.id, 'update', 'user', req.params.id, `تغییر نرخ انگیزه فروش ${name}: نقد ${existing.commission_cash}%→${newCash}% چک ${existing.commission_cheque}%→${newCheque}%`);
  } else {
    audit(req.user.id, 'update', 'user', req.params.id, `ویرایش کاربر ${name}`);
  }
  res.json({ ok: true });
});

// Delete (deactivate) user
router.delete('/users/:id', auth, adminOnly, centralOnly, (req, res) => {
  if (req.params.id == req.user.id) return res.status(400).json({ error: 'نمی‌توانید خودتان را حذف کنید' });
  const db = getDB();
  const u = db.prepare('SELECT name FROM users WHERE id=?').get(req.params.id);
  db.prepare('UPDATE users SET active=0 WHERE id=?').run(req.params.id);
  audit(req.user.id, 'delete', 'user', req.params.id, `غیرفعال‌سازی کاربر ${u ? u.name : ''}`);
  res.json({ ok: true });
});

// Admin dashboard - per-salesperson stats (using final invoices for revenue)
router.get('/dashboard', auth, adminOnly, (req, res) => {
  const db = getDB();
  const safeDate = v => (v && /^[\d/]+$/.test(v)) ? v : null;
  const sf = safeDate(req.query.from), st = safeDate(req.query.to);
  const dateClause = sf || st
    ? ` AND date >= '${sf || ''}' AND date <= '${st || '9999'}'`
    : '';
  const users = db.prepare("SELECT id,name,username FROM users WHERE active=1").all();
  const custMap = Object.fromEntries(
    db.prepare('SELECT user_id, COUNT(*) c FROM customers GROUP BY user_id').all().map(r => [r.user_id, r.c])
  );
  const salesMap = Object.fromEntries(
    db.prepare(`SELECT user_id, COALESCE(SUM(final),0) s FROM invoices WHERE type='final'${dateClause} GROUP BY user_id`).all().map(r => [r.user_id, r.s])
  );
  const fupMap = Object.fromEntries(
    db.prepare("SELECT user_id, COUNT(*) c FROM followups WHERE status='open' GROUP BY user_id").all().map(r => [r.user_id, r.c])
  );
  const stats = users.map(u => ({
    ...u,
    custCount: custMap[u.id] || 0,
    totalSales: salesMap[u.id] || 0,
    totalDebt: 0,
    openFup: fupMap[u.id] || 0
  }));
  res.json(stats);
});

// Aggregate overview across ALL users (revenue from final invoices only)
router.get('/stats/overview', auth, adminOnly, (req, res) => {
  const db = getDB();
  const safeDate = v => (v && /^[\d/]+$/.test(v)) ? v : null;
  const sf = safeDate(req.query.from), st = safeDate(req.query.to);
  const dateClause = sf || st
    ? ` AND date >= '${sf || ''}' AND date <= '${st || '9999'}'`
    : '';
  const totalCustomers = db.prepare('SELECT COUNT(*) c FROM customers').get().c;
  const totalRevenue = db.prepare(`SELECT COALESCE(SUM(final),0) s FROM invoices WHERE type='final'${dateClause}`).get().s;
  const totalInvoices = db.prepare(`SELECT COUNT(*) c FROM invoices WHERE type='final'${dateClause}`).get().c;
  const totalProforma = db.prepare(`SELECT COUNT(*) c FROM invoices WHERE type='proforma'${dateClause}`).get().c;
  const totalProducts = db.prepare('SELECT COUNT(*) c FROM products').get().c;
  const openFollowups = db.prepare("SELECT COUNT(*) c FROM followups WHERE status='open'").get().c;
  const lowStock = db.prepare('SELECT COUNT(*) c FROM products WHERE stock<=stock_alert').get().c;
  res.json({ totalCustomers, totalRevenue, totalInvoices, totalProforma, totalProducts, openFollowups, lowStock,
             totalOrders: 0, totalPaid: 0, totalDebt: 0 });
});

// Data for a specific salesperson (admin)
router.get('/user-data/:userId', auth, adminOnly, (req, res) => {
  const db = getDB();
  const uid = req.params.userId;
  const customers = db.prepare('SELECT * FROM customers WHERE user_id=? ORDER BY created_at DESC').all(uid);
  const followups = db.prepare('SELECT * FROM followups WHERE user_id=? ORDER BY created_at DESC').all(uid);
  res.json({ customers, followups });
});

// Paginated audit log with filters
router.get('/audit', auth, adminOnly, (req, res) => {
  const db = getDB();
  const page = Math.max(1, parseInt(req.query.page || '1'));
  const limit = Math.min(200, parseInt(req.query.limit || '50'));
  const offset = (page - 1) * limit;
  const where = [];
  const params = [];
  if (req.query.user_id) { where.push('a.user_id=?'); params.push(req.query.user_id); }
  if (req.query.entity) { where.push('a.entity=?'); params.push(req.query.entity); }
  if (req.query.from) { where.push('a.created_at>=?'); params.push(parseInt(req.query.from)); }
  if (req.query.to) { where.push('a.created_at<=?'); params.push(parseInt(req.query.to)); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM audit_log a ${whereSql}`).get(...params).c;
  const rows = db.prepare(
    `SELECT a.*, u.name as user_name FROM audit_log a LEFT JOIN users u ON a.user_id=u.id ${whereSql} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  res.json({ rows, total, page, limit });
});

// Customer balances — admin sees all, others handled in /customers/balances
router.get('/customer-balances', auth, adminOnly, (req, res) => {
  const db = getDB();
  const LEDGER_BAL_JOIN = `LEFT JOIN (
    SELECT customer_id, COALESCE(SUM(debit)-SUM(credit),0) AS balance
    FROM customer_ledger GROUP BY customer_id
  ) lb ON lb.customer_id=c.id`;
  const BAL = 'COALESCE(lb.balance,0)';
  const rows = db.prepare(`
    SELECT c.id, c.biz, c.owner, c.city, ${BAL} AS balance, u.name as salesperson
    FROM customers c ${LEDGER_BAL_JOIN}
    LEFT JOIN users u ON c.user_id=u.id
    WHERE ${BAL} <> 0
    ORDER BY ABS(${BAL}) DESC
  `).all();
  res.json(rows);
});

module.exports = router;
