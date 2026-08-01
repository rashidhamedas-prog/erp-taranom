'use strict';

const assert = require('assert');
const path = require('path');
const { ROOT, TARGETS, compareRuntime } = require('./embedded-server-files');

for (const targetName of Object.keys(TARGETS)) {
  const result = compareRuntime(targetName);
  assert.deepStrictEqual(result.missing, [], `${targetName}: missing runtime files`);
  assert.deepStrictEqual(result.extra, [], `${targetName}: extra runtime files`);
  assert.deepStrictEqual(result.mismatch, [], `${targetName}: SHA-256 mismatch`);
}

const modules = [
  path.join(ROOT, 'server', 'lib', 'app-update.js'),
  path.join(TARGETS.desktop, 'lib', 'app-update.js'),
  path.join(TARGETS.android, 'lib', 'app-update.js'),
];
const releaseIds = modules.map(modulePath => require(modulePath).readManifest().releaseId);
assert(releaseIds[0], 'release id must be present');
assert(releaseIds.every(id => id === releaseIds[0]), `release id drift: ${releaseIds.join(', ')}`);
console.log(`embedded release test: 7/7 pass; release_id=${releaseIds[0]}`);
