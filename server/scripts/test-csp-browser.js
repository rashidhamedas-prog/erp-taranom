'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', '..', 'e2e', 'node_modules', 'playwright'));

const publicDir = path.join(__dirname, '..', 'public');
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self'",
  "style-src-attr 'none'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'self' blob:",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'trusted-types erp-sanitizer-parser erp-taranom',
  "require-trusted-types-for 'script'"
].join('; ');

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};
const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
let privateImageAuthorization = '';
const verifiedNonce = 'browser-test-nonce-123456789';
const verifiedDocumentPolicy = [
  "default-src 'none'", "script-src 'none'", "script-src-attr 'none'",
  `style-src 'self' 'nonce-${verifiedNonce}'`, "style-src-attr 'none'", "img-src 'self' data:",
  "font-src 'self'", "connect-src 'none'", "object-src 'none'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  'sandbox allow-same-origin'
].join('; ');
const verifiedScriptPolicy = verifiedDocumentPolicy
  .replace("script-src 'none'", "script-src 'self'")
  .replace('sandbox allow-same-origin', 'sandbox allow-same-origin allow-scripts allow-modals');

function verifiedHtml(policy, extraHead = '', body = '<p>safe</p>') {
  return '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="'
    + policy + '"><style nonce="' + verifiedNonce + '">p{color:#123}</style>'
    + extraHead + '<title>verified</title></head><body>' + body + '</body></html>';
}

function sendVerified(response, policy, extraHead = '', body) {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': policy,
    'X-Taranom-Safe-HTML': '1',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(verifiedHtml(policy, extraHead, body));
}

function json(response, value) {
  response.writeHead(200, { 'Content-Type': mime['.json'], 'Content-Security-Policy': csp });
  response.end(JSON.stringify(value));
}

function handler(request, response) {
  const requestUrl = new URL(request.url, 'http://127.0.0.1');
  if (requestUrl.pathname === '/api/system/time') return json(response, { ts: Date.now() });
  if (requestUrl.pathname === '/api/system/app-info') return json(response, { role: 'central', version: 'test', b2b_portal: false });
  if (requestUrl.pathname === '/api/products/7') {
    return json(response, { id: 7, name: 'CSP product', code: 'CSP-7', stock: 2, stock_alert: 0, price: 1000, unit: 'عدد', images: [{ filename: 'x.png' }] });
  }
  if (requestUrl.pathname === '/api/messages/media/42') {
    privateImageAuthorization = request.headers.authorization || '';
    if (privateImageAuthorization !== 'Bearer test-token') {
      response.writeHead(401, { 'Content-Type': mime['.json'], 'Content-Security-Policy': csp });
      return response.end('{"error":"unauthorized"}');
    }
    response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': onePixelPng.length, 'Content-Security-Policy': csp });
    return response.end(onePixelPng);
  }
  if (requestUrl.pathname === '/api/test/secure-document') {
    return sendVerified(response, verifiedDocumentPolicy);
  }
  if (requestUrl.pathname === '/api/test/unverified-document') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': verifiedDocumentPolicy });
    return response.end('<!doctype html><html><head></head><body>unverified</body></html>');
  }
  if (requestUrl.pathname === '/api/test/remote-image-policy') {
    return sendVerified(response, verifiedDocumentPolicy.replace("img-src 'self' data:", 'img-src https:'));
  }
  if (requestUrl.pathname === '/api/test/missing-sandbox-policy') {
    return sendVerified(response, verifiedDocumentPolicy.replace('; sandbox allow-same-origin', ''));
  }
  if (requestUrl.pathname === '/api/test/extra-sandbox-policy') {
    return sendVerified(response, verifiedDocumentPolicy.replace('sandbox allow-same-origin', 'sandbox allow-same-origin allow-popups'));
  }
  if (requestUrl.pathname === '/api/test/mismatched-nonce-document') {
    const html = verifiedHtml(verifiedDocumentPolicy).replace(`nonce="${verifiedNonce}"`, 'nonce="wrong-nonce-123456789"');
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': verifiedDocumentPolicy,
      'X-Taranom-Safe-HTML': '1'
    });
    return response.end(html);
  }
  if (requestUrl.pathname === '/api/test/mismatched-script-document') {
    return sendVerified(response, verifiedDocumentPolicy, '<script src="/print-page.js"></script>');
  }
  if (requestUrl.pathname === '/api/test/unapproved-script-document') {
    return sendVerified(response, verifiedScriptPolicy, '<script src="/app.js"></script>');
  }

  const pathname = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  const resolved = path.resolve(publicDir, `.${pathname}`);
  if (!resolved.startsWith(path.resolve(publicDir) + path.sep) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain', 'Content-Security-Policy': csp });
    return response.end('not found');
  }
  response.writeHead(200, {
    'Content-Type': mime[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff'
  });
  fs.createReadStream(resolved).pipe(response);
}

