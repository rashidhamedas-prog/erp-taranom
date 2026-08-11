'use strict';

function initReportingSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      start_date TEXT,
      end_date TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS report_configurations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_name TEXT NOT NULL,
      row_number INTEGER NOT NULL,
      row_label TEXT NOT NULL,
      operation TEXT NOT NULL DEFAULT 'sum'
        CHECK(operation IN ('sum','subtract','subtotal')),
      account_prefixes_json TEXT NOT NULL DEFAULT '[]',
      show_subtotal INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(report_name, row_number)
    );

    CREATE TABLE IF NOT EXISTS vat_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      journal_line_id INTEGER,
      source_type TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      invoice_number TEXT,
      invoice_date TEXT NOT NULL,
      base_amount_rial INTEGER NOT NULL DEFAULT 0,
      vat_rate_bp INTEGER NOT NULL DEFAULT 0,
      vat_amount_rial INTEGER NOT NULL DEFAULT 0,
      vat_category TEXT NOT NULL CHECK(vat_category IN ('output','input','withholding')),
      fiscal_period TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'posted'
        CHECK(status IN ('draft','posted','reversed')),
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(source_type, source_id, vat_category),
      FOREIGN KEY(journal_line_id) REFERENCES journal_lines(id)
    );

    CREATE INDEX IF NOT EXISTS idx_report_config_name
      ON report_configurations(report_name, row_number);
    CREATE INDEX IF NOT EXISTS idx_vat_records_period
      ON vat_records(fiscal_period, vat_category, status);
  `);
}

module.exports = { initReportingSchema };
