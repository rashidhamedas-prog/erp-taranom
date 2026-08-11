'use strict';

const assert = require('assert');
const {
  secureHtmlDocument,
  sendSecureHtml,
  assertNoInlineExecutableMarkup,
} = require('../lib/secure-html-response');

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

const base = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/print.css"><style>body{color:#111}</style></head><body><button data-print>print</button><script src="/print-page.js"></script></body></html>';

ok('nonce is injected into style and CSP header/meta', () => {
  const result = secureHtmlDocument(base, { allowPrintScript: true });
  assert.match(result.html, /<style nonce="[A-Za-z0-9+/=]+">/);
  assert.match(result.html, /http-equiv="Content-Security-Policy"/);
  assert.match(result.policy, /script-src 'self'/);
  assert.match(result.policy, /script-src-attr 'none'/);
  assert.match(result.policy, /style-src 'self' 'nonce-/);
  assert.match(result.policy, /style-src-attr 'none'/);
  assert.doesNotMatch(result.policy, /unsafe-inline|unsafe-eval/);
});

for (const [name, fragment] of [
  ['inline event handler', '<button onclick="print()">x</button>'],
  ['inline style attribute', '<div style="color:red">x</div>'],
  ['javascript URL', '<a href="javascript:alert(1)">x</a>'],
  ['inline script body', '<script>alert(1)</script>'],
  ['remote script source', '<script src="https://evil.example/x.js"></script>'],
  ['protocol-relative script source', '<script src="//evil.example/x.js"></script>'],
  ['unapproved local script source', '<script src="/app.js"></script>'],
]) {
  ok(`rejects ${name}`, () => {
    assert.throws(
      () => assertNoInlineExecutableMarkup(`<!doctype html><html><head></head><body>${fragment}</body></html>`),
      /Secure HTML response/,
    );
  });
}

ok('rejects a document without head', () => {
  assert.throws(() => secureHtmlDocument('<html><body>x</body></html>'), /head element/);
});

ok('response is marked and header policy matches the embedded policy', () => {
  const headers = {};
  const response = {
    statusCode: 0,
    status(code) { this.statusCode = code; return this; },
    type(value) { headers['Content-Type'] = value; return this; },
    setHeader(name, value) { headers[name] = value; },
    send(value) { this.body = value; return value; },
  };
  sendSecureHtml(response, base, { allowPrintScript: true });
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(headers['X-Taranom-Safe-HTML'], '1');
  assert.strictEqual(headers['Cache-Control'], 'private, no-store, max-age=0');
  assert.ok(response.body.includes('http-equiv="Content-Security-Policy"'));
  assert.ok(response.body.includes(headers['Content-Security-Policy'].replace(/&/g, '&amp;').replace(/"/g, '&quot;')));
});

console.log(`secure HTML response: ${passed}/${passed} pass`);
