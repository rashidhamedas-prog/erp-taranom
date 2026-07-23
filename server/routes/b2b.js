// B2B customer portal — ported from CRM v4 (single-tenant adaptation).
//
// CENTRAL-ONLY: the portal is a public web surface; device builds return 403
// on every endpoint (tables are not synced). Portal orders create a normal
// proforma invoice owned by the customer's salesperson — that invoice flows
// through the existing approval / conversion / sync machinery untouched.
//
// Security model:
//  - Portal tokens carry scope:'b2b' and are rejected by the internal staff
//    auth middleware (and vice versa: staff tokens are rejected here).
//  - Every /me/* query is pinned to the customer id inside the token.
//  - Login requires customers.b2b_enabled=1 AND an active portal account AND
//    the feature_b2b_portal setting turned on.
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getDB, audit, allocateNumber } = require('../db');
const { auth: internalAuth, adminOnly, centralOnlyStrict, SECRET } = require('../middleware/auth');
const { sendSMS } = require('../sms');
const { todayJalali } = require('../jalali');

router.use(centralOnlyStrict);

function getSettingValue(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : '';
}

function featureEnabled(db) {
  return getSettingValue(db, 'feature_b2b_portal') === '1';
}

function issueB2BToken(account) {
  return jwt.sign({ id: account.customer_id, aid: account.id, scope: 'b2b' }, SECRET, { expiresIn: '7d' });
}

// Portal session middleware — only accepts scope:'b2b' tokens
function b2bAuth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'توکن یافت نشد' });
  try {
    const payload = jwt.verify(token, SECRET);
    if (payload.scope !== 'b2b') return res.status(401).json({ error: 'توکن نامعتبر' });
    const db = getDB();
    const acc = db.prepare(
      'SELECT a.*, c.biz, c.b2b_enabled FROM b2b_portal_accounts a JOIN customers c ON a.customer_id=c.id WHERE a.id=? AND a.active=1'
    ).get(payload.aid);
    if (!acc || !acc.b2b_enabled) return res.status(401).json({ error: 'دسترسی پورتال غیرفعال است' });
    if (!featureEnabled(db)) return res.status(403).json({ error: 'پورتال B2B فعال نیست' });
    req.account = acc;
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

// ── Auth: phone + password ───────────────────────────────────────────────────
router.post('/auth/login', (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const password = String(req.body.password || '').slice(0, 128);
  if (!phone || !password) return res.status(400).json({ error: 'اطلاعات ناقص' });
  const db = getDB();
  if (!featureEnabled(db)) return res.status(403).json({ error: 'پورتال B2B فعال نیست' });
  const acc = findAccount(db, phone);
  if (!acc || !acc.password || !bcrypt.compareSync(password, acc.password)) {
    return res.status(401).json({ error: 'شماره یا رمز عبور اشتباه است' });
  }
  db.prepare("UPDATE b2b_portal_accounts SET last_login=strftime('%s','now') WHERE id=?").run(acc.id);
  audit(null, 'b2b_login', 'b2b_account', acc.id, `ورود پورتال ${acc.biz}`, req);
  res.json({ token: issueB2BToken(acc), customer: { id: acc.customer_id, biz: acc.biz } });
});

// ── Auth: SMS OTP (request + verify) ────────────────────────────────────────
router.post('/auth/otp', async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'شماره موبایل الزامی است' });
  const db = getDB();
  // uniform response — never leak whether the phone exists
  const generic = { ok: true, message: 'در صورت فعال بودن حساب، کد ورود پیامک شد' };
  if (!featureEnabled(db)) return res.json(generic);
  const acc = findAccount(db, phone);
  if (!acc) return res.json(generic);

  const otp = String(crypto.randomInt(100000, 999999));
  const hash = crypto.createHash('sha256').update(otp).digest('hex');
  db.prepare('UPDATE b2b_portal_accounts SET otp_hash=?, otp_expires=? WHERE id=?')
    .run(hash, Math.floor(Date.now() / 1000) + 300, acc.id);

  const rows = db.prepare("SELECT key,value FROM settings WHERE key IN ('sms_provider','sms_api_key','sms_from')").all();
  const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
  if (settings.sms_api_key) {
    await sendSMS(settings, phone, `کد ورود پورتال ترنم: ${otp}\nاعتبار: ۵ دقیقه`);
  } else {
    console.log(`📟 [B2B OTP] phone=${phone} otp=${otp} (SMS تنظیم نشده)`);
  }
  res.json(generic);
});

