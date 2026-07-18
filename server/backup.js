const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { UPLOADS_ROOT } = require('./paths');

const SERVER_DIR = __dirname;
const DB_PATH = process.env.DB_PATH || path.join(SERVER_DIR, 'crm.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(SERVER_DIR, 'backups');
const MAX_KEEP = Math.min(parseInt(process.env.BACKUP_KEEP_COUNT) || 14, 60);

function ensureDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  return BACKUP_DIR;
}

function tsName() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ── Backup encryption (AES-256-GCM) ──────────────────────────────────────────
// Password comes from env BACKUP_PASSWORD, or the settings key backup_password
// (set by the admin in the backup page). If neither is set, backups stay plain.
// File format: MAGIC(8) + salt(16) + iv(12) + ciphertext + authTag(16)
const ENC_MAGIC = Buffer.from('TRNMBKP1', 'ascii');

function getBackupPassword() {
  if (process.env.BACKUP_PASSWORD) return process.env.BACKUP_PASSWORD;
  try {
    const { getDB } = require('./db');
    const row = getDB().prepare("SELECT value FROM settings WHERE key='backup_password'").get();
    return (row && row.value) ? row.value : null;
  } catch { return null; }
}

function encryptFile(srcPath, destPath, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = fs.readFileSync(srcPath);
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  fs.writeFileSync(destPath, Buffer.concat([ENC_MAGIC, salt, iv, enc, cipher.getAuthTag()]));
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
  fs.writeFileSync(destPath, out);
}

function listBackups() {
  ensureDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => /^crm-backup-.*\.(tar\.gz|zip)(\.enc)?$/i.test(f))
    .map(name => {
      const fp = path.join(BACKUP_DIR, name);
      const st = fs.statSync(fp);
      return {
        name,
        size: st.size,
        sizeMB: (st.size / 1024 / 1024).toFixed(2),
        encrypted: name.endsWith('.enc'),
        created_at: Math.floor(st.mtimeMs / 1000)
      };
    })
    .sort((a, b) => b.created_at - a.created_at);
}

function pruneOld() {
  const items = listBackups();
  for (const old of items.slice(MAX_KEEP)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, old.name)); } catch { /* */ }
  }
}

function addFileToZip(zip, filePath, entryName) {
  if (!fs.existsSync(filePath)) return;
  const st = fs.statSync(filePath);
  if (st.isDirectory()) {
    for (const ent of fs.readdirSync(filePath, { withFileTypes: true })) {
      addFileToZip(zip, path.join(filePath, ent.name), path.join(entryName, ent.name).replace(/\\/g, '/'));
    }
  } else {
    zip.addFile(entryName.replace(/\\/g, '/'), fs.readFileSync(filePath));
  }
}

function createZipBackup(outPath) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  const manifest = {
    version: 1,
    created_at: new Date().toISOString(),
    app: 'crm-taranom',
    files: []
  };
  if (fs.existsSync(DB_PATH)) {
    zip.addFile('crm.db', fs.readFileSync(DB_PATH));
    manifest.files.push('crm.db');
  }
  if (fs.existsSync(UPLOADS_ROOT)) {
    addFileToZip(zip, UPLOADS_ROOT, 'uploads');
    manifest.files.push('uploads/');
  }
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  zip.writeZip(outPath);
}

function createTarBackup(outPath) {
  const tmp = path.join(BACKUP_DIR, `.tmp-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, path.join(tmp, 'crm.db'));
    if (fs.existsSync(UPLOADS_ROOT)) {
      execSync(`cp -a "${UPLOADS_ROOT}" "${path.join(tmp, 'uploads')}"`, { stdio: 'pipe' });
    }
    const manifest = { version: 1, created_at: new Date().toISOString(), app: 'crm-taranom' };
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));
    execSync(`tar -czf "${outPath}" -C "${tmp}" .`, { timeout: 300000, stdio: 'pipe' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function runBackup() {
  try {
    ensureDir();
    const useZip = process.platform === 'win32';
    const ext = useZip ? 'zip' : 'tar.gz';
    let fileName = `crm-backup-${tsName()}.${ext}`;
    let outPath = path.join(BACKUP_DIR, fileName);

    if (useZip) createZipBackup(outPath);
    else {
      try { createTarBackup(outPath); }
      catch { createZipBackup(outPath); }
    }

    // Encrypt when a backup password is configured (env or settings)
    const password = getBackupPassword();
    let encrypted = false;
    if (password) {
      const encPath = outPath + '.enc';
      encryptFile(outPath, encPath, password);
      fs.unlinkSync(outPath);
      outPath = encPath;
      fileName += '.enc';
      encrypted = true;
    }

    // Symlink/copy latest for backward-compatible download endpoint
    const latestBase = path.join(BACKUP_DIR, useZip ? 'crm-latest.zip' : 'crm-latest.tar.gz');
    for (const p of [latestBase, latestBase + '.enc']) {
      try { fs.unlinkSync(p); } catch { /* */ }
    }
    const latest = encrypted ? latestBase + '.enc' : latestBase;
    fs.copyFileSync(outPath, latest);

    pruneOld();
    const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);
    console.log(`✅ پشتیبان: ${fileName} (${sizeMB} MB)${encrypted ? ' 🔒 رمزنگاری‌شده' : ''}`);
    return { ok: true, file: fileName, path: outPath, local: outPath, sizeMB, encrypted, latest };
  } catch (e) {
    console.error('backup error:', e.message);
    return { ok: false, error: e.message };
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
    'crm-latest.zip', 'crm-latest.tar.gz'
  ].map(n => path.join(BACKUP_DIR, n));
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return candidates[candidates.length - 1];
}

function restoreBackup(archivePath) {
  const path = require('path');
  const fs = require('fs');
  const { execSync } = require('child_process');
  const AdmZip = require('adm-zip');
  const tmp = path.join(BACKUP_DIR, `.restore-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    if (archivePath.endsWith('.zip') || archivePath.endsWith('.zip.enc')) {
      let zipPath = archivePath;
      if (archivePath.endsWith('.enc')) {
        const password = getBackupPassword();
        if (!password) throw new Error('رمز پشتیبان برای بازگشایی لازم است');
        zipPath = archivePath.replace(/\.enc$/, '');
        decryptFile(archivePath, zipPath, password);
      }
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(tmp, true);
      if (zipPath !== archivePath) try { fs.unlinkSync(zipPath); } catch { /* */ }
    } else {
      execSync(`tar -xzf "${archivePath}" -C "${tmp}"`, { stdio: 'pipe', timeout: 300000 });
    }
    const dbSrc = path.join(tmp, 'crm.db');
    if (!fs.existsSync(dbSrc)) throw new Error('crm.db در پشتیبان یافت نشد');
    const pre = DB_PATH + '.pre-restore-' + Date.now();
    if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, pre);
    fs.copyFileSync(dbSrc, DB_PATH);
    const uploadsSrc = path.join(tmp, 'uploads');
    if (fs.existsSync(uploadsSrc)) {
      fs.rmSync(UPLOADS_ROOT, { recursive: true, force: true });
      fs.cpSync(uploadsSrc, UPLOADS_ROOT, { recursive: true });
    }
    return { ok: true, pre_restore_db: pre };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = {
  runBackup, listBackups, resolveBackupFile, getLatestBackupFile,
  getBackupPassword, encryptFile, decryptFile, restoreBackup, BACKUP_DIR
};
