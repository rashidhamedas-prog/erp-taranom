'use strict';

/**
 * Accounting access catalog — single server source for delegated accounting.
 *
 * Master gate: resource `accounting`, action `view` → main nav tab «حسابداری».
 * Each accounting menu id `acc-*` is its own resource `acc_<id>` (dashes → underscores).
 * The same id drives the permissions panel and which rows appear inside the tab.
 * Delegated users (not admin, not the accounting role) pass adminOrAccounting only
 * when the request path maps to a section they hold the matching action for.
 * The accounting role stays on the existing role gate so unmapped routes keep working.
 */

const ALL_FLAGS = { view: true, create: true, edit: true, delete: true, approve: true, export: true };
const NONE_FLAGS = { view: false, create: false, edit: false, delete: false, approve: false, export: false };
const MANAGER_FLAGS = { view: true, create: false, edit: false, delete: false, approve: true, export: true };

/** Pages a sales manager already reaches inside the accounting shell. Dashboard included because the shell opens there. */
const SALES_MANAGER_ACC_NAVIDS = new Set([
  'acc-dash',
  'acc-reps',
  'acc-commissions',
  'acc-receivables',
  'acc-sales-invoices',
  'acc-statement',
  'acc-settlements',
]);

/**
 * navId → { apis: string[], legacy?: string }
 * `legacy` means a grant on this section also satisfies hasPermission(legacy, same action)
 * so existing requirePermission('payroll'|'production_*') routes open with the section.
 * Append new menu ids at the end.
 */
