#!/usr/bin/env node
// Smoke test for accounting phases 3–8

process.env.DB_PATH = process.env.DB_PATH || require('path').join(__dirname, '..', 'crm-test-phases.db');
const fs = require('fs');
const dbPath = process.env.DB_PATH;
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.error('  ❌', label); }
}

console.log('=== Phase 3–8 smoke test ===');

// Schema
ok('moadian_queue table', !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='moadian_queue'").get());
ok('fixed_assets table', !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fixed_assets'").get());
ok('user_activity_log table', !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_activity_log'").get());
ok('vat_rate setting', db.prepare("SELECT value FROM settings WHERE key='vat_rate'").get()?.value === '10');
ok('coa_vat_payable 2103', !!db.prepare("SELECT code FROM chart_of_accounts WHERE code='2103'").get());

// VAT lib
const { calcDocTotals } = require('../lib/vat');
const uid = db.prepare('SELECT id FROM users LIMIT 1').get()?.id || 1;
db.prepare("INSERT INTO products (user_id,name,code,price,vat_class,stock) VALUES (?,?,?,?,?,?)").run(uid, 'تست', 'T1', 100000, 'standard', 10);
const pid = db.prepare('SELECT id FROM products WHERE code=?').get('T1').id;
const totals = calcDocTotals(db, { rows: [{ product_id: pid, sum: 100000 }], subtotal: 100000 }, 0);
ok('VAT calc 10%', totals.vatAmount === 10000 && totals.final === 110000);

// Moadian enqueue
const { enqueueMoadian } = require('../routes/moadian');
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('moadian_enabled','1')").run();
enqueueMoadian(db, 'sales', 999);
ok('moadian queue insert', !!db.prepare("SELECT id FROM moadian_queue WHERE doc_type='sales' AND doc_id=999").get());

// Fixed assets route module
ok('fixed-assets route loads', typeof require('../routes/fixed-assets') === 'function');

// Fiscal period helpers
const { assertFiscalYearWritable } = require('../lib/fiscal-period');
ok('fiscal-period module', typeof assertFiscalYearWritable === 'function');

// Adv reports routes
const adv = require('../routes/adv-reports');
ok('adv-reports router', typeof adv === 'function');

console.log(`\nResult: ${pass} passed, ${fail} failed`);
try { fs.unlinkSync(dbPath); } catch { /* */ }
process.exit(fail ? 1 : 0);
