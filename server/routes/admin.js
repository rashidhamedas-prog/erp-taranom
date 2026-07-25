const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { getDB, audit } = require('../db');
const { auth, adminOnly, centralOnly, invalidateUserCache } = require('../middleware/auth');
const { validatePassword } = require('../lib/security');
const { j2g } = require('../jalali');
const { ensureUserParty } = require('../lib/user-party');

function jalaliDayBounds(jStr) {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(String(jStr || '').trim());
  if (!m) return null;
  const [gy, gm, gd] = j2g(+m[1], +m[2], +m[3]);
  const start = Math.floor(new Date(gy, gm - 1, gd, 0, 0, 0).getTime() / 1000);
  return { start, end: start + 86400 - 1 };
}

// Get all users (include incentive fields)
router.get('/users', auth, adminOnly, (req, res) => {
  const db = getDB();
  const users = db.prepare(`
    SELECT u.id,u.name,u.username,u.role,u.phone,u.active,u.last_login,u.commission_cash,u.commission_cheque,
      u.commission_basis,u.monthly_target,u.incentive_locked,u.created_at,u.party_id,u.sales_warehouse_id,
      p.person_code,p.legal_type,p.company_name,p.national_id,p.economic_code,
      p.secondary_phone AS person_secondary_phone,p.mobile AS person_mobile,p.fax AS person_fax,
      p.email AS person_email,p.city AS person_city,p.province AS person_province,p.address AS person_address,
      p.postal_code AS person_postal_code,p.birth_date AS person_birth_date,p.notes AS person_notes,
      p.party_group_id AS person_party_group_id,p.account_nature AS person_account_nature
    FROM users u LEFT JOIN parties p ON p.id=u.party_id ORDER BY u.created_at DESC
  `).all();
  res.json(users);
});

