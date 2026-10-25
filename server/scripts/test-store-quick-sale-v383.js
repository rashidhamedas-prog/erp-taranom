'use strict';
const { swAtLeast } = require('./lib/sw-at-least');
/**
 * فروش سریع فروشگاهی v383 — RBAC + walk-in rules + static wiring.
 * Run: node server/scripts/test-store-quick-sale-v383.js
 */
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

console.log('\n══ Store quick sale v383 ══\n');

const root = path.join(__dirname, '..');
const rbac = require('../lib/rbac');
const {
  WALKIN_BIZ, STORE_CHANNEL, ensureWalkinCustomer, isWalkinCustomer,
  prepareStoreQuickSaleBody, assertStoreQuickSaleRules, isStoreRetailRole,
  locksStoreWarehouse, applyRetailRowDefaults,
} = require('../lib/store-quick-sale');
const { fillRoleDefaults } = rbac;

const storePerms = fillRoleDefaults('store_retail');
ok(storePerms.invoices.create === true && storePerms.invoices.view === true, 'store_retail invoices create/view');
ok(storePerms.invoices.delete === false, 'store_retail invoices no delete');
ok(storePerms.products.view === true && storePerms.products.create === false, 'store_retail products view-only');
ok(storePerms.accounting.view === false, 'store_retail no accounting');

const dist = fillRoleDefaults('distribution_office');
ok(dist.invoices.create === true && dist.invoices.view === true, 'distribution_office invoices create/view');
ok(dist.invoices.delete === false && dist.invoices.approve === false, 'distribution_office no delete/approve');

ok(isStoreRetailRole('store_retail') && !isStoreRetailRole('field_sales'), 'isStoreRetailRole');
ok(locksStoreWarehouse('store_retail') && !locksStoreWarehouse('admin'), 'locksStoreWarehouse');
ok(WALKIN_BIZ === 'مشتری نقدی فروشگاه', 'walk-in biz name');
ok(STORE_CHANNEL === 'store_quick', 'store channel constant');

