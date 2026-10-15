'use strict';
/**
 * Invoice list default sort by issue date DESC (v393).
 * Run: node server/scripts/test-invoice-list-date-sort-v393.js
 */
const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra == null ? '' : extra); }
}

function sortInvoicesByIssueDateDesc(rows) {
  return (rows || []).slice().sort((a, b) => {
    const d = String(b.date || '').localeCompare(String(a.date || ''));
    if (d) return d;
    return (Number(b.id) || 0) - (Number(a.id) || 0);
  });
}

const root = path.join(__dirname, '..');
const routesSrc = fs.readFileSync(path.join(root, 'routes', 'invoices.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

ok(/ORDER BY i\.date DESC, i\.id DESC/.test(routesSrc), 'API list ORDER BY date DESC, id DESC');
ok(!/ORDER BY i\.created_at DESC/.test(routesSrc), 'API list no longer uses created_at DESC');
ok(/function sortInvoicesByIssueDateDesc/.test(appSrc), 'client helper sortInvoicesByIssueDateDesc exists');
ok(/rows=sortInvoicesByIssueDateDesc\(rows\)/.test(appSrc), 'renderInvTable uses date sort');
ok(/sortInvoicesByIssueDateDesc\(CACHE\.invoices\.filter/.test(appSrc), 'acc sales list uses date sort');
ok(/erp-taranom-v393/.test(swSrc), 'SW cache v393');
ok(/app\.js\?v=393/.test(indexSrc), 'index.html app.js?v=393');

// Screenshot scenario: T-0022 dated 07/02 must not float above 07/21 when created_at is newer.
const sample = [
  { id: 22, num: 'T-0022', date: '1405/07/02', created_at: 999 },
  { id: 21, num: 'T-0021', date: '1405/07/20', created_at: 90 },
  { id: 20, num: 'T-0020', date: '1405/07/21', created_at: 80 },
  { id: 19, num: 'T-0019', date: '1405/07/21', created_at: 70 },
];
const sorted = sortInvoicesByIssueDateDesc(sample);
ok(sorted[0].num === 'T-0020' && sorted[1].num === 'T-0019', 'same day 07/21: higher id first', sorted.map((r) => r.num).join(','));
ok(sorted[2].num === 'T-0021', '07/20 after 07/21', sorted.map((r) => r.num).join(','));
ok(sorted[3].num === 'T-0022', '07/02 last despite newest created_at', sorted.map((r) => r.num).join(','));

const todayish = '1405/07/23';
ok(sorted.every((r, i) => i === 0 || String(sorted[i - 1].date) >= String(r.date)), 'monotonic date DESC vs today ' + todayish);

console.log('\n' + (fail ? `FAIL ${fail} / pass ${pass}` : `PASS ${pass}`) + '\n');
process.exit(fail ? 1 : 0);
