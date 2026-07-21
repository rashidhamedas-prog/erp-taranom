/**
 * Portal karmandan schema (docs/PORTAL-KARMANDAN-SPEC.md) — idempotent.
 */
function initPortalSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS op_units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      manager_person_id INTEGER NOT NULL,
      manager2_person_id INTEGER,
      manager3_person_id INTEGER,
      output_type TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER,
      FOREIGN KEY(manager_person_id) REFERENCES persons(id)
    );

    CREATE TABLE IF NOT EXISTS op_unit_warehouses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id INTEGER NOT NULL,
      warehouse_id INTEGER NOT NULL,
      FOREIGN KEY(unit_id) REFERENCES op_units(id),
      FOREIGN KEY(warehouse_id) REFERENCES warehouses(id)
    );

    CREATE TABLE IF NOT EXISTS op_unit_persons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id INTEGER NOT NULL,
      person_id INTEGER NOT NULL,
      FOREIGN KEY(unit_id) REFERENCES op_units(id),
      FOREIGN KEY(person_id) REFERENCES persons(id)
    );

    CREATE TABLE IF NOT EXISTS op_departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      manager_person_id INTEGER NOT NULL,
      warehouse_id INTEGER NOT NULL,
      sequence_order INTEGER NOT NULL,
      status TEXT DEFAULT 'active',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(unit_id) REFERENCES op_units(id),
      FOREIGN KEY(warehouse_id) REFERENCES warehouses(id)
    );

    CREATE TABLE IF NOT EXISTS op_parameters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      num TEXT,
      name TEXT NOT NULL,
      unit_id INTEGER NOT NULL,
      current_department_id INTEGER,
      status TEXT DEFAULT 'initiated',
      final_quantity REAL,
      destination_warehouse_id INTEGER,
      description TEXT DEFAULT '',
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER,
      completed_at INTEGER,
      FOREIGN KEY(unit_id) REFERENCES op_units(id)
    );

    CREATE TABLE IF NOT EXISTS op_parameter_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parameter_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity REAL NOT NULL,
      unit_of_measure TEXT DEFAULT '',
      FOREIGN KEY(parameter_id) REFERENCES op_parameters(id),
      FOREIGN KEY(product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS op_parameter_dept_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parameter_id INTEGER NOT NULL,
      department_id INTEGER NOT NULL,
      sequence_order INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      received_quantity REAL,
      confirmed INTEGER DEFAULT 0,
      correction_quantity REAL,
      correction_notified INTEGER DEFAULT 0,
      output_quantity REAL,
      payment_person_id INTEGER,
      payment_amount INTEGER DEFAULT 0,
      payment_status TEXT,
      payment_journal_id INTEGER,
      converted_product_id INTEGER,
      conversion_quantity REAL,
      production_run_id INTEGER,
      transfer_move_id INTEGER,
      notes TEXT DEFAULT '',
      started_at INTEGER,
      completed_at INTEGER,
      completed_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(parameter_id) REFERENCES op_parameters(id),
      FOREIGN KEY(department_id) REFERENCES op_departments(id)
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_op_param_dept_log_param ON op_parameter_dept_log(parameter_id);
    CREATE INDEX IF NOT EXISTS idx_op_param_dept_log_dept ON op_parameter_dept_log(department_id);
    CREATE INDEX IF NOT EXISTS idx_op_parameters_unit_status ON op_parameters(unit_id, status);
    CREATE INDEX IF NOT EXISTS idx_op_parameters_current_dept ON op_parameters(current_department_id);
    CREATE INDEX IF NOT EXISTS idx_op_departments_unit_seq ON op_departments(unit_id, sequence_order);
  `);

  db.prepare("INSERT OR IGNORE INTO number_sequences (key,current_value) VALUES ('op_parameter',0)").run();
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('module_portal','1')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('portal_schema_v1','1')").run();

  // v2 — capabilities / tasks / extra costs / module links / CRM followups (APPEND)
  db.exec(`
    CREATE TABLE IF NOT EXISTS op_dept_capabilities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      department_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      FOREIGN KEY(department_id) REFERENCES op_departments(id)
    );
    CREATE TABLE IF NOT EXISTS op_dept_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      department_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      FOREIGN KEY(department_id) REFERENCES op_departments(id)
    );
    CREATE TABLE IF NOT EXISTS op_unit_module_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id INTEGER NOT NULL,
      module_key TEXT NOT NULL,
      FOREIGN KEY(unit_id) REFERENCES op_units(id)
    );
    CREATE TABLE IF NOT EXISTS op_parameter_extra_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parameter_id INTEGER NOT NULL,
      description TEXT NOT NULL,
      amount_rial INTEGER NOT NULL,
      expense_category_id INTEGER,
      journal_id INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(parameter_id) REFERENCES op_parameters(id)
    );
    CREATE TABLE IF NOT EXISTS op_field_followups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      field_key TEXT NOT NULL,
      note TEXT NOT NULL,
      person_id INTEGER,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);
  try { db.exec("ALTER TABLE op_parameter_dept_log ADD COLUMN payment_note TEXT DEFAULT ''"); } catch (_) {}
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('portal_schema_v2','1')").run();

  // v3 — temporary department manager delegation (APPEND)
  db.exec(`
    CREATE TABLE IF NOT EXISTS op_dept_delegations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      department_id INTEGER NOT NULL,
      delegate_person_id INTEGER NOT NULL,
      starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,
      note TEXT DEFAULT '',
      created_by INTEGER,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(department_id) REFERENCES op_departments(id),
      FOREIGN KEY(delegate_person_id) REFERENCES persons(id)
    );
    CREATE INDEX IF NOT EXISTS idx_op_dept_delegations_active
      ON op_dept_delegations(delegate_person_id, active, starts_at, ends_at);
  `);
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('portal_schema_v3','1')").run();
}

module.exports = { initPortalSchema };
