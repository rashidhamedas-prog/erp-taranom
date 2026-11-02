#!/usr/bin/env node
'use strict';
/**
 * مهاجرت یک‌بارهٔ موجودی اول دوره: ردیف‌های افتتاحیهٔ زندهٔ کاردکس → product_opening_stock.
 *
 *   node scripts/product-opening-stock-migrate.js --db <path> --dry-run [--out report.json]
 *   node scripts/product-opening-stock-migrate.js --db <path> --apply [--out report.json] [--i-have-approval]
 *
 * --dry-run: همه‌چیز در یک تراکنش اجرا و rollback می‌شود (اگر جدول نباشد همان‌جا موقتاً ساخته می‌شود).
 * --apply  : روی مسیر زندهٔ تولید (/home/taranom/ یا crm-taranom/) فقط با --i-have-approval.
 * هرگز inventory_ledger / journal_* را تغییر نمی‌دهد (تعداد و جمع‌ها قبل/بعد مقایسه می‌شوند).
 */
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const a = { db: null, dryRun: null, apply: false, out: null, approval: false };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--db') a.db = argv[++i];
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--apply') a.apply = true;
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--i-have-approval') a.approval = true;
    else if (k === '-h' || k === '--help') a.help = true;
  }
  return a;
}

function usage(code) {
  console.log('usage: node scripts/product-opening-stock-migrate.js --db <path> --dry-run|--apply [--out report.json] [--i-have-approval]');
  process.exit(code);
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) usage(0);
  if (!a.db) usage(2);
  if (a.apply && a.dryRun) { console.error('either --dry-run or --apply, not both'); process.exit(2); }
  if (!a.apply && !a.dryRun) { console.error('choose --dry-run or --apply'); process.exit(2); }
  const dbPath = path.resolve(a.db);
  const live = /\/home\/taranom\/|crm-taranom\//.test(String(a.db).replace(/\\/g, '/') + '/')
    || /\/home\/taranom\/|crm-taranom\//.test(dbPath.replace(/\\/g, '/') + '/');
  if (a.apply && live && !a.approval) {
    console.error('refusing --apply on a live production path without --i-have-approval:', dbPath);
    process.exit(3);
  }
  if (!fs.existsSync(dbPath)) { console.error('DB not found:', dbPath); process.exit(2); }

  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 10000');
  const POS = require('../lib/inventory/product-opening-stock');
  let rep;
  try {
    rep = POS.migrateProductOpeningStock(db, { dryRun: !a.apply, userId: null, ensureTable: !a.apply });
  } finally {
    try { db.close(); } catch (_) { /* */ }
  }
  const summary = {
    db: dbPath,
    dry_run: rep.dry_run,
    fiscal_year_id: rep.fiscal_year_id,
    combos_total: rep.combos_total,
    created: rep.created,
    skipped_existing: rep.skipped_existing,
    totals: rep.totals,
    ledger_count: [rep.ledger_count_before, rep.ledger_count_after],
    je_count: [rep.je_count_before, rep.je_count_after],
  };
  console.log(JSON.stringify(summary, null, 2));
  if (a.out) {
    fs.writeFileSync(path.resolve(a.out), JSON.stringify(rep, null, 2));
    console.log('full report →', path.resolve(a.out));
  }
}

main();
