'use strict';
/**
 * P3 — اصلاح دادهٔ «تطبیق موجودی» (gated؛ فقط پیش‌نویس).
 *
 *   node server/scripts/inventory-recon-fix.js --mode=report  --db <path> [--out <prefix>]
 *   node server/scripts/inventory-recon-fix.js --mode=dry-run --db <path> [--out <prefix>]
 *   node server/scripts/inventory-recon-fix.js --mode=apply   --db <path> [--out <prefix>] [--created-by <userId>]
 *
 * report: فقط‌خواندنی (DB با readonly باز می‌شود و total_changes() قبل=بعد چک می‌شود).
 * dry-run: همان apply داخل تراکنش و سپس rollback.
 * apply: فقط پیش‌نویس voucher_drafts می‌سازد (هیچ post/DELETE)، همه در یک تراکنش.
 *        روی مسیر DB زندهٔ production رد می‌شود مگر با --i-have-p3-approval.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { computeLayerReconcile } = require('../lib/inventory/layer-reconcile');
const P3 = require('../lib/inventory/p3-recon-drafts');

function arg(name) {
  const eq = process.argv.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  return v == null || v.startsWith('--') ? null : v;
}
function has(name) { return process.argv.includes(name); }

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeCsv(file, headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

function isLiveProductionPath(abs) {
  const norm = abs.replace(/\\/g, '/').toLowerCase();
  if (norm.includes('/home/taranom/')) return true;
  if (norm.includes('/crm-taranom/')) return true;
  if (norm.endsWith('/server/crm.db')) return true;
  if (norm.includes('/data/companies/')) return true;
  const envDb = process.env.DB_PATH ? path.resolve(process.env.DB_PATH).replace(/\\/g, '/').toLowerCase() : '';
  return !!envDb && envDb === norm;
}

const ACTIONS = [
  ['ws_vs_ledger', 'warehouse≠kardex', 'بازسازی کش انبار از کاردکس (لایهٔ مشتق)'],
  ['ws_vs_vws', 'warehouse≠color/size', 'بازسازی کش واریانت از کاردکس؛ ماتریسی بی‌واریانت → شمارش'],
  ['ws_negative', 'منفی', 'بدون تعدیل — برگهٔ شمارش با system_qty کاردکس'],
  ['zero_qty_nonzero_value', 'qty صفر با ارزش', 'پیش‌نویس revaluation value-only (revaluation.js) پس از تأیید حسابدار'],
  ['duplicate_opening', 'opening تکراری', 'خنثی‌سازی با reversal (نگه‌داشتن کوچک‌ترین id)؛ اگر je داشت پیش‌نویس برگشت'],
];

function categorize(rec) {
  const rows = [];
  for (const r of rec.rows || []) {
    for (const [flag, cat, action] of ACTIONS) {
      if (r.flags && r.flags[flag]) {
        rows.push({
          category: cat, product_id: r.product_id, product_code: r.product_code, warehouse_id: r.warehouse_id,
          ws_qty: r.ws_qty, ledger_qty: r.ledger_qty, ledger_value_rial: r.ledger_value_rial, action,
        });
      }
    }
  }
  const ex = rec.exceptions || {};
  for (const x of ex.ledger_without_warehouse || []) {
    rows.push({ category: 'کاردکس بدون انبار', product_id: x.product_id, product_code: x.product_code || null, warehouse_id: null,
      ws_qty: null, ledger_qty: x.qty != null ? x.qty : null, ledger_value_rial: x.value_rial != null ? x.value_rial : null,
      action: 'پر کردن warehouse_id فقط اگر سند مبدأ انبار یکتا دارد؛ وگرنه فهرست تصمیم' });
  }
  for (const x of ex.default_variant_with_stock || []) {
    rows.push({ category: 'واریانت پیش‌فرض با موجودی', product_id: x.product_id, product_code: x.product_code, warehouse_id: null,
      ws_qty: x.vws_qty, ledger_qty: null, ledger_value_rial: null, action: 'بازسازی کش واریانت از کاردکس؛ ambiguous → شمارش' });
  }
  for (const x of ex.variant_mismatches || []) {
    rows.push({ category: 'variant≠color/size', product_id: x.product_id, product_code: x.product_code || null, warehouse_id: null,
      ws_qty: null, ledger_qty: null, ledger_value_rial: null, action: 'بازسازی کش واریانت از کاردکس' });
  }
  return rows;
}

function buildReport(db) {
  const rec = computeLayerReconcile(db, {});
  return { summary: rec.summary, rows: categorize(rec), p3: P3.buildP3Report(db) };
}

function writeOutputs(out, mode, report, applied) {
  if (!out) return;
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out + '-report.json', JSON.stringify({ mode, ...report, applied: applied || null }, null, 2), 'utf8');
  writeCsv(out + '-rows.csv', ['category', 'product_id', 'product_code', 'warehouse_id', 'ws_qty', 'ledger_qty', 'ledger_value_rial', 'action'], report.rows);
  writeCsv(out + '-drafts.csv', ['key', 'amount_rial', 'guard_ok', 'guard_reason', 'effect_1104_rial', 'description'], report.p3.plan);
  writeCsv(out + '-cogs-zero-inbound.csv',
    ['product_id', 'pairs', 'restored_inbound_rial', 'delta_cogs_sales_rial', 'delta_other_out_rial', 'remaining_in_stock_rial'],
    report.p3.cogs_zero_inbound.products);
}

function printSummary(mode, report, applied) {
  const p = report.p3;
  console.log(`P3 mode=${mode} rows=${report.rows.length} gl1104=${p.gl_1104_live_rial} gl1104_if_posted=${p.gl_1104_if_all_drafts_posted_rial}`);
  for (const s of p.plan) {
    console.log(`  draft ${s.key} amount=${s.amount_rial} guard=${s.guard_ok ? 'OK' : 'SKIP: ' + s.guard_reason}${s.already_created ? ' (already #' + s.already_created.draft_id + ')' : ''}`);
  }
  const c = p.cogs_zero_inbound;
  console.log(`  cogs_zero_inbound wh${c.warehouse_id}: pairs=${c.pairs} delta_cogs_sales=${c.totals.delta_cogs_sales_rial || 0} (report only)`);
  if (applied) console.log(`  created=${applied.created.length} skipped=${applied.skipped.length} already=${applied.already.length} warnings=${applied.warnings.length}`);
}

class DryRollback extends Error {}

function main() {
  const mode = String(arg('--mode') || '').toLowerCase();
  const dbPath = arg('--db');
  const out = arg('--out');
  if (!['report', 'dry-run', 'apply'].includes(mode) || !dbPath) {
    console.error('usage: inventory-recon-fix.js --mode=report|dry-run|apply --db <path> [--out <prefix>]');
    process.exit(1);
  }
  const abs = path.resolve(dbPath);
  if (!fs.existsSync(abs)) { console.error('STOP: فایل DB پیدا نشد'); process.exit(2); }

  if (mode === 'report') {
    const db = new Database(abs, { readonly: true, fileMustExist: true });
    const before = db.prepare('SELECT total_changes() c').get().c;
    const report = buildReport(db);
    const after = db.prepare('SELECT total_changes() c').get().c;
    db.close();
    if (before !== after) { console.error(`STOP: report نوشتن انجام داد (${before}→${after})`); process.exit(2); }
    writeOutputs(out, mode, report, null);
    printSummary(mode, report, null);
    return;
  }

  if (mode === 'apply' && isLiveProductionPath(abs) && !has('--i-have-p3-approval')) {
    console.error('STOP: apply روی DB زندهٔ production بدون --i-have-p3-approval ممنوع است (gate P3: تأیید حامد)');
    process.exit(2);
  }
  const db = new Database(abs, { fileMustExist: true });
  let applied = null;
  let report = null;
  const createdBy = arg('--created-by');
  try {
    db.transaction(() => {
      applied = P3.createP3Drafts(db, { createdBy: createdBy ? Number(createdBy) : null });
      report = buildReport(db);
      if (mode === 'dry-run') throw new DryRollback();
    }).immediate();
  } catch (e) {
    if (!(e instanceof DryRollback)) {
      console.error(e && e.message ? e.message : e);
      db.close();
      process.exit(e && e.code === 'WHFIX_STOP' ? 2 : 1);
    }
  }
  db.close();
  writeOutputs(out, mode, report, applied);
  printSummary(mode, report, applied);
}

if (require.main === module) main();

module.exports = { isLiveProductionPath, categorize };
