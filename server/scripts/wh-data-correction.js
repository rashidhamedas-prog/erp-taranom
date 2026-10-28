'use strict';
/**
 * اصلاح دادهٔ انبار.
 * --phase B|C|D
 * --dry-run (پیش‌فرض) | --apply-sandbox | --apply
 * --apply نیاز به --expect-max-changes و --expect-summary دارد.
 * --apply-sandbox فقط اگر مسیر DB زیر backups/sandbox- باشد.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { runCorrection } = require('../lib/inventory/wh-data-correction');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  if (v == null || v.startsWith('--')) return fallback;
  return v;
}
function has(name) { return process.argv.includes(name); }

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function writeCsv(file, headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

function isSandbox(p) {
  return p.replace(/\\/g, '/').toLowerCase().includes('/backups/sandbox-');
}

function productionLocked(dbPath) {
  const norm = dbPath.replace(/\\/g, '/').toLowerCase();
  const live = norm.endsWith('/server/crm.db') || norm.includes('/crm-taranom/');
  if (!live) return false;
  const probe = spawnSync('pm2', ['jlist'], { encoding: 'utf8' });
  if (probe.status !== 0 || !probe.stdout) return false;
  try {
    const list = JSON.parse(probe.stdout);
    return list.some((p) => p && p.name === 'erp-taranom' && p.pm2_env && p.pm2_env.status === 'online');
  } catch (_) { return false; }
}

const dbPath = arg('--db');
const phase = String(arg('--phase', '')).toUpperCase();
const out = arg('--out');
if (!dbPath || !phase || !out) {
  console.error('usage: wh-data-correction.js --db <path> --phase B|C|D [--dry-run|--apply-sandbox|--apply] --out <prefix>');
  process.exit(1);
}
const abs = path.resolve(dbPath);
let mode = 'dry-run';
if (has('--apply')) mode = 'apply';
else if (has('--apply-sandbox')) mode = 'apply-sandbox';

if (mode === 'apply-sandbox' && !isSandbox(abs)) {
  console.error('STOP: --apply-sandbox فقط روی مسیر backups/sandbox-* مجاز است');
  process.exit(2);
}
if (mode === 'apply') {
  if (!has('--expect-max-changes') || !arg('--expect-summary')) {
    console.error('STOP: --apply به --expect-max-changes و --expect-summary نیاز دارد');
    process.exit(2);
  }
  if (productionLocked(abs) && !has('--maintenance-lock')) {
    console.error('STOP: crm.db باز است و pm2 آنلاین است. اول فرایند را متوقف کنید یا --maintenance-lock بدهید');
    process.exit(2);
  }
}

let expectSummary = null;
const summaryPath = arg('--expect-summary');
if (summaryPath) {
  expectSummary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
}
const expectMax = has('--expect-max-changes') ? Number(arg('--expect-max-changes')) : null;
const createdBy = arg('--created-by');
const xwhReport = arg('--xwh-report');

const db = new Database(abs, { fileMustExist: true });
let result;
try {
  result = runCorrection(db, {
    phase,
    mode,
    expectMaxChanges: expectMax,
    expectSummary,
    createdBy: createdBy ? Number(createdBy) : null,
    xwhReport: xwhReport || null,
    runId: arg('--run-id') || undefined,
  });
} catch (e) {
  console.error(e && e.message ? e.message : e);
  try { db.close(); } catch (_) {}
  process.exit(e && e.code === 'WHFIX_STOP' ? 2 : 1);
}

const byTable = {};
for (const c of result.changes) byTable[c.tbl] = (byTable[c.tbl] || 0) + 1;
writeCsv(out + '-diff-before-after.csv', ['table', 'row_key', 'column', 'old', 'new', 'reason', 'rule'], result.changes.map((c) => ({
  table: c.tbl, row_key: c.row_key, column: c.col, old: c.old_value, new: c.new_value, reason: c.reason, rule: c.rule,
})));
writeCsv(out + '-ambiguous.csv', ['rule', 'product_id', 'warehouse_id', 'row_key', 'detail'], result.ambiguous);
writeCsv(out + '-negative-after.csv', ['product_id', 'warehouse_id', 'qty', 'detail'], result.negativeAfter);
writeCsv(out + '-voucher-drafts.csv', ['id', 'rule', 'ref', 'date', 'amount_rial', 'description'], result.drafts);
writeCsv(out + '-revaluation-proposal.csv', [
  'product_id', 'product_code', 'warehouse_id', 'qty', 'ledger_value_rial', 'average_cost_rial',
  'proposed_value_rial', 'diff_rial', 'suggested_accounts',
], result.revaluation);
fs.writeFileSync(out + '-pending-phase-c.txt', result.pendingPhaseC.join('\n') + (result.pendingPhaseC.length ? '\n' : ''), 'utf8');

const summaryLines = [
  `phase=${result.phase}`,
  `mode=${mode}`,
  `run_id=${result.runId}`,
  `changes=${result.changes.length}`,
  `ambiguous=${result.ambiguous.length}`,
  `drafts=${result.drafts.length}`,
  `revaluation=${result.revaluation.length}`,
  `pending_phase_c=${result.pendingPhaseC.length}`,
  'by_table=' + Object.entries(byTable).map(([k, v]) => `${k}:${v}`).join(',') ,
  result.xwhNote || '',
  '',
  'summary_before',
  ...Object.keys(result.summaryBefore).sort().map((k) => `${k}=${result.summaryBefore[k]}`),
  '',
  'summary_after',
  ...Object.keys(result.summaryAfter).sort().map((k) => `${k}=${result.summaryAfter[k]}`),
  '',
  result.syncAssessment,
  '',
];
fs.writeFileSync(out + '-summary.txt', summaryLines.join('\n'), 'utf8');
console.log(`WHFIX phase=${result.phase} mode=${mode} changes=${result.changes.length} ambiguous=${result.ambiguous.length} drafts=${result.drafts.length}`);
db.close();