async function main() {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  let browser;
  try {
    const requestedExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '';
    const bundledExecutable = chromium.executablePath();
    const systemChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    let executablePath = '';
    if (requestedExecutable) {
      if (!fs.existsSync(requestedExecutable)) throw new Error(`PLAYWRIGHT_CHROMIUM_EXECUTABLE does not exist: ${requestedExecutable}`);
      executablePath = requestedExecutable;
    } else if (!fs.existsSync(bundledExecutable) && fs.existsSync(systemChrome)) {
      executablePath = systemChrome;
    }
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const page = await browser.newPage();
    const pageErrors = [];
    const cspViolations = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', event => {
        window.__cspViolations.push({
          directive: event.effectiveDirective,
          blocked: event.blockedURI,
          sample: event.sample,
          source: event.sourceFile,
          line: event.lineNumber,
          column: event.columnNumber
        });
      });
    });
    await page.goto(origin, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForFunction(() => window.CSP && typeof window.productCardHtml === 'function');

    assert.deepStrictEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
    assert.strictEqual(await page.evaluate(() => typeof trustedTypes !== 'undefined'), true, 'Chromium Trusted Types unavailable');

    const sanitizer = await page.evaluate(() => {
      window.__xss = 0;
      const host = document.createElement('div');
      host.id = 'csp-xss-test';
      document.body.appendChild(host);
      host.innerHTML = '<img src="/logo.png" style="position:fixed" onerror="window.__xss=1">'
        + '<a id="bad-link" href="javascript:window.__xss=2">bad</a>'
        + '<svg><g onload="window.__xss=3"></g><script>window.__xss=4<\/script></svg>';
      return {
        xss: window.__xss,
        handler: host.querySelector('img')?.getAttribute('onerror'),
        style: host.querySelector('img')?.getAttribute('style'),
        href: host.querySelector('#bad-link')?.getAttribute('href'),
        scripts: host.querySelectorAll('script').length,
        svgHandler: host.querySelector('g')?.getAttribute('onload')
      };
    });
    assert.deepStrictEqual(sanitizer, { xss: 0, handler: null, style: null, href: null, scripts: 0, svgHandler: null });
    const blockedAttackViolations = await page.evaluate(() => window.__cspViolations.splice(0));
    assert.ok(
      blockedAttackViolations.length >= 1 && blockedAttackViolations.every(item => item.directive === 'style-src-attr' && item.blocked === 'inline'),
      `hostile inline style was not blocked as expected: ${JSON.stringify(blockedAttackViolations)}`
    );

    const themeBefore = await page.locator('html').getAttribute('data-theme');
    await page.locator('.theme-toggle-btn').first().click();
    const themeAfter = await page.locator('html').getAttribute('data-theme');
    assert.notStrictEqual(themeAfter, themeBefore, 'static delegated theme action did not fire');

    const delegated = await page.evaluate(async () => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      window.__delegated = 0;
      host.innerHTML = `<button id="delegated-test" data-csp-click="${CSP.bind('click', function () { window.__delegated += 1; })}">go</button>`;
      document.getElementById('delegated-test').click();
      await new Promise(resolve => setTimeout(resolve, 0));
      return window.__delegated;
    });
    assert.strictEqual(delegated, 1, 'dynamic delegated action did not fire');

    const appliedColor = await page.evaluate(async () => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      host.innerHTML = `<span id="style-test" data-csp-style="${CSP.style('color:rgb(1, 2, 3)')}">styled</span>`;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return getComputedStyle(document.getElementById('style-test')).color;
    });
    assert.strictEqual(appliedColor, 'rgb(1, 2, 3)', 'CSP-safe dynamic style was not applied');

    const canvasCapture = await page.evaluate(async () => {
      const panel = document.createElement('section');
      panel.id = 'html2canvas-csp-test';
      panel.textContent = 'Taranom CSP capture';
      panel.dataset.cspStyle = CSP.style('width:180px;height:48px;background:#fff;color:#123;padding:8px');
      document.body.appendChild(panel);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      try {
        const canvas = await CSP.capture(panel, { backgroundColor: '#ffffff', scale: 1, logging: false });
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let hasInk = false;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 3] && (pixels[i] < 230 || pixels[i + 1] < 230 || pixels[i + 2] < 230)) { hasInk = true; break; }
        }
        return { width: canvas.width, height: canvas.height, hasInk, data: canvas.toDataURL('image/png').slice(0, 22) };
      } finally {
        panel.remove();
      }
    });
    assert.ok(canvasCapture.width >= 180 && canvasCapture.height >= 48 && canvasCapture.hasInk && canvasCapture.data === 'data:image/png;base64,', `html2canvas capture failed: ${JSON.stringify(canvasCapture)}`);
    await page.waitForTimeout(1000);
    const captureViolations = await page.evaluate(() => window.__cspViolations.splice(0));
    assert.deepStrictEqual(captureViolations, [], `html2canvas caused CSP violations: ${JSON.stringify(captureViolations)}`);

    await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'csp-product-test';
      document.body.appendChild(host);
      host.innerHTML = productCardHtml({
        id: 7, name: 'CSP product', code: 'CSP-7', stock: 2, stock_alert: 0,
        price: 1000, unit: 'عدد', images: [{ filename: 'x.png' }]
      }, { canEdit: false, selectable: false });
    });
    await page.locator('#csp-product-test .pcard .img').evaluate(element => element.click());
    await page.locator('.img-overlay.img-album').waitFor({ state: 'visible' });
    assert.ok((await page.locator('.img-overlay.img-album img').getAttribute('src')).includes('/uploads/products/x.png'), 'product album action lost its image');
    await page.locator('.img-overlay.img-album .img-album-close').evaluate(element => element.click());

    await page.evaluate(() => localStorage.setItem('crm_token', 'test-token'));
    await page.evaluate(() => showImgPreview('/api/messages/media/42'));
    await page.waitForFunction(() => document.querySelector('.img-overlay.img-album img')?.src.startsWith('blob:'));
    assert.strictEqual(privateImageAuthorization, 'Bearer test-token', 'private image fetch omitted bearer authorization');
    await page.locator('.img-overlay.img-album .img-album-close').evaluate(element => element.click());

    const verifiedDocument = await page.evaluate(async () => {
      const nativeOpen = window.open;
      let openedUrl = '';
      window.open = url => {
        openedUrl = String(url || '');
        return { opener: window };
      };
      try {
        const accepted = await CSP.openVerifiedServerDocument(await fetch('/api/test/secure-document'));
        let rejected = false;
        try { await CSP.openVerifiedServerDocument(await fetch('/api/test/unverified-document')); }
        catch (_) { rejected = true; }
        const invalidPaths = [
          '/api/test/remote-image-policy',
          '/api/test/missing-sandbox-policy',
          '/api/test/extra-sandbox-policy',
          '/api/test/mismatched-nonce-document',
          '/api/test/mismatched-script-document',
          '/api/test/unapproved-script-document'
        ];
        let rejectedPolicies = 0;
        for (const path of invalidPaths) {
          try { await CSP.openVerifiedServerDocument(await fetch(path)); }
          catch (_) { rejectedPolicies += 1; }
        }
        return { accepted, rejected, rejectedPolicies, openedBlob: openedUrl.startsWith('blob:') };
      } finally {
        window.open = nativeOpen;
      }
    });
    assert.deepStrictEqual(verifiedDocument, { accepted: true, rejected: true, rejectedPolicies: 6, openedBlob: true }, 'verified server document contract failed');

    const verifiedFrameText = await page.evaluate(async () => {
      const handle = await CSP.createVerifiedServerFrame(await fetch('/api/test/secure-document'), { width: 420, height: 420 });
      try { return handle.element.contentDocument.body.textContent.trim(); }
      finally { handle.dispose(); }
    });
    assert.strictEqual(verifiedFrameText, 'safe', 'verified same-origin HTML frame failed to load');

    cspViolations.push(...await page.evaluate(() => window.__cspViolations || []));
    assert.deepStrictEqual(pageErrors, [], `page errors after interactions: ${pageErrors.join(' | ')}`);
    assert.deepStrictEqual(cspViolations, [], `CSP violations: ${JSON.stringify(cspViolations)}`);
    console.log('CSP browser gate passed: 15/15 (strict CSP/Trusted Types, hostile markup, events/styles, html2canvas, product/private media, verified HTML policy negatives, zero normal-flow violations).');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
