#!/usr/bin/env node
'use strict';
/**
 * Generate docs/native/OPERATION-CONTRACT.md (+ .json) from live sync capture registry.
 * CI gate: regenerate and fail if git diff is non-empty.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const OUT_MD = path.join(ROOT, 'docs', 'native', 'OPERATION-CONTRACT.md');
const OUT_JSON = path.join(ROOT, 'docs', 'native', 'OPERATION-CONTRACT.json');

const {
  PATH_TABLE_MAP, tableForPath, BLOCKLIST, BLOCK_PATTERNS,
} = require(path.join(ROOT, 'server', 'sync', 'capture.js'));
const {
  SYNCABLE_TABLES, FK_COLUMNS, PROVISIONAL_FLOOR, DEVICE_SPAN, TABLE_SPAN,
  LEGACY_TABLE_SLOTS, OVERFLOW_FLOOR,
} = require(path.join(ROOT, 'server', 'sync', 'tables.js'));

const blockPatternsSrc = BLOCK_PATTERNS.map((re) => re.source);

const routesDir = path.join(ROOT, 'server', 'routes');
const routeFiles = fs.readdirSync(routesDir).filter((f) => f.endsWith('.js') && !f.includes('.bak'));
let mutating = 0;
const methodHits = { get: 0, post: 0, put: 0, patch: 0, delete: 0 };
for (const f of routeFiles) {
  const src = fs.readFileSync(path.join(routesDir, f), 'utf8');
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
    const re = new RegExp(`router\\.${m}\\s*\\(`, 'gi');
    const n = (src.match(re) || []).length;
    methodHits[m] += n;
    if (m !== 'get') mutating += n;
  }
}

const pathMap = PATH_TABLE_MAP.map(([prefix, table]) => ({ prefix, table }));
const tables = SYNCABLE_TABLES.map((t, i) => ({
  index: i,
  name: t.name,
  upsertKey: t.upsertKey || 'id',
  compositeKeys: t.compositeKeys || null,
}));

const canonical = {
  source: {
    capture: 'server/sync/capture.js',
    tables: 'server/sync/tables.js',
    routes: 'server/routes/*.js',
  },
  counts: {
    route_files: routeFiles.length,
    endpoints_by_method: methodHits,
    mutating_endpoints_approx: mutating,
    syncable_tables: SYNCABLE_TABLES.length,
    path_table_map: pathMap.length,
    fk_columns: FK_COLUMNS.length,
  },
  id_space: {
    PROVISIONAL_FLOOR, DEVICE_SPAN, TABLE_SPAN, LEGACY_TABLE_SLOTS, OVERFLOW_FLOOR,
  },
  blocklist: BLOCKLIST,
  block_patterns: blockPatternsSrc,
  path_table_map: pathMap,
  syncable_tables: tables,
  fk_columns: FK_COLUMNS.slice(),
  samples: {
    '/api/customers': tableForPath('/api/customers'),
    '/api/invoices/1': tableForPath('/api/invoices/1'),
    '/api/warehouses/moves': tableForPath('/api/warehouses/moves'),
    '/api/warehouses': tableForPath('/api/warehouses'),
  },
};

const hash = crypto.createHash('sha256')
  .update(JSON.stringify(canonical))
  .digest('hex');

const payload = {
  content_sha256: hash,
  ...canonical,
};

const jsonBody = JSON.stringify(payload, null, 2) + '\n';

const md = [
  '# OPERATION-CONTRACT — قرارداد عملیات سینک (تولید خودکار)',
  '',
  '> **تولید:** `node scripts/native/generate-operation-contract.js`',
  `> **SHA-256 محتوا:** \`${hash}\``,
  '',
  'این فایل را دستی ویرایش نکنید. هر تغییر در `capture.js` / `tables.js` باید دوباره تولید و در CI بدون diff باشد.',
  '',
  '## شمارش‌ها',
  '',
  `| شاخص | مقدار |`,
  `|---|---|`,
  `| فایل‌های route | ${payload.counts.route_files} |`,
  `| endpoint mutating (تقریبی) | ${payload.counts.mutating_endpoints_approx} |`,
  `| GET / POST / PUT / PATCH / DELETE | ${methodHits.get} / ${methodHits.post} / ${methodHits.put} / ${methodHits.patch} / ${methodHits.delete} |`,
  `| جداول syncable | ${payload.counts.syncable_tables} |`,
  `| PATH_TABLE_MAP | ${payload.counts.path_table_map} |`,
  `| FK_COLUMNS | ${payload.counts.fk_columns} |`,
  '',
  '## فضای شناسه',
  '',
  '```',
  `PROVISIONAL_FLOOR=${PROVISIONAL_FLOOR}`,
  `DEVICE_SPAN=${DEVICE_SPAN}`,
  `TABLE_SPAN=${TABLE_SPAN}`,
  `LEGACY_TABLE_SLOTS=${LEGACY_TABLE_SLOTS}`,
  `OVERFLOW_FLOOR=${OVERFLOW_FLOOR}`,
  '```',
  '',
  '## BLOCKLIST (پیشوند مسیر)',
  '',
  ...BLOCKLIST.map((p) => `- \`${p}\``),
  '',
  '## BLOCK_PATTERNS',
  '',
  ...blockPatternsSrc.map((p) => `- \`/${p}/\``),
  '',
  '## PATH_TABLE_MAP (خاص قبل از عام)',
  '',
  '| پیشوند | جدول |',
  '|---|---|',
  ...pathMap.map((r) => `| \`${r.prefix}\` | \`${r.table}\` |`),
  '',
  '## SYNCABLE_TABLES (append-only — ترتیب مقدس)',
  '',
  '| # | جدول | upsertKey | compositeKeys |',
  '|---|---|---|---|',
  ...tables.map((t) => `| ${t.index} | \`${t.name}\` | \`${t.upsertKey}\` | ${t.compositeKeys ? '`' + t.compositeKeys.join(',') + '`' : '—'} |`),
  '',
  '## نمونه tableForPath',
  '',
  '```json',
  JSON.stringify(payload.samples, null, 2),
  '```',
  '',
  'فایل ماشین‌خوان: [`OPERATION-CONTRACT.json`](./OPERATION-CONTRACT.json)',
  '',
];

fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
fs.writeFileSync(OUT_JSON, jsonBody);
fs.writeFileSync(OUT_MD, md.join('\n'));
fs.writeFileSync(path.join(ROOT, 'docs', 'native', 'OPERATION-CONTRACT.sha256'), hash + '\n');
console.log('OK', OUT_MD);
console.log('OK', OUT_JSON);
console.log('content_sha256', hash);
console.log('tables', SYNCABLE_TABLES.length, 'mutating≈', mutating);
