'use strict';

// Pull uploaded media referenced by synced rows. Product images remain public;
// message, voucher and representative media live outside the public web root.
// A filename alone is never authority: every read or pull must match a current
// allowlisted database reference.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { UPLOADS_ROOT } = require('../paths');
const {
  PRIVATE_UPLOADS_ROOT,
  locatePrivateFile,
} = require('../lib/private-uploads');
const { PROFILES, validateUploadedFile } = require('../lib/upload-policy');
const { createDeviceHeaders } = require('./device-auth');

const PUBLIC_UPLOADS_ROOT = path.resolve(UPLOADS_ROOT);
const PRIVATE_ROOT = path.resolve(PRIVATE_UPLOADS_ROOT);
const SKIP_KEY = 'sync_skipped_files';
const NEGATIVE_CACHE_TTL_MS = 60 * 1000;
const MAX_NEGATIVE_CACHE_ENTRIES = 2000;

const FILE_SOURCES = Object.freeze([
  { subdir: 'products', sql: "SELECT DISTINCT image AS name FROM products WHERE image IS NOT NULL AND image != ''", referenceSql: "SELECT 1 AS ok FROM products WHERE image=? LIMIT 1" },
  { subdir: 'products', sql: "SELECT DISTINCT filename AS name FROM product_images WHERE filename IS NOT NULL AND filename != ''", referenceSql: "SELECT 1 AS ok FROM product_images WHERE filename=? LIMIT 1" },
  { subdir: 'messages', sql: "SELECT DISTINCT image AS name FROM messages WHERE image IS NOT NULL AND image != ''", referenceSql: "SELECT 1 AS ok FROM messages WHERE image=? LIMIT 1" },
  { subdir: 'vouchers', sql: "SELECT DISTINCT attachment AS name FROM journal_entries WHERE attachment IS NOT NULL AND attachment != ''", referenceSql: "SELECT 1 AS ok FROM journal_entries WHERE attachment=? LIMIT 1" },
  { subdir: 'reps', sql: "SELECT DISTINCT receipt_file AS name FROM rep_payment_submissions WHERE receipt_file IS NOT NULL AND receipt_file != ''", referenceSql: "SELECT 1 AS ok FROM rep_payment_submissions WHERE receipt_file=? LIMIT 1" },
  { subdir: 'reps', sql: "SELECT DISTINCT receipt_file AS name FROM rep_expenses WHERE receipt_file IS NOT NULL AND receipt_file != ''", referenceSql: "SELECT 1 AS ok FROM rep_expenses WHERE receipt_file=? LIMIT 1" },
  { subdir: 'reps', sql: "SELECT DISTINCT contract_file AS name FROM users WHERE contract_file IS NOT NULL AND contract_file != ''", referenceSql: "SELECT 1 AS ok FROM users WHERE contract_file=? LIMIT 1" },
  { subdir: 'reps', sql: "SELECT DISTINCT photo_file AS name FROM rep_visit_logs WHERE photo_file IS NOT NULL AND photo_file != ''", referenceSql: "SELECT 1 AS ok FROM rep_visit_logs WHERE photo_file=? LIMIT 1" },
  { subdir: 'reps', sql: "SELECT DISTINCT signature_file AS name FROM rep_visit_logs WHERE signature_file IS NOT NULL AND signature_file != ''", referenceSql: "SELECT 1 AS ok FROM rep_visit_logs WHERE signature_file=? LIMIT 1" },
]);

const ALLOWED_SUBDIRS = new Set(['products', 'messages', 'vouchers', 'reps']);
const SENSITIVE_SUBDIRS = new Set(['messages', 'vouchers', 'reps']);
const ALLOWED_EXTENSIONS = Object.freeze({
  products: new Set(['.webp', '.png', '.jpg', '.jpeg']),
  messages: new Set(['.webp', '.png', '.jpg', '.jpeg']),
  vouchers: new Set(['.webp', '.png', '.jpg', '.jpeg', '.pdf']),
  reps: new Set(['.webp', '.png', '.jpg', '.jpeg', '.pdf']),
});
const PROFILE_BY_SUBDIR = Object.freeze({
  products: 'image',
  messages: 'messageImage',
  vouchers: 'document',
  reps: 'document',
});
const negativeMissingFiles = new Map();

