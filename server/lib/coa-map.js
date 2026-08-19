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
  coa_fx_gain:                { code: '4206', name: 'سود تسعیر ارز' },
  coa_fx_loss:                { code: '6109', name: 'زیان تسعیر ارز' },
  coa_other_income:           { code: '4201', name: 'سایر درآمدها' },
  // Accounting gap (docs/ACCOUNTING-GAP-ANALYSIS.md) — APPEND keys only
  coa_cheques_in_collection:  { code: '1116', name: 'اسناد در جریان وصول' },
  coa_legal_reserve:          { code: '3103', name: 'اندوخته قانونی' },
  coa_doubtful_debts:         { code: '2102', name: 'ذخیره مطالبات مشکوک‌الوصول' },
  coa_doubtful_expense:       { code: '6112', name: 'هزینه مطالبات مشکوک‌الوصول' },
  coa_inventory_writedown:    { code: '1117', name: 'ذخیره کاهش ارزش موجودی' },
  coa_inventory_writedown_exp:{ code: '6113', name: 'هزینه کاهش ارزش موجودی' },
  coa_revaluation_surplus:    { code: '3104', name: 'مازاد تجدید ارزیابی' },
  coa_severance_payable:      { code: '2110', name: 'ذخیره مزایای پایان خدمت' },
  coa_eidi_payable:           { code: '2111', name: 'ذخیره عیدی کارکنان' },
  coa_asset_disposal_gain:    { code: '4201', name: 'سود واگذاری دارایی' },
  coa_asset_disposal_loss:    { code: '6105', name: 'زیان واگذاری دارایی' },
  // POS-01/02 — card in-transit + dedicated fee (1118/6114 unused in existing chart)
  coa_card_in_transit:        { code: '1118', name: 'وجوه در راه کارتخوان' },
  coa_card_fee:               { code: '6114', name: 'کارمزد کارتخوان' },
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

/**
 * Suggest next child code under parent (Update 11 / D4).
 * Validates child must start with parent prefix.
 */
function suggestChildCode(db, parentCode) {
  const parent = String(parentCode || '').trim();
  if (!parent) return null;
  const prow = db.prepare('SELECT * FROM chart_of_accounts WHERE code=?').get(parent);
  if (!prow) return null;
  const level = Number(prow.level) || (parent.length <= 2 ? 1 : parent.length <= 4 ? 2 : parent.length <= 6 ? 3 : 4);
  const childLevel = level + 1;
  let pad = 2;
  if (childLevel === 2) pad = 2;
  else if (childLevel === 3) pad = 2;
  else if (childLevel === 4) pad = 6;
  const like = parent + '%';
  const row = db.prepare(`
    SELECT MAX(CAST(substr(code, ?) AS INTEGER)) m
    FROM chart_of_accounts
    WHERE parent_code=? OR (code LIKE ? AND length(code)=?)
  `).get(parent.length + 1, parent, like, parent.length + pad);
  const nextNum = (row && row.m ? row.m : 0) + 1;
  const child = parent + String(nextNum).padStart(pad, '0');
  return { parent_code: parent, code: child, level: childLevel };
}

function validateChildCode(parentCode, childCode) {
  const p = String(parentCode || '');
  const c = String(childCode || '');
  if (!p || !c) return false;
  return c.startsWith(p) && c.length > p.length;
}

