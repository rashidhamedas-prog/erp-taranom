const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getDB, audit, getSetting } = require('../db');
const { SECRET } = require('../middleware/auth');
const { sendSMS } = require('../sms');
const { todayJalali } = require('../jalali');

// ── B2B auth: completely separate JWT scope from internal users ──────────────
function issueB2BToken(account) {
  return jwt.sign(
    { id: account.customer_id, aid: account.id, tid: account.tenant_id, scope: 'b2b' },
    SECRET, { expiresIn: '7d' }
  );
}

// B2B session middleware — only accepts scope:'b2b' tokens
function b2bAuth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'توکن یافت نشد' });
  try {
    const payload = jwt.verify(token, SECRET);
    if (payload.scope !== 'b2b') return res.status(401).json({ error: 'توکن نامعتبر' });
    const db = getDB();
    const acc = db.prepare('SELECT a.*, c.biz, c.b2b_enabled FROM b2b_portal_accounts a JOIN customers c ON a.customer_id=c.id WHERE a.id=? AND a.active=1').get(payload.aid);
    if (!acc || !acc.b2b_enabled) return res.status(401).json({ error: 'دسترسی پورتال غیرفعال است' });
    if (getSetting(acc.tenant_id, 'feature_b2b_portal') !== '1') return res.status(403).json({ error: 'پورتال B2B فعال نیست' });
    const tenant = db.prepare('SELECT status FROM tenants WHERE id=?').get(acc.tenant_id);
    if (!tenant || tenant.status !== 'active') return res.status(403).json({ error: 'حساب کسب‌وکار غیرفعال است' });
    req.account = acc;
    req.tenantId = acc.tenant_id;
    req.customerId = acc.customer_id;
    next();
  } catch {
    res.status(401).json({ error: 'توکن نامعتبر' });
  }
}

function normalizePhone(p) {
  return String(p || '')
    .replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x06F0)
    .replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x0660)
    .replace(/\D/g, '')
    .replace(/^98/, '0')
    .slice(0, 11);
}

function findAccount(db, phone) {
  return db.prepare(`
    SELECT a.*, c.biz, c.b2b_enabled FROM b2b_portal_accounts a
    JOIN customers c ON a.customer_id=c.id
    WHERE a.phone=? AND a.active=1 AND c.b2b_enabled=1
  `).get(phone);
}

// Login with phone + password
router.post('/auth/login', (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const password = String(req.body.password || '').slice(0, 128);
  if (!phone || !password) return res.status(400).json({ error: 'اطلاعات ناقص' });
  const db = getDB();
  const acc = findAccount(db, phone);
  if (!acc || !acc.password || !bcrypt.compareSync(password, acc.password)) {
    return res.status(401).json({ error: 'شماره یا رمز عبور اشتباه است' });
  }
  if (getSetting(acc.tenant_id, 'feature_b2b_portal') !== '1') return res.status(403).json({ error: 'پورتال B2B فعال نیست' });
  db.prepare("UPDATE b2b_portal_accounts SET last_login=strftime('%s','now') WHERE id=?").run(acc.id);
  audit(acc.tenant_id, null, 'b2b_login', 'b2b_account', acc.id, `ورود پورتال ${acc.biz}`, req.ip);
  res.json({ token: issueB2BToken(acc), customer: { id: acc.customer_id, biz: acc.biz } });
});

// Request an SMS OTP
router.post('/auth/otp', async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'شماره موبایل الزامی است' });
  const db = getDB();
  const acc = findAccount(db, phone);
  // uniform response — do not leak whether the phone exists
  const generic = { ok: true, message: 'در صورت فعال بودن حساب، کد ورود پیامک شد' };
  if (!acc) return res.json(generic);
  if (getSetting(acc.tenant_id, 'feature_b2b_portal') !== '1') return res.json(generic);

  const otp = String(crypto.randomInt(100000, 999999));
  const hash = crypto.createHash('sha256').update(otp).digest('hex');
  db.prepare('UPDATE b2b_portal_accounts SET otp_hash=?, otp_expires=? WHERE id=?')
    .run(hash, Math.floor(Date.now() / 1000) + 300, acc.id);

  const rows = db.prepare("SELECT key,value FROM settings WHERE tenant_id=? AND key IN ('sms_provider','sms_api_key','sms_from','niksms_api_key','smsir_api_key','smsir_line')").all(acc.tenant_id);
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;
  if (settings.sms_api_key) {
    await sendSMS(settings, phone, `کد ورود پورتال: ${otp}\nاعتبار: ۵ دقیقه`);
  } else {
    console.log(`📟 [B2B OTP] tenant=${acc.tenant_id} phone=${phone} otp=${otp} (SMS تنظیم نشده)`);
  }
  res.json(generic);
});

