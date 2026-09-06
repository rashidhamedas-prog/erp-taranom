'use strict';

/**
 * Login / origin resilience: classify + retry policy, boot-gate 503, SQLite busy_timeout.
 * Run: node server/scripts/test-login-resilience.js
 */

const assert = require('assert');
const http = require('http');
const express = require('express');
const path = require('path');
const fs = require('fs');

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

const net = require('../lib/http-resilience');
const bootGate = require('../lib/boot-gate');

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log('ok', passed, '-', name);
}

ok('transient statuses include CF 521-524 and 502/503', () => {
  assert.strictEqual(net.isTransientStatus(502), true);
  assert.strictEqual(net.isTransientStatus(503), true);
  assert.strictEqual(net.isTransientStatus(521), true);
  assert.strictEqual(net.isTransientStatus(524), true);
  assert.strictEqual(net.isTransientStatus(401), false);
  assert.strictEqual(net.isTransientStatus(409), false);
});

ok('login retries transport and 503 STARTING but not 401/429', () => {
  assert.strictEqual(net.shouldRetryLogin(503, false), true);
  assert.strictEqual(net.shouldRetryLogin(521, false), true);
  assert.strictEqual(net.shouldRetryLogin(undefined, true), true);
  assert.strictEqual(net.shouldRetryLogin(401, false), false);
  assert.strictEqual(net.shouldRetryLogin(429, false), false);
  assert.strictEqual(net.shouldRetryLogin(409, false), false);
});

ok('classify transport Failed to fetch is retryable Persian', () => {
  const c = net.classifyTransportError(new Error('Failed to fetch'));
  assert.strictEqual(c.retryable, true);
  assert.strictEqual(c.code, 'NETWORK');
  assert.match(c.message, /راه‌اندازی|ارتباط/);
});

ok('classify 503 STARTING uses server message', () => {
  const c = net.classifyHttpFailure(503, { code: 'STARTING', error: 'سرور در حال راه‌اندازی است؛ چند ثانیه دیگر تلاش کنید' });
  assert.strictEqual(c.retryable, true);
  assert.strictEqual(c.code, 'STARTING');
});

ok('retry delays grow', () => {
  assert.strictEqual(net.retryDelayMs(0), 400);
  assert.strictEqual(net.retryDelayMs(1), 900);
  assert.ok(net.retryDelayMs(2) > net.retryDelayMs(1));
});

ok('boot-gate starts not-ready then serves after markReady', () => {
  const g = require('../lib/boot-gate');
  assert.strictEqual(g.canServe(), false);
  assert.strictEqual(g.state().code, 'STARTING');
  g.markReady();
  assert.strictEqual(g.canServe(), true);
  assert.strictEqual(g.state().code, 'OK');
  g.markDraining();
  assert.strictEqual(g.canServe(), false);
  assert.strictEqual(g.state().code, 'RESTARTING');
});

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function req(port, method, urlPath) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = body ? JSON.parse(body) : null; } catch { json = null; }
        resolve({ status: res.statusCode, json, retryAfter: res.headers['retry-after'] });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

(async () => {
  const gate = (() => {
    const m = require('module');
    const file = require.resolve('../lib/boot-gate');
    delete require.cache[file];
    return require('../lib/boot-gate');
  })();

  const app = express();
  app.get('/api/system/health', (req, res) => {
    res.json({ ok: true, starting: !gate.canServe() });
  });
  app.get('/api/system/ready', (req, res) => {
    if (!gate.canServe()) {
      res.set('Retry-After', '2');
      return res.status(503).json({ ok: false, code: gate.state().code });
    }
    res.json({ ok: true, ready: true });
  });
  app.use('/api', gate.middleware);
  app.post('/api/auth/login', (req, res) => res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است', code: 'LOGIN_REJECTED' }));

  const server = await listen(app);
  const port = server.address().port;

  const health0 = await req(port, 'GET', '/api/system/health');
  ok('health 200 while starting', () => {
    assert.strictEqual(health0.status, 200);
    assert.strictEqual(health0.json.ok, true);
    assert.strictEqual(health0.json.starting, true);
  });

  const ready0 = await req(port, 'GET', '/api/system/ready');
  ok('ready 503 STARTING with Retry-After', () => {
    assert.strictEqual(ready0.status, 503);
    assert.strictEqual(ready0.json.code, 'STARTING');
    assert.strictEqual(String(ready0.retryAfter), '2');
  });

  const login0 = await req(port, 'POST', '/api/auth/login');
  ok('login 503 while starting (not Failed to fetch)', () => {
    assert.strictEqual(login0.status, 503);
    assert.strictEqual(login0.json.code, 'STARTING');
  });

  gate.markReady();
  const ready1 = await req(port, 'GET', '/api/system/ready');
  ok('ready 200 after markReady', () => {
    assert.strictEqual(ready1.status, 200);
    assert.strictEqual(ready1.json.ready, true);
  });
  const login1 = await req(port, 'POST', '/api/auth/login');
  ok('login reaches handler after ready (401 JSON, not network)', () => {
    assert.strictEqual(login1.status, 401);
    assert.strictEqual(login1.json.code, 'LOGIN_REJECTED');
  });

  gate.markDraining();
  const login2 = await req(port, 'POST', '/api/auth/login');
  ok('login 503 RESTARTING while draining', () => {
    assert.strictEqual(login2.status, 503);
    assert.strictEqual(login2.json.code, 'RESTARTING');
  });

  await new Promise((r) => server.close(r));

  const dbSrc = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8');
  ok('db.js waits on SQLITE_BUSY for 8000ms', () => {
    assert.match(dbSrc, /busy_timeout = 8000/);
    assert.match(dbSrc, /timeout: 8000/);
    assert.match(dbSrc, /mmap_size = 134217728/);
  });

  const src = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  ok('login uses fetchWithRetry', () => {
    assert.match(src, /fetchWithRetry/);
    assert.match(src, /waitUntilReady/);
    assert.match(src, /ورود موفق بود ولی بارگذاری برنامه کامل نشد/);
  });

  console.log('\n' + passed + ' passed');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
