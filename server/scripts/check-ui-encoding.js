#!/usr/bin/env node
/**
 * CI/local guard: server/public/index.html must remain real UTF-8 Persian.
 * Fails on:
 *  - too few Persian letters
 *  - long runs of replacement '?' (encoding corruption)
 *  - unparseable HTML / embedded script blocks (best-effort)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'public', 'index.html');
const MIN_PERSIAN = Number(process.env.UI_ENCODING_MIN_PERSIAN || 400);
const MAX_QQ_RUN = Number(process.env.UI_ENCODING_MAX_QQ_RUN || 2);

function fail(msg) {
  console.error('❌ encoding guard:', msg);
  process.exit(1);
}

const buf = fs.readFileSync(FILE);
const text = buf.toString('utf8');
const persian = (text.match(/[\u0600-\u06FF]/g) || []).length;
const qqRuns = text.match(/\?{3,}/g) || [];
const longestQ = qqRuns.reduce((m, s) => Math.max(m, s.length), 0);

console.log('file:', FILE);
console.log('bytes:', buf.length, 'BOM:', buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF);
console.log('persian_chars:', persian, '(min', MIN_PERSIAN + ')');
console.log('qq_runs_3plus:', qqRuns.length, 'longest:', longestQ, '(max allowed run', MAX_QQ_RUN + ' for continuous ? — fail if any run ≥3)');

if (persian < MIN_PERSIAN) {
  fail(`Persian char count ${persian} < ${MIN_PERSIAN}`);
}
if (qqRuns.length > 0) {
  fail(`found ${qqRuns.length} runs of ???+ (longest=${longestQ}) — likely mojibake`);
}

// Basic HTML shape
if (!/<html[\s>]/i.test(text) || !/<\/html>/i.test(text)) {
  fail('missing <html>…</html>');
}
if (!/<body[\s>]/i.test(text) || !/<\/body>/i.test(text)) {
  fail('missing <body>…</body>');
}

// Extract and parse inline <script> bodies (not src=)
const inlineScripts = [];
const re = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m;
while ((m = re.exec(text))) {
  const body = m[1].trim();
  if (body) inlineScripts.push(body);
}
for (let i = 0; i < inlineScripts.length; i++) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(inlineScripts[i]);
  } catch (e) {
    fail(`inline script #${i + 1} parse error: ${e.message}`);
  }
}
console.log('inline_scripts_checked:', inlineScripts.length);

// Spot-check known Persian UI strings from healthy shell
const mustHave = ['ورود به سامانه', 'نام کاربری', 'رمز عبور', 'داشبورد'];
for (const s of mustHave) {
  if (!text.includes(s)) fail(`missing expected Persian string: ${s}`);
}

console.log('✅ UI encoding guard PASS');
process.exit(0);
