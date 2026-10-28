'use strict';
/**
 * v574 — فاز ۱ انبار: GET /api/inventory/reconcile (فقط‌خواندنی) + هشدار drift بدون heal.
 * اجرا: node server/scripts/test-inventory-layer-reconcile-v574.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : extra); }
}

console.log('\n══ inventory layer reconcile (v574) ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-recon-'));
process.env.DB_PATH = path.join(dir, 'inv-recon.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'inv-recon-test-secret-32chars!!!!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

(async () => {
  const { getDB, initDB } = require('../db');
  initDB();
  const db = getDB();
  const { issueStaffSession } = require('../lib/auth-sessions');
  const { createWarehouseDoc } = require('../lib/warehouse-docs');
  const { computeLayerReconcile } = require('../lib/inventory/layer-reconcile');
  const { todayJalali } = require('../jalali');

  function insert(table, obj) {
    const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    const keys = Object.keys(obj).filter((k) => cols.has(k));
    return db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...keys.map((k) => obj[k])).lastInsertRowid;
  }
  const totalChanges = () => db.prepare('SELECT total_changes() AS c').get().c;

  const adminId = insert('users', { name: 'مدیر', username: 'rc_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
  const acctId = insert('users', { name: 'حسابدار', username: 'rc_acct', password: 'x', role: 'accounting', active: 1, must_change_password: 0 });
  const salesId = insert('users', { name: 'فروش', username: 'rc_sales', password: 'x', role: 'sales', active: 1, must_change_password: 0 });
  const admin = db.prepare('SELECT * FROM users WHERE id=?').get(adminId);
  const acct = db.prepare('SELECT * FROM users WHERE id=?').get(acctId);
  const sales = db.prepare('SELECT * FROM users WHERE id=?').get(salesId);

  const wh1 = insert('warehouses', { name: 'انبار ۱', code: 'RC-1', active: 1, allow_negative: 1, warehouse_type: 'finished_goods' });
  const wh2 = insert('warehouses', { name: 'انبار ۲', code: 'RC-2', active: 1, allow_negative: 1, warehouse_type: 'finished_goods' });

  const mkProduct = (code, extra = {}) => insert('products', {
    user_id: adminId, name: 'کالا ' + code, code, price: 100000, cost: 40000,
    average_cost_rial: 40000, stock: 0, warehouse_id: wh1, unit: 'عدد', ...extra,
  });

  // ── کالای ماتریسی سالم ───────────────────────────────────
  const colors = ['قرمز', 'آبی'].map((name) => insert('product_colors', { name, active: 1 }));
  const sizes = ['M', 'L'].map((name, i) => insert('product_sizes', { name, active: 1, sort_order: i }));
  const pMatrix = mkProduct('RC-MATRIX');
  const variants = [];
  for (const c of colors) {
    for (const s of sizes) {
      variants.push(insert('product_variants', {
        product_id: pMatrix, color_id: c, size_id: s, stock: 0, active: 1, is_default: 0, sku: `RC-${c}-${s}`,
      }));
    }
  }

  const clean = createWarehouseDoc(db, {
    type: 'receipt', warehouse_id: wh1, date: todayJalali(), receipt_class: 'adjustment', note: 'رسید سالم',
    lines: [{ product_id: pMatrix, variant_id: variants[0], qty: 3 }, { product_id: pMatrix, variant_id: variants[1], qty: 2 }],
  }, admin);
  ok(clean && clean.id, 'receipt on clean matrix product posts', clean);
  const warnsClean = db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='warning' AND entity='inventory_layer_drift'").get().c;
  ok(warnsClean === 0, 'no drift warning for a clean receipt', warnsClean);

  // ── ایجاد استثناها با SQL خام (فقط آماده‌سازی تست) ───────
  let txSeq = 0;
  const rawLedger = (o) => insert('inventory_ledger', {
    tx_no: 'RCT-' + (++txSeq), event_type: 'receipt', status: 'posted', date: todayJalali(),
    qty_in: 0, qty_out: 0, qty_balance: 0, unit_cost_rial: 0, amount_rial: 0, ...o,
  });

  // ws منفی
  const pNeg = mkProduct('RC-NEG');
  db.prepare('INSERT INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)').run(pNeg, wh1, -4);
  // ledger بدون انبار
  const pNoWh = mkProduct('RC-NOWH');
  rawLedger({ product_id: pNoWh, warehouse_id: null, qty_in: 7, amount_rial: 700000, unit_cost_rial: 100000 });
  // opening تکراری
  const pDup = mkProduct('RC-DUP');
  rawLedger({ product_id: pDup, warehouse_id: wh1, qty_in: 5, amount_rial: 500000, source_type: 'opening_inventory', event_type: 'opening' });
  rawLedger({ product_id: pDup, warehouse_id: wh1, qty_in: 5, amount_rial: 500000, source_type: 'opening_inventory', event_type: 'opening' });
  db.prepare('INSERT INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)').run(pDup, wh1, 10);
  // qty=0 با ارزش ≠ ۰
  const pZero = mkProduct('RC-ZERO');
  rawLedger({ product_id: pZero, warehouse_id: wh1, qty_in: 0, qty_out: 0, amount_rial: -17000000, event_type: 'adjustment' });
  db.prepare('INSERT INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)').run(pZero, wh1, 0);
  // واریانت پیش‌فرض با موجودی روی کالای ماتریسی
  const defVariant = insert('product_variants', {
    product_id: pMatrix, color_id: null, size_id: null, stock: 9, active: 1, is_default: 1, sku: 'RC-DEFAULT',
  });
  // اختلاف pv و vws
  db.prepare('UPDATE product_variants SET stock=? WHERE id=?').run(11, variants[2]);
  // اختلاف ws و vws/ledger روی کالای ماتریسی
  db.prepare('UPDATE warehouse_stock SET qty=qty+5 WHERE product_id=? AND warehouse_id=?').run(pMatrix, wh1);

  const app = express();
  app.use(express.json());
  app.use('/api/inventory', require('../routes/inventory'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tok = (u, n) => issueStaffSession(db, u, { device_kind: 'test', device_name: n, device_fingerprint: 'fp-' + n }).token;
  const tAdmin = tok(admin, 'rc-a');
  const tAcct = tok(acct, 'rc-b');
  const tSales = tok(sales, 'rc-c');

  // ── بدون نوشتن ───────────────────────────────────────────
  const before = totalChanges();
  const snap = JSON.stringify(db.prepare('SELECT * FROM warehouse_stock ORDER BY product_id, warehouse_id').all())
    + JSON.stringify(db.prepare('SELECT COUNT(*) c, SUM(qty_in) a, SUM(qty_out) b FROM inventory_ledger').get());
  const res = await fetch(`${base}/api/inventory/reconcile`, { headers: { Authorization: 'Bearer ' + tAdmin } });
  const body = await res.json();
  const res2 = await fetch(`${base}/api/inventory/reconcile?only_drift=1&limit=5`, { headers: { Authorization: 'Bearer ' + tAcct } });
  const body2 = await res2.json();
  const res3 = await fetch(`${base}/api/inventory/reconcile?product_id=${pMatrix}&warehouse_id=${wh1}`, { headers: { Authorization: 'Bearer ' + tAdmin } });
  const body3 = await res3.json();
  const after = totalChanges();
  const snapAfter = JSON.stringify(db.prepare('SELECT * FROM warehouse_stock ORDER BY product_id, warehouse_id').all())
    + JSON.stringify(db.prepare('SELECT COUNT(*) c, SUM(qty_in) a, SUM(qty_out) b FROM inventory_ledger').get());
  ok(res.status === 200 && res2.status === 200 && res3.status === 200, 'admin + accounting get 200', [res.status, res2.status, res3.status]);
  ok(before === after, 'GET /reconcile performs zero writes (total_changes unchanged)', { before, after });
  ok(snap === snapAfter, 'warehouse_stock / ledger content unchanged');

  // ── RBAC ────────────────────────────────────────────────
  const rNo = await fetch(`${base}/api/inventory/reconcile`);
  ok(rNo.status === 401, 'unauthenticated → 401', rNo.status);
  const rSales = await fetch(`${base}/api/inventory/reconcile`, { headers: { Authorization: 'Bearer ' + tSales } });
  ok(rSales.status === 403, 'non admin/accounting → 403', rSales.status);

  // ── شکل پاسخ ───────────────────────────────────────────
  ok(body.ok === true && body.read_only === true, 'ok + read_only flags');
  ok(body.summary && typeof body.summary.rows_total === 'number' && typeof body.summary.products_checked === 'number', 'summary shape');
  ok(Array.isArray(body.rows) && Array.isArray(body.products), 'rows[] and products[] arrays');
  const e = body.exceptions || {};
  for (const k of ['ws_negative', 'ledger_without_warehouse', 'default_variant_with_stock', 'duplicate_opening', 'zero_qty_nonzero_value', 'variant_mismatches']) {
    ok(Array.isArray(e[k]), `exceptions.${k} is array`);
  }
  const row = body.rows.find((r) => r.product_id === pMatrix && r.warehouse_id === wh1);
  ok(!!row, 'matrix product × wh1 row present');
  if (row) {
    for (const k of ['products_stock', 'ws_qty', 'vws_sum', 'pv_stock_sum', 'ledger_qty', 'movements_qty',
      'ledger_value_rial', 'stock_x_avg_rial', 'flags', 'drift_any']) {
      ok(k in row, `row.${k} present`);
    }
    ok(row.flags.ws_vs_vws === true && row.flags.ws_vs_ledger === true && row.drift_any === true, 'ws+5 drift flagged (ws_vs_vws, ws_vs_ledger)', row);
    ok(row.ws_qty === 10 && row.vws_matrix_sum === 5 && row.ledger_qty === 5, 'matrix row numbers (ws=10, vws=5, ledger=5)', row);
  }
  ok(body.sources && body.sources.inventory_movements === true, 'movements table detected');

  // ── استثناها ────────────────────────────────────────────
  ok(e.ws_negative.some((x) => x.product_id === pNeg && x.ws_qty === -4), 'ws negative listed');
  ok(e.ledger_without_warehouse.some((x) => x.product_id === pNoWh && x.qty === 7), 'ledger without warehouse listed');
  ok(e.default_variant_with_stock.some((x) => x.product_id === pMatrix && x.pv_stock === 9), 'default variant with stock on matrix product listed');
  ok(e.duplicate_opening.some((x) => x.product_id === pDup && x.warehouse_id === wh1 && x.opening_rows === 2), 'duplicate opening listed');
  ok(e.zero_qty_nonzero_value.some((x) => x.product_id === pZero && x.ledger_value_rial === -17000000), 'qty=0 with value≠0 listed');
  ok(e.variant_mismatches.some((x) => x.variant_id === variants[2] && x.pv_stock === 11), 'pv vs vws variant mismatch listed');
  ok(body.summary.ws_negative >= 1 && body.summary.duplicate_opening >= 1 && body.summary.zero_qty_nonzero_value >= 1, 'summary counters reflect exceptions');

  // ── only_drift / فیلتر ───────────────────────────────────
  ok(body2.rows.length <= 5 && body2.rows.every((r) => r.drift_any || r.exception_any), 'only_drift + limit respected');
  ok(body3.rows.length === 1 && body3.rows[0].product_id === pMatrix, 'product_id + warehouse_id filter');

  // ── هشدار drift پس از سند انبار — بدون heal ──────────────
  const wsBefore = db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(pMatrix, wh1).qty;
  const doc2 = createWarehouseDoc(db, {
    type: 'receipt', warehouse_id: wh1, date: todayJalali(), receipt_class: 'adjustment', note: 'رسید روی کالای دارای اختلاف',
    lines: [{ product_id: pMatrix, variant_id: variants[3], qty: 1 }],
  }, admin);
  ok(doc2 && doc2.id, 'receipt on drifted product still succeeds', doc2);
  const warn = db.prepare("SELECT * FROM audit_log WHERE action='warning' AND entity='inventory_layer_drift' AND entity_id=?").get(doc2.id);
  ok(!!warn && /RC-MATRIX/.test(warn.detail), 'audit warning recorded for drifted pair', warn);
  const wsAfter = db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(pMatrix, wh1).qty;
  ok(wsAfter === wsBefore + 1, 'no heal: ws only moved by the document qty', { wsBefore, wsAfter });
  const rec2 = computeLayerReconcile(db, { productId: pMatrix, warehouseId: wh1 });
  ok(rec2.rows[0] && rec2.rows[0].drift_any === true, 'drift remains after document (report-only)');

  server.close();
  try { db.close(); } catch (_) { /* ignore */ }
  console.log(`\n══ Result: ${pass} passed, ${fail} failed ══\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
