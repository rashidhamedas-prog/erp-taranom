'use strict';

/**
 * W2-M1 / P1-M1 — license & entitlement smoke test.
 * Generates an ephemeral Ed25519 keypair (never committed), signs a fixture,
 * activates, forces expiry → readonly, then deactivates.
 *
 * Run: node server/scripts/test-license.js
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-license-'));
const dbFile = path.join(dir, 'license-test.db');
try { fs.unlinkSync(dbFile); } catch (_) {}

process.env.NODE_ENV = 'test';
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'license-test-jwt-secret-at-least-32-bytes!!';

delete require.cache[require.resolve('../db')];

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

const { signLicenseDocument, verifyLicenseDocument } = require('../lib/license/verify');
const {
  normalizeClaims,
  evaluateLicenseState,
  setPublicKey,
  touchLastSeen,
  checkClockRollback,
  getLicenseStatus,
} = require('../lib/license/claims');
const { licenseGuard } = require('../lib/license/middleware');

let passed = 0;
function check(cond, label) {
  assert.ok(cond, label);
  passed += 1;
  console.log('  PASS', label);
}

console.log('\n— schema —');
check(!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='licenses'").get(),
  'licenses table exists');
check(!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='license_activations'").get(),
  'license_activations table exists');
const syncNames = require('../sync/tables').SYNCABLE_TABLES.map((t) => t.name);
check(!syncNames.includes('licenses') && !syncNames.includes('license_activations'),
  'license tables are central-only (not in SYNCABLE_TABLES)');

console.log('\n— ephemeral Ed25519 sign/verify —');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
setPublicKey(db, publicPem);

const futureExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const claims = normalizeClaims({
  v: 1,
  license_uid: 'LIC-TEST-' + crypto.randomBytes(4).toString('hex'),
  customer: 'پوشاک تست ترنم',
  edition: 'workshop',
  max_users: 10,
  max_devices: 3,
  expiry: futureExpiry,
  grace_days: 7,
  feature_flags: { module_production: true },
  issued_at: new Date().toISOString(),
});

const doc = signLicenseDocument(claims, privateKey);
const verified = verifyLicenseDocument(doc, publicPem);
check(verified.ok === true, 'signed fixture verifies with public key');
check(verified.claims.customer === claims.customer, 'claims round-trip customer');

const bad = { ...doc, signature: 'AAAA' + String(doc.signature).slice(4) };
check(verifyLicenseDocument(bad, publicPem).ok === false, 'tampered signature rejected');

console.log('\n— evaluate states —');
const valid = evaluateLicenseState(claims, new Date());
check(valid.mode === 'valid' && valid.readonly === false, 'fresh license → valid');

const inGrace = evaluateLicenseState(
  { ...claims, expiry: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), grace_days: 7 },
  new Date()
);
check(inGrace.mode === 'grace' && inGrace.readonly === false, 'within grace → not readonly');

const pastGrace = evaluateLicenseState(
  { ...claims, expiry: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(), grace_days: 7 },
  new Date()
);
check(pastGrace.mode === 'readonly' && pastGrace.readonly === true, 'past grace → readonly');

console.log('\n— HTTP activate / status / readonly / deactivate —');
db.prepare('UPDATE users SET must_change_password=0 WHERE username=?').run('admin');
const admin = db.prepare("SELECT id,username,role,name,phone,auth_epoch FROM users WHERE username='admin'").get();
check(!!admin, 'admin user exists after initDB');
const { issueStaffSession } = require('../lib/auth-sessions');
const token = issueStaffSession(db, admin, {
  device_kind: 'test',
  device_name: 'license-e2e',
  device_fingerprint: 'license-e2e-fp',
}).token;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api', licenseGuard);
app.use('/api/license', require('../routes/license'));
// Dummy mutating endpoint to prove readonly blocks writes.
app.post('/api/customers', (req, res) => res.json({ ok: true, echo: req.body }));
app.get('/api/customers', (req, res) => res.json([{ id: 1 }]));

const server = http.createServer(app);
const listen = () => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = () => new Promise((resolve) => server.close(resolve));

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = text; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  await listen();

  const act = await request('POST', '/api/license/activate', {
    license: doc,
    device_fingerprint: 'device-a',
    public_key: publicPem,
  });
  check(act.status === 200 && act.body.ok === true, 'activate returns ok');
  check(act.body.mode === 'valid', 'activate mode=valid');
  check(act.body.license_uid === claims.license_uid, 'activate license_uid matches');

  const st = await request('GET', '/api/license/status');
  check(st.status === 200 && st.body.active === true, 'status shows active license');
  check(st.body.activations_active >= 1, 'at least one device activation');

  const writeOk = await request('POST', '/api/customers', { name: 'x' });
  check(writeOk.status === 200, 'mutating API allowed while license valid');

  // Force expiry past grace in DB (signature already verified at activate).
  const expiredAt = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE licenses SET expiry=?, grace_days=7 WHERE license_uid=?')
    .run(expiredAt, claims.license_uid);
  const forced = getLicenseStatus(db, new Date());
  check(forced.readonly === true && forced.mode === 'readonly', 'status readonly after forced expiry');

  const blocked = await request('POST', '/api/customers', { name: 'y' });
  check(blocked.status === 403 && blocked.body.code === 'license_readonly',
    'mutating API blocked in readonly safe mode');

  const readOk = await request('GET', '/api/customers');
  check(readOk.status === 200, 'GET still allowed in readonly (data not deleted)');

  const licenseStillWritable = await request('POST', '/api/license/deactivate', {});
  check(licenseStillWritable.status === 200 && licenseStillWritable.body.ok === true,
    'deactivate allowed while readonly');

  const after = getLicenseStatus(db, new Date());
  check(after.active === false && after.mode === 'none', 'no active license after deactivate');

  const writeAgain = await request('POST', '/api/customers', { name: 'z' });
  check(writeAgain.status === 200, 'mutating API allowed again with no active license');

  console.log('\n— clock rollback guard —');
  const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
  touchLastSeen(db, future);
  const rolled = checkClockRollback(db, new Date());
  check(rolled.ok === false && rolled.code === 'clock_rollback',
    'system time << last_seen rejected');
  // Restore watermark so leftover DB is sane.
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('license_last_seen_at',?)")
    .run(new Date().toISOString());

  // Re-activate briefly then ensure no crash on status
  const doc2 = signLicenseDocument({
    ...claims,
    license_uid: claims.license_uid + '-2',
    expiry: futureExpiry,
  }, privateKey);
  const act2 = await request('POST', '/api/license/activate', {
    license: doc2,
    device_fingerprint: 'device-b',
  });
  check(act2.status === 200, 'second activate does not crash');
  await request('POST', '/api/license/deactivate', {});

  await close();
  console.log(`\n✅ test-license.js: ${passed} assertions passed`);
  process.exit(0);
})().catch((err) => {
  console.error('\n❌ test-license.js FAILED:', err);
  try { server.close(); } catch (_) {}
  process.exit(1);
});
