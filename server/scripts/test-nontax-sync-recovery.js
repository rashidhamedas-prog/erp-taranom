// P0 sync recovery (nontax) — isolated device-role tests on a temp SQLite file.
//
//   node server/scripts/test-nontax-sync-recovery.js
//
// Covers (see NONTAX-P0-sync):
//   A. a failed first pull keeps pairing + pending outbox rows byte-for-byte (no wipe)
//   B. factory reset is fail-closed: device role + loopback peer + per-install secret,
//      static phrases refused, two-step prepare→commit with verified outbox backup,
//      challenge nonce, restore byte-for-byte
//   C. pulled rows/tombstones never overwrite a local row with a pending op (both
//      versions kept in sync_pull_conflicts), policies, idempotent replay, FK
//      integrity gate (paging-aware)
//
// Exit codes: 0 all pass, 1 failures, 2 SKIP (better-sqlite3 unavailable for this Node ABI).
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

// Loopback fetches must never go through a system VPN proxy.
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k];
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nontax-sync-recovery-'));
process.env.ERP_TEST_ISOLATION = '1';
process.env.DB_PATH = path.join(dir, 'device.db');
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.PRIVATE_UPLOADS_DIR = path.join(dir, 'private-uploads');
process.env.DEVICE_DATA_DIR = path.join(dir, 'data');
process.env.SYNC_ROLE = 'device';
process.env.JWT_SECRET = 'nontax-sync-recovery-test-secret-at-least-32-bytes';
delete process.env.DEVICE_RESET_SECRET;
delete process.env.SYNC_PULL_ORPHAN_CHECK;

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✅', label); }
  else { failed++; console.log('  ❌', label); }
}
function section(title) { console.log(`\n— ${title} —`); }
function finish() {
  console.log(`\nSUMMARY pass=${passed} fail=${failed} skip=0`);
  console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
  process.exit(failed ? 1 : 0);
}

// ---- better-sqlite3 availability (Node ABI) → SKIP, never a fake PASS ----
try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (e) {
  console.log('SKIP: better-sqlite3 failed to load for this Node runtime:', e && e.message);
  console.log('SUMMARY pass=0 fail=0 skip=1');
  console.log('RESULT: SKIP');
  process.exit(2);
}

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const client = require('../sync/client');
const { setSecret } = require('../sync/secure-kv');
const { generateReplaySigningKeyPair } = require('../sync/device-auth');
const syncRouter = require('../routes/sync');
const { SECRET } = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const express = require('express');

const kvSet = (k, v) => db.prepare('INSERT INTO sync_local_kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
const kvGet = k => { const r = db.prepare('SELECT value FROM sync_local_kv WHERE key=?').get(k); return r ? r.value : null; };
const outboxRows = () => db.prepare('SELECT * FROM sync_outbox ORDER BY id').all();
const sameRows = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const count = (tbl, where = '1=1', ...args) => db.prepare(`SELECT COUNT(*) c FROM ${tbl} WHERE ${where}`).get(...args).c;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function insertOutbox(fields) {
  const row = {
    method: 'PUT', path: '/api/customers/5', body_json: '{"biz":"local biz"}', user_id: 1, base_version: 0,
    entity_table: 'customers', entity_local_id: 5, captured_rows_json: '{}', has_file: 0, file_path: null,
    status: 'pending', replay_proof: 'sig-' + crypto.randomBytes(4).toString('hex'), ...fields,
  };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO sync_outbox (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map(c => row[c])).lastInsertRowid);
}
function adminId() { return db.prepare("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1").get().id; }
function adminToken() {
  const u = db.prepare('SELECT id,username,name,auth_epoch FROM users WHERE id=?').get(adminId());
  return jwt.sign({ id: u.id, username: u.username, role: 'admin', name: u.name, ae: Number(u.auth_epoch || 0) }, SECRET, { expiresIn: '5m' });
}

