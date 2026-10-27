#!/usr/bin/env node
'use strict';
/**
 * Read-only: active product_colors with empty/invalid hex.
 * Usage: node scripts/report-color-missing-hex.js --db <path>
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { safeCssHex } = require('../lib/prod-sku-color-panel');

function usage() {
  console.error('Usage: node scripts/report-color-missing-hex.js --db <path-to.db>');
  console.error('       node scripts/report-color-missing-hex.js --db=<path-to.db>');
}

function parseDbArg(argv) {
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') return argv[i + 1] || '';
    if (a.startsWith('--db=')) return a.slice(5);
  }
  return '';
}

const dbPath = parseDbArg(process.argv);
if (!dbPath) {
  usage();
  process.exit(2);
}
if (!fs.existsSync(dbPath)) {
  console.error('DB not found:', dbPath);
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const rows = db.prepare(`
  SELECT id, name, code, hex, IFNULL(active,1) AS active
  FROM product_colors
  WHERE IFNULL(active,1)=1
  ORDER BY id
`).all();

const bad = rows.filter((r) => !safeCssHex(r.hex));
console.log('=== Active product_colors with missing/invalid hex ===');
if (!bad.length) {
  console.log('(none)');
} else {
  console.log('id,name,code,hex');
  for (const r of bad) {
    const hex = r.hex == null ? '' : String(r.hex);
    const safe = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    console.log([r.id, safe(r.name), safe(r.code), safe(hex)].join(','));
  }
}
console.log('count=', bad.length);
console.log('Done. DB=', path.resolve(dbPath));
db.close();
