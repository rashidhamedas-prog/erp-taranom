#!/usr/bin/env node
// Publish desktop release METADATA only (manifest + latest.yml).
// The .exe is NOT copied into server/public/releases — upload it to GitHub Releases instead.
//
// Usage (from repo root):
//   node scripts/publish-desktop.js [version]
//   node scripts/publish-desktop.js 1.0.6 --github rashidhamedas-prog/crm-taranom
//
// Or from desktop/:  npm run publish:win
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const version = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : require(path.join(ROOT, 'desktop', 'package.json')).version;
const githubArg = process.argv.find(a => a.startsWith('--github='));
const githubRepo = githubArg
  ? githubArg.split('=')[1]
  : (process.env.GITHUB_REPO || 'rashidhamedas-prog/crm-taranom');
const tag = `v${version}`;
const exeName = `ERP-Taranom-Setup-${version}.exe`;

const distDir = path.join(ROOT, 'desktop', 'dist');
const releasesDir = path.join(ROOT, 'server', 'public', 'releases');

const candidates = [
  `ERP Taranom Setup ${version}.exe`,
  exeName,
  // Legacy artifact names (pre-rebrand builds)
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
  process.exit(1);
}

const sizeMB = (fs.statSync(src).size / 1024 / 1024).toFixed(1);
console.log(`📦 installer: ${path.basename(src)} (${sizeMB} MB)`);

fs.mkdirSync(releasesDir, { recursive: true });

// latest.yml is generated from the built exe (for GitHub release asset upload).
execFileSync(process.execPath, [
  path.join(__dirname, 'generate-release.js'),
  releasesDir,
  version
], { stdio: 'inherit', cwd: ROOT });

// Point manifest at GitHub Releases — no exe on production server.
const manifestPath = path.join(releasesDir, 'manifest.json');
let manifest = {};
try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* */ }

const ghBase = `https://github.com/${githubRepo}/releases/download/${tag}`;
manifest.desktop = {
  version,
  url: `${ghBase}/${encodeURIComponent(path.basename(src)).replace(/%20/g, ' ')}`,
  feed_url: `${ghBase}/`,
  notes: manifest.desktop?.notes || `نسخه ${version} — دانلود از GitHub Releases`
};

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('✅ manifest.json → GitHub URL:', manifest.desktop.url);

console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  متادیتا آماده است. exe را روی سرور SCP نکنید.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  1) آپلود به GitHub Release:
     gh release create ${tag} \\
       "${src.replace(/\\/g, '/')}" \\
       "${path.join(releasesDir, 'latest.yml').replace(/\\/g, '/')}" \\
       --repo ${githubRepo} --title "ERP Taranom Desktop ${version}"

  2) فقط manifest + latest.yml را deploy کنید:
     git add server/public/releases/manifest.json server/public/releases/latest.yml
     git commit -m "chore: desktop ${version} metadata"
     git push && ssh ... "git pull && pm2 restart erp-taranom"

  جزئیات: docs/DESKTOP-UPDATE.md
`);
