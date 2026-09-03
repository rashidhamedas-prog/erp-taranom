/**
 * Schema for update.md tasks 2–9 (idempotent).
 * Call from db.js initDB().
 */
function ensureUpdateMdSchema(db, ensureColumn) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(product_id) REFERENCES products(id)
    );
    CREATE INDEX IF NOT EXISTS idx_product_images_pid ON product_images(product_id);

    CREATE TABLE IF NOT EXISTS user_catalog_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      category_id INTEGER NOT NULL,
      UNIQUE(user_id, category_id),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(category_id) REFERENCES product_categories(id)
    );

    CREATE TABLE IF NOT EXISTS sms_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      event_key TEXT DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      active INTEGER DEFAULT 1,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS sms_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section_key TEXT NOT NULL,
      label TEXT NOT NULL,
      template_id INTEGER,
      active INTEGER DEFAULT 1,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(template_id) REFERENCES sms_templates(id)
    );

    CREATE TABLE IF NOT EXISTS sms_scheduled (
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
    );
    CREATE INDEX IF NOT EXISTS idx_sms_sched_status ON sms_scheduled(status, send_at);

    CREATE TABLE IF NOT EXISTS sms_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL,
      party_group_id INTEGER,
      user_id INTEGER,
      template_id INTEGER NOT NULL,
      delay_minutes INTEGER NOT NULL DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_by INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(template_id) REFERENCES sms_templates(id)
    );
    CREATE INDEX IF NOT EXISTS idx_sms_rules_event ON sms_rules(event_key, active);

    CREATE TABLE IF NOT EXISTS marketer_carts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      items_json TEXT DEFAULT '[]',
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(user_id)
    );
  `);

  // party_groups is normally seeded in currency.seedStandardSubgroups (later);
  // create shell here so is_marketer / sync columns can attach on fresh DBs.
  db.exec(`
    CREATE TABLE IF NOT EXISTS party_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL UNIQUE,
      entity_type TEXT NOT NULL DEFAULT 'all',
      description TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);
  ensureColumn(db, 'party_groups', 'is_marketer', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'products', 'images_json', "TEXT DEFAULT '[]'");

  const defaults = {
    website_stock_sync_enabled: '0',
    website_stock_sync_mode: 'pull', // pull | push | both
    website_stock_webhook_url: '',
    website_wc_url: '',
    website_wc_key: '',
    website_wc_secret: '',
    rubika_bot_token: '',
    rubika_chat_id: '',
    rubika_invoice_enabled: '0',
  };
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
  for (const [k, v] of Object.entries(defaults)) ins.run(k, v);

  // Seed a few SMS templates if empty
  const n = db.prepare('SELECT COUNT(*) c FROM sms_templates').get().c;
  if (!n) {
    const seed = db.prepare('INSERT INTO sms_templates (code,name,event_key,body,active) VALUES (?,?,?,?,1)');
    seed.run('welcome', 'خوش‌آمدگویی مشتری', 'customer.created', 'سلام {name} به پوشاک ترنم خوش آمدید');
    seed.run('invoice_approved', 'تأیید فاکتور', 'invoice.approved', 'فاکتور {num} به مبلغ {amount} ریال تأیید شد');
    seed.run('order_ready', 'آماده تحویل', 'order.ready', 'سفارش شما آماده تحویل است');
  }

  // Append-safe templates for newly-wired events. INSERT OR IGNORE keyed on the
  // UNIQUE `code` column → never overwrites an admin-edited template and never
  // wipes existing rows. Seeding a template alone does NOT send anything; an
  // active sms_rule must still link the event to a template.
  const seedIgnore = db.prepare('INSERT OR IGNORE INTO sms_templates (code,name,event_key,body,active) VALUES (?,?,?,?,1)');
  const extraTemplates = [
    ['invoice_created', 'ثبت فاکتور', 'invoice.created', 'فاکتور {num} به مبلغ {amount} ریال برای {name} ثبت شد. پوشاک ترنم'],
    ['invoice_converted', 'تبدیل به فاکتور قطعی', 'invoice.converted', 'پیش‌فاکتور شما به {status} شماره {num} به مبلغ {amount} ریال تبدیل شد. پوشاک ترنم'],
    ['followup_reminder', 'یادآوری پیگیری', 'followup.reminder', 'یادآوری پیگیری: {name} — {note} (ساعت {status})'],
    ['auth_otp', 'کد ورود کاربر', 'auth.otp', 'کد تأیید ERP ترنم: {code}'],
    ['b2b_otp', 'کد ورود پورتال', 'b2b.otp', 'کد ورود پورتال ترنم: {code}'],
    ['portal_invite', 'فعال‌سازی پورتال', 'portal.invite', 'دسترسی پورتال ترنم برای {biz} فعال شد. شماره ورود: {phone}'],
    ['settlement_created', 'ثبت دریافت', 'settlement.created', 'دریافت {amount} ریال از {name} ثبت شد. پوشاک ترنم'],
    ['payment_created', 'ثبت پرداخت', 'payment.created', 'پرداخت {amount} ریال برای {name} ثبت شد. پوشاک ترنم'],
    ['party_created', 'ثبت شخص', 'party.created', '{name} در دفتر اشخاص ترنم ثبت شد.'],
  ];
  for (const [code, name, ev, body] of extraTemplates) seedIgnore.run(code, name, ev, body);
}

module.exports = { ensureUpdateMdSchema };
