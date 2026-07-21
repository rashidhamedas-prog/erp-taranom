/**
 * Accounting gap schema, routes, legal reserve helper — run: node server/scripts/test-accounting-gap.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-'));
const dbFile = path.join(dir, 't.db');
try { fs.unlinkSync(dbFile); } catch (_) {}
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test';

delete require.cache[require.resolve('../db')];
try { delete require.cache[require.resolve('../lib/coa-map')]; } catch (_) {}

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra || ''); }
}

function hasCol(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}

const GAP_TABLES = [
  'bank_reconciliations', 'budgets', 'legal_reserve_entries',
  'inventory_nrv_provisions', 'payroll_labor_settings',
];

console.log('\n— gap schema tables —');
GAP_TABLES.forEach(t => {
  ok(!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t), 'table ' + t);
});

console.log('\n— gap columns —');
ok(hasCol('invoices', 'moadian_invoice_type'), 'invoices.moadian_invoice_type');
ok(hasCol('products', 'tax_stuff_id'), 'products.tax_stuff_id');
ok(hasCol('fixed_assets', 'depreciation_method'), 'fixed_assets.depreciation_method');

console.log('\n— route modules load —');
['bank-reconciliation', 'budgeting', 'reserves', 'moadian', 'adv-reports'].forEach(mod => {
  try {
    const r = require('../routes/' + mod);
    ok(!!r, 'route ' + mod + ' loads');
  } catch (e) {
    ok(false, 'route ' + mod + ' loads', e.message);
  }
});

console.log('\n— legal reserve helper —');
const { computeLegalReserveRial } = require('../lib/reserves/legal-reserve');
const reserve = computeLegalReserveRial(db, 100_000_000, 1_000_000_000);
ok(reserve === 5_000_000, 'computeLegalReserveRial 5% capped', 'got ' + reserve);
const capped = computeLegalReserveRial(db, 100_000_000, 10_000_000);
ok(capped === 1_000_000, 'computeLegalReserveRial 10% capital headroom', 'got ' + capped);

console.log('\n— cash-flow report shape (adv-reports stack) —');
try {
  const adv = require('../routes/adv-reports');
  const stack = adv.stack || [];
  const hasCashFlow = stack.some(l => l.route && l.route.path === '/cash-flow');
  ok(hasCashFlow, 'adv-reports registers GET /cash-flow');
} catch (e) {
  ok(false, 'adv-reports cash-flow route', e.message);
}

console.log('\n— persist moadian/tax fields via SQL (schema round-trip) —');
db.prepare("UPDATE settings SET value='1000000000' WHERE key='company_capital_rial'").run();
const custId = db.prepare("INSERT INTO customers (user_id,biz,status) VALUES (1,'مشتری گپ','active')").run().lastInsertRowid;
const invId = db.prepare(`
  INSERT INTO invoices (user_id,cust_id,num,type,date,rows,subtotal,final,moadian_invoice_type)
  VALUES (1,?, 'G-1','proforma','1405/01/01','[]',0,0,2)
`).run(custId).lastInsertRowid;
ok(db.prepare('SELECT moadian_invoice_type FROM invoices WHERE id=?').get(invId).moadian_invoice_type === 2,
  'invoices moadian_invoice_type persists');
const prodId = db.prepare(`
  INSERT INTO products (user_id,code,name,price,tax_stuff_id) VALUES (1,'G-P','گپ',0,'1234567890123')
`).run().lastInsertRowid;
ok(db.prepare('SELECT tax_stuff_id FROM products WHERE id=?').get(prodId).tax_stuff_id === '1234567890123',
  'products tax_stuff_id persists');

try { db.close(); } catch (_) {}
try { fs.unlinkSync(dbFile); } catch (_) {}
try { fs.unlinkSync(dbFile + '-wal'); } catch (_) {}
try { fs.unlinkSync(dbFile + '-shm'); } catch (_) {}
try { fs.rmdirSync(dir); } catch (_) {}

console.log('\n' + (fail ? `FAILED ${fail}` : 'ALL CHECKS PASSED') + ` (${pass} pass, ${fail} fail)`);
process.exit(fail ? 1 : 0);
