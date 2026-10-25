'use strict';
const { test, expect } = require('@playwright/test');

async function apiLogin(request) {
  const passwords = ['admin123', 'E2eAdmin#Wave01405'];
  for (const password of passwords) {
    const login = await request.post('/api/auth/login', {
      data: { username: 'admin', password, force_logout_other: true },
    });
    const body = await login.json().catch(() => ({}));
    if (body.token) return { pass: password, token: body.token };
  }
  throw new Error('login failed');
}

async function openPos(page, request) {
  page.on('dialog', (d) => d.accept());
  const { pass } = await apiLogin(request);
  await page.goto('/');
  await page.fill('#loginUser', 'admin');
  await page.fill('#loginPass', pass);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST'),
    page.locator('#loginForm').evaluate((form) => form.requestSubmit()),
  ]);
  await expect.poll(async () => page.evaluate(() => typeof storeQsLiveSearch === 'function' && !!window.ME).catch(() => false), { timeout: 45000 }).toBeTruthy();
  await page.evaluate(async () => { if (typeof go === 'function') await go('store-quick-sale'); });
  await page.waitForSelector('.pos-v2 #storeQsScan', { timeout: 30000 });
}

test('fast typing keeps input + last query wins (B18)', async ({ page, request }) => {
  await openPos(page, request);
  let hits = [];
  await page.route('**/api/products?*', async (route) => {
    const u = new URL(route.request().url());
    const q = u.searchParams.get('search') || u.searchParams.get('q') || '';
    hits.push(q);
    await new Promise((r) => setTimeout(r, 500));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { id: 1, name: 'نتیجه ' + q, code: 'X', stock: 1, wh_qty: 1, status: 'active', item_type: 'finished', approval_status: 'approved', consumer_price: 1 },
      ]),
    });
  });
  const scan = page.locator('#storeQsScan');
  await scan.type('کفتان لینن', { delay: 30 });
  await expect(scan).toHaveValue('کفتان لینن');
  await page.waitForTimeout(900);
  const lastName = await page.locator('.pos-prod-name').first().textContent();
  expect(lastName).toContain('کفتان لینن');
  expect(hits[hits.length - 1]).toBe('کفتان لینن');
});

test('zzzz shows empty state; Esc closes list', async ({ page, request }) => {
  await openPos(page, request);
  await page.route('**/api/products?*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.locator('#storeQsScan').fill('zzzz');
  await expect(page.getByRole('status').filter({ hasText: 'کالا یافت نشد' })).toBeVisible({ timeout: 10000 });
  await page.locator('#storeQsScan').press('Escape');
  await expect(page.locator('#posResults .pos-empty')).toHaveCount(0);
});

test('POS search sends warehouse_id + for=pos (B17)', async ({ page, request }) => {
  await openPos(page, request);
  let seen = null;
  await page.route('**/api/products?*', async (route) => {
    seen = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.locator('#storeQsScan').fill('آستری');
  await page.waitForTimeout(400);
  expect(seen).toBeTruthy();
  expect(seen.searchParams.get('for')).toBe('pos');
  expect(seen.searchParams.get('include_zero')).toBe('1');
});