function isSensitiveSubdir(subdir) {
  return SENSITIVE_SUBDIRS.has(String(subdir || ''));
}

function isValidFileName(name, subdir) {
  const value = typeof name === 'string' ? name : '';
  const category = String(subdir || '');
  if (!ALLOWED_SUBDIRS.has(category) || !value || Buffer.byteLength(value, 'utf8') > 220) return false;
  if (value !== path.basename(value) || value.startsWith('.') || value.includes('..')) return false;
  if (/[\\/:%\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value) || /[. ]$/.test(value)) return false;
  const stem = path.basename(value, path.extname(value));
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) return false;
  return ALLOWED_EXTENSIONS[category].has(path.extname(value).toLowerCase());
}

function parseFileReference(relativePath) {
  const value = typeof relativePath === 'string' ? relativePath : '';
  if (!value || Buffer.byteLength(value, 'utf8') > 260 || value.includes('\\') || value.includes('%')) return null;
  const parts = value.split('/');
  if (parts.length !== 2 || !isValidFileName(parts[1], parts[0])) return null;
  return { subdir: parts[0], name: parts[1] };
}

function sourcesFor(subdir) {
  return FILE_SOURCES.filter((source) => source.subdir === subdir);
}

function isReferencedFile(db, subdir, name) {
  if (!db || typeof db.prepare !== 'function' || !isValidFileName(name, subdir)) return false;
  for (const source of sourcesFor(subdir)) {
    try {
      if (db.prepare(source.referenceSql).get(name)) return true;
    } catch { /* A table/column may be absent on an older device schema. */ }
  }
  return false;
}

function getSkippedFiles(db) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(SKIP_KEY);
    const parsed = row ? JSON.parse(row.value) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => parseFileReference(item)).slice(0, 100_000);
  } catch { return []; }
}

function skipMissingFile(db, subdir, name) {
  if (!isReferencedFile(db, subdir, name)) return false;
  const key = `${subdir}/${name}`;
  const skipped = getSkippedFiles(db);
  if (!skipped.includes(key)) skipped.push(key);
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(SKIP_KEY, JSON.stringify(skipped));
  return true;
}

function collectNeededFiles(db) {
  const seen = new Set();
  const skipped = new Set(getSkippedFiles(db));
  const out = [];
  for (const source of FILE_SOURCES) {
    try {
      for (const row of db.prepare(source.sql).all()) {
        if (!isValidFileName(row && row.name, source.subdir)) continue;
        const key = `${source.subdir}/${row.name}`;
        if (seen.has(key) || skipped.has(key)) continue;
        seen.add(key);
        out.push({ subdir: source.subdir, name: row.name });
      }
    } catch { /* A table/column may be absent on an older device schema. */ }
  }
  return out;
}

function storageRootFor(subdir) {
  if (!ALLOWED_SUBDIRS.has(subdir)) throw new Error('Sync file category is not allowed');
  return isSensitiveSubdir(subdir) ? PRIVATE_ROOT : PUBLIC_UPLOADS_ROOT;
}

function localFilePath(subdir, name) {
  if (!isValidFileName(name, subdir)) throw new Error('Sync filename is invalid');
  const root = storageRootFor(subdir);
  const categoryRoot = path.resolve(root, subdir);
  const target = path.resolve(categoryRoot, name);
  if (!categoryRoot.startsWith(root + path.sep) || !target.startsWith(categoryRoot + path.sep)) {
    throw new Error('Sync file path escaped its storage root');
  }
  return target;
}

function maxBytesFor(subdir) {
  return PROFILES[PROFILE_BY_SUBDIR[subdir]].maxBytes;
}

function regularFile(target, maxBytes) {
  try {
    const stat = fs.lstatSync(target);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maxBytes ? stat : null;
  } catch { return null; }
}

function isPresent(subdir, name) {
  try { return !!regularFile(localFilePath(subdir, name), maxBytesFor(subdir)); }
  catch { return false; }
}

