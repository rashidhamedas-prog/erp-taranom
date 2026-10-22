'use strict';
/**
 * v525 — closed inventory month: more ordinary operations post normally (qty + document JE)
 * and park their rial value effect in ONE closed_period approval doc per source document.
 *  A) covered cutting-lay amend/void (cutting_lay_fg_delta)
 *  B) order receipt align (order_cost_receipt_align)
 *  C) sales return (enters at pool avg; difference vs original issue cost parked)
 *  D) warehouse docs: closed-month receipt doc → one doc for all lines; inbound transfer into
 *     another pool enters at the destination avg, difference parked
 * Each: no 422, reason closed_period, GL balanced, inventory GL = stock value,
 * approve (original / next_open), reject, reopen, reversing the source cancels the doc.
 * Run: node server/scripts/test-closed-month-gates-v525.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closed-gates-v525-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(dir, 't.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.JWT_SECRET = 'test-closed-month-gates-v525-secret-32b';
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';

let passed = 0;
let failed = 0;
function ok(c, m, extra) {
  if (c) { passed++; console.log('  OK', m); }
  else { failed++; console.error('  FAIL', m, extra !== undefined ? JSON.stringify(extra) : ''); }
}
function attempt(fn) {
  try { return { value: fn(), error: null }; } catch (e) { return { value: null, error: e }; }
}

let db;
try {
  const { initDB, getDB } = require('../db');
  initDB();
  db = getDB();
} catch (e) {
  console.log('SKIP — better-sqlite3 در دسترس نیست:', e.message);
  process.exit(0);
}

const L = require('../lib/inventory/ledger');
const PL = require('../lib/inventory/period-lock');
const VA = require('../lib/inventory/value-accounts');
const VAP = require('../lib/inventory/value-approval');
const { acct, rebuildBaseCoa } = require('../lib/coa-map');
const { postToLedger } = require('../lib/ledger');

if (!db.prepare('SELECT COUNT(*) c FROM chart_of_accounts').get().c) rebuildBaseCoa(db);
require('../lib/inventory/valuation').ensureValuationSchema(db);

const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get()
  || db.prepare('SELECT * FROM users ORDER BY id LIMIT 1').get();
const uid = admin.id;
const user = { id: uid, role: 'admin' };
const clearing = VA.clearingAccount(db);
const variance = VA.priceVarianceAccount(db);
const fgAcc = acct(db, 'coa_finished_goods');
const cogsAcc = acct(db, 'coa_cogs');
const wipAcc = acct(db, 'coa_wip');

function acctBal(code) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(jl.debit),0) - COALESCE(SUM(jl.credit),0) b
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
  `).get(code);
  return Math.round((Number(r && r.b) || 0) * 10);
}
function jeBalanced(jeId) {
  const r = db.prepare('SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM journal_lines WHERE entry_id=?').get(jeId);
  return Math.abs((r.d || 0) - (r.c || 0)) < 0.01 && r.d > 0;
}
function allJesBalanced() {
  const bad = db.prepare(`
    SELECT je.id FROM journal_entries je JOIN journal_lines jl ON jl.entry_id=je.id
    GROUP BY je.id HAVING ABS(SUM(jl.debit) - SUM(jl.credit)) > 0.01
  `).all();
  return bad.length === 0;
}
function stockValue(productIds) {
  const ids = productIds.map(Number);
  return Math.round(db.prepare(`SELECT COALESCE(SUM(value_rial),0) v FROM inventory_valuation_buckets WHERE product_id IN (${ids.map(() => '?').join(',')})`).get(...ids).v || 0);
}
function liveDocs(sourceType, sourceId) {
  return db.prepare(`
    SELECT * FROM inventory_value_approvals WHERE source_type=? AND source_id=? AND status IN ('pending','approved','rejected') ORDER BY id
  `).all(sourceType, sourceId);
}
function allDocs(sourceType, sourceId) {
  return db.prepare('SELECT * FROM inventory_value_approvals WHERE source_type=? AND source_id=? ORDER BY id').all(sourceType, sourceId);
}
function mkWarehouse(name, level = null, type = 'finished_goods') {
  const id = db.prepare('INSERT INTO warehouses (name, warehouse_type) VALUES (?, ?)').run(name, type).lastInsertRowid;
  if (level) db.prepare('UPDATE warehouses SET valuation_level=? WHERE id=?').run(level, id);
  return Number(id);
}
function mkProduct(code) {
  return Number(db.prepare(`
    INSERT INTO products (user_id,name,code,stock,average_cost_rial,cost,unit) VALUES (?,?,?,0,0,0,'عدد')
  `).run(uid, `کالا ${code}`, code).lastInsertRowid);
}
function postJe(sourceType, sourceId, date, dr, cr, rial, desc) {
  return postToLedger(db, {
    sourceType, sourceId, date, description: desc || sourceType, createdBy: uid,
    lines: [
      { code: dr.code, name: dr.name, debit: rial / 10, credit: 0 },
      { code: cr.code, name: cr.name, debit: 0, credit: rial / 10 },
    ],
  });
}

/** GL inventory (given accounts) moves exactly with the stock value of the given products. */
function glGuard(label, codes, productIds) {
  const g0 = () => codes.reduce((s, c) => s + acctBal(c), 0);
  const base = { gl: g0(), val: stockValue(productIds) };
  return (step) => {
    const dg = g0() - base.gl;
    const dv = stockValue(productIds) - base.val;
    ok(dg === dv, `${label} ${step}: inventory GL Δ = stock value Δ (${dg} vs ${dv})`);
  };
}