router.post('/auth/otp/verify', (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const otp = String(req.body.code || req.body.otp || '').replace(/\D/g, '');
  if (!phone || !otp) return res.status(400).json({ error: 'اطلاعات ناقص' });
  const db = getDB();
  if (!featureEnabled(db)) return res.status(403).json({ error: 'پورتال B2B فعال نیست' });
  const acc = findAccount(db, phone);
  if (!acc || !acc.otp_hash || !acc.otp_expires) return res.status(401).json({ error: 'کد نامعتبر است' });
  if (acc.otp_expires < Math.floor(Date.now() / 1000)) return res.status(401).json({ error: 'کد منقضی شده — دوباره درخواست کنید' });
  const hash = crypto.createHash('sha256').update(otp).digest('hex');
  if (hash !== acc.otp_hash) return res.status(401).json({ error: 'کد نامعتبر است' });
  db.prepare("UPDATE b2b_portal_accounts SET otp_hash=NULL, otp_expires=NULL, last_login=strftime('%s','now') WHERE id=?").run(acc.id);
  audit(null, 'b2b_login', 'b2b_account', acc.id, `ورود پورتال با OTP - ${acc.biz}`, req);
  res.json({ token: issueB2BToken(acc), customer: { id: acc.customer_id, biz: acc.biz } });
});

// ── Authenticated portal endpoints — every query pinned to req.customerId ───
router.use('/me', b2bAuth);

// Live account statement (same engine the accounting module uses)
router.get('/me/statement', (req, res) => {
  const { buildStatement } = require('./accounting');
  const db = getDB();
  const safeDate = v => (v && /^[\d/]+$/.test(v)) ? v : undefined;
  const data = buildStatement(db, req.customerId, { from: safeDate(req.query.from), to: safeDate(req.query.to) });
  if (!data) return res.status(404).json({ error: 'یافت نشد' });
  delete data.customer.salesperson; // internal field
  res.json(data);
});

// Invoice history — own invoices only
router.get('/me/invoices', (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT id, num, type, date, subtotal, disc, disc_amt, final, pay_type, created_at
    FROM invoices WHERE cust_id=? ORDER BY created_at DESC LIMIT 200
  `).all(req.customerId);
  res.json(rows);
});

// Catalog for ordering (prices from the product table; stock only as a flag)
router.get('/me/catalog', (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT id, name, code, category, price, unit, image, stock > 0 as available
    FROM products ORDER BY category, name
  `).all();
  res.json(rows);
});

// Place a new order → recorded + proforma invoice + notify the salesperson
router.post('/me/orders', (req, res) => {
  const db = getDB();
  const items = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!items.length) return res.status(400).json({ error: 'سفارش خالی است' });
  if (items.length > 100) return res.status(400).json({ error: 'حداکثر ۱۰۰ ردیف' });

  let subtotal = 0;
  const rows = [];
  for (const r of items) {
    const prod = db.prepare('SELECT * FROM products WHERE id=?').get(parseInt(r.product_id));
    if (!prod) return res.status(400).json({ error: 'محصول نامعتبر در سفارش' });
    const qty = Math.max(1, Math.min(10000, parseInt(r.qty) || 1));
    // price ALWAYS from the product table — the portal client can never set it
    const sum = qty * prod.price;
    subtotal += sum;
    rows.push({ product_id: prod.id, name: prod.name, qty, price: prod.price, disc: 0, disc_amt: 0, sum });
  }

  const cust = db.prepare('SELECT * FROM customers WHERE id=?').get(req.customerId);
  if (!cust) return res.status(400).json({ error: 'مشتری یافت نشد' });
  const seller = db.prepare('SELECT name,phone FROM users WHERE id=?').get(cust.user_id);
  const prefixRow = db.prepare("SELECT value FROM settings WHERE key='invoice_num_prefix'").get();

  let out;
  try {
    out = db.transaction(() => {
      const order = db.prepare('INSERT INTO b2b_portal_orders (customer_id,rows,note,status) VALUES (?,?,?,?)')
        .run(req.customerId, JSON.stringify(rows), String(req.body.note || '').slice(0, 500), 'pending');
      // proforma invoice owned by the customer's salesperson — proformas post
      // no ledger/journal entries and deduct no stock until converted to final
      const num = allocateNumber(db, 'invoice', prefixRow?.value || 'T');
      const inv = db.prepare(
        'INSERT INTO invoices (user_id,cust_id,num,type,date,note,rows,subtotal,disc,disc_amt,final,seller_name,seller_phone,pay_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(cust.user_id, req.customerId, num, 'proforma', todayJalali(),
            `سفارش پورتال B2B شماره ${order.lastInsertRowid}`, JSON.stringify(rows), subtotal, 0, 0, subtotal,
            seller ? seller.name : '', seller ? (seller.phone || '') : '', 'cash');
      db.prepare('UPDATE b2b_portal_orders SET invoice_id=? WHERE id=?').run(inv.lastInsertRowid, order.lastInsertRowid);
      // internal message to the salesperson (admins see all messages)
      db.prepare('INSERT INTO messages (from_id,to_id,body) VALUES (?,?,?)')
        .run(cust.user_id, cust.user_id,
             `🛒 سفارش جدید پورتال B2B\nمشتری: ${cust.biz}\nپیش‌فاکتور: ${num}\nمبلغ: ${subtotal.toLocaleString('fa-IR')} ریال`);
      return { orderId: order.lastInsertRowid, invoiceNum: num };
    })();
  } catch (e) {
    return res.status(500).json({ error: 'ثبت سفارش ناموفق بود' });
  }
  audit(null, 'b2b_order', 'b2b_order', out.orderId, `سفارش پورتال ${cust.biz} → ${out.invoiceNum}`, req);
  res.json({ ok: true, ...out });
});

