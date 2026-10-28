const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOnly, centralOnly } = require('../middleware/auth');
const { sendSMS } = require('../sms');
const {
  clearCoaCache,
  LEGACY,
  listCoaKeyDescriptors,
  validateCoaKeyAssignment,
  COA_UI_GROUPS,
} = require('../lib/coa-map');
const { assertSafeOutboundTarget } = require('../lib/safe-outbound-request');
const {
  getPublicSettings,
  getSmsSettings,
  updateSettings,
} = require('../lib/secret-settings');
const { validateStaffPolicyBody, normalizeTwofaRoles } = require('../lib/staff-security');

/** Non-coa settings keys (coa_mode is a mode flag, not a LEGACY mapping key). */
const NON_COA_ALLOWED_KEYS = [
  'currency_base','currency_display',
  'coa_mode',
  'feature_cogs_voucher','returns_reverse_vat','returns_allow_open','returns_auto_allocate_credit',
  'telegram_bot_token', 'telegram_chat_id',
  'sms_provider', 'sms_api_key', 'sms_from', 'sms_otp_template',
  'niksms_api_key', 'smsir_api_key', 'smsir_line',
  'company_name', 'company_phone', 'company_address',
  'company_economic_code', 'company_national_id', 'company_postal_code',
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
  // Cost-center policy: require CC on expense/COGS journal lines (default OFF)
  'require_cc_on_expense',
  // Website stock sync + Rubika invoice
  'website_stock_sync_enabled', 'website_stock_sync_mode', 'website_stock_webhook_url',
  'website_wc_url', 'website_wc_key', 'website_wc_secret',
  'website_target', 'website_b2b_url', 'website_b2b_token', 'website_b2b_channel',
  'website_wh_wholesale_id', 'website_wh_retail_id',
  'website_wh_retail_2_id', 'website_wh_retail_3_id',
  'rubika_bot_token', 'rubika_chat_id', 'rubika_invoice_enabled',
  // Invoice print: formal ×3, casual-simple (fixed), thermal width 58/80 + customize JSON
  'invoice_template_formal', 'invoice_template_casual',
  'invoice_paper_size', 'invoice_thermal_width', 'invoice_customize',
  'session_absolute_hours', 'session_idle_hours', 'twofa_required_roles',
  // Invoice matrix: full pack required|optional (default required + matrix fallback)
  'sales.full_pack_mode',
  // Phase 3C — سقف تأیید دوم برای وصول/واخواست/ابطال چک (ریال؛ 0=غیرفعال)
  'cheque_approve_threshold_rial',
  // v585 Phase 1 — leaf-account enforcement: warn (default) | enforce
  'ledger_leaf_enforcement',
  // v586 Phase 2 — product tafsili: legacy_leaf (default) | detail_account
  'coa_product_tafsili_mode',
];

/** SSOT: every LEGACY coa_* key is persistable (no hand-maintained coa allow-list). */
const ALLOWED_KEYS = [
  ...NON_COA_ALLOWED_KEYS,
  ...Object.keys(LEGACY),
];

// Module flags a non-admin (e.g. accounting role) also needs, to know which
// Accounting-shell nav items to hide — safe to expose (no secrets), unlike
// the full settings list which is admin-only.
const MODULE_KEYS = [
  'module_petty_cash', 'module_trust_checks', 'module_warehouses',
  'module_consignments', 'module_production', 'module_payroll', 'module_reps',
  'module_moadian', 'module_fixed_assets', 'module_portal',
  'feature_ai_assistant', 'feature_b2b_portal',
  'coa_mode', 'currency_display',
  'require_cc_on_expense',
];
router.get('/modules', auth, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`SELECT key,value FROM settings WHERE key IN (${MODULE_KEYS.map(() => '?').join(',')})`).all(...MODULE_KEYS);
  const obj = {};
  for (const k of MODULE_KEYS) {
    if (k === 'coa_mode') obj[k] = '';
    else if (k === 'currency_display') obj[k] = 'rial';
    else if (k.startsWith('feature_')) obj[k] = '0';
    else if (k === 'require_cc_on_expense') obj[k] = '0';
    else obj[k] = '1';
  }
  for (const r of rows) obj[r.key] = r.value;
  res.json(obj);
});

function websiteSyncErrorBody(e, fallback) {
  return {
    ok: false,
    error: (e && e.message) || fallback,
    code: e && e.code ? String(e.code) : undefined,
    key: e && e.key ? String(e.key) : undefined,
  };
}

router.post('/website-test', auth, adminOnly, centralOnly, async (req, res) => {
  try {
    const sync = require('../lib/website-stock-sync');
    if (typeof sync.testWebsiteConnection !== 'function') {
      return res.status(501).json({ ok: false, error: 'اتصال آزمایشی هنوز آماده نیست' });
    }
    const result = await sync.testWebsiteConnection({ db: getDB() });
    res.json(result);
  } catch (e) {
    res.status(400).json(websiteSyncErrorBody(e, 'آزمایش اتصال ناموفق'));
  }
});

router.post('/website-dry-run', auth, adminOnly, centralOnly, async (req, res) => {
  try {
    const sync = require('../lib/website-stock-sync');
    const raw = req.body && (req.body.productId != null ? req.body.productId : req.body.code);
    if (raw == null || String(raw).trim() === '') {
      return res.status(400).json({ ok: false, error: 'کد یا شناسه کالا الزامی است' });
    }
    const result = await sync.dryRunProductMatrix(getDB(), raw);
    res.json(result);
  } catch (e) {
    res.status(400).json(websiteSyncErrorBody(e, 'dry-run ناموفق'));
  }
});

