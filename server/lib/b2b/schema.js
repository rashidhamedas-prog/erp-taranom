'use strict';

/**
 * B2B corporate account + credit schema (P1-B2B1 / P1-B2B3 MVP).
 * Central-only — not appended to SYNCABLE_TABLES.
 */
function initB2bSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS b2b_companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL,
      credit_limit_rial INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    );
    CREATE INDEX IF NOT EXISTS idx_b2b_companies_active ON b2b_companies(active);

    CREATE TABLE IF NOT EXISTS b2b_company_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','buyer','approver','viewer')),
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(company_id, account_id),
      FOREIGN KEY(company_id) REFERENCES b2b_companies(id),
      FOREIGN KEY(account_id) REFERENCES b2b_portal_accounts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_b2b_company_users_account ON b2b_company_users(account_id);

    CREATE TABLE IF NOT EXISTS b2b_credit_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      order_id INTEGER,
      delta_rial INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('reserve','release','consume')),
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(company_id) REFERENCES b2b_companies(id)
    );
    CREATE INDEX IF NOT EXISTS idx_b2b_credit_ledger_company ON b2b_credit_ledger(company_id);
    CREATE INDEX IF NOT EXISTS idx_b2b_credit_ledger_order ON b2b_credit_ledger(order_id);
  `);
}

module.exports = { initB2bSchema };
