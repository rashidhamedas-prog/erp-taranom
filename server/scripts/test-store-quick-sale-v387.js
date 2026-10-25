'use strict';
const { swAtLeast } = require('./lib/sw-at-least');
/**
 * فروش سریع فروشگاهی v387 — RBAC + cash/wh defaults + exchange wiring + UI static.
 * Run: node server/scripts/test-store-quick-sale-v387.js
 */
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

console.log('\n══ Store quick sale v387 ══\n');

const root = path.join(__dirname, '..');
const {
  STORE_CHANNEL, ensureWalkinCustomer, isWalkinCustomer,
  prepareStoreQuickSaleBody, assertStoreQuickSaleRules,
  locksStoreWarehouse, locksStoreCashBox,
  resolveStoreCashBoxId, resolveStoreWarehouseId,
  scalePaySplitsToNet, prepareExchangeSaleBody, estimateSaleFinalRial,
  bootstrapStoreSale,
} = require('../lib/store-quick-sale');

ok(STORE_CHANNEL === 'store_quick', 'store channel');
ok(locksStoreWarehouse('store_retail') && !locksStoreWarehouse('admin'), 'locks warehouse');
ok(locksStoreCashBox('store_retail') && !locksStoreCashBox('admin'), 'locks cash box');

ok(estimateSaleFinalRial([{ qty: 2, unit_price: 1000, disc_pct: 10 }], 0) === 1800, 'estimate line disc');
ok(estimateSaleFinalRial([{ qty: 1, unit_price: 1000 }], 10) === 900, 'estimate header disc');

const scaled = scalePaySplitsToNet([
  { pay_type: 'cash', amount: 60, cash_box_id: 1 },
  { pay_type: 'pos_card', amount: 40, terminal_id: 2 },
], 50);
ok(scaled.length === 2 && scaled[0].amount + scaled[1].amount === 50, 'scalePaySplitsToNet sums to target');

function makeStubDb() {
  const settings = new Map();
  const customers = [];
  let custSeq = 1;
  const products = {
    5: {
      id: 5, name: 'مانتو تست', code: 'P5', barcode: '2000000000005', unit: 'عدد',
      price: 1000, price_rial: 1000, retail_price: 1500, retail_price_rial: 1500,
    },
  };
  const users = {
    1: { id: 1, role: 'admin', active: 1, sales_warehouse_id: 10, sales_cash_box_id: 3 },
    2: { id: 2, role: 'store_retail', active: 1, sales_warehouse_id: 10, sales_cash_box_id: 3 },
    3: { id: 3, role: 'store_retail', active: 1, sales_warehouse_id: null, sales_cash_box_id: null },
  };
  const warehouses = { 10: { id: 10, name: 'انبار فروشگاه', code: 'WH-STORE' } };
  const cashBoxes = { 3: { id: 3, name: 'صندوق فروشگاه' } };

  function prep(sql) {
    const s = String(sql);
    return {
      get(...args) {
        if (s.includes("FROM settings WHERE key=?")) {
          const v = settings.get(args[0]);
          return v == null ? undefined : { value: v };
        }
        if (s.includes('FROM customers WHERE id=?')) {
          return customers.find((x) => x.id === Number(args[0])) || undefined;
        }
        if (s.includes('FROM customers WHERE biz=?')) {
          return customers.find((x) => x.biz === args[0]) || undefined;
        }
        if (s.includes("FROM users WHERE role='admin'")) return users[1];
        if (s.includes('FROM users ORDER BY id LIMIT 1')) return users[1];
        if (s.includes('FROM users WHERE id=?')) return users[args[0]] || undefined;
        if (s.includes('FROM products WHERE id=?')) return products[args[0]] || undefined;
        if (s.includes('FROM warehouses WHERE id=?')) return warehouses[args[0]] || undefined;
        if (s.includes('FROM cash_boxes WHERE id=?')) return cashBoxes[args[0]] || undefined;
        return undefined;
      },
      all() {
        if (s.includes('FROM warehouses')) return Object.values(warehouses);
        if (s.includes('FROM cash_boxes')) return Object.values(cashBoxes);
        return [];
      },
      run(...args) {
        if (s.includes('INSERT INTO customers')) {
          const row = {
            id: custSeq++,
            user_id: args[0], biz: args[1], owner: args[2], phone: args[3],
            type: args[4], status: args[5], note: args[6],
          };
          customers.push(row);
          return { lastInsertRowid: row.id };
        }
        if (s.includes('INSERT OR REPLACE INTO settings')) {
          settings.set(args[0], String(args[1]));
          return { changes: 1 };
        }
        return { changes: 0 };
      },
    };
  }
  return { prepare: prep };
}

