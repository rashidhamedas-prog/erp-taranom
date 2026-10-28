#!/usr/bin/env node
'use strict';
/**
 * گزارش فقط‌خواندنی نگاشت حساب برگ (فاز ۱ — v585):
 *   - انبارهای بی‌نگاشت یا با نگاشت غیربرگ (موجودی / بهای تمام‌شده)
 *   - کلیدهای coa_* در settings که غیربرگ‌اند
 *   - مانده و تعداد سطرهای دفتر روی حساب‌های غیربرگ (مثل 1104)
 *
 * Usage:
 *   node server/scripts/report-coa-leaf-mapping.js --db=/path/to/crm.db [--out=/path/prefix]
 * DB باز می‌شود readonly؛ خروجی در ~/backups/reports/. هرگز در DB نمی‌نویسد.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { buildCoaLeafReport } = require('../lib/coa-leaf-report');
const { reasonFa } = require('../lib/coa-leaf-policy');

const args = process.argv.slice(2);
function argValue(prefix, flag) {
  const hit = args.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : '';
}
const dbPath = argValue('--db=', '--db');
const outExplicit = argValue('--out=', '--out');

if (!dbPath) {
  console.error('Usage: report-coa-leaf-mapping.js --db=/path/to/crm.db [--out=prefix]');
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
  : path.join(home, 'backups', 'reports', `coa-leaf-mapping-${stamp()}`);
fs.mkdirSync(path.dirname(outPrefix), { recursive: true });

const rep = buildCoaLeafReport(db);
const after = db.prepare('SELECT total_changes() c').get().c;
db.close();
if (before !== after) {
  console.error('STOP: گزارش فقط‌خواندنی total_changes را عوض کرد');
  process.exit(1);
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const whHeaders = [
  'warehouse_id', 'name', 'warehouse_type', 'perpetual', 'active',
  'inventory_coa_code', 'inventory_reason', 'cogs_coa_code', 'cogs_reason', 'mapped',
];
const csv = [whHeaders.join(',')].concat(
  rep.warehouses.map((w) => whHeaders.map((h) => csvEscape(h === 'warehouse_id' ? w.warehouse_id : w[h])).join(',')),
).join('\n') + '\n';
fs.writeFileSync(outPrefix + '.csv', csv, 'utf8');

const md = [];
md.push('# گزارش نگاشت حساب برگ (فاز ۱)');
md.push('');
md.push(`- db: \`${abs}\``);
md.push(`- flag \`${rep.flag.key}\`: **${rep.flag.value}**`);
md.push(`- انبار دائمی بی‌نگاشت/غیربرگ: ${rep.summary.warehouses_perpetual_unmapped} از ${rep.summary.warehouses_total}`);
md.push(`- کلیدهای coa_* غیربرگ: ${rep.summary.settings_nonleaf}`);
md.push(`- حساب‌های غیربرگ دارای سطر دفتر: ${rep.summary.nonleaf_accounts_with_lines} (${rep.summary.nonleaf_lines_total} سطر)`);
md.push(`- total_changes: ${before} → ${after}`);
md.push('');
md.push('## انبارها');
md.push('');
md.push('| id | نام | نوع | روش | موجودی | وضعیت | بهای تمام‌شده | وضعیت |');
md.push('|---:|---|---|---|---|---|---|---|');
for (const w of rep.warehouses) {
  md.push(`| ${w.warehouse_id} | ${w.name} | ${w.warehouse_type || ''}${w.fixed_asset_type ? ' ⚠' : ''} | ${w.perpetual ? 'دائمی' : 'ادواری'} | ${w.inventory_coa_code || '—'} | ${w.inventory_ok ? 'OK' : reasonFa(w.inventory_reason)} | ${w.cogs_coa_code || '—'} | ${w.cogs_ok ? 'OK' : reasonFa(w.cogs_reason)} |`);
}
md.push('');
md.push('## کلیدهای coa_* غیربرگ');
md.push('');
if (!rep.settings_nonleaf.length) md.push('_هیچ‌کدام._');
else {
  md.push('| کلید | کد | نام | علت | منبع |');
  md.push('|---|---|---|---|---|');
  for (const s of rep.settings_nonleaf) md.push(`| ${s.key} | ${s.code} | ${s.name || ''} | ${reasonFa(s.reason)} | ${s.source} |`);
}
md.push('');
md.push('## مانده و سطرهای دفتر روی حساب‌های غیربرگ');
md.push('');
if (!rep.nonleaf_balances.length) md.push('_هیچ‌کدام._');
else {
  md.push('| کد | نام | تعداد سطر | بدهکار (ریال) | بستانکار (ریال) | مانده (ریال) |');
  md.push('|---|---|---:|---:|---:|---:|');
  for (const b of rep.nonleaf_balances) {
    md.push(`| ${b.code} | ${b.name || ''} | ${b.line_count} | ${b.debit_rial} | ${b.credit_rial} | ${b.balance_rial} |`);
  }
}
fs.writeFileSync(outPrefix + '.md', md.join('\n') + '\n', 'utf8');

console.log(outPrefix + '.md');
console.log(outPrefix + '.csv');
console.log(`flag=${rep.flag.value} warehouses_unmapped=${rep.summary.warehouses_perpetual_unmapped}/${rep.summary.warehouses_total} settings_nonleaf=${rep.summary.settings_nonleaf} nonleaf_accounts=${rep.summary.nonleaf_accounts_with_lines}`);
