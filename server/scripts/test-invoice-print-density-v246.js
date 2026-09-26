'use strict';
/**
 * Dense invoice print — 3 product rows must stay compact (no color/size, bold amounts).
 * Run: node server/scripts/test-invoice-print-density-v246.js
 */
const fs = require('fs');
const path = require('path');
const { renderInvoicePrintHtml, paperDims } = require('../lib/invoice-print');
const { collapsePrintRows } = require('../lib/print-line-collapse');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra == null ? '' : extra); }
}

const rows = [
  { product_id: 1, name: 'مانتو A', variant_id: 1, color_name: 'مشکی', size_name: 'M', qty: 1, price: 1000000, sum: 1000000, unit: 'عدد', code: 'P1', warehouse_id: 1 },
  { product_id: 1, name: 'مانتو A', variant_id: 2, color_name: 'سفید', size_name: 'L', qty: 1, price: 1000000, sum: 1000000, unit: 'عدد', code: 'P1', warehouse_id: 1 },
  { product_id: 2, name: 'شومیز B', variant_id: 3, color_name: 'کرم', size_name: 'S', qty: 2, price: 800000, sum: 1600000, unit: 'عدد', code: 'P2', warehouse_id: 1 },
];

const collapsed = collapsePrintRows(rows);
ok(collapsed.length === 2, '3 variant lines collapse to 2 product rows', collapsed.length);
ok(collapsed.every((r) => !/مشکی|سفید|کرم|M×|L×|S×/.test(String(r.description || ''))), 'no color/size in collapsed desc');

const inv = {
  num: 'T-0246', type: 'final', date: '1405/07/06', cust_biz: 'خریدار',
  pay_type: 'cash', subtotal: 3600000, final: 3600000, seller_name: 'فروشنده',
};
const templates = ['formal-official', 'formal-modern', 'formal-premium', 'casual-simple'];
for (const tid of templates) {
  for (const paper of ['A4', 'A5']) {
    const html = renderInvoicePrintHtml({
      inv, rows, settings: { company_name: 'پوشاک ترنم' }, paper, templateOverride: tid,
    });
    ok(!/مشکی|سفید|کرم/.test(html), `${tid}/${paper} omits color names`);
    ok(/font-weight:800/.test(html), `${tid}/${paper} bolds amounts`);
    ok(!/min-height:210mm|min-height:297mm/.test(html), `${tid}/${paper} no forced paper min-height`);
    const pad = paperDims(paper).pad;
    ok(html.includes(`padding:${pad}`), `${tid}/${paper} uses dense pad ${pad}`);
  }
}

const css = fs.readFileSync(path.join(__dirname, '../public/invoice-print.css'), 'utf8');
ok(css.includes('min-height: 28px'), 'stamp boxes compact');
ok(css.includes('@page inv-a5 { size: 148mm 210mm; margin: 5mm;'), 'A5 margin 5mm');
ok(css.includes('font-weight: 800'), 'CSS amount bold');

console.log(fail ? `\nFAILED ${fail} / ${pass + fail}` : `\nAll ${pass} checks passed`);
process.exit(fail ? 1 : 0);
