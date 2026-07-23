#!/usr/bin/env node
/** Unit checks: rebuildBaseCoa + releaseTafsili cascade. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { rebuildBaseCoa, allocTafsili, releaseTafsili, LEGACY } = require('../lib/coa-map');

const dbPath = path.join(os.tmpdir(), 'coa-release-' + Date.now() + '.db');
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE chart_of_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT,
    type TEXT,
    parent_code TEXT,
    level INTEGER DEFAULT 0,
    nature TEXT,
    tafsili_type TEXT
  );
  CREATE TABLE journal_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_code TEXT NOT NULL,
    debit REAL DEFAULT 0,
    credit REAL DEFAULT 0
  );
  CREATE TABLE products (id INTEGER PRIMARY KEY, coa_code TEXT, name TEXT);
  CREATE TABLE persons (id INTEGER PRIMARY KEY, coa_code TEXT);
  CREATE TABLE parties (id INTEGER PRIMARY KEY, coa_code TEXT);
  CREATE TABLE customers (id INTEGER PRIMARY KEY, coa_code TEXT);
  CREATE TABLE suppliers (id INTEGER PRIMARY KEY, coa_code TEXT);
  CREATE TABLE banks (id INTEGER PRIMARY KEY, coa_code TEXT);
  CREATE TABLE cash_boxes (id INTEGER PRIMARY KEY, coa_code TEXT);
`);

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label); }
}

const n = rebuildBaseCoa(db);
ok(n >= 50, `rebuildBaseCoa inserted ${n} accounts`);
ok(!!db.prepare('SELECT 1 FROM chart_of_accounts WHERE code=?').get(LEGACY.coa_receivable.code), 'receivable control present');
ok(!!db.prepare('SELECT 1 FROM chart_of_accounts WHERE code=?').get(LEGACY.coa_wip.code), 'WIP control present');
ok(db.prepare("SELECT value FROM settings WHERE key='coa_mode'").get()?.value === 'standard', 'coa_mode=standard');

const code = allocTafsili(db, 'product', 'کالای تست');
ok(!!code && code.length === 12, `allocTafsili product → ${code}`);
db.prepare('INSERT INTO products (id,coa_code,name) VALUES (1,?,?)').run(code, 'کالای تست');

const blocked = releaseTafsili(db, code);
ok(!blocked.ok && blocked.reason === 'linked', 'release blocked while product linked');

db.prepare('DELETE FROM products WHERE id=1').run();
const freed = releaseTafsili(db, code);
ok(freed.ok, 'release ok after product gone');
ok(!db.prepare('SELECT 1 FROM chart_of_accounts WHERE code=?').get(code), 'detail row deleted');

const code2 = allocTafsili(db, 'person', 'شخص تست');
db.prepare('INSERT INTO journal_lines (account_code,debit) VALUES (?,100)').run(code2);
const inUse = releaseTafsili(db, code2);
ok(!inUse.ok && inUse.reason === 'in_use', 'release blocked when journal has lines');

db.close();
try { fs.unlinkSync(dbPath); } catch (_) {}
console.log(fail ? `\n💥 ${pass} passed, ${fail} failed` : `\n🎉 ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
