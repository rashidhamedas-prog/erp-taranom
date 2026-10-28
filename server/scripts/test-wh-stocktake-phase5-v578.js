#!/usr/bin/env node
/**
 * v578 — Warehouse Phase 5 BACKEND (stocktake / cycle count, audit O8):
 *  1. system_qty = KARDEX snapshot (Σ live ledger) frozen at session start — not warehouse_stock / vws,
 *     and equals the Phase 3 kardex closing (buildStockLedger) incl. variant filter
 *  2. matrix product: each variant is its own line; variance = counted − snapshot
 *  3. open session locks warehouse docs / manual adjust (409 E_STOCKTAKE_LOCKED); warn mode lets them through
 *  4. apply never re-snaps from live: a move after the snapshot keeps its effect, only the variance is posted
 *  5. apply = «مغایرت انبارگردانی»: balanced JE on its own accounts (6120 / 4205, never 6108) + kardex + variant layer
 *  6. void reverses everything (ledger, variant layer, header stock, JE) and is repeatable
 *  7. blind sheet payload carries NO system / snapshot / counted qty
 *  8. RBAC: acc_warehouse_ops:create counts, apply = admin/accounting, void = :delete
 *
 * Isolated temp DB. Run with Node 20 (better-sqlite3).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-stocktake-p5-v578-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'test-wh-stocktake-p5-v578-secret-32chars!';
process.env.AUTH_SESSION_DB_PATH = path.join(tmp, 'sessions.db');
process.env.NODE_ENV = 'test';
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const { getDB, initDB } = require('../db');
initDB();
const db = getDB();

const WD = require('../lib/warehouse-docs');
const CC = require('../lib/inventory/cycle-count');
const { buildStockLedger, kardexSnapshotQty } = require('../lib/ledgers');
const { variantWarehouseQty } = require('../lib/inventory/movement');
const { todayJalali } = require('../jalali');

let pass = 0;
let fail = 0;
function ok(cond, msg, detail) {
  if (cond) { pass += 1; console.log('  ✓', msg); }
  else { fail += 1; console.log('  ✗', msg, detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail))); }
}
function attempt(fn) {
  try { return { value: fn() }; } catch (e) { return { err: e }; }
}
function insert(table, obj) {
  const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  const keys = Object.keys(obj).filter((k) => cols.has(k));
  return db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => obj[k])).lastInsertRowid;
}

async function main() {
  console.log('\n=== warehouse phase 5 stocktake v578 ===\n');
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('feature_perpetual_docs','1')").run();

  const adminId = Number(insert('users', { name: 'مدیر', username: 'p5_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0 }));
  const keeperId = Number(insert('users', { name: 'انباردار', username: 'p5_keeper', password: 'x', role: 'sales', active: 1, must_change_password: 0 }));
  const voiderId = Number(insert('users', { name: 'ابطال‌کننده', username: 'p5_voider', password: 'x', role: 'sales', active: 1, must_change_password: 0 }));
  const admin = db.prepare('SELECT * FROM users WHERE id=?').get(adminId);
  const setPerm = db.prepare('INSERT OR REPLACE INTO user_permissions (user_id,resource,action,allowed) VALUES (?,?,?,?)');
  // keeper: view + create (count entry) — no delete
  setPerm.run(keeperId, 'acc_warehouse_ops', 'view', 1);
  setPerm.run(keeperId, 'acc_warehouse_ops', 'create', 1);
  setPerm.run(keeperId, 'acc_warehouse_ops', 'delete', 0);
  // voider: view + delete (void) — no create
  setPerm.run(voiderId, 'acc_warehouse_ops', 'view', 1);
  setPerm.run(voiderId, 'acc_warehouse_ops', 'create', 0);
  setPerm.run(voiderId, 'acc_warehouse_ops', 'delete', 1);

  const whA = Number(insert('warehouses', { name: 'انبار الف', code: 'P5-A', active: 1, allow_negative: 0, warehouse_type: 'finished_goods', inventory_system: 'perpetual' }));
  const whB = Number(insert('warehouses', { name: 'انبار ب', code: 'P5-B', active: 1, allow_negative: 0, warehouse_type: 'finished_goods', inventory_system: 'perpetual' }));
  const UNIT = 10000;
  const mk = (name, code, wh = whA) => Number(insert('products', {
    user_id: adminId, name, code, price: 500000, cost: UNIT, average_cost_rial: UNIT, stock: 0, warehouse_id: wh, unit: 'عدد',
  }));
  const date = todayJalali();
  const receive = (productId, wh, qty, variantId) => WD.createWarehouseDoc(db, {
    type: 'receipt', warehouse_id: wh, date, receipt_class: 'adjustment',
    lines: [{ product_id: productId, qty, unit_cost_rial: UNIT, ...(variantId ? { variant_id: variantId } : {}) }],
  }, admin);

  const p1 = mk('کالای ساده', 'P5-1');
  const p3 = mk('کالای اختلاف لایه', 'P5-3');
  const p2 = mk('کالای انبار ب', 'P5-2', whB);
  const pm = mk('کالای ماتریسی', 'P5-M');
  const colors = ['قرمز', 'آبی'].map((name) => insert('product_colors', { name, active: 1 }));
  const size = insert('product_sizes', { name: 'M', active: 1, sort_order: 0 });
  const [v1, v2] = colors.map((cid) => {
    const vid = Number(insert('product_variants', {
      product_id: pm, color_id: cid, size_id: size, stock: 0, active: 1, is_default: 0, sku: `P5-M-${cid}`,
    }));
    db.prepare('UPDATE product_variants SET active=1 WHERE id=?').run(vid);
    return vid;
  });

  receive(p1, whA, 10);
  receive(p3, whA, 10);
  receive(p2, whB, 4);
  receive(pm, whA, 5, v1);
  receive(pm, whA, 3, v2);
  // Layer drift on purpose: warehouse_stock says 7 but the kardex (Σ ledger) says 10 (audit O8).
  db.prepare('UPDATE warehouse_stock SET qty=7 WHERE product_id=? AND warehouse_id=?').run(p3, whA);

  // ── 1) kardex snapshot ────────────────────────────────────────────────────
  console.log('— 1) kardex snapshot frozen at start —');
  const started = CC.createSession(db, { warehouseId: whA, date, responsibleUserId: adminId, note: 'تست', createdBy: adminId });
  const sid = started.id;
  const sess = db.prepare('SELECT * FROM stocktaking_sessions WHERE id=?').get(sid);
  ok(sess.snapshot_at && sess.snapshot_source === 'kardex', 'session records snapshot_at + snapshot_source=kardex', sess);
  const items = db.prepare('SELECT * FROM stocktaking_items WHERE session_id=? ORDER BY product_id, variant_id').all(sid);
  const line = (pid, vid = null) => items.find((i) => i.product_id === pid && (i.variant_id || null) === vid);
  ok(line(p1) && line(p1).system_qty === 10 && line(p1).snapshot_qty === 10, 'simple product snapshot = kardex Σ (10)', line(p1));
  ok(line(p3) && line(p3).system_qty === 10 && line(p3).snapshot_qty === 10,
    'drifted product uses KARDEX 10, not warehouse_stock 7 (O8)', line(p3));
  ok(!line(p2), 'product with stock only in another warehouse is not on this sheet');
  const mLines = items.filter((i) => i.product_id === pm);
  ok(mLines.length === 2 && !!line(pm, v1) && !!line(pm, v2), 'matrix product: one line per variant (no header line)', mLines.map((m) => m.variant_id));
  ok(line(pm, v1).snapshot_qty === 5 && line(pm, v2).snapshot_qty === 3, 'each variant snapshot from kardex (5 / 3)', mLines);
  ok(mLines.every((m) => m.snapshot_source === 'kardex'), 'attributed variants flagged source=kardex');
  // same source as Phase 3 kardex
  const k1 = buildStockLedger(db, { product_id: p1, warehouse_id: whA });
  ok(k1.closing_qty === line(p1).snapshot_qty, 'snapshot == Phase 3 buildStockLedger closing (header)', [k1.closing_qty, line(p1).snapshot_qty]);
  const kv1 = buildStockLedger(db, { product_id: pm, warehouse_id: whA, variant_id: v1 });
  const kv2 = buildStockLedger(db, { product_id: pm, warehouse_id: whA, variant_id: v2 });
  ok(kv1.closing_qty === line(pm, v1).snapshot_qty && kv2.closing_qty === line(pm, v2).snapshot_qty,
    'snapshot == Phase 3 closing with variant filter', [kv1.closing_qty, kv2.closing_qty]);
  ok(kardexSnapshotQty(db, { productId: pm, warehouseId: whA, variantId: v1 }).qty === 5, 'shared helper kardexSnapshotQty(variant)');
  const dupe = attempt(() => CC.createSession(db, { warehouseId: whA, createdBy: adminId }));
  ok(dupe.err && dupe.err.code === 'E_STK_OPEN_EXISTS' && dupe.err.status === 409, 'second open session on the same warehouse → 409', dupe.err && dupe.err.code);

  // ── 2) lock / warn ────────────────────────────────────────────────────────
  console.log('— 2) movement lock while the session is open —');
  let r = attempt(() => receive(p1, whA, 1));
  ok(r.err && r.err.code === 'E_STOCKTAKE_LOCKED' && r.err.status === 409, 'receipt into the counting warehouse → 409 E_STOCKTAKE_LOCKED', r.err && r.err.code);
  r = attempt(() => WD.createWarehouseDoc(db, {
    type: 'transfer', from_warehouse_id: whA, to_warehouse_id: whB, date, lines: [{ product_id: p1, qty: 1 }],
  }, admin));
  ok(r.err && r.err.code === 'E_STOCKTAKE_LOCKED', 'transfer OUT of the counting warehouse locked', r.err && r.err.code);
  r = attempt(() => WD.createWarehouseDoc(db, {
    type: 'transfer', from_warehouse_id: whB, to_warehouse_id: whA, date, lines: [{ product_id: p2, qty: 1 }],
  }, admin));
  ok(r.err && r.err.code === 'E_STOCKTAKE_LOCKED', 'transfer INTO the counting warehouse locked', r.err && r.err.code);
  r = attempt(() => receive(p2, whB, 1));
  ok(r.value && r.value.id && !r.value.stocktake_warning, 'other warehouse is not locked');
  const MA = require('../lib/inventory/manual-adjust');
  r = attempt(() => MA.postAdjust(db, { product_id: p1, warehouse_id: whA, mode: 'delta', qty: 1, reason_code: 'other', note: 'x' }, admin, { requireReason: true }));
  ok(r.err && r.err.code === 'E_STOCKTAKE_LOCKED', 'manual stock adjust on the counting warehouse locked', r.err && r.err.code);
  ok(!db.prepare("SELECT 1 FROM warehouse_docs WHERE to_warehouse_id=? AND type='receipt' AND date=? AND qty_total=1").get(whA, date),
    'locked receipts left no document behind');

  // warn mode: movement goes through with a warning; snapshot stays frozen
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('stocktake_move_lock','warn')").run();
  r = attempt(() => receive(p1, whA, 2));
  ok(r.value && r.value.stocktake_warning === true && r.value.stocktake_sessions.includes(sid), 'warn mode: receipt posts with stocktake_warning', r.err ? r.err.message : r.value);
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('stocktake_move_lock','lock')").run();
  const live = kardexSnapshotQty(db, { productId: p1, warehouseId: whA }).qty;
  ok(live === 12, 'live kardex moved to 12 after the warn-mode receipt', live);
  ok(db.prepare('SELECT snapshot_qty FROM stocktaking_items WHERE id=?').get(line(p1).id).snapshot_qty === 10, 'frozen snapshot still 10');

  // ── 3) blind sheet + HTTP + RBAC ──────────────────────────────────────────
  console.log('— 3) HTTP: blind sheet + RBAC —');
  const express = require('express');
  const http = require('http');
  const { issueStaffSession } = require('../lib/auth-sessions');
  const tokenFor = (uid, tag) => issueStaffSession(db, db.prepare('SELECT * FROM users WHERE id=?').get(uid), {
    device_kind: 'test', device_name: 'p5-' + tag, device_fingerprint: 'p5-fp-' + tag,
  }).token;
  const tok = { admin: tokenFor(adminId, 'admin'), keeper: tokenFor(keeperId, 'keeper'), voider: tokenFor(voiderId, 'voider') };
  const app = express();
  app.use(express.json());
  app.use('/api/stocktaking', require('../routes/stocktaking'));
  app.use('/api/warehouses', require('../routes/warehouses'));
  const server = http.createServer(app);
  await new Promise((rs) => server.listen(0, '127.0.0.1', rs));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  async function api(method, p, body, who = 'admin') {
    const headers = { 'Content-Type': 'application/json' };
    if (who) headers.Authorization = 'Bearer ' + tok[who];
    const res = await fetch(BASE + p, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); } catch (_) { json = null; }
    return { status: res.status, json };
  }

  for (const route of [`/api/stocktaking/${sid}/sheet`, `/api/stocktaking/${sid}/tags`]) {
    const s = await api('GET', route, null, 'keeper');
    const raw = JSON.stringify(s.json);
    ok(s.status === 200 && s.json.blind === true && s.json.items.length === items.length, `blind sheet ${route.split('/').pop()} → 200 with all lines`, s.status);
    ok(!/system_qty|snapshot_qty|counted_qty|count1_qty|count2_qty|count3_qty|variance|header_qty/.test(raw),
      `blind sheet ${route.split('/').pop()} carries NO system/snapshot/counted qty`);
    ok(s.json.items.some((i) => i.variant_id === v1 && i.color_name) && s.json.items.every((i) => i.code && i.name), 'blind sheet still names product + color × size');
  }
  const detail = await api('GET', `/api/stocktaking/${sid}`, null, 'keeper');
  const dm = detail.json.items.find((i) => i.product_id === pm && i.variant_id === v1);
  ok(detail.status === 200 && dm && dm.snapshot_qty === 5 && dm.variance === 0, 'detail: variant line has snapshot_qty + variance 0 before counting', dm);
  ok(detail.json.session.movements_locked === 1 && detail.json.session.snapshot_at && detail.json.session.adjust_doc_label === 'مغایرت انبارگردانی',
    'detail session exposes movements_locked / snapshot_at / adjust_doc_label', detail.json.session);
  const list = await api('GET', `/api/stocktaking?warehouse_id=${whA}`, null, 'keeper');
  ok(list.status === 200 && list.json.some((x) => x.id === sid && x.movements_locked === 1), 'list rows carry movements_locked');
  const lockedHttp = await api('POST', '/api/warehouses/moves/docs', {
    type: 'receipt', warehouse_id: whA, date, receipt_class: 'adjustment', lines: [{ product_id: p1, qty: 1, unit_cost_rial: UNIT }],
  }, 'admin');
  ok(lockedHttp.status === 409 && lockedHttp.json.code === 'E_STOCKTAKE_LOCKED', 'HTTP receipt into counting warehouse → 409 E_STOCKTAKE_LOCKED', lockedHttp);

  // counts: P1 9 (−1 vs frozen 10), v1 6 (+1), v2 2 (−1), P3 10 (= kardex, ≠ ws 7)
  const put = await api('PUT', `/api/stocktaking/${sid}/items`, {
    items: [
      { id: line(p1).id, count1_qty: 9, confirmed_count: 1 },
      { id: line(pm, v1).id, count1_qty: 6, confirmed_count: 1 },
      { id: line(pm, v2).id, count1_qty: 2, confirmed_count: 1 },
      { id: line(p3).id, count1_qty: 10, confirmed_count: 1 },
    ],
  }, 'keeper');
  ok(put.status === 200, 'storekeeper (acc_warehouse_ops:create) enters counts', put);
  const dv = await api('GET', `/api/stocktaking/${sid}`, null, 'keeper');
  const by = (pid, vid = null) => dv.json.items.find((i) => i.product_id === pid && (i.variant_id || null) === vid);
  ok(by(p1).variance === -1 && by(pm, v1).variance === 1 && by(pm, v2).variance === -1 && by(p3).variance === 0,
    'variance = counted − snapshot (per variant)', dv.json.items.map((i) => [i.product_id, i.variant_id, i.variance]));
  const done = await api('POST', `/api/stocktaking/${sid}/complete`, {}, 'keeper');
  ok(done.status === 200, 'storekeeper completes the count');
  const denyApply = await api('POST', `/api/stocktaking/${sid}/apply`, {}, 'keeper');
  ok(denyApply.status === 403, 'storekeeper (create only) cannot apply → 403', denyApply.status);
  const denyApply2 = await api('POST', `/api/stocktaking/${sid}/apply`, {}, 'voider');
  ok(denyApply2.status === 403, 'void-only user cannot apply → 403', denyApply2.status);
  const noSess = await api('POST', '/api/stocktaking', { warehouse_id: whB }, 'voider');
  ok(noSess.status === 403, 'void-only user cannot start/count (no :create) → 403', noSess.status);

  // ── 4) apply ──────────────────────────────────────────────────────────────
  console.log('— 4) apply = مغایرت انبارگردانی (frozen snapshot, own COA) —');
  const kBefore = {
    p1: kardexSnapshotQty(db, { productId: p1, warehouseId: whA }).qty,
    p3: kardexSnapshotQty(db, { productId: p3, warehouseId: whA }).qty,
    pm: kardexSnapshotQty(db, { productId: pm, warehouseId: whA }).qty,
  };
  const ap = await api('POST', `/api/stocktaking/${sid}/apply`, {}, 'admin');
  ok(ap.status === 200 && ap.json.ok && ap.json.doc_type === 'stocktake_variance' && ap.json.doc_label === 'مغایرت انبارگردانی', 'admin applies', ap);
  ok(ap.json.total_gain_rial === UNIT && ap.json.total_loss_rial === 2 * UNIT, 'gain = 1 unit, loss = 2 units (variant diffs)', ap.json);
  ok(ap.json.moved_since_snapshot >= 1, 'apply reports the line that moved after the snapshot (info only)', ap.json.moved_since_snapshot);

  const kAfter = {
    p1: kardexSnapshotQty(db, { productId: p1, warehouseId: whA }).qty,
    p3: kardexSnapshotQty(db, { productId: p3, warehouseId: whA }).qty,
    pm: kardexSnapshotQty(db, { productId: pm, warehouseId: whA }).qty,
  };
  ok(kAfter.p1 === kBefore.p1 - 1 && kAfter.p1 === 11, 'P1: only the variance (−1) posted on the LIVE 12 → 11 (no re-snap to counted 9)', kAfter);
  ok(kAfter.p3 === 10, 'P3: counted = kardex → nothing posted (old live-vws logic would have added +3)', kAfter);
  ok(kAfter.pm === kBefore.pm, 'matrix header kardex net 0 (+1 −1)', kAfter);
  const kv1a = buildStockLedger(db, { product_id: pm, warehouse_id: whA, variant_id: v1 });
  const kv2a = buildStockLedger(db, { product_id: pm, warehouse_id: whA, variant_id: v2 });
  ok(kv1a.closing_qty === 6 && kv2a.closing_qty === 2, 'kardex per variant: v1 6, v2 2', [kv1a.closing_qty, kv2a.closing_qty]);
  ok(variantWarehouseQty(db, v1, whA) === 6 && variantWarehouseQty(db, v2, whA) === 2, 'variant layer v1 6, v2 2');
  const wsP1 = db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(p1, whA).qty;
  ok(wsP1 === 11, 'warehouse_stock P1 follows the ledger (11)', wsP1);

  const cLed = db.prepare("SELECT * FROM inventory_ledger WHERE source_type='stocktaking' AND source_id=? AND reversed_of IS NULL").all(sid);
  ok(cLed.length === 3 && cLed.every((l) => l.event_type === 'cycle_count' && l.status === 'posted' && l.je_id), 'three cycle_count kardex rows (P1, v1, v2) linked to the JE', cLed);
  ok(cLed.filter((l) => l.variant_id).map((l) => l.variant_id).sort().join() === [v1, v2].sort().join(), 'variant kardex rows carry variant_id');
  ok(/مغایرت انبارگردانی/.test(cLed[0].note), 'kardex note names the adjustment type', cLed[0].note);

  const sApplied = db.prepare('SELECT * FROM stocktaking_sessions WHERE id=?').get(sid);
  ok(sApplied.status === 'adjusted' && sApplied.je_id, 'session adjusted + je_id', sApplied);
  const jl = db.prepare('SELECT account_code, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?').all(sApplied.je_id);
  const dr = jl.reduce((a, l) => a + (l.debit_rial || 0), 0);
  const crd = jl.reduce((a, l) => a + (l.credit_rial || 0), 0);
  ok(dr > 0 && dr === crd, 'JE balanced', [dr, crd]);
  ok(jl.some((l) => l.account_code === '6120' && l.debit_rial === 2 * UNIT), 'loss debits the stocktake account 6120', jl);
  ok(jl.some((l) => l.account_code === '4205' && l.credit_rial === UNIT), 'gain credits 4205 اضافی انبارگردانی', jl);
  ok(!jl.some((l) => l.account_code === '6108'), 'NOT the scrap / shortage account 6108', jl);
  ok(db.prepare("SELECT 1 FROM chart_of_accounts WHERE code='6120'").get(), 'account 6120 exists in the chart');
  const jeRow = db.prepare('SELECT description FROM journal_entries WHERE id=?').get(sApplied.je_id);
  ok(/مغایرت انبارگردانی/.test(jeRow.description), 'JE description names the adjustment type', jeRow);

  const again = await api('POST', `/api/stocktaking/${sid}/apply`, {}, 'admin');
  ok(again.status === 409 && again.json.code === 'E_STK_ALREADY', 'second apply → 409 E_STK_ALREADY', again);
  const detailAfter = await api('GET', `/api/stocktaking/${sid}`, null, 'admin');
  ok(detailAfter.json.session.movements_locked === 0, 'lock released after apply');
  r = attempt(() => receive(p1, whA, 1));
  ok(r.value && r.value.id, 'warehouse docs allowed again after apply');
  WD.voidWarehouseDoc(db, r.value.id, admin, { reason: 'test cleanup' });

  // ── 5) void (R13) ─────────────────────────────────────────────────────────
  console.log('— 5) void reverses everything —');
  const kPre = kardexSnapshotQty(db, { productId: p1, warehouseId: whA }).qty;
  const denyVoid = await api('POST', `/api/stocktaking/${sid}/void`, {}, 'keeper');
  ok(denyVoid.status === 403, 'create-only storekeeper cannot void → 403', denyVoid.status);
  const vd = await api('POST', `/api/stocktaking/${sid}/void`, {}, 'voider');
  ok(vd.status === 200 && vd.json.ok, 'acc_warehouse_ops:delete user voids', vd);
  const live2 = db.prepare("SELECT COUNT(*) c FROM inventory_ledger WHERE source_type='stocktaking' AND source_id=? AND event_type='cycle_count' AND status='posted' AND reversed_of IS NULL").get(sid).c;
  ok(live2 === 0, 'no live cycle_count ledger rows after void', live2);
  ok(kardexSnapshotQty(db, { productId: p1, warehouseId: whA }).qty === kPre + 1 && kPre + 1 === 12, 'P1 kardex back to 12', kPre);
  const kv1v = buildStockLedger(db, { product_id: pm, warehouse_id: whA, variant_id: v1 });
  const kv2v = buildStockLedger(db, { product_id: pm, warehouse_id: whA, variant_id: v2 });
  ok(kv1v.closing_qty === 5 && kv2v.closing_qty === 3, 'kardex per variant restored (5 / 3)', [kv1v.closing_qty, kv2v.closing_qty]);
  ok(variantWarehouseQty(db, v1, whA) === 5 && variantWarehouseQty(db, v2, whA) === 3, 'variant layer restored (5 / 3)');
  ok(db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(p1, whA).qty === 12, 'warehouse_stock P1 restored (12)');
  const je = db.prepare('SELECT status, deleted_at FROM journal_entries WHERE id=?').get(sApplied.je_id);
  ok(je && je.status === 'reversed', 'JE reversed', je);
  const sVoid = db.prepare('SELECT status, je_id, total_gain_rial, total_loss_rial FROM stocktaking_sessions WHERE id=?').get(sid);
  ok(sVoid.status === 'completed' && !sVoid.je_id && !sVoid.total_gain_rial && !sVoid.total_loss_rial, 'session back to completed, totals cleared', sVoid);
  const sumDr = db.prepare(`SELECT COALESCE(SUM(l.debit_rial),0) d, COALESCE(SUM(l.credit_rial),0) c
    FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
    WHERE e.deleted_at IS NULL OR e.deleted_at=0`).get();
  ok(sumDr.d === sumDr.c, 'live books still balanced after void', sumDr);
  const reApply = attempt(() => CC.applyCycleCount(db, sid, { createdBy: adminId }));
  ok(reApply.value && reApply.value.ok, 'voided session can be applied again', reApply.err && reApply.err.message);
  CC.voidCycleCount(db, sid, { createdBy: adminId });
  ok(kardexSnapshotQty(db, { productId: p1, warehouseId: whA }).qty === 12, 're-apply + void second time also net zero');

  // delete releases the lock
  const del = await api('DELETE', `/api/stocktaking/${sid}`, null, 'voider');
  ok(del.status === 200, 'open session can be deleted (releases the lock)', del);
  r = attempt(() => receive(p1, whA, 1));
  ok(r.value && r.value.id, 'receipt allowed once the session is gone');

  // ── 6) static wiring ──────────────────────────────────────────────────────
  console.log('— 6) static wiring —');
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const cc = read('lib/inventory/cycle-count.js');
  ok(!/variantWarehouseQty\(db, it\.variant_id, session\.warehouse_id\)/.test(cc) && !/Re-snapshot system_qty at apply/.test(cc), 'apply no longer re-snaps from live stock');
  ok(/coa_stocktake_loss/.test(cc) && !/coa_inventory_loss/.test(cc), 'apply uses coa_stocktake_loss, not coa_inventory_loss');
  ok(/assertWarehouseNotCounting/.test(read('lib/warehouse-docs.js')), 'warehouse-docs guarded by the stocktake lock');
  ok(/erp-taranom-v57[89]|erp-taranom-v5[89]\d/.test(read('public/sw.js')), 'SW ≥ v578');

  server.close();
  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