/** approve original → reopen → approve next_open → reopen → reject → reopen (pending). */
function decisionCycle(label, docId, { check, nextOpen }) {
  const clr0 = acctBal(clearing.code);
  const var0 = acctBal(variance.code);
  let a = VAP.approve(db, docId, user, { post_date_mode: 'original' });
  ok(a.status === 'approved' && a.post_date_mode === 'original' && a.decision_date === a.date, `${label}: approve original dated ${a.date}`, { s: a.status, d: a.decision_date });
  ok(jeBalanced(a.decision_je_id), `${label}: decision JE balanced`);
  ok(acctBal(clearing.code) - clr0 === -a.total_delta_rial, `${label}: approve clears the parked amount`, { clr: acctBal(clearing.code) - clr0, t: a.total_delta_rial });
  check('approve original');
  a = VAP.reopen(db, docId, user, { reason: 'بازبینی' });
  ok(a.status === 'pending' && acctBal(clearing.code) === clr0, `${label}: reopen → pending, clearing restored`);
  check('reopen');
  a = VAP.approve(db, docId, user, { post_date_mode: 'next_open' });
  ok(a.status === 'approved' && a.decision_date === nextOpen, `${label}: approve next_open → ${nextOpen}`, { d: a.decision_date });
  check('approve next_open');
  VAP.reopen(db, docId, user, { reason: 'تست رد' });
  a = VAP.reject(db, docId, user, {});
  ok(a.status === 'rejected' && acctBal(variance.code) - var0 === a.total_delta_rial, `${label}: reject → «انحراف بها»`, { v: acctBal(variance.code) - var0 });
  check('reject');
  a = VAP.reopen(db, docId, user, { reason: 'برگشت رد' });
  ok(a.status === 'pending' && acctBal(variance.code) === var0 && acctBal(clearing.code) === clr0, `${label}: reopen reject → pending`);
}

console.log('\n══ v525 closed-month value gates ══\n');

