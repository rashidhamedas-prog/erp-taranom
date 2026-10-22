// v522 — synchronous online-only relay for /api/inventory-valuation (device → central).
// Boots central + paired device + unpaired device on fresh DBs and verifies:
//   preview/post via relay (central hash accepted, row lands on central), no
//   local outbox row, idempotent retry, forged/expired/replayed/cross-protocol
//   envelopes → 403/409, allow-list (path/method/query smuggling) → 403, central
//   RBAC 403 passes through, unpaired/offline → 503 E_ONLINE_REQUIRED, GET falls
//   back to the local handler when central is down.
// Run: node server/scripts/test-device-relay-v522.js  (RELAY_TEST_PORT_BASE, default 4360)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createDeviceHeaders, generateReplaySigningKeyPair, signReplayEnvelope } = require('../sync/device-auth');
const relay = require('../sync/relay-now');
const { preferredPort, assertPortsFree, killProcessTree, installCleanupHooks } = require('./lib/test-server-boot');

for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k];
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';

const S = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-relay-v522-'));
const SERVER = path.join(__dirname, '..', 'server.js');
const CWD = path.join(__dirname, '..');
const BOOT_TIMEOUT_MS = Math.max(60000, parseInt(process.env.SYNC_TEST_BOOT_TIMEOUT_MS, 10) || 60000);
const PORT_BASE = preferredPort('RELAY_TEST_PORT_BASE', 4360);
const PORT_C = PORT_BASE, PORT_A = PORT_BASE + 1, PORT_U = PORT_BASE + 2;
const C = `http://127.0.0.1:${PORT_C}`;
const A = `http://127.0.0.1:${PORT_A}`;
const U = `http://127.0.0.1:${PORT_U}`;

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✅', label); } else { failed++; console.log('  ❌', label); }
}
const procs = {};
function start(name, env) {
  const p = spawn(process.execPath, [SERVER], { cwd: CWD, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', () => {});
  p.stderr.on('data', d => { if (process.env.RELAY_TEST_VERBOSE) console.error(`[${name}]`, d.toString().slice(0, 300)); });
  procs[name] = p;
}
async function stop(name) {
  if (!procs[name]) return;
  const child = procs[name]; delete procs[name];
  await killProcessTree(child, { graceMs: 2500 });
}
installCleanupHooks(() => Object.values(procs));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitForServer(base) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try { const r = await fetch(base + '/api/system/time', { signal: AbortSignal.timeout(1500) }); if (r.ok) return; } catch { /* booting */ }
    await sleep(500);
  }
  throw new Error('server readiness timeout ' + base);
}
async function req(base, method, p, token, body) {
  const r = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j, source: r.headers.get('x-data-source'), relay: r.headers.get('x-relay-result') };
}
async function pollUntil(fn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) { last = await fn(); if (last) return last; await sleep(500); }
  return last;
}

function unitTests() {
  console.log('— unit: allow-list + envelope —');
  const rej = (m, p) => { try { relay.validateRelayTarget(m, p); return false; } catch (e) { return e.status === 403; } };
  ok(!rej('GET', '/api/inventory-valuation/policy'), 'allow: GET policy');
  ok(!rej('GET', '/api/inventory-valuation/effective?product_id=3&warehouse_id=1'), 'allow: GET with simple query');
  ok(!rej('POST', '/api/inventory-valuation/revaluations/12/reverse'), 'allow: POST reverse');
  ok(rej('DELETE', '/api/inventory-valuation/rules/1'), 'reject: DELETE');
  ok(rej('post', '/api/inventory-valuation/rules'), 'reject: lowercase method');
  ok(rej('POST', '/api/inventory-valuation/../admin/users'), 'reject: .. traversal');
  ok(rej('POST', '/api/inventory-valuation/%2e%2e/admin'), 'reject: encoded traversal');
  ok(rej('POST', '/api/inventory-valuation//rules'), 'reject: double slash');
  ok(rej('POST', '/api/inventory-valuation/rules?x=1'), 'reject: query on mutation');
  ok(rej('GET', '/api/inventory-valuation/policy?a=<script>'), 'reject: unsafe query chars');
  ok(rej('GET', '/api/inventory-valuationX/policy'), 'reject: prefix lookalike');
  ok(rej('POST', '/api/admin/users'), 'reject: outside prefix');
  ok(relay.isRelayMutation('POST', '/api/inventory-valuation/revaluations') && !relay.isRelayMutation('POST', '/api/inventory-valuation/revaluations/preview'),
    'preview is not a mutation; post is');
  const keys = generateReplaySigningKeyPair();
  const env = relay.buildRelayEnvelope(keys.privateKey, { deviceId: 7, userId: 1, method: 'POST', path: '/api/inventory-valuation/rules', body: { a: 1 } });
  const input = { deviceId: 7, userId: 1, ts: env.ts, nonce: env.nonce, method: 'POST', path: env.path, body: env.body };
  ok(relay.verifyRelayEnvelope(keys.publicKey, env.replay_proof, input), 'envelope verifies');
  ok(!relay.verifyRelayEnvelope(keys.publicKey, env.replay_proof, { ...input, userId: 2 }), 'user_id is bound');
  ok(!relay.verifyRelayEnvelope(keys.publicKey, env.replay_proof, { ...input, deviceId: 8 }), 'device_id is bound');
  ok(!relay.verifyRelayEnvelope(keys.publicKey, env.replay_proof, { ...input, ts: env.ts + 1 }), 'ts is bound');
  ok(!relay.verifyRelayEnvelope(keys.publicKey, env.replay_proof, { ...input, body: { a: 2 } }), 'body is bound');
  let limited = false;
  for (let i = 0; i < 40; i++) limited = relay._rateLimited(-1, true) || limited;
  ok(limited, 'per-device mutation rate limit trips');
  relay._rateBuckets.delete(-1);
}

