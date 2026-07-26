// Shared sync-table registry — used by BOTH the central server (pull endpoint,
// sync_seq/tombstone triggers) and device builds (provisional id-range seeding,
// pull application). The array order is FK-parents-first and APPEND-ONLY:
// each table's index feeds into the provisional id formula, so reordering or
// removing entries would corrupt existing devices' id ranges.
//
// Checklist when appending (do not skip): PATH_TABLE_MAP, FK_COLUMNS,
// compositeKeys if needed, sync_seq_backfill_vN, files.js for uploads —
// see .cursor/rules/sync-hygiene.mdc and docs/OFFLINE-SYNC.md.
//
// upsertKey: column used to apply pulled rows. 'id' for normal tables;
// business keys for tables the device also seeds locally at initDB (settings,
// chart_of_accounts) where local autoincrement ids differ from central's.
const SYNCABLE_TABLES = [
  { name: 'users', upsertKey: 'id' },
  { name: 'settings', upsertKey: 'key' },
  { name: 'chart_of_accounts', upsertKey: 'code' },
  { name: 'customer_groups', upsertKey: 'id' },
  { name: 'person_categories', upsertKey: 'id' },
  { name: 'cost_centers', upsertKey: 'id' },
  { name: 'warehouses', upsertKey: 'id' },
  { name: 'banks', upsertKey: 'id' },
  { name: 'cash_boxes', upsertKey: 'id' },
  { name: 'check_categories', upsertKey: 'id' },
  { name: 'suppliers', upsertKey: 'id' },
  { name: 'customers', upsertKey: 'id' },
  { name: 'persons', upsertKey: 'id' },
  { name: 'products', upsertKey: 'id' },
  { name: 'orders', upsertKey: 'id' },
  { name: 'followups', upsertKey: 'id' },
  { name: 'invoices', upsertKey: 'id' },
  { name: 'settlements', upsertKey: 'id' },
  { name: 'sales_returns', upsertKey: 'id' },
  { name: 'purchase_invoices', upsertKey: 'id' },
  { name: 'purchase_returns', upsertKey: 'id' },
  { name: 'supplier_payments', upsertKey: 'id' },
  { name: 'expense_payments', upsertKey: 'id' },
  { name: 'account_transfers', upsertKey: 'id' },
  { name: 'trust_checks', upsertKey: 'id' },
  { name: 'warehouse_moves', upsertKey: 'id' },
  { name: 'consignments', upsertKey: 'id' },
  { name: 'production_runs', upsertKey: 'id' },
  { name: 'payroll_records', upsertKey: 'id' },
  { name: 'incentive_payments', upsertKey: 'id' },
  { name: 'stock_logs', upsertKey: 'id' },
  { name: 'customer_ledger', upsertKey: 'id' },
  { name: 'supplier_ledger', upsertKey: 'id' },
  { name: 'person_ledger', upsertKey: 'id' },
  { name: 'journal_entries', upsertKey: 'id' },
  { name: 'journal_lines', upsertKey: 'id' },
  { name: 'journal_templates', upsertKey: 'id' },
  { name: 'voucher_drafts', upsertKey: 'id' },
  { name: 'messages', upsertKey: 'id' },
  { name: 'reminders', upsertKey: 'id' },
  { name: 'product_categories', upsertKey: 'id' },
  // Composite PK (no id column) — tombstone format product_id:warehouse_id
  { name: 'warehouse_stock', upsertKey: 'product_id:warehouse_id', compositeKeys: ['product_id', 'warehouse_id'] },
  { name: 'rep_assignment_history', upsertKey: 'id' },
  { name: 'rep_ledger', upsertKey: 'id' },
  { name: 'rep_expenses', upsertKey: 'id' },
  { name: 'rep_advances', upsertKey: 'id' },
  { name: 'rep_commission_rules', upsertKey: 'id' },
  { name: 'rep_commission_tiers', upsertKey: 'id' },
  { name: 'rep_settlements', upsertKey: 'id' },
  { name: 'rep_territories', upsertKey: 'id' },
  { name: 'rep_visit_logs', upsertKey: 'id' },
  { name: 'rep_call_logs', upsertKey: 'id' },
  { name: 'stocktaking_sessions', upsertKey: 'id' },
  { name: 'stocktaking_items', upsertKey: 'id' },
  { name: 'parties', upsertKey: 'id' },
  { name: 'detail_categories', upsertKey: 'id' },
  { name: 'detail_accounts', upsertKey: 'id' },
  { name: 'fiscal_years', upsertKey: 'id' },
  { name: 'units_of_measure', upsertKey: 'id' },

  // ===== Production module — appended 1405/04 (APPEND-ONLY) =====
  { name: 'bom_headers',                      upsertKey: 'id' },
  { name: 'bom_lines',                        upsertKey: 'id' },
  { name: 'bom_operations',                   upsertKey: 'id' },
  { name: 'bom_outputs',                      upsertKey: 'id' },
  { name: 'bom_change_log',                   upsertKey: 'id' },
  { name: 'cost_center_rates',                upsertKey: 'id' },
  { name: 'overhead_allocation_rules',        upsertKey: 'id' },
  { name: 'overhead_allocation_weights',      upsertKey: 'id' },
  { name: 'production_orders',                upsertKey: 'id' },
  { name: 'production_order_stages',          upsertKey: 'id' },
  { name: 'production_material_issues',       upsertKey: 'id' },
  { name: 'production_labor_entries',         upsertKey: 'id' },
  { name: 'production_overhead_applications', upsertKey: 'id' },
  { name: 'production_waste',                 upsertKey: 'id' },
  { name: 'production_rework',                upsertKey: 'id' },
  { name: 'production_receipts',              upsertKey: 'id' },
  { name: 'production_subcontract',           upsertKey: 'id' },
  { name: 'production_variances',             upsertKey: 'id' },
  { name: 'production_period_close',          upsertKey: 'period_label' },
  { name: 'production_estimates',             upsertKey: 'id' },
  { name: 'production_estimate_lines',        upsertKey: 'id' },
  { name: 'mrp_runs',                         upsertKey: 'id' },
  { name: 'mrp_requirements',                 upsertKey: 'id' },
  { name: 'production_reservations',          upsertKey: 'id' },

  // ===== Inventory module — appended 1405/04 (APPEND-ONLY) =====
  { name: 'inventory_ledger',                 upsertKey: 'id' },
  { name: 'inventory_cost_layers',            upsertKey: 'id' },
  { name: 'inventory_batches',                upsertKey: 'id' },
  { name: 'inventory_serials',                upsertKey: 'id' },
  { name: 'inventory_reservations',           upsertKey: 'id' },
  { name: 'landed_cost_docs',                 upsertKey: 'id' },
  { name: 'landed_cost_lines',                upsertKey: 'id' },
  { name: 'landed_cost_allocations',          upsertKey: 'id' },

  // ===== Payroll and advanced reporting — appended 1405/04 (APPEND-ONLY) =====
  { name: 'payroll_periods',                   upsertKey: 'id' },
  { name: 'salary_structures',                 upsertKey: 'id' },
  { name: 'payroll_tax_brackets',              upsertKey: 'id' },
  { name: 'payroll_year_end_bonuses',          upsertKey: 'id' },
  { name: 'projects',                          upsertKey: 'id' },
  { name: 'report_configurations',             upsertKey: 'id' },
  { name: 'vat_records',                       upsertKey: 'id' },

  // ===== Update 11 — FX / positions / pricing (APPEND-ONLY) =====
  { name: 'currencies',                        upsertKey: 'code' },
  { name: 'exchange_rates',                    upsertKey: 'id' },
  { name: 'person_positions',                  upsertKey: 'id' },
  { name: 'pricing_rules',                     upsertKey: 'id' },

  // ===== Portal karmandan (APPEND-ONLY) =====
  { name: 'op_units',                          upsertKey: 'id' },
  { name: 'op_unit_warehouses',                upsertKey: 'id' },
  { name: 'op_unit_persons',                   upsertKey: 'id' },
  { name: 'op_departments',                    upsertKey: 'id' },
  { name: 'op_parameters',                     upsertKey: 'id' },
  { name: 'op_parameter_items',                upsertKey: 'id' },
  { name: 'op_parameter_dept_log',             upsertKey: 'id' },

  // ===== Accounting gap — reserves / recon / budget (APPEND-ONLY) =====
  { name: 'bank_reconciliations',              upsertKey: 'id' },
  { name: 'bank_reconciliation_items',         upsertKey: 'id' },
  { name: 'doubtful_debt_provisions',          upsertKey: 'id' },
  { name: 'inventory_nrv_provisions',          upsertKey: 'id' },
  { name: 'inventory_nrv_lines',               upsertKey: 'id' },
  { name: 'legal_reserve_entries',             upsertKey: 'id' },
  { name: 'payroll_labor_settings',            upsertKey: 'id' },
  { name: 'payroll_monthly_accruals',          upsertKey: 'id' },
  { name: 'budgets',                           upsertKey: 'id' },
  { name: 'budget_lines',                      upsertKey: 'id' },

  // ===== Portal v2 — capabilities / tasks / costs (APPEND-ONLY) =====
  { name: 'op_dept_capabilities',              upsertKey: 'id' },
  { name: 'op_dept_tasks',                     upsertKey: 'id' },
  { name: 'op_unit_module_links',              upsertKey: 'id' },
  { name: 'op_parameter_extra_costs',          upsertKey: 'id' },
  { name: 'op_field_followups',                upsertKey: 'id' },
  { name: 'expense_categories',                upsertKey: 'id' },

  // ===== Portal v3 — temporary dept delegation (APPEND-ONLY) =====
  { name: 'op_dept_delegations',               upsertKey: 'id' },

  // ===== update.md tasks — product images / catalog ACL / SMS / marketer (APPEND-ONLY) =====
  { name: 'product_images',                    upsertKey: 'id' },
  { name: 'user_catalog_categories',           upsertKey: 'id' },
  { name: 'sms_templates',                     upsertKey: 'id' },
  { name: 'sms_options',                       upsertKey: 'id' },
  { name: 'sms_scheduled',                     upsertKey: 'id' },
  { name: 'marketer_carts',                    upsertKey: 'id' },

  // ===== Sync gaps fix 1405/04/31 — APPEND-ONLY =====
  { name: 'party_groups',                      upsertKey: 'id' },
  { name: 'cheque_records',                    upsertKey: 'id' },

  // ===== Sync gaps fix 1405/05/01 — assets / ACL / field payments (APPEND-ONLY) =====
  { name: 'fixed_assets',                      upsertKey: 'id' },
  { name: 'fixed_asset_depreciation',          upsertKey: 'id' },
  { name: 'user_cost_centers',                 upsertKey: 'user_id:cost_center_id', compositeKeys: ['user_id', 'cost_center_id'] },
  { name: 'rep_payment_submissions',           upsertKey: 'id' },

  // ===== SMS auto rules 1405/05/04 — APPEND-ONLY =====
  { name: 'sms_rules',                         upsertKey: 'id' },
];