// ── D) warehouse docs: grouped receipt + inbound transfer ──────────────────
{
  console.log('[D] warehouse docs');
  const WD = require('../lib/warehouse-docs');
  const WA = mkWarehouse('انبار الف v525', 'warehouse');
  const WB = mkWarehouse('انبار ب v525', 'warehouse');
  const p1 = mkProduct('WD-1');
  const p2 = mkProduct('WD-2');
  const invCodes = [...new Set([L.inventoryAccountForWarehouse(db, WA).code, L.inventoryAccountForWarehouse(db, WB).code])];
  const guard = glGuard('WD', invCodes, [p1, p2]);
  WD.createWarehouseDoc(db, { type: 'receipt', warehouse_id: WA, date: '1405/04/02', lines: [
    { product_id: p1, qty: 10, unit_cost_rial: 100 }, { product_id: p2, qty: 10, unit_cost_rial: 300 }] }, user);
  WD.createWarehouseDoc(db, { type: 'receipt', warehouse_id: WB, date: '1405/04/02', lines: [
    { product_id: p1, qty: 10, unit_cost_rial: 200 }, { product_id: p2, qty: 10, unit_cost_rial: 500 }] }, user);
  guard('opening receipts');
  PL.closePeriod(db, '1405/04', user, { reason: 'بستن تیر' });
  const clr0 = acctBal(clearing.code);

  // D1) closed-month receipt doc with two lines → ONE approval doc
  const r1 = attempt(() => WD.createWarehouseDoc(db, { type: 'receipt', warehouse_id: WA, date: '1405/04/15', lines: [
    { product_id: p1, qty: 5, unit_cost_rial: 400 }, { product_id: p2, qty: 5, unit_cost_rial: 100 }] }, user));
  ok(!r1.error && r1.value && r1.value.id, 'closed-month receipt doc posts (no 422)', r1.error && r1.error.message);
  const docs1 = liveDocs('warehouse_doc', r1.value.id);
  ok(docs1.length === 1 && docs1[0].reason === 'closed_period', 'receipt doc → exactly ONE closed_period approval doc', docs1.map((d) => d.id));
  const full1 = VAP.get(db, docs1[0].id);
  // p1: 5×400=2000 vs pool 100 → +1500; p2: 5×100=500 vs pool 300 → −1000
  ok(full1.lines.length === 2 && full1.total_delta_rial === 500, 'two lines, total +1500−1000 = 500', { n: full1.lines.length, t: full1.total_delta_rial });
  ok(acctBal(clearing.code) - clr0 === 500, 'clearing holds 500');
  guard('closed receipt');
  ok(db.prepare("SELECT COUNT(*) c FROM inventory_value_approvals WHERE source_type='receipt:warehouse_move'").get().c === 0, 'no per-row receipt:warehouse_move docs any more');
  decisionCycle('WD receipt', docs1[0].id, { check: guard, nextOpen: '1405/05/01' });
  WD.voidWarehouseDoc(db, r1.value.id, user, { reason: 'ابطال تست' });
  ok(VAP.get(db, docs1[0].id).status === 'cancelled' && acctBal(clearing.code) === clr0, 'void receipt doc → approval cancelled, clearing back');
  guard('void receipt');

  // D1b) a decided doc is undone when the source is voided
  const r1b = WD.createWarehouseDoc(db, { type: 'receipt', warehouse_id: WA, date: '1405/04/16', lines: [
    { product_id: p1, qty: 2, unit_cost_rial: 300 }] }, user);
  const d1b = liveDocs('warehouse_doc', r1b.id)[0];
  VAP.approve(db, d1b.id, user, {});
  guard('approved receipt');
  WD.voidWarehouseDoc(db, r1b.id, user, { reason: 'ابطال پس از تأیید' });
  ok(VAP.get(db, d1b.id).status === 'cancelled' && acctBal(clearing.code) === clr0, 'void after approve → decision undone, doc cancelled');
  guard('void approved receipt');

  // D2) transfer A → B (separate pools) in the closed month
  const b1 = () => db.prepare('SELECT * FROM inventory_valuation_buckets WHERE product_id=? AND warehouse_id=?').get(p1, WB);
  const t = attempt(() => WD.createWarehouseDoc(db, { type: 'transfer', from_warehouse_id: WA, to_warehouse_id: WB, date: '1405/04/20', lines: [
    { product_id: p1, qty: 4 }, { product_id: p2, qty: 4 }] }, user));
  ok(!t.error && t.value && t.value.id, 'closed-month transfer posts (no 422)', t.error && t.error.message);
  const tdocs = liveDocs('warehouse_doc', t.value.id);
  ok(tdocs.length === 1 && tdocs[0].reason === 'closed_period', 'transfer → ONE closed_period doc', tdocs.length);
  const tfull = VAP.get(db, tdocs[0].id);
  // p1: out 4×100=400, B avg 200 → in 800, park −400; p2: 4×300=1200, B avg 500 → 2000, park −800
  ok(tfull.lines.length === 2 && tfull.total_delta_rial === -1200, 'transfer lines −400 / −800 (total −1200)', { t: tfull.total_delta_rial, n: tfull.lines.length });
  ok(Math.round(b1().avg_rial) === 200 && Number(b1().qty) === 14, 'destination pool avg unchanged (14 @ 200)', b1());
  guard('closed transfer');
  ok(allJesBalanced(), 'all JEs balanced');
  decisionCycle('WD transfer', tdocs[0].id, { check: guard, nextOpen: '1405/05/01' });
  VAP.approve(db, tdocs[0].id, user, { post_date_mode: 'original' });
  ok(Math.round(Number(b1().value_rial)) === 14 * 200 - 400, 'approved: destination pool absorbs −400', b1());
  WD.voidWarehouseDoc(db, t.value.id, user, { reason: 'ابطال انتقال' });
  ok(VAP.get(db, tdocs[0].id).status === 'cancelled' && acctBal(clearing.code) === clr0, 'void transfer → decision undone + cancelled, clearing back');
  ok(Number(b1().qty) === 10 && Math.round(Number(b1().value_rial)) === 2000, 'destination back to 10 @ 200', b1());
  guard('void transfer');

  // D3) same shared pool → nothing to park
  const S1 = mkWarehouse('مشترک ۱ v525');
  const S2 = mkWarehouse('مشترک ۲ v525');
  const p3 = mkProduct('WD-3');
  PL.reopenPeriod(db, '1405/04', user, { reason: 'تنظیم' });
  WD.createWarehouseDoc(db, { type: 'receipt', warehouse_id: S1, date: '1405/04/03', lines: [{ product_id: p3, qty: 10, unit_cost_rial: 100 }] }, user);
  PL.closePeriod(db, '1405/04', user, { reason: 'بستن مجدد' });
  const t3 = WD.createWarehouseDoc(db, { type: 'transfer', from_warehouse_id: S1, to_warehouse_id: S2, date: '1405/04/21', lines: [{ product_id: p3, qty: 3 }] }, user);
  ok(liveDocs('warehouse_doc', t3.id).length === 0, 'transfer inside one shared pool → no approval doc');
  PL.reopenPeriod(db, '1405/04', user, { reason: 'پایان تست' });
}

