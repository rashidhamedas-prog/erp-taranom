/**
 * Currency helpers — storage is always Rial (مبنای محک).
 * Display can be Rial or Toman via settings.currency_display.
 */
const BASE = 'rial';

function displayMode(db) {
  if (!db) return 'rial';
  const row = db.prepare("SELECT value FROM settings WHERE key='currency_display'").get();
  return row?.value === 'toman' ? 'toman' : 'rial';
}

/** Store amount from Mahak Excel (already Rial). */
function storeRial(rial) {
  return Math.round(parseFloat(rial) || 0);
}

/** Convert stored Rial → display value. */
function toDisplay(storedRial, mode) {
  const v = Math.round(parseFloat(storedRial) || 0);
  return mode === 'toman' ? Math.round(v / 10) : v;
}

/** Convert user input (in display unit) → stored Rial. */
function fromInput(inputValue, mode) {
  const v = Math.round(parseFloat(inputValue) || 0);
  return mode === 'toman' ? v * 10 : v;
}

function unitLabel(mode) {
  return mode === 'toman' ? 'تومان' : 'ریال';
}

/** One-time migration: old DBs stored Toman — multiply all money fields ×10 to Rial. */
function migrateTomanToRial(db) {
  const done = db.prepare("SELECT value FROM settings WHERE key='currency_rial_migration_v1'").get();
  if (done?.value === '1') return false;

  const mul = (sql) => { try { db.exec(sql); } catch (e) { console.warn('currency migration:', e.message); } };

  const tables = [
    ['products', ['price', 'cost']],
    ['customers', ['balance']],
    ['suppliers', ['balance']],
    ['invoices', ['subtotal', 'disc_amt', 'final']],
    ['purchase_invoices', ['subtotal', 'disc_amt', 'final']],
    ['settlements', ['amount']],
    ['supplier_payments', ['amount']],
    ['expense_payments', ['amount']],
    ['account_transfers', ['amount']],
    ['payroll_records', ['hourly_rate', 'overtime_rate', 'bonuses', 'deductions', 'insurance_deduction', 'tax_deduction', 'gross_pay', 'net_pay']],
    ['production_runs', ['material_cost', 'labor_cost', 'overhead_cost', 'packaging_cost', 'waste_cost', 'previous_cost']],
    ['consignments', ['unit_price']],
    ['journal_lines', ['debit', 'credit']],
    ['customer_ledger', ['debit', 'credit']],
    ['supplier_ledger', ['debit', 'credit']],
    ['person_ledger', ['debit', 'credit']],
    ['rep_ledger', ['debit', 'credit']],
    ['persons', ['credit_limit', 'debit_limit', 'hourly_rate', 'overtime_rate']],
    ['sales_returns', ['amount']],
    ['purchase_returns', ['amount']],
    ['trust_checks', ['amount']],
  ];

  for (const [tbl, cols] of tables) {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tbl);
    if (!exists) continue;
    for (const col of cols) {
      const has = db.prepare(`PRAGMA table_info(${tbl})`).all().some(c => c.name === col);
      if (has) mul(`UPDATE ${tbl} SET ${col} = ROUND(${col} * 10) WHERE ${col} IS NOT NULL AND ${col} != 0`);
    }
  }

  // JSON rows in invoices / purchase_invoices / returns
  for (const [tbl, idCol] of [['invoices', 'id'], ['purchase_invoices', 'id'], ['sales_returns', 'id'], ['purchase_returns', 'id']]) {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tbl);
    if (!exists) continue;
    const rows = db.prepare(`SELECT ${idCol} id, rows FROM ${tbl} WHERE rows IS NOT NULL AND rows<>''`).all();
    const upd = db.prepare(`UPDATE ${tbl} SET rows=? WHERE ${idCol}=?`);
    for (const r of rows) {
      try {
        const arr = JSON.parse(r.rows);
        if (!Array.isArray(arr)) continue;
        for (const item of arr) {
          for (const k of ['price', 'cost', 'sum', 'disc_amt', 'total']) {
            if (item[k]) item[k] = Math.round(item[k] * 10);
          }
        }
        upd.run(JSON.stringify(arr), r.id);
      } catch (_) { /* skip bad JSON */ }
    }
  }

  db.prepare("INSERT INTO settings (key,value) VALUES ('currency_rial_migration_v1','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  db.prepare("INSERT INTO settings (key,value) VALUES ('currency_base','rial') ON CONFLICT(key) DO UPDATE SET value='rial'").run();
  db.prepare("INSERT INTO settings (key,value) VALUES ('currency_display','rial') ON CONFLICT(key) DO UPDATE SET value='rial'").run();
  console.log('✅ currency migration: Toman → Rial (×10)');
  return true;
}

/**
 * نام‌های قدیمی seed محک — دیگر در boot درج نمی‌شوند.
 * فقط برای تشخیص/پاک‌سازی یک‌باره و اسکریپت‌های import نگه داشته شده‌اند.
 */
const LEGACY_SEEDED_PRODUCT_GROUP_NAMES = [
  'کلیه کالاها', 'پارچه', 'خرج کار', 'زیپ ها', 'اثاثه', 'لینن', 'زمستونی',
  'لی', 'خرید محصول متفرقه', 'کتان', 'برش خورده', 'متفرقه', 'مواد اولیه', 'محصول نهایی', 'لایی', 'جین',
];

/** @deprecated خالی — گروه‌های کالا فقط دستی ساخته می‌شوند. */
const MAHAK_PRODUCT_GROUPS = [];

/** فقط گروه مجازی «کلیه اشخاص» — بقیه گروه‌ها توسط کاربر تعریف می‌شوند. */
const MAHAK_PARTY_GROUPS = [
  { code: 0, name: 'کلیه اشخاص', entity_type: 'all' },
];

