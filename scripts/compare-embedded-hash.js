'use strict';
const { TARGETS, compareRuntime } = require('./embedded-server-files');
let failed = false;
for (const name of Object.keys(TARGETS)) {
  const result = compareRuntime(name);
  const diff = result.missing.length + result.extra.length + result.mismatch.length;
  console.log(JSON.stringify({ ...result, diff }, null, 2));
  if (diff) failed = true;
}
if (failed) {
  console.error('embedded runtime drift detected; run: node scripts/prepare-embedded-server.js all');
  process.exit(1);
}
console.log('embedded runtime SHA-256 diff: 0');
