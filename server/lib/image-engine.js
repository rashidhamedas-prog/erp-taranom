'use strict';

/**
 * ImageEngine — جداسازی اعتبارسنجی ساختار تصویر از موتور native (sharp).
 *
 * حالت‌ها:
 *   sharp       — decode + resize + WebP (ترجیح مرکزی)
 *   passthrough — magic/EOF از upload-policy + ابعاد از هدر؛ بدون re-encode
 *   unavailable — فقط وقتی IMAGE_ENGINE_MODE=require و sharp نباشد
 *
 * ریشهٔ باگ production: pin سورس sharp@0.35 روی CPU بدون x86-64-v2 لود نمی‌شود؛
 * waiver W0-OPS-002 اجازهٔ runtime 0.33.5 می‌دهد، ولی npm install آن را می‌شکند.
 */

let sharp = null;
let sharpLoadError = null;
let sharpVersion = null;

try {
  // eslint-disable-next-line global-require
  sharp = require('sharp');
  try {
    sharpVersion = require('sharp/package.json').version;
  } catch {
    sharpVersion = null;
  }
} catch (err) {
  sharpLoadError = err && err.message ? err.message : String(err);
  console.warn('⚠️ sharp unavailable — image engine will use secure passthrough:', sharpLoadError);
}

function envMode() {
  const raw = String(process.env.IMAGE_ENGINE_MODE || 'auto').toLowerCase().trim();
  if (raw === 'require' || raw === 'passthrough' || raw === 'auto') return raw;
  return 'auto';
}

function getStatus() {
  const modePref = envMode();
  if (sharp) {
    return {
      ok: true,
      available: true,
      mode: 'sharp',
      preferred: modePref,
      version: sharpVersion,
      reason: null,
    };
  }
  if (modePref === 'require') {
    return {
      ok: false,
      available: false,
      mode: 'unavailable',
      preferred: modePref,
      version: null,
      reason: sharpLoadError || 'sharp_missing',
    };
  }
  return {
    ok: true,
    available: false,
    mode: 'passthrough',
    preferred: modePref,
    version: null,
    reason: sharpLoadError || 'sharp_missing',
  };
}

function readPngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

function readJpegDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > buffer.length) return null;
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > buffer.length) return null;
    const isSof = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      if (!width || !height) return null;
      return { width, height };
    }
    offset += 2 + segmentLength;
  }
  return null;
}

function readWebpDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 30) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  const fourcc = buffer.toString('ascii', 12, 16);
  if (fourcc === 'VP8X' && buffer.length >= 30) {
    const width = 1 + buffer[24] + (buffer[25] << 8) + (buffer[26] << 16);
    const height = 1 + buffer[27] + (buffer[28] << 8) + (buffer[29] << 16);
    if (!width || !height) return null;
    return { width, height };
  }
  if (fourcc === 'VP8 ' && buffer.length >= 30) {
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    if (!width || !height) return null;
    return { width, height };
  }
  if (fourcc === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer[21] | (buffer[22] << 8) | (buffer[23] << 16) | ((buffer[24] & 0x0f) << 24);
    const width = 1 + (bits & 0x3fff);
    const height = 1 + ((bits >> 14) & 0x3fff);
    if (!width || !height) return null;
    return { width, height };
  }
  return null;
}

function readImageDimensions(buffer, mime) {
  const kind = String(mime || '').toLowerCase();
  if (kind === 'image/png') return readPngDimensions(buffer);
  if (kind === 'image/jpeg' || kind === 'image/jpg') return readJpegDimensions(buffer);
  if (kind === 'image/webp') return readWebpDimensions(buffer);
  return readPngDimensions(buffer) || readJpegDimensions(buffer) || readWebpDimensions(buffer);
}

function assertDimensions(dims, profile, UploadPolicyError) {
  const width = Number(dims && dims.width) || 0;
  const height = Number(dims && dims.height) || 0;
  if (!width || !height || width > profile.maxWidth || height > profile.maxHeight || width * height > profile.maxPixels) {
    throw new UploadPolicyError('ابعاد یا تعداد پیکسل تصویر بیش از حد مجاز است', 'UPLOAD_IMAGE_DIMENSIONS');
  }
  return { width, height };
}

async function normalizeWithSharp(buffer, profile, UploadPolicyError) {
  let metadata;
  try {
    metadata = await sharp(buffer, { failOn: 'warning', limitInputPixels: profile.maxPixels }).metadata();
  } catch {
    throw new UploadPolicyError('تصویر قابل decode نیست یا ساختار آن آسیب‌دیده است', 'UPLOAD_BAD_IMAGE');
  }
  const { width, height } = assertDimensions(metadata, profile, UploadPolicyError);
  try {
    const output = await sharp(buffer, { failOn: 'warning', limitInputPixels: profile.maxPixels })
      .rotate()
      .resize({ width: profile.outputEdge, height: profile.outputEdge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78, effort: 3 })
      .toBuffer();
    return {
      buffer: output,
      width,
      height,
      mime: 'image/webp',
      extension: '.webp',
      via: 'sharp',
    };
  } catch {
    throw new UploadPolicyError('بازنویسی امن تصویر ناموفق بود', 'UPLOAD_IMAGE_REENCODE_FAILED');
  }
}

function normalizePassthrough(buffer, profile, sourceMime, sourceExt, UploadPolicyError) {
  // Passthrough keeps magic/EOF checks already applied by upload-policy.
  // Stricter byte ceiling reduces decompression-bomb surface without a decoder.
  const passthroughMax = Math.min(profile.maxBytes, Math.floor(profile.maxBytes * 0.75) || profile.maxBytes);
  if (buffer.length > passthroughMax) {
    throw new UploadPolicyError(
      'بدون موتور پردازش تصویر، حجم این فایل بیش از سقف حالت کاهش‌یافته است',
      'UPLOAD_TOO_LARGE',
      413
    );
  }
  const dims = readImageDimensions(buffer, sourceMime);
  if (!dims) {
    throw new UploadPolicyError('ابعاد تصویر از هدر قابل خواندن نیست', 'UPLOAD_BAD_IMAGE');
  }
  const { width, height } = assertDimensions(dims, profile, UploadPolicyError);
  return {
    buffer,
    width,
    height,
    mime: sourceMime,
    extension: sourceExt,
    via: 'passthrough',
  };
}

/**
 * @param {Buffer} buffer
 * @param {object} profile upload profile
 * @param {{ mime: string, extension: string }} source
 * @param {typeof Error} UploadPolicyError
 */
async function normalizeImage(buffer, profile, source, UploadPolicyError) {
  const status = getStatus();
  if (status.mode === 'unavailable') {
    throw new UploadPolicyError(
      'پردازش تصویر روی سرور در دسترس نیست؛ بعداً دوباره تلاش کنید',
      'UPLOAD_IMAGE_ENGINE_UNAVAILABLE',
      503
    );
  }
  if (status.mode === 'sharp' && sharp) {
    return normalizeWithSharp(buffer, profile, UploadPolicyError);
  }
  return normalizePassthrough(
    buffer,
    profile,
    source.mime,
    source.extension,
    UploadPolicyError
  );
}

/** Test helper — inject/clear sharp binding. */
function _setSharpForTests(nextSharp, version = 'test') {
  sharp = nextSharp || null;
  sharpVersion = nextSharp ? version : null;
  sharpLoadError = nextSharp ? null : 'test_forced_unavailable';
}

module.exports = {
  getStatus,
  normalizeImage,
  readImageDimensions,
  readPngDimensions,
  readJpegDimensions,
  readWebpDimensions,
  _setSharpForTests,
  _test: { envMode },
};