// Provisional id-space partitioning. A paired device with device_id D writes
// every new local row of table index i with ids starting at tableBase(D, i).
// Central autoincrement ids stay tiny (< PROVISIONAL_FLOOR), so a pulled
// central row can never collide with a device's own not-yet-synced rows, and
// two devices can never mint the same provisional id.
//
// Legacy layout (indices 0–99): FLOOR + D*DEVICE_SPAN + i*TABLE_SPAN
// (DEVICE_SPAN=1e8 holds 100 table slots of TABLE_SPAN=1e6). Indices ≥100
// overflow into a separate high band so we never collide with device D+1
// table 0 — critical after Update 11 appended tables past index 99.
// DO NOT change FLOOR / DEVICE_SPAN / TABLE_SPAN / LEGACY_TABLE_SLOTS for
// indices 0–99: existing devices already minted ids in that formula.
const PROVISIONAL_FLOOR = 1_000_000_000_000;
const DEVICE_SPAN = 100_000_000;
const TABLE_SPAN = 1_000_000;
const LEGACY_TABLE_SLOTS = 100;
const OVERFLOW_FLOOR = PROVISIONAL_FLOOR + 10_000_000_000; // 1.01e13

function tableBase(deviceId, tableIndex) {
  const d = Number(deviceId) || 0;
  const i = Number(tableIndex) || 0;
  if (i < LEGACY_TABLE_SLOTS) {
    return PROVISIONAL_FLOOR + d * DEVICE_SPAN + i * TABLE_SPAN;
  }
  const overflowIndex = i - LEGACY_TABLE_SLOTS;
  return OVERFLOW_FLOOR + d * DEVICE_SPAN + overflowIndex * TABLE_SPAN;
}

