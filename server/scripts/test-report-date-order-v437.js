'use strict';
/**
 * Reports follow document date, and party turnover exposes debit/credit/closing.
 * Run: node server/scripts/test-report-date-order-v437.js
 */
const fs = require('fs');
const path = require('path');
const { sortReportRows, reportDateKey, sumDebitCredit } = require('../lib/report-order');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra == null ? '' : extra); }
}

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const turnover = read('lib/party-turnover.js');
const accounting = read('routes/accounting.js');
const app = read('public/app.js');
const sw = read('public/sw.js');
const index = read('public/index.html');

ok(/ORDER BY date ASC, created_at ASC, id ASC/.test(turnover), 'customer turnover SQL is document date');
ok(!/ORDER BY created_at ASC, id ASC/.test(turnover), 'customer turnover no longer sorts by created_at');
ok(/sortReportRows\(tagged/.test(turnover), 'customer turnover re-sorts before running balance');
ok(/sumDebitCredit/.test(turnover), 'turnover attaches debit and credit totals');
ok(/totalDebit/.test(read('lib/report-order.js')), 'totals helper names totalDebit');
ok(/ORDER BY cl\.date ASC, cl\.created_at ASC, cl\.id ASC/.test(accounting), 'statement SQL is document date');
ok(/sortReportRows\(ledgerTagged/.test(accounting), 'statement re-sorts before running balance');
ok(/مانده نهایی:/.test(app) && /جمع بدهکار/.test(app) && /جمع بستانکار/.test(app), 'turnover modal shows debit, credit, and final balance');
ok(/erp-taranom-v439/.test(sw), 'SW cache v439');
ok(/app\.js\?v=439/.test(index), 'index.html app.js?v=439');

ok(reportDateKey('1405/7/2') === '14050702', 'unpadded jalali normalizes');
ok(reportDateKey('1405/07/02') === reportDateKey('1405-7-2'), 'slash and dash match');

const rows = [
  { id: 1, date: '1405/07/21', created_at: 1, debit: 30000000, credit: 0 },
  { id: 2, date: '1405/07/02', created_at: 99, debit: 0, credit: 4000000 },
  { id: 4, date: '1405/07/02', created_at: 50, debit: 1000000, credit: 0 },
  { id: 3, date: '1405/7/8', created_at: 3, debit: 0, credit: 500000 },
];
sortReportRows(rows, { date: 'date', dir: 'asc' });
ok(rows.map((r) => r.id).join(',') === '4,2,3,1', 'oldest document date first; same day by created_at then id', rows.map((r) => r.id));
let run = 0;
for (const e of rows) {
  run += e.debit - e.credit;
  e.balance = run;
}
ok(rows[0].balance === 1000000, 'running balance follows date order, not insert time', rows[0].balance);
ok(rows[rows.length - 1].balance === 26500000, 'closing is last chronological balance', rows[rows.length - 1].balance);
const sums = sumDebitCredit(rows);
ok(sums.totalDebit === 31000000 && sums.totalCredit === 4500000, 'debit and credit totals', sums);

const desc = rows.slice();
sortReportRows(desc, { date: 'date', dir: 'desc' });
ok(desc[0].id === 1 && desc[desc.length - 1].id === 4, 'desc keeps date order for registers');

console.log(fail ? `\n${fail} failed, ${pass} passed` : `\n${pass} passed`);
process.exit(fail ? 1 : 0);
