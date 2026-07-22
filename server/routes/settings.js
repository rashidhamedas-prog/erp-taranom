const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOnly, centralOnly } = require('../middleware/auth');
const { sendSMS } = require('../sms');
const { clearCoaCache } = require('../lib/coa-map');

const ALLOWED_KEYS = [
  'currency_base','currency_display',
  'coa_mode','coa_receivable','coa_payable','coa_sales','coa_sales_discount','coa_cogs','coa_inventory','coa_cash_default','coa_bank_default','coa_adjustment','coa_payroll_expense','coa_payroll_payable','coa_misc_persons','coa_vat_payable','coa_vat_receivable','coa_depreciation_expense','feature_cogs_voucher',
  'telegram_bot_token', 'telegram_chat_id',
  'sms_provider', 'sms_api_key', 'sms_from',
  'niksms_api_key', 'smsir_api_key', 'smsir_line',
  'company_name', 'company_phone', 'company_address',
  'kimia_address', 'welcome_sms_text',
  'api_v1_enabled', 'api_rate_limit', 'webhook_secret',
  'backup_smtp_user', 'backup_smtp_pass', 'backup_email', 'backup_password',
  // Admin panel (Phase 10): numbering sequences, fiscal year, module toggles
  'invoice_num_prefix', 'purchase_num_prefix', 'fiscal_year_start_month',
  'module_petty_cash', 'module_trust_checks', 'module_warehouses',
  'module_consignments', 'module_production', 'module_payroll', 'module_reps',
  'module_moadian', 'module_fixed_assets',
  'vat_rate', 'moadian_enabled', 'moadian_fiscal_id', 'moadian_private_key_path',
  // AI assistant (v4 port) + B2B customer portal feature flags
  'feature_ai_assistant', 'ai_api_key', 'ai_model', 'feature_b2b_portal',
  // Website stock sync + Rubika invoice
  'website_stock_sync_enabled', 'website_stock_sync_mode', 'website_stock_webhook_url',
  'website_wc_url', 'website_wc_key', 'website_wc_secret',
  'rubika_bot_token', 'rubika_chat_id', 'rubika_invoice_enabled'
];

// Module flags a non-admin (e.g. accounting role) also needs, to know which
// Accounting-shell nav items to hide — safe to expose (no secrets), unlike
// the full settings list which is admin-only.
const MODULE_KEYS = [
  'module_petty_cash', 'module_trust_checks', 'module_warehouses',
  'module_consignments', 'module_production', 'module_payroll', 'module_reps',
  'module_moadian', 'module_fixed_assets',
  'coa_mode', 'currency_display'
];
router.get('/modules', auth, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`SELECT key,value FROM settings WHERE key IN (${MODULE_KEYS.map(() => '?').join(',')})`).all(...MODULE_KEYS);
  const obj = {};
  for (const k of MODULE_KEYS) obj[k] = (k === 'coa_mode') ? '' : (k === 'currency_display' ? 'rial' : '1');
  for (const r of rows) obj[r.key] = r.value;
  res.json(obj);
});

// GET all settings (admin only)
router.get('/', auth, adminOnly, (req, res) => {
  const db = getDB();
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  res.json(obj);
});

// PUT upsert key-value pairs (admin only)
router.put('/', auth, adminOnly, centralOnly, (req, res) => {
  const db = getDB();
  const stmt = db.prepare(`
    INSERT INTO settings (key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `);
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) {
      if (!ALLOWED_KEYS.includes(k)) continue;
      stmt.run(k, v == null ? '' : String(v));
    }
  });
  const entries = Object.entries(req.body || {});
  tx(entries);
  if (entries.some(([k]) => k.startsWith('coa_') || k === 'feature_cogs_voucher')) clearCoaCache();
  audit(req.user.id, 'update', 'settings', null, 'بروزرسانی تنظیمات');
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  res.json(obj);
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
  const rows = db.prepare("SELECT key,value FROM settings WHERE key IN ('sms_provider','sms_api_key','sms_from','welcome_sms_text','kimia_address')").all();
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
