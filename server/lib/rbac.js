// Granular RBAC — default matrix by role + per-user overrides in user_permissions.
const {
  ACC_SECTION_RESOURCES, isAccSectionResource, accSectionDefault, LEGACY_PARENTS,
  ACC_CAPABILITY_RESOURCES, capabilityDefault, resourceForNav,
} = require('./accounting-access');

// APPEND-ONLY. `operate` = cheque lifecycle. `negative` (Warehouse Phase 2) = may post stock below zero
// (only meaningful on acc_warehouse_ops; the warehouse must also allow negative).
// acc_warehouse_ops mapping: view=view · create=create · void=delete (v525 convention) · negative=negative.
const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'operate', 'negative'];

const RESOURCES = [
  'customers', 'parties', 'products', 'invoices', 'followups', 'accounting', 'reports',
  'ai', 'settings', 'backup', 'users', 'stocktaking', 'messages', 'reps', 'dashboard',
  'journal_vouchers', 'payroll', 'fixed_assets', 'moadian',
  // Production module (append-only)
  'production', 'production_bom', 'production_cost', 'production_close', 'production_reports',
  // Portal + gap accounting (append-only)
  'portal', 'budgeting', 'bank_reconciliation',
  // Accounting shell sections (append-only). Master gate remains `accounting`.
  ...ACC_SECTION_RESOURCES,
  // v522 capability resources without a menu page (append-only)
  ...ACC_CAPABILITY_RESOURCES,
  // Audit 8A — append-only: explicit gates (were auth-only or VIEW_ONLY fallback)
  'banks', 'orders', 'rfq',
  // Phase 1 cross-warehouse sales (append-only) — action create; default admin only
  'sales_cross_warehouse',
  // Phase 3C — cheque lifecycle permissions (cheque.operate / cheque.approve)
  'cheque',
  // Phase 2 cross-warehouse — override موجودی منفی فروش (action approve)
  'inventory_negative',
  // P4 — field-level cost visibility (action view). Default: admin + accounting only.
  // Cashier (store_retail) / sales / production roles never see purchase cost, margin, profit.
  'cost_visibility',
  // P7 — qty-only supplier receipt (cashier). view/create; delete = void before costing.
  // Costing (ریالی‌سازی) is NOT this resource: cost_visibility:view + acc_purchases:create.
  'qty_receipt',
  // P10-fix — sales amount in reports (action view). Default: admin + accounting + store_retail.
  // Purchase amount / cost / margin / profit stay behind cost_visibility:view.
  'sales_amount',
];
const CAPABILITY_SET = new Set(ACC_CAPABILITY_RESOURCES);
/** Resources that must not silently default to view for every role (audit #96 / 8A). */
const CLOSED_DEFAULT_NONE = new Set([
  'backup', 'users', 'journal_vouchers', 'payroll', 'moadian', 'settings', 'banks', 'orders', 'rfq',
  'sales_cross_warehouse',
  'cheque',
  'inventory_negative',
  'cost_visibility',
  'qty_receipt',
  'sales_amount',
]);

const ALL = Object.fromEntries(ACTIONS.map(a => [a, true]));
const VIEW_ONLY = { view: true, create: false, edit: false, delete: false, approve: false, export: false, operate: false, negative: false };
const SALES_CRUD = { view: true, create: true, edit: true, delete: false, approve: false, export: true, operate: false, negative: false };
const ACC_FULL = { ...ALL };
const PROD_MGR = {
  production: { view: true, create: true, edit: true, delete: false, approve: true, export: true },
  production_bom: { view: true, create: true, edit: true, delete: false, approve: true, export: true },
  production_cost: { view: true, create: false, edit: false, delete: false, approve: false, export: true },
  production_close: { view: true, create: false, edit: false, delete: false, approve: false, export: true },
  production_reports: { view: true, create: false, edit: false, delete: false, approve: false, export: true },
};
const NONE = { view: false, create: false, edit: false, delete: false, approve: false, export: false, operate: false, negative: false };
const CHEQUE_OPERATE = {
  view: true, create: true, edit: true, delete: false, approve: true, export: true, operate: true,
};
const PROD_OP = {
  production: { view: true, create: true, edit: false, delete: false, approve: false, export: false },
  production_bom: { view: true, create: false, edit: false, delete: false, approve: false, export: false },
  production_cost: { ...NONE },
  production_close: { ...NONE },
  production_reports: { view: true, create: false, edit: false, delete: false, approve: false, export: false },
};

