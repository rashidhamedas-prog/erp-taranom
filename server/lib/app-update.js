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
    return { ...DEFAULT_MANIFEST, ...JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_MANIFEST };
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

function buildUpdateResponse(platform, current, manifest, baseUrl) {
  const latest = manifest[platform] || {};
  const latestVersion = latest.version || '0';
  const hasUrl = !!(latest.url && String(latest.url).trim());
  const updateAvailable = hasUrl && compareVersion(current, latestVersion) < 0;
  let url = hasUrl ? latest.url : null;
  if (url && !url.startsWith('http') && baseUrl) {
    url = baseUrl.replace(/\/$/, '') + url;
  }
  return {
    platform,
    current,
    latest_version: latestVersion,
    version_code: latest.versionCode || null,
    update_available: updateAvailable,
    distribution: latest.distribution || (platform === 'android' && !hasUrl ? 'local' : 'server'),
    url,
    notes: latest.notes || ''
  };
}

module.exports = { readManifest, compareVersion, buildUpdateResponse, MANIFEST_PATH };
