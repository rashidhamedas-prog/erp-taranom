'use strict';
/**
 * Walk-in cash desk privacy v395 — helpers + timeline filter (stub DB, no native sqlite).
 * Run: node server/scripts/test-walkin-tx-privacy-v395.js
 */
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

console.log('\n══ Walk-in tx privacy v395 ══\n');

const {
  ensureWalkinCustomer, isWalkinCustomer, seesAllWalkinTransactions,
  restrictWalkinTransactions, canViewWalkinInvoice, walkinListVisibilityOrSql,
  walkinPersonalBalanceRial, WALKIN_BIZ,
} = require('../lib/store-quick-sale');
const { customerVisibleTo } = require('../lib/customer-scope');
const { buildTimeline } = require('../lib/crm-analytics');

ok(seesAllWalkinTransactions('admin') && seesAllWalkinTransactions('accounting'), 'admin/accounting see all');
ok(!seesAllWalkinTransactions('store_retail') && !seesAllWalkinTransactions('sales_manager'), 'sales roles restricted');

function makeStubDb() {
  const settings = new Map();
  const customers = [];
  const invoices = [];
  const settlements = [];
  const returns = [];
  const followups = [];
  const ledger = [];
  let custSeq = 1;
  const users = {
    1: { id: 1, name: 'Admin', role: 'admin', active: 1 },
    2: { id: 2, name: 'Sharifi', role: 'store_retail', active: 1 },
    3: { id: 3, name: 'Other', role: 'store_retail', active: 1 },
  };

  function prep(sql) {
    const s = String(sql);
    return {
      get(...args) {
        if (s.includes("FROM settings WHERE key=?")) {
          const v = settings.get(args[0]);
          return v == null ? undefined : { value: v };
        }
        if (s.includes('FROM customers WHERE id=?') && s.includes('user_id, assigned_to')) {
          const c = customers.find((x) => x.id === Number(args[0]));
          return c ? { user_id: c.user_id, assigned_to: c.assigned_to } : undefined;
        }
        if (s.includes('FROM customers WHERE id=?') && s.includes('SELECT id FROM')) {
          const c = customers.find((x) => x.id === Number(args[0]));
          if (!c) return undefined;
          if (s.includes('user_id=? OR') || s.includes('user_id=? OR')) {
            const uid = Number(args[1]);
            if (Number(c.user_id) === uid || Number(c.assigned_to) === uid) return { id: c.id };
            return undefined;
          }
          return { id: c.id };
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
        if (s.includes('FROM customer_ledger WHERE customer_id=? AND user_id=?') && s.includes('SUM')) {
          const cid = Number(args[0]); const uid = Number(args[1]);
          let b = 0;
          for (const r of ledger) {
            if (r.customer_id === cid && r.user_id === uid) b += (r.debit || 0) - (r.credit || 0);
          }
          return { b };
        }
        if (s.includes('FROM invoices i') && s.includes('SUM(i.final)')) {
          const cid = Number(args[0]); const uid = Number(args[1]);
          let sum = 0;
          for (const i of invoices) {
            if (i.cust_id !== cid || i.user_id !== uid) continue;
            const inLed = ledger.some((l) => l.ref_type === 'invoice' && Number(l.ref_id) === i.id
              && l.customer_id === cid && String(l.entry_type || '') !== 'reversal');
            if (!inLed) sum += Number(i.final) || 0;
          }
          return { s: sum };
        }
        return undefined;
      },
      all(...args) {
        // Order matters: settlements SQL embeds an invoices subquery — match settlements first.
        if (s.includes('FROM settlements')) {
          if (s.includes('user_id=?') || s.includes('user_id=?')) {
            const cid = Number(args[0]); const uid = Number(args[1]);
            return settlements.filter((x) => x.cust_id === cid && (
              x.user_id === uid
              || invoices.some((i) => i.id === x.invoice_id && i.cust_id === cid && i.user_id === uid)
            ));
          }
          return settlements.filter((x) => x.cust_id === Number(args[0]));
        }
        if (s.includes('FROM sales_returns')) {
          if (s.includes('user_id=?')) {
            return returns.filter((r) => r.cust_id === Number(args[0]) && r.user_id === Number(args[1]));
          }
          return returns.filter((r) => r.cust_id === Number(args[0]));
        }
        if (s.includes('FROM followups WHERE cust_id=? AND user_id=?')) {
          return followups.filter((f) => f.cust_id === Number(args[0]) && f.user_id === Number(args[1]));
        }
        if (s.includes('FROM followups WHERE cust_id=?')) {
          return followups.filter((f) => f.cust_id === Number(args[0]));
        }
        if (s.includes('FROM invoices WHERE cust_id=? AND user_id=?')) {
          return invoices.filter((i) => i.cust_id === Number(args[0]) && i.user_id === Number(args[1])
            && !i.deleted_at);
        }
        if (s.includes('FROM invoices WHERE cust_id=?')) {
          return invoices.filter((i) => i.cust_id === Number(args[0]) && !i.deleted_at);
        }
        return [];
      },
      run(...args) {
        if (s.includes('INSERT INTO customers')) {
          const row = {
            id: custSeq++,
            user_id: args[0], biz: args[1], owner: args[2], phone: args[3],
            type: args[4], status: args[5], note: args[6], assigned_to: args[0],
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
    _customers: customers,
    _invoices: invoices,
    _settlements: settlements,
    _returns: returns,
    _ledger: ledger,
    seedTx() {
      const wid = Number(settings.get('store_walkin_customer_id'));
      invoices.push(
        { id: 10, num: 'T-A', cust_id: wid, user_id: 2, type: 'normal', date: '1405/01/01', final: 1000, final_rial: 1000, status: 'posted', created_at: 1, deleted_at: 0 },
        { id: 11, num: 'T-B', cust_id: wid, user_id: 3, type: 'normal', date: '1405/01/02', final: 2000, final_rial: 2000, status: 'posted', created_at: 2, deleted_at: 0 }
      );
      settlements.push(
        { id: 20, cust_id: wid, user_id: 2, invoice_id: 10, amount: 1000, amount_rial: 1000, pay_type: 'cash', date: '1405/01/01', created_at: 1 },
        { id: 21, cust_id: wid, user_id: 3, invoice_id: 11, amount: 2000, amount_rial: 2000, pay_type: 'cash', date: '1405/01/02', created_at: 2 }
      );
      returns.push(
        { id: 30, cust_id: wid, user_id: 2, amount: 100, date: '1405/01/03', status: 'posted', created_at: 3 },
        { id: 31, cust_id: wid, user_id: 3, amount: 50, date: '1405/01/04', status: 'posted', created_at: 4 }
      );
      ledger.push(
        { customer_id: wid, user_id: 2, debit: 1000, credit: 0, ref_type: 'invoice', ref_id: 10, entry_type: 'invoice' },
        { customer_id: wid, user_id: 2, debit: 0, credit: 1000, ref_type: 'settlement', ref_id: 20, entry_type: 'settlement' },
        { customer_id: wid, user_id: 3, debit: 2000, credit: 0, ref_type: 'invoice', ref_id: 11, entry_type: 'invoice' }
      );
    },
  };
}

const db = makeStubDb();
const walkinId = ensureWalkinCustomer(db);
ok(walkinId > 0 && isWalkinCustomer(db, walkinId), 'walkin seeded');
ok(String(db._customers.find((c) => c.id === walkinId).biz) === WALKIN_BIZ, 'walkin biz');

ok(customerVisibleTo(db, walkinId, 2) === true, 'store_retail can see walkin customer');
ok(restrictWalkinTransactions(db, { role: 'store_retail' }, walkinId) === true, 'restrict store_retail');
ok(restrictWalkinTransactions(db, { role: 'admin' }, walkinId) === false, 'admin not restricted');

const orVis = walkinListVisibilityOrSql(db, 'c');
ok(orVis.sql.includes('OR') && Number(orVis.params[0]) === walkinId, 'list visibility OR sql');

db.seedTx();

const invA = { id: 10, cust_id: walkinId, user_id: 2 };
const invB = { id: 11, cust_id: walkinId, user_id: 3 };
ok(canViewWalkinInvoice(db, { user: { id: 2, role: 'store_retail' } }, invA) === true, 'sharifi sees own inv');
ok(canViewWalkinInvoice(db, { user: { id: 2, role: 'store_retail' } }, invB) === false, 'sharifi blocked other inv');
ok(canViewWalkinInvoice(db, { user: { id: 2, role: 'sales_manager' } }, invB) === false, 'sales_manager blocked other walkin');
ok(canViewWalkinInvoice(db, { user: { id: 1, role: 'admin' } }, invB) === true, 'admin sees all walkin');
ok(canViewWalkinInvoice(db, { user: { id: 2, role: 'store_retail' } }, { id: 99, cust_id: 999, user_id: 3 }) === null, 'non-walkin null');

const tl2 = buildTimeline(db, { customerId: walkinId, scopeUserId: 2, limit: 80 });
const kinds2 = (tl2.events || []).map((e) => `${e.kind}:${e.sourceId}`);
ok(kinds2.includes('invoice:10'), 'timeline has own invoice', kinds2);
ok(!kinds2.includes('invoice:11'), 'timeline hides other invoice', kinds2);
ok(kinds2.includes('settlement:20'), 'timeline own settlement', kinds2);
ok(!kinds2.includes('settlement:21'), 'timeline hides other settlement', kinds2);
ok(kinds2.includes('sales_return:30'), 'timeline own return', kinds2);
ok(!kinds2.includes('sales_return:31'), 'timeline hides other return', kinds2);

const tlAdmin = buildTimeline(db, { customerId: walkinId, scopeUserId: null, limit: 80 });
ok((tlAdmin.events || []).filter((e) => e.sourceType === 'invoices').length >= 2, 'admin timeline both invoices');

ok(walkinPersonalBalanceRial(db, walkinId, 2) === 0, 'sharifi personal bal settled');
ok(walkinPersonalBalanceRial(db, walkinId, 3) === 2000, 'other personal bal open invoice');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(appJs.includes('حریم تراکنش (v395)') || appJs.includes('حریم فروش حضوری'), 'help mentions privacy');
ok(fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8').includes('erp-taranom-v395'), 'sw v395');
ok(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8').includes('app.js?v=395'), 'index app.js v395');

const invRoutes = fs.readFileSync(path.join(__dirname, '../routes/invoices.js'), 'utf8');
ok(invRoutes.includes('canViewWalkinInvoice'), 'invoices route wired');
const custRoutes = fs.readFileSync(path.join(__dirname, '../routes/customers.js'), 'utf8');
ok(custRoutes.includes('walkinListVisibilityOrSql') && custRoutes.includes('walkinPersonalBalanceRial'), 'customers route wired');

console.log(`\nResult: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