router.post('/website-retry-one', auth, adminOnly, centralOnly, (req, res) => {
  try {
    const sync = require('../lib/website-stock-sync');
    const raw = req.body && (req.body.productId != null ? req.body.productId : req.body.code);
    const resolved = sync.resolveSyncProduct(getDB(), raw);
    if (!resolved.ok) return res.status(400).json({ ok: false, error: resolved.error });
    const result = sync.enqueueWebsiteStock(getDB(), resolved.product.id, { clearHold: true });
    res.json({ ok: true, ...result, productId: resolved.product.id, label: resolved.label, via: resolved.via });
  } catch (e) {
    res.status(400).json(websiteSyncErrorBody(e, 'ارسال دوباره ناموفق'));
  }
});

router.post('/website-full-sync', auth, adminOnly, centralOnly, async (req, res) => {
  try {
    const sync = require('../lib/website-stock-sync');
    const result = sync.enqueueFullSync(getDB());
    res.json(result);
  } catch (e) {
    res.status(400).json(websiteSyncErrorBody(e, 'همگام‌سازی کامل ناموفق'));
  }
});

router.get('/website-outbox', auth, adminOnly, centralOnly, (req, res) => {
  try {
    const sync = require('../lib/website-stock-sync');
    res.json(sync.outboxStatus(getDB()));
  } catch (e) {
    res.status(400).json(websiteSyncErrorBody(e, 'خواندن outbox ناموفق'));
  }
});

/** Readonly catalog of configurable coa_* keys (SSOT from LEGACY). */
router.get('/coa-keys', auth, adminOnly, (req, res) => {
  try {
    const keys = listCoaKeyDescriptors();
    res.json({ keys, groups: COA_UI_GROUPS, count: keys.length });
  } catch (e) {
    console.error('GET /api/settings/coa-keys failed:', e && e.message);
    res.status(500).json({ error: 'خواندن فهرست کلیدهای کدینگ ناموفق بود', code: 'E_COA_KEYS' });
  }
});

// GET all settings (admin only)
router.get('/', auth, adminOnly, (req, res) => {
  try {
    const payload = getPublicSettings(getDB());
    try {
      const { isDemoMode } = require('../lib/demo-mode');
      const { redactSecretSettingsIfDemo } = require('../middleware/demo-guard');
      if (isDemoMode()) return res.json(redactSecretSettingsIfDemo(payload));
    } catch { /* production path */ }
    res.json(payload);
  } catch (e) {
    console.error('GET /api/settings failed:', e && e.message);
    res.status(500).json({
      error: 'خواندن تنظیمات ناموفق بود',
      code: (e && e.code) || 'E_SETTINGS',
    });
  }
});

function currentSettingValue(db, key) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? String(row.value == null ? '' : row.value) : '';
  } catch (_) {
    return '';
  }
}

// PUT upsert key-value pairs (admin only)
router.put('/', auth, adminOnly, centralOnly, async (req, res) => {
  const body = req.body || {};
  for (const key of ['currency_base', 'currency_display']) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    if (String(body[key] || '').trim().toLowerCase() !== 'rial') {
      return res.status(400).json({ error: 'واحد پول فقط ریال است و مبلغ سندها عوض نمی‌شود' });
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'ledger_leaf_enforcement')) {
    const v = String(body.ledger_leaf_enforcement || '').trim().toLowerCase();
    if (v !== 'warn' && v !== 'enforce') {
      return res.status(400).json({ error: 'مقدار ledger_leaf_enforcement فقط warn یا enforce است', code: 'E_LEAF_FLAG' });
    }
    body.ledger_leaf_enforcement = v;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'coa_product_tafsili_mode')) {
    const v = String(body.coa_product_tafsili_mode || '').trim().toLowerCase();
    if (v !== 'legacy_leaf' && v !== 'detail_account') {
      return res.status(400).json({
        error: 'مقدار coa_product_tafsili_mode فقط legacy_leaf یا detail_account است',
        code: 'E_PRODUCT_TAFSILI_MODE',
      });
    }
    body.coa_product_tafsili_mode = v;
  }
  const dbForPolicy = getDB();
  const policyCheck = validateStaffPolicyBody(body, dbForPolicy);
  if (!policyCheck.ok) return res.status(400).json({ error: policyCheck.error });
  if (policyCheck.absolute) body.session_absolute_hours = String(policyCheck.absolute);
  if (policyCheck.idle) body.session_idle_hours = String(policyCheck.idle);
  if (Object.prototype.hasOwnProperty.call(body, 'twofa_required_roles')) {
    body.twofa_required_roles = normalizeTwofaRoles(body.twofa_required_roles);
  }
  const entries = Object.entries(body);
  for (const [key, value] of entries) {
    if (!['website_stock_webhook_url', 'website_wc_url', 'website_b2b_url'].includes(key) || value == null || String(value).trim() === '') continue;
    try { await assertSafeOutboundTarget(String(value)); }
    catch (error) { return res.status(400).json({ error: error.message || 'آدرس ارتباط با وب‌سایت مجاز نیست' }); }
  }

  // Validate changed LEGACY coa_* assignments (leaf + type; control keys may be non-leaf).
  const db = dbForPolicy;
  for (const [key, value] of entries) {
    if (!Object.prototype.hasOwnProperty.call(LEGACY, key)) continue;
    const next = value == null ? '' : String(value).trim();
    const prev = currentSettingValue(db, key).trim();
    if (next === prev) continue;
    const check = validateCoaKeyAssignment(db, key, next);
    if (!check.ok) {
      return res.status(check.status || 422).json({
        error: check.error,
        code: check.code,
        key,
      });
    }
  }

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
module.exports.NON_COA_ALLOWED_KEYS = NON_COA_ALLOWED_KEYS;
