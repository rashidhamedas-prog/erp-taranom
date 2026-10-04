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
  BACKUP_ROOT_MARKER, BACKUP_ROOT_MARKER_CONTENT,
} = require('../backup');
const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');

fs.mkdirSync(process.env.BACKUP_OFFSITE_DIR, { recursive: true, mode: 0o700 });
fs.writeFileSync(
  path.join(process.env.BACKUP_OFFSITE_DIR, BACKUP_ROOT_MARKER),
  BACKUP_ROOT_MARKER_CONTENT,
  { mode: 0o600 }
);

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
  for (const company of (verified.companies || [])) {
    const extracted = (verified.fingerprints || []).find((fp) => fp.db === company.entry);
    if (!extracted) throw new Error(`company fingerprint missing: ${company.entry}`);
    const companyCmp = require('../backup').compareFingerprints(extracted, company.fingerprint);
    if (!companyCmp.ok) throw new Error(`company fingerprint mismatch: ${companyCmp.reason}`);
  }
  ok(`all company fingerprints match (${(verified.companies || []).length})`);

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
  const extractDb = new Database(path.join(extract, 'crm.db'), { readonly: true });
  const integrity = extractDb.pragma('integrity_check', { simple: true });
  const after = extractDb.prepare('SELECT COUNT(*) c FROM users').get().c;
  extractDb.close();
  if (integrity !== 'ok' || before !== after) throw new Error(`restore verification failed: ${integrity} ${before}/${after}`);
  ok('extract integrity + users fingerprint');

  const localSum = fs.readFileSync(result.path + '.sha256', 'utf8').trim().split(/\s+/)[0];
  const remoteSum = fs.readFileSync(result.offsite.target + '.sha256', 'utf8').trim().split(/\s+/)[0];
  if (localSum !== remoteSum || localSum !== result.checksum) throw new Error('sha256 files diverge');
  ok('local/offsite sha256 agreement');

  const {
    getBackupHealth, recordDrillResult, compareFingerprints, fingerprintDb, restoreBackup: restoreFn,
  } = require('../backup');
  const health1 = getBackupHealth({ maxAgeMin: 60, maxDrillAgeDays: 8 });
  if (!health1.last || health1.last.ok !== true) throw new Error('health missing last ok backup');
  ok(`backup health last.ok + age=${health1.latest_age_min}m`);

  const isolate = path.join(root, 'weekly-isolate');
  fs.mkdirSync(isolate, { recursive: true });
  const targetDb = path.join(isolate, 'restored.db');
  const offlineRestore = restoreFn(result.offsite.target, {
    confirmOfflineRestore: true,
    dbPath: targetDb,
    restoreUploads: false,
    restorePrivate: false,
  });
  if (!offlineRestore.ok) throw new Error('offline restore failed');
  const restoredFp = fingerprintDb(targetDb);
  const pkgFp = (verified.fingerprints || []).find((fp) => fp.db === 'crm.db') || (verified.fingerprints || [])[0];
  const cmp = compareFingerprints(restoredFp, pkgFp);
  if (!cmp.ok) throw new Error('fingerprint mismatch: ' + cmp.reason);
  recordDrillResult({
    ok: true,
    source: result.offsite.target,
    duration_ms: 1,
    rto_estimate_sec: 1,
    fingerprints: { package: pkgFp, restored: restoredFp },
  });
  const health2 = getBackupHealth({ maxAgeMin: 60, maxDrillAgeDays: 8 });
  if (health2.alerts.some((a) => a.code === 'BACKUP_DRILL_MISSING')) {
    throw new Error('drill still missing after record');
  }
  ok('weekly-style isolated restore + fingerprint + drill status');

  const companyDest = path.join(root, 'company-restore', 'company-1.db');
  fs.mkdirSync(path.dirname(companyDest), { recursive: true });
  fs.writeFileSync(companyDest, 'stale-main');
  fs.writeFileSync(companyDest + '-wal', 'stale-wal');
  const uploadDest = path.join(root, 'upload-restore');
  fs.mkdirSync(path.join(uploadDest, 'old-only'), { recursive: true });
  fs.writeFileSync(path.join(uploadDest, 'old-only', 'gone.txt'), 'should-not-survive');
  const privateDest = path.join(root, 'private-restore');
  fs.mkdirSync(path.join(privateDest, 'messages'), { recursive: true });
  fs.writeFileSync(path.join(privateDest, 'messages', 'leftover.bin'), 'old-private');
  const companyEntry = (verified.companies || []).find((company) => company.entry) || null;
  if (!companyEntry) throw new Error('package has no company entry to restore');
  const multi = restoreFn(result.offsite.target, {
    confirmOfflineRestore: true,
    dbPath: path.join(root, 'alias-only.db'),
    restoreUploads: true,
    restorePrivate: true,
    uploadsRoot: uploadDest,
    privateRoot: privateDest,
    companyTargets: [{ id: companyEntry.id, entry: companyEntry.entry, destPath: companyDest }],
  });
  if (!multi.ok || !multi.restored_companies.includes(Number(companyEntry.id))) {
    throw new Error('company restore missing: ' + JSON.stringify(multi.restored_companies));
  }
  if (fs.existsSync(companyDest + '-wal') || fs.existsSync(companyDest + '-shm')) {
    throw new Error('stale WAL sidecar survived restore');
  }
  const companyDb = new Database(companyDest, { readonly: true });
  const companyUsers = companyDb.prepare('SELECT COUNT(*) c FROM users').get().c;
  const companyIntegrity = companyDb.pragma('integrity_check', { simple: true });
  companyDb.close();
  if (companyIntegrity !== 'ok' || companyUsers !== before) {
    throw new Error(`company restore failed: ${companyIntegrity} users=${companyUsers}`);
  }
  if (fs.existsSync(path.join(uploadDest, 'old-only', 'gone.txt'))) throw new Error('stale public upload survived');
  if (!fs.existsSync(path.join(uploadDest, 'probe.txt'))) throw new Error('public upload missing after replace');
  if (fs.existsSync(path.join(privateDest, 'messages', 'leftover.bin'))) throw new Error('stale private file survived');
  if (!fs.existsSync(path.join(privateDest, 'messages', 'secret.bin'))) throw new Error('private file missing after replace');
  ok('company snapshot replaces WAL and upload trees swap atomically');

  console.log(`backup DR drill: ${step}/${step} pass; users=${before}; method=fs; sha256=${result.checksum.slice(0, 16)}…`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