const DEFAULT_ROLE_PERMISSIONS = {
  admin: Object.fromEntries(RESOURCES.map(r => [r, { ...ALL }])),
  accounting: {
    customers: { view: true, create: true, edit: true, delete: false, approve: false, export: true },
    parties: { view: true, create: true, edit: true, delete: false, approve: false, export: true },
    products: { view: true, create: true, edit: true, delete: false, approve: false, export: true },
    invoices: { view: true, create: true, edit: true, delete: true, approve: true, export: true },
    followups: VIEW_ONLY,
    accounting: ACC_FULL,
    reports: { view: true, create: false, edit: false, delete: false, approve: false, export: true },
    ai: VIEW_ONLY,
    settings: NONE,
    backup: VIEW_ONLY,
    users: VIEW_ONLY,
    stocktaking: ACC_FULL,
    messages: SALES_CRUD,
    reps: { view: true, create: true, edit: true, delete: false, approve: true, export: true },
    production: { view: true, create: true, edit: true, delete: true, approve: true, export: true },
    production_bom: { view: true, create: true, edit: true, delete: false, approve: false, export: true },
    production_cost: ALL,
    production_close: { view: true, create: true, edit: true, delete: false, approve: true, export: true },
    production_reports: { view: true, create: false, edit: false, delete: false, approve: false, export: true },
    portal: { view: true, create: true, edit: true, delete: false, approve: true, export: true },
    budgeting: ACC_FULL,
    bank_reconciliation: ACC_FULL,
    banks: VIEW_ONLY,
    orders: SALES_CRUD,
    rfq: { view: true, create: true, edit: true, delete: false, approve: true, export: true },
    journal_vouchers: ACC_FULL,
    payroll: ACC_FULL,
    fixed_assets: ACC_FULL,
    moadian: VIEW_ONLY,
    cheque: CHEQUE_OPERATE,
    cost_visibility: { ...NONE, view: true },
    qty_receipt: { ...NONE, view: true, create: true, delete: true },
    sales_amount: { ...NONE, view: true },
    // acc_* sections (incl. acc_warehouse_ops create/delete = manual stock adjust + void, v525)
    // come from accSectionDefault('accounting') — all flags except ACCOUNTING_ROLE_SECTION_EXCEPTIONS.
  },
  sales_manager: {
    customers: SALES_CRUD,
    products: { view: true, create: false, edit: false, delete: false, approve: false, export: true },
    invoices: { ...SALES_CRUD, approve: true },
    followups: SALES_CRUD,
    accounting: { view: true, create: false, edit: false, delete: false, approve: true, export: true },
    reports: { view: true, create: false, edit: false, delete: false, approve: false, export: true },
    ai: ALL,
    settings: NONE,
    backup: NONE,
    users: NONE,
    stocktaking: VIEW_ONLY,
    messages: SALES_CRUD,
    reps: { view: true, create: true, edit: true, delete: false, approve: true, export: true },
    production: { view: true, create: false, edit: false, delete: false, approve: false, export: true },
    production_bom: { view: true, create: false, edit: false, delete: false, approve: false, export: true },
    production_cost: { ...NONE },
    production_close: { ...NONE },
    production_reports: { view: true, create: false, edit: false, delete: false, approve: false, export: true },
    banks: NONE,
    orders: { ...SALES_CRUD, approve: true },
    rfq: { view: true, create: true, edit: false, delete: false, approve: false, export: false },
  },
  field_sales: {
    customers: SALES_CRUD,
    products: { view: true, create: false, edit: false, delete: false, approve: false, export: false },
    invoices: SALES_CRUD,
    followups: SALES_CRUD,
    accounting: NONE,
    reports: VIEW_ONLY,
    ai: VIEW_ONLY,
    settings: NONE,
    backup: NONE,
    users: NONE,
    stocktaking: VIEW_ONLY,
    messages: SALES_CRUD,
    reps: VIEW_ONLY,
    production: { ...NONE },
    production_bom: { ...NONE },
    production_cost: { ...NONE },
    production_close: { ...NONE },
    production_reports: { ...NONE },
    banks: NONE,
    orders: SALES_CRUD,
    rfq: NONE,
  },
  inside_sales: {
    customers: SALES_CRUD,
    products: { view: true, create: false, edit: false, delete: false, approve: false, export: false },
    invoices: SALES_CRUD,
    followups: SALES_CRUD,
    accounting: NONE,
    reports: VIEW_ONLY,
    ai: VIEW_ONLY,
    settings: NONE,
    backup: NONE,
    users: NONE,
    stocktaking: VIEW_ONLY,
    messages: SALES_CRUD,
    reps: VIEW_ONLY,
    production: { ...NONE },
    production_bom: { ...NONE },
    production_cost: { ...NONE },
    production_close: { ...NONE },
    production_reports: { ...NONE },
    banks: NONE,
    orders: SALES_CRUD,
    rfq: NONE,
  },
  distribution_office: {
    customers: VIEW_ONLY,
    products: VIEW_ONLY,
    invoices: { view: true, create: true, edit: false, delete: false, approve: false, export: true },
    followups: VIEW_ONLY,
    accounting: NONE,
    reports: VIEW_ONLY,
    ai: VIEW_ONLY,
    settings: NONE,
    backup: NONE,
    users: NONE,
    stocktaking: VIEW_ONLY,
    messages: VIEW_ONLY,
    reps: VIEW_ONLY,
    production: { ...NONE },
    production_bom: { ...NONE },
    production_cost: { ...NONE },
    production_close: { ...NONE },
    production_reports: { ...NONE },
    banks: NONE,
    orders: { view: true, create: true, edit: false, delete: false, approve: false, export: false },
    rfq: NONE,
  },
  /** صندوق فروشگاهی — فروش قطعی تک‌فروشی (نه پیش‌فاکتور نماینده) */
  store_retail: {
    customers: VIEW_ONLY,
    products: { view: true, create: false, edit: false, delete: false, approve: false, export: false },
    invoices: { view: true, create: true, edit: false, delete: false, approve: false, export: false },
    followups: NONE,
    accounting: NONE,
    reports: VIEW_ONLY,
    ai: VIEW_ONLY,
    settings: NONE,
    backup: NONE,
    users: NONE,
    stocktaking: VIEW_ONLY,
    messages: VIEW_ONLY,
    reps: VIEW_ONLY,
    production: { ...NONE },
    production_bom: { ...NONE },
    production_cost: { ...NONE },
    production_close: { ...NONE },
    production_reports: { ...NONE },
    banks: NONE,
    orders: NONE,
    rfq: NONE,
    qty_receipt: { ...NONE, view: true, create: true },
    sales_amount: { ...NONE, view: true },
  },
  production_manager: {
    customers: VIEW_ONLY,
    products: { view: true, create: true, edit: true, delete: false, approve: false, export: true },
    invoices: VIEW_ONLY,
    followups: VIEW_ONLY,
    accounting: NONE,
    reports: VIEW_ONLY,
    ai: VIEW_ONLY,
    settings: NONE,
    backup: NONE,
    users: NONE,
    stocktaking: VIEW_ONLY,
    messages: VIEW_ONLY,
    reps: VIEW_ONLY,
    banks: NONE,
    orders: NONE,
    rfq: NONE,
    ...PROD_MGR,
  },
  production_operator: {
    customers: VIEW_ONLY,
    products: VIEW_ONLY,
    invoices: VIEW_ONLY,
    followups: VIEW_ONLY,
    accounting: NONE,
    reports: VIEW_ONLY,
    ai: VIEW_ONLY,
    settings: NONE,
    backup: NONE,
    users: NONE,
    stocktaking: VIEW_ONLY,
    messages: VIEW_ONLY,
    reps: VIEW_ONLY,
    banks: NONE,
    orders: NONE,
    rfq: NONE,
    ...PROD_OP,
  },
  unit_manager: {
    customers: VIEW_ONLY,
    parties: VIEW_ONLY,
    products: { view: true, create: false, edit: false, delete: false, approve: false, export: false },
    invoices: VIEW_ONLY,
    followups: VIEW_ONLY,
    accounting: NONE,
    reports: VIEW_ONLY,
    ai: VIEW_ONLY,
    settings: NONE,
    backup: NONE,
    users: NONE,
    stocktaking: VIEW_ONLY,
    messages: VIEW_ONLY,
    reps: VIEW_ONLY,
    banks: NONE,
    orders: NONE,
    rfq: NONE,
    portal: { view: true, create: true, edit: true, delete: false, approve: true, export: false },
    production: { view: true, create: true, edit: false, delete: false, approve: false, export: false },
    production_bom: VIEW_ONLY,
    production_cost: { ...NONE },
    production_close: { ...NONE },
    production_reports: VIEW_ONLY,
  },
  department_manager: {
    customers: VIEW_ONLY,
    parties: VIEW_ONLY,
    products: { view: true, create: false, edit: false, delete: false, approve: false, export: false },
    invoices: VIEW_ONLY,
    followups: VIEW_ONLY,
    accounting: NONE,
    reports: VIEW_ONLY,
    ai: VIEW_ONLY,
    settings: NONE,
    backup: NONE,
    users: NONE,
    stocktaking: VIEW_ONLY,
    messages: VIEW_ONLY,
    reps: VIEW_ONLY,
    banks: NONE,
    orders: NONE,
    rfq: NONE,
    portal: { view: true, create: true, edit: false, delete: false, approve: false, export: false },
    production: { view: true, create: true, edit: false, delete: false, approve: false, export: false },
    production_bom: VIEW_ONLY,
    production_cost: { ...NONE },
    production_close: { ...NONE },
    production_reports: VIEW_ONLY,
  },
};

