'use strict';
const { test, expect } = require('@playwright/test');

test('login page renders and admin can sign in', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await expect(page.locator('#loginUser')).toBeVisible();
  await expect(page.locator('#loginPass')).toBeVisible();
  const passwords = ['admin123', 'E2eAdmin#Wave01405'];
  let ok = false;
  let lastErr = '';
  for (const password of passwords) {
    await page.fill('#loginUser', 'admin');
    await page.fill('#loginPass', password);
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST', { timeout: 20000 }),
      page.locator('#loginForm').evaluate((form) => form.requestSubmit()),
    ]);
    const state = await (async () => {
      for (let i = 0; i < 40; i += 1) {
        const force = await page.locator('#fc-old').isVisible().catch(() => false);
        const loginHidden = await page.locator('#login').evaluate((el) => getComputedStyle(el).display === 'none').catch(() => false);
        const err = ((await page.locator('#loginErr').textContent().catch(() => '')) || '').trim();
        if (force || loginHidden) return 'OK';
        if (err && !/نشست|دستگاه/.test(err)) return 'ERR:' + err;
        await page.waitForTimeout(250);
      }
      return 'WAIT';
    })();
    if (state === 'OK') { ok = true; break; }
    lastErr = state;
  }
  expect(ok, lastErr || 'login failed').toBeTruthy();
});
