'use strict';

const path = require('path');
const multer = require('multer');
const AdmZip = require('adm-zip');
const sharp = require('sharp');

const MB = 1024 * 1024;
const GENERIC_MIME = new Set(['', 'application/octet-stream']);

const PROFILES = Object.freeze({
  image: {
    kinds: ['image'], maxBytes: 12 * MB, maxTotalBytes: 32 * MB,
    maxFiles: 13, maxWidth: 12_000, maxHeight: 12_000, maxPixels: 40_000_000, outputEdge: 1600,
  },
  messageImage: {
    kinds: ['image'], maxBytes: 8 * MB, maxTotalBytes: 9 * MB,
    maxFiles: 1, maxWidth: 10_000, maxHeight: 10_000, maxPixels: 30_000_000, outputEdge: 1200,
  },
  document: {
    kinds: ['image', 'pdf'], maxBytes: 8 * MB, maxTotalBytes: 9 * MB,
    maxFiles: 1, maxWidth: 12_000, maxHeight: 12_000, maxPixels: 40_000_000, outputEdge: 1800,
  },
  xlsx: {
    kinds: ['xlsx'], maxBytes: 15 * MB, maxTotalBytes: 16 * MB, maxFiles: 1,
  },
  lwte: {
    kinds: ['lwte'], maxBytes: 4 * MB, maxTotalBytes: 5 * MB, maxFiles: 1,
  },
});

class UploadPolicyError extends Error {
  constructor(message, code = 'UPLOAD_REJECTED', status = 400) {
    super(message);
    this.name = 'UploadPolicyError';
    this.code = code;
    this.status = status;
  }
}

function profileFor(nameOrProfile) {
  const profile = typeof nameOrProfile === 'string' ? PROFILES[nameOrProfile] : nameOrProfile;
  if (!profile || !Array.isArray(profile.kinds)) throw new Error('Unknown upload profile');
  return profile;
}

function safeOriginalName(value) {
  const raw = String(value || '').normalize('NFKC');
  if (!raw || Buffer.byteLength(raw, 'utf8') > 220 || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new UploadPolicyError('نام فایل معتبر نیست', 'UPLOAD_BAD_NAME');
  }
  if (raw !== path.basename(raw) || /[\\/:]/.test(raw) || raw.includes('..')) {
    throw new UploadPolicyError('مسیر یا نام فایل غیرمجاز است', 'UPLOAD_PATH_TRAVERSAL');
  }
  return raw;
}

function assertNoClientFileReferences(body, keys) {
  const source = body && typeof body === 'object' ? body : {};
  for (const key of keys || []) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (value != null && String(value).trim() !== '') {
      throw new UploadPolicyError('مرجع فایل ارسالی از کلاینت پذیرفته نمی‌شود؛ خود فایل را آپلود کنید', 'UPLOAD_FORGED_REFERENCE');
    }
  }
}

function strictPngEnd(buffer) {
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (length > buffer.length - offset - 12) return false;
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    offset += 12 + length;
    if (type === 'IEND') return offset === buffer.length;
  }
  return false;
}

function strictJpegEnd(buffer) {
  return buffer.length >= 4 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
}

function strictWebpEnd(buffer) {
  if (buffer.length < 12) return false;
  return buffer.readUInt32LE(4) + 8 === buffer.length;
}

function strictZipEnd(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    return offset + 22 + commentLength === buffer.length;
  }
  return false;
}

function detectKind(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (!strictPngEnd(buffer)) throw new UploadPolicyError('ساختار PNG یا داده انتهایی فایل نامعتبر است', 'UPLOAD_POLYGLOT');
    return { kind: 'image', mime: 'image/png', sourceExt: '.png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    if (!strictJpegEnd(buffer)) throw new UploadPolicyError('ساختار JPEG یا داده انتهایی فایل نامعتبر است', 'UPLOAD_POLYGLOT');
    return { kind: 'image', mime: 'image/jpeg', sourceExt: '.jpg' };
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    if (!strictWebpEnd(buffer)) throw new UploadPolicyError('ساختار WebP یا داده انتهایی فایل نامعتبر است', 'UPLOAD_POLYGLOT');
    return { kind: 'image', mime: 'image/webp', sourceExt: '.webp' };
  }
  if (buffer.length >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-') {
    const tail = buffer.subarray(Math.max(0, buffer.length - 4096)).toString('latin1');
    if (!/%%EOF\s*$/.test(tail)) throw new UploadPolicyError('ساختار PDF کامل نیست', 'UPLOAD_BAD_PDF');
    return { kind: 'pdf', mime: 'application/pdf', sourceExt: '.pdf' };
  }
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && [0x03, 0x05, 0x07].includes(buffer[2])) {
    if (!strictZipEnd(buffer)) throw new UploadPolicyError('ساختار ZIP/Excel یا داده انتهایی فایل نامعتبر است', 'UPLOAD_POLYGLOT');
    return { kind: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sourceExt: '.xlsx' };
  }
  return { kind: 'text', mime: 'text/plain', sourceExt: '.txt' };
}

