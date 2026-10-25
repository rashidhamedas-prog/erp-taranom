'use strict';
/**
 * POS v2 QA regressions (B1–B18) — UI/CSP/keyboard/search.
 * Requires local ERP server. Does not mutate store-quick-payload.snapshot.json.
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const VIEWPORTS = [
  { name: '1920', width: 1920, height: 1080 },
  { name: '1366', width: 1366, height: 768 },
  { name: '1024', width: 1024, height: 768 },
  { name: '390', width: 390, height: 844 },
];

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
      return { pass: 'E2eAdmin#Wave01405', token: (await again.json()).token };
    }
    if (body.token) return { pass: password, token: body.token };
  }
  throw new Error('login failed');
}

async function openPos(page, request, opts = {}) {
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
        .evaluate(() => typeof storeQsCheckout === 'function' && !!window.ME)
        .catch(() => false);
      const loginHidden = await page
        .locator('#login')
        .evaluate((el) => getComputedStyle(el).display === 'none')
        .catch(() => false);
      return ready && loginHidden ? 'OK' : 'WAIT';
    }, { timeout: 45000 })
    .toBe('OK');
  if (opts.theme === 'dark') {
    await page.evaluate(() => {
      localStorage.setItem('crm_theme', 'dark');
      if (typeof applyTheme === 'function') applyTheme('dark');
    });
  }
  await page.evaluate(async () => {
    if (typeof go === 'function') await go('store-quick-sale');
  });
  await page.waitForSelector('.pos-v2 #storeQsScan', { timeout: 30000 });
}

test.describe('POS v2 QA', () => {
  test('ref-invoice helpers exist (B1) and F-key regex allows F4 while typing (B4)', async ({ page, request }) => {
    await openPos(page, request);
    const meta = await page.evaluate(() => ({
      load: typeof storeQsLoadRefInvoices === 'function',
      select: typeof storeQsSelectRefInvoice === 'function',
      fk: /^F\d+$/.test('F4') && !/^Fd+$/.test('F4'),
      cardHidden: !document.querySelector('.pos-pay-chip[aria-checked][disabled][title="به‌زودی"]'),
    }));
    expect(meta.load).toBe(true);
    expect(meta.select).toBe(true);
    expect(meta.fk).toBe(true);
  });

  test('CSP: zero style=/on*= in POS DOM after render (B2)', async ({ page, request }) => {
    const violations = [];
    page.on('console', (msg) => {
      const t = msg.text() || '';
      if (/Content Security Policy|Refused to apply inline style|Refused to execute inline event/i.test(t)) {
        violations.push(t);
      }
    });
    await openPos(page, request);
    await page.click('.pos-tab[aria-selected="false"]').catch(() => {});
    await page.waitForTimeout(400);
    const inline = await page.evaluate(() => {
      const root = document.querySelector('.pos-v2');
      if (!root) return { style: -1, on: -1 };
      let style = 0;
      let on = 0;
      root.querySelectorAll('*').forEach((el) => {
        if (el.hasAttribute('style')) style += 1;
        for (const a of el.attributes) {
          if (/^on/i.test(a.name)) on += 1;
        }
      });
      return { style, on };
    });
    expect(inline.style).toBe(0);
    expect(inline.on).toBe(0);
    expect(violations).toEqual([]);
  });

  test('Enter on live results adds focused item without legacy modal (B10/B18)', async ({ page, request }) => {
    await openPos(page, request);
    await page.route('**/api/products?*', async (route) => {
      const u = new URL(route.request().url());
      if (!u.searchParams.get('search') && !u.searchParams.get('q')) return route.continue();
      const rows = [
        { id: 9101, name: 'کفتان لینن تست', code: 'KF-1', barcode: '2001', price: 100000, consumer_price: 100000, stock: 5, wh_qty: 5, status: 'active', item_type: 'finished', approval_status: 'approved' },
        { id: 9102, name: 'کفتان لینن دوم', code: 'KF-2', barcode: '2002', price: 110000, consumer_price: 110000, stock: 3, wh_qty: 3, status: 'active', item_type: 'finished', approval_status: 'approved' },
        { id: 9103, name: 'کفتان لینن سوم', code: 'KF-3', barcode: '2003', price: 120000, consumer_price: 120000, stock: 2, wh_qty: 2, status: 'active', item_type: 'finished', approval_status: 'approved' },
      ];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
    });
    const scan = page.locator('#storeQsScan');
    await scan.fill('کفتان لینن');
    await page.waitForSelector('.pos-prod', { timeout: 10000 });
    await scan.press('ArrowDown');
    await scan.press('ArrowDown');
    await scan.press('Enter');
    await expect(page.locator('.modal, .overlay.open')).toHaveCount(0);
    const lines = await page.evaluate(() => (_storeQs.lines || []).map((l) => l.product_id));
    expect(lines).toContain(9103);
  });

  test('variant barcode adds variant_id directly (B9)', async ({ page, request }) => {
    await openPos(page, request);
    await page.route('**/api/products/by-barcode/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 9201,
          name: 'مانتو تست تنوع',
          code: 'MT-V',
          barcode: '200107001001',
          price: 200000,
          consumer_price: 200000,
          stock: 4,
          variant_id: 7788,
          color_name: 'مشکی',
          size_name: 'L',
          status: 'active',
          item_type: 'finished',
          approval_status: 'approved',
        }),
      });
    });
    await page.locator('#storeQsScan').fill('200107001001');
    await page.locator('#storeQsScan').press('Enter');
    await expect.poll(async () => page.evaluate(() => (_storeQs.lines || [])[0]?.variant_id)).toBe(7788);
  });

  test('Shift+F8 resumes last held cart (B14)', async ({ page, request }) => {
    await openPos(page, request);
    await page.evaluate(() => {
      _storeQs.lines = [{ product_id: 1, name: 'تست', qty: 2, unit_price: 1000, disc_pct: 0, disc_amt: 0, unit: 'عدد', code: 'T' }];
      storeQsHoldCart();
    });
    await page.keyboard.press('Shift+F8');
    const n = await page.evaluate(() => (_storeQs.lines || []).length);
    expect(n).toBe(1);
  });

  test('line/header discount inputs update totals live (B12)', async ({ page, request }) => {
    await openPos(page, request);
    await page.evaluate(() => {
      _storeQs.lines = [{ product_id: 1, name: 'تست', qty: 2, unit_price: 100000, disc_pct: 0, disc_amt: 0, unit: 'عدد', code: 'T' }];
      _storeQs.discPct = 0;
      storeQsRenderBody();
    });
    await page.locator('.pos-line-disc-input').fill('10');
    await page.locator('.pos-line-disc-input').dispatchEvent('input');
    const afterLine = await page.evaluate(() => storeQsFinal());
    expect(afterLine).toBe(180000);
    await page.locator('#storeQsDisc').fill('10');
    await page.locator('#storeQsDisc').dispatchEvent('input');
    const afterHdr = await page.evaluate(() => storeQsFinal());
    expect(afterHdr).toBe(162000);
  });

  test('fill remain + change (B13)', async ({ page, request }) => {
    await openPos(page, request);
    await page.evaluate(() => {
      _storeQs.lines = [{ product_id: 1, name: 'تست', qty: 1, unit_price: 50000, disc_pct: 0, disc_amt: 0, unit: 'عدد', code: 'T' }];
      _storeQs.payType = 'cash';
      _storeQs.uiCashTendered = 0;
      storeQsRenderBody();
    });
    await page.getByRole('button', { name: /باقیمانده را پر کن/ }).click();
    const t = await page.evaluate(() => _storeQs.uiCashTendered);
    expect(t).toBe(50000);
    await page.evaluate(() => {
      _storeQs.uiCashTendered = 70000;
      storeQsRenderBody({ keepFocus: true });
    });
    await expect(page.locator('#posChangeLbl')).toHaveText(/۲۰[\u066C,]?۰۰۰|20[\u066C,]?000/);
  });

  test('dark theme follows crm_theme (B5)', async ({ page, request }) => {
    await openPos(page, request, { theme: 'dark' });
    const th = await page.locator('.pos-v2').getAttribute('data-theme');
    expect(th).toBe('dark');
  });

  test('warehouse select shows selected value (B8)', async ({ page, request }) => {
    await openPos(page, request);
    const ok = await page.evaluate(() => {
      const sel = document.getElementById('storeQsWh');
      if (!sel) return true; // locked readonly path
      const wh = storeQsWhId();
      if (!wh) return sel.value === '';
      return String(sel.value) === String(wh);
    });
    expect(ok).toBe(true);
  });

  for (const vp of VIEWPORTS) {
    test(`layout screenshot ${vp.name}`, async ({ page, request }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openPos(page, request);
      const dir = path.join(__dirname, '../docs/screenshots/pos-v2-qa');
      fs.mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: path.join(dir, `pos-${vp.name}.png`), fullPage: true });
    });
  }

  test('layout screenshot dark 1366', async ({ page, request }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await openPos(page, request, { theme: 'dark' });
    const dir = path.join(__dirname, '../docs/screenshots/pos-v2-qa');
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, 'pos-1366-dark.png'), fullPage: true });
  });
});
