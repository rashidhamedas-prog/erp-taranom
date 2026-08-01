'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-secret-settings-'));
const JWT_SECRET = 'secret-settings-jwt-key-at-least-32-bytes';
const DATA_KEY_A = 'secret-settings-data-key-a-at-least-32-bytes';
const DATA_KEY_B = 'secret-settings-data-key-b-at-least-32-bytes';
const ADMIN_PASSWORD = 'SecretSettingsAdmin1405';
const ADMIN_PASSWORD_CHANGED = 'SecretSettingsChanged1405';
const SENTINEL = 'never-print-or-return-this-secret';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = JWT_SECRET;
process.env.DATA_ENCRYPTION_KEY = DATA_KEY_A;

const {
  ENVELOPE_PREFIX,
  encrypt,
  decrypt,
} = require('../services/crypto');
const {
  SECRET_MASK,
  getSetting,
  getPublicSettings,
  setSetting,
  updateSettings,
} = require('../lib/secret-settings');

let passed = 0;
function check(condition, label) {
  assert.ok(condition, label);
  passed += 1;
  console.log('  PASS', label);
}

function legacyEncrypt(plaintext) {
  const key = crypto.createHash('sha256').update(JWT_SECRET + ':secrets-at-rest').digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
}

function configProbe(env, deleteNames = []) {
  const childEnv = { ...process.env, ...env };
  for (const name of deleteNames) delete childEnv[name];
  return spawnSync(process.execPath, ['-e', "require('./services/crypto')"], {
    cwd: ROOT,
    env: childEnv,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function pureModuleTests() {
  console.log('Secret envelope and database storage');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare("INSERT INTO settings (key,value) VALUES ('company_name','Taranom')").run();

  setSetting(db, 'sms_api_key', SENTINEL);
  const stored = db.prepare("SELECT value FROM settings WHERE key='sms_api_key'").pluck().get();
  check(stored.startsWith(ENVELOPE_PREFIX), 'new secret uses a versioned AES-GCM envelope');
  check(!stored.includes(SENTINEL), 'database ciphertext contains no plaintext credential');
  check(decrypt(stored, 'setting:sms_api_key') === SENTINEL, 'encrypted setting round-trips with its bound purpose');

  const publicView = getPublicSettings(db);
  check(publicView.sms_api_key === SECRET_MASK && publicView.sms_api_key_has_value === true,
    'public/API-shaped response returns mask plus has_value');
  check(!JSON.stringify(publicView).includes(SENTINEL), 'public/API-shaped response contains no plaintext credential');
  check(publicView.company_name === 'Taranom', 'non-secret settings remain visible');

  updateSettings(db, [['sms_api_key', SECRET_MASK]], new Set(['sms_api_key']));
  check(db.prepare("SELECT value FROM settings WHERE key='sms_api_key'").pluck().get() === stored,
    'unchanged mask does not overwrite stored secret');
  updateSettings(db, [['sms_api_key', '   ']], new Set(['sms_api_key']));
  check(db.prepare("SELECT value FROM settings WHERE key='sms_api_key'").pluck().get() === stored,
    'blank browser value does not overwrite stored secret');

  const replacement = 'replacement-secret-value-at-least-one';
  setSetting(db, 'sms_api_key', replacement);
  const replacedStored = db.prepare("SELECT value FROM settings WHERE key='sms_api_key'").pluck().get();
  check(replacedStored !== stored && !replacedStored.includes(replacement), 'changed secret is re-encrypted with a fresh nonce');
  check(getSetting(db, 'sms_api_key') === replacement, 'internal consumer receives decrypted replacement');

  setSetting(db, 'sms_api_key', null);
  check(db.prepare("SELECT value FROM settings WHERE key='sms_api_key'").pluck().get() === '',
    'explicit null clears a stored secret');
  check(getPublicSettings(db, ['sms_api_key']).sms_api_key_has_value === false,
    'cleared secret reports has_value=false');

  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('ai_api_key',?)").run('legacy-plaintext-ai-key');
  check(getSetting(db, 'ai_api_key') === 'legacy-plaintext-ai-key', 'legacy plaintext opens once');
  const migratedPlain = db.prepare("SELECT value FROM settings WHERE key='ai_api_key'").pluck().get();
  check(migratedPlain.startsWith(ENVELOPE_PREFIX) && !migratedPlain.includes('legacy-plaintext-ai-key'),
    'legacy plaintext is transparently replaced by ciphertext');

  const legacyValue = 'legacy-jwt-derived-secret';
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('webhook_secret',?)").run(legacyEncrypt(legacyValue));
  check(getSetting(db, 'webhook_secret') === legacyValue, 'legacy JWT-derived AES-GCM envelope decrypts');
  const migratedLegacy = db.prepare("SELECT value FROM settings WHERE key='webhook_secret'").pluck().get();
  check(migratedLegacy.startsWith(ENVELOPE_PREFIX) && migratedLegacy !== legacyValue,
    'legacy JWT-derived envelope migrates to v2 with explicit data key');

  setSetting(db, 'website_wc_secret', 'tamper-target-secret');
  const valid = db.prepare("SELECT value FROM settings WHERE key='website_wc_secret'").pluck().get();
  const parts = valid.split(':');
  parts[4] = `${parts[4].slice(0, -1)}${parts[4].endsWith('A') ? 'B' : 'A'}`;
  db.prepare("UPDATE settings SET value=? WHERE key='website_wc_secret'").run(parts.join(':'));
  assert.throws(
    () => getSetting(db, 'website_wc_secret'),
    (error) => error && ['E_SECRET_DECRYPT_FAILED', 'E_SECRET_FORMAT'].includes(error.code),
  );
  passed += 1;
  console.log('  PASS tampered ciphertext fails closed');

  db.prepare("UPDATE settings SET value=? WHERE key='website_wc_secret'").run(valid);
  process.env.DATA_ENCRYPTION_KEY = DATA_KEY_B;
  assert.throws(
    () => getSetting(db, 'website_wc_secret'),
    (error) => error && error.code === 'E_SECRET_KEY_MISMATCH',
  );
  passed += 1;
  console.log('  PASS wrong data-encryption key fails closed');
  process.env.DATA_ENCRYPTION_KEY = DATA_KEY_A;

  const captured = [];
  const originals = [console.log, console.warn, console.error];
  console.log = (...args) => captured.push(args.join(' '));
  console.warn = (...args) => captured.push(args.join(' '));
  console.error = (...args) => captured.push(args.join(' '));
  try {
    setSetting(db, 'rubika_bot_token', SENTINEL);
    getPublicSettings(db, ['rubika_bot_token']);
  } finally {
    [console.log, console.warn, console.error] = originals;
  }
  check(!captured.join('\n').includes(SENTINEL), 'secret storage and redaction never log plaintext');

  db.close();

  console.log('Configuration boundary');
  check(configProbe({ NODE_ENV: 'production', JWT_SECRET }, ['DATA_ENCRYPTION_KEY']).status !== 0,
    'production import fails fast without DATA_ENCRYPTION_KEY');
  check(configProbe({ NODE_ENV: 'production', JWT_SECRET, DATA_ENCRYPTION_KEY: DATA_KEY_A }).status === 0,
    'production import accepts an explicit strong data key');
  check(configProbe({ NODE_ENV: 'production', JWT_SECRET, DATA_ENCRYPTION_KEY: 'short' }).status !== 0,
    'production import rejects a weak data key');
  check(configProbe({ NODE_ENV: 'test', JWT_SECRET }, ['DATA_ENCRYPTION_KEY']).status === 0,
    'test/development import retains JWT-derived migration compatibility');
}

async function request(base, method, route, body, token) {
  const response = await fetch(base + route, {
    method,
    headers: {
      ...(body == null ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}

async function waitForServer(child, base, getStderr = () => '') {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      const diagnostic = String(getStderr() || '').replaceAll(SENTINEL, '[REDACTED]').slice(-2000);
      throw new Error(`server exited early (${child.exitCode})${diagnostic ? `\n${diagnostic}` : ''}`);
    }
    try {
      const response = await fetch(base + '/api/system/time');
      if (response.ok) return;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('server readiness timeout');
}

async function apiTests() {
  console.log('Authenticated settings API redaction');
  const port = 4860 + crypto.randomInt(0, 100);
  const base = `http://127.0.0.1:${port}`;
  const dbPath = path.join(TMP, 'api.db');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      JWT_SECRET,
      DATA_ENCRYPTION_KEY: DATA_KEY_A,
      ALLOWED_ORIGINS: 'https://erp.secret-settings.test',
      PORT: String(port),
      LISTEN_HOST: '127.0.0.1',
      DB_PATH: dbPath,
      AUTH_SESSION_DB_PATH: path.join(TMP, 'sessions.db'),
      COMPANIES_DIR: path.join(TMP, 'companies'),
      UPLOADS_DIR: path.join(TMP, 'uploads'),
      PRIVATE_UPLOADS_DIR: path.join(TMP, 'private-uploads'),
      BACKUP_DIR: path.join(TMP, 'backups'),
      BOOTSTRAP_ADMIN_PASSWORD: ADMIN_PASSWORD,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    await waitForServer(child, base, () => stderr);
    let result = await request(base, 'POST', '/api/auth/login', {
      username: 'admin',
      password: ADMIN_PASSWORD,
      device_fingerprint: 'secret-settings-test',
      device_name: 'Secret Settings Test',
      device_kind: 'web',
    });
    check(result.status === 200 && !!result.data?.token, 'admin obtains an authenticated settings session');
    let token = result.data.token;
    if (result.data.must_change_password) {
      result = await request(base, 'POST', '/api/auth/change-password', {
        oldPass: ADMIN_PASSWORD,
        newPass: ADMIN_PASSWORD_CHANGED,
      }, token);
      check(result.status === 200, 'bootstrap admin completes mandatory password change');
      result = await request(base, 'POST', '/api/auth/login', {
        username: 'admin',
        password: ADMIN_PASSWORD_CHANGED,
        device_fingerprint: 'secret-settings-test',
        device_name: 'Secret Settings Test',
        device_kind: 'web',
      });
      check(result.status === 200 && !!result.data?.token, 'admin re-authenticates after password change');
      token = result.data.token;
    }

    result = await request(base, 'PUT', '/api/settings', {
      company_name: 'API Redaction Company',
      sms_api_key: SENTINEL,
      website_wc_secret: 'wc-secret-sentinel',
    }, token);
    check(result.status === 200,
      `settings API accepts secret update (status=${result.status}, code=${result.data?.code || 'none'})`);
    check(result.data?.sms_api_key === SECRET_MASK && result.data?.sms_api_key_has_value === true,
      'PUT response redacts the SMS key');
    check(!JSON.stringify(result.data).includes(SENTINEL) && !JSON.stringify(result.data).includes('wc-secret-sentinel'),
      'PUT response contains no submitted secret');

    result = await request(base, 'GET', '/api/settings', null, token);
    check(result.status === 200 && result.data?.company_name === 'API Redaction Company',
      'GET response preserves non-secret settings');
    check(result.data?.sms_api_key === SECRET_MASK && result.data?.website_wc_secret === SECRET_MASK,
      'GET response masks every stored credential');
    check(!JSON.stringify(result.data).includes(SENTINEL) && !JSON.stringify(result.data).includes('wc-secret-sentinel'),
      'GET response contains no plaintext credential');

    const rawDb = new Database(dbPath, { readonly: true });
    const rawBefore = rawDb.prepare("SELECT value FROM settings WHERE key='sms_api_key'").pluck().get();
    check(rawBefore.startsWith(ENVELOPE_PREFIX) && !rawBefore.includes(SENTINEL),
      'HTTP update persists ciphertext, not plaintext');
    rawDb.close();

    result = await request(base, 'PUT', '/api/settings', { sms_api_key: SECRET_MASK }, token);
    check(result.status === 200, 'masked form round-trip is accepted');
    result = await request(base, 'PUT', '/api/settings', { sms_api_key: '' }, token);
    check(result.status === 200, 'blank form round-trip is accepted without clearing');
    const verifyDb = new Database(dbPath, { readonly: true });
    const rawAfter = verifyDb.prepare("SELECT value FROM settings WHERE key='sms_api_key'").pluck().get();
    verifyDb.close();
    check(rawAfter === rawBefore, 'API mask and blank submissions preserve existing ciphertext');

    result = await request(base, 'GET', '/api/sms-module/provider', null, token);
    check(result.status === 200 && result.data?.sms_api_key === SECRET_MASK
      && result.data?.sms_api_key_has_value === true,
    'secondary SMS provider API also redacts the key');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode != null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 3000).unref();
    });
    if (stderr.includes(SENTINEL) || stderr.includes('wc-secret-sentinel')) {
      throw new Error('server stderr exposed a plaintext credential');
    }
  }
}

(async () => {
  try {
    pureModuleTests();
    await apiTests();
    console.log(`\nOK secret settings security: ${passed}/${passed} passed`);
  } catch (error) {
    console.error('\nFAIL secret settings security:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows child handle race */ }
  }
})();
