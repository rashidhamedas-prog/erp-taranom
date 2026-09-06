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

function listBackups() {
  ensureDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^crm-backup-.*\.(tar\.gz|zip)(\.enc)?$/i.test(f))
    .map((name) => {
      const fp = path.join(BACKUP_DIR, name);
      const st = fs.statSync(fp);
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

function pruneOld() {
  // GFS-ish: keep all from last 24h, then daily/weekly/monthly buckets (cap total).
  const items = listBackups();
  const now = Date.now();
  const keep = new Set();
  const day = 86400000;
  for (const it of items) {
    const age = now - it.created_at * 1000;
    if (age <= day) keep.add(it.name);
  }
  const byDay = new Map();
  const byWeek = new Map();
  const byMonth = new Map();
  for (const it of items) {
    const d = new Date(it.created_at * 1000);
    const dayKey = d.toISOString().slice(0, 10);
    const weekKey = `${d.getUTCFullYear()}-W${Math.ceil((((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / day) + 1) / 7)}`;
    const monthKey = d.toISOString().slice(0, 7);
    if (!byDay.has(dayKey)) byDay.set(dayKey, it.name);
    if (!byWeek.has(weekKey)) byWeek.set(weekKey, it.name);
    if (!byMonth.has(monthKey)) byMonth.set(monthKey, it.name);
  }
  [...byDay.values()].slice(0, 31).forEach((n) => keep.add(n));
  [...byWeek.values()].slice(0, 12).forEach((n) => keep.add(n));
  [...byMonth.values()].slice(0, 12).forEach((n) => keep.add(n));
  for (const old of items) {
    if (keep.has(old.name)) continue;
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, old.name));
      try { fs.unlinkSync(path.join(BACKUP_DIR, old.name + '.sha256')); } catch { /* */ }
    } catch { /* */ }
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
  const last = status.last || null;
  const drill = status.last_drill || null;
  const latest = getLatestBackupFile();
  const latestAgeMin = latest && fs.existsSync(latest)
    ? Math.round((Date.now() - fs.statSync(latest).mtimeMs) / 60000)
    : null;
  const free = diskFreeBytes(BACKUP_DIR);
  const minFreeMb = Number(options.minFreeMb || process.env.BACKUP_MIN_FREE_MB || 512);
  const maxAgeMin = Number(options.maxAgeMin || process.env.BACKUP_MAX_AGE_MIN || 20);
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
  let tmpDir = null;
  try {
    ensureDir();
    const password = assertBackupPolicy();
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
    let demoForbidsOffsite = false;
    try {
      demoForbidsOffsite = require('./lib/demo-mode').isDemoMode();
    } catch {
      demoForbidsOffsite = /^(true|1|yes)$/i.test(String(process.env.ERP_DEMO_MODE || ''));
    }
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
      const destDir = path.resolve(process.env.BACKUP_OFFSITE_DIR);
      if (destDir === path.resolve(BACKUP_DIR)) throw new Error('BACKUP_OFFSITE_DIR must differ from BACKUP_DIR');
      fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
      if (sameFilesystemDevice(BACKUP_DIR, destDir) && process.env.BACKUP_ALLOW_SAME_DEVICE !== '1') {
        if (isProduction()) throw new Error('BACKUP_OFFSITE_DIR is on the same device as BACKUP_DIR (not off-server)');
        // non-prod: warn but allow only with explicit flag; tests set the flag
        if (process.env.BACKUP_ALLOW_SAME_DEVICE !== '1') {
          throw new Error('same-device offsite rejected (set BACKUP_ALLOW_SAME_DEVICE=1 for local drills)');
        }
      }
      const target = path.join(destDir, path.basename(finalPath));
      fs.copyFileSync(finalPath, target);
      fs.copyFileSync(finalPath + '.sha256', target + '.sha256');
      if (sha256File(target) !== checksum) throw new Error('off-site filesystem checksum mismatch');
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
  // Staging extract again for apply
  const AdmZip = require('adm-zip');
  const staging = options.targetDir || path.join(BACKUP_DIR, `.restore-stage-${Date.now()}`);
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  let zipPath = archivePath;
  let decrypted = null;
  try {
    if (String(archivePath).endsWith('.enc')) {
      const password = options.password || getBackupPassword();
      decrypted = path.join(staging, 'payload.zip');
      decryptFile(archivePath, decrypted, password);
      zipPath = decrypted;
    }
    new AdmZip(zipPath).extractAllTo(staging, true);
    const dbSrc = path.join(staging, 'crm.db');
    if (!fs.existsSync(dbSrc)) throw new Error('crm.db در پشتیبان یافت نشد');
    const DB_PATH = options.dbPath || resolveBackupDbPath();
    const pre = DB_PATH + '.pre-restore-' + Date.now();
    if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, pre);
    fs.copyFileSync(dbSrc, DB_PATH);
    const uploadsSrc = path.join(staging, 'uploads');
    if (fs.existsSync(uploadsSrc) && options.restoreUploads !== false) {
      fs.rmSync(UPLOADS_ROOT, { recursive: true, force: true });
      fs.cpSync(uploadsSrc, UPLOADS_ROOT, { recursive: true });
    }
    const privateSrc = path.join(staging, 'private-uploads');
    if (fs.existsSync(privateSrc) && options.restorePrivate !== false) {
      try {
        const { PRIVATE_UPLOADS_ROOT } = require('./lib/private-uploads');
        fs.mkdirSync(PRIVATE_UPLOADS_ROOT, { recursive: true, mode: 0o700 });
        fs.cpSync(privateSrc, PRIVATE_UPLOADS_ROOT, { recursive: true });
      } catch { /* */ }
    }
    return { ok: true, pre_restore_db: pre, verify };
  } finally {
    if (!options.keepStaging) fs.rmSync(staging, { recursive: true, force: true });
  }
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
  BACKUP_DIR,
  PACKAGE_VERSION,
};