// ── C) sales return ─────────────────────────────────────────────────────────
{
  console.log('\n[C] sales return');
  const SR = require('../lib/sales-return-doc');
  const W = mkWarehouse('انبار فروش v525');
  const p = mkProduct('SR-1');
  const inv = L.inventoryAccountForWarehouse(db, W);
  const ap = acct(db, 'coa_grni');
  const guard = glGuard('SR', [inv.code], [p]);
  const custId = Number(db.prepare("INSERT INTO customers (user_id,biz,owner,status) VALUES (?,'مشتری v525','مالک','active')").run(uid).lastInsertRowid);
  const buy = (qty, unit, date, sid) => {
    L.postInventoryMovement(db, { eventType: 'purchase', productId: p, warehouseId: W, qtyIn: qty, unitCostRial: unit, sourceType: 'purchase', sourceId: sid, date, createdBy: uid });
    postJe('test_purchase', sid, date, inv, ap, qty * unit);
  };
  buy(10, 1000, '1405/05/02', 52501);
  const invId = Number(db.prepare(`
    INSERT INTO invoices (user_id,cust_id,num,type,date,rows,subtotal,final) VALUES (?,?,?,?,?,?,?,?)
  `).run(uid, custId, 'T-V525', 'normal', '1405/05/03', JSON.stringify([{ product_id: p, name: 'کالا SR-1', qty: 4, price: 5000, warehouse_id: W }]), 20000, 20000).lastInsertRowid);
  const sale = L.postInventoryMovement(db, { eventType: 'sale', productId: p, warehouseId: W, qtyOut: 4, sourceType: 'invoice', sourceId: invId, date: '1405/05/03', createdBy: uid });
  postJe('test_cogs', invId, '1405/05/03', cogsAcc, inv, sale.amount_rial);
  buy(10, 2000, '1405/05/25', 52502);
  guard('setup');
  PL.closePeriod(db, '1405/05', user, { reason: 'بستن مرداد' });
  const clr0 = acctBal(clearing.code);
  const avg = () => Math.round(Number(db.prepare('SELECT average_cost_rial a FROM products WHERE id=?').get(p).a) || 0);
  ok(avg() === 1625, `pool avg before return 1625 (got ${avg()})`);

  const r = attempt(() => SR.createSalesReturn(db, { cust_id: custId, invoice_id: invId, date: '1405/05/20', rows: [{ product_id: p, qty: 2 }] }, user));
  ok(!r.error && r.value && r.value.id, 'closed-month sales return posts (no 422)', r.error && r.error.message);
  const retId = r.value.id;
  const docs = liveDocs('receipt:sales_return', retId);
  ok(docs.length === 1 && docs[0].reason === 'closed_period', 'sales return → ONE closed_period doc', docs.length);
  // doc cost = original issue 2×1000 = 2000; pool 2×1625 = 3250 → −1250 parked
  ok(docs[0].total_delta_rial === -1250, 'difference vs original issue cost parked (−1250)', docs[0].total_delta_rial);
  ok(avg() === 1625, `avg unchanged (got ${avg()})`);
  const ret = db.prepare('SELECT cost_amount FROM sales_returns WHERE id=?').get(retId);
  ok(Math.round(Number(ret.cost_amount)) === 2000, 'return COGS reversal at original issue cost 2000', ret);
  ok(acctBal(clearing.code) - clr0 === -1250, 'clearing −1250');
  guard('closed return');
  ok(allJesBalanced(), 'all JEs balanced');
  decisionCycle('SR', docs[0].id, { check: guard, nextOpen: '1405/06/01' });

  // amend (R13 reverse + repost) → old doc cancelled, one new live doc
  const a = attempt(() => SR.updateSalesReturn(db, retId, { date: '1405/05/20', rows: [{ product_id: p, qty: 3 }] }, user));
  ok(!a.error, 'amend in closed month posts', a.error && a.error.message);
  const after = liveDocs('receipt:sales_return', retId);
  ok(VAP.get(db, docs[0].id).status === 'cancelled' && after.length === 1 && after[0].total_delta_rial === 3000 - 3 * 1625,
    'amend → previous doc cancelled, one new doc (−1875)', { live: after.map((d) => d.total_delta_rial) });
  guard('amend');
  VAP.approve(db, after[0].id, user, { post_date_mode: 'original' });
  guard('approve after amend');
  SR.voidSalesReturn(db, retId, user);
  ok(VAP.get(db, after[0].id).status === 'cancelled' && acctBal(clearing.code) === clr0, 'void return → decision undone, doc cancelled, clearing back');
  ok(Number(db.prepare('SELECT stock FROM products WHERE id=?').get(p).stock) === 16 && stockValue([p]) === 16 * 1625 && Math.abs(avg() - 1625) <= 1,
    'stock 16, pool value 26000 after void (header avg ±1 rounding)',
    { stock: db.prepare('SELECT stock FROM products WHERE id=?').get(p).stock, avg: avg(), v: stockValue([p]) });
  guard('void');
  PL.reopenPeriod(db, '1405/05', user, { reason: 'پایان تست' });
}

