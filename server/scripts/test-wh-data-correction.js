'use strict';
/**
 * اصلاح دادهٔ انبار — dry-run، idempotency، برگشت opening، بدون حذف کاردکس و بدون دست‌زدن به سند.
 * node server/scripts/test-wh-data-correction.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : extra); }
}

const stamp = Date.now();
const sandbox = path.join(os.tmpdir(), 'backups', 'sandbox-whfix-' + stamp);
const rollbackDir = path.join(os.tmpdir(), 'backups', 'sandbox-whfix-rb-' + stamp);
fs.mkdirSync(sandbox, { recursive: true });
fs.mkdirSync(rollbackDir, { recursive: true });
const dbPath = path.join(sandbox, 'crm.db');
const outDir = path.join(sandbox, 'out');
fs.mkdirSync(outDir, { recursive: true });

process.env.DB_PATH = dbPath;
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'whfix-test-secret-32chars-minimum!!';
process.env.AUTH_SESSION_DB_PATH = path.join(sandbox, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

function insert(table, obj) {
  const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  const keys = Object.keys(obj).filter((k) => cols.has(k));
  return db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => obj[k])).lastInsertRowid;
}

const svc = insert('users', { name: 'فنی', username: 'whfix', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
insert('users', { name: 'حامد رشید', username: 'hamed', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
const cust = insert('customers', { user_id: svc, biz: 'مشتری تست', status: 'active' });
const wh = insert('warehouses', { name: 'انبار تست', code: 'WHFIX', active: 1, allow_negative: 1, warehouse_type: 'finished_goods' });
insert('fiscal_years', { label: 'سال تست', start_date: '1400/01/01', end_date: '1410/12/29', status: 'open' });

function ensureAccount(code, name, parent) {
  const row = db.prepare('SELECT code FROM chart_of_accounts WHERE code=?').get(code);
  if (row) return;
  insert('chart_of_accounts', { code, name, type: 'asset', parent_code: parent || null, is_active: 1, level: parent ? 3 : 1 });
}
ensureAccount('110401', 'موجودی تست', '1104');
ensureAccount('510101', 'بهای تست', '5101');
ensureAccount('310201', 'تراز افتتاحیه تست', '3102');
for (const [k, v] of [['coa_inventory', '110401'], ['coa_finished_goods', '110401'], ['coa_cogs', '510101'], ['coa_opening_balance', '310201']]) {
  db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, v);
}

const pExact = insert('products', { user_id: svc, name: 'کالای تکراری', code: 'EXACT', price: 1000, stock: 4, average_cost_rial: 1000, unit: 'عدد', warehouse_id: wh });
const pAmb = insert('products', { user_id: svc, name: 'کالای مبهم', code: 'AMB', price: 1000, stock: 6, average_cost_rial: 6700000, unit: 'عدد', warehouse_id: wh });
const pDrift = insert('products', { user_id: svc, name: 'کالای اختلاف', code: 'DRIFT', price: 1000, stock: 9, average_cost_rial: 1000, unit: 'عدد', warehouse_id: wh });
const pRet = insert('products', { user_id: svc, name: 'کالای برگشت', code: 'RET', price: 1000, stock: 0, average_cost_rial: 1000, unit: 'عدد', warehouse_id: wh });
const vExact = insert('product_variants', { product_id: pExact, stock: 4, active: 1, is_default: 1, sku: 'EXACT-1' });
insert('warehouse_stock', { product_id: pExact, warehouse_id: wh, qty: 4 });
insert('warehouse_stock', { product_id: pAmb, warehouse_id: wh, qty: 6 });
insert('warehouse_stock', { product_id: pDrift, warehouse_id: wh, qty: 9 });
const whNeg = insert('warehouses', { name: 'انبار بدون منفی', code: 'WHFIX-N', active: 1, allow_negative: 0, warehouse_type: 'finished_goods' });
const pNeg = insert('products', { user_id: svc, name: 'کالای منفی', code: 'NEG', price: 1000, stock: 4, average_cost_rial: 1000, unit: 'عدد', warehouse_id: whNeg });
insert('warehouse_stock', { product_id: pNeg, warehouse_id: whNeg, qty: 4 });
insert('variant_warehouse_stock', { variant_id: vExact, warehouse_id: wh, qty: 4 });

let tx = 1;
function led(obj) {
  tx += 1;
  return insert('inventory_ledger', Object.assign({
    tx_no: 'WHFIX-' + tx, qty_out: 0, qty_balance: 0, avg_cost_after_rial: 1000,
    status: 'posted', date: '1405/06/31', note: '',
  }, obj));
}
const jeOpen = insert('journal_entries', {
  entry_date: '1405/06/31', description: 'افتتاحیه تست', ref_type: 'opening_inventory', ref_id: pExact, created_by: svc, status: 'approved',
});
insert('journal_lines', { entry_id: jeOpen, account_code: '110401', account_name: 'موجودی', debit: 200, credit: 0, debit_rial: 2000, credit_rial: 0 });
insert('journal_lines', { entry_id: jeOpen, account_code: '310201', account_name: 'تراز', debit: 0, credit: 200, debit_rial: 0, credit_rial: 2000 });

const openA = led({ event_type: 'opening', product_id: pExact, warehouse_id: wh, qty_in: 2, unit_cost_rial: 1000, amount_rial: 2000, source_type: 'opening_inventory', je_id: jeOpen });
const openB = led({ event_type: 'opening', product_id: pExact, warehouse_id: wh, qty_in: 2, unit_cost_rial: 1000, amount_rial: 2000, source_type: 'opening_inventory', je_id: jeOpen });
led({ event_type: 'opening', product_id: pAmb, warehouse_id: wh, qty_in: 1, unit_cost_rial: 6700000, amount_rial: 6700000, source_type: 'opening_inventory', je_id: jeOpen });
led({ event_type: 'opening', product_id: pAmb, warehouse_id: wh, qty_in: 5, unit_cost_rial: 6700000, amount_rial: 33500000, source_type: 'opening_inventory', je_id: jeOpen });
led({ event_type: 'receipt', product_id: pDrift, warehouse_id: wh, qty_in: 3, unit_cost_rial: 1000, amount_rial: 3000, source_type: 'wh_receipt' });
led({ event_type: 'issue', product_id: pNeg, warehouse_id: whNeg, qty_in: 0, qty_out: 2, unit_cost_rial: 1000, amount_rial: 2000, source_type: 'wh_issue' });

const inv = insert('invoices', {
  user_id: svc, cust_id: cust, num: 'T-0099', type: 'final', date: '1405/07/19', rows: '[]', final: 1000, warehouse_id: wh, stock_deducted: 1,
});
const jeCogs = insert('journal_entries', {
  entry_date: '1405/07/19', description: 'بهای تست', ref_type: 'invoice_cogs', ref_id: inv, created_by: svc, status: 'approved',
});
insert('journal_lines', { entry_id: jeCogs, account_code: '510101', account_name: 'بهای تمام‌شده', debit: 2000, credit: 0, debit_rial: 20000, credit_rial: 0 });
insert('journal_lines', { entry_id: jeCogs, account_code: '110401', account_name: 'موجودی', debit: 0, credit: 2000, debit_rial: 0, credit_rial: 20000 });
led({ event_type: 'sale', product_id: pDrift, warehouse_id: wh, qty_in: 0, qty_out: 1, unit_cost_rial: 50000, amount_rial: 50000, source_type: 'invoice', source_id: inv });

const sr = insert('sales_returns', {
  user_id: svc, cust_id: cust, invoice_id: inv, date: '1405/07/20', amount: 0,
  rows: JSON.stringify([{ product_id: pRet, qty: 5, warehouse_id: wh }]),
});
const retLed = led({ event_type: 'sale_return', product_id: pRet, warehouse_id: null, qty_in: 5, unit_cost_rial: 1000, amount_rial: 5000, source_type: 'sales_return', source_id: sr });
insert('warehouse_moves', { type: 'transfer', product_id: pExact, from_warehouse_id: wh, to_warehouse_id: wh, qty: 1, date: '1405/07/01', variant_id: null });

const jeCount = db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c;
const jlCount = db.prepare('SELECT COUNT(*) c FROM journal_lines').get().c;
const ledgerIds = new Set(db.prepare('SELECT id FROM inventory_ledger').all().map((r) => r.id));
const tombs = db.prepare("SELECT COUNT(*) c FROM sync_tombstones WHERE tbl='inventory_ledger'").get().c;
db.pragma('journal_mode = DELETE');
db.close();

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function run(script, args) {
  return spawnSync(process.execPath, [path.join(__dirname, script), ...args], { encoding: 'utf8' });
}
function summaryChanges(prefix) {
  const text = fs.readFileSync(prefix + '-summary.txt', 'utf8');
  const m = text.match(/^changes=(\d+)/m);
  return m ? Number(m[1]) : -1;
}

console.log('\n══ wh data correction ══\n');

const hashBefore = sha(dbPath);
const dry = run('wh-data-correction.js', ['--db', dbPath, '--phase', 'B', '--dry-run', '--out', path.join(outDir, 'dry-b')]);
ok(dry.status === 0, 'dry-run exits 0', dry.stderr || dry.stdout);
ok(sha(dbPath) === hashBefore, 'dry-run sha256 unchanged');
ok(summaryChanges(path.join(outDir, 'dry-b')) > 0, 'dry-run still reports the planned changes', summaryChanges(path.join(outDir, 'dry-b')));

const report = run('inv-reconcile-report.js', ['--db', dbPath, '--readonly', '--out', path.join(outDir, 'before')]);
const tc = (report.stdout || '').match(/total_changes (\d+) (\d+)/);
ok(report.status === 0 && tc && tc[1] === tc[2], 'readonly report total_changes stable', report.stdout + report.stderr);

fs.copyFileSync(dbPath, path.join(rollbackDir, 'crm.db'));
const rb = run('wh-data-correction.js', ['--db', path.join(rollbackDir, 'crm.db'), '--phase', 'B', '--apply-sandbox', '--expect-max-changes', '0', '--out', path.join(outDir, 'rb')]);
ok(rb.status === 2, 'mid-run threshold rolls back', rb.stderr || rb.stdout);
const Database = require('better-sqlite3');
const rbDb = new Database(path.join(rollbackDir, 'crm.db'), { readonly: true });
ok(rbDb.prepare('SELECT COUNT(*) c FROM inventory_ledger').get().c === ledgerIds.size, 'rolled-back ledger count unchanged');
ok(!rbDb.prepare("SELECT 1 FROM sqlite_master WHERE name='wh_data_corrections' AND type='table'").get()
  || rbDb.prepare('SELECT COUNT(*) c FROM wh_data_corrections').get().c === 0, 'rolled-back correction log empty');
rbDb.close();

const applyB = run('wh-data-correction.js', ['--db', dbPath, '--phase', 'B', '--apply-sandbox', '--out', path.join(outDir, 'b')]);
ok(applyB.status === 0, 'apply sandbox B', applyB.stderr || applyB.stdout);
const live = new Database(dbPath);
const opens = live.prepare(`
  SELECT id, status FROM inventory_ledger
  WHERE product_id=? AND (event_type='opening' OR source_type='opening_inventory')
`).all(pExact);
const postedExact = opens.filter((r) => r.status === 'posted');
ok(postedExact.length === 1 && postedExact[0].id === Math.min(openA, openB), 'exact duplicate opening neutralized, smallest id kept', JSON.stringify(opens));
ok(live.prepare("SELECT COUNT(*) c FROM inventory_ledger WHERE event_type='reversal' AND source_type='wh_data_correction'").get().c === 1, 'one reversal row, no delete');
const ambOpens = live.prepare("SELECT id, status FROM inventory_ledger WHERE product_id=? AND status='posted'").all(pAmb);
ok(ambOpens.length === 2, 'non-identical openings untouched', JSON.stringify(ambOpens));
const ambCsv = fs.readFileSync(path.join(outDir, 'b-ambiguous.csv'), 'utf8');
ok(ambCsv.includes('dup_opening_nonidentical'), 'non-identical opening listed');
ok(live.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(pDrift, wh).qty === 2, 'ws rebuilt from kardex (3 in − 1 out)');
ok(live.prepare('SELECT stock FROM products WHERE id=?').get(pDrift).stock === 2, 'header rebuilt from ws');
ok(live.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(pNeg, whNeg).qty === 4, 'negative kardex on a no-negative warehouse is left untouched');
ok(ambCsv.includes('ws_negative_blocked'), 'blocked negative is listed, not forced');
ok(live.prepare('SELECT warehouse_id FROM inventory_ledger WHERE id=?').get(retLed).warehouse_id == null, 'phase B does not fill null warehouse');
const idsAfter = new Set(live.prepare('SELECT id FROM inventory_ledger').all().map((r) => r.id));
ok([...ledgerIds].every((id) => idsAfter.has(id)), 'no ledger id deleted');
ok(live.prepare("SELECT COUNT(*) c FROM sync_tombstones WHERE tbl='inventory_ledger'").get().c === tombs, 'ledger tombstones unchanged');
ok(live.prepare('SELECT COUNT(*) c FROM journal_entries').get().c === jeCount, 'journal_entries untouched');
ok(live.prepare('SELECT COUNT(*) c FROM journal_lines').get().c === jlCount, 'journal_lines untouched');
ok(live.prepare('SELECT average_cost_rial FROM products WHERE id=?').get(pExact).average_cost_rial === 1000, 'average cost unchanged');
live.close();

const again = run('wh-data-correction.js', ['--db', dbPath, '--phase', 'B', '--apply-sandbox', '--out', path.join(outDir, 'b2')]);
ok(again.status === 0, 'second B apply exits 0', again.stderr || again.stdout);
ok(summaryChanges(path.join(outDir, 'b2')) === 0, 'second B apply changes nothing', summaryChanges(path.join(outDir, 'b2')));

const applyC = run('wh-data-correction.js', ['--db', dbPath, '--phase', 'C', '--apply-sandbox', '--out', path.join(outDir, 'c')]);
ok(applyC.status === 0, 'apply sandbox C', applyC.stderr || applyC.stdout);
const afterC = new Database(dbPath);
ok(afterC.prepare('SELECT warehouse_id FROM inventory_ledger WHERE id=?').get(retLed).warehouse_id === wh, 'return ledger warehouse filled from the return document');
ok(afterC.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(pRet, wh).qty === 5, 'phase B rerun after C rebuilds that product');
const moveVar = afterC.prepare('SELECT variant_id FROM warehouse_moves WHERE product_id=?').get(pExact).variant_id;
ok(moveVar === vExact, 'single-variant transfer got the default variant', moveVar);
ok(afterC.prepare('SELECT COUNT(*) c FROM journal_entries').get().c === jeCount, 'phase C leaves journals untouched');
afterC.close();
const againC = run('wh-data-correction.js', ['--db', dbPath, '--phase', 'C', '--apply-sandbox', '--out', path.join(outDir, 'c2')]);
ok(againC.status === 0 && summaryChanges(path.join(outDir, 'c2')) === 0, 'second C apply changes nothing', againC.stdout + againC.stderr);

const applyD = run('wh-data-correction.js', ['--db', dbPath, '--phase', 'D', '--apply-sandbox', '--created-by', String(svc), '--out', path.join(outDir, 'd')]);
ok(applyD.status === 0, 'apply sandbox D', applyD.stderr || applyD.stdout);
const afterD = new Database(dbPath);
const drafts = afterD.prepare('SELECT * FROM voucher_drafts').all();
ok(drafts.length >= 2, 'COGS and opening drafts created', drafts.length);
ok(drafts.every((d) => d.created_by === svc), 'drafts belong to the technical user, not Hamed');
ok(drafts.some((d) => String(d.description).includes('cogs_vs_kardex') && String(d.description).includes('T-0099')), 'COGS draft references the invoice');
ok(drafts.some((d) => String(d.description).includes('opening_reversal')), 'opening reversal draft exists');
ok(afterD.prepare('SELECT COUNT(*) c FROM journal_entries').get().c === jeCount, 'phase D does not post journals');
const reval = fs.readFileSync(path.join(outDir, 'd-revaluation-proposal.csv'), 'utf8');
ok(reval.includes('product_id'), 'revaluation proposal file written');
afterD.close();
const againD = run('wh-data-correction.js', ['--db', dbPath, '--phase', 'D', '--apply-sandbox', '--created-by', String(svc), '--out', path.join(outDir, 'd2')]);
ok(againD.status === 0 && summaryChanges(path.join(outDir, 'd2')) === 0, 'second D apply creates no draft', againD.stdout + againD.stderr);

const outside = path.join(os.tmpdir(), 'not-a-sandbox-' + stamp + '.db');
fs.copyFileSync(dbPath, outside);
const denied = run('wh-data-correction.js', ['--db', outside, '--phase', 'B', '--apply-sandbox', '--out', path.join(outDir, 'denied')]);
ok(denied.status === 2, 'apply-sandbox refuses a path outside backups/sandbox-', denied.stderr || denied.stdout);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
