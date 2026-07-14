// Control-account mapping layer (docs/MAHAK-MIGRATION.md §3.2).
//
// Route handlers historically hardcode Taranom's original chart codes
// (1103 receivables, 2101 payables, 1101 cash, ...). On a Mahak-based
// database those postings must land on the Mahak codes instead. This module
// resolves each logical account through the settings table with the legacy
// code as fallback, so existing installs keep working unchanged: as long as
// no coa_* settings row exists, every lookup returns the legacy code.
//
// A DB is in "Mahak mode" when settings.coa_mode = 'mahak' (written by the
// importer). The importer also writes every coa_* key explicitly, so lookups
// never guess.
const LEGACY = {
  coa_receivable:      { code: '1103',   name: 'حساب‌های دریافتنی' },
  coa_payable:         { code: '2101',   name: 'حساب‌های پرداختنی' },
  coa_misc_persons:    { code: '1106',   name: 'حساب اشخاص متفرقه' },
  coa_sales:           { code: '4101',   name: 'درآمد فروش' },
  coa_sales_discount:  { code: '4103',   name: 'تخفیفات فروش' },
  coa_cogs:            { code: '5101',   name: 'بهای تمام‌شده کالای فروش رفته' },
  coa_inventory:       { code: '1104',   name: 'موجودی کالا' },
  coa_cash_default:    { code: '1101',   name: 'موجودی صندوق' },
  coa_bank_default:    { code: '1102',   name: 'موجودی بانک' },
  coa_adjustment:      { code: '9999',   name: 'اصلاحات و تعدیلات' },
  coa_payroll_expense: { code: '6104',   name: 'هزینه حقوق و دستمزد' },
  coa_payroll_payable: { code: '2104',   name: 'بدهی بیمه و مالیات کارکنان' },
  coa_vat_payable:     { code: '2103',   name: 'مالیات بر ارزش افزوده پرداختنی' },
  coa_vat_receivable:  { code: '1108',   name: 'مالیات بر ارزش افزوده دریافتنی' },
  coa_depreciation_expense: { code: '6105', name: 'هزینه استهلاک دارایی' },
  coa_fixed_assets:    { code: '1201',   name: 'دارایی‌های ثابت' },
};

let _cache = null, _cacheAt = 0;

function coaMode(db) {
  try {
    const r = db.prepare("SELECT value FROM settings WHERE key='coa_mode'").get();
    return r ? r.value : '';
  } catch { return ''; }
}

// Resolve a logical account key → { code, name }.
// In Mahak mode the settings row holds the mapped code and the name comes
// from chart_of_accounts; otherwise the legacy pair is returned untouched.
function acct(db, key) {
  const legacy = LEGACY[key];
  if (!legacy) throw new Error('coa-map: unknown key ' + key);
  const now = Date.now();
  if (!_cache || now - _cacheAt > 15000) { _cache = {}; _cacheAt = now; }
  if (_cache[key]) return _cache[key];
  let out = legacy;
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    if (row && row.value) {
      const acc = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(row.value);
      out = acc ? { code: acc.code, name: acc.name } : { code: row.value, name: legacy.name };
    }
  } catch { /* settings not ready during boot */ }
  _cache[key] = out;
  return out;
}

function clearCoaCache() { _cache = null; }

// In Mahak mode, every new operational entity gets its own tafsili account
// under the mapped معین. Returns the new full code, or null outside Mahak
// mode / on any failure (callers treat this as best-effort).
const KIND_KEY = { customer: 'coa_receivable', supplier: 'coa_payable', product: 'coa_inventory', bank: 'coa_bank_default', cashbox: 'coa_cash_default', person: 'coa_misc_persons' };
const KIND_TYPE = { customer: 'اشخاص', supplier: 'اشخاص', product: 'کالاها', bank: 'بانک ها', cashbox: 'صندوق ها', person: 'اشخاص' };
function allocTafsili(db, kind, name) {
  try {
    if (coaMode(db) !== 'mahak') return null;
    const base = acct(db, KIND_KEY[kind]).code;
    const moein = base.length > 6 ? base.slice(0, 6) : base;      // والد سطح ۳
    if (moein.length !== 6) return null;
    const parent = db.prepare('SELECT code,type FROM chart_of_accounts WHERE code=?').get(moein);
    if (!parent) return null;
    // شماره تفصیلی بعدی: بیشینهٔ ۶ رقم آخر همهٔ حساب‌های سطح ۴ + ۱ (سراسری تا تصادم نشود)
    const row = db.prepare("SELECT MAX(CAST(substr(code,7) AS INTEGER)) m FROM chart_of_accounts WHERE level=4 AND length(code)=12").get();
    const next = String((row && row.m ? row.m : 0) + 1).padStart(6, '0');
    const full = moein + next;
    db.prepare('INSERT INTO chart_of_accounts (code,name,type,parent_code,level,nature,tafsili_type) VALUES (?,?,?,?,4,NULL,?)')
      .run(full, String(name || '').trim() || ('حساب ' + full), parent.type, moein, KIND_TYPE[kind] || null);
    return full;
  } catch { return null; }
}

module.exports = { acct, coaMode, clearCoaCache, allocTafsili, LEGACY };
