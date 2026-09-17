const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-backup-retention-'));
process.env.BACKUP_DIR = path.join(root, 'primary');
fs.mkdirSync(process.env.BACKUP_DIR, { recursive: true, mode: 0o700 });
const {
  pruneBackupDirectory,
  assertManagedBackupDirectory,
  copyFilesystemBackupAtomic,
  BACKUP_ROOT_MARKER,
  BACKUP_ROOT_MARKER_CONTENT,
} = require('../backup');

function checksum(file) {
  return require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function addBackup(date, suffix = '.zip.enc', dir = root) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const name = `crm-backup-${stamp}${suffix}`;
  const archive = path.join(dir, name);
  fs.writeFileSync(archive, Buffer.alloc(1024, 1));
  fs.writeFileSync(archive + '.sha256', `${checksum(archive)}  ${name}\n`);
  fs.utimesSync(archive, date, date);
  fs.utimesSync(archive + '.sha256', date, date);
  return name;
}

function addNamedBackup(name, date, dir = root) {
  const archive = path.join(dir, name);
  fs.writeFileSync(archive, Buffer.alloc(1024, 2));
  fs.writeFileSync(archive + '.sha256', `${checksum(archive)}  ${name}\n`);
  fs.utimesSync(archive, date, date);
  fs.utimesSync(archive + '.sha256', date, date);
  return name;
}

