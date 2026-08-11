// End-to-end sync verification: central (:4100) + two devices (:4101, :4102),
// fresh databases. Covers: pairing, true-offline queueing (central down),
// concurrent numbering from two devices, chained refs, pull propagation of
// edits + tombstoned deletes, version conflict on concurrent edit, oversell
// conflict, idempotency — asserting Trial Balance + Balance Sheet stay
// balanced on central and all instances converge.
const { spawn } = require('child_process');
const fs = require('fs');

const os = require('os');
const path = require('path');
const {
  createDeviceHeaders,
  signature,
  generateReplaySigningKeyPair,
  signReplayEnvelope,
} = require('../sync/device-auth');
const S = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-sync-e2e-'));
const SERVER = path.join(__dirname, '..', 'server.js');
const CWD = path.join(__dirname, '..');

// Loopback health checks must never route through a system VPN proxy
// (Windows: HTTP(S)_PROXY set per-shell breaks 127.0.0.1 fetches).
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';

// Cold boot of 3 servers on a loaded machine can exceed 60s each — tunable.
const BOOT_TIMEOUT_MS = Math.max(60000, parseInt(process.env.SYNC_TEST_BOOT_TIMEOUT_MS, 10) || 60000);

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✅', label); }
  else { failed++; console.log('  ❌', label); }
}

