#!/usr/bin/env node
'use strict';
/**
 * گزارش فقط‌خواندنی تطبیق حساب موجودی (مثل 1104) با کاردکس انبارهای انتخابی.
 *
 * Usage:
 *   node server/scripts/report-inventory-gl-gap.js --db=/path/to/crm.db \
 *     --acct 1104 --warehouses 34,35 --cutoff 1405/08/30 [--out=/path/prefix]
 *
 * DB با readonly:true باز می‌شود؛ خروجی JSON+Markdown در ~/backups/reports/.
 * هیچ INSERT/UPDATE/DELETE و هیچ سند حسابداری تولید نمی‌شود.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { buildInventoryGlGapReport, reportToMarkdown } = require('../lib/inventory-gl-gap-report');

const args = process.argv.slice(2);
function argValue(prefix, flag) {
  const hit = args.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : '';
}

const dbPath = argValue('--db=', '--db');
const acct = argValue('--acct=', '--acct') || '1104';
const warehouses = argValue('--warehouses=', '--warehouses') || '34,35';
const cutoff = argValue('--cutoff=', '--cutoff') || '';
const outExplicit = argValue('--out=', '--out');

if (!dbPath || !cutoff) {
  console.error('Usage: report-inventory-gl-gap.js --db=/path/to/crm.db --acct 1104 --warehouses 34,35 --cutoff 1405/08/30 [--out=prefix]');
  process.exit(2);
}
if (!fs.existsSync(dbPath)) {
  console.error('DB not found:', dbPath);
  process.exit(2);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const abs = path.resolve(dbPath);
const db = new Database(abs, { readonly: true, fileMustExist: true });
const before = db.prepare('SELECT total_changes() c').get().c;

const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
const outPrefix = outExplicit
  ? path.resolve(outExplicit)
  : path.join(home, 'backups', 'reports', `inventory-gl-gap-${acct}-${stamp()}`);
fs.mkdirSync(path.dirname(outPrefix), { recursive: true });

let rep;
try {
  rep = buildInventoryGlGapReport(db, { acct, warehouses, cutoff });
} catch (e) {
  db.close();
  console.error(e.message || e);
  process.exit(1);
}

const after = db.prepare('SELECT total_changes() c').get().c;
db.close();
if (before !== after) {
  console.error('STOP: گزارش فقط‌خواندنی total_changes را عوض کرد');
  process.exit(1);
}

fs.writeFileSync(outPrefix + '.json', JSON.stringify(rep, null, 2), 'utf8');
fs.writeFileSync(outPrefix + '.md', reportToMarkdown(rep, { db: abs, total_changes: `${before}→${after}` }), 'utf8');

console.log(outPrefix + '.md');
console.log(outPrefix + '.json');
console.log(
  `acct=${acct} wh=${warehouses} cutoff=${cutoff} gl=${rep.summary.gl_rial} kardex=${rep.summary.kardex_mapped_rial} gap=${rep.summary.gap_rial} residual=${rep.summary.residual_rial} total_changes=${before}→${after}`,
);