function assertMimeMatches(declaredValue, detected) {
  const declared = String(declaredValue || '').toLowerCase().split(';')[0].trim();
  if (GENERIC_MIME.has(declared)) return;
  const aliases = {
    'image/jpeg': new Set(['image/jpeg', 'image/jpg', 'image/pjpeg']),
    'image/png': new Set(['image/png', 'image/x-png']),
    'image/webp': new Set(['image/webp']),
    'application/pdf': new Set(['application/pdf']),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': new Set([
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/zip', 'application/x-zip-compressed',
    ]),
    'text/plain': new Set(['text/plain', 'application/x-lwte']),
  };
  if (!aliases[detected.mime] || !aliases[detected.mime].has(declared)) {
    throw new UploadPolicyError('نوع MIME اعلام‌شده با محتوای واقعی فایل یکسان نیست', 'UPLOAD_MIME_MISMATCH');
  }
}

function assertExtensionMatches(originalName, detected, expectedKind) {
  const ext = path.extname(originalName).toLowerCase();
  const allowed = {
    image: new Set(['.jpg', '.jpeg', '.png', '.webp']),
    pdf: new Set(['.pdf']),
    xlsx: new Set(['.xlsx']),
    lwte: new Set(['.lwte']),
  };
  const kind = expectedKind === 'lwte' ? 'lwte' : detected.kind;
  if (!allowed[kind] || !allowed[kind].has(ext)) {
    throw new UploadPolicyError('پسوند فایل با نوع محتوای مجاز یکسان نیست', 'UPLOAD_EXTENSION_MISMATCH');
  }
  if (detected.kind === 'image') {
    if (detected.mime === 'image/png' && ext !== '.png') throw new UploadPolicyError('پسوند تصویر با محتوای واقعی یکسان نیست', 'UPLOAD_EXTENSION_MISMATCH');
    if (detected.mime === 'image/webp' && ext !== '.webp') throw new UploadPolicyError('پسوند تصویر با محتوای واقعی یکسان نیست', 'UPLOAD_EXTENSION_MISMATCH');
    if (detected.mime === 'image/jpeg' && !['.jpg', '.jpeg'].includes(ext)) throw new UploadPolicyError('پسوند تصویر با محتوای واقعی یکسان نیست', 'UPLOAD_EXTENSION_MISMATCH');
  }
}

function inspectXlsx(buffer) {
  let zip;
  try { zip = new AdmZip(buffer); }
  catch { throw new UploadPolicyError('فایل Excel قابل بازخوانی نیست', 'UPLOAD_BAD_XLSX'); }
  const entries = zip.getEntries();
  if (!entries.length || entries.length > 5000) throw new UploadPolicyError('ساختار Excel بیش از حد بزرگ یا خالی است', 'UPLOAD_BAD_XLSX');
  let uncompressed = 0;
  const names = new Set();
  for (const entry of entries) {
    const name = String(entry.entryName || '').replace(/\\/g, '/');
    if (!name || name.startsWith('/') || name.includes('\0') || name.split('/').includes('..')) {
      throw new UploadPolicyError('مسیر داخلی فایل Excel غیرمجاز است', 'UPLOAD_ZIP_TRAVERSAL');
    }
    const size = Number(entry.header && entry.header.size) || 0;
    const compressed = Number(entry.header && entry.header.compressedSize) || 0;
    uncompressed += size;
    if (uncompressed > 60 * MB || (size > 1024 * 1024 && compressed > 0 && size / compressed > 100)) {
      throw new UploadPolicyError('فایل Excel مشکوک به zip bomb است', 'UPLOAD_ZIP_BOMB');
    }
    if (/vbaProject\.bin$/i.test(name) || /^xl\/externalLinks\//i.test(name)) {
      throw new UploadPolicyError('ماکرو یا پیوند خارجی در فایل Excel مجاز نیست', 'UPLOAD_ACTIVE_XLSX');
    }
    names.add(name);
  }
  if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) {
    throw new UploadPolicyError('فایل ZIP یک workbook معتبر Excel نیست', 'UPLOAD_BAD_XLSX');
  }
}

