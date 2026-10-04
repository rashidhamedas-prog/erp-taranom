'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync, spawnSync } = require('child_process');
const { UPLOADS_ROOT } = require('./paths');
const { getSetting } = require('./lib/secret-settings');

const SERVER_DIR = __dirname;
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(SERVER_DIR, 'backups');
const PACKAGE_VERSION = 2;
const ENC_MAGIC = Buffer.from('TRNMBKP1', 'ascii');
let backupLock = false;

function resolveBackupDbPath() {
  try {
    const { getDBPath } = require('./db');
    return getDBPath() || process.env.DB_PATH || path.join(SERVER_DIR, 'crm.db');
  } catch {
    return process.env.DB_PATH || path.join(SERVER_DIR, 'crm.db');
  }
}

function ensureDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  return BACKUP_DIR;
}

function tsName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function getBackupPassword() {
  if (process.env.BACKUP_ENCRYPTION_KEY) return process.env.BACKUP_ENCRYPTION_KEY;
  if (process.env.BACKUP_PASSWORD) return process.env.BACKUP_PASSWORD;
  try {
    const { getDB } = require('./db');
    return getSetting(getDB(), 'backup_password') || null;
  } catch {
    return null;
  }
}

function isProduction() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

function assertBackupPolicy() {
  const password = getBackupPassword();
  if (isProduction() && !password) {
    throw new Error('production requires BACKUP_ENCRYPTION_KEY (or BACKUP_PASSWORD)');
  }
  if (isProduction() && !process.env.BACKUP_S3_URI && !process.env.BACKUP_OFFSITE_DIR) {
    throw new Error('production requires BACKUP_S3_URI or BACKUP_OFFSITE_DIR off-server destination');
  }
  return password;
}

function encryptFile(srcPath, destPath, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = fs.readFileSync(srcPath);
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  fs.writeFileSync(destPath, Buffer.concat([ENC_MAGIC, salt, iv, enc, cipher.getAuthTag()]), { mode: 0o600 });
}

function decryptFile(srcPath, destPath, password) {
  const buf = fs.readFileSync(srcPath);
  if (!buf.subarray(0, 8).equals(ENC_MAGIC)) throw new Error('فایل رمزنگاری‌شدهٔ معتبر نیست');
  const salt = buf.subarray(8, 24);
  const iv = buf.subarray(24, 36);
  const tag = buf.subarray(buf.length - 16);
  const enc = buf.subarray(36, buf.length - 16);
  const key = crypto.scryptSync(password, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(enc), decipher.final()]);
  fs.writeFileSync(destPath, out, { mode: 0o600 });
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sameFilesystemDevice(a, b) {
  try {
    return fs.statSync(a).dev === fs.statSync(b).dev;
  } catch {
    return false;
  }
}

function fingerprintDb(dbPath) {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    const count = (sql) => {
      try { return Number(db.prepare(sql).get().c || 0); } catch { return 0; }
    };
    let debit = 0;
    let credit = 0;
    try {
      const row = db.prepare(`
        SELECT COALESCE(SUM(debit_rial),SUM(debit),0) d, COALESCE(SUM(credit_rial),SUM(credit),0) c
        FROM journal_lines
      `).get();
      debit = Number(row.d || 0);
      credit = Number(row.c || 0);
    } catch { /* older schema */ }
    return {
      integrity,
      invoices: count("SELECT COUNT(*) c FROM invoices"),
      customers: count("SELECT COUNT(*) c FROM customers"),
      journals: count("SELECT COUNT(*) c FROM journal_entries"),
      trial_balance: { debit, credit, balanced: debit === credit },
    };
  } finally {
    db.close();
  }
}

function listCompanyDbTargets() {
  try {
    const { readRegistry } = require('./lib/company-workspace');
    const reg = readRegistry();
    return (reg.companies || [])
      .filter((c) => c.dbPath && fs.existsSync(c.dbPath))
      .map((c) => ({
        id: c.id,
        name: c.name,
        code: c.code || '',
        absPath: path.resolve(c.dbPath),
        entry: `companies/company-${c.id}.db`,
      }));
  } catch {
    const p = resolveBackupDbPath();
    if (!fs.existsSync(p)) return [];
    return [{ id: 1, name: 'default', code: '', absPath: path.resolve(p), entry: 'crm.db' }];
  }
}

function addFileToZip(zip, filePath, entryName, filesMeta) {
  if (!fs.existsSync(filePath)) return;
  const st = fs.statSync(filePath);
  if (st.isDirectory()) {
    for (const ent of fs.readdirSync(filePath, { withFileTypes: true })) {
      if (ent.name === '.' || ent.name === '..') continue;
      addFileToZip(zip, path.join(filePath, ent.name), path.posix.join(entryName, ent.name), filesMeta);
    }
    return;
  }
  const rel = entryName.replace(/\\/g, '/');
  if (rel.includes('..') || path.isAbsolute(rel)) throw new Error(`unsafe backup entry: ${rel}`);
  if (filesMeta.some((f) => f.path === rel)) throw new Error(`duplicate backup entry: ${rel}`);
  const buf = fs.readFileSync(filePath);
  zip.addFile(rel, buf);
  filesMeta.push({
    path: rel,
    size: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  });
}

function releaseId() {
  try {
    const man = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'public', 'releases', 'manifest.json'), 'utf8'));
    return `web:${man.web?.version || '?'}/desk:${man.desktop?.version || '?'}/and:${man.android?.version || '?'}`;
  } catch {
    return 'unknown';
  }
}

async function snapshotCompanyDbs(tmpDir) {
  const Database = require('better-sqlite3');
  const targets = listCompanyDbTargets();
  const out = [];
  for (const t of targets) {
    const snap = path.join(tmpDir, `snap-${t.id}-${crypto.randomBytes(4).toString('hex')}.db`);
    const src = new Database(t.absPath);
    try {
      await src.backup(snap);
    } finally {
      src.close();
    }
    const fp = fingerprintDb(snap);
    if (fp.integrity !== 'ok') throw new Error(`integrity failed for company ${t.id}: ${fp.integrity}`);
    out.push({ ...t, snapshotPath: snap, fingerprint: fp });
  }
  return out;
}

