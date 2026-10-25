'use strict';
/**
 * Snapshot: store quick-sale / exchange payload builders must stay byte-stable
 * after POS v2 UI redesign (storeQsSaleRows + storeQsBuildPaySplits unchanged).
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const SNAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'store-quick-payload.snapshot.json'), 'utf8')
);

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
        .evaluate(() => typeof storeQsCheckout === 'function' && !!window.ME)
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
  await page.waitForSelector('.pos-v2 #storeQsScan', { timeout: 30000 });
}

test('POS payload builders match snapshot shapes (walkin cash / card+disc / mixed)', async ({
  page,
  request,
}) => {
  await openPos(page, request);

  const result = await page.evaluate(() => {
    const boot = _storeQs.boot || {};
    const walkin = Number(boot.walkin_customer_id || 0);
    const cashId = Number(_storeQs.cashBoxId || boot.cash_box_id || 0);
    const termId = Number(_storeQs.terminalId || 0) || 1;
    _storeQs.lines = [
      {
        product_id: 9001,
        name: 'تست مانتو',
        code: 'T-POS',
        unit: 'عدد',
        qty: 2,
        unit_price: 1000000,
        disc_pct: 0,
        disc_amt: 0,
        variant_id: null,
        color_id: null,
        size_id: null,
        color_name: '',
        size_name: '',
        warehouse_id: storeQsWhId(),
      },
    ];
    _storeQs.custId = walkin;
    _storeQs.discPct = 0;
    _storeQs.payType = 'cash';
    _storeQs.cashBoxId = cashId;
    const rows1 = storeQsSaleRows();
    const final1 = storeQsFinal();
    const split1 = storeQsBuildPaySplits(final1);

    _storeQs.discPct = 10;
    _storeQs.payType = 'pos_card';
    _storeQs.terminalId = termId;
    _storeQs.custId = walkin || 1;
    const rows2 = storeQsSaleRows();
    const final2 = storeQsFinal();
    const split2 = storeQsBuildPaySplits(final2);

    _storeQs.discPct = 0;
    _storeQs.payType = 'mixed';
    const final3 = storeQsFinal();
    const split3 = storeQsBuildPaySplits(final3);

    return {
      rowKeys: Object.keys(rows1[0] || {}),
      walkin: {
        payType: split1 && split1.payType,
        splits: split1 && split1.pay_splits,
        final: final1,
        disc: 0,
      },
      card: {
        payType: split2 && split2.payType,
        splits: split2 && split2.pay_splits,
        final: final2,
        disc: 10,
        rowDisc: rows2[0].disc_pct,
      },
      mixed: {
        payType: split3 && split3.payType,
        splits: split3 && split3.pay_splits,
        final: final3,
        half: Math.floor(final3 / 2),
        rest: final3 - Math.floor(final3 / 2),
      },
      gateNoCash: (function () {
        const prev = _storeQs.cashBoxId;
        _storeQs.payType = 'cash';
        _storeQs.cashBoxId = null;
        const r = storeQsCheckoutGateReason();
        _storeQs.cashBoxId = prev;
        return r;
      })(),
    };
  });

  expect(result.rowKeys).toEqual(SNAP.walkin_cash.rows_shape);
  expect(result.walkin.payType).toBe('cash');
  expect(result.walkin.splits).toEqual([
    { pay_type: 'cash', amount: result.walkin.final, cash_box_id: expect.any(Number) },
  ]);
  expect(result.card.payType).toBe('pos_card');
  expect(result.card.disc).toBe(10);
  expect(result.card.splits[0].pay_type).toBe('pos_card');
  expect(result.card.splits[0].amount).toBe(result.card.final);
  expect(result.mixed.payType).toBe('mixed');
  expect(result.mixed.splits).toEqual([
    { pay_type: 'cash', amount: result.mixed.half, cash_box_id: expect.any(Number) },
    { pay_type: 'pos_card', amount: result.mixed.rest, terminal_id: expect.any(Number) },
  ]);
  expect(result.gateNoCash).toMatch(/صندوق/);
});

test('POS validation: empty cart blocks checkout reason', async ({ page, request }) => {
  await openPos(page, request);
  const reason = await page.evaluate(() => {
    _storeQs.lines = [];
    _storeQs.mode = 'sale';
    return storeQsCheckoutGateReason();
  });
  expect(reason).toMatch(/سبد|خالی|F2/);
});
