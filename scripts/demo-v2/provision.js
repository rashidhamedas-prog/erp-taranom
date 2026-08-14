#!/usr/bin/env node
'use strict';
/**
 * Create an isolated interactive-demo root. Does not start the server.
 *
 *   node scripts/demo-v2/provision.js <absolute-demo-root>
 *
 * Writes .erp-demo-root, secrets/credentials.json (0600), secrets/demo.env (0600).
 * NEVER commit demo.env.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  MARKER_NAME,
  assertAbsolute,
  assertNotForbiddenRoot,
  tryRealpath,
} = require('../../server/lib/demo-paths');

function generatePassword() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const all = letters + digits;
  const bytes = crypto.randomBytes(18);
  let s = '';
  for (let i = 0; i < 14; i++) s += all[bytes[i] % all.length];
  if (!/[A-Za-z]/.test(s)) s = `A${s.slice(1)}`;
  if (!/\d/.test(s)) s = `${s.slice(0, -1)}7`;
  return s;
}

function validatePresenterPassword(raw) {
  const p = String(raw || '');
  if (p.length < 10) return 'ERP_DEMO_SEED_PASSWORD must be at least 10 characters';
  if (p.length > 128) return 'ERP_DEMO_SEED_PASSWORD is too long';
  if (!/[A-Za-z\u0600-\u06FF]/.test(p) || !/\d/.test(p)) {
    return 'ERP_DEMO_SEED_PASSWORD must include a letter and a digit';
  }
  if (/^(demo1234|admin123)$/i.test(p)) return 'ERP_DEMO_SEED_PASSWORD rejects a well-known password';
  return null;
}

function writeSecretsFile(root, payload) {
  const dir = path.join(root, 'secrets');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'credentials.json');
  const tmp = path.join(dir, `.credentials.${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* windows */ }
  fs.renameSync(tmp, dest);
  try { fs.chmodSync(dest, 0o600); } catch { /* windows */ }
  return dest;
}

function writeAtomic(filePath, contents, mode = 0o600) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, contents, { mode });
  try { fs.chmodSync(tmp, mode); } catch { /* windows */ }
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, mode); } catch { /* windows */ }
}

function envLine(key, value) {
  const v = String(value == null ? '' : value);
  if (/[\r\n]/.test(v)) throw new Error(`${key} contains a newline`);
  if (/[\s#"']/.test(v) || v.includes('=')) return `${key}="${v.replace(/"/g, '\\"')}"`;
  return `${key}=${v}`;
}

function main() {
  const arg = process.argv[2] || process.env.ERP_DEMO_ROOT;
  if (!arg) {
    console.error('usage: node scripts/demo-v2/provision.js <absolute-demo-root>');
    process.exit(2);
  }
  const rootAbs = assertAbsolute('ERP_DEMO_ROOT', arg);
  fs.mkdirSync(rootAbs, { recursive: true });
  const rootReal = tryRealpath(rootAbs) || rootAbs;
  assertNotForbiddenRoot(rootReal);

  const instanceId = (process.env.ERP_DEMO_INSTANCE_ID || '').trim()
    || `demo-v2-${crypto.randomBytes(8).toString('hex')}`;
  if (instanceId.length < 8 || instanceId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(instanceId)) {
    throw new Error('ERP_DEMO_INSTANCE_ID is invalid');
  }

  const expiresAt = (process.env.ERP_DEMO_EXPIRES_AT || '').trim()
    || new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
  const jwtRaw = String(process.env.ERP_DEMO_JWT_SECRET || '').trim();
  const jwt = jwtRaw && jwtRaw.length >= 32 && !/^(demo-seed-secret|laptop-demo-secret)$/i.test(jwtRaw)
    ? jwtRaw
    : crypto.randomBytes(32).toString('hex');
  const resetRaw = String(process.env.ERP_DEMO_RESET_TOKEN || '').trim();
  const resetToken = resetRaw.length >= 32 ? resetRaw : crypto.randomBytes(32).toString('hex');

  let presenter = String(process.env.ERP_DEMO_SEED_PASSWORD || '').trim();
  if (presenter) {
    const err = validatePresenterPassword(presenter);
    if (err) throw new Error(err);
  } else {
    presenter = generatePassword();
  }

  for (const dir of ['data', 'uploads', 'companies', 'private-uploads', 'backups', 'tmp', 'logs', 'secrets']) {
    fs.mkdirSync(path.join(rootReal, dir), { recursive: true });
  }

  writeAtomic(path.join(rootReal, MARKER_NAME), `${instanceId}\n`, 0o644);

  const dbPath = path.join(rootReal, 'data', 'demo.db');
  const secretsPath = writeSecretsFile(rootReal, {
    generated_at: new Date().toISOString(),
    instance_id: instanceId,
    presenter_usernames: ['demo_manager', 'demo_accountant', 'demo_sales', 'demo_production'],
    presenter_password: presenter,
    bootstrap_admin_username: 'admin',
    bootstrap_admin_password: null,
    note: 'bootstrap_admin_password is filled after seed. Never print or commit this file.',
  });

  const envPath = path.join(rootReal, 'secrets', 'demo.env');
  const lines = [
    '# Interactive demo env — NEVER commit. Bind loopback by default.',
    '# Staging over a network must sit behind HTTPS (reverse proxy / TLS terminator).',
    '# Do not put a public IP in this file.',
    '# Offsite backup MUST stay unset: do not set BACKUP_S3_URI or BACKUP_OFFSITE_DIR.',
    '# JWT is generated here; parent-shell JWT_SECRET is never copied.',
    envLine('ERP_DEMO_MODE', 'true'),
    envLine('ERP_DEMO_ROOT', rootReal),
    envLine('ERP_DEMO_INSTANCE_ID', instanceId),
    envLine('ERP_DEMO_EXPIRES_AT', expiresAt),
    envLine('JWT_SECRET', jwt),
    envLine('ERP_DEMO_RESET_TOKEN', resetToken),
    envLine('ERP_DEMO_SEED_PASSWORD', presenter),
    envLine('DB_PATH', dbPath),
    envLine('UPLOADS_DIR', path.join(rootReal, 'uploads')),
    envLine('COMPANIES_DIR', path.join(rootReal, 'companies')),
    envLine('PRIVATE_UPLOADS_DIR', path.join(rootReal, 'private-uploads')),
    envLine('BACKUP_DIR', path.join(rootReal, 'backups')),
    envLine('AUTH_SESSION_DB_PATH', path.join(rootReal, 'auth-sessions.db')),
    envLine('LISTEN_HOST', process.env.ERP_DEMO_BIND_PUBLIC === 'true' ? (process.env.LISTEN_HOST || '127.0.0.1') : '127.0.0.1'),
    envLine('PORT', process.env.PORT || '3002'),
    envLine('SYNC_ROLE', 'central'),
    envLine('ERP_TEST_ISOLATION', '1'),
  ];
  if (process.env.ERP_DEMO_SALES_URL) lines.push(envLine('ERP_DEMO_SALES_URL', process.env.ERP_DEMO_SALES_URL));
  writeAtomic(envPath, lines.join('\n') + '\n', 0o600);

  console.log('demo root provisioned:', rootReal);
  console.log('env file:', envPath);
  console.log('credentials file:', secretsPath);
  console.log('next: node server/scripts/seed-demo.js', dbPath);
}

try {
  main();
} catch (e) {
  console.error('provision failed:', e.message || e);
  process.exit(1);
}
