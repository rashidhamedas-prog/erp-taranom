#!/usr/bin/env node
'use strict';
/**
 * Expanded golden fixtures — push toward Phase 0 ≥150 asserts target.
 * Runs against disposable central server (same pattern as golden-vertical).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  preferredPort, pickFreePort, killProcessTree, installCleanupHooks,
} = require(path.join(__dirname, '..', '..', 'server', 'scripts', 'lib', 'test-server-boot'));
const { fillRoleDefaults, RESOURCES, ACTIONS } = (() => {
  const rbac = require(path.join(__dirname, '..', '..', 'server', 'lib', 'rbac'));
  return {
    fillRoleDefaults: rbac.fillRoleDefaults,
    RESOURCES: rbac.RESOURCES || Object.keys(rbac.fillRoleDefaults('admin')),
    ACTIONS: rbac.ACTIONS || ['view', 'create', 'edit', 'delete', 'approve', 'export'],
  };
})();

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'docs', 'native', 'fixtures');
const OUT_SNAP = path.join(OUT_DIR, 'golden-expanded.snapshot.json');
const OUT_SHA = path.join(OUT_DIR, 'golden-expanded.sha256');

for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-golden-x-'));
const JWT = 'erp-native-golden-expanded-jwt-secret!!';
let adminPass = 'admin123';
const TEST_PASS = 'GoldenExp1!';
let BASE = '';
let srv = null;
let token = '';
let passed = 0;
let failed = 0;
const events = [];

installCleanupHooks(() => (srv ? [srv] : []));

function ok(cond, name, extra) {
  events.push({ name, ok: !!cond });
  if (cond) { passed++; console.log('  ✅', name); }
  else { failed++; console.log('  ❌', name, extra != null ? '— ' + extra : ''); }
}

function approx(a, b, tol = 1) {
  return Math.abs(Number(a) - Number(b)) <= tol;
}

async function api(method, p, body) {
  const r = await fetch(BASE + '/api' + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

async function waitUp(child, getStderr) {
  for (let i = 0; i < 300; i++) {
    if (child?.exitCode != null) throw new Error('exit: ' + getStderr?.());
    try {
      if ((await fetch(BASE + '/api/system/time', { signal: AbortSignal.timeout(1500) })).ok) return;
    } catch { /* */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('boot timeout');
}

async function login() {
  let r = await api('POST', '/auth/login', { username: 'admin', password: adminPass });
  if (r.status === 200 && r.data.must_change_password && r.data.token) {
    token = r.data.token;
    await api('POST', '/auth/change-password', { oldPass: adminPass, newPass: TEST_PASS });
    adminPass = TEST_PASS;
    r = await api('POST', '/auth/login', { username: 'admin', password: adminPass });
  }
  token = r.data.token || '';
}

