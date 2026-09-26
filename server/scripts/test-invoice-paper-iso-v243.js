'use strict';
/**
 * Invoice paper sizes must stay ISO 216 (A4 210x297, A5 148x210 mm).
 * Dense print: no forced sheet min-height (empty whitespace).
 * Run: node server/scripts/test-invoice-paper-iso-v243.js
 */
const fs = require('fs');
const path = require('path');
const {
  renderInvoicePrintHtml, paperDims, ISO_PAPER,
} = require('../lib/invoice-print');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra == null ? '' : extra); }
}

ok(ISO_PAPER.A4.widthMm === 210 && ISO_PAPER.A4.heightMm === 297, 'ISO_PAPER A4 is 210x297');
ok(ISO_PAPER.A5.widthMm === 148 && ISO_PAPER.A5.heightMm === 210, 'ISO_PAPER A5 is 148x210');

const a5d = paperDims('A5');
ok(a5d.widthMm === 148 && a5d.heightMm === 210, 'paperDims A5 mm', a5d);
ok(a5d.sheetMax === '148mm', 'paperDims A5 sheetMax');
ok(a5d.pageSizeCss === '148mm 210mm', 'paperDims A5 pageSizeCss is explicit mm');
ok(a5d.pageMargin === '5mm', 'A5 page margin tight for density');

const a4d = paperDims('A4');
ok(a4d.widthMm === 210 && a4d.heightMm === 297, 'paperDims A4 mm', a4d);
ok(a4d.pageSizeCss === '210mm 297mm', 'paperDims A4 pageSizeCss is explicit mm');
ok(a4d.pageMargin === '6mm', 'A4 page margin tight for density');

const css = fs.readFileSync(path.join(__dirname, '../public/invoice-print.css'), 'utf8');
ok(css.includes('@page inv-a5 { size: 148mm 210mm;'), 'CSS named page A5 ISO size');
ok(css.includes('@page inv-a4 { size: 210mm 297mm;'), 'CSS named page A4 ISO size');
ok(css.includes('page: inv-a5'), 'CSS assigns page: inv-a5 on A5 sheet');
ok(css.includes('page: inv-a4'), 'CSS assigns page: inv-a4 on A4 sheet');
ok(!css.includes('min-height: 210mm') && !css.includes('min-height: 297mm'), 'CSS has no forced sheet min-height');
ok(css.includes('font-weight: 800'), 'CSS bolds amounts');
ok(css.includes('min-height: 28px'), 'CSS compact stamp boxes');
ok(!/html\.inv-print\.paper-a5\s*\{\s*\}/.test(css), 'no empty paper-a5 placeholder');

const sample = {
  inv: {
    num: 'T-ISO', type: 'normal', date: '1405/07/05', cust_biz: 'customer',
    subtotal: 1000000, final: 1000000,
  },
  rows: [{ name: 'item', qty: 1, price: 1000000, sum: 1000000 }],
  settings: { company_name: 'Taranom' },
};

const a5 = renderInvoicePrintHtml({ ...sample, paper: 'A5', templateOverride: 'casual-simple' });
ok(a5.includes('paper-a5'), 'A5 html class');
ok(a5.includes('@page{size:148mm 210mm'), 'inline @page uses ISO A5 mm (not bare A5 keyword)');
ok(!a5.includes('min-height:210mm'), 'inline sheet has no forced A5 min-height');
ok(a5.includes('max-width:148mm'), 'inline max-width A5');
ok(a5.includes('/invoice-print.css?v=246'), 'cache-busted print CSS');
ok(a5.includes('font-weight:800'), 'inline theme bolds .num');

const a4 = renderInvoicePrintHtml({ ...sample, paper: 'A4', templateOverride: 'formal-official' });
ok(a4.includes('@page{size:210mm 297mm'), 'inline @page uses ISO A4 mm');
ok(!a4.includes('min-height:297mm'), 'inline sheet has no forced A4 min-height');

console.log(fail ? `\nFAILED ${fail} / ${pass + fail}` : `\nAll ${pass} checks passed`);
process.exit(fail ? 1 : 0);
