'use strict';

/**
 * گزارش فقط‌خواندنی v428 برای دو مجموعهٔ تاریخی عملیات نقد.
 * بدون --dry-run اجرا نمی‌شود.
 * بدون DB_PATH یا --db هیچ فایلی باز نمی‌شود و مسیر پیش‌فرض ندارد.
 * فقط SELECT. هیچ ردیفی نوشته یا اصلاح نمی‌شود.
 *
 * بخش ۱ — expense_payments با purchase_invoice_id پر و status غیر از reversed.
 *   ستون‌ها: id, amount, purchase_invoice_id, account_code. شمارش همین مجموعه.
 *   این مجموعهٔ دوبل‌شماری تاریخی است. settled_amount دست نخورده می‌ماند.
 *
 * بخش ۲ — journal_entries با ref_type=manual_voucher یا doc_type خالی/manual
 *   که شرح سند عبارت «پرداخت به شخص» را ندارد، ولی در person_ledger
 *   برای همان سند بدهکار (debit) وجود دارد.
 *   شمارش به‌علاوهٔ id و ۸۰ نویسهٔ اول شرح. این‌ها نباید خودکار تبدیل شوند.
 */

function fail(message, code) {
  console.error(message);
  process.exit(code);
}

function explicitDbPath(argv) {
  const envPath = String(process.env.DB_PATH || '').trim();
  const args = argv.slice(2);
  let fromArg = '';
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--db' || arg === '--database' || arg === 'db') {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) fromArg = String(next).trim();
      break;
    }
    if (arg.startsWith('--db=')) {
      fromArg = arg.slice('--db='.length).trim();
      break;
    }
    if (arg.startsWith('--database=')) {
      fromArg = arg.slice('--database='.length).trim();
      break;
    }
    if (arg.startsWith('db=')) {
      fromArg = arg.slice('db='.length).trim();
      break;
    }
  }
  return fromArg || envPath;
}

const dbPath = explicitDbPath(process.argv);
if (!dbPath) {
  fail('Needs an explicit sqlite path (DB_PATH or --db). This script does not default to a database.', 2);
}

if (!process.argv.includes('--dry-run')) {
  fail('Refusing to run without --dry-run.', 2);
}

let Database;
try {
  Database = require('better-sqlite3');
} catch (_) {
  console.log('SKIP_SQLITE');
  process.exit(0);
}

let db;
try {
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
} catch (err) {
  fail(`Cannot open sqlite read-only: ${err.message}`, 1);
}

function tableExists(name) {
  const row = db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name);
  return !!row;
}

function columnSet(name) {
  return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((col) => col.name));
}

function missingNames(present, needed) {
  return needed.filter((name) => !present.has(name));
}

function sectionExpensePayments() {
  const key = 'expense_payments_historical_double_count';
  if (!tableExists('expense_payments')) {
    return { skipped: true, reason: 'table expense_payments is missing' };
  }
  const cols = columnSet('expense_payments');
  const needed = ['id', 'amount', 'purchase_invoice_id', 'account_code', 'status'];
  const missing = missingNames(cols, needed);
  if (missing.length) {
    return { skipped: true, reason: `column missing on expense_payments: ${missing.join(', ')}` };
  }
  const rows = db.prepare(`
    SELECT id, amount, purchase_invoice_id, account_code
    FROM expense_payments
    WHERE purchase_invoice_id IS NOT NULL
      AND COALESCE(status, 'posted') <> 'reversed'
    ORDER BY id
  `).all();
  return {
    key,
    note: 'historical double-count set; settled_amount left untouched',
    count: rows.length,
    rows,
  };
}

function sectionManualVouchers() {
  if (!tableExists('journal_entries')) {
    return { skipped: true, reason: 'table journal_entries is missing' };
  }
  if (!tableExists('person_ledger')) {
    return { skipped: true, reason: 'table person_ledger is missing' };
  }
  const jeNeed = ['id', 'description', 'ref_type', 'doc_type'];
  const plNeed = ['ref_id', 'ref_type', 'debit'];
  const missing = [
    ...missingNames(columnSet('journal_entries'), jeNeed).map((name) => `journal_entries.${name}`),
    ...missingNames(columnSet('person_ledger'), plNeed).map((name) => `person_ledger.${name}`),
  ];
  if (missing.length) {
    return { skipped: true, reason: `column missing: ${missing.join(', ')}` };
  }
  const rows = db.prepare(`
    SELECT je.id AS id, COALESCE(je.description, '') AS description
    FROM journal_entries je
    WHERE (
      je.ref_type = 'manual_voucher'
      OR je.doc_type IS NULL
      OR TRIM(je.doc_type) = ''
      OR LOWER(je.doc_type) = 'manual'
    )
      AND INSTR(COALESCE(je.description, ''), 'پرداخت به شخص') = 0
      AND EXISTS (
        SELECT 1
        FROM person_ledger pl
        WHERE pl.ref_id = je.id
          AND COALESCE(pl.debit, 0) > 0
          AND (
            pl.ref_type = 'manual_voucher'
            OR pl.ref_type IS NULL
            OR TRIM(pl.ref_type) = ''
          )
      )
    ORDER BY je.id
  `).all();
  return {
    note: 'must NOT be auto-converted',
    count: rows.length,
    rows: rows.map((row) => ({
      id: row.id,
      description_prefix: String(row.description || '').slice(0, 80),
    })),
  };
}

let report;
try {
  report = {
    dry_run: true,
    readonly: true,
    expense_payments_historical_double_count: sectionExpensePayments(),
    manual_vouchers_not_auto_convert: sectionManualVouchers(),
  };
} catch (err) {
  const message = String((err && err.message) || err);
  try { db.close(); } catch (_) { /* already closing */ }
  if (/no such (table|column)/i.test(message)) {
    console.log(JSON.stringify({
      dry_run: true,
      readonly: true,
      skipped: true,
      reason: message,
    }, null, 2));
    process.exit(0);
  }
  fail(message, 1);
}

console.log(JSON.stringify(report, null, 2));
db.close();
