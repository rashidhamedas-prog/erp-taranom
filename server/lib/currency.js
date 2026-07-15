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

/** Mahak product group names from full data.xlsx — گروه کالا sheet. */
const MAHAK_PRODUCT_GROUPS = [
  { code: 0, name: 'کلیه کالاها', parent: null },
  { code: 1, name: 'پارچه', parent: 0 },
  { code: 2, name: 'خرج کار', parent: 0 },
  { code: 3, name: 'زیپ ها', parent: 0 },
  { code: 4, name: 'اثاثه', parent: 0 },
  { code: 5, name: 'لینن', parent: 0 },
  { code: 6, name: 'زمستونی', parent: 0 },
  { code: 8, name: 'لی', parent: 0 },
  { code: 9, name: 'خرید محصول متفرقه', parent: 0 },
  { code: 10, name: 'کتان', parent: 0 },
  { code: 11, name: 'برش خورده', parent: 0 },
  { code: 12, name: 'متفرقه', parent: 0 },
  { code: 13, name: 'مواد اولیه', parent: 0 },
  { code: 14, name: 'محصول نهایی', parent: 0 },
];

/** Mahak person groups from full data.xlsx — گروه اشخاص sheet. */
const MAHAK_PARTY_GROUPS = [
  { code: 0, name: 'کلیه اشخاص', entity_type: 'all' },
  { code: 1, name: 'مشتریان', entity_type: 'customer' },
  { code: 2, name: 'فروشندگان', entity_type: 'supplier' },
  { code: 3, name: 'پرسنل', entity_type: 'person' },
  { code: 4, name: 'وام‌ها', entity_type: 'person' },
  { code: 5, name: 'بازاریاب', entity_type: 'person' },
  { code: 6, name: 'دوزندگان بیرون بر', entity_type: 'person' },
  { code: 7, name: 'فروشگاه‌های ترنم', entity_type: 'customer' },
];

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

  const pgCount = db.prepare('SELECT COUNT(*) c FROM party_groups').get().c;
  const insPg = db.prepare('INSERT OR IGNORE INTO party_groups (code,name,entity_type,description) VALUES (?,?,?,?)');
  const updPg = db.prepare('UPDATE party_groups SET entity_type=?,description=? WHERE name=?');
  for (const g of MAHAK_PARTY_GROUPS) {
    insPg.run(g.code, g.name, g.entity_type, 'گروه استاندارد');
    updPg.run(g.entity_type, 'گروه استاندارد', g.name);
  }

  const insCat = db.prepare('INSERT OR IGNORE INTO product_categories (name,code,parent_id,sort_order,description) VALUES (?,?,?,?,?)');
  const updCat = db.prepare('UPDATE product_categories SET code=?,sort_order=?,description=? WHERE name=?');
  const catByName = new Map();
  const getId = (name) => {
    if (catByName.has(name)) return catByName.get(name);
    const r = db.prepare('SELECT id FROM product_categories WHERE name=?').get(name);
    if (r) { catByName.set(name, r.id); return r.id; }
    return null;
  };

  for (const g of MAHAK_PRODUCT_GROUPS) {
    insCat.run(g.name, g.code, null, g.code, 'گروه استاندارد');
    updCat.run(g.code, g.code, 'گروه استاندارد', g.name);
  }
  for (const g of MAHAK_PRODUCT_GROUPS) {
    if (g.parent == null) continue;
    const parentName = MAHAK_PRODUCT_GROUPS.find(x => x.code === g.parent)?.name;
    const parentId = parentName ? getId(parentName) : null;
    if (parentId) db.prepare('UPDATE product_categories SET parent_id=? WHERE name=?').run(parentId, g.name);
  }
}

module.exports = {
  BASE, storeRial, toDisplay, fromInput, unitLabel, displayMode,
  migrateTomanToRial, seedStandardSubgroups, guessMahakProductGroup,
  seedMahakSubgroups: seedStandardSubgroups,
  MAHAK_PRODUCT_GROUPS, MAHAK_PARTY_GROUPS,
};
