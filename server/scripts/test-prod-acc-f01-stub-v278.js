'use strict';
/**
 * PROD-ACC PA-03 — F01 stub (no native sqlite, runs on any Node)
 * Companion to test-prod-acc-f01-issue-v278.js, which needs a better-sqlite3 build.
 * Asserts issueFromStock reads warehouse qty (not products.stock) when warehouseId is
 * set, never writes warehouse_stock/products directly, and routes qty through
 * postInventoryMovement.
 * Run: node server/scripts/test-prod-acc-f01-stub-v278.js
 */
const fs = require('fs');
const path = require('path');

const ledgerPath = require.resolve('../lib/inventory/ledger');
const apparelPath = require.resolve('../lib/inventory/apparel-lines');

const movements = [];
const whQtyCalls = [];
const WH_QTY = { 1: 5, 2: 95 };

function stubModule(filename, exports) {
  require.cache[filename] = {
    id: filename, filename, loaded: true, children: [], paths: [], exports,
  };
}

// Stub inventory modules before costing.js destructures them at require time.
stubModule(ledgerPath, {
  postInventoryMovement(db, opts) {
    movements.push(opts);
    return { id: movements.length, unit_cost_rial: opts.unitCostRial, amount_rial: opts.amountRial };
  },
  warehouseQty(db, productId, warehouseId) {
    whQtyCalls.push({ productId, warehouseId });
    return Object.prototype.hasOwnProperty.call(WH_QTY, warehouseId) ? WH_QTY[warehouseId] : 0;
  },
  ensureWhRow() {},
});
stubModule(apparelPath, {
  resolveApparelLines: () => [],
  // Non-matrix stub: one ledger row, same as the real helper for a product without variants.
  postLedgerByVariant: (db, opts) => {
    const r = require(ledgerPath).postInventoryMovement(db, opts);
    return { ...r, ids: [r.id] };
  },
  ledgerGroupIds: (db, id) => [id],
  reverseLedgerGroup: () => [],
});

const PRODUCT = { id: 7, stock: 100, name: 'نخ تست', average_cost_rial: 1000, cost: 100 };
const sqlRuns = [];

function fakeDb(settings = {}) {
  return {
    prepare(sql) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      return {
        get(...args) {
          if (/FROM settings/i.test(s)) return { value: settings[args[0]] };
          if (/FROM products/i.test(s)) return { ...PRODUCT };
          return undefined;
        },
        all() { return []; },
        run() { sqlRuns.push(s); return { changes: 1, lastInsertRowid: 1 }; },
      };
    },
    transaction(fn) { return (...args) => fn(...args); },
  };
}

const { issueFromStock } = require('../lib/production/costing');

let passed = 0, failed = 0;
function ok(c, m) {
  if (c) { passed++; console.log('  OK', m); } else { failed++; console.error('  FAIL', m); }
}

console.log('F01 — shortage in WH-A (qty 5) must not be masked by products.stock=100');
const db = fakeDb();
let threw = null;
try {
  issueFromStock(db, { productId: PRODUCT.id, warehouseId: 1, qty: 10, userId: 1, note: 'test' });
} catch (e) { threw = e; }
ok(!!threw && (threw.code === 'E_NEGATIVE_STOCK' || threw.message === 'E_NEGATIVE_STOCK'), 'throws E_NEGATIVE_STOCK');
ok(threw && Number(threw.extra?.available) === 5, `available=5 (warehouse qty) got ${threw && threw.extra && threw.extra.available}`);
ok(threw && Number(threw.extra?.warehouse_id) === 1, 'error carries warehouse_id');
ok(whQtyCalls.length === 1 && whQtyCalls[0].warehouseId === 1, 'warehouseQty() consulted for warehouse availability');
ok(movements.length === 0, 'no inventory movement posted on shortage');
ok(sqlRuns.length === 0, 'no direct writes on shortage');

console.log('F01 — successful issue of 3 from WH-A');
const r = issueFromStock(db, { productId: PRODUCT.id, warehouseId: 1, qty: 3, userId: 1 });
ok(r.ok && r.qty === 3, 'issue 3 ok');
ok(movements.length === 1, 'exactly one inventory movement');
const mv = movements[0] || {};
ok(mv.eventType === 'production_issue', `eventType=production_issue got ${mv.eventType}`);
ok(mv.qtyOut === 3 && mv.warehouseId === 1, 'movement carries qtyOut=3 and warehouseId');
ok(mv.updateAvg === false, 'issue does not move the average');
ok(mv.unitCostRial === 1000 && mv.amountRial === 3000, `unit/amount rial 1000/3000 got ${mv.unitCostRial}/${mv.amountRial}`);
ok(r.remaining === 2, `remaining=2 got ${r.remaining}`);
ok(sqlRuns.length === 0, 'no direct warehouse_stock/products/stock_logs writes');

console.log('F01 — allow-negative setting bypasses the guard');
const dbNeg = fakeDb({ production_allow_negative_stock: '1' });
let negErr = null;
try { issueFromStock(dbNeg, { productId: PRODUCT.id, warehouseId: 1, qty: 10, userId: 1 }); }
catch (e) { negErr = e; }
ok(!negErr, 'no throw when allow-negative is on');
ok(movements.length === 2 && movements[1].allowNegative === true, 'allowNegative forwarded to ledger');

console.log('F01 — no-warehouse issue falls back to products.stock');
const dbNoWh = fakeDb();
const r2 = issueFromStock(dbNoWh, { productId: PRODUCT.id, qty: 10, userId: 1 });
ok(r2.ok && r2.remaining === 90, `header fallback remaining=90 got ${r2.remaining}`);
ok(movements.length === 3 && movements[2].warehouseId === null, 'movement warehouseId null without warehouse');

console.log('F01 — source has no stock-rewrite SQL');
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'production', 'costing.js'), 'utf8');
ok(!/UPDATE\s+warehouse_stock/i.test(src), 'costing.js contains no UPDATE warehouse_stock');
ok(!/UPDATE\s+products\s+SET[^;]*stock/i.test(src), 'costing.js contains no UPDATE products SET stock');
ok(!/INSERT\s+INTO\s+stock_logs/i.test(src), 'costing.js contains no direct stock_logs insert');

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