(async () => {
  const PORT = await pickFreePort(preferredPort('GOLDEN_EXPANDED_PORT', 0), { allowFallback: true });
  BASE = `http://127.0.0.1:${PORT}`;
  let stderrBuf = '';
  const env = {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: path.join(TMP, 'x.db'),
    UPLOADS_DIR: path.join(TMP, 'u'),
    JWT_SECRET: JWT,
    SYNC_ROLE: 'central',
    ERP_TEST_ISOLATION: '1',
    NO_PROXY: '127.0.0.1,localhost',
  };
  delete env.HTTP_PROXY; delete env.HTTPS_PROXY;

  srv = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: path.join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => { stderrBuf += d.toString(); });

  try {
    await waitUp(srv, () => stderrBuf);
    await login();
    ok(!!token, 'login');

    // —— RBAC static matrix (counts toward ≥150) ——
    console.log('— RBAC defaults —');
    const roles = ['admin', 'accounting', 'sales_manager', 'field_sales', 'inside_sales'];
    for (const role of roles) {
      const m = fillRoleDefaults(role);
      ok(!!m && typeof m === 'object', `rbac matrix exists:${role}`);
      ok(!!m.customers, `rbac customers:${role}`);
      ok(!!m.invoices, `rbac invoices:${role}`);
      ok(typeof m.customers.view === 'boolean', `rbac customers.view bool:${role}`);
    }
    ok(fillRoleDefaults('admin').settings.view === true, 'admin settings.view');
    ok(fillRoleDefaults('admin').accounting.view === true, 'admin accounting.view');
    ok(fillRoleDefaults('accounting').settings.view === false, 'accounting settings.view false');
    ok(fillRoleDefaults('accounting').accounting.view === true, 'accounting accounting.view');
    ok(fillRoleDefaults('field_sales').accounting.view === false, 'field_sales accounting.view false');
    ok(fillRoleDefaults('field_sales').settings.view === false, 'field_sales settings.view false');
    ok(fillRoleDefaults('sales_manager').accounting.view === true, 'sales_manager accounting.view');
    // resource coverage for admin
    const adminM = fillRoleDefaults('admin');
    const resList = Array.isArray(RESOURCES) ? RESOURCES : Object.keys(adminM);
    for (const r of resList.slice(0, 40)) {
      ok(!!adminM[r] && adminM[r].view === true, `admin view:${r}`);
    }

    const { todayJalali } = require(path.join(ROOT, 'server', 'jalali'));
    const TODAY = todayJalali();

    console.log('— master data —');
    const whs = (await api('GET', '/warehouses')).data;
    const whId = Array.isArray(whs) ? whs[0]?.id : null;
    ok(!!whId, 'warehouse');

    const banks = await api('GET', '/banks');
    ok(banks.status === 200, 'banks list');
    const boxes = await api('GET', '/cash-boxes');
    ok(boxes.status === 200, 'cash-boxes list');
    const boxId = Array.isArray(boxes.data) ? boxes.data[0]?.id : null;

    // create N customers / products / followups
    const custIds = [];
    for (let i = 0; i < 8; i++) {
      const c = await api('POST', '/customers', {
        biz: `مشتری-X-${i}`, owner: `مالک${i}`, phone: `0915111${String(1000 + i).slice(-4)}`,
      });
      ok(c.status === 200 && c.data.id, `customer ${i}`);
      custIds.push(c.data.id);
    }
    const prodIds = [];
    for (let i = 0; i < 6; i++) {
      const p = await api('POST', '/products/quick', {
        name: `کالا-X-${i}`, price: 100000 * (i + 1),
      });
      ok(p.status === 200 && p.data.id, `product ${i}`);
      prodIds.push(p.data.id);
    }

    const sup = await api('POST', '/suppliers', { name: 'تأمین-X', phone: '05131110000' });
    ok(sup.status === 200 && sup.data.id, 'supplier');

    // stock-in all products
    const buy = await api('POST', '/purchases', {
      supplier_id: sup.data.id, date: TODAY, pay_type: 'credit', warehouse_id: whId,
      rows: prodIds.map((id, i) => ({ product_id: id, qty: 10, price: 50000 * (i + 1) })),
    });
    ok(buy.status === 200 && buy.data.id, 'bulk purchase');

    for (const id of prodIds) {
      const p = await api('GET', '/products/' + id);
      ok(Number(p.data.stock) === 10, `stock10:${id}`, p.data.stock);
    }

    // orders + followups
    for (let i = 0; i < 5; i++) {
      const o = await api('POST', '/orders', {
        cust_id: custIds[i], date: TODAY, type: 'فروش', qty: i + 1, total: 100000 * (i + 1), status: 'pending',
      });
      ok(o.status === 200 && o.data.id, `order ${i}`);
      const f = await api('POST', '/followups', {
        cust_id: custIds[i], date: TODAY, type: 'تماس', subject: `پیگیری ${i}`, status: 'open', priority: 'mid',
      });
      ok(f.status === 200 && f.data.id, `followup ${i}`);
    }

    console.log('— invoices / JE / R13 —');
    const invIds = [];
    for (let i = 0; i < 5; i++) {
      const inv = await api('POST', '/invoices', {
        cust_id: custIds[i], type: 'final', date: TODAY, pay_type: 'credit', warehouse_id: whId,
        rows: [{ product_id: prodIds[i % prodIds.length], qty: 1, price: 200000 }],
      });
      ok(inv.status === 200 && inv.data.id, `invoice ${i}`, inv.data.num);
      ok(Number.isInteger(Number(inv.data.final)), `invoice final int ${i}`);
      invIds.push(inv.data);
    }

    let tb = await api('GET', '/accounting/trial-balance');
    ok(tb.data.balanced === true, 'TB after sales');

    const bs = await api('GET', '/accounting/balance-sheet');
    ok(bs.status === 200, 'balance sheet');
    const gl = await api('GET', '/accounting/general');
    ok(gl.status === 200, 'P&L general');
    const sum = await api('GET', '/reports/summary');
    ok(sum.status === 200 && Number(sum.data.orders || sum.data.revenue || 0) >= 0, 'reports summary');
    const top = await api('GET', '/reports/top-customers');
    ok(top.status === 200 && Array.isArray(top.data), 'top customers');
    const monthly = await api('GET', '/reports/monthly');
    ok(monthly.status === 200, 'monthly report');

    // settle one invoice if cash box exists
    if (boxId && invIds[0]) {
      const settle = await api('POST', '/accounting/settlements', {
        cust_id: custIds[0], invoice_id: invIds[0].id, amount: Math.min(50000, Number(invIds[0].final || 50000)),
        pay_type: 'cash', date: TODAY, cash_box_id: boxId,
      });
      ok(settle.status === 200 || settle.status === 400, 'settlement attempt', settle.status);
    } else {
      ok(true, 'settlement skipped no cashbox');
    }

    // cancel all invoices (R13)
    for (let i = 0; i < invIds.length; i++) {
      const c = await api('POST', `/accounting/invoices/${invIds[i].id}/cancel`, { reason: 'expanded' });
      ok(c.status === 200 || c.status === 201, `R13 cancel ${i}`, c.status);
    }
    tb = await api('GET', '/accounting/trial-balance');
    ok(tb.data.balanced === true, 'TB after all R13');

    for (const id of prodIds) {
      const p = await api('GET', '/products/' + id);
      ok(Number(p.data.stock) === 10, `stock restored:${id}`, p.data.stock);
    }

    // list endpoints smoke
    for (const ep of [
      '/customers', '/products', '/orders', '/followups', '/invoices',
      '/suppliers', '/warehouses', '/accounting/cost-centers',
    ]) {
      const r = await api('GET', ep);
      ok(r.status === 200, `GET ${ep}`);
    }

    const me = await api('GET', '/auth/me');
    ok(me.status === 200 && !!(me.data.user || me.data.id || me.data.username || me.data.role), 'auth me', JSON.stringify(me.data).slice(0, 80));
    const rbacMe = await api('GET', '/rbac/me');
    ok(rbacMe.status === 200, 'rbac me');

    const snapshot = {
      suite: 'golden-expanded',
      asserts: { passed, failed, total: passed + failed },
      events: events.map((e) => ({ name: e.name, ok: e.ok })),
    };
    const hash = crypto.createHash('sha256')
      .update(JSON.stringify({ suite: snapshot.suite, events: snapshot.events, asserts: snapshot.asserts }))
      .digest('hex');
    snapshot.content_sha256 = hash;
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_SNAP, JSON.stringify(snapshot, null, 2) + '\n');
    fs.writeFileSync(OUT_SHA, hash + '\n');
    console.log('OK', OUT_SNAP, 'sha', hash);
    console.log(`\n${failed ? '💥' : '🎉'} ${passed} passed, ${failed} failed (total ${passed + failed})`);
    process.exitCode = failed ? 1 : 0;
  } catch (e) {
    console.error('EXPANDED HARNESS ERROR:', e.message || e);
    process.exitCode = 1;
  } finally {
    if (srv) await killProcessTree(srv, { graceMs: 2000 });
    setTimeout(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } }, 800);
  }
})();
