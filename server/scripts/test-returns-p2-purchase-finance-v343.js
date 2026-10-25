const { swAtLeast } = require('./lib/sw-at-least');
#!/usr/bin/env node
/**
 * RETURNS P2-finance purchase mirror — linked purchase return reduces PI settled/open balance.
 * Run: node server/scripts/test-returns-p2-purchase-finance-v343.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  OK', name); }
  else { failed++; console.log(' FAIL', name, extra != null ? String(extra).slice(0, 160) : ''); }
}

const root = path.join(__dirname, '..');
const readUtf8 = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const app = readUtf8(path.join(root, 'public', 'app.js'));
const sw = readUtf8(path.join(root, 'public', 'sw.js'));
const idx = readUtf8(path.join(root, 'public', 'index.html'));
const acc = readUtf8(path.join(root, 'routes', 'accounting.js'));
const pur = readUtf8(path.join(root, 'routes', 'purchases.js'));
const paySrc = readUtf8(path.join(root, 'lib', 'purchase-payments.js'));
const amend = readUtf8(path.join(root, 'lib', 'amend-cash-ops.js'));

console.log('-- returns P2-finance purchase v343 --');

ok(swAtLeast(sw, 343), 'SW cache v343');
ok(/app\.js\?v=343/.test(idx), 'index.html app.js?v=343');
ok(paySrc.includes('function sumLinkedPurchaseReturnsGrossRial'), 'sumLinkedPurchaseReturnsGrossRial defined');
ok(/paidReturns\s*=\s*sumLinkedPurchaseReturnsGrossRial/.test(paySrc), 'recompute adds linked purchase returns');
ok(acc.includes('/suppliers/:supplierId/open-invoices') && acc.includes('purchase_returns'), 'supplier open-invoices SQL include returns');
ok(acc.includes('/payables/by-invoice') && acc.includes('returns_gross'), 'payables/by-invoice include returns');
ok(/if \(purchase_invoice_id\) recomputePurchaseInvoiceSettledBalances\(db, purchase_invoice_id\)/.test(pur), 'POST purchase-return recomputes');
ok(/if \(row\.purchase_invoice_id\) recomputePurchaseInvoiceSettledBalances\(db, row\.purchase_invoice_id\)/.test(pur), 'void purchase-return recomputes');
ok(/sumLinkedPurchaseReturnsGrossRial\(db, invoiceId\)/.test(amend), 'assertPurchaseRoom subtracts returns');
ok(app.includes('برگشت خرید روی فاکتور') || app.includes('پرداخت تأمین‌کنندهٔ جعلی'), 'Help mentions purchase return reduces PI balance');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-returns-p2-purchase-finance-v343-secret';
process.env.ERP_TEST_ISOLATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-ret-p2f-pur-'));
process.env.DB_PATH = path.join(tmp, 't.db');

function runMockRecomputeScenario() {
  const { recomputePurchaseInvoiceSettledBalances, sumLinkedPurchaseReturnsGrossRial } = require('../lib/purchase-payments');
  let returns = [{ amount: 150000, vat_amount: 50000 }];
  const db = {
    prepare(sql) {
      const s = String(sql);
      return {
        get(...args) {
          if (s.includes('FROM purchase_invoices') && s.includes('final')) {
            return { final: 1000000 };
          }
          if (s.includes('FROM supplier_payments')) return { s: 400000 };
          if (s.includes('FROM expense_payments')) return { s: 0 };
          return null;
        },
        all() {
          if (s.includes('FROM purchase_returns')) return returns;
          return [];
        },
        run() {},
      };
    },
  };
  ok(sumLinkedPurchaseReturnsGrossRial(db, 1) === 200000, 'sum linked purchase returns 200k');
  const r = recomputePurchaseInvoiceSettledBalances(db, 1);
  ok(r && r.paid === 600000, 'settled = payment 400k + return 200k', r && r.paid);
  ok(r && r.balance_due === 400000, 'balance_due 400k', r && r.balance_due);
  returns = [];
  const r2 = recomputePurchaseInvoiceSettledBalances(db, 1);
  ok(r2 && r2.paid === 400000, 'after reverse return, paid = supplier payment only', r2 && r2.paid);
}

runMockRecomputeScenario();

try {
  new Function(app);
  ok(true, 'app.js parses');
} catch (e) {
  ok(false, 'app.js parses', e && e.message);
}

console.log('\n' + passed + ' passed,', failed + ' failed');
process.exit(failed ? 1 : 0);