function inspectPdf(buffer) {
  // Reject features that can execute actions, embed arbitrary payloads, or hide
  // those names inside encrypted/compressed object streams. PDFs are delivered
  // as attachment, never inline, after this conservative scan.
  const source = buffer.toString('latin1').replace(/#([0-9a-f]{2})/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
  if (/\/(?:JavaScript|JS|OpenAction|AA|Launch|EmbeddedFile|RichMedia|XFA)\b/i.test(source)) {
    throw new UploadPolicyError('PDF دارای محتوای فعال یا فایل جاسازی‌شده است', 'UPLOAD_ACTIVE_PDF');
  }
  if (/\/(?:Encrypt|ObjStm)\b/i.test(source)) {
    throw new UploadPolicyError('PDF رمزگذاری‌شده یا دارای object stream قابل بازرسی نیست', 'UPLOAD_UNINSPECTABLE_PDF');
  }
}

function inspectLwte(buffer) {
  if (buffer.includes(0)) throw new UploadPolicyError('فایل کارکرد شامل داده باینری غیرمجاز است', 'UPLOAD_BAD_LWTE');
  let text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  if (text.includes('\uFFFD')) text = buffer.toString('latin1');
  if (/[^\x09\x0a\x0d\x20-\x7e\u0080-\uffff]/u.test(text)) {
    throw new UploadPolicyError('فایل کارکرد شامل نویسه کنترلی غیرمجاز است', 'UPLOAD_BAD_LWTE');
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length || lines.length > 100_000 || lines.some((line) => line.length > 32_768)) {
    throw new UploadPolicyError('ساختار فایل کارکرد معتبر نیست', 'UPLOAD_BAD_LWTE');
  }
  const firstRows = lines.slice(0, Math.min(lines.length, 10));
  if (!firstRows.some((line) => line.split('\t').length >= 20)) {
    throw new UploadPolicyError('ستون‌های فایل کارکرد فراننکو معتبر نیست', 'UPLOAD_BAD_LWTE');
  }
}

async function normalizeImage(buffer, profile) {
  let metadata;
  try {
    metadata = await sharp(buffer, { failOn: 'warning', limitInputPixels: profile.maxPixels }).metadata();
  } catch {
    throw new UploadPolicyError('تصویر قابل decode نیست یا ساختار آن آسیب‌دیده است', 'UPLOAD_BAD_IMAGE');
  }
  const width = Number(metadata.width) || 0;
  const height = Number(metadata.height) || 0;
  if (!width || !height || width > profile.maxWidth || height > profile.maxHeight || width * height > profile.maxPixels) {
    throw new UploadPolicyError('ابعاد یا تعداد پیکسل تصویر بیش از حد مجاز است', 'UPLOAD_IMAGE_DIMENSIONS');
  }
  try {
    const output = await sharp(buffer, { failOn: 'warning', limitInputPixels: profile.maxPixels })
      .rotate()
      .resize({ width: profile.outputEdge, height: profile.outputEdge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78, effort: 3 })
      .toBuffer();
    return { buffer: output, width, height, mime: 'image/webp', extension: '.webp' };
  } catch {
    throw new UploadPolicyError('بازنویسی امن تصویر ناموفق بود', 'UPLOAD_IMAGE_REENCODE_FAILED');
  }
}

async function validateUploadedFile(file, profileName) {
  const profile = profileFor(profileName);
  if (!file || !Buffer.isBuffer(file.buffer)) throw new UploadPolicyError('فایل دریافت نشد', 'UPLOAD_MISSING');
  if (!file.buffer.length) throw new UploadPolicyError('فایل خالی مجاز نیست', 'UPLOAD_EMPTY');
  if (file.buffer.length > profile.maxBytes) {
    throw new UploadPolicyError('حجم فایل بیش از حد مجاز است', 'UPLOAD_TOO_LARGE', 413);
  }
  const originalname = safeOriginalName(file.originalname);
  let detected = detectKind(file.buffer);
  const expectedLwte = profile.kinds.includes('lwte');
  if (expectedLwte && detected.kind === 'text') detected = { kind: 'lwte', mime: 'text/plain', sourceExt: '.lwte' };
  if (!profile.kinds.includes(detected.kind)) {
    throw new UploadPolicyError('نوع واقعی فایل در این بخش مجاز نیست', 'UPLOAD_KIND_REJECTED');
  }
  assertMimeMatches(file.mimetype, detected);
  assertExtensionMatches(originalname, detected, detected.kind);
  if (detected.kind === 'xlsx') inspectXlsx(file.buffer);
  if (detected.kind === 'pdf') inspectPdf(file.buffer);
  if (detected.kind === 'lwte') inspectLwte(file.buffer);

  let normalized = { buffer: file.buffer, mime: detected.mime, extension: detected.sourceExt };
  if (detected.kind === 'image') normalized = await normalizeImage(file.buffer, profile);
  return {
    ...file,
    originalname,
    safeOriginalName: originalname,
    sourceMime: detected.mime,
    sourceExtension: detected.sourceExt,
    detectedKind: detected.kind,
    mimetype: normalized.mime,
    extension: normalized.extension,
    buffer: normalized.buffer,
    size: normalized.buffer.length,
    imageWidth: normalized.width || null,
    imageHeight: normalized.height || null,
    uploadValidated: true,
  };
}

function allRequestFiles(req) {
  if (req.file) return [req.file];
  if (!req.files) return [];
  if (Array.isArray(req.files)) return req.files;
  return Object.values(req.files).flat().filter(Boolean);
}

function replaceRequestFiles(req, validated) {
  if (req.file) {
    req.file = validated[0];
    return;
  }
  if (!req.files || Array.isArray(req.files)) {
    req.files = validated;
    return;
  }
  let index = 0;
  for (const key of Object.keys(req.files)) {
    req.files[key] = req.files[key].map(() => validated[index++]);
  }
}

function uploadErrorResponse(res, error) {
  const tooLarge = error && (error.code === 'LIMIT_FILE_SIZE' || error.code === 'LIMIT_FILE_COUNT' || error.code === 'UPLOAD_TOO_LARGE');
  const status = tooLarge ? 413 : Number(error && error.status) || 400;
  const message = tooLarge ? 'حجم یا تعداد فایل‌ها بیش از حد مجاز است' : (error && error.message) || 'فایل آپلودشده معتبر نیست';
  return res.status(status).json({ error: message, code: error && error.code ? error.code : 'UPLOAD_REJECTED' });
}

function createSecureUpload(profileName) {
  const profile = profileFor(profileName);
  const parser = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: profile.maxBytes,
      files: profile.maxFiles,
      fields: 80,
      parts: 100,
      fieldNameSize: 100,
      fieldSize: 512 * 1024,
    },
  });

  function wrap(middleware) {
    return function secureUploadMiddleware(req, res, next) {
      const declaredLength = Number(req.headers && req.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > profile.maxTotalBytes + MB) {
        return uploadErrorResponse(res, new UploadPolicyError('حجم کل درخواست بیش از حد مجاز است', 'UPLOAD_TOO_LARGE', 413));
      }
      middleware(req, res, (multerError) => {
        if (multerError) return uploadErrorResponse(res, multerError);
        const files = allRequestFiles(req);
        const total = files.reduce((sum, file) => sum + Number(file.size || file.buffer?.length || 0), 0);
        if (files.length > profile.maxFiles || total > profile.maxTotalBytes) {
          return uploadErrorResponse(res, new UploadPolicyError('حجم کل فایل‌ها بیش از حد مجاز است', 'UPLOAD_TOO_LARGE', 413));
        }
        Promise.all(files.map((file) => validateUploadedFile(file, profileName)))
          .then((validated) => { replaceRequestFiles(req, validated); next(); })
          .catch((error) => uploadErrorResponse(res, error));
      });
    };
  }

  return {
    single: (field) => wrap(parser.single(field)),
    fields: (fields) => wrap(parser.fields(fields)),
    array: (field, maxCount) => wrap(parser.array(field, maxCount)),
  };
}

// Used only by the authenticated sync relay. The destination allowlist chooses
// the strict profile after path/method/field validation.
function createRelayEnvelopeUpload(maxBytes = 15 * MB) {
  const parser = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 80, parts: 85, fieldNameSize: 100, fieldSize: 512 * 1024 },
  });
  return function relayEnvelope(req, res, next) {
    parser.single('file')(req, res, (error) => {
      if (error) return uploadErrorResponse(res, error);
      try {
        if (req.file) req.file.originalname = safeOriginalName(req.file.originalname);
        next();
      } catch (validationError) {
        return uploadErrorResponse(res, validationError);
      }
    });
  };
}

module.exports = {
  MB,
  PROFILES,
  UploadPolicyError,
  safeOriginalName,
  assertNoClientFileReferences,
  detectKind,
  validateUploadedFile,
  createSecureUpload,
  createRelayEnvelopeUpload,
  uploadErrorResponse,
  _test: { strictPngEnd, strictJpegEnd, strictWebpEnd, strictZipEnd, inspectXlsx, inspectPdf, inspectLwte },
};
