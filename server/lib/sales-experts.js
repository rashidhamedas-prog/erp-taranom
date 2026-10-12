/**
 * Canonical roles that may own a sales invoice / appear as «کارشناس» in pickers.
 * Broader than REP_ROLES (field/inside only — commissions & rep ledger).
 * Keep client `SALES_EXPERT_ROLES` in app.js in sync with this list.
 */
const SALES_EXPERT_ROLES = Object.freeze([
  'admin',
  'accounting',
  'field_sales',
  'inside_sales',
  'salesperson',
  'sales_manager',
  'distribution_office',
]);

function isSalesExpertRole(role) {
  return SALES_EXPERT_ROLES.includes(String(role || ''));
}

/** SQL fragment: role IN (...) — values are fixed constants, safe to inline. */
function salesExpertRolesSql() {
  return `(${SALES_EXPERT_ROLES.map((r) => `'${r}'`).join(',')})`;
}

module.exports = {
  SALES_EXPERT_ROLES,
  isSalesExpertRole,
  salesExpertRolesSql,
};
