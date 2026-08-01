'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-drill-'));
process.env.DB_PATH = path.join(root, 'source.db');
process.env.UPLOADS_DIR = path.join(root, 'uploads');
process.env.PRIVATE_UPLOADS_DIR = path.join(root, 'private');
process.env.BACKUP_DIR = path.join(root, 'backups');
process.env.BACKUP_OFFSITE_DIR = path.join(root, 'offsite');
process.env.BACKUP_ALLOW_SAME_DEVICE = '1';
process.env.BACKUP_PASSWORD = 'isolated-drill-password-123';
process.env.JWT_SECRET = 'isolated-drill-jwt-secret-123456789012345';
process.env.DATA_ENCRYPTION_KEY = 'isolated-data-key-32-bytes-minimum!!';

const { initDB, getDB } = require('../db');
const {
  runBackup, decryptFile, verifyBackupPackage, restoreBackup, sameFilesystemDevice,
} = require('../backup');
const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');

let step = 0;
function ok(msg) {
  step += 1;
  console.log(`  ✅ ${step}. ${msg}`);
}

(async () => {
  initDB();
  const db = getDB();
  const before = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  fs.mkdirSync(path.join(root, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(root, 'uploads', 'probe.txt'), 'public-upload');
  fs.mkdirSync(path.join(root, 'private', 'messages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'private', 'messages', 'secret.bin'), 'private-bytes');
  ok(`seed users=${before}`);

  const result = await runBackup();
  if (!result.ok || !result.encrypted || result.integrity !== 'ok') throw new Error(JSON.stringify(result));
  ok('encrypted backup + integrity_check');

  const expected = require('crypto').createHash('sha256').update(fs.readFileSync(result.path)).digest('hex');
  if (expected !== result.checksum || !fs.existsSync(result.path + '.sha256')) throw new Error('checksum mismatch');
  ok('sha256 sidecar matches');

  if (!result.offsite || !result.offsite.ok || result.offsite.method !== 'fs') {
    throw new Error('offsite fs mirror missing: ' + JSON.stringify(result.offsite));
  }
  ok('off-site filesystem mirror + checksum');

  const verified = verifyBackupPackage(result.offsite.target);
  if (!verified.ok || verified.restore_applied) throw new Error(JSON.stringify(verified));
  ok('verifyBackupPackage from offsite (no mutate)');

  // Tamper fails closed
  const bad = path.join(root, 'tampered.enc');
  const buf = Buffer.from(fs.readFileSync(result.path));
  buf[buf.length - 5] ^= 0xff;
  fs.writeFileSync(bad, buf);
  let tamperRejected = false;
  try { verifyBackupPackage(bad); } catch { tamperRejected = true; }
  if (!tamperRejected) throw new Error('tamper not rejected');
  ok('tampered package rejected');

  // Online restore API contract: restoreBackup without confirm throws
  let onlineBlocked = false;
  try { restoreBackup(result.path); } catch (e) {
    onlineBlocked = /confirmOfflineRestore|online restore disabled/i.test(String(e.message));
  }
  if (!onlineBlocked) throw new Error('online restore not blocked');
  ok('live restore requires explicit offline confirmation');

  // Same-device guard exists (helper)
  ok(`same-device helper=${sameFilesystemDevice(process.env.BACKUP_DIR, process.env.BACKUP_OFFSITE_DIR)}`);

  const zipPath = path.join(root, 'drill-from-offsite.zip');
  decryptFile(result.offsite.target, zipPath, process.env.BACKUP_PASSWORD);
  const extract = path.join(root, 'extract-offsite');
  new AdmZip(zipPath).extractAllTo(extract, true);
  if (!fs.existsSync(path.join(extract, 'private-uploads', 'messages', 'secret.bin'))) {
    throw new Error('private uploads missing from package');
  }
  ok('private-uploads packaged');
  const restored = new Database(path.join(extract, 'crm.db'), { readonly: true });
  const integrity = restored.pragma('integrity_check', { simple: true });
  const after = restored.prepare('SELECT COUNT(*) c FROM users').get().c;
  restored.close();
  if (integrity !== 'ok' || before !== after) throw new Error(`restore verification failed: ${integrity} ${before}/${after}`);
  ok('extract integrity + users fingerprint');

  const localSum = fs.readFileSync(result.path + '.sha256', 'utf8').trim().split(/\s+/)[0];
  const remoteSum = fs.readFileSync(result.offsite.target + '.sha256', 'utf8').trim().split(/\s+/)[0];
  if (localSum !== remoteSum || localSum !== result.checksum) throw new Error('sha256 files diverge');
  ok('local/offsite sha256 agreement');

  console.log(`backup DR drill: ${step}/${step} pass; users=${before}; method=fs; sha256=${result.checksum.slice(0, 16)}…`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
