'use strict';
const { test, expect } = require('@playwright/test');

async function apiLogin(request) {
  for (const password of ['admin123', 'E2eAdmin#Wave01405']) {
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
  await expect.poll(async () => page.evaluate(() => typeof storeQsRenderResults === 'function').catch(() => false), { timeout: 45000 }).toBeTruthy();
  await page.evaluate(async () => { if (typeof go === 'function') await go('store-quick-sale'); });
  await page.waitForSelector('.pos-v2 #storeQsScan', { timeout: 30000 });
}

test('product with image uses /uploads/products/; without image uses placeholder not logo (B15)', async ({ page, request }) => {
  await openPos(page, request);
  await page.route('**/api/products?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { id: 1, name: 'با تصویر', code: 'I1', image: 'coat-a.jpg', stock: 1, wh_qty: 1, status: 'active', item_type: 'finished', approval_status: 'approved', consumer_price: 1 },
        { id: 2, name: 'بدون تصویر', code: 'I2', stock: 1, wh_qty: 1, status: 'active', item_type: 'finished', approval_status: 'approved', consumer_price: 1 },
      ]),
    });
  });
  await page.locator('#storeQsScan').fill('تصویر');
  await page.waitForSelector('.pos-prod', { timeout: 10000 });
  const withImg = page.locator('.pos-prod').filter({ hasText: 'با تصویر' }).locator('img.pos-prod-thumb');
  await expect(withImg).toHaveAttribute('src', /\/uploads\/products\//);
  const ph = page.locator('.pos-prod').filter({ hasText: 'بدون تصویر' }).locator('.pos-prod-ph');
  await expect(ph).toBeVisible();
  await expect(page.locator('.pos-prod img[src*="logo.png"]')).toHaveCount(0);
});
