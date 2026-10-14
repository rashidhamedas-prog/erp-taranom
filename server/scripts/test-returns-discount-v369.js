/**
 * v370 — return discounts: line + header from invoice + extra on return.
 * Pure unit tests + mock-DB JE balance (no native better-sqlite3 required).
 */
'use strict';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; console.log('  OK', msg); }
  else { failed += 1; console.error('  FAIL', msg); }
}

const {
  lineOrigDiscAmt, prorateLineDiscount, allocateHeaderDiscount,
  resolveExtraDiscount, computeReturnTotals, returnMoneyParts,
} = require('../lib/returns-discount');

console.log('--- returns-discount pure ---');

ok(lineOrigDiscAmt({ qty: 10, price: 1000, disc: 10 }) === 1000, 'line disc from pct');
ok(lineOrigDiscAmt({ qty: 10, price: 1000, disc_amt: 500, disc: 0 }) === 500, 'line disc prefers disc_amt');

const p1 = prorateLineDiscount({ qty: 10, price: 1000, disc_amt: 1000 }, 4, 0);
ok(p1.discAmt === 400, 'partial line disc 40%');
const p2 = prorateLineDiscount({ qty: 10, price: 1000, disc_amt: 1000 }, 6, 4);
ok(p2.discAmt === 600, 'remainder takes leftover disc exactly');
ok(p1.discAmt + p2.discAmt === 1000, 'two slices sum to original disc');

ok(allocateHeaderDiscount({
  invoiceDiscAmt: 10000, invoiceSubtotal: 100000, goodsAmountA: 50000,
  priorHdrUsed: 0, remainingGoodsOnInvoice: 100000,
}) === 5000, 'header 50% share');

ok(allocateHeaderDiscount({
  invoiceDiscAmt: 10000, invoiceSubtotal: 100000, goodsAmountA: 50000,
  priorHdrUsed: 5000, remainingGoodsOnInvoice: 50000,
}) === 5000, 'last remaining goods takes remaining header');

try {
  resolveExtraDiscount({ extraDiscAmt: 999999, extraDiscPct: 0, maxBase: 100 });
  ok(false, 'extra over cap should throw');
} catch (e) {
  ok(e.code === 'E_RET_EXTRA_DISC', 'extra over cap E_RET_EXTRA_DISC');
}

const t = computeReturnTotals({
  goodsAmountA: 90000,
  invoiceDiscAmt: 10000,
  invoiceSubtotal: 100000,
  priorHdrUsed: 0,
  remainingGoodsOnInvoice: 100000,
  extraDiscAmt: 5000,
  extraDiscPct: 0,
  sourceVat: 9000,
  sourceNetBase: 90000,
  vatSettingOn: true,
  priorVatUsed: 0,
});
ok(t.goodsAmount === 90000, 'goods A');
ok(t.hdrDiscAmt === 9000, 'H = 10k * 90/100');
ok(t.extraDiscAmt === 5000, 'extra X');
ok(t.amount === 76000, 'N = A-H-X');
ok(t.vatAmount > 0 && t.vatAmount <= 9000, 'VAT proportional capped');
ok(t.gross === t.amount + t.vatAmount, 'gross = N+V');

const legacy = returnMoneyParts({ amount: 50000, vat_amount: 4500 });
ok(legacy.goodsAmount === 50000 && legacy.hdrDiscAmt === 0 && legacy.gross === 54500, 'legacy parts');

const modern = returnMoneyParts({
  amount: 76000, goods_amount: 90000, hdr_disc_amt: 9000, extra_disc_amt: 5000, vat_amount: 7600,
});
ok(modern.goodsAmount === 90000 && modern.amountNet === 76000 && modern.discTotal === 14000, 'modern parts');

console.log('--- JE with discount (mock db) ---');

function makeMockDb() {
  const settings = {
    coa_sales_return: '4102',
    coa_sales_discount: '4103',
    coa_receivable: '1103',
    coa_payable: '2101',
    coa_vat_payable: '2130',
    coa_vat_receivable: '1140',
    coa_cogs: '5101',
    coa_inventory: '1104',
    coa_adjustment: '5501',
    coa_raw_materials: '1110',
  };
  const names = {
    4102: 'برگشت فروش', 4103: 'تخفیفات فروش', 1103: 'دریافتنی', 2101: 'پرداختنی',
    2130: 'VAT پرداختنی', 1140: 'VAT دریافتنی', 5101: 'COGS', 1104: 'موجودی', 5501: 'تعدیل', 1110: 'مواد',
  };
  return {
    prepare(sql) {
      if (/FROM settings WHERE key/.test(sql)) {
        return { get: (k) => (settings[k] != null ? { value: settings[k] } : null) };
      }
      if (/FROM chart_of_accounts WHERE code/.test(sql)) {
        return { get: (code) => (names[code] ? { code, name: names[code] } : null) };
      }
      if (/FROM customers/.test(sql) || /FROM suppliers/.test(sql)) {
        return { get: () => null };
      }
      if (/FROM warehouses/.test(sql)) {
        return { get: () => ({ inventory_coa: null, type: 'finished' }) };
      }
      return { get: () => null, all: () => [], run: () => ({ lastInsertRowid: 1 }) };
    },
  };
}

const {
  buildSalesReturnJournalLines, buildPurchaseReturnJournalLines,
} = require('../lib/returns-posting');
const mock = makeMockDb();

const sLines = buildSalesReturnJournalLines(mock, {
  custId: null,
  amountNet: 76000,
  goodsAmount: 90000,
  hdrDiscAmt: 9000,
  extraDiscAmt: 5000,
  vatAmount: 7600,
  costItems: [],
});
const sDr = sLines.reduce((a, l) => a + (l.debit || 0), 0);
const sCr = sLines.reduce((a, l) => a + (l.credit || 0), 0);
ok(Math.abs(sDr - sCr) < 0.01, 'sales return JE balanced with discounts');
ok(sLines.some((l) => l.code === '4103' && l.credit > 0), 'credits sales discount');
ok(sLines.some((l) => l.code === '4102' && l.debit > 0), 'debits sales return goods');

const pLines = buildPurchaseReturnJournalLines(mock, {
  supplierId: null,
  amountNet: 76000,
  goodsAmount: 90000,
  hdrDiscAmt: 9000,
  extraDiscAmt: 5000,
  inventoryAmount: 81000,
  vatAmount: 7600,
  costItems: [{ warehouseId: null, amountRial: 81000 }],
});
const pDr = pLines.reduce((a, l) => a + (l.debit || 0), 0);
const pCr = pLines.reduce((a, l) => a + (l.credit || 0), 0);
ok(Math.abs(pDr - pCr) < 0.01, 'purchase return JE balanced with discounts');
ok(pLines.some((l) => l.code === '5501' && l.debit > 0), 'purchase extra disc to adjustment');

const sRev = buildSalesReturnJournalLines(mock, {
  custId: null,
  amountNet: 76000,
  goodsAmount: 90000,
  hdrDiscAmt: 9000,
  extraDiscAmt: 5000,
  vatAmount: 7600,
  costItems: [],
  reverse: true,
});
ok(Math.abs(
  sRev.reduce((a, l) => a + (l.debit || 0), 0)
  - sRev.reduce((a, l) => a + (l.credit || 0), 0)
) < 0.01, 'sales reverse JE balanced');

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
