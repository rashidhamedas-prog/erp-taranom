#!/usr/bin/env node
// Windows/Electron toolchain update radar for ERP Taranom desktop.
// Read-only: compares versions pinned/installed in desktop/ with the latest upstream releases and EOL data.
// Usage:  node .cursor/skills/EXE/scripts/check-updates.mjs [--json] [--strict] [--offline]
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
const UA = 'erp-taranom-exe-skill-update-check';

function readJson(rel) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch { return null; }
}
function read(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; }
}
function major(v) { return parseInt(String(v || '').replace(/^[^\d]*/, '').split('.')[0], 10) || 0; }

async function get(url) {
  if (OFFLINE) return { error: 'offline' };
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { data: await res.json() };
  } catch (e) {
    return { error: e.name === 'TimeoutError' ? 'timeout' : (e.cause?.code || e.message) };
  }
}

// ---------- pinned / installed ----------
const pkg = readJson('desktop/package.json') || {};
const lock = readJson('desktop/package-lock.json') || {};
const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
function installed(name) {
  const p = lock.packages && lock.packages[`node_modules/${name}`];
  return p ? p.version : null;
}
const workflowsDir = path.join(ROOT, '.github/workflows');
const workflows = fs.existsSync(workflowsDir) ? fs.readdirSync(workflowsDir).map(f => read(`.github/workflows/${f}`)).join('\n') : '';
const ciNode = [...new Set([...workflows.matchAll(/node-version:\s*['"]?(\d+)/g)].map(x => x[1]))].join(',') || null;

const WATCH = ['electron', 'electron-builder', 'electron-updater', 'better-sqlite3', 'sharp'];

// ---------- upstream ----------
const tagResults = await Promise.all(WATCH.map(n => get(`https://registry.npmjs.org/-/package/${n}/dist-tags`)));
const [electronEol, nodeEol, bs3Latest] = await Promise.all([
  get('https://endoflife.date/api/electron.json'),
  get('https://endoflife.date/api/nodejs.json'),
  get('https://registry.npmjs.org/better-sqlite3/latest'),
]);

const today = new Date().toISOString().slice(0, 10);
const rows = [];
function row(component, pinned, inst, latest, note = '', flag = '') {
  rows.push({ component, pinned: pinned ?? '?', installed: inst ?? '?', latest: latest ?? '?', note, flag });
}

WATCH.forEach((name, i) => {
  const tags = tagResults[i];
  const latest = tags.data?.latest || tags.error;
  const next = tags.data?.next ? ` (next ${tags.data.next})` : '';
  const inst = installed(name);
  const cur = inst || deps[name];
  const behind = tags.data && cur ? major(latest) - major(cur) : 0;
  let note = behind > 0 ? `${behind} major behind` : '';
  let flag = '';
  if (name === 'electron' && Array.isArray(electronEol.data) && cur) {
    const cyc = electronEol.data.find(c => String(c.cycle) === String(major(cur)));
    if (cyc) {
      const eol = String(cyc.eol);
      const past = eol !== 'false' && eol <= today;
      note = `${note ? note + '; ' : ''}Electron ${cyc.cycle} EOL ${eol}${past ? ' (PAST - unsupported)' : ''}`;
      if (past) flag = 'EOL';
    }
    const supported = electronEol.data.filter(c => String(c.eol) === 'false' || String(c.eol) > today).map(c => c.cycle).slice(0, 4);
    if (supported.length) note += `; supported lines: ${supported.join(', ')}`;
  }
  if (name === 'better-sqlite3' && bs3Latest.data?.engines?.node) {
    note = `${note ? note + '; ' : ''}latest engines.node ${bs3Latest.data.engines.node}; N-API since 13.0.0`;
  }
  if (!flag && behind >= 2) flag = 'MAJOR';
  row(name, deps[name] || null, inst, `${latest}${next}`, note, flag);
});

// Node (CI / build docs)
{
  let lts = '';
  let flag = '';
  if (Array.isArray(nodeEol.data)) {
    lts = nodeEol.data.filter(c => c.lts && String(c.eol) > today).map(c => `${c.cycle} (eol ${c.eol})`).join(', ');
    for (const v of (ciNode || '').split(',').filter(Boolean)) {
      const cyc = nodeEol.data.find(c => String(c.cycle) === v);
      if (cyc && String(cyc.eol) !== 'false' && String(cyc.eol) <= today) flag = 'EOL';
    }
  }
  row('Node.js (CI workflows)', ciNode, '-', lts || nodeEol.error, 'supported LTS lines; Electron 44 bundles Node 24', flag);
}
// Packaging facts
{
  const b = pkg.build || {};
  const pub = Array.isArray(b.publish) ? b.publish.map(p => p.url || p.provider).join(', ') : '';
  row('electron-builder config', `asar=${b.asar} npmRebuild=${b.npmRebuild} publisherName=${b.win?.publisherName ?? 'MISSING'}`, '-', '-',
    `publish: ${pub || 'none'}${/example\.com/.test(pub) ? ' (PLACEHOLDER)' : ''}`,
    (!b.win?.publisherName || /example\.com/.test(pub)) ? 'WARN' : '');
  row('App version', pkg.version, '-', '-', 'bump desktop/package.json + manifest.json desktop.* + latest.yml together');
}

// ---------- output ----------
if (JSON_OUT) {
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), root: ROOT, rows }, null, 2));
} else {
  console.log(`ERP Taranom - Windows/Electron toolchain radar (${today}) root=${ROOT}`);
  console.table(rows.map(r => ({ component: r.component, pinned: r.pinned, installed: r.installed, latest: r.latest, flag: r.flag, note: r.note })));
  const unreachable = rows.filter(r => /timeout|ENOTFOUND|ECONNRESET|HTTP \d+|offline|fetch failed/i.test(String(r.latest)));
  if (unreachable.length) {
    console.log(`\n${unreachable.length} source(s) unreachable. Behind a local VPN proxy run:\n  $env:NODE_USE_ENV_PROXY="1"; $env:HTTPS_PROXY="http://127.0.0.1:PORT"; node .cursor/skills/EXE/scripts/check-updates.mjs`);
  }
  console.log('\nBreaking changes before any Electron major upgrade: https://www.electronjs.org/docs/latest/breaking-changes');
  console.log('Sources and signal->action table: .cursor/skills/EXE/resources.md');
}
const flagged = rows.filter(r => r.flag);
if (STRICT && flagged.length) {
  console.error(`\n--strict: ${flagged.length} flagged component(s): ${flagged.map(r => `${r.component} [${r.flag}]`).join('; ')}`);
  process.exit(1);
}
