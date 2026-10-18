'use strict';
/**
 * NONTAX-P0-atp — available-to-promise (ATP) gate for firm sales.
 * Run: node server/scripts/test-nontax-atp.js
 *
 * Isolated temp DB only (os.tmpdir()). Never opens, repairs or rewrites a live database.
 *
 * Invariant under test:
 *   ATP(warehouse, SKU) = on_hand − active reservations (of other customers) − committed demand not yet
 *   deducted (firm invoices with fulfillment_state backorder|provisional and stock_deducted=0).
 *   A firm sale (normal|final) whose qty exceeds ATP is rejected with 409 — nothing is written.
 *
 * Historical negative balances: this change runs NO UPDATE against existing stock rows. Old negative
 * on-hand rows stay negative (their ATP ≤ 0 simply blocks further firm sales of that SKU) until a
 * counted stocktake / adjustment corrects them.
 *
 * Concurrency: better-sqlite3 is synchronous and SQLite serialises writers, so two transactions on one
 * file cannot interleave; the guarantee is that the ATP check and the movement live in the SAME
 * db.transaction. The "last unit" case therefore runs two sequential sales: the first commits, the
 * second must fail and must not leave a row behind. The reservation case holds a soft-lock for another
 * customer while a sale asks for the last unit.
 *
 * If better-sqlite3 cannot be loaded for this Node ABI, DB cases are reported as SKIP with the loader
 * error — never as PASS. Static/syntax checks always run.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

let pass = 0;
let fail = 0;
let skip = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : JSON.stringify(extra)); }
}
function skipped(label, why) {
  skip += 1;
  console.log('  SKIP', label, '—', why);
}

console.log('\n══ NONTAX-P0-atp — available-to-promise gate ══\n');

// ─── 1. static / syntax checks (always) ──────────────────────────────────────────────────────────
console.log('— static —');
const SRC = {
  invoices: path.join(__dirname, '../routes/invoices.js'),
  atp: path.join(__dirname, '../lib/inventory/available-to-promise.js'),
  schema: path.join(__dirname, '../lib/inventory/atp-schema.js'),
};
const src = {};
for (const [k, p] of Object.entries(SRC)) {
  src[k] = fs.readFileSync(p, 'utf8');
  try {
    // eslint-disable-next-line no-new
    new vm.Script(`(function (require, module, exports, __dirname, __filename) {${src[k]}\n})`, { filename: p });
    ok(true, `syntax ${path.basename(p)}`);
  } catch (e) {
    ok(false, `syntax ${path.basename(p)}`, e.message);
  }
}
const deductSlice = src.invoices.slice(
  src.invoices.indexOf('function deductStock('),
  src.invoices.indexOf("router.get('/'")
);
ok(deductSlice.length > 200, 'deductStock located');
ok(!/allowNegative:\s*true/.test(deductSlice), 'deductStock product path no longer hard-codes allowNegative:true');
ok(/allowNegative:\s*allowNeg/.test(deductSlice), 'deductStock applies warehouseAllowsNegative to the product path');
const postSlice = src.invoices.slice(src.invoices.indexOf("router.post('/',"), src.invoices.indexOf("router.put('/:id'"));
const convertSlice = src.invoices.slice(src.invoices.indexOf("router.post('/:id/convert'"), src.invoices.indexOf("router.get('/:id/print'"));
ok(/db\.transaction\(\(\) => \{[\s\S]*decideSaleFulfillment\([\s\S]*postSaleStockMovements\(/.test(postSlice),
  'create: ATP decision is inside db.transaction and precedes stock posting');
ok(/db\.transaction\(\(\) => \{[\s\S]*decideSaleFulfillment\([\s\S]*postSaleStockMovements\(/.test(convertSlice),
  'convert: ATP decision is inside db.transaction and precedes stock posting');
ok(src.invoices.includes('E_ATP_AMEND_LOCKED'), 'amend of backorder/provisional invoice is locked (R13: cancel & re-issue)');
const TAX_TOKENS = /vat_exempt|vat_amount|vat_rate|moadian_|enqueueMoadian|tax_id|calcDocTotals/;
ok(!TAX_TOKENS.test(src.atp) && !TAX_TOKENS.test(src.schema), 'new modules touch no VAT / Moadian / tax field');
ok(/fulfillment_state TEXT DEFAULT ''/.test(src.schema), 'schema adds nullable-safe invoices.fulfillment_state only');
ok(!/ALTER TABLE|UPDATE /.test(src.atp), 'ATP evaluator is read-only (no UPDATE / DDL)');
const rsvSrc = fs.readFileSync(path.join(__dirname, '../lib/inventory/reservation.js'), 'utf8');
ok(rsvSrc.includes('function runWithSaleContext') && /ORDER BY priority ASC, id ASC/.test(rsvSrc),
  'reservation.js: customer-scoped consumption added, legacy FIFO retained for other callers');

// ─── 2. DB cases (temp file) ─────────────────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nontax-atp-'));
const dbFile = path.join(dir, 'atp.db');
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'nontax-atp-test-secret-at-least-32-chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

let db = null;
let dbMods = null;
try {
  delete require.cache[require.resolve('../db')];
  dbMods = require('../db');
  dbMods.initDB();
  db = dbMods.getDB();
} catch (e) {
  skipped('all DB cases', 'better-sqlite3 / schema init failed: ' + String(e.message || e).split('\n')[0]);
}

async function dbCases() {
  const express = require('express');
  const http = require('http');
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const { createReservation } = require('../lib/inventory/reservation');
  const atp = require('../lib/inventory/available-to-promise');

  const colsCache = new Map();
  function cols(table) {
    if (!colsCache.has(table)) {
      colsCache.set(table, new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)));
    }
    return colsCache.get(table);
  }
  function insert(table, obj) {
    const c = cols(table);
    const keys = Object.keys(obj).filter((k) => c.has(k));
    const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
    return db.prepare(sql).run(...keys.map((k) => obj[k])).lastInsertRowid;
  }
  const q1 = (sql, ...p) => db.prepare(sql).get(...p);
  const n = (v) => Math.round(Number(v || 0) * 1000) / 1000;
  const wsQty = (pid, wh) => n(q1('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?', pid, wh)?.qty);
  const prodStock = (pid) => n(q1('SELECT stock FROM products WHERE id=?', pid)?.stock);
  const vwsQty = (vid, wh) => n(q1('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?', vid, wh)?.qty);
  const varStock = (vid) => n(q1('SELECT stock FROM product_variants WHERE id=?', vid)?.stock);
  const inv = (id) => q1('SELECT * FROM invoices WHERE id=?', id);
  const invCount = () => q1('SELECT COUNT(*) AS c FROM invoices').c;

  // ── seed ──
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('inventory_allow_negative','0')").run();
  const adminId = insert('users', { name: 'مدیر ATP', username: 'atp_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
  const acctId = insert('users', { name: 'حسابدار ATP', username: 'atp_acct', password: 'x', role: 'accounting', active: 1, must_change_password: 0 });
  const smId = insert('users', { name: 'مدیر فروش ATP', username: 'atp_sm', password: 'x', role: 'sales_manager', active: 1, must_change_password: 0 });
  const custA = insert('customers', { user_id: adminId, biz: 'مشتری الف', owner: 'الف', city: 'مشهد', phone: '0511', status: 'active' });
  const custB = insert('customers', { user_id: adminId, biz: 'مشتری ب', owner: 'ب', city: 'مشهد', phone: '0512', status: 'active' });
  const whFG = insert('warehouses', { name: 'انبار فروش ATP', code: 'FG-ATP', active: 1, allow_negative: 0, is_default: 1, warehouse_type: 'finished_goods', inventory_system: 'perpetual' });
  const whPER = insert('warehouses', { name: 'انبار ادواری ATP', code: 'PER-ATP', active: 1, allow_negative: 0, is_default: 0, warehouse_type: 'finished_goods', inventory_system: 'periodic' });
  const whNEG = insert('warehouses', { name: 'انبار منفی‌مجاز ATP', code: 'NEG-ATP', active: 1, allow_negative: 1, is_default: 0, warehouse_type: 'finished_goods', inventory_system: 'perpetual' });

  function product(name, stock, whId, extra = {}) {
    const pid = insert('products', Object.assign({
      user_id: adminId, name, code: 'ATP-' + name, price: 100000, cost: 50000, stock, warehouse_id: whId, average_cost_rial: 500000,
    }, extra));
    if (whId && extra.noWsRow !== true) {
      db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)').run(pid, whId, stock);
    }
    return pid;
  }
  const P1 = product('ساده-۱', 1, whFG);           // last-unit scenario
  const P3 = product('رزرو-۳', 2, whFG);           // reservation scenario
  const P4 = product('ادواری-۴', 1, whPER);        // periodic (deductStock) path
  const P5 = product('ادواری-بدون-ردیف-۵', 2, whPER, { noWsRow: true }); // legacy seed rule
  const P6 = product('منفی-مجاز-۶', 0, whNEG);     // explicit allow_negative warehouse
  // matrix product P2: two variants, VWS 3 + 2 in FG
  const P2 = product('ماتریسی-۲', 5, whFG);
  const colorId = insert('product_colors', { name: 'قرمز', code: 'RED', active: 1 });
  const sizeM = insert('product_sizes', { name: 'M', code: 'M', active: 1 });
  const sizeL = insert('product_sizes', { name: 'L', code: 'L', active: 1 });
  const V1 = insert('product_variants', { product_id: P2, color_id: colorId, size_id: sizeM, sku: 'P2-RED-M', stock: 3, active: 1, is_default: 0 });
  const V2 = insert('product_variants', { product_id: P2, color_id: colorId, size_id: sizeL, sku: 'P2-RED-L', stock: 2, active: 1, is_default: 0 });
  db.prepare('INSERT INTO variant_warehouse_stock (variant_id,warehouse_id,qty) VALUES (?,?,?)').run(V1, whFG, 3);
  db.prepare('INSERT INTO variant_warehouse_stock (variant_id,warehouse_id,qty) VALUES (?,?,?)').run(V2, whFG, 2);

  // order of customer B soft-locks 1 unit of P3 in FG
  const orderB = insert('orders', { user_id: adminId, cust_id: custB, product_id: P3, qty: 1, total: 100000, status: 'pending', warehouse_id: whFG, date: '1405/07/12' });
  const rsvB = createReservation(db, { kind: 'sales', productId: P3, warehouseId: whFG, qty: 1, sourceType: 'order', sourceId: orderB, createdBy: adminId });
  ok(rsvB && rsvB.status === 'active', 'seed: reservation of customer B active for P3');

  // ── http harness ──
  const tok = {};
  for (const [k, uid] of [['admin', adminId], ['acct', acctId], ['sm', smId]]) {
    const u = q1('SELECT * FROM users WHERE id=?', uid);
    tok[k] = issueStaffSession(db, u, { device_kind: 'test', device_name: 'atp-' + k, device_fingerprint: 'atp-fp-' + k }).token;
  }
  const app = express();
  app.use(express.json());
  app.use('/api/invoices', require('../routes/invoices'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  async function api(method, p, body, who = 'admin', headers = {}) {
    const res = await fetch(BASE + p, {
      method,
      headers: Object.assign({ Authorization: 'Bearer ' + tok[who], 'Content-Type': 'application/json' }, headers),
      body: body == null ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, data };
  }
  const line = (pid, qty, extra = {}) => Object.assign({ product_id: pid, qty, price: 100000 }, extra);
  const sale = (custId, rows, extra = {}) => Object.assign({
    cust_id: custId, type: 'normal', date: '1405/07/12', pay_type: 'credit', warehouse_id: whFG, rows,
  }, extra);

  try {
    // ── A/B. last unit, two sequential firm sales → second rejected, nothing written ──
    console.log('\n— last unit —');
    ok(wsQty(P1, whFG) === 1, 'P1 starts with 1 in FG');
    let r = await api('POST', '/api/invoices', sale(custA, [line(P1, 1)]));
    ok(r.status === 200, 'sale #1 of the last unit accepted', r.data);
    const invA = r.data && r.data.id;
    ok(inv(invA)?.stock_deducted === 1 && (inv(invA)?.fulfillment_state || '') === '', 'sale #1 deducted (stock_deducted=1, fulfillment_state empty)');
    ok(wsQty(P1, whFG) === 0 && prodStock(P1) === 0, 'P1 on-hand is 0 after sale #1', { ws: wsQty(P1, whFG), prod: prodStock(P1) });
    const before = invCount();
    r = await api('POST', '/api/invoices', sale(custA, [line(P1, 1)]));
    ok(r.status === 409 && r.data?.code === 'E_ATP_INSUFFICIENT', 'sale #2 of the same unit → 409 E_ATP_INSUFFICIENT', r.data);
    ok(/کافی نیست/.test(r.data?.error || ''), 'rejection message is Persian', r.data?.error);
    ok(Array.isArray(r.data?.atp_shortages) && r.data.atp_shortages[0].product_id === P1, 'rejection carries atp_shortages');
    ok(invCount() === before, 'rejected sale left no invoice row (transaction rolled back)');
    ok(wsQty(P1, whFG) === 0 && prodStock(P1) === 0, 'P1 on-hand still 0 — never negative');

    // ── G. void of a deducted invoice restores exactly once ──
    console.log('\n— void deducted invoice restores once —');
    r = await api('DELETE', '/api/invoices/' + invA);
    ok(r.status === 200 && r.data?.ok, 'void of deducted sale #1 ok', r.data);
    ok(wsQty(P1, whFG) === 1 && prodStock(P1) === 1, 'P1 restored to 1 (once)', { ws: wsQty(P1, whFG), prod: prodStock(P1) });
    const revRows = q1("SELECT COUNT(*) AS c FROM inventory_ledger WHERE source_type='invoice' AND source_id=? AND event_type='reversal'", invA).c;
    ok(revRows === 1, 'exactly one reversal ledger row', revRows);
    r = await api('DELETE', '/api/invoices/' + invA);
    ok(r.status >= 400, 'second void rejected', r.data);
    ok(wsQty(P1, whFG) === 1 && prodStock(P1) === 1, 'second void did not restore again');

    // ── C. reservation held for another customer ──
    console.log('\n— active reservation + order —');
    r = await api('POST', '/api/invoices', sale(custA, [line(P3, 2)]));
    ok(r.status === 409 && r.data?.code === 'E_ATP_INSUFFICIENT', 'customer A cannot take 2 of P3 while 1 is reserved for B (ATP=1)', r.data);
    r = await api('POST', '/api/invoices', sale(custA, [line(P3, 1)]));
    ok(r.status === 200, 'customer A takes 1 of P3 (within ATP)', r.data);
    ok(wsQty(P3, whFG) === 1, 'P3 on-hand 1 (last unit reserved for B)');
    const rsvMid = q1('SELECT status, qty_consumed FROM inventory_reservations WHERE id=?', rsvB.id);
    ok(rsvMid && rsvMid.status === 'active' && Number(rsvMid.qty_consumed) === 0,
      "customer A's sale did NOT consume customer B's reservation (customer-scoped consumption)", rsvMid);
    r = await api('POST', '/api/invoices', sale(custA, [line(P3, 1)]));
    ok(r.status === 409 && r.data?.code === 'E_ATP_INSUFFICIENT', 'customer A cannot take the last reserved unit of P3', r.data?.error);
    ok(wsQty(P3, whFG) === 1, 'P3 still 1');
    r = await api('POST', '/api/invoices', sale(custB, [line(P3, 1)]));
    ok(r.status === 200, 'customer B (owner of the reservation) takes the last unit', r.data);
    ok(wsQty(P3, whFG) === 0, 'P3 on-hand 0, not negative');
    const rsvAfter = q1('SELECT * FROM inventory_reservations WHERE id=?', rsvB.id);
    ok(rsvAfter && (rsvAfter.status === 'consumed' || Number(rsvAfter.qty_consumed) >= 1), 'reservation consumed by the sale', rsvAfter && rsvAfter.status);

    // ── D. explicit backorder by admin: labelled, no negative stock, counts as committed demand ──
    console.log('\n— authorised backorder —');
    ok(wsQty(P1, whFG) === 1, 'P1 has 1 before backorder');
    r = await api('POST', '/api/invoices', sale(custA, [line(P1, 3)], { backorder: true }));
    ok(r.status === 200, 'admin backorder (qty 3 > ATP 1) accepted', r.data);
    const invBO = r.data && r.data.id;
    ok(r.data?.fulfillment_state === 'backorder', 'response labelled fulfillment_state=backorder', r.data?.fulfillment_state);
    ok(Array.isArray(r.data?.atp_shortages) && r.data.atp_shortages.length >= 1, 'response lists the shortage');
    ok(inv(invBO)?.stock_deducted === 0 && inv(invBO)?.fulfillment_state === 'backorder', 'backorder row: stock_deducted=0, fulfillment_state=backorder');
    ok(wsQty(P1, whFG) === 1 && prodStock(P1) === 1, 'backorder moved no stock (still 1, not −2)', { ws: wsQty(P1, whFG), prod: prodStock(P1) });
    ok(q1("SELECT COUNT(*) AS c FROM inventory_ledger WHERE source_type='invoice' AND source_id=?", invBO).c === 0, 'backorder posted no inventory ledger row');
    ok(q1("SELECT COUNT(*) AS c FROM journal_entries WHERE ref_type='invoice_cogs' AND ref_id=?", invBO).c === 0, 'backorder posted no COGS');
    // committed demand: receipt of 3 → ATP = 4 − 3(backorder) = 1
    db.prepare('UPDATE warehouse_stock SET qty=qty+3 WHERE product_id=? AND warehouse_id=?').run(P1, whFG); // test-only receipt
    db.prepare('UPDATE products SET stock=stock+3 WHERE id=?').run(P1);
    const ev = atp.evaluateAvailableToPromise(db, [line(P1, 2, { warehouse_id: whFG })], whFG, { custId: custA });
    ok(ev.shortages.length === 1 && ev.shortages[0].committed === 3 && ev.shortages[0].atp === 1, 'committed backorder demand reduces ATP (4 − 3 = 1)', ev.shortages[0]);
    r = await api('POST', '/api/invoices', sale(custA, [line(P1, 2)]));
    ok(r.status === 409, 'normal sale of 2 rejected while 3 are committed to the backorder', r.data);
    r = await api('POST', '/api/invoices', sale(custA, [line(P1, 1)]));
    ok(r.status === 200, 'normal sale of 1 (= remaining ATP) accepted', r.data);
    ok(wsQty(P1, whFG) === 3, 'P1 on-hand 3 after that sale');

    // amend lock on the backorder invoice
    r = await api('PUT', '/api/invoices/' + invBO, sale(custA, [line(P1, 1)]));
    ok(r.status === 409 && r.data?.code === 'E_ATP_AMEND_LOCKED', 'amending a backorder invoice is locked', r.data);

    // void of backorder must not invent stock
    console.log('\n— void backorder —');
    r = await api('DELETE', '/api/invoices/' + invBO);
    ok(r.status === 200 && r.data?.ok, 'void of backorder ok', r.data);
    ok(wsQty(P1, whFG) === 3 && prodStock(P1) === 3, 'void of backorder did not increase on-hand (still 3)', { ws: wsQty(P1, whFG), prod: prodStock(P1) });
    ok(inv(invBO)?.status === 'reversed' && inv(invBO)?.stock_deducted === 0, 'backorder invoice reversed, stock_deducted stays 0');
    r = await api('POST', '/api/invoices', sale(custA, [line(P1, 3)]));
    ok(r.status === 200, 'after the backorder is voided its demand is released (sale of 3 ok)', r.data);
    ok(wsQty(P1, whFG) === 0, 'P1 on-hand 0');

    // ── E. sales role may not backorder ──
    console.log('\n— sales role backorder —');
    r = await api('POST', '/api/invoices', sale(custA, [line(P1, 1)], { backorder: true }), 'sm');
    ok(r.status === 403 && r.data?.code === 'E_BACKORDER_FORBIDDEN', 'sales_manager backorder → 403 E_BACKORDER_FORBIDDEN', r.data);
    r = await api('POST', '/api/invoices', sale(custA, [line(P1, 1)]), 'sm');
    ok(r.status === 409 && r.data?.code === 'E_ATP_INSUFFICIENT', 'sales_manager plain sale over ATP → 409', r.data);
    ok(wsQty(P1, whFG) === 0, 'P1 untouched by rejected sales-role attempts');
    r = await api('POST', '/api/invoices', sale(custA, [line(P1, 1)], { backorder: true }), 'acct');
    ok(r.status === 200 && r.data?.fulfillment_state === 'backorder', 'accounting may backorder', r.data?.error);
    const invBO2 = r.data && r.data.id;
    ok(wsQty(P1, whFG) === 0, 'accounting backorder moved no stock');
    await api('DELETE', '/api/invoices/' + invBO2);

    // ── F. variant lines reconcile to the variant×warehouse row ──
    console.log('\n— variant / pack layer —');
    r = await api('POST', '/api/invoices', sale(custA, [line(P2, 2, { variant_id: V1 })]));
    ok(r.status === 200, 'sale of 2 × V1 accepted', r.data);
    ok(vwsQty(V1, whFG) === 1 && varStock(V1) === 1, 'V1 variant×warehouse row 3→1 and variant stock 3→1', { vws: vwsQty(V1, whFG), v: varStock(V1) });
    ok(wsQty(P2, whFG) === 3 && prodStock(P2) === 3, 'P2 header 5→3 (single decrement, no double header hit)', { ws: wsQty(P2, whFG), prod: prodStock(P2) });
    ok(vwsQty(V2, whFG) === 2, 'V2 untouched');
    r = await api('POST', '/api/invoices', sale(custA, [line(P2, 2, { variant_id: V1 })]));
    ok(r.status === 409 && r.data?.code === 'E_ATP_INSUFFICIENT', 'sale of 2 × V1 rejected on the VARIANT row (1 left) although product has 3', r.data);
    ok(r.data?.atp_shortages?.some((s) => s.variant_id === V1), 'shortage names the variant row');
    r = await api('POST', '/api/invoices', sale(custA, [line(P2, 1, { variant_id: V1 }), line(P2, 1, { variant_id: V1 })]));
    ok(r.status === 409, 'two pack lines of the same variant are summed (1+1 > 1)', r.data);
    ok(vwsQty(V1, whFG) === 1, 'V1 still 1 after rejected sales');
    r = await api('POST', '/api/invoices', sale(custA, [line(P2, 2, { variant_id: V2 })]));
    ok(r.status === 200, 'sale of 2 × V2 accepted', r.data);
    ok(vwsQty(V2, whFG) === 0 && wsQty(P2, whFG) === 1 && prodStock(P2) === 1, 'V2 0, header 1', { vws: vwsQty(V2, whFG), ws: wsQty(P2, whFG) });

    // ── H. provisional (device / offline) sale: never deducts locally ──
    console.log('\n— provisional (offline) —');
    ok(wsQty(P3, whFG) === 0, 'P3 is at 0');
    db.prepare('UPDATE warehouse_stock SET qty=2 WHERE product_id=? AND warehouse_id=?').run(P3, whFG); // test-only receipt
    db.prepare('UPDATE products SET stock=2 WHERE id=?').run(P3);
    r = await api('POST', '/api/invoices', sale(custA, [line(P3, 1)]), 'admin', { 'x-offline-provisional': '1' });
    ok(r.status === 200 && r.data?.fulfillment_state === 'provisional', 'provisional sale accepted and labelled', r.data?.error || r.data?.fulfillment_state);
    const invProv = r.data && r.data.id;
    ok(inv(invProv)?.stock_deducted === 0 && inv(invProv)?.fulfillment_state === 'provisional', 'provisional row: stock_deducted=0');
    ok(wsQty(P3, whFG) === 2 && prodStock(P3) === 2, 'provisional sale did not deduct (still 2)');
    r = await api('POST', '/api/invoices', sale(custA, [line(P3, 2)]), 'admin', { 'x-offline-provisional': '1' });
    ok(r.status === 409, 'provisional sale over ATP (2 − 1 committed = 1) still rejected — never negative', r.data);
    r = await api('DELETE', '/api/invoices/' + invProv);
    ok(r.status === 200 && wsQty(P3, whFG) === 2, 'void of provisional does not add stock');

    // ── I/J. proforma never deducts; convert honours the gate ──
    console.log('\n— proforma / convert —');
    r = await api('POST', '/api/invoices', sale(custA, [line(P3, 100)], { type: 'proforma' }));
    ok(r.status === 200, 'proforma for 100 accepted', r.data);
    const invPF = r.data && r.data.id;
    ok(inv(invPF)?.stock_deducted === 0 && (inv(invPF)?.fulfillment_state || '') === '' && wsQty(P3, whFG) === 2, 'proforma deducted nothing and carries no label');
    // target 'final': enqueueMoadian is a no-op unless moadian_enabled='1'; void of a converted final un-converts.
    r = await api('POST', `/api/invoices/${invPF}/convert`, { target_type: 'final' });
    ok(r.status === 409 && r.data?.code === 'E_ATP_INSUFFICIENT', 'convert over ATP → 409', r.data);
    ok(inv(invPF)?.type === 'proforma' && !inv(invPF)?.converted && wsQty(P3, whFG) === 2, 'failed convert rolled back (still proforma, stock intact)');
    r = await api('POST', `/api/invoices/${invPF}/convert`, { target_type: 'final', backorder: true }, 'sm');
    ok(r.status === 403 && r.data?.code === 'E_BACKORDER_FORBIDDEN', 'sales_manager cannot convert as backorder', r.data);
    r = await api('POST', `/api/invoices/${invPF}/convert`, { target_type: 'final', backorder: true });
    ok(r.status === 200 && r.data?.fulfillment_state === 'backorder', 'admin convert as backorder ok + labelled', r.data);
    ok(inv(invPF)?.type === 'final' && inv(invPF)?.stock_deducted === 0 && inv(invPF)?.fulfillment_state === 'backorder', 'converted backorder: firm, stock_deducted=0');
    ok(wsQty(P3, whFG) === 2, 'convert-as-backorder moved no stock');
    r = await api('DELETE', '/api/invoices/' + invPF);
    ok(r.status === 200 && r.data?.restoredToProforma === true, 'void of converted backorder restores proforma', r.data);
    ok(inv(invPF)?.type === 'proforma' && (inv(invPF)?.fulfillment_state || '') === '' && wsQty(P3, whFG) === 2, 'restored proforma: label cleared, stock unchanged');
    r = await api('POST', '/api/invoices', sale(custA, [line(P3, 2)]));
    ok(r.status === 200 && wsQty(P3, whFG) === 0, 'proforma (even for 100) is not demand — the 2 units are sellable', r.data?.error);

    // ── K. periodic warehouse → deductStock path ──
    console.log('\n— periodic warehouse (deductStock) —');
    const perSale = (pid, qty) => sale(custA, [line(pid, qty, { warehouse_id: whPER })], { warehouse_id: whPER });
    r = await api('POST', '/api/invoices', perSale(P4, 1));
    ok(r.status === 200, 'periodic: sale of the last unit accepted', r.data);
    const invPer = r.data && r.data.id;
    ok(q1("SELECT COUNT(*) AS c FROM inventory_movements WHERE doc_type='invoice' AND doc_id=?", invPer).c === 1, 'periodic path posted one inventory_movements row');
    ok(wsQty(P4, whPER) === 0 && prodStock(P4) === 0, 'periodic: P4 at 0');
    r = await api('POST', '/api/invoices', perSale(P4, 1));
    ok(r.status === 409, 'periodic: second sale rejected', r.data);
    ok(wsQty(P4, whPER) === 0 && prodStock(P4) === 0, 'periodic: never negative');
    r = await api('DELETE', '/api/invoices/' + invPer);
    ok(r.status === 200 && wsQty(P4, whPER) === 1 && prodStock(P4) === 1, 'periodic: void restores once', { ws: wsQty(P4, whPER), prod: prodStock(P4) });
    ok(q1("SELECT COUNT(*) AS c FROM inventory_movements WHERE doc_type='invoice_void' AND doc_id=?", invPer).c === 1, 'periodic: one void movement');
    r = await api('DELETE', '/api/invoices/' + invPer);
    ok(r.status >= 400 && wsQty(P4, whPER) === 1, 'periodic: second void rejected, no double restore');
    // legacy seed: product with stock but no warehouse_stock row
    ok(!q1('SELECT 1 AS x FROM warehouse_stock WHERE product_id=? AND warehouse_id=?', P5, whPER), 'P5 has no warehouse_stock row (legacy product)');
    r = await api('POST', '/api/invoices', perSale(P5, 1));
    ok(r.status === 200, 'legacy product sells from its home-warehouse quantity', r.data);
    ok(wsQty(P5, whPER) === 1 && prodStock(P5) === 1, 'legacy seed 2 − 1 = 1 (not a fresh 0 row driven to −1)', { ws: wsQty(P5, whPER), prod: prodStock(P5) });

    // ── L. explicit allow_negative warehouse: ATP + physical write both allow (v435 trigger) ──
    console.log('\n— allow_negative warehouse (explicit admin switch) —');
    const evNeg = atp.evaluateAvailableToPromise(db, [line(P6, 1, { warehouse_id: whNEG })], whNEG, { custId: custA });
    ok(evNeg.shortages.length === 0 && evNeg.checked[0] && evNeg.checked[0].bypassed === true,
      'gate bypassed for a warehouse with allow_negative=1 (explicit configuration)', evNeg.checked[0]);
    r = await api('POST', '/api/invoices', sale(custA, [line(P6, 1, { warehouse_id: whNEG })], { warehouse_id: whNEG }));
    ok(r.status === 200 && r.data?.code !== 'E_ATP_INSUFFICIENT', 'HTTP: sale accepted (not ATP-blocked)', r.data);
    ok(wsQty(P6, whNEG) === -1, 'warehouse_stock may go negative when allow_negative=1', { ws: wsQty(P6, whNEG) });
  } finally {
    server.close();
    try { closeSessionStore(); } catch (_) {}
  }
}

(async () => {
  if (db) {
    try {
      await dbCases();
    } catch (e) {
      ok(false, 'DB cases crashed', (e && e.stack) || String(e));
    } finally {
      try { dbMods.closeDB(); } catch (_) {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  }
  console.log(`\n══ Result: ${pass} pass, ${fail} fail, ${skip} skip ══\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