// Verify OTP → token
router.post('/auth/otp/verify', (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const otp = String(req.body.otp || '').replace(/\D/g, '');
  if (!phone || !otp) return res.status(400).json({ error: 'اطلاعات ناقص' });
  const db = getDB();
  const acc = findAccount(db, phone);
  if (!acc || !acc.otp_hash || !acc.otp_expires) return res.status(401).json({ error: 'کد نامعتبر است' });
  if (acc.otp_expires < Math.floor(Date.now() / 1000)) return res.status(401).json({ error: 'کد منقضی شده — دوباره درخواست کنید' });
  const hash = crypto.createHash('sha256').update(otp).digest('hex');
  if (hash !== acc.otp_hash) return res.status(401).json({ error: 'کد نامعتبر است' });
  db.prepare("UPDATE b2b_portal_accounts SET otp_hash=NULL, otp_expires=NULL, last_login=strftime('%s','now') WHERE id=?").run(acc.id);
  audit(acc.tenant_id, null, 'b2b_login', 'b2b_account', acc.id, `ورود پورتال با OTP - ${acc.biz}`, req.ip);
  res.json({ token: issueB2BToken(acc), customer: { id: acc.customer_id, biz: acc.biz } });
});

// ── Authenticated portal endpoints — every query pinned to req.customerId ────
router.use('/me', b2bAuth);

// Live account statement (same engine the accounting module uses)
router.get('/me/statement', (req, res) => {
  const db = getDB();
  const { buildStatement } = require('./accounting');
  const safeDate = v => (v && /^[\d/]+$/.test(v)) ? v : undefined;
  const data = buildStatement(db, req.tenantId, req.customerId, { from: safeDate(req.query.from), to: safeDate(req.query.to) });
  if (!data) return res.status(404).json({ error: 'یافت نشد' });
  // strip internal fields
  delete data.customer.salesperson;
  res.json(data);
});

// Invoice history — own invoices only
router.get('/me/invoices', (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT id, num, type, date, subtotal, disc, disc_amt, final, pay_type, created_at
    FROM invoices WHERE tenant_id=? AND cust_id=? ORDER BY created_at DESC LIMIT 200
  `).all(req.tenantId, req.customerId);
  res.json(rows);
});

// Invoice PDF — ownership enforced
router.get('/me/invoices/:id/pdf', async (req, res) => {
  const db = getDB();
  const inv = db.prepare('SELECT i.*,c.biz as cust_biz,c.owner as cust_owner,c.city as cust_city,c.phone as cust_phone FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.id=? AND i.tenant_id=? AND i.cust_id=?')
    .get(req.params.id, req.tenantId, req.customerId);
  if (!inv) return res.status(404).json({ error: 'فاکتور یافت نشد' });
  try {
    const { renderInvoiceHTML } = require('./invoices');
    const pdfService = require('../services/pdf');
    const path = require('path');
    const fs = require('fs');
    const filename = `inv-${req.tenantId}-${inv.id}-A4.pdf`;
    const filePath = path.join(pdfService.PDF_DIR, filename);
    if (!fs.existsSync(filePath)) {
      await pdfService.renderToFile(renderInvoiceHTML(db, req.tenantId, inv, 'A4'), filename, { format: 'A4' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=invoice-${inv.id}.pdf`);
    res.send(fs.readFileSync(filePath));
  } catch (e) {
    res.status(500).json({ error: 'خطا در تولید PDF' });
  }
});

