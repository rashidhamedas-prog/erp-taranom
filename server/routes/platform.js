const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { getDB, audit, seedChartOfAccounts, seedDefaultSettings } = require('../db');
const { auth, platformOnly } = require('../middleware/auth');

router.use(auth, platformOnly);

// List all tenants with headline stats
router.get('/tenants', (req, res) => {
  const db = getDB();
  const tenants = db.prepare('SELECT * FROM tenants ORDER BY id').all();
  const stats = db.prepare(`
    SELECT t.id,
      (SELECT COUNT(*) FROM users u WHERE u.tenant_id=t.id) AS users,
      (SELECT COUNT(*) FROM customers c WHERE c.tenant_id=t.id) AS customers,
      (SELECT COUNT(*) FROM invoices i WHERE i.tenant_id=t.id) AS invoices
    FROM tenants t
  `).all();
  const byId = Object.fromEntries(stats.map(s => [s.id, s]));
  res.json(tenants.map(t => ({ ...t, stats: byId[t.id] || {} })));
});

// Create a tenant + its initial admin user + default settings/accounts
router.post('/tenants', (req, res) => {
  const { name, subdomain, plan, admin_name, admin_username, admin_password } = req.body || {};
  if (!name || !admin_username || !admin_password || admin_password.length < 6) {
    return res.status(400).json({ error: 'نام کسب‌وکار، نام کاربری مدیر و رمز (حداقل ۶ کاراکتر) الزامی است' });
  }
  const db = getDB();
  if (db.prepare('SELECT id FROM users WHERE username=?').get(admin_username)) {
    return res.status(400).json({ error: 'این نام کاربری قبلاً استفاده شده است' });
  }
  if (subdomain && db.prepare('SELECT id FROM tenants WHERE subdomain=?').get(subdomain)) {
    return res.status(400).json({ error: 'این زیردامنه قبلاً استفاده شده است' });
  }
  const tx = db.transaction(() => {
    const t = db.prepare('INSERT INTO tenants (name,subdomain,plan,status) VALUES (?,?,?,?)')
      .run(name, subdomain || null, plan || 'basic', 'active');
    const tenantId = t.lastInsertRowid;
    db.prepare('INSERT INTO users (tenant_id,name,username,password,role) VALUES (?,?,?,?,?)')
      .run(tenantId, admin_name || 'مدیر', admin_username, bcrypt.hashSync(admin_password, 10), 'admin');
    seedDefaultSettings(db, tenantId);
    seedChartOfAccounts(db, tenantId);
    return tenantId;
  });
  const tenantId = tx();
  audit(null, req.user.id, 'tenant_created', 'tenant', tenantId, `ایجاد مستأجر ${name}`, req.ip);
  res.json({ ok: true, id: tenantId });
});

// Update tenant (name, plan, limits, branding)
router.put('/tenants/:id', (req, res) => {
  const db = getDB();
  const t = db.prepare('SELECT * FROM tenants WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'مستأجر یافت نشد' });
  const { name, subdomain, plan, max_users, max_monthly_invoices, max_upload_mb, brand_color, brand_color2 } = req.body || {};
  db.prepare(`UPDATE tenants SET
      name=COALESCE(?,name), subdomain=COALESCE(?,subdomain), plan=COALESCE(?,plan),
      max_users=COALESCE(?,max_users), max_monthly_invoices=COALESCE(?,max_monthly_invoices),
      max_upload_mb=COALESCE(?,max_upload_mb), brand_color=COALESCE(?,brand_color), brand_color2=COALESCE(?,brand_color2)
    WHERE id=?`)
    .run(name ?? null, subdomain ?? null, plan ?? null, max_users ?? null, max_monthly_invoices ?? null,
         max_upload_mb ?? null, brand_color ?? null, brand_color2 ?? null, req.params.id);
  audit(null, req.user.id, 'tenant_updated', 'tenant', t.id, `ویرایش مستأجر ${t.name}`, req.ip);
  res.json({ ok: true });
});

// Suspend / reactivate
router.post('/tenants/:id/suspend', (req, res) => {
  const db = getDB();
  const t = db.prepare('SELECT * FROM tenants WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'مستأجر یافت نشد' });
  const newStatus = t.status === 'active' ? 'suspended' : 'active';
  db.prepare('UPDATE tenants SET status=? WHERE id=?').run(newStatus, t.id);
  audit(null, req.user.id, 'tenant_' + (newStatus === 'active' ? 'activated' : 'suspended'), 'tenant', t.id, t.name, req.ip);
  res.json({ ok: true, status: newStatus });
});

// Per-tenant detailed stats
router.get('/tenants/:id/stats', (req, res) => {
  const db = getDB();
  const t = db.prepare('SELECT * FROM tenants WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'مستأجر یافت نشد' });
  const one = (sql) => db.prepare(sql).get(t.id);
  res.json({
    tenant: t,
    users: one('SELECT COUNT(*) c FROM users WHERE tenant_id=?').c,
    customers: one('SELECT COUNT(*) c FROM customers WHERE tenant_id=?').c,
    invoices: one('SELECT COUNT(*) c FROM invoices WHERE tenant_id=?').c,
    invoices_final: db.prepare("SELECT COUNT(*) c FROM invoices WHERE tenant_id=? AND type='final'").get(t.id).c,
    sales_total: db.prepare("SELECT COALESCE(SUM(final),0) s FROM invoices WHERE tenant_id=? AND type='final'").get(t.id).s,
    followups: one('SELECT COUNT(*) c FROM followups WHERE tenant_id=?').c,
    products: one('SELECT COUNT(*) c FROM products WHERE tenant_id=?').c,
  });
});

// Delete a tenant and ALL its data (dangerous; blocked for tenant 1)
router.delete('/tenants/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === 1) return res.status(400).json({ error: 'مستأجر اصلی قابل حذف نیست' });
  const db = getDB();
  const t = db.prepare('SELECT * FROM tenants WHERE id=?').get(id);
  if (!t) return res.status(404).json({ error: 'مستأجر یافت نشد' });
  if (req.body?.confirm_name !== t.name) {
    return res.status(400).json({ error: 'برای حذف، نام دقیق مستأجر را در confirm_name بفرستید' });
  }
  const tables = ['customers','orders','followups','invoices','products','stock_logs','messages','reminders',
    'sms_log','settlements','api_keys','webhooks','customer_ledger','incentive_payments','settings',
    'chart_of_accounts','api_usage_log','users'];
  const tx = db.transaction(() => {
    // journal_lines has no tenant_id — delete via its parent entries first
    db.prepare('DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE tenant_id=?)').run(id);
    db.prepare('DELETE FROM journal_entries WHERE tenant_id=?').run(id);
    for (const table of tables) db.prepare(`DELETE FROM ${table} WHERE tenant_id=?`).run(id);
    db.prepare('DELETE FROM tenants WHERE id=?').run(id);
  });
  tx();
  audit(null, req.user.id, 'tenant_deleted', 'tenant', id, `حذف کامل مستأجر ${t.name}`, req.ip);
  res.json({ ok: true });
});

module.exports = router;
