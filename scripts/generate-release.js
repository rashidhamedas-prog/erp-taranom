#!/usr/bin/env node
// Generate electron-updater latest.yml + refresh manifest.json after building
// desktop/android installers. Usage:
//   node scripts/generate-release.js [releasesDir] [version]
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const releasesDir = path.resolve(process.argv[2] || path.join(ROOT, 'server', 'public', 'releases'));
const version = process.argv[3] || '1.0.1';

function sha512File(filePath) {
  return crypto.createHash('sha512').update(fs.readFileSync(filePath)).digest('base64');
}

function writeLatestYml(exeName) {
  const exePath = path.join(releasesDir, exeName);
  if (!fs.existsSync(exePath)) {
    console.warn('⚠️  skip latest.yml — not found:', exePath);
    return;
  }
  const sha512 = sha512File(exePath);
  const size = fs.statSync(exePath).size;
  const yml = [
    `version: ${version}`,
    'files:',
    `  - url: ${exeName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${exeName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    ''
  ].join('\n');
  fs.writeFileSync(path.join(releasesDir, 'latest.yml'), yml);
  console.log('✅ latest.yml');
}

const manifest = {
  web: { version: '2.1.0', notes: 'به‌روزرسانی رابط وب — با باز کردن سایت در مرورگر خودکار اعمال می‌شود.' },
  desktop: {
    version,
    url: `/releases/CRM-Taranom-Setup-${version}.exe`,
    notes: 'همگام‌سازی عکس محصولات، به‌روزرسانی خودکار برنامه.'
  },
  android: {
    version: process.argv[4] || '2.0.1',
    versionCode: parseInt(process.argv[5] || '3', 10),
    url: '/releases/crm-taranom.apk',
    notes: 'همگام‌سازی عکس محصولات، اعلان نسخه جدید.'
  }
};

fs.mkdirSync(releasesDir, { recursive: true });
writeLatestYml(`CRM-Taranom-Setup-${version}.exe`);
writeLatestYml('CRM Taranom Setup ' + version + '.exe');
fs.writeFileSync(path.join(releasesDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('✅ manifest.json');
console.log('\nUpload to server/public/releases/:');
console.log('  - CRM-Taranom-Setup-' + version + '.exe (or copy from desktop/dist/)');
console.log('  - crm-taranom.apk (from android build)');
console.log('  - latest.yml + manifest.json');