const ACC_ITEMS = {
  'acc-dash': { apis: ['/api/accounting/overview', '/api/accounting/general', '/api/accounting/pending-approvals'] },
  'acc-parties': { apis: ['/api/parties', '/api/persons'] },
  'acc-party-groups': { apis: ['/api/party-groups'] },
  'acc-person-positions': { apis: ['/api/person-positions'] },
  'acc-customer-groups': { apis: ['/api/accounting/customer-groups'] },
  'acc-receivables': { apis: ['/api/accounting/receivables', '/api/accounting/customers'] },
  'acc-statement': { apis: ['/api/accounting/statement'] },
  'acc-party-control-dashboard': { apis: ['/api/adv-reports/party-control-dashboard', '/api/parties'] },
  'acc-products': { apis: ['/api/products'] },
  'acc-product-groups': { apis: ['/api/product-categories'] },
  'acc-product-colors': { apis: ['/api/product-variants'] },
  'acc-product-sizes': { apis: ['/api/product-variants'] },
  'acc-units': { apis: ['/api/units'] },
  'acc-warehouses': { apis: ['/api/warehouses'] },
  'acc-warehouse-ops': { apis: ['/api/inventory'] },
  'acc-stocktaking': { apis: ['/api/stocktaking'] },
  'acc-inv-batches': { apis: ['/api/inventory'] },
  'acc-fabric-rolls': { apis: ['/api/inventory'] },
  'acc-inv-reservations': { apis: ['/api/inventory'] },
  'acc-inv-landed': { apis: ['/api/inventory'] },
  'acc-consignments': { apis: ['/api/consignments', '/api/inventory'] },
  'acc-warehouse-report': { apis: ['/api/inventory', '/api/adv-reports/inventory-valuation', '/api/adv-reports/inventory-health'] },
  'acc-variant-stock-report': { apis: ['/api/inventory', '/api/product-variants'] },
  'acc-item-kardex': { apis: ['/api/inventory', '/api/ledgers'] },
  'acc-fabric-roll-kardex': { apis: ['/api/inventory'] },
  'acc-banks': { apis: ['/api/banks'] },
  'acc-cash-boxes': { apis: ['/api/cash-boxes'] },
  'acc-check-categories': { apis: ['/api/check-categories'] },
  'acc-account-transfer': { apis: ['/api/transfers'] },
  'acc-petty-cash-ops': { apis: ['/api/cash-boxes'] },
  'acc-bank-recon': { apis: ['/api/bank-reconciliation'] },
  'acc-pos-report': { apis: ['/api/pos'] },
  'acc-cash-flow-std': { apis: ['/api/adv-reports/cash-flow'] },
  'acc-treasury-dashboard': { apis: ['/api/adv-reports/treasury-dashboard', '/api/adv-reports/cash-flow', '/api/banks', '/api/cash-boxes', '/api/bank-reconciliation'] },
  'acc-incomes': { apis: ['/api/accounting/general', '/api/accounting/income-statement'] },
  'acc-expenses': { apis: ['/api/expenses'] },
  'acc-expense-categories': { apis: ['/api/expenses/categories'] },
  'acc-sales-invoices': { apis: ['/api/accounting/invoices'] },
  'acc-purchases': { apis: ['/api/purchases'] },
  'acc-sales-returns': { apis: ['/api/accounting/sales-returns'] },
  'acc-purchase-returns': { apis: ['/api/purchases'] },
  'acc-orders-list': { apis: ['/api/orders'] },
  // Cash-ops screen bundles receive + outgoing pay. Companion APIs must open with
  // this section alone — otherwise delegated users (e.g. distribution_office) get
  // menu access but the page dies on Promise.all 403 (incentive-payments / COA / vouchers).
  'acc-settlements': {
    apis: [
      '/api/accounting/settlements',
      '/api/accounting/account-payments',
      '/api/accounting/account-receipts',
      '/api/accounting/incentive-payments',
      '/api/accounting/cash-ops',
      '/api/accounting/vouchers',
      '/api/accounting/customers',
      '/api/accounting/suppliers',
      '/api/reps/payments',
      '/api/transfers',
      // Same-length OR with acc_expenses — do NOT add /api/purchases/payments
      // (longer than /api/purchases and would steal purchase-only delegates).
      '/api/expenses',
    ],
    readApis: [
      '/api/accounting/chart-of-accounts',
      '/api/accounting/coa',
      '/api/accounting/commissions',
      '/api/accounting/cost-centers',
      '/api/expenses/categories',
      '/api/suppliers',
      '/api/check-categories',
    ],
  },
  'acc-pl-statement': { apis: ['/api/accounting/income-statement', '/api/accounting/general'] },
  'acc-sales-purchase-dashboard': { apis: ['/api/adv-reports/sales-purchase-dashboard'] },
  'acc-invoice-list-tax': { apis: ['/api/moadian', '/api/accounting/invoices'] },
  'acc-opening-recv-cheques': { apis: ['/api/accounting/cheques', '/api/cheque-records'] },
  'acc-opening-pay-cheques': { apis: ['/api/accounting/cheques', '/api/cheque-records'] },
  'acc-cheques-recv': { apis: ['/api/accounting/cheques', '/api/cheque-records'] },
  'acc-cheques-pay': { apis: ['/api/accounting/cheques', '/api/cheque-records'] },
  'acc-trust-checks': { apis: ['/api/trust-checks'] },
  'acc-cheque-register': { apis: ['/api/cheque-records', '/api/accounting/cheques'] },
  'acc-cheque-dashboard': { apis: ['/api/adv-reports/cheque-dashboard', '/api/cheque-records', '/api/accounting/cheques'] },
  'acc-chequebook-report': { apis: ['/api/adv-reports/chequebook-dashboard', '/api/check-categories', '/api/cheque-records'] },
  'acc-coa-codes': { apis: ['/api/accounting/chart-of-accounts', '/api/accounting/coa'] },
  'acc-account-groups': { apis: ['/api/accounting/chart-of-accounts', '/api/accounting/coa'] },
  'acc-ledger-accounts': { apis: ['/api/accounting/chart-of-accounts', '/api/accounting/coa'] },
  'acc-subsidiary-accounts': { apis: ['/api/accounting/chart-of-accounts', '/api/accounting/coa'] },
  'acc-detail-accounts': { apis: ['/api/detail-accounts', '/api/accounting/chart-of-accounts'] },
  'acc-detail-categories': { apis: ['/api/detail-accounts'] },
  'acc-other-details': { apis: ['/api/detail-accounts'] },
  'acc-equity-info': { apis: ['/api/accounting/chart-of-accounts'] },
  'acc-shareholders': { apis: ['/api/parties'] },
  'acc-cost-centers': { apis: ['/api/accounting/cost-centers'] },
  'acc-fiscal-period': { apis: [] },
  'acc-journal-docs': { apis: ['/api/accounting/journal', '/api/ledgers'] },
  'acc-journal-entry': { apis: ['/api/accounting/vouchers'] },
  'acc-opening-voucher': { apis: ['/api/accounting/vouchers'] },
  'acc-close-temp': { apis: ['/api/accounting/vouchers'] },
  'acc-close-perm': { apis: ['/api/accounting/vouchers'] },
  'acc-revaluation': { apis: ['/api/accounting/vouchers'] },
  'acc-adv-reports': { apis: ['/api/adv-reports'] },
  'acc-shared-ledger': { apis: ['/api/ledgers'] },
  'acc-trial-balance': { apis: ['/api/accounting/trial-balance'] },
  'acc-financial-statement': { apis: ['/api/accounting/balance-sheet'] },
  'acc-reconciliation': { apis: ['/api/accounting/general-ledger', '/api/accounting/account-dashboard'] },
  'acc-vat-return': { apis: ['/api/moadian'] },
  'acc-seasonal-169': { apis: ['/api/moadian'] },
  'acc-kpi-dashboard': { apis: ['/api/accounting/overview'] },
  'acc-reserves': { apis: ['/api/reserves'] },
  'acc-budgeting': { apis: ['/api/budgeting'] },
  'acc-portal-units': { apis: ['/api/portal'], legacy: 'portal' },
  'acc-portal-my-dept': { apis: ['/api/portal'], legacy: 'portal' },
  'acc-production-boms': { apis: ['/api/production/boms'], legacy: 'production_bom' },
  'acc-production-rates': { apis: ['/api/production/cost-centers'], legacy: 'production_cost' },
  'acc-production-access': { apis: ['/api/production/user-cost-centers'], legacy: 'production' },
  'acc-production-dashboard': { apis: ['/api/production/health-check'], legacy: 'production_reports' },
  'acc-production-orders': { apis: ['/api/production/orders'], legacy: 'production' },
  'acc-cutting-lays': { apis: ['/api/production/cutting-lays'], legacy: 'production' },
  'acc-production-kanban': { apis: ['/api/production/execution'], legacy: 'production_reports' },
  'acc-production-estimate': { apis: ['/api/production/estimate'], legacy: 'production_cost' },
  'acc-production-mrp': { apis: ['/api/production/mrp'], legacy: 'production' },
  'acc-production-close': { apis: ['/api/production/close'], legacy: 'production_close' },
  'acc-production-reports': { apis: ['/api/production/reports'], legacy: 'production_reports' },
  'acc-production-variance': { apis: ['/api/production/reports', '/api/production/close'], legacy: 'production_reports' },
  'acc-production-monthly-profit': { apis: ['/api/production/reports'], legacy: 'production_reports' },
  'acc-production-cost-sheet': { apis: ['/api/production/reports'], legacy: 'production_reports' },
  'acc-payroll-employees': { apis: ['/api/payroll'], legacy: 'payroll' },
  'acc-payroll-structures': { apis: ['/api/payroll'], legacy: 'payroll' },
  'acc-payroll-tax': { apis: ['/api/payroll'], legacy: 'payroll' },
  'acc-payroll-periods': { apis: ['/api/payroll'], legacy: 'payroll' },
  'acc-payroll-processing': { apis: ['/api/payroll'], legacy: 'payroll' },
  'acc-payroll': { apis: ['/api/payroll'], legacy: 'payroll' },
  'acc-payroll-year-end': { apis: ['/api/payroll'], legacy: 'payroll' },
  'acc-payroll-reports': { apis: ['/api/payroll'], legacy: 'payroll' },
  'acc-fixed-assets': { apis: ['/api/fixed-assets'], legacy: 'fixed_assets' },
  'acc-currencies': { apis: ['/api/fx'] },
  'acc-fx-rates': { apis: ['/api/fx'] },
  'acc-pos-devices': { apis: ['/api/pos'] },
  'acc-scale-settings': { apis: [] },
  'acc-company-profile': { apis: [] },
  'acc-settings': { apis: [] },
  'acc-devices': { apis: [] },
  'acc-backup': { apis: [] },
  'acc-fiscal-ops': { apis: [] },
  'acc-moadian': { apis: ['/api/moadian'], legacy: 'moadian' },
  'acc-commissions': { apis: ['/api/accounting/commissions', '/api/accounting/incentive-payments'] },
  'acc-reps': { apis: ['/api/reps'] },
};

