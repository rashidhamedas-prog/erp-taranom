'use strict';
/**
 * Assert «کالای جدید» FormData keys/order/values match the committed snapshot
 * taken from the original prodModal on the default branch tip.
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const SNAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'new-product-formdata.snapshot.json'), 'utf8')
);

function serializeMultipart(postDataBuffer, contentType) {
  const entries = [];
  if (!postDataBuffer || !contentType) return entries;
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return entries;
  const boundary = m[1] || m[2];
  const raw = Buffer.isBuffer(postDataBuffer) ? postDataBuffer : Buffer.from(postDataBuffer);
  const parts = raw.toString('binary').split('--' + boundary);
  for (const part of parts) {
    if (!part || part === '--\r\n' || part === '--') continue;
    const idx = part.indexOf('\r\n\r\n');
    if (idx < 0) continue;
    const headers = part.slice(0, idx);
    let bodyBin = part.slice(idx + 4);
    if (bodyBin.endsWith('\r\n')) bodyBin = bodyBin.slice(0, -2);
    const nameM = /name="([^"]+)"/i.exec(headers);
    if (!nameM) continue;
    const name = nameM[1];
    if (/filename=/i.test(headers)) entries.push({ key: name, value: '__FILE__', file: true });
    else entries.push({ key: name, value: Buffer.from(bodyBin, 'binary').toString('utf8') });
  }
  return entries;
}

async function apiLogin(request) {
  const passwords = ['admin123', 'E2eAdmin#Wave01405'];
  for (const password of passwords) {
    const login = await request.post('/api/auth/login', {
      data: { username: 'admin', password, force_logout_other: true },
    });
    const body = await login.json().catch(() => ({}));
    if (body.must_change_password && body.token) {
      await request.post('/api/auth/change-password', {
        headers: { Authorization: `Bearer ${body.token}` },
        data: { oldPass: password, newPass: 'E2eAdmin#Wave01405' },
      });
      const again = await request.post('/api/auth/login', {
        data: { username: 'admin', password: 'E2eAdmin#Wave01405', force_logout_other: true },
      });
      const againBody = await again.json();
      return { pass: 'E2eAdmin#Wave01405', token: againBody.token };
    }
    if (body.token) return { pass: password, token: body.token };
  }
  throw new Error('login failed');
}

async function fillField(page, sel, value) {
  const loc = page.locator(sel);
  if (!(await loc.count())) return;
  await loc.evaluate((el, v) => {
    el.removeAttribute('readonly');
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

test('new product FormData matches original snapshot (keys+order+values)', async ({ page, request }) => {
  page.on('dialog', (d) => d.accept());
  const { pass } = await apiLogin(request);
  await page.goto('/');
  await page.fill('#loginUser', 'admin');
  await page.fill('#loginPass', pass);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST'),
    page.locator('#loginForm').evaluate((form) => form.requestSubmit()),
  ]);
  await expect
    .poll(async () => {
      const force = await page.locator('#fc-old').isVisible().catch(() => false);
      const loginHidden = await page
        .locator('#login')
        .evaluate((el) => getComputedStyle(el).display === 'none')
        .catch(() => false);
      const ready = await page.evaluate(() => typeof prodModal === 'function' && !!window.ME).catch(() => false);
      return !force && loginHidden && ready ? 'OK' : 'WAIT';
    }, { timeout: 30000 })
    .toBe('OK');

  await page.evaluate(async () => {
    if (typeof accNewProduct === 'function') await accNewProduct();
    else await prodModal(0);
  });
  await page.waitForSelector('#p-name', { timeout: 20000 });

  const f = SNAP.fill;
  await fillField(page, '#p-name', f.name);
  await fillField(page, '#p-code', f.code);
  await fillField(page, '#p-barcode', f.barcode);
  await fillField(page, '#p-price', f.price);
  await fillField(page, '#p-retail', f.retail);
  await fillField(page, '#p-cost', f.cost);
  await fillField(page, '#p-stock', f.stock);
  await fillField(page, '#p-alert', f.stock_alert);
  await fillField(page, '#p-colors', f.colors);
  await fillField(page, '#p-pack_size', f.pack_size);
  await fillField(page, '#p-note', f.note);
  await fillField(page, '#p-cat', f.category);

  let captured = null;
  await page.route('**/api/products', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      captured = serializeMultipart(req.postDataBuffer(), req.headers()['content-type'] || '');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 999001, name: 'ok', production_readiness: { hard: [], soft: [] } }),
      });
      return;
    }
    await route.continue();
  });

  await page.evaluate(() => saveProduct(0));
  await expect.poll(() => (captured ? captured.length : 0), { timeout: 15000 }).toBeGreaterThan(5);
  await page.unroute('**/api/products');

  expect(captured.map((e) => e.key)).toEqual(SNAP.entries.map((e) => e.key));
  expect(captured.map((e) => e.value)).toEqual(SNAP.entries.map((e) => e.value));
});
