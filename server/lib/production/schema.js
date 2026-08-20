'use strict';
/**
 * Production module P0 — schema, triggers, views, sequences, settings, seed.
 * Called from initSyncSchema() before the second sync-column pass.
 */
const { ensureColumn, tableExists } = (() => {
  // Prefer shared helpers from db.js without circular init issues:
  // this module only receives `db` and uses local ensureColumn.
  return {
    ensureColumn(db, table, column, definition) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all();
      if (!cols.some(c => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    },
    tableExists(db, table) {
      return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    }
  };
})();

const PROD_TABLES = [
  'bom_headers', 'bom_lines', 'bom_operations', 'bom_outputs', 'bom_change_log',
  'cost_center_rates', 'overhead_allocation_rules', 'overhead_allocation_weights',
  'production_orders', 'production_order_stages',
  'production_material_issues', 'production_labor_entries',
  'production_overhead_applications', 'production_waste', 'production_rework',
  'production_receipts', 'production_subcontract', 'production_variances',
  'production_period_close', 'production_estimates', 'production_estimate_lines',
  'mrp_runs', 'mrp_requirements', 'production_reservations',
  'cutting_lays', 'cutting_lay_rolls',
];

const PROD_SEQUENCES = [
  { key: 'production_order', prefix: 'PO' },
  { key: 'material_issue', prefix: 'MI' },
  { key: 'production_receipt', prefix: 'PR' },
  { key: 'labor_entry', prefix: 'LB' },
  { key: 'overhead_apply', prefix: 'OH' },
  { key: 'production_waste', prefix: 'WS' },
  { key: 'production_rework', prefix: 'RW' },
  { key: 'subcontract', prefix: 'SC' },
  { key: 'bom', prefix: 'BOM' },
  { key: 'estimate', prefix: 'EST' },
  { key: 'mrp_run', prefix: 'MRP' },
  { key: 'cutting_lay', prefix: 'LAY' },
];

const PRODUCTION_SETTINGS = {
  production_costing_method: 'moving_average',
  production_variance_method: 'proration',
  production_variance_threshold_pct: '0.5',
  production_normal_waste_default_pct: '3',
  production_auto_post_je: '1',
  production_backflush_on_receipt: '1',
  production_allow_negative_stock: '0',
  production_wh_raw_id: '',
  production_wh_fg_id: '',
  production_wh_sub_id: '',
  production_wh_scrap_id: '',
  production_default_analysis: 'fixed',
  production_cost_deviation_alert_pct: '15',
  production_labor_methods_enabled: 'piece,monthly',
  production_oh_bootstrap_months: '3',
  production_mrp_horizon_days: '30',
  production_period_auto_open: '1',
  production_estimate_price_basis: 'max',
  production_variance_reason_threshold_pct: '5',
  production_coproduct_method: 'share',
  production_margin_percent: '35',
  production_module_enabled: '1',
  production_wh_dist_id: '',
};

const TARANOM_COST_CENTERS = [
  { code: 'CC-10', name: 'برش', seq: 10, is_stage: 1, kind: 'production', driver: 'material_rial', default_labor_method: 'monthly' },
  { code: 'CC-20', name: 'گلدوزی', seq: 20, is_stage: 1, kind: 'production', driver: 'machine_hours', default_labor_method: 'piece' },
  { code: 'CC-30', name: 'دوخت', seq: 30, is_stage: 1, kind: 'production', driver: 'direct_labor_rial', default_labor_method: 'piece' },
  { code: 'CC-40', name: 'دکمه و یراق', seq: 40, is_stage: 1, kind: 'production', driver: 'output_qty', default_labor_method: 'piece' },
  { code: 'CC-50', name: 'شستشو', seq: 50, is_stage: 1, kind: 'production', driver: 'output_qty', default_labor_method: 'contract' },
  { code: 'CC-60', name: 'اتو و بسته‌بندی', seq: 60, is_stage: 1, kind: 'production', driver: 'output_qty', default_labor_method: 'monthly' },
  { code: 'CC-90', name: 'انبار محصول', seq: 90, is_stage: 0, kind: 'service', driver: 'manual', default_labor_method: 'monthly' },
];

const TARANOM_WAREHOUSES = [
  { code: 'WH-RAW', name: 'انبار مواد اولیه — کارگاه نبوت', kind: 'raw' },
  { code: 'WH-FG', name: 'انبار کالای ساخته‌شده — نبوت', kind: 'finished' },
  { code: 'WH-DIST-FG', name: 'انبار دفتر پخش — کیمیا', kind: 'finished' },
  { code: 'WH-SUB', name: 'امانی نزد پیمانکار', kind: 'subcontract' },
  { code: 'WH-SCRAP', name: 'انبار ضایعات', kind: 'scrap' },
];

const PRODUCTION_ACCOUNTS = [
  { code: '1110', name: 'موجودی مواد اولیه', type: 'asset', parent_code: '1100' },
  { code: '1111', name: 'کالای در جریان ساخت', type: 'asset', parent_code: '1100' },
  { code: '1112', name: 'موجودی مواد بسته‌بندی', type: 'asset', parent_code: '1100' },
  { code: '1113', name: 'موجودی ضایعات قابل فروش', type: 'asset', parent_code: '1100' },
  { code: '1114', name: 'موجودی نزد پیمانکار', type: 'asset', parent_code: '1100' },
  { code: '5200', name: 'حساب‌های کنترل تولید', type: 'expense', parent_code: '6000' },
  { code: '5201', name: 'کنترل دستمزد مستقیم', type: 'expense', parent_code: '5200' },
  { code: '5202', name: 'کنترل سربار ساخت', type: 'expense', parent_code: '5200' },
  { code: '5203', name: 'سربار جذب‌شده', type: 'expense', parent_code: '5200' },
  { code: '5210', name: 'انحراف نرخ مواد', type: 'expense', parent_code: '5200' },
  { code: '5211', name: 'انحراف مقدار مواد', type: 'expense', parent_code: '5200' },
  { code: '5212', name: 'انحراف نرخ دستمزد', type: 'expense', parent_code: '5200' },
  { code: '5213', name: 'انحراف کارایی دستمزد', type: 'expense', parent_code: '5200' },
  { code: '5214', name: 'انحراف بودجه سربار', type: 'expense', parent_code: '5200' },
  { code: '5215', name: 'انحراف حجم سربار', type: 'expense', parent_code: '5200' },
  { code: '5221', name: 'هزینه ضایعات غیرعادی', type: 'expense', parent_code: '5200' },
  { code: '5222', name: 'هزینه دوباره‌کاری', type: 'expense', parent_code: '5200' },
  { code: '5230', name: 'کارمزد ساخت پیمانکاری', type: 'expense', parent_code: '5200' },
];

function ensureExistingColumns(db) {
  ensureColumn(db, 'products', 'item_type', "TEXT DEFAULT 'finished'");
  ensureColumn(db, 'products', 'is_manufactured', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'products', 'default_bom_id', 'INTEGER');
  ensureColumn(db, 'products', 'default_warehouse_id', 'INTEGER');
  ensureColumn(db, 'products', 'std_cost_rial', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'products', 'last_prod_cost_rial', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'products', 'lead_time_days', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'products', 'min_order_qty', 'REAL DEFAULT 0');
  ensureColumn(db, 'products', 'safety_stock', 'REAL DEFAULT 0');
  ensureColumn(db, 'products', 'scrap_percent', 'REAL DEFAULT 0');

  ensureColumn(db, 'cost_centers', 'kind', "TEXT DEFAULT 'production'");
  ensureColumn(db, 'cost_centers', 'driver', "TEXT DEFAULT 'output_qty'");
  ensureColumn(db, 'cost_centers', 'seq', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'cost_centers', 'is_stage', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'cost_centers', 'capacity_per_day', 'REAL DEFAULT 0');
  ensureColumn(db, 'cost_centers', 'default_labor_method', "TEXT DEFAULT 'piece'");
  ensureColumn(db, 'cost_centers', 'parent_id', 'INTEGER');
  ensureColumn(db, 'cost_centers', 'coa_tafsili_oh', 'TEXT');
  ensureColumn(db, 'cost_centers', 'coa_tafsili_lb', 'TEXT');

  ensureColumn(db, 'warehouses', 'kind', "TEXT DEFAULT 'general'");
  ensureColumn(db, 'expense_payments', 'overhead_type', "TEXT DEFAULT 'variable'");

  if (tableExists(db, 'production_runs')) {
    ensureColumn(db, 'production_runs', 'migrated_to_order_id', 'INTEGER');
    ensureColumn(db, 'production_runs', 'legacy', 'INTEGER DEFAULT 1');
  }
  if (tableExists(db, 'persons')) {
    ensureColumn(db, 'persons', 'cost_center_id', 'INTEGER');
    ensureColumn(db, 'persons', 'labor_method', "TEXT DEFAULT 'piece'");
  }
  if (tableExists(db, 'payroll_records')) {
    ensureColumn(db, 'payroll_records', 'production_linked', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'payroll_records', 'cost_center_id', 'INTEGER');
  }
  if (tableExists(db, 'production_material_issues')) {
    ensureColumn(db, 'production_material_issues', 'variance_status', "TEXT DEFAULT 'memo'");
  }
  if (tableExists(db, 'cost_center_rates')) {
    ensureColumn(db, 'cost_center_rates', 'monthly_labor_rate_rial', 'INTEGER DEFAULT 0');
  }
  if (tableExists(db, 'cutting_lays')) {
    try {
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_cutting_lays_idem ON cutting_lays(idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key <> ''");
    } catch (_) { /* ignore */ }
  }
}

function createTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bom_headers (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      code              TEXT NOT NULL,
      product_id        INTEGER NOT NULL,
      version           INTEGER NOT NULL DEFAULT 1,
      revision          TEXT DEFAULT '',
      name              TEXT DEFAULT '',
      bom_type          TEXT DEFAULT 'standard',
      alt_of_bom_id     INTEGER,
      alt_reason        TEXT DEFAULT '',
      base_qty          REAL NOT NULL DEFAULT 1,
      unit_id           INTEGER,
      status            TEXT DEFAULT 'draft',
      valid_from        TEXT DEFAULT '',
      valid_to          TEXT DEFAULT '',
      is_default        INTEGER DEFAULT 0,
      is_multilevel     INTEGER DEFAULT 0,
      has_routing       INTEGER DEFAULT 0,
      has_coproducts    INTEGER DEFAULT 0,
      yield_percent     REAL DEFAULT 100,
      size_range        TEXT DEFAULT '',
      color_variant     TEXT DEFAULT '',
      note              TEXT DEFAULT '',
      approved_by       INTEGER,
      approved_at       INTEGER,
      created_by        INTEGER,
      created_at        INTEGER DEFAULT (strftime('%s','now')),
      updated_at        INTEGER DEFAULT (strftime('%s','now')),
      deleted_at        INTEGER,
      FOREIGN KEY(product_id) REFERENCES products(id),
      FOREIGN KEY(alt_of_bom_id) REFERENCES bom_headers(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_bom_code ON bom_headers(code);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_bom_prod_ver ON bom_headers(product_id, version, revision);
    CREATE INDEX IF NOT EXISTS ix_bom_product_status ON bom_headers(product_id, status, valid_from, valid_to);

    CREATE TABLE IF NOT EXISTS bom_lines (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      bom_id                INTEGER NOT NULL,
      line_no               INTEGER NOT NULL DEFAULT 1,
      component_product_id  INTEGER NOT NULL,
      qty_per_base          REAL NOT NULL,
      unit_id               INTEGER,
      scrap_percent         REAL DEFAULT 0,
      fixed_qty             REAL DEFAULT 0,
      line_type             TEXT DEFAULT 'material',
      stage_cost_center_id  INTEGER,
      backflush             INTEGER DEFAULT 1,
      is_optional           INTEGER DEFAULT 0,
      substitute_group      TEXT DEFAULT '',
      substitute_priority   INTEGER DEFAULT 0,
      size_matrix           TEXT DEFAULT '',
      std_cost_rial         INTEGER DEFAULT 0,
      note                  TEXT DEFAULT '',
      created_at            INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(bom_id) REFERENCES bom_headers(id) ON DELETE CASCADE,
      FOREIGN KEY(component_product_id) REFERENCES products(id),
      FOREIGN KEY(stage_cost_center_id) REFERENCES cost_centers(id)
    );
    CREATE INDEX IF NOT EXISTS ix_bomline_bom  ON bom_lines(bom_id, line_no);
    CREATE INDEX IF NOT EXISTS ix_bomline_comp ON bom_lines(component_product_id);

    CREATE TABLE IF NOT EXISTS bom_operations (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      bom_id               INTEGER NOT NULL,
      seq                  INTEGER NOT NULL,
      cost_center_id       INTEGER NOT NULL,
      operation_name       TEXT DEFAULT '',
      setup_minutes        REAL DEFAULT 0,
      run_minutes_per_unit REAL DEFAULT 0,
      machine_minutes_per_unit REAL DEFAULT 0,
      labor_method         TEXT DEFAULT 'piece',
      labor_rate_rial      INTEGER DEFAULT 0,
      crew_size            REAL DEFAULT 1,
      overhead_driver      TEXT DEFAULT '',
      yield_percent        REAL DEFAULT 100,
      normal_waste_percent REAL DEFAULT 0,
      is_subcontract       INTEGER DEFAULT 0,
      subcontract_supplier_id INTEGER,
      subcontract_fee_rial INTEGER DEFAULT 0,
      is_qc_gate           INTEGER DEFAULT 0,
      note                 TEXT DEFAULT '',
      created_at           INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(bom_id) REFERENCES bom_headers(id) ON DELETE CASCADE,
      FOREIGN KEY(cost_center_id) REFERENCES cost_centers(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_bomop ON bom_operations(bom_id, seq);

    CREATE TABLE IF NOT EXISTS bom_outputs (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      bom_id             INTEGER NOT NULL,
      product_id         INTEGER NOT NULL,
      output_type        TEXT NOT NULL DEFAULT 'main',
      qty_per_base       REAL NOT NULL DEFAULT 1,
      unit_id            INTEGER,
      cost_method        TEXT DEFAULT 'share',
      cost_share_percent REAL DEFAULT 0,
      nrv_rial           INTEGER DEFAULT 0,
      warehouse_id       INTEGER,
      stage_cost_center_id INTEGER,
      note               TEXT DEFAULT '',
      created_at         INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(bom_id) REFERENCES bom_headers(id) ON DELETE CASCADE,
      FOREIGN KEY(product_id) REFERENCES products(id)
    );
    CREATE INDEX IF NOT EXISTS ix_bomout ON bom_outputs(bom_id, output_type);

    CREATE TABLE IF NOT EXISTS bom_change_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      bom_id       INTEGER NOT NULL,
      change_type  TEXT NOT NULL,
      entity       TEXT DEFAULT '',
      entity_id    INTEGER,
      before_json  TEXT DEFAULT '',
      after_json   TEXT DEFAULT '',
      reason       TEXT DEFAULT '',
      date         TEXT DEFAULT '',
      created_by   INTEGER,
      created_at   INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(bom_id) REFERENCES bom_headers(id)
    );
    CREATE INDEX IF NOT EXISTS ix_bomlog ON bom_change_log(bom_id, created_at);

    CREATE TABLE IF NOT EXISTS cost_center_rates (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      cost_center_id         INTEGER NOT NULL,
      period_label           TEXT NOT NULL,
      period_type            TEXT DEFAULT 'month',
      driver                 TEXT NOT NULL,
      budget_fixed_oh_rial   INTEGER DEFAULT 0,
      budget_var_oh_rial     INTEGER DEFAULT 0,
      budget_driver_qty      REAL DEFAULT 0,
      fixed_rate_rial        INTEGER DEFAULT 0,
      var_rate_rial          INTEGER DEFAULT 0,
      total_rate_rial        INTEGER DEFAULT 0,
      actual_oh_rial         INTEGER DEFAULT 0,
      actual_driver_qty      REAL DEFAULT 0,
      applied_oh_rial        INTEGER DEFAULT 0,
      variance_rial          INTEGER DEFAULT 0,
      status                 TEXT DEFAULT 'draft',
      is_estimated           INTEGER DEFAULT 0,
      note                   TEXT DEFAULT '',
      created_by             INTEGER,
      created_at             INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(cost_center_id) REFERENCES cost_centers(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_ccrate ON cost_center_rates(cost_center_id, period_label);

    CREATE TABLE IF NOT EXISTS overhead_allocation_rules (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      expense_match  TEXT DEFAULT '',
      basis          TEXT NOT NULL,
      active         INTEGER DEFAULT 1,
      created_at     INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS overhead_allocation_weights (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id        INTEGER NOT NULL,
      cost_center_id INTEGER NOT NULL,
      weight         REAL NOT NULL DEFAULT 0,
      FOREIGN KEY(rule_id) REFERENCES overhead_allocation_rules(id) ON DELETE CASCADE,
      FOREIGN KEY(cost_center_id) REFERENCES cost_centers(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_ohw ON overhead_allocation_weights(rule_id, cost_center_id);

    CREATE TABLE IF NOT EXISTS production_orders (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no           TEXT NOT NULL,
      product_id         INTEGER NOT NULL,
      bom_id             INTEGER,
      bom_version        INTEGER,
      analysis_type      TEXT NOT NULL DEFAULT 'fixed',
      production_mode    TEXT NOT NULL DEFAULT 'MTS',
      sales_order_id     INTEGER,
      b2b_order_id       INTEGER,
      customer_id        INTEGER,
      qty_planned        REAL NOT NULL,
      qty_produced       REAL DEFAULT 0,
      qty_waste_normal   REAL DEFAULT 0,
      qty_waste_abnormal REAL DEFAULT 0,
      qty_scrap_salable  REAL DEFAULT 0,
      qty_rework         REAL DEFAULT 0,
      size_breakdown     TEXT DEFAULT '',
      color              TEXT DEFAULT '',
      warehouse_raw_id   INTEGER,
      warehouse_fg_id    INTEGER,
      cost_center_id     INTEGER,
      coa_wip_tafsili    TEXT,
      status             TEXT DEFAULT 'draft',
      priority           INTEGER DEFAULT 5,
      planned_start      TEXT DEFAULT '',
      planned_end        TEXT DEFAULT '',
      actual_start       TEXT DEFAULT '',
      actual_end         TEXT DEFAULT '',
      date               TEXT NOT NULL,
      period_label       TEXT DEFAULT '',
      fiscal_year_id     INTEGER,
      material_cost_rial     INTEGER DEFAULT 0,
      packaging_cost_rial    INTEGER DEFAULT 0,
      labor_cost_rial        INTEGER DEFAULT 0,
      overhead_cost_rial     INTEGER DEFAULT 0,
      subcontract_cost_rial  INTEGER DEFAULT 0,
      rework_cost_rial       INTEGER DEFAULT 0,
      abnormal_waste_rial    INTEGER DEFAULT 0,
      scrap_credit_rial      INTEGER DEFAULT 0,
      byproduct_credit_rial  INTEGER DEFAULT 0,
      total_cost_rial        INTEGER DEFAULT 0,
      unit_cost_rial         INTEGER DEFAULT 0,
      variance_applied_rial  INTEGER DEFAULT 0,
      std_material_rial      INTEGER DEFAULT 0,
      std_labor_rial         INTEGER DEFAULT 0,
      std_overhead_rial      INTEGER DEFAULT 0,
      std_total_rial         INTEGER DEFAULT 0,
      std_unit_rial          INTEGER DEFAULT 0,
      estimate_id        INTEGER,
      note               TEXT DEFAULT '',
      closed_by          INTEGER,
      closed_at          INTEGER,
      cancelled_reason   TEXT DEFAULT '',
      created_by         INTEGER,
      created_at         INTEGER DEFAULT (strftime('%s','now')),
      updated_at         INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(product_id) REFERENCES products(id),
      FOREIGN KEY(bom_id) REFERENCES bom_headers(id),
      FOREIGN KEY(cost_center_id) REFERENCES cost_centers(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_po_no ON production_orders(order_no);
    CREATE INDEX IF NOT EXISTS ix_po_status ON production_orders(status, date);
    CREATE INDEX IF NOT EXISTS ix_po_prod   ON production_orders(product_id, date);
    CREATE INDEX IF NOT EXISTS ix_po_period ON production_orders(period_label, status);
    CREATE INDEX IF NOT EXISTS ix_po_so     ON production_orders(sales_order_id);

    CREATE TABLE IF NOT EXISTS production_order_stages (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id           INTEGER NOT NULL,
      seq                INTEGER NOT NULL,
      cost_center_id     INTEGER NOT NULL,
      operation_id       INTEGER,
      operation_name     TEXT DEFAULT '',
      status             TEXT DEFAULT 'pending',
      qty_in             REAL DEFAULT 0,
      qty_out            REAL DEFAULT 0,
      qty_waste_normal   REAL DEFAULT 0,
      qty_waste_abnormal REAL DEFAULT 0,
      qty_rework         REAL DEFAULT 0,
      qty_scrap_salable  REAL DEFAULT 0,
      labor_hours        REAL DEFAULT 0,
      machine_hours      REAL DEFAULT 0,
      driver             TEXT DEFAULT '',
      driver_qty         REAL DEFAULT 0,
      material_in_rial      INTEGER DEFAULT 0,
      material_added_rial   INTEGER DEFAULT 0,
      labor_rial            INTEGER DEFAULT 0,
      overhead_rial         INTEGER DEFAULT 0,
      subcontract_rial      INTEGER DEFAULT 0,
      waste_abnormal_rial   INTEGER DEFAULT 0,
      scrap_credit_rial     INTEGER DEFAULT 0,
      cost_out_rial         INTEGER DEFAULT 0,
      unit_cost_out_rial    INTEGER DEFAULT 0,
      is_subcontract     INTEGER DEFAULT 0,
      supplier_id        INTEGER,
      started_at         TEXT DEFAULT '',
      ended_at           TEXT DEFAULT '',
      qc_passed          INTEGER,
      qc_note            TEXT DEFAULT '',
      note               TEXT DEFAULT '',
      created_by         INTEGER,
      created_at         INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(order_id) REFERENCES production_orders(id) ON DELETE CASCADE,
      FOREIGN KEY(cost_center_id) REFERENCES cost_centers(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_pos ON production_order_stages(order_id, seq);
    CREATE INDEX IF NOT EXISTS ix_pos_status ON production_order_stages(status, cost_center_id);

    CREATE TABLE IF NOT EXISTS production_material_issues (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_no           TEXT DEFAULT '',
      order_id         INTEGER NOT NULL,
      stage_id         INTEGER,
      cost_center_id   INTEGER,
      product_id       INTEGER NOT NULL,
      bom_line_id      INTEGER,
      issue_type       TEXT DEFAULT 'issue',
      qty_standard     REAL DEFAULT 0,
      qty_actual       REAL NOT NULL,
      qty_variance     REAL DEFAULT 0,
      unit_cost_rial   INTEGER NOT NULL,
      std_cost_rial    INTEGER DEFAULT 0,
      amount_rial      INTEGER NOT NULL,
      std_amount_rial  INTEGER DEFAULT 0,
      var_price_rial   INTEGER DEFAULT 0,
      var_qty_rial     INTEGER DEFAULT 0,
      warehouse_id     INTEGER NOT NULL,
      substitute_of_product_id INTEGER,
      date             TEXT NOT NULL,
      period_label     TEXT DEFAULT '',
      je_id            INTEGER,
      reversed_je_id   INTEGER,
      status           TEXT DEFAULT 'posted',
      note             TEXT DEFAULT '',
      created_by       INTEGER,
      created_at       INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(order_id) REFERENCES production_orders(id),
      FOREIGN KEY(product_id) REFERENCES products(id)
    );
    CREATE INDEX IF NOT EXISTS ix_mi_order ON production_material_issues(order_id, date);
    CREATE INDEX IF NOT EXISTS ix_mi_prod  ON production_material_issues(product_id, date);
    CREATE INDEX IF NOT EXISTS ix_mi_je    ON production_material_issues(je_id);

    CREATE TABLE IF NOT EXISTS production_labor_entries (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_no           TEXT DEFAULT '',
      order_id         INTEGER NOT NULL,
      stage_id         INTEGER,
      cost_center_id   INTEGER NOT NULL,
      person_id        INTEGER,
      payroll_record_id INTEGER,
      supplier_id      INTEGER,
      method           TEXT NOT NULL DEFAULT 'piece',
      qty              REAL DEFAULT 0,
      hours            REAL DEFAULT 0,
      std_hours        REAL DEFAULT 0,
      rate_rial        INTEGER DEFAULT 0,
      std_rate_rial    INTEGER DEFAULT 0,
      amount_rial      INTEGER NOT NULL,
      std_amount_rial  INTEGER DEFAULT 0,
      var_rate_rial    INTEGER DEFAULT 0,
      var_eff_rial     INTEGER DEFAULT 0,
      date             TEXT NOT NULL,
      period_label     TEXT DEFAULT '',
      je_id            INTEGER,
      reversed_je_id   INTEGER,
      status           TEXT DEFAULT 'posted',
      note             TEXT DEFAULT '',
      created_by       INTEGER,
      created_at       INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(order_id) REFERENCES production_orders(id)
    );
    CREATE INDEX IF NOT EXISTS ix_lab_order  ON production_labor_entries(order_id, date);
    CREATE INDEX IF NOT EXISTS ix_lab_person ON production_labor_entries(person_id, period_label);
    CREATE INDEX IF NOT EXISTS ix_lab_cc     ON production_labor_entries(cost_center_id, period_label);

    CREATE TABLE IF NOT EXISTS production_overhead_applications (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_no           TEXT DEFAULT '',
      order_id         INTEGER NOT NULL,
      stage_id         INTEGER,
      cost_center_id   INTEGER NOT NULL,
      rate_id          INTEGER,
      driver           TEXT NOT NULL,
      driver_qty       REAL NOT NULL,
      fixed_rate_rial  INTEGER DEFAULT 0,
      var_rate_rial    INTEGER DEFAULT 0,
      rate_rial        INTEGER NOT NULL,
      amount_rial      INTEGER NOT NULL,
      date             TEXT NOT NULL,
      period_label     TEXT DEFAULT '',
      je_id            INTEGER,
      reversed_je_id   INTEGER,
      status           TEXT DEFAULT 'posted',
      note             TEXT DEFAULT '',
      created_by       INTEGER,
      created_at       INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(order_id) REFERENCES production_orders(id),
      FOREIGN KEY(cost_center_id) REFERENCES cost_centers(id)
    );
    CREATE INDEX IF NOT EXISTS ix_oh_order ON production_overhead_applications(order_id);
    CREATE INDEX IF NOT EXISTS ix_oh_cc    ON production_overhead_applications(cost_center_id, period_label);

    CREATE TABLE IF NOT EXISTS production_waste (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_no           TEXT DEFAULT '',
      order_id         INTEGER NOT NULL,
      stage_id         INTEGER,
      cost_center_id   INTEGER,
      product_id       INTEGER,
      scrap_product_id INTEGER,
      waste_type       TEXT NOT NULL,
      qty              REAL NOT NULL,
      allowed_qty      REAL DEFAULT 0,
      unit_cost_rial   INTEGER DEFAULT 0,
      amount_rial      INTEGER DEFAULT 0,
      nrv_unit_rial    INTEGER DEFAULT 0,
      nrv_amount_rial  INTEGER DEFAULT 0,
      warehouse_id     INTEGER,
      reason_code      TEXT DEFAULT '',
      reason_note      TEXT DEFAULT '',
      responsible_person_id INTEGER,
      date             TEXT NOT NULL,
      period_label     TEXT DEFAULT '',
      je_id            INTEGER,
      reversed_je_id   INTEGER,
      status           TEXT DEFAULT 'posted',
      created_by       INTEGER,
      created_at       INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(order_id) REFERENCES production_orders(id)
    );
    CREATE INDEX IF NOT EXISTS ix_waste_order ON production_waste(order_id, waste_type);
    CREATE INDEX IF NOT EXISTS ix_waste_cc    ON production_waste(cost_center_id, period_label);

    CREATE TABLE IF NOT EXISTS production_rework (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_no           TEXT DEFAULT '',
      order_id         INTEGER NOT NULL,
      origin_stage_id  INTEGER,
      rework_stage_id  INTEGER,
      qty              REAL NOT NULL,
      classification   TEXT DEFAULT 'normal',
      material_rial    INTEGER DEFAULT 0,
      labor_rial       INTEGER DEFAULT 0,
      overhead_rial    INTEGER DEFAULT 0,
      total_rial       INTEGER DEFAULT 0,
      qty_recovered    REAL DEFAULT 0,
      qty_failed       REAL DEFAULT 0,
      reason_code      TEXT DEFAULT '',
      date             TEXT NOT NULL,
      period_label     TEXT DEFAULT '',
      je_id            INTEGER,
      status           TEXT DEFAULT 'posted',
      note             TEXT DEFAULT '',
      created_by       INTEGER,
      created_at       INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(order_id) REFERENCES production_orders(id)
    );

    CREATE TABLE IF NOT EXISTS production_receipts (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_no           TEXT DEFAULT '',
      order_id         INTEGER NOT NULL,
      stage_id         INTEGER,
      product_id       INTEGER NOT NULL,
      output_type      TEXT DEFAULT 'main',
      qty              REAL NOT NULL,
      unit_cost_rial   INTEGER NOT NULL,
      amount_rial      INTEGER NOT NULL,
      cost_method      TEXT DEFAULT 'share',
      warehouse_id     INTEGER NOT NULL,
      size_breakdown   TEXT DEFAULT '',
      is_partial       INTEGER DEFAULT 0,
      prev_avg_rial    INTEGER DEFAULT 0,
      prev_stock_qty   REAL DEFAULT 0,
      new_avg_rial     INTEGER DEFAULT 0,
      date             TEXT NOT NULL,
      period_label     TEXT DEFAULT '',
      je_id            INTEGER,
      reversed_je_id   INTEGER,
      status           TEXT DEFAULT 'posted',
      note             TEXT DEFAULT '',
      created_by       INTEGER,
      created_at       INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(order_id) REFERENCES production_orders(id),
      FOREIGN KEY(product_id) REFERENCES products(id)
    );
    CREATE INDEX IF NOT EXISTS ix_pr_order ON production_receipts(order_id);
    CREATE INDEX IF NOT EXISTS ix_pr_prod  ON production_receipts(product_id, date);

    CREATE TABLE IF NOT EXISTS production_subcontract (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_no            TEXT DEFAULT '',
      order_id          INTEGER NOT NULL,
      stage_id          INTEGER,
      supplier_id       INTEGER NOT NULL,
      direction         TEXT NOT NULL,
      product_id        INTEGER NOT NULL,
      qty               REAL NOT NULL,
      unit_cost_rial    INTEGER DEFAULT 0,
      amount_rial       INTEGER DEFAULT 0,
      fee_unit_rial     INTEGER DEFAULT 0,
      fee_amount_rial   INTEGER DEFAULT 0,
      vat_rial          INTEGER DEFAULT 0,
      qty_returned      REAL DEFAULT 0,
      qty_lost          REAL DEFAULT 0,
      warehouse_id      INTEGER,
      purchase_invoice_id INTEGER,
      date              TEXT NOT NULL,
      period_label      TEXT DEFAULT '',
      je_id             INTEGER,
      status            TEXT DEFAULT 'posted',
      note              TEXT DEFAULT '',
      created_by        INTEGER,
      created_at        INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(order_id) REFERENCES production_orders(id),
      FOREIGN KEY(supplier_id) REFERENCES suppliers(id)
    );
    CREATE INDEX IF NOT EXISTS ix_sub_order ON production_subcontract(order_id, direction);

    CREATE TABLE IF NOT EXISTS production_variances (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      period_label    TEXT NOT NULL,
      order_id        INTEGER,
      cost_center_id  INTEGER,
      stage_id        INTEGER,
      product_id      INTEGER,
      variance_type   TEXT NOT NULL,
      amount_rial     INTEGER NOT NULL,
      favorable       INTEGER DEFAULT 0,
      basis_json      TEXT DEFAULT '',
      allocation_json TEXT DEFAULT '',
      alloc_wip_rial  INTEGER DEFAULT 0,
      alloc_fg_rial   INTEGER DEFAULT 0,
      alloc_cogs_rial INTEGER DEFAULT 0,
      je_id           INTEGER,
      close_id        INTEGER,
      status          TEXT DEFAULT 'open',
      created_at      INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(order_id) REFERENCES production_orders(id)
    );
    CREATE INDEX IF NOT EXISTS ix_var_period ON production_variances(period_label, variance_type);

    CREATE TABLE IF NOT EXISTS production_period_close (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      period_label          TEXT NOT NULL,
      fiscal_year_id        INTEGER,
      start_date            TEXT NOT NULL,
      end_date              TEXT NOT NULL,
      status                TEXT DEFAULT 'open',
      total_material_rial   INTEGER DEFAULT 0,
      total_labor_rial      INTEGER DEFAULT 0,
      total_oh_actual_rial  INTEGER DEFAULT 0,
      total_oh_applied_rial INTEGER DEFAULT 0,
      total_produced_rial   INTEGER DEFAULT 0,
      wip_open_rial         INTEGER DEFAULT 0,
      wip_close_rial        INTEGER DEFAULT 0,
      fg_close_rial         INTEGER DEFAULT 0,
      cogs_rial             INTEGER DEFAULT 0,
      total_variance_rial   INTEGER DEFAULT 0,
      variance_to_wip_rial  INTEGER DEFAULT 0,
      variance_to_fg_rial   INTEGER DEFAULT 0,
      variance_to_cogs_rial INTEGER DEFAULT 0,
      method                TEXT DEFAULT 'proration',
      threshold_pct         REAL DEFAULT 0.5,
      je_id                 INTEGER,
      reversed_je_id        INTEGER,
      checklist_json        TEXT DEFAULT '',
      closed_by             INTEGER,
      closed_at             INTEGER,
      reopened_by           INTEGER,
      reopened_at           INTEGER,
      reopen_reason         TEXT DEFAULT '',
      note                  TEXT DEFAULT '',
      created_at            INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_ppc ON production_period_close(period_label);

    CREATE TABLE IF NOT EXISTS production_estimates (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      code                TEXT NOT NULL,
      title               TEXT DEFAULT '',
      estimate_type       TEXT DEFAULT 'both',
      product_id          INTEGER,
      bom_id              INTEGER,
      qty                 REAL NOT NULL DEFAULT 1,
      size_breakdown      TEXT DEFAULT '',
      customer_id         INTEGER,
      sales_order_id      INTEGER,
      price_basis         TEXT DEFAULT 'average',
      est_material_rial   INTEGER DEFAULT 0,
      est_packaging_rial  INTEGER DEFAULT 0,
      est_labor_rial      INTEGER DEFAULT 0,
      est_overhead_rial   INTEGER DEFAULT 0,
      est_subcontract_rial INTEGER DEFAULT 0,
      est_waste_rial      INTEGER DEFAULT 0,
      est_total_rial      INTEGER DEFAULT 0,
      est_unit_rial       INTEGER DEFAULT 0,
      margin_percent      REAL DEFAULT 35,
      suggested_price_rial INTEGER DEFAULT 0,
      actual_unit_rial    INTEGER DEFAULT 0,
      accuracy_percent    REAL DEFAULT 0,
      mrp_shortage_count  INTEGER DEFAULT 0,
      mrp_feasible        INTEGER DEFAULT 1,
      mrp_earliest_date   TEXT DEFAULT '',
      valid_until         TEXT DEFAULT '',
      status              TEXT DEFAULT 'draft',
      converted_order_id  INTEGER,
      date                TEXT NOT NULL,
      note                TEXT DEFAULT '',
      created_by          INTEGER,
      created_at          INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(product_id) REFERENCES products(id),
      FOREIGN KEY(bom_id) REFERENCES bom_headers(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_est_code ON production_estimates(code);

    CREATE TABLE IF NOT EXISTS production_estimate_lines (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      estimate_id        INTEGER NOT NULL,
      level              INTEGER DEFAULT 0,
      parent_line_id     INTEGER,
      product_id         INTEGER,
      cost_center_id     INTEGER,
      line_kind          TEXT NOT NULL,
      qty_gross          REAL DEFAULT 0,
      qty_net            REAL DEFAULT 0,
      unit_id            INTEGER,
      unit_cost_rial     INTEGER DEFAULT 0,
      amount_rial        INTEGER DEFAULT 0,
      price_source       TEXT DEFAULT '',
      on_hand_qty        REAL DEFAULT 0,
      reserved_qty       REAL DEFAULT 0,
      on_order_qty       REAL DEFAULT 0,
      available_qty      REAL DEFAULT 0,
      shortage_qty       REAL DEFAULT 0,
      lead_time_days     INTEGER DEFAULT 0,
      need_by_date       TEXT DEFAULT '',
      suggested_action   TEXT DEFAULT '',
      created_at         INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(estimate_id) REFERENCES production_estimates(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS ix_estline ON production_estimate_lines(estimate_id, line_kind);

    CREATE TABLE IF NOT EXISTS mrp_runs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      code             TEXT NOT NULL,
      run_type         TEXT DEFAULT 'net',
      horizon_days     INTEGER DEFAULT 30,
      demand_source    TEXT DEFAULT 'orders',
      include_safety   INTEGER DEFAULT 1,
      include_on_order INTEGER DEFAULT 1,
      status           TEXT DEFAULT 'running',
      total_shortage_items INTEGER DEFAULT 0,
      total_shortage_rial  INTEGER DEFAULT 0,
      date             TEXT NOT NULL,
      duration_ms      INTEGER DEFAULT 0,
      error            TEXT DEFAULT '',
      created_by       INTEGER,
      created_at       INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS mrp_requirements (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id           INTEGER NOT NULL,
      product_id       INTEGER NOT NULL,
      level            INTEGER DEFAULT 0,
      gross_req_qty    REAL DEFAULT 0,
      on_hand_qty      REAL DEFAULT 0,
      reserved_qty     REAL DEFAULT 0,
      on_order_qty     REAL DEFAULT 0,
      safety_stock     REAL DEFAULT 0,
      net_req_qty      REAL DEFAULT 0,
      suggested_qty    REAL DEFAULT 0,
      action           TEXT DEFAULT '',
      need_by_date     TEXT DEFAULT '',
      order_by_date    TEXT DEFAULT '',
      est_cost_rial    INTEGER DEFAULT 0,
      supplier_id      INTEGER,
      converted_ref    TEXT DEFAULT '',
      created_at       INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(run_id) REFERENCES mrp_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS ix_mrpreq ON mrp_requirements(run_id, action);

    CREATE TABLE IF NOT EXISTS production_reservations (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id       INTEGER NOT NULL,
      product_id     INTEGER NOT NULL,
      warehouse_id   INTEGER NOT NULL,
      qty            REAL NOT NULL,
      qty_consumed   REAL DEFAULT 0,
      status         TEXT DEFAULT 'active',
      date           TEXT DEFAULT '',
      created_at     INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(order_id) REFERENCES production_orders(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS ix_resv ON production_reservations(product_id, warehouse_id, status);

    CREATE TABLE IF NOT EXISTS cutting_lays (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      lay_no               TEXT NOT NULL UNIQUE,
      product_id           INTEGER NOT NULL,
      bom_id               INTEGER,
      warehouse_id         INTEGER,
      fabric_product_id    INTEGER,
      color                TEXT DEFAULT '',
      marker_length_m      REAL NOT NULL DEFAULT 0,
      ply_count            INTEGER NOT NULL DEFAULT 0,
      width_cm             INTEGER DEFAULT 0,
      planned_meters       REAL DEFAULT 0,
      actual_meters        REAL DEFAULT 0,
      matrix_meters        REAL DEFAULT 0,
      size_breakdown       TEXT DEFAULT '',
      size_matrix          TEXT DEFAULT '',
      qty_pieces           INTEGER DEFAULT 0,
      waste_normal_m       REAL DEFAULT 0,
      waste_abnormal_m     REAL DEFAULT 0,
      waste_allowed_m      REAL DEFAULT 0,
      unit_cost_rial       INTEGER DEFAULT 0,
      amount_rial          INTEGER DEFAULT 0,
      waste_amount_rial    INTEGER DEFAULT 0,
      journal_id           INTEGER,
      waste_journal_id     INTEGER,
      status               TEXT NOT NULL DEFAULT 'posted',
      idempotency_key      TEXT,
      date                 TEXT NOT NULL DEFAULT '',
      note                 TEXT DEFAULT '',
      created_by           INTEGER,
      created_at           INTEGER DEFAULT (strftime('%s','now')),
      reversed_at          INTEGER,
      reversed_by          INTEGER,
      reversal_journal_id  INTEGER
    );
    CREATE INDEX IF NOT EXISTS ix_cutting_lays_prod ON cutting_lays(product_id, status, id);
    CREATE INDEX IF NOT EXISTS ix_cutting_lays_date ON cutting_lays(date, id);

    CREATE TABLE IF NOT EXISTS cutting_lay_rolls (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      lay_id        INTEGER NOT NULL,
      batch_id      INTEGER NOT NULL,
      meters        REAL NOT NULL,
      unit_cost_rial INTEGER DEFAULT 0,
      amount_rial   INTEGER DEFAULT 0,
      ledger_id     INTEGER,
      status        TEXT NOT NULL DEFAULT 'posted',
      FOREIGN KEY(lay_id) REFERENCES cutting_lays(id)
    );
    CREATE INDEX IF NOT EXISTS ix_cutting_lay_rolls ON cutting_lay_rolls(lay_id, batch_id);

    CREATE TABLE IF NOT EXISTS production_idempotency (
      key          TEXT PRIMARY KEY,
      endpoint     TEXT NOT NULL,
      user_id      INTEGER,
      response_json TEXT DEFAULT '',
      created_at   INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS production_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type   TEXT NOT NULL,
      entity_type  TEXT NOT NULL,
      entity_id    INTEGER,
      payload_json TEXT DEFAULT '',
      processed    INTEGER DEFAULT 0,
      created_at   INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS ix_pevt ON production_events(processed, created_at);

    CREATE TABLE IF NOT EXISTS user_cost_centers (
      user_id        INTEGER NOT NULL,
      cost_center_id INTEGER NOT NULL,
      can_view       INTEGER DEFAULT 1,
      can_post       INTEGER DEFAULT 1,
      created_at     INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (user_id, cost_center_id),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(cost_center_id) REFERENCES cost_centers(id)
    );
    CREATE INDEX IF NOT EXISTS ix_ucc_user ON user_cost_centers(user_id);
  `);

  // Report indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_rpt_po_period ON production_orders(period_label, status, product_id);
    CREATE INDEX IF NOT EXISTS ix_rpt_pr_period ON production_receipts(period_label, product_id, date);
    CREATE INDEX IF NOT EXISTS ix_rpt_mi_period ON production_material_issues(period_label, product_id, cost_center_id);
    CREATE INDEX IF NOT EXISTS ix_rpt_ws_period ON production_waste(period_label, waste_type, cost_center_id);
    CREATE INDEX IF NOT EXISTS ix_rpt_pos_cc ON production_order_stages(cost_center_id, status, ended_at);
    CREATE INDEX IF NOT EXISTS ix_rpt_jl_acct ON journal_lines(account_code, entry_id);
  `);
}

function createTriggers(db) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_bom_updated AFTER UPDATE ON bom_headers
    BEGIN
      UPDATE bom_headers SET updated_at = strftime('%s','now') WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_po_updated AFTER UPDATE ON production_orders
    BEGIN
      UPDATE production_orders SET updated_at = strftime('%s','now') WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_bom_single_default
    AFTER UPDATE OF is_default ON bom_headers WHEN NEW.is_default = 1
    BEGIN
      UPDATE bom_headers SET is_default = 0
      WHERE product_id = NEW.product_id AND id <> NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_bomline_lock_active
    BEFORE UPDATE ON bom_lines
    BEGIN
      SELECT RAISE(ABORT, 'E_BOM_LOCKED: فرمول فعال قابل ویرایش نیست؛ نسخه جدید بسازید')
      WHERE (SELECT status FROM bom_headers WHERE id = NEW.bom_id) = 'active';
    END;

    CREATE TRIGGER IF NOT EXISTS trg_bomline_lock_delete
    BEFORE DELETE ON bom_lines
    BEGIN
      SELECT RAISE(ABORT, 'E_BOM_LOCKED: فرمول فعال قابل حذف نیست')
      WHERE (SELECT status FROM bom_headers WHERE id = OLD.bom_id) = 'active';
    END;

    CREATE TRIGGER IF NOT EXISTS trg_bom_no_self
    BEFORE INSERT ON bom_lines
    BEGIN
      SELECT RAISE(ABORT, 'E_BOM_SELF_REF: کالا نمی‌تواند جزء فرمول خودش باشد')
      WHERE NEW.component_product_id = (SELECT product_id FROM bom_headers WHERE id = NEW.bom_id);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_mi_period_lock
    BEFORE INSERT ON production_material_issues
    BEGIN
      SELECT RAISE(ABORT, 'E_PERIOD_CLOSED: دوره بسته شده است')
      WHERE NEW.period_label <> '' AND EXISTS (
        SELECT 1 FROM production_period_close
        WHERE period_label = NEW.period_label AND status = 'closed');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_lab_period_lock
    BEFORE INSERT ON production_labor_entries
    BEGIN
      SELECT RAISE(ABORT, 'E_PERIOD_CLOSED: دوره بسته شده است')
      WHERE NEW.period_label <> '' AND EXISTS (
        SELECT 1 FROM production_period_close
        WHERE period_label = NEW.period_label AND status = 'closed');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_oh_period_lock
    BEFORE INSERT ON production_overhead_applications
    BEGIN
      SELECT RAISE(ABORT, 'E_PERIOD_CLOSED: دوره بسته شده است')
      WHERE NEW.period_label <> '' AND EXISTS (
        SELECT 1 FROM production_period_close
        WHERE period_label = NEW.period_label AND status = 'closed');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_pr_period_lock
    BEFORE INSERT ON production_receipts
    BEGIN
      SELECT RAISE(ABORT, 'E_PERIOD_CLOSED: دوره بسته شده است')
      WHERE NEW.period_label <> '' AND EXISTS (
        SELECT 1 FROM production_period_close
        WHERE period_label = NEW.period_label AND status = 'closed');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_waste_period_lock
    BEFORE INSERT ON production_waste
    BEGIN
      SELECT RAISE(ABORT, 'E_PERIOD_CLOSED: دوره بسته شده است')
      WHERE NEW.period_label <> '' AND EXISTS (
        SELECT 1 FROM production_period_close
        WHERE period_label = NEW.period_label AND status = 'closed');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_rework_period_lock
    BEFORE INSERT ON production_rework
    BEGIN
      SELECT RAISE(ABORT, 'E_PERIOD_CLOSED: دوره بسته شده است')
      WHERE NEW.period_label <> '' AND EXISTS (
        SELECT 1 FROM production_period_close
        WHERE period_label = NEW.period_label AND status = 'closed');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_sub_period_lock
    BEFORE INSERT ON production_subcontract
    BEGIN
      SELECT RAISE(ABORT, 'E_PERIOD_CLOSED: دوره بسته شده است')
      WHERE NEW.period_label <> '' AND EXISTS (
        SELECT 1 FROM production_period_close
        WHERE period_label = NEW.period_label AND status = 'closed');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_est_lock_confirmed
    BEFORE UPDATE ON production_estimates
    WHEN OLD.status IN ('confirmed','converted') AND NEW.status = OLD.status
    BEGIN
      SELECT RAISE(ABORT, 'E_ESTIMATE_LOCKED: برآورد تأییدشده قابل ویرایش نیست')
      WHERE NEW.qty <> OLD.qty OR NEW.product_id <> OLD.product_id;
    END;
  `);

  if (tableExists(db, 'warehouse_stock')) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_ws_no_negative
      BEFORE UPDATE ON warehouse_stock WHEN NEW.qty < 0
      BEGIN
        SELECT RAISE(ABORT, 'E_NEGATIVE_STOCK: موجودی انبار منفی می‌شود');
      END;
    `);
  }
}

function createViews(db) {
  db.exec(`
    DROP VIEW IF EXISTS v_wip_by_order;
    CREATE VIEW v_wip_by_order AS
    SELECT po.id AS order_id, po.order_no, po.product_id, po.status, po.period_label,
           COALESCE(SUM(CASE WHEN jl.account_code = COALESCE((SELECT value FROM settings WHERE key='coa_wip'), '1111')
                              OR jl.account_code = '1111'
                        THEN COALESCE(jl.debit_rial,0) - COALESCE(jl.credit_rial,0) ELSE 0 END), 0) AS wip_rial
    FROM production_orders po
    LEFT JOIN journal_entries je ON je.ref_id = po.id
                                AND je.ref_type LIKE 'production_%'
                                AND COALESCE(je.deleted_at,0) = 0
    LEFT JOIN journal_lines jl   ON jl.entry_id = je.id
    GROUP BY po.id;

    DROP VIEW IF EXISTS v_order_cost_summary;
    CREATE VIEW v_order_cost_summary AS
    SELECT po.id AS order_id, po.order_no, po.product_id, p.name AS product_name,
           po.date, po.period_label, po.status, po.analysis_type,
           po.qty_planned, po.qty_produced,
           po.qty_waste_normal, po.qty_waste_abnormal,
           po.material_cost_rial, po.packaging_cost_rial, po.labor_cost_rial,
           po.overhead_cost_rial, po.subcontract_cost_rial, po.rework_cost_rial,
           po.abnormal_waste_rial, po.scrap_credit_rial, po.byproduct_credit_rial,
           po.total_cost_rial, po.unit_cost_rial,
           po.std_total_rial, po.std_unit_rial,
           CASE WHEN po.std_unit_rial > 0
                THEN ROUND((po.unit_cost_rial - po.std_unit_rial) * 100.0 / po.std_unit_rial, 2)
                ELSE 0 END AS deviation_pct,
           CASE WHEN (po.qty_produced + po.qty_waste_normal + po.qty_waste_abnormal) > 0
                THEN ROUND(po.qty_produced * 100.0
                           / (po.qty_produced + po.qty_waste_normal + po.qty_waste_abnormal), 2)
                ELSE 0 END AS yield_pct
    FROM production_orders po
    JOIN products p ON p.id = po.product_id;

    DROP VIEW IF EXISTS v_variance_summary;
    CREATE VIEW v_variance_summary AS
    SELECT v.period_label, v.variance_type, v.cost_center_id, cc.code AS cc_code, cc.name AS cc_name,
           s.seq AS stage_seq,
           SUM(v.amount_rial) AS amount_rial,
           COUNT(DISTINCT v.order_id) AS order_count,
           SUM(CASE WHEN v.amount_rial < 0 THEN 1 ELSE 0 END) AS favorable_count
    FROM production_variances v
    LEFT JOIN cost_centers cc ON cc.id = v.cost_center_id
    LEFT JOIN production_order_stages s ON s.id = v.stage_id
    GROUP BY v.period_label, v.variance_type, v.cost_center_id, s.seq;
  `);
}

function seedSequences(db) {
  for (const { key } of PROD_SEQUENCES) {
    if (!db.prepare('SELECT 1 FROM number_sequences WHERE key=?').get(key)) {
      db.prepare('INSERT INTO number_sequences (key,current_value) VALUES (?,0)').run(key);
    }
  }
}

function seedSettings(db) {
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
  for (const [k, v] of Object.entries(PRODUCTION_SETTINGS)) {
    ins.run(k, v);
  }
  // Map logical coa keys to codes (optional overrides)
  const coaSettings = {
    coa_raw_materials: '1110',
    coa_packaging_materials: '1112',
    coa_wip: '1111',
    coa_finished_goods: '1104',
    coa_scrap_inventory: '1113',
    coa_subcontract_inventory: '1114',
    coa_labor_control: '5201',
    coa_overhead_control: '5202',
    coa_overhead_applied: '5203',
    coa_var_material_price: '5210',
    coa_var_material_qty: '5211',
    coa_var_labor_rate: '5212',
    coa_var_labor_eff: '5213',
    coa_var_oh_budget: '5214',
    coa_var_oh_volume: '5215',
    coa_abnormal_waste: '5221',
    coa_rework_cost: '5222',
    coa_subcontract_fee: '5230',
  };
  for (const [k, v] of Object.entries(coaSettings)) ins.run(k, v);
}

function seedCostCenters(db) {
  const find = db.prepare('SELECT id FROM cost_centers WHERE code=?');
  const ins = db.prepare(`
    INSERT INTO cost_centers (name,code,kind,driver,seq,is_stage,default_labor_method,active)
    VALUES (?,?,?,?,?,?,?,1)
  `);
  const upd = db.prepare(`
    UPDATE cost_centers SET name=?, kind=?, driver=?, seq=?, is_stage=?, default_labor_method=?
    WHERE code=?
  `);
  for (const cc of TARANOM_COST_CENTERS) {
    const row = find.get(cc.code);
    if (row) {
      upd.run(cc.name, cc.kind, cc.driver, cc.seq, cc.is_stage, cc.default_labor_method, cc.code);
    } else {
      ins.run(cc.name, cc.code, cc.kind, cc.driver, cc.seq, cc.is_stage, cc.default_labor_method);
    }
  }
}

function seedWarehouses(db) {
  // After an intentional wipe (settings.warehouses_user_cleared=1), never
  // re-insert the Taranom default warehouse catalog — operators redefine them.
  const cleared = db.prepare("SELECT value FROM settings WHERE key='warehouses_user_cleared'").get()?.value;
  const find = db.prepare('SELECT id FROM warehouses WHERE code=?');
  const byName = db.prepare('SELECT id FROM warehouses WHERE name=?');
  if (cleared !== '1') {
    for (const wh of TARANOM_WAREHOUSES) {
      let row = find.get(wh.code);
      if (!row) row = byName.get(wh.name);
      if (row) {
        ensureColumn(db, 'warehouses', 'code', 'TEXT');
        ensureColumn(db, 'warehouses', 'kind', "TEXT DEFAULT 'general'");
        db.prepare('UPDATE warehouses SET code=COALESCE(code,?), kind=?, name=? WHERE id=?')
          .run(wh.code, wh.kind, wh.name, row.id);
      } else {
        db.prepare(`
          INSERT INTO warehouses (code,name,address,kind,warehouse_type,active)
          VALUES (?,?,?,?,?,1)
        `).run(
          wh.code,
          wh.name,
          '',
          wh.kind,
          wh.kind === 'raw' ? 'raw_material' : (wh.kind === 'finished' ? 'finished_goods' : wh.kind)
        );
      }
    }
  }

  const idOf = (code) => db.prepare('SELECT id FROM warehouses WHERE code=?').get(code)?.id;
  const setIfEmpty = (key, id) => {
    if (!id) return;
    const cur = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    if (!cur || !cur.value) {
      db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(key, String(id));
    }
  };
  // Only wire production defaults when those warehouses actually exist
  setIfEmpty('production_wh_raw_id', idOf('WH-RAW'));
  setIfEmpty('production_wh_fg_id', idOf('WH-FG'));
  setIfEmpty('production_wh_sub_id', idOf('WH-SUB'));
  setIfEmpty('production_wh_scrap_id', idOf('WH-SCRAP'));
  setIfEmpty('production_wh_dist_id', idOf('WH-DIST-FG'));
}

function seedAccounts(db) {
  // Parent group for control accounts
  db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code) VALUES ('5200','حساب‌های کنترل تولید','expense','6000')").run();
  const ins = db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code) VALUES (?,?,?,?)');
  for (const a of PRODUCTION_ACCOUNTS) {
    if (a.code === '5200') continue;
    ins.run(a.code, a.name, a.type, a.parent_code);
  }
}

function initProductionSchema(db) {
  ensureExistingColumns(db);
  createTables(db);
  ensureExistingColumns(db); // columns on newly created production tables
  createTriggers(db);
  createViews(db);
  seedSequences(db);
  seedSettings(db);
  seedCostCenters(db);
  seedWarehouses(db);
  seedAccounts(db);
}

module.exports = {
  initProductionSchema,
  PROD_TABLES,
  PROD_SEQUENCES,
  PRODUCTION_SETTINGS,
  TARANOM_COST_CENTERS,
  TARANOM_WAREHOUSES,
  PRODUCTION_ACCOUNTS,
};
