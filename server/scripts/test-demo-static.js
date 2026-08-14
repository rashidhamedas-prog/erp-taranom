#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function scanDemoStatic(publicDir) {
  const dir = publicDir || path.join(__dirname, '..', 'public');
  const files = ['demo.html', 'demo.js', 'demo.css'].map((n) => path.join(dir, n));
  const text = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const networkHits = [];
  if (/\bfetch\s*\(/.test(text)) networkHits.push('fetch');
  if (/XMLHttpRequest/.test(text)) networkHits.push('XMLHttpRequest');
  if (/new\s+WebSocket/.test(text)) networkHits.push('WebSocket');
  if (/EventSource\s*\(/.test(text)) networkHits.push('EventSource');
  const secretHits = [];
  for (const s of ['admin123', 'demo1234', 'laptop-demo-secret', 'demo-seed-secret']) {
    if (text.includes(s)) secretHits.push(s);
  }
  const fails = [];
  if (networkHits.length) fails.push('network primitive found');
  if (secretHits.length) fails.push('hardcoded credential found');
  if (!/ساختگی/.test(text)) fails.push('missing fake-data watermark text');
  if (!/ترانه اندیشه پردازان ریان/.test(text)) fails.push('missing manufacturer credit');
  if (!/app\.css/.test(text)) fails.push('static demo must reuse app.css');
  if (!/پیش‌فاکتور|پيش فاکتور/.test(text)) fails.push('missing proforma mention');
  if (!/عادی|معمولی/.test(text)) fails.push('missing normal invoice mention');
  if (!/نهایی/.test(text)) fails.push('missing final invoice mention');
  return {
    ok: fails.length === 0,
    fails,
    networkHits,
    secretHits,
    watermarkOk: /ساختگی/.test(text),
    invoicesOk: (/پیش‌فاکتور/.test(text) || /پيش فاکتور/.test(text)) && /عادی|معمولی/.test(text) && /نهایی/.test(text),
    checks: [{ id: 'network', detail: networkHits.length ? networkHits.join(',') : 'no network primitives' }],
  };
}

module.exports = { scanDemoStatic };

if (require.main === module) {
  const r = scanDemoStatic();
  if (!r.ok) {
    console.error('STATIC DEMO FAIL');
    for (const f of r.fails) console.error(' -', f);
    process.exit(1);
  }
  console.log('STATIC DEMO OK');
}
