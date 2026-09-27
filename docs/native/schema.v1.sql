-- ERP Taranom schema dump (generated — do not edit by hand)
-- SYNC_ROLE: device
-- tables: 207 indexes: 381 triggers: 15

CREATE TABLE account_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      from_type TEXT NOT NULL,
      from_id INTEGER,
      to_type TEXT NOT NULL,
      to_id INTEGER,
      amount REAL NOT NULL,
      note TEXT DEFAULT '',
      user_id INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0, mahak_doc_no TEXT, mahak_doc_type TEXT, status TEXT NOT NULL DEFAULT 'posted', reversal_journal_id INTEGER, reversed_at INTEGER, reversed_by INTEGER, foreign_amount REAL, fx_rate_rial INTEGER, currency TEXT DEFAULT 'IRR');

CREATE TABLE ai_insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      user_id INTEGER,
      kind TEXT NOT NULL,
      score INTEGER,
      title TEXT DEFAULT '',
      body TEXT DEFAULT '',
      period TEXT DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

CREATE TABLE api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      scopes TEXT DEFAULT 'read',
      active INTEGER DEFAULT 1,
      last_used INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

CREATE TABLE api_usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id INTEGER,
      endpoint TEXT,
      method TEXT,
      status INTEGER,
      ip TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

CREATE TABLE app_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      title TEXT DEFAULT '',
      body TEXT DEFAULT '',
      target_roles TEXT DEFAULT '[]',
      resolved_at INTEGER,
      resolved_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT,
      entity TEXT,
      entity_id INTEGER,
      detail TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , ip_address TEXT DEFAULT '', user_agent TEXT DEFAULT '');

CREATE TABLE b2b_companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL,
      credit_limit_rial INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    );

CREATE TABLE b2b_company_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','buyer','approver','viewer')),
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(company_id, account_id),
      FOREIGN KEY(company_id) REFERENCES b2b_companies(id),
      FOREIGN KEY(account_id) REFERENCES b2b_portal_accounts(id)
    );

CREATE TABLE b2b_credit_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      order_id INTEGER,
      delta_rial INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('reserve','release','consume')),
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(company_id) REFERENCES b2b_companies(id)
    );

CREATE TABLE b2b_portal_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER UNIQUE NOT NULL,
      phone TEXT NOT NULL,
      password TEXT,
      otp_hash TEXT,
      otp_expires INTEGER,
      active INTEGER DEFAULT 1,
      last_login INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')), auth_epoch INTEGER DEFAULT 0, otp_attempts INTEGER DEFAULT 0, otp_locked_until INTEGER,
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    );

CREATE TABLE b2b_portal_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      rows TEXT,
      note TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      invoice_id INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    );

CREATE TABLE bank_reconciliation_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reconciliation_id INTEGER NOT NULL,
      side TEXT NOT NULL,
      ref_type TEXT,
      ref_id INTEGER,
      description TEXT DEFAULT '',
      amount_rial INTEGER NOT NULL DEFAULT 0,
      matched INTEGER DEFAULT 0,
      statement_line INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')), match_confidence INTEGER DEFAULT 0, statement_line_id INTEGER, item_kind TEXT DEFAULT 'unclassified', line_date TEXT, voided INTEGER DEFAULT 0, sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(reconciliation_id) REFERENCES bank_reconciliations(id)
    );

CREATE TABLE bank_reconciliations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_id INTEGER NOT NULL,
      statement_date TEXT NOT NULL,
      statement_balance_rial INTEGER NOT NULL DEFAULT 0,
      book_balance_rial INTEGER NOT NULL DEFAULT 0,
      status TEXT DEFAULT 'open',
      notes TEXT DEFAULT '',
      adjustment_je_id INTEGER,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      closed_at INTEGER, reversal_je_id INTEGER, voided_at INTEGER, sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(bank_id) REFERENCES banks(id)
    );

CREATE TABLE bank_statement_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reconciliation_id INTEGER NOT NULL,
      line_date TEXT NOT NULL,
      amount_rial INTEGER NOT NULL DEFAULT 0,
      description TEXT DEFAULT '',
      ref TEXT DEFAULT '',
      matched INTEGER DEFAULT 0,
      match_confidence INTEGER DEFAULT 0,
      matched_ref_type TEXT,
      matched_ref_id INTEGER,
      matched_item_id INTEGER,
      bank_item_id INTEGER,
      status TEXT DEFAULT 'active',
      deleted_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(reconciliation_id) REFERENCES bank_reconciliations(id)
    );

CREATE TABLE banks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      account_number TEXT DEFAULT '',
      branch TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0, coa_code TEXT, opening_balance_rial INTEGER DEFAULT 0, opening_balance_je_id INTEGER, opening_balance_date TEXT, mahak_op_code TEXT, account_type TEXT, phone TEXT, card_number TEXT, card_expiry TEXT, sheba TEXT, note TEXT, extra_accounts TEXT DEFAULT '[]', currency TEXT DEFAULT 'IRR', is_foreign INTEGER DEFAULT 0);

CREATE TABLE bom_change_log (
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
      created_at   INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(bom_id) REFERENCES bom_headers(id)
    );

CREATE TABLE bom_headers (
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
      deleted_at        INTEGER, sync_seq INTEGER,
      FOREIGN KEY(product_id) REFERENCES products(id),
      FOREIGN KEY(alt_of_bom_id) REFERENCES bom_headers(id)
    );

CREATE TABLE bom_lines (
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
      created_at            INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(bom_id) REFERENCES bom_headers(id) ON DELETE CASCADE,
      FOREIGN KEY(component_product_id) REFERENCES products(id),
      FOREIGN KEY(stage_cost_center_id) REFERENCES cost_centers(id)
    );

CREATE TABLE bom_operations (
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
      person_id            INTEGER,
      note                 TEXT DEFAULT '',
      created_at           INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(bom_id) REFERENCES bom_headers(id) ON DELETE CASCADE,
      FOREIGN KEY(cost_center_id) REFERENCES cost_centers(id)
    );

CREATE TABLE bom_outputs (
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
      created_at         INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(bom_id) REFERENCES bom_headers(id) ON DELETE CASCADE,
      FOREIGN KEY(product_id) REFERENCES products(id)
    );

CREATE TABLE branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE budget_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      budget_id INTEGER NOT NULL,
      account_code TEXT,
      cost_center_id INTEGER,
      month INTEGER NOT NULL,
      amount_rial INTEGER NOT NULL DEFAULT 0,
      category TEXT DEFAULT 'opex',
      notes TEXT DEFAULT '', sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(budget_id) REFERENCES budgets(id)
    );

CREATE TABLE budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      fiscal_year_id INTEGER,
      year_label TEXT,
      status TEXT DEFAULT 'draft',
      notes TEXT DEFAULT '',
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE cash_boxes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      custodian TEXT DEFAULT '',
      is_petty_cash INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0, coa_code TEXT, currency TEXT DEFAULT 'IRR', is_foreign INTEGER DEFAULT 0, opening_balance_rial INTEGER DEFAULT 0, opening_balance_je_id INTEGER, opening_balance_date TEXT);

CREATE TABLE chart_of_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      parent_code TEXT,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0, level INTEGER DEFAULT 0, nature TEXT, tafsili_type TEXT, balance_type TEXT DEFAULT 'trial_balance', is_cost_element INTEGER DEFAULT 0);

CREATE TABLE check_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      serial_from TEXT DEFAULT '',
      serial_to TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0, holder_name TEXT, leaf_count INTEGER DEFAULT 0, current_leaf TEXT, note TEXT,
      FOREIGN KEY(bank_id) REFERENCES banks(id)
    );

CREATE TABLE cheque_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL,
      cheque_number TEXT DEFAULT '',
      issue_date TEXT DEFAULT '',
      receive_date TEXT DEFAULT '',
      due_date TEXT DEFAULT '',
      bank_name TEXT DEFAULT '',
      branch TEXT DEFAULT '',
      sayadi TEXT DEFAULT '',
      sheba TEXT DEFAULT '',
      account_number TEXT DEFAULT '',
      party_name TEXT DEFAULT '',
      status TEXT DEFAULT '',
      status_note TEXT DEFAULT '',
      amount REAL NOT NULL DEFAULT 0,
      mahak_row_id TEXT DEFAULT '',
      mahak_reg_id TEXT DEFAULT '',
      note TEXT DEFAULT '',
      created_by_name TEXT DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , record_status TEXT NOT NULL DEFAULT 'posted', journal_entry_id INTEGER, reversal_journal_id INTEGER, reversed_at INTEGER, reversed_by INTEGER, party_id INTEGER, customer_id INTEGER, lifecycle_status TEXT DEFAULT '', invoice_id INTEGER, settlement_id INTEGER, collection_bank_id INTEGER, collection_je_id INTEGER, cleared_je_id INTEGER, bounced_je_id INTEGER, endorse_party_id INTEGER, endorse_supplier_id INTEGER, sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE consignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL,
      party_name TEXT NOT NULL,
      party_phone TEXT DEFAULT '',
      product_id INTEGER NOT NULL,
      qty INTEGER NOT NULL,
      unit_price REAL DEFAULT 0,
      date TEXT DEFAULT '',
      status TEXT DEFAULT 'open',
      note TEXT DEFAULT '',
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0, person_id INTEGER, warehouse_id INTEGER, invoice_id INTEGER, settle_path TEXT, settle_je_id INTEGER, issue_ledger_id INTEGER, record_status TEXT DEFAULT 'active', unit_price_rial INTEGER DEFAULT 0, variant_id INTEGER);

CREATE TABLE cost_center_rates (
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
      created_at             INTEGER DEFAULT (strftime('%s','now')), monthly_labor_rate_rial INTEGER DEFAULT 0, sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(cost_center_id) REFERENCES cost_centers(id)
    );

CREATE TABLE cost_centers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT,
      name TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0, entity TEXT, kind TEXT DEFAULT 'production', driver TEXT DEFAULT 'output_qty', seq INTEGER DEFAULT 0, is_stage INTEGER DEFAULT 0, capacity_per_day REAL DEFAULT 0, default_labor_method TEXT DEFAULT 'piece', parent_id INTEGER, coa_tafsili_oh TEXT, coa_tafsili_lb TEXT);

CREATE TABLE crm_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      party_id INTEGER,
      customer_id INTEGER,
      opportunity_id INTEGER,
      owner_user_id INTEGER,
      followup_id INTEGER,
      type TEXT NOT NULL DEFAULT 'note',
      subject TEXT DEFAULT '',
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT DEFAULT 'mid',
      activity_date TEXT DEFAULT '',
      due_date TEXT DEFAULT '',
      completed_at INTEGER,
      result TEXT DEFAULT '',
      next_action TEXT DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE crm_automation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_key TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      payload TEXT DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(rule_key, entity_type, entity_id)
    );

CREATE TABLE crm_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      cost_rial INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      start_date TEXT DEFAULT '',
      end_date TEXT DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE crm_customer_segments (
      customer_id INTEGER PRIMARY KEY,
      party_id INTEGER,
      calculated_segment TEXT NOT NULL DEFAULT 'C',
      manual_segment TEXT,
      effective_segment TEXT NOT NULL DEFAULT 'C',
      manual_override_reason TEXT DEFAULT '',
      reason TEXT DEFAULT '',
      sales_30_rial INTEGER NOT NULL DEFAULT 0,
      sales_90_rial INTEGER NOT NULL DEFAULT 0,
      sales_365_rial INTEGER NOT NULL DEFAULT 0,
      purchase_count INTEGER NOT NULL DEFAULT 0,
      avg_purchase_rial INTEGER NOT NULL DEFAULT 0,
      last_purchase_date TEXT DEFAULT '',
      avg_cycle_days REAL,
      inactive_days INTEGER NOT NULL DEFAULT 0,
      churn_probability_percent INTEGER NOT NULL DEFAULT 0,
      computed_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE crm_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      party_id INTEGER,
      customer_id INTEGER,
      opportunity_id INTEGER,
      activity_id INTEGER,
      file_path TEXT NOT NULL,
      original_name TEXT DEFAULT '',
      uploaded_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE crm_lead_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE crm_opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      party_id INTEGER,
      customer_id INTEGER NOT NULL,
      owner_user_id INTEGER,
      title TEXT DEFAULT '',
      pipeline_stage TEXT NOT NULL DEFAULT 'lead',
      status TEXT NOT NULL DEFAULT 'open',
      estimated_amount_rial INTEGER NOT NULL DEFAULT 0,
      probability_percent INTEGER NOT NULL DEFAULT 10,
      weighted_amount_rial INTEGER NOT NULL DEFAULT 0,
      expected_close_date TEXT DEFAULT '',
      lead_source TEXT DEFAULT '',
      campaign TEXT DEFAULT '',
      campaign_id INTEGER,
      lost_reason TEXT DEFAULT '',
      won_invoice_id INTEGER,
      entered_stage_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      closed_at INTEGER
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE crm_segment_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      from_segment TEXT,
      to_segment TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'system',
      reason TEXT DEFAULT '',
      changed_by INTEGER,
      changed_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE crm_stage_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opportunity_id INTEGER NOT NULL,
      from_stage TEXT,
      to_stage TEXT NOT NULL,
      changed_by INTEGER,
      changed_at INTEGER DEFAULT (strftime('%s','now')),
      duration_seconds INTEGER,
      reason TEXT DEFAULT ''
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE currencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      symbol TEXT DEFAULT '',
      is_base INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE customer_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      nature TEXT NOT NULL DEFAULT 'debit',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE customer_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      ref_type TEXT,
      ref_id INTEGER,
      description TEXT,
      debit REAL DEFAULT 0,
      credit REAL DEFAULT 0,
      user_id INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(customer_id) REFERENCES customers(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

CREATE TABLE customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      biz TEXT NOT NULL,
      owner TEXT,
      city TEXT,
      phone TEXT,
      insta TEXT,
      type TEXT DEFAULT 'بوتیک',
      status TEXT DEFAULT 'new',
      note TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')), source TEXT DEFAULT '', balance REAL DEFAULT 0, province TEXT DEFAULT '', address TEXT DEFAULT '', assigned_to INTEGER, auto_followup INTEGER DEFAULT 1, group_id INTEGER, rep_territory TEXT DEFAULT '', sync_seq INTEGER, version INTEGER DEFAULT 0, churn_score INTEGER DEFAULT 0, b2b_enabled INTEGER DEFAULT 0, coa_code TEXT, party_group_id INTEGER, mahak_op_code TEXT, prefix TEXT, phone2 TEXT, fax TEXT, mobile TEXT, email TEXT, economic_code TEXT, postal_code TEXT, national_id TEXT, referrer TEXT, birth_date TEXT, company_name TEXT, account_nature TEXT, party_id INTEGER, created_by INTEGER, lead_source TEXT DEFAULT '', campaign TEXT DEFAULT '',
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

CREATE TABLE cutting_lay_rolls (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      lay_id        INTEGER NOT NULL,
      batch_id      INTEGER NOT NULL,
      meters        REAL NOT NULL,
      unit_cost_rial INTEGER DEFAULT 0,
      amount_rial   INTEGER DEFAULT 0,
      ledger_id     INTEGER,
      status        TEXT NOT NULL DEFAULT 'posted', sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(lay_id) REFERENCES cutting_lays(id)
    );

CREATE TABLE cutting_lays (
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
      reversal_journal_id  INTEGER,
      production_order_id  INTEGER
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE cutting_pack_bundles (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      pack_id       INTEGER NOT NULL,
      product_id    INTEGER NOT NULL,
      color         TEXT DEFAULT '',
      size_code     TEXT DEFAULT '',
      qty           REAL NOT NULL DEFAULT 0,
      amount_rial   INTEGER DEFAULT 0,
      barcode       TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'posted',
      created_at    INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(pack_id) REFERENCES cutting_packs(id)
    );

CREATE TABLE cutting_packs (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      pack_no              TEXT NOT NULL UNIQUE,
      lay_id               INTEGER NOT NULL,
      production_order_id  INTEGER,
      product_id           INTEGER NOT NULL,
      warehouse_id         INTEGER NOT NULL,
      qty                  REAL NOT NULL,
      amount_rial          INTEGER NOT NULL DEFAULT 0,
      unit_cost_rial       INTEGER DEFAULT 0,
      size_breakdown       TEXT DEFAULT '',
      journal_id           INTEGER,
      ledger_id            INTEGER,
      status               TEXT NOT NULL DEFAULT 'posted',
      idempotency_key      TEXT,
      date                 TEXT NOT NULL DEFAULT '',
      note                 TEXT DEFAULT '',
      created_by           INTEGER,
      created_at           INTEGER DEFAULT (strftime('%s','now')),
      reversed_at          INTEGER,
      reversed_by          INTEGER,
      reversal_journal_id  INTEGER, sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(lay_id) REFERENCES cutting_lays(id)
    );

CREATE TABLE detail_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      detail_category_id INTEGER REFERENCES detail_categories(id),
      linked_table TEXT,
      linked_id INTEGER,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE detail_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE doubtful_debt_provisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      as_of_date TEXT NOT NULL,
      method TEXT DEFAULT 'aging',
      total_rial INTEGER NOT NULL DEFAULT 0,
      je_id INTEGER,
      notes TEXT DEFAULT '',
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE employee_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE exchange_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      currency TEXT NOT NULL,
      date TEXT NOT NULL,
      rate_rial INTEGER NOT NULL,
      source TEXT DEFAULT 'manual',
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      UNIQUE(currency, date, source)
    );

CREATE TABLE expense_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT,
      name TEXT NOT NULL,
      account_code TEXT,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0, coa_code TEXT, parent_id INTEGER, level INTEGER DEFAULT 1);

CREATE TABLE expense_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL DEFAULT 'admin',
      title TEXT DEFAULT '',
      amount REAL NOT NULL,
      pay_type TEXT DEFAULT 'cash',
      bank_id INTEGER,
      cash_box_id INTEGER,
      check_category_id INTEGER,
      cost_center_id INTEGER,
      date TEXT NOT NULL,
      note TEXT DEFAULT '',
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , account_code TEXT, purchase_invoice_id INTEGER, is_overhead INTEGER DEFAULT 0, status TEXT NOT NULL DEFAULT 'posted', journal_entry_id INTEGER, reversal_journal_id INTEGER, reversed_at INTEGER, reversed_by INTEGER, sync_seq INTEGER, version INTEGER DEFAULT 0, mahak_doc_no TEXT, mahak_doc_type TEXT, overhead_type TEXT DEFAULT 'variable', foreign_amount REAL, fx_rate_rial INTEGER, currency TEXT DEFAULT 'IRR');