// ---- Mock central (loopback HTTP) ----
function listen(server) {
  return new Promise((resolve, reject) => server.listen(0, '127.0.0.1', err => (err ? reject(err) : resolve(server.address().port))));
}
async function startMockCentral() {
  const mock = { pullMode: 'fail', changes: [], pairCalls: 0, pullCalls: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      if (url.pathname === '/api/system/time') return send(200, { now: Date.now() });
      if (url.pathname === '/api/sync/pair' && req.method === 'POST') {
        mock.pairCalls++;
        return send(200, { device_id: 7, device_token: 'ab'.repeat(32), token_expires_at: Math.floor(Date.now() / 1000) + 86400 });
      }
      if (url.pathname === '/api/sync/pull') {
        mock.pullCalls++;
        if (mock.pullMode === 'fail') return send(500, { error: 'pull boom (simulated bootstrap failure)' });
        const since = Number(url.searchParams.get('since'));
        const changes = mock.changes.filter(c => c.seq > since);
        return send(200, { changes, next_since: changes.length ? changes[changes.length - 1].seq : since, has_more: false });
      }
      return send(404, { error: 'not found: ' + url.pathname });
    });
  });
  const port = await listen(server);
  mock.url = `http://127.0.0.1:${port}`;
  return { mock, server };
}

