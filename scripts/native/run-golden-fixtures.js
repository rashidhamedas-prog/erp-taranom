#!/usr/bin/env node
'use strict';
/**
 * Golden fixture harness — Phase 0 vertical slice (Node reference).
 * Customer → product stock-in → invoice → JE/stock asserts → R13 cancel → restore.
 *
 * Usage (Node 20 / MODULE_VERSION 115):
 *   node scripts/native/run-golden-fixtures.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  preferredPort, pickFreePort, killProcessTree, installCleanupHooks,
} = require(path.join(__dirname, '..', '..', 'server', 'scripts', 'lib', 'test-server-boot'));

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'docs', 'native', 'fixtures');
const OUT_SNAP = path.join(OUT_DIR, 'golden-vertical.snapshot.json');
const OUT_SHA = path.join(OUT_DIR, 'golden-vertical.sha256');

for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}
process.env.NO_PROXY = '127.0.0.1,localhost';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-golden-'));
const JWT = 'erp-native-golden-fixture-jwt-secret-32!!';
let adminPass = 'admin123';
const TEST_PASS = 'GoldenFix1!';
let BASE = '';
let srv = null;
let token = '';

installCleanupHooks(() => (srv ? [srv] : []));

let passed = 0;
let failed = 0;
const events = [];

function ok(cond, name, extra) {
  const row = { name, ok: !!cond, extra: extra == null ? null : String(extra) };
  events.push(row);
  if (cond) {
    passed++;
    console.log('  ✅', name);
  } else {
    failed++;
    console.log('  ❌', name + (extra != null ? ' — ' + extra : ''));
  }
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
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

async function waitUp(child, getStderr) {
  for (let i = 0; i < 300; i++) {
    if (child && child.exitCode != null) {
      throw new Error('server exited early: ' + String(getStderr?.() || '').slice(-1200));
    }
    try {
      const r = await fetch(BASE + '/api/system/time', { signal: AbortSignal.timeout(1500) });
      if (r.ok) return;
    } catch { /* */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('server boot timeout: ' + String(getStderr?.() || '').slice(-1200));
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
  return r;
}