CREATE TABLE fiscal_years (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT DEFAULT '',
      status TEXT DEFAULT 'open',
      opening_retained REAL DEFAULT 0,
      opening_receivables REAL DEFAULT 0,
      opening_inventory REAL DEFAULT 0,
      created_by INTEGER,
      closed_by INTEGER,
      closed_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE fixed_asset_depreciation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL,
      period_label TEXT NOT NULL,
      amount_rial INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now')), status TEXT DEFAULT 'posted', je_id INTEGER, reversed_at INTEGER, reversed_by INTEGER, sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(asset_id) REFERENCES fixed_assets(id)
    );

CREATE TABLE fixed_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT DEFAULT '',
      purchase_date TEXT DEFAULT '',
      cost_rial INTEGER NOT NULL DEFAULT 0,
      salvage_rial INTEGER DEFAULT 0,
      useful_life_months INTEGER DEFAULT 60,
      accumulated_depreciation_rial INTEGER DEFAULT 0,
      coa_asset_code TEXT DEFAULT '1201',
      location TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , depreciation_method TEXT DEFAULT 'straight', declining_rate_pct REAL DEFAULT 25, disposed_at INTEGER, dispose_je_id INTEGER, dispose_proceeds_rial INTEGER DEFAULT 0, revaluation_surplus_rial INTEGER DEFAULT 0, sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE followups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cust_id INTEGER NOT NULL,
      date TEXT,
      time TEXT,
      type TEXT,
      subject TEXT,
      note TEXT,
      action TEXT,
      next_date TEXT,
      status TEXT DEFAULT 'open',
      priority TEXT DEFAULT 'mid',
      created_at INTEGER DEFAULT (strftime('%s','now')), interest_level TEXT DEFAULT 'mid', purchase_prob INTEGER DEFAULT 50, pipeline_stage TEXT DEFAULT 'lead', tags TEXT DEFAULT '', lost_reason TEXT DEFAULT '', assigned_to INTEGER, next_time TEXT DEFAULT '', sms_sent INTEGER DEFAULT 0, account_balance REAL DEFAULT 0, sync_seq INTEGER, version INTEGER DEFAULT 0, opportunity_id INTEGER, party_id INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(cust_id) REFERENCES customers(id)
    );

CREATE TABLE global_seq (
      id INTEGER PRIMARY KEY CHECK (id=1),
      value INTEGER NOT NULL DEFAULT 0
    );

CREATE TABLE goods_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      num TEXT NOT NULL,
      purchase_order_id INTEGER NOT NULL,
      supplier_id INTEGER,
      date TEXT,
      status TEXT NOT NULL DEFAULT 'posted',
      branch_id INTEGER,
      warehouse_id INTEGER,
      rows TEXT NOT NULL DEFAULT '[]',
      note TEXT DEFAULT '',
      journal_id INTEGER,
      reversal_journal_id INTEGER,
      created_by INTEGER,
      reversed_at INTEGER,
      reversed_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE group_salary_structures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_group_id INTEGER NOT NULL,
      fiscal_year INTEGER NOT NULL,
      wage_basis TEXT NOT NULL DEFAULT 'monthly'
        CHECK(wage_basis IN ('monthly','daily','hourly','contractor')),
      base_wage_rial INTEGER NOT NULL DEFAULT 0,
      housing_allowance_rial INTEGER NOT NULL DEFAULT 0,
      grocery_allowance_rial INTEGER NOT NULL DEFAULT 0,
      child_allowance_rial INTEGER NOT NULL DEFAULT 0,
      spouse_allowance_rial INTEGER NOT NULL DEFAULT 0,
      other_fixed_allowance_rial INTEGER NOT NULL DEFAULT 0,
      child_count INTEGER NOT NULL DEFAULT 0,
      marital_status INTEGER NOT NULL DEFAULT 0,
      insurance_type TEXT NOT NULL DEFAULT 'sso'
        CHECK(insurance_type IN ('sso','armed_forces','none')),
      tax_exemption_type TEXT NOT NULL DEFAULT 'none'
        CHECK(tax_exemption_type IN ('none','tax_exempt','veteran','petroleum_zones')),
      tax_exemption_percent_bp INTEGER NOT NULL DEFAULT 0,
      overtime_factor_bp INTEGER NOT NULL DEFAULT 14000,
      night_shift_factor_bp INTEGER NOT NULL DEFAULT 11500,
      active INTEGER NOT NULL DEFAULT 1,
      effective_from TEXT,
      effective_to TEXT,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      UNIQUE(employee_group_id, fiscal_year),
      FOREIGN KEY(employee_group_id) REFERENCES employee_groups(id)
    );

CREATE TABLE incentive_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rep_id INTEGER NOT NULL,
      amount REAL DEFAULT 0,
      pay_type TEXT DEFAULT 'cash',
      date TEXT,
      note TEXT,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')), bank_id INTEGER, check_category_id INTEGER, cash_box_id INTEGER, sync_seq INTEGER, version INTEGER DEFAULT 0, status TEXT NOT NULL DEFAULT 'posted', reversal_journal_id INTEGER, reversed_at INTEGER, reversed_by INTEGER,
      FOREIGN KEY(rep_id) REFERENCES users(id)
    );

CREATE TABLE inventory_batches (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_no          TEXT NOT NULL,
      product_id        INTEGER NOT NULL,
      warehouse_id      INTEGER,
      supplier_batch    TEXT DEFAULT '',
      mfg_date          TEXT DEFAULT '',
      expiry_date       TEXT DEFAULT '',
      best_before       TEXT DEFAULT '',
      quality_grade     TEXT DEFAULT '',
      qty_on_hand       REAL NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'active',
      note              TEXT DEFAULT '',
      created_by        INTEGER,
      created_at        INTEGER DEFAULT (strftime('%s','now')), kind TEXT DEFAULT 'generic', color TEXT DEFAULT '', pattern TEXT DEFAULT '', width_cm INTEGER DEFAULT 0, unit TEXT DEFAULT '', unit_cost_rial INTEGER DEFAULT 0, supplier_id INTEGER, qty_received REAL DEFAULT 0, ledger_id INTEGER, journal_id INTEGER, idempotency_key TEXT, reversed_at INTEGER, reversed_by INTEGER, reversal_journal_id INTEGER, source_type TEXT, source_id INTEGER, sync_seq INTEGER, version INTEGER DEFAULT 0,
      UNIQUE(product_id, batch_no)
    );

CREATE TABLE inventory_cost_layers (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id        INTEGER NOT NULL,
      warehouse_id      INTEGER,
      batch_id          INTEGER,
      qty_remaining     REAL NOT NULL DEFAULT 0,
      unit_cost_rial    INTEGER NOT NULL DEFAULT 0,
      amount_rial       INTEGER NOT NULL DEFAULT 0,
      source_type       TEXT DEFAULT '',
      source_id         INTEGER,
      ledger_id         INTEGER,
      received_at       INTEGER DEFAULT (strftime('%s','now')),
      status            TEXT NOT NULL DEFAULT 'open',
      created_at        INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE inventory_ledger (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_no             TEXT NOT NULL,
      event_type        TEXT NOT NULL,
      product_id        INTEGER NOT NULL,
      warehouse_id      INTEGER,
      qty_in            REAL NOT NULL DEFAULT 0,
      qty_out           REAL NOT NULL DEFAULT 0,
      qty_balance       REAL NOT NULL DEFAULT 0,
      unit_cost_rial    INTEGER NOT NULL DEFAULT 0,
      amount_rial       INTEGER NOT NULL DEFAULT 0,
      avg_cost_after_rial INTEGER NOT NULL DEFAULT 0,
      batch_id          INTEGER,
      serial_id         INTEGER,
      source_type       TEXT DEFAULT '',
      source_id         INTEGER,
      je_id             INTEGER,
      reversed_of       INTEGER,
      status            TEXT NOT NULL DEFAULT 'posted',
      date              TEXT NOT NULL DEFAULT '',
      note              TEXT DEFAULT '',
      created_by        INTEGER,
      created_at        INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      UNIQUE(tx_no)
    );

CREATE TABLE inventory_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      variant_id INTEGER,
      warehouse_id INTEGER,
      qty_delta REAL NOT NULL,
      doc_type TEXT NOT NULL,
      doc_id INTEGER,
      doc_line INTEGER,
      user_id INTEGER,
      note TEXT DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE inventory_nrv_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provision_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      qty REAL NOT NULL DEFAULT 0,
      cost_rial INTEGER NOT NULL DEFAULT 0,
      nrv_rial INTEGER NOT NULL DEFAULT 0,
      writedown_rial INTEGER NOT NULL DEFAULT 0, sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(provision_id) REFERENCES inventory_nrv_provisions(id),
      FOREIGN KEY(product_id) REFERENCES products(id)
    );

CREATE TABLE inventory_nrv_provisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      as_of_date TEXT NOT NULL,
      total_rial INTEGER NOT NULL DEFAULT 0,
      je_id INTEGER,
      notes TEXT DEFAULT '',
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE inventory_reservations (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_no    TEXT NOT NULL UNIQUE,
      kind              TEXT NOT NULL DEFAULT 'sales',
      product_id        INTEGER NOT NULL,
      warehouse_id      INTEGER,
      qty               REAL NOT NULL,
      qty_released      REAL NOT NULL DEFAULT 0,
      qty_consumed      REAL NOT NULL DEFAULT 0,
      priority          INTEGER NOT NULL DEFAULT 100,
      status            TEXT NOT NULL DEFAULT 'active',
      expires_at        INTEGER,
      source_type       TEXT DEFAULT '',
      source_id         INTEGER,
      batch_id          INTEGER,
      note              TEXT DEFAULT '',
      created_by        INTEGER,
      created_at        INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE inventory_serials (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      serial_no         TEXT NOT NULL,
      product_id        INTEGER NOT NULL,
      warehouse_id      INTEGER,
      batch_id          INTEGER,
      status            TEXT NOT NULL DEFAULT 'available',
      warranty_until    TEXT DEFAULT '',
      owner_party_id    INTEGER,
      source_type       TEXT DEFAULT '',
      source_id         INTEGER,
      note              TEXT DEFAULT '',
      created_by        INTEGER,
      created_at        INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      UNIQUE(product_id, serial_no)
    );

CREATE TABLE invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cust_id INTEGER NOT NULL,
      num TEXT,
      type TEXT DEFAULT 'proforma',
      date TEXT,
      note TEXT,
      rows TEXT,
      subtotal REAL DEFAULT 0,
      disc REAL DEFAULT 0,
      disc_amt REAL DEFAULT 0,
      final REAL DEFAULT 0,
      seller_name TEXT,
      seller_phone TEXT,
      converted INTEGER DEFAULT 0,
      pay_type TEXT DEFAULT 'cash',
      cheque_duration TEXT DEFAULT '',
      cheque_due_date TEXT DEFAULT '',
      cheque_info TEXT DEFAULT '',
      stock_deducted INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')), approved INTEGER DEFAULT 0, approved_at INTEGER, approved_by INTEGER, pay_splits_json TEXT, pay_amount_rial INTEGER DEFAULT 0, pos_terminal_id INTEGER, sales_channel TEXT DEFAULT '', lead_source TEXT DEFAULT '', campaign TEXT DEFAULT '', sync_seq INTEGER, version INTEGER DEFAULT 0, deleted_at INTEGER, deleted_by INTEGER, mahak_doc_no TEXT, mahak_doc_type TEXT, status TEXT NOT NULL DEFAULT 'posted', reversal_journal_id INTEGER, reversed_at INTEGER, reversed_by INTEGER, mahak_invoice_code TEXT, atf_no TEXT, settlement_date TEXT, freight_amount REAL DEFAULT 0, freight_type TEXT, settled_amount REAL DEFAULT 0, balance_due REAL DEFAULT 0, driver TEXT, entry_method TEXT, delivery_date TEXT, delivered INTEGER DEFAULT 0, settlement_status TEXT, settlement_type TEXT, invoice_address TEXT, visitor TEXT, party_id INTEGER, warehouse_id INTEGER, vat_exempt INTEGER DEFAULT 0, bank_id INTEGER, cash_box_id INTEGER, cost_center_id INTEGER, check_category_id INTEGER, vat_amount REAL DEFAULT 0, vat_rate REAL DEFAULT 10, vat_amount_rial INTEGER DEFAULT 0, moadian_tax_id TEXT, moadian_status TEXT DEFAULT 'not_sent', doc_status TEXT DEFAULT 'confirmed', final_rial INTEGER DEFAULT 0, subtotal_rial INTEGER DEFAULT 0, freight_alloc_method TEXT DEFAULT 'amount', moadian_invoice_type INTEGER DEFAULT 1, buyer_economic_code TEXT, moadian_ref_tax_id TEXT, moadian_correction_type TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(cust_id) REFERENCES customers(id)
    );

