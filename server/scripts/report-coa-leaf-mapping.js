#!/usr/bin/env node
'use strict';
/**
 * گزارش فقط‌خواندنی نگاشت حساب برگ (فاز ۳ — v586):
 *   - انبارهای دائمی فعال بی‌نگاشت (+ بخش جدا برای غیرفعال)
 *   - کلیدهای coa_* تفکیک‌شده: غیربرگ / کنترلی / یافت‌نشده
 *   - حساب‌های کنترلی با سطر روی خود کنترل
 *   - مانده غیربرگ کنترلی و غیرکنترلی
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

const s = rep.summary;
const md = [];
md.push('# گزارش نگاشت حساب برگ (فاز ۳)');
md.push('');
md.push(`- db: \`${abs}\``);
md.push(`- flag \`${rep.flag.key}\`: **${rep.flag.value}**`);
md.push(`- انبار دائمی فعال بی‌نگاشت: ${s.warehouses_perpetual_unmapped} از ${s.warehouses_total} (غیرفعال جدا: ${s.warehouses_inactive_unmapped})`);
md.push(`- کلیدها کل: ${s.settings_keys_total} · غیربرگ: ${s.settings_nonleaf} · یافت‌نشده: ${s.settings_not_found} · کنترلی: ${s.settings_control}`);
md.push(`- حساب‌های غیربرگ دارای سطر دفتر: ${s.nonleaf_accounts_with_lines} (${s.nonleaf_lines_total} سطر؛ کنترلی ${s.nonleaf_control_accounts} / غیرکنترلی ${s.nonleaf_noncontrol_accounts})`);
md.push(`- total_changes: ${before} → ${after}`);
md.push('');
md.push('## همهٔ انبارها');
md.push('');
md.push('| id | نام | نوع | روش | فعال | موجودی | وضعیت | بهای تمام‌شده | وضعیت |');
md.push('|---:|---|---|---|---|---|---|---|---|');
for (const w of rep.warehouses) {
  md.push(`| ${w.warehouse_id} | ${w.name} | ${w.warehouse_type || ''}${w.fixed_asset_type ? ' ⚠' : ''} | ${w.perpetual ? 'دائمی' : 'ادواری'} | ${w.active ? 1 : 0} | ${w.inventory_coa_code || '—'} | ${w.inventory_ok ? 'OK' : reasonFa(w.inventory_reason)} | ${w.cogs_coa_code || '—'} | ${w.cogs_ok ? 'OK' : reasonFa(w.cogs_reason)} |`);
}
md.push('');
md.push('## انبارهای دائمی فعال بی‌نگاشت');
md.push('');
if (!rep.warehouses_unmapped.length) md.push('_هیچ‌کدام._');
else {
  md.push('| id | نام | نوع | موجودی | وضعیت | بهای تمام‌شده | وضعیت |');
  md.push('|---:|---|---|---|---|---|---|');
  for (const w of rep.warehouses_unmapped) {
    md.push(`| ${w.warehouse_id} | ${w.name} | ${w.warehouse_type || ''}${w.fixed_asset_type ? ' ⚠' : ''} | ${w.inventory_coa_code || '—'} | ${w.inventory_ok ? 'OK' : reasonFa(w.inventory_reason)} | ${w.cogs_coa_code || '—'} | ${w.cogs_ok ? 'OK' : reasonFa(w.cogs_reason)} |`);
  }
}
md.push('');
md.push('## انبارهای غیرفعال بی‌نگاشت (دائمی)');
md.push('');
if (!rep.warehouses_inactive_unmapped.length) md.push('_هیچ‌کدام._');
else {
  md.push('| id | نام | موجودی | بهای تمام‌شده |');
  md.push('|---:|---|---|---|');
  for (const w of rep.warehouses_inactive_unmapped) {
    md.push(`| ${w.warehouse_id} | ${w.name} | ${w.inventory_coa_code || '—'} | ${w.cogs_coa_code || '—'} |`);
  }
}
md.push('');
md.push('## کلیدهای coa_* غیربرگ (نیازمند توجه)');
md.push('');
if (!rep.settings_nonleaf.length) md.push('_هیچ‌کدام._');
else {
  md.push('| کلید | کد | نام | علت | منبع |');
  md.push('|---|---|---|---|---|');
  for (const x of rep.settings_nonleaf) md.push(`| ${x.key} | ${x.code} | ${x.name || ''} | ${reasonFa(x.reason)} | ${x.source} |`);
}
md.push('');
md.push('## کلیدهای کنترلی');
md.push('');
if (!rep.settings_control.length) md.push('_هیچ‌کدام._');
else {
  md.push('| کلید | کد | نام | منبع |');
  md.push('|---|---|---|---|');
  for (const x of rep.settings_control) md.push(`| ${x.key} | ${x.code} | ${x.name || ''} | ${x.source} |`);
}
md.push('');
md.push('## کلیدهای یافت‌نشده');
md.push('');
if (!rep.settings_not_found.length) md.push('_هیچ‌کدام._');
else {
  md.push('| کلید | کد | منبع |');
  md.push('|---|---|---|');
  for (const x of rep.settings_not_found) md.push(`| ${x.key} | ${x.code} | ${x.source} |`);
}
md.push('');
md.push('## حساب‌های کنترلی (سطر روی خود حساب = توجه)');
md.push('');
if (!rep.control_accounts.length) md.push('_هیچ‌کدام._');
else {
  md.push('| کد | نام | تفصیلی فعال | سطر روی کنترل | کلیدها |');
  md.push('|---|---|---:|---:|---|');
  for (const c of rep.control_accounts) {
    md.push(`| ${c.code} | ${c.name || ''} | ${c.active_detail_count} | ${c.lines_on_control} | ${(c.keys || []).join(', ')} |`);
  }
}
md.push('');
md.push('## مانده غیربرگ — کنترلی');
md.push('');
const balCtl = (rep.nonleaf_balances_split && rep.nonleaf_balances_split.control) || [];
if (!balCtl.length) md.push('_هیچ‌کدام._');
else {
  md.push('| کد | نام | تعداد سطر | مانده (ریال) |');
  md.push('|---|---|---:|---:|');
  for (const b of balCtl) md.push(`| ${b.code} | ${b.name || ''} | ${b.line_count} | ${b.balance_rial} |`);
}
md.push('');
md.push('## مانده غیربرگ — غیرکنترلی');
md.push('');
const balNon = (rep.nonleaf_balances_split && rep.nonleaf_balances_split.non_control) || [];
if (!balNon.length) md.push('_هیچ‌کدام._');
else {
  md.push('| کد | نام | تعداد سطر | مانده (ریال) |');
  md.push('|---|---|---:|---:|');
  for (const b of balNon) md.push(`| ${b.code} | ${b.name || ''} | ${b.line_count} | ${b.balance_rial} |`);
}
fs.writeFileSync(outPrefix + '.md', md.join('\n') + '\n', 'utf8');

console.log(outPrefix + '.md');
console.log(outPrefix + '.csv');
console.log(`flag=${rep.flag.value} warehouses_unmapped=${s.warehouses_perpetual_unmapped}/${s.warehouses_total} inactive_unmapped=${s.warehouses_inactive_unmapped} settings_nonleaf=${s.settings_nonleaf} settings_control=${s.settings_control} settings_not_found=${s.settings_not_found} nonleaf_accounts=${s.nonleaf_accounts_with_lines}`);
