'use strict';
/**
 * P7 — حالت «اول دوره» در دریافت مواد / طاقه.
 * Run: node server/scripts/test-prodcycle-p7-opening-rolls.js
 *
 * Isolated temp DB. Covers: 3 rolls of a yard product entered in metres (m → yd) → draft (no side effects)
 * → post by another user (3 batches, 3 kardex opening rows, JE Dr 1110 / Cr 3102, no supplier);
 * second opening same product×warehouse → 409 E_OPENING_EXISTS; roll void/amend from the roll screen blocked;
 * edit = full reverse + new draft; void blocked when a roll is consumed, then full reverse;
 * non-admin/accounting forbidden; legacy opening paths write no unvalued opening kardex rows; sync wiring.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : JSON.stringify(extra)); }
}

console.log('\n══ P7 — opening mode for material / fabric-roll receipt ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-opening-rolls-'));
const DB_PATH = path.join(dir, 'p7.db');
process.env.DB_PATH = DB_PATH;
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'p7-opening-rolls-test-secret-at-least-32-chars!!';
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
  const SE = require('../lib/inventory/shortage-error');
  const capture = require('../sync/capture');
  const { FK_COLUMNS } = require('../sync/tables');
  const OS = require('../lib/inventory/opening-stock');
  const OR = require('../lib/inventory/opening-rolls');
  const FR = require('../lib/inventory/fabric-rolls');
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
  const count = (sql, ...p) => q1(sql, ...p).c;
  const whQty = (pid, wh) => n3(L.warehouseQty(db, pid, wh));
  const jeLines = (jeId) => qa('SELECT account_code, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?', jeId);
  const jeLive = (jeId) => {
    const h = q1('SELECT status, deleted_at FROM journal_entries WHERE id=?', jeId);
    return !!h && !(Number(h.deleted_at || 0) > 0) && !['reversed', 'void'].includes(String(h.status || ''));
  };
  const unvaluedOpenings = () => count(`SELECT COUNT(*) AS c FROM inventory_ledger
    WHERE event_type='opening' AND COALESCE(status,'posted')='posted' AND (je_id IS NULL OR COALESCE(amount_rial,0)=0)`);

  // ── seed ──
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('inventory_allow_negative','0')").run();
  const adminA = insert('users', { name: 'مدیر ۱', username: 'p7_admin_a', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
  const adminB = insert('users', { name: 'مدیر ۲', username: 'p7_admin_b', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
  const acctId = insert('users', { name: 'حسابدار', username: 'p7_acct', password: 'x', role: 'accounting', active: 1, must_change_password: 0 });
  const salesId = insert('users', { name: 'فروشنده', username: 'p7_sales', password: 'x', role: 'sales', active: 1, must_change_password: 0 });
  const whRAW = insert('warehouses', { name: 'انبار مواد P7', code: 'RAW-P7', active: 1, allow_negative: 0, is_default: 0, warehouse_type: 'raw_material', inventory_system: 'perpetual' });
  const whFG = insert('warehouses', { name: 'انبار کالای ساخته P7', code: 'FG-P7', active: 1, allow_negative: 0, is_default: 0, warehouse_type: 'finished_goods', inventory_system: 'perpetual' });
  const unit = (code) => q1('SELECT * FROM units_of_measure WHERE code=?', code);
  const M = unit('M');
  const YD = unit('YD');
  ok(!!(M && YD), 'uom catalog has M and YD');
  const PY = insert('products', { user_id: adminA, name: 'پارچه یاردی P7', code: 'P7-YD', price: 0, cost: 0, stock: 0, unit: 'یارد', unit_id: YD.id, average_cost_rial: 0, warehouse_id: whRAW });
  const PATTR = insert('products', { user_id: adminA, name: 'دکمه P7', code: 'P7-BTN', price: 0, cost: 0, stock: 0, unit: 'عدد', average_cost_rial: 0, warehouse_id: whRAW });

  const tok = {};
  for (const [k, uid] of [['adminA', adminA], ['adminB', adminB], ['acct', acctId], ['sales', salesId]]) {
    const u = q1('SELECT * FROM users WHERE id=?', uid);
    tok[k] = issueStaffSession(db, u, { device_kind: 'test', device_name: 'p7-' + k, device_fingerprint: 'p7-fp-' + k }).token;
  }
  const app = express();
  app.use(express.json());
  app.use('/api', SE.requestScope);
  app.use(capture.captureMiddleware);
  app.use('/api/opening-stock', require('../routes/opening-stock'));
  app.use('/api/inventory', require('../routes/inventory'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  async function api(method, p, body, who = 'acct') {
    const res = await fetch(BASE + p, {
      method,
      headers: { Authorization: 'Bearer ' + tok[who], 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, data };
  }

  const rawInv = L.inventoryAccountForWarehouse(db, whRAW);
  const ROLLS = [
    { roll_no: 'P7-R1', color: 'مشکی', width_cm: 150, entry_qty: 9.144, weight_kg: 4.5 },
    { roll_no: 'P7-R2', color: 'سرمه‌ای', width_cm: 150, entry_qty: 18.288, weight_kg: 9 },
    { roll_no: 'P7-R3', color: 'مشکی', width_cm: 160, entry_qty: 27.432, weight_kg: 13.25, pattern: 'ساده' },
  ];
  const LINE = { product_id: PY, warehouse_id: whRAW, entry_unit_id: M.id, unit_cost_rial: 1000000, rolls: ROLLS };
  const TOTAL = 9144000 + 18288000 + 27432000;

  try {
    // ── 0. schema / sync wiring ──
    console.log('— schema & sync wiring —');
    ok(['profile', 'rolls_json', 'entry_unit_id', 'entry_factor', 'entry_unit_cost_rial', 'amount_rial'].every((c) => cols('opening_stock_lines').has(c)), 'opening_stock_lines extended (no new opening table)');
    ok(cols('opening_stock_docs').has('amends_doc_id') && cols('inventory_batches').has('weight_kg'), 'amends_doc_id + inventory_batches.weight_kg');
    ok(!q1("SELECT 1 FROM sqlite_master WHERE type='table' AND name LIKE 'opening_roll%'"), 'no separate opening rolls table');
    ok(FK_COLUMNS.some(([t, c]) => t === 'opening_stock_lines' && c === 'entry_unit_id') && FK_COLUMNS.some(([t, c]) => t === 'opening_stock_docs' && c === 'amends_doc_id'), 'FK_COLUMNS remap entry_unit_id / amends_doc_id');
    ok(capture.tableForPath('/api/opening-stock/rolls') === 'opening_stock_docs' && capture.tableForPath('/api/opening-stock/7/rolls-amend') === 'opening_stock_docs', 'PATH_TABLE_MAP covers /api/opening-stock/rolls*');
    ok(rawInv.code === '1110', 'raw warehouse inventory leaf = 1110', rawInv);

    // ── 1. permissions + validation ──
    console.log('\n— permissions & validation —');
    let r = await api('POST', '/api/opening-stock/rolls', { lines: [LINE] }, 'sales');
    ok(r.status === 403, 'sales → 403', r.data);
    let err = null;
    try { OR.createRollsDraft(db, { lines: [LINE] }, { id: salesId, role: 'warehouse' }); } catch (e) { err = e; }
    ok(err && err.status === 403 && err.code === 'E_PERMISSION', 'lib: non-admin/accounting role → E_PERMISSION', err && err.code);
    r = await api('POST', '/api/opening-stock/rolls', { lines: [{ ...LINE, warehouse_id: whFG }] });
    ok(r.status === 400 && r.data?.code === 'E_FABRIC_WH_RAW', 'non-raw warehouse → 400 E_FABRIC_WH_RAW', r.data);
    r = await api('POST', '/api/opening-stock/rolls', { lines: [{ ...LINE, rolls: [] }] });
    ok(r.status === 400 && r.data?.code === 'E_OPENING_ROLLS_EMPTY', 'no rolls → 400', r.data);
    r = await api('POST', '/api/opening-stock/rolls', { lines: [{ ...LINE, unit_cost_rial: 0 }] });
    ok(r.status === 422 && r.data?.code === 'E_OPENING_COST_REQUIRED', 'cost 0 → 422', r.data);
    r = await api('POST', '/api/opening-stock/rolls', { lines: [{ ...LINE, rolls: [{ ...ROLLS[0], color: '' }] }] });
    ok(r.status === 400 && r.data?.code === 'E_FABRIC_COLOR', 'fabric roll without color → 400', r.data);
    r = await api('POST', '/api/opening-stock/rolls', { lines: [{ ...LINE, rolls: [ROLLS[0], { ...ROLLS[1], roll_no: 'P7-R1' }] }] });
    ok(r.status === 409 && r.data?.code === 'E_FABRIC_DUP_ROLL', 'duplicate roll number → 409', r.data);
    ok(count('SELECT COUNT(*) AS c FROM opening_stock_docs') === 0, 'failed validations created no doc');

    // ── 2. draft (no side effects) ──
    console.log('\n— draft —');
    const snap = { led: count('SELECT COUNT(*) AS c FROM inventory_ledger'), je: count('SELECT COUNT(*) AS c FROM journal_entries'), b: count('SELECT COUNT(*) AS c FROM inventory_batches') };
    r = await api('POST', '/api/opening-stock/rolls', { note: 'طاقه‌های اول دوره', lines: [LINE] });
    ok(r.status === 200 && r.data?.status === 'draft', 'accounting creates rolls draft', r.data);
    const doc1 = r.data;
    const l1 = doc1.lines?.[0] || {};
    ok(/^OP-\d{4}$/.test(doc1.doc_no || ''), 'doc_no from allocateNumber', doc1.doc_no);
    ok(doc1.lines.length === 1 && Array.isArray(l1.rolls) && l1.rolls.length === 3, 'one product×warehouse line holding 3 rolls');
    ok(l1.qty === 60, 'line qty converted to product unit: 9.144+18.288+27.432 m = 60 yd', l1.qty);
    ok(l1.amount_rial === TOTAL && doc1.total_rial === TOTAL && l1.unit_cost_rial === 914400, 'amount exact (54,864,000) and unit cost per yd 914,400', { a: l1.amount_rial, u: l1.unit_cost_rial });
    ok(l1.rolls.map((x) => n3(x.stock_qty)).join(',') === '10,20,30' && l1.rolls[2].weight_kg === 13.25, 'per-roll stock qty 10/20/30 yd + weight kept');
    ok(count('SELECT COUNT(*) AS c FROM inventory_ledger') === snap.led && count('SELECT COUNT(*) AS c FROM journal_entries') === snap.je && count('SELECT COUNT(*) AS c FROM inventory_batches') === snap.b, 'draft: no kardex / JE / batch');
    r = await api('GET', '/api/opening-stock', null, 'acct');
    ok(r.data?.rows?.find((x) => x.id === doc1.id)?.total_rial === TOTAL && r.data.rows.find((x) => x.id === doc1.id).rolls_line_count === 1, 'list total uses exact amount + rolls flag');

    // ── 3. post ──
    console.log('\n— post —');
    r = await api('POST', `/api/opening-stock/${doc1.id}/post`, null, 'acct');
    ok(r.status === 403 && r.data?.code === 'E_SOD_MAKER_CHECKER', 'creator cannot post (maker-checker)', r.data);
    err = null;
    try { OS.postDoc(db, doc1.id, { id: salesId, role: 'warehouse' }); } catch (e) { err = e; }
    ok(err && err.code === 'E_PERMISSION', 'lib: post of rolls doc by non-admin/accounting → E_PERMISSION', err && err.code);
    r = await api('POST', `/api/opening-stock/${doc1.id}/post`, null, 'adminB');
    ok(r.status === 200 && r.data?.status === 'posted' && r.data?.je_id > 0, 'other admin posts', r.data);
    const posted1 = r.data;
    const batches = qa("SELECT * FROM inventory_batches WHERE source_type='opening_stock_doc' AND source_id=? ORDER BY id", doc1.id);
    ok(batches.length === 3, '3 inventory_batches created', batches.length);
    ok(batches.every((b) => b.kind === 'fabric' && !b.supplier_id && b.status === 'active' && b.unit === 'yd'), 'batches: kind fabric, no supplier, unit yd');
    ok(batches.map((b) => b.batch_no).join(',') === 'P7-R1,P7-R2,P7-R3' && batches.map((b) => b.qty_received).join(',') === '10,20,30', 'roll numbers + qty_received exactly 10/20/30 yd', batches.map((b) => b.qty_received));
    ok(batches.every((b) => b.entry_unit_id === M.id) && n3(batches[0].entry_qty) === 9.144 && batches[2].weight_kg === 13.25 && batches[2].width_cm === 160 && batches[1].color === 'سرمه‌ای', 'entry unit m / entry qty / weight / width / color on batch');
    ok(batches.every((b) => b.journal_id === posted1.je_id && b.ledger_id > 0), 'batch → ledger_id + journal_id');
    const led = qa("SELECT * FROM inventory_ledger WHERE source_type='opening_stock_doc' AND source_id=? ORDER BY id", doc1.id);
    ok(led.length === 3 && led.every((x) => x.event_type === 'opening' && x.status === 'posted' && x.je_id === posted1.je_id), '3 kardex rows event=opening linked to JE');
    ok(led.map((x) => x.batch_id).join(',') === batches.map((b) => b.id).join(','), 'kardex rows tagged with batch_id');
    ok(n3(led.reduce((a, x) => a + x.qty_in, 0)) === 60 && led.reduce((a, x) => a + Math.round(x.amount_rial), 0) === TOTAL, 'kardex qty 60 yd / value 54,864,000', led.map((x) => [x.qty_in, x.amount_rial]));
    ok(whQty(PY, whRAW) === 60 && n3(q1('SELECT stock FROM products WHERE id=?', PY).stock) === 60, 'warehouse + header stock = 60 yd');
    ok(batches.every((b) => n3(FR.liveBatchMeters(db, b.id)) === n3(b.qty_received)), 'live roll balance = received');
    const jl = jeLines(posted1.je_id);
    const dr1110 = jl.filter((x) => x.account_code === '1110').reduce((a, x) => a + Math.round(x.debit_rial || 0), 0);
    const cr3102 = jl.filter((x) => x.account_code === '3102').reduce((a, x) => a + Math.round(x.credit_rial || 0), 0);
    ok(dr1110 === TOTAL && cr3102 === TOTAL && jl.length === 2, 'JE: Dr 1110 / Cr 3102 = 54,864,000 (2 lines)', jl);
    ok(!jl.some((x) => String(x.account_code).startsWith('21')), 'JE has no payable/supplier line');
    ok(count("SELECT COUNT(*) AS c FROM supplier_ledger WHERE ref_type='fabric_roll'") === 0, 'no supplier ledger rows');
    ok(q1('SELECT status FROM product_opening_stock WHERE product_id=? AND warehouse_id=?', PY, whRAW)?.status === 'ok', 'product_opening_stock row ok (one per combo)');
    ok(Number(posted1.lines[0].active) === 1 && posted1.lines[0].ledger_id === led[0].id, 'single active line → first roll ledger');
    ok(posted1.has_rolls === true && posted1.batches?.length === 3, 'GET doc exposes rolls + batches');

    // ── 4. guards ──
    console.log('\n— one opening per product×warehouse —');
    r = await api('POST', '/api/opening-stock/rolls', { lines: [{ ...LINE, rolls: [{ ...ROLLS[0], roll_no: 'P7-X1' }] }] });
    ok(r.status === 409 && r.data?.code === 'E_OPENING_EXISTS', 'second rolls opening same product×warehouse → 409 E_OPENING_EXISTS', r.data);
    r = await api('POST', '/api/opening-stock', { lines: [{ product_id: PY, warehouse_id: whRAW, qty: 5, unit_cost_rial: 1000 }] });
    ok(r.status === 409 && ['E_OPENING_DUPLICATE', 'E_OPENING_EXISTS'].includes(r.data?.code), 'plain v609 doc for same combo → 409', r.data);
    const POS = require('../lib/inventory/product-opening-stock');
    let plan;
    try { plan = POS.planOpeningChange(db, { product_id: PY, warehouse_id: whRAW, qty: 70, unit_cost_rial: 900000, reason: 'تست اصلاحیه' }, q1('SELECT * FROM users WHERE id=?', adminA)); } catch (e) { plan = { errors: [{ code: e.code, msg: e.message }] }; }
    ok((plan.errors || []).some((x) => x.code === 'E_OPENING_USE_DOC_VOID') && !plan.ready, 'product opening amendment refuses doc-owned rolls opening (E_OPENING_USE_DOC_VOID)', plan.errors);
    r = await api('POST', `/api/inventory/fabric-rolls/${batches[0].id}/void`, { reason: 'x' }, 'adminA');
    ok(r.status === 409 && r.data?.code === 'E_FABRIC_OPENING_DOC', 'roll screen void of opening roll → 409 E_FABRIC_OPENING_DOC', r.data);
    r = await api('PATCH', `/api/inventory/fabric-rolls/${batches[0].id}`, { meters: 11 }, 'adminA');
    ok(r.status === 409 && r.data?.code === 'E_FABRIC_OPENING_DOC', 'roll screen qty edit of opening roll → 409', r.data);
    r = await api('PATCH', `/api/inventory/fabric-rolls/${batches[0].id}`, { pattern: 'راه‌راه' }, 'adminA');
    ok(r.status === 200 && r.data?.pattern === 'راه‌راه', 'descriptive edit (pattern) still allowed without supplier', r.data);
    r = await api('POST', '/api/inventory/fabric-rolls', { mode: 'opening', product_id: PY, warehouse_id: whRAW, color: 'x', entry_qty: 1, unit_cost_rial: 1, idempotency_key: 'p7-op' }, 'adminA');
    ok(r.status === 400 && r.data?.code === 'E_FABRIC_OPENING_ROUTE', 'normal receipt endpoint refuses mode=opening (no supplier bypass)', r.data);

    // ── 5. edit = full reverse + new draft ──
    console.log('\n— edit (R13) —');
    r = await api('POST', `/api/opening-stock/${doc1.id}/rolls-amend`, { reason: 'x', lines: [LINE] });
    ok(r.status === 400 && r.data?.code === 'E_REASON_REQUIRED', 'edit without reason → 400', r.data);
    r = await api('POST', `/api/opening-stock/${doc1.id}/rolls-amend`, { reason: 'اصلاح متراژ', lines: [LINE] }, 'sales');
    ok(r.status === 403, 'sales cannot edit', r.data);
    const EDIT_ROLLS = [
      { roll_no: 'P7-R1', color: 'مشکی', width_cm: 150, entry_qty: 45.72, weight_kg: 20 },
      { roll_no: 'P7-E2', color: 'قرمز', width_cm: 150, entry_qty: 9.144 },
    ];
    r = await api('POST', `/api/opening-stock/${doc1.id}/rolls-amend`, { reason: 'اصلاح متراژ', lines: [{ ...LINE, unit_cost_rial: 1200000, rolls: EDIT_ROLLS }] });
    ok(r.status === 200 && r.data?.status === 'draft' && r.data?.amends_doc_id === doc1.id && r.data?.voided_doc?.status === 'void', 'edit → old doc void + new draft (amends_doc_id)', r.data);
    const doc2 = r.data;
    ok(whQty(PY, whRAW) === 0 && n3(q1('SELECT stock FROM products WHERE id=?', PY).stock) === 0, 'edit reversed stock to 0');
    ok(qa("SELECT status FROM inventory_ledger WHERE source_type='opening_stock_doc' AND source_id=? AND event_type='opening'", doc1.id).every((x) => x.status === 'reversed'), 'old opening kardex rows reversed');
    ok(count("SELECT COUNT(*) AS c FROM inventory_ledger WHERE source_type='opening_stock_doc' AND source_id=? AND event_type='reversal'", doc1.id) === 3, '3 reversal kardex rows (one per roll)');
    ok(qa("SELECT status, qty_on_hand FROM inventory_batches WHERE source_type='opening_stock_doc' AND source_id=?", doc1.id).every((b) => b.status === 'reversed' && Number(b.qty_on_hand) === 0), 'old batches reversed, on-hand 0');
    ok(batches.every((b) => n3(FR.liveBatchMeters(db, b.id)) === 0), 'old rolls live balance 0');
    ok(!jeLive(posted1.je_id), 'old JE reversed');
    ok(q1('SELECT status FROM product_opening_stock WHERE product_id=? AND warehouse_id=? ORDER BY id DESC LIMIT 1', PY, whRAW)?.status === 'void', 'product_opening_stock row void');
    ok(count("SELECT COUNT(*) AS c FROM audit_log WHERE entity='opening_stock_doc' AND action='void' AND entity_id=?", doc1.id) === 1
      && count("SELECT COUNT(*) AS c FROM audit_log WHERE entity='opening_stock_doc' AND action='update' AND entity_id=?", doc2.id) === 1, 'edit audited (void old + update new)');
    r = await api('POST', `/api/opening-stock/${doc2.id}/post`, null, 'adminB');
    ok(r.status === 200 && r.data?.status === 'posted', 'amended doc posts', r.data);
    const posted2 = r.data;
    ok(whQty(PY, whRAW) === 60 && n3(posted2.lines[0].qty) === 60, 'new opening 50+10 = 60 yd', whQty(PY, whRAW));
    const reusedNew = q1("SELECT * FROM inventory_batches WHERE source_type='opening_stock_doc' AND source_id=? AND batch_no='P7-R1'", doc2.id);
    const reusedOld = q1('SELECT * FROM inventory_batches WHERE id=?', batches[0].id);
    ok(reusedNew && reusedNew.status === 'active' && n3(reusedNew.qty_received) === 50
      && reusedOld.status === 'reversed' && reusedOld.batch_no === `P7-R1~${doc1.doc_no}`,
    'edit re-uses physical roll no P7-R1; reversed old batch gets archive label', { reusedNew, old: reusedOld && reusedOld.batch_no });
    const TOTAL2 = Math.round(1200000 * 45.72) + Math.round(1200000 * 9.144);
    ok(jeLines(posted2.je_id).filter((x) => x.account_code === '3102').reduce((a, x) => a + Math.round(x.credit_rial || 0), 0) === TOTAL2, 'new JE Cr 3102 = new value', TOTAL2);

    // ── 6. cancel: blocked when consumed, then full reverse ──
    console.log('\n— cancel (R13) —');
    const b2 = qa("SELECT * FROM inventory_batches WHERE source_type='opening_stock_doc' AND source_id=? ORDER BY id", doc2.id);
    ok(b2.length === 2, 'amended doc has 2 batches');
    const issue = L.postInventoryMovement(db, { eventType: 'issue', productId: PY, warehouseId: whRAW, qtyOut: 5, batchId: b2[0].id, sourceType: 'test', sourceId: 1, date: todayJalali(), createdBy: adminA });
    const ledN = count('SELECT COUNT(*) AS c FROM inventory_ledger');
    r = await api('POST', `/api/opening-stock/${doc2.id}/void`, { reason: 'تست' }, 'adminA');
    ok(r.status === 409 && r.data?.code === 'E_FABRIC_CONSUMED', 'void blocked while a roll is consumed → 409 E_FABRIC_CONSUMED', r.data);
    ok(q1('SELECT status FROM opening_stock_docs WHERE id=?', doc2.id).status === 'posted' && count('SELECT COUNT(*) AS c FROM inventory_ledger') === ledN && jeLive(posted2.je_id), 'blocked void changed nothing');
    L.reverseInventoryMovement(db, issue.id, { createdBy: adminA, note: 'برگشت مصرف تست' });
    err = null;
    try { OS.voidDoc(db, doc2.id, { id: salesId, role: 'warehouse' }, { reason: 'x' }); } catch (e) { err = e; }
    ok(err && err.code === 'E_PERMISSION', 'lib: void of rolls doc by non-admin/accounting → E_PERMISSION', err && err.code);
    r = await api('POST', `/api/opening-stock/${doc2.id}/void`, { reason: 'انصراف' }, 'acct');
    ok(r.status === 200 && r.data?.status === 'void', 'accounting voids', r.data);
    ok(whQty(PY, whRAW) === 0 && n3(q1('SELECT stock FROM products WHERE id=?', PY).stock) === 0, 'stock back to 0');
    ok(qa("SELECT status FROM inventory_batches WHERE source_type='opening_stock_doc' AND source_id=?", doc2.id).every((b) => b.status === 'reversed'), 'batches reversed');
    ok(!jeLive(posted2.je_id), 'JE reversed');
    ok(qa('SELECT active FROM opening_stock_lines WHERE doc_id=?', doc2.id).every((x) => Number(x.active) === 0), 'line released (active=0)');
    r = await api('POST', '/api/opening-stock/rolls', { lines: [{ ...LINE, rolls: [{ ...ROLLS[0], roll_no: 'P7-N1' }] }] });
    ok(r.status === 200, 'after void the combo accepts a new opening', r.data);
    r = await api('POST', `/api/opening-stock/${r.data.id}/void`, { reason: 'پاکسازی' }, 'acct');
    ok(r.status === 200 && r.data?.status === 'void', 'draft void (status only)');
    ok(count('SELECT COUNT(*) AS c FROM opening_stock_docs') >= 3, 'docs kept physically (no hard delete)');

    // ── 7. attributed material (no uom conversion, product unit) ──
    console.log('\n— attributed material batches —');
    r = await api('POST', '/api/opening-stock/rolls', { lines: [{ product_id: PATTR, warehouse_id: whRAW, profile: 'attr', unit_cost_rial: 500, rolls: [{ roll_no: 'P7-B1', qty: 100 }, { roll_no: 'P7-B2', qty: 40, color: 'طلایی' }] }] });
    ok(r.status === 200 && n3(r.data?.lines?.[0]?.qty) === 140 && r.data.lines[0].profile === 'attr', 'attr lots: qty in product unit (140)', r.data);
    r = await api('POST', `/api/opening-stock/${r.data.id}/post`, null, 'adminB');
    ok(r.status === 200 && whQty(PATTR, whRAW) === 140 && qa("SELECT kind FROM inventory_batches WHERE product_id=?", PATTR).every((b) => b.kind === 'attr'), 'attr lots posted as kind=attr', r.data);

    // ── 8. legacy paths ──
    console.log('\n— legacy opening paths —');
    const OP = require('../lib/opening-post');
    const baseUnvalued = unvaluedOpenings();
    ok(baseUnvalued === 0, 'no unvalued opening kardex rows so far', baseUnvalued);
    const PLEG = insert('products', { user_id: adminA, name: 'کالای قدیمی P7', code: 'P7-LEG', price: 0, cost: 0, stock: 0, unit: 'عدد', average_cost_rial: 0, warehouse_id: whFG });
    db.prepare('UPDATE products SET stock=5 WHERE id=?').run(PLEG);
    db.prepare('INSERT OR REPLACE INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,5)').run(PLEG, whFG);
    const ledBefore = count('SELECT COUNT(*) AS c FROM inventory_ledger');
    db.prepare("DELETE FROM settings WHERE key='opening_inventory_ledger_backfill_v1'").run();
    const bf = OP.backfillOpeningInventoryLedger(db);
    ok(bf.report_only === true && count('SELECT COUNT(*) AS c FROM inventory_ledger') === ledBefore, 'boot backfill is report-only (0 rows)', bf);
    const gaps = OP.reconcileInventoryLedgerGaps(db);
    ok(gaps.report_only === true && gaps.count === 0 && gaps.gap_count >= 1 && count('SELECT COUNT(*) AS c FROM inventory_ledger') === ledBefore, 'reconcile gaps is report-only (reports the stock without kardex)', gaps);
    const { seedMissingAverageCost } = require('../lib/inventory/seed-avg');
    const jeBefore = count('SELECT COUNT(*) AS c FROM journal_entries');
    const seed = seedMissingAverageCost(db, { productId: PLEG, unitCostRial: 2000, userId: adminA });
    ok(seed.needs_opening_doc === true && !seed.je_id, 'seed-avg: qty without kardex → needs_opening_doc, no JE', seed);
    ok(count('SELECT COUNT(*) AS c FROM inventory_ledger') === ledBefore && count('SELECT COUNT(*) AS c FROM journal_entries') === jeBefore, 'seed-avg wrote no kardex row / JE');
    ok(Number(q1('SELECT average_cost_rial AS a FROM products WHERE id=?', PLEG).a) === 2000, 'seed-avg still sets average cost');
    const rebuildSrc = fs.readFileSync(path.join(__dirname, 'rebuild-product-docs.js'), 'utf8');
    ok(!/postInventoryMovement|postProductOpeningInventory|INSERT INTO warehouse_moves/.test(rebuildSrc) && /opening_gaps/.test(rebuildSrc), 'rebuild-product-docs: no opening kardex/receipt/JE writers, reports opening_gaps');
    ok(unvaluedOpenings() === 0, 'legacy paths created no unvalued opening kardex rows');

    // rebuild-product-docs end-to-end on this DB (child process)
    server.close();
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) { /* */ }
    const ledgerBeforeRebuild = count('SELECT COUNT(*) AS c FROM inventory_ledger');
    const openingJeBefore = count("SELECT COUNT(*) AS c FROM journal_entries WHERE ref_type='opening_inventory'");
    let rebuildOut = '';
    try {
      rebuildOut = execFileSync(process.execPath, [path.join(__dirname, 'rebuild-product-docs.js'), '--confirm=REBUILD-PRODUCT-DOCS'], {
        env: { ...process.env, DB_PATH }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
      });
    } catch (e) { rebuildOut = String(e.stdout || '') + String(e.stderr || e.message); }
    ok(/opening_gaps/.test(rebuildOut) && /P7-LEG/.test(rebuildOut), 'rebuild-product-docs ran and reported the gap', rebuildOut.slice(-400));
    ok(count('SELECT COUNT(*) AS c FROM inventory_ledger') === ledgerBeforeRebuild && count("SELECT COUNT(*) AS c FROM journal_entries WHERE ref_type='opening_inventory'") === openingJeBefore, 'rebuild-product-docs wrote no kardex / opening JE');
    ok(unvaluedOpenings() === 0, 'still no unvalued opening kardex rows');
  } finally {
    try { server.close(); } catch (_) { /* */ }
  }
}

main().then(() => {
  console.log(`\nP7 opening rolls: ${pass} passed, ${fail} failed`);
  try { db.close(); } catch (_) { /* */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* */ }
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