CREATE TABLE journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_date TEXT NOT NULL,
      description TEXT,
      ref_type TEXT,
      ref_id INTEGER,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')), cost_center_id INTEGER, attachment TEXT, sync_seq INTEGER, version INTEGER DEFAULT 0, deleted_at INTEGER, deleted_by INTEGER, src_system TEXT, src_doc_no TEXT, src_atf TEXT, fiscal_year_id INTEGER, voucher_number TEXT, voucher_type TEXT DEFAULT 'auto', status TEXT DEFAULT 'approved', total_debit_rial INTEGER DEFAULT 0, total_credit_rial INTEGER DEFAULT 0, doc_type TEXT, is_closing INTEGER DEFAULT 0,
      FOREIGN KEY(created_by) REFERENCES users(id)
    );

CREATE TABLE journal_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER NOT NULL,
      account_code TEXT NOT NULL,
      account_name TEXT NOT NULL,
      debit REAL DEFAULT 0,
      credit REAL DEFAULT 0,
      description TEXT, sync_seq INTEGER, version INTEGER DEFAULT 0, line_no INTEGER DEFAULT 0, detail_account_id INTEGER, debit_rial INTEGER DEFAULT 0, credit_rial INTEGER DEFAULT 0, cost_center_id INTEGER, project_id INTEGER, tax_type TEXT, tafsili2_code TEXT,
      FOREIGN KEY(entry_id) REFERENCES journal_entries(id)
    );

CREATE TABLE journal_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      lines_json TEXT NOT NULL,
      cost_center_id INTEGER,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE landed_cost_allocations (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id            INTEGER NOT NULL,
      product_id        INTEGER NOT NULL,
      warehouse_id      INTEGER,
      qty               REAL NOT NULL DEFAULT 0,
      base_value_rial   INTEGER NOT NULL DEFAULT 0,
      allocated_rial    INTEGER NOT NULL DEFAULT 0,
      ledger_id         INTEGER, sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(doc_id) REFERENCES landed_cost_docs(id) ON DELETE CASCADE
    );

CREATE TABLE landed_cost_docs (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_no            TEXT NOT NULL UNIQUE,
      purchase_id       INTEGER,
      date              TEXT NOT NULL DEFAULT '',
      currency          TEXT DEFAULT 'IRR',
      status            TEXT NOT NULL DEFAULT 'draft',
      alloc_method      TEXT NOT NULL DEFAULT 'value',
      total_cost_rial   INTEGER NOT NULL DEFAULT 0,
      je_id             INTEGER,
      note              TEXT DEFAULT '',
      created_by        INTEGER,
      created_at        INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE landed_cost_lines (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id            INTEGER NOT NULL,
      cost_type         TEXT NOT NULL,
      amount_rial       INTEGER NOT NULL DEFAULT 0,
      note              TEXT DEFAULT '', sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(doc_id) REFERENCES landed_cost_docs(id) ON DELETE CASCADE
    );

CREATE TABLE legal_reserve_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fiscal_year_id INTEGER,
      profit_rial INTEGER NOT NULL DEFAULT 0,
      reserve_rial INTEGER NOT NULL DEFAULT 0,
      capital_rial INTEGER NOT NULL DEFAULT 0,
      je_id INTEGER,
      date TEXT,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE license_activations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      license_id INTEGER NOT NULL,
      device_fingerprint TEXT NOT NULL,
      activated_at TEXT NOT NULL,
      deactivated_at TEXT,
      FOREIGN KEY(license_id) REFERENCES licenses(id)
    );

CREATE TABLE licenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      license_uid TEXT NOT NULL UNIQUE,
      customer TEXT NOT NULL,
      edition TEXT NOT NULL,
      max_users INTEGER NOT NULL DEFAULT 0,
      max_devices INTEGER NOT NULL DEFAULT 0,
      expiry TEXT NOT NULL,
      grace_days INTEGER NOT NULL DEFAULT 14,
      feature_flags TEXT NOT NULL DEFAULT '{}',
      payload_json TEXT NOT NULL,
      signature TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      activated_at TEXT,
      deactivated_at TEXT,
      created_at TEXT NOT NULL
    );

CREATE TABLE marketer_carts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      items_json TEXT DEFAULT '[]',
      updated_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      UNIQUE(user_id)
    );

CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id INTEGER NOT NULL,
      to_id INTEGER,
      body TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')), image TEXT, sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(from_id) REFERENCES users(id)
    );

CREATE TABLE moadian_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_type TEXT NOT NULL,
      doc_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      tax_id TEXT,
      response_json TEXT,
      error_message TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      sent_at INTEGER, invoice_type INTEGER DEFAULT 1, adapter TEXT DEFAULT 'stub', retry_count INTEGER DEFAULT 0, next_retry_at INTEGER, last_error TEXT, status_notes TEXT,
      UNIQUE(doc_type, doc_id)
    );

CREATE TABLE moadian_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_id INTEGER NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_at INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY(queue_id) REFERENCES moadian_queue(id)
);

CREATE TABLE mrp_requirements (
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
      created_at       INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(run_id) REFERENCES mrp_runs(id) ON DELETE CASCADE
    );

CREATE TABLE mrp_runs (
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
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE number_sequences (
    key TEXT PRIMARY KEY,
    current_value INTEGER NOT NULL DEFAULT 0
  );

CREATE TABLE op_departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      manager_person_id INTEGER NOT NULL,
      warehouse_id INTEGER NOT NULL,
      sequence_order INTEGER NOT NULL,
      status TEXT DEFAULT 'active',
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(unit_id) REFERENCES op_units(id),
      FOREIGN KEY(warehouse_id) REFERENCES warehouses(id)
    );

CREATE TABLE op_dept_capabilities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      department_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1, sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(department_id) REFERENCES op_departments(id)
    );

CREATE TABLE op_dept_delegations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      department_id INTEGER NOT NULL,
      delegate_person_id INTEGER NOT NULL,
      starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,
      note TEXT DEFAULT '',
      created_by INTEGER,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(department_id) REFERENCES op_departments(id),
      FOREIGN KEY(delegate_person_id) REFERENCES persons(id)
    );

CREATE TABLE op_dept_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      department_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1, sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(department_id) REFERENCES op_departments(id)
    );

CREATE TABLE op_field_followups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      field_key TEXT NOT NULL,
      note TEXT NOT NULL,
      person_id INTEGER,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE op_parameter_dept_log (
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
      created_at INTEGER DEFAULT (strftime('%s','now')), payment_note TEXT DEFAULT '', review_requested_at INTEGER, sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(parameter_id) REFERENCES op_parameters(id),
      FOREIGN KEY(department_id) REFERENCES op_departments(id)
    );

CREATE TABLE op_parameter_extra_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parameter_id INTEGER NOT NULL,
      description TEXT NOT NULL,
      amount_rial INTEGER NOT NULL,
      expense_category_id INTEGER,
      journal_id INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(parameter_id) REFERENCES op_parameters(id)
    );

CREATE TABLE op_parameter_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parameter_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity REAL NOT NULL,
      unit_of_measure TEXT DEFAULT '', sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(parameter_id) REFERENCES op_parameters(id),
      FOREIGN KEY(product_id) REFERENCES products(id)
    );

CREATE TABLE op_parameters (
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
      completed_at INTEGER, sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(unit_id) REFERENCES op_units(id)
    );

CREATE TABLE op_unit_module_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id INTEGER NOT NULL,
      module_key TEXT NOT NULL, sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(unit_id) REFERENCES op_units(id)
    );

CREATE TABLE op_unit_persons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id INTEGER NOT NULL,
      person_id INTEGER NOT NULL, sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(unit_id) REFERENCES op_units(id),
      FOREIGN KEY(person_id) REFERENCES persons(id)
    );

CREATE TABLE op_unit_warehouses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id INTEGER NOT NULL,
      warehouse_id INTEGER NOT NULL, sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(unit_id) REFERENCES op_units(id),
      FOREIGN KEY(warehouse_id) REFERENCES warehouses(id)
    );

CREATE TABLE op_units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      manager_person_id INTEGER NOT NULL,
      manager2_person_id INTEGER,
      manager3_person_id INTEGER,
      output_type TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER, sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(manager_person_id) REFERENCES persons(id)
    );

CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cust_id INTEGER NOT NULL,
      product_id INTEGER,
      date TEXT,
      type TEXT,
      qty INTEGER DEFAULT 0,
      total REAL DEFAULT 0,
      paid REAL DEFAULT 0,
      pay TEXT,
      deliver TEXT,
      status TEXT DEFAULT 'pending',
      note TEXT,
      stock_deducted INTEGER DEFAULT 0,
      warehouse_id INTEGER,
      reservation_id INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(cust_id) REFERENCES customers(id)
    );

CREATE TABLE overhead_allocation_rules (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      expense_match  TEXT DEFAULT '',
      basis          TEXT NOT NULL,
      active         INTEGER DEFAULT 1,
      created_at     INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE overhead_allocation_weights (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id        INTEGER NOT NULL,
      cost_center_id INTEGER NOT NULL,
      weight         REAL NOT NULL DEFAULT 0, sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(rule_id) REFERENCES overhead_allocation_rules(id) ON DELETE CASCADE,
      FOREIGN KEY(cost_center_id) REFERENCES cost_centers(id)
    );

CREATE TABLE parties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_code TEXT UNIQUE NOT NULL,
      party_type TEXT NOT NULL DEFAULT 'customer',
      legal_type TEXT DEFAULT 'real',
      full_name TEXT NOT NULL,
      company_name TEXT,
      national_id TEXT,
      economic_code TEXT,
      phone TEXT NOT NULL,
      secondary_phone TEXT,
      email TEXT,
      city TEXT,
      province TEXT,
      address TEXT,
      postal_code TEXT,
      store_type TEXT,
      segment TEXT DEFAULT 'C',
      source TEXT,
      detail_account_id INTEGER REFERENCES detail_accounts(id),
      credit_limit INTEGER DEFAULT 0,
      opening_balance INTEGER DEFAULT 0,
      opening_balance_date TEXT,
      notes TEXT,
      is_active INTEGER DEFAULT 1,
      legacy_table TEXT,
      legacy_id INTEGER,
      user_id INTEGER,
      biz TEXT,
      owner TEXT,
      insta TEXT,
      status TEXT DEFAULT 'new',
      type TEXT DEFAULT 'بوتیک',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER
    , position_id INTEGER, party_group_id INTEGER, prefix TEXT, fax TEXT, mobile TEXT, birth_date TEXT, referrer TEXT, account_nature TEXT, coa_code TEXT, party_roles TEXT, sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE party_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL UNIQUE,
      entity_type TEXT NOT NULL DEFAULT 'all',
      description TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , is_marketer INTEGER DEFAULT 0, sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE password_reset_otps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

CREATE TABLE payroll_labor_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL UNIQUE,
      min_wage_daily_rial INTEGER NOT NULL DEFAULT 0,
      housing_allowance_rial INTEGER NOT NULL DEFAULT 0,
      food_allowance_rial INTEGER NOT NULL DEFAULT 0,
      child_allowance_rial INTEGER NOT NULL DEFAULT 0,
      seniority_base_rial INTEGER NOT NULL DEFAULT 0,
      insurance_cap_monthly_rial INTEGER NOT NULL DEFAULT 0,
      overtime_factor REAL NOT NULL DEFAULT 1.4,
      night_factor REAL NOT NULL DEFAULT 1.35,
      friday_factor REAL NOT NULL DEFAULT 1.4,
      shift_factor REAL NOT NULL DEFAULT 1.225,
      tax_exemption_rial INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE payroll_labor_settings_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      min_daily_wage_rial INTEGER NOT NULL DEFAULT 0,
      housing_allowance_rial INTEGER NOT NULL DEFAULT 0,
      grocery_allowance_rial INTEGER NOT NULL DEFAULT 0,
      child_allowance_rial INTEGER NOT NULL DEFAULT 0,
      seniority_daily_rial INTEGER NOT NULL DEFAULT 0,
      insurance_base_cap_rial INTEGER NOT NULL DEFAULT 0,
      tax_exemption_rial INTEGER NOT NULL DEFAULT 0,
      overtime_factor_bp INTEGER NOT NULL DEFAULT 14000,
      night_factor_bp INTEGER NOT NULL DEFAULT 13500,
      friday_factor_bp INTEGER NOT NULL DEFAULT 14000,
      shift_factor_bp INTEGER NOT NULL DEFAULT 0,
      note TEXT DEFAULT '',
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

CREATE TABLE payroll_monthly_accruals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_label TEXT NOT NULL,
      person_id INTEGER,
      severance_rial INTEGER NOT NULL DEFAULT 0,
      eidi_rial INTEGER NOT NULL DEFAULT 0,
      je_id INTEGER,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE payroll_periods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fiscal_year INTEGER NOT NULL,
      month_no INTEGER NOT NULL CHECK(month_no BETWEEN 1 AND 12),
      label TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      standard_days INTEGER NOT NULL DEFAULT 30,
      standard_hours_x100 INTEGER NOT NULL DEFAULT 22000,
      employee_insurance_bp INTEGER NOT NULL DEFAULT 700,
      employer_insurance_bp INTEGER NOT NULL DEFAULT 2300,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','processed','closed')),
      processed_at INTEGER,
      closed_at INTEGER,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')), params_json TEXT, params_snapshot_json TEXT, sync_seq INTEGER, version INTEGER DEFAULT 0,
      UNIQUE(fiscal_year, month_no)
    );

CREATE TABLE payroll_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL,
      period_label TEXT DEFAULT '',
      regular_hours REAL DEFAULT 0,
      overtime_hours REAL DEFAULT 0,
      hourly_rate REAL DEFAULT 0,
      overtime_rate REAL DEFAULT 0,
      bonuses REAL DEFAULT 0,
      deductions REAL DEFAULT 0,
      insurance_deduction REAL DEFAULT 0,
      tax_deduction REAL DEFAULT 0,
      gross_pay REAL DEFAULT 0,
      net_pay REAL DEFAULT 0,
      date TEXT DEFAULT '',
      note TEXT DEFAULT '',
      paid INTEGER DEFAULT 0,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0, mahak_doc_no TEXT, mahak_doc_type TEXT, production_linked INTEGER DEFAULT 0, cost_center_id INTEGER, period_id INTEGER, working_days_x100 INTEGER DEFAULT 0, regular_hours_x100 INTEGER DEFAULT 0, overtime_hours_x100 INTEGER DEFAULT 0, night_shift_hours_x100 INTEGER DEFAULT 0, base_pay_rial INTEGER DEFAULT 0, housing_allowance_rial INTEGER DEFAULT 0, grocery_allowance_rial INTEGER DEFAULT 0, child_allowance_rial INTEGER DEFAULT 0, spouse_allowance_rial INTEGER DEFAULT 0, hardship_allowance_rial INTEGER DEFAULT 0, other_allowance_rial INTEGER DEFAULT 0, overtime_pay_rial INTEGER DEFAULT 0, night_shift_pay_rial INTEGER DEFAULT 0, gross_earnings_rial INTEGER DEFAULT 0, insurance_base_rial INTEGER DEFAULT 0, taxable_income_rial INTEGER DEFAULT 0, income_tax_rial INTEGER DEFAULT 0, sso_employee_rial INTEGER DEFAULT 0, sso_employer_rial INTEGER DEFAULT 0, other_deductions_rial INTEGER DEFAULT 0, net_pay_rial INTEGER DEFAULT 0, employer_cost_rial INTEGER DEFAULT 0, status TEXT DEFAULT 'posted', journal_entry_id INTEGER, payment_journal_id INTEGER, reversal_journal_id INTEGER, paid_at INTEGER, reversed_at INTEGER);