function createZipBackup(outPath, companySnaps) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  const filesMeta = [];
  const companies = [];

  for (const c of companySnaps) {
    addFileToZip(zip, c.snapshotPath, c.entry, filesMeta);
    companies.push({
      id: c.id,
      name: c.name,
      code: c.code,
      entry: c.entry,
      fingerprint: c.fingerprint,
    });
  }
  // Legacy alias: active company also as crm.db when stored under companies/
  try {
    const activeId = require('./lib/company-workspace').getActiveCompany()?.id;
    const active = companySnaps.find((c) => c.id === activeId) || companySnaps[0];
    if (active && active.entry !== 'crm.db' && !filesMeta.some((f) => f.path === 'crm.db')) {
      addFileToZip(zip, active.snapshotPath, 'crm.db', filesMeta);
    }
  } catch {
    if (companySnaps[0] && companySnaps[0].entry !== 'crm.db' && !filesMeta.some((f) => f.path === 'crm.db')) {
      addFileToZip(zip, companySnaps[0].snapshotPath, 'crm.db', filesMeta);
    }
  }

  if (fs.existsSync(UPLOADS_ROOT)) addFileToZip(zip, UPLOADS_ROOT, 'uploads', filesMeta);

  try {
    const { PRIVATE_UPLOADS_ROOT } = require('./lib/private-uploads');
    if (fs.existsSync(PRIVATE_UPLOADS_ROOT)) {
      addFileToZip(zip, PRIVATE_UPLOADS_ROOT, 'private-uploads', filesMeta);
    }
  } catch { /* private module may throw if misconfigured in exotic tests */ }

  try {
    const { registryPath, readRegistry } = require('./lib/company-workspace');
    const reg = readRegistry();
    const portable = {
      ...reg,
      companies: (reg.companies || []).map((c) => ({
        ...c,
        dbPath: `companies/company-${c.id}.db`,
      })),
    };
    const buf = Buffer.from(JSON.stringify(portable, null, 2), 'utf8');
    zip.addFile('registry.json', buf);
    filesMeta.push({ path: 'registry.json', size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
    if (fs.existsSync(registryPath())) {
      // already included as portable registry.json
    }
  } catch { /* single-company */ }

  const manifest = {
    version: PACKAGE_VERSION,
    created_at: new Date().toISOString(),
    app: 'crm-taranom',
    release_id: releaseId(),
    companies,
    files: filesMeta,
  };
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  zip.writeZip(outPath);
  return manifest;
}

function createTarBackup(outPath, companySnaps) {
  // Prefer zip package on all platforms for authenticated multi-file manifests.
  return createZipBackup(outPath.replace(/\.tar\.gz$/, '.zip'), companySnaps);
}

const BACKUP_ARCHIVE_RE = /^crm-backup-.*\.(tar\.gz|zip)(\.enc)?$/i;
const BACKUP_ROOT_MARKER = '.erp-taranom-backup-root';
const BACKUP_ROOT_MARKER_CONTENT = 'ERP_TARANOM_BACKUP_ROOT_V1\n';

function pathsOverlap(left, right) {
  const rel = path.relative(left, right);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function assertManagedBackupDirectory(dir, primaryDir = BACKUP_DIR) {
  const resolved = path.resolve(dir);
  const st = fs.lstatSync(resolved);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('backup retention directory must be a real directory');
  const real = fs.realpathSync(resolved);
  if (real === path.parse(real).root) throw new Error('refusing backup retention on filesystem root');
  const primaryReal = fs.realpathSync(path.resolve(primaryDir));
  if (pathsOverlap(real, primaryReal) || pathsOverlap(primaryReal, real)) {
    throw new Error('backup retention directory must not alias, contain, or be inside the primary backup directory');
  }
  const marker = path.join(real, BACKUP_ROOT_MARKER);
  const markerSt = fs.lstatSync(marker);
  if (!markerSt.isFile() || markerSt.isSymbolicLink()) throw new Error('backup retention marker must be a regular file');
  if (fs.readFileSync(marker, 'utf8') !== BACKUP_ROOT_MARKER_CONTENT) throw new Error('backup retention marker is invalid');
  if (process.platform !== 'win32') {
    if ((st.mode & 0o077) !== 0 || (markerSt.mode & 0o077) !== 0) {
      throw new Error('backup retention directory and marker must not grant group/other access');
    }
    if (st.uid !== markerSt.uid || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
      throw new Error('backup retention directory and marker must be owned by the backup process user');
    }
  }
  return real;
}

function listBackupsIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => BACKUP_ARCHIVE_RE.test(f))
    .map((name) => {
      const fp = path.join(dir, name);
      const st = fs.lstatSync(fp);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error(`unsafe backup archive entry: ${name}`);
      return {
        name,
        size: st.size,
        sizeMB: (st.size / 1024 / 1024).toFixed(2),
        encrypted: name.endsWith('.enc'),
        created_at: Math.floor(st.mtimeMs / 1000),
      };
    })
    .sort((a, b) => b.created_at - a.created_at);
}

function sidecarWellFormed(dir, item) {
  try {
    const sidecar = path.join(dir, item.name + '.sha256');
    const sideSt = fs.lstatSync(sidecar);
    if (!sideSt.isFile() || sideSt.isSymbolicLink() || sideSt.size > 512) return false;
    const line = fs.readFileSync(sidecar, 'utf8').trim();
    const match = /^([a-f0-9]{64})\s+(.+)$/i.exec(line);
    return !!(match && path.basename(match[2]) === item.name);
  } catch {
    return false;
  }
}

function backupPairVerified(dir, item) {
  try {
    if (!sidecarWellFormed(dir, item)) return false;
    const line = fs.readFileSync(path.join(dir, item.name + '.sha256'), 'utf8').trim();
    const match = /^([a-f0-9]{64})\s+/i.exec(line);
    if (!match) return false;
    return sha256File(path.join(dir, item.name)).toLowerCase() === match[1].toLowerCase();
  } catch {
    return false;
  }
}

function listBackups() {
  ensureDir();
  return listBackupsIn(BACKUP_DIR).map((item) => ({
    ...item,
    verified: sidecarWellFormed(BACKUP_DIR, item),
  }));
}

const DEFAULT_BACKUP_SCHEDULE = Object.freeze({
  enabled: true,
  interval_min: 60,
  window_start: '00:00',
  window_end: '00:00',
  retention: Object.freeze({ recent: 24, daily: 14, weekly: 8, monthly: 6 }),
  keep_newest: 8,
});

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeClock(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return fallback;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function clockToMinutes(value) {
  const [hour, minute] = normalizeClock(value, '00:00').split(':').map(Number);
  return hour * 60 + minute;
}

function tehranClockMinutes(now) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tehran',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  let hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
  if (hour === 24) hour = 0;
  return hour * 60 + minute;
}

function normalizeSchedule(input) {
  const src = input && typeof input === 'object' ? input : {};
  const retention = src.retention && typeof src.retention === 'object' ? src.retention : {};
  let interval = clampInt(src.interval_min, 15, 1440, DEFAULT_BACKUP_SCHEDULE.interval_min);
  interval = Math.round(interval / 5) * 5;
  if (interval < 15) interval = 15;
  if (interval > 1440) interval = 1440;
  const enabled = src.enabled === false || src.enabled === 0 || src.enabled === '0' || src.enabled === 'false'
    ? false
    : true;
  return {
    enabled,
    interval_min: interval,
    window_start: normalizeClock(src.window_start, DEFAULT_BACKUP_SCHEDULE.window_start),
    window_end: normalizeClock(src.window_end, DEFAULT_BACKUP_SCHEDULE.window_end),
    retention: {
      recent: clampInt(retention.recent, 4, 96, DEFAULT_BACKUP_SCHEDULE.retention.recent),
      daily: clampInt(retention.daily, 1, 31, DEFAULT_BACKUP_SCHEDULE.retention.daily),
      weekly: clampInt(retention.weekly, 1, 12, DEFAULT_BACKUP_SCHEDULE.retention.weekly),
      monthly: clampInt(retention.monthly, 1, 24, DEFAULT_BACKUP_SCHEDULE.retention.monthly),
    },
    keep_newest: clampInt(
      src.keep_newest != null ? src.keep_newest : src.keep_manual_last,
      1,
      30,
      DEFAULT_BACKUP_SCHEDULE.keep_newest,
    ),
  };
}