/** Base control tree for a clean go-live (group → subgroup → account). */
function baseCoaTree() {
  return [
    ['1000', 'دارایی‌ها', 'asset', null, 1],
    ['1100', 'دارایی‌های جاری', 'asset', '1000', 2],
    ['1101', 'موجودی صندوق', 'asset', '1100', 2],
    ['1102', 'موجودی بانک', 'asset', '1100', 2],
    ['1103', 'حساب‌های دریافتنی از مشتریان', 'asset', '1100', 2],
    ['1104', 'موجودی کالا', 'asset', '1100', 2],
    ['1105', 'پیش‌پرداخت‌ها', 'asset', '1100', 2],
    ['1106', 'حساب اشخاص متفرقه', 'asset', '1100', 2],
    ['1107', 'مساعده نمایندگان فروش', 'asset', '1100', 2],
    ['1108', 'مالیات بر ارزش افزوده دریافتنی', 'asset', '1100', 2],
    ['1109', 'اسناد دریافتنی', 'asset', '1100', 2],
    ['1110', 'موجودی مواد اولیه', 'asset', '1100', 2],
    ['1111', 'کالای در جریان ساخت', 'asset', '1100', 2],
    ['1112', 'موجودی مواد بسته‌بندی', 'asset', '1100', 2],
    ['1113', 'موجودی ضایعات قابل فروش', 'asset', '1100', 2],
    ['1114', 'موجودی نزد پیمانکار', 'asset', '1100', 2],
    ['1115', 'موجودی در راه (حمل)', 'asset', '1100', 2],
    ['1116', 'اسناد در جریان وصول', 'asset', '1100', 2],
    ['1117', 'ذخیره کاهش ارزش موجودی', 'asset', '1100', 2],
    ['1118', 'وجوه در راه کارتخوان', 'asset', '1100', 2],
    ['1201', 'دارایی‌های ثابت', 'asset', '1000', 2],
    ['1202', 'استهلاک انباشته دارایی', 'asset', '1000', 2],
    ['2000', 'بدهی‌ها', 'liability', null, 1],
    ['2100', 'بدهی‌های جاری', 'liability', '2000', 2],
    ['2101', 'حساب‌های پرداختنی', 'liability', '2100', 2],
    ['2102', 'ذخیره مطالبات مشکوک‌الوصول', 'liability', '2100', 2],
    ['2103', 'مالیات بر ارزش افزوده پرداختنی', 'liability', '2100', 2],
    ['2104', 'حقوق پرداختنی کارکنان', 'liability', '2100', 2],
    ['2105', 'بیمه پرداختنی', 'liability', '2100', 2],
    ['2106', 'مالیات حقوق پرداختنی', 'liability', '2100', 2],
    ['2107', 'بستانکاران انگیزه نمایندگان', 'liability', '2100', 2],
    ['2108', 'سایر کسورات حقوق پرداختنی', 'liability', '2100', 2],
    ['2109', 'اسناد پرداختنی', 'liability', '2100', 2],
    ['2110', 'ذخیره مزایای پایان خدمت', 'liability', '2100', 2],
    ['2111', 'ذخیره عیدی کارکنان', 'liability', '2100', 2],
    ['3000', 'حقوق صاحبان سرمایه', 'equity', null, 1],
    ['3101', 'سود (زیان) انباشته', 'equity', '3000', 2],
    ['3102', 'تراز افتتاحیه', 'equity', '3000', 2],
    ['3103', 'اندوخته قانونی', 'equity', '3000', 2],
    ['3104', 'مازاد تجدید ارزیابی', 'equity', '3000', 2],
    ['3201', 'افتتاحیه سال مالی', 'equity', '3000', 2],
    ['4000', 'درآمدها', 'revenue', null, 1],
    ['4101', 'درآمد فروش کالا', 'revenue', '4000', 2],
    ['4102', 'برگشت از فروش', 'revenue', '4000', 2],
    ['4103', 'تخفیفات فروش', 'revenue', '4000', 2],
    ['4201', 'سایر درآمدها', 'revenue', '4000', 2],
    ['4205', 'اضافی انبارگردانی', 'revenue', '4000', 2],
    ['4206', 'سود تسعیر ارز', 'revenue', '4000', 2],
    ['5000', 'بهای تمام‌شده کالای فروش رفته', 'cogs', null, 1],
    ['5101', 'بهای تمام‌شده کالای فروش رفته', 'cogs', '5000', 2],
    ['6000', 'هزینه‌ها', 'expense', null, 1],
    ['5200', 'حساب‌های کنترل تولید', 'expense', '6000', 2],
    ['5201', 'کنترل دستمزد مستقیم', 'expense', '5200', 2],
    ['5202', 'کنترل سربار ساخت', 'expense', '5200', 2],
    ['5203', 'سربار جذب‌شده', 'expense', '5200', 2],
    ['5210', 'انحراف نرخ مواد', 'expense', '5200', 2],
    ['5211', 'انحراف مقدار مواد', 'expense', '5200', 2],
    ['5212', 'انحراف نرخ دستمزد', 'expense', '5200', 2],
    ['5213', 'انحراف کارایی دستمزد', 'expense', '5200', 2],
    ['5214', 'انحراف بودجه سربار', 'expense', '5200', 2],
    ['5215', 'انحراف حجم سربار', 'expense', '5200', 2],
    ['5221', 'هزینه ضایعات غیرعادی', 'expense', '5200', 2],
    ['5222', 'هزینه دوباره‌کاری', 'expense', '5200', 2],
    ['5230', 'کارمزد ساخت پیمانکاری', 'expense', '5200', 2],
    ['6101', 'هزینه انگیزه فروش', 'expense', '6000', 2],
    ['6102', 'هزینه‌های عمومی و اداری', 'expense', '6000', 2],
    ['6103', 'هزینه‌های توزیع و فروش', 'expense', '6000', 2],
    ['6104', 'هزینه حقوق و دستمزد', 'expense', '6000', 2],
    ['6105', 'هزینه استهلاک دارایی', 'expense', '6000', 2],
    ['6106', 'هزینه بیمه سهم کارفرما', 'expense', '6000', 2],
    ['6108', 'کسری و ضایعات انبار', 'expense', '6000', 2],
    ['6109', 'زیان تسعیر ارز', 'expense', '6000', 2],
    ['6110', 'هزینه عیدی کارکنان', 'expense', '6000', 2],
    ['6111', 'هزینه مزایای پایان خدمت', 'expense', '6000', 2],
    ['6112', 'هزینه مطالبات مشکوک‌الوصول', 'expense', '6000', 2],
    ['6113', 'هزینه کاهش ارزش موجودی', 'expense', '6000', 2],
    ['6114', 'کارمزد کارتخوان', 'expense', '6000', 2],
    ['9999', 'اصلاحات و تعدیلات', 'equity', null, 1],
  ];
}

