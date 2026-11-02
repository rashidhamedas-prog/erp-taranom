'use strict';
/**
 * موجودی اول دوره جدا از موجودی کل (product_opening_stock).
 * Run: node server/scripts/test-product-opening-stock.js
 *
 * Isolated temp DB; legacy fixtures inserted directly to mimic production (one v528 JE per product shared by
 * duplicate opening rows across two warehouses, opening rows without JE, stock_reconcile offsets).
 * Covers: migration dry-run/real/idempotent, guard 409, RBAC 403, correction (shared JE → counter, dedicated → reverse,
 * GL inventory delta == kardex value delta, trial balance), resolve needs_review (+ paired stock_reconcile),
 * negative → 409 + rollback, reason/confirm 400, duplicates list, sync wiring.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : JSON.stringify(extra)); }
}

console.log('\n══ product_opening_stock — موجودی اول دوره ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-opening-'));
process.env.DB_PATH = path.join(dir, 'pos.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'product-opening-stock-test-secret-at-least-32-chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.PRODUCT_OPENING_STOCK_MIGRATE;

const dbMods = require('../db');
dbMods.initDB();
const db = dbMods.getDB();

async function main() {
  const express = require('express');
  const http = require('http');
  const { issueStaffSession } = require('../lib/auth-sessions');
  const L = require('../lib/inventory/ledger');
  const SE = require('../lib/inventory/shortage-error');
  const POS = require('../lib/inventory/product-opening-stock');
  const capture = require('../sync/capture');
  const { SYNCABLE_TABLES, FK_COLUMNS } = require('../sync/tables');
  const { acct } = require('../lib/coa-map');
  const { postToLedger } = require('../lib/ledger');
  const { fiscalOpeningDate } = require('../lib/opening-post');
  const rbac = require('../lib/rbac');

  const colsCache = new Map();
  const cols = (t) => {
    if (!colsCache.has(t)) colsCache.set(t, new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)));
    return colsCache.get(t);
  };
  function insert(table, obj) {
    const c = cols(table);
    const keys = Object.keys(obj).filter((k) => c.has(k));
    return Number(db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...keys.map((k) => obj[k])).lastInsertRowid);
  }
  const q1 = (sql, ...p) => db.prepare(sql).get(...p);
  const qa = (sql, ...p) => db.prepare(sql).all(...p);
  const n3 = (v) => Math.round(Number(v || 0) * 1000) / 1000;
  const count = (t, where = '1=1', ...p) => q1(`SELECT COUNT(*) AS c FROM ${t} WHERE ${where}`, ...p).c;
  const LIVE_JE = "COALESCE(je.status,'') NOT IN ('reversed','void') AND COALESCE(je.deleted_at,0)=0";
  const jeLive = (id) => !!q1(`SELECT 1 FROM journal_entries je WHERE je.id=? AND ${LIVE_JE}`, id);
  const glNet = (code) => Math.round(q1(`
    SELECT COALESCE(SUM(jl.debit_rial - jl.credit_rial),0) AS v FROM journal_lines jl
    JOIN journal_entries je ON je.id=jl.entry_id WHERE jl.account_code=? AND ${LIVE_JE}`, code).v);
  const trial = () => q1(`
    SELECT COALESCE(SUM(jl.debit_rial),0) AS d, COALESCE(SUM(jl.credit_rial),0) AS c
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE ${LIVE_JE}`);
  const kardexValue = (pid) => Math.round(q1(`
    SELECT COALESCE(SUM(CASE WHEN COALESCE(qty_in,0)>0 THEN amount_rial WHEN COALESCE(qty_out,0)>0 THEN -amount_rial ELSE amount_rial END),0) AS v
    FROM inventory_ledger WHERE product_id=? AND status='posted' AND reversed_of IS NULL
      AND COALESCE(event_type,'')<>'reversal' AND COALESCE(event_type,'') NOT GLOB '*_reversal'`, pid).v);
  const kq = (pid, wh) => POS.kardexCombo(db, pid, wh, null).qty;

  // ── seed ──
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('inventory_allow_negative','0')").run();
  const mkUser = (name, username, role) => insert('users', { name, username, password: 'x', role, active: 1, must_change_password: 0 });
  const adminId = mkUser('مدیر', 'pos_admin', 'admin');
  const acctId = mkUser('حسابدار', 'pos_acct', 'accounting');
  const acct2Id = mkUser('حسابدار ۲', 'pos_acct2', 'accounting');
  const salesId = mkUser('فروشنده', 'pos_sales', 'sales');
  const storeId = mkUser('صندوق', 'pos_store', 'store_retail');
  const W34 = insert('warehouses', { name: 'انبار ۳۴', code: 'W34', active: 1, allow_negative: 0, is_default: 1, warehouse_type: 'finished_goods', inventory_system: 'perpetual' });
  const W35 = insert('warehouses', { name: 'انبار ۳۵', code: 'W35', active: 1, allow_negative: 0, is_default: 0, warehouse_type: 'finished_goods', inventory_system: 'perpetual' });
  let pseq = 0;
  const product = (name) => insert('products', {
    user_id: adminId, name, code: `POS-${++pseq}`, price: 100000, cost: 0, stock: 0, warehouse_id: W34, average_cost_rial: 0, unit: 'عدد',
  });
  const P1 = product('مانتو تکراری');
  const P2x = product('شلوار بدون سند');
  const P3 = product('پیراهن سند اختصاصی');
  const P4 = product('دامن منفی');
  const P5 = product('کالای تازه');

  const openDate = fiscalOpeningDate(db);
  const inv34 = L.inventoryAccountForWarehouse(db, W34);
  const inv35 = L.inventoryAccountForWarehouse(db, W35);
  const opAcct = acct(db, 'coa_opening_balance');
  let txn = 0;
  const led = (o) => insert('inventory_ledger', Object.assign({
    tx_no: `LEG-${++txn}`, qty_in: 0, qty_out: 0, status: 'posted', date: openDate, created_by: adminId, note: 'موجودی اول دوره (قدیمی)',
  }, o));
  const opening = (pid, wh, qty, unit, jeId) => led({
    event_type: 'opening', product_id: pid, warehouse_id: wh, qty_in: qty, unit_cost_rial: unit, amount_rial: qty * unit,
    source_type: 'opening_inventory', source_id: pid, je_id: jeId || null,
  });
  const legacyJe = (refType, pid, lines) => postToLedger(db, {
    sourceType: refType, sourceId: pid, date: openDate, description: `افتتاحیهٔ قدیمی کالا ${pid}`, createdBy: adminId, voucherType: 'opening',
    lines: lines.map((l) => ({ code: l.code, name: l.name, debit: l.debit / 10, credit: l.credit / 10 })),
  });
  const setCache = (pid, wh, qty) => {
    db.prepare('INSERT OR REPLACE INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)').run(pid, wh, qty);
    const tot = q1('SELECT COALESCE(SUM(qty),0) AS q FROM warehouse_stock WHERE product_id=?', pid).q;
    db.prepare('UPDATE products SET stock=?, average_cost_rial=? WHERE id=?').run(tot, 1000, pid);
  };

  // P1: v528 JE shared by L1 (W34), L2 (W34 duplicate), L3 (W35); gap-filler offset ADJ1 on W34.
  const L1 = opening(P1, W34, 10, 1000);
  const L2 = opening(P1, W34, 10, 1000);
  const L3 = opening(P1, W35, 5, 1000);
  const JE_A = legacyJe('opening_inventory_recon_v528', P1, inv34.code === inv35.code
    ? [{ code: inv34.code, name: inv34.name, debit: 25000, credit: 0 }, { code: opAcct.code, name: opAcct.name, debit: 0, credit: 25000 }]
    : [{ code: inv34.code, name: inv34.name, debit: 20000, credit: 0 }, { code: inv35.code, name: inv35.name, debit: 5000, credit: 0 }, { code: opAcct.code, name: opAcct.name, debit: 0, credit: 25000 }]);
  db.prepare('UPDATE inventory_ledger SET je_id=? WHERE id IN (?,?,?)').run(JE_A, L1, L2, L3);
  const ADJ1 = led({ event_type: 'adjustment', product_id: P1, warehouse_id: W34, qty_out: 10, unit_cost_rial: 1000, amount_rial: 10000, source_type: 'stock_reconcile', source_id: P1, note: 'هم‌ترازی کاردکس' });
  setCache(P1, W34, 10); setCache(P1, W35, 5);
  // P2x: single opening, no JE
  const L4 = opening(P2x, W34, 7, 2000);
  setCache(P2x, W34, 7);
  // P3: single opening with a dedicated JE
  const L5 = opening(P3, W34, 4, 5000);
  const JE_B = legacyJe('opening_inventory', P3, [{ code: inv34.code, name: inv34.name, debit: 20000, credit: 0 }, { code: opAcct.code, name: opAcct.name, debit: 0, credit: 20000 }]);
  db.prepare('UPDATE inventory_ledger SET je_id=? WHERE id=?').run(JE_B, L5);
  setCache(P3, W34, 4);
  // P4: two openings without JE, 5 sold → resolving drops 3 → negative
  const L6 = opening(P4, W34, 3, 1000);
  const L7 = opening(P4, W34, 3, 1000);
  led({ event_type: 'sale', product_id: P4, warehouse_id: W34, qty_out: 5, unit_cost_rial: 1000, amount_rial: 5000, source_type: 'invoice', source_id: 1, note: 'فروش' });
  setCache(P4, W34, 1);

  const tok = {};
  for (const [k, uid] of [['admin', adminId], ['acct', acctId], ['acct2', acct2Id], ['sales', salesId], ['store', storeId]]) {
    const u = q1('SELECT * FROM users WHERE id=?', uid);
    tok[k] = issueStaffSession(db, u, { device_kind: 'test', device_name: 'pos-' + k, device_fingerprint: 'pos-fp-' + k }).token;
  }
  const app = express();
  app.use(express.json());
  app.use('/api', SE.requestScope);
  app.use(capture.captureMiddleware);
  app.use('/api/opening-stock', require('../routes/opening-stock'));
  app.use('/api/inventory', require('../routes/product-opening-stock'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  async function api(method, p, body, who = 'admin') {
    const res = await fetch(BASE + p, {
      method,
      headers: { Authorization: 'Bearer ' + tok[who], 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, data };
  }

  try {
    // ── (h) schema / sync wiring ──
    console.log('— schema & sync wiring —');
    ok(!!q1("SELECT 1 FROM sqlite_master WHERE name='product_opening_stock'") && !!q1("SELECT 1 FROM sqlite_master WHERE name='ux_product_opening_stock'"), 'table + partial unique index exist');
    const names = SYNCABLE_TABLES.map((t) => t.name);
    ok(names[names.length - 1] === 'product_opening_stock' && names.indexOf('product_opening_stock') > names.indexOf('commission_transfers'), 'SYNCABLE_TABLES: appended at end (after commission_transfers)');
    ok(['product_id', 'warehouse_id', 'variant_id', 'ledger_id', 'je_id'].every((c) => FK_COLUMNS.some(([t, col]) => t === 'product_opening_stock' && col === c)), 'FK_COLUMNS for product_opening_stock');
    ok(capture.tableForPath('/api/inventory/opening-stock/apply') === 'product_opening_stock', 'tableForPath /api/inventory/opening-stock/apply → product_opening_stock');
    ok(capture.tableForPath('/api/inventory/ledger/9/reverse') === 'inventory_ledger', 'generic /api/inventory/ledger mapping unaffected');
    ok(capture.BLOCKLIST.includes('/api/inventory/opening-stock/preview') && capture.BLOCKLIST.includes('/api/inventory/opening-stock/migrate'), 'preview + migrate never captured (BLOCKLIST)');
    ok(q1("SELECT value FROM settings WHERE key='sync_seq_backfill_v36'")?.value === '1', 'sync_seq_backfill_v36 sealed');
    ok(cols('product_opening_stock').has('sync_seq'), 'sync_seq column present');
    ok(rbac.RESOURCES[rbac.RESOURCES.length - 1] === 'opening_stock' && rbac.CLOSED_DEFAULT_NONE.has('opening_stock'), 'RBAC opening_stock appended + closed default');
    const D = rbac.DEFAULT_ROLE_PERMISSIONS;
    ok(D.accounting.opening_stock.view && D.accounting.opening_stock.edit && D.store_retail.opening_stock.view && !D.store_retail.opening_stock.edit && !D.field_sales.opening_stock.edit, 'RBAC defaults: accounting view+edit, product-view roles view only');
    ok(!POS.bootMigrationWanted(db) || false, 'boot migration OFF by default');
    ok(count('product_opening_stock') === 0, 'no rows before migration (default OFF)');

    // ── (a) migration ──
    console.log('\n— migration —');
    const snap = () => ({
      led: count('inventory_ledger'), je: count('journal_entries'), jl: count('journal_lines'),
      ledSum: q1('SELECT COALESCE(SUM(amount_rial),0) AS s FROM inventory_ledger').s,
      jlSum: q1('SELECT COALESCE(SUM(debit_rial),0) AS s FROM journal_lines').s,
    });
    const s0 = snap();
    const dry = POS.migrateProductOpeningStock(db, { dryRun: true });
    ok(dry.dry_run === true && dry.combos_total === 5, 'dry-run: 5 combos', { combos: dry.combos_total });
    ok(dry.created.ok === 2 && dry.created.no_je === 1 && dry.created.needs_review === 2, 'dry-run counts ok=2 no_je=1 needs_review=2', dry.created);
    ok(count('product_opening_stock') === 0 && JSON.stringify(snap()) === JSON.stringify(s0), 'dry-run wrote nothing');
    ok(!q1("SELECT 1 FROM settings WHERE key=?", POS.MIGRATE_MARKER), 'dry-run did not set marker');
    const p1row = dry.rows.find((r) => r.product_id === P1 && r.warehouse_id === W34);
    ok(p1row && p1row.status === 'needs_review' && p1row.qty === 10 && p1row.value_rial === 10000 && p1row.chosen_ledger_id === L1 && p1row.candidates.length === 2,
      'multi combo: first row values (qty 10, not 20) + 2 candidates', p1row);
    ok(dry.totals.extra_rows_count === 2 && dry.totals.extra_rows_rial === 13000 && dry.totals.combos_multi === 2 && dry.totals.all_rows_rial === 65000, 'totals: extras 2 rows / 13000 rial; all 65000', dry.totals);
    ok(dry.ledger_count_before === dry.ledger_count_after && dry.je_count_before === dry.je_count_after, 'report: ledger + JE counts unchanged');

    // CLI script (dry-run, second connection) + live-path refusal
    const NODE = process.execPath;
    const script = path.join(__dirname, 'product-opening-stock-migrate.js');
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) { /* */ }
    const outFile = path.join(dir, 'report.json');
    let cp = spawnSync(NODE, [script, '--db', process.env.DB_PATH, '--dry-run', '--out', outFile], { encoding: 'utf8' });
    ok(cp.status === 0 && /"combos_total": 5/.test(cp.stdout) && fs.existsSync(outFile), 'CLI --dry-run exit 0 + report file', { st: cp.status, err: cp.stderr && cp.stderr.slice(0, 300) });
    cp = spawnSync(NODE, [script, '--db', '/home/taranom/crm-taranom/server/erp.db', '--apply'], { encoding: 'utf8' });
    ok(cp.status === 3, 'CLI --apply on live path without --i-have-approval → refused (exit 3)', { st: cp.status });
    ok(count('product_opening_stock') === 0, 'CLI dry-run wrote nothing');

    let r = await api('POST', '/api/inventory/opening-stock/migrate', {}, 'acct');
    ok(r.status === 403, 'migrate route: accounting → 403', r.data);
    r = await api('POST', '/api/inventory/opening-stock/migrate', {}, 'admin');
    ok(r.status === 200 && r.data.dry_run === true && count('product_opening_stock') === 0, 'migrate route: dry_run default', r.data && r.data.created);

    const real = POS.migrateProductOpeningStock(db, { dryRun: false, userId: adminId });
    ok(real.created.ok === 2 && real.created.no_je === 1 && real.created.needs_review === 2 && count('product_opening_stock') === 5, 'real run: 5 rows', real.created);
    ok(JSON.stringify(snap()) === JSON.stringify(s0), 'real run: ledger/JE counts and amounts unchanged');
    ok(!!q1('SELECT value FROM settings WHERE key=?', POS.MIGRATE_MARKER), 'marker product_opening_stock_migrate_v1 set');
    const again = POS.migrateProductOpeningStock(db, { dryRun: false });
    ok(again.created.ok + again.created.no_je + again.created.needs_review === 0 && again.skipped_existing === 5, 'second run creates 0 (idempotent)', again.created);
    const pos1 = q1('SELECT * FROM product_opening_stock WHERE product_id=? AND warehouse_id=?', P1, W34);
    ok(pos1.status === 'needs_review' && pos1.qty === 10 && pos1.ledger_id === L1 && JSON.stringify(JSON.parse(pos1.candidate_ledger_ids)) === JSON.stringify([L1, L2]), 'P1@W34 needs_review, first-row values, candidates [L1,L2]');
    ok(q1('SELECT status FROM product_opening_stock WHERE product_id=?', P2x).status === 'no_je', 'P2x → no_je');
    ok(q1('SELECT status, je_id FROM product_opening_stock WHERE product_id=? AND warehouse_id=?', P1, W35).je_id === JE_A, 'P1@W35 ok with shared JE id');

    // ── (g) duplicates list ──
    console.log('\n— opening-duplicates —');
    r = await api('GET', '/api/inventory/opening-duplicates', null, 'acct');
    ok(r.status === 200 && r.data.needs_review.length === 2 && r.data.no_je.length === 1 && r.data.totals.needs_review_count === 2, 'lists 2 needs_review + 1 no_je', r.data && r.data.totals);
    const nr = r.data.needs_review.find((x) => x.product_id === P1);
    ok(nr && nr.candidates.length === 2 && nr.candidates[1].amount_rial === 10000 && r.data.totals.extra_rows_rial === 13000, 'candidates with amounts; extra_rows_rial 13000', r.data.totals);
    r = await api('GET', '/api/inventory/opening-duplicates', null, 'sales');
    ok(r.status === 200 && r.data.totals.extra_rows_rial === undefined && (r.data.needs_review[0].candidates[0].amount_rial === undefined), 'sales: no cost fields');

    // ── GET product opening ──
    r = await api('GET', `/api/inventory/opening-stock?product_id=${P1}`, null, 'acct');
    ok(r.status === 200 && r.data.stock_total === 15 && r.data.rows.length === 2 && r.data.can_edit === true && r.data.rows.some((x) => x.unit_cost_rial === 1000), 'GET: stock_total 15 (kardex), 2 rows, cost visible to accounting', { st: r.data && r.data.stock_total });
    ok(r.data.by_warehouse.find((x) => x.warehouse_id === W34)?.qty === 10 && r.data.warehouses.length >= 2, 'by_warehouse from kardex + active warehouses');
    r = await api('GET', `/api/inventory/opening-stock?product_id=${P1}`, null, 'store');
    ok(r.status === 200 && r.data.can_edit === false && r.data.rows.every((x) => x.unit_cost_rial === undefined && x.value_rial === undefined), 'store_retail: view, no cost keys, can_edit=false');

    // ── (c) RBAC ──
    console.log('\n— permissions —');
    r = await api('POST', '/api/inventory/opening-stock/preview', { product_id: P3, warehouse_id: W34, qty: 5 }, 'sales');
    ok(r.status === 403 && r.data.code === 'E_PERMISSION', 'sales preview → 403 E_PERMISSION', r.data);
    r = await api('POST', '/api/inventory/opening-stock/apply', { product_id: P3, warehouse_id: W34, qty: 5, reason: 'تست فروشنده', confirm: true }, 'sales');
    ok(r.status === 403 && r.data.code === 'E_PERMISSION', 'sales apply → 403 E_PERMISSION', r.data);

    // ── (b) guard ──
    console.log('\n— single-opening guard —');
    r = await api('POST', '/api/opening-stock', { lines: [{ product_id: P3, warehouse_id: W34, qty: 1, unit_cost_rial: 1000 }] }, 'acct');
    ok(r.status === 409 && r.data.code === 'E_OPENING_EXISTS', 'P2 createDraft for combo with legacy opening → 409 E_OPENING_EXISTS', r.data);
    r = await api('POST', '/api/inventory/opening-stock/preview', { product_id: P5, warehouse_id: W34, qty: 3, unit_cost_rial: 9000 }, 'acct');
    ok(r.status === 200 && r.data.mode === 'create' && r.data.ready && r.data.draft_lines.length === 1, 'preview create mode (no opening yet)', r.data && r.data.errors);
    const ledN0 = count('inventory_ledger');
    r = await api('POST', '/api/inventory/opening-stock/apply', { product_id: P5, warehouse_id: W34, qty: 3, unit_cost_rial: 9000, reason: 'ثبت اولیه', confirm: true }, 'acct');
    ok(r.status === 200 && r.data.mode === 'create' && r.data.draft_doc && r.data.draft_doc.status === 'draft' && count('inventory_ledger') === ledN0, 'apply create → P2 draft, no kardex row', r.data);
    const draftId = r.data.draft_doc.id;
    r = await api('POST', `/api/opening-stock/${draftId}/post`, null, 'acct2');
    ok(r.status === 200 && r.data.status === 'posted', 'other accountant posts the draft (maker-checker)', r.data);
    const pos5 = q1("SELECT * FROM product_opening_stock WHERE product_id=? AND status<>'void'", P5);
    ok(pos5 && pos5.source === 'opening_doc' && pos5.status === 'ok' && pos5.qty === 3 && pos5.value_rial === 27000 && pos5.je_id === r.data.je_id, 'P2 post hook upserts product_opening_stock row (opening_doc)', pos5);
    r = await api('POST', '/api/opening-stock', { lines: [{ product_id: P5, warehouse_id: W34, qty: 1, unit_cost_rial: 1000 }] }, 'acct');
    ok(r.status === 409 && ['E_OPENING_DUPLICATE', 'E_OPENING_EXISTS'].includes(r.data.code), 'second P2 opening for same combo → 409', r.data);
    r = await api('POST', '/api/inventory/opening-stock/preview', { product_id: P5, warehouse_id: W34, qty: 4, unit_cost_rial: 9000 }, 'acct');
    ok(r.status === 200 && !r.data.ready && r.data.errors.some((e) => e.code === 'E_OPENING_USE_DOC_VOID'), 'correction of a P2-doc opening refused → void the doc instead', r.data && r.data.errors);
    r = await api('POST', `/api/opening-stock/${draftId}/void`, { reason: 'ابطال تست' }, 'admin');
    ok(r.status === 200 && q1('SELECT status FROM product_opening_stock WHERE id=?', pos5.id).status === 'void', 'P2 void → product_opening_stock row void');

    // ── (f) reason / confirm ──
    console.log('\n— reason / confirm —');
    r = await api('POST', '/api/inventory/opening-stock/apply', { product_id: P3, warehouse_id: W34, qty: 4, unit_cost_rial: 6000, confirm: true }, 'acct');
    ok(r.status === 400 && r.data.code === 'E_OPENING_REASON_REQUIRED', 'missing reason → 400', r.data);
    r = await api('POST', '/api/inventory/opening-stock/apply', { product_id: P3, warehouse_id: W34, qty: 4, unit_cost_rial: 6000, reason: 'کم' , confirm: true }, 'acct');
    ok(r.status === 400 && r.data.code === 'E_OPENING_REASON_REQUIRED', 'reason < 5 chars → 400', r.data);
    r = await api('POST', '/api/inventory/opening-stock/apply', { product_id: P3, warehouse_id: W34, qty: 4, unit_cost_rial: 6000, reason: 'بهای اشتباه' }, 'acct');
    ok(r.status === 400 && r.data.code === 'E_OPENING_CONFIRM_REQUIRED', 'missing confirm → 400', r.data);

    // ── (d) correction: dedicated JE ──
    console.log('\n— correction (dedicated JE) —');
    const gl0 = glNet(inv34.code);
    const kv0 = kardexValue(P3);
    const ch0 = Number(q1('SELECT total_changes() AS c').c);
    r = await api('POST', '/api/inventory/opening-stock/preview', { product_id: P3, warehouse_id: W34, qty: 4, unit_cost_rial: 6000 }, 'acct');
    ok(r.status === 200 && r.data.mode === 'correct' && r.data.ready && r.data.voids.length === 1 && r.data.voids[0].je_action === 'reverse' && r.data.new_ledger.amount_rial === 24000, 'preview: correct, dedicated JE → reverse, new 24000', r.data && { v: r.data.voids, e: r.data.errors });
    ok(r.data.gl_inventory_delta_rial === 4000 && r.data.kardex_value_delta_rial === 4000, 'preview GL delta == kardex delta (4000)');
    ok(Number(q1('SELECT total_changes() AS c').c) === ch0, 'preview wrote nothing');
    r = await api('POST', '/api/inventory/opening-stock/preview', { product_id: P3, warehouse_id: W34, qty: 4, unit_cost_rial: 5000 }, 'acct');
    ok(r.status === 200 && !r.data.ready && r.data.errors.some((e) => e.code === 'E_OPENING_NO_CHANGE'), 'same values → E_OPENING_NO_CHANGE');
    r = await api('POST', '/api/inventory/opening-stock/apply', { product_id: P3, warehouse_id: W34, qty: 4, unit_cost_rial: 6000, reason: 'بهای اشتباه ثبت شده', confirm: true }, 'acct');
    ok(r.status === 200 && r.data.mode === 'correct' && r.data.reversed_je.length === 1 && r.data.counter_je.length === 0, 'apply correct → dedicated JE reversed', r.data);
    ok(!jeLive(JE_B), 'JE_B no longer live');
    ok(q1('SELECT status FROM inventory_ledger WHERE id=?', L5).status === 'reversed', 'old ledger row status reversed');
    const newL = q1('SELECT * FROM inventory_ledger WHERE id=?', r.data.new_ledger_id);
    ok(newL && newL.source_type === 'product_opening_stock' && newL.event_type === 'opening' && newL.qty_in === 4 && newL.amount_rial === 24000 && newL.je_id === r.data.new_je_id && newL.date === openDate, 'new opening row source_type product_opening_stock, dated fiscal opening, je linked');
    ok(glNet(inv34.code) - gl0 === kardexValue(P3) - kv0 && kardexValue(P3) - kv0 === 4000, 'GL inventory delta == kardex value delta (4000)', { gl: glNet(inv34.code) - gl0, kv: kardexValue(P3) - kv0 });
    let tb = trial();
    ok(Math.round(tb.d) === Math.round(tb.c), 'trial balance balanced', tb);
    const pos3 = q1('SELECT * FROM product_opening_stock WHERE product_id=?', P3);
    ok(pos3.status === 'ok' && pos3.ledger_id === newL.id && pos3.value_rial === 24000 && pos3.version >= 2 && pos3.updated_by === acctId, 'pos row updated (ledger/je/value/version/updated_by)');
    ok(kq(P3, W34) === 4 && n3(q1('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?', P3, W34).qty) === 4, 'qty unchanged (kardex + cache 4)');
    ok(count('audit_log', "action='opening_stock_correct' AND entity_id=?", pos3.id) === 1, 'audit row written');

    // ── (d) correction: shared JE ──
    console.log('\n— correction (shared JE) —');
    const glS = glNet(inv35.code);
    const kvS = kardexValue(P1);
    r = await api('POST', '/api/inventory/opening-stock/apply', { product_id: P1, warehouse_id: W35, qty: 6, unit_cost_rial: 1200, reason: 'شمارش مجدد انبار', confirm: true }, 'acct');
    ok(r.status === 200 && r.data.counter_je.length === 1 && r.data.reversed_je.length === 0 && r.data.counter_je[0].counters_je_id === JE_A, 'shared JE → counter JE, no reverse', r.data);
    ok(jeLive(JE_A), 'shared JE_A still live (approved)');
    const cj = q1('SELECT * FROM journal_entries WHERE id=?', r.data.counter_je[0].je_id);
    const cjl = qa('SELECT account_code, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?', cj.id);
    ok(cj.ref_type === 'product_opening_stock_counter' && cjl.some((l) => l.account_code === opAcct.code && l.debit_rial === 5000) && cjl.some((l) => l.account_code === inv35.code && l.credit_rial === 5000), 'counter JE: Dr opening 5000 / Cr inventory(W35) 5000', cjl);
    ok(q1('SELECT status FROM inventory_ledger WHERE id=?', L3).status === 'reversed', 'L3 reversed');
    ok(glNet(inv35.code) - glS === kardexValue(P1) - kvS && kardexValue(P1) - kvS === 7200 - 5000, 'GL inventory delta == kardex value delta (2200)', { gl: glNet(inv35.code) - glS, kv: kardexValue(P1) - kvS });
    tb = trial();
    ok(Math.round(tb.d) === Math.round(tb.c), 'trial balance balanced', tb);
    ok(kq(P1, W35) === 6 && n3(q1('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?', P1, W35).qty) === 6, 'W35: kardex 6, cache follows (+1)');

    // ── (e) resolve needs_review ──
    console.log('\n— resolve needs_review —');
    r = await api('POST', '/api/inventory/opening-stock/preview', { product_id: P1, warehouse_id: W34 }, 'acct');
    ok(r.status === 200 && r.data.mode === 'resolve' && r.data.ready && r.data.voids.length === 1 && r.data.voids[0].ledger_id === L2 && r.data.voids[0].je_action === 'counter', 'preview resolve: void L2 (counter)', r.data && { v: r.data.voids, e: r.data.errors });
    ok(r.data.paired_adjustments.length === 1 && r.data.paired_adjustments[0].ledger_id === ADJ1 && r.data.residual_qty === 0 && r.data.kardex_after.qty === 10, 'paired stock_reconcile ADJ1, residual 0, kardex stays 10', r.data.paired_adjustments);
    r = await api('POST', '/api/inventory/opening-stock/preview', { product_id: P1, warehouse_id: W34, keep_ledger_id: 999999 }, 'acct');
    ok(r.status === 200 && !r.data.ready && r.data.errors.some((e) => e.code === 'E_OPENING_KEEP_INVALID'), 'invalid keep_ledger_id → not ready');
    const k34 = kq(P1, W34);
    const wsReal = q1('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?', P1, W34);
    db.prepare('UPDATE warehouse_stock SET qty=0 WHERE product_id=? AND warehouse_id=?').run(P1, W34);
    r = await api('POST', '/api/inventory/opening-stock/preview', { product_id: P1, warehouse_id: W34 }, 'acct');
    ok(r.status === 200 && r.data.ready && r.data.warnings.some((w) => String(w).includes('کش موجودی انبار')), 'stale warehouse_stock cache → warning only; kardex decides', r.data && { e: r.data.errors, w: r.data.warnings });
    if (wsReal) db.prepare('UPDATE warehouse_stock SET qty=? WHERE product_id=? AND warehouse_id=?').run(wsReal.qty, P1, W34);
    r = await api('POST', '/api/inventory/opening-stock/apply', { product_id: P1, warehouse_id: W34, reason: 'حذف ردیف تکراری', confirm: true }, 'acct');
    ok(r.status === 200 && r.data.mode === 'resolve' && r.data.voided_ledger.length === 2, 'apply resolve → 2 ledger rows voided', r.data);
    ok(q1('SELECT status FROM inventory_ledger WHERE id=?', L2).status === 'reversed' && q1('SELECT status FROM inventory_ledger WHERE id=?', ADJ1).status === 'reversed' && q1('SELECT status FROM inventory_ledger WHERE id=?', L1).status === 'posted', 'L2 + ADJ1 reversed, L1 kept');
    ok(kq(P1, W34) === k34 && k34 === 10, 'kardex qty unchanged (10)');
    const pr = q1('SELECT * FROM product_opening_stock WHERE product_id=? AND warehouse_id=?', P1, W34);
    ok(pr.status === 'ok' && pr.candidate_ledger_ids == null && pr.reviewed_by === acctId && !!pr.reviewed_at && pr.ledger_id === L1, 'pos → ok, reviewed_by/at, candidates cleared');
    ok(jeLive(JE_A) && r.data.counter_je.length === 1 && r.data.counter_je[0].amount_rial === 10000, 'JE_A still live; counter 10000 for L2');
    ok(count('audit_log', "action='opening_stock_resolve' AND entity_id=?", pr.id) === 1, 'resolve audit row');
    tb = trial();
    ok(Math.round(tb.d) === Math.round(tb.c), 'trial balance balanced after resolve', tb);

    // negative → 409, full rollback
    const before = { led: count('inventory_ledger'), je: count('journal_entries'), pos: JSON.stringify(q1('SELECT * FROM product_opening_stock WHERE product_id=?', P4)) };
    r = await api('POST', '/api/inventory/opening-stock/preview', { product_id: P4, warehouse_id: W34 }, 'acct');
    ok(r.status === 200 && !r.data.ready && r.data.errors.some((e) => e.code === 'E_NEGATIVE_STOCK') && r.data.residual_qty === 3, 'preview resolve P4: residual 3 → E_NEGATIVE_STOCK', r.data && r.data.errors);
    r = await api('POST', '/api/inventory/opening-stock/apply', { product_id: P4, warehouse_id: W34, reason: 'حذف ردیف تکراری', confirm: true }, 'acct');
    ok(r.status === 409 && r.data.code === 'E_NEGATIVE_STOCK', 'apply → 409 E_NEGATIVE_STOCK', r.data);
    ok(count('inventory_ledger') === before.led && count('journal_entries') === before.je && JSON.stringify(q1('SELECT * FROM product_opening_stock WHERE product_id=?', P4)) === before.pos && q1('SELECT status FROM inventory_ledger WHERE id=?', L7).status === 'posted', 'nothing changed (rollback)');

    // qty=0 correction → only void (no_je row)
    r = await api('POST', '/api/inventory/opening-stock/apply', { product_id: P2x, warehouse_id: W34, qty: 0, reason: 'موجودی اشتباه بود', confirm: true }, 'acct');
    ok(r.status === 200 && r.data.new_ledger_id == null && r.data.voided_ledger.length === 1 && q1('SELECT status FROM inventory_ledger WHERE id=?', L4).status === 'reversed', 'qty 0 → only void, no new row', r.data);
    ok(q1('SELECT status FROM product_opening_stock WHERE product_id=?', P2x).status === 'void' && kq(P2x, W34) === 0, 'pos void, kardex 0');

    r = await api('GET', '/api/inventory/opening-duplicates', null, 'acct');
    ok(r.status === 200 && r.data.needs_review.length === 1 && r.data.needs_review[0].product_id === P4 && r.data.no_je.length === 0, 'duplicates list after fixes: only P4 left', r.data && r.data.totals);
    ok(L6 > 0, 'fixtures sane');
  } finally {
    server.close();
  }
}

main().then(() => {
  console.log(`\nproduct opening stock: ${pass} passed, ${fail} failed`);
  try { db.close(); } catch (_) { /* */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* */ }
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