/** پیشنهاد نام گروه هنگام import محک — گروه را خودش نمی‌سازد. */
function guessMahakProductGroup(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  if (/پارچه|لنین|لینن|کتان\b|جین\b|لی\b|زمستون|زمستانی|پارچه/i.test(n)) {
    if (/زیپ/i.test(n)) return 'زیپ ها';
    if (/لایی|آستر|لینن/i.test(n)) return 'لینن';
    if (/جین/i.test(n)) return 'جین';
    if (/زمستون|زمستانی/i.test(n)) return 'زمستونی';
    if (/\bلی\b|لی\s/i.test(n)) return 'لی';
    if (/کتان/i.test(n)) return 'کتان';
    if (/پارچه|لنین/i.test(n)) return 'پارچه';
  }
  if (/قفسه|میز|صندلی|اثاثه/i.test(n)) return 'اثاثه';
  if (/خرجکار|خرج کار|دکمه|مارک|برچسب|بسته|پلمپ|چسب|قفل|نخ\b|جارو|کاور|پکت|ته طاق/i.test(n)) return 'خرج کار';
  if (/زیپ/i.test(n)) return 'زیپ ها';
  if (/لایی|آستر/i.test(n)) return 'لایی';
  if (/برش/i.test(n)) return 'برش خورده';
  if (/مانتو|پیراهن|دامن|شلوار|کت\b|ست\b|بالاپوش|لباس|پالتو|کاپشن|تیشرت|بلوز|شومیز/i.test(n)) return 'محصول نهایی';
  if (/پارچه|مغزی|نخ\b|رنگ|دوخت|ملزوم/i.test(n)) return 'مواد اولیه';
  return 'متفرقه';
}

/**
 * یک‌بار: حذف گروه‌های seed‌شدهٔ قدیمی که کالایی به آن‌ها وصل نیست.
 * (قبلاً هر boot با INSERT OR IGNORE دوباره ساخته می‌شدند.)
 */
function purgeAutoSeededProductCategories(db) {
  const done = db.prepare("SELECT value FROM settings WHERE key='product_categories_no_auto_seed_v1'").get();
  if (done?.value === '1') return 0;

  const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='product_categories'").get();
  if (!hasTable) {
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('product_categories_no_auto_seed_v1','1')").run();
    return 0;
  }

  // فقط ردیف‌های seed قدیمی (description ثابت) یا ریشهٔ مجازی «کلیه کالاها»
  const seedWhere = `(description='گروه استاندارد' OR (name='کلیه کالاها' AND COALESCE(code,0)=0))`;
  const candidates = db.prepare(`
    SELECT id, name, parent_id FROM product_categories
    WHERE ${seedWhere}
    ORDER BY CASE WHEN parent_id IS NULL THEN 1 ELSE 0 END, id DESC
  `).all();

  let removed = 0;
  let delAcl = null;
  try {
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_catalog_categories'").get()) {
      delAcl = db.prepare('DELETE FROM user_catalog_categories WHERE category_id=?');
    }
  } catch (_) { /* ignore */ }
  const inUseProd = db.prepare('SELECT COUNT(*) c FROM products WHERE category_id=?');
  const childCount = db.prepare('SELECT COUNT(*) c FROM product_categories WHERE parent_id=?');
  const delCat = db.prepare('DELETE FROM product_categories WHERE id=?');

  for (const row of candidates) {
    if (inUseProd.get(row.id).c > 0) continue;
    if (childCount.get(row.id).c > 0) continue;
    try {
      if (delAcl) delAcl.run(row.id);
      delCat.run(row.id);
      removed++;
    } catch (e) {
      console.warn('purge product category skipped:', row.name, e.message);
    }
  }

  // اگر هنوز والد خالی مانده، یک دور دیگر
  const leftovers = db.prepare(`
    SELECT id FROM product_categories
    WHERE ${seedWhere}
      AND id NOT IN (SELECT DISTINCT category_id FROM products WHERE category_id IS NOT NULL)
      AND id NOT IN (SELECT DISTINCT parent_id FROM product_categories WHERE parent_id IS NOT NULL)
  `).all();
  for (const row of leftovers) {
    try {
      if (delAcl) delAcl.run(row.id);
      delCat.run(row.id);
      removed++;
    } catch (_) { /* ignore */ }
  }

  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('product_categories_no_auto_seed_v1','1')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('product_categories_user_cleared','1')").run();
  if (removed) console.log(`✅ purged ${removed} auto-seeded product categories (no re-seed)`);
  return removed;
}

function seedStandardSubgroups(db) {
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

  const insPg = db.prepare('INSERT OR IGNORE INTO party_groups (code,name,entity_type,description) VALUES (?,?,?,?)');
  const updPg = db.prepare('UPDATE party_groups SET entity_type=?,description=? WHERE name=?');
  for (const g of MAHAK_PARTY_GROUPS) {
    insPg.run(g.code, g.name, g.entity_type, '');
    updPg.run(g.entity_type, '', g.name);
  }

  // گروه‌های کالا دیگر seed نمی‌شوند — فقط تعریف دستی کاربر.
  // (قبلاً MAHAK_PRODUCT_GROUPS هر boot دوباره INSERT می‌شد و حذف کاربر را خنثی می‌کرد.)
  purgeAutoSeededProductCategories(db);
}

module.exports = {
  BASE, storeRial, toDisplay, fromInput, unitLabel, displayMode,
  migrateTomanToRial, seedStandardSubgroups, guessMahakProductGroup,
  purgeAutoSeededProductCategories,
  seedMahakSubgroups: seedStandardSubgroups,
  MAHAK_PRODUCT_GROUPS, MAHAK_PARTY_GROUPS, LEGACY_SEEDED_PRODUCT_GROUP_NAMES,
};
