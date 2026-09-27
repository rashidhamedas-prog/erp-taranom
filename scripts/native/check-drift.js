#!/usr/bin/env node
'use strict';
/**
 * CI drift gate: regenerate OPERATION-CONTRACT + schema hash; fail if sha files differ.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const nodeBin = process.execPath;

function run(script) {
  const r = spawnSync(nodeBin, [path.join(ROOT, 'scripts', 'native', script)], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  if (r.status !== 0) {
    console.error(r.stdout || '');
    console.error(r.stderr || '');
    throw new Error(script + ' failed exit=' + r.status);
  }
  console.log(r.stdout.trim().split('\n').slice(-4).join('\n'));
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').trim();
}

const before = {
  contract: read('docs/native/OPERATION-CONTRACT.sha256'),
  schema: read('docs/native/schema.v1.sha256'),
};

run('generate-operation-contract.js');
run('schema-hash.js');

const after = {
  contract: read('docs/native/OPERATION-CONTRACT.sha256'),
  schema: read('docs/native/schema.v1.sha256'),
};

let failed = 0;
for (const k of Object.keys(before)) {
  if (before[k] !== after[k]) {
    console.error(`DRIFT ${k}: committed=${before[k]} regenerated=${after[k]}`);
    failed++;
  } else {
    console.log(`OK ${k} ${after[k]}`);
  }
}

if (failed) {
  console.error('Re-run generators and commit updated docs/native artifacts.');
  process.exit(1);
}
console.log('drift check passed');
