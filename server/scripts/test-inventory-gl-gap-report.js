#!/usr/bin/env node
'use strict';
/**
 * Phase 4 — inventory GL ↔ kardex gap report (readonly).
 * Fixture: zero-value transfer_in, NULL warehouse row, adjust without JE.
 * Expect: residual 0 + correct cause amounts; report does no writes.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const {
  buildInventoryGlGapReport,
  reportToMarkdown,
} = require('../lib/inventory-gl-gap-report');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : JSON.stringify(extra)); }
}

console.log('\n══ inventory-gl-gap-report (phase 4 readonly) ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-gl-gap-'));
const dbPath = path.join(dir, 'gap.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE journal_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_date TEXT, description TEXT, ref_type TEXT, ref_id INTEGER,
    created_by INTEGER, status TEXT DEFAULT 'approved', deleted_at INTEGER DEFAULT 0
  );
  CREATE TABLE journal_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER, account_code TEXT, account_name TEXT,
    debit REAL, credit REAL, debit_rial INTEGER, credit_rial INTEGER
  );
  CREATE TABLE inventory_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER, warehouse_id INTEGER,
    qty_in REAL DEFAULT 0, qty_out REAL DEFAULT 0,
    amount_rial INTEGER DEFAULT 0, unit_cost_rial INTEGER DEFAULT 0,
    source_type TEXT, source_id INTEGER, event_type TEXT, je_id INTEGER,
    status TEXT DEFAULT 'posted', date TEXT, note TEXT,
    tx_no TEXT, qty_balance REAL DEFAULT 0, avg_cost_after_rial INTEGER DEFAULT 0,
    reversed_of INTEGER
  );
  CREATE TABLE warehouses (
    id INTEGER PRIMARY KEY, name TEXT, code TEXT, warehouse_type TEXT,
    inventory_coa_code TEXT, inventory_system TEXT DEFAULT 'perpetual', active INTEGER DEFAULT 1
  );
  CREATE TABLE chart_of_accounts (
    code TEXT PRIMARY KEY, name TEXT, type TEXT, parent_code TEXT, level INTEGER, is_active INTEGER DEFAULT 1
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);

  INSERT INTO chart_of_accounts(code,name,type,level) VALUES ('1104','موجودی ساخته‌شده','asset',3);
  INSERT INTO chart_of_accounts(code,name,type,level) VALUES ('3102','تراز افتتاحیه','equity',3);
  INSERT INTO warehouses(id,name,code,warehouse_type,inventory_coa_code) VALUES
    (34,'عمده','W34','finished_goods','1104'),
    (35,'خرده','W35','finished_goods','1104'),
    (36,'دارایی','W36','دارایی_ثابت',NULL);
`);

function addJe(refType, refId, acctDebit, acctCredit, date) {
  const r = db.prepare(`
    INSERT INTO journal_entries(entry_date, description, ref_type, ref_id, created_by, status, deleted_at)
    VALUES (?,?,?,?,1,'approved',0)
  `).run(date || '1405/07/01', 't', refType, refId);
  const id = r.lastInsertRowid;
  db.prepare(`
    INSERT INTO journal_lines(entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial)
    VALUES (?,?,?,?,?,?,?)
  `).run(id, '1104', 'موجودی', acctDebit / 10, acctCredit / 10, acctDebit, acctCredit);
  // balancing line
  db.prepare(`
    INSERT INTO journal_lines(entry_id, account_code, account_name, debit, credit, debit_rial, credit_rial)
    VALUES (?,?,?,?,?,?,?)
  `).run(id, '3102', 'تراز', acctCredit / 10, acctDebit / 10, acctCredit, acctDebit);
  return id;
}

function addKardex(row) {
  const tx = row.tx_no || ('TX' + Math.random().toString(36).slice(2, 8));
  return db.prepare(`
    INSERT INTO inventory_ledger(
      product_id, warehouse_id, qty_in, qty_out, amount_rial, unit_cost_rial,
      source_type, source_id, event_type, je_id, status, date, note, tx_no
    ) VALUES (?,?,?,?,?,?,?,?,?,?, 'posted',?,?,?)
  `).run(
    row.product_id || 1,
    row.warehouse_id,
    row.qty_in || 0,
    row.qty_out || 0,
    row.amount_rial || 0,
    row.unit_cost_rial || 0,
    row.source_type || '',
    row.source_id || null,
    row.event_type || 'adjustment',
    row.je_id == null ? null : row.je_id,
    row.date || '1405/07/10',
    row.note || '',
    tx,
  ).lastInsertRowid;
}

// Opening: GL +1_000_000 linked to kardex wh 34
const jeOpen = addJe('opening_inventory', 1, 1000000, 0, '1405/07/01');
addKardex({
  warehouse_id: 34, qty_in: 10, amount_rial: 1000000,
  source_type: 'opening_inventory', source_id: 1, event_type: 'opening', je_id: jeOpen,
  date: '1405/07/01',
});

// a) zero-value transfer_in (34→35): out 100_000, in 0 — no JE (same account)
addKardex({
  warehouse_id: 34, qty_out: 5, amount_rial: 100000,
  source_type: 'warehouse_transfer', source_id: 101, event_type: 'transfer_out',
  date: '1405/07/15',
});
addKardex({
  warehouse_id: 35, qty_in: 5, amount_rial: 0,
  source_type: 'warehouse_transfer', source_id: 101, event_type: 'transfer_in',
  date: '1405/07/15',
});

// b) NULL warehouse return: GL +50_000, kardex sv +50_000 warehouse_id NULL
const jeRet = addJe('sales_return', 7, 50000, 0, '1405/07/20');
addKardex({
  warehouse_id: null, qty_in: 2, amount_rial: 50000,
  source_type: 'sales_return', source_id: 7, event_type: 'sale_return', je_id: jeRet,
  date: '1405/07/20',
});

// c) adjust without JE: shortage 30_000 in wh 34
addKardex({
  warehouse_id: 34, qty_out: 1, amount_rial: 30000,
  source_type: 'stock_reconcile', source_id: 9, event_type: 'adjustment',
  je_id: null, date: '1405/07/25', note: 'تعدیل بی‌سند',
});

const beforeChanges = db.prepare('SELECT total_changes() c').get().c;
const rep = buildInventoryGlGapReport(db, {
  acct: '1104',
  warehouses: [34, 35],
  cutoff: '1405/08/30',
});
const afterChanges = db.prepare('SELECT total_changes() c').get().c;

ok(beforeChanges === afterChanges, 'buildInventoryGlGapReport does not write (total_changes)', {
  before: beforeChanges, after: afterChanges,
});

ok(rep.summary.gl_rial === 1050000, 'GL = opening 1M + return 50k', rep.summary.gl_rial);
// kardex mapped: +1M -100k (transfer out) +0 (transfer in) -30k (adjust) = 870k
ok(rep.summary.kardex_mapped_rial === 870000, 'kardex mapped = 870000', rep.summary.kardex_mapped_rial);
ok(rep.summary.gap_rial === 180000, 'gap GL−kardex = 180000', rep.summary.gap_rial);

ok(rep.causes.a_transfer_leakage.amount_rial === 100000, 'cause a transfer leak = 100000', rep.causes.a_transfer_leakage);
ok(rep.causes.a_transfer_leakage.count === 1, 'cause a count = 1', rep.causes.a_transfer_leakage.count);

ok(rep.causes.b_null_warehouse.amount_rial === 50000, 'cause b NULL wh = 50000', rep.causes.b_null_warehouse);
ok(rep.causes.b_null_warehouse.count === 1, 'cause b count = 1');

ok(rep.causes.c_kardex_without_je.amount_rial === 30000, 'cause c no-je = 30000 (−sv of shortage)', rep.causes.c_kardex_without_je);
ok(rep.causes.c_kardex_without_je.count >= 1, 'cause c has rows');

ok(rep.summary.residual_rial === 0, 'residual g = 0', {
  residual: rep.summary.residual_rial,
  causes: {
    a: rep.causes.a_transfer_leakage.amount_rial,
    b: rep.causes.b_null_warehouse.amount_rial,
    c: rep.causes.c_kardex_without_je.amount_rial,
    d: rep.causes.d_offset_neutralised.amount_rial,
    e: rep.causes.e_gl_without_kardex_source.amount_rial,
    f: rep.causes.f_other_wh_fallback.amount_rial,
  },
  summary: rep.summary,
});

ok(!('suggested_vouchers' in rep) && !rep.voucher_suggestions, 'no automatic voucher suggestions');

const md = reportToMarkdown(rep, { db: dbPath });
ok(/فقط‌خواندنی/.test(md) && /هیچ پیشنهاد سند/.test(md), 'markdown marks readonly / no JE suggestions');

// Script opens DB readonly and does not write
db.close();
const outPrefix = path.join(dir, 'out-gap');
const script = path.join(__dirname, 'report-inventory-gl-gap.js');
const run = spawnSync(process.execPath, [
  script,
  `--db=${dbPath}`,
  '--acct', '1104',
  '--warehouses', '34,35',
  '--cutoff', '1405/08/30',
  `--out=${outPrefix}`,
], { encoding: 'utf8' });
ok(run.status === 0, 'CLI script exits 0', { status: run.status, stderr: run.stderr, stdout: run.stdout });
ok(fs.existsSync(outPrefix + '.json') && fs.existsSync(outPrefix + '.md'), 'CLI writes json+md');
ok(/readonly:\s*true/.test(fs.readFileSync(script, 'utf8')), 'script opens DB with readonly:true');

const ro = new Database(dbPath, { readonly: true, fileMustExist: true });
const tc1 = ro.prepare('SELECT total_changes() c').get().c;
const rep2 = buildInventoryGlGapReport(ro, { acct: '1104', warehouses: '34,35', cutoff: '1405/08/30' });
const tc2 = ro.prepare('SELECT total_changes() c').get().c;
ro.close();
ok(tc1 === tc2, 'readonly DB total_changes unchanged after report', { tc1, tc2 });
ok(rep2.summary.residual_rial === 0, 'readonly reopen residual still 0');

const parsed = JSON.parse(fs.readFileSync(outPrefix + '.json', 'utf8'));
ok(parsed.summary.residual_rial === 0, 'CLI JSON residual 0');
ok(parsed.causes.a_transfer_leakage.amount_rial === 100000, 'CLI JSON cause a');
ok(parsed.causes.b_null_warehouse.amount_rial === 50000, 'CLI JSON cause b');
ok(parsed.causes.c_kardex_without_je.amount_rial === 30000, 'CLI JSON cause c');

console.log(`\n══ result: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail ? 1 : 0);