/** Minimal better-sqlite3-like stub for store-quick-sale helpers */
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
    1: { id: 1, role: 'admin', active: 1, sales_warehouse_id: 10 },
    2: { id: 2, role: 'store_retail', active: 1, sales_warehouse_id: 10 },
  };
  const warehouses = { 10: { id: 10, name: 'انبار فروشگاه', code: 'WH-STORE' } };

  function prep(sql) {
    const s = String(sql);
    return {
      get(...args) {
        if (s.includes("FROM settings WHERE key=?")) {
          const v = settings.get(args[0]);
          return v == null ? undefined : { value: v };
        }
        if (s.includes('FROM customers WHERE id=?')) {
          const c = customers.find((x) => x.id === Number(args[0]));
          return c || undefined;
        }
        if (s.includes('FROM customers WHERE biz=?')) {
          return customers.find((x) => x.biz === args[0]) || undefined;
        }
        if (s.includes("FROM users WHERE role='admin'")) {
          return users[1];
        }
        if (s.includes('FROM users ORDER BY id LIMIT 1')) return users[1];
        if (s.includes('FROM users WHERE id=?')) return users[args[0]] || undefined;
        if (s.includes('FROM products WHERE id=?')) return products[args[0]] || undefined;
        if (s.includes('FROM warehouses WHERE id=?')) return warehouses[args[0]] || undefined;
        return undefined;
      },
      run(...args) {
        if (s.includes('INSERT INTO customers')) {
          const row = {
            id: custSeq++,
            user_id: args[0],
            biz: args[1],
            owner: args[2],
            phone: args[3],
            type: args[4],
            status: args[5],
            note: args[6],
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
  return { prepare: prep, _customers: customers, _settings: settings };
}

const db = makeStubDb();
const walkinId = ensureWalkinCustomer(db);
ok(walkinId > 0, 'ensureWalkinCustomer id');
ok(ensureWalkinCustomer(db) === walkinId, 'ensureWalkinCustomer idempotent');
ok(isWalkinCustomer(db, walkinId), 'isWalkinCustomer true');
ok(!isWalkinCustomer(db, 99999), 'isWalkinCustomer false');

const rows = applyRetailRowDefaults(db, [{ product_id: 5, qty: 2 }]);
ok(rows[0].unit_price === 1500 && rows[0].name === 'مانتو تست', 'applyRetailRowDefaults uses retail');

const prepared = prepareStoreQuickSaleBody(db, { id: 2, role: 'store_retail' }, {
  rows: [{ product_id: 5, qty: 1 }],
});
ok(prepared.store_quick === true && prepared.sales_channel === STORE_CHANNEL, 'prepare channel');
ok(prepared.type === 'normal', 'prepare firm type');
ok(Number(prepared.cust_id) === walkinId, 'prepare default walkin cust');
ok(Number(prepared.warehouse_id) === 10, 'prepare warehouse lock');

try {
  assertStoreQuickSaleRules(db, { id: 2, role: 'store_retail' }, {
    cust_id: walkinId,
    pay_type: 'credit',
  }, { final: 1500, invType: 'normal' });
  ok(false, 'walk-in credit must reject');
} catch (e) {
  ok(e.code === 'E_WALKIN_MUST_SETTLE' || e.code === 'E_WALKIN_NO_CREDIT', 'walk-in credit rejected', e.code);
}

try {
  assertStoreQuickSaleRules(db, { id: 2, role: 'store_retail' }, {
    cust_id: walkinId,
    pay_splits: [{ pay_type: 'cash', amount: 1500, cash_box_id: 1 }],
  }, { final: 1500, invType: 'normal' });
  ok(true, 'walk-in full cash OK');
} catch (e) {
  ok(false, 'walk-in full cash OK', e.message);
}

try {
  assertStoreQuickSaleRules(db, { id: 2, role: 'store_retail' }, {
    cust_id: walkinId,
    pay_splits: [{ pay_type: 'cash', amount: 500, cash_box_id: 1 }],
  }, { final: 1500, invType: 'normal' });
  ok(false, 'walk-in partial must reject');
} catch (e) {
  ok(e.code === 'E_WALKIN_MUST_SETTLE', 'walk-in partial E_WALKIN_MUST_SETTLE', e.code);
}

const invSrc = fs.readFileSync(path.join(root, 'routes/invoices.js'), 'utf8');
ok(invSrc.includes("store_retail: 'store_quick'"), 'invoices ROLE_CHANNEL store_retail');
ok(invSrc.includes('assertStoreQuickSaleRules'), 'invoices calls assertStoreQuickSaleRules');
ok(invSrc.includes('locksStoreWarehouse'), 'invoices warehouse lock for store');

const storeSrc = fs.readFileSync(path.join(root, 'routes/store.js'), 'utf8');
ok(storeSrc.includes('/quick-sale') && storeSrc.includes('/bootstrap'), 'store routes');

const captureSrc = fs.readFileSync(path.join(root, 'sync/capture.js'), 'utf8');
ok(captureSrc.includes("'/api/store/quick-sale', 'invoices'"), 'capture maps store quick-sale → invoices');

const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
ok(appSrc.includes("ROUTES['store-quick-sale']") && appSrc.includes('NAV_STORE'), 'app.js route + NAV_STORE');
ok(appSrc.includes('store_retail') && appSrc.includes('فروشگاهی'), 'app.js role label');
ok(appSrc.includes('فروش سریع فروشگاهی'), 'help/UI title present');

const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
ok(serverSrc.includes('/api/store'), 'server mounts /api/store');

const swSrc = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
ok(swAtLeast(swSrc, 383), 'SW v383');

const experts = require('../lib/sales-experts');
ok(experts.SALES_EXPERT_ROLES.includes('store_retail'), 'sales-experts includes store_retail');

// Frontend parse sanity (app.js chunk containing store route)
try {
  // eslint-disable-next-line no-new-func
  new Function(appSrc);
  ok(true, 'app.js parses with new Function');
} catch (e) {
  ok(false, 'app.js parses with new Function', e.message);
}

console.log(`\n══ Result: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail ? 1 : 0);
