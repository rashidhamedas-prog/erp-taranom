// Shared sync-table registry — used by BOTH the central server (pull endpoint,
// sync_seq/tombstone triggers) and device builds (provisional id-range seeding,
// pull application). The array order is FK-parents-first and APPEND-ONLY:
// each table's index feeds into the provisional id formula, so reordering or
// removing entries would corrupt existing devices' id ranges.
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
  { name: 'warehouse_stock', upsertKey: 'id' },
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
];

// Provisional id-space partitioning. A paired device with device_id D writes
// every new local row of table index i with ids starting at:
//   PROVISIONAL_FLOOR + D*DEVICE_SPAN + i*TABLE_SPAN
// Central autoincrement ids stay tiny (< PROVISIONAL_FLOOR), so a pulled
// central row can never collide with a device's own not-yet-synced rows, and
// two devices can never mint the same provisional id. TABLE_SPAN of 1e6 gives
// each table a million offline-created rows per device; DEVICE_SPAN of 1e8
// supports the 40 tables with room for future ones (99 slots of 1e6).
const PROVISIONAL_FLOOR = 1_000_000_000_000;
const DEVICE_SPAN = 100_000_000;
const TABLE_SPAN = 1_000_000;

function tableBase(deviceId, tableIndex) {
  return PROVISIONAL_FLOOR + deviceId * DEVICE_SPAN + tableIndex * TABLE_SPAN;
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
];

module.exports = { SYNCABLE_TABLES, FK_COLUMNS, PROVISIONAL_FLOOR, DEVICE_SPAN, TABLE_SPAN, tableBase, isProvisionalId };
