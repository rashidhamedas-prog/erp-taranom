'use strict';
/**
 * v465 — lay roll picker must find «سورمه ای» when the matrix color is «سرمه‌ای».
 * The old SQL LIKE ran before colorsMatch and dropped the roll.
 * Run: node server/scripts/test-fabric-color-roll-list-v465.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fr = fs.readFileSync(path.join(__dirname, '../lib/inventory/fabric-rolls.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const idx = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

assert.ok(fr.includes('function fabricColorKeySql'), 'sql color key exists');
assert.ok(fr.includes("fabricColorKeySql('b.color')} = ?"), 'color filter uses the soft key');
assert.ok(app.includes('cuttingExplainMissingRolls'), 'empty picker explains why');
assert.ok(app.includes('v465'), 'help mentions v465');
assert.ok(sw.includes('erp-taranom-v465'));
assert.ok(idx.includes('app.js?v=465'));
new Function(app);

const {
  normalizeFabricColor,
  fabricColorMatchKey,
  fabricColorKeySql,
  colorsMatch,
} = require('../lib/inventory/fabric-rolls');

const navyZwnj = 'سرمه‌ای';
const navyWawSpace = 'سورمه ای';
const navySpace = 'سرمه ای';
const navyZwnjWaw = 'سورمه‌ای';
assert.strictEqual(fabricColorMatchKey(navyZwnj), fabricColorMatchKey(navyWawSpace));
assert.strictEqual(fabricColorMatchKey(navyZwnj), fabricColorMatchKey(navySpace));
assert.strictEqual(fabricColorMatchKey(navyZwnj), fabricColorMatchKey(navyZwnjWaw));
assert.strictEqual(colorsMatch(navyZwnj, navyWawSpace), true);
assert.strictEqual(colorsMatch('قهوه‌ای', 'قهوه ای'), true);
assert.strictEqual(colorsMatch('مشکی', 'شکلاتی'), false);
assert.strictEqual(normalizeFabricColor('سرمه\u00a0ای'), 'سرمه ای');

function openMemory() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(':memory:');
  } catch (_) {
    const Better = require('better-sqlite3');
    return new Better(':memory:');
  }
}
const mem = openMemory();
mem.exec('CREATE TABLE t (color TEXT)');
const ins = mem.prepare('INSERT INTO t (color) VALUES (?)');
for (const c of [navyWawSpace, navySpace, navyZwnj, navyZwnjWaw, 'مشکی', 'قهوه ای']) ins.run(c);
const keySql = fabricColorKeySql('color');
const hit = mem.prepare(`SELECT color FROM t WHERE ${keySql} = ?`).all(fabricColorMatchKey(navyZwnj));
const got = hit.map((r) => r.color).sort();
assert.deepStrictEqual(got, [navySpace, navyZwnj, navyZwnjWaw, navyWawSpace].sort());
const coffee = mem.prepare(`SELECT color FROM t WHERE ${keySql} = ?`).all(fabricColorMatchKey('قهوه‌ای'));
assert.deepStrictEqual(coffee.map((r) => r.color), ['قهوه ای']);
mem.close();
console.log('  OK sql key: سرمه‌ای finds سورمه ای / سرمه ای / سورمه‌ای');

let sqliteBinding = true;
try {
  const B = require('better-sqlite3');
  const probe = new B(':memory:');
  probe.close();
} catch (e) {
  sqliteBinding = false;
  console.log('  SKIP listFabricRolls:', e.message.split('\n')[0]);
}
if (!sqliteBinding) {
  console.log('PASS test-fabric-color-roll-list-v465 (sql key proven; better-sqlite3 binding absent)');
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fab-color-v465-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-fabric-color-roll-list-v465-secret';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;
delete require.cache[require.resolve('../db')];
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get();
const pid = db.prepare(`
  INSERT INTO products (user_id, name, code, price, stock, unit)
  VALUES (?, 'پارچه مموری لایکو دوزی', 'FAB-V465', 0, 0, 'متر')
`).run(admin.id).lastInsertRowid;
const wh = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get();
function addRoll(no, color, width, qty) {
  db.prepare(`
    INSERT INTO inventory_batches
      (batch_no, product_id, warehouse_id, qty_on_hand, qty_received, status, kind, color, width_cm, unit)
    VALUES (?,?,?,?,?, 'active', 'fabric', ?, ?, 'm')
  `).run(no, pid, wh.id, qty, qty, color, width);
}
addRoll('LOT-A', navyWawSpace, 150, 113);
addRoll('LOT-B', 'مشکی', 150, 40);
addRoll('LOT-C', 'قهوه ای', 140, 20);

const { listFabricRolls } = require('../lib/inventory/fabric-rolls');
const listed = listFabricRolls(db, {
  product_id: pid, color: navyZwnj, width_cm: 150, status: 'active', min_qty: '0.01', kind: 'fabric',
});
assert.strictEqual(listed.length, 1, 'matrix navy finds waw+space roll at width 150');
assert.strictEqual(listed[0].batch_no, 'LOT-A');
assert.ok(Number(listed[0].qty_live) >= 113 - 1e-6);
const wrongWidth = listFabricRolls(db, {
  product_id: pid, color: 'قهوه‌ای', width_cm: 150, status: 'active', min_qty: '0.01',
});
assert.strictEqual(wrongWidth.length, 0, 'width 140 is not width 150');
const coffeeList = listFabricRolls(db, {
  product_id: pid, color: 'قهوه‌ای', width_cm: 140, status: 'active', min_qty: '0.01',
});
assert.strictEqual(coffeeList.length, 1);
assert.strictEqual(coffeeList[0].batch_no, 'LOT-C');

console.log('PASS test-fabric-color-roll-list-v465');
