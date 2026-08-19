/**
 * HR-02 — secure user invitation
 * Run: node server/scripts/test-hr-invite.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-invite-'));
const dbFile = path.join(dir, 't.db');
try { fs.unlinkSync(dbFile); } catch (_) {}
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-hr-invite-secret-32-bytes-min';
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

delete require.cache[require.resolve('../db')];
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  OK', label); }
  else { fail++; console.log(' FAIL', label, extra || ''); }
}

const { hashInviteToken, INVITE_TTL_SEC } = require('../lib/user-invitations');
const { SYNCABLE_TABLES } = require('../sync/tables');

console.log('\n— schema + sync hygiene —');
const cols = db.prepare('PRAGMA table_info(user_invitations)').all().map((c) => c.name);
['id', 'person_id', 'token_hash', 'expires_at', 'used_at', 'invited_email', 'created_by', 'created_at']
  .forEach((c) => ok(cols.includes(c), 'column ' + c));
ok(!SYNCABLE_TABLES.some((t) => t.name === 'user_invitations'), 'user_invitations not in SYNCABLE_TABLES');
ok(db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === 'person_id'), 'users.person_id');

const { sanitizeLogPath, REDACTED } = require('../lib/observability');
ok(sanitizeLogPath('/api/auth/invite/HrInviteRawToken_TEST_abc123XYZ') === '/api/auth/invite/' + REDACTED
  && !sanitizeLogPath('/api/auth/invite/HrInviteRawToken_TEST_abc123XYZ').includes('HrInviteRawToken_TEST_abc123XYZ'),
  'access-log path redacts raw invite token');

(async () => {
  console.log('\n— HTTP invite flow —');
  const admin = db.prepare("SELECT id,username,role,name,phone,auth_epoch FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test',
    device_name: 'hr-invite-e2e',
    device_fingerprint: 'hr-invite-e2e-fp',
  }).token;

  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/users', require('../routes/user-invitations'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const BASE = `http://127.0.0.1:${port}`;

  async function api(method, p, body, withAuth) {
    const headers = { 'Content-Type': 'application/json' };
    if (withAuth) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(BASE + p, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  }

  const personId = db.prepare("INSERT INTO persons (name, phone) VALUES ('سارا مدعو','09120001111')").run().lastInsertRowid;

  const unauth = await api('POST', '/api/users/invitations', { person_id: personId }, false);
  ok(unauth.status === 401 || unauth.status === 403, 'create invite requires auth');

  const created = await api('POST', '/api/users/invitations', { person_id: personId }, true);
  ok(created.status === 200, 'create invite 200', created.status + ' ' + (created.data && created.data.error));
  const raw = created.data && created.data.token;
  ok(!!raw && raw.length >= 32, 'raw token returned once');
  ok(raw !== '12345' && raw !== 'admin123', 'token is not a known password');
  ok(created.data.invite_url === '/invite?token=' + encodeURIComponent(raw), 'invite_url path');
  const ttl = Number(created.data.expires_at) - Math.floor(Date.now() / 1000);
  ok(ttl > 70 * 3600 && ttl <= INVITE_TTL_SEC + 5, 'expiry default ~72h', String(ttl));

  const stored = db.prepare('SELECT * FROM user_invitations WHERE person_id=? ORDER BY id DESC').get(personId);
  ok(stored && stored.token_hash === hashInviteToken(raw), 'only sha256 hash stored');
  ok(stored.token_hash !== raw, 'raw token not persisted');
  ok(!JSON.stringify(created.data).includes(stored.token_hash) || created.data.token, 'response is token not dump');

  const lookup = await api('GET', '/api/auth/invite/' + encodeURIComponent(raw), undefined, false);
  ok(lookup.status === 200 && lookup.data.valid === true && lookup.data.status === 'valid', 'public lookup valid');
  ok(lookup.data.person_name === 'سارا مدعو', 'person name only');
  ok(!('phone' in lookup.data) && !('invited_email' in lookup.data) && !('token_hash' in lookup.data), 'no PII dump');

  const weak = await api('POST', '/api/auth/invite/' + encodeURIComponent(raw) + '/accept', {
    username: 'sara.invite', password: '12345',
  }, false);
  ok(weak.status === 400, 'reject weak password', String(weak.status));

  const accepted = await api('POST', '/api/auth/invite/' + encodeURIComponent(raw) + '/accept', {
    username: 'sara.invite', password: 'SaraInvite9',
  }, false);
  ok(accepted.status === 200 && accepted.data.ok === true, 'accept 200', accepted.status + ' ' + (accepted.data && accepted.data.error));
  ok(accepted.data.must_change_password === 0, 'must_change_password=0');
  const user = db.prepare('SELECT * FROM users WHERE username=?').get('sara.invite');
  ok(!!user, 'users row created');
  ok(user.must_change_password === 0, 'db must_change_password=0');
  ok(user.person_id === personId, 'users.person_id linked');
  ok(user.party_id == null || Number(user.party_id) > 0, 'party link optional/ok');
  ok(db.prepare('SELECT used_at FROM user_invitations WHERE id=?').get(stored.id).used_at > 0, 'marked used');

  const reuse = await api('POST', '/api/auth/invite/' + encodeURIComponent(raw) + '/accept', {
    username: 'sara.invite2', password: 'SaraInvite9',
  }, false);
  ok(reuse.status === 409 && reuse.data.code === 'E_INVITE_USED', 'reject reuse', String(reuse.status));
  const usedLookup = await api('GET', '/api/auth/invite/' + encodeURIComponent(raw), undefined, false);
  ok(usedLookup.data.status === 'used' && usedLookup.data.valid === false, 'lookup used');

  const person2 = db.prepare("INSERT INTO persons (name, phone) VALUES ('علی منقضی','09120002222')").run().lastInsertRowid;
  const created2 = await api('POST', '/api/users/invitations', { person_id: person2 }, true);
  ok(created2.status === 200, 'second invite 200');
  const raw2 = created2.data.token;
  const row2 = db.prepare('SELECT id FROM user_invitations WHERE token_hash=?').get(hashInviteToken(raw2));
  db.prepare('UPDATE user_invitations SET expires_at=? WHERE id=?').run(Math.floor(Date.now() / 1000) - 10, row2.id);
  const expiredGet = await api('GET', '/api/auth/invite/' + encodeURIComponent(raw2), undefined, false);
  ok(expiredGet.data.status === 'expired' && expiredGet.data.valid === false, 'lookup expired');
  const expiredAcc = await api('POST', '/api/auth/invite/' + encodeURIComponent(raw2) + '/accept', {
    username: 'ali.expired', password: 'AliExpired9',
  }, false);
  ok(expiredAcc.status === 410 && expiredAcc.data.code === 'E_INVITE_EXPIRED', 'reject expired', String(expiredAcc.status));
  ok(!db.prepare('SELECT id FROM users WHERE username=?').get('ali.expired'), 'expired accept created no user');

  const bogus = await api('GET', '/api/auth/invite/' + crypto.randomBytes(16).toString('hex'), undefined, false);
  ok(bogus.data.status === 'invalid' && !bogus.data.person_name, 'unknown token invalid without name');

  await new Promise((resolve) => server.close(resolve));
  console.log('\n' + (fail ? `❌ ${fail} failed, ${pass} passed` : `🎉 ${pass} passed, 0 failed`));
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