// ---- Device app (real router, loopback) ----
async function startDeviceApp() {
  const app = express();
  app.set('trust proxy', 1); // mirrors server.js — guard must still use the raw socket
  app.use(express.json());
  app.set('internalReplayToken', 'test-replay-token');
  app.use('/api/sync', syncRouter);
  const server = http.createServer(app);
  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}` };
}
async function call(base, method, p, { token, body, headers } = {}) {
  const r = await fetch(base + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token, 'x-internal-replay': 'test-replay-token' } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = s => { res.statusCode = s; return res; };
  res.json = b => { res.body = b; return res; };
  return res;
}
function runGuard(req) {
  const res = fakeRes();
  let nextCalled = false;
  syncRouter.factoryResetGuard({ headers: {}, ...req }, res, () => { nextCalled = true; });
  return { nextCalled, status: res.statusCode, code: res.body && res.body.code };
}

(async () => {
  const { mock, server: mockServer } = await startMockCentral();
  const { server: appServer, url: APP } = await startDeviceApp();
  const seeds = db.prepare("SELECT COUNT(*) c FROM users WHERE username='admin'").get().c;
  ok(seeds === 1, 'fresh device DB has the placeholder admin');

  // ======================================================================
  section('C. pull vs pending local edit — both versions kept');
  db.prepare("INSERT INTO customers (id,user_id,biz,owner,city,phone) VALUES (5,1,'local biz','o','c','p')").run();
  const pendingCustomerOp = insertOutbox({});
  const before = outboxRows();

  let r = client.applyChanges(db, [{ seq: 10, tbl: 'customers', row: { id: 5, user_id: 1, biz: 'remote biz', owner: 'o', city: 'c', phone: 'p', version: 3 } }], null);
  ok(r.held === 1 && r.applied === 0, 'remote replace of a row with a pending local op is held (not applied)');
  ok(db.prepare('SELECT biz FROM customers WHERE id=5').get().biz === 'local biz', 'local edit preserved — no last-writer-wins');
  let conflicts = client.listPullConflicts(db);
  ok(conflicts.length === 1 && conflicts[0].tbl === 'customers' && conflicts[0].row_key === '5', 'one open pull conflict recorded for customers:5');
  ok(conflicts[0].local && conflicts[0].local.biz === 'local biz' && conflicts[0].remote && conflicts[0].remote.biz === 'remote biz',
    'conflict row stores BOTH versions (local snapshot + remote row)');
  ok(conflicts[0].policy === 'keep_both' && conflicts[0].remote_kind === 'replace' && conflicts[0].reason === 'pending_local_op',
    'customers conflict policy = keep_both');
  ok(Array.isArray(conflicts[0].outbox_ids) && conflicts[0].outbox_ids.includes(pendingCustomerOp),
    'conflict references the protecting outbox op');

  client.applyChanges(db, [{ seq: 10, tbl: 'customers', row: { id: 5, user_id: 1, biz: 'remote biz', owner: 'o', city: 'c', phone: 'p', version: 3 } }], null);
  ok(client.listPullConflicts(db).length === 1, 'replaying the same remote change does not duplicate the conflict row');

  r = client.applyChanges(db, [{ seq: 11, tbl: 'customers', del: 5 }], null);
  ok(r.held === 1 && count('customers', 'id=5') === 1, 'remote tombstone does not delete a row with a pending local edit');
  conflicts = client.listPullConflicts(db);
  ok(conflicts.length === 1 && conflicts[0].remote_kind === 'delete' && conflicts[0].remote_seq === 11,
    'held tombstone updates the same open conflict (latest remote state, still one row)');

  // Clean pull: no pending op → applies, idempotent, deletable
  r = client.applyChanges(db, [{ seq: 12, tbl: 'customers', row: { id: 6, user_id: 1, biz: 'clean', owner: 'o', city: 'c', phone: 'p' } }], null);
  ok(r.applied === 1 && r.held === 0 && db.prepare('SELECT biz FROM customers WHERE id=6').get().biz === 'clean', 'clean pull with no pending op still applies');
  client.applyChanges(db, [{ seq: 13, tbl: 'customers', row: { id: 6, user_id: 1, biz: 'clean v2', owner: 'o', city: 'c', phone: 'p' } }], null);
  ok(count('customers', 'id=6') === 1 && db.prepare('SELECT biz FROM customers WHERE id=6').get().biz === 'clean v2', 're-applying a remote row stays idempotent (INSERT OR REPLACE)');
  client.applyChanges(db, [{ seq: 14, tbl: 'customers', del: 6 }], null);
  ok(count('customers', 'id=6') === 0, 'remote tombstone deletes a row without pending work');
  ok(client.listPullConflicts(db).length === 1, 'clean rows never create conflict entries');

  // Cascade: deleting a parent that would orphan a child carrying pending work is held
  db.prepare("INSERT INTO customers (id,user_id,biz,owner,city,phone) VALUES (7,1,'parent','o','c','p')").run();
  db.prepare("INSERT INTO followups (id,user_id,cust_id,date,subject) VALUES (70,1,7,'1405/01/01','local followup')").run();
  insertOutbox({ method: 'POST', path: '/api/followups', body_json: '{"cust_id":7}', entity_table: 'followups', entity_local_id: 70 });
  r = client.applyChanges(db, [{ seq: 15, tbl: 'customers', del: 7 }], null);
  ok(r.held === 1 && count('customers', 'id=7') === 1 && count('followups', 'id=70') === 1,
    'parent tombstone is held when a child row still carries a pending local op (no orphan created)');
  const cascade = client.listPullConflicts(db).find(c => c.tbl === 'customers' && c.row_key === '7');
  ok(cascade && cascade.reason === 'child_pending_local_op' && cascade.policy === 'keep_both', 'cascade hold recorded with reason child_pending_local_op');

  // Posted financial tables → reversal_required (still no overwrite)
  db.prepare("INSERT INTO journal_entries (id,entry_date,description,created_by) VALUES (100,'1405/01/01','local JE',1)").run();
  insertOutbox({ method: 'PUT', path: '/api/accounting/journal/100', body_json: '{}', entity_table: 'journal_entries', entity_local_id: 100 });
  r = client.applyChanges(db, [{ seq: 16, tbl: 'journal_entries', row: { id: 100, entry_date: '1405/01/02', description: 'remote JE', created_by: 1 } }], null);
  const jeConflict = client.listPullConflicts(db).find(c => c.tbl === 'journal_entries');
  ok(r.held === 1 && jeConflict && jeConflict.policy === 'reversal_required', 'journal_entries conflict policy = reversal_required');
  ok(db.prepare('SELECT description FROM journal_entries WHERE id=100').get().description === 'local JE', 'posted financial row not overwritten either');

  db.prepare("INSERT INTO invoices (id,user_id,cust_id,num,type) VALUES (200,1,5,'T-0200','final')").run();
  insertOutbox({ method: 'PUT', path: '/api/invoices/200', body_json: '{}', entity_table: 'invoices', entity_local_id: 200 });
  client.applyChanges(db, [{ seq: 17, tbl: 'invoices', row: { id: 200, user_id: 1, cust_id: 5, num: 'T-0200', type: 'final', note: 'remote' } }], null);
  const finalInv = client.listPullConflicts(db).find(c => c.tbl === 'invoices' && c.row_key === '200');
  ok(finalInv && finalInv.policy === 'reversal_required', 'final (posted) invoice conflict policy = reversal_required');

  db.prepare("INSERT INTO invoices (id,user_id,cust_id,num,type) VALUES (201,1,5,'P-0201','proforma')").run();
  insertOutbox({ method: 'PUT', path: '/api/invoices/201', body_json: '{}', entity_table: 'invoices', entity_local_id: 201 });
  client.applyChanges(db, [{ seq: 18, tbl: 'invoices', row: { id: 201, user_id: 1, cust_id: 5, num: 'P-0201', type: 'proforma', note: 'remote' } }], null);
  const draftInv = client.listPullConflicts(db).find(c => c.tbl === 'invoices' && c.row_key === '201');
  ok(draftInv && draftInv.policy === 'keep_both', 'proforma (draft) invoice conflict policy = keep_both');

  ok(client.pullConflictPolicy('invoices', { type: 'proforma' }, { type: 'final' }) === 'reversal_required', 'policy: remote-posted invoice → reversal_required');
  ok(client.pullConflictPolicy('invoices', { type: 'proforma', status: 'posted' }, { type: 'proforma', status: 'posted' }) === 'keep_both',
    'policy: R13 status=posted (default on every invoice, incl. proformas) does not make a draft firm → keep_both');
  ok(['crm_opportunities', 'inventory_movements', 'bom_lines', 'bom_headers', 'customers'].every(t => client.pullConflictPolicy(t, {}, {}) === 'keep_both'),
    'policy: CRM / inventory movements / BOM / customers → keep_both');
  ok(client.pullConflictPolicy('journal_lines', {}, {}) === 'reversal_required', 'policy: journal_lines → reversal_required');

  // FK integrity gate
  let threw = null;
  try {
    client.applyChanges(db, [{ seq: 50, tbl: 'journal_lines', row: { id: 900, entry_id: 99999, account_code: '1101', account_name: 'x', debit: 0, credit: 0 } }], null, { final: true });
  } catch (e) { threw = e; }
  ok(threw && threw.code === 'E_SYNC_PULL_ORPHAN', 'final page: child row whose parent is missing throws E_SYNC_PULL_ORPHAN');
  ok(count('journal_lines', 'id=900') === 0, 'orphan page rolled back (child row absent)');

  const ctx = client.createPullContext();
  threw = null;
  try {
    client.applyChanges(db, [{ seq: 51, tbl: 'journal_lines', row: { id: 901, entry_id: 777, account_code: '1101', account_name: 'x', debit: 0, credit: 0 } }], null, { final: false, ctx });
  } catch (e) { threw = e; }
  ok(!threw && count('journal_lines', 'id=901') === 1, 'non-final page: parent may still be in flight → applied, check deferred');
  threw = null;
  try {
    client.applyChanges(db, [{ seq: 52, tbl: 'journal_entries', row: { id: 777, entry_date: '1405/01/03', description: 'parent arrives later', created_by: 1 } }], null, { final: true, ctx });
  } catch (e) { threw = e; }
  ok(!threw && count('journal_entries', 'id=777') === 1, 'final page with the late parent passes the deferred reference check');

  db.prepare("INSERT INTO customers (id,user_id,biz,owner,city,phone) VALUES (8,1,'orphan parent','o','c','p')").run();
  db.prepare("INSERT INTO followups (id,user_id,cust_id,date,subject) VALUES (80,1,8,'1405/01/01','no outbox op')").run();
  threw = null;
  try { client.applyChanges(db, [{ seq: 53, tbl: 'customers', del: 8 }], null); } catch (e) { threw = e; }
  ok(threw && threw.code === 'E_SYNC_PULL_ORPHAN' && count('customers', 'id=8') === 1, 'parent delete that would leave an unprotected child behind throws and rolls back');

  const pulled = await call(APP, 'GET', '/api/sync/pull-conflicts', { token: adminToken() });
  ok(pulled.status === 200 && Array.isArray(pulled.body) && pulled.body.length >= 4 && pulled.body[0].local !== undefined,
    'GET /api/sync/pull-conflicts lists open conflicts with parsed versions');
  ok(client.getStatus().pull_conflicts === client.listPullConflicts(db).length, 'getStatus() exposes pull_conflicts count');
  ok(sameRows(before.filter(x => x.id === pendingCustomerOp), outboxRows().filter(x => x.id === pendingCustomerOp)), 'pending outbox row untouched by pulls');

  // ======================================================================
  section('B. factory reset authorization — fail closed');
  const secretFile = path.join(process.env.DEVICE_DATA_DIR, 'device-reset.secret');
  const outboxBeforeDenials = outboxRows();

  let res = await call(APP, 'POST', '/api/sync/factory-reset-device', { body: { confirm: 'RESET-DEVICE' } });
  ok(res.status === 400 && res.body.code === 'E_RESET_STATIC_PHRASE', 'legacy {confirm:RESET-DEVICE} is refused (400)');
  res = await call(APP, 'POST', '/api/sync/factory-reset-device/prepare', { body: { secret: 'wrong-secret' } });
  ok(res.status === 403 && res.body.code === 'E_RESET_SECRET_MISSING', 'no per-install secret yet → prepare fails closed (403)');

  const created = client.ensureDeviceResetSecret();
  ok(created.created === true && fs.existsSync(secretFile), 'per-install secret file minted (random, not in source)');
  const SECRET_VALUE = fs.readFileSync(secretFile, 'utf8').trim();
  ok(/^[a-f0-9]{64}$/.test(SECRET_VALUE), 'secret is 32 random bytes (hex)');
  ok(client.ensureDeviceResetSecret().created === false && fs.readFileSync(secretFile, 'utf8').trim() === SECRET_VALUE, 'ensureDeviceResetSecret is idempotent');

  res = await call(APP, 'POST', '/api/sync/factory-reset-device/prepare', { body: { secret: 'wrong-secret' } });
  ok(res.status === 403 && res.body.code === 'E_RESET_SECRET_INVALID', 'wrong secret → 403');
  res = await call(APP, 'POST', '/api/sync/factory-reset-device/prepare', { body: { secret: 'RESET-DEVICE' } });
  ok(res.status === 400 && res.body.code === 'E_RESET_STATIC_PHRASE', 'static phrase as secret → refused');
  res = await call(APP, 'POST', '/api/sync/factory-reset-device/prepare', { body: { secret: 'RESET' } });
  ok(res.status === 400 && res.body.code === 'E_RESET_STATIC_PHRASE', 'static phrase RESET → refused');
  res = await call(APP, 'POST', '/api/sync/factory-reset-device/prepare', { body: {} });
  ok(res.status === 403, 'missing secret → 403');
  res = await call(APP, 'POST', '/api/sync/factory-reset-device/commit', { body: { secret: 'wrong-secret', backup_id: 'x' } });
  ok(res.status === 403, 'commit with wrong secret → 403');
  res = await call(APP, 'POST', '/api/sync/reset-pairing', { body: { confirm: 'RESET' } });
  ok(res.status === 401, 'reset-pairing without admin session → 401');
  res = await call(APP, 'POST', '/api/sync/reset-pairing', { token: adminToken(), body: { confirm: 'RESET' } });
  ok(res.status === 400 && res.body.code === 'E_RESET_STATIC_PHRASE', 'admin session + legacy {confirm:RESET} is refused (400)');
  res = await call(APP, 'POST', '/api/sync/factory-reset-device/prepare', {
    body: { secret: SECRET_VALUE }, headers: { 'x-forwarded-for': '203.0.113.9' },
  });
  ok(res.status === 200 && res.body.wiped === false, 'loopback socket is what counts (spoofed X-Forwarded-For ignored); prepare returns wiped:false');

  ok(runGuard({ socket: { remoteAddress: '10.1.2.3' } }).code === 'E_RESET_PEER', 'guard: non-loopback peer → 403 E_RESET_PEER');
  ok(runGuard({ socket: { remoteAddress: '10.1.2.3' }, ip: '127.0.0.1', headers: { 'x-forwarded-for': '127.0.0.1' } }).code === 'E_RESET_PEER',
    'guard: X-Forwarded-For spoof of loopback is rejected (raw socket address used)');
  ok(['127.0.0.1', '::1', '::ffff:127.0.0.1'].every(a => runGuard({ socket: { remoteAddress: a } }).nextCalled), 'guard: all three loopback forms pass');
  ok(syncRouter.isLoopbackPeer({ socket: { remoteAddress: 'localhost' } }) === false, 'guard: hostname strings are not treated as loopback');
  process.env.SYNC_ROLE = 'central';
  ok(runGuard({ socket: { remoteAddress: '127.0.0.1' } }).code === 'E_RESET_ROLE', 'guard: central role → 403 E_RESET_ROLE even from loopback');
  process.env.SYNC_ROLE = 'device';
  ok(client.verifyDeviceResetSecret(SECRET_VALUE).ok === true && client.verifyDeviceResetSecret(SECRET_VALUE + 'x').ok === false
    && client.verifyDeviceResetSecret('').ok === false, 'verifyDeviceResetSecret: exact match only');
  ok(sameRows(outboxBeforeDenials, outboxRows()), 'outbox rows unchanged after all denied attempts');

  // ======================================================================
  section('B. authorized two-step reset with verified backup, then restore');
  const keys = generateReplaySigningKeyPair();
  kvSet('central_url', mock.url); kvSet('device_id', 7); kvSet('last_pull_seq', 5); kvSet('initial_sync_done', 1);
  setSecret(db, 'device_token', 'ab'.repeat(32));
  setSecret(db, 'device_signing_private_key', keys.privateKey);
  ok(client.isPaired(db), 'device considered paired for the reset scenario');
  insertOutbox({ status: 'confirmed', path: '/api/customers/5', method: 'PUT', body_json: '{"settled":true}' });
  const pendingBefore = outboxRows().filter(x => x.status === 'pending');
  const allBefore = outboxRows();
  ok(pendingBefore.length === 5, `scenario has ${pendingBefore.length} pending outbox ops`);

  const prep = await call(APP, 'POST', '/api/sync/factory-reset-device/prepare', { body: { secret: SECRET_VALUE } });
  ok(prep.status === 200 && prep.body.pending_count === pendingBefore.length && /^[a-f0-9]{64}$/.test(prep.body.backup_sha256) && /^ob-/.test(prep.body.backup_id),
    'prepare returns pending_count, backup_id, backup_sha256');
  ok(fs.existsSync(prep.body.backup_file) && crypto.createHash('sha256').update(fs.readFileSync(prep.body.backup_file)).digest('hex') === prep.body.backup_sha256,
    'backup file on disk hashes to the returned sha256');
  ok(fs.existsSync(prep.body.challenge_file), 'challenge file written on the device');
  ok(sameRows(allBefore, outboxRows()) && client.isPaired(db) && count('customers') > 0, 'prepare wipes nothing');
  const challengeNonce = JSON.parse(fs.readFileSync(prep.body.challenge_file, 'utf8')).nonce;
  ok(/^[a-f0-9]{64}$/.test(challengeNonce) && JSON.stringify(prep.body).indexOf(challengeNonce) === -1, 'nonce lives only in the file (not in the HTTP response)');

  const base = { secret: SECRET_VALUE, backup_id: prep.body.backup_id, backup_sha256: prep.body.backup_sha256, pending_count: prep.body.pending_count };
  res = await call(APP, 'POST', '/api/sync/factory-reset-device/commit', { body: { ...base } });
  ok(res.status === 403 && res.body.code === 'E_RESET_CHALLENGE_NONCE' && sameRows(allBefore, outboxRows()), 'commit without the challenge nonce → 403, nothing wiped');
  res = await call(APP, 'POST', '/api/sync/factory-reset-device/commit', { body: { ...base, challenge_nonce: challengeNonce, backup_sha256: 'f'.repeat(64) } });
  ok(res.status === 409 && res.body.code === 'E_RESET_BACKUP_SHA' && sameRows(allBefore, outboxRows()), 'commit with wrong backup sha → 409, nothing wiped');
  res = await call(APP, 'POST', '/api/sync/factory-reset-device/commit', { body: { ...base, challenge_nonce: challengeNonce, backup_sha256: undefined } });
  ok(res.status === 409 && sameRows(allBefore, outboxRows()), 'commit without backup sha → 409, nothing wiped');
  res = await call(APP, 'POST', '/api/sync/factory-reset-device/commit', { body: { ...base, challenge_nonce: challengeNonce, pending_count: 0 } });
  ok(res.status === 409 && res.body.code === 'E_RESET_PENDING_MISMATCH' && sameRows(allBefore, outboxRows()), 'commit with wrong pending_count echo → 409, nothing wiped');
  res = await call(APP, 'POST', '/api/sync/factory-reset-device/commit', { body: { ...base, challenge_nonce: challengeNonce, backup_id: 'ob-1700000000000-' + 'a'.repeat(16) } });
  ok(res.status === 404 && sameRows(allBefore, outboxRows()), 'commit with unknown backup id → 404, nothing wiped');
  const staleOp = insertOutbox({ path: '/api/customers/5', body_json: '{"late":"edit"}' });
  res = await call(APP, 'POST', '/api/sync/factory-reset-device/commit', { body: { ...base, challenge_nonce: challengeNonce } });
  ok(res.status === 409 && res.body.code === 'E_RESET_PENDING_MISMATCH', 'a new pending op after prepare blocks commit (backup would be incomplete)');
  db.prepare('DELETE FROM sync_outbox WHERE id=?').run(staleOp);

  res = await call(APP, 'POST', '/api/sync/factory-reset-device/commit', { body: { ...base, challenge_nonce: challengeNonce } });
  ok(res.status === 200 && res.body.ok === true && res.body.wiped === true && res.body.backup_id === prep.body.backup_id, 'fully authorized commit wipes the device');
  ok(outboxRows().length === 0 && !client.isPaired(db) && count('customers') === 0, 'outbox + syncable rows cleared, pairing removed');
  ok(db.prepare("SELECT COUNT(*) c FROM users WHERE username='admin' AND role='admin'").get().c === 1, 'placeholder admin restored');
  ok(!fs.existsSync(prep.body.challenge_file), 'challenge consumed (file removed)');
  res = await call(APP, 'POST', '/api/sync/factory-reset-device/commit', { body: { ...base, challenge_nonce: challengeNonce } });
  ok(res.status === 403 && res.body.code === 'E_RESET_CHALLENGE_MISSING', 'replaying the commit is refused (nonce single-use)');

  res = await call(APP, 'POST', '/api/sync/factory-reset-device/restore', { body: { secret: SECRET_VALUE, backup_id: prep.body.backup_id, backup_sha256: 'e'.repeat(64) } });
  ok(res.status === 409 && outboxRows().length === 0, 'restore with mismatching sha is refused');
  res = await call(APP, 'POST', '/api/sync/factory-reset-device/restore', { body: { secret: SECRET_VALUE, backup_id: prep.body.backup_id, backup_sha256: prep.body.backup_sha256 } });
  ok(res.status === 200 && res.body.restored === pendingBefore.length && res.body.skipped_settled === 1 && res.body.unsigned === pendingBefore.length,
    'restore re-queues every pending op (settled ops skipped); unsigned while unpaired');
  const restored = outboxRows();
  const byteFields = ['method', 'path', 'body_json', 'user_id', 'base_version', 'entity_table', 'entity_local_id', 'captured_rows_json', 'has_file', 'file_path', 'status', 'replay_file_hash', 'replay_file_field'];
  ok(restored.length === pendingBefore.length && pendingBefore.every((orig, i) => byteFields.every(f => (orig[f] ?? null) === (restored[i][f] ?? null))),
    'restored rows match the backup byte-for-byte on method/path/body_json/entity fields');
  res = await call(APP, 'POST', '/api/sync/factory-reset-device/restore', { body: { secret: SECRET_VALUE, backup_id: prep.body.backup_id } });
  ok(res.status === 200 && res.body.restored === 0 && res.body.skipped_existing === pendingBefore.length && outboxRows().length === pendingBefore.length,
    'restore is idempotent (no duplicate ops)');

  // ======================================================================
  section('A. fresh pairing + failed first pull keeps everything (no wipe)');
  fs.unlinkSync(secretFile);
  ok(!fs.existsSync(secretFile), 'reset secret removed to prove pairing never needs it');
  const outboxBeforePair = outboxRows();
  mock.pullMode = 'fail';
  const pairResult = await client.pair(mock.url, 'admin', 'central-admin-pass', 'nontax test device');
  ok(pairResult.ok === true && pairResult.device_id === 7 && pairResult.initial_sync === 'started', 'pair() succeeds on an empty device without the reset secret');
  let initial = await client.startInitialSyncAfterPair();
  if (initial && initial.ok === undefined) { await sleep(50); initial = await client.startInitialSyncAfterPair(); }
  ok(initial.ok === false && initial.retryable === true && initial.rolled_back === false, 'failed first pull → { ok:false, retryable:true, rolled_back:false }');
  ok(client.isPaired(db) && kvGet('device_id') === '7' && kvGet('central_url') === mock.url, 'pairing credentials kept after the failed first pull');
  ok(sameRows(outboxBeforePair, outboxRows()), 'pending outbox rows byte-for-byte identical after the failed first pull');
  ok(!fs.existsSync(secretFile), 'pairing did not require or create the reset secret');
  ok(kvGet('initial_sync_done') === null, 'initial sync still marked incomplete (retry pending)');
  const st = client.getStatus();
  ok(st.paired === true && st.pairing_broken === true && st.pairing_broken_reason === 'initial_sync_incomplete' && typeof st.last_error === 'string',
    'status reports the retryable condition without wiping');
  ok(mock.pullCalls >= 1, 'pull was attempted against central');

  // Second failure (still offline) → still no wipe
  initial = await client.startInitialSyncAfterPair();
  ok(initial.ok === false && initial.rolled_back === false && sameRows(outboxBeforePair, outboxRows()) && client.isPaired(db), 'repeated failures never trigger a wipe');

  // Central comes back → retry completes; outbox untouched; nothing was wiped
  mock.pullMode = 'ok';
  mock.changes = [
    { seq: 1, tbl: 'users', row: { id: 1, name: 'مدیر مرکزی', username: 'admin', password: '$2a$10$abcdefghijklmnopqrstuv', role: 'admin', active: 1 } },
    { seq: 2, tbl: 'customers', row: { id: 11, user_id: 1, biz: 'pulled biz', owner: 'o', city: 'c', phone: 'p' } },
  ];
  initial = await client.startInitialSyncAfterPair();
  ok(initial.ok === true && initial.users === 1, 'retry after connectivity returns completes the initial sync');
  ok(kvGet('initial_sync_done') === '1' && count('customers', 'id=11') === 1, 'pulled rows applied, initial_sync_done set');
  ok(sameRows(outboxBeforePair, outboxRows()), 'outbox rows still byte-for-byte identical after the successful retry (never wiped)');
  ok(db.prepare("SELECT name FROM users WHERE id=1").get().name === 'مدیر مرکزی' && count('users') === 1, 'placeholder admin replaced by the central admin (no extra wipe path)');

  const resetAfterPair = client.ensureDeviceResetSecret();
  ok(resetAfterPair.created === true, 'reset secret can be minted later on boot (pairing independent)');

  // ======================================================================
  section('B. legacy single-shot entry points never wipe');
  const outboxFinal = outboxRows();
  res = await call(APP, 'POST', '/api/sync/factory-reset-device', { body: { confirm: 'RESET-DEVICE' } });
  res = await call(APP, 'POST', '/api/sync/reset-pairing', { token: adminToken(), body: { confirm: 'RESET' } });
  ok(res.status === 400 && client.isPaired(db) && sameRows(outboxFinal, outboxRows()), 'after legacy calls: still paired, outbox intact');
  ok(syncRouter.RESET_ROUTES.length === 10, 'all reset entry points share the fail-closed guard list');

  mockServer.close();
  appServer.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
  finish();
})().catch(e => {
  console.error('UNEXPECTED', e && e.stack || e);
  failed++;
  finish();
});
