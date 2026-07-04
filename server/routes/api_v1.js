const router = require('express').Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { getDB } = require('../db');
const { todayJalali, nowHHMM } = require('../jalali');

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// API key authentication middleware — the key row determines the tenant scope
function apiAuth(req, res, next) {
  const db = getDB();

  // Extract key from Bearer token or query param
  let rawKey = null;
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) rawKey = auth.slice(7).trim();
  else if (req.query.api_key) rawKey = req.query.api_key.trim();

  if (!rawKey) return res.status(401).json({ error: 'API key الزامی است' });
  if (!rawKey.startsWith('trn_')) return res.status(401).json({ error: 'فرمت API key نامعتبر است' });

  const keyHash = hashKey(rawKey);
  const keyRow = db.prepare('SELECT * FROM api_keys WHERE key_hash=? AND active=1').get(keyHash);
  if (!keyRow) return res.status(401).json({ error: 'API key نامعتبر یا غیرفعال است' });

  // API must be enabled for the key's tenant, and the tenant itself must be active
  const enabled = db.prepare("SELECT value FROM settings WHERE tenant_id=? AND key='api_v1_enabled'").get(keyRow.tenant_id);
  if (!enabled || enabled.value !== '1') return res.status(503).json({ error: 'API غیرفعال است' });
  const tenant = db.prepare('SELECT status FROM tenants WHERE id=?').get(keyRow.tenant_id);
  if (!tenant || tenant.status !== 'active') return res.status(403).json({ error: 'حساب کسب‌وکار غیرفعال است' });

  // Update last_used
  db.prepare('UPDATE api_keys SET last_used=? WHERE id=?').run(Math.floor(Date.now() / 1000), keyRow.id);

  // Log usage
  try {
    db.prepare('INSERT INTO api_usage_log (tenant_id,api_key_id,endpoint,method,status,ip) VALUES (?,?,?,?,?,?)')
      .run(keyRow.tenant_id, keyRow.id, req.path, req.method, 200, req.ip);
  } catch {}

  req.apiKey = keyRow;
  req.tenantId = keyRow.tenant_id;
  next();
}

const apiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: (req) => {
    const db = getDB();
    const limit = db.prepare("SELECT value FROM settings WHERE tenant_id=? AND key='api_rate_limit'").get(req.tenantId || 0);
    return parseInt(limit?.value) || 100;
  },
  keyGenerator: (req) => req.apiKey?.id || req.ip,
  standardHeaders: true,
  message: { error: 'تعداد درخواست بیش از حد مجاز است' }
});

router.use(apiAuth);
router.use(apiLimiter);

