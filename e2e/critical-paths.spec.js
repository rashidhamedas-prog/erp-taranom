'use strict';
/**
 * Playwright critical paths (API + light UI) for Wave 0 P0-Q.
 * Uses Playwright baseURL from playwright.config.js (do not hardcode ports).
 */
const { test, expect } = require('@playwright/test');

const PASSWORDS = ['E2eAdmin#Wave01405', 'admin123'];

async function loginAdmin(request) {
  let lastBody = null;
  for (const password of PASSWORDS) {
    const login = await request.post('/api/auth/login', {
      data: { username: 'admin', password, force_logout_other: true },
    });
    const body = await login.json().catch(() => ({}));
    lastBody = body;
    if (body.must_change_password && body.token) {
      const ch = await request.post('/api/auth/change-password', {
        headers: { Authorization: `Bearer ${body.token}` },
        data: { oldPass: password, newPass: 'E2eAdmin#Wave01405' },
      });
      expect(ch.ok()).toBeTruthy();
      const again = await request.post('/api/auth/login', {
        data: { username: 'admin', password: 'E2eAdmin#Wave01405', force_logout_other: true },
      });
      const againBody = await again.json();
      expect(againBody.token).toBeTruthy();
      return {
        token: againBody.token,
        pass: 'E2eAdmin#Wave01405',
        auth: { Authorization: `Bearer ${againBody.token}` },
      };
    }
    if (body.token) {
      return {
        token: body.token,
        pass: password,
        auth: { Authorization: `Bearer ${body.token}` },
      };
    }
  }
  throw new Error('admin login failed: ' + JSON.stringify(lastBody));
}

async function relogin(request, pass) {
  const login = await request.post('/api/auth/login', {
    data: { username: 'admin', password: pass, force_logout_other: true },
  });
  expect(login.ok()).toBeTruthy();
  const body = await login.json();
  expect(body.token).toBeTruthy();
  return { token: body.token, auth: { Authorization: `Bearer ${body.token}` } };
}

test.describe.configure({ mode: 'serial' });

test('UI: login then force-password or app shell', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await expect(page.locator('#loginUser')).toBeVisible();
  await page.fill('#loginUser', 'admin');
  await page.fill('#loginPass', 'admin123');
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST'),
    page.locator('#loginForm').evaluate((form) => form.requestSubmit()),
  ]);
  await expect
    .poll(async () => {
      const force = await page.locator('#fc-old').isVisible().catch(() => false);
      const loginHidden = await page.locator('#login').evaluate((el) => getComputedStyle(el).display === 'none').catch(() => false);
      const err = ((await page.locator('#loginErr').textContent().catch(() => '')) || '').trim();
      if (err && !/نشست|دستگاه/.test(err)) return 'ERR:' + err;
      return force || loginHidden ? 'OK' : 'WAIT';
    }, { timeout: 20000 })
    .toBe('OK');
});

test('API: invoice cycle + hostile cross-company', async ({ request }) => {
  let { auth, pass } = await loginAdmin(request);

  const cust = await request.post('/api/customers', {
    headers: auth,
    data: { biz: 'مشتری E2E', owner: 'تست', city: 'مشهد', phone: '09121110001', status: 'active' },
  });
  expect(cust.ok()).toBeTruthy();
  const custBody = await cust.json();
  const custId = custBody.id || custBody.customer?.id;
  expect(custId).toBeTruthy();

  const prod = await request.post('/api/products', {
    headers: auth,
    data: { name: 'کالای E2E', code: 'E2E-P1', price: 150000, stock: 20, unit: 'عدد' },
  });
  expect(prod.ok()).toBeTruthy();
  const prodBody = await prod.json();
  const prodId = prodBody.id || prodBody.product?.id;
  expect(prodId).toBeTruthy();

  const inv = await request.post('/api/invoices', {
    headers: auth,
    data: {
      cust_id: custId,
      type: 'final',
      rows: [{ product_id: prodId, qty: 1, price: 150000 }],
      pay_type: 'credit',
    },
  });
  expect(inv.ok()).toBeTruthy();
  const invBody = await inv.json();
  const invId = invBody.id || invBody.invoice?.id;
  const invNum = invBody.num || invBody.invoice?.num;
  expect(invId).toBeTruthy();
  expect(invNum).toBeTruthy();

  const cos = await request.get('/api/companies', { headers: auth });
  expect(cos.ok()).toBeTruthy();
  const cosBody = await cos.json();
  const defaultId = cosBody.activeCompanyId;

  const created = await request.post('/api/companies', {
    headers: auth,
    data: {
      name: 'شرکت E2E ایزوله',
      code: 'E2E',
      fiscal_label: 'سال تست',
      start_date: '1405/01/01',
      activate: false,
    },
  });
  expect(created.ok()).toBeTruthy();
  const createdBody = await created.json();
  expect(createdBody.ok).toBeTruthy();
  const bId = createdBody.company.id;

  const actB = await request.post(`/api/companies/${bId}/activate`, { headers: auth, data: {} });
  expect(actB.ok()).toBeTruthy();
  ({ auth } = await relogin(request, pass));

  const listB = await request.get('/api/invoices', { headers: auth });
  expect(listB.ok()).toBeTruthy();
  const listBody = await listB.json();
  const rowsB = Array.isArray(listBody) ? listBody : (listBody.invoices || []);
  expect(rowsB.some((i) => i.id === invId || i.num === invNum)).toBeFalsy();

  const leak = await request.get(`/api/invoices/${invId}`, { headers: auth });
  expect([403, 404].includes(leak.status()) || !(await leak.json()).id).toBeTruthy();

  const back = await request.post(`/api/companies/${defaultId}/activate`, { headers: auth, data: {} });
  expect(back.ok()).toBeTruthy();
  ({ auth } = await relogin(request, pass));
  const again = await request.get(`/api/invoices/${invId}`, { headers: auth });
  expect(again.ok()).toBeTruthy();

  let del = await request.delete(`/api/companies/${bId}`, {
    headers: auth,
    data: { confirm_password: pass },
  });
  if (del.status() === 400) {
    const err = await del.json();
    if (/DELETE-COMPANY/.test(err.error || '')) {
      del = await request.delete(`/api/companies/${bId}`, {
        headers: auth,
        data: { confirm_password: pass, confirm_text: 'DELETE-COMPANY' },
      });
    }
  }
  expect(del.ok()).toBeTruthy();
});

test('API: private media path is not served as downloadable file', async ({ request }) => {
  const r = await request.get('/private-uploads/messages/does-not-exist.bin');
  const ct = (r.headers()['content-type'] || '').toLowerCase();
  const body = await r.text();
  // Must not stream a binary attachment; SPA fallback HTML is acceptable, 4xx also ok.
  const blocked = r.status() >= 400
    || ct.includes('text/html')
    || /<!doctype html|<html/i.test(body);
  expect(blocked).toBeTruthy();
  expect(body).not.toContain('private-bytes');
});

test('API: B2B unknown phone does not reveal users', async ({ request }) => {
  const r = await request.post('/api/b2b/auth/login', {
    data: { phone: '09158887766', password: 'wrong-password-xyz' },
  });
  expect(r.status()).toBeGreaterThanOrEqual(400);
  const body = await r.json().catch(() => ({}));
  const msg = JSON.stringify(body);
  expect(msg.toLowerCase()).not.toContain('admin');
});