function withinBackupWindow(schedule, now) {
  const start = clockToMinutes(schedule.window_start);
  const end = clockToMinutes(schedule.window_end);
  if (start === end) return true;
  const current = tehranClockMinutes(now);
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

function scheduleDue(schedule, now, lastSuccessMs) {
  const normalized = normalizeSchedule(schedule);
  if (!normalized.enabled) return { due: false, reason: 'disabled', schedule: normalized };
  if (!withinBackupWindow(normalized, now)) return { due: false, reason: 'window', schedule: normalized };
  const last = Number(lastSuccessMs) || 0;
  const elapsedMin = last ? (now.getTime() - last) / 60000 : Infinity;
  if (elapsedMin < normalized.interval_min) {
    return { due: false, reason: 'interval', schedule: normalized, elapsed_min: elapsedMin };
  }
  return { due: true, reason: 'due', schedule: normalized, elapsed_min: elapsedMin };
}

function getBackupSchedule() {
  const status = readStatus();
  if (!status.schedule) return normalizeSchedule(DEFAULT_BACKUP_SCHEDULE);
  return normalizeSchedule({ ...DEFAULT_BACKUP_SCHEDULE, ...status.schedule, retention: { ...DEFAULT_BACKUP_SCHEDULE.retention, ...(status.schedule.retention || {}) } });
}

function saveBackupSchedule(patch) {
  const current = getBackupSchedule();
  const src = patch && typeof patch === 'object' ? patch : {};
  const next = normalizeSchedule({
    ...current,
    ...src,
    retention: { ...current.retention, ...(src.retention || {}) },
  });
  writeStatus({ schedule: next });
  return next;
}

function pruneBackupDirectory(dir, options = {}) {
  // GFS-ish retention. Omitted options keep the historical caps so existing
  // retention tests stay stable. A saved schedule passes explicit caps.
  let resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) {
    return { directory: resolved, scanned: 0, kept: 0, removed: 0, removed_sidecars: 0, freed_bytes: 0, failures: [] };
  }
  if (options.requireMarker === true) {
    resolved = assertManagedBackupDirectory(resolved, options.primaryDir || BACKUP_DIR);
  }
  const items = listBackupsIn(resolved);
  const now = Number(options.nowMs) || Date.now();
  const dryRun = options.dryRun === true;
  const keep = new Set();
  const verified = new Map();
  const canKeep = (it) => {
    if (options.verifyChecksum !== true) return true;
    if (!verified.has(it.name)) verified.set(it.name, backupPairVerified(resolved, it));
    return verified.get(it.name);
  };
  const day = 86400000;
  const legacyCaps = !options.retention;
  const recentCap = legacyCaps ? 96 : clampInt(options.retention.recent, 4, 96, 24);
  const dailyCap = legacyCaps ? 31 : clampInt(options.retention.daily, 1, 31, 14);
  const weeklyCap = legacyCaps ? 12 : clampInt(options.retention.weekly, 1, 12, 8);
  const monthlyCap = legacyCaps ? 12 : clampInt(options.retention.monthly, 1, 24, 6);
  const keepNewest = legacyCaps ? 0 : clampInt(options.keepNewest, 0, 96, 0);
  let recentKept = 0;
  for (const it of items) {
    const age = now - it.created_at * 1000;
    if (age <= day && recentKept < recentCap && canKeep(it)) {
      keep.add(it.name);
      recentKept++;
    }
  }
  if (keepNewest > 0) {
    let pinned = 0;
    for (const it of items) {
      if (pinned >= keepNewest) break;
      if (!canKeep(it)) continue;
      keep.add(it.name);
      pinned++;
    }
  }
  const byDay = new Map();
  const byWeek = new Map();
  const byMonth = new Map();
  for (const it of items) {
    const d = new Date(it.created_at * 1000);
    const dayKey = d.toISOString().slice(0, 10);
    const weekKey = `${d.getUTCFullYear()}-W${Math.ceil((((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / day) + 1) / 7)}`;
    const monthKey = d.toISOString().slice(0, 7);
    const needDay = byDay.size < dailyCap && !byDay.has(dayKey);
    const needWeek = byWeek.size < weeklyCap && !byWeek.has(weekKey);
    const needMonth = byMonth.size < monthlyCap && !byMonth.has(monthKey);
    if (!needDay && !needWeek && !needMonth) continue;
    if (!canKeep(it)) continue;
    if (needDay) byDay.set(dayKey, it.name);
    if (needWeek) byWeek.set(weekKey, it.name);
    if (needMonth) byMonth.set(monthKey, it.name);
  }
  byDay.forEach((n) => keep.add(n));
  byWeek.forEach((n) => keep.add(n));
  byMonth.forEach((n) => keep.add(n));
  let removed = 0;
  let removedSidecars = 0;
  let freedBytes = 0;
  const failures = [];
  for (const old of items) {
    if (keep.has(old.name)) continue;
    const archive = path.join(resolved, old.name);
    const sidecar = archive + '.sha256';
    try {
      const archiveBytes = fs.statSync(archive).size;
      if (!dryRun) fs.unlinkSync(archive);
      freedBytes += archiveBytes;
      removed++;
    } catch (error) {
      failures.push({ name: old.name, error: String(error && error.code || error && error.message || error) });
      continue;
    }
    if (fs.existsSync(sidecar)) {
      try {
        const sidecarBytes = fs.statSync(sidecar).size;
        if (!dryRun) fs.unlinkSync(sidecar);
        freedBytes += sidecarBytes;
        removedSidecars++;
      } catch (error) {
        failures.push({ name: path.basename(sidecar), error: String(error && error.code || error && error.message || error) });
      }
    }
  }
  // Interrupted atomic mirror copies use a hidden partial name. Leave fresh
  // files alone in case another process is finishing, but prune stale regular
  // partials after 24 hours.
  for (const name of fs.readdirSync(resolved)) {
    if (!name.startsWith('.partial-crm-backup-')) continue;
    const partial = path.join(resolved, name);
    try {
      const partialSt = fs.lstatSync(partial);
      if (!partialSt.isFile() || partialSt.isSymbolicLink()) {
        failures.push({ name, error: 'UNSAFE_PARTIAL_ENTRY' });
        continue;
      }
      if (now - partialSt.mtimeMs <= day) continue;
      if (!dryRun) fs.unlinkSync(partial);
      freedBytes += partialSt.size;
      removed++;
    } catch (error) {
      failures.push({ name, error: String(error && error.code || error && error.message || error) });
    }
  }
  // Old releases left checksum sidecars behind. They are useful only while
  // their exact archive exists, so remove bounded orphan metadata as well.
  for (const name of fs.readdirSync(resolved)) {
    if (!name.endsWith('.sha256')) continue;
    const archiveName = name.slice(0, -'.sha256'.length);
    if (!BACKUP_ARCHIVE_RE.test(archiveName)) continue;
    if (fs.existsSync(path.join(resolved, archiveName))) continue;
    const sidecar = path.join(resolved, name);
    try {
      freedBytes += fs.statSync(sidecar).size;
      if (!dryRun) fs.unlinkSync(sidecar);
      removedSidecars++;
    } catch (error) {
      failures.push({ name, error: String(error && error.code || error && error.message || error) });
    }
  }
  return {
    directory: resolved,
    scanned: items.length,
    kept: items.length - removed,
    removed,
    removed_sidecars: removedSidecars,
    freed_bytes: freedBytes,
    dry_run: dryRun,
    failures,
  };
}