// Order history
router.get('/me/orders', (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT o.*, i.num as invoice_num, i.type as invoice_type
    FROM b2b_portal_orders o LEFT JOIN invoices i ON o.invoice_id=i.id
    WHERE o.customer_id=? ORDER BY o.created_at DESC LIMIT 100
  `).all(req.customerId);
  res.json(rows.map(r => ({ ...r, rows: JSON.parse(r.rows || '[]') })));
});

// ── Admin management (INTERNAL staff token) ──────────────────────────────────
router.post('/admin/customers/:id/access', internalAuth, adminOnly, (req, res) => {
  const db = getDB();
  const cust = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!cust) return res.status(404).json({ error: 'مشتری یافت نشد' });
  const enabled = req.body.enabled ? 1 : 0;
  const phone = normalizePhone(req.body.phone || cust.phone);
  const password = String(req.body.password || '');

  if (enabled && !phone) return res.status(400).json({ error: 'مشتری شماره موبایل ندارد' });
  if (enabled && password && password.length < 6) return res.status(400).json({ error: 'رمز حداقل ۶ کاراکتر' });

  db.transaction(() => {
    db.prepare('UPDATE customers SET b2b_enabled=? WHERE id=?').run(enabled, cust.id);
    const acc = db.prepare('SELECT * FROM b2b_portal_accounts WHERE customer_id=?').get(cust.id);
    if (enabled) {
      const hash = password ? bcrypt.hashSync(password, 10) : (acc ? acc.password : null);
      if (acc) {
        db.prepare('UPDATE b2b_portal_accounts SET phone=?, password=?, active=1 WHERE customer_id=?').run(phone, hash, cust.id);
      } else {
        db.prepare('INSERT INTO b2b_portal_accounts (customer_id,phone,password,active) VALUES (?,?,?,1)').run(cust.id, phone, hash);
      }
    } else if (acc) {
      db.prepare('UPDATE b2b_portal_accounts SET active=0 WHERE customer_id=?').run(cust.id);
    }
  })();
  audit(req.user.id, enabled ? 'b2b_enabled' : 'b2b_disabled', 'customer', cust.id, `پورتال B2B ${cust.biz}`, req);
  res.json({ ok: true, enabled: !!enabled });
});

// Admin: portal orders list (approval queue view)
router.get('/admin/orders', internalAuth, adminOnly, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT o.*, c.biz as cust_biz, i.num as invoice_num, i.type as invoice_type, i.converted as invoice_converted
    FROM b2b_portal_orders o
    JOIN customers c ON o.customer_id=c.id
    LEFT JOIN invoices i ON o.invoice_id=i.id
    ORDER BY o.created_at DESC LIMIT 200
  `).all();
  res.json(rows.map(r => ({ ...r, rows: JSON.parse(r.rows || '[]') })));
});

module.exports = router;
