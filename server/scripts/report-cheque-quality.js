#!/usr/bin/env node
'use strict';
/**
 * Read-only cheque quality report.
 * Usage: node scripts/report-cheque-quality.js --db /path/to/crm.db [--out report.md]
 * NEVER writes to the database.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const {
  chequeQualityFlags, QUALITY_LABEL_FA, buildDupSayadSet, buildAdminNameSet, digitsOnly,
} = require('../lib/cheque-quality');
const { todayJalali } = require('../jalali');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}

const dbPath = arg('--db');
if (!dbPath) {
  console.error('Usage: node scripts/report-cheque-quality.js --db <path-to-crm.db> [--out file.md|csv]');
  process.exit(2);
}
if (!fs.existsSync(dbPath)) {
  console.error('DB not found:', dbPath);
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const today = arg('--today', todayJalali());
const ctx = {
  today,
  dupSayads: buildDupSayadSet(db),
  adminNames: buildAdminNameSet(db),
};

const rows = db.prepare(`
  SELECT * FROM cheque_records
  WHERE COALESCE(record_status,'posted')='posted'
  ORDER BY id
`).all();

const lines = [];
lines.push(`# گزارش کیفیت دفتر چک`);
lines.push(`تاریخ مبنا: ${today}`);
lines.push(`تعداد posted: ${rows.length}`);
lines.push('');
lines.push('| id | جهت | شماره | مبلغ | طرف | صیاد | چرخه | پرچم‌ها |');
lines.push('|---:|:---:|:---|---:|:---|:---|:---|:---|');

const counts = {};
for (const r of rows) {
  const flags = chequeQualityFlags(r, ctx);
  for (const f of flags) counts[f] = (counts[f] || 0) + 1;
  if (!flags.length) continue;
  lines.push(`| ${r.id} | ${r.direction} | ${r.cheque_number || ''} | ${Math.round(r.amount || 0)} | ${(r.party_name || '').replace(/\|/g, '/')} | ${digitsOnly(r.sayadi) || '—'} | ${r.lifecycle_status || ''} | ${flags.map((f) => QUALITY_LABEL_FA[f] || f).join('، ')} |`);
}

lines.push('');
lines.push('## خلاصه پرچم‌ها');
for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  lines.push(`- ${QUALITY_LABEL_FA[k] || k}: ${n}`);
}

const out = arg('--out');
const text = lines.join('\n') + '\n';
if (out) {
  fs.writeFileSync(path.resolve(out), text, 'utf8');
  console.log('wrote', out);
} else {
  process.stdout.write(text);
}
db.close();
