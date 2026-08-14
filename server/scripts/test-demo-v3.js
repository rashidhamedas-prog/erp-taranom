#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { scanDemoStatic } = require('./test-demo-static');

const PUBLIC = path.join(__dirname, '..', 'public');
const results = [];
let failed = 0;

function rec(id, ok, detail) {
  results.push({ id, ok, detail });
  if (!ok) {
    failed += 1;
    console.error('FAIL ' + id + ': ' + detail);
  } else {
    console.log('PASS ' + id + (detail ? ' — ' + detail : ''));
  }
}

function loadBrowser(files) {
  const ls = new Map();
  const localStorage = {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => { ls.set(String(k), String(v)); },
    removeItem: (k) => { ls.delete(k); },
    key: (i) => Array.from(ls.keys())[i],
    get length() { return ls.size; }
  };
  const sandbox = {
    console,
    localStorage,
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      readyState: 'complete'
    },
    matchMedia: () => ({ matches: false }),
    URL,
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    Set,
    JSON,
    parseInt,
    isNaN,
    setTimeout: () => 0,
    requestAnimationFrame: (fn) => fn(),
    addEventListener: () => {},
    module: { exports: {} },
    exports: {}
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  files.forEach((name) => {
    vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, name), 'utf8'), sandbox, { filename: name });
  });
  sandbox.__ls = ls;
  return sandbox;
}

function noNetwork(text) {
  return !/\bfetch\s*\(/.test(text) && !/XMLHttpRequest/.test(text) && !/new\s+WebSocket/.test(text);
}

(function run() {
  const staticScan = scanDemoStatic(PUBLIC);
  rec('static-scan', staticScan.ok, staticScan.ok ? 'ok' : staticScan.fails.join('; '));

  const seedFile = fs.readFileSync(path.join(PUBLIC, 'demo-v3-seed.js'), 'utf8');
  const storeFile = fs.readFileSync(path.join(PUBLIC, 'demo-v3-store.js'), 'utf8');
  const tourFile = fs.readFileSync(path.join(PUBLIC, 'demo-v3-tour.js'), 'utf8');
  const appFile = fs.readFileSync(path.join(PUBLIC, 'demo-v3-app.js'), 'utf8');
  const bootFile = fs.readFileSync(path.join(PUBLIC, 'demo.js'), 'utf8');
  const html = fs.readFileSync(path.join(PUBLIC, 'demo.html'), 'utf8');
  const css = fs.readFileSync(path.join(PUBLIC, 'demo.css'), 'utf8');
  const all = [seedFile, storeFile, tourFile, appFile, bootFile, html, css].join('\n');

  rec('no-network', noNetwork(all), 'no fetch/xhr/ws');
  rec('no-secrets', !/admin123|demo1234|laptop-demo-secret|JWT_SECRET|sk_live/.test(all), 'no hardcoded secrets');
  rec('no-negative-toast', !/ذخیره روی سرور انجام نمی‌شود/.test(all), 'old toast gone');
  rec('positive-toast', /در محیط نمایشی ثبت شد/.test(all), 'positive toast present');
  rec('no-orange-bar', !/padding-top:\s*32px/.test(css) && !/#92400e/.test(css), 'orange bar removed');
  rec('logo-sizes', /height:110px/.test(css) && /height:44px/.test(css), '110/44');
  rec('welcome-copy', /از اولین تماس با مشتری تا تولید/.test(html), 'hero title');
  rec('four-roles', ['manager', 'sales', 'accounting', 'warehouse', 'free'].every((r) => html.includes('data-start="' + r + '"')), 'role starts');
  rec('maker', /ترانه اندیشه پردازان ریان/.test(html), 'maker');
  rec('cta-config', /DEMO_V3_CTA/.test(html) && /consultUrl:\s*''/.test(html), 'empty CTA');
  rec('no-emoji-nav-contract', !/icon:'📊'/.test(appFile), 'no emoji nav in app');

  const ctx = loadBrowser(['demo-v3-seed.js', 'demo-v3-store.js', 'demo-v3-tour.js']);
  const data = ctx.DemoV3Seed.createSeed();
  const v1 = ctx.DemoV3Seed.validateSeed(data);
  rec('seed-validate', v1.ok, v1.ok ? 'graph ok' : v1.fails.join('; '));
  const data2 = ctx.DemoV3Seed.createSeed();
  rec('seed-deterministic', JSON.stringify(data.customers[0]) === JSON.stringify(data2.customers[0]), 'same first customer');
  rec('seed-minima', data.customers.length >= 50 && data.opportunities.length >= 40 && data.activities.length >= 100 && data.invoices.length >= 100, 'counts');
  rec('seed-no-password', data.users.every((u) => !u.password), 'users have no password');
  rec('journals-balanced', data.journals.every((j) => j.debit === j.credit), 'each JE');

  const state = ctx.DemoV3Store.freshState();
  ctx.DemoV3Store.saveState(state);
  rec('store-roundtrip', ctx.DemoV3Store.loadState().meta.company === 'پوشاک نمونه سپیدارگل', 'load/save');
  ctx.__ls.set('unrelated-key', 'keep');
  ctx.DemoV3Store.resetDemo();
  rec('reset-allowlist', !ctx.__ls.has('erp.taranom.demo.v3.1.state') && ctx.__ls.has('unrelated-key'), 'only v3 keys removed');
  rec('reset-no-wildcard', !/Object\.keys\(\s*localStorage/.test(storeFile) && !/for\s*\(.*in\s*localStorage/.test(storeFile), 'no key scan');

  rec('tour-sales-13', ctx.DemoV3Tour.TOURS.sales.length === 13, String(ctx.DemoV3Tour.TOURS.sales.length));
  rec('tour-manager', ctx.DemoV3Tour.TOURS.manager.length >= 8, String(ctx.DemoV3Tour.TOURS.manager.length));
  rec('tour-accounting', ctx.DemoV3Tour.TOURS.accounting.length >= 10, String(ctx.DemoV3Tour.TOURS.accounting.length));
  rec('tour-warehouse', ctx.DemoV3Tour.TOURS.warehouse.length >= 10, String(ctx.DemoV3Tour.TOURS.warehouse.length));

  rec('escape-helper', /function esc\(/.test(appFile), 'esc exists');
  rec('innerhtml-user', !/innerHTML\s*=\s*[a-zA-Z_][a-zA-Z0-9_]*\.value/.test(appFile), 'no raw value innerHTML');
  rec('https-cta', /protocol !== 'https:'/.test(bootFile) || /protocol === 'https:'/.test(bootFile), 'cta https only');
  rec('acc-shell-ids', /enterAccountingShell/.test(bootFile) && /renderAccPage/.test(bootFile) && /ACC_NAV_SECTIONS/.test(bootFile), 'acc identifiers');
  rec('namespace', /erp\.taranom\.demo\.v3\.1/.test(storeFile), 'ns');

  ['demo.js', 'demo-v3-seed.js', 'demo-v3-store.js', 'demo-v3-tour.js', 'demo-v3-app.js'].forEach((name) => {
    try {
      execFileSync(process.execPath, ['--check', path.join(PUBLIC, name)], { stdio: 'pipe' });
      rec('syntax-' + name, true, 'ok');
    } catch (e) {
      rec('syntax-' + name, false, e.stderr ? String(e.stderr) : String(e));
    }
  });

  console.log('\nDemo V3: ' + (failed ? failed + ' failed' : results.length + ' passed'));
  process.exit(failed ? 1 : 0);
})();
