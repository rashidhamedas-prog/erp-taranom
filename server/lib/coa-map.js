// Control-account mapping — settings coa_* keys override legacy defaults.
const LEGACY = {
  coa_receivable:      { code: '1103',   name: 'حساب‌های دریافتنی' },
  coa_payable:         { code: '2101',   name: 'حساب‌های پرداختنی' },
  coa_misc_persons:    { code: '1106',   name: 'حساب اشخاص متفرقه' },
  coa_sales:           { code: '4101',   name: 'درآمد فروش' },
  coa_sales_return:    { code: '4102',   name: 'برگشت از فروش' },
  coa_sales_discount:  { code: '4103',   name: 'تخفیفات فروش' },
  coa_cogs:            { code: '5101',   name: 'بهای تمام‌شده کالای فروش رفته' },
  coa_inventory:       { code: '1104',   name: 'موجودی کالا' },
  coa_cash_default:    { code: '1101',   name: 'موجودی صندوق' },
  coa_bank_default:    { code: '1102',   name: 'موجودی بانک' },
  coa_adjustment:      { code: '9999',   name: 'اصلاحات و تعدیلات' },
  coa_cheques_receivable: { code: '1109', name: 'اسناد دریافتنی' },
  coa_cheques_payable: { code: '2109', name: 'اسناد پرداختنی' },
  coa_opening_balance: { code: '3102', name: 'تراز افتتاحیه' },
  coa_admin_expense:   { code: '6102', name: 'هزینه‌های عمومی و اداری' },
  coa_sales_expense:   { code: '6103', name: 'هزینه‌های توزیع و فروش' },
  coa_rep_commission_expense: { code: '6101', name: 'هزینه انگیزه فروش' },
  coa_rep_commission_payable: { code: '2107', name: 'بستانکاران انگیزه نمایندگان' },
  coa_payroll_expense: { code: '6104',   name: 'هزینه حقوق و دستمزد' },
  coa_payroll_payable: { code: '2104',   name: 'حقوق پرداختنی کارکنان' },
  coa_sso_payable:     { code: '2105',   name: 'بیمه پرداختنی' },
  coa_payroll_tax_payable: { code: '2106', name: 'مالیات حقوق پرداختنی' },
  coa_payroll_other_deductions: { code: '2108', name: 'سایر کسورات حقوق پرداختنی' },
  coa_employer_insurance_expense: { code: '6106', name: 'هزینه بیمه سهم کارفرما' },
  coa_eidi_expense:    { code: '6110',   name: 'هزینه عیدی کارکنان' },
  coa_severance_expense: { code: '6111', name: 'هزینه مزایای پایان خدمت' },
  coa_vat_payable:     { code: '2103',   name: 'مالیات بر ارزش افزوده پرداختنی' },
  coa_vat_receivable:  { code: '1108',   name: 'مالیات بر ارزش افزوده دریافتنی' },
  coa_depreciation_expense: { code: '6105', name: 'هزینه استهلاک دارایی' },
  coa_fixed_assets:    { code: '1201',   name: 'دارایی‌های ثابت' },
  coa_accumulated_depreciation: { code: '1202', name: 'استهلاک انباشته دارایی' },
  coa_rep_advance:     { code: '1107',   name: 'مساعده نمایندگان فروش' },
  coa_retained_earnings: { code: '3101', name: 'سود (زیان) انباشته' },
  coa_fiscal_opening:  { code: '3201',   name: 'افتتاحیه سال مالی' },
  // Production module (docs/Production Master §2.1)
  coa_raw_materials:          { code: '1110', name: 'موجودی مواد اولیه' },
  coa_packaging_materials:    { code: '1112', name: 'موجودی مواد بسته‌بندی' },
  coa_wip:                    { code: '1111', name: 'کالای در جریان ساخت' },
  coa_finished_goods:         { code: '1104', name: 'موجودی کالای ساخته‌شده' },
  coa_scrap_inventory:        { code: '1113', name: 'موجودی ضایعات قابل فروش' },
  coa_subcontract_inventory:  { code: '1114', name: 'موجودی نزد پیمانکار' },
  coa_labor_control:          { code: '5201', name: 'کنترل دستمزد مستقیم' },
  coa_overhead_control:       { code: '5202', name: 'کنترل سربار ساخت' },
  coa_overhead_applied:       { code: '5203', name: 'سربار جذب‌شده' },
  coa_var_material_price:     { code: '5210', name: 'انحراف نرخ مواد' },
  coa_var_material_qty:       { code: '5211', name: 'انحراف مقدار مواد' },
  coa_var_labor_rate:         { code: '5212', name: 'انحراف نرخ دستمزد' },
  coa_var_labor_eff:          { code: '5213', name: 'انحراف کارایی دستمزد' },
  coa_var_oh_budget:          { code: '5214', name: 'انحراف بودجه سربار' },
  coa_var_oh_volume:          { code: '5215', name: 'انحراف حجم سربار' },
  coa_abnormal_waste:         { code: '5221', name: 'هزینه ضایعات غیرعادی' },
  coa_rework_cost:            { code: '5222', name: 'هزینه دوباره‌کاری' },
  coa_subcontract_fee:        { code: '5230', name: 'کارمزد ساخت پیمانکاری' },
  coa_inventory_gain:         { code: '4205', name: 'اضافی انبارگردانی' },
  coa_inventory_loss:         { code: '6108', name: 'کسری و ضایعات انبار' },
  coa_inventory_in_transit:   { code: '1115', name: 'موجودی در راه (حمل)' },
};

