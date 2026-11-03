'use strict';
/**
 * audit-kardex K2 — assign a warehouse to legacy NULL-warehouse sale_return kardex rows + root-cause guards.
 * Run: node server/scripts/test-audit-kardex-k2.js
 *
 * LEGACY FIXTURES: returns with warehouse_id NULL can no longer be created through createSalesReturn
 * (E_SR_WH_REQUIRED). They are produced by `legacyOpenReturn` / `legacyEditDropWarehouse`, which replay
 * what the pre-K2 code did (built lines with warehouse_id:null posted by the real postSalesReturnEffects).
 *
 * Scenarios (prod analogues): P1 healed header (p154), P2 un-healed header (p125), P3 matrix with
 * pv=vws+1 (p106) and pv=Σvws variants, P4 = SR#7/ledger#1338 (created in wh35, edit dropped the warehouse).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : JSON.stringify(extra)); }
}

console.log('\n══ audit-kardex K2 — assign warehouse to NULL-warehouse sale returns ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-k2-'));
process.env.DB_PATH = path.join(dir, 'k2.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'audit-kardex-k2-test-secret-32-chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const dbMods = require('../db');
dbMods.initDB();
const db = dbMods.getDB();

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
const changes = () => q1('SELECT total_changes() AS n').n;
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

const ADMIN_ID = insert('users', { name: 'مدیر تست', username: 'k2_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
const CASHIER_ID = insert('users', { name: 'صندوقدار', username: 'k2_cashier', password: 'x', role: 'cashier', active: 1, must_change_password: 0 });
const ADMIN = { id: ADMIN_ID, role: 'admin', username: 'k2_admin', name: 'مدیر تست' };

const authMw = require('../middleware/auth');
authMw.auth = (req, _res, next) => {
  const id = Number(req.headers['x-test-user']) || ADMIN_ID;
  const u = q1('SELECT id, role, name, username FROM users WHERE id=?', id);
  req.user = { id: u.id, role: u.role, name: u.name, username: u.username };
  next();
};

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/inventory', require('../routes/inventory'));

const L = require('../lib/inventory/ledger');
const M = require('../lib/inventory/movement');
const V = require('../lib/inventory/valuation');
const SR = require('../lib/sales-return-doc');
const AW = require('../lib/inventory/ledger-assign-warehouse');
const { kardexOf } = require('../lib/inventory/ledger-reverse-correction');
const { todayJalali } = require('../jalali');
const D = todayJalali();
const UNIT = 1000000;

const header = (pid) => r3(q1('SELECT stock FROM products WHERE id=?', pid).stock);
const sumWs = (pid) => r3(q1('SELECT COALESCE(SUM(qty),0) s FROM warehouse_stock WHERE product_id=?', pid).s);
const ws = (pid, wh) => { const r = q1('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?', pid, wh); return r ? r3(r.qty) : 0; };
const pv = (vid) => r3(q1('SELECT stock FROM product_variants WHERE id=?', vid).stock);
const sumVws = (vid) => r3(q1('SELECT COALESCE(SUM(qty),0) s FROM variant_warehouse_stock WHERE variant_id=?', vid).s);
const vws = (vid, wh) => { const r = q1('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?', vid, wh); return r ? r3(r.qty) : 0; };
const kx = (pid, wh) => kardexOf(db, pid, wh || null);
const glSnapshot = () => JSON.stringify({
  je: q1('SELECT COUNT(*) c FROM journal_entries').c,
  lines: qa('SELECT account_code, ROUND(SUM(debit),2) d, ROUND(SUM(credit),2) c FROM journal_lines GROUP BY account_code ORDER BY account_code'),
});
const liveSrRows = (srId) => qa(`SELECT * FROM inventory_ledger WHERE source_type='sales_return' AND source_id=? AND event_type='sale_return'
  AND status='posted' AND reversed_of IS NULL ORDER BY id`, srId);
function bucketsOf(pid) {
  return qa('SELECT warehouse_id, qty, value_rial FROM inventory_valuation_buckets WHERE product_id=? ORDER BY warehouse_id', pid)
    .map((b) => ({ wh: Number(b.warehouse_id) || 0, q: r3(b.qty), v: Math.round(Number(b.value_rial) || 0) }))
    .filter((b) => Math.abs(b.q) > 1e-6 || Math.abs(b.v) > 0);
}
function bucketsMatchRebuild(pid) {
  const inc = JSON.stringify(bucketsOf(pid));
  V.rebuildBuckets(db, { productId: pid });
  const reb = JSON.stringify(bucketsOf(pid));
  return { same: inc === reb, inc, reb };
}

function mkProduct(code, whId) {
  return insert('products', {
    user_id: ADMIN_ID, name: `کالای ${code}`, code, price: 2 * UNIT, cost: 0,
    average_cost_rial: 0, stock: 0, warehouse_id: whId, unit: 'عدد',
  });
}
function mkVariant(pid, sku) {
  return insert('product_variants', { product_id: pid, sku, stock: 0, active: 1, is_default: 0, status: 'active' });
}
function purchase(pid, wh, qty, sid) {
  return L.postInventoryMovement(db, {
    eventType: 'purchase', productId: pid, warehouseId: wh, qtyIn: qty, unitCostRial: UNIT,
    sourceType: 'purchase', sourceId: sid, date: D, createdBy: ADMIN_ID,
  });
}
function variantIn(pid, vid, wh, qty, docId) {
  M.postVariantLayer(db, { productId: pid, variantId: vid, warehouseId: wh, qtyDelta: qty, docType: 'k2_fixture_in', docId, docLine: 0, userId: ADMIN_ID, allowNegative: true });
}
function builtLine(pid, qty, variantId) {
  const p = q1('SELECT name FROM products WHERE id=?', pid);
  return {
    product_id: pid, name: p.name, qty, price: 2 * UNIT / 10, disc: 0, disc_amt: 0, sum: qty * 2 * UNIT / 10,
    warehouse_id: null, unit_cost: UNIT, cost_rial: UNIT, variant_id: variantId || null, color_name: '', size_name: '',
  };
}
/** LEGACY SIMULATION: pre-K2 open return without warehouse (built lines warehouse_id:null). */
function legacyOpenReturn(custId, lines) {
  const built = lines.map((l) => builtLine(l.pid, l.qty, l.vid));
  const amount = built.reduce((a, r) => a + r.sum, 0);
  const cost = built.reduce((a, r) => a + r.qty * UNIT, 0);
  return db.transaction(() => {
    const id = Number(db.prepare(`INSERT INTO sales_returns (user_id,cust_id,invoice_id,date,note,rows,amount,cost_amount)
      VALUES (?,?,NULL,?,?,?,?,?)`).run(ADMIN_ID, custId, D, 'legacy', JSON.stringify(built), amount, cost).lastInsertRowid);
    SR.postSalesReturnEffects(db, {
      retId: id, custId, invoiceId: null, date: D, note: `برگشت از فروش #${id}`, built, amount, costAmount: cost,
      parentWhId: null, userId: ADMIN_ID, goodsAmount: amount, hdrDiscAmt: 0, extraDiscAmt: 0, vatAmount: 0,
    });
    return id;
  })();
}
/** LEGACY SIMULATION: pre-K2 edit that dropped the warehouse (prod SR#7 → ledger#1338). */
function legacyEditDropWarehouse(srId) {
  const row = q1('SELECT * FROM sales_returns WHERE id=?', srId);
  const built = JSON.parse(row.rows).map((r) => ({ ...r, warehouse_id: null }));
  db.transaction(() => {
    SR.reverseSalesReturnEffects(db, row, ADMIN_ID, 'legacy edit');
    db.prepare(`UPDATE sales_returns SET rows=?, warehouse_id=NULL, status='posted', reversed_at=NULL, reversed_by=NULL, reversal_journal_id=NULL WHERE id=?`)
      .run(JSON.stringify(built), srId);
    SR.postSalesReturnEffects(db, {
      retId: srId, custId: row.cust_id, invoiceId: null, date: D, note: `برگشت از فروش #${srId}`, built,
      amount: row.amount, costAmount: row.cost_amount, parentWhId: null, userId: ADMIN_ID,
      goodsAmount: row.amount, hdrDiscAmt: 0, extraDiscAmt: 0, vatAmount: 0,
    });
  })();
}

