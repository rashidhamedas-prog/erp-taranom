#!/usr/bin/env node
/**
 * RETURNS P2-finance — linked sales return reduces invoice settled/open balance.
 * Run: node server/scripts/test-returns-p2-finance-v341.js
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
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
const idx = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const acc = fs.readFileSync(path.join(root, 'routes', 'accounting.js'), 'utf8');
const paySrc = fs.readFileSync(path.join(root, 'lib', 'invoice-payments.js'), 'utf8');

console.log('-- returns P2-finance v341/v342 --');

ok(/erp-taranom-v342/.test(sw), 'SW cache v342');
ok(/app\.js\?v=342/.test(idx), 'index.html app.js?v=342');
ok(paySrc.includes('function sumLinkedSalesReturnsGrossRial'), 'sumLinkedSalesReturnsGrossRial defined');
ok(/paidReturns\s*=\s*sumLinkedSalesReturnsGrossRial/.test(paySrc), 'recompute adds linked returns');
ok(acc.includes('returns_gross') && acc.includes('sales_returns'), 'receivables/open-invoices SQL include returns');
ok(/if \(invoice_id\) recomputeInvoiceSettledBalances\(db, invoice_id\)/.test(acc), 'POST sales-return recomputes');
ok(/if \(row\.invoice_id\) recomputeInvoiceSettledBalances\(db, row\.invoice_id\)/.test(acc), 'void sales-return recomputes');
ok(app.includes('برگشت فروش روی فاکتور') || app.includes('بدون ردیف تسویه'), 'Help mentions return reduces invoice balance');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-returns-p2-finance-v341-secret-32';
process.env.ERP_TEST_ISOLATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-ret-p2f-'));
process.env.DB_PATH = path.join(tmp, 't.db');

function runMockRecomputeScenario() {
  const { recomputeInvoiceSettledBalances, sumLinkedSalesReturnsGrossRial } = require('../lib/invoice-payments');
  let returns = [{ amount: 200000, vat_amount: 0 }];
  let lastUpdate = null;
  const db = {
    prepare(sql) {
      const s = String(sql);
      return {
        get() {
          if (s.includes('FROM invoices') && s.includes('final_rial')) {
            return { final: 1000000, final_rial: 1000000 };
          }
          return null;
        },
        all() {
          if (s.includes('FROM settlements')) return [{ amount_rial: 300000, amount: 300000 }];
          if (s.includes('FROM pos_receipts')) return [];
          if (s.includes('FROM sales_returns')) return returns;
          return [];
        },
        run(settled, balance) {
          if (s.includes('UPDATE invoices SET settled_amount')) lastUpdate = { settled, balance };
        },
      };
    },
  };
  ok(sumLinkedSalesReturnsGrossRial(db, 1) === 200000, 'sum linked returns 200k');
  const r = recomputeInvoiceSettledBalances(db, 1);
  ok(r && r.paid === 500000, 'settled = receipt 300k + return 200k', r && r.paid);
  ok(r && r.balance_due === 500000, 'balance_due 500k', r && r.balance_due);
  returns = [];
  const r2 = recomputeInvoiceSettledBalances(db, 1);
  ok(r2 && r2.paid === 300000, 'after reverse return, paid = receipt only', r2 && r2.paid);
}

// Isolated mock is the deploy-safe gate (no production DB touch).
runMockRecomputeScenario();

try {
  new Function(app);
  ok(true, 'app.js parses');
} catch (e) {
  ok(false, 'app.js parses', e && e.message);
}

console.log('\n' + passed + ' passed,', failed + ' failed');
process.exit(failed ? 1 : 0);
