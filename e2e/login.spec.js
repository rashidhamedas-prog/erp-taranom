'use strict';
const { test, expect } = require('@playwright/test');

test('login page renders and admin can sign in', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#loginUser')).toBeVisible();
  await expect(page.locator('#loginPass')).toBeVisible();
  await page.fill('#loginUser', 'admin');
  await page.fill('#loginPass', 'admin123');
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST', { timeout: 20000 }),
    page.locator('#loginForm').evaluate((form) => form.requestSubmit()),
  ]);
  // Force-password modal (#fc-old) OR login shell hidden after boot
  await expect
    .poll(async () => {
      const force = await page.locator('#fc-old').isVisible().catch(() => false);
      const loginHidden = await page.locator('#login').evaluate((el) => getComputedStyle(el).display === 'none').catch(() => false);
      const err = (await page.locator('#loginErr').textContent().catch(() => '')) || '';
      if (err.trim()) return 'ERR:' + err.trim();
      return force || loginHidden ? 'OK' : 'WAIT';
    }, { timeout: 20000 })
    .toBe('OK');
});
