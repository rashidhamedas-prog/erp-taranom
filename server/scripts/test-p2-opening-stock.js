'use strict';
/**
 * P2 — سند موجودی اول دوره (کالا × انبار × واریانت).
 * Run: node server/scripts/test-p2-opening-stock.js
 *
 * Isolated temp DB. Covers: draft (no side effects) → post (ledger + variant layer + balanced JE),
 * maker-checker, duplicate key 409, matrix without variant 400, closed period 422, R13 void
 * (ledger/JE/variant layer/stock back to before), void blocked when consumed, product-create → draft doc,
 * sync wiring (tables append-only, PATH_TABLE_MAP, backfill v33), leaf enforcement untouched.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : JSON.stringify(extra)); }
}

console.log('\n══ P2 — opening stock docs ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-opening-'));
process.env.DB_PATH = path.join(dir, 'p2.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'p2-opening-stock-test-secret-at-least-32-chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const dbMods = require('../db');
dbMods.initDB();
const db = dbMods.getDB();

async function main() {
  const express = require('express');
  const http = require('http');
  const { issueStaffSession } = require('../lib/auth-sessions');
  const L = require('../lib/inventory/ledger');
  const PL = require('../lib/inventory/period-lock');
  const SE = require('../lib/inventory/shortage-error');
  const capture = require('../sync/capture');
  const { SYNCABLE_TABLES } = require('../sync/tables');
  const { acct } = require('../lib/coa-map');
  const { fiscalOpeningDate } = require('../lib/opening-post');
  const { todayJalali } = require('../jalali');

  const colsCache = new Map();
  const cols = (t) => {
    if (!colsCache.has(t)) colsCache.set(t, new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)));
    return colsCache.get(t);
  };
  function insert(table, obj) {
    const c = cols(table);
    const keys = Object.keys(obj).filter((k) => c.has(k));
    return db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...keys.map((k) => obj[k])).lastInsertRowid;
  }
  const q1 = (sql, ...p) => db.prepare(sql).get(...p);
  const qa = (sql, ...p) => db.prepare(sql).all(...p);
  const n3 = (v) => Math.round(Number(v || 0) * 1000) / 1000;
  const whQty = (pid, wh) => n3(L.warehouseQty(db, pid, wh));
  const hdr = (pid) => n3(q1('SELECT stock FROM products WHERE id=?', pid)?.stock);
  const vwsQty = (vid, wh) => n3(q1('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?', vid, wh)?.qty);
  const count = (t) => q1(`SELECT COUNT(*) AS c FROM ${t}`).c;
  const jeLines = (jeId) => qa('SELECT account_code, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?', jeId);
  const jeLive = (jeId) => {
    const h = q1('SELECT status, deleted_at FROM journal_entries WHERE id=?', jeId);
    return !!h && !(Number(h.deleted_at || 0) > 0) && !['reversed', 'void'].includes(String(h.status || ''));
  };

  // ── seed ──
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('inventory_allow_negative','0')").run();
  const leafBefore = q1("SELECT value FROM settings WHERE key='ledger_leaf_enforcement'")?.value;
  const adminA = insert('users', { name: 'مدیر ۱', username: 'p2_admin_a', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
  const adminB = insert('users', { name: 'مدیر ۲', username: 'p2_admin_b', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
  const acctId = insert('users', { name: 'حسابدار', username: 'p2_acct', password: 'x', role: 'accounting', active: 1, must_change_password: 0 });
  const salesId = insert('users', { name: 'فروشنده', username: 'p2_sales', password: 'x', role: 'sales', active: 1, must_change_password: 0 });
  const whFG = insert('warehouses', { name: 'انبار کالای ساخته', code: 'FG', active: 1, allow_negative: 0, is_default: 1, warehouse_type: 'finished_goods', inventory_system: 'perpetual' });
  const whRAW = insert('warehouses', { name: 'انبار مواد', code: 'RAW', active: 1, allow_negative: 0, is_default: 0, warehouse_type: 'raw_material', inventory_system: 'perpetual' });
  let pseq = 0;
  const product = (name, whId, extra = {}) => insert('products', Object.assign({
    user_id: adminA, name, code: `P2-${++pseq}`, price: 100000, cost: 0, stock: 0, warehouse_id: whId, average_cost_rial: 0, unit: 'عدد',
  }, extra));
  const PA = product('پیراهن', whFG);
  const PB = product('پارچه', whRAW, { unit: 'متر' });
  const PM = product('مانتو', whFG);
  const colorId = insert('product_colors', { name: 'قرمز', code: 'RED', active: 1 });
  const sizeM = insert('product_sizes', { name: 'M', code: 'M', active: 1 });
  const sizeL = insert('product_sizes', { name: 'L', code: 'L', active: 1 });
  const V1 = insert('product_variants', { product_id: PM, color_id: colorId, size_id: sizeM, sku: 'P2-M-RED-M', stock: 0, active: 1, is_default: 0 });
  const V2 = insert('product_variants', { product_id: PM, color_id: colorId, size_id: sizeL, sku: 'P2-M-RED-L', stock: 0, active: 1, is_default: 0 });

  const tok = {};
  for (const [k, uid] of [['adminA', adminA], ['adminB', adminB], ['acct', acctId], ['sales', salesId]]) {
    const u = q1('SELECT * FROM users WHERE id=?', uid);
    tok[k] = issueStaffSession(db, u, { device_kind: 'test', device_name: 'p2-' + k, device_fingerprint: 'p2-fp-' + k }).token;
  }
  const app = express();
  app.use(express.json());
  app.use('/api', SE.requestScope);
  app.use(capture.captureMiddleware);
  app.use('/api/opening-stock', require('../routes/opening-stock'));
  app.use('/api/products', require('../routes/products'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  async function api(method, p, body, who = 'adminA') {
    const res = await fetch(BASE + p, {
      method,
      headers: { Authorization: 'Bearer ' + tok[who], 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, data };
  }

  const openDate = fiscalOpeningDate(db);
  const fgInv = L.inventoryAccountForWarehouse(db, whFG);
  const rawInv = L.inventoryAccountForWarehouse(db, whRAW);
  const openingAcct = acct(db, 'coa_opening_balance');

  try {
    // ── 0. schema / sync wiring ──
    console.log('— schema & sync wiring —');
    ok(!!q1("SELECT 1 FROM sqlite_master WHERE name='opening_stock_docs'") && !!q1("SELECT 1 FROM sqlite_master WHERE name='opening_stock_lines'"), 'tables exist');
    ok(!!q1("SELECT 1 FROM sqlite_master WHERE name='ux_opening_stock_active'"), 'partial unique index exists');
    const names = SYNCABLE_TABLES.map((t) => t.name);
    ok(names.indexOf('opening_stock_lines') === names.indexOf('opening_stock_docs') + 1 && names.indexOf('opening_stock_docs') > names.indexOf('cheque_book_leaves'), 'SYNCABLE_TABLES append-only order (P2 after cheque_book_leaves)');
    ok(capture.tableForPath('/api/opening-stock/5/post') === 'opening_stock_docs', 'PATH_TABLE_MAP /api/opening-stock → opening_stock_docs');
    ok(q1("SELECT value FROM settings WHERE key='sync_seq_backfill_v33'")?.value === '1', 'sync_seq_backfill_v33 sealed');
    ok(cols('opening_stock_docs').has('sync_seq') && cols('opening_stock_lines').has('sync_seq'), 'sync_seq column on both tables');
    let initTwice = true;
    try { dbMods.initDB(); } catch (e) { initTwice = e.message; }
    ok(initTwice === true, 'initDB idempotent (second run no throw)', initTwice);

    // ── 1. permissions + validation ──
    console.log('\n— permissions & validation —');
    const good = { lines: [{ product_id: PA, warehouse_id: whFG, qty: 10, unit_cost_rial: 500000 }] };
    let r = await api('POST', '/api/opening-stock', good, 'sales');
    ok(r.status === 403, 'sales without acc_warehouse_ops:create → 403', r.data);
    r = await api('POST', '/api/opening-stock', { lines: [] }, 'acct');
    ok(r.status === 400 && r.data?.code === 'E_OPENING_EMPTY', 'empty doc → 400', r.data);
    r = await api('POST', '/api/opening-stock', { lines: [{ product_id: PA, warehouse_id: whFG, qty: 0, unit_cost_rial: 100 }] }, 'acct');
    ok(r.status === 400 && r.data?.code === 'E_OPENING_QTY', 'qty=0 → 400 E_OPENING_QTY', r.data);
    r = await api('POST', '/api/opening-stock', { lines: [{ product_id: PA, warehouse_id: whFG, qty: 1, unit_cost_rial: 0 }] }, 'acct');
    ok(r.status === 422 && r.data?.code === 'E_OPENING_COST_REQUIRED', 'unit_cost=0 → 422', r.data);
    r = await api('POST', '/api/opening-stock', { lines: [{ product_id: PM, warehouse_id: whFG, qty: 1, unit_cost_rial: 100 }] }, 'acct');
    ok(r.status === 400 && r.data?.code === 'E_VARIANT_REQUIRED', 'matrix product without variant → 400 E_VARIANT_REQUIRED', r.data);
    r = await api('POST', '/api/opening-stock', { lines: [
      { product_id: PA, warehouse_id: whFG, qty: 1, unit_cost_rial: 100 },
      { product_id: PA, warehouse_id: whFG, qty: 2, unit_cost_rial: 100 }] }, 'acct');
    ok(r.status === 400 && r.data?.code === 'E_OPENING_DUP_LINE', 'duplicate key inside one doc → 400', r.data);
    r = await api('POST', '/api/opening-stock', { lines: [{ product_id: PA, warehouse_id: 99999, qty: 1, unit_cost_rial: 100 }] }, 'acct');
    ok(r.status === 404 && r.data?.code === 'E_WAREHOUSE_NOT_FOUND', 'unknown warehouse → 404', r.data);
    ok(count('opening_stock_docs') === 0, 'failed validations created no doc');

    // ── 2. draft has no side effects ──
    console.log('\n— draft —');
    const snap = { led: count('inventory_ledger'), je: count('journal_entries'), jl: count('journal_lines'), mov: count('inventory_movements') };
    r = await api('POST', '/api/opening-stock', {
      note: 'اول دوره ۱۴۰۵',
      lines: [
        { product_id: PA, warehouse_id: whFG, qty: 10, unit_cost_rial: 500000 },
        { product_id: PB, warehouse_id: whRAW, qty: 40, unit_cost_rial: 200000 },
        { product_id: PM, warehouse_id: whFG, variant_id: V1, qty: 3, unit_cost_rial: 400000 },
        { product_id: PM, warehouse_id: whFG, variant_id: V2, qty: 2, unit_cost_rial: 400000 },
      ],
    }, 'acct');
    ok(r.status === 200 && r.data?.status === 'draft', 'draft created by accounting', r.data);
    const doc1 = r.data;
    ok(/^OP-\d{4}$/.test(doc1?.doc_no || ''), 'doc_no from allocateNumber (OP-0001)', doc1?.doc_no);
    ok(doc1?.date === openDate && doc1?.lines?.length === 4, 'date = fiscalOpeningDate; 4 lines', { date: doc1?.date, openDate });
    ok(count('inventory_ledger') === snap.led && count('journal_entries') === snap.je && count('journal_lines') === snap.jl && count('inventory_movements') === snap.mov,
      'draft: no ledger / JE / movement rows');
    ok(hdr(PA) === 0 && whQty(PA, whFG) === 0 && vwsQty(V1, whFG) === 0, 'draft: stock untouched');
    ok(doc1.lines.every((l) => Number(l.active) === 0 && !l.ledger_id), 'draft lines inactive, no ledger_id');

    // ── 3. maker-checker ──
    console.log('\n— maker-checker —');
    r = await api('POST', `/api/opening-stock/${doc1.id}/post`, null, 'acct');
    ok(r.status === 403 && r.data?.code === 'E_SOD_MAKER_CHECKER', 'creator cannot post own doc (accounting)', r.data);
    const adminDraft = await api('POST', '/api/opening-stock', { lines: [{ product_id: PB, warehouse_id: whRAW, qty: 1, unit_cost_rial: 1000 }] }, 'adminA');
    ok(adminDraft.status === 200 && adminDraft.data?.created_by === adminA, 'admin may create a draft too (creator recorded)', adminDraft.data);
    r = await api('POST', `/api/opening-stock/${adminDraft.data.id}/post`, null, 'adminA');
    ok(r.status === 403 && r.data?.code === 'E_SOD_MAKER_CHECKER', 'admin creator also cannot post own doc (no admin override)', r.data);
    r = await api('POST', `/api/opening-stock/${doc1.id}/post`, null, 'sales');
    ok(r.status === 403 && r.data?.code === 'E_PERMISSION', 'sales cannot post', r.data);
    ok(count('inventory_ledger') === snap.led, 'rejected posts wrote nothing');

    // ── 4. post ──
    console.log('\n— post —');
    const dupDraft = await api('POST', '/api/opening-stock', { lines: [{ product_id: PA, warehouse_id: whFG, qty: 5, unit_cost_rial: 111 }] }, 'adminA');
    ok(dupDraft.status === 200, 'second draft for same key allowed while first is only draft', dupDraft.data);
    r = await api('POST', `/api/opening-stock/${doc1.id}/post`, null, 'adminB');
    ok(r.status === 200 && r.data?.status === 'posted', 'other user posts → posted', r.data);
    const posted = r.data;
    ok(posted?.posted_by === adminB && posted?.je_id > 0, 'posted_by = other user, je_id set');
    ok(hdr(PA) === 10 && whQty(PA, whFG) === 10, 'plain product: header + warehouse qty = 10');
    ok(hdr(PB) === 40 && whQty(PB, whRAW) === 40, 'raw product: 40 in RAW');
    ok(hdr(PM) === 5 && whQty(PM, whFG) === 5 && vwsQty(V1, whFG) === 3 && vwsQty(V2, whFG) === 2, 'matrix: header 5 · wh 5 · V1=3 · V2=2');
    const ledRows = qa("SELECT * FROM inventory_ledger WHERE source_type='opening_stock_doc' AND source_id=? ORDER BY id", doc1.id);
    ok(ledRows.length === 4 && ledRows.every((x) => x.event_type === 'opening' && x.status === 'posted' && x.je_id === posted.je_id), '4 ledger rows event=opening, status posted, je_id linked');
    ok(ledRows.filter((x) => x.variant_id === V1 || x.variant_id === V2).length === 2, 'ledger.variant_id written for variant lines');
    ok(posted.lines.every((l) => Number(l.active) === 1 && l.ledger_id > 0), 'lines active=1 with ledger_id');
    const jl = jeLines(posted.je_id);
    const totalRial = 10 * 500000 + 40 * 200000 + 3 * 400000 + 2 * 400000;
    const dr = jl.reduce((a, x) => a + Math.round(x.debit_rial || 0), 0);
    const cr = jl.reduce((a, x) => a + Math.round(x.credit_rial || 0), 0);
    ok(dr === cr && dr === totalRial, 'JE balanced = total value', { dr, cr, totalRial });
    const dFG = jl.filter((x) => x.account_code === fgInv.code).reduce((a, x) => a + Math.round(x.debit_rial || 0), 0);
    const dRAW = jl.filter((x) => x.account_code === rawInv.code).reduce((a, x) => a + Math.round(x.debit_rial || 0), 0);
    ok(fgInv.code !== rawInv.code ? (dFG === 10 * 500000 + 5 * 400000 && dRAW === 40 * 200000) : (dFG === totalRial), 'Dr per-warehouse inventory account', { dFG, dRAW, fg: fgInv.code, raw: rawInv.code });
    ok(jl.some((x) => x.account_code === openingAcct.code && Math.round(x.credit_rial || 0) === totalRial), `Cr opening account ${openingAcct.code}`);
    const je = q1('SELECT * FROM journal_entries WHERE id=?', posted.je_id);
    ok(je.entry_date === openDate && je.ref_type === 'opening_stock_doc' && je.ref_id === doc1.id, 'JE dated fiscalOpeningDate, ref=opening_stock_doc', { d: je.entry_date, rt: je.ref_type });
    ok(n3(q1('SELECT average_cost_rial AS a FROM products WHERE id=?', PA).a) === 500000, 'average cost seeded from unit cost');
    r = await api('POST', `/api/opening-stock/${doc1.id}/post`, null, 'adminB');
    ok(r.status === 409 && r.data?.code === 'E_OPENING_NOT_DRAFT', 're-post → 409 E_OPENING_NOT_DRAFT', r.data);

    // ── 5. duplicate key ──
    console.log('\n— duplicate key —');
    r = await api('POST', '/api/opening-stock', { lines: [{ product_id: PA, warehouse_id: whFG, qty: 1, unit_cost_rial: 500000 }] }, 'acct');
    ok(r.status === 409 && r.data?.code === 'E_OPENING_DUPLICATE', 'same key as posted doc → 409 E_OPENING_DUPLICATE on create', r.data);
    const ledBefore = count('inventory_ledger'); const jeBefore = count('journal_entries');
    r = await api('POST', `/api/opening-stock/${dupDraft.data.id}/post`, null, 'adminB');
    ok(r.status === 409 && r.data?.code === 'E_OPENING_DUPLICATE', 'post of pre-existing draft with same key → 409', r.data);
    ok(count('inventory_ledger') === ledBefore && count('journal_entries') === jeBefore && hdr(PA) === 10, 'rejected duplicate rolled back atomically');
    r = await api('POST', '/api/opening-stock', { lines: [{ product_id: PM, warehouse_id: whFG, variant_id: V1, qty: 1, unit_cost_rial: 1000 }] }, 'acct');
    ok(r.status === 409 && r.data?.code === 'E_OPENING_DUPLICATE', 'same variant key → 409', r.data);
    r = await api('POST', '/api/opening-stock', { lines: [{ product_id: PA, warehouse_id: whRAW, qty: 1, unit_cost_rial: 1000 }] }, 'acct');
    ok(r.status === 200, 'same product, different warehouse → allowed', r.data);
    const draftOtherWh = r.data;

    // ── 6. closed period ──
    console.log('\n— closed period —');
    const period = openDate.slice(0, 7);
    PL.closePeriod(db, period, { id: adminA }, { reason: 'تست قفل دوره' });
    r = await api('POST', `/api/opening-stock/${draftOtherWh.id}/post`, null, 'adminB');
    ok(r.status === 422 && r.data?.code === 'E_INV_PERIOD_LOCKED', 'closed inventory period → 422 E_INV_PERIOD_LOCKED', r.data);
    ok(q1('SELECT status FROM opening_stock_docs WHERE id=?', draftOtherWh.id).status === 'draft', 'doc stays draft after lock rejection');
    PL.reopenPeriod(db, period, { id: adminA }, { reason: 'پایان تست قفل' });

    // ── 7. void (R13) ──
    console.log('\n— void —');
    const before = { hdrA: hdr(PA), je: posted.je_id };
    r = await api('POST', `/api/opening-stock/${doc1.id}/void`, { reason: 'اشتباه بها' }, 'sales');
    ok(r.status === 403, 'void needs acc_warehouse_ops:delete', r.data);
    // consume part of PA → void must be blocked atomically
    L.postInventoryMovement(db, { eventType: 'sale', productId: PA, warehouseId: whFG, qtyOut: 4, sourceType: 'test', sourceId: 1, date: todayJalali(), createdBy: adminA });
    const ledN = count('inventory_ledger');
    r = await api('POST', `/api/opening-stock/${doc1.id}/void`, { reason: 'تست مصرف‌شده' }, 'adminA');
    ok(r.status === 409 && r.data?.code === 'E_NEGATIVE_STOCK', 'void blocked when stock consumed → 409 E_NEGATIVE_STOCK', r.data);
    ok(q1('SELECT status FROM opening_stock_docs WHERE id=?', doc1.id).status === 'posted' && count('inventory_ledger') === ledN && jeLive(posted.je_id), 'blocked void changed nothing');
    // return the consumed stock, then void
    L.postInventoryMovement(db, { eventType: 'purchase', productId: PA, warehouseId: whFG, qtyIn: 4, unitCostRial: 500000, sourceType: 'test', sourceId: 2, date: todayJalali(), createdBy: adminA });
    const wsBefore = { A: whQty(PA, whFG) - 10, B: whQty(PB, whRAW) - 40, M: whQty(PM, whFG) - 5 };
    r = await api('POST', `/api/opening-stock/${doc1.id}/void`, { reason: 'اشتباه بها' }, 'adminA');
    ok(r.status === 200 && r.data?.status === 'void', 'admin void → 200 void', r.data);
    ok(whQty(PA, whFG) - 0 === wsBefore.A + 0 && whQty(PB, whRAW) === wsBefore.B && whQty(PM, whFG) === wsBefore.M, 'warehouse_stock back to pre-post values', { A: whQty(PA, whFG), B: whQty(PB, whRAW), M: whQty(PM, whFG) });
    ok(vwsQty(V1, whFG) === 0 && vwsQty(V2, whFG) === 0, 'variant layer back to 0');
    ok(hdr(PB) === 0 && hdr(PM) === 0, 'header stock back (raw, matrix)');
    ok(qa("SELECT status FROM inventory_ledger WHERE source_type='opening_stock_doc' AND source_id=? AND event_type='opening'", doc1.id).every((x) => x.status === 'reversed'), 'original opening ledger rows → reversed');
    ok(qa("SELECT 1 FROM inventory_ledger WHERE source_type='opening_stock_doc' AND source_id=? AND event_type='reversal'", doc1.id).length === 4, '4 reversal ledger rows');
    ok(!jeLive(posted.je_id), 'JE reversed / soft-voided');
    ok(qa('SELECT active FROM opening_stock_lines WHERE doc_id=?', doc1.id).every((x) => Number(x.active) === 0), 'lines released (active=0)');
    ok(q1('SELECT void_reason, voided_by FROM opening_stock_docs WHERE id=?', doc1.id).void_reason === 'اشتباه بها', 'void reason stored');
    r = await api('POST', `/api/opening-stock/${doc1.id}/void`, null, 'adminA');
    ok(r.status === 409 && r.data?.code === 'E_OPENING_ALREADY_VOID', 'void twice → 409', r.data);
    // edit = void + new doc with same key
    r = await api('POST', '/api/opening-stock', { lines: [{ product_id: PA, warehouse_id: whFG, qty: 12, unit_cost_rial: 450000 }] }, 'acct');
    ok(r.status === 200, 'after void, same key accepted in a new doc', r.data);
    const doc2 = r.data;
    r = await api('POST', `/api/opening-stock/${doc2.id}/post`, null, 'adminB');
    ok(r.status === 200 && whQty(PA, whFG) === 12 + wsBefore.A, 'new doc posts after void', { st: r.status, q: whQty(PA, whFG) });
    // draft void: status only
    const ledAfter = count('inventory_ledger');
    r = await api('POST', `/api/opening-stock/${draftOtherWh.id}/void`, { reason: 'انصراف' }, 'adminA');
    ok(r.status === 200 && r.data?.status === 'void' && count('inventory_ledger') === ledAfter, 'draft void = status only, no ledger writes', r.data);
    r = await api('POST', `/api/opening-stock/${draftOtherWh.id}/post`, null, 'adminB');
    ok(r.status === 409 && r.data?.code === 'E_OPENING_NOT_DRAFT', 'voided draft cannot be posted', r.data);

    // ── 8. read APIs ──
    console.log('\n— read —');
    r = await api('GET', '/api/opening-stock?status=posted', null, 'acct');
    ok(r.status === 200 && r.data.rows.every((x) => x.status === 'posted') && r.data.rows.some((x) => x.id === doc2.id), 'list filter status=posted');
    r = await api('GET', `/api/opening-stock/${doc2.id}`, null, 'acct');
    ok(r.status === 200 && r.data.lines?.length === 1 && r.data.total_rial === 12 * 450000, 'get doc + lines + total', r.data?.total_rial);
    r = await api('GET', '/api/opening-stock', null, 'sales');
    ok(r.status === 403, 'sales cannot list', r.data);
    r = await api('GET', '/api/opening-stock/meta', null, 'acct');
    ok(r.data?.can_create === true && r.data?.can_post === true, 'meta flags for accounting');

    // ── 9. product create never writes stock; opening goes through the opening doc ──
    console.log('\n— product create → opening doc —');
    r = await api('POST', '/api/products', { name: 'کالای تازه', code: 'P2-NEW-1', price: 100000, cost: 80000, stock: 7, warehouse_id: whFG, unit: 'عدد' }, 'acct');
    ok(r.status === 422 && r.data?.code === 'E_STOCK_VIA_OPENING', 'POST /products with stock → 422 E_STOCK_VIA_OPENING', r.data);
    ok(!q1('SELECT 1 FROM products WHERE code=?', 'P2-NEW-1'), 'rejected create writes no product');
    r = await api('POST', '/api/products', { name: 'کالای تازه', code: 'P2-NEW-1', price: 100000, cost: 80000, warehouse_id: whFG, unit: 'عدد' }, 'acct');
    ok(r.status === 200 || r.status === 201, 'POST /products without stock → ok', r.data);
    const newPid = r.data?.id;
    ok(Number(r.data?.stock || 0) === 0 && !r.data?.opening_doc, 'new product: stock 0, no auto opening doc', r.data?.opening_doc);
    ok(!q1("SELECT 1 FROM inventory_ledger WHERE product_id=?", newPid) && q1('SELECT 1 FROM journal_entries WHERE ref_type=? AND description LIKE ?', 'opening_inventory', `%کالای تازه%`) == null, 'no legacy opening ledger/JE for new product');
    r = await api('POST', '/api/opening-stock', { lines: [{ product_id: newPid, warehouse_id: whFG, qty: 7, unit_cost_rial: 80000 }] }, 'acct');
    ok(r.status === 200 || r.status === 201, 'opening draft for new product', r.data);
    const dl = q1('SELECT * FROM opening_stock_lines WHERE product_id=?', newPid);
    ok(dl && dl.qty === 7 && dl.unit_cost_rial === 80000, 'draft line: qty 7 @ 80000');
    r = await api('POST', `/api/opening-stock/${dl.doc_id}/post`, null, 'adminB');
    ok(r.status === 200 && hdr(newPid) === 7 && whQty(newPid, whFG) === 7, 'other user posts → stock 7', r.data);
    ok(q1("SELECT status FROM product_opening_stock WHERE product_id=? AND warehouse_id=?", newPid, whFG)?.status === 'ok', 'posted doc → product_opening_stock row ok');
    r = await api('POST', '/api/opening-stock', { lines: [{ product_id: newPid, warehouse_id: whFG, qty: 1, unit_cost_rial: 80000 }] }, 'acct');
    ok(r.status === 409 && ['E_OPENING_DUPLICATE', 'E_OPENING_EXISTS'].includes(r.data?.code), 'second opening for same combo → 409', r.data);
    r = await api('POST', '/api/products', { name: 'کالای صفر', code: 'P2-NEW-3', price: 1, cost: 10, stock: 0, warehouse_id: whFG }, 'acct');
    ok((r.status === 200 || r.status === 201) && !r.data?.opening_doc, 'stock 0 → no opening doc', r.data?.opening_doc);

    // ── 9b. bulk / Excel refs (code, warehouse code, variant sku) ──
    console.log('\n— bulk refs —');
    // NOTE (P1 dependency): on main, adjustVariantStock → retireZeroStockColors deactivates a matrix colour
    // whose stock returns to 0 (e.g. after the void above). P1 "safe colour retire" removes that; until it
    // lands we re-activate here so this test is independent of it.
    db.prepare("UPDATE product_variants SET active=1, status='active' WHERE product_id=?").run(PM);
    const PBulk = product('کالای گروهی', whFG);
    r = await api('POST', '/api/opening-stock', { note: 'اکسل', lines: [
      { product_code: q1('SELECT code FROM products WHERE id=?', PBulk).code, warehouse_code: 'FG', qty: 6, unit_cost_rial: 70000 },
      { product_code: q1('SELECT code FROM products WHERE id=?', PM).code, warehouse_name: 'انبار مواد', variant_sku: 'P2-M-RED-M', qty: 1, unit_cost_rial: 90000 },
    ] }, 'acct');
    ok(r.status === 200 && r.data?.lines?.length === 2, 'bulk lines resolved by code / warehouse code|name / sku', r.data);
    ok(r.data?.lines?.[0]?.product_id === PBulk && r.data?.lines?.[0]?.warehouse_id === whFG && r.data?.lines?.[1]?.variant_id === V1 && r.data?.lines?.[1]?.warehouse_id === whRAW, 'resolved ids correct');
    r = await api('POST', '/api/opening-stock', { lines: [{ product_code: 'NOPE-404', warehouse_code: 'FG', qty: 1, unit_cost_rial: 1 }] }, 'acct');
    ok(r.status === 404 && r.data?.code === 'E_OPENING_REF_NOT_FOUND', 'unknown product code → 404 E_OPENING_REF_NOT_FOUND', r.data);

    // ── 10. guards ──
    console.log('\n— guards —');
    const leafAfter = q1("SELECT value FROM settings WHERE key='ledger_leaf_enforcement'")?.value;
    ok(leafAfter === leafBefore, 'ledger_leaf_enforcement unchanged', { leafBefore, leafAfter });
    ok(count('opening_stock_docs') >= 4, 'docs retained physically (no hard delete)');
  } finally {
    server.close();
  }
}

main().then(() => {
  console.log(`\nP2 opening stock: ${pass} passed, ${fail} failed`);
  try { db.close(); } catch (_) { /* */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* */ }
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
