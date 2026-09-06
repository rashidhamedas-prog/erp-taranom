const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOnly, centralOnly } = require('../middleware/auth');
const { sendSMS } = require('../sms');
const { clearCoaCache } = require('../lib/coa-map');
const { assertSafeOutboundTarget } = require('../lib/safe-outbound-request');
const {
  getPublicSettings,
  getSmsSettings,
  updateSettings,
} = require('../lib/secret-settings');

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
  'module_moadian', 'module_fixed_assets', 'module_portal',
  'vat_rate', 'moadian_enabled', 'moadian_fiscal_id', 'moadian_private_key_path',
  // AI assistant (v4 port) + B2B customer portal feature flags
  'feature_ai_assistant', 'ai_api_key', 'ai_model', 'ai_provider', 'feature_b2b_portal',
  // Website stock sync + Rubika invoice
  'website_stock_sync_enabled', 'website_stock_sync_mode', 'website_stock_webhook_url',
  'website_wc_url', 'website_wc_key', 'website_wc_secret',
  'website_target', 'website_b2b_url', 'website_b2b_token', 'website_b2b_channel',
  'rubika_bot_token', 'rubika_chat_id', 'rubika_invoice_enabled',
  // Invoice print: formal ×3, casual-simple (fixed), thermal width 58/80 + customize JSON
  'invoice_template_formal', 'invoice_template_casual',
  'invoice_paper_size', 'invoice_thermal_width', 'invoice_customize'
];

// Module flags a non-admin (e.g. accounting role) also needs, to know which
// Accounting-shell nav items to hide — safe to expose (no secrets), unlike
// the full settings list which is admin-only.
const MODULE_KEYS = [
  'module_petty_cash', 'module_trust_checks', 'module_warehouses',
  'module_consignments', 'module_production', 'module_payroll', 'module_reps',
  'module_moadian', 'module_fixed_assets', 'module_portal',
  'feature_ai_assistant', 'feature_b2b_portal',
  'coa_mode', 'currency_display'
];
router.get('/modules', auth, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`SELECT key,value FROM settings WHERE key IN (${MODULE_KEYS.map(() => '?').join(',')})`).all(...MODULE_KEYS);
  const obj = {};
  for (const k of MODULE_KEYS) {
    if (k === 'coa_mode') obj[k] = '';
    else if (k === 'currency_display') obj[k] = 'rial';
    else if (k.startsWith('feature_')) obj[k] = '0';
    else obj[k] = '1';
  }
  for (const r of rows) obj[r.key] = r.value;
  res.json(obj);
});

router.post('/website-test', auth, adminOnly, centralOnly, async (req, res) => {
  try {
    const sync = require('../lib/website-stock-sync');
    if (typeof sync.testWebsiteConnection !== 'function') {
      return res.status(501).json({ ok: false, error: 'اتصال آزمایشی هنوز آماده نیست' });
    }
    const result = await sync.testWebsiteConnection({ db: getDB() });
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'آزمایش اتصال ناموفق' });
  }
});

// GET all settings (admin only)
router.get('/', auth, adminOnly, (req, res) => {
  const payload = getPublicSettings(getDB());
  try {
    const { isDemoMode } = require('../lib/demo-mode');
    const { redactSecretSettingsIfDemo } = require('../middleware/demo-guard');
    if (isDemoMode()) return res.json(redactSecretSettingsIfDemo(payload));
  } catch { /* production path */ }
  res.json(payload);
});

// PUT upsert key-value pairs (admin only)
router.put('/', auth, adminOnly, centralOnly, async (req, res) => {
  const entries = Object.entries(req.body || {});
  for (const [key, value] of entries) {
    if (!['website_stock_webhook_url', 'website_wc_url', 'website_b2b_url'].includes(key) || value == null || String(value).trim() === '') continue;
    try { await assertSafeOutboundTarget(String(value)); }
    catch (error) { return res.status(400).json({ error: error.message || 'آدرس ارتباط با وب‌سایت مجاز نیست' }); }
  }
  const db = getDB();
  updateSettings(db, entries, new Set(ALLOWED_KEYS));
  if (entries.some(([k]) => k.startsWith('coa_') || k === 'feature_cogs_voucher')) clearCoaCache();
  audit(req.user.id, 'update', 'settings', null, 'بروزرسانی تنظیمات');
  res.json(getPublicSettings(db));
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
  const settings = getSmsSettings(db, ['welcome_sms_text', 'kimia_address']);
  const to = (req.body.phone || '').trim();
  if (!to) return res.status(400).json({ error: 'شماره موبایل الزامی است' });
  const addrLine = settings.kimia_address ? `\n🏢 آدرس دفتر: ${settings.kimia_address}` : '';
  const text = (settings.welcome_sms_text || DEFAULT_WELCOME_SMS).replace('{address}', addrLine);
  const result = await sendSMS(settings, to, text);
  res.json(result);
});

module.exports = router;
module.exports.ALLOWED_KEYS = ALLOWED_KEYS;
