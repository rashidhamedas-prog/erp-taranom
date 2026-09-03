'use strict';
/**
 * Invoice print layout v195 — A4/A5 preview must be centered paper, not RTL-shrunk to the right.
 * Run: node server/scripts/test-invoice-print-layout-v195.js
 */
const fs = require('fs');
const path = require('path');
const { renderInvoicePrintHtml, paperDims } = require('../lib/invoice-print');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra == null ? '' : extra); }
}

const sample = {
  inv: {
    num: 'T-0013', type: 'normal', date: '1405/06/13', cust_biz: 'مشتری 1',
    cust_phone: '09936525621', pay_type: 'cash',
    subtotal: 4343200000, final: 4786520000, vat_amount: 434320000, freight_amount: 9000000,
    seller_name: 'حامد رشید',
  },
  rows: [
    { name: 'مانتو شومیزی لنین نازگل', qty: 2, price: 1000000, unit: 'عدد', sum: 2000000 },
    { name: 'پارچه لنین ساده', qty: 10, price: 500000, unit: 'متر', sum: 5000000 },
  ],
  settings: { company_name: 'پوشاک ترنم', company_address: 'مشهد', company_phone: '09152424624' },
};

const cssPath = path.join(__dirname, '../public/invoice-print.css');
const css = fs.readFileSync(cssPath, 'utf8');
ok(css.includes('min-width: 100vw'), 'layout css forces viewport width');
ok(css.includes('align-items: center'), 'layout css centers the sheet');
ok(css.includes('max-width: 148mm'), 'layout css A5 paper width');
ok(css.includes('max-width: 210mm'), 'layout css A4 paper width');
ok(css.includes('@media screen and (max-width: 420px)'), 'stack only on very small screens');
ok(!css.includes('max-width:640px') && !css.includes('max-width: 640px'), 'no 640px collapse');

ok(paperDims('A5').sheetMax === '148mm', 'A5 sheetMax is 148mm');
ok(paperDims('A4').sheetMax === '210mm', 'A4 sheetMax is 210mm');

const a5 = renderInvoicePrintHtml({ ...sample, paper: 'A5', templateOverride: 'casual-simple' });
ok(a5.includes('class="inv-print paper-a5 tmpl-casual-simple"'), 'A5 html classes', a5.slice(a5.indexOf('<html'), a5.indexOf('>') + 1));
ok(a5.includes('/invoice-print.css'), 'links layout stylesheet');
ok(a5.includes('align-items:center'), 'inline theme also centers');
ok(a5.includes('min-width:100vw'), 'inline theme fills viewport');
ok(a5.includes('max-width:148mm'), 'A5 max-width is paper size');
ok(!a5.includes('max-width:640px'), 'A5 html has no 640px breakpoint');
ok(a5.includes('@media screen and (max-width:420px)'), 'A5 stacks only below 420px');
ok(!/\sstyle\s*=/i.test(a5), 'still no inline style attributes');

const a4 = renderInvoicePrintHtml({ ...sample, paper: 'A4', templateOverride: 'formal-official' });
ok(a4.includes('paper-a4'), 'A4 html class');
ok(a4.includes('max-width:210mm'), 'A4 max-width is paper size');

const thermal = renderInvoicePrintHtml({ ...sample, paper: 'THERMAL', templateOverride: 'thermal' });
ok(thermal.includes('paper-thermal'), 'thermal html class');

console.log(fail ? `\nFAILED ${fail} / ${pass + fail}` : `\nAll ${pass} checks passed`);
process.exit(fail ? 1 : 0);
