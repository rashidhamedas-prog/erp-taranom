'use strict';
/**
 * Blob print preview must keep theme CSS/logo working under CSP.
 * Root cause: DOMParser stripped style nonce; base-uri 'none' ignored <base>.
 * Run: node server/scripts/test-invoice-print-blob-v199.js
 */
const fs = require('fs');
const path = require('path');
const { renderInvoicePrintHtml } = require('../lib/invoice-print');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra == null ? '' : extra); }
}

const runtime = fs.readFileSync(path.join(__dirname, '../public/csp-runtime.js'), 'utf8');
const fn = runtime.slice(runtime.indexOf('function withSameOriginBase'), runtime.indexOf('async function openVerifiedServerDocument'));
ok(fn.includes('function withSameOriginBase'), 'withSameOriginBase still exists');
ok(!fn.includes('new DOMParser') && !fn.includes('parseFromString'), 'blob rewrite does not reparse HTML (keeps style nonce)');
ok(!fn.includes('createElement(\'base\')') && !fn.includes('createElement("base")'), 'does not inject a base element');
ok(fn.includes('href|src') && fn.includes('location.origin'), 'rewrites root-relative assets to absolute origin');

function rewrite(html, origin) {
  const originUrl = new URL(origin);
  return String(html).replace(
    /\b(href|src)=(["'])(\/[^"'>\s]*)\2/gi,
    (whole, attr, quote, assetPath) => {
      if (assetPath.startsWith('//')) return whole;
      const abs = new URL(assetPath, originUrl.href.endsWith('/') ? originUrl.href : originUrl.href + '/');
      if (abs.origin !== originUrl.origin) return whole;
      return `${attr}=${quote}${abs.href}${quote}`;
    }
  );
}

const sample = `<html><head>
<meta http-equiv="Content-Security-Policy" content="style-src 'self' 'nonce-KeepMe'">
<link href="/invoice-print.css" rel="stylesheet">
<style nonce="KeepMe">.sheet{color:green}</style>
</head><body>
<img src="/logo-sm.png" alt="لوگو">
<script src="/print-page.js"></script>
</body></html>`;
const out = rewrite(sample, 'https://erp.poshaktaranom.com');
ok(out.includes('nonce="KeepMe"'), 'nonce survives rewrite');
ok(out.includes('https://erp.poshaktaranom.com/invoice-print.css'), 'css becomes absolute');
ok(out.includes('https://erp.poshaktaranom.com/logo-sm.png'), 'logo becomes absolute');
ok(out.includes('https://erp.poshaktaranom.com/print-page.js'), 'print script becomes absolute');
ok(!out.includes('href="/invoice-print.css"'), 'no leftover root-relative css href');

const html = renderInvoicePrintHtml({
  inv: { num: 'T-0015', type: 'normal', date: '1405/06/15', cust_biz: 'مشتری 1' },
  rows: [{ name: 'بارانی', qty: 12, price: 5980000, sum: 71760000 }],
  settings: { company_name: 'پوشاک ترنم' },
  paper: 'A5',
  templateOverride: 'formal-official',
});
ok(html.includes('tmpl-formal-official'), 'official template class present');
ok(html.includes('off-banner'), 'official banner markup present');
ok(html.includes('/invoice-print.css'), 'print stylesheet linked');
const { sendSecureHtml } = require('../lib/secure-html-response');
const sent = {};
sendSecureHtml({
  req: { headers: { host: 'erp.poshaktaranom.com' } },
  status() { return this; },
  type() { return this; },
  setHeader(name, value) { sent[name] = value; },
  send(value) { sent.body = value; return value; },
}, html, { allowPrintScript: true });
ok(sent.body.includes('https://erp.poshaktaranom.com/invoice-print.css'), 'server print HTML uses absolute CSS URL');
ok(sent.body.includes('https://erp.poshaktaranom.com/logo-sm.png'), 'server print HTML uses absolute logo URL');
ok(sent.body.includes('nonce="'), 'style nonce still present after absolutize');
ok(html.includes('words-fa') || html.includes('به حروف'), 'payable-in-words block present');

console.log(fail ? `\nFAILED ${fail} / ${pass + fail}` : `\nAll ${pass} checks passed`);
process.exit(fail ? 1 : 0);
