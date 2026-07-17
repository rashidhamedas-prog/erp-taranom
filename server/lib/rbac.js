// Granular RBAC — default matrix by role + per-user overrides in user_permissions.

const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'export'];

const RESOURCES = [
  'customers', 'parties', 'products', 'invoices', 'followups', 'accounting', 'reports',
  'ai', 'settings', 'backup', 'users', 'stocktaking', 'messages', 'reps', 'dashboard',
  'journal_vouchers', 'payroll', 'fixed_assets', 'moadian',
  // Production module (append-only)
  'production', 'production_bom', 'production_cost', 'production_close', 'production_reports',
];

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
    settings: VIEW_ONLY,
    backup: VIEW_ONLY,
    users: VIEW_ONLY,
    stocktaking: ACC_FULL,
    messages: SALES_CRUD,
    reps: { view: true, create: true, edit: true, delete: false, approve: true, export: true },
    production: { view: true, create: true, edit: true, delete: false, approve: true, export: true },
    production_bom: { view: true, create: true, edit: true, delete: false, approve: false, export: true },
    production_cost: ALL,
    production_close: { view: true, create: true, edit: true, delete: false, approve: true, export: true },
    production_reports: { view: true, create: false, edit: false, delete: false, approve: false, export: true },
  },
  sales_manager: {
    customers: SALES_CRUD,
    products: { view: true, create: false, edit: false, delete: false, approve: false, export: true },
    invoices: { ...SALES_CRUD, approve: true },
    followups: SALES_CRUD,
    accounting: { view: true, create: false, edit: false, delete: false, approve: true, export: true },
    reports: { view: true, create: false, edit: false, delete: false, approve: false, export: true },
    ai: ALL,
    settings: VIEW_ONLY,
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
    accounting: VIEW_ONLY,
    reports: VIEW_ONLY,
    ai: VIEW_ONLY,
    settings: VIEW_ONLY,
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
    accounting: VIEW_ONLY,
    reports: VIEW_ONLY,
    ai: VIEW_ONLY,
    settings: VIEW_ONLY,
    backup: VIEW_ONLY,
    users: VIEW_ONLY,
    stocktaking: VIEW_ONLY,
    messages: SALES_CRUD,
    reps: VIEW_ONLY,
  },
  distribution_office: {
    customers: VIEW_ONLY,
    products: VIEW_ONLY,
    invoices: VIEW_ONLY,
    followups: VIEW_ONLY,
    accounting: VIEW_ONLY,
    reports: VIEW_ONLY,
    ai: VIEW_ONLY,
    settings: VIEW_ONLY,
    backup: VIEW_ONLY,
    users: VIEW_ONLY,
    stocktaking: VIEW_ONLY,
    messages: VIEW_ONLY,
    reps: VIEW_ONLY,
  },
  production_manager: {
    customers: VIEW_ONLY,
    products: { view: true, create: true, edit: true, delete: false, approve: false, export: true },
    invoices: VIEW_ONLY,
    followups: VIEW_ONLY,
    accounting: VIEW_ONLY,
    reports: VIEW_ONLY,
    ai: VIEW_ONLY,
    settings: VIEW_ONLY,
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
    accounting: VIEW_ONLY,
    reports: VIEW_ONLY,
    ai: VIEW_ONLY,
    settings: VIEW_ONLY,
    backup: VIEW_ONLY,
    users: VIEW_ONLY,
    stocktaking: VIEW_ONLY,
    messages: VIEW_ONLY,
    reps: VIEW_ONLY,
    ...PROD_OP,
  },
};

function fillRoleDefaults(role) {
  const base = DEFAULT_ROLE_PERMISSIONS[role] || DEFAULT_ROLE_PERMISSIONS.field_sales;
  const out = {};
  for (const r of RESOURCES) {
    out[r] = { ...(base[r] || VIEW_ONLY) };
  }
  return out;
}

function getUserPermissions(db, userId, role) {
  const rows = db.prepare('SELECT resource, action, allowed FROM user_permissions WHERE user_id=?').all(userId);
  const perms = fillRoleDefaults(role);
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
  return !!(perms[resource] && perms[resource][action]);
}

function isManagerRole(role) {
  return role === 'admin' || role === 'sales_manager';
}

module.exports = {
  ACTIONS, RESOURCES, DEFAULT_ROLE_PERMISSIONS,
  getUserPermissions, hasPermission, isManagerRole, fillRoleDefaults,
};
