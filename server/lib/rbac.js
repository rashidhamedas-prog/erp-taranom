// Granular RBAC — default matrix by role + per-user overrides in user_permissions.
const {
  ACC_SECTION_RESOURCES, isAccSectionResource, accSectionDefault, LEGACY_PARENTS,
  ACC_CAPABILITY_RESOURCES, capabilityDefault, resourceForNav,
} = require('./accounting-access');

const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'export'];

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
];
const CAPABILITY_SET = new Set(ACC_CAPABILITY_RESOURCES);

const ALL = Object.fromEntries(ACTIONS.map(a => [a, true]));
const VIEW_ONLY = { view: true, create: false, edit: false, delete: false, approve: false, export: false };
const SALES_CRUD = { view: true, create: true, edit: true, delete: false, approve: false, export: true };
const ACC_FULL = { ...ALL };
const PROD_MGR = {
  production: { view: true, create: true, edit: true, delete: false, approve: true, export: true },
  production_bom: { view: true, create: true, edit: true, delete: false, approve: true, export: true },
  production_cost: { view: true, create: false, edit: false, delete: false, approve: false, export: true },
  production_close: { view: true, create: false, edit: false, delete: false, approve: false, export: true },
  production_reports: { view: true, create: false, edit: false, delete: false, approve: false, export: true },
};
const NONE = { view: false, create: false, edit: false, delete: false, approve: false, export: false };
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
    backup: VIEW_ONLY,
    users: VIEW_ONLY,
    stocktaking: VIEW_ONLY,
    messages: SALES_CRUD,
    reps: { view: true, create: true, edit: true, delete: false, approve: true, export: true },
    production: { view: true, create: false, edit: false, delete: false, approve: false, export: true },
    production_bom: { view: true, create: false, edit: false, delete: false, approve: false, export: true },
    production_cost: { ...NONE },
    production_close: { ...NONE },
    production_reports: { view: true, create: false, edit: false, delete: false, approve: false, export: true },
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
    backup: VIEW_ONLY,
    users: VIEW_ONLY,
    stocktaking: VIEW_ONLY,
    messages: SALES_CRUD,
    reps: VIEW_ONLY,
    production: { ...NONE },
    production_bom: { ...NONE },
    production_cost: { ...NONE },
    production_close: { ...NONE },
    production_reports: { ...NONE },
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
    backup: VIEW_ONLY,
    users: VIEW_ONLY,
    stocktaking: VIEW_ONLY,
    messages: SALES_CRUD,
    reps: VIEW_ONLY,
    production: { ...NONE },
    production_bom: { ...NONE },
    production_cost: { ...NONE },
    production_close: { ...NONE },
    production_reports: { ...NONE },
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
    backup: VIEW_ONLY,
    users: VIEW_ONLY,
    stocktaking: VIEW_ONLY,
    messages: VIEW_ONLY,
    reps: VIEW_ONLY,
    production: { ...NONE },
    production_bom: { ...NONE },
    production_cost: { ...NONE },
    production_close: { ...NONE },
    production_reports: { ...NONE },
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
    backup: VIEW_ONLY,
    users: VIEW_ONLY,
    stocktaking: VIEW_ONLY,
    messages: VIEW_ONLY,
    reps: VIEW_ONLY,
    production: { ...NONE },
    production_bom: { ...NONE },
    production_cost: { ...NONE },
    production_close: { ...NONE },
    production_reports: { ...NONE },
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
    backup: VIEW_ONLY,
    users: VIEW_ONLY,
    stocktaking: VIEW_ONLY,
    messages: VIEW_ONLY,
    reps: VIEW_ONLY,
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
    backup: VIEW_ONLY,
    users: VIEW_ONLY,
    stocktaking: VIEW_ONLY,
    messages: VIEW_ONLY,
    reps: VIEW_ONLY,
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
    backup: VIEW_ONLY,
    users: VIEW_ONLY,
    stocktaking: VIEW_ONLY,
    messages: VIEW_ONLY,
    reps: VIEW_ONLY,
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
    backup: VIEW_ONLY,
    users: VIEW_ONLY,
    stocktaking: VIEW_ONLY,
    messages: VIEW_ONLY,
    reps: VIEW_ONLY,
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
    else out[r] = { ...VIEW_ONLY };
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

function sodErr(message) {
  const e = new Error(message);
  e.status = 403;
  e.code = 'E_SOD_MAKER_CHECKER';
  return e;
}

/** Segregation of duties / maker-checker / sod_ — creator cannot approve the same document. */
function assertMakerChecker(user, createdByUserId) {
  if (!user) throw sodErr('ورود لازم است');
  if (user.role === 'admin') return;
  if (createdByUserId == null) return;
  if (Number(createdByUserId) === Number(user.id)) {
    throw sodErr('سازنده نمی‌تواند همان سند را تأیید کند (segregation / maker-checker)');
  }
}

function branchScopeErr(message) {
  const e = new Error(message);
  e.status = 403;
  e.code = 'E_BRANCH_SCOPE';
  return e;
}

/** Staff ACL is branch-scoped via users.branch_id. Admin is unrestricted. */
function assertBranchScope(user, rowBranchId) {
  if (!user) throw branchScopeErr('ورود لازم است');
  if (user.role === 'admin') return;
  const mine = user.branch_id != null ? Number(user.branch_id) : null;
  if (mine == null) return;
  if (rowBranchId == null) return;
  if (Number(rowBranchId) !== mine) {
    throw branchScopeErr('این رکورد خارج از شعبه شماست');
  }
}

function applyBranchScopeSql(user, alias) {
  if (!user || user.role === 'admin') return { sql: '', params: [] };
  const mine = user.branch_id != null ? Number(user.branch_id) : null;
  if (mine == null) return { sql: '', params: [] };
  const col = alias ? `${alias}.branch_id` : 'branch_id';
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
  ACTIONS, RESOURCES, DEFAULT_ROLE_PERMISSIONS,
  getUserPermissions, hasPermission, isManagerRole, fillRoleDefaults, applyLegacyGrants,
  assertMakerChecker, assertBranchScope, applyBranchScopeSql,
  // v522
  canDo, requireCan, codeRoleDefaults, getRoleOverrides, saveRoleOverrides, ROLE_DEFAULTS_KEY,
};
