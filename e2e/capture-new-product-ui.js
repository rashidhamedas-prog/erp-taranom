'use strict';
/**
 * Capture before/after screenshots of «کالای جدید» modal + optional FormData snapshot.
 * Usage:
 *   node capture-new-product-ui.js --tag before
 *   node capture-new-product-ui.js --tag after
 *   node capture-new-product-ui.js --tag after --validation
 *   node capture-new-product-ui.js --snapshot-only
 */
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const PORT = Number(process.env.E2E_PORT || 3107);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(os.tmpdir(), `erp-newprod-cap-${Date.now()}`);
const OUT_DIR = path.join(__dirname, '..', 'docs', 'screenshots', 'new-product');
const SNAP_PATH = path.join(__dirname, 'fixtures', 'new-product-formdata.snapshot.json');

const argv = process.argv.slice(2);
const tag = (() => {
  const i = argv.indexOf('--tag');
  return i >= 0 ? argv[i + 1] : 'before';
})();
const wantValidation = argv.includes('--validation');
const snapshotOnly = argv.includes('--snapshot-only');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(path.dirname(SNAP_PATH), { recursive: true });
fs.mkdirSync(ROOT, { recursive: true });

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
      env: {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        PORT: String(PORT),
        LISTEN_HOST: '127.0.0.1',
        SYNC_ROLE: 'central',
        NODE_ENV: 'test',
        JWT_SECRET: 'e2e-playwright-jwt-secret-32chars!!',
        DB_PATH: path.join(ROOT, 'crm.db'),
        COMPANIES_DIR: path.join(ROOT, 'companies'),
        ALLOWED_ORIGINS: BASE,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const onData = (d) => {
      buf += String(d);
      if (/listening|ERP|server/i.test(buf) || buf.length > 200) {
        /* health poll below */
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const t0 = Date.now();
    const poll = async () => {
      try {
        const r = await fetch(`${BASE}/api/system/health`);
        if (r.ok) return resolve(child);
      } catch (_) {}
      if (Date.now() - t0 > 90000) {
        child.kill('SIGTERM');
        return reject(new Error('server start timeout\n' + buf.slice(-2000)));
      }
      setTimeout(poll, 250);
    };
    setTimeout(poll, 400);
  });
}

async function apiLogin(requestContext) {
  const passwords = ['admin123', 'E2eAdmin#Wave01405'];
  for (const password of passwords) {
    const login = await requestContext.post(BASE + '/api/auth/login', {
      data: { username: 'admin', password, force_logout_other: true },
    });
    const body = await login.json().catch(() => ({}));
    if (body.must_change_password && body.token) {
      const ch = await requestContext.post(BASE + '/api/auth/change-password', {
        headers: { Authorization: `Bearer ${body.token}` },
        data: { oldPass: password, newPass: 'E2eAdmin#Wave01405' },
      });
      if (!ch.ok()) throw new Error('change-password failed');
      const again = await requestContext.post(BASE + '/api/auth/login', {
        data: { username: 'admin', password: 'E2eAdmin#Wave01405', force_logout_other: true },
      });
      const againBody = await again.json();
      if (!againBody.token) throw new Error('relogin after change-password failed');
      return { token: againBody.token, pass: 'E2eAdmin#Wave01405' };
    }
    if (body.token) return { token: body.token, pass: password };
  }
  throw new Error('api login failed');
}

async function login(page, browser) {
  const ctx = await browser.newContext();
  const { pass } = await apiLogin(ctx.request);
  await ctx.close();
  await page.goto(BASE + '/');
  await page.fill('#loginUser', 'admin');
  await page.fill('#loginPass', pass);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST', { timeout: 20000 }).catch(() => null),
    page.locator('#loginForm').evaluate((form) => form.requestSubmit()),
  ]);
  for (let i = 0; i < 80; i += 1) {
    const force = await page.locator('#fc-old').isVisible().catch(() => false);
    if (force) {
      // Should be rare after apiLogin; complete UI change if shown
      await page.fill('#fc-old', pass);
      await page.fill('#fc-new', 'E2eAdmin#Wave01405');
      const conf = page.locator('#fc-new2, #fc-confirm');
      if (await conf.count()) await conf.first().fill('E2eAdmin#Wave01405');
      await page.evaluate(() => {
        if (typeof submitForcePass === 'function') return submitForcePass();
      }).catch(() => {});
      await page.waitForTimeout(500);
    }
    const loginHidden = await page.locator('#login').evaluate((el) => getComputedStyle(el).display === 'none').catch(() => false);
    const appReady = await page.evaluate(() => typeof prodModal === 'function' && !!window.ME && !!window.ME.role).catch(() => false);
    const stillForce = await page.locator('#fc-old').isVisible().catch(() => false);
    if (loginHidden && appReady && !stillForce) return pass;
    await page.waitForTimeout(250);
  }
  throw new Error('login/shell failed');
}