/**
 * v522 role-level overrides edited by admin: settings key `role_permission_defaults`,
 * JSON { role: { resource: { action: bool } } }. Layering: code defaults → role overrides →
 * per-user user_permissions rows.
 */
const ROLE_DEFAULTS_KEY = 'role_permission_defaults';

function getRoleOverrides(db) {
  if (!db) return {};
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(ROLE_DEFAULTS_KEY);
    const parsed = row && row.value ? JSON.parse(row.value) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

/** Sanitise + persist role overrides (admin keeps everything; unknown keys dropped). */
function saveRoleOverrides(db, overrides) {
  const clean = {};
  for (const [role, res] of Object.entries(overrides || {})) {
    if (role === 'admin' || !DEFAULT_ROLE_PERMISSIONS[role] || !res || typeof res !== 'object') continue;
    for (const [resource, flags] of Object.entries(res)) {
      if (!RESOURCES.includes(resource) || !flags || typeof flags !== 'object') continue;
      for (const action of ACTIONS) {
        if (flags[action] === undefined) continue;
        if (!clean[role]) clean[role] = {};
        if (!clean[role][resource]) clean[role][resource] = {};
        clean[role][resource][action] = !!flags[action];
      }
    }
  }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(ROLE_DEFAULTS_KEY, JSON.stringify(clean));
  return clean;
}

function codeRoleDefaults(role) {
  const base = DEFAULT_ROLE_PERMISSIONS[role] || DEFAULT_ROLE_PERMISSIONS.field_sales;
  const out = {};
  for (const r of RESOURCES) {
    if (base[r]) out[r] = { ...base[r] };
    else if (isAccSectionResource(r)) out[r] = accSectionDefault(role, r);
    else if (CAPABILITY_SET.has(r)) out[r] = capabilityDefault(role, r);
    else out[r] = CLOSED_DEFAULT_NONE.has(r) ? { ...NONE } : { ...VIEW_ONLY };
  }
  return out;
}

function fillRoleDefaults(role, db) {
  const out = codeRoleDefaults(role);
  if (role === 'admin') return out;
  const mine = getRoleOverrides(db)[role] || {};
  for (const [resource, flags] of Object.entries(mine)) {
    if (!out[resource]) continue;
    for (const action of ACTIONS) {
      if (flags && flags[action] !== undefined) out[resource][action] = !!flags[action];
    }
  }
  return out;
}

function getUserPermissions(db, userId, role) {
  const rows = db.prepare('SELECT resource, action, allowed FROM user_permissions WHERE user_id=?').all(userId);
  const perms = fillRoleDefaults(role, db);
  for (const row of rows) {
    if (!perms[row.resource]) perms[row.resource] = { ...VIEW_ONLY };
    if (ACTIONS.includes(row.action)) perms[row.resource][row.action] = !!row.allowed;
  }
  return perms;
}

function hasPermission(db, user, resource, action) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const perms = getUserPermissions(db, user.id, user.role);
  if (perms[resource] && perms[resource][action]) return true;
  const aliases = LEGACY_PARENTS[resource];
  if (!aliases) return false;
  for (const section of aliases) {
    if (perms[section] && perms[section][action]) return true;
  }
  return false;
}

