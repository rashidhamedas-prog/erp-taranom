'use strict';
/**
 * Schedule clamp, window, custom retention, and confined delete/purge.
 * Does not touch the production database.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-backup-schedule-'));
process.env.BACKUP_DIR = path.join(root, 'primary');
fs.mkdirSync(process.env.BACKUP_DIR, { recursive: true, mode: 0o700 });
delete process.env.BACKUP_OFFSITE_DIR;
delete process.env.BACKUP_S3_URI;

const {
  normalizeSchedule,
  scheduleDue,
  saveBackupSchedule,
  getBackupSchedule,
  pruneBackupDirectory,
  deleteBackupArchive,
  purgeBackupArchives,
  BACKUP_ROOT_MARKER,
  BACKUP_ROOT_MARKER_CONTENT,
} = require('../backup');

function checksum(file) {
  return require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function addNamed(dir, name, when) {
  const archive = path.join(dir, name);
  fs.writeFileSync(archive, Buffer.alloc(128, name.length));
  fs.writeFileSync(archive + '.sha256', `${checksum(archive)}  ${name}\n`);
  if (when) fs.utimesSync(archive, when, when);
  return name;
}

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
  console.log('ok', msg);
}

const clamped = normalizeSchedule({ interval_min: 14, retention: { recent: 2, daily: 99, weekly: 0, monthly: 3 }, keep_newest: 0 });
ok(clamped.interval_min === 15, 'interval below 15 clamps to 15');
ok(clamped.retention.recent === 4, 'recent below 4 clamps to 4');
ok(clamped.retention.daily === 31, 'daily above 31 clamps to 31');
ok(clamped.retention.weekly === 1, 'weekly below 1 clamps to 1');
ok(clamped.keep_newest === 1, 'keep_newest below 1 clamps to 1');
ok(normalizeSchedule({ interval_min: 17 }).interval_min === 15, 'interval snaps to a 5-minute step');
ok(normalizeSchedule({ enabled: false }).enabled === false, 'schedule can be turned off');

const noon = new Date('2026-09-24T08:30:00.000Z'); // 12:00 Asia/Tehran
const morningOnly = normalizeSchedule({ enabled: true, interval_min: 60, window_start: '08:00', window_end: '11:00' });
ok(scheduleDue(morningOnly, noon, 0).reason === 'window', 'outside the Tehran window is not due');
const allDay = normalizeSchedule({ enabled: true, interval_min: 60, window_start: '00:00', window_end: '00:00' });
ok(scheduleDue(allDay, noon, noon.getTime() - 10 * 60000).reason === 'interval', 'recent success waits for the interval');
ok(scheduleDue(allDay, noon, noon.getTime() - 61 * 60000).due === true, 'elapsed interval is due');
ok(scheduleDue({ ...allDay, enabled: false }, noon, 0).reason === 'disabled', 'disabled schedule never runs');

const saved = saveBackupSchedule({ interval_min: 120, window_start: '06:00', window_end: '22:00', keep_newest: 3, retention: { recent: 8 } });
ok(saved.interval_min === 120 && getBackupSchedule().retention.recent === 8, 'schedule round-trips through backup-status.json');
ok(getBackupSchedule().retention.daily === 14, 'omitted retention fields keep the default');

const now = new Date('2026-09-24T12:00:00.000Z');
const primary = process.env.BACKUP_DIR;
for (let i = 0; i < 6; i++) {
  addNamed(primary, `crm-backup-keep-${i}.zip.enc`, new Date(now.getTime() - i * 60000));
}
const custom = pruneBackupDirectory(primary, {
  nowMs: now.getTime(),
  retention: { recent: 2, daily: 1, weekly: 1, monthly: 1 },
  keepNewest: 3,
});
const left = fs.readdirSync(primary).filter((n) => /^crm-backup-keep-.*\.zip\.enc$/.test(n));
ok(custom.removed >= 1 && left.length === 4, `recent floor is 4 even if asked for 2, left ${left.length}`);
for (const name of left) {
  fs.unlinkSync(path.join(primary, name));
  fs.unlinkSync(path.join(primary, name + '.sha256'));
}

const only = 'crm-backup-only-20260924-120000.zip.enc';
addNamed(primary, only);
let rejected = false;
try { deleteBackupArchive(only, { confirmName: 'wrong' }); } catch (e) { rejected = e.code === 'CONFIRM_NAME'; }
ok(rejected && fs.existsSync(path.join(primary, only)), 'wrong confirm name deletes nothing');
let last = false;
try { deleteBackupArchive(only, { confirmName: only, force: false }); } catch (e) { last = e.code === 'LAST_VERIFIED'; }
ok(last, 'the only checksummed archive needs force');
const forced = deleteBackupArchive(only, { confirmName: only, force: true });
ok(forced.ok && !fs.existsSync(path.join(primary, only)) && !fs.existsSync(path.join(primary, only + '.sha256')), 'forced delete removes archive and sidecar');

const mirror = path.join(root, 'mirror');
fs.mkdirSync(mirror, { mode: 0o700 });
fs.writeFileSync(path.join(mirror, BACKUP_ROOT_MARKER), BACKUP_ROOT_MARKER_CONTENT, { mode: 0o600 });
process.env.BACKUP_OFFSITE_DIR = mirror;
const paired = 'crm-backup-pair-20260924-130000.zip.enc';
addNamed(primary, paired);
addNamed(primary, 'crm-backup-pair-extra-20260924-140000.zip.enc');
addNamed(mirror, paired);
fs.writeFileSync(path.join(primary, 'crm-latest.zip.enc'), fs.readFileSync(path.join(primary, paired)));
fs.writeFileSync(path.join(primary, 'backup-status.json'), JSON.stringify({ schedule: saved, note: 'keep-me' }));
const deleted = deleteBackupArchive(paired, { confirmName: paired, force: false });
ok(deleted.offsite && deleted.offsite.removed && !fs.existsSync(path.join(mirror, paired)), 'delete removes the offsite copy inside the marker');
ok(fs.existsSync(path.join(mirror, BACKUP_ROOT_MARKER)), 'offsite marker survives delete');

let badPurge = true;
try { purgeBackupArchives({ confirm: 'no' }); } catch (e) { badPurge = fs.existsSync(path.join(primary, 'crm-backup-pair-extra-20260924-140000.zip.enc')); }
ok(badPurge, 'bad purge confirm leaves archives');
const purged = purgeBackupArchives({ confirm: 'PURGE-ALL-BACKUPS' });
const remain = fs.readdirSync(primary).filter((n) => n.startsWith('crm-backup-') || n.startsWith('crm-latest'));
ok(purged.removed >= 1 && remain.length === 0, 'purge removes archives and the latest pointer');
const status = JSON.parse(fs.readFileSync(path.join(primary, 'backup-status.json'), 'utf8'));
ok(status.note === 'keep-me' && status.schedule.interval_min === 120, 'purge keeps the schedule file');
ok(fs.existsSync(path.join(mirror, BACKUP_ROOT_MARKER)), 'purge keeps the offsite marker');

console.log(`\n${passed} assertions passed`);