try {
  const now = new Date('2026-09-17T00:00:00.000Z');
  // 45 days of quarter-hour backups: enough to exercise every retention tier.
  for (let daysAgo = 0; daysAgo < 45; daysAgo++) {
    for (let slot = 0; slot < 96; slot++) {
      const when = new Date(now.getTime() - daysAgo * 86400000 - slot * 15 * 60000);
      addBackup(when);
    }
  }
  // Simulate a broken scheduler creating a large burst inside one hour.
  for (let i = 0; i < 1000; i++) {
    addNamedBackup(`crm-backup-burst-${String(i).padStart(4, '0')}.zip.enc`, new Date(now.getTime() - i * 1000));
  }
  fs.writeFileSync(path.join(root, 'crm-backup-20200101-000000.zip.enc.sha256'), 'orphan');
  fs.writeFileSync(path.join(root, 'crm-latest.zip.enc'), 'latest-must-survive');

  const before = fs.readdirSync(root).filter((n) => /^crm-backup-.*\.zip\.enc$/.test(n)).length;
  const preview = pruneBackupDirectory(root, { nowMs: now.getTime(), dryRun: true });
  assert.strictEqual(fs.readdirSync(root).filter((n) => /^crm-backup-.*\.zip\.enc$/.test(n)).length, before);
  assert(preview.removed > 5000, 'dry-run should identify the runaway history and recent burst');
  assert.deepStrictEqual(preview.failures, [], 'dry-run has no cleanup failures');

  const result = pruneBackupDirectory(root, { nowMs: now.getTime() });
  const archives = fs.readdirSync(root).filter((n) => /^crm-backup-.*\.zip\.enc$/.test(n));
  assert(result.removed > 5000, 'old archives and burst overflow are pruned');
  assert(archives.length <= 160, `GFS archive count is bounded, got ${archives.length}`);
  assert(archives.length >= 120, `GFS keeps recent/daily/weekly/monthly coverage, got ${archives.length}`);
  assert(fs.existsSync(path.join(root, 'crm-latest.zip.enc')), 'latest pointer is not touched');
  assert(!fs.existsSync(path.join(root, 'crm-backup-20200101-000000.zip.enc.sha256')), 'orphan sidecar is pruned');
  for (const name of archives) {
    assert(fs.existsSync(path.join(root, name + '.sha256')), `sidecar preserved for ${name}`);
  }
  assert.deepStrictEqual(result.failures, [], 'cleanup completed without ignored failures');

  const managed = path.join(root, 'managed-mirror');
  fs.mkdirSync(managed, { mode: 0o700 });
  fs.writeFileSync(path.join(managed, BACKUP_ROOT_MARKER), BACKUP_ROOT_MARKER_CONTENT, { mode: 0o600 });
  assert.strictEqual(assertManagedBackupDirectory(managed, process.env.BACKUP_DIR), fs.realpathSync(managed));
  assert.throws(
    () => assertManagedBackupDirectory(path.parse(managed).root, process.env.BACKUP_DIR),
    /filesystem root/
  );

  const alias = path.join(root, 'primary-alias');
  try {
    fs.symlinkSync(process.env.BACKUP_DIR, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => assertManagedBackupDirectory(alias, process.env.BACKUP_DIR), /real directory/);
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error;
  }
  const dangling = path.join(root, 'dangling-mirror');
  try {
    fs.symlinkSync(path.join(root, 'missing-target'), dangling, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => assertManagedBackupDirectory(dangling, process.env.BACKUP_DIR));
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error;
  }

  if (process.platform !== 'win32') {
    const openDir = path.join(root, 'open-mirror');
    fs.mkdirSync(openDir, { mode: 0o755 });
    fs.writeFileSync(path.join(openDir, BACKUP_ROOT_MARKER), BACKUP_ROOT_MARKER_CONTENT, { mode: 0o600 });
    assert.throws(() => assertManagedBackupDirectory(openDir, process.env.BACKUP_DIR), /group\/other access/);
  }

  const healthy = addNamedBackup('crm-backup-20260916-120000.zip.enc', new Date('2026-09-16T12:00:00Z'), managed);
  addNamedBackup('crm-backup-20260916-130000.zip.enc', new Date('2026-09-16T13:00:00Z'), managed);
  fs.appendFileSync(path.join(managed, 'crm-backup-20260916-130000.zip.enc'), 'corrupt');
  fs.writeFileSync(path.join(managed, 'crm-backup-20260916-140000.zip.enc'), 'interrupted-without-sidecar');
  fs.utimesSync(path.join(managed, 'crm-backup-20260916-140000.zip.enc'), new Date('2026-09-16T14:00:00Z'), new Date('2026-09-16T14:00:00Z'));
  const stalePartial = path.join(managed, '.partial-crm-backup-stale.zip.enc-deadbeef');
  fs.writeFileSync(stalePartial, 'partial');
  fs.utimesSync(stalePartial, new Date('2026-09-15T00:00:00Z'), new Date('2026-09-15T00:00:00Z'));
  const verifiedPrune = pruneBackupDirectory(managed, {
    nowMs: now.getTime(), requireMarker: true, primaryDir: process.env.BACKUP_DIR, verifyChecksum: true,
  });
  assert.deepStrictEqual(verifiedPrune.failures, [], 'managed verified cleanup succeeds');
  assert(fs.existsSync(path.join(managed, healthy)), 'healthy backup in the same daily bucket survives');
  assert(!fs.existsSync(path.join(managed, 'crm-backup-20260916-130000.zip.enc')), 'checksum mismatch is removed');
  assert(!fs.existsSync(path.join(managed, 'crm-backup-20260916-140000.zip.enc')), 'archive without sidecar is removed');
  assert(!fs.existsSync(stalePartial), 'stale interrupted copy is removed');

  const source = path.join(root, 'source.zip.enc');
  fs.writeFileSync(source, Buffer.alloc(4096, 7));
  const sourceHash = checksum(source);
  const copied = copyFilesystemBackupAtomic(source, managed, sourceHash);
  assert.strictEqual(checksum(copied), sourceHash, 'atomic mirror copy checksum matches');
  assert.strictEqual(fs.readFileSync(copied + '.sha256', 'utf8'), `${sourceHash}  ${path.basename(source)}\n`);
  assert(!fs.readdirSync(managed).some((n) => n.startsWith('.partial-source.zip.enc-')), 'atomic copy leaves no partials');
  console.log(`backup retention PASS: before=${before} kept=${archives.length} removed=${result.removed}`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
