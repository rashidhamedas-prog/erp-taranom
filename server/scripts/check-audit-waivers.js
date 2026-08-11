'use strict';
/**
 * npm audit gate — no time-boxed waivers after exceljs migration.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const WAIVED_PACKAGES = {};

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
for (const [name, v] of Object.entries(vulns)) {
  const severity = String(v.severity || '').toLowerCase();
  if (severity !== 'high' && severity !== 'critical') continue;
  if (WAIVED_PACKAGES[name]) continue;
  blocking.push({ name, severity, range: v.range });
}

console.log(JSON.stringify({ waived: [], blocking, today: new Date().toISOString().slice(0, 10) }, null, 2));
if (blocking.length) {
  console.error(`Dependency gate FAIL: ${blocking.length} unwaived high/critical`);
  process.exit(1);
}
console.log('Dependency gate OK');
process.exit(0);
