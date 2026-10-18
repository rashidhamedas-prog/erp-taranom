/**
 * v450 — sales/purchase return open-mode money parse.
 * Guards: "17,000,000" must not become 17 (parseFloat comma truncation).
 */
'use strict';

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed += 1; console.log('  OK', msg); }
  else { failed += 1; console.error('  FAIL', msg, detail != null ? detail : ''); }
}

const fs = require('fs');
const path = require('path');
const { parseMoneyInput } = require('../lib/money');
const { resolveExtraDiscount, rial } = require('../lib/returns-discount');

console.log('--- parseMoneyInput ---');
ok(parseMoneyInput('17,000,000') === 17000000, 'comma-formatted string');
ok(parseMoneyInput('۱۷٬۰۰۰٬۰۰۰') === 17000000, 'persian digits + separators');
ok(parseMoneyInput(17000000) === 17000000, 'number passthrough');
ok(parseMoneyInput('') === 0, 'empty → 0');
ok(parseMoneyInput(null) === 0, 'null → 0');
ok(parseFloat('17,000,000') === 17, 'baseline: bare parseFloat truncates (known bug)');

console.log('--- resolveExtraDiscount comma amt ---');
const x = resolveExtraDiscount({ extraDiscAmt: '1,000,000', extraDiscPct: 0, maxBase: 5000000 });
ok(x.extraAmt === 1000000, 'extra disc amt from comma string', x);

console.log('--- rial comma string ---');
ok(rial('17,000,000') === 17000000, 'rial() accepts comma money string');

console.log('--- frontend contract (app.js source) ---');
const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(/function parseMoneyAny\(/.test(appSrc), 'parseMoneyAny helper exists');
ok(/moneyParseInput\(el\('sr-open-price'\)\)/.test(appSrc), 'srOpenAddLineSimple uses moneyParseInput');
ok(/moneyParseInput\(el\('pr-open-price'\)\)/.test(appSrc), 'prOpenAddLineSimple uses moneyParseInput');
ok(/moneyParseInput\(priceEl\)/.test(appSrc), 'matrix confirm uses moneyParseInput for return price');
ok(/amt:\s*amtEl\?moneyParseInput\(amtEl\)/.test(appSrc), 'returnExtraDiscInputs uses moneyParseInput for amt');
ok(!/const price=parseFloat\(el\('sr-open-price'\)/.test(appSrc), 'no bare parseFloat on sr-open-price');
ok(!/let defaultPrice=parseFloat\(priceEl/.test(appSrc), 'no bare parseFloat on matrix return price');

console.log('--- sales-return-doc open branch ---');
const srSrc = fs.readFileSync(path.join(__dirname, '../lib/sales-return-doc.js'), 'utf8');
ok(/parseMoneyInput\(r\.price\)/.test(srSrc), 'open-mode price uses parseMoneyInput');
ok(!/price\s*=\s*parseFloat\(r\.price\)/.test(srSrc), 'no parseFloat(r.price) in sales-return-doc');

console.log('\n=== result: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed ? 1 : 0);
