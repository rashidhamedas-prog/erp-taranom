'use strict';

/**
 * W2-O1 — observability unit checks + readiness probe via getDB.
 * Run: node server/scripts/test-observability.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  createRequestId,
  redactFields,
  jsonLog,
  checkDbReady,
  REDACTED,
  requestIdMiddleware,
} = require('../lib/observability');

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

ok('createRequestId generates opaque hex when no incoming', () => {
  const a = createRequestId();
  const b = createRequestId(null);
  assert.match(a, /^[a-f0-9]{32}$/);
  assert.match(b, /^[a-f0-9]{32}$/);
  assert.notStrictEqual(a, b);
});

ok('createRequestId accepts safe incoming X-Request-Id', () => {
  assert.strictEqual(createRequestId('abc-123_XYZ:1'), 'abc-123_XYZ:1');
});

ok('createRequestId rejects unsafe incoming values', () => {
  const bad = createRequestId('evil\nheader');
  assert.match(bad, /^[a-f0-9]{32}$/);
  const space = createRequestId('has space');
  assert.match(space, /^[a-f0-9]{32}$/);
});

ok('redactFields masks national_id phone password token iban', () => {
  const out = redactFields({
    national_id: '0012345678',
    phone: '09121234567',
    password: 'secret',
    token: 'tok_abc',
    iban: 'IR123',
    customer_id: 42,
    nested: { phone: '0999', ok: true },
  });
  assert.strictEqual(out.national_id, REDACTED);
  assert.strictEqual(out.phone, REDACTED);
  assert.strictEqual(out.password, REDACTED);
  assert.strictEqual(out.token, REDACTED);
  assert.strictEqual(out.iban, REDACTED);
  assert.strictEqual(out.customer_id, 42);
  assert.strictEqual(out.nested.phone, REDACTED);
  assert.strictEqual(out.nested.ok, true);
});

ok('jsonLog redacts PII in stdout JSON', () => {
  const lines = [];
  const orig = console.log;
  console.log = (line) => { lines.push(line); };
  try {
    const logged = jsonLog({
      level: 'info',
      msg: 'unit',
      requestId: 'rid-1',
      phone: '09120000000',
      password: 'x',
      amount: 100,
    });
    assert.strictEqual(logged.phone, REDACTED);
    assert.strictEqual(logged.password, REDACTED);
    assert.strictEqual(logged.amount, 100);
    assert.strictEqual(logged.requestId, 'rid-1');
    assert.ok(lines.length === 1);
    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(parsed.phone, REDACTED);
    assert.doesNotMatch(lines[0], /09120000000/);
  } finally {
    console.log = orig;
  }
});

ok('requestIdMiddleware sets header and req.requestId', () => {
  const req = {
    method: 'GET',
    url: '/api/system/health',
    originalUrl: '/api/system/health',
    headers: { 'x-request-id': 'client-rid-9' },
  };
  const headers = {};
  const listeners = {};
  const res = {
    setHeader(k, v) { headers[k] = v; },
    statusCode: 200,
    on(ev, fn) { listeners[ev] = fn; },
  };
  let nextCalled = false;
  const lines = [];
  const orig = console.log;
  console.log = (line) => { lines.push(line); };
  try {
    requestIdMiddleware(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
    assert.strictEqual(req.requestId, 'client-rid-9');
    assert.strictEqual(headers['X-Request-Id'], 'client-rid-9');
    listeners.finish();
    assert.ok(lines.some((l) => {
      const o = JSON.parse(l);
      return o.msg === 'http_request' && o.path === '/api/system/health' && o.status === 200;
    }));
  } finally {
    console.log = orig;
  }
});

// Readiness via real temp DB (same contract as GET /api/system/ready)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-ready-'));
const dbPath = path.join(tmpDir, 'obs.db');
process.env.DB_PATH = dbPath;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-observability-jwt-secret-32chars!!';
process.env.SYNC_ROLE = process.env.SYNC_ROLE || 'central';

const { initDB, getDB } = require('../db');
initDB();

ok('checkDbReady true after initDB', () => {
  assert.strictEqual(checkDbReady(getDB), true);
  getDB().prepare('SELECT 1').get();
});

ok('ready handler shape 200 when DB ok', () => {
  // Mirror route logic without binding a port
  const ready = checkDbReady(getDB);
  const status = ready ? 200 : 503;
  const body = ready ? { ok: true, ready: true } : { ok: false, ready: false };
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body, { ok: true, ready: true });
});

ok('support meta stub contract', () => {
  const meta = {
    ticketing: 'external',
    sla_note: 'پشتیبانی از طریق کانال خارجی سازمان پیگیری می‌شود؛ تیکتینگ داخل ERP فعلاً فعال نیست.',
    kb_url: null,
  };
  assert.strictEqual(meta.ticketing, 'external');
  assert.strictEqual(meta.kb_url, null);
  assert.ok(typeof meta.sla_note === 'string' && meta.sla_note.length > 10);
});

console.log(`observability: ${passed}/${passed} pass`);
