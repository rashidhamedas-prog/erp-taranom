#!/usr/bin/env node
'use strict';
/**
 * Fail if server/public HTML/JS/CSS has mojibake, U+FFFD, ????, or BOM.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
const EXTS = new Set(['.html', '.js', '.css']);
const failures = [];
let checked = 0;

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (EXTS.has(path.extname(name).toLowerCase())) checkFile(p);
  }
}

function checkFile(filePath) {
  checked += 1;
  const buf = fs.readFileSync(filePath);
  const rel = path.relative(path.join(__dirname, '..'), filePath).replace(/\\/g, '/');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    failures.push(`${rel}: UTF-8 BOM`);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    failures.push(`${rel}: invalid UTF-8 (${e.message})`);
    return;
  }
  if (text.includes('\uFFFD')) failures.push(`${rel}: contains U+FFFD`);
  if (text.includes('????')) failures.push(`${rel}: contains ????`);
  if (/\u00d8[\u0080-\u00bf]/.test(text) || /Ø[\u0080-\u00bf]/.test(text)) {
    failures.push(`${rel}: latin1/UTF-8 mojibake pattern (Ø…)`);
  }
  if (rel.endsWith('public/index.html') || rel.endsWith('index.html')) {
    const m = text.match(/<title>([^<]*)<\/title>/i);
    if (!m || !m[1].includes('ترنم')) {
      failures.push(`${rel}: <title> must contain ترنم (got ${m ? m[1] : 'missing'})`);
    }
  }
}

walk(ROOT);

if (failures.length) {
  console.error('test-public-encoding FAILED:');
  failures.forEach((f) => console.error('  -', f));
  process.exit(1);
}
console.log(`test-public-encoding OK — ${checked} files`);
process.exit(0);
