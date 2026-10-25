'use strict';
const { swAtLeast } = require('./lib/sw-at-least');
/**
 * v333 — warehouse valuation uses Rial catalog cost without ×10.
 * Reproduces K-00009: cost=20_500_000, avg unset → report must show 20_500_000 not 205_000_000.
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(c, m) {
  if (c) { pass++; console.log('OK  ', m); }
  else { fail++; console.error('FAIL', m); }
}

const helperSrc = fs.readFileSync(path.join(root, 'lib/inventory/product-unit-cost.js'), 'utf8');
const whSrc = fs.readFileSync(path.join(root, 'routes/warehouses.js'), 'utf8');
const ledgerSrc = fs.readFileSync(path.join(root, 'lib/inventory/ledger.js'), 'utf8');
const seedSrc = fs.readFileSync(path.join(root, 'lib/inventory/seed-avg.js'), 'utf8');
const openSrc = fs.readFileSync(path.join(root, 'lib/opening-post.js'), 'utf8');
const prodCostSrc = fs.readFileSync(path.join(root, 'lib/production/costing.js'), 'utf8');
const cycleSrc = fs.readFileSync(path.join(root, 'lib/inventory/cycle-count.js'), 'utf8');
const consignSrc = fs.readFileSync(path.join(root, 'lib/consignments.js'), 'utf8');
const accSrc = fs.readFileSync(path.join(root, 'routes/accounting.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(root, 'db.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');

ok(/function productUnitCostRial/.test(helperSrc), 'canonical productUnitCostRial helper');
ok(/healProductCostRialUnits/.test(helperSrc), 'boot heal for dual-write / inflated avg');
ok(/product-unit-cost/.test(whSrc) && /unitCostRialOf/.test(whSrc), 'warehouse report uses helper');
ok(!/\(Number\(p\.cost\) \|\| 0\) \* 10/.test(whSrc), 'warehouse report no cost×10');
ok(/catalogCostFromAvgRial/.test(ledgerSrc), 'moving avg writes cost in rial');
ok(!/newAvg \/ 10/.test(ledgerSrc), 'ledger no avg/10 toman shadow');
ok(/catalogCostFromAvgRial/.test(seedSrc) && /catalogCostFromAvgRial/.test(openSrc), 'seed/opening sync cost=rial');
ok(/productUnitCostRial/.test(prodCostSrc), 'production avgUnitRial uses helper');
ok(!/legacy products\.cost may be toman/.test(prodCostSrc), 'removed toman legacy comment path');
ok(/productUnitCostRial/.test(cycleSrc), 'cycle-count uses helper');
ok(/productUnitCostRial/.test(consignSrc), 'consignment COGS uses helper');
ok(!/costToman \* 10/.test(consignSrc), 'consignment no costToman×10');
ok(/productUnitCostRial/.test(accSrc), 'sales-return costing uses helper');
ok(/healProductCostRialUnits/.test(dbSrc), 'db boot runs cost rial unify');
ok(/گزارش جامع انبار \(v333\)/.test(appSrc) && /×۱۰/.test(appSrc), 'help documents rial valuation');
ok(swAtLeast(swSrc, 333), 'SW v333');

const { productUnitCostRial, catalogCostFromAvgRial, healProductCostRialUnits } = require('../lib/inventory/product-unit-cost');

ok(productUnitCostRial({ average_cost_rial: 0, cost: 20500000 }) === 20500000,
  'fallback cost is rial (K-00009 case)');
ok(productUnitCostRial({ average_cost_rial: 20500000, cost: 2050000 }) === 20500000,
  'prefers average_cost_rial');
ok(catalogCostFromAvgRial(20500000) === 20500000, 'catalog cost mirrors avg in rial');

try {
  const Better = require('better-sqlite3');
  const db = new Better(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      code TEXT, cost REAL, average_cost_rial REAL, price REAL
    );
  `);
  db.prepare('INSERT INTO products (id,code,cost,average_cost_rial,price) VALUES (1,?,?,?,?)')
    .run('K-00009', 20500000, 0, 23900000);
  db.prepare('INSERT INTO products (id,code,cost,average_cost_rial,price) VALUES (2,?,?,?,?)')
    .run('DUAL', 2050000, 20500000, 23900000);
  db.prepare('INSERT INTO products (id,code,cost,average_cost_rial,price) VALUES (3,?,?,?,?)')
    .run('INFL', 20500000, 205000000, 23900000);

  const heal = healProductCostRialUnits(db);
  ok(heal && heal.ok, 'heal runs once');
  const k = db.prepare('SELECT cost, average_cost_rial FROM products WHERE id=1').get();
  ok(Number(k.average_cost_rial) === 20500000, 'heal seeds avg from catalog cost');
  const d = db.prepare('SELECT cost, average_cost_rial FROM products WHERE id=2').get();
  ok(Number(d.cost) === 20500000, 'heal promotes toman shadow cost to rial');
  const i = db.prepare('SELECT cost, average_cost_rial FROM products WHERE id=3').get();
  ok(Number(i.average_cost_rial) === 20500000, 'heal shrinks avg when avg >> price (x10 trap)');

  const again = healProductCostRialUnits(db);
  ok(again && again.skipped, 'heal idempotent');

  ok(productUnitCostRial({ average_cost_rial: 0, cost: 20500000 }) === 20500000, 'report unit without ×10');
  ok(Math.round(2 * productUnitCostRial({ average_cost_rial: 0, cost: 20500000 })) === 41000000,
    'rial value = qty × cost (not 410M)');
  db.close();
} catch (e) {
  console.log('SKIP runtime sqlite (' + (e && e.message ? e.message.split('\n')[0] : 'no native') + ')');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
