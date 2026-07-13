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
  'نسخه 1.0.11: Command Palette، مرکز اقدامات، RBAC، مشاور AI، سال مالی، مهاجرت محک، هات‌فیکس ورود، بارکد wedge، SW v30';
const manifest = {
  web: { version: '2.1.0', notes: 'به‌روزرسانی رابط وب — با باز کردن سایت در مرورگر خودکار اعمال می‌شود.' },
  desktop: {
    version,
    url: `/releases/CRM-Taranom-Setup-${version}.exe`,
    feed_url: '',
    notes: NOTES
  },
  android: {
    version: process.argv[4] || '2.0.1',
    versionCode: parseInt(process.argv[5] || '3', 10),
    url: '/releases/crm-taranom.apk',
    notes: NOTES
  }
};

fs.mkdirSync(releasesDir, { recursive: true });
const distExe = path.join(ROOT, 'desktop', 'dist', `CRM Taranom Setup ${version}.exe`);
const distExeAlt = path.join(ROOT, 'desktop', 'dist', `CRM-Taranom-Setup-${version}.exe`);
const builtExe = fs.existsSync(distExe) ? distExe : (fs.existsSync(distExeAlt) ? distExeAlt : null);
if (!builtExe) {
  writeLatestYml(path.join(releasesDir, `CRM-Taranom-Setup-${version}.exe`));
} else {
  writeLatestYml(builtExe);
}
fs.writeFileSync(path.join(releasesDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('✅ manifest.json');
console.log('\nMetadata written to server/public/releases/');
console.log('Upload the .exe to GitHub Releases — see docs/DESKTOP-UPDATE.md');