/**
 * v522 single capability check: admin → always; others → role defaults (code + admin
 * overrides) then per-user grants/denials. `resource` may be a menu id ('acc-inv-valuation')
 * or a resource ('acc_inv_valuation').
 */
function canDo(user, resource, action, db) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (!ACTIONS.includes(action)) return false;
  const res = String(resource || '').startsWith('acc-') ? resourceForNav(resource) : String(resource || '');
  if (!res) return false;
  const handle = db || require('../db').getDB();
  return hasPermission(handle, user, res, action);
}

/** Express middleware form of canDo. */
function requireCan(resource, action) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'توکن یافت نشد' });
    if (canDo(req.user, resource, action)) return next();
    return res.status(403).json({ error: 'دسترسی ندارید', code: 'E_PERMISSION', resource, action });
  };
}

function isManagerRole(role) {
  return role === 'admin' || role === 'sales_manager';
}

/** OPEN-DECISION (audit 8A #98): roles allowed unrestricted when users.branch_id is null. */
function isBranchUnscopedRole(role) {
  return role === 'admin' || role === 'accounting' || role === 'sales_manager';
}

function sodErr(message) {
  const e = new Error(message);
  e.status = 403;
  e.code = 'E_SOD_MAKER_CHECKER';
  return e;
}

/**
 * Segregation of duties / maker-checker (ممیزی ۸D).
 * سازنده همان سند را تأیید/ثبت قطعی نمی‌کند — حتی نقش admin (بدون override).
 * Alias: requireDifferentApprover(createdBy, approverUserId) با شکل دوآرگومانی user/createdBy.
 */
