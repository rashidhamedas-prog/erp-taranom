#!/usr/bin/env node
// Android toolchain update radar for ERP Taranom.
// Read-only: compares versions pinned in the repo with the latest upstream releases.
// Usage:  node .cursor/skills/APK/scripts/check-updates.mjs [--json] [--strict] [--offline]
// Proxy:  set NODE_USE_ENV_PROXY=1 and HTTPS_PROXY=http://127.0.0.1:PORT in the same shell (Node >= 24).
// Requires Node >= 18 (global fetch). No dependencies.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const args = new Set(process.argv.slice(2));
const JSON_OUT = args.has('--json');
const STRICT = args.has('--strict');
const OFFLINE = args.has('--offline');
const TIMEOUT_MS = 15000;
const UA = 'erp-taranom-apk-skill-update-check';

function read(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; }
}
function m(text, re, group = 1) {
  const r = re.exec(text);
  return r ? r[group] : null;
}
function isStable(v) {
  return !/alpha|beta|rc|preview|dev|nightly|canary|-\d+$/i.test(v);
}
function cmpVer(a, b) {
  const pa = String(a).replace(/^[^\d]*/, '').split(/[.-]/).map(x => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^[^\d]*/, '').split(/[.-]/).map(x => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
function major(v) { return parseInt(String(v || '').replace(/^[^\d]*/, '').split('.')[0], 10) || 0; }

async function get(url, { json = true } = {}) {
  if (OFFLINE) return { error: 'offline' };
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: json ? 'application/json' : '*/*' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { data: json ? await res.json() : await res.text() };
  } catch (e) {
    return { error: e.name === 'TimeoutError' ? 'timeout' : (e.cause?.code || e.message) };
  }
}

// ---------- pinned versions from the repo ----------
const appGradle = read('android/app/build.gradle');
const rootGradle = read('android/build.gradle');
const wrapper = read('android/gradle/wrapper/gradle-wrapper.properties');
const buildPs1 = read('scripts/build-android.ps1');
const npPkgRaw = read('android/app/src/main/assets/nodejs-project/package.json');
let npPkg = {};
try { npPkg = JSON.parse(npPkgRaw); } catch { /* ignore */ }
const workflows = fs.existsSync(path.join(ROOT, '.github/workflows'))
  ? fs.readdirSync(path.join(ROOT, '.github/workflows')).map(f => read(`.github/workflows/${f}`)).join('\n')
  : '';

const pinned = {
  agp: m(rootGradle, /com\.android\.tools\.build:gradle:([\d.]+)/) || m(rootGradle, /com\.android\.application['"]?\s+version\s+['"]([\d.]+)/),
  gradle: m(wrapper, /gradle-(\d+(?:\.\d+)+)-/),
  compileSdk: m(appGradle, /compileSdk\s+(\d+)/),
  targetSdk: m(appGradle, /targetSdk\s+(\d+)/),
  minSdk: m(appGradle, /minSdk\s+(\d+)/),
  ndk: m(appGradle, /ndkVersion\s+["']([\d.]+)["']/),
  versionName: m(appGradle, /versionName\s+["']([^"']+)["']/),
  versionCode: m(appGradle, /versionCode\s+(\d+)/),
  nodejsMobile: m(buildPs1, /nodejs-mobile\/releases\/download\/v([\d.]+)\//),
  betterSqlite3: (npPkg.dependencies || {})['better-sqlite3'] || null,
  ciNode: [...new Set([...workflows.matchAll(/node-version:\s*['"]?(\d+)/g)].map(x => x[1]))].join(',') || null,
};

// ---------- upstream ----------
const [agpMeta, gradleCur, ndkRel, nmOfficial, nmFork, bs3Tags, bs3Latest, nodeEol, androidEol, jdk] = await Promise.all([
  get('https://dl.google.com/dl/android/maven2/com/android/tools/build/gradle/maven-metadata.xml', { json: false }),
  get('https://services.gradle.org/versions/current'),
  get('https://api.github.com/repos/android/ndk/releases/latest'),
  get('https://api.github.com/repos/nodejs-mobile/nodejs-mobile/releases/latest'),
  get('https://api.github.com/repos/gmaclennan/nodejs-mobile/releases?per_page=5'),
  get('https://registry.npmjs.org/-/package/better-sqlite3/dist-tags'),
  get('https://registry.npmjs.org/better-sqlite3/latest'),
  get('https://endoflife.date/api/nodejs.json'),
  get('https://endoflife.date/api/android.json'),
  get('https://api.adoptium.net/v3/info/available_releases'),
]);

const today = new Date().toISOString().slice(0, 10);
const rows = [];
function row(component, current, latest, note = '', flag = '') {
  rows.push({ component, pinned: current ?? '?', latest: latest ?? '?', note, flag });
}

// AGP
{
  let latest = null;
  if (agpMeta.data) {
    const versions = [...agpMeta.data.matchAll(/<version>([^<]+)<\/version>/g)].map(x => x[1]).filter(isStable);
    latest = versions.sort(cmpVer).pop() || null;
  }
  const behind = latest && pinned.agp ? major(latest) - major(pinned.agp) : 0;
  row('AGP (com.android.tools.build:gradle)', pinned.agp, latest || agpMeta.error, behind > 0 ? `${behind} major behind` : '', behind >= 2 ? 'MAJOR' : '');
}
// Gradle
row('Gradle wrapper', pinned.gradle, gradleCur.data?.version || gradleCur.error,
  gradleCur.data && pinned.gradle && major(gradleCur.data.version) > major(pinned.gradle) ? 'major behind' : '');
// SDK levels
{
  let latestCycle = null;
  if (Array.isArray(androidEol.data)) latestCycle = androidEol.data[0];
  row('Android platform (latest cycle)', `compileSdk ${pinned.compileSdk} / targetSdk ${pinned.targetSdk} / minSdk ${pinned.minSdk}`,
    latestCycle ? `Android ${latestCycle.cycle} (${latestCycle.releaseDate})` : androidEol.error,
    'Play requires targetSdk >= 36 from 2026-08-31; sideload not enforced but Android 16 behaviors apply at targetSdk 36',
    pinned.targetSdk && parseInt(pinned.targetSdk, 10) < 36 ? 'WARN' : '');
}
// NDK
row('NDK', pinned.ndk, ndkRel.data?.tag_name || ndkRel.error, 'r28+ aligns 16 KB by default; AGP 9.4 default 28.2.13676358');
// nodejs-mobile
{
  const off = nmOfficial.data?.tag_name || nmOfficial.error;
  const forkRel = Array.isArray(nmFork.data) ? nmFork.data[0] : null;
  const fork = forkRel ? `${forkRel.tag_name}${forkRel.prerelease ? ' (prerelease)' : ''} @ ${String(forkRel.published_at || '').slice(0, 10)}` : nmFork.error;
  const nodeMajor = major(pinned.nodejsMobile);
  let eolNote = '';
  let eolFlag = '';
  if (Array.isArray(nodeEol.data)) {
    const cyc = nodeEol.data.find(c => String(c.cycle) === String(nodeMajor));
    if (cyc) {
      const eol = String(cyc.eol);
      const isEol = eol !== 'false' && eol <= today;
      eolNote = `embedded Node ${nodeMajor} EOL ${eol}${isEol ? ' (PAST)' : ''}`;
      eolFlag = isEol ? 'EOL' : '';
    }
  }
  row('nodejs-mobile (official)', `v${pinned.nodejsMobile}`, off, eolNote, eolFlag);
  row('nodejs-mobile (fork gmaclennan)', '-', fork, 'candidate runtime for Node 24 line; verify NDK/minSdk/16 KB in release notes');
}
// better-sqlite3
{
  const latest = bs3Tags.data?.latest || bs3Tags.error;
  const engines = bs3Latest.data?.engines?.node ? `engines.node ${bs3Latest.data.engines.node}` : '';
  const behind = latest && pinned.betterSqlite3 ? major(latest) - major(pinned.betterSqlite3) : 0;
  row('better-sqlite3 (android assets)', pinned.betterSqlite3, latest, `${engines}${behind ? `; ${behind} major behind` : ''}`.trim(), behind >= 2 ? 'MAJOR' : '');
}
// Node LTS lines + CI
{
  let lts = '';
  if (Array.isArray(nodeEol.data)) {
    lts = nodeEol.data.filter(c => c.lts && String(c.eol) > today).map(c => `${c.cycle} (eol ${c.eol})`).join(', ');
  }
  let ciFlag = '';
  if (Array.isArray(nodeEol.data) && pinned.ciNode) {
    for (const v of pinned.ciNode.split(',')) {
      const cyc = nodeEol.data.find(c => String(c.cycle) === v);
      if (cyc && String(cyc.eol) !== 'false' && String(cyc.eol) <= today) ciFlag = 'EOL';
    }
  }
  row('Node.js (CI workflows)', pinned.ciNode, lts || nodeEol.error, 'supported LTS lines', ciFlag);
}
// JDK
row('JDK (LTS)', '17 (build-android.ps1)', jdk.data ? `most recent LTS ${jdk.data.most_recent_lts}` : jdk.error, 'AGP 9.x needs >= 17');
// App version
row('App version', `${pinned.versionName} (code ${pinned.versionCode})`, '-', 'bump versionCode/versionName + main.js APP_VERSION + test marker + manifest.json together');

// ---------- output ----------
if (JSON_OUT) {
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), root: ROOT, rows }, null, 2));
} else {
  console.log(`ERP Taranom - Android toolchain radar (${today}) root=${ROOT}`);
  console.table(rows.map(r => ({ component: r.component, pinned: r.pinned, latest: r.latest, flag: r.flag, note: r.note })));
  const unreachable = rows.filter(r => /timeout|ENOTFOUND|ECONNRESET|HTTP \d+|offline|fetch failed/i.test(String(r.latest)));
  if (unreachable.length) {
    console.log(`\n${unreachable.length} source(s) unreachable. Behind a local VPN proxy run:\n  $env:NODE_USE_ENV_PROXY="1"; $env:HTTPS_PROXY="http://127.0.0.1:PORT"; node .cursor/skills/APK/scripts/check-updates.mjs`);
  }
  console.log('\nSources and signal->action table: .cursor/skills/APK/resources.md');
}
const flagged = rows.filter(r => r.flag);
if (STRICT && flagged.length) {
  console.error(`\n--strict: ${flagged.length} flagged component(s): ${flagged.map(r => `${r.component} [${r.flag}]`).join('; ')}`);
  process.exit(1);
}
