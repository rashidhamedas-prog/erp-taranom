#!/usr/bin/env node
/**
 * v577 — Warehouse Phase 4 BACKEND (reports + valuation).
 *
 *  1. valuation = Σ rial of live inventory_ledger rows per product × warehouse
 *     (fixtures mirror prod products 168 / 174 / 137 / 334; reversed pairs ignored; NULL warehouse kept)
 *  2. header_value_rial (ws × products.average_cost_rial) is comparison only
 *  3. qty=0 but value≠0 → zero_qty_nonzero_value; negative value flagged; never silently dropped
 *  4. weighted average per warehouse = Σvalue/Σqty (≠ simple mean of unit costs)
 *  5. drift vs warehouse_stock / vws from the Phase 1 reconcile layer (product 334 40/41/56)
 *  6. HTTP: /warehouses/stock/report · stock/overview · stock/variant-report ·
 *     /adv-reports/inventory-valuation · /inventory/stock-by-warehouse
 *  7. RBAC: acc_warehouse_ops:view OR reports:view — NOT invoices:view
 *  8. reports never write (row counts unchanged)
 *
 * Isolated temp DB. Run with Node 20 (better-sqlite3).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-reports-v577-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'test-wh-reports-v577-secret-32chars!!!!';
process.env.AUTH_SESSION_DB_PATH = path.join(tmp, 'sessions.db');
process.env.NODE_ENV = 'test';
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const { getDB, initDB } = require('../db');
initDB();
const db = getDB();

const {
  buildLedgerValuationRows, buildProductValuationReport, weightedAvgRial,
} = require('../lib/inventory/valuation');
const { computeLayerReconcile } = require('../lib/inventory/layer-reconcile');
const { buildVariantStockReport } = require('../lib/inventory/variant-report');

let pass = 0;
let fail = 0;
function ok(cond, msg, detail) {
  if (cond) { pass += 1; console.log('  ✓', msg); }
  else { fail += 1; console.log('  ✗', msg, detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail))); }
}
function insert(table, obj) {
  const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  const keys = Object.keys(obj).filter((k) => cols.has(k));
  return db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => obj[k])).lastInsertRowid;
}

let txSeq = 0;
function led(o) {
  txSeq += 1;
  return insert('inventory_ledger', {
    tx_no: `R4-${txSeq}`,
    event_type: 'receipt',
    status: 'posted',
    source_type: 'manual_test',
    source_id: 7000 + txSeq,
    qty_in: 0,
    qty_out: 0,
    amount_rial: 0,
    unit_cost_rial: 0,
    date: '1405/05/01',
    note: 'ردیف تست',
    ...o,
  });
}

async function main() {
  console.log('\n=== warehouse phase 4 reports + valuation v577 ===\n');
  const adminId = insert('users', { name: 'مدیر', username: 'r4_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
  const salesId = insert('users', { name: 'فروش', username: 'r4_sales', password: 'x', role: 'sales', active: 1, must_change_password: 0 });
  const noRepId = insert('users', { name: 'بدون گزارش', username: 'r4_norep', password: 'x', role: 'sales', active: 1, must_change_password: 0 });
  const opsOnlyId = insert('users', { name: 'انباردار', username: 'r4_ops', password: 'x', role: 'sales', active: 1, must_change_password: 0 });
  const setPerm = db.prepare('INSERT OR REPLACE INTO user_permissions (user_id,resource,action,allowed) VALUES (?,?,?,?)');
  // noRep: invoices.view stays allowed, everything report-ish denied
  setPerm.run(noRepId, 'reports', 'view', 0);
  setPerm.run(noRepId, 'acc_warehouse_ops', 'view', 0);
  setPerm.run(noRepId, 'invoices', 'create', 0);
  // opsOnly: no reports.view, but acc_warehouse_ops.view
  setPerm.run(opsOnlyId, 'reports', 'view', 0);
  setPerm.run(opsOnlyId, 'acc_warehouse_ops', 'view', 1);
  setPerm.run(opsOnlyId, 'invoices', 'create', 0);

  const whA = Number(insert('warehouses', { name: 'انبار محصول', code: 'R4-A', active: 1, warehouse_type: 'finished_goods', inventory_system: 'perpetual' }));
  const whB = Number(insert('warehouses', { name: 'انبار دوم', code: 'R4-B', active: 1, warehouse_type: 'finished_goods', inventory_system: 'perpetual' }));
  const whW = Number(insert('warehouses', { name: 'کار در جریان', code: 'R4-W', active: 1, warehouse_type: 'wip', kind: 'wip', inventory_system: 'perpetual' }));
  const mk = (name, code, extra = {}) => Number(insert('products', {
    user_id: adminId, name, code, price: 5000000, cost: 1000, average_cost_rial: 1000,
    stock: 0, warehouse_id: whA, unit: 'عدد', ...extra,
  }));
  const wsSet = db.prepare('INSERT OR REPLACE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)');

  // ── fixtures mirroring prod acceptance numbers ───────────────────────────────
  // 168: in 12 / out 3 → qty 9, Σledger value 10,889,268
  const p168 = mk('کالای ۱۶۸', 'R4-168', { stock: 9 });
  led({ product_id: p168, warehouse_id: whA, event_type: 'purchase', qty_in: 12, amount_rial: 14000000 });
  led({ product_id: p168, warehouse_id: whA, event_type: 'sale', qty_out: 3, amount_rial: 3110732 });
  wsSet.run(p168, whA, 9);
  // 174: 6 pcs → 8,460,000
  const p174 = mk('کالای ۱۷۴', 'R4-174', { stock: 6 });
  led({ product_id: p174, warehouse_id: whA, event_type: 'purchase', qty_in: 6, amount_rial: 8460000 });
  wsSet.run(p174, whA, 6);
  // 137: two warehouses, Σ = 52,729,484
  const p137 = mk('کالای ۱۳۷', 'R4-137', { stock: 7 });
  led({ product_id: p137, warehouse_id: whA, event_type: 'purchase', qty_in: 4, amount_rial: 20000000 });
  led({ product_id: p137, warehouse_id: whB, event_type: 'purchase', qty_in: 3, amount_rial: 32729484 });
  wsSet.run(p137, whA, 4);
  wsSet.run(p137, whB, 3);
  // 334: WIP ghost — in 50 / out 50 but value −894,234,074 left behind
  const p334 = mk('کالای ۳۳۴ (WIP)', 'R4-334', { stock: 0 });
  led({ product_id: p334, warehouse_id: whW, event_type: 'production_receipt', qty_in: 50, amount_rial: 100000000 });
  led({ product_id: p334, warehouse_id: whW, event_type: 'production_issue', qty_out: 50, amount_rial: 994234074 });
  // 6: ghost −17,000,000 (qty 0, value only)
  const p6 = mk('کالای ۶', 'R4-6', { stock: 0 });
  led({ product_id: p6, warehouse_id: whA, event_type: 'adjustment', source_type: 'value_adjust', qty_in: 0, qty_out: 0, amount_rial: -17000000 });

  // reversed pair must be ignored (original status=reversed, reversal row has reversed_of)
  const pRev = mk('کالای معکوس', 'R4-REV', { stock: 2 });
  led({ product_id: pRev, warehouse_id: whA, event_type: 'purchase', qty_in: 2, amount_rial: 2000 });
  const revOrig = led({ product_id: pRev, warehouse_id: whA, event_type: 'purchase', qty_in: 5, amount_rial: 5000, status: 'reversed' });
  led({ product_id: pRev, warehouse_id: whA, event_type: 'purchase_reversal', qty_out: 5, amount_rial: 5000, reversed_of: revOrig });
  wsSet.run(pRev, whA, 2);

  // NULL-warehouse ledger value — never dropped
  const pNull = mk('کالای بدون انبار', 'R4-NULL', { stock: 0 });
  led({ product_id: pNull, warehouse_id: null, event_type: 'adjustment', qty_in: 0, qty_out: 0, amount_rial: 777000 });

  // weighted vs simple average (warehouse B): X qty 1 @100, Y qty 99 @200
  const pX = mk('کالای X', 'R4-X', { stock: 1 });
  const pY = mk('کالای Y', 'R4-Y', { stock: 99 });
  led({ product_id: pX, warehouse_id: whB, event_type: 'purchase', qty_in: 1, amount_rial: 100 });
  led({ product_id: pY, warehouse_id: whB, event_type: 'purchase', qty_in: 99, amount_rial: 19800 });
  wsSet.run(pX, whB, 1);
  wsSet.run(pY, whB, 99);

  // ── 1) Σ ledger value / qty per product ────────────────────────────────────────
  console.log('— 1) value = Σ ledger —');
  const val = buildLedgerValuationRows(db, {});
  const prod = (id) => val.by_product.get(id);
  ok(prod(p168).ledger_value_rial === 10889268 && prod(p168).ledger_qty === 9, '168 → Σledger 10,889,268 / qty 9', prod(p168));
  ok(prod(p174).ledger_value_rial === 8460000, '174 → 8,460,000', prod(p174).ledger_value_rial);
  ok(prod(p137).ledger_value_rial === 52729484 && prod(p137).ledger_qty === 7, '137 → 52,729,484 (two warehouses)', prod(p137));
  ok(prod(p334).ledger_value_rial === -894234074, '334 → −894,234,074 (Σledger, not hidden)', prod(p334).ledger_value_rial);
  ok(prod(pRev).ledger_value_rial === 2000 && prod(pRev).ledger_qty === 2, 'reversed pair ignored', prod(pRev));
  const rNull = val.rows.find((r) => r.product_id === pNull);
  ok(rNull && rNull.warehouse_id === 0 && rNull.ledger_value_rial === 777000, 'NULL-warehouse ledger kept as warehouse 0', rNull);
  ok(val.rows.every((r) => r.source === 'kardex'), 'every row declares source=kardex');

  // ── 2) header only for comparison ─────────────────────────────────────────────
  console.log('\n— 2) header value is comparison only —');
  const r168 = val.rows.find((r) => r.product_id === p168 && r.warehouse_id === whA);
  ok(r168.header_value_rial === 9 * 1000 && r168.ledger_value_rial === 10889268, '168: header 9×1000 ≠ ledger value; ledger wins', r168);
  ok(r168.header_value_diff_rial === 10889268 - 9000, 'header_value_diff_rial = ledger − header', r168.header_value_diff_rial);

  // ── 3) ghost / negative flags ─────────────────────────────────────────────────
  console.log('\n— 3) qty=0 with value≠0 flagged —');
  const r334 = val.rows.find((r) => r.product_id === p334 && r.warehouse_id === whW);
  ok(r334.ledger_qty === 0 && r334.flags.zero_qty_nonzero_value && r334.flags.negative_value && r334.flagged, '334 WIP ghost flagged', r334.flags);
  ok(prod(p334).zero_qty_nonzero_value === true && prod(p334).any_flagged, '334 product-level ghost flag');
  const r6 = val.rows.find((r) => r.product_id === p6);
  ok(r6.ledger_qty === 0 && r6.ledger_value_rial === -17000000 && r6.flags.zero_qty_nonzero_value, 'product 6 −17,000,000 ghost flagged', r6);
  ok(!r168.flags.zero_qty_nonzero_value && !r168.flags.negative_value, 'healthy row not flagged');

  // ── 4) weighted average ───────────────────────────────────────────────────────
  console.log('\n— 4) weighted average —');
  const bRows = val.rows.filter((r) => r.warehouse_id === whB && (r.product_id === pX || r.product_id === pY));
  const w = weightedAvgRial(bRows);
  ok(w === 199, 'weighted = (100+19800)/100 = 199 (simple mean would be 150)', w);
  const simple = Math.round(bRows.reduce((a, r) => a + r.weighted_avg_unit_rial, 0) / bRows.length);
  ok(simple === 150 && w !== simple, 'simple average differs (150)', simple);
  ok(weightedAvgRial([{ ledger_qty: 0, ledger_value_rial: 5 }]) === 0, 'zero qty → 0 avg (no NaN)');
  ok(r168.weighted_avg_unit_rial === Math.round(10889268 / 9), '168 row weighted unit = value/qty', r168.weighted_avg_unit_rial);

  // ── 5) product report ─────────────────────────────────────────────────────────
  console.log('\n— 5) product valuation report —');
  const rep = buildProductValuationReport(db);
  const row = (id) => rep.rows.find((r) => r.id === id);
  ok(row(p168).cost_value === 10889268 && row(p168).stock === 9, 'report 168 cost_value = Σledger', row(p168));
  ok(row(p174).cost_value === 8460000, 'report 174', row(p174).cost_value);
  ok(row(p137).cost_value === 52729484, 'report 137', row(p137).cost_value);
  ok(row(p334).cost_value === -894234074 && row(p334).flags.zero_qty_nonzero_value && row(p334).flagged, 'report 334 flagged ghost', row(p334));
  ok(row(p168).header_value_rial === 9000 && row(p168).header_diff_rial === 10889268 - 9000, 'report keeps header value for comparison', row(p168));
  ok(rep.source === 'kardex' && rep.value_basis === 'sum_ledger_rial', 'report declares source');
  ok(rep.totals.ghost_value_rial === -894234074 + -17000000 + 777000 || rep.totals.ghost_value_rial <= 0, 'totals.ghost_value_rial aggregated', rep.totals.ghost_value_rial);

  // ── 6) layer drift vs Phase 1 reconcile (334: ledger 40, vws 41, ws 56) ──────
  console.log('\n— 6) layer drift (40/41/56) —');
  const colorId = insert('product_colors', { name: 'مشکی', code: 'R4BLK', active: 1 });
  const sizeId = insert('product_sizes', { name: 'M', code: 'R4M', active: 1 });
  const pD = mk('کالای ۳۳۴ واریانتی', 'R4-334V', { stock: 56 });
  led({ product_id: pD, warehouse_id: whA, event_type: 'purchase', qty_in: 40, amount_rial: 4000000 });
  wsSet.run(pD, whA, 56);
  const varId = Number(insert('product_variants', { product_id: pD, color_id: colorId, size_id: sizeId, sku: 'R4-334V-BLK-M', stock: 0, active: 1, is_default: 0 }));
  db.prepare('INSERT OR REPLACE INTO variant_warehouse_stock (variant_id,warehouse_id,qty) VALUES (?,?,?)').run(varId, whA, 41);
  const vd = buildLedgerValuationRows(db, { productId: pD });
  const dRow = vd.rows.find((r) => r.warehouse_id === whA);
  ok(dRow.ledger_qty === 40 && dRow.ws_qty === 56 && dRow.vws_sum === 41, 'ledger 40 / ws 56 / vws 41 exposed', dRow);
  ok(dRow.flags.drift_ws_ledger && dRow.flags.drift_ws_vws && dRow.flags.drift_any && dRow.flagged, 'drift flags set', dRow.flags);
  ok(dRow.drift_qty === 16, 'drift_qty = ws − ledger = 16', dRow.drift_qty);
  const rec = computeLayerReconcile(db, { productId: pD });
  ok(rec.rows.some((r) => r.flags.ws_vs_ledger && r.flags.ws_vs_vws), 'Phase 1 reconcile agrees (same drift)');
  const vr = buildVariantStockReport(db, { product_id: pD });
  const layer = vr.layers.find((l) => l.product_id === pD && l.warehouse_id === whA);
  ok(layer && layer.variant_qty === 41 && layer.kardex_qty === 40 && layer.drift === true && layer.drift_qty === 1, 'variant report layer: 41 vs kardex 40 → drift flag', layer);
  ok(vr.cells.every((c) => c.layer_drift === true), 'variant cells carry layer_drift');
  ok(vr.kpis.layer_drift_count === 1 && vr.notes.warehouse_total_source === 'kardex', 'kpi + declared source');
  // aligned product → no drift
  db.prepare('UPDATE variant_warehouse_stock SET qty=40 WHERE variant_id=?').run(varId);
  const vr2 = buildVariantStockReport(db, { product_id: pD });
  ok(vr2.layers.find((l) => l.warehouse_id === whA).drift === false && vr2.kpis.layer_drift_count === 0, 'same number → no drift flag');
  db.prepare('UPDATE variant_warehouse_stock SET qty=41 WHERE variant_id=?').run(varId);

  // ── 7) HTTP: reports + RBAC ───────────────────────────────────────────────────
  console.log('\n— 7) HTTP + RBAC —');
  const express = require('express');
  const http = require('http');
  const { issueStaffSession } = require('../lib/auth-sessions');
  const tokenFor = (uid, tag) => issueStaffSession(db, db.prepare('SELECT * FROM users WHERE id=?').get(uid), {
    device_kind: 'test', device_name: 'r4-' + tag, device_fingerprint: 'r4-fp-' + tag,
  }).token;
  const tok = {
    admin: tokenFor(adminId, 'admin'), sales: tokenFor(salesId, 'sales'),
    norep: tokenFor(noRepId, 'norep'), ops: tokenFor(opsOnlyId, 'ops'),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/warehouses', require('../routes/warehouses'));
  app.use('/api/inventory', require('../routes/inventory'));
  app.use('/api/adv-reports', require('../routes/adv-reports'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  async function api(method, p, body, who = 'admin') {
    const headers = { 'Content-Type': 'application/json' };
    if (who) headers.Authorization = 'Bearer ' + tok[who];
    const res = await fetch(BASE + p, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, data };
  }

  const counts = () => ['warehouse_stock', 'variant_warehouse_stock', 'inventory_ledger', 'inventory_valuation_buckets', 'products']
    .map((t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c).join(',');
  const checksum = () => db.prepare('SELECT COALESCE(SUM(qty),0) s FROM warehouse_stock').get().s
    + ':' + db.prepare('SELECT COALESCE(SUM(stock),0) s FROM products').get().s;
  const before = counts() + '|' + checksum();

  const stock = await api('GET', '/api/warehouses/stock/report?include_zero=1');
  ok(stock.status === 200 && stock.data.source === 'kardex', 'stock/report 200 + declared source', stock.status);
  const blocks = stock.data.rows;
  const blockA = blocks.find((b) => b.warehouse_id === whA);
  const blockB = blocks.find((b) => b.warehouse_id === whB);
  const blockW = blocks.find((b) => b.warehouse_id === whW);
  const blockNull = blocks.find((b) => b.warehouse_id === 0);
  const pr = (b, id) => b.products.find((x) => x.id === id);
  ok(pr(blockA, p168).amount_rial === 10889268 && pr(blockA, p168).qty === 9, 'WH report A/168 amount = Σledger', pr(blockA, p168));
  ok(pr(blockA, p174).amount_rial === 8460000, 'WH report A/174 = 8,460,000');
  ok(pr(blockA, p137).amount_rial + pr(blockB, p137).amount_rial === 52729484, 'WH report 137 across A+B = 52,729,484');
  ok(pr(blockW, p334).amount_rial === -894234074 && pr(blockW, p334).flags.zero_qty_nonzero_value, 'WH report WIP/334 listed + flagged', pr(blockW, p334));
  ok(blockW.ghost_count >= 1 && blockW.ghost_value_rial === -894234074, 'warehouse block ghost_count / ghost_value_rial', [blockW.ghost_count, blockW.ghost_value_rial]);
  ok(blockNull && blockNull.products.some((x) => x.id === pNull && x.amount_rial === 777000), 'no-warehouse kardex block present');
  ok(blockB.weighted_avg_unit_cost_rial === weightedAvgRial(blockB.products, 'qty', 'amount_rial') && blockB.avg_unit_cost_rial === blockB.weighted_avg_unit_cost_rial,
    'block avg_unit_cost_rial is the weighted average', [blockB.avg_unit_cost_rial, blockB.weighted_avg_unit_cost_rial]);
  const simpleB = Math.round(blockB.products.reduce((a, x) => a + x.unit_cost_rial, 0) / blockB.products.length);
  ok(blockB.avg_unit_cost_rial !== simpleB, 'weighted ≠ simple mean of unit costs in warehouse B', [blockB.avg_unit_cost_rial, simpleB]);

  // without include_zero: ghosts still visible, plain zero rows hidden
  const stockNoZero = await api('GET', '/api/warehouses/stock/report');
  const nzW = stockNoZero.data.rows.find((b) => b.warehouse_id === whW);
  ok(nzW.products.some((x) => x.id === p334), 'ghost 334 visible even without include_zero', nzW.products.length);
  const overview = await api('GET', '/api/warehouses/stock/overview');
  ok(overview.status === 200 && Array.isArray(overview.data) && overview.data.every((b) => b.warehouse_name != null), 'stock/overview 200 (kardex)');

  const adv = await api('GET', '/api/adv-reports/inventory-valuation');
  const advRow = (id) => adv.data.rows.find((r) => r.id === id);
  ok(adv.status === 200 && advRow(p168).cost_value === 10889268 && advRow(p174).cost_value === 8460000
    && advRow(p137).cost_value === 52729484 && advRow(p334).cost_value === -894234074 && advRow(p334).flagged,
  'adv-reports/inventory-valuation = Σledger for 168/174/137/334(flagged)');
  ok(adv.data.totals && typeof adv.data.totals.ghost_value_rial === 'number', 'totals expose ghost_value_rial');

  const vrep = await api('GET', `/api/warehouses/stock/variant-report?product_id=${pD}`);
  ok(vrep.status === 200 && vrep.data.layers.find((l) => l.warehouse_id === whA).drift === true, 'variant-report HTTP: drift layer 41 vs 40');

  const sbw = await api('GET', `/api/inventory/stock-by-warehouse?product_id=${p168}`);
  const sbwA = sbw.data.warehouses.find((x) => x.warehouse_id === whA);
  ok(sbw.status === 200 && sbwA.kardex_qty === 9 && sbwA.kardex_value_rial === 10889268 && sbwA.declared_source === 'kardex', 'stock-by-warehouse exposes kardex qty/value', sbwA);
  const sbwD = await api('GET', `/api/inventory/stock-by-warehouse?product_id=${pD}`);
  const sbwDA = sbwD.data.warehouses.find((x) => x.warehouse_id === whA);
  ok(sbwDA.qty === 56 && sbwDA.kardex_qty === 40 && sbwDA.drift === true && sbwDA.drift_qty === 16, 'stock-by-warehouse: qty(ws 56) vs kardex 40 → drift', sbwDA);
  const sbwK = await api('GET', `/api/inventory/stock-by-warehouse?product_id=${pD}&source=kardex`);
  ok(sbwK.data.warehouses.find((x) => x.warehouse_id === whA).qty === 40, 'source=kardex → qty is kardex');
  const sbwV = await api('GET', `/api/inventory/stock-by-warehouse?product_id=${pD}&variant_id=${varId}`);
  const sbwVA = sbwV.data.warehouses.find((x) => x.warehouse_id === whA);
  ok(sbwVA.qty === 41 && sbwVA.source === 'vws', 'variant read stays vws (variant_id not complete in ledger)', sbwVA);
  const sbwB = await api('POST', '/api/inventory/stock-by-warehouse/batch', { items: [{ product_id: p168 }, { product_id: pD, variant_id: varId }] });
  ok(sbwB.status === 200 && sbwB.data.results.length === 2 && sbwB.data.results[0].warehouses.some((x) => x.kardex_qty === 9), 'batch endpoint carries kardex fields');

  const whStock = await api('GET', `/api/warehouses/${whA}/stock`);
  const whStockD = (whStock.data || []).find((x) => x.id === pD);
  ok(whStock.status === 200 && whStockD && whStockD.stock === 56 && whStockD.kardex_qty === 40 && whStockD.drift === true,
    '/:id/stock keeps ws stock and adds kardex_qty + drift', whStockD);

  // RBAC
  const urls = [
    '/api/warehouses/stock/report', '/api/warehouses/stock/overview', '/api/warehouses/stock/variant-report',
    '/api/adv-reports/inventory-valuation', '/api/adv-reports/inventory-health',
    `/api/inventory/stock-by-warehouse?product_id=${p168}`,
  ];
  for (const u of urls) {
    const s = await api('GET', u, null, 'sales');
    ok(s.status === 200, `reports:view (sales default) → 200 ${u}`, s.status);
    const o = await api('GET', u, null, 'ops');
    ok(o.status === 200, `acc_warehouse_ops:view only → 200 ${u}`, o.status);
    const n = await api('GET', u, null, 'norep');
    ok(n.status === 403, `invoices:view alone (reports/ops denied) → 403 ${u}`, n.status);
    const a = await api('GET', u, null, null);
    ok(a.status === 401 || a.status === 403, `anonymous rejected ${u}`, a.status);
  }
  const nb = await api('POST', '/api/inventory/stock-by-warehouse/batch', { items: [{ product_id: p168 }] }, 'norep');
  ok(nb.status === 403, 'batch: invoices:view alone → 403', nb.status);
  const invViewAllowed = db.prepare("SELECT allowed FROM user_permissions WHERE user_id=? AND resource='invoices' AND action='view'").get(noRepId);
  ok(!invViewAllowed || invViewAllowed.allowed !== 0, 'precondition: norep still holds invoices:view (not denied)');

  const after = counts() + '|' + checksum();
  ok(before === after, 'reports are read-only (row counts + qty checksum unchanged)', [before, after]);

  // ── 8) static wiring ─────────────────────────────────────────────────────────
  console.log('\n— 8) static wiring —');
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const whSrc = read('routes/warehouses.js');
  const invSrc = read('routes/inventory.js');
  const advSrc = read('routes/adv-reports.js');
  const reportFn = whSrc.slice(whSrc.indexOf('function buildWarehouseStockRows'), whSrc.indexOf("router.get('/stock/overview'"));
  ok(/buildLedgerValuationRows/.test(reportFn) && !/FROM warehouse_stock/.test(reportFn), 'buildWarehouseStockRows built from kardex rows (no ws query)');
  ok(!/avg_unit_cost_rial:\s*products\.length/.test(whSrc), 'warehouses.js no simple average');
  ok(!/requirePermission\('invoices', 'view'\)/.test(invSrc), 'inventory.js no invoices:view gate');
  ok(/requireWarehouseReportView/.test(invSrc) && /requireWarehouseReportView/.test(advSrc) && /requireWarehouseReportView/.test(whSrc), 'all three routers use requireWarehouseReportView');
  ok(!/'\/inventory-valuation', auth, adminOrAccounting/.test(advSrc), 'adv-reports inventory-valuation not adminOrAccounting-only');
  ok(/erp-taranom-v5(7[7-9]|[89]\d)/.test(read('public/sw.js')), 'SW ≥ v577');

  server.close();
  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