function assertMakerChecker(user, createdByUserId) {
  if (!user) throw sodErr('ورود لازم است');
  if (createdByUserId == null || createdByUserId === '') return;
  if (Number(createdByUserId) === Number(user.id)) {
    throw sodErr('سازنده نمی‌تواند همان سند را تأیید کند (segregation / maker-checker)');
  }
}

/** همان assertMakerChecker — نام خوانا برای مسیرهای approve/post. */
function requireDifferentApprover(createdByUserId, approverUserOrId) {
  const user = (approverUserOrId && typeof approverUserOrId === 'object')
    ? approverUserOrId
    : { id: approverUserOrId };
  return assertMakerChecker(user, createdByUserId);
}

function branchScopeErr(message) {
  const e = new Error(message);
  e.status = 403;
  e.code = 'E_BRANCH_SCOPE';
  return e;
}

/**
 * Staff ACL is branch-scoped via users.branch_id.
 * OPEN-DECISION (audit 8A #98): admin/accounting/sales_manager without branch stay
 * company-wide; other roles without branch_id are fail-closed (not unrestricted).
 */
function assertBranchScope(user, rowBranchId) {
  if (!user) throw branchScopeErr('ورود لازم است');
  if (user.role === 'admin') return;
  const mine = user.branch_id != null ? Number(user.branch_id) : null;
  if (mine == null) {
    if (isBranchUnscopedRole(user.role)) return;
    throw branchScopeErr('شعبه برای نقش شما تعریف نشده است');
  }
  if (rowBranchId == null) return;
  if (Number(rowBranchId) !== mine) {
    throw branchScopeErr('این رکورد خارج از شعبه شماست');
  }
}

function applyBranchScopeSql(user, alias) {
  if (!user || user.role === 'admin') return { sql: '', params: [] };
  const mine = user.branch_id != null ? Number(user.branch_id) : null;
  const col = alias ? `${alias}.branch_id` : 'branch_id';
  if (mine == null) {
    if (isBranchUnscopedRole(user.role)) return { sql: '', params: [] };
    return { sql: ' AND 1=0', params: [] };
  }
  return { sql: ` AND (${col} IS NULL OR ${col}=?)`, params: [mine] };
}

/** Copy of the matrix with section grants also satisfying their legacy resource. For /rbac/me only. */
function applyLegacyGrants(perms) {
  const out = {};
  for (const [key, flags] of Object.entries(perms || {})) out[key] = { ...flags };
  for (const [parent, sections] of Object.entries(LEGACY_PARENTS)) {
    if (!out[parent]) continue;
    const next = { ...out[parent] };
    for (const action of ACTIONS) {
      if (sections.some((section) => out[section] && out[section][action])) next[action] = true;
    }
    out[parent] = next;
  }
  return out;
}

module.exports = {
  ACTIONS, RESOURCES, DEFAULT_ROLE_PERMISSIONS, CLOSED_DEFAULT_NONE,
  getUserPermissions, hasPermission, isManagerRole, isBranchUnscopedRole, fillRoleDefaults, applyLegacyGrants,
  assertMakerChecker, requireDifferentApprover, assertBranchScope, applyBranchScopeSql,
  // v522
  canDo, requireCan, codeRoleDefaults, getRoleOverrides, saveRoleOverrides, ROLE_DEFAULTS_KEY,
};