const db = makeStubDb();
const walkinId = ensureWalkinCustomer(db);
ok(isWalkinCustomer(db, walkinId), 'walkin');

ok(resolveStoreWarehouseId(db, { id: 2, role: 'store_retail' }, {}) === 10, 'store wh locked');
ok(resolveStoreCashBoxId(db, { id: 2, role: 'store_retail' }, {}) === 3, 'store cash locked');
try {
  resolveStoreCashBoxId(db, { id: 3, role: 'store_retail' }, {});
  ok(false, 'store without cashbox must fail');
} catch (e) {
  ok(e.code === 'E_STORE_CASHBOX_REQUIRED', 'E_STORE_CASHBOX_REQUIRED', e.code);
}

const prepared = prepareStoreQuickSaleBody(db, { id: 2, role: 'store_retail' }, {
  rows: [{ product_id: 5, qty: 1 }],
  pay_type: 'cash',
  pay_splits: [{ pay_type: 'cash', amount: 1500 }],
});
ok(Number(prepared.warehouse_id) === 10, 'prepare warehouse');
ok(Array.isArray(prepared.pay_splits) && Number(prepared.pay_splits[0].cash_box_id) === 3, 'prepare injects cash box');

const boot = bootstrapStoreSale(db, { id: 2, role: 'store_retail' });
ok(boot.locks_warehouse && boot.locks_cash_box, 'bootstrap locks');
ok(Number(boot.cash_box_id) === 3 && boot.cash_box && boot.cash_box.name, 'bootstrap cash');

const ex = prepareExchangeSaleBody(db, { id: 1, role: 'admin' }, {
  rows: [{ product_id: 5, qty: 1, unit_price: 2000 }],
  cust_id: walkinId,
  pay_type: 'cash',
  cash_box_id: 3,
  pay_splits: [{ pay_type: 'cash', amount: 2000, cash_box_id: 3 }],
  warehouse_id: 10,
}, 500);
ok(ex.netCollect === 1500 && ex.exchangeCreditRial === 500, 'exchange net collect');
ok(ex.body._store_exchange && ex.body._store_exchange.exchange_credit_rial === 500, 'exchange meta on body');

try {
  assertStoreQuickSaleRules(db, { id: 1, role: 'admin' }, {
    cust_id: walkinId,
    pay_splits: [{ pay_type: 'cash', amount: 1500, cash_box_id: 3 }],
  }, { final: 2000, invType: 'normal', exchangeCreditRial: 500 });
  ok(true, 'walk-in exchange settle with credit OK');
} catch (e) {
  ok(false, 'walk-in exchange settle', e.message);
}

const storeSrc = fs.readFileSync(path.join(root, 'routes/store.js'), 'utf8');
ok(storeSrc.includes('/quick-exchange') && storeSrc.includes('createSalesReturn'), 'store exchange route');

const captureSrc = fs.readFileSync(path.join(root, 'sync/capture.js'), 'utf8');
ok(captureSrc.includes("'/api/store/quick-exchange', 'invoices'"), 'capture exchange map');

const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
ok(appSrc.includes('initCustSearches(box)'), 'UI initCustSearches');
ok(appSrc.includes("dest:'store_quick'") || appSrc.includes('dest:\'store_quick\''), 'variant dest store_quick');
ok(appSrc.includes('storeQsAddVariantLines'), 'storeQsAddVariantLines');
ok(appSrc.includes('sales_cash_box_id') && appSrc.includes('u-sales-cashbox'), 'user cash box field');
ok(appSrc.includes("mode='exchange'") || appSrc.includes('mode==="exchange"') || appSrc.includes("mode==='exchange'"), 'exchange mode UI');
ok(appSrc.includes('/store/quick-exchange'), 'UI posts quick-exchange');

const invSrc = fs.readFileSync(path.join(root, 'routes/invoices.js'), 'utf8');
ok(invSrc.includes('exchangeCreditRial') || invSrc.includes('exchange_credit_rial'), 'invoices exchange credit assert');

const dbSrc = fs.readFileSync(path.join(root, 'db.js'), 'utf8');
ok(dbSrc.includes("sales_cash_box_id"), 'db ensureColumn sales_cash_box_id');

const swSrc = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
ok(swAtLeast(swSrc, 387), 'SW v387');

const idxSrc = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
ok((() => { const m = idxSrc.match(/app\.js\?v=(\d+)/); return m && Number(m[1]) >= 387; })(), 'index app.js?v=387+');

try {
  // eslint-disable-next-line no-new-func
  new Function(appSrc);
  ok(true, 'app.js parses');
} catch (e) {
  ok(false, 'app.js parses', e.message);
}

console.log(`\n══ Result: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail ? 1 : 0);
