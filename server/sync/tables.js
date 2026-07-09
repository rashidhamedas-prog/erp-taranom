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
  { name: 'rep_advances', upsertKey: 'id' }
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
  ['rep_assignment_history', 'customer_id'], ['rep_assignment_history', 'from_rep_id'], ['rep_assignment_history', 'to_rep_id']
];

module.exports = { SYNCABLE_TABLES, FK_COLUMNS, PROVISIONAL_FLOOR, DEVICE_SPAN, TABLE_SPAN, tableBase, isProvisionalId };