CREATE TABLE payroll_tax_brackets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fiscal_year INTEGER NOT NULL,
      bracket_order INTEGER NOT NULL,
      bracket_min_rial INTEGER NOT NULL DEFAULT 0,
      bracket_max_rial INTEGER,
      tax_rate_bp INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      UNIQUE(fiscal_year, bracket_order)
    );

CREATE TABLE payroll_year_end_bonuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL,
      fiscal_year INTEGER NOT NULL,
      service_days INTEGER NOT NULL DEFAULT 365,
      eidi_rial INTEGER NOT NULL DEFAULT 0,
      severance_rial INTEGER NOT NULL DEFAULT 0,
      tax_exempt_rial INTEGER NOT NULL DEFAULT 0,
      taxable_rial INTEGER NOT NULL DEFAULT 0,
      income_tax_rial INTEGER NOT NULL DEFAULT 0,
      net_pay_rial INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','posted','paid','reversed')),
      journal_entry_id INTEGER,
      reversal_journal_id INTEGER,
      posted_at INTEGER,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      UNIQUE(person_id, fiscal_year),
      FOREIGN KEY(person_id) REFERENCES persons(id)
    );

CREATE TABLE person_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      nature TEXT NOT NULL DEFAULT 'debit',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0, is_shared INTEGER NOT NULL DEFAULT 1);

CREATE TABLE person_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      ref_type TEXT,
      ref_id INTEGER,
      description TEXT,
      debit REAL DEFAULT 0,
      credit REAL DEFAULT 0,
      user_id INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(person_id) REFERENCES persons(id)
    );

CREATE TABLE person_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE persons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      address TEXT DEFAULT '',
      note TEXT DEFAULT '',
      credit_limit REAL DEFAULT 0,
      debit_limit REAL DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')), employee_no TEXT, card_no TEXT, hourly_rate REAL DEFAULT 0, overtime_rate REAL DEFAULT 0, insurance_percent REAL DEFAULT 0, tax_percent REAL DEFAULT 0, sync_seq INTEGER, version INTEGER DEFAULT 0, coa_code TEXT, party_group_id INTEGER, mahak_op_code TEXT, prefix TEXT, phone2 TEXT, fax TEXT, mobile TEXT, email TEXT, economic_code TEXT, postal_code TEXT, national_id TEXT, referrer TEXT, birth_date TEXT, company_name TEXT, account_nature TEXT, party_id INTEGER, hire_date TEXT, salary_type TEXT DEFAULT 'hourly', monthly_salary_rial INTEGER DEFAULT 0, department TEXT, bank_iban TEXT, cost_center_id INTEGER, labor_method TEXT DEFAULT 'piece', personnel_code TEXT, first_name TEXT, last_name TEXT, insurance_id TEXT, tax_id TEXT, employment_type TEXT, termination_date TEXT, tax_exemption_type TEXT, insurance_type TEXT, is_tax_exempt INTEGER DEFAULT 0, employee_group_id INTEGER, position_id INTEGER,
      FOREIGN KEY(category_id) REFERENCES person_categories(id)
    );

CREATE TABLE pos_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      terminal_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      amount_rial INTEGER NOT NULL,
      settled_rial INTEGER DEFAULT 0,
      invoice_id INTEGER,
      cust_id INTEGER,
      settlement_id INTEGER,
      journal_id INTEGER,
      status TEXT DEFAULT 'open',
      idempotency_key TEXT,
      ref TEXT,
      note TEXT,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      reversed_at INTEGER,
      reversed_by INTEGER,
      reversal_journal_id INTEGER, sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(terminal_id) REFERENCES pos_terminals(id)
    );

CREATE TABLE pos_settlement_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      terminal_id INTEGER,
      date TEXT NOT NULL,
      gross_rial INTEGER NOT NULL,
      fee_rial INTEGER DEFAULT 0,
      shortage_rial INTEGER DEFAULT 0,
      net_rial INTEGER NOT NULL,
      bank_id INTEGER NOT NULL,
      journal_id INTEGER,
      status TEXT DEFAULT 'posted',
      idempotency_key TEXT,
      ref TEXT,
      note TEXT,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      reversed_at INTEGER,
      reversed_by INTEGER,
      reversal_journal_id INTEGER
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE pos_settlement_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      receipt_id INTEGER NOT NULL,
      amount_rial INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE pos_terminals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      terminal_id TEXT NOT NULL,
      merchant_id TEXT,
      bank_id INTEGER NOT NULL,
      active INTEGER DEFAULT 1,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(bank_id) REFERENCES banks(id)
    );

CREATE TABLE pricing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL DEFAULT 'global',
      scope_id INTEGER,
      wholesale_markup_pct REAL NOT NULL DEFAULT 20,
      retail_markup_pct REAL NOT NULL DEFAULT 35,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE product_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0, code INTEGER, parent_id INTEGER, description TEXT, is_shared INTEGER NOT NULL DEFAULT 1, created_by INTEGER, coa_code TEXT);

CREATE TABLE product_colors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT,
      name TEXT NOT NULL,
      hex TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE product_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(product_id) REFERENCES products(id)
    );

CREATE TABLE product_sizes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE product_style_colors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      color_id INTEGER NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      UNIQUE(product_id, color_id),
      FOREIGN KEY(product_id) REFERENCES products(id),
      FOREIGN KEY(color_id) REFERENCES product_colors(id)
    );

CREATE TABLE product_style_sizes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      size_id INTEGER NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      UNIQUE(product_id, size_id),
      FOREIGN KEY(product_id) REFERENCES products(id),
      FOREIGN KEY(size_id) REFERENCES product_sizes(id)
    );

CREATE TABLE product_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      color_id INTEGER,
      size_id INTEGER,
      sku TEXT,
      barcode TEXT,
      price REAL DEFAULT 0,
      price_rial INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      stock REAL DEFAULT 0,
      weight REAL DEFAULT 0,
      status TEXT DEFAULT 'active',
      is_default INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      note TEXT DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(product_id) REFERENCES products(id),
      FOREIGN KEY(color_id) REFERENCES product_colors(id),
      FOREIGN KEY(size_id) REFERENCES product_sizes(id)
    );

CREATE TABLE production_estimate_lines (
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
      created_at         INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(estimate_id) REFERENCES production_estimates(id) ON DELETE CASCADE
    );

CREATE TABLE production_estimates (
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
      created_at          INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(product_id) REFERENCES products(id),
      FOREIGN KEY(bom_id) REFERENCES bom_headers(id)
    );

CREATE TABLE production_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type   TEXT NOT NULL,
      entity_type  TEXT NOT NULL,
      entity_id    INTEGER,
      payload_json TEXT DEFAULT '',
      processed    INTEGER DEFAULT 0,
      created_at   INTEGER DEFAULT (strftime('%s','now'))
    );

CREATE TABLE production_idempotency (
      key          TEXT PRIMARY KEY,
      endpoint     TEXT NOT NULL,
      user_id      INTEGER,
      response_json TEXT DEFAULT '',
      created_at   INTEGER DEFAULT (strftime('%s','now'))
    );

CREATE TABLE production_labor_entries (
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
      created_at       INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(order_id) REFERENCES production_orders(id)
    );

CREATE TABLE production_material_issues (
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
      created_at       INTEGER DEFAULT (strftime('%s','now')), variance_status TEXT DEFAULT 'memo', sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(order_id) REFERENCES production_orders(id),
      FOREIGN KEY(product_id) REFERENCES products(id)
    );

CREATE TABLE production_order_stages (
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
      created_at         INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(order_id) REFERENCES production_orders(id) ON DELETE CASCADE,
      FOREIGN KEY(cost_center_id) REFERENCES cost_centers(id)
    );

CREATE TABLE production_orders (
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
      updated_at         INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(product_id) REFERENCES products(id),
      FOREIGN KEY(bom_id) REFERENCES bom_headers(id),
      FOREIGN KEY(cost_center_id) REFERENCES cost_centers(id)
    );

CREATE TABLE production_overhead_applications (
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
      created_at       INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(order_id) REFERENCES production_orders(id),
      FOREIGN KEY(cost_center_id) REFERENCES cost_centers(id)
    );

CREATE TABLE production_period_close (
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
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE production_receipts (
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
      created_at       INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(order_id) REFERENCES production_orders(id),
      FOREIGN KEY(product_id) REFERENCES products(id)
    );

CREATE TABLE production_reservations (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id       INTEGER NOT NULL,
      product_id     INTEGER NOT NULL,
      warehouse_id   INTEGER NOT NULL,
      qty            REAL NOT NULL,
      qty_consumed   REAL DEFAULT 0,
      status         TEXT DEFAULT 'active',
      date           TEXT DEFAULT '',
      created_at     INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(order_id) REFERENCES production_orders(id) ON DELETE CASCADE
    );

CREATE TABLE production_rework (
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
      created_at       INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(order_id) REFERENCES production_orders(id)
    );

CREATE TABLE production_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      qty_produced INTEGER NOT NULL,
      material_cost REAL DEFAULT 0,
      labor_cost REAL DEFAULT 0,
      overhead_cost REAL DEFAULT 0,
      packaging_cost REAL DEFAULT 0,
      waste_qty INTEGER DEFAULT 0,
      waste_cost REAL DEFAULT 0,
      date TEXT DEFAULT '',
      note TEXT DEFAULT '',
      stock_added INTEGER DEFAULT 0,
      cost_updated INTEGER DEFAULT 0,
      previous_cost REAL,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , warehouse_id INTEGER, sync_seq INTEGER, version INTEGER DEFAULT 0, migrated_to_order_id INTEGER, legacy INTEGER DEFAULT 1, voided INTEGER DEFAULT 0);

CREATE TABLE production_subcontract (
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
      created_at        INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(order_id) REFERENCES production_orders(id),
      FOREIGN KEY(supplier_id) REFERENCES suppliers(id)
    );

CREATE TABLE production_variances (
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
      created_at      INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(order_id) REFERENCES production_orders(id)
    );

CREATE TABLE production_waste (
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
      created_at       INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(order_id) REFERENCES production_orders(id)
    );

CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      category TEXT,
      code TEXT,
      name TEXT NOT NULL,
      price REAL DEFAULT 0,
      stock INTEGER DEFAULT 0,
      stock_alert INTEGER DEFAULT 5,
      image TEXT,
      unit TEXT DEFAULT 'عدد',
      note TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')), colors INTEGER DEFAULT 1, pack_size INTEGER DEFAULT 1, cost REAL DEFAULT 0, warehouse_id INTEGER, category_id INTEGER, brand TEXT DEFAULT '', sync_seq INTEGER, version INTEGER DEFAULT 0, barcode TEXT, coa_code TEXT, needs_qty INTEGER DEFAULT 0, mahak_op_code TEXT, full_name TEXT, product_type TEXT, product_index TEXT, tax_id TEXT, consumer_price REAL DEFAULT 0, location TEXT, opening_price REAL DEFAULT 0, sms_code TEXT, unit_id INTEGER, vat_class TEXT DEFAULT 'standard', reorder_point INTEGER DEFAULT 12, costing_method TEXT DEFAULT 'moving_average', average_cost_rial INTEGER DEFAULT 0, price_rial INTEGER DEFAULT 0, item_type TEXT DEFAULT 'finished', is_manufactured INTEGER DEFAULT 0, default_bom_id INTEGER, default_warehouse_id INTEGER, std_cost_rial INTEGER DEFAULT 0, last_prod_cost_rial INTEGER DEFAULT 0, lead_time_days INTEGER DEFAULT 0, min_order_qty REAL DEFAULT 0, safety_stock REAL DEFAULT 0, scrap_percent REAL DEFAULT 0, track_batch INTEGER DEFAULT 0, track_serial INTEGER DEFAULT 0, max_stock REAL DEFAULT 0, retail_price REAL DEFAULT 0, retail_price_rial INTEGER DEFAULT 0, tax_stuff_id TEXT, approval_status TEXT DEFAULT 'approved', images_json TEXT DEFAULT '[]', is_style INTEGER DEFAULT 1, has_variants INTEGER DEFAULT 0, default_variant_id INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      start_date TEXT,
      end_date TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE purchase_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      supplier_id INTEGER NOT NULL,
      num TEXT,
      date TEXT,
      note TEXT,
      rows TEXT,
      subtotal REAL DEFAULT 0,
      disc REAL DEFAULT 0,
      disc_amt REAL DEFAULT 0,
      final REAL DEFAULT 0,
      pay_type TEXT DEFAULT 'credit',
      cheque_duration TEXT DEFAULT '',
      cheque_due_date TEXT DEFAULT '',
      cheque_info TEXT DEFAULT '',
      stock_added INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')), bank_id INTEGER, check_category_id INTEGER, cash_box_id INTEGER, pay_splits_json TEXT, pay_amount_rial INTEGER DEFAULT 0, sync_seq INTEGER, version INTEGER DEFAULT 0, mahak_doc_no TEXT, mahak_doc_type TEXT, status TEXT NOT NULL DEFAULT 'posted', reversal_journal_id INTEGER, reversed_at INTEGER, reversed_by INTEGER, atf_no TEXT, settled_amount REAL DEFAULT 0, balance_due REAL DEFAULT 0, settlement_status TEXT, freight_amount INTEGER DEFAULT 0, freight_type TEXT, vat_exempt INTEGER DEFAULT 0, cost_center_id INTEGER, vat_amount REAL DEFAULT 0, vat_rate REAL DEFAULT 10, warehouse_id INTEGER, goods_receipt_id INTEGER, purchase_order_id INTEGER, freight_alloc_method TEXT DEFAULT 'amount',
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(supplier_id) REFERENCES suppliers(id)
    );

CREATE TABLE purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      num TEXT NOT NULL,
      supplier_id INTEGER NOT NULL,
      rfq_id INTEGER,
      date TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      branch_id INTEGER,
      warehouse_id INTEGER,
      rows TEXT NOT NULL DEFAULT '[]',
      note TEXT DEFAULT '',
      created_by INTEGER,
      approved_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE purchase_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      supplier_id INTEGER NOT NULL,
      purchase_invoice_id INTEGER,
      date TEXT,
      note TEXT,
      rows TEXT,
      amount REAL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0, mahak_doc_no TEXT, mahak_doc_type TEXT, status TEXT NOT NULL DEFAULT 'posted', reversal_journal_id INTEGER, reversed_at INTEGER, reversed_by INTEGER,
      FOREIGN KEY(supplier_id) REFERENCES suppliers(id)
    );