async function openNewProductModal(page) {
  await page.evaluate(async () => {
    if (typeof go === 'function') {
      try { await go('acc-products'); } catch (_) {}
    }
    if (typeof accNewProduct === 'function') await accNewProduct();
    else if (typeof prodModal === 'function') await prodModal(0);
  });
  await page.waitForSelector('#p-name', { timeout: 20000 });
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

async function fillFixedProduct(page) {
  await fillField(page, '#p-name', 'کالای تست بازطراحی UI');
  await fillField(page, '#p-code', 'K-UI-TEST-001');
  await fillField(page, '#p-barcode', '2000000000014');
  await fillField(page, '#p-price', '100000');
  await fillField(page, '#p-retail', '150000');
  await fillField(page, '#p-cost', '80000');
  await fillField(page, '#p-stock', '10');
  await fillField(page, '#p-alert', '2');
  await fillField(page, '#p-colors', '2');
  await fillField(page, '#p-pack_size', '6');
  await fillField(page, '#p-note', 'یادداشت تست فرم کالای جدید');
  await fillField(page, '#p-cat', 'دسته تست');
}

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
    if (/filename=/i.test(headers)) {
      entries.push({ key: name, value: '__FILE__', file: true });
    } else {
      entries.push({ key: name, value: Buffer.from(bodyBin, 'binary').toString('utf8') });
    }
  }
  return entries;
}

async function captureFormData(page) {
  let captured = null;
  await page.route('**/api/products', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      const headers = req.headers();
      const buf = req.postDataBuffer();
      captured = serializeMultipart(buf, headers['content-type'] || '');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 999001, name: 'ok', production_readiness: { hard: [], soft: [] } }),
      });
      return;
    }
    await route.continue();
  });
  await page.evaluate(() => {
    if (typeof saveProduct === 'function') return saveProduct(0);
  });
  for (let i = 0; i < 40 && !captured; i += 1) await page.waitForTimeout(100);
  await page.unroute('**/api/products');
  if (!captured) throw new Error('FormData not captured');
  return captured;
}

(async () => {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'fa-IR' });
    const page = await context.newPage();
    page.on('dialog', (d) => d.accept());
    await login(page, browser);
    await openNewProductModal(page);

    if (snapshotOnly || tag === 'before') {
      await fillFixedProduct(page);
      const entries = await captureFormData(page);
      const snap = {
        generatedAt: new Date().toISOString(),
        source: 'original-prodModal-before-ui-redesign',
        fill: {
          name: 'کالای تست بازطراحی UI',
          code: 'K-UI-TEST-001',
          barcode: '2000000000014',
          price: '100000',
          retail: '150000',
          cost: '80000',
          stock: '10',
          stock_alert: '2',
          colors: '2',
          pack_size: '6',
          note: 'یادداشت تست فرم کالای جدید',
          category: 'دسته تست',
        },
        entries,
      };
      fs.writeFileSync(SNAP_PATH, JSON.stringify(snap, null, 2), 'utf8');
      console.log('wrote snapshot', SNAP_PATH, 'entries=', entries.length);
      // reopen for screenshots if needed
      await openNewProductModal(page);
      await fillFixedProduct(page);
    } else {
      await fillFixedProduct(page);
    }

    if (!snapshotOnly) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(400);
      const desk = path.join(OUT_DIR, `${tag}-desktop.png`);
      await page.locator('#activeModal').screenshot({ path: desk });
      console.log('shot', desk);

      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(400);
      const mob = path.join(OUT_DIR, `${tag}-mobile.png`);
      await page.locator('#activeModal').screenshot({ path: mob });
      console.log('shot', mob);

      if (wantValidation || tag === 'after') {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.fill('#p-name', '');
        await page.evaluate(() => {
          const inp = document.getElementById('p-name');
          if (inp) {
            inp.dispatchEvent(new Event('blur', { bubbles: true }));
            inp.focus();
          }
          if (typeof prodFormV2ValidateAll === 'function') prodFormV2ValidateAll({ focusSummary: true });
          else if (typeof saveProduct === 'function') saveProduct(0);
        });
        await page.waitForTimeout(500);
        const errShot = path.join(OUT_DIR, 'after-validation-error.png');
        await page.locator('#activeModal').screenshot({ path: errShot });
        console.log('shot', errShot);
      }
    }
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