let _cache = null, _cacheAt = 0;

function coaMode(db) {
  try {
    const r = db.prepare("SELECT value FROM settings WHERE key='coa_mode'").get();
    return r ? r.value : '';
  } catch { return ''; }
}

function usesExtendedCoa(db) {
  const m = coaMode(db);
  return m === 'extended' || m === 'mahak';
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

const KIND_KEY = {
  customer: 'coa_receivable', supplier: 'coa_payable', product: 'coa_inventory',
  bank: 'coa_bank_default', cashbox: 'coa_cash_default', person: 'coa_misc_persons',
  production_order: 'coa_wip', cost_center_oh: 'coa_overhead_control', cost_center_lb: 'coa_labor_control',
};
const KIND_TYPE = {
  customer: 'اشخاص', supplier: 'اشخاص', product: 'کالاها',
  bank: 'بانک ها', cashbox: 'صندوق ها', person: 'اشخاص',
  production_order: 'سفارش تولید', cost_center_oh: 'مراکز هزینه', cost_center_lb: 'مراکز هزینه',
};

/** Ensure parent کل/معین exists for mapped control account; then allocate تفصیلی. */
function ensureControlParents(db, kind) {
  const key = KIND_KEY[kind];
  if (!key) return null;
  const mapped = acct(db, key);
  let code = String(mapped.code || '');
  if (!code) return null;
  // Prefer 6-digit معین; if only 4-digit کل, append 01
  let moein = code.length >= 6 ? code.slice(0, 6) : (code.length === 4 ? code + '01' : code);
  if (moein.length !== 6) return null;
  const kol = moein.slice(0, 4);
  const existingMoein = db.prepare('SELECT code,type FROM chart_of_accounts WHERE code=?').get(moein);
  if (existingMoein) return existingMoein;
  const kolRow = db.prepare('SELECT code,type FROM chart_of_accounts WHERE code=?').get(kol);
  const type = kolRow?.type || (kind === 'supplier' ? 'liability' : kind === 'product' ? 'asset' : 'asset');
  if (!kolRow) {
    try {
      db.prepare('INSERT INTO chart_of_accounts (code,name,type,parent_code,level) VALUES (?,?,?,?,1)')
        .run(kol, mapped.name || ('حساب ' + kol), type, null);
    } catch { /* ignore */ }
  }
  try {
    db.prepare('INSERT INTO chart_of_accounts (code,name,type,parent_code,level) VALUES (?,?,?,?,3)')
      .run(moein, mapped.name || ('معین ' + moein), type, kol);
  } catch { /* ignore */ }
  return db.prepare('SELECT code,type FROM chart_of_accounts WHERE code=?').get(moein) || null;
}

// New entities get tafsili accounts under mapped معین (creates parents if needed).
function allocTafsili(db, kind, name) {
  try {
    if (!KIND_KEY[kind]) return null;
    const parent = ensureControlParents(db, kind);
    if (!parent) return null;
    const moein = parent.code;
    const row = db.prepare("SELECT MAX(CAST(substr(code,7) AS INTEGER)) m FROM chart_of_accounts WHERE level=4 AND length(code)=12 AND substr(code,1,6)=?").get(moein);
    const next = String((row && row.m ? row.m : 0) + 1).padStart(6, '0');
    const full = moein + next;
    db.prepare('INSERT INTO chart_of_accounts (code,name,type,parent_code,level,nature,tafsili_type) VALUES (?,?,?,?,4,NULL,?)')
      .run(full, String(name || '').trim() || ('حساب ' + full), parent.type, moein, KIND_TYPE[kind] || null);
    return full;
  } catch { return null; }
}

module.exports = { acct, coaMode, usesExtendedCoa, clearCoaCache, allocTafsili, ensureControlParents, LEGACY };