// ── Customers ──────────────────────────────────────────────
router.get('/customers', (req, res) => {
  const db = getDB();
  const { q, status, limit = 50, offset = 0 } = req.query;
  let sql = 'SELECT id,biz,owner,city,phone,insta,type,status,note,created_at FROM customers WHERE tenant_id=?';
  const params = [req.tenantId];
  if (q) { sql += ' AND (biz LIKE ? OR owner LIKE ? OR phone LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (status) { sql += ' AND status=?'; params.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(Math.min(200, parseInt(limit)), parseInt(offset));
  res.json(db.prepare(sql).all(...params));
});

router.get('/customers/:id', (req, res) => {
  const db = getDB();
  const c = db.prepare('SELECT id,biz,owner,city,phone,insta,type,status,note,created_at FROM customers WHERE id=? AND tenant_id=?').get(req.params.id, req.tenantId);
  if (!c) return res.status(404).json({ error: 'مشتری یافت نشد' });
  res.json(c);
});

router.post('/customers', (req, res) => {
  if (!req.apiKey.scopes.includes('write')) return res.status(403).json({ error: 'دسترسی نوشتن ندارید' });
  const { biz, owner, city, phone, insta, type = 'بوتیک', status = 'new', note } = req.body;
  if (!biz) return res.status(400).json({ error: 'نام کسب‌وکار الزامی است' });
  const db = getDB();
  // Assign to first admin user of the tenant
  const admin = db.prepare("SELECT id FROM users WHERE tenant_id=? AND role='admin' LIMIT 1").get(req.tenantId);
  if (!admin) return res.status(500).json({ error: 'کاربر ادمین یافت نشد' });
  const r = db.prepare('INSERT INTO customers (tenant_id,user_id,biz,owner,city,phone,insta,type,status,note) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(req.tenantId, admin.id, biz, owner || '', city || '', phone || '', insta || '', type, status, note || '');
  res.status(201).json({ id: r.lastInsertRowid, biz, owner, city, phone, type, status });
});

// ── Follow-ups ─────────────────────────────────────────────
router.get('/followups', (req, res) => {
  const db = getDB();
  const { cust_id, status, date, limit = 50, offset = 0 } = req.query;
  let sql = 'SELECT f.*,c.biz as cust_biz FROM followups f LEFT JOIN customers c ON f.cust_id=c.id WHERE f.tenant_id=?';
  const params = [req.tenantId];
  if (cust_id) { sql += ' AND f.cust_id=?'; params.push(cust_id); }
  if (status) { sql += ' AND f.status=?'; params.push(status); }
  if (date) { sql += ' AND f.next_date=?'; params.push(date); }
  sql += ' ORDER BY f.created_at DESC LIMIT ? OFFSET ?';
  params.push(Math.min(200, parseInt(limit)), parseInt(offset));
  res.json(db.prepare(sql).all(...params));
});

router.post('/followups', (req, res) => {
  if (!req.apiKey.scopes.includes('write')) return res.status(403).json({ error: 'دسترسی نوشتن ندارید' });
  const { cust_id, subject, note, next_date, next_time, priority = 'mid', pipeline_stage = 'lead' } = req.body;
  if (!cust_id) return res.status(400).json({ error: 'cust_id الزامی است' });
  const db = getDB();
  const cust = db.prepare('SELECT id FROM customers WHERE id=? AND tenant_id=?').get(cust_id, req.tenantId);
  if (!cust) return res.status(404).json({ error: 'مشتری یافت نشد' });
  const admin = db.prepare("SELECT id FROM users WHERE tenant_id=? AND role='admin' LIMIT 1").get(req.tenantId);
  const r = db.prepare(
    'INSERT INTO followups (tenant_id,user_id,cust_id,date,time,type,subject,note,next_date,next_time,status,priority,pipeline_stage) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(req.tenantId, admin?.id || 1, cust_id, todayJalali(), nowHHMM(), 'API', subject || '', note || '', next_date || '', next_time || '', 'open', priority, pipeline_stage);
  res.status(201).json({ id: r.lastInsertRowid });
});

// ── Invoices ───────────────────────────────────────────────
router.get('/invoices', (req, res) => {
  const db = getDB();
  const { type, limit = 50, offset = 0 } = req.query;
  let sql = 'SELECT i.id,i.num,i.type,i.date,i.final,i.disc,c.biz as cust_biz FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.tenant_id=?';
  const params = [req.tenantId];
  if (type) { sql += ' AND i.type=?'; params.push(type); }
  sql += ' ORDER BY i.created_at DESC LIMIT ? OFFSET ?';
  params.push(Math.min(200, parseInt(limit)), parseInt(offset));
  res.json(db.prepare(sql).all(...params));
});

router.get('/invoices/:id', (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT i.*,c.biz as cust_biz FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.id=? AND i.tenant_id=?').get(req.params.id, req.tenantId);
  if (!row) return res.status(404).json({ error: 'فاکتور یافت نشد' });
  if (row.rows) try { row.rows = JSON.parse(row.rows); } catch {}
  res.json(row);
});

// ── Products ───────────────────────────────────────────────
router.get('/products', (req, res) => {
  const db = getDB();
  const { q, category, limit = 100, offset = 0 } = req.query;
  let sql = 'SELECT id,category,code,barcode,name,price,stock,unit FROM products WHERE tenant_id=?';
  const params = [req.tenantId];
  if (q) { sql += ' AND (name LIKE ? OR code LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  if (category) { sql += ' AND category=?'; params.push(category); }
  sql += ' ORDER BY name LIMIT ? OFFSET ?';
  params.push(Math.min(500, parseInt(limit)), parseInt(offset));
  res.json(db.prepare(sql).all(...params));
});

// ── Warehouse stock (per-warehouse breakdown) ─────────────
router.get('/warehouse/stock', (req, res) => {
  const db = getDB();
  try {
    const rows = db.prepare(`
      SELECT ws.product_id, p.name as product_name, p.code, ws.warehouse_id, w.name as warehouse_name, ws.qty
      FROM warehouse_stock ws
      JOIN warehouses w ON ws.warehouse_id=w.id
      JOIN products p ON ws.product_id=p.id
      WHERE w.tenant_id=? AND p.tenant_id=?
      ORDER BY p.name, w.name
    `).all(req.tenantId, req.tenantId);
    res.json(rows);
  } catch {
    res.json([]); // WMS tables not present yet
  }
});

// ── System ─────────────────────────────────────────────────
router.get('/ping', (req, res) => {
  res.json({ ok: true, ts: Date.now(), version: 'v1' });
});

module.exports = router;