// Used by the authenticated central /api/sync/files route. Returning null for
// both an absent and an unreferenced file avoids turning filenames into an
// enumeration oracle. Legacy sensitive files migrate only after DB authority.
function resolveReferencedFile(db, subdir, name, { migrateLegacy = true } = {}) {
  if (!isReferencedFile(db, subdir, name)) return null;
  let target;
  try {
    target = isSensitiveSubdir(subdir)
      ? locatePrivateFile(subdir, name, { migrateLegacy })
      : localFilePath(subdir, name);
  } catch { return null; }
  return target && regularFile(target, maxBytesFor(subdir)) ? target : null;
}

function listMissingFiles(db) {
  return collectNeededFiles(db).filter((file) => !isPresent(file.subdir, file.name));
}

function countMissingFiles(db) {
  return listMissingFiles(db).length;
}

function negativeCacheKey(cfg, subdir, name) {
  return `${String(cfg.centralUrl || '').replace(/\/$/, '')}|${subdir}/${name}`;
}

function pruneNegativeCache(now = Date.now()) {
  for (const [key, expiresAt] of negativeMissingFiles) {
    if (expiresAt <= now) negativeMissingFiles.delete(key);
  }
  while (negativeMissingFiles.size > MAX_NEGATIVE_CACHE_ENTRIES) {
    negativeMissingFiles.delete(negativeMissingFiles.keys().next().value);
  }
}

function isRecentlyMissing(cfg, subdir, name) {
  const now = Date.now();
  pruneNegativeCache(now);
  return (negativeMissingFiles.get(negativeCacheKey(cfg, subdir, name)) || 0) > now;
}

function markMissing(cfg, subdir, name) {
  negativeMissingFiles.set(negativeCacheKey(cfg, subdir, name), Date.now() + NEGATIVE_CACHE_TTL_MS);
  pruneNegativeCache();
}

function clearMissing(cfg, subdir, name) {
  negativeMissingFiles.delete(negativeCacheKey(cfg, subdir, name));
}

async function readResponseBuffer(response, maxBytes) {
  const declaredHeader = response.headers && response.headers.get('content-length');
  const declared = declaredHeader == null || declaredHeader === '' ? NaN : Number(declaredHeader);
  if (Number.isFinite(declared) && (declared <= 0 || declared > maxBytes)) {
    const error = new Error('Sync file response size is invalid');
    error.code = 'SYNC_FILE_SIZE_REJECTED';
    throw error;
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > maxBytes) {
      const error = new Error('Sync file response size is invalid');
      error.code = 'SYNC_FILE_SIZE_REJECTED';
      throw error;
    }
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        const error = new Error('Sync file response exceeds its size limit');
        error.code = 'SYNC_FILE_SIZE_REJECTED';
        throw error;
      }
      chunks.push(chunk);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* response is already closed */ }
    throw error;
  }
  if (!total) {
    const error = new Error('Sync file response is empty');
    error.code = 'SYNC_FILE_SIZE_REJECTED';
    throw error;
  }
  return Buffer.concat(chunks, total);
}

async function validateDownloadedBuffer(buffer, response, subdir, name) {
  const mimetype = String(response.headers && response.headers.get('content-type') || 'application/octet-stream')
    .split(';')[0].trim().toLowerCase();
  // Validation decodes images and scans PDFs. Keep the original bytes because
  // legacy .png/.jpg DB references must retain their matching extension.
  await validateUploadedFile({
    buffer,
    size: buffer.length,
    originalname: name,
    mimetype,
    fieldname: 'file',
  }, PROFILE_BY_SUBDIR[subdir]);
}

function ensureDestinationDirectory(subdir) {
  const target = localFilePath(subdir, `probe${ALLOWED_EXTENSIONS[subdir].values().next().value}`);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Sync storage directory is unsafe');
  try { fs.chmodSync(dir, 0o700); } catch { /* Windows ACLs are managed by the host. */ }
  return dir;
}

