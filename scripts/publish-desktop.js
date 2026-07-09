#!/usr/bin/env node
// Copy desktop installer into server/public/releases and refresh latest.yml + manifest.
// Usage (from repo root):  node scripts/publish-desktop.js [version]
// Or from desktop/:       npm run publish:win
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const version = process.argv[2] || require(path.join(ROOT, 'desktop', 'package.json')).version;
const distDir = path.join(ROOT, 'desktop', 'dist');
const releasesDir = path.join(ROOT, 'server', 'public', 'releases');

const candidates = [
  `CRM Taranom Setup ${version}.exe`,
  `CRM-Taranom-Setup-${version}.exe`
];

let src = null;
for (const name of candidates) {
  const p = path.join(distDir, name);
  if (fs.existsSync(p)) { src = p; break; }
}

if (!src) {
  console.error('❌ installer not found — run first: cd desktop && npm run dist:win');
  console.error('   looked in:', distDir);
  process.exit(1);
}

fs.mkdirSync(releasesDir, { recursive: true });
const destName = `CRM-Taranom-Setup-${version}.exe`;
const dest = path.join(releasesDir, destName);
fs.copyFileSync(src, dest);
console.log('✅ copied', path.basename(src), '→', destName);

execFileSync(process.execPath, [
  path.join(__dirname, 'generate-release.js'),
  releasesDir,
  version
], { stdio: 'inherit', cwd: ROOT });

console.log('\nNext: upload server/public/releases/ to production, then restart PM2.');
