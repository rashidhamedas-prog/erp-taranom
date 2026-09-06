#!/usr/bin/env node
/**
 * Fail the build if app code binds CSP events that the runtime does not list
 * at file-parse time (submit etc.). Auto-register still exists as a safety net.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'public');
const runtime = fs.readFileSync(path.join(root, 'csp-runtime.js'), 'utf8');
const eventsMatch = runtime.match(/const EVENT_TYPES = \[([\s\S]*?)\];/);
if (!eventsMatch) {
  console.error('FAIL: could not parse EVENT_TYPES from csp-runtime.js');
  process.exit(1);
}
const allowed = new Set(
  [...eventsMatch[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1])
);
if (!allowed.has('submit')) {
  console.error('FAIL: EVENT_TYPES must include submit (settings page regression)');
  process.exit(1);
}

const files = ['app.js', 'acc-nav.js', 'prod-ui.js', 'mdi.js', 'tbl-enhance.js']
  .map((f) => path.join(root, f))
  .filter((f) => fs.existsSync(f));

let bad = 0;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/CSP\.bind\(\s*['"]([a-z]+)['"]/g)) {
    if (!allowed.has(m[1])) {
      console.error(`FAIL ${path.basename(file)}: CSP.bind('${m[1]}') not in EVENT_TYPES`);
      bad += 1;
    }
  }
}
if (bad) {
  console.error(`\n${bad} unsupported CSP.bind event(s)`);
  process.exit(1);
}
console.log(`OK CSP events — ${allowed.size} types, scanned ${files.length} files`);