CREATE TABLE reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cust_id INTEGER,
      title TEXT NOT NULL,
      body TEXT,
      remind_at TEXT NOT NULL,
      done INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

CREATE TABLE rep_advances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rep_id INTEGER NOT NULL,
      amount REAL DEFAULT 0,
      pay_type TEXT DEFAULT 'cash',
      date TEXT,
      note TEXT,
      settled_amount REAL DEFAULT 0,
      bank_id INTEGER,
      cash_box_id INTEGER,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(rep_id) REFERENCES users(id)
    );

CREATE TABLE rep_assignment_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      from_rep_id INTEGER,
      to_rep_id INTEGER NOT NULL,
      date TEXT,
      note TEXT,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(customer_id) REFERENCES customers(id),
      FOREIGN KEY(from_rep_id) REFERENCES users(id),
      FOREIGN KEY(to_rep_id) REFERENCES users(id)
    );

CREATE TABLE rep_call_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rep_id INTEGER NOT NULL,
      customer_id INTEGER,
      date TEXT,
      duration_min INTEGER DEFAULT 0,
      outcome TEXT DEFAULT '',
      note TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(rep_id) REFERENCES users(id),
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    );

CREATE TABLE rep_commission_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rep_id INTEGER NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id INTEGER,
      rate_cash REAL DEFAULT 0,
      rate_cheque REAL DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')), scope_label TEXT DEFAULT '', sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(rep_id) REFERENCES users(id)
    );

CREATE TABLE rep_commission_tiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rep_id INTEGER NOT NULL,
      from_amount REAL DEFAULT 0,
      to_amount REAL,
      rate_cash REAL DEFAULT 0,
      rate_cheque REAL DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(rep_id) REFERENCES users(id)
    );

CREATE TABLE rep_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rep_id INTEGER NOT NULL,
      category TEXT DEFAULT 'other',
      amount REAL DEFAULT 0,
      date TEXT,
      description TEXT,
      receipt_file TEXT,
      cost_center_id INTEGER,
      status TEXT DEFAULT 'pending',
      approved_by INTEGER,
      approved_at INTEGER,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(rep_id) REFERENCES users(id)
    );

CREATE TABLE rep_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rep_id INTEGER NOT NULL,
      date TEXT,
      entry_type TEXT NOT NULL,
      ref_type TEXT,
      ref_id INTEGER,
      description TEXT,
      debit REAL DEFAULT 0,
      credit REAL DEFAULT 0,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(rep_id) REFERENCES users(id)
    );

CREATE TABLE rep_payment_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rep_id INTEGER NOT NULL,
      cust_id INTEGER NOT NULL,
      pay_type TEXT DEFAULT 'cash',
      amount REAL DEFAULT 0,
      date TEXT,
      note TEXT,
      receipt_file TEXT,
      cheque_bank TEXT DEFAULT '',
      cheque_sayadi TEXT DEFAULT '',
      cheque_number TEXT DEFAULT '',
      cheque_account TEXT DEFAULT '',
      cheque_amount REAL DEFAULT 0,
      cheque_owner TEXT DEFAULT '',
      cheque_due TEXT DEFAULT '',
      bank_ref TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      settlement_id INTEGER,
      approved_by INTEGER,
      approved_at INTEGER,
      rejection_note TEXT DEFAULT '',
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(rep_id) REFERENCES users(id),
      FOREIGN KEY(cust_id) REFERENCES customers(id)
    );

CREATE TABLE rep_settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rep_id INTEGER NOT NULL,
      date TEXT,
      settlement_type TEXT DEFAULT 'combined',
      commission_paid REAL DEFAULT 0,
      expense_settled REAL DEFAULT 0,
      advance_settled REAL DEFAULT 0,
      total_amount REAL DEFAULT 0,
      balance_before REAL DEFAULT 0,
      balance_after REAL DEFAULT 0,
      note TEXT,
      ref_payment_id INTEGER,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(rep_id) REFERENCES users(id)
    );

CREATE TABLE rep_territories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      rep_id INTEGER,
      cities TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(rep_id) REFERENCES users(id)
    );

CREATE TABLE rep_visit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rep_id INTEGER NOT NULL,
      customer_id INTEGER,
      date TEXT,
      check_in_at INTEGER,
      check_out_at INTEGER,
      lat REAL,
      lng REAL,
      note TEXT,
      signature_file TEXT,
      photo_file TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(rep_id) REFERENCES users(id),
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    );

CREATE TABLE report_configurations (
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
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      UNIQUE(report_name, row_number)
    );

CREATE TABLE rfqs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      num TEXT NOT NULL,
      kind TEXT NOT NULL,
      party_id INTEGER,
      supplier_id INTEGER,
      cust_id INTEGER,
      date TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      branch_id INTEGER,
      rows TEXT NOT NULL DEFAULT '[]',
      note TEXT DEFAULT '',
      created_by INTEGER,
      approved_by INTEGER,
      awarded_at INTEGER,
      journal_id INTEGER,
      status_reason TEXT DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE salary_structures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL,
      fiscal_year INTEGER NOT NULL,
      wage_basis TEXT NOT NULL DEFAULT 'monthly'
        CHECK(wage_basis IN ('monthly','daily','hourly','contractor')),
      base_wage_rial INTEGER NOT NULL DEFAULT 0,
      housing_allowance_rial INTEGER NOT NULL DEFAULT 0,
      grocery_allowance_rial INTEGER NOT NULL DEFAULT 0,
      child_allowance_rial INTEGER NOT NULL DEFAULT 0,
      spouse_allowance_rial INTEGER NOT NULL DEFAULT 0,
      other_fixed_allowance_rial INTEGER NOT NULL DEFAULT 0,
      child_count INTEGER NOT NULL DEFAULT 0,
      marital_status INTEGER NOT NULL DEFAULT 0,
      insurance_type TEXT NOT NULL DEFAULT 'sso'
        CHECK(insurance_type IN ('sso','armed_forces','none')),
      tax_exemption_type TEXT NOT NULL DEFAULT 'none'
        CHECK(tax_exemption_type IN ('none','tax_exempt','veteran','petroleum_zones')),
      tax_exemption_percent_bp INTEGER NOT NULL DEFAULT 0,
      overtime_factor_bp INTEGER NOT NULL DEFAULT 14000,
      night_shift_factor_bp INTEGER NOT NULL DEFAULT 11500,
      active INTEGER NOT NULL DEFAULT 1,
      effective_from TEXT,
      effective_to TEXT,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      UNIQUE(person_id, fiscal_year),
      FOREIGN KEY(person_id) REFERENCES persons(id)
    );

CREATE TABLE sales_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cust_id INTEGER NOT NULL,
      invoice_id INTEGER,
      date TEXT,
      note TEXT,
      rows TEXT,
      amount REAL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0, mahak_doc_no TEXT, mahak_doc_type TEXT, status TEXT NOT NULL DEFAULT 'posted', reversal_journal_id INTEGER, reversed_at INTEGER, reversed_by INTEGER, cost_amount REAL NOT NULL DEFAULT 0,
      FOREIGN KEY(cust_id) REFERENCES customers(id)
    );

CREATE TABLE settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      value TEXT
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cust_id INTEGER NOT NULL,
      invoice_id INTEGER,
      amount REAL DEFAULT 0,
      pay_type TEXT DEFAULT 'cash',
      date TEXT,
      note TEXT,
      cheque_bank TEXT DEFAULT '',
      cheque_sayadi TEXT DEFAULT '',
      cheque_number TEXT DEFAULT '',
      cheque_account TEXT DEFAULT '',
      cheque_amount REAL DEFAULT 0,
      cheque_owner TEXT DEFAULT '',
      cheque_due TEXT DEFAULT '',
      cheque_status TEXT DEFAULT 'pending',
      created_at INTEGER DEFAULT (strftime('%s','now')), cheque_branch TEXT DEFAULT '', cheque_sheba TEXT DEFAULT '', cheque_row INTEGER DEFAULT 0, cost_center_id INTEGER, bank_id INTEGER, check_category_id INTEGER, cash_box_id INTEGER, account_code TEXT DEFAULT '', installment_group TEXT, sync_seq INTEGER, version INTEGER DEFAULT 0, mahak_doc_no TEXT, mahak_doc_type TEXT, status TEXT NOT NULL DEFAULT 'posted', reversal_journal_id INTEGER, reversed_at INTEGER, reversed_by INTEGER, mahak_receipt_code TEXT, atf_no TEXT, invoice_ref TEXT, visitor TEXT, purpose TEXT, cash_amount REAL DEFAULT 0, cheque_total REAL DEFAULT 0, transfer_total REAL DEFAULT 0, party_id INTEGER, amount_rial INTEGER DEFAULT 0, foreign_amount REAL, fx_rate_rial INTEGER, currency TEXT DEFAULT 'IRR', cheque_lifecycle TEXT DEFAULT '',
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(cust_id) REFERENCES customers(id)
    );

CREATE TABLE sms_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cust_id INTEGER,
      phone TEXT,
      body TEXT,
      status TEXT DEFAULT 'pending',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

CREATE TABLE sms_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section_key TEXT NOT NULL,
      label TEXT NOT NULL,
      template_id INTEGER,
      active INTEGER DEFAULT 1,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(template_id) REFERENCES sms_templates(id)
    );

CREATE TABLE sms_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL,
      party_group_id INTEGER,
      user_id INTEGER,
      template_id INTEGER NOT NULL,
      delay_minutes INTEGER NOT NULL DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(template_id) REFERENCES sms_templates(id)
    );

CREATE TABLE sms_scheduled (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      body TEXT NOT NULL,
      send_at TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      template_id INTEGER,
      created_by INTEGER,
      sent_at INTEGER,
      error TEXT DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE sms_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      event_key TEXT DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      active INTEGER DEFAULT 1,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE stock_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      change INTEGER NOT NULL,
      note TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(product_id) REFERENCES products(id)
    );

CREATE TABLE stocktaking_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      system_qty INTEGER DEFAULT 0,
      counted_qty INTEGER DEFAULT 0, sync_seq INTEGER, version INTEGER DEFAULT 0, unit_cost_rial INTEGER DEFAULT 0, amount_rial INTEGER DEFAULT 0, ledger_id INTEGER, count1_qty REAL DEFAULT 0, count2_qty REAL, count3_qty REAL, count_tag TEXT, confirmed_count INTEGER DEFAULT 1, variant_id INTEGER,
      FOREIGN KEY(session_id) REFERENCES stocktaking_sessions(id),
      FOREIGN KEY(product_id) REFERENCES products(id)
    );

CREATE TABLE stocktaking_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      warehouse_id INTEGER NOT NULL,
      date TEXT,
      responsible_user_id INTEGER,
      status TEXT DEFAULT 'draft',
      note TEXT DEFAULT '',
      created_by INTEGER,
      approved_by INTEGER,
      approved_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0, je_id INTEGER, total_gain_rial INTEGER DEFAULT 0, total_loss_rial INTEGER DEFAULT 0,
      FOREIGN KEY(warehouse_id) REFERENCES warehouses(id)
    );

CREATE TABLE supplier_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      ref_type TEXT,
      ref_id INTEGER,
      description TEXT,
      debit REAL DEFAULT 0,
      credit REAL DEFAULT 0,
      user_id INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      FOREIGN KEY(supplier_id) REFERENCES suppliers(id)
    );

CREATE TABLE supplier_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL,
      purchase_invoice_id INTEGER,
      amount REAL DEFAULT 0,
      pay_type TEXT DEFAULT 'cash',
      date TEXT,
      note TEXT,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')), bank_id INTEGER, check_category_id INTEGER, account_code TEXT DEFAULT '', cash_box_id INTEGER, sync_seq INTEGER, version INTEGER DEFAULT 0, mahak_doc_no TEXT, mahak_doc_type TEXT, status TEXT NOT NULL DEFAULT 'posted', reversal_journal_id INTEGER, reversed_at INTEGER, reversed_by INTEGER, atf_no TEXT, purpose TEXT, cash_amount REAL DEFAULT 0, cheque_total REAL DEFAULT 0, transfer_total REAL DEFAULT 0,
      FOREIGN KEY(supplier_id) REFERENCES suppliers(id)
    );

CREATE TABLE suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      address TEXT DEFAULT '',
      note TEXT DEFAULT '',
      balance REAL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0, coa_code TEXT, party_group_id INTEGER, mahak_op_code TEXT, prefix TEXT, phone2 TEXT, fax TEXT, mobile TEXT, email TEXT, economic_code TEXT, postal_code TEXT, national_id TEXT, referrer TEXT, company_name TEXT, account_nature TEXT, party_id INTEGER);

CREATE TABLE sync_applied_ops (
      idempotency_key TEXT PRIMARY KEY,
      device_id INTEGER NOT NULL,
      device_seq INTEGER NOT NULL,
      method TEXT, path TEXT,
      status TEXT NOT NULL,             -- applied | conflict
      result_json TEXT,
      applied_at INTEGER DEFAULT (strftime('%s','now'))
    );

CREATE TABLE sync_capture_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      body_json TEXT,
      user_id INTEGER,
      base_version INTEGER,
      entity_table TEXT,
      entity_local_id INTEGER,
      captured_rows_json TEXT,
      has_file INTEGER DEFAULT 0,
      file_path TEXT,
      replay_file_hash TEXT,
      replay_file_field TEXT,
      error_code TEXT,
      error_message TEXT,
      status TEXT DEFAULT 'pending',
      outbox_id INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      reconciled_at INTEGER
    );

CREATE TABLE sync_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL,
      device_seq INTEGER NOT NULL,
      idempotency_key TEXT,
      method TEXT, path TEXT,
      payload TEXT,
      reason TEXT,
      central_snapshot TEXT,
      status TEXT DEFAULT 'open',       -- open | resolved
      resolved_by INTEGER, resolved_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

CREATE TABLE sync_device_nonces (
    device_id INTEGER NOT NULL,
    nonce TEXT NOT NULL,
    seen_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, nonce)
  );

CREATE TABLE sync_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      paired_by INTEGER,
      active INTEGER DEFAULT 1,
      last_push_at INTEGER,
      last_pull_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , token_expires_at INTEGER, token_rotated_at INTEGER, revoked_at INTEGER, signing_public_key TEXT, signing_key_version INTEGER DEFAULT 1);

CREATE TABLE sync_id_map (
      device_id INTEGER NOT NULL,
      local_id INTEGER NOT NULL,
      tbl TEXT NOT NULL,
      central_id INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (device_id, local_id)
    );

CREATE TABLE sync_local_kv (
      key TEXT PRIMARY KEY,
      value TEXT
    );

CREATE TABLE sync_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, -- doubles as device_seq (ordering)
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      body_json TEXT,
      user_id INTEGER,
      base_version INTEGER,
      entity_table TEXT,
      entity_local_id INTEGER,
      captured_rows_json TEXT,          -- rows this op created locally (for cleanup on confirm)
      has_file INTEGER DEFAULT 0,
      file_path TEXT,
      status TEXT DEFAULT 'pending',    -- pending | confirmed | conflict | discarded
      central_result TEXT,
      reason TEXT,
      attempts INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      resolved_at INTEGER
    , replay_proof TEXT, replay_file_hash TEXT, replay_file_field TEXT);

CREATE TABLE sync_tombstones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tbl TEXT NOT NULL,
      row_key TEXT NOT NULL,
      sync_seq INTEGER NOT NULL,
      deleted_at INTEGER DEFAULT (strftime('%s','now'))
    );

