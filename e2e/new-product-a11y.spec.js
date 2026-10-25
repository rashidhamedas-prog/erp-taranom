'use strict';
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

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
      return { pass: 'E2eAdmin#Wave01405' };
    }
    if (body.token) return { pass: password };
  }
  throw new Error('login failed');
}

test('new product modal has no critical/serious axe violations', async ({ page, request }) => {
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
  await page.waitForSelector('.prod-form-v2 #p-name', { timeout: 20000 });

  const results = await new AxeBuilder({ page })
    .include('.prod-form-v2')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();

  const bad = (results.violations || []).filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
});