// Create user (salesperson or admin) — incentive is locked immediately after creation
router.post('/users', auth, adminOnly, centralOnly, (req, res) => {
  const { name, username, password, phone, role = 'salesperson', commission_cash = 0, commission_cheque = 0,
    commission_basis = 'invoice', monthly_target = 0, quarterly_target = 0, annual_target = 0, bonus_pct = 0, commission_fixed = 0, penalty_pct = 0, supervisor_commission_pct = 0,
    rep_code, rep_subtype, territory, supervisor_id, employment_status, bank_name, bank_account, bank_iban, rep_opening_balance, sales_warehouse_id } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: 'اطلاعات ناقص' });
  const passErr = validatePassword(password);
  if (passErr) return res.status(400).json({ error: passErr });
  const db = getDB();
  const exists = db.prepare('SELECT id FROM users WHERE username=?').get(username);
  if (exists) return res.status(400).json({ error: 'این نام کاربری قبلاً ثبت شده' });
  const hash = bcrypt.hashSync(password, 10);
  // must_change_password=1 → رمزی که مدیر تعیین کرده موقتی است و در اولین ورود عوض می‌شود
  const created = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO users (name,username,password,phone,role,commission_cash,commission_cheque,commission_basis,monthly_target,quarterly_target,annual_target,bonus_pct,commission_fixed,penalty_pct,supervisor_commission_pct,incentive_locked,must_change_password,
        rep_code,rep_subtype,territory,supervisor_id,employment_status,bank_name,bank_account,bank_iban,rep_opening_balance,sales_warehouse_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,?,?,?,?,?,?,?,?,?,?)
    `).run(name, username, hash, phone || '', role, parseFloat(commission_cash) || 0, parseFloat(commission_cheque) || 0,
      ['collection', 'profit'].includes(commission_basis) ? commission_basis : 'invoice',
      parseFloat(monthly_target) || 0,
      parseFloat(quarterly_target) || 0, parseFloat(annual_target) || 0, parseFloat(bonus_pct) || 0, parseFloat(commission_fixed) || 0,
      parseFloat(penalty_pct) || 0, parseFloat(supervisor_commission_pct) || 0,
      rep_code || '', rep_subtype || '', territory || '', supervisor_id ? parseInt(supervisor_id) : null,
      employment_status || 'active', bank_name || '', bank_account || '', bank_iban || '', parseFloat(rep_opening_balance) || 0,
      sales_warehouse_id ? parseInt(sales_warehouse_id, 10) : null);
    ensureUserParty(db, result.lastInsertRowid, req.body);
    return result;
  })();
  audit(req.user.id, 'create', 'user', created.lastInsertRowid, `ساخت کاربر ${name} با انگیزه فروش نقد ${commission_cash}٪ چک ${commission_cheque}٪`);
  res.json({ id: created.lastInsertRowid, name, username, phone: phone || '', role, commission_cash: parseFloat(commission_cash) || 0, commission_cheque: parseFloat(commission_cheque) || 0, incentive_locked: 1 });
});

// Update user — if incentive rate changed on a locked user, require force:true
router.put('/users/:id', auth, adminOnly, centralOnly, (req, res) => {
  const { name, password, active, role, phone, commission_cash = 0, commission_cheque = 0, force,
    commission_basis, monthly_target, quarterly_target, annual_target, bonus_pct, commission_fixed, penalty_pct, supervisor_commission_pct,
    rep_code, rep_subtype, territory, supervisor_id, employment_status,
    bank_name, bank_account, bank_iban, rep_opening_balance, sales_warehouse_id } = req.body;
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
    const passErr = validatePassword(password);
    if (passErr) return res.status(400).json({ error: passErr });
  }

  db.transaction(() => {
    const salesWhId = sales_warehouse_id === '' || sales_warehouse_id == null
      ? (existing.sales_warehouse_id || null)
      : (parseInt(sales_warehouse_id, 10) || null);
    if (password) {
      db.prepare(`UPDATE users SET name=?,active=?,role=?,phone=?,password=?,commission_cash=?,commission_cheque=?,commission_basis=?,monthly_target=?,quarterly_target=?,annual_target=?,bonus_pct=?,commission_fixed=?,penalty_pct=?,supervisor_commission_pct=?,incentive_locked=1,must_change_password=1,
        rep_code=?,rep_subtype=?,territory=?,supervisor_id=?,employment_status=?,bank_name=?,bank_account=?,bank_iban=?,rep_opening_balance=?,sales_warehouse_id=? WHERE id=?`)
        .run(name, active, role, phone || '', bcrypt.hashSync(password, 10), newCash, newCheque, basis, target, qTarget, aTarget, bonus, fixed, penalty, supComm,
          rep_code || existing.rep_code || '', rep_subtype || existing.rep_subtype || '', territory || existing.territory || '',
          supervisor_id ? parseInt(supervisor_id) : existing.supervisor_id,
          employment_status || existing.employment_status || 'active',
          bank_name || existing.bank_name || '', bank_account || existing.bank_account || '', bank_iban || existing.bank_iban || '',
          rep_opening_balance != null ? parseFloat(rep_opening_balance) : (existing.rep_opening_balance || 0),
          salesWhId,
          req.params.id);
    } else {
      db.prepare(`UPDATE users SET name=?,active=?,role=?,phone=?,commission_cash=?,commission_cheque=?,commission_basis=?,monthly_target=?,quarterly_target=?,annual_target=?,bonus_pct=?,commission_fixed=?,penalty_pct=?,supervisor_commission_pct=?,incentive_locked=1,
        rep_code=?,rep_subtype=?,territory=?,supervisor_id=?,employment_status=?,bank_name=?,bank_account=?,bank_iban=?,rep_opening_balance=?,sales_warehouse_id=? WHERE id=?`)
        .run(name, active, role, phone || '', newCash, newCheque, basis, target, qTarget, aTarget, bonus, fixed, penalty, supComm,
          rep_code || existing.rep_code || '', rep_subtype || existing.rep_subtype || '', territory || existing.territory || '',
          supervisor_id ? parseInt(supervisor_id) : existing.supervisor_id,
          employment_status || existing.employment_status || 'active',
          bank_name || existing.bank_name || '', bank_account || existing.bank_account || '', bank_iban || existing.bank_iban || '',
          rep_opening_balance != null ? parseFloat(rep_opening_balance) : (existing.rep_opening_balance || 0),
          salesWhId,
          req.params.id);
    }
    ensureUserParty(db, Number(req.params.id), req.body);
  })();
  invalidateUserCache(+req.params.id);
  if (rateChanged) {
    audit(req.user.id, 'update', 'user', req.params.id, `تغییر نرخ انگیزه فروش ${name}: نقد ${existing.commission_cash}%→${newCash}% چک ${existing.commission_cheque}%→${newCheque}%`);
  } else {
    audit(req.user.id, 'update', 'user', req.params.id, `ویرایش کاربر ${name}`);
  }
  res.json({ ok: true });
});

// حذف کامل کاربر — ردیف users پاک می‌شود؛ مالکیت اسناد به admin منتقل می‌گردد
router.delete('/users/:id', auth, adminOnly, centralOnly, (req, res) => {
  if (req.params.id == req.user.id) return res.status(400).json({ error: 'نمی‌توانید خودتان را حذف کنید' });
  const db = getDB();
  try {
    const { purgeUser } = require('../lib/purge-user');
    const result = purgeUser(db, +req.params.id, req.user.id);
    invalidateUserCache(+req.params.id);
    audit(req.user.id, 'purge', 'user', req.params.id, `حذف کامل کاربر ${result.name || ''} (${result.username || ''})`);
    res.json({ ok: true, purged: true, ...result });
  } catch (e) {
    const code = e.status || 400;
    res.status(code).json({ error: e.message || 'خطا در حذف کاربر' });
  }
});

router.get('/users/:id/catalog-categories', auth, adminOnly, centralOnly, (req, res) => {
  const db = getDB();
  const ids = db.prepare('SELECT category_id FROM user_catalog_categories WHERE user_id=?').all(req.params.id).map(r => r.category_id);
  res.json(ids);
});

router.put('/users/:id/catalog-categories', auth, adminOnly, centralOnly, (req, res) => {
  const db = getDB();
  const ids = Array.isArray(req.body.category_ids) ? req.body.category_ids.map(Number).filter(Boolean) : [];
  db.transaction(() => {
    db.prepare('DELETE FROM user_catalog_categories WHERE user_id=?').run(req.params.id);
    const ins = db.prepare('INSERT OR IGNORE INTO user_catalog_categories (user_id,category_id) VALUES (?,?)');
    for (const cid of ids) ins.run(req.params.id, cid);
  })();
  res.json({ ok: true, category_ids: ids });
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
  if (req.query.date) {
    const b = jalaliDayBounds(req.query.date);
    if (b) { where.push('a.created_at>=?'); params.push(b.start); where.push('a.created_at<=?'); params.push(b.end); }
  }
  if (req.query.date_from) {
    const b = jalaliDayBounds(req.query.date_from);
    if (b) { where.push('a.created_at>=?'); params.push(b.start); }
  }
  if (req.query.date_to) {
    const b = jalaliDayBounds(req.query.date_to);
    if (b) { where.push('a.created_at<=?'); params.push(b.end); }
  }
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
