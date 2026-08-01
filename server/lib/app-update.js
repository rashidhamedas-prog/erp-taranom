const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.join(__dirname, '..', 'public', 'releases', 'manifest.json');

const DEFAULT_MANIFEST = {
  web: { version: '2.1.0', notes: '' },
  desktop: { version: '1.0.4', url: '/releases/CRM-Taranom-Setup-1.0.4.exe', notes: 'دکمه به‌روزرسانی در تنظیمات برنامه' },
  android: { version: '2.0.1', versionCode: 3, url: '', distribution: 'local', notes: '' }
};

function readManifest() {
  try {
    const parsed = { ...DEFAULT_MANIFEST, ...JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) };
    parsed.releaseId = parsed.releaseId || [
      parsed.web?.version || '0', parsed.desktop?.version || '0', parsed.android?.version || '0'
    ].join('-');
    return parsed;
  } catch {
    return {
      ...DEFAULT_MANIFEST,
      releaseId: [DEFAULT_MANIFEST.web.version, DEFAULT_MANIFEST.desktop.version, DEFAULT_MANIFEST.android.version].join('-')
    };
  }
}

function parseVersion(v) {
  return String(v || '0').split(/[.-]/).map(n => parseInt(n, 10) || 0);
}

function compareVersion(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function normalizedSha256(value) {
  const digest = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(digest) ? digest : null;
}

function normalizedSize(value) {
  const size = Number(value);
  return Number.isSafeInteger(size) && size > 0 ? size : null;
}

function resolveReleaseUrl(value, baseUrl) {
  const candidate = String(value || '').trim();
  if (!candidate) return null;
  try {
    if (/^https?:\/\//i.test(candidate)) return new URL(candidate).toString();
    if (!candidate.startsWith('/') || !baseUrl) return null;
    const base = new URL(baseUrl);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return null;
    return new URL(candidate, base).toString();
  } catch {
    return null;
  }
}

/**
 * پاسخ بررسی آپدیت.
 * update_available فقط بر اساس نسخه است (حتی اگر لینک دانلود نباشد — مثل اندروید sideload).
 * downloadable وقتی true است که url قابل استفاده وجود داشته باشد.
 */
function buildUpdateResponse(platform, current, manifest, baseUrl) {
  const latest = manifest[platform] || {};
  const latestVersion = latest.version || '0';
  const hasUrl = !!(latest.url && String(latest.url).trim());
  const newer = compareVersion(current, latestVersion) < 0;
  const updateAvailable = newer;
  const sha256 = normalizedSha256(latest.sha256);
  const size = normalizedSize(latest.size);
  const integrityRequired = (platform === 'android' || platform === 'desktop') && hasUrl;
  const integrityValid = !!(sha256 && size);
  const url = hasUrl ? resolveReleaseUrl(latest.url, baseUrl) : null;
  const distribution = latest.distribution
    || (platform === 'android' && !hasUrl ? 'local' : 'server');
  return {
    platform,
    current,
    latest_version: latestVersion,
    version_code: latest.versionCode || null,
    update_available: updateAvailable,
    downloadable: !!url && newer && (!integrityRequired || integrityValid),
    distribution,
    url,
    notes: latest.notes || '',
    sha256,
    sha512: typeof latest.sha512 === 'string' && latest.sha512.trim() ? latest.sha512.trim() : null,
    size,
    integrity_required: integrityRequired,
    integrity_valid: integrityValid,
    integrity: integrityValid ? { algorithm: 'sha256', digest: sha256, size } : null
  };
}

module.exports = {
  readManifest,
  compareVersion,
  buildUpdateResponse,
  normalizedSha256,
  normalizedSize,
  resolveReleaseUrl,
  MANIFEST_PATH
};
