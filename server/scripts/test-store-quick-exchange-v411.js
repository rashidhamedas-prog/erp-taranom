'use strict';
/**
 * تعویض فروشگاهی v411 — سناریوهای مابه‌التفاوت + UI/API wiring.
 * Run: node server/scripts/test-store-quick-exchange-v411.js
 */
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

console.log('\n══ Store quick exchange v411 ══\n');

const root = path.join(__dirname, '..');
const {
  computeExchangeSettlement,
  prepareExchangeSaleBody,
  estimateSaleFinalRial,
  estimateReturnGrossFromLines,
  ensureWalkinCustomer,
  isWalkinCustomer,
} = require('../lib/store-quick-sale');
const { getInvoiceReturnablePack } = require('../lib/sales-return-doc');

// --- settlement matrix ---
const collect = computeExchangeSettlement(2000, 500);
ok(collect.settlementCase === 'collect' && collect.netCollect === 1500
  && collect.refundRial === 0 && collect.exchangeCreditRial === 500, 'case collect');

const refund = computeExchangeSettlement(800, 2000);
ok(refund.settlementCase === 'refund' && refund.refundRial === 1200
  && refund.netCollect === 0 && refund.exchangeCreditRial === 800, 'case refund');

const even = computeExchangeSettlement(1500, 1500);
ok(even.settlementCase === 'even' && even.netCollect === 0 && even.refundRial === 0
  && even.exchangeCreditRial === 1500, 'case even');

ok(estimateReturnGrossFromLines([
  { qty: 2, net_unit: 1000 },
  { qty: 0, net_unit: 999 },
  { qty: 1, price: 500 },
]) === 2500, 'estimateReturnGrossFromLines');

ok(estimateSaleFinalRial([{ qty: 1, unit_price: 3000, disc_pct: 10 }], 0) === 2700, 'sale estimate with disc');

function makeStubDb() {
  const settings = new Map();
  const customers = [];
  let custSeq = 1;
  const products = {
    5: {
      id: 5, name: 'مانتو تست', code: 'P5', barcode: '2000000000005', unit: 'عدد',
      price: 1000, price_rial: 1000, retail_price: 1500, retail_price_rial: 1500,
    },
    6: {
      id: 6, name: 'شلوار تست', code: 'P6', barcode: '2000000000006', unit: 'عدد',
      price: 2000, price_rial: 2000, retail_price: 2500, retail_price_rial: 2500,
    },
  };
  const users = {
    1: { id: 1, role: 'admin', active: 1, sales_warehouse_id: 10, sales_cash_box_id: 3 },
  };
  const warehouses = { 10: { id: 10, name: 'انبار فروشگاه', code: 'WH-STORE' } };
  const cashBoxes = { 3: { id: 3, name: 'صندوق فروشگاه' } };
  const invoices = {
    100: {
      id: 100, cust_id: null, type: 'normal', status: 'posted', deleted_at: 0,
      warehouse_id: 10, disc_amt: 0, subtotal: 3000, final: 3000,
      rows: JSON.stringify([
        { product_id: 5, name: 'مانتو تست', qty: 2, price: 1500, disc: 0, disc_amt: 0 },
        { product_id: 6, name: 'شلوار تست', qty: 1, price: 2500, disc: 0, disc_amt: 0 },
      ]),
    },
  };
  const salesReturns = [];

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
        if (s.includes('FROM invoices i') && s.includes('WHERE i.id=?')) {
          const inv = invoices[args[0]];
          if (!inv) return undefined;
          if (s.includes('AND i.cust_id=?') && Number(args[1]) !== Number(inv.cust_id)) return undefined;
          return { ...inv, cust_biz: 'تست' };
        }
        if (s.includes('FROM invoices WHERE id=?')) {
          return invoices[args[0]] || undefined;
        }
        return undefined;
      },
      all(...args) {
        if (s.includes('FROM warehouses')) return Object.values(warehouses);
        if (s.includes('FROM cash_boxes')) return Object.values(cashBoxes);
        if (s.includes('FROM sales_returns WHERE invoice_id=?')) {
          return salesReturns.filter((r) => Number(r.invoice_id) === Number(args[0]));
        }
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
  return {
    prepare: prep,
    _invoices: invoices,
    _salesReturns: salesReturns,
    _setWalkinOnInvoice(invId, custId) {
      if (invoices[invId]) invoices[invId].cust_id = custId;
    },
    _addPriorReturn(invoiceId, rows) {
      salesReturns.push({
        id: salesReturns.length + 1,
        invoice_id: invoiceId,
        status: 'posted',
        rows: JSON.stringify(rows),
      });
    },
  };
}

const db = makeStubDb();
const walkinId = ensureWalkinCustomer(db);
ok(isWalkinCustomer(db, walkinId), 'walkin');
db._setWalkinOnInvoice(100, walkinId);