const procs = {};
function start(name, env) {
  const p = spawn('node', [SERVER], { cwd: CWD, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', () => {});
  p.stderr.on('data', d => console.error(`[${name}]`, d.toString().slice(0, 200)));
  procs[name] = p;
  return p;
}
function stop(name) { if (procs[name]) { procs[name].kill('SIGKILL'); delete procs[name]; } }
// Never leave orphan servers holding the test ports (a truncated pipe/SIGINT
// used to leak children — the next run then talked to stale instances).
function killAll() { for (const n of Object.keys(procs)) stop(n); }
process.on('exit', killAll);
process.on('SIGINT', () => { killAll(); process.exit(130); });
process.on('SIGTERM', () => { killAll(); process.exit(143); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForServer(base, timeoutMs = BOOT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base + '/api/system/time', { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`server readiness timeout for ${base}: ${lastError?.message || 'not ready'}`);
}

// Pre-flight: fail fast if the fixed ports are already taken by stale runs.
async function assertPortsFree(ports) {
  for (const port of ports) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/system/time`, { signal: AbortSignal.timeout(700) });
      console.error(`⛔ پورت ${port} اشغال است (اجرای قبلی؟) — با pkill -f "node.*server.js" پاک کنید`);
      process.exit(2);
    } catch { /* free */ }
  }
}

async function req(base, method, path, token, body) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

const C = 'http://127.0.0.1:4100';
const A = 'http://127.0.0.1:4101';
const B = 'http://127.0.0.1:4102';

const centralEnv = { JWT_SECRET: 'sync-central-test-secret-at-least-32-bytes', PORT: '4100', DB_PATH: `${S}/e2e-central.db` };

(async () => {

  console.log('— boot central + devices —');
  await assertPortsFree([4100, 4101, 4102]);
  start('central', centralEnv);
  start('devA', { JWT_SECRET: 'sync-device-a-test-secret-at-least-32-bytes', PORT: '4101', DB_PATH: `${S}/e2e-devA.db`, SYNC_ROLE: 'device', SYNC_INTERVAL_MS: '3600000' });
  start('devB', { JWT_SECRET: 'sync-device-b-test-secret-at-least-32-bytes', PORT: '4102', DB_PATH: `${S}/e2e-devB.db`, SYNC_ROLE: 'device', SYNC_INTERVAL_MS: '3600000' });
  await Promise.all([waitForServer(C), waitForServer(A), waitForServer(B)]);

  let CENTRAL_PASS = 'sync-test-1234';
  let loginC = (await req(C, 'POST', '/api/auth/login', null, { username: 'admin', password: 'admin123' })).body;
  let ct = loginC.token;
  ok(loginC.must_change_password === true, 'central flags default password for forced change');
  // Until the password changes, central rejects everything else
  const blocked = await req(C, 'GET', '/api/customers', ct);
  ok(blocked.status === 403 && blocked.body.code === 'must_change_password', 'central blocks API calls until password change');
  const chg = await req(C, 'POST', '/api/auth/change-password', ct, { oldPass: 'admin123', newPass: CENTRAL_PASS });
  ok(chg.status === 200, 'central admin password changed');
  ct = (await req(C, 'POST', '/api/auth/login', null, { username: 'admin', password: CENTRAL_PASS })).body.token;
  // Devices skip forced-change locally (their users table is overwritten by pull)
  let at = (await req(A, 'POST', '/api/auth/login', null, { username: 'admin', password: 'admin123' })).body.token;
  let bt = (await req(B, 'POST', '/api/auth/login', null, { username: 'admin', password: 'admin123' })).body.token;
  ok(ct && at && bt, 'all three instances up + login');

  console.log('— device request replay/time-window guard —');
  const replayKeys = generateReplaySigningKeyPair();
  const replayPair = await req(C, 'POST', '/api/sync/pair', null, {
    username: 'admin', password: CENTRAL_PASS, device_name: 'replay-probe',
    replay_public_key: replayKeys.publicKey,
  });
  const replayCfg = { deviceId: replayPair.body.device_id, deviceToken: replayPair.body.device_token };
  const replayHeaders = createDeviceHeaders(replayCfg);
  const replayOnce = await fetch(C + '/api/sync/pull?since=-1&limit=1', { headers: replayHeaders });
  const replayTwice = await fetch(C + '/api/sync/pull?since=-1&limit=1', { headers: replayHeaders });
  ok(replayOnce.status === 200 && replayTwice.status === 409, 'same signed nonce is accepted once then rejected');
  const oldTime = Math.floor(Date.now() / 1000) - 601;
  const oldNonce = 'a'.repeat(36);
  const staleHeaders = {
    Authorization: `Device ${replayCfg.deviceId}:${replayCfg.deviceToken}`,
    'x-sync-time': String(oldTime),
    'x-sync-nonce': oldNonce,
    'x-sync-signature': signature(replayCfg.deviceToken, oldTime, oldNonce),
  };
  const staleRequest = await fetch(C + '/api/sync/pull?since=-1&limit=1', { headers: staleHeaders });
  ok(staleRequest.status === 401, 'signed request outside time window is rejected');

  const forgedOp = {
    seq: 900001,
    method: 'POST',
    path: '/api/admin/users',
    body: { name: 'forged-admin', username: 'forged-admin', password: 'ForgedPass1405', role: 'admin' },
    user_id: 1,
    replay_proof: signReplayEnvelope(replayKeys.privateKey, {
      deviceId: replayCfg.deviceId,
      seq: 900001,
      method: 'POST',
      path: '/api/admin/users',
      userId: 999999,
      body: { name: 'forged-admin', username: 'forged-admin', password: 'ForgedPass1405', role: 'admin' },
    }),
  };
  const forgedReplay = await fetch(C + '/api/sync/push', {
    method: 'POST',
    headers: { ...createDeviceHeaders(replayCfg), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ops: [forgedOp] }),
  });
  const forgedReplayBody = await forgedReplay.json().catch(() => ({}));
  ok(forgedReplay.status === 403 && forgedReplayBody.code === 'SYNC_REPLAY_PROOF_REJECTED',
    'stolen device token cannot change signed user_id to admin');

  console.log('— seed central —');
  await req(C, 'POST', '/api/products', ct, { name: 'کالای اصلی', code: 'M-1', price: 50000, cost: 20000, stock: 100 });
  const custC = (await req(C, 'POST', '/api/customers', ct, { biz: 'مشتری مشترک' })).body;
  await req(C, 'POST', '/api/followups', ct, { cust_id: custC.id, date: '1405/04/01', type: 'تماس', subject: 'برای حذف', status: 'open' });

  console.log('— scenario 1: pair both devices —');
  const pA = await req(A, 'POST', '/api/sync/pair-device', at, { central_url: C, username: 'admin', password: CENTRAL_PASS, device_name: 'دستگاه A' });
  const pB = await req(B, 'POST', '/api/sync/pair-device', bt, { central_url: C, username: 'admin', password: CENTRAL_PASS, device_name: 'دستگاه B' });
  ok(pA.body.ok && pB.body.ok, `pairing (A=device ${pA.body.device_id}, B=device ${pB.body.device_id})`);
  // Initial pull runs async after pairing — poll until seeded rows appear
  // (registry has grown; a fixed read right after pair-device races the pull).
  async function pollUntil(fn, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await fn();
      if (last) return last;
      await sleep(500);
    }
    return last;
  }
  // The initial users-table pull intentionally replaces the placeholder
  // account (password hash + auth_epoch), so its pre-pair local session must
  // be treated as revoked. Re-authenticate with the central credential once
  // the authoritative user row has arrived.
  const loginAfterPullA = await pollUntil(async () => {
    const login = await req(A, 'POST', '/api/auth/login', null, { username: 'admin', password: CENTRAL_PASS });
    return login.status === 200 && login.body.token ? login.body : null;
  });
  const loginAfterPullB = await pollUntil(async () => {
    const login = await req(B, 'POST', '/api/auth/login', null, { username: 'admin', password: CENTRAL_PASS });
    return login.status === 200 && login.body.token ? login.body : null;
  });
  at = loginAfterPullA && loginAfterPullA.token;
  bt = loginAfterPullB && loginAfterPullB.token;
  ok(!!at && !!bt, 'devices re-authenticate after authoritative initial user pull');
  const aCustSeen = await pollUntil(async () => {
    const rows = (await req(A, 'GET', '/api/customers', at)).body;
    return Array.isArray(rows) && rows.some(c => c.biz === 'مشتری مشترک');
  });
  const bProdSeen = await pollUntil(async () => {
    const rows = (await req(B, 'GET', '/api/products', bt)).body;
    return Array.isArray(rows) && rows.some(p => p.code === 'M-1' && p.stock === 100);
  });
  if (!aCustSeen || !bProdSeen) {
    console.log('   initial pull status A:', JSON.stringify((await req(A, 'GET', '/api/sync/status', at)).body));
    console.log('   initial pull status B:', JSON.stringify((await req(B, 'GET', '/api/sync/status', bt)).body));
    console.log('   customers A:', JSON.stringify((await req(A, 'GET', '/api/customers', at)).body));
    console.log('   products B:', JSON.stringify((await req(B, 'GET', '/api/products', bt)).body));
  }
  ok(aCustSeen, 'A pulled central customer');
  ok(bProdSeen, 'B pulled central product');

  console.log('— scenario 1b: device password change proxies to central —');
  const DEV_NEW_PASS = 'device-new-5678';
  const chgA = await req(A, 'POST', '/api/auth/change-password', at, { oldPass: CENTRAL_PASS, newPass: DEV_NEW_PASS });
  ok(chgA.status === 200, 'device A change-password proxies to central');
  const loginCNew = await req(C, 'POST', '/api/auth/login', null, { username: 'admin', password: DEV_NEW_PASS });
  ok(loginCNew.status === 200, 'central accepts new password after device change');
  const loginCOld = await req(C, 'POST', '/api/auth/login', null, { username: 'admin', password: CENTRAL_PASS });
  ok(loginCOld.status === 401, 'central rejects old password');
  await req(A, 'POST', '/api/sync/now', at);
  const loginAOld = await req(A, 'POST', '/api/auth/login', null, { username: 'admin', password: CENTRAL_PASS });
  ok(loginAOld.status === 401, 'device A rejects old password after sync');
  const loginANew = await req(A, 'POST', '/api/auth/login', null, { username: 'admin', password: DEV_NEW_PASS });
  ok(loginANew.status === 200, 'device A accepts new password');
  CENTRAL_PASS = DEV_NEW_PASS;
  ct = loginCNew.body.token;
  at = loginANew.body.token;

  console.log('— scenario 2: TRUE offline — central down, device A keeps working —');
  stop('central');
  await sleep(400);
  const offCust = (await req(A, 'POST', '/api/customers', at, { biz: 'مشتری در قطعی' })).body;
  const offInv = (await req(A, 'POST', '/api/invoices', at, {
    cust_id: offCust.id, type: 'final', rows: [{ product_id: 1, qty: 5, price: 50000 }]
  })).body;
  ok(offCust.id >= 1e12 && offInv.id >= 1e12, `offline creates use provisional ids (${offCust.id}, ${offInv.id})`);
  ok(String(offInv.num).startsWith('موقت'), `offline invoice number provisional (${offInv.num})`);
  const syncFail = (await req(A, 'POST', '/api/sync/now', at)).body;
  ok(syncFail.ok === false, `sync while central down fails gracefully (${syncFail.error})`);
  let stA = (await req(A, 'GET', '/api/sync/status', at)).body;
  ok(stA.pending === 2 && stA.online === false, `2 ops queued, offline state reported`);

  console.log('— scenario 3: central returns; A syncs; chained refs resolve —');
  start('central', centralEnv);
  await sleep(2500);
  let syncOK = null, totalConfirmed = 0;
  for (let i = 0; i < 4; i++) {
    syncOK = (await req(A, 'POST', '/api/sync/now', at)).body;
    console.log(`   attempt ${i + 1}:`, JSON.stringify(syncOK));
    totalConfirmed += syncOK.confirmed || 0;
    if (syncOK.ok && syncOK.pending === 0 && !syncOK.conflicts) break;
    await sleep(1500);
  }
  ok(totalConfirmed === 2 || (syncOK.ok && syncOK.pending === 0), `sync after reconnect confirmed both ops (total ${totalConfirmed})`);
  const cInv = (await req(C, 'GET', '/api/invoices', ct)).body;
  // Match on pre-VAT subtotal (VAT-invariant): since accounting phase 3 the
  // `final` field includes default VAT, so it is no longer exactly 250000.
  const applied = cInv.find(i => i.subtotal === 250000);
  ok(applied && /^T-\d{4}$/.test(applied.num), `central assigned real number (${applied && applied.num})`);
  const cCust2 = (await req(C, 'GET', '/api/customers', ct)).body.find(c => c.biz === 'مشتری در قطعی');
  ok(cCust2 && applied.cust_id === cCust2.id, 'chained provisional customer ref translated');
  const aInvAfter = (await req(A, 'GET', '/api/invoices', at)).body;
  ok(aInvAfter.every(i => i.id < 1e12) && aInvAfter.some(i => i.num === applied.num), 'A converged to central rows');

  console.log('— scenario 4: concurrent invoices from A and B → unique numbers —');
  const abCust = (await req(A, 'GET', '/api/customers', at)).body.find(c => c.biz === 'مشتری مشترک');
  await req(A, 'POST', '/api/invoices', at, { cust_id: abCust.id, type: 'final', rows: [{ product_id: 1, qty: 1, price: 50000 }] });
  await req(B, 'POST', '/api/invoices', bt, { cust_id: abCust.id, type: 'final', rows: [{ product_id: 1, qty: 2, price: 50000 }] });
  await req(A, 'POST', '/api/sync/now', at);
  await req(B, 'POST', '/api/sync/now', bt);
  // B has now pulled the password/auth_epoch changed through device A; its
  // old local session is correctly revoked and must be renewed.
  const loginBNew = await req(B, 'POST', '/api/auth/login', null, { username: 'admin', password: CENTRAL_PASS });
  ok(loginBNew.status === 200 && !!loginBNew.body.token, 'device B re-authenticates after password epoch reaches it');
  bt = loginBNew.body.token;
  const nums = (await req(C, 'GET', '/api/invoices', ct)).body.map(i => i.num);
  ok(new Set(nums).size === nums.length, `all invoice numbers unique: ${nums.join(', ')}`);

  console.log('— scenario 5: central edit + tombstoned delete propagate to devices —');
  await req(C, 'PUT', `/api/customers/${custC.id}`, ct, { biz: 'مشتری مشترک (ویرایش مرکزی)' });
  const fu = (await req(C, 'GET', '/api/followups', ct)).body.find(f => f.subject === 'برای حذف');
  await req(C, 'DELETE', `/api/followups/${fu.id}`, ct);
  await req(A, 'POST', '/api/sync/now', at);
  await req(B, 'POST', '/api/sync/now', bt);
  const aC = (await req(A, 'GET', '/api/customers', at)).body.find(c => c.id === custC.id);
  const bFu = (await req(B, 'GET', '/api/followups', bt)).body;
  ok(aC && aC.biz.includes('ویرایش مرکزی'), 'central edit reached device A');
  ok(!bFu.some(f => f.id === fu.id), 'tombstoned delete reached device B');

  console.log('— scenario 6: version conflict — A edits stale row, central edited meanwhile —');
  // A is currently in sync. Central edits the customer; then A (without pulling) edits the same customer.
  await req(C, 'PUT', `/api/customers/${custC.id}`, ct, { biz: 'نام مرکزی جدیدتر' });
  const aEdit = await req(A, 'PUT', `/api/customers/${custC.id}`, at, { biz: 'نام از دستگاه A' });
  ok(aEdit.status === 200, 'A local edit applied locally');
  const pushRes = (await req(A, 'POST', '/api/sync/now', at)).body;
  const conflictsA = (await req(A, 'GET', '/api/sync/conflicts', at)).body;
  ok(conflictsA.some(c => c.method === 'PUT' && c.path.includes('/customers/')), 'concurrent edit flagged as conflict (not last-write-wins)');
  const cName = (await req(C, 'GET', '/api/customers', ct)).body.find(c => c.id === custC.id).biz;
  ok(cName === 'نام مرکزی جدیدتر', `central kept its newer value (${cName})`);
  // discard on A → row restored to central state
  const cid = conflictsA.find(c => c.method === 'PUT').id;
  await req(A, 'POST', `/api/sync/conflicts/${cid}/discard`, at);
  const aName = (await req(A, 'GET', '/api/customers', at)).body.find(c => c.id === custC.id).biz;
  ok(aName === 'نام مرکزی جدیدتر', 'discard restored central value on A');

  console.log('— scenario 7: oversell conflict (STALE local stock) + idempotent retry —');
  // B pulls while stock is high, THEN central stock drops without B knowing.
  await req(B, 'POST', '/api/sync/now', bt);
  const bStale = (await req(B, 'GET', '/api/products', bt)).body.find(p => p.code === 'M-1').stock;
  await req(C, 'PATCH', '/api/products/1/stock', ct, { stock: 1 });
  // B, seeing the stale higher stock, sells more than central now has:
  const oversellQty = Math.min(bStale, 5);
  const bInv = (await req(B, 'POST', '/api/invoices', bt, { cust_id: abCust.id, type: 'final', rows: [{ product_id: 1, qty: oversellQty, price: 50000 }] })).body;
  if (!(bInv.id >= 1e12)) console.log('   bInv response:', JSON.stringify(bInv));
  ok(bInv.id >= 1e12, `B created invoice locally against stale stock ${bStale} (qty ${oversellQty})`);
  await req(B, 'POST', '/api/sync/now', bt);
  await req(B, 'POST', '/api/sync/now', bt); // idempotent retry
  const confB = (await req(B, 'GET', '/api/sync/conflicts', bt)).body;
  ok(confB.length === 1 && confB[0].reason.includes('کافی نیست'), `oversell flagged exactly once (${confB[0] && confB[0].reason})`);
  const cStock = (await req(C, 'GET', '/api/products', ct)).body.find(p => p.code === 'M-1').stock;
  ok(cStock === 1, `central stock untouched by conflicted op (${cStock})`);
  // cleanup: discard so final balance checks run on a conflict-free state
  await req(B, 'POST', `/api/sync/conflicts/${confB[0].id}/discard`, bt);
  const confB2 = (await req(B, 'GET', '/api/sync/conflicts', bt)).body;
  ok(confB2.length === 0, 'discard cleared the conflict on B');

  console.log('— scenario 8: device credential lifecycle —');
  const devicesBefore = await req(C, 'GET', '/api/sync/devices', ct);
  const deviceB = devicesBefore.body.find(d => d.name.includes('B'));
  ok(deviceB && deviceB.token_expires_at > Math.floor(Date.now() / 1000), 'paired token has a server-side expiry');
  ok(!devicesBefore.body.some(d => d.token_hash || d.device_token), 'device listing never exposes token material');
  const rotated = await req(C, 'POST', `/api/sync/devices/${deviceB.id}/rotate-token`, ct, {});
  ok(rotated.status === 200 && rotated.body.device_token && rotated.body.token_expires_at, 'admin can rotate device token');
  const staleTokenSync = (await req(B, 'POST', '/api/sync/now', bt)).body;
  ok(staleTokenSync.ok === false, 'old device token is blocked immediately after rotation');
  const deactivated = await req(C, 'POST', `/api/sync/devices/${deviceB.id}/deactivate`, ct, {});
  ok(deactivated.status === 200, 'admin can revoke paired device');
  const revokedSync = (await req(B, 'POST', '/api/sync/now', bt)).body;
  ok(revokedSync.ok === false, 'revoked device is blocked on its next sync');

  console.log('— final: books balanced on central —');
  const tb = (await req(C, 'GET', '/api/accounting/trial-balance', ct)).body;
  const bs = (await req(C, 'GET', '/api/accounting/balance-sheet', ct)).body;
  ok(tb.balanced, `Trial Balance balanced (D=${tb.totalDebit} C=${tb.totalCredit})`);
  ok(bs.balanced, `Balance Sheet balanced (assets=${bs.totalAssets})`);

  console.log(`\n${failed === 0 ? '🎉' : '💥'} ${passed} passed, ${failed} failed`);
  for (const n of Object.keys(procs)) stop(n);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); for (const n of Object.keys(procs)) stop(n); process.exit(1); });
