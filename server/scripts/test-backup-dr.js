'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-drill-'));
process.env.DB_PATH = path.join(root, 'source.db');
process.env.UPLOADS_DIR = path.join(root, 'uploads');
process.env.BACKUP_DIR = path.join(root, 'backups');
process.env.BACKUP_OFFSITE_DIR = path.join(root, 'offsite');
process.env.BACKUP_PASSWORD = 'isolated-drill-password-123';
process.env.JWT_SECRET = 'isolated-drill-jwt-secret-123456789012345';
const { initDB, getDB } = require('../db');
const { runBackup, decryptFile } = require('../backup');
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
  if (!fs.existsSync(result.offsite.target) || !fs.existsSync(result.offsite.target + '.sha256')) {
    throw new Error('offsite files missing');
  }
  ok('off-site filesystem mirror + checksum');

  // Restore drill from the *offsite* copy (simulates second location / RTO path)
  const zipPath = path.join(root, 'drill-from-offsite.zip');
  decryptFile(result.offsite.target, zipPath, process.env.BACKUP_PASSWORD);
  const extract = path.join(root, 'extract-offsite');
  new AdmZip(zipPath).extractAllTo(extract, true);
  const restored = new Database(path.join(extract, 'crm.db'), { readonly: true });
  const integrity = restored.pragma('integrity_check', { simple: true });
  const after = restored.prepare('SELECT COUNT(*) c FROM users').get().c;
  restored.close();
  if (integrity !== 'ok' || before !== after) throw new Error(`restore verification failed: ${integrity} ${before}/${after}`);
  ok('restore from off-site copy (users + integrity)');

  const localSum = fs.readFileSync(result.path + '.sha256', 'utf8').trim().split(/\s+/)[0];
  const remoteSum = fs.readFileSync(result.offsite.target + '.sha256', 'utf8').trim().split(/\s+/)[0];
  if (localSum !== remoteSum || localSum !== result.checksum) throw new Error('sha256 files diverge');
  ok('local/offsite sha256 agreement');

  console.log(`backup DR drill: ${step}/${step} pass; users=${before}; method=fs; sha256=${result.checksum.slice(0, 16)}…`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
