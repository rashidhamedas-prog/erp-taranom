#!/usr/bin/env node
'use strict';
/**
 * گزارش فقط‌خواندنی تطبیق بهای تمام‌شده دفتر با خروج کاردکس فروش.
 * شامل سندهای invoice_cogs / invoice_cogs_fix / invoice_cogs_reversal.
 *
 * Usage:
 *   node server/scripts/report-cogs-reconcile.js --db=/path/to/crm.db [--out=/path/prefix]
 * Never writes to the DB.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const {
  cogsPostedByInvoiceMap,
  kardexSaleOutByInvoiceMap,
  COGS_JE_REF_TYPES,
} = require('../lib/inventory/cogs-per-invoice');

const args = process.argv.slice(2);
function argValue(prefix) {
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}
const dbPath = argValue('--db=') || (() => {
  const i = args.indexOf('--db');
  return i >= 0 ? args[i + 1] : '';
})();
const outExplicit = argValue('--out=') || (() => {
  const i = args.indexOf('--out');
  return i >= 0 ? args[i + 1] : '';
})();

if (!dbPath) {
  console.error('Usage: report-cogs-reconcile.js --db=/path/to/crm.db [--out=prefix]');
  process.exit(2);
}
if (!fs.existsSync(dbPath)) {
  console.error('DB not found:', dbPath);
  process.exit(2);
}

const abs = path.resolve(dbPath);
const db = new Database(abs, { readonly: true, fileMustExist: true });
const before = db.prepare('SELECT total_changes() c').get().c;

const FOCUS_NUMS = [
  'T-0001', 'T-0002', 'T-0003', 'T-0004', 'T-0005', 'T-0007', 'T-0009',
  'T-0014', 'T-0015', 'T-0031', 'T-0033', 'T-0034', 'T-0035',
];

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
const defaultDir = path.join(home, 'backups', 'reports');
const outPrefix = outExplicit
  ? path.resolve(outExplicit)
  : path.join(defaultDir, `cogs-reconcile-${stamp()}`);

fs.mkdirSync(path.dirname(outPrefix), { recursive: true });

const kardex = kardexSaleOutByInvoiceMap(db);
const cogs = cogsPostedByInvoiceMap(db);
const ids = new Set([...kardex.keys(), ...cogs.keys()]);

const invCols = db.prepare('PRAGMA table_info(invoices)').all().map((c) => c.name);
const hasNum = invCols.includes('num');

const rows = [];
for (const id of ids) {
  if (!id) continue;
  const inv = db.prepare(`
    SELECT id, ${hasNum ? 'num' : "'' AS num"}, date
    FROM invoices WHERE id=?
  `).get(id);
  if (!inv) continue;
  const k = kardex.get(id) || 0;
  const c = cogs.get(id) || 0;
  rows.push({
    invoice_id: inv.id,
    num: inv.num || '',
    date: inv.date || '',
    kardex_rial: k,
    cogs_rial: c,
    diff_rial: k - c,
  });
}
rows.sort((a, b) => String(a.num).localeCompare(String(b.num), 'fa') || (a.invoice_id - b.invoice_id));

const after = db.prepare('SELECT total_changes() c').get().c;
if (before !== after) {
  console.error('STOP: گزارش فقط‌خواندنی total_changes را عوض کرد');
  db.close();
  process.exit(1);
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
const headers = ['invoice_id', 'num', 'date', 'kardex_rial', 'cogs_rial', 'diff_rial'];
const csv = [headers.join(',')].concat(
  rows.map((r) => headers.map((h) => csvEscape(r[h])).join(','))
).join('\n') + '\n';
fs.writeFileSync(outPrefix + '.csv', csv, 'utf8');

const mismatches = rows.filter((r) => r.diff_rial !== 0);
const focus = FOCUS_NUMS.map((num) => {
  const r = rows.find((x) => x.num === num);
  return r || { num, invoice_id: '', date: '', kardex_rial: '', cogs_rial: '', diff_rial: 'NOT_FOUND' };
});

const md = [];
md.push('# گزارش تطبیق COGS با کاردکس');
md.push('');
md.push(`- db: \`${abs}\``);
md.push(`- ref_types: ${COGS_JE_REF_TYPES.join(', ')}`);
md.push(`- invoices_scanned: ${rows.length}`);
md.push(`- mismatches: ${mismatches.length}`);
md.push(`- total_changes: ${before} → ${after}`);
md.push('');
md.push('## ۱۳ فاکتور موردنظر (فاز ۰)');
md.push('');
md.push('| فاکتور | کاردکس | COGS دفتر | اختلاف |');
md.push('|---|---:|---:|---:|');
for (const r of focus) {
  md.push(`| ${r.num} | ${r.kardex_rial} | ${r.cogs_rial} | ${r.diff_rial} |`);
}
md.push('');
md.push('## همهٔ اختلاف‌های غیرصفر');
md.push('');
if (!mismatches.length) {
  md.push('_هیچ اختلافی نیست._');
} else {
  md.push('| فاکتور | id | کاردکس | COGS | اختلاف |');
  md.push('|---|---:|---:|---:|---:|');
  for (const r of mismatches) {
    md.push(`| ${r.num} | ${r.invoice_id} | ${r.kardex_rial} | ${r.cogs_rial} | ${r.diff_rial} |`);
  }
}
fs.writeFileSync(outPrefix + '.md', md.join('\n') + '\n', 'utf8');

console.log(outPrefix + '.md');
console.log(outPrefix + '.csv');
console.log(`mismatches=${mismatches.length}`);
for (const r of focus) {
  console.log(`${r.num}\tdiff=${r.diff_rial}\tkardex=${r.kardex_rial}\tcogs=${r.cogs_rial}`);
}
db.close();
