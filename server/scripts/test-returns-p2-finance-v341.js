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
ok(app.includes('ماندهٔ همان فاکتور') || app.includes('بدون ردیف تسویهٔ جدا'), 'Help mentions return reduces invoice balance');

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

let dbRan = false;
try {
  require('better-sqlite3');
  const { initDB, getDB } = require('../db');
  initDB();
  const db = getDB();
  const { recomputeInvoiceSettledBalances, sumLinkedSalesReturnsGrossRial } = require('../lib/invoice-payments');

  const u = db.prepare("INSERT INTO users(username,password_hash,name,role) VALUES('t','x','t','admin')").run();
  const uid = u.lastInsertRowid;
  const c = db.prepare("INSERT INTO customers(biz,owner,user_id) VALUES('C','O',?)").run(uid);
  const cid = c.lastInsertRowid;
  const inv = db.prepare(`
    INSERT INTO invoices(num,cust_id,date,type,status,final,final_rial,settled_amount,balance_due,created_by)
    VALUES('T-P2F',?,strftime('%Y/%m/%d','now'),'normal','confirmed',1000000,1000000,0,1000000,?)
  `).run(cid, uid);
  const iid = inv.lastInsertRowid;

  db.prepare(`
    INSERT INTO settlements(cust_id,invoice_id,date,amount,amount_rial,pay_type,status,created_by)
    VALUES(?,?,strftime('%Y/%m/%d','now'),300000,300000,'cash','posted',?)
  `).run(cid, iid, uid);

  db.prepare(`
    INSERT INTO sales_returns(cust_id,invoice_id,date,amount,vat_amount,status,created_by)
    VALUES(?,?,strftime('%Y/%m/%d','now'),200000,0,'posted',?)
  `).run(cid, iid, uid);

  ok(sumLinkedSalesReturnsGrossRial(db, iid) === 200000, 'sum linked returns 200k (sqlite)');
  const r = recomputeInvoiceSettledBalances(db, iid);
  ok(r && r.paid === 500000, 'settled = receipt 300k + return 200k (sqlite)', r && r.paid);
  ok(r && r.balance_due === 500000, 'balance_due 500k (sqlite)', r && r.balance_due);

  db.prepare("UPDATE sales_returns SET status='reversed' WHERE invoice_id=?").run(iid);
  const r2 = recomputeInvoiceSettledBalances(db, iid);
  ok(r2 && r2.paid === 300000, 'after reverse return, paid = receipt only (sqlite)', r2 && r2.paid);
  dbRan = true;
} catch (e) {
  const msg = e && e.message ? String(e.message) : '';
  if (/bindings file|better_sqlite3|Cannot find module 'better-sqlite3'/.test(msg)) {
    console.log('  (skip sqlite — using mock recompute)');
    runMockRecomputeScenario();
  } else {
    ok(false, 'DB scenario', e && (e.stack || e.message));
  }
}
if (!dbRan && !failed) {
  /* mock path already counted assertions */
}

try {
  new Function(app);
  ok(true, 'app.js parses');
} catch (e) {
  ok(false, 'app.js parses', e && e.message);
}

console.log('\n' + passed + ' passed,', failed + ' failed');
process.exit(failed ? 1 : 0);