function pruneOld() {
  const schedule = getBackupSchedule();
  return pruneBackupDirectory(BACKUP_DIR, {
    retention: schedule.retention,
    keepNewest: schedule.keep_newest,
  });
}

function copyFilesystemBackupAtomic(finalPath, destDir, checksum) {
  const fileName = path.basename(finalPath);
  const target = path.join(destDir, fileName);
  const nonce = crypto.randomBytes(6).toString('hex');
  const tmpArchive = path.join(destDir, `.partial-${fileName}-${nonce}`);
  const tmpSidecar = tmpArchive + '.sha256';
  try {
    fs.copyFileSync(finalPath, tmpArchive, fs.constants.COPYFILE_EXCL);
    if (sha256File(tmpArchive) !== checksum) throw new Error('off-site filesystem checksum mismatch');
    fs.writeFileSync(tmpSidecar, `${checksum}  ${fileName}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmpArchive, target);
    fs.renameSync(tmpSidecar, target + '.sha256');
    return target;
  } finally {
    try { fs.unlinkSync(tmpArchive); } catch { /* renamed or absent */ }
    try { fs.unlinkSync(tmpSidecar); } catch { /* renamed or absent */ }
  }
}

function writeStatus(patch) {
  ensureDir();
  const statusPath = path.join(BACKUP_DIR, 'backup-status.json');
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch { /* */ }
  const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
  fs.writeFileSync(statusPath, JSON.stringify(next, null, 2));
  return next;
}

function readStatus() {
  ensureDir();
  const statusPath = path.join(BACKUP_DIR, 'backup-status.json');
  try { return JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch { return {}; }
}

function diskFreeBytes(dirPath) {
  try {
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(dirPath);
      return Number(st.bavail) * Number(st.bsize);
    }
  } catch { /* */ }
  return null;
}

function compareFingerprints(a, b) {
  if (!a || !b) return { ok: false, reason: 'missing fingerprint' };
  const keys = ['invoices', 'customers', 'journals'];
  for (const k of keys) {
    if (Number(a[k] || 0) !== Number(b[k] || 0)) {
      return { ok: false, reason: `${k} mismatch ${a[k]}≠${b[k]}` };
    }
  }
  const ad = a.trial_balance || {};
  const bd = b.trial_balance || {};
  if (Number(ad.debit || 0) !== Number(bd.debit || 0) || Number(ad.credit || 0) !== Number(bd.credit || 0)) {
    return { ok: false, reason: 'trial_balance mismatch' };
  }
  return { ok: true };
}

/**
 * Operational health for Gate/ops dashboards.
 * Alerts: failed last backup, age > 20m, disk low, missing weekly drill.
 */
function getBackupHealth(options = {}) {
  const status = readStatus();
  const schedule = getBackupSchedule();
  const last = status.last || null;
  const drill = status.last_drill || null;
  const latest = getLatestBackupFile();
  const latestAgeMin = latest && fs.existsSync(latest)
    ? Math.round((Date.now() - fs.statSync(latest).mtimeMs) / 60000)
    : null;
  const free = diskFreeBytes(BACKUP_DIR);
  const minFreeMb = Number(options.minFreeMb || process.env.BACKUP_MIN_FREE_MB || 512);
  const defaultMaxAge = Math.max(20, schedule.interval_min * 2);
  const maxAgeMin = Number(options.maxAgeMin || process.env.BACKUP_MAX_AGE_MIN || defaultMaxAge);
  const maxDrillAgeDays = Number(options.maxDrillAgeDays || process.env.BACKUP_MAX_DRILL_AGE_DAYS || 8);
  const alerts = [];
  if (!last || last.ok === false) alerts.push({ code: 'BACKUP_LAST_FAILED', severity: 'critical', message: last?.error || 'no successful backup' });
  if (latestAgeMin == null) alerts.push({ code: 'BACKUP_MISSING', severity: 'critical', message: 'latest backup file missing' });
  else if (latestAgeMin > maxAgeMin) alerts.push({ code: 'BACKUP_STALE', severity: 'high', message: `latest backup age ${latestAgeMin}m > ${maxAgeMin}m` });
  if (free != null && free < minFreeMb * 1024 * 1024) {
    alerts.push({ code: 'BACKUP_DISK_LOW', severity: 'high', message: `free disk ${(free / 1024 / 1024).toFixed(0)}MB < ${minFreeMb}MB` });
  }
  if (isProduction() && !process.env.BACKUP_S3_URI && !process.env.BACKUP_OFFSITE_DIR) {
    alerts.push({ code: 'BACKUP_OFFSITE_UNCONFIGURED', severity: 'critical', message: 'no BACKUP_S3_URI / BACKUP_OFFSITE_DIR' });
  }
  if (process.env.BACKUP_OFFSITE_DIR && sameFilesystemDevice(BACKUP_DIR, process.env.BACKUP_OFFSITE_DIR)
    && process.env.BACKUP_ALLOW_SAME_DEVICE !== '1') {
    alerts.push({ code: 'BACKUP_OFFSITE_SAME_DEVICE', severity: 'critical', message: 'offsite dir is same device as BACKUP_DIR' });
  }
  const drillAgeDays = drill?.at
    ? (Date.now() - Date.parse(drill.at)) / 86400000
    : null;
  if (!drill || drill.ok === false) {
    alerts.push({ code: 'BACKUP_DRILL_MISSING', severity: 'medium', message: drill?.error || 'weekly offsite restore drill not recorded' });
  } else if (drillAgeDays != null && drillAgeDays > maxDrillAgeDays) {
    alerts.push({ code: 'BACKUP_DRILL_STALE', severity: 'medium', message: `last drill ${drillAgeDays.toFixed(1)}d ago` });
  }
  return {
    ok: alerts.filter((a) => a.severity === 'critical' || a.severity === 'high').length === 0,
    last,
    last_drill: drill,
    latest_age_min: latestAgeMin,
    disk_free_bytes: free,
    offsite_configured: !!(process.env.BACKUP_S3_URI || process.env.BACKUP_OFFSITE_DIR),
    schedule,
    alerts,
    updated_at: status.updated_at || null,
  };
}

function recordDrillResult(result) {
  return writeStatus({
    last_drill: {
      ok: !!result.ok,
      at: new Date().toISOString(),
      source: result.source || null,
      duration_ms: result.duration_ms || null,
      fingerprints: result.fingerprints || null,
      error: result.error || null,
      rto_estimate_sec: result.rto_estimate_sec || null,
    },
  });
}

function verifyS3ObjectChecksum(s3Uri, expectedSha256) {
  const tmp = path.join(BACKUP_DIR, `.s3-verify-${crypto.randomBytes(4).toString('hex')}`);
  try {
    const dl = spawnSync('aws', ['s3', 'cp', s3Uri, tmp, '--only-show-errors'], {
      encoding: 'utf8', timeout: 15 * 60 * 1000,
    });
    if (dl.status !== 0) {
      return { ok: false, error: String(dl.stderr || dl.error || 's3 download failed').trim() };
    }
    const got = sha256File(tmp);
    if (got !== expectedSha256) return { ok: false, error: `s3 checksum mismatch ${got}≠${expectedSha256}` };
    return { ok: true, checksum: got };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* */ }
  }
}

async function runBackup() {
  if (backupLock) return { ok: false, error: 'backup already running' };
  backupLock = true;
  const started = Date.now();
  try { writeStatus({ last_attempt_at: new Date().toISOString() }); } catch { /* status must not block the snapshot */ }
  let tmpDir = null;
  try {
    ensureDir();
    const password = assertBackupPolicy();
    // Reclaim bounded retention before allocating a new snapshot. Waiting
    // until the end cannot recover a filesystem that is already full.
    const localPrune = pruneOld();
    if (localPrune.failures.length) {
      throw new Error(`backup retention cleanup failed for ${localPrune.failures.length} local files`);
    }
    let filesystemOffsiteDir = null;
    let demoForbidsOffsite = false;
    try {
      demoForbidsOffsite = require('./lib/demo-mode').isDemoMode();
    } catch {
      demoForbidsOffsite = /^(true|1|yes)$/i.test(String(process.env.ERP_DEMO_MODE || ''));
    }
    const schedule = getBackupSchedule();
    if (!demoForbidsOffsite && !process.env.BACKUP_S3_URI && process.env.BACKUP_OFFSITE_DIR) {
      filesystemOffsiteDir = assertManagedBackupDirectory(process.env.BACKUP_OFFSITE_DIR, BACKUP_DIR);
      if (sameFilesystemDevice(BACKUP_DIR, filesystemOffsiteDir) && process.env.BACKUP_ALLOW_SAME_DEVICE !== '1') {
        if (isProduction()) throw new Error('BACKUP_OFFSITE_DIR is on the same device as BACKUP_DIR (not off-server)');
        throw new Error('same-device offsite rejected (set BACKUP_ALLOW_SAME_DEVICE=1 for local drills)');
      }
      const offsitePrune = pruneBackupDirectory(filesystemOffsiteDir, {
        requireMarker: true,
        primaryDir: BACKUP_DIR,
        verifyChecksum: true,
        retention: schedule.retention,
        keepNewest: schedule.keep_newest,
      });
      if (offsitePrune.failures.length) {
        throw new Error(`backup retention cleanup failed for ${offsitePrune.failures.length} offsite files`);
      }
    }
    tmpDir = path.join(BACKUP_DIR, `.tmp-pkg-${crypto.randomBytes(6).toString('hex')}`);
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const companySnaps = await snapshotCompanyDbs(tmpDir);
    if (!companySnaps.length) throw new Error('no company databases found to back up');

    const useZip = true;
    let fileName = `crm-backup-${tsName()}.zip`;
    const tmpOut = path.join(BACKUP_DIR, `.partial-${crypto.randomBytes(4).toString('hex')}.zip`);
    const manifest = createZipBackup(tmpOut, companySnaps);

    let encrypted = false;
    let outPath = tmpOut;
    if (password) {
      const encPath = tmpOut + '.enc';
      encryptFile(tmpOut, encPath, password);
      fs.unlinkSync(tmpOut);
      outPath = encPath;
      fileName += '.enc';
      encrypted = true;
    } else if (isProduction()) {
      throw new Error('refusing plaintext backup in production');
    }

    const finalPath = path.join(BACKUP_DIR, fileName);
    fs.renameSync(outPath, finalPath);

    const latest = path.join(BACKUP_DIR, encrypted ? 'crm-latest.zip.enc' : 'crm-latest.zip');
    for (const p of [
      path.join(BACKUP_DIR, 'crm-latest.zip'),
      path.join(BACKUP_DIR, 'crm-latest.zip.enc'),
      path.join(BACKUP_DIR, 'crm-latest.tar.gz'),
      path.join(BACKUP_DIR, 'crm-latest.tar.gz.enc'),
    ]) {
      try { fs.unlinkSync(p); } catch { /* */ }
    }
    fs.copyFileSync(finalPath, latest);

    const checksum = sha256File(finalPath);
    fs.writeFileSync(finalPath + '.sha256', `${checksum}  ${path.basename(finalPath)}\n`, { mode: 0o600 });

    let offsite = { configured: false, ok: false, method: null };
    if (demoForbidsOffsite) {
      offsite = { configured: false, ok: false, method: null, skipped: 'demo' };
    } else if (process.env.BACKUP_S3_URI) {
      offsite.configured = true;
      offsite.method = 's3';
      const target = process.env.BACKUP_S3_URI.replace(/\/$/, '') + '/' + path.basename(finalPath);
      const up = spawnSync('aws', ['s3', 'cp', finalPath, target, '--only-show-errors'], { encoding: 'utf8', timeout: 15 * 60 * 1000 });
      offsite = {
        configured: true, method: 's3', ok: up.status === 0, target,
        error: up.status === 0 ? null : String(up.stderr || up.error || 'upload failed').trim(),
      };
      if (!offsite.ok) throw new Error(`off-site backup failed: ${offsite.error}`);
      const side = spawnSync('aws', ['s3', 'cp', finalPath + '.sha256', target + '.sha256', '--only-show-errors'], {
        encoding: 'utf8', timeout: 5 * 60 * 1000,
      });
      if (side.status !== 0) throw new Error('off-site sidecar upload failed');
      // Round-trip: download archive and confirm SHA-256 matches local.
      const roundTrip = verifyS3ObjectChecksum(target, checksum);
      if (!roundTrip.ok) throw new Error(`off-site s3 verify failed: ${roundTrip.error}`);
      offsite.verify = roundTrip;
    } else if (process.env.BACKUP_OFFSITE_DIR) {
      offsite.configured = true;
      offsite.method = 'fs';
      const destDir = filesystemOffsiteDir || path.resolve(process.env.BACKUP_OFFSITE_DIR);
      const target = copyFilesystemBackupAtomic(finalPath, destDir, checksum);
      offsite = { configured: true, method: 'fs', ok: true, target, error: null };
    }

    pruneOld();
    const sizeMB = (fs.statSync(finalPath).size / 1024 / 1024).toFixed(2);
    const integrity = companySnaps.every((c) => c.fingerprint.integrity === 'ok') ? 'ok' : 'fail';
    const fingerprints = companySnaps.map((c) => ({
      company_id: c.id, name: c.name, code: c.code, ...c.fingerprint,
    }));
    writeStatus({
      last: {
        ok: true, file: fileName, checksum, encrypted, offsite, sizeMB,
        duration_ms: Date.now() - started, companies: manifest.companies.length,
        fingerprints,
        disk_free_bytes: diskFreeBytes(BACKUP_DIR),
        finished_at: new Date().toISOString(),
      },
    });
    console.log(`✅ پشتیبان: ${fileName} (${sizeMB} MB)${encrypted ? ' 🔒' : ''}`);
    return {
      ok: true, file: fileName, path: finalPath, local: finalPath, sizeMB,
      encrypted, latest, checksum, integrity, offsite, fingerprints,
      manifest_version: PACKAGE_VERSION,
    };
  } catch (e) {
    console.error('backup error:', e.message);
    writeStatus({ last: { ok: false, error: e.message, duration_ms: Date.now() - started } });
    return { ok: false, error: e.message };
  } finally {
    backupLock = false;
    if (tmpDir) try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  }
}

function resolveBackupFile(name) {
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) return null;
  const fp = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(fp)) return null;
  return fp;
}

function getLatestBackupFile() {
  ensureDir();
  const candidates = [
    'crm-latest.zip.enc', 'crm-latest.tar.gz.enc',
    'crm-latest.zip', 'crm-latest.tar.gz',
  ].map((n) => path.join(BACKUP_DIR, n));
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return candidates[candidates.length - 1];
}

/** Verify archive (and decrypt if needed). Does NOT mutate production DB. */
function verifyBackupPackage(archivePath, options = {}) {
  const AdmZip = require('adm-zip');
  const tmp = path.join(BACKUP_DIR, `.verify-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  let zipPath = archivePath;
  let decryptedTemp = null;
  try {
    if (String(archivePath).endsWith('.enc')) {
      const password = options.password || getBackupPassword();
      if (!password) throw new Error('رمز پشتیبان برای تأیید لازم است');
      decryptedTemp = path.join(tmp, 'payload.zip');
      decryptFile(archivePath, decryptedTemp, password);
      zipPath = decryptedTemp;
    }
    if (!/\.zip$/i.test(zipPath)) throw new Error('only zip packages are supported for verify');
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    const seen = new Set();
    for (const ent of entries) {
      const name = String(ent.entryName || '').replace(/\\/g, '/');
      if (!name || name.includes('..') || path.isAbsolute(name) || name.startsWith('/')) {
        throw new Error(`unsafe entry rejected: ${name}`);
      }
      if (seen.has(name)) throw new Error(`duplicate entry: ${name}`);
      seen.add(name);
      if (ent.getData().length > 512 * 1024 * 1024) throw new Error(`entry oversize: ${name}`);
    }
    zip.extractAllTo(tmp, true);
    const manifestPath = path.join(tmp, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error('manifest.json missing');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest.files || !Array.isArray(manifest.files)) throw new Error('manifest.files missing');
    for (const meta of manifest.files) {
      const fp = path.join(tmp, meta.path);
      if (!fp.startsWith(tmp + path.sep)) throw new Error(`path escape: ${meta.path}`);
      if (!fs.existsSync(fp)) throw new Error(`missing file: ${meta.path}`);
      const st = fs.statSync(fp);
      if (st.size !== meta.size) throw new Error(`size mismatch: ${meta.path}`);
      if (sha256File(fp) !== meta.sha256) throw new Error(`hash mismatch: ${meta.path}`);
    }
    const dbs = [];
    if (fs.existsSync(path.join(tmp, 'crm.db'))) dbs.push(path.join(tmp, 'crm.db'));
    const companyDir = path.join(tmp, 'companies');
    if (fs.existsSync(companyDir)) {
      for (const name of fs.readdirSync(companyDir)) {
        if (name.endsWith('.db')) dbs.push(path.join(companyDir, name));
      }
    }
    const fingerprints = [];
    for (const dbPath of dbs) {
      const fp = fingerprintDb(dbPath);
      if (fp.integrity !== 'ok') throw new Error(`integrity failed: ${path.basename(dbPath)}`);
      fingerprints.push({ db: path.relative(tmp, dbPath).replace(/\\/g, '/'), ...fp });
    }
    return {
      ok: true,
      verified: true,
      restore_applied: false,
      manifest_version: manifest.version,
      companies: manifest.companies || [],
      fingerprints,
      files: manifest.files.length,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function stagingFile(staging, rel) {
  const norm = String(rel || '').replace(/\\/g, '/');
  if (!norm || norm.includes('..') || path.isAbsolute(norm) || norm.startsWith('/')) {
    throw new Error(`unsafe restore entry: ${norm}`);
  }
  const root = path.resolve(staging);
  const fp = path.resolve(staging, norm);
  if (fp !== root && !fp.startsWith(root + path.sep)) throw new Error(`path escape: ${norm}`);
  return fp;
}

/** Replace a SQLite file with a consistent snapshot and drop leftover WAL sidecars. */
function applySqliteSnapshot(srcPath, destPath) {
  if (!fs.existsSync(srcPath)) throw new Error('snapshot missing');
  const destDir = path.dirname(destPath);
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const tmp = path.join(destDir, `.${path.basename(destPath)}.restore-${stamp}`);
  fs.copyFileSync(srcPath, tmp);
  const moved = [];
  let pre = null;
  try {
    for (const suf of ['-wal', '-shm']) {
      const side = destPath + suf;
      if (!fs.existsSync(side)) continue;
      const aside = `${side}.aside-${stamp}`;
      fs.renameSync(side, aside);
      moved.push({ from: aside, to: side });
    }
    if (fs.existsSync(destPath)) {
      pre = `${destPath}.pre-restore-${stamp}`;
      fs.renameSync(destPath, pre);
    }
    fs.renameSync(tmp, destPath);
    for (const item of moved) fs.rmSync(item.from, { force: true });
    return pre;
  } catch (error) {
    if (!fs.existsSync(destPath) && pre && fs.existsSync(pre)) {
      try { fs.renameSync(pre, destPath); } catch { /* keep the pre-restore copy */ }
    }
    for (const item of moved) {
      if (!fs.existsSync(item.to) && fs.existsSync(item.from)) {
        try { fs.renameSync(item.from, item.to); } catch { /* keep the aside copy */ }
      }
    }
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
    throw error;
  }
}

/** Stage the new tree, then swap it into place so a failed copy does not wipe the live folder. */
function replaceDirAtomic(src, dest) {
  if (!fs.existsSync(src)) return null;
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const tmp = `${dest}.restore-new-${stamp}`;
  fs.cpSync(src, tmp, { recursive: true });
  let pre = null;
  if (fs.existsSync(dest)) {
    pre = `${dest}.pre-restore-${stamp}`;
    fs.renameSync(dest, pre);
  }
  try {
    fs.renameSync(tmp, dest);
  } catch {
    fs.cpSync(tmp, dest, { recursive: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return pre;
}

function companyRestorePlan(staging, options) {
  if (Array.isArray(options.companyTargets)) return options.companyTargets;
  if (options.dbPath || options.restoreCompanies === false) return [];
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf8'));
  } catch {
    return [];
  }
  let reg;
  try {
    reg = require('./lib/company-workspace').readRegistry();
  } catch {
    return [];
  }
  const plan = [];
  for (const company of manifest.companies || []) {
    const live = (reg.companies || []).find((row) => Number(row.id) === Number(company.id));
    if (!live?.dbPath || !company.entry) continue;
    plan.push({ id: company.id, entry: company.entry, destPath: path.resolve(live.dbPath) });
  }
  return plan;
}

/**
 * Offline/maintenance restore only. Callers must stop the live service.
 * Online HTTP handlers must use verifyBackupPackage instead.
 */
function restoreBackup(archivePath, options = {}) {
  if (!options.confirmOfflineRestore) {
    throw new Error('online restore disabled — use verify only; CLI restore requires confirmOfflineRestore');
  }
  const verify = verifyBackupPackage(archivePath, options);
  if (!verify.ok) throw new Error('verify failed');
  const AdmZip = require('adm-zip');
  const staging = options.targetDir || path.join(BACKUP_DIR, `.restore-stage-${Date.now()}`);
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  let zipPath = archivePath;
  try {
    if (String(archivePath).endsWith('.enc')) {
      const password = options.password || getBackupPassword();
      const decrypted = path.join(staging, 'payload.zip');
      decryptFile(archivePath, decrypted, password);
      zipPath = decrypted;
    }
    new AdmZip(zipPath).extractAllTo(staging, true);
    const restoredCompanies = [];
    for (const target of companyRestorePlan(staging, options)) {
      const src = stagingFile(staging, target.entry);
      if (!fs.existsSync(src)) throw new Error(`company snapshot missing: ${target.entry}`);
      applySqliteSnapshot(src, path.resolve(target.destPath));
      restoredCompanies.push(Number(target.id));
    }
    const dbSrc = stagingFile(staging, 'crm.db');
    if (!fs.existsSync(dbSrc)) throw new Error('crm.db در پشتیبان یافت نشد');
    const DB_PATH = options.dbPath || resolveBackupDbPath();
    const pre = applySqliteSnapshot(dbSrc, DB_PATH);
    const uploadsSrc = path.join(staging, 'uploads');
    if (fs.existsSync(uploadsSrc) && options.restoreUploads !== false) {
      replaceDirAtomic(uploadsSrc, options.uploadsRoot || UPLOADS_ROOT);
    }
    const privateSrc = path.join(staging, 'private-uploads');
    if (fs.existsSync(privateSrc) && options.restorePrivate !== false) {
      let privateRoot = options.privateRoot || null;
      if (!privateRoot) {
        try { privateRoot = require('./lib/private-uploads').PRIVATE_UPLOADS_ROOT; } catch { privateRoot = null; }
      }
      if (privateRoot) replaceDirAtomic(privateSrc, privateRoot);
    }
    return { ok: true, pre_restore_db: pre, restored_companies: restoredCompanies, verify };
  } finally {
    if (!options.keepStaging) fs.rmSync(staging, { recursive: true, force: true });
  }
}

const LATEST_POINTER_NAMES = [
  'crm-latest.zip.enc', 'crm-latest.tar.gz.enc', 'crm-latest.zip', 'crm-latest.tar.gz',
];

function backupHttpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code || null;
  return err;
}

function confinedDir(dir) {
  const resolved = path.resolve(dir);
  const st = fs.lstatSync(resolved);
  if (!st.isDirectory() || st.isSymbolicLink()) throw backupHttpError(500, 'پوشهٔ پشتیبان نامعتبر است', 'UNSAFE_DIR');
  return fs.realpathSync(resolved);
}

function unlinkRegularInside(dirReal, filePath) {
  const st = fs.lstatSync(filePath);
  if (!st.isFile() || st.isSymbolicLink()) throw backupHttpError(400, 'فایل پشتیبان نامعتبر است', 'UNSAFE_FILE');
  const real = fs.realpathSync(filePath);
  const rel = path.relative(dirReal, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw backupHttpError(400, 'مسیر پشتیبان مجاز نیست', 'PATH_ESCAPE');
  fs.unlinkSync(filePath);
  return st.size;
}

function unlinkArchivePair(dir, name) {
  if (!BACKUP_ARCHIVE_RE.test(name)) throw backupHttpError(400, 'نام فایل پشتیبان نامعتبر است', 'BAD_NAME');
  const dirReal = confinedDir(dir);
  const archive = path.join(dirReal, name);
  if (!fs.existsSync(archive)) return { removed: false, bytes: 0 };
  let bytes = unlinkRegularInside(dirReal, archive);
  const sidecar = archive + '.sha256';
  if (fs.existsSync(sidecar)) {
    try { bytes += unlinkRegularInside(dirReal, sidecar); } catch { /* sidecar is optional metadata */ }
  }
  return { removed: true, bytes };
}

function removeLatestPointers(dir) {
  const dirReal = confinedDir(dir);
  let bytes = 0;
  for (const name of LATEST_POINTER_NAMES) {
    const fp = path.join(dirReal, name);
    if (!fs.existsSync(fp)) continue;
    try { bytes += unlinkRegularInside(dirReal, fp); } catch { /* pointer may already be gone */ }
  }
  return bytes;
}

function dropMatchingLatestPointer(checksum) {
  if (!checksum) return 0;
  let bytes = 0;
  const dirReal = confinedDir(BACKUP_DIR);
  for (const name of LATEST_POINTER_NAMES) {
    const fp = path.join(dirReal, name);
    if (!fs.existsSync(fp)) continue;
    try {
      if (sha256File(fp) !== checksum) continue;
      bytes += unlinkRegularInside(dirReal, fp);
    } catch { /* leave an unreadable pointer for the next backup */ }
  }
  return bytes;
}

function offsiteDirOrError() {
  if (!process.env.BACKUP_OFFSITE_DIR) return { dir: null, error: null };
  try {
    return { dir: assertManagedBackupDirectory(process.env.BACKUP_OFFSITE_DIR, BACKUP_DIR), error: null };
  } catch (error) {
    return { dir: null, error: error.message };
  }
}

function removeS3Name(name) {
  if (!process.env.BACKUP_S3_URI || !BACKUP_ARCHIVE_RE.test(name)) return null;
  const target = process.env.BACKUP_S3_URI.replace(/\/$/, '') + '/' + name;
  const rm = spawnSync('aws', ['s3', 'rm', target, '--only-show-errors'], { encoding: 'utf8', timeout: 120000 });
  spawnSync('aws', ['s3', 'rm', target + '.sha256', '--only-show-errors'], { encoding: 'utf8', timeout: 60000 });
  if (rm.status !== 0) return { ok: false, error: String(rm.stderr || rm.error || 's3 rm failed').trim(), target };
  return { ok: true, target };
}

function verifiedOtherThan(dir, name) {
  return listBackupsIn(dir).some((item) => item.name !== name && sidecarWellFormed(dir, item));
}

function deleteBackupArchive(name, options = {}) {
  if (backupLock) throw backupHttpError(409, 'پشتیبان‌گیری در حال اجراست — کمی بعد دوباره حذف کنید', 'BACKUP_BUSY');
  const confirmName = options.confirmName != null ? String(options.confirmName) : '';
  if (!name || name !== confirmName || !BACKUP_ARCHIVE_RE.test(name) || /[\\/]/.test(name) || name.includes('..')) {
    throw backupHttpError(400, 'برای حذف، نام فایل را دقیقاً تأیید کنید', 'CONFIRM_NAME');
  }
  const fp = resolveBackupFile(name);
  if (!fp) throw backupHttpError(404, 'فایل پشتیبان یافت نشد', 'NOT_FOUND');
  const verified = sidecarWellFormed(BACKUP_DIR, { name });
  const offsite = offsiteDirOrError();
  const offsiteOther = offsite.dir ? verifiedOtherThan(offsite.dir, name) : false;
  if (verified && !verifiedOtherThan(BACKUP_DIR, name) && !offsiteOther && options.force !== true) {
    throw backupHttpError(403, 'این تنها نسخهٔ تأییدشده است. حذف فقط با تأیید اجباری ممکن است', 'LAST_VERIFIED');
  }
  let checksum = null;
  try {
    const line = fs.readFileSync(fp + '.sha256', 'utf8').trim();
    const match = /^([a-f0-9]{64})\s+/i.exec(line);
    checksum = match ? match[1].toLowerCase() : null;
  } catch { checksum = null; }
  const local = unlinkArchivePair(BACKUP_DIR, name);
  let freed = local.bytes + dropMatchingLatestPointer(checksum);
  if (listBackupsIn(BACKUP_DIR).length === 0) freed += removeLatestPointers(BACKUP_DIR);
  let offsiteResult = null;
  if (offsite.dir) {
    try {
      const removed = unlinkArchivePair(offsite.dir, name);
      offsiteResult = { ok: true, removed: removed.removed, bytes: removed.bytes };
      freed += removed.bytes;
    } catch (error) {
      offsiteResult = { ok: false, error: error.message };
    }
  } else if (offsite.error) {
    offsiteResult = { ok: false, error: offsite.error };
  }
  return {
    ok: true,
    name,
    freed_bytes: freed,
    force: options.force === true,
    offsite: offsiteResult,
    s3: removeS3Name(name),
  };
}

function isPurgePartial(name) {
  return name.startsWith('.partial-') && (name.includes('crm-backup') || /\.(zip|tar\.gz)(\.enc)?$/i.test(name));
}

function purgePartials(dirReal) {
  let bytes = 0;
  let removed = 0;
  for (const name of fs.readdirSync(dirReal)) {
    if (!isPurgePartial(name) || name.includes('..')) continue;
    const fp = path.join(dirReal, name);
    try {
      bytes += unlinkRegularInside(dirReal, fp);
      removed++;
    } catch { /* leave unsafe entries in place */ }
  }
  return { removed, bytes };
}

function purgeBackupArchives(options = {}) {
  if (backupLock) throw backupHttpError(409, 'پشتیبان‌گیری در حال اجراست', 'BACKUP_BUSY');
  if (!options || options.confirm !== 'PURGE-ALL-BACKUPS') {
    throw backupHttpError(400, 'عبارت تأیید پاکسازی نادرست است', 'CONFIRM_PURGE');
  }
  let freed = 0;
  let removed = 0;
  const failures = [];
  for (const item of listBackupsIn(BACKUP_DIR)) {
    try {
      const result = unlinkArchivePair(BACKUP_DIR, item.name);
      if (result.removed) removed++;
      freed += result.bytes;
    } catch (error) {
      failures.push({ name: item.name, error: error.message });
    }
  }
  freed += removeLatestPointers(BACKUP_DIR);
  const partials = purgePartials(confinedDir(BACKUP_DIR));
  freed += partials.bytes;
  removed += partials.removed;
  const offsite = offsiteDirOrError();
  let offsiteRemoved = 0;
  if (offsite.dir) {
    for (const item of listBackupsIn(offsite.dir)) {
      try {
        const result = unlinkArchivePair(offsite.dir, item.name);
        if (result.removed) offsiteRemoved++;
        freed += result.bytes;
      } catch (error) {
        failures.push({ name: item.name, error: error.message, where: 'offsite' });
      }
    }
    freed += removeLatestPointers(offsite.dir);
    const offPartials = purgePartials(offsite.dir);
    freed += offPartials.bytes;
    offsiteRemoved += offPartials.removed;
  }
  let s3 = null;
  if (process.env.BACKUP_S3_URI) {
    const rm = spawnSync('aws', [
      's3', 'rm', process.env.BACKUP_S3_URI.replace(/\/$/, '') + '/',
      '--recursive', '--exclude', '*', '--include', 'crm-backup-*', '--only-show-errors',
    ], { encoding: 'utf8', timeout: 180000 });
    s3 = { ok: rm.status === 0, error: rm.status === 0 ? null : String(rm.stderr || rm.error || 's3 rm failed').trim() };
  }
  return {
    ok: failures.length === 0,
    removed,
    offsite_removed: offsiteRemoved,
    offsite_error: offsite.error,
    freed_bytes: freed,
    failures,
    s3,
  };
}

function lastSuccessMs() {
  const status = readStatus();
  const stamp = status.last && status.last.ok && status.last.finished_at;
  const parsed = stamp ? Date.parse(stamp) : NaN;
  if (Number.isFinite(parsed)) return parsed;
  try {
    const latest = getLatestBackupFile();
    if (latest && fs.existsSync(latest)) return fs.statSync(latest).mtimeMs;
  } catch { /* */ }
  return 0;
}

function lastAttemptMs() {
  const status = readStatus();
  const parsed = status.last_attempt_at ? Date.parse(status.last_attempt_at) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

async function maybeRunScheduledBackup(now = new Date()) {
  if (backupLock) return { ok: true, skipped: 'busy' };
  const schedule = getBackupSchedule();
  const decision = scheduleDue(schedule, now, Math.max(lastSuccessMs(), lastAttemptMs()));
  let due = decision.due;
  if (!due && schedule.enabled && withinBackupWindow(schedule, now)) {
    try {
      const empty = listBackupsIn(BACKUP_DIR).length === 0;
      const retryMs = Math.min(schedule.interval_min, 15) * 60000;
      if (empty && (now.getTime() - lastAttemptMs()) >= retryMs) due = true;
    } catch { /* an unsafe directory must not start a backup */ }
  }
  if (!due) return { ok: true, skipped: decision.reason, schedule };
  return runBackup();
}

module.exports = {
  runBackup,
  listBackups,
  resolveBackupFile,
  getLatestBackupFile,
  getBackupPassword,
  encryptFile,
  decryptFile,
  restoreBackup,
  verifyBackupPackage,
  sameFilesystemDevice,
  fingerprintDb,
  compareFingerprints,
  getBackupHealth,
  recordDrillResult,
  readStatus,
  writeStatus,
  verifyS3ObjectChecksum,
  pruneBackupDirectory,
  assertManagedBackupDirectory,
  copyFilesystemBackupAtomic,
  normalizeSchedule,
  scheduleDue,
  getBackupSchedule,
  saveBackupSchedule,
  deleteBackupArchive,
  purgeBackupArchives,
  maybeRunScheduledBackup,
  DEFAULT_BACKUP_SCHEDULE,
  BACKUP_ROOT_MARKER,
  BACKUP_ROOT_MARKER_CONTENT,
  BACKUP_DIR,
  PACKAGE_VERSION,
};
