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
      return { pass: 'E2eAdmin#Wave01405' };
    }
    if (body.token) return { pass: password };
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
  await expect
    .poll(async () => {
      const ready = await page
        .evaluate(() => typeof storeQsRenderBody === 'function' && !!window.ME)
        .catch(() => false);
      const loginHidden = await page
        .locator('#login')
        .evaluate((el) => getComputedStyle(el).display === 'none')
        .catch(() => false);
      return ready && loginHidden ? 'OK' : 'WAIT';
    }, { timeout: 45000 })
    .toBe('OK');
  await page.evaluate(async () => {
    if (typeof go === 'function') await go('store-quick-sale');
  });
  await page.waitForSelector('.pos-v2', { timeout: 30000 });
}

test('POS v2 has no critical/serious axe violations (desktop)', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPos(page, request);
  const results = await new AxeBuilder({ page })
    .include('.pos-v2')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const bad = (results.violations || []).filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
});

test('POS v2 has no critical/serious axe violations (mobile)', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPos(page, request);
  const results = await new AxeBuilder({ page })
    .include('.pos-v2')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  const bad = (results.violations || []).filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
});
