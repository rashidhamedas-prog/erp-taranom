'use strict';
/**
 * npm audit gate with an explicit, time-boxed waiver list.
 * Only waived packages may remain high/critical; anything else fails CI.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const WAIVED_PACKAGES = {
  xlsx: {
    reason: 'No upstream fix for GHSA-4r6h / GHSA-5pgg; mitigated by server/lib/excel-safe.js',
    until: '2026-10-01',
    replaceWith: 'exceljs (planned)',
  },
};

const today = new Date().toISOString().slice(0, 10);
for (const [pkg, w] of Object.entries(WAIVED_PACKAGES)) {
  if (w.until < today) {
    console.error(`Waiver expired for ${pkg} — until ${w.until}. Replace dependency.`);
    process.exit(1);
  }
}

const r = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
  cwd: path.join(__dirname, '..'),
  encoding: 'utf8',
  shell: process.platform === 'win32',
  maxBuffer: 20 * 1024 * 1024,
});
let report;
try {
  report = JSON.parse(r.stdout || '{}');
} catch {
  console.error('Failed to parse npm audit JSON');
  console.error((r.stderr || '').slice(0, 500));
  process.exit(1);
}

const vulns = report.vulnerabilities || {};
const blocking = [];
const waivedHit = [];

for (const [name, v] of Object.entries(vulns)) {
  const severity = String(v.severity || '').toLowerCase();
  if (severity !== 'high' && severity !== 'critical') continue;
  if (WAIVED_PACKAGES[name]) {
    waivedHit.push({ name, severity, until: WAIVED_PACKAGES[name].until });
    continue;
  }
  blocking.push({ name, severity, range: v.range, via: v.via });
}

console.log(JSON.stringify({ waived: waivedHit, blocking, today }, null, 2));
if (blocking.length) {
  console.error(`Dependency gate FAIL: ${blocking.length} unwaived high/critical`);
  process.exit(1);
}
console.log('Dependency gate OK');
process.exit(0);