// ── B) order receipt align ──────────────────────────────────────────────────
{
  console.log('\n[B] order cost reconcile');
  const OCR = require('../lib/production/order-cost-reconcile');
  const fgWh = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get().id;
  const rawWh = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get().id;
  const p = mkProduct('OCR-FG');
  const guard = glGuard('OCR', [fgAcc.code], [p]);
  const poId = Number(db.prepare(`
    INSERT INTO production_orders (order_no, product_id, qty_planned, date, status, analysis_type, material_cost_rial, abnormal_waste_rial)
    VALUES ('PO-V525', ?, 96, '1405/03/05', 'completed', 'fixed_adv', 100000, 20000)
  `).run(p).lastInsertRowid);
  db.prepare(`
    INSERT INTO production_material_issues (order_id, product_id, issue_type, qty_actual, unit_cost_rial, amount_rial, warehouse_id, date, status, note)
    VALUES (?,?, 'cutting_lay', 1, 100000, 100000, ?, '1405/03/05', 'posted', 'LAY-V525')
  `).run(poId, p, rawWh);
  const layId = Number(db.prepare(`
    INSERT INTO cutting_lays (lay_no, product_id, marker_length_m, ply_count, date, status, waste_amount_rial, production_order_id, amount_rial)
    VALUES ('LAY-V525', ?, 1, 1, '1405/03/05', 'posted', 20000, ?, 100000)
  `).run(p, poId).lastInsertRowid);
  db.prepare(`
    INSERT INTO production_receipts (order_id, product_id, qty, unit_cost_rial, amount_rial, warehouse_id, date, status)
    VALUES (?,?,96,1042,100000,?,'1405/03/05','posted')
  `).run(poId, p, fgWh);
  L.postInventoryMovement(db, { eventType: 'production_receipt', productId: p, warehouseId: fgWh, qtyIn: 96, amountRial: 100000, sourceType: 'production_receipt', sourceId: poId, date: '1405/03/05', createdBy: uid });
  postJe('test_prd_receipt', poId, '1405/03/05', fgAcc, wipAcc, 100000);
  const sold = L.postInventoryMovement(db, { eventType: 'sale', productId: p, warehouseId: fgWh, qtyOut: 16, sourceType: 'invoice', sourceId: 52599, date: '1405/03/06', createdBy: uid });
  postJe('test_cogs', 52599, '1405/03/06', cogsAcc, fgAcc, sold.amount_rial);
  guard('setup');
  PL.closePeriod(db, '1405/03', user, { reason: 'بستن خرداد' });
  const clr0 = acctBal(clearing.code);
  const avg = () => Math.round(Number(db.prepare('SELECT average_cost_rial a FROM products WHERE id=?').get(p).a) || 0);
  const avg0 = avg();

  const r = attempt(() => OCR.reconcileOrderCosts(db, poId, { mode: 'auto', userId: uid }));
  ok(!r.error && r.value && r.value.receipt_delta_rial === -20000, 'closed-month receipt align posts (no 422), gap −20000', r.error ? r.error.message : r.value && r.value.receipt_delta_rial);
  const docs = liveDocs('order_cost_receipt_align', poId);
  ok(docs.length === 1 && docs[0].reason === 'closed_period' && docs[0].total_delta_rial === -20000, 'ONE closed_period doc −20000', docs.map((d) => d.total_delta_rial));
  ok(r.value && r.value.value_approval_id === docs[0].id, 'result carries value_approval_id');
  ok(avg() === avg0, 'FG avg unchanged while pending');
  ok(acctBal(clearing.code) - clr0 === -20000, 'clearing −20000');
  ok(Math.round(db.prepare('SELECT amount_rial FROM production_receipts WHERE order_id=?').get(poId).amount_rial) === 80000, 'receipt document amount aligned to 80000');
  guard('closed align');
  ok(allJesBalanced(), 'all JEs balanced');
  decisionCycle('OCR', docs[0].id, { check: guard, nextOpen: '1405/04/01' });
  const cogs0 = acctBal(cogsAcc.code);
  VAP.approve(db, docs[0].id, user, {});
  ok(acctBal(cogsAcc.code) - cogs0 === -3333, 'approve: sold share (16/96) → COGS −3333', acctBal(cogsAcc.code) - cogs0);
  guard('approved');

  // re-run after a document change in the closed month → previous doc cancelled + carried
  db.prepare('UPDATE cutting_lays SET waste_amount_rial=30000 WHERE id=?').run(layId);
  const r2 = attempt(() => OCR.reconcileOrderCosts(db, poId, { mode: 'auto', userId: uid }));
  ok(!r2.error, 're-align in closed month posts', r2.error && r2.error.message);
  const live2 = liveDocs('order_cost_receipt_align', poId);
  ok(VAP.get(db, docs[0].id).status === 'cancelled' && live2.length === 1 && live2[0].total_delta_rial === -30000,
    'previous (approved) doc undone + cancelled; one live doc −30000', live2.map((d) => d.total_delta_rial));
  ok(acctBal(clearing.code) - clr0 === -30000, 'clearing −30000');
  guard('re-align closed');

  // month reopened: next align applies the carried change immediately
  PL.reopenPeriod(db, '1405/03', user, { reason: 'بازگشایی' });
  db.prepare('UPDATE cutting_lays SET waste_amount_rial=25000 WHERE id=?').run(layId);
  OCR.reconcileOrderCosts(db, poId, { mode: 'auto', userId: uid });
  ok(liveDocs('order_cost_receipt_align', poId).length === 0 && acctBal(clearing.code) === clr0, 'open month: carried change applied, no live doc, clearing back');
  guard('open re-align');
  ok(allJesBalanced(), 'all JEs balanced');
}

