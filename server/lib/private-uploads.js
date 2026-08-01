'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { UPLOADS_ROOT } = require('../paths');

const PUBLIC_ROOT = path.resolve(__dirname, '..', 'public');
const siblingPrivateRoot = path.resolve(path.dirname(path.resolve(UPLOADS_ROOT)), 'private-uploads');
const defaultPrivateRoot = siblingPrivateRoot === path.join(PUBLIC_ROOT, 'private-uploads')
  ? path.resolve(__dirname, '..', 'private-uploads')
  : siblingPrivateRoot;
const PRIVATE_UPLOADS_ROOT = process.env.PRIVATE_UPLOADS_DIR
  ? path.resolve(process.env.PRIVATE_UPLOADS_DIR)
  : defaultPrivateRoot;

if (PRIVATE_UPLOADS_ROOT === PUBLIC_ROOT || PRIVATE_UPLOADS_ROOT.startsWith(PUBLIC_ROOT + path.sep)) {
  throw new Error('PRIVATE_UPLOADS_DIR must be outside server/public');
}

const CATEGORIES = new Set(['messages', 'vouchers', 'reps', 'rubika']);

function assertCategory(category) {
  const value = String(category || '');
  if (!CATEGORIES.has(value)) throw new Error('Private upload category is not allowed');
  return value;
}

function assertStoredName(filename) {
  const value = String(filename || '');
  if (!value || value !== path.basename(value) || value.includes('..') || /[\\/\u0000-\u001f\u007f:]/.test(value) || Buffer.byteLength(value, 'utf8') > 240) {
    const error = new Error('نام فایل ذخیره‌شده معتبر نیست');
    error.status = 400;
    throw error;
  }
  return value;
}

function categoryDir(category) {
  const dir = path.resolve(PRIVATE_UPLOADS_ROOT, assertCategory(category));
  if (!dir.startsWith(PRIVATE_UPLOADS_ROOT + path.sep)) throw new Error('Private upload path escaped root');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* Windows ACLs are managed by the host. */ }
  return dir;
}

function privatePath(category, filename) {
  const dir = categoryDir(category);
  const target = path.resolve(dir, assertStoredName(filename));
  if (!target.startsWith(dir + path.sep)) throw new Error('Private upload path escaped category');
  return target;
}

function legacyPath(subdir, filename) {
  const safeSubdir = assertCategory(subdir);
  const root = path.resolve(UPLOADS_ROOT);
  const target = path.resolve(root, safeSubdir, assertStoredName(filename));
  if (!target.startsWith(root + path.sep)) throw new Error('Legacy upload path escaped root');
  return target;
}

function ensureRegularFile(target) {
  try {
    const stat = fs.lstatSync(target);
    return stat.isFile() && !stat.isSymbolicLink() ? stat : null;
  } catch { return null; }
}

function persistPrivateUpload(file, category, prefix = 'file') {
  if (!file || !file.uploadValidated || !Buffer.isBuffer(file.buffer)) {
    const error = new Error('فایل پیش از ذخیره‌سازی اعتبارسنجی نشده است');
    error.status = 400;
    throw error;
  }
  const dir = categoryDir(category);
  const safePrefix = String(prefix || 'file').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24) || 'file';
  const extension = /^\.[a-z0-9]{2,6}$/.test(file.extension || '') ? file.extension : '.bin';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const filename = `${safePrefix}-${crypto.randomBytes(18).toString('hex')}${extension}`;
    const target = path.join(dir, filename);
    try {
      fs.writeFileSync(target, file.buffer, { flag: 'wx', mode: 0o600 });
      return filename;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('ساخت نام تصادفی یکتا برای فایل ناموفق بود');
}

function persistPrivateUploadWithCommit(file, category, prefix, commit) {
  if (typeof commit !== 'function') throw new TypeError('commit callback is required');
  const filename = persistPrivateUpload(file, category, prefix);
  try {
    return { filename, result: commit(filename) };
  } catch (error) {
    removeStoredFile(category, filename);
    throw error;
  }
}

function locatePrivateFile(category, filename, { migrateLegacy = true } = {}) {
  const name = assertStoredName(filename);
  const target = privatePath(category, name);
  if (ensureRegularFile(target)) return target;
  if (!migrateLegacy) return null;

  const old = legacyPath(category, name);
  if (!ensureRegularFile(old)) return null;
  try {
    fs.renameSync(old, target);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.copyFileSync(old, target, fs.constants.COPYFILE_EXCL);
    fs.unlinkSync(old);
  }
  try { fs.chmodSync(target, 0o600); } catch { /* Windows ACLs are managed by the host. */ }
  return target;
}

function removeStoredFile(category, filename) {
  if (!filename) return;
  for (const target of [privatePath(category, filename), legacyPath(category, filename)]) {
    try {
      const stat = fs.lstatSync(target);
      if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(target);
    } catch { /* Missing files are already removed. */ }
  }
}

function contentType(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext === '.webp') return 'image/webp';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.pdf') return 'application/pdf';
  return 'application/octet-stream';
}

function sendPrivateFile(res, category, filename, options = {}) {
  let target;
  try { target = locatePrivateFile(category, filename, { migrateLegacy: options.migrateLegacy !== false }); }
  catch (error) {
    return res.status(error.status || 400).json({ error: error.message || 'فایل نامعتبر است' });
  }
  if (!target) return res.status(404).json({ error: 'فایل یافت نشد' });
  const stat = ensureRegularFile(target);
  if (!stat) return res.status(404).json({ error: 'فایل یافت نشد' });
  const type = contentType(target);
  const inline = options.inline === true && type.startsWith('image/');
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${path.basename(target).replace(/["\\]/g, '_')}"`);
  const stream = fs.createReadStream(target);
  stream.on('error', () => {
    if (!res.headersSent) res.status(500).json({ error: 'خطا در خواندن فایل' });
    else res.destroy();
  });
  stream.pipe(res);
}

/**
 * Mount before every public static middleware in server.js. Public uploads are
 * fail-closed: only a safe product-image basename may be read with GET/HEAD.
 */
function blockSensitivePublicUploads(req, res, next) {
  const methodAllowed = req.method === 'GET' || req.method === 'HEAD';
  const requestPath = String(req.path || '');
  const imageAllowed = /^\/products\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(?:webp|png|jpe?g)$/i.test(requestPath)
    && !requestPath.includes('..');
  if (methodAllowed && imageAllowed) return next();
  res.setHeader('Cache-Control', 'no-store');
  return res.status(404).json({ error: 'این مسیر آپلود عمومی نیست' });
}

module.exports = {
  PRIVATE_UPLOADS_ROOT,
  persistPrivateUpload,
  persistPrivateUploadWithCommit,
  locatePrivateFile,
  removeStoredFile,
  sendPrivateFile,
  blockSensitivePublicUploads,
  assertStoredName,
};