function resourceForNav(navId) {
  const id = String(navId || '');
  if (!id.startsWith('acc-')) return null;
  return 'acc_' + id.slice(4).replace(/-/g, '_');
}

const NAV_BY_RESOURCE = {};
const ACC_SECTION_RESOURCES = [];
for (const navId of Object.keys(ACC_ITEMS)) {
  const resource = resourceForNav(navId);
  if (!resource || NAV_BY_RESOURCE[resource]) {
    throw new Error('accounting-access: bad or duplicate resource for ' + navId);
  }
  NAV_BY_RESOURCE[resource] = navId;
  ACC_SECTION_RESOURCES.push(resource);
}
const ACC_SECTION_RESOURCE_SET = new Set(ACC_SECTION_RESOURCES);

const API_ROWS = [];
for (const [navId, spec] of Object.entries(ACC_ITEMS)) {
  const resource = resourceForNav(navId);
  for (const prefix of spec.apis || []) {
    API_ROWS.push({ prefix, resource, readOnly: false });
  }
  for (const prefix of spec.readApis || []) {
    API_ROWS.push({ prefix, resource, readOnly: true });
  }
}
API_ROWS.sort((a, b) => b.prefix.length - a.prefix.length);

const LEGACY_PARENTS = {};
for (const [navId, spec] of Object.entries(ACC_ITEMS)) {
  if (!spec.legacy) continue;
  if (!LEGACY_PARENTS[spec.legacy]) LEGACY_PARENTS[spec.legacy] = [];
  LEGACY_PARENTS[spec.legacy].push(resourceForNav(navId));
}

