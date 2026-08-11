'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const serverDir = path.join(__dirname, '..');
const publicDir = path.join(serverDir, 'public');
const publicSources = fs.readdirSync(publicDir, { withFileTypes: true })
  .filter(entry => entry.isFile() && /\.(?:html|js)$/i.test(entry.name))
  .map(entry => path.join(publicDir, entry.name));
const generatedHtmlSources = [
  path.join(serverDir, 'routes', 'accounting.js'),
  path.join(serverDir, 'routes', 'rep-management.js'),
  path.join(serverDir, 'routes', 'products.js'),
  path.join(serverDir, 'lib', 'invoice-print.js'),
  path.join(serverDir, 'lib', 'production', 'report-export.js')
];
const nonceStyleTransports = new Map([
  ['routes/accounting.js', { expected: 1, transport: path.join(serverDir, 'routes', 'accounting.js') }],
  ['routes/rep-management.js', { expected: 1, transport: path.join(serverDir, 'routes', 'rep-management.js') }],
  ['routes/products.js', { expected: 1, transport: path.join(serverDir, 'routes', 'products.js') }],
  ['lib/invoice-print.js', { expected: 1, transport: path.join(serverDir, 'routes', 'invoices.js') }],
  ['lib/production/report-export.js', { expected: 2, transport: path.join(serverDir, 'routes', 'production-reports.js') }]
]);
const serverEntry = path.join(serverDir, 'server.js');

function count(pattern, text) {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)].length;
}

function inspectFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  return {
    file: path.relative(serverDir, file).replace(/\\/g, '/'),
    inlineEvents: count(/(?:^|[^.\w-])on[a-z]+\s*=\s*["']/gim, text),
    eventAttributeApis: count(/(?:set|get)Attribute\s*\(\s*["']on[a-z]+["']/gi, text),
    javascriptUrls: count(/(?:href|src)\s*=\s*["']\s*javascript\s*:/gi, text),
    privateUploadUrls: count(/\/uploads\/(?:messages|vouchers|reps|rubika)\b/gi, text),
    queryAuthTokens: count(/[?&]token\s*=/gi, text),
    inlineScripts: count(/<script(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script>/gi, text),
    inlineStyles: /\.html$/i.test(file)
      ? count(/<style\b[^>]*>[\s\S]*?<\/style>/gi, text)
      : count(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, text),
    styleAttributes: count(/(?:^|[^.\w-])style\s*=\s*["']/gim, text),
    documentWrite: count(/document\.write\s*\(/g, text),
    unsafeEval: count(/\beval\s*\(|\bnew\s+Function\s*\(/g, text),
    htmlSinks: count(/\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(/g, text)
  };
}

function issueCount(item) {
  return item.inlineEvents + item.eventAttributeApis + item.javascriptUrls + item.privateUploadUrls + item.queryAuthTokens + item.inlineScripts
    + item.inlineStyles + item.styleAttributes + item.documentWrite + item.unsafeEval;
}

const publicInventory = publicSources.map(inspectFile);
const generatedInventory = generatedHtmlSources.map(inspectFile);
const serverText = fs.readFileSync(serverEntry, 'utf8');
const unsafeInline = count(/["']unsafe-inline["']/g, serverText);
const index = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const order = {
  runtime: index.indexOf('/csp-runtime.js'),
  firstFeatureScript: Math.min(...['/marketer-ui.js', '/portal-ui.js', '/app.js'].map(name => index.indexOf(name)).filter(pos => pos >= 0))
};

const failures = [];
for (const item of publicInventory) {
  if (issueCount(item)) failures.push(`public/${item.file}: ${JSON.stringify(item)}`);
}
for (const file of publicSources.filter(file => /\.js$/i.test(file))) {
  try {
    new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
  } catch (error) {
    failures.push(`public/${path.basename(file)} does not parse: ${error.message}`);
  }
}
if (order.runtime < 0 || order.firstFeatureScript < 0 || order.runtime > order.firstFeatureScript) {
  failures.push('csp-runtime.js must load before every feature script');
}
const runtime = fs.readFileSync(path.join(publicDir, 'csp-runtime.js'), 'utf8');
if (!/trustedTypes\.createPolicy\('erp-taranom'/.test(runtime)) {
  failures.push('erp-taranom Trusted Types policy is missing');
}
if (!/async function openVerifiedServerDocument\(response\)/.test(runtime)) {
  failures.push('verified same-origin server-document opener is missing');
}

const publicOnly = process.argv.includes('--public-only');
if (!publicOnly) {
  for (const item of generatedInventory) {
    let approvedNonceStyles = 0;
    if (item.inlineStyles) {
      const approved = nonceStyleTransports.get(item.file);
      if (!approved || approved.expected !== item.inlineStyles) {
        failures.push(`generated/${item.file}: unexpected style block count (${item.inlineStyles}); explicit nonce transport review required`);
      } else {
        const transport = fs.readFileSync(approved.transport, 'utf8');
        const hasSecureTransport = /require\([^\n]*secure-html-response[^\n]*\)/.test(transport)
          && /\bsendSecureHtml\s*\(/.test(transport);
        if (!hasSecureTransport) {
          failures.push(`generated/${item.file}: style block is not routed exclusively through sendSecureHtml nonce transport`);
        } else {
          approvedNonceStyles = item.inlineStyles;
        }
      }
    }
    if (issueCount(item) - approvedNonceStyles) failures.push(`generated/${item.file}: ${JSON.stringify(item)}`);
  }
  if (unsafeInline) failures.push(`server/server.js still contains ${unsafeInline} unsafe-inline source(s)`);
}

const report = {
  public: publicInventory.filter(item => issueCount(item) || item.htmlSinks),
  generated: generatedInventory.filter(item => issueCount(item) || item.htmlSinks),
  helmetUnsafeInline: unsafeInline,
  runtimeOrder: order
};

if (process.argv.includes('--inventory')) console.log(JSON.stringify(report, null, 2));
if (failures.length) {
  console.error(`CSP/DOM-XSS static gate failed (${failures.length}):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log(`CSP/DOM-XSS static gate passed (${publicSources.length} public sources${publicOnly ? '' : ` + ${generatedHtmlSources.length} generated HTML sources`}).`);
