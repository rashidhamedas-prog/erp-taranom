#!/usr/bin/env node
// Generate electron-updater latest.yml + refresh manifest.json after building desktop.
// The .exe itself stays in desktop/dist — upload to GitHub Releases separately.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const releasesDir = path.resolve(process.argv[2] || path.join(ROOT, 'server', 'public', 'releases'));
const version = process.argv[3] || '1.0.1';

function sha512File(filePath) {
  return crypto.createHash('sha512').update(fs.readFileSync(filePath)).digest('base64');
}

function writeLatestYml(exePath) {
  if (!fs.existsSync(exePath)) {
    console.warn('⚠️  skip latest.yml — not found:', exePath);
    return false;
  }
  const urlName = path.basename(exePath);
  const sha512 = sha512File(exePath);
  const size = fs.statSync(exePath).size;
  const yml = [
    `version: ${version}`,
    'files:',
    `  - url: ${urlName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${urlName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    ''
  ].join('\n');
  fs.writeFileSync(path.join(releasesDir, 'latest.yml'), yml);
  console.log('✅ latest.yml');
  return true;
}

const NOTES = process.argv[6] ||
  `نسخه ${version}: بیلد دسکتاپ با آخرین بک‌اند (pairing/sync، SW فعلی).`;

// Preserve existing web/android fields when only refreshing desktop metadata.
let prev = {};
try {
  prev = JSON.parse(fs.readFileSync(path.join(releasesDir, 'manifest.json'), 'utf8'));
} catch { /* */ }

const manifest = {
  web: prev.web || { version: '2.1.0', notes: 'به‌روزرسانی رابط وب — با باز کردن سایت در مرورگر خودکار اعمال می‌شود.' },
  desktop: {
    version,
    url: `/releases/ERP-Taranom-Setup-${version}.exe`,
    feed_url: '',
    notes: NOTES
  },
  android: prev.android || {
    version: process.argv[4] || '2.0.21',
    versionCode: parseInt(process.argv[5] || '23', 10),
    url: '',
    distribution: 'local',
    notes: 'نصب اندروید فقط از APK محلی (sideload/USB).'
  }
};
if (process.argv[4]) {
  manifest.android.version = process.argv[4];
  manifest.android.versionCode = parseInt(process.argv[5] || String(manifest.android.versionCode || 23), 10);
}

fs.mkdirSync(releasesDir, { recursive: true });
const candidates = [
  path.join(ROOT, 'desktop', 'dist', `ERP Taranom Setup ${version}.exe`),
  path.join(ROOT, 'desktop', 'dist', `ERP-Taranom-Setup-${version}.exe`),
  path.join(ROOT, 'desktop', 'dist', `CRM Taranom Setup ${version}.exe`),
  path.join(ROOT, 'desktop', 'dist', `CRM-Taranom-Setup-${version}.exe`),
  path.join(releasesDir, `ERP-Taranom-Setup-${version}.exe`),
  path.join(releasesDir, `CRM-Taranom-Setup-${version}.exe`)
];
const builtExe = candidates.find((p) => fs.existsSync(p)) || null;
if (builtExe) writeLatestYml(builtExe);
else console.warn('⚠️  skip latest.yml — installer not found for', version);

fs.writeFileSync(path.join(releasesDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('✅ manifest.json');
console.log('\nMetadata written to server/public/releases/');
console.log('Upload the .exe to the server /releases/ folder (or GitHub — see docs/DESKTOP-UPDATE.md)');