function isAccSectionResource(resource) {
  return ACC_SECTION_RESOURCE_SET.has(resource);
}

function accSectionDefault(role, resource) {
  if (role === 'accounting') return { ...ALL_FLAGS };
  const navId = NAV_BY_RESOURCE[resource];
  if (role === 'sales_manager' && navId && SALES_MANAGER_ACC_NAVIDS.has(navId)) return { ...MANAGER_FLAGS };
  return { ...NONE_FLAGS };
}

function prefixMatch(urlPath, prefix) {
  return urlPath === prefix || urlPath.startsWith(prefix + '/');
}

/**
 * Longest-prefix match. Equal-length prefixes are OR (shared APIs).
 * Returns { resource, readOnly }[] — readOnly rows only authorize GET/HEAD via view/export.
 */
function matchAccAccess(urlPath) {
  const path = String(urlPath || '').split('?')[0];
  let best = -1;
  const found = [];
  const seen = new Set();
  for (const row of API_ROWS) {
    if (!prefixMatch(path, row.prefix)) continue;
    if (row.prefix.length > best) {
      best = row.prefix.length;
      found.length = 0;
      seen.clear();
    } else if (row.prefix.length < best) {
      continue;
    }
    const key = row.resource + ':' + (row.readOnly ? 'r' : 'w');
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ resource: row.resource, readOnly: !!row.readOnly });
  }
  return found;
}

/** Resources only (legacy helpers / tests). */
function matchAccResources(urlPath) {
  const out = [];
  for (const hit of matchAccAccess(urlPath)) {
    if (!out.includes(hit.resource)) out.push(hit.resource);
  }
  return out;
}

function flagsAllowMethod(flags, method, urlPath) {
  if (!flags) return false;
  const m = String(method || 'GET').toUpperCase();
  const path = String(urlPath || '');
  if (m === 'GET' || m === 'HEAD') return !!(flags.view || flags.export);
  if (m === 'DELETE') return !!flags.delete;
  if (m === 'PUT' || m === 'PATCH') return !!flags.edit;
  if (m === 'POST') {
    if (flags.create || flags.edit) return true;
    return !!(flags.approve && /\/(approve|reject)(?:\/|$)/.test(path));
  }
  return false;
}

/** Whether delegated user flags authorize this hit (honours readOnly). */
function accessHitAllows(hit, flags, method, urlPath) {
  if (!hit) return false;
  const m = String(method || 'GET').toUpperCase();
  if (hit.readOnly) {
    if (m !== 'GET' && m !== 'HEAD') return false;
    return !!(flags && (flags.view || flags.export));
  }
  return flagsAllowMethod(flags, method, urlPath);
}

module.exports = {
  ACC_ITEMS,
  ACC_SECTION_RESOURCES,
  SALES_MANAGER_ACC_NAVIDS,
  LEGACY_PARENTS,
  resourceForNav,
  isAccSectionResource,
  accSectionDefault,
  matchAccAccess,
  matchAccResources,
  flagsAllowMethod,
  accessHitAllows,
};
