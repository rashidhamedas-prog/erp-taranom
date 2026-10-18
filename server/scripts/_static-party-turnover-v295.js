'use strict';
const fs = require('fs');
const a = fs.readFileSync('server/public/app.js', 'utf8');
const acc = fs.readFileSync('server/routes/accounting.js', 'utf8');
const pt = fs.readFileSync('server/lib/party-turnover.js', 'utf8');
const checks = [
  ['turnover API', a.includes("/parties/'+id+'/turnover")],
  ['party_id payment', a.includes('party_id:target')],
  ['no expense person pay', !/category:'admin', title:'پرداخت به شخص/.test(a)],
  ['customer settlement receipt', a.includes("'/accounting/settlements'") && a.includes('custId')],
  ['resolver', acc.includes('resolvePersonIdFromVoucherLine')],
  ['party_id line', acc.includes('l.party_id')],
  ['party turnover lib', pt.includes('buildPartyTurnover')],
  ['linked_rep metadata (no merge)', pt.includes('linked_rep_id') && pt.includes('do NOT merge rep_ledger')],
];
let f = 0;
for (const [n, ok] of checks) {
  console.log(ok ? 'OK' : 'FAIL', n);
  if (!ok) f++;
}
process.exit(f);
