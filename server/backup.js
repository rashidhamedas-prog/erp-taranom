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

function listBackups() {
  ensureDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => /^crm-backup-.*\.(tar\.gz|zip)$/i.test(f))
    .map(name => {
      const fp = path.join(BACKUP_DIR, name);
      const st = fs.statSync(fp);
      return {
        name,
        size: st.size,
        sizeMB: (st.size / 1024 / 1024).toFixed(2),
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
    const fileName = `crm-backup-${tsName()}.${ext}`;
    const outPath = path.join(BACKUP_DIR, fileName);

    if (useZip) createZipBackup(outPath);
    else {
      try { createTarBackup(outPath); }
      catch { createZipBackup(outPath); }
    }

    // Symlink/copy latest for backward-compatible download endpoint
    const latest = path.join(BACKUP_DIR, useZip ? 'crm-latest.zip' : 'crm-latest.tar.gz');
    try { fs.unlinkSync(latest); } catch { /* */ }
    fs.copyFileSync(outPath, latest);

    pruneOld();
    const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);
    console.log(`✅ پشتیبان: ${fileName} (${sizeMB} MB)`);
    return { ok: true, file: fileName, path: outPath, local: outPath, sizeMB, latest };
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
  const zip = path.join(BACKUP_DIR, 'crm-latest.zip');
  const tar = path.join(BACKUP_DIR, 'crm-latest.tar.gz');
  if (fs.existsSync(zip)) return zip;
  if (fs.existsSync(tar)) return tar;
  return tar;
}

module.exports = { runBackup, listBackups, resolveBackupFile, getLatestBackupFile, BACKUP_DIR };
