'use strict';
/**
 * P0-C policy: production must reject same-device offsite and require an off-server destination.
 * Does not need real S3 credentials — only enforces configuration gates.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-offsite-policy-'));

process.env.DB_PATH = path.join(root, 'source.db');
process.env.UPLOADS_DIR = path.join(root, 'uploads');
process.env.PRIVATE_UPLOADS_DIR = path.join(root, 'private');
process.env.BACKUP_DIR = path.join(root, 'backups');
process.env.BACKUP_PASSWORD = 'policy-drill-password-123456';
process.env.JWT_SECRET = 'policy-drill-jwt-secret-123456789012';
process.env.DATA_ENCRYPTION_KEY = 'policy-data-key-32-bytes-minimum!!!!';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'PolicyBootstrap#Admin1405!';
process.env.NODE_ENV = 'production';
delete process.env.BACKUP_S3_URI;
delete process.env.BACKUP_OFFSITE_DIR;
delete process.env.BACKUP_ALLOW_SAME_DEVICE;

const { initDB } = require('../db');
const { runBackup, sameFilesystemDevice } = require('../backup');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; console.log('  ✅', msg); }
  else { failed += 1; console.error('  ❌', msg); }
}

function failedOffsite(resultOrError) {
  const msg = resultOrError && resultOrError.message
    ? String(resultOrError.message)
    : JSON.stringify(resultOrError || {});
  return /BACKUP_S3_URI|BACKUP_OFFSITE_DIR|off-server|same device/i.test(msg);
}

(async () => {
  console.log('\n══ Backup offsite policy ══\n');
  initDB();

  let first;
  try {
    first = await runBackup();
  } catch (e) {
    first = e;
  }
  ok(failedOffsite(first) || (first && first.ok === false),
    'production without S3/OFFSITE must fail');

  process.env.BACKUP_OFFSITE_DIR = path.join(root, 'offsite-same');
  fs.mkdirSync(process.env.BACKUP_OFFSITE_DIR, { recursive: true });
  ok(sameFilesystemDevice(process.env.BACKUP_DIR, process.env.BACKUP_OFFSITE_DIR),
    'helper detects same device for local dirs');

  let second;
  try {
    second = await runBackup();
  } catch (e) {
    second = e;
  }
  ok(failedOffsite(second) || (second && second.ok === false),
    'same-device rejected in production');

  process.env.BACKUP_ALLOW_SAME_DEVICE = '1';
  const allowed = await runBackup();
  ok(!!allowed.ok && allowed.offsite?.ok, 'ALLOW_SAME_DEVICE=1 permits local drill');

  console.log(`\nOffsite policy: ${passed} passed, ${failed} failed`);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