async function main() {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, userId) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-user': String(userId || ADMIN_ID) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch (_) { json = null; }
    return { status: res.status, body: json };
  };
  const REASON = 'تعیین انبار ردیف بی‌انبار — تست K2';

  try {
    db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('ledger_leaf_enforcement','warn')").run();
    db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES ('1104','موجودی کالا','asset',NULL,2,1)").run();
    db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES ('110499','موجودی جدا K2','asset','1104',3,1)").run();
    const WH34 = insert('warehouses', { id: 34, name: 'نوبرت', code: 'K2-34', active: 1, warehouse_type: 'finished_goods', inventory_system: 'perpetual' });
    const WH35 = insert('warehouses', { id: 35, name: 'کیمیا', code: 'K2-35', active: 1, warehouse_type: 'finished_goods', inventory_system: 'perpetual' });
    const WH36 = insert('warehouses', { id: 36, name: 'حساب جدا', code: 'K2-36', active: 1, warehouse_type: 'finished_goods', inventory_system: 'perpetual', inventory_coa_code: '110499' });
    const custId = insert('customers', { user_id: ADMIN_ID, biz: 'مشتری K2', owner: 'O', status: 'active' });

    console.log('— fixture —');
    const P1 = mkProduct('K2-P1', WH34); purchase(P1, WH34, 10, 1);
    const P2 = mkProduct('K2-P2', WH34); purchase(P2, WH34, 10, 2);
    const P3 = mkProduct('K2-P3', WH34); purchase(P3, WH34, 4, 3);
    const V1 = mkVariant(P3, 'K2-P3-A'); const V2 = mkVariant(P3, 'K2-P3-B');
    variantIn(P3, V1, WH34, 2, 1); variantIn(P3, V2, WH34, 2, 2);
    const P4 = mkProduct('K2-P4', WH35); purchase(P4, WH35, 5, 4);
    const V3 = mkVariant(P4, 'K2-P4-A'); variantIn(P4, V3, WH35, 5, 3);

    const SRA = legacyOpenReturn(custId, [{ pid: P1, qty: 3 }]);
    db.prepare('UPDATE products SET stock=? WHERE id=?').run(sumWs(P1), P1); // header healed from Σws (p154)
    const SRB = legacyOpenReturn(custId, [{ pid: P2, qty: 2 }]); // header not healed (p125)
    const SRC = legacyOpenReturn(custId, [{ pid: P3, qty: 1, vid: V1 }, { pid: P3, qty: 1, vid: V2 }]);
    db.prepare('UPDATE products SET stock=? WHERE id=?').run(sumWs(P3), P3);
    db.prepare('UPDATE product_variants SET stock=? WHERE id=?').run(sumVws(V2), V2); // V2 healed, V1 stays pv=vws+1 (p106)
    const sr7 = SR.createSalesReturn(db, { cust_id: custId, warehouse_id: WH35, date: D, rows: [{ product_id: P4, variant_id: V3, qty: 1, price: 200000, cost_rial: UNIT }] }, ADMIN);
    const SR7 = Number(sr7.id);
    legacyEditDropWarehouse(SR7);

    const rowA = liveSrRows(SRA)[0];
    const rowB = liveSrRows(SRB)[0];
    const [rowC1, rowC2] = liveSrRows(SRC);
    const row7 = liveSrRows(SR7)[0];
    ok(rowA && rowA.warehouse_id == null && rowB.warehouse_id == null && rowC1.warehouse_id == null && rowC2.warehouse_id == null,
      'legacy fixture: NULL-warehouse sale_return rows exist');
    ok(row7 && row7.warehouse_id == null && qa("SELECT id FROM inventory_ledger WHERE source_type='sales_return' AND source_id=? AND warehouse_id=35", SR7).length > 0,
      'SR#7-like: live row NULL after legacy edit; history row in wh35');
    ok(header(P1) === sumWs(P1) && header(P2) === sumWs(P2) + 2, 'P1 header healed; P2 header = Σws + 2');
    ok(pv(V1) === sumVws(V1) + 1 && pv(V2) === sumVws(V2) && pv(V3) === sumVws(V3) + 1, 'V1/V3 pv=Σvws+1; V2 healed', { v1: [pv(V1), sumVws(V1)], v3: [pv(V3), sumVws(V3)] });
    const purchaseRow = q1("SELECT id FROM inventory_ledger WHERE product_id=? AND event_type='purchase'", P1).id;

    console.log('— 403 / 400 / 404 (zero writes) —');
    let c0 = changes();
    let r = await call('GET', `/api/inventory/ledger/${row7.id}/assign-warehouse-preview`, null, CASHIER_ID);
    ok(r.status === 403 && r.body.code === 'E_PERMISSION', 'cashier preview ⇒ 403 E_PERMISSION', r);
    r = await call('POST', `/api/inventory/ledger/${row7.id}/assign-warehouse`, { confirm: true, reason: REASON }, CASHIER_ID);
    ok(r.status === 403, 'cashier POST ⇒ 403');
    r = await call('POST', '/api/inventory/ledger/assign-warehouse', { ids: [row7.id], confirm: true, reason: REASON }, CASHIER_ID);
    ok(r.status === 403, 'cashier batch POST ⇒ 403');
    r = await call('POST', `/api/inventory/ledger/${row7.id}/assign-warehouse`, { confirm: true });
    ok(r.status === 400 && r.body.code === 'E_ASSIGN_WH_REASON_REQUIRED', 'no reason ⇒ 400', r.body);
    r = await call('POST', `/api/inventory/ledger/${row7.id}/assign-warehouse`, { confirm: true, reason: 'کوتاه' });
    ok(r.status === 400 && r.body.code === 'E_ASSIGN_WH_REASON_REQUIRED', 'reason < 10 ⇒ 400');
    r = await call('POST', `/api/inventory/ledger/${row7.id}/assign-warehouse`, { reason: REASON });
    ok(r.status === 400 && r.body.code === 'E_ASSIGN_WH_CONFIRM_REQUIRED', 'no confirm ⇒ 400');
    r = await call('POST', `/api/inventory/ledger/${row7.id}/assign-warehouse`, { confirm: true, reason: REASON, date: '2026-01-01' });
    ok(r.status === 400 && r.body.code === 'E_ASSIGN_WH_DATE', 'bad date ⇒ 400');
    r = await call('POST', '/api/inventory/ledger/assign-warehouse', { ids: [rowA.id, rowA.id], confirm: true, reason: REASON });
    ok(r.status === 400 && r.body.code === 'E_ASSIGN_WH_IDS', 'duplicate ids ⇒ 400');
    r = await call('POST', '/api/inventory/ledger/assign-warehouse', { ids: [rowA.id], overrides: 'x', confirm: true, reason: REASON });
    ok(r.status === 400 && r.body.code === 'E_ASSIGN_WH_BAD_OVERRIDES', 'bad overrides ⇒ 400');
    ok(changes() === c0, '403/400 calls wrote nothing');
    r = await call('GET', '/api/inventory/ledger/999999/assign-warehouse-preview');
    ok(r.status === 404, 'unknown ledger id ⇒ 404');

    console.log('— 409 blockers —');
    r = await call('POST', `/api/inventory/ledger/${purchaseRow}/assign-warehouse`, { warehouse_id: WH34, confirm: true, reason: REASON });
    ok(r.status === 409 && r.body.code === 'E_ASSIGN_WH_NOT_SALE_RETURN', 'purchase row ⇒ 409 E_ASSIGN_WH_NOT_SALE_RETURN', r.body);
    r = await call('POST', `/api/inventory/ledger/${rowA.id}/assign-warehouse`, { confirm: true, reason: REASON });
    ok(r.status === 409 && r.body.code === 'E_ASSIGN_WH_EXPLICIT_REQUIRED', 'weak evidence (product home) without warehouse ⇒ 409 explicit required', r.body);
    r = await call('POST', `/api/inventory/ledger/${row7.id}/assign-warehouse`, { warehouse_id: WH34, confirm: true, reason: REASON });
    ok(r.status === 409 && r.body.code === 'E_ASSIGN_WH_CONFLICT', 'explicit 34 vs strong 35 ⇒ 409 conflict', r.body);
    r = await call('GET', `/api/inventory/ledger/${row7.id}/assign-warehouse-preview?warehouse_id=${WH34}&force=1`);
    ok(r.status === 200 && r.body.ready === true && r.body.forced === true && r.body.batch.ready === true, 'force preview ⇒ ready (forced)', r.body && r.body.blocker);
    r = await call('POST', `/api/inventory/ledger/${rowA.id}/assign-warehouse`, { warehouse_id: WH36, confirm: true, reason: REASON });
    ok(r.status === 409 && r.body.code === 'E_ASSIGN_WH_GL_MISMATCH', 'warehouse on different inventory account ⇒ 409 GL mismatch', r.body);
    r = await call('POST', `/api/inventory/ledger/${rowA.id}/assign-warehouse`, { warehouse_id: 999, confirm: true, reason: REASON });
    ok(r.status === 409 && r.body.code === 'E_ASSIGN_WH_INVALID', 'missing warehouse ⇒ 409 invalid', r.body);
    ok(changes() === c0, '409 calls wrote nothing');

    console.log('— single assign: SR#7-like (strong evidence ⇒ 35) —');
    c0 = changes();
    r = await call('GET', `/api/inventory/ledger/${row7.id}/assign-warehouse-preview`);
    const pr7 = r.body;
    ok(r.status === 200 && pr7 && pr7.derived.confidence === 'strong' && pr7.warehouse_id === WH35, 'preview derives wh35 strong', pr7 && pr7.derived);
    ok(changes() === c0, 'preview wrote nothing');
    ok(pr7 && pr7.gl_effect_rial === 0 && pr7.gl_account.null_bucket === pr7.gl_account.warehouse, 'preview GL effect 0, same account');
    const gl0 = glSnapshot();
    const k7null0 = kx(P4, null); const k735 = kx(P4, WH35);
    r = await call('POST', `/api/inventory/ledger/${row7.id}/assign-warehouse`, { confirm: true, reason: REASON });
    ok(r.status === 200 && r.body.ok && r.body.count === 1, 'POST single ⇒ 200', r.body);
    const res7 = r.body.rows[0];
    ok(header(P4) === sumWs(P4), `P4 header == Σws (${header(P4)})`);
    ok(pv(V3) === sumVws(V3), `V3 pv == Σvws (${pv(V3)}/${sumVws(V3)})`);
    ok(header(P4) === pr7.header_stock.after && ws(P4, WH35) === pr7.warehouse_stock.after
      && pv(V3) === pr7.variant.pv.after && vws(V3, WH35) === pr7.variant.vws.after, 'preview after == posted state (header/ws/pv/vws)');
    const k7null1 = kx(P4, null); const k7351 = kx(P4, WH35);
    ok(r3(k7null1.qty) === r3(k7null0.qty - 1) && k7null1.value_rial === k7null0.value_rial - row7.amount_rial
      && r3(k7351.qty) === r3(k735.qty + 1) && k7351.value_rial === k735.value_rial + row7.amount_rial, 'kardex moved NULL → wh35 (qty and value)');
    ok(JSON.stringify(pr7.kardex.warehouse.after) === JSON.stringify({ qty: r3(k7351.qty), value_rial: k7351.value_rial })
      || (r3(pr7.kardex.warehouse.after.qty) === r3(k7351.qty) && pr7.kardex.warehouse.after.value_rial === k7351.value_rial), 'preview kardex after == posted kardex');
    ok(glSnapshot() === gl0, 'no JE / GL unchanged');
    const orig7 = q1('SELECT * FROM inventory_ledger WHERE id=?', row7.id);
    const new7 = q1('SELECT * FROM inventory_ledger WHERE id=?', res7.new_ledger_id);
    ok(orig7.status === 'reversed' || q1('SELECT id FROM inventory_ledger WHERE reversed_of=?', row7.id), 'original row reversed (not updated in place)');
    ok(orig7.warehouse_id == null && orig7.qty_in === row7.qty_in && orig7.amount_rial === row7.amount_rial, 'original row data untouched');
    ok(new7 && new7.warehouse_id === WH35 && new7.event_type === 'sale_return' && Number(new7.source_id) === SR7 && Math.round(new7.amount_rial) === Math.round(row7.amount_rial), 'new sale_return row in wh35 same source/amount');
    let bm = bucketsMatchRebuild(P4);
    ok(bm.same, 'P4 valuation buckets == rebuild', bm);
    const aud7 = qa("SELECT * FROM audit_log WHERE action='ledger_assign_warehouse' AND entity_id=?", row7.id);
    ok(aud7.length === 1 && JSON.parse(aud7[0].detail).reason === REASON && JSON.parse(aud7[0].detail).warehouse_id === WH35, 'audit row with reason/warehouse');

    console.log('— idempotency —');
    c0 = changes();
    r = await call('POST', `/api/inventory/ledger/${row7.id}/assign-warehouse`, { confirm: true, reason: REASON });
    ok(r.status === 409 && r.body.code === 'E_ALREADY_REVERSED' && r.body.assigned_ledger_id === res7.new_ledger_id, 'second POST ⇒ 409 E_ALREADY_REVERSED + assigned_ledger_id', r.body);
    r = await call('POST', `/api/inventory/ledger/${res7.new_ledger_id}/assign-warehouse`, { confirm: true, reason: REASON });
    ok(r.status === 409 && r.body.code === 'E_ASSIGN_WH_HAS_WAREHOUSE', 'new row ⇒ 409 has warehouse');
    ok(changes() === c0, 'idempotent retries wrote nothing');

    console.log('— batch all-or-nothing rollback (error mid-apply) —');
    db.prepare('UPDATE product_variants SET active=0 WHERE id=?').run(V1);
    db.prepare('INSERT INTO product_variants (product_id, sku, stock, active, is_default) VALUES (?,?,0,1,0)').run(P3, 'K2-P3-keep-matrix');
    const before = JSON.stringify({ l: q1('SELECT COUNT(*) c FROM inventory_ledger').c, m: q1('SELECT COUNT(*) c FROM inventory_movements').c, h1: header(P1), w1: ws(P1, WH34), a: q1("SELECT COUNT(*) c FROM audit_log WHERE action='ledger_assign_warehouse'").c });
    r = await call('POST', '/api/inventory/ledger/assign-warehouse', { ids: [rowA.id, rowC1.id], warehouse_id: WH34, confirm: true, reason: REASON });
    const after = JSON.stringify({ l: q1('SELECT COUNT(*) c FROM inventory_ledger').c, m: q1('SELECT COUNT(*) c FROM inventory_movements').c, h1: header(P1), w1: ws(P1, WH34), a: q1("SELECT COUNT(*) c FROM audit_log WHERE action='ledger_assign_warehouse'").c });
    ok(r.status >= 400, `inactive variant fails mid-batch (${r.status} ${r.body && r.body.code})`);
    ok(before === after && q1('SELECT status FROM inventory_ledger WHERE id=?', rowA.id).status === 'posted', 'first row rolled back — zero net writes', { before, after });
    db.prepare('UPDATE product_variants SET active=1 WHERE id=?').run(V1);
    db.prepare("DELETE FROM product_variants WHERE sku='K2-P3-keep-matrix'").run();

    console.log('— batch: P1 healed, P2 un-healed, P3 V1 (pv=vws+1) + V2 (healed) ⇒ wh34 —');
    const ids = [rowA.id, rowB.id, rowC1.id, rowC2.id];
    c0 = changes();
    r = await call('GET', `/api/inventory/ledger/assign-warehouse-preview?ids=${ids.join(',')}&warehouse_id=${WH34}`);
    ok(r.status === 200 && r.body.ready && r.body.count === 4 && r.body.gl_effect_rial === 0, 'batch preview ready', r.body && r.body.blockers);
    ok(changes() === c0, 'batch preview wrote nothing');
    const prev = r.body;
    r = await call('GET', '/api/inventory/ledger/assign-warehouse-preview');
    ok(r.status === 200 && ids.every((id) => r.body.ids.includes(id)) && !r.body.ids.includes(row7.id), 'candidate list = remaining NULL rows');
    const pA = prev.rows.find((x) => x.ledger_id === rowA.id);
    const pB = prev.rows.find((x) => x.ledger_id === rowB.id);
    const pC1 = prev.rows.find((x) => x.ledger_id === rowC1.id);
    const pC2 = prev.rows.find((x) => x.ledger_id === rowC2.id);
    ok(pA.header_stock.includes_row === false && pB.header_stock.includes_row === true, 'header rule: P1 healed ⇒ +q; P2 already includes row');
    ok(pC1.variant.mode === 'pv_includes_row' && pC2.variant.mode === 'pv_eq_vws' && pC2.variant.pv_heal_qty === 1, 'variant modes: V1 includes row; V2 heal +1');
    ok(prev.totals.by_warehouse.length === 1 && prev.totals.by_warehouse[0].rows === 4, 'totals by warehouse');
    const glB = glSnapshot();
    r = await call('POST', '/api/inventory/ledger/assign-warehouse', { ids, warehouse_id: WH34, confirm: true, reason: REASON });
    ok(r.status === 200 && r.body.count === 4, 'batch POST ⇒ 200', r.body);
    for (const pid of [P1, P2, P3]) ok(header(pid) === sumWs(pid), `product ${pid} header == Σws (${header(pid)}/${sumWs(pid)})`);
    for (const vid of [V1, V2]) ok(pv(vid) === sumVws(vid), `variant ${vid} pv == Σvws (${pv(vid)}/${sumVws(vid)})`);
    ok(header(P1) === pA.header_stock.after && header(P2) === pB.header_stock.after && header(P3) === pC2.header_stock.after
      && ws(P1, WH34) === pA.warehouse_stock.after && ws(P2, WH34) === pB.warehouse_stock.after && ws(P3, WH34) === pC2.warehouse_stock.after
      && pv(V1) === pC1.variant.pv.after && pv(V2) === pC2.variant.pv.after, 'batch preview after == posted state');
    ok(header(P1) === 13 && ws(P1, WH34) === 13 && header(P2) === 12 && ws(P2, WH34) === 12 && header(P3) === 6 && ws(P3, WH34) === 6, 'expected stock values P1 13 / P2 12 / P3 6');
    for (const pid of [P1, P2, P3]) ok(r3(kx(pid, null).qty) === 0 && kx(pid, null).value_rial === 0, `product ${pid} NULL kardex bucket now 0`);
    for (const pid of [P1, P2, P3]) { bm = bucketsMatchRebuild(pid); ok(bm.same, `product ${pid} buckets == rebuild`, bm); }
    ok(glSnapshot() === glB, 'batch: no JE / GL unchanged');
    ok(q1("SELECT COUNT(*) c FROM audit_log WHERE action='ledger_assign_warehouse'").c === 5, 'audit: one row per assigned ledger row');

    console.log('— R13: void / edit after assign —');
    SR.voidSalesReturn(db, SR7, ADMIN);
    ok(q1('SELECT status FROM inventory_ledger WHERE id=?', res7.new_ledger_id).status === 'reversed' || q1('SELECT id FROM inventory_ledger WHERE reversed_of=?', res7.new_ledger_id),
      'void SR#7 reverses the new wh35 row');
    ok(header(P4) === sumWs(P4) && ws(P4, WH35) === 5 && pv(V3) === 0 && vws(V3, WH35) === 0,
      'void SR#7: product cache remains 5; variant cache returns to ledger-derived zero',
      { h: header(P4), w: ws(P4, WH35), pv: pv(V3), vws: vws(V3, WH35) });
    ok(r3(kx(P4, WH35).qty) === 5 && r3(kx(P4, null).qty) === 0, 'void SR#7: kardex wh35 5, NULL 0');
    SR.voidSalesReturn(db, SRC, ADMIN);
    ok(header(P3) === 4 && ws(P3, WH34) === 4 && pv(V1) === 0 && vws(V1, WH34) === 0 && pv(V2) === 0 && vws(V2, WH34) === 0,
      'void SR-C: product returns to 4; unledgered legacy variant cache returns to zero',
      { h: header(P3), pv1: pv(V1), pv2: pv(V2) });
    SR.updateSalesReturn(db, SRA, { rows: [{ product_id: P1, qty: 4, price: 200000, cost_rial: UNIT }] }, ADMIN);
    const liveA = liveSrRows(SRA);
    ok(liveA.length === 1 && liveA[0].warehouse_id === WH34 && r3(liveA[0].qty_in) === 4, 'edit SR-A (no warehouse in body) re-posts into wh34 from history', liveA);
    ok(header(P1) === 14 && ws(P1, WH34) === 14, 'edit SR-A: header/ws34 14');
    for (const pid of [P1, P3, P4]) { bm = bucketsMatchRebuild(pid); ok(bm.same, `after R13 product ${pid} buckets == rebuild`, bm); }

    console.log('— root-cause guards —');
    c0 = q1('SELECT COUNT(*) c FROM sales_returns').c;
    let err = null;
    try { SR.createSalesReturn(db, { cust_id: custId, date: D, rows: [{ product_id: P2, qty: 1, price: 200000 }] }, ADMIN); } catch (e) { err = e; }
    ok(err && err.code === 'E_SR_WH_REQUIRED' && (err.status || err.statusCode) === 400, 'open return without warehouse ⇒ 400 E_SR_WH_REQUIRED', err && { code: err.code, m: err.message });
    ok(q1('SELECT COUNT(*) c FROM sales_returns').c === c0, 'guard wrote nothing');

    const SRE = Number(SR.createSalesReturn(db, { cust_id: custId, warehouse_id: WH34, date: D, rows: [{ product_id: P2, qty: 1, price: 200000, cost_rial: UNIT }] }, ADMIN).id);
    ok(q1('SELECT warehouse_id FROM sales_returns WHERE id=?', SRE).warehouse_id === WH34, 'sales_returns.warehouse_id persisted');
    SR.updateSalesReturn(db, SRE, { rows: [{ product_id: P2, qty: 2, price: 200000, cost_rial: UNIT }] }, ADMIN);
    const liveE = liveSrRows(SRE);
    ok(liveE.length === 1 && liveE[0].warehouse_id === WH34 && r3(liveE[0].qty_in) === 2, 'edit without warehouse keeps stored wh34', liveE);
    ok(header(P2) === sumWs(P2), 'P2 header == Σws after edit');

    const vws35 = vws(V3, WH35);
    const SRF = Number(SR.createSalesReturn(db, { cust_id: custId, warehouse_id: WH35, date: D, rows: [{ product_id: P4, variant_id: V3, qty: 1, price: 200000, cost_rial: UNIT }] }, ADMIN).id);
    SR.updateSalesReturn(db, SRF, { rows: [{ product_id: P4, variant_id: V3, qty: 1, price: 200000, cost_rial: UNIT }] }, ADMIN);
    ok(vws(V3, WH35) === r3(vws35 + 1) && pv(V3) === sumVws(V3), 'doc_line fix: same-qty edit re-posts the sku layer (vws35 +1, pv==Σvws)', { vws: vws(V3, WH35), was: vws35 });
    const liveSku = qa(`SELECT m.id FROM inventory_movements m WHERE m.doc_type='sale_return_sku' AND m.doc_id=? AND NOT EXISTS (
      SELECT 1 FROM inventory_movements v WHERE v.doc_type='sale_return_sku_void' AND v.doc_id=m.doc_id AND COALESCE(v.doc_line,-1)=COALESCE(m.doc_line,-1))`, SRF);
    ok(liveSku.length === 1, 'exactly one live sku movement after edit', liveSku);

    const P5 = mkProduct('K2-P5', WH34); purchase(P5, WH35, 5, 5);
    const invId = insert('invoices', { user_id: ADMIN_ID, cust_id: custId, num: 'K2-INV', type: 'normal', date: D,
      rows: JSON.stringify([{ product_id: P5, qty: 3, price: 200000 }]), subtotal: 600000, final: 600000 });
    L.postInventoryMovement(db, { eventType: 'sale', productId: P5, warehouseId: WH35, qtyOut: 3, sourceType: 'invoice', sourceId: invId, date: D, createdBy: ADMIN_ID });
    const SRI = Number(SR.createSalesReturn(db, { cust_id: custId, invoice_id: invId, date: D, rows: [{ product_id: P5, qty: 1 }] }, ADMIN).id);
    const liveI = liveSrRows(SRI);
    ok(liveI.length === 1 && liveI[0].warehouse_id === WH35, 'invoice return without warehouse ⇒ wh from invoice sale kardex (35), not product home (34)', liveI);

    console.log('— sync capture mapping / schema —');
    const { tableForPath } = require('../sync/capture');
    ok(tableForPath('/api/inventory/ledger/12/assign-warehouse') === 'inventory_ledger', 'capture: single route ⇒ inventory_ledger');
    ok(tableForPath('/api/inventory/ledger/assign-warehouse') === 'inventory_ledger', 'capture: batch route ⇒ inventory_ledger');
    const { FK_COLUMNS } = require('../sync/tables');
    const fkHas = Array.isArray(FK_COLUMNS) && FK_COLUMNS.some((x) => Array.isArray(x) && x[0] === 'sales_returns' && x[1] === 'warehouse_id');
    ok(fkHas, 'FK_COLUMNS includes sales_returns.warehouse_id');
    ok(AW.REASON_MIN === 10, 'REASON_MIN 10');

    console.log('— frontend wiring —');
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    ok(/function openLedgerAssignWarehouse\(/.test(appJs) && /تعیین انبار/.test(appJs), 'UI: openLedgerAssignWarehouse + «تعیین انبار»');
    ok(/assign-warehouse-preview/.test(appJs) && /\/api\/inventory\/ledger\/assign-warehouse/.test(appJs), 'UI uses preview + batch routes');
    ok(/E_SR_WH_REQUIRED/.test(appJs) && /برگشت‌های بی‌انبار/.test(appJs), 'Help mentions E_SR_WH_REQUIRED + batch button');
  } catch (e) {
    fail += 1;
    console.log('  FAIL harness error', e && e.stack);
  } finally {
    server.close();
  }
  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
