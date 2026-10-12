#!/usr/bin/env node
/**
 * RETURNS P2c-allocate — unlinked return credit → open invoice (no JE).
 * Static checks only (no prod DB). Run: node server/scripts/test-returns-p2c-allocate-v344.js
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
const invPay = readUtf8(path.join(root, 'lib', 'invoice-payments.js'));
const purPay = readUtf8(path.join(root, 'lib', 'purchase-payments.js'));
const allocPath = path.join(root, 'lib', 'return-credit-allocate.js');
const allocSrc = readUtf8(allocPath);
const cap = readUtf8(path.join(root, 'sync', 'capture.js'));
const tbl = readUtf8(path.join(root, 'sync', 'tables.js'));
const settings = readUtf8(path.join(root, 'routes', 'settings.js'));
const dbJs = readUtf8(path.join(root, 'db.js'));

console.log('-- returns P2c-allocate v344 --');

function cacheVer(s) {
  const m = String(s || '').match(/erp-taranom-v(\d+)/);
  return m ? Number(m[1]) : 0;
}
function appVer(s) {
  const m = String(s || '').match(/app\.js\?v=(\d+)/);
  return m ? Number(m[1]) : 0;
}
ok(cacheVer(sw) >= 344, 'SW cache >= v344', cacheVer(sw));
ok(appVer(idx) >= 344, 'index.html app.js?v >= 344', appVer(idx));

ok(fs.existsSync(allocPath), 'lib/return-credit-allocate.js exists');
ok(/function allocateReturnCredit/.test(allocSrc), 'allocateReturnCredit defined');
ok(/function reverseAllocationsForReturn/.test(allocSrc), 'reverseAllocationsForReturn defined');
ok(/function autoAllocateIfEnabled/.test(allocSrc), 'autoAllocateIfEnabled defined');

ok(/sumAllocationsToInvoice\(db,\s*SIDE_SALES,\s*invoiceId\)/.test(invPay), 'invoice-payments sumAllocationsToInvoice');
ok(/paidAlloc\s*=\s*sumAllocationsToInvoice/.test(invPay), 'invoice-payments recompute uses paidAlloc');
ok(/sumAllocationsToInvoice\(db,\s*SIDE_PURCHASE,\s*purchaseInvoiceId\)/.test(purPay), 'purchase-payments sumAllocationsToInvoice');
ok(/paidAlloc\s*=\s*sumAllocationsToInvoice/.test(purPay), 'purchase-payments recompute uses paidAlloc');

ok(/router\.post\('\/sales-returns\/:id\/allocate'/.test(acc), 'accounting sales-returns/:id/allocate');
ok(acc.includes('return_credit_allocations') && acc.includes('open-invoices'), 'open-invoices SQL includes return_credit_allocations');

ok(/router\.post\('\/returns\/:id\/allocate'/.test(pur), 'purchases returns/:id/allocate');

ok(/\/\/ Returns P2c[\s\S]*return_credit_allocations/.test(tbl), 'tables.js append return_credit_allocations');
ok(/name:\s*'return_credit_allocations'/.test(tbl), 'tables.js return_credit_allocations entry');

ok(cap.includes("return 'return_credit_allocations'") && /sales-returns\/.*allocate/.test(cap), 'capture sales-returns allocate → return_credit_allocations');
ok(/purchases\/returns\/.*allocate/.test(cap), 'capture purchases returns allocate path');

ok(settings.includes('returns_auto_allocate_credit'), 'settings ALLOWED_KEYS returns_auto_allocate_credit');

ok(/CREATE TABLE IF NOT EXISTS return_credit_allocations/.test(dbJs), 'db.js CREATE return_credit_allocations');
ok(dbJs.includes('sync_seq_backfill_v20'), 'db.js sync_seq_backfill_v20');
ok(dbJs.includes("ensureColumn(db, 'sales_returns', 'reason_code'"), 'db.js sales_returns reason_code');
ok(dbJs.includes("ensureColumn(db, 'purchase_returns', 'reason_code'"), 'db.js purchase_returns reason_code');

ok(
  app.includes('تخصیص به فاکتور') || app.includes('allocateReturnCredit') || app.includes('returnCreditAlloc'),
  'app.js allocate UI string'
);
ok(
  idx.includes('تخصیص اعتبار') || app.includes('تخصیص اعتبار'),
  'Help mentions تخصیص اعتبار'
);

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-returns-p2c-allocate-v344-secret-32';
process.env.ERP_TEST_ISOLATION = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-ret-p2c-'));
process.env.DB_PATH = path.join(tmp, 't.db');

function runMockRecomputeWithPaidAlloc() {
  const { recomputeInvoiceSettledBalances } = require('../lib/invoice-payments');
  const allocSum = 150000;
  const db = {
    prepare(sql) {
      const s = String(sql);
      return {
        get(...args) {
          if (s.includes('FROM invoices') && s.includes('final_rial')) {
            return { final: 1000000, final_rial: 1000000 };
          }
          if (s.includes('FROM return_credit_allocations') && s.includes('SUM')) {
            return { s: allocSum };
          }
          return null;
        },
        all() {
          if (s.includes('FROM settlements')) return [{ amount_rial: 300000, amount: 300000 }];
          if (s.includes('FROM pos_receipts')) return [];
          if (s.includes('FROM sales_returns')) return [];
          return [];
        },
        run() {},
      };
    },
  };
  const r = recomputeInvoiceSettledBalances(db, 42);
  ok(r && r.paid === 450000, 'recompute paid = receipt 300k + alloc 150k', r && r.paid);
  ok(r && r.balance_due === 550000, 'recompute balance_due 550k', r && r.balance_due);
}

runMockRecomputeWithPaidAlloc();

try {
  new Function(app);
  ok(true, 'app.js parses');
} catch (e) {
  ok(false, 'app.js parses', e && e.message);
}

console.log('\n' + passed + ' passed,', failed + ' failed');
if (failed) {
  console.log('(SW/index/app Help may lag UI agent — backend gates should still pass)');
}
process.exit(failed ? 1 : 0);
