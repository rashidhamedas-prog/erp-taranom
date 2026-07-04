const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const { sendSMS } = require('../sms');

const ALLOWED_KEYS = [
  'telegram_bot_token', 'telegram_chat_id',
  'sms_provider', 'sms_api_key', 'sms_from',
  'niksms_api_key', 'smsir_api_key', 'smsir_line',
  'company_name', 'company_phone', 'company_address',
  'kimia_address', 'welcome_sms_text',
  'api_v1_enabled', 'api_rate_limit', 'webhook_secret',
  'backup_smtp_user', 'backup_smtp_pass', 'backup_email',
  // v4 feature flags + module settings
  'feature_wms', 'feature_b2b_portal', 'feature_ai_assistant', 'feature_einvoice',
  'twofa_required_roles', 'ai_api_key',
];

// Moadian e-invoice settings live behind their own endpoint (PUT /settings/einvoice)
const EINVOICE_KEYS = ['einvoice_memory_id', 'einvoice_private_key', 'einvoice_service_url', 'einvoice_mode'];

// Branding (white-label) settings live behind PUT /settings/branding
const BRANDING_KEYS = ['brand_color', 'brand_color2', 'logo'];

function readAll(db, tenantId) {
  const rows = db.prepare('SELECT key,value FROM settings WHERE tenant_id=?').all(tenantId);
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  // never ship the private key material back to the browser — only a set/unset flag
  if (obj.einvoice_private_key) obj.einvoice_private_key = '__set__';
  if (obj.ai_api_key) obj.ai_api_key = '__set__';
  return obj;
}

// GET all settings (admin only)
router.get('/', auth, adminOnly, (req, res) => {
  const db = getDB();
  const obj = readAll(db, req.tenantId);
  // include tenant branding
  const t = db.prepare('SELECT brand_color, brand_color2, logo, name FROM tenants WHERE id=?').get(req.tenantId);
  res.json({ ...obj, ...t });
});

// PUT upsert key-value pairs (admin only)
router.put('/', auth, adminOnly, (req, res) => {
  const db = getDB();
  const stmt = db.prepare(`
    INSERT INTO settings (tenant_id,key,value) VALUES (?,?,?)
    ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value
  `);
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) {
      if (!ALLOWED_KEYS.includes(k)) continue;
      if (v === '__set__') continue; // masked placeholder — leave stored secret untouched
      stmt.run(req.tenantId, k, v == null ? '' : String(v));
    }
  });
  tx(Object.entries(req.body || {}));
  audit(req.tenantId, req.user.id, 'update', 'settings', null, 'بروزرسانی تنظیمات', req.ip);
  res.json(readAll(db, req.tenantId));
});

// PUT Moadian e-invoice connection settings (admin only)
router.put('/einvoice', auth, adminOnly, (req, res) => {
  const db = getDB();
  const stmt = db.prepare(`
    INSERT INTO settings (tenant_id,key,value) VALUES (?,?,?)
    ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value
  `);
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) {
      if (!EINVOICE_KEYS.includes(k)) continue;
      if (v === '__set__') continue;
      stmt.run(req.tenantId, k, v == null ? '' : String(v));
    }
  });
  tx(Object.entries(req.body || {}));
  audit(req.tenantId, req.user.id, 'update', 'settings', null, 'بروزرسانی تنظیمات مودیان', req.ip);
  res.json({ ok: true });
});

// PUT tenant branding (white-label) — writes to the tenants table
router.put('/branding', auth, adminOnly, (req, res) => {
  const db = getDB();
  const { brand_color, brand_color2, logo } = req.body || {};
  const hex = /^#[0-9a-fA-F]{6}$/;
  if (brand_color && !hex.test(brand_color)) return res.status(400).json({ error: 'رنگ نامعتبر' });
  if (brand_color2 && !hex.test(brand_color2)) return res.status(400).json({ error: 'رنگ نامعتبر' });
  db.prepare('UPDATE tenants SET brand_color=COALESCE(?,brand_color), brand_color2=COALESCE(?,brand_color2), logo=COALESCE(?,logo) WHERE id=?')
    .run(brand_color ?? null, brand_color2 ?? null, logo ?? null, req.tenantId);
  audit(req.tenantId, req.user.id, 'update', 'settings', null, 'بروزرسانی هویت برند', req.ip);
  res.json({ ok: true });
});

const DEFAULT_WELCOME_SMS = `سلام 🌸 به خانواده پوشاک ترنم خوش‌آمدید!

برای اطلاع از جدیدترین محصولات و تخفیف‌های ویژه، ما را دنبال کنید:

📱 روبیکا: rubika.ir/toliditaranom_omde
✈️ تلگرام: t.me/toliditaranom
💬 بله: bale.ai/toliditaranom
{address}
پوشاک ترنم 🌿`;

// Test SMS — sends the welcome SMS template to the given phone number
router.post('/test-sms', auth, adminOnly, async (req, res) => {
  const db = getDB();
  const rows = db.prepare("SELECT key,value FROM settings WHERE tenant_id=? AND key IN ('sms_provider','sms_api_key','sms_from','welcome_sms_text','kimia_address')").all(req.tenantId);
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;
  const to = (req.body.phone || '').trim();
  if (!to) return res.status(400).json({ error: 'شماره موبایل الزامی است' });
  const addrLine = settings.kimia_address ? `\n🏢 آدرس دفتر: ${settings.kimia_address}` : '';
  const text = (settings.welcome_sms_text || DEFAULT_WELCOME_SMS).replace('{address}', addrLine);
  const result = await sendSMS(settings, to, text);
  res.json(result);
});

module.exports = router;
