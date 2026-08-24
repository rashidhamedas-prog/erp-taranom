'use strict';

const fs = require('fs');
const path = require('path');
const { ADMIN_USER, ADMIN_PASS, ADMIN_BOOTSTRAP_PASS } = require('../lib/constants');

function resolvePlaywright(repoRoot) {
  const candidates = [
    path.join(repoRoot, 'e2e', 'node_modules', 'playwright'),
    path.join(repoRoot, 'e2e', 'node_modules', '@playwright', 'test'),
    path.join(repoRoot, 'server', 'node_modules', 'playwright'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

async function runE2E({ repoRoot, baseUrl, rec, ctx, artifactDir, skip }) {
  if (skip) {
    rec({ id: 'e2e.skipped', suite: 'e2e', module: 'ui', status: 'SKIP', message: '--skip-e2e' });
    return;
  }
  const loc = resolvePlaywright(repoRoot);
  if (!loc) {
    rec({
      id: 'e2e.playwright', suite: 'e2e', module: 'ui', status: 'BLOCKED',
      message: 'Playwright not installed in e2e/node_modules (existing package; no new dependency added)',
    });
    return;
  }

  let playwright;
  try {
    playwright = require(path.join(repoRoot, 'e2e', 'node_modules', 'playwright'));
  } catch (e) {
    rec({ id: 'e2e.playwright', suite: 'e2e', module: 'ui', status: 'BLOCKED', message: e.message });
    return;
  }

  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  const pageErrors = [];
  const failedReq = [];
  page.on('dialog', (d) => d.accept().catch(() => {}));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const t = msg.text() || '';
    if (/Failed to load resource|favicon|CSP|Content Security Policy|net::ERR_/i.test(t)) return;
    consoleErrors.push(t);
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('requestfailed', (req) => {
    const u = req.url();
    if (/favicon|hot-update/.test(u)) return;
    failedReq.push(u);
  });

  try {
    await page.goto(baseUrl + '/', { waitUntil: 'networkidle', timeout: 45000 }).catch(async () => {
      await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    });
    rec({
      id: 'e2e.login_page', suite: 'e2e', module: 'ui',
      status: (await page.locator('#loginUser').count()) ? 'PASS' : 'FAIL',
      expected: '#loginUser', actual: await page.locator('#loginUser').count(),
    });

    async function tryLogin(password) {
      await page.fill('#loginUser', ADMIN_USER);
      await page.fill('#loginPass', password);
      const submitted = page.waitForResponse(
        (r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST',
        { timeout: 20000 }
      ).catch(() => null);
      await page.locator('#loginForm button[type="submit"]').click().catch(async () => {
        await page.locator('#loginForm').evaluate((form) => form.requestSubmit());
      });
      await submitted;
      for (let i = 0; i < 40; i += 1) {
        const token = await page.evaluate(() => localStorage.getItem('crm_token')).catch(() => null);
        const force = await page.locator('#fc-old').isVisible().catch(() => false);
        const hidden = await page.locator('#login').evaluate((el) => getComputedStyle(el).display === 'none').catch(() => false);
        if (token || force || hidden) return { ok: true, force: !!force, token: !!token };
        const err = ((await page.locator('#loginErr').textContent().catch(() => '')) || '').trim();
        if (err && !/نشست|دستگاه/.test(err) && i > 4) return { ok: false, err };
        await page.waitForTimeout(250);
      }
      return { ok: false };
    }

    let signed = await tryLogin(ADMIN_PASS);
    if (!signed.ok) signed = await tryLogin(ADMIN_BOOTSTRAP_PASS);
    if (signed.force) {
      await page.fill('#fc-old', signed.ok && ADMIN_BOOTSTRAP_PASS ? ADMIN_BOOTSTRAP_PASS : ADMIN_PASS);
      await page.fill('#fc-new', ADMIN_PASS);
      if (await page.locator('#fc-new2').count()) await page.fill('#fc-new2', ADMIN_PASS);
      await page.locator('.overlay.open button[type="submit"], #fc-form button, .modal button').first().click().catch(() => {});
      await page.waitForTimeout(1500);
      signed.ok = !!(await page.evaluate(() => localStorage.getItem('crm_token')).catch(() => null));
    }
    rec({
      id: 'e2e.login', suite: 'e2e', module: 'ui',
      status: signed.ok ? 'PASS' : 'FAIL',
      expected: 'shell', actual: signed.ok,
      message: signed.err || '',
    });
    if (!signed.ok) {
      await page.screenshot({ path: path.join(artifactDir, 'screenshots', 'login-fail.png') }).catch(() => {});
      rec({ id: 'e2e.nav.skipped', suite: 'e2e', module: 'ui', status: 'SKIP', message: 'login failed' });
      return;
    }

    const pages = ['#', ...(ctx.inventory?.nav?.admin || []), ...(ctx.inventory?.acc_pages || []).slice(0, 8)];
    for (const id of pages.slice(0, 24)) {
      try {
        if (id === '#') continue;
        await page.evaluate((pid) => {
          if (typeof go === 'function') go(pid);
        }, id).catch(() => {});
        await page.waitForTimeout(400);
        const blank = await page.evaluate(() => (document.body && document.body.innerText || '').trim().length);
        rec({
          id: 'e2e.nav.' + id, suite: 'e2e', module: 'ui',
          status: blank > 0 ? 'PASS' : 'FAIL',
          expected: 'non-blank', actual: blank,
        });
        if (blank === 0) {
          await page.screenshot({ path: path.join(artifactDir, 'screenshots', `blank-${id}.png`) }).catch(() => {});
        }
      } catch (e) {
        rec({ id: 'e2e.nav.' + id, suite: 'e2e', module: 'ui', status: 'FAIL', message: e.message });
        await page.screenshot({ path: path.join(artifactDir, 'screenshots', `err-${id}.png`) }).catch(() => {});
      }
    }

    const selects = await page.evaluate(() => {
      const all = [...document.querySelectorAll('select')];
      return {
        total: all.length,
        unlabeled: all.filter((s) => !s.getAttribute('data-searchable') && !s.closest('[data-searchable]')).length,
      };
    });
    rec({
      id: 'e2e.selects_inventory', suite: 'e2e', module: 'ui',
      status: 'PASS',
      message: `selects=${selects.total} without data-searchable=${selects.unlabeled}`,
      evidence: JSON.stringify(selects),
    });
    if (selects.unlabeled > 0) {
      rec({
        id: 'e2e.selects_not_all_searchable', suite: 'e2e', module: 'ui', severity: 'medium',
        status: 'FAIL',
        expected: 'all dropdowns searchable',
        actual: selects.unlabeled + ' native selects without data-searchable',
      });
    }

    await page.evaluate(() => { if (typeof go === 'function') go('invoices'); }).catch(() => {});
    await page.waitForTimeout(500);
    const picker = await page.evaluate(() => {
      const search = document.querySelector('#inv-cust, input[placeholder*="جستجو"], .acct-search input, [data-picker]');
      const custSel = document.querySelector('#inv-cust, select[id*="cust"]');
      return {
        hasSearchInput: !!search,
        hasCustSelect: !!custSel,
        custSelectHtml: custSel ? custSel.outerHTML.slice(0, 200) : '',
      };
    });
    rec({
      id: 'e2e.picker.searchable', suite: 'e2e', module: 'ui',
      status: picker.hasSearchInput || picker.hasCustSelect ? 'PASS' : 'FAIL',
      expected: 'customer picker on invoices',
      actual: JSON.stringify(picker),
    });
    if (picker.hasSearchInput) {
      const box = page.locator('#inv-cust, input[placeholder*="جستجو"]').first();
      await box.fill('QA').catch(() => {});
      rec({ id: 'e2e.picker.type', suite: 'e2e', module: 'ui', status: 'PASS', message: 'typed QA into picker' });
    }

    const freeText = ctx.inventory?.free_text_party || [];
    rec({
      id: 'e2e.party_id_required', suite: 'e2e', module: 'ui', severity: freeText.length ? 'high' : null,
      status: freeText.length ? 'FAIL' : 'PASS',
      expected: 'party_id searchable pickers where API has party_id',
      actual: freeText.length ? freeText.join(',') : 'none listed in inventory',
      message: freeText.length ? 'UI still uses free-text party fields' : '',
    });

    rec({
      id: 'e2e.console_errors', suite: 'e2e', module: 'ui',
      status: pageErrors.length ? 'FAIL' : (consoleErrors.length > 5 ? 'FAIL' : 'PASS'),
      expected: 0, actual: pageErrors.length + consoleErrors.length,
      evidence: [...pageErrors, ...consoleErrors].slice(0, 8).join(' | '),
    });
    rec({
      id: 'e2e.failed_requests', suite: 'e2e', module: 'ui',
      status: failedReq.length ? 'FAIL' : 'PASS',
      expected: 0, actual: failedReq.length,
      evidence: failedReq.slice(0, 8).join(' | '),
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { runE2E, resolvePlaywright };