/**
 * Wipe and rebuild control COA from LEGACY + production/payroll/VAT needs.
 * Idempotent when called after DELETE FROM chart_of_accounts.
 */
function rebuildBaseCoa(db) {
  const cols = db.prepare('PRAGMA table_info(chart_of_accounts)').all().map((c) => c.name);
  const hasLevel = cols.includes('level');
  const ins = hasLevel
    ? db.prepare('INSERT OR REPLACE INTO chart_of_accounts (code,name,type,parent_code,level) VALUES (?,?,?,?,?)')
    : db.prepare('INSERT OR REPLACE INTO chart_of_accounts (code,name,type,parent_code) VALUES (?,?,?,?)');
  for (const [code, name, type, parent, level] of baseCoaTree()) {
    if (hasLevel) ins.run(code, name, type, parent, level);
    else ins.run(code, name, type, parent);
  }
  const set = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');
  for (const [key, { code }] of Object.entries(LEGACY)) {
    set.run(key, code);
  }
  set.run('coa_mode', 'standard');
  clearCoaCache();
  return db.prepare('SELECT COUNT(*) c FROM chart_of_accounts').get().c;
}

/**
 * Delete a detail/tafsili COA row when its owning entity is gone and it has no journal usage.
 * Safe for sync: DELETE fires sync_tombstones triggers.
 * @returns {{ ok:boolean, reason?:string, error?:string }}
 */
function releaseTafsili(db, code) {
  const c = String(code || '').trim();
  if (!c) return { ok: true, reason: 'empty' };
  let acc;
  try {
    acc = db.prepare('SELECT * FROM chart_of_accounts WHERE code=?').get(c);
  } catch (_) {
    return { ok: false, reason: 'no_table' };
  }
  if (!acc) return { ok: true, reason: 'missing' };

  const isDetail = Number(acc.level) === 4
    || c.length >= 12
    || c.includes('-')
    || !!(acc.tafsili_type);
  if (!isDetail) return { ok: false, reason: 'not_detail' };

  try {
    const jl = db.prepare('SELECT COUNT(*) c FROM journal_lines WHERE account_code=?').get(c)?.c || 0;
    if (jl > 0) {
      return { ok: false, reason: 'in_use', error: 'این کدینگ در اسناد حسابداری گردش دارد و قابل حذف نیست' };
    }
  } catch (_) { /* journal_lines may lack account_code on ancient DBs */ }

  const refTables = [
    ['products', 'coa_code'],
    ['persons', 'coa_code'],
    ['parties', 'coa_code'],
    ['customers', 'coa_code'],
    ['suppliers', 'coa_code'],
    ['banks', 'coa_code'],
    ['cash_boxes', 'coa_code'],
  ];
  for (const [tbl, col] of refTables) {
    try {
      const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tbl);
      if (!exists) continue;
      const n = db.prepare(`SELECT COUNT(*) c FROM ${tbl} WHERE ${col}=?`).get(c)?.c || 0;
      if (n > 0) return { ok: false, reason: 'linked' };
    } catch (_) { /* ignore */ }
  }

  try {
    db.prepare('DELETE FROM chart_of_accounts WHERE code=?').run(c);
  } catch (e) {
    return { ok: false, reason: 'fk', error: e.message };
  }
  return { ok: true };
}

/** Clear entity coa_code then release the detail account (call after entity delete or inside tx). */
function releaseEntityCoa(db, coaCode) {
  return releaseTafsili(db, coaCode);
}

module.exports = {
  acct, coaMode, usesExtendedCoa, clearCoaCache, allocTafsili, ensureControlParents,
  suggestChildCode, validateChildCode, LEGACY, rebuildBaseCoa, releaseTafsili, releaseEntityCoa, baseCoaTree,
};
