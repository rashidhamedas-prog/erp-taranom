'use strict';
/**
 * v510 — پارچه با برچسب «کیلوگرم» ولی طاقهٔ متری هم پارچهٔ طاقه‌ای است
 * و خروجی مرحلهٔ برش را به لایه‌چینی می‌برد (ریشهٔ PO-0016).
 * Run: node server/scripts/test-roll-fabric-kg-label-v510.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let n = 0;
function ok(msg) { n += 1; console.log('  ✓', msg); }

const adv = fs.readFileSync(path.join(root, 'lib/production/engine-advanced.js'), 'utf8');
const cutSrc = fs.readFileSync(path.join(root, 'lib/production/cutting.js'), 'utf8');
assert.ok(cutSrc.includes('function isRollFabricProduct'), 'shared roll-fabric detector');
assert.ok(/orderRequiresFabricCutting[\s\S]{0,600}isRollFabricProduct\(db/.test(cutSrc), 'order gate uses detector');
assert.ok(/assertFabricIssueAllowed[\s\S]{0,400}isRollFabricProduct\(db/.test(cutSrc), 'issue gate uses detector');
assert.ok(/function lengthFabricProduct[\s\S]{0,300}isRollFabricProduct\(db/.test(adv), 'stage gate uses detector');
assert.ok(!/isMeterUnit\(prod\.unit\)/.test(adv), 'stage gate no longer reads unit text only');
ok('all lay gates share one detector');

const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
new Function(app);
assert.ok(app.includes('پارچهٔ طاقه‌ای'), 'help explains roll fabric');
ok('app.js parses + help updated');

let Database;
try { Database = require('better-sqlite3'); new Database(':memory:').close(); }
catch (e) {
  console.log('  - skip db part:', e.message.split('\n')[0]);
  console.log('PASS', n);
  process.exit(0);
}
const { isRollFabricProduct, rollFabricUnitLabel } = require('../lib/production/cutting');
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE units_of_measure (id INTEGER PRIMARY KEY, code TEXT, name TEXT, dimension TEXT, unece_code TEXT);
  INSERT INTO units_of_measure VALUES (1,'PCS','عدد','count','H87'),(2,'M','متر','length','MTR'),(3,'KG','کیلوگرم','mass','KGM'),(6,'YD','یارد','length','YRD');
  CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, unit TEXT, unit_id INTEGER);
  INSERT INTO products VALUES
    (14,'دورس سه نخ','کیلوگرم',3),
    (64,'کشبافت','کيلو گرم',NULL),
    (70,'نخ دوخت','کیلوگرم',3),
    (80,'Memory Lycra','یارد',6),
    (90,'زیپ','عدد',1);
  CREATE TABLE inventory_batches (id INTEGER PRIMARY KEY, product_id INTEGER, kind TEXT, unit TEXT, status TEXT);
  INSERT INTO inventory_batches (product_id,kind,unit) VALUES (14,'fabric','m'),(64,'fabric','m'),(70,'attr','کیلوگرم');
  INSERT INTO inventory_batches (product_id,kind,unit,status) VALUES (90,'fabric','m','reversed');
`);
assert.strictEqual(isRollFabricProduct(db, 14), true, 'kg label + metre rolls');
assert.strictEqual(isRollFabricProduct(db, 64), true, 'arabic-yeh kg label without unit_id + metre rolls');
ok('kg-labelled fabric with metre rolls goes through lay-up');
assert.strictEqual(isRollFabricProduct(db, 80), true, 'yard unit');
assert.strictEqual(isRollFabricProduct(db, 70), false, 'kg attr material stays stage issue');
assert.strictEqual(isRollFabricProduct(db, 90), false, 'count material stays stage issue');
assert.strictEqual(isRollFabricProduct(db, 999), false, 'missing product');
ok('yard still roll fabric; kg/count materials without rolls unchanged');
assert.strictEqual(isRollFabricProduct(db, 90), false, 'reversed roll alone does not make roll fabric');
assert.strictEqual(rollFabricUnitLabel(db, { id: 14, unit: 'کیلوگرم' }), 'متر طاقه');
assert.strictEqual(rollFabricUnitLabel(db, { id: 70, unit: 'کیلوگرم' }), 'کیلوگرم');
assert.strictEqual(rollFabricUnitLabel(db, { unit: 'یارد' }), 'یارد');
ok('messages show the roll unit, not «کیلوگرم»');
db.close();
console.log('PASS', n);