CREATE TABLE three_way_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_order_id INTEGER NOT NULL,
      goods_receipt_id INTEGER NOT NULL,
      purchase_invoice_id INTEGER,
      matched INTEGER NOT NULL DEFAULT 0,
      diffs TEXT NOT NULL DEFAULT '[]',
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE trust_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL,
      party_name TEXT NOT NULL,
      party_phone TEXT DEFAULT '',
      bank_name TEXT DEFAULT '',
      sayadi TEXT DEFAULT '',
      cheque_number TEXT DEFAULT '',
      account_number TEXT DEFAULT '',
      amount REAL NOT NULL,
      owner_name TEXT DEFAULT '',
      due_date TEXT DEFAULT '',
      status TEXT DEFAULT 'held',
      note TEXT DEFAULT '',
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , party_id INTEGER, sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE two_factor_auth (
      user_id INTEGER PRIMARY KEY,
      secret TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      recovery_codes TEXT DEFAULT '[]',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

CREATE TABLE units_of_measure (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE user_activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id INTEGER,
      ip_address TEXT,
      details TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

CREATE TABLE user_catalog_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      category_id INTEGER NOT NULL, sync_seq INTEGER, version INTEGER DEFAULT 0,
      UNIQUE(user_id, category_id),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(category_id) REFERENCES product_categories(id)
    );

CREATE TABLE user_cost_centers (
      user_id        INTEGER NOT NULL,
      cost_center_id INTEGER NOT NULL,
      can_view       INTEGER DEFAULT 1,
      can_post       INTEGER DEFAULT 1,
      created_at     INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      PRIMARY KEY (user_id, cost_center_id),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(cost_center_id) REFERENCES cost_centers(id)
    );

CREATE TABLE user_device_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      device_slot TEXT NOT NULL,
      device_fingerprint TEXT NOT NULL,
      device_name TEXT,
      device_kind TEXT,
      last_seen INTEGER DEFAULT (strftime('%s','now')),
      created_at INTEGER DEFAULT (strftime('%s','now')), session_id TEXT, expires_at INTEGER, auth_epoch INTEGER DEFAULT 0, company_id INTEGER DEFAULT 1, revoked_at INTEGER,
      UNIQUE(user_id, device_slot),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

CREATE TABLE user_invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      invited_email TEXT,
      intended_role TEXT,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(person_id) REFERENCES persons(id)
    );

CREATE TABLE user_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      resource TEXT NOT NULL,
      action TEXT NOT NULL,
      allowed INTEGER DEFAULT 1,
      UNIQUE(user_id, resource, action),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'salesperson',
      phone TEXT,
      active INTEGER DEFAULT 1,
      last_login INTEGER,
      commission_cash REAL DEFAULT 0,
      commission_cheque REAL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , must_change_password INTEGER DEFAULT 0, auth_epoch INTEGER DEFAULT 0, branch_id INTEGER, incentive_locked INTEGER DEFAULT 0, rep_code TEXT, rep_subtype TEXT DEFAULT '', territory TEXT DEFAULT '', supervisor_id INTEGER, employment_status TEXT DEFAULT 'active', bank_name TEXT DEFAULT '', bank_account TEXT DEFAULT '', bank_iban TEXT DEFAULT '', contract_file TEXT DEFAULT '', rep_opening_balance REAL DEFAULT 0, commission_basis TEXT DEFAULT 'invoice', monthly_target REAL DEFAULT 0, quarterly_target REAL DEFAULT 0, annual_target REAL DEFAULT 0, bonus_pct REAL DEFAULT 0, commission_fixed REAL DEFAULT 0, supervisor_commission_pct REAL DEFAULT 0, penalty_pct REAL DEFAULT 0, sync_seq INTEGER, version INTEGER DEFAULT 0, party_id INTEGER, person_id INTEGER, sales_warehouse_id INTEGER);

CREATE TABLE variant_warehouse_stock (
      variant_id INTEGER NOT NULL,
      warehouse_id INTEGER NOT NULL,
      qty REAL DEFAULT 0, sync_seq INTEGER, version INTEGER DEFAULT 0,
      PRIMARY KEY (variant_id, warehouse_id)
    );

CREATE TABLE vat_records (
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
      created_at INTEGER DEFAULT (strftime('%s','now')), sync_seq INTEGER, version INTEGER DEFAULT 0,
      UNIQUE(source_type, source_id, vat_category),
      FOREIGN KEY(journal_line_id) REFERENCES journal_lines(id)
    );

CREATE TABLE voucher_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT DEFAULT '',
      description TEXT DEFAULT '',
      lines_json TEXT NOT NULL,
      cost_center_id INTEGER,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0);

CREATE TABLE warehouse_moves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      product_id INTEGER NOT NULL,
      from_warehouse_id INTEGER,
      to_warehouse_id INTEGER,
      qty INTEGER NOT NULL,
      date TEXT DEFAULT '',
      note TEXT DEFAULT '',
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0, mahak_doc_no TEXT, mahak_doc_type TEXT, ledger_id INTEGER, unit_cost_rial INTEGER DEFAULT 0, amount_rial INTEGER DEFAULT 0, je_id INTEGER, batch_id INTEGER, status TEXT DEFAULT 'posted', reversed_at INTEGER, reversed_by INTEGER);

CREATE TABLE warehouse_stock (
      product_id INTEGER NOT NULL,
      warehouse_id INTEGER NOT NULL,
      qty INTEGER DEFAULT 0, sync_seq INTEGER, version INTEGER DEFAULT 0,
      PRIMARY KEY (product_id, warehouse_id),
      FOREIGN KEY(product_id) REFERENCES products(id),
      FOREIGN KEY(warehouse_id) REFERENCES warehouses(id)
    );

CREATE TABLE warehouses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    , sync_seq INTEGER, version INTEGER DEFAULT 0, entity TEXT DEFAULT 'distribution_office', cost_center_id INTEGER, code TEXT, warehouse_type TEXT DEFAULT 'finished_goods', is_default INTEGER DEFAULT 0, kind TEXT DEFAULT 'general', allow_negative INTEGER DEFAULT 0, costing_method TEXT);

CREATE TABLE webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      events TEXT DEFAULT 'customer.created',
      secret TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

CREATE INDEX idx_account_transfers_sync_seq ON account_transfers(sync_seq);

CREATE INDEX idx_activity_created ON user_activity_log(created_at);

CREATE INDEX idx_ai_insights_cust ON ai_insights(customer_id);

CREATE INDEX idx_ai_insights_kind ON ai_insights(kind, period);

CREATE INDEX idx_api_usage ON api_usage_log(api_key_id);

CREATE INDEX idx_audit_entity ON audit_log(entity);

CREATE INDEX idx_audit_user ON audit_log(user_id);

CREATE INDEX idx_b2b_acc_phone ON b2b_portal_accounts(phone);

CREATE INDEX idx_b2b_companies_active ON b2b_companies(active);

CREATE INDEX idx_b2b_company_users_account ON b2b_company_users(account_id);

CREATE INDEX idx_b2b_credit_ledger_company ON b2b_credit_ledger(company_id);

CREATE INDEX idx_b2b_credit_ledger_order ON b2b_credit_ledger(order_id);

CREATE INDEX idx_b2b_orders_cust ON b2b_portal_orders(customer_id);

CREATE INDEX idx_bank_reconciliation_items_sync_seq ON bank_reconciliation_items(sync_seq);

CREATE INDEX idx_bank_reconciliations_sync_seq ON bank_reconciliations(sync_seq);

CREATE INDEX idx_bank_statement_lines_sync_seq ON bank_statement_lines(sync_seq);

CREATE INDEX idx_banks_sync_seq ON banks(sync_seq);

CREATE INDEX idx_bom_change_log_sync_seq ON bom_change_log(sync_seq);

CREATE INDEX idx_bom_headers_sync_seq ON bom_headers(sync_seq);

CREATE INDEX idx_bom_lines_sync_seq ON bom_lines(sync_seq);

CREATE INDEX idx_bom_operations_sync_seq ON bom_operations(sync_seq);

CREATE INDEX idx_bom_outputs_sync_seq ON bom_outputs(sync_seq);

CREATE INDEX idx_branches_sync_seq ON branches(sync_seq);

CREATE INDEX idx_budget_lines_sync_seq ON budget_lines(sync_seq);

CREATE INDEX idx_budgets_sync_seq ON budgets(sync_seq);

CREATE INDEX idx_cash_boxes_sync_seq ON cash_boxes(sync_seq);

CREATE INDEX idx_chart_of_accounts_sync_seq ON chart_of_accounts(sync_seq);

CREATE INDEX idx_check_categories_bank ON check_categories(bank_id);

CREATE INDEX idx_check_categories_sync_seq ON check_categories(sync_seq);

CREATE INDEX idx_cheque_records_customer ON cheque_records(customer_id);

CREATE INDEX idx_cheque_records_dir ON cheque_records(direction);

CREATE INDEX idx_cheque_records_due ON cheque_records(due_date);

CREATE INDEX idx_cheque_records_party ON cheque_records(party_id);

CREATE INDEX idx_cheque_records_sync_seq ON cheque_records(sync_seq);

CREATE INDEX idx_consignments_sync_seq ON consignments(sync_seq);

CREATE INDEX idx_cost_center_rates_sync_seq ON cost_center_rates(sync_seq);

CREATE INDEX idx_cost_centers_sync_seq ON cost_centers(sync_seq);

CREATE INDEX idx_crm_act_cust ON crm_activities(customer_id);

CREATE INDEX idx_crm_act_followup ON crm_activities(followup_id);

CREATE INDEX idx_crm_act_opp ON crm_activities(opportunity_id);

CREATE INDEX idx_crm_act_status_due ON crm_activities(status, due_date);

CREATE INDEX idx_crm_activities_sync_seq ON crm_activities(sync_seq);

CREATE INDEX idx_crm_auto_rule ON crm_automation_log(rule_key, created_at);

CREATE INDEX idx_crm_campaigns_sync_seq ON crm_campaigns(sync_seq);

CREATE INDEX idx_crm_customer_segments_sync_seq ON crm_customer_segments(sync_seq);

CREATE INDEX idx_crm_files_sync_seq ON crm_files(sync_seq);

CREATE INDEX idx_crm_hist_opp ON crm_stage_history(opportunity_id, changed_at);

CREATE INDEX idx_crm_lead_sources_sync_seq ON crm_lead_sources(sync_seq);

CREATE INDEX idx_crm_opp_cust ON crm_opportunities(customer_id);

CREATE INDEX idx_crm_opp_owner ON crm_opportunities(owner_user_id);

CREATE INDEX idx_crm_opp_source ON crm_opportunities(lead_source, campaign);

CREATE INDEX idx_crm_opp_stage ON crm_opportunities(pipeline_stage, status);

CREATE INDEX idx_crm_opportunities_sync_seq ON crm_opportunities(sync_seq);

CREATE INDEX idx_crm_seg_eff ON crm_customer_segments(effective_segment);

CREATE INDEX idx_crm_segment_history_sync_seq ON crm_segment_history(sync_seq);

CREATE INDEX idx_crm_stage_history_sync_seq ON crm_stage_history(sync_seq);

CREATE INDEX idx_currencies_sync_seq ON currencies(sync_seq);

CREATE INDEX idx_customer_groups_sync_seq ON customer_groups(sync_seq);

CREATE INDEX idx_customer_ledger_sync_seq ON customer_ledger(sync_seq);

CREATE INDEX idx_customers_biz ON customers(biz);

CREATE INDEX idx_customers_group ON customers(group_id);

CREATE INDEX idx_customers_party ON customers(party_id);

CREATE INDEX idx_customers_province ON customers(province);

CREATE INDEX idx_customers_status ON customers(status);

CREATE INDEX idx_customers_sync_seq ON customers(sync_seq);

CREATE INDEX idx_customers_user ON customers(user_id);

CREATE INDEX idx_cutting_lay_rolls_sync_seq ON cutting_lay_rolls(sync_seq);

