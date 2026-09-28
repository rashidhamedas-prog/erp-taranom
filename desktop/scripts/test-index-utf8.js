#!/usr/bin/env node
'use strict';
/**
 * Guard: embedded desktop/android copies of public/index.html must keep Persian UTF-8.
 * Catches ANSI/latin1 corruption that turns login labels into "????".
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const targets = [
  path.join(ROOT, 'server', 'public', 'index.html'),
  path.join(ROOT, 'desktop', 'server', 'public', 'index.html'),
];

let failed = 0;
for (const file of targets) {
  if (!fs.existsSync(file)) {
    console.log('skip (missing)', path.relative(ROOT, file));
    continue;
  }
  const buf = fs.readFileSync(file);
  const text = buf.toString('utf8');
  const persian = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const badClusters = (text.match(/\?{4,}/g) || []).length;
  const hasLoginPhrase = text.includes('سامانه یکپارچه') || text.includes('ورود به سامانه');
  const ok = persian >= 100 && badClusters === 0 && hasLoginPhrase;
  console.log(ok ? '  ✅' : '  ❌', path.relative(ROOT, file),
    `persian=${persian} qmarkClusters=${badClusters} loginPhrase=${hasLoginPhrase}`);
  if (!ok) failed++;
}

if (failed) {
  console.error('\n💥 UTF-8 Persian guard failed — re-copy from server/public/index.html (never save as ANSI).');
  process.exit(1);
}
console.log('\n🎉 index.html Persian UTF-8 OK');