(async () => {
  const preferred = preferredPort('GOLDEN_FIXTURE_PORT', 0);
  const PORT = await pickFreePort(preferred, { allowFallback: true });
  BASE = `http://127.0.0.1:${PORT}`;
  console.log(`[golden] PORT=${PORT} DB=${TMP}`);

  let stderrBuf = '';
  const env = {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: path.join(TMP, 'golden.db'),
    UPLOADS_DIR: path.join(TMP, 'uploads'),
    JWT_SECRET: JWT,
    SYNC_ROLE: 'central',
    ERP_TEST_ISOLATION: '1',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;

  srv = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: path.join(ROOT, 'server'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => { stderrBuf += d.toString(); });

  try {
    await waitUp(srv, () => stderrBuf);
    const log = await login();
    ok(!!token, 'admin login', log.status);

    const { todayJalali } = require(path.join(ROOT, 'server', 'jalali'));
    const TODAY = todayJalali();

    console.log('— seed —');
    const whs = (await api('GET', '/warehouses')).data;
    const whId = Array.isArray(whs) ? whs[0]?.id : whs?.rows?.[0]?.id;
    ok(!!whId, 'default warehouse', whId);

    const prod = (await api('POST', '/products/quick', {
      name: 'کالای fixture طلایی', price: 1000000,
    })).data;
    ok(!!prod.id, 'product create', prod.id);

    const cust = (await api('POST', '/customers', {
      biz: 'مشتری fixture طلایی', owner: 'مالک', phone: '09151112233',
    })).data;
    ok(!!cust.id, 'customer create', cust.id);

    const ord = await api('POST', '/orders', {
      cust_id: cust.id, date: TODAY, type: 'فروش', qty: 2, total: 2000000, status: 'pending',
    });
    ok(ord.status === 200 && ord.data.id, 'order create', ord.data.id || ord.data.error);

    // stock-in via purchase credit
    const sup = (await api('POST', '/suppliers', {
      name: 'تأمین‌کننده fixture', phone: '05131112233',
    })).data;
    ok(!!sup.id, 'supplier create', sup.id);

    const buy = await api('POST', '/purchases', {
      supplier_id: sup.id, date: TODAY, pay_type: 'credit', warehouse_id: whId,
      rows: [{ product_id: prod.id, qty: 5, price: 600000 }],
    });
    ok(buy.status === 200 && buy.data.id, 'purchase stock-in', buy.data.num || buy.data.error);

    let p = (await api('GET', '/products/' + prod.id)).data;
    ok(Number(p.stock) === 5, 'stock after purchase = 5', p.stock);

    console.log('— invoice + JE —');
    const inv = await api('POST', '/invoices', {
      cust_id: cust.id, type: 'final', date: TODAY, pay_type: 'credit', warehouse_id: whId,
      rows: [{ product_id: prod.id, qty: 2, price: 1000000 }],
    });
    ok(inv.status === 200 && inv.data.id, 'invoice create', inv.data.num || inv.data.error);
    const saleFinal = Number(inv.data.final || 0);
    ok(saleFinal >= 2000000, 'invoice final >= line total', saleFinal);

    p = (await api('GET', '/products/' + prod.id)).data;
    ok(Number(p.stock) === 3, 'stock after sale = 3', p.stock);

    const tb = (await api('GET', '/accounting/trial-balance')).data;
    ok(tb.balanced === true, 'trial balance balanced after sale', `D=${tb.totalDebit} C=${tb.totalCredit}`);

    const st = (await api('GET', '/accounting/statement/' + cust.id)).data;
    ok(approx(st.closing, saleFinal), 'customer statement = invoice final', `${st.closing} vs ${saleFinal}`);

    console.log('— money / rounding sample —');
    const invOdd = await api('POST', '/invoices', {
      cust_id: cust.id, type: 'final', date: TODAY, pay_type: 'credit', warehouse_id: whId,
      rows: [{ product_id: prod.id, qty: 1, price: 333333 }],
    });
    ok(invOdd.status === 200 && invOdd.data.id, 'odd-price invoice', invOdd.data.final);
    ok(Number.isInteger(Number(invOdd.data.final)), 'final is integer rial', invOdd.data.final);

    console.log('— R13 cancel primary invoice —');
    const cancel = await api('POST', `/accounting/invoices/${inv.data.id}/cancel`, { reason: 'golden-fixture' });
    ok(cancel.status === 200 || cancel.status === 201, 'R13 cancel', cancel.data.error || cancel.status);

    p = (await api('GET', '/products/' + prod.id)).data;
    // stock: 5 - 2 (inv) - 1 (odd) + 2 (cancel) = 4
    ok(Number(p.stock) === 4, 'stock after R13 = 4', p.stock);

    const tb2 = (await api('GET', '/accounting/trial-balance')).data;
    ok(tb2.balanced === true, 'trial balance after R13', `D=${tb2.totalDebit} C=${tb2.totalCredit}`);

    const st2 = (await api('GET', '/accounting/statement/' + cust.id)).data;
    const oddFinal = Number(invOdd.data.final || 0);
    ok(approx(st2.closing, oddFinal), 'statement after R13 = odd invoice only', `${st2.closing} vs ${oddFinal}`);

    // cancel odd too → zero
    await api('POST', `/accounting/invoices/${invOdd.data.id}/cancel`, { reason: 'golden-cleanup' });
    const st3 = (await api('GET', '/accounting/statement/' + cust.id)).data;
    ok(approx(st3.closing, 0), 'statement cleared after both cancels', st3.closing);

    p = (await api('GET', '/products/' + prod.id)).data;
    ok(Number(p.stock) === 5, 'stock restored to 5', p.stock);

    const snapshot = {
      suite: 'golden-vertical',
      SYNC_ROLE: 'central',
      asserts: {
        passed,
        failed,
        total: passed + failed,
      },
      events: events.map((e) => ({ name: e.name, ok: e.ok })),
      sample: {
        warehouse_id: whId,
        product_id: prod.id,
        customer_id: cust.id,
        order_id: ord.data.id || null,
        invoice_id: inv.data.id || null,
        sale_final: saleFinal,
        odd_final: oddFinal,
      },
    };
    // Hash without volatile ids — only pass/fail names
    const canonical = {
      suite: snapshot.suite,
      events: snapshot.events,
      asserts: snapshot.asserts,
    };
    const hash = crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
    snapshot.content_sha256 = hash;

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_SNAP, JSON.stringify(snapshot, null, 2) + '\n');
    fs.writeFileSync(OUT_SHA, hash + '\n');
    console.log('OK', OUT_SNAP);
    console.log('sha256', hash);
    console.log(`\n${failed ? '💥' : '🎉'} ${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
  } catch (e) {
    console.error('GOLDEN HARNESS ERROR:', e.message || e);
    process.exitCode = 1;
  } finally {
    if (srv) await killProcessTree(srv, { graceMs: 2000 });
    setTimeout(() => {
      try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
    }, 800);
  }
})();