(async () => {
  unitTests();
  console.log(`— boot central + paired device + unpaired device (ports ${PORT_C}/${PORT_A}/${PORT_U}) —`);
  try { await assertPortsFree([PORT_C, PORT_A, PORT_U]); } catch (e) { console.error('⛔ ' + e.message); process.exit(2); }
  const centralEnv = { JWT_SECRET: 'relay-central-test-secret-at-least-32-bytes', PORT: String(PORT_C), DB_PATH: `${S}/central.db` };
  start('central', centralEnv);
  start('devA', { JWT_SECRET: 'relay-device-a-test-secret-at-least-32-b', PORT: String(PORT_A), DB_PATH: `${S}/devA.db`, SYNC_ROLE: 'device', SYNC_INTERVAL_MS: '3600000' });
  start('devU', { JWT_SECRET: 'relay-device-u-test-secret-at-least-32-b', PORT: String(PORT_U), DB_PATH: `${S}/devU.db`, SYNC_ROLE: 'device', SYNC_INTERVAL_MS: '3600000' });
  await Promise.all([waitForServer(C), waitForServer(A), waitForServer(U)]);

  const PASS = 'relay-test-1405';
  let ct = (await req(C, 'POST', '/api/auth/login', null, { username: 'admin', password: 'admin123' })).body.token;
  await req(C, 'POST', '/api/auth/change-password', ct, { oldPass: 'admin123', newPass: PASS });
  ct = (await req(C, 'POST', '/api/auth/login', null, { username: 'admin', password: PASS })).body.token;
  let at = (await req(A, 'POST', '/api/auth/login', null, { username: 'admin', password: 'admin123' })).body.token;
  const ut = (await req(U, 'POST', '/api/auth/login', null, { username: 'admin', password: 'admin123' })).body.token;
  ok(ct && at && ut, 'logins on all three');

  const prod = (await req(C, 'POST', '/api/products', ct, { name: 'کالای ارزش‌گذاری', code: 'RV-1', price: 50000, cost: 20000, stock: 10 })).body;
  const sales = await req(C, 'POST', '/api/admin/users', ct, { name: 'فروش رله', username: 'relay-sales', password: 'SalesPass1405', role: 'field_sales', phone: '09120000077' });
  ok(prod && prod.id && sales.status === 200 && sales.body.id, 'central seeded product + non-accounting user');

  console.log('— unpaired device → 503 —');
  const unp = await req(U, 'POST', '/api/inventory-valuation/revaluations/preview', ut, { basis: 'manual_unit', product_ids: [prod.id], unit_cost_rial: 25000, date: '1405/07/10' });
  ok(unp.status === 503 && unp.body.code === 'E_ONLINE_REQUIRED', `unpaired device mutation/preview → 503 E_ONLINE_REQUIRED (got ${unp.status} ${unp.body.code})`);
  const unpRead = await req(U, 'GET', '/api/inventory-valuation/policy', ut);
  ok(unpRead.status === 200 && unpRead.source === 'local', 'unpaired device GET served locally (X-Data-Source: local)');

  console.log('— pair device A —');
  const pA = await req(A, 'POST', '/api/sync/pair-device', at, { central_url: C, username: 'admin', password: PASS, device_name: 'relay A' });
  ok(pA.body.ok, 'device A paired');
  const relogin = await pollUntil(async () => {
    const l = await req(A, 'POST', '/api/auth/login', null, { username: 'admin', password: PASS });
    return l.status === 200 && l.body.token ? l.body : null;
  });
  at = relogin && relogin.token;
  ok(!!at, 'device A re-login after initial pull');
  await pollUntil(async () => (await req(A, 'GET', '/api/sync/status', at)).body.initial_sync_done);

  console.log('— device preview + post via relay —');
  const revBody = { basis: 'manual_unit', product_ids: [prod.id], unit_cost_rial: 25000, date: '1405/07/10' };
  const pv = await req(A, 'POST', '/api/inventory-valuation/revaluations/preview', at, revBody);
  ok(pv.status === 200 && pv.source === 'central' && typeof pv.body.hash === 'string', `device preview answered by central (status ${pv.status}, source ${pv.source})`);
  const pvC = await req(C, 'POST', '/api/inventory-valuation/revaluations/preview', ct, revBody);
  ok(pvC.body.hash === pv.body.hash, 'device preview hash == central preview hash');
  ok(Array.isArray(pv.body.lines) && pv.body.lines.length >= 1, `preview has lines (${(pv.body.lines || []).length})`);
  const before = (await req(C, 'GET', '/api/inventory-valuation/revaluations?limit=50', ct)).body.rows || [];
  const post = await req(A, 'POST', '/api/inventory-valuation/revaluations', at, { ...revBody, preview_hash: pv.body.hash });
  ok(post.status === 201 && post.body.id, `device post via relay → 201 (got ${post.status} ${post.body.code || ''})`);
  const after = (await req(C, 'GET', '/api/inventory-valuation/revaluations?limit=50', ct)).body.rows || [];
  ok(after.length === before.length + 1 && after.some(r => r.id === post.body.id), 'revaluation row exists on central');
  const stale = await req(A, 'POST', '/api/inventory-valuation/revaluations', at, { ...revBody, preview_hash: 'deadbeef' });
  ok(stale.status >= 400 && stale.status < 500 && stale.source === 'central', `wrong preview_hash rejected by central (${stale.status} ${stale.body.code})`);
  const pending = (await req(A, 'GET', '/api/sync/pending', at)).body || [];
  ok(Array.isArray(pending) && !pending.some(o => String(o.path || '').includes('inventory-valuation')), 'no local outbox row for relayed ops');
  const rd = await req(A, 'GET', '/api/inventory-valuation/revaluations?limit=5', at);
  ok(rd.status === 200 && rd.source === 'central' && (rd.body.rows || []).some(r => r.id === post.body.id), 'device GET online → central data');
  const rev = await req(A, 'POST', `/api/inventory-valuation/revaluations/${post.body.id}/reverse`, at, { reason: 'test' });
  ok(rev.status === 200, `device reverse via relay → 200 (got ${rev.status} ${rev.body.code || ''})`);

  console.log('— central relay endpoint: forged/expired/replayed/allow-list/idempotency —');
  const keys = generateReplaySigningKeyPair();
  const probe = (await req(C, 'POST', '/api/sync/pair', null, { username: 'admin', password: PASS, device_name: 'relay-probe', replay_public_key: keys.publicKey })).body;
  const cfg = { deviceId: probe.device_id, deviceToken: probe.device_token };
  const send = async (env) => {
    const r = await fetch(C + '/api/sync/relay-now', { method: 'POST', headers: { ...createDeviceHeaders(cfg), 'Content-Type': 'application/json' }, body: JSON.stringify(env) });
    return { status: r.status, body: await r.json().catch(() => ({})), relay: r.headers.get('x-relay-result') };
  };
  const mk = (o) => relay.buildRelayEnvelope(keys.privateKey, { deviceId: cfg.deviceId, userId: 1, method: 'GET', path: '/api/inventory-valuation/policy', ...o });

  const good = await send(mk({}));
  ok(good.status === 200 && good.relay === 'replayed', 'signed GET relay → 200');
  const forged = mk({ method: 'POST', path: '/api/inventory-valuation/rules', body: { name: 'x' }, userId: 999 });
  forged.user_id = 1;
  const fr = await send(forged);
  ok(fr.status === 403 && fr.body.code === 'SYNC_RELAY_PROOF_REJECTED', 'forged user_id → 403');
  const tampered = mk({ method: 'POST', path: '/api/inventory-valuation/rules', body: { name: 'a' } });
  tampered.body = { name: 'b' };
  ok((await send(tampered)).status === 403, 'tampered body → 403');
  const expired = await send(mk({ ts: Math.floor(Date.now() / 1000) - 601 }));
  ok(expired.status === 403 && expired.body.code === 'SYNC_RELAY_EXPIRED', 'expired ts → 403');
  const once = mk({});
  await send(once);
  const twice = await send(once);
  ok(twice.status === 409 && twice.body.code === 'SYNC_RELAY_REPLAYED', 'replayed GET nonce → 409');
  const pushProofOp = { method: 'POST', path: '/api/inventory-valuation/rules', body: { name: 'x' } };
  const cross = mk(pushProofOp);
  cross.replay_proof = signReplayEnvelope(keys.privateKey, { deviceId: cfg.deviceId, seq: 1, userId: 1, ...pushProofOp });
  ok((await send(cross)).status === 403, 'push-envelope proof not accepted as relay proof');
  const outsideEnv = mk({ method: 'POST', path: '/api/inventory-valuation/rules', body: {} });
  outsideEnv.path = '/api/admin/users';
  const outside = await send(outsideEnv);
  ok(outside.status === 403 && outside.body.code === 'SYNC_RELAY_PATH_REJECTED', 'path outside allow-list → 403');
  const trav = mk({}); trav.path = '/api/inventory-valuation/../admin/users';
  ok((await send(trav)).status === 403, '.. traversal → 403');
  const extra = mk({}); extra.seq = 5;
  ok((await send(extra)).status === 400, 'unknown envelope field → 400');

  const ruleBody = { name: 'رله-idem', triggers: ['back_dated'], basis: 'replay', action: 'review', schedule: 'none', enabled: 0 };
  const idem = mk({ method: 'POST', path: '/api/inventory-valuation/rules', body: ruleBody });
  const r1 = await send(idem);
  const r2 = await send(idem);
  const rules = (await req(C, 'GET', '/api/inventory-valuation/rules', ct)).body.rows || [];
  ok(r1.status === 201 && r2.status === 201 && r2.relay === 'idempotent' && r1.body.id === r2.body.id, `idempotent retry returns stored outcome (${r1.status}/${r2.status} ${r2.relay})`);
  ok(rules.filter(r => r.name === 'رله-idem').length === 1, 'idempotent retry did not double-post');

  const salesId = sales.body.id;
  const denied = await send(mk({ userId: salesId, method: 'POST', path: '/api/inventory-valuation/rules', body: { ...ruleBody, name: 'denied' } }));
  ok(denied.status === 403 && denied.relay === 'replayed', `central RBAC 403 passes through for unprivileged acting user (${denied.status})`);
  const ghost = await send(mk({ userId: 987654 }));
  ok(ghost.status === 403 && ghost.body.code === 'SYNC_RELAY_USER_REJECTED', 'unknown acting user → 403');

  const noAuth = await fetch(C + '/api/sync/relay-now', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mk({})) });
  ok(noAuth.status === 401, 'relay without device auth → 401');

  console.log('— central down: device writes 503, reads local —');
  await stop('central');
  await sleep(300);
  const off = await req(A, 'POST', '/api/inventory-valuation/revaluations/preview', at, revBody);
  ok(off.status === 503 && off.body.code === 'E_ONLINE_REQUIRED', `offline preview → 503 E_ONLINE_REQUIRED (got ${off.status})`);
  const offPost = await req(A, 'PUT', '/api/inventory-valuation/policy', at, { level: 'product' });
  ok(offPost.status === 503 && offPost.body.code === 'E_ONLINE_REQUIRED', 'offline policy change → 503');
  const offRead = await req(A, 'GET', '/api/inventory-valuation/policy', at);
  ok(offRead.status === 200 && offRead.source === 'local', `offline GET falls back to local (status ${offRead.status}, source ${offRead.source})`);
  const pending2 = (await req(A, 'GET', '/api/sync/pending', at)).body || [];
  ok(!pending2.some(o => String(o.path || '').includes('inventory-valuation')), 'offline attempts were not queued');

  await stop('devA'); await stop('devU');
  console.log(`\n${passed} passed, ${failed} failed`);
  try { fs.rmSync(S, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e);
  for (const n of Object.keys(procs)) await stop(n);
  process.exit(1);
});
