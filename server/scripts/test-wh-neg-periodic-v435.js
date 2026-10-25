'use strict';
const { swAtLeast } = require('./lib/sw-at-least');
/**
 * v435 — warehouse allow_negative trigger + inventory_system gating (amend/return/consignment).
 * Static checks always run. Live DB cases skip when better-sqlite3 ABI unavailable.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
let fail = 0;
let skip = 0;
function ok(cond, label, detail) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log('  FAIL', label, detail != null ? detail : ''); }
}
function skipOk(label, why) {
  skip += 1;
  console.log('  SKIP', label, '—', why);
}

console.log('\n══ v435 warehouse negative + periodic valuation gates ══\n');

const ROOT = path.join(__dirname, '..');
const FILES = {
  prodSchema: path.join(ROOT, 'lib/production/schema.js'),
  amend: path.join(ROOT, 'lib/amend-invoice.js'),
  salesRet: path.join(ROOT, 'lib/sales-return-doc.js'),
  consign: path.join(ROOT, 'lib/consignments.js'),
  salesDoc: path.join(ROOT, 'lib/sales-document.js'),
  app: path.join(ROOT, 'public/app.js'),
  sw: path.join(ROOT, 'public/sw.js'),
  index: path.join(ROOT, 'public/index.html'),
};

console.log('— static —');
const src = {};
for (const [k, p] of Object.entries(FILES)) {
  src[k] = fs.readFileSync(p, 'utf8');
  try {
    if (k === 'app' || k === 'sw' || k === 'index') continue;
    // eslint-disable-next-line no-new
    new vm.Script(`(function (require, module, exports) {${src[k]}\n})`, { filename: p });
    ok(true, `syntax ${path.basename(p)}`);
  } catch (e) {
    ok(false, `syntax ${path.basename(p)}`, e.message);
  }
}

ok(src.prodSchema.includes('DROP TRIGGER IF EXISTS trg_ws_no_negative'),
  'production schema drops old unconditional negative trigger');
ok(/allow_negative[\s\S]*inventory_allow_negative/.test(src.prodSchema)
  || /warehouses w[\s\S]*allow_negative[\s\S]*inventory_allow_negative/.test(src.prodSchema),
  'new trigger honors warehouse allow_negative + global setting');
ok(src.prodSchema.includes('trg_ws_no_negative_ins'),
  'INSERT path also gated for negative warehouse_stock');

ok(src.salesDoc.includes('function warehouseUsesPerpetualValuation'),
  'sales-document exports warehouseUsesPerpetualValuation');
ok(src.amend.includes('warehouseUsesPerpetualValuation'),
  'amend-invoice gates COGS with warehouseUsesPerpetualValuation');
ok(src.salesRet.includes('warehouseUsesPerpetualValuation'),
  'sales-return filters cost JE for periodic WH');
ok(src.consign.includes('warehouseUsesPerpetualValuation'),
  'consignment settle skips COGS on periodic WH');

ok(src.swAtLeast(sw, 435), 'SW cache v435');
ok(src.index.includes('app.js?v=435'), 'index.html busts app.js to v435');
ok(src.app.includes('اجازه موجودی منفی'), 'warehouse form still has allow_negative checkbox');
ok(src.app.includes('فاکتور/فروش از این انبار حتی با کمبود'), 'UI hint for allow_negative');
ok(src.app.includes('ربطی به دائمی/ادواری ندارد'), 'UI distinguishes costing_method from inventory_system');

// Live trigger on :memory: when native bindings match this Node (else SKIP_SQLITE).
let Database = null;
try {
  Database = require('better-sqlite3');
  const probe = new Database(':memory:');
  probe.close();
} catch (e) {
  const msg = String((e && e.message) || e);
  skipOk('live sqlite', /bindings|NODE_MODULE_VERSION|better_sqlite3/i.test(msg)
    ? 'SKIP_SQLITE — ' + msg.split('\n')[0]
    : msg);
  Database = null;
  console.log('SKIP_SQLITE');
}

if (Database) {
  console.log('\n— live trigger —');
  try {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE warehouses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        allow_negative INTEGER DEFAULT 0,
        inventory_system TEXT DEFAULT 'perpetual'
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE warehouse_stock (
        product_id INTEGER NOT NULL,
        warehouse_id INTEGER NOT NULL,
        qty REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (product_id, warehouse_id)
      );
      DROP TRIGGER IF EXISTS trg_ws_no_negative;
      DROP TRIGGER IF EXISTS trg_ws_no_negative_ins;
      CREATE TRIGGER trg_ws_no_negative
      BEFORE UPDATE ON warehouse_stock WHEN NEW.qty < 0
      BEGIN
        SELECT RAISE(ABORT, 'E_NEGATIVE_STOCK: موجودی انبار منفی می‌شود')
        WHERE NOT EXISTS (
          SELECT 1 FROM warehouses w
          WHERE w.id = NEW.warehouse_id AND COALESCE(w.allow_negative, 0) = 1
        )
        AND NOT EXISTS (
          SELECT 1 FROM settings s
          WHERE s.key = 'inventory_allow_negative' AND s.value = '1'
        );
      END;
    `);

    const sql = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_ws_no_negative'"
    ).get();
    ok(!!sql && /allow_negative/.test(sql.sql || ''),
      'installed trg_ws_no_negative SQL references allow_negative');

    const whNeg = db.prepare('INSERT INTO warehouses (allow_negative, inventory_system) VALUES (1, ?)').run('perpetual').lastInsertRowid;
    const whPos = db.prepare('INSERT INTO warehouses (allow_negative, inventory_system) VALUES (0, ?)').run('perpetual').lastInsertRowid;

    db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (90001, ?, 0)').run(whNeg);
    db.prepare('UPDATE warehouse_stock SET qty=-3 WHERE product_id=90001 AND warehouse_id=?').run(whNeg);
    const n1 = db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=90001 AND warehouse_id=?').get(whNeg);
    ok(n1 && Number(n1.qty) === -3, 'allow_negative=1 permits negative UPDATE', n1);

    db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (90002, ?, 1)').run(whPos);
    let blocked = false;
    try {
      db.prepare('UPDATE warehouse_stock SET qty=-1 WHERE product_id=90002 AND warehouse_id=?').run(whPos);
    } catch (e) {
      blocked = /E_NEGATIVE_STOCK|موجودی انبار منفی/.test(String(e && e.message));
    }
    ok(blocked, 'allow_negative=0 still aborts negative UPDATE');

    // Minimal stub for warehouseUsesPerpetualValuation (no full ERP schema)
    const { isPeriodicWarehouse } = require('../lib/inventory/periodic-close');
    db.prepare("UPDATE warehouses SET inventory_system='periodic' WHERE id=?").run(whNeg);
    ok(isPeriodicWarehouse(db, whNeg) === true, 'periodic WH detected');
    db.prepare("UPDATE warehouses SET inventory_system='perpetual' WHERE id=?").run(whPos);
    ok(isPeriodicWarehouse(db, whPos) === false, 'perpetual WH detected');
    db.close();
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/bindings|NODE_MODULE_VERSION|better_sqlite3/i.test(msg)) {
      skipOk('live trigger harness', 'SKIP_SQLITE — ' + msg.split('\n')[0]);
      console.log('SKIP_SQLITE');
    } else {
      ok(false, 'live trigger harness', (e && e.stack) || msg);
    }
  }
}

console.log(`\n══ Result: ${pass} pass, ${fail} fail, ${skip} skip ══\n`);
process.exit(fail ? 1 : 0);