// Active catalog for ordering
router.get('/me/catalog', (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT id, name, code, category, price, unit, colors, pack_size, image, stock > 0 as available
    FROM products WHERE tenant_id=? ORDER BY category, name
  `).all(req.tenantId);
  res.json(rows);
});

// Place a new order → recorded + proforma invoice in the approval queue + notify salesperson
router.post('/me/orders', (req, res) => {
  const db = getDB();
  const items = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!items.length) return res.status(400).json({ error: 'سفارش خالی است' });
  if (items.length > 100) return res.status(400).json({ error: 'حداکثر ۱۰۰ ردیف' });

  let subtotal = 0;
  const rows = [];
  for (const r of items) {
    const prod = db.prepare('SELECT * FROM products WHERE id=? AND tenant_id=?').get(parseInt(r.product_id), req.tenantId);
    if (!prod) return res.status(400).json({ error: 'محصول نامعتبر در سفارش' });
    const qty = Math.max(1, parseInt(r.qty) || 1);
    const sum = qty * prod.price;
    subtotal += sum;
    rows.push({ product_id: prod.id, name: prod.name, qty, price: prod.price, sum, mac_cost: prod.mac_cost || prod.cost || 0 });
  }

  const cust = db.prepare('SELECT * FROM customers WHERE id=? AND tenant_id=?').get(req.customerId, req.tenantId);
  const tx = db.transaction(() => {
    const order = db.prepare('INSERT INTO b2b_portal_orders (tenant_id,customer_id,rows,note,status) VALUES (?,?,?,?,?)')
      .run(req.tenantId, req.customerId, JSON.stringify(rows), String(req.body.note || '').slice(0, 500), 'pending');
    // proforma invoice into the approval queue, owned by the customer's salesperson
    const count = db.prepare('SELECT COUNT(*) as c FROM invoices WHERE tenant_id=?').get(req.tenantId).c;
    const num = 'T-' + String(count + 1).padStart(4, '0');
    const inv = db.prepare(
      'INSERT INTO invoices (tenant_id,user_id,cust_id,num,type,date,note,rows,subtotal,disc,disc_amt,final,pay_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(req.tenantId, cust.user_id, req.customerId, num, 'proforma', todayJalali(),
          `سفارش پورتال B2B شماره ${order.lastInsertRowid}`, JSON.stringify(rows), subtotal, 0, 0, subtotal, 'cash');
    db.prepare('UPDATE b2b_portal_orders SET invoice_id=? WHERE id=?').run(inv.lastInsertRowid, order.lastInsertRowid);
    // notify the salesperson (and admins see all messages anyway)
    db.prepare('INSERT INTO messages (tenant_id,from_id,to_id,body) VALUES (?,?,?,?)')
      .run(req.tenantId, cust.user_id, cust.user_id,
           `🛒 سفارش جدید پورتال B2B\nمشتری: ${cust.biz}\nپیش‌فاکتور: ${num}\nمبلغ: ${subtotal.toLocaleString('fa-IR')} تومان`);
    return { orderId: order.lastInsertRowid, invoiceNum: num };
  });
  const out = tx();
  audit(req.tenantId, null, 'b2b_order', 'b2b_order', out.orderId, `سفارش پورتال ${cust.biz} → ${out.invoiceNum}`, req.ip);
  res.json({ ok: true, ...out });
});

// Order history
router.get('/me/orders', (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT o.*, i.num as invoice_num, i.type as invoice_type
    FROM b2b_portal_orders o LEFT JOIN invoices i ON o.invoice_id=i.id
    WHERE o.tenant_id=? AND o.customer_id=? ORDER BY o.created_at DESC LIMIT 100
  `).all(req.tenantId, req.customerId);
  res.json(rows.map(r => ({ ...r, rows: JSON.parse(r.rows || '[]') })));
});

// ── Admin management: enable/disable portal access per customer ──────────────
// Mounted under /api/b2b but authenticated with the INTERNAL admin token.
const { auth: internalAuth, adminOnly } = require('../middleware/auth');

router.post('/admin/customers/:id/access', internalAuth, adminOnly, (req, res) => {
  const db = getDB();
  const cust = db.prepare('SELECT * FROM customers WHERE id=? AND tenant_id=?').get(req.params.id, req.tenantId);
  if (!cust) return res.status(404).json({ error: 'مشتری یافت نشد' });
  const enabled = req.body.enabled ? 1 : 0;
  const phone = normalizePhone(req.body.phone || cust.phone);
  const password = String(req.body.password || '');

  if (enabled && !phone) return res.status(400).json({ error: 'مشتری شماره موبایل ندارد' });
  if (enabled && password && password.length < 6) return res.status(400).json({ error: 'رمز حداقل ۶ کاراکتر' });

  const tx = db.transaction(() => {
    db.prepare('UPDATE customers SET b2b_enabled=? WHERE id=? AND tenant_id=?').run(enabled, cust.id, req.tenantId);
    const acc = db.prepare('SELECT * FROM b2b_portal_accounts WHERE customer_id=? AND tenant_id=?').get(cust.id, req.tenantId);
    if (enabled) {
      const hash = password ? bcrypt.hashSync(password, 10) : (acc ? acc.password : null);
      if (acc) {
        db.prepare('UPDATE b2b_portal_accounts SET phone=?, password=?, active=1 WHERE customer_id=? AND tenant_id=?').run(phone, hash, cust.id, req.tenantId);
      } else {
        db.prepare('INSERT INTO b2b_portal_accounts (tenant_id,customer_id,phone,password,active) VALUES (?,?,?,?,1)')
          .run(req.tenantId, cust.id, phone, hash);
      }
    } else if (acc) {
      db.prepare('UPDATE b2b_portal_accounts SET active=0 WHERE customer_id=? AND tenant_id=?').run(cust.id, req.tenantId);
    }
  });
  tx();
  audit(req.tenantId, req.user.id, enabled ? 'b2b_enabled' : 'b2b_disabled', 'customer', cust.id, `پورتال B2B ${cust.biz}`, req.ip);
  res.json({ ok: true, enabled: !!enabled });
});

// Admin: list pending portal orders (approval queue view)
router.get('/admin/orders', internalAuth, adminOnly, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT o.*, c.biz as cust_biz, i.num as invoice_num, i.type as invoice_type
    FROM b2b_portal_orders o
    JOIN customers c ON o.customer_id=c.id
    LEFT JOIN invoices i ON o.invoice_id=i.id
    WHERE o.tenant_id=? ORDER BY o.created_at DESC LIMIT 200
  `).all(req.tenantId);
  res.json(rows.map(r => ({ ...r, rows: JSON.parse(r.rows || '[]') })));
});

module.exports = router;
