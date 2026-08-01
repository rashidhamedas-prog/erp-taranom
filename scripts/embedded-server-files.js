'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'server');
const TARGETS = {
  desktop: path.join(ROOT, 'desktop', 'server'),
  android: path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'nodejs-project', 'server'),
};
const SKIP_DIRS = new Set(['node_modules', 'backups', 'uploads']);
const SKIP_FILE = /(?:^|\/)(?:\.env|.*\.db(?:-wal|-shm)?|.*\.log|.*\.xlsx?|.*\.xls)$/i;
const SKIP_RUNTIME = [
  /^scripts\/test-.*\.(?:js|mjs)$/i,
  /^scripts\/.*mahak.*$/i,
  /^scripts\/(?:import|verify)-mahak.*$/i,
  /^scripts\/seed-.*\.js$/i,
  /^lib\/mahak-import(?:-helpers)?\.js$/i,
  /^mahak-.*\.md$/i,
  /^public\/releases\/.*\.(?:exe|apk|blockmap)$/i,
  /^public\/uploads(?:\/|$)/i,
];

const normalize = relativePath => relativePath.split(path.sep).join('/');
function shouldSkip(relativePath, entry) {
  const rel = normalize(relativePath);
  if (rel.split('/').some(part => SKIP_DIRS.has(part))) return true;
  if (entry.isFile() && SKIP_FILE.test(rel)) return true;
  return SKIP_RUNTIME.some(pattern => pattern.test(rel));
}
function listRuntimeFiles(base = SOURCE) {
  const result = [];
  function walk(current, relative = '') {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = relative ? path.join(relative, entry.name) : entry.name;
      if (shouldSkip(rel, entry)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) result.push(normalize(rel));
    }
  }
  walk(base);
  return result.sort();
}
function copyRuntime(targetName) {
  const destination = TARGETS[targetName];
  if (!destination) throw new Error(`Unknown embedded target: ${targetName}`);
  fs.rmSync(destination, { recursive: true, force: true });
  const files = listRuntimeFiles(SOURCE);
  for (const rel of files) {
    const sourceFile = path.join(SOURCE, ...rel.split('/'));
    const destinationFile = path.join(destination, ...rel.split('/'));
    fs.mkdirSync(path.dirname(destinationFile), { recursive: true });
    fs.copyFileSync(sourceFile, destinationFile);
  }
  return { targetName, destination, count: files.length };
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function compareRuntime(targetName) {
  const destination = TARGETS[targetName];
  if (!destination) throw new Error(`Unknown embedded target: ${targetName}`);
  const expected = listRuntimeFiles(SOURCE);
  const actual = listRuntimeFiles(destination);
  const expectedSet = new Set(expected), actualSet = new Set(actual);
  const missing = expected.filter(rel => !actualSet.has(rel));
  const extra = actual.filter(rel => !expectedSet.has(rel));
  const mismatch = expected.filter(rel => actualSet.has(rel)
    && sha256(path.join(SOURCE, ...rel.split('/'))) !== sha256(path.join(destination, ...rel.split('/'))));
  return { targetName, expected: expected.length, actual: actual.length, missing, extra, mismatch };
}
module.exports = { ROOT, SOURCE, TARGETS, listRuntimeFiles, copyRuntime, compareRuntime };