// ── A) covered cutting-lay amend / void ─────────────────────────────────────
{
  console.log('\n[A] cutting covered lay');
  const C = require('../lib/production/cutting');
  const { receiveFabricRoll } = require('../lib/inventory/fabric-rolls');
  const { postEvent, dr, cr } = require('../lib/production/posting');
  const raw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get();
  const fgWh = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get();
  const fgId = Number(db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, is_manufactured, item_type)
    VALUES (?, 'مانتو v525', 'V525-FG', 0, 0, 'عدد', 1, 'finished')
  `).run(uid).lastInsertRowid);
  const fabId = Number(db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, average_cost_rial, item_type)
    VALUES (?, 'کرپ v525', 'V525-FAB', 0, 0, 'متر', 200000, 'raw')
  `).run(uid).lastInsertRowid);
  const supId = Number(db.prepare("INSERT INTO suppliers (name) VALUES ('نساجی v525')").run().lastInsertRowid);
  const roll = receiveFabricRoll(db, {
    product_id: fabId, warehouse_id: raw.id, color: 'مشکی', meters: 50, unit: 'متر',
    unit_cost_rial: 200000, supplier_id: supId, roll_no: 'R-V525', date: '1405/06/10', idempotency_key: 'v525-roll',
  }, user);
  const bomLib = require('../lib/production/bom');
  const bom = bomLib.createBom(db, { product_id: fgId, name: 'BOM v525', base_qty: 1, yield_percent: 100 }, uid);
  bomLib.addLine(db, bom.id, {
    component_product_id: fabId, qty_per_base: 1.5, scrap_percent: 0,
    line_type: 'material', size_matrix: JSON.stringify({ '38': 1.5, '40': 1.5 }),
  }, uid);
  try {
    db.prepare("INSERT INTO product_sizes (name, code, active, sort_order) VALUES ('38','38',1,1)").run();
    db.prepare("INSERT INTO product_sizes (name, code, active, sort_order) VALUES ('40','40',1,2)").run();
  } catch (_) { /* sizes may exist */ }
  bomLib.activateBom(db, bom.id, '1405/01/01', uid);
  const breakdown = { '38': 2, '40': 2 };
  const lay = C.postCuttingLay(db, {
    product_id: fgId, warehouse_id: raw.id, color: 'مشکی', marker_length_m: 2, ply_count: 3,
    actual_meters: 6, width_cm: 150, size_breakdown: breakdown, rolls: [{ batch_id: roll.id, meters: 6 }],
    date: '1405/06/10', idempotency_key: 'v525-lay',
  }, user);
  const oldNet = Math.max(0, Math.round(Number(lay.amount_rial)) - Math.round(Number(lay.waste_amount_rial) || 0));
  const poId = Number(db.prepare(`
    INSERT INTO production_orders (order_no, product_id, bom_id, analysis_type, qty_planned, qty_produced,
      date, status, material_cost_rial, total_cost_rial, unit_cost_rial, abnormal_waste_rial)
    VALUES ('PO-V525-CUT', ?, ?, 'fixed', 4, 4, '1405/06/10', 'completed', ?, ?, ?, ?)
  `).run(fgId, bom.id, Math.round(Number(lay.amount_rial)), oldNet, Math.round(oldNet / 4), Math.round(Number(lay.waste_amount_rial) || 0)).lastInsertRowid);
  const receiptId = Number(db.prepare(`
    INSERT INTO production_receipts (doc_no, order_id, product_id, output_type, qty, unit_cost_rial, amount_rial, warehouse_id, date, status, created_by)
    VALUES ('PR-V525', ?, ?, 'main', 4, ?, ?, ?, '1405/06/10', 'posted', ?)
  `).run(poId, fgId, Math.round(oldNet / 4), oldNet, fgWh.id, uid).lastInsertRowid);
  db.prepare('UPDATE cutting_lays SET production_order_id=? WHERE id=?').run(poId, lay.id);
  db.prepare(`
    INSERT INTO production_material_issues (doc_no, order_id, product_id, issue_type, qty_actual, qty_standard,
      unit_cost_rial, std_cost_rial, amount_rial, std_amount_rial, warehouse_id, date, status, note, created_by)
    VALUES (?, ?, ?, 'cutting_lay', 6, 6, ?, ?, ?, ?, ?, '1405/06/10', 'posted', ?, ?)
  `).run(lay.lay_no, poId, fabId, 200000, 200000, lay.amount_rial, lay.amount_rial, raw.id, `لایه‌چینی ${lay.lay_no} — مصرف پارچه مرحله برش`, uid);
  L.postInventoryMovement(db, { eventType: 'production_receipt', productId: fgId, warehouseId: fgWh.id, qtyIn: 4, amountRial: oldNet, sourceType: 'production_receipt', sourceId: receiptId, date: '1405/06/10', createdBy: uid });
  postEvent(db, { event: 'PRD-07', sourceId: receiptId, date: '1405/06/10', description: 'رسید تست v525', createdBy: uid,
    lines: [dr(db, 'coa_finished_goods', oldNet), cr(db, 'coa_wip', oldNet)] });
  const sold = L.postInventoryMovement(db, { eventType: 'sale', productId: fgId, warehouseId: fgWh.id, qtyOut: 1, sourceType: 'invoice', sourceId: 52590, date: '1405/06/11', createdBy: uid });
  postJe('test_cogs', 52590, '1405/06/11', cogsAcc, fgAcc, sold.amount_rial);
  const guard = glGuard('CUT', [fgAcc.code], [fgId]);
  PL.closePeriod(db, '1405/06', user, { reason: 'بستن شهریور' });
  const clr0 = acctBal(clearing.code);
  const avg = () => Math.round(Number(db.prepare('SELECT average_cost_rial a FROM products WHERE id=?').get(fgId).a) || 0);
  const avg0 = avg();
  const amendBody = (meters) => ({
    product_id: fgId, warehouse_id: raw.id, color: 'مشکی', marker_length_m: 2, ply_count: 4,
    actual_meters: meters, width_cm: 150, size_breakdown: breakdown, rolls: [{ batch_id: roll.id, meters }],
    production_order_id: poId, date: '1405/06/10', reason: 'اصلاح متر در ماه قفل',
  });

  const a1 = attempt(() => C.updateCuttingLay(db, lay.id, amendBody(8), user));
  ok(!a1.error && a1.value && a1.value.id === lay.id, 'covered lay amend in closed month posts (no 422)', a1.error && (a1.error.code || a1.error.message));
  const net8 = Math.max(0, Math.round(Number(a1.value.amount_rial)) - Math.round(Number(a1.value.waste_amount_rial) || 0));
  const d1 = net8 - oldNet;
  const docs = liveDocs('cutting_lay_fg_delta', lay.id);
  ok(docs.length === 1 && docs[0].reason === 'closed_period' && docs[0].total_delta_rial === d1, `ONE closed_period doc = lay delta ${d1}`, docs.map((d) => d.total_delta_rial));
  ok(avg() === avg0, 'FG avg unchanged while pending');
  ok(acctBal(clearing.code) - clr0 === d1, 'clearing holds the delta');
  ok(Math.round(db.prepare('SELECT amount_rial FROM production_receipts WHERE id=?').get(receiptId).amount_rial) === net8, 'receipt document absorbs the delta');
  const deltaJe = db.prepare("SELECT id FROM journal_entries WHERE ref_type='cutting_lay_fg_delta' AND ref_id=? AND COALESCE(deleted_at,0)=0 ORDER BY id DESC").get(lay.id);
  ok(deltaJe && jeBalanced(deltaJe.id), 'delta JE (Dr clearing / Cr WIP) balanced');
  guard('closed amend');
  ok(allJesBalanced(), 'all JEs balanced');
  decisionCycle('CUT', docs[0].id, { check: guard, nextOpen: '1405/07/01' });
  VAP.approve(db, docs[0].id, user, {});
  ok(avg() !== avg0, 'approved: FG avg moved');
  guard('approved');

  // second amend in the closed month → previous doc undone + cancelled, one live doc with the net change
  const a2 = attempt(() => C.updateCuttingLay(db, lay.id, amendBody(7), user));
  ok(!a2.error, 'second amend posts', a2.error && (a2.error.code || a2.error.message));
  const net7 = Math.max(0, Math.round(Number(a2.value.amount_rial)) - Math.round(Number(a2.value.waste_amount_rial) || 0));
  const live2 = liveDocs('cutting_lay_fg_delta', lay.id);
  ok(VAP.get(db, docs[0].id).status === 'cancelled' && live2.length === 1 && live2[0].total_delta_rial === net7 - oldNet,
    `previous doc cancelled; one live doc = ${net7 - oldNet}`, live2.map((d) => d.total_delta_rial));
  ok(avg() === avg0 && acctBal(clearing.code) - clr0 === net7 - oldNet, 'decision undone: avg back, clearing = net change');
  guard('second amend');

  // void the lay in the closed month → its docs cancelled; the void's own change is a new doc
  const v = attempt(() => C.voidCuttingLay(db, lay.id, user, { reason: 'ابطال تست' }));
  ok(!v.error, 'void covered lay in closed month posts', v.error && (v.error.code || v.error.message));
  const live3 = liveDocs('cutting_lay_fg_delta', lay.id);
  ok(VAP.get(db, live2[0].id).status === 'cancelled' && live3.length === 1 && live3[0].total_delta_rial === -oldNet,
    `void → earlier doc cancelled; one live doc = −original net (${-oldNet})`, live3.map((d) => d.total_delta_rial));
  ok(allDocs('cutting_lay_fg_delta', lay.id).filter((d) => d.status === 'cancelled').length === 2, 'two cancelled docs kept for audit (no physical delete)');
  guard('void');
  ok(allJesBalanced(), 'all JEs balanced');

  // reopen month → reject the void's doc is still possible; then the lay void is fully booked
  PL.reopenPeriod(db, '1405/06', user, { reason: 'پایان تست' });
  VAP.approve(db, live3[0].id, user, {});
  ok(acctBal(clearing.code) === clr0, 'after approving the void doc clearing is back to zero');
  guard('void approved');
}

// ── static wiring ────────────────────────────────────────────────────────────
{
  console.log('\n[static]');
  const root = path.join(__dirname, '..');
  const adr = fs.readFileSync(path.join(root, '..', 'docs', 'architecture', 'INV-VAL-ADR-008-valuation-revaluation-recon.md'), 'utf8');
  ok(/v525/.test(adr), 'ADR-008 has the v525 subsection');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  ok(app.includes('برش پوشش‌داده‌شده') && app.includes('برگشت از فروش') && app.includes('انتقال بین انبار'), 'Help «قفل ماهانه» lists the v525 flows');
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
try { require('../lib/auth-sessions').closeSessionStore(); } catch (_) { /* optional */ }
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* tmp */ }
process.exit(failed ? 1 : 0);