CREATE UNIQUE INDEX idx_cutting_lays_idem ON cutting_lays(idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';

CREATE INDEX idx_cutting_lays_sync_seq ON cutting_lays(sync_seq);

CREATE INDEX idx_cutting_pack_bundles_sync_seq ON cutting_pack_bundles(sync_seq);

CREATE UNIQUE INDEX idx_cutting_packs_idem ON cutting_packs(idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';

CREATE INDEX idx_cutting_packs_sync_seq ON cutting_packs(sync_seq);

CREATE INDEX idx_detail_accounts_sync_seq ON detail_accounts(sync_seq);

CREATE INDEX idx_detail_categories_sync_seq ON detail_categories(sync_seq);

CREATE INDEX idx_doubtful_debt_provisions_sync_seq ON doubtful_debt_provisions(sync_seq);

CREATE INDEX idx_employee_groups_sync_seq ON employee_groups(sync_seq);

CREATE INDEX idx_exchange_rates_sync_seq ON exchange_rates(sync_seq);

CREATE INDEX idx_expense_categories_sync_seq ON expense_categories(sync_seq);

CREATE INDEX idx_expense_payments_sync_seq ON expense_payments(sync_seq);

CREATE INDEX idx_fiscal_years_sync_seq ON fiscal_years(sync_seq);

CREATE INDEX idx_fixed_asset_depreciation_sync_seq ON fixed_asset_depreciation(sync_seq);

CREATE INDEX idx_fixed_assets_sync_seq ON fixed_assets(sync_seq);

CREATE INDEX idx_followups_cust ON followups(cust_id);

CREATE INDEX idx_followups_next ON followups(next_date);

CREATE INDEX idx_followups_opportunity ON followups(opportunity_id);

CREATE INDEX idx_followups_stage ON followups(pipeline_stage);

CREATE INDEX idx_followups_status_next ON followups(status, next_date);

CREATE INDEX idx_followups_sync_seq ON followups(sync_seq);

CREATE INDEX idx_followups_user ON followups(user_id);

CREATE INDEX idx_goods_receipts_sync_seq ON goods_receipts(sync_seq);

CREATE INDEX idx_group_salary_structures_group_year
      ON group_salary_structures(employee_group_id, fiscal_year);

CREATE INDEX idx_group_salary_structures_sync_seq ON group_salary_structures(sync_seq);

CREATE INDEX idx_incentive_payments_bank ON incentive_payments(bank_id);

CREATE INDEX idx_incentive_payments_sync_seq ON incentive_payments(sync_seq);

CREATE INDEX idx_incentive_rep ON incentive_payments(rep_id);

CREATE UNIQUE INDEX idx_inv_batches_idem ON inventory_batches(idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';

CREATE INDEX idx_inventory_batches_sync_seq ON inventory_batches(sync_seq);

CREATE INDEX idx_inventory_cost_layers_sync_seq ON inventory_cost_layers(sync_seq);

CREATE INDEX idx_inventory_ledger_sync_seq ON inventory_ledger(sync_seq);

CREATE INDEX idx_inventory_movements_sync_seq ON inventory_movements(sync_seq);

CREATE INDEX idx_inventory_nrv_lines_sync_seq ON inventory_nrv_lines(sync_seq);

CREATE INDEX idx_inventory_nrv_provisions_sync_seq ON inventory_nrv_provisions(sync_seq);

CREATE INDEX idx_inventory_reservations_sync_seq ON inventory_reservations(sync_seq);

CREATE INDEX idx_inventory_serials_sync_seq ON inventory_serials(sync_seq);

CREATE INDEX idx_invoices_campaign ON invoices(campaign);

CREATE INDEX idx_invoices_commission ON invoices(user_id, type, approved, pay_type);

CREATE INDEX idx_invoices_created ON invoices(created_at DESC);

CREATE INDEX idx_invoices_cust ON invoices(cust_id);

CREATE INDEX idx_invoices_lead_source ON invoices(lead_source);

CREATE UNIQUE INDEX idx_invoices_num_unique ON invoices(num);

CREATE INDEX idx_invoices_status_del ON invoices(status, deleted_at);

CREATE INDEX idx_invoices_sync_seq ON invoices(sync_seq);

CREATE INDEX idx_invoices_type ON invoices(type);

CREATE INDEX idx_invoices_type_cust_date ON invoices(type, cust_id, date);

CREATE INDEX idx_invoices_type_date ON invoices(type, date);

CREATE INDEX idx_invoices_user ON invoices(user_id);

CREATE INDEX idx_journal_entries_date ON journal_entries(entry_date);

CREATE INDEX idx_journal_entries_sync_seq ON journal_entries(sync_seq);

CREATE INDEX idx_journal_lines_account ON journal_lines(account_code);

CREATE INDEX idx_journal_lines_entry ON journal_lines(entry_id);

CREATE INDEX idx_journal_lines_sync_seq ON journal_lines(sync_seq);

CREATE INDEX idx_journal_ref ON journal_entries(ref_type,ref_id);

CREATE INDEX idx_journal_templates_sync_seq ON journal_templates(sync_seq);

CREATE INDEX idx_landed_cost_allocations_sync_seq ON landed_cost_allocations(sync_seq);

CREATE INDEX idx_landed_cost_docs_sync_seq ON landed_cost_docs(sync_seq);

CREATE INDEX idx_landed_cost_lines_sync_seq ON landed_cost_lines(sync_seq);

CREATE INDEX idx_ledger_cust_created ON customer_ledger(customer_id, created_at);

CREATE INDEX idx_ledger_customer ON customer_ledger(customer_id);

CREATE INDEX idx_ledger_ref ON customer_ledger(ref_type,ref_id);

CREATE INDEX idx_legal_reserve_entries_sync_seq ON legal_reserve_entries(sync_seq);

CREATE INDEX idx_license_activations_license
      ON license_activations(license_id);

CREATE INDEX idx_licenses_status
      ON licenses(status);

CREATE INDEX idx_marketer_carts_sync_seq ON marketer_carts(sync_seq);

CREATE INDEX idx_messages_sync_seq ON messages(sync_seq);

CREATE INDEX idx_messages_to ON messages(to_id);

CREATE INDEX idx_moadian_queue_next_retry
  ON moadian_queue(next_retry_at);

CREATE INDEX idx_moadian_status_history_queue
  ON moadian_status_history(queue_id);

CREATE INDEX idx_mrp_requirements_sync_seq ON mrp_requirements(sync_seq);

CREATE INDEX idx_mrp_runs_sync_seq ON mrp_runs(sync_seq);

CREATE INDEX idx_notif_unresolved ON app_notifications(resolved_at);

CREATE INDEX idx_op_departments_sync_seq ON op_departments(sync_seq);

CREATE INDEX idx_op_departments_unit_seq ON op_departments(unit_id, sequence_order);

CREATE INDEX idx_op_dept_capabilities_sync_seq ON op_dept_capabilities(sync_seq);

CREATE INDEX idx_op_dept_delegations_active
      ON op_dept_delegations(delegate_person_id, active, starts_at, ends_at);

CREATE INDEX idx_op_dept_delegations_sync_seq ON op_dept_delegations(sync_seq);

CREATE INDEX idx_op_dept_tasks_sync_seq ON op_dept_tasks(sync_seq);

CREATE INDEX idx_op_field_followups_sync_seq ON op_field_followups(sync_seq);

CREATE INDEX idx_op_param_dept_log_dept ON op_parameter_dept_log(department_id);

CREATE INDEX idx_op_param_dept_log_param ON op_parameter_dept_log(parameter_id);

CREATE INDEX idx_op_parameter_dept_log_sync_seq ON op_parameter_dept_log(sync_seq);

CREATE INDEX idx_op_parameter_extra_costs_sync_seq ON op_parameter_extra_costs(sync_seq);

CREATE INDEX idx_op_parameter_items_sync_seq ON op_parameter_items(sync_seq);

CREATE INDEX idx_op_parameters_current_dept ON op_parameters(current_department_id);

CREATE INDEX idx_op_parameters_sync_seq ON op_parameters(sync_seq);

CREATE INDEX idx_op_parameters_unit_status ON op_parameters(unit_id, status);

CREATE INDEX idx_op_unit_module_links_sync_seq ON op_unit_module_links(sync_seq);

CREATE INDEX idx_op_unit_persons_sync_seq ON op_unit_persons(sync_seq);

CREATE INDEX idx_op_unit_warehouses_sync_seq ON op_unit_warehouses(sync_seq);

CREATE INDEX idx_op_units_sync_seq ON op_units(sync_seq);

CREATE INDEX idx_orders_cust ON orders(cust_id);

CREATE INDEX idx_orders_sync_seq ON orders(sync_seq);

CREATE INDEX idx_orders_user ON orders(user_id);

CREATE INDEX idx_outbox_pending ON sync_outbox(status, id);

CREATE INDEX idx_outbox_status ON sync_outbox(status);

CREATE INDEX idx_overhead_allocation_rules_sync_seq ON overhead_allocation_rules(sync_seq);

CREATE INDEX idx_overhead_allocation_weights_sync_seq ON overhead_allocation_weights(sync_seq);

CREATE INDEX idx_parties_phone ON parties(phone);

CREATE INDEX idx_parties_sync_seq ON parties(sync_seq);

CREATE INDEX idx_parties_type ON parties(party_type);

CREATE INDEX idx_party_groups_sync_seq ON party_groups(sync_seq);

CREATE INDEX idx_payroll_labor_settings_sync_seq ON payroll_labor_settings(sync_seq);

CREATE INDEX idx_payroll_labor_versions_year
      ON payroll_labor_settings_versions(year, effective_from);

CREATE INDEX idx_payroll_monthly_accruals_sync_seq ON payroll_monthly_accruals(sync_seq);

CREATE INDEX idx_payroll_periods_status
      ON payroll_periods(status, fiscal_year, month_no);

CREATE INDEX idx_payroll_periods_sync_seq ON payroll_periods(sync_seq);

CREATE INDEX idx_payroll_records_sync_seq ON payroll_records(sync_seq);

CREATE INDEX idx_payroll_tax_brackets_sync_seq ON payroll_tax_brackets(sync_seq);

CREATE INDEX idx_payroll_tax_brackets_year
      ON payroll_tax_brackets(fiscal_year, bracket_order);

CREATE INDEX idx_payroll_year_end_bonuses_sync_seq ON payroll_year_end_bonuses(sync_seq);

CREATE INDEX idx_person_categories_sync_seq ON person_categories(sync_seq);

CREATE INDEX idx_person_ledger_sync_seq ON person_ledger(sync_seq);

CREATE INDEX idx_person_positions_sync_seq ON person_positions(sync_seq);

CREATE UNIQUE INDEX idx_persons_party_id_unique ON persons(party_id) WHERE party_id IS NOT NULL;

CREATE INDEX idx_persons_sync_seq ON persons(sync_seq);

CREATE UNIQUE INDEX idx_pos_batch_items ON pos_settlement_items(batch_id, receipt_id);

CREATE UNIQUE INDEX idx_pos_batches_idem
      ON pos_settlement_batches(idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key!='';

CREATE UNIQUE INDEX idx_pos_receipts_idem
      ON pos_receipts(idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key!='';

CREATE INDEX idx_pos_receipts_sync_seq ON pos_receipts(sync_seq);

CREATE INDEX idx_pos_settlement_batches_sync_seq ON pos_settlement_batches(sync_seq);

CREATE INDEX idx_pos_settlement_items_sync_seq ON pos_settlement_items(sync_seq);

CREATE INDEX idx_pos_terminals_sync_seq ON pos_terminals(sync_seq);

CREATE UNIQUE INDEX idx_pos_terminals_terminal_id ON pos_terminals(terminal_id);

CREATE INDEX idx_pricing_rules_sync_seq ON pricing_rules(sync_seq);

CREATE INDEX idx_product_categories_sync_seq ON product_categories(sync_seq);

CREATE INDEX idx_product_colors_sync_seq ON product_colors(sync_seq);

CREATE INDEX idx_product_images_pid ON product_images(product_id);

CREATE INDEX idx_product_images_sync_seq ON product_images(sync_seq);

CREATE INDEX idx_product_sizes_sync_seq ON product_sizes(sync_seq);

CREATE INDEX idx_product_style_colors_sync_seq ON product_style_colors(sync_seq);

CREATE INDEX idx_product_style_sizes_sync_seq ON product_style_sizes(sync_seq);

CREATE INDEX idx_product_variants_sync_seq ON product_variants(sync_seq);

CREATE INDEX idx_production_estimate_lines_sync_seq ON production_estimate_lines(sync_seq);

CREATE INDEX idx_production_estimates_sync_seq ON production_estimates(sync_seq);

CREATE INDEX idx_production_labor_entries_sync_seq ON production_labor_entries(sync_seq);

CREATE INDEX idx_production_material_issues_sync_seq ON production_material_issues(sync_seq);

CREATE INDEX idx_production_order_stages_sync_seq ON production_order_stages(sync_seq);

CREATE INDEX idx_production_orders_sync_seq ON production_orders(sync_seq);

CREATE INDEX idx_production_overhead_applications_sync_seq ON production_overhead_applications(sync_seq);

CREATE INDEX idx_production_period_close_sync_seq ON production_period_close(sync_seq);

CREATE INDEX idx_production_receipts_sync_seq ON production_receipts(sync_seq);

CREATE INDEX idx_production_reservations_sync_seq ON production_reservations(sync_seq);

CREATE INDEX idx_production_rework_sync_seq ON production_rework(sync_seq);

CREATE INDEX idx_production_runs_sync_seq ON production_runs(sync_seq);

CREATE INDEX idx_production_subcontract_sync_seq ON production_subcontract(sync_seq);

CREATE INDEX idx_production_variances_sync_seq ON production_variances(sync_seq);

CREATE INDEX idx_production_waste_sync_seq ON production_waste(sync_seq);

CREATE INDEX idx_products_cat ON products(category);

CREATE INDEX idx_products_name ON products(name);

CREATE INDEX idx_products_sync_seq ON products(sync_seq);

CREATE INDEX idx_products_warehouse ON products(warehouse_id);

CREATE INDEX idx_projects_sync_seq ON projects(sync_seq);

CREATE INDEX idx_purchase_invoices_bank ON purchase_invoices(bank_id);

CREATE INDEX idx_purchase_invoices_supplier ON purchase_invoices(supplier_id);

CREATE INDEX idx_purchase_invoices_sync_seq ON purchase_invoices(sync_seq);

CREATE INDEX idx_purchase_orders_sync_seq ON purchase_orders(sync_seq);

CREATE INDEX idx_purchase_returns_supplier ON purchase_returns(supplier_id);

CREATE INDEX idx_purchase_returns_sync_seq ON purchase_returns(sync_seq);

CREATE UNIQUE INDEX idx_purchases_num_unique ON purchase_invoices(num);

CREATE INDEX idx_pv_barcode ON product_variants(barcode);

CREATE INDEX idx_pv_color ON product_variants(color_id);

CREATE INDEX idx_pv_product ON product_variants(product_id);

CREATE INDEX idx_pv_size ON product_variants(size_id);

CREATE INDEX idx_pv_sku ON product_variants(sku);

CREATE INDEX idx_reminders_sync_seq ON reminders(sync_seq);

CREATE INDEX idx_rep_advances_rep ON rep_advances(rep_id);

CREATE INDEX idx_rep_advances_sync_seq ON rep_advances(sync_seq);

CREATE INDEX idx_rep_assign_cust ON rep_assignment_history(customer_id);

CREATE INDEX idx_rep_assignment_history_sync_seq ON rep_assignment_history(sync_seq);

CREATE INDEX idx_rep_call_logs_sync_seq ON rep_call_logs(sync_seq);

CREATE INDEX idx_rep_calls_rep ON rep_call_logs(rep_id);

CREATE INDEX idx_rep_comm_rules_rep ON rep_commission_rules(rep_id);

CREATE INDEX idx_rep_comm_tiers_rep ON rep_commission_tiers(rep_id);

CREATE INDEX idx_rep_commission_rules_sync_seq ON rep_commission_rules(sync_seq);

CREATE INDEX idx_rep_commission_tiers_sync_seq ON rep_commission_tiers(sync_seq);

CREATE INDEX idx_rep_expenses_rep ON rep_expenses(rep_id);

CREATE INDEX idx_rep_expenses_sync_seq ON rep_expenses(sync_seq);

CREATE INDEX idx_rep_ledger_rep ON rep_ledger(rep_id);

CREATE INDEX idx_rep_ledger_sync_seq ON rep_ledger(sync_seq);

CREATE INDEX idx_rep_pay_sub_rep ON rep_payment_submissions(rep_id);

CREATE INDEX idx_rep_pay_sub_status ON rep_payment_submissions(status);

CREATE INDEX idx_rep_payment_submissions_sync_seq ON rep_payment_submissions(sync_seq);

CREATE INDEX idx_rep_settlements_rep ON rep_settlements(rep_id);

CREATE INDEX idx_rep_settlements_sync_seq ON rep_settlements(sync_seq);

CREATE INDEX idx_rep_territories_sync_seq ON rep_territories(sync_seq);

CREATE INDEX idx_rep_visit_logs_sync_seq ON rep_visit_logs(sync_seq);

CREATE INDEX idx_rep_visits_rep ON rep_visit_logs(rep_id);

CREATE INDEX idx_report_config_name
      ON report_configurations(report_name, row_number);

CREATE INDEX idx_report_configurations_sync_seq ON report_configurations(sync_seq);

CREATE INDEX idx_reset_otp_user ON password_reset_otps(user_id);

CREATE INDEX idx_rfqs_sync_seq ON rfqs(sync_seq);

CREATE INDEX idx_salary_structures_person_year
      ON salary_structures(person_id, fiscal_year);

CREATE INDEX idx_salary_structures_sync_seq ON salary_structures(sync_seq);

CREATE INDEX idx_sales_returns_cust ON sales_returns(cust_id);

CREATE INDEX idx_sales_returns_sync_seq ON sales_returns(sync_seq);

CREATE INDEX idx_settings_sync_seq ON settings(sync_seq);

CREATE INDEX idx_settlements_bank ON settlements(bank_id);

CREATE INDEX idx_settlements_cust ON settlements(cust_id);

CREATE INDEX idx_settlements_date ON settlements(date);

CREATE INDEX idx_settlements_invoice ON settlements(invoice_id);

CREATE INDEX idx_settlements_sync_seq ON settlements(sync_seq);

CREATE INDEX idx_sms_options_sync_seq ON sms_options(sync_seq);

CREATE INDEX idx_sms_rules_event ON sms_rules(event_key, active);

CREATE INDEX idx_sms_rules_sync_seq ON sms_rules(sync_seq);

CREATE INDEX idx_sms_sched_status ON sms_scheduled(status, send_at);

CREATE INDEX idx_sms_scheduled_sync_seq ON sms_scheduled(sync_seq);

CREATE INDEX idx_sms_templates_sync_seq ON sms_templates(sync_seq);

CREATE INDEX idx_stock_logs_sync_seq ON stock_logs(sync_seq);

CREATE INDEX idx_stocktaking_items_sess ON stocktaking_items(session_id);

CREATE INDEX idx_stocktaking_items_sync_seq ON stocktaking_items(sync_seq);

CREATE INDEX idx_stocktaking_sessions_sync_seq ON stocktaking_sessions(sync_seq);

CREATE INDEX idx_stocktaking_status ON stocktaking_sessions(status);

CREATE INDEX idx_stocktaking_wh ON stocktaking_sessions(warehouse_id);

CREATE INDEX idx_supplier_ledger_supplier ON supplier_ledger(supplier_id);

CREATE INDEX idx_supplier_ledger_sync_seq ON supplier_ledger(sync_seq);

CREATE INDEX idx_supplier_payments_bank ON supplier_payments(bank_id);

CREATE INDEX idx_supplier_payments_sync_seq ON supplier_payments(sync_seq);

CREATE INDEX idx_suppliers_sync_seq ON suppliers(sync_seq);

CREATE INDEX idx_sync_capture_failures_status
      ON sync_capture_failures(status,id);

CREATE INDEX idx_sync_device_nonces_seen ON sync_device_nonces(seen_at);

CREATE INDEX idx_sync_devices_active ON sync_devices(active);

CREATE INDEX idx_three_way_matches_sync_seq ON three_way_matches(sync_seq);

CREATE INDEX idx_tombstones_seq ON sync_tombstones(sync_seq);

CREATE INDEX idx_trust_checks_sync_seq ON trust_checks(sync_seq);

CREATE INDEX idx_units_of_measure_sync_seq ON units_of_measure(sync_seq);

CREATE INDEX idx_user_catalog_categories_sync_seq ON user_catalog_categories(sync_seq);

CREATE INDEX idx_user_cost_centers_sync_seq ON user_cost_centers(sync_seq);

CREATE UNIQUE INDEX idx_user_device_sessions_sid ON user_device_sessions(session_id) WHERE session_id IS NOT NULL;

CREATE INDEX idx_user_device_sessions_user ON user_device_sessions(user_id);

CREATE INDEX idx_user_invitations_hash ON user_invitations(token_hash);

CREATE INDEX idx_user_invitations_person ON user_invitations(person_id);

CREATE UNIQUE INDEX idx_users_party_id_unique ON users(party_id) WHERE party_id IS NOT NULL;

CREATE INDEX idx_users_sync_seq ON users(sync_seq);

CREATE INDEX idx_variant_warehouse_stock_sync_seq ON variant_warehouse_stock(sync_seq);

CREATE INDEX idx_vat_records_period
      ON vat_records(fiscal_period, vat_category, status);

CREATE INDEX idx_vat_records_sync_seq ON vat_records(sync_seq);

CREATE INDEX idx_voucher_drafts_sync_seq ON voucher_drafts(sync_seq);

CREATE INDEX idx_warehouse_moves_sync_seq ON warehouse_moves(sync_seq);

CREATE INDEX idx_warehouse_stock_sync_seq ON warehouse_stock(sync_seq);

CREATE INDEX idx_warehouse_stock_wh ON warehouse_stock(warehouse_id);

CREATE INDEX idx_warehouses_sync_seq ON warehouses(sync_seq);

CREATE INDEX ix_bom_product_status ON bom_headers(product_id, status, valid_from, valid_to);

CREATE INDEX ix_bomline_bom  ON bom_lines(bom_id, line_no);

CREATE INDEX ix_bomline_comp ON bom_lines(component_product_id);

CREATE INDEX ix_bomlog ON bom_change_log(bom_id, created_at);

CREATE INDEX ix_bomout ON bom_outputs(bom_id, output_type);

CREATE INDEX ix_cutting_lay_rolls ON cutting_lay_rolls(lay_id, batch_id);

CREATE INDEX ix_cutting_lays_date ON cutting_lays(date, id);

CREATE INDEX ix_cutting_lays_po ON cutting_lays(production_order_id, status);

CREATE INDEX ix_cutting_lays_prod ON cutting_lays(product_id, status, id);

CREATE INDEX ix_cutting_pack_bundles ON cutting_pack_bundles(pack_id, status);

CREATE INDEX ix_cutting_packs_lay ON cutting_packs(lay_id, status);

CREATE INDEX ix_cutting_packs_prod ON cutting_packs(product_id, date);

CREATE INDEX ix_estline ON production_estimate_lines(estimate_id, line_kind);

CREATE INDEX ix_inv_batch_exp ON inventory_batches(product_id, expiry_date, status);

CREATE INDEX ix_inv_layer_prod ON inventory_cost_layers(product_id, warehouse_id, status, id);

CREATE INDEX ix_inv_led_date ON inventory_ledger(date, id);

CREATE INDEX ix_inv_led_prod ON inventory_ledger(product_id, id);

CREATE INDEX ix_inv_led_src ON inventory_ledger(source_type, source_id);

CREATE INDEX ix_inv_led_wh ON inventory_ledger(warehouse_id, id);

CREATE INDEX ix_inv_mov_doc ON inventory_movements(doc_type, doc_id);

CREATE INDEX ix_inv_mov_product ON inventory_movements(product_id, id);

CREATE INDEX ix_inv_mov_variant ON inventory_movements(variant_id, id);

CREATE INDEX ix_inv_rsv_prod ON inventory_reservations(product_id, warehouse_id, status);

CREATE INDEX ix_inv_serial_st ON inventory_serials(product_id, status);

CREATE INDEX ix_lab_cc     ON production_labor_entries(cost_center_id, period_label);

CREATE INDEX ix_lab_order  ON production_labor_entries(order_id, date);

CREATE INDEX ix_lab_person ON production_labor_entries(person_id, period_label);

CREATE INDEX ix_lc_alloc ON landed_cost_allocations(doc_id);

CREATE INDEX ix_lc_doc ON landed_cost_lines(doc_id);

CREATE INDEX ix_mi_je    ON production_material_issues(je_id);

CREATE INDEX ix_mi_order ON production_material_issues(order_id, date);

CREATE INDEX ix_mi_prod  ON production_material_issues(product_id, date);

CREATE INDEX ix_mrpreq ON mrp_requirements(run_id, action);

CREATE INDEX ix_oh_cc    ON production_overhead_applications(cost_center_id, period_label);

CREATE INDEX ix_oh_order ON production_overhead_applications(order_id);

CREATE INDEX ix_pevt ON production_events(processed, created_at);

CREATE INDEX ix_po_period ON production_orders(period_label, status);

CREATE INDEX ix_po_prod   ON production_orders(product_id, date);

CREATE INDEX ix_po_so     ON production_orders(sales_order_id);

CREATE INDEX ix_po_status ON production_orders(status, date);

CREATE INDEX ix_pos_status ON production_order_stages(status, cost_center_id);

CREATE INDEX ix_pr_order ON production_receipts(order_id);

CREATE INDEX ix_pr_prod  ON production_receipts(product_id, date);

CREATE INDEX ix_resv ON production_reservations(product_id, warehouse_id, status);

CREATE INDEX ix_rpt_jl_acct ON journal_lines(account_code, entry_id);

CREATE INDEX ix_rpt_mi_period ON production_material_issues(period_label, product_id, cost_center_id);

CREATE INDEX ix_rpt_po_period ON production_orders(period_label, status, product_id);

CREATE INDEX ix_rpt_pos_cc ON production_order_stages(cost_center_id, status, ended_at);

CREATE INDEX ix_rpt_pr_period ON production_receipts(period_label, product_id, date);

CREATE INDEX ix_rpt_ws_period ON production_waste(period_label, waste_type, cost_center_id);

CREATE INDEX ix_sub_order ON production_subcontract(order_id, direction);

CREATE INDEX ix_ucc_user ON user_cost_centers(user_id);

CREATE INDEX ix_var_period ON production_variances(period_label, variance_type);

CREATE INDEX ix_waste_cc    ON production_waste(cost_center_id, period_label);

CREATE INDEX ix_waste_order ON production_waste(order_id, waste_type);

CREATE UNIQUE INDEX ux_bom_code ON bom_headers(code);

CREATE UNIQUE INDEX ux_bom_prod_ver ON bom_headers(product_id, version, revision);

CREATE UNIQUE INDEX ux_bomop ON bom_operations(bom_id, seq);

CREATE UNIQUE INDEX ux_ccrate ON cost_center_rates(cost_center_id, period_label);

CREATE UNIQUE INDEX ux_cutting_pack_barcode ON cutting_pack_bundles(barcode);

CREATE UNIQUE INDEX ux_cutting_packs_live_lay ON cutting_packs(lay_id) WHERE status='posted';

CREATE UNIQUE INDEX ux_est_code ON production_estimates(code);

CREATE UNIQUE INDEX ux_inventory_movements_doc
      ON inventory_movements (
        doc_type,
        doc_id,
        COALESCE(doc_line, -1),
        COALESCE(warehouse_id, 0),
        COALESCE(variant_id, 0)
      )
      WHERE doc_id IS NOT NULL
    ;

CREATE UNIQUE INDEX ux_ohw ON overhead_allocation_weights(rule_id, cost_center_id);

CREATE UNIQUE INDEX ux_po_no ON production_orders(order_no);

CREATE UNIQUE INDEX ux_pos ON production_order_stages(order_id, seq);

CREATE UNIQUE INDEX ux_ppc ON production_period_close(period_label);

CREATE UNIQUE INDEX ux_product_colors_code
      ON product_colors(code) WHERE code IS NOT NULL AND code <> '';

CREATE UNIQUE INDEX ux_product_sizes_code
      ON product_sizes(code) WHERE code IS NOT NULL AND code <> '';

CREATE UNIQUE INDEX ux_pv_default
      ON product_variants(product_id) WHERE is_default = 1;

CREATE UNIQUE INDEX ux_pv_matrix
      ON product_variants(product_id, color_id, size_id)
      WHERE color_id IS NOT NULL AND size_id IS NOT NULL AND active = 1;

CREATE TRIGGER trg_bom_no_self
    BEFORE INSERT ON bom_lines
    BEGIN
      SELECT RAISE(ABORT, 'E_BOM_SELF_REF: کالا نمی‌تواند جزء فرمول خودش باشد')
      WHERE NEW.component_product_id = (SELECT product_id FROM bom_headers WHERE id = NEW.bom_id);
    END;

CREATE TRIGGER trg_bom_single_default
    AFTER UPDATE OF is_default ON bom_headers WHEN NEW.is_default = 1
    BEGIN
      UPDATE bom_headers SET is_default = 0
      WHERE product_id = NEW.product_id AND id <> NEW.id;
    END;

CREATE TRIGGER trg_bom_updated AFTER UPDATE ON bom_headers
    BEGIN
      UPDATE bom_headers SET updated_at = strftime('%s','now') WHERE id = NEW.id;
    END;

CREATE TRIGGER trg_bomline_lock_active
    BEFORE UPDATE ON bom_lines
    BEGIN
      SELECT RAISE(ABORT, 'E_BOM_LOCKED: فرمول فعال قابل ویرایش نیست؛ نسخه جدید بسازید')
      WHERE (SELECT status FROM bom_headers WHERE id = NEW.bom_id) = 'active';
    END;

CREATE TRIGGER trg_bomline_lock_delete
    BEFORE DELETE ON bom_lines
    BEGIN
      SELECT RAISE(ABORT, 'E_BOM_LOCKED: فرمول فعال قابل حذف نیست')
      WHERE (SELECT status FROM bom_headers WHERE id = OLD.bom_id) = 'active';
    END;

CREATE TRIGGER trg_est_lock_confirmed
    BEFORE UPDATE ON production_estimates
    WHEN OLD.status IN ('confirmed','converted') AND NEW.status = OLD.status
    BEGIN
      SELECT RAISE(ABORT, 'E_ESTIMATE_LOCKED: برآورد تأییدشده قابل ویرایش نیست')
      WHERE NEW.qty <> OLD.qty OR NEW.product_id <> OLD.product_id;
    END;

CREATE TRIGGER trg_lab_period_lock
    BEFORE INSERT ON production_labor_entries
    BEGIN
      SELECT RAISE(ABORT, 'E_PERIOD_CLOSED: دوره بسته شده است')
      WHERE NEW.period_label <> '' AND EXISTS (
        SELECT 1 FROM production_period_close
        WHERE period_label = NEW.period_label AND status = 'closed');
    END;

CREATE TRIGGER trg_mi_period_lock
    BEFORE INSERT ON production_material_issues
    BEGIN
      SELECT RAISE(ABORT, 'E_PERIOD_CLOSED: دوره بسته شده است')
      WHERE NEW.period_label <> '' AND EXISTS (
        SELECT 1 FROM production_period_close
        WHERE period_label = NEW.period_label AND status = 'closed');
    END;

CREATE TRIGGER trg_oh_period_lock
    BEFORE INSERT ON production_overhead_applications
    BEGIN
      SELECT RAISE(ABORT, 'E_PERIOD_CLOSED: دوره بسته شده است')
      WHERE NEW.period_label <> '' AND EXISTS (
        SELECT 1 FROM production_period_close
        WHERE period_label = NEW.period_label AND status = 'closed');
    END;

CREATE TRIGGER trg_po_updated AFTER UPDATE ON production_orders
    BEGIN
      UPDATE production_orders SET updated_at = strftime('%s','now') WHERE id = NEW.id;
    END;

CREATE TRIGGER trg_pr_period_lock
    BEFORE INSERT ON production_receipts
    BEGIN
      SELECT RAISE(ABORT, 'E_PERIOD_CLOSED: دوره بسته شده است')
      WHERE NEW.period_label <> '' AND EXISTS (
        SELECT 1 FROM production_period_close
        WHERE period_label = NEW.period_label AND status = 'closed');
    END;

CREATE TRIGGER trg_rework_period_lock
    BEFORE INSERT ON production_rework
    BEGIN
      SELECT RAISE(ABORT, 'E_PERIOD_CLOSED: دوره بسته شده است')
      WHERE NEW.period_label <> '' AND EXISTS (
        SELECT 1 FROM production_period_close
        WHERE period_label = NEW.period_label AND status = 'closed');
    END;

CREATE TRIGGER trg_sub_period_lock
    BEFORE INSERT ON production_subcontract
    BEGIN
      SELECT RAISE(ABORT, 'E_PERIOD_CLOSED: دوره بسته شده است')
      WHERE NEW.period_label <> '' AND EXISTS (
        SELECT 1 FROM production_period_close
        WHERE period_label = NEW.period_label AND status = 'closed');
    END;

CREATE TRIGGER trg_waste_period_lock
    BEFORE INSERT ON production_waste
    BEGIN
      SELECT RAISE(ABORT, 'E_PERIOD_CLOSED: دوره بسته شده است')
      WHERE NEW.period_label <> '' AND EXISTS (
        SELECT 1 FROM production_period_close
        WHERE period_label = NEW.period_label AND status = 'closed');
    END;

CREATE TRIGGER trg_ws_no_negative
      BEFORE UPDATE ON warehouse_stock WHEN NEW.qty < 0
      BEGIN
        SELECT RAISE(ABORT, 'E_NEGATIVE_STOCK: موجودی انبار منفی می‌شود');
      END;