function isProvisionalId(v) {
  return Number.isInteger(v) && v >= PROVISIONAL_FLOOR;
}

// FK columns that may reference a provisional id. When central confirms a
// create and returns the real id, the device re-points these columns in any
// still-local rows (pending ops' rows) from the provisional id to the central
// id. Provisional ids are globally unique across tables (per-table bases), so
// a blind column-wide UPDATE is safe.
const FK_COLUMNS = [
  ['customers', 'group_id'], ['customers', 'user_id'], ['customers', 'assigned_to'],
  ['customers', 'party_id'], ['customers', 'party_group_id'],
  ['orders', 'cust_id'],
  ['followups', 'cust_id'],
  ['invoices', 'cust_id'],
  ['settlements', 'cust_id'], ['settlements', 'invoice_id'], ['settlements', 'bank_id'], ['settlements', 'cash_box_id'],
  ['sales_returns', 'cust_id'], ['sales_returns', 'invoice_id'],
  ['customer_ledger', 'customer_id'],
  ['purchase_invoices', 'supplier_id'], ['purchase_invoices', 'bank_id'], ['purchase_invoices', 'cash_box_id'], ['purchase_invoices', 'check_category_id'],
  ['purchase_returns', 'supplier_id'], ['purchase_returns', 'purchase_invoice_id'],
  ['supplier_payments', 'supplier_id'], ['supplier_payments', 'purchase_invoice_id'], ['supplier_payments', 'bank_id'], ['supplier_payments', 'cash_box_id'],
  ['supplier_ledger', 'supplier_id'],
  ['persons', 'category_id'],
  ['person_ledger', 'person_id'],
  ['payroll_records', 'person_id'],
  ['products', 'warehouse_id'],
  ['stock_logs', 'product_id'],
  ['warehouse_moves', 'product_id'], ['warehouse_moves', 'from_warehouse_id'], ['warehouse_moves', 'to_warehouse_id'],
  ['consignments', 'product_id'],
  ['production_runs', 'product_id'],
  ['expense_payments', 'bank_id'], ['expense_payments', 'cash_box_id'], ['expense_payments', 'cost_center_id'],
  ['account_transfers', 'from_id'], ['account_transfers', 'to_id'],
  ['journal_entries', 'cost_center_id'],
  ['journal_lines', 'entry_id'],
  ['check_categories', 'bank_id'],
  ['rep_expenses', 'rep_id'], ['rep_advances', 'rep_id'], ['rep_ledger', 'rep_id'],
  ['rep_commission_rules', 'rep_id'], ['rep_commission_tiers', 'rep_id'], ['rep_settlements', 'rep_id'],
  ['rep_visit_logs', 'rep_id'], ['rep_visit_logs', 'customer_id'], ['rep_call_logs', 'rep_id'], ['rep_call_logs', 'customer_id'],
  ['rep_assignment_history', 'customer_id'], ['rep_assignment_history', 'from_rep_id'], ['rep_assignment_history', 'to_rep_id'],
  // Production FKs (append-only)
  ['bom_lines', 'bom_id'], ['bom_lines', 'component_product_id'],
  ['bom_operations', 'bom_id'], ['bom_operations', 'cost_center_id'],
  ['bom_outputs', 'bom_id'], ['bom_outputs', 'product_id'],
  ['production_orders', 'product_id'], ['production_orders', 'bom_id'], ['production_orders', 'cost_center_id'],
  ['production_order_stages', 'order_id'], ['production_order_stages', 'cost_center_id'],
  ['production_material_issues', 'order_id'], ['production_material_issues', 'product_id'],
  ['production_labor_entries', 'order_id'],
  ['production_overhead_applications', 'order_id'], ['production_overhead_applications', 'cost_center_id'],
  ['production_waste', 'order_id'],
  ['production_receipts', 'order_id'], ['production_receipts', 'product_id'],
  ['production_subcontract', 'order_id'], ['production_subcontract', 'supplier_id'],
  ['production_estimate_lines', 'estimate_id'],
  ['mrp_requirements', 'run_id'],
  ['production_reservations', 'order_id'],
  // Inventory FKs (append-only)
  ['inventory_ledger', 'product_id'], ['inventory_ledger', 'warehouse_id'],
  ['inventory_cost_layers', 'product_id'], ['inventory_cost_layers', 'warehouse_id'],
  ['inventory_batches', 'product_id'], ['inventory_batches', 'warehouse_id'],
  ['inventory_serials', 'product_id'], ['inventory_serials', 'warehouse_id'], ['inventory_serials', 'batch_id'],
  ['inventory_reservations', 'product_id'], ['inventory_reservations', 'warehouse_id'],
  ['landed_cost_lines', 'doc_id'],
  ['landed_cost_allocations', 'doc_id'], ['landed_cost_allocations', 'product_id'],
  // Payroll/reporting FKs (append-only)
  ['salary_structures', 'person_id'],
  ['payroll_records', 'period_id'],
  ['payroll_year_end_bonuses', 'person_id'],
  ['vat_records', 'journal_line_id'],
  // Update 11 FKs (append-only)
  ['persons', 'position_id'],
  ['pricing_rules', 'scope_id'],
  // Portal FKs (append-only)
  ['op_units', 'manager_person_id'], ['op_units', 'manager2_person_id'], ['op_units', 'manager3_person_id'],
  ['op_unit_warehouses', 'unit_id'], ['op_unit_warehouses', 'warehouse_id'],
  ['op_unit_persons', 'unit_id'], ['op_unit_persons', 'person_id'],
  ['op_departments', 'unit_id'], ['op_departments', 'manager_person_id'], ['op_departments', 'warehouse_id'],
  ['op_parameters', 'unit_id'], ['op_parameters', 'current_department_id'], ['op_parameters', 'destination_warehouse_id'],
  ['op_parameter_items', 'parameter_id'], ['op_parameter_items', 'product_id'],
  ['op_parameter_dept_log', 'parameter_id'], ['op_parameter_dept_log', 'department_id'],
  ['op_parameter_dept_log', 'payment_person_id'], ['op_parameter_dept_log', 'converted_product_id'],
  // Gap accounting FKs (append-only)
  ['bank_reconciliations', 'bank_id'],
  ['bank_reconciliation_items', 'reconciliation_id'],
  ['inventory_nrv_lines', 'provision_id'], ['inventory_nrv_lines', 'product_id'],
  ['budget_lines', 'budget_id'],
  ['payroll_monthly_accruals', 'person_id'],
  // Portal v3 FKs (append-only)
  ['op_dept_delegations', 'department_id'],
  ['op_dept_delegations', 'delegate_person_id'],
  // update.md FKs (append-only)
  ['product_images', 'product_id'],
  ['user_catalog_categories', 'user_id'],
  ['user_catalog_categories', 'category_id'],
  ['sms_options', 'template_id'],
  ['sms_scheduled', 'template_id'],
  ['marketer_carts', 'user_id'],
  // Sync gaps FKs (append-only)
  ['suppliers', 'party_id'], ['suppliers', 'party_group_id'],
  ['parties', 'party_group_id'],
  ['persons', 'party_group_id'],
  ['cheque_records', 'collection_bank_id'],
  ['cheque_records', 'journal_entry_id'],
  // Sync gaps 1405/05/01 FKs (append-only)
  ['fixed_asset_depreciation', 'asset_id'],
  ['user_cost_centers', 'user_id'],
  ['user_cost_centers', 'cost_center_id'],
  ['rep_payment_submissions', 'rep_id'],
  ['rep_payment_submissions', 'cust_id'],
  ['rep_payment_submissions', 'settlement_id'],
  // SMS rules 1405/05/04 (append-only)
  ['sms_rules', 'template_id'],
  ['sms_rules', 'party_group_id'],
  ['sms_rules', 'user_id'],
];

module.exports = { SYNCABLE_TABLES, FK_COLUMNS, PROVISIONAL_FLOOR, DEVICE_SPAN, TABLE_SPAN, LEGACY_TABLE_SLOTS, OVERFLOW_FLOOR, tableBase, isProvisionalId };