const pack = getInvoiceReturnablePack(db, 100, { custId: walkinId, requireFirm: true });
ok(pack.rows.length === 2, 'available 2 lines');
ok(Number(pack.rows.find((r) => Number(r.product_id) === 5).max_returnable) === 2, 'max manto=2');

db._addPriorReturn(100, [{ product_id: 5, qty: 1 }]);
const pack2 = getInvoiceReturnablePack(db, 100, { custId: walkinId, requireFirm: true });
const manto = pack2.rows.find((r) => Number(r.product_id) === 5);
ok(manto && Number(manto.max_returnable) === 1 && Number(manto.already_returned) === 1, 'partial already returned');

// collect: sale 2500, return credit 500 → net 2000
const exCollect = prepareExchangeSaleBody(db, { id: 1, role: 'admin' }, {
  rows: [{ product_id: 6, qty: 1, unit_price: 2500 }],
  cust_id: walkinId,
  pay_type: 'cash',
  cash_box_id: 3,
  pay_splits: [{ pay_type: 'cash', amount: 2500, cash_box_id: 3 }],
  warehouse_id: 10,
}, 500);
ok(exCollect.settlementCase === 'collect' && exCollect.netCollect === 2000, 'prepare collect');
ok(Array.isArray(exCollect.body.pay_splits) && exCollect.body.pay_splits[0].amount === 2000, 'scaled tender');

// refund: sale 800, return 2000
const exRefund = prepareExchangeSaleBody(db, { id: 1, role: 'admin' }, {
  rows: [{ product_id: 5, qty: 1, unit_price: 800 }],
  cust_id: walkinId,
  pay_type: 'cash',
  cash_box_id: 3,
  warehouse_id: 10,
}, 2000);
ok(exRefund.settlementCase === 'refund' && exRefund.refundRial === 1200
  && exRefund.exchangeCreditRial === 800 && !exRefund.body.pay_splits.length, 'prepare refund');

// even
const exEven = prepareExchangeSaleBody(db, { id: 1, role: 'admin' }, {
  rows: [{ product_id: 5, qty: 1, unit_price: 1500 }],
  cust_id: walkinId,
  pay_type: 'cash',
  cash_box_id: 3,
  warehouse_id: 10,
}, 1500);
ok(exEven.settlementCase === 'even' && exEven.netCollect === 0 && exEven.refundRial === 0, 'prepare even');

// multi-item estimate
const multiGross = estimateReturnGrossFromLines([
  { qty: 1, net_unit: 1500 },
  { qty: 1, net_unit: 2500 },
]);
const multiSale = estimateSaleFinalRial([
  { qty: 1, unit_price: 2000 },
  { qty: 1, unit_price: 3000 },
], 0);
const multi = computeExchangeSettlement(multiSale, multiGross);
ok(multi.settlementCase === 'collect' && multi.netCollect === 1000, 'multi item collect');

// wiring
const storeSrc = fs.readFileSync(path.join(root, 'routes/store.js'), 'utf8');
ok(storeSrc.includes('/exchange-available/') && storeSrc.includes('rollbackExchange'), 'store routes exchange-available+rollback');
ok(storeSrc.includes('/customer-firm-invoices/'), 'store firm invoices');
ok(storeSrc.includes('voidSalesReturn') && storeSrc.includes('voidInvoiceFully'), 'compensate void');

const srSrc = fs.readFileSync(path.join(root, 'lib/sales-return-doc.js'), 'utf8');
ok(srSrc.includes('getInvoiceReturnablePack'), 'getInvoiceReturnablePack exported');

const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
ok(appSrc.includes('storeQsSetAllReturnMax') && appSrc.includes('max_returnable'), 'UI max returnable');
ok(appSrc.includes('settlement_case') || appSrc.includes('storeQsSettlementCase'), 'UI settlement case');
ok(appSrc.includes('/store/exchange-available/'), 'UI calls exchange-available');
ok(appSrc.includes('مابه‌التفاوت') || appSrc.includes('استرداد به مشتری'), 'UI labels');

const captureSrc = fs.readFileSync(path.join(root, 'sync/capture.js'), 'utf8');
ok(captureSrc.includes("'/api/store/quick-exchange', 'invoices'"), 'capture map');

const swSrc = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
ok(swSrc.includes('erp-taranom-v412'), 'SW v412');

const idxSrc = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
ok(idxSrc.includes('app.js?v=412'), 'index app.js?v=412');

try {
  // eslint-disable-next-line no-new-func
  new Function(appSrc);
  ok(true, 'app.js parses');
} catch (e) {
  ok(false, 'app.js parses', e.message);
}

console.log(`\n══ Result: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail ? 1 : 0);
