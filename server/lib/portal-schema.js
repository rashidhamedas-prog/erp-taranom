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
}

module.exports = { initPortalSchema };