function writeFileAtomic(subdir, name, buffer) {
  const dest = localFilePath(subdir, name);
  const dir = ensureDestinationDirectory(subdir);
  const temp = path.join(dir, `.sync-${crypto.randomBytes(18).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, buffer);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (regularFile(dest, maxBytesFor(subdir))) return dest;
    try {
      const existing = fs.lstatSync(dest);
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Sync destination is unsafe');
      fs.unlinkSync(dest); // invalid/empty cache file; the validated replacement is ready
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    // An exclusive hard-link publishes the fully fsynced temporary file and
    // cannot overwrite a path raced into place by another request.
    fs.linkSync(temp, dest);
    fs.unlinkSync(temp);
    try { fs.chmodSync(dest, 0o600); } catch { /* Windows ACLs are managed by the host. */ }
    return dest;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    try { fs.unlinkSync(temp); } catch { /* renamed or never created */ }
  }
}

async function pullOneFile(db, cfg, subdir, name) {
  if (!cfg || !cfg.centralUrl || !cfg.deviceId || !cfg.deviceToken) return false;
  if (!isReferencedFile(db, subdir, name)) return false;
  if (isPresent(subdir, name)) return true;
  if (isRecentlyMissing(cfg, subdir, name)) return false;

  const rel = `${subdir}/${name}`;
  const headers = createDeviceHeaders(cfg);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let response;
  try {
    response = await fetch(
      `${cfg.centralUrl.replace(/\/$/, '')}/api/sync/files?path=${encodeURIComponent(rel)}`,
      { headers, signal: controller.signal }
    );
    if (!response.ok) {
      if (response.status === 404 || response.status === 410) markMissing(cfg, subdir, name);
      try { if (response.body) await response.body.cancel(); } catch { /* ignore response cleanup */ }
      return false;
    }
    const buffer = await readResponseBuffer(response, maxBytesFor(subdir));
    await validateDownloadedBuffer(buffer, response, subdir, name);
    // The owning row may have been removed while the network request ran.
    if (!isReferencedFile(db, subdir, name)) return false;
    writeFileAtomic(subdir, name, buffer);
    clearMissing(cfg, subdir, name);
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

async function pullMissingFiles(db, cfg) {
  if (!cfg || !cfg.centralUrl || !cfg.deviceId || !cfg.deviceToken) {
    return { pulled: 0, failed: 0, failed_list: [] };
  }
  const needed = collectNeededFiles(db);
  let pulled = 0;
  let failed = 0;
  const failed_list = [];

  for (const { subdir, name } of needed) {
    if (isPresent(subdir, name)) continue;
    try {
      if (await pullOneFile(db, cfg, subdir, name)) pulled += 1;
      else if (isReferencedFile(db, subdir, name)) {
        failed += 1;
        failed_list.push({ subdir, name });
      }
    } catch (error) {
      failed += 1;
      failed_list.push({ subdir, name });
      console.error('sync file pull:', `${subdir}/${name}`, error.message);
    }
  }
  return { pulled, failed, failed_list };
}

function uploadFallbackMiddleware(getConfig, getDatabase) {
  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const parsed = parseFileReference(String(req.path || '').replace(/^\/+/, ''));
    // Public lazy loading exists only for product images. Sensitive media is
    // served by authenticated API routes from PRIVATE_UPLOADS_ROOT.
    if (!parsed || parsed.subdir !== 'products') return next();
    if (isPresent(parsed.subdir, parsed.name)) return next();

    let db;
    try {
      db = typeof getDatabase === 'function' ? getDatabase() : require('../db').getDB();
    } catch { return next(); }
    if (!isReferencedFile(db, parsed.subdir, parsed.name)) return next();

    const cfg = getConfig();
    if (!cfg || !cfg.centralUrl || !cfg.deviceId || !cfg.deviceToken) return next();

    try {
      const pulled = await pullOneFile(db, cfg, parsed.subdir, parsed.name);
      if (!pulled) return next();
      const filePath = localFilePath(parsed.subdir, parsed.name);
      if (req.method === 'HEAD') return res.end();
      return res.sendFile(filePath);
    } catch (error) {
      console.error('upload fallback:', `${parsed.subdir}/${parsed.name}`, error.message);
      return next();
    }
  };
}

module.exports = {
  FILE_SOURCES,
  ALLOWED_SUBDIRS,
  collectNeededFiles,
  listMissingFiles,
  pullMissingFiles,
  pullOneFile,
  countMissingFiles,
  skipMissingFile,
  isPresent,
  isValidFileName,
  isReferencedFile,
  isSensitiveSubdir,
  parseFileReference,
  resolveReferencedFile,
  localFilePath,
  uploadFallbackMiddleware,
  _test: {
    negativeMissingFiles,
    readResponseBuffer,
    validateDownloadedBuffer,
    writeFileAtomic,
  },
};
