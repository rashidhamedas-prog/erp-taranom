#!/usr/bin/env node
/**
 * v576 — Warehouse Phase 3 BACKEND (kardex):
 *  1. ORDER BY COALESCE(date,''), id  (buildStockLedger + getKardex)
 *  2. running qty AND running value (rial) for the SAME filter
 *  3. pagination (page / page_size ≤ 500) with page-start opening; no hard LIMIT 500
 *  4. filters: warehouse_id, variant_id (when the column exists), from / to (Jalali)
 *  5. toggles: show_wip, show_warehouse_only, show_cancelled (structural — NO note regex)
 *  6. source-document links (production / invoice / purchase / adjust / stocktaking / warehouse_doc)
 *  7. kardex closing == Phase 1 reconcile Σledger (qty and value)
 *  8. routes wire the query params
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-kardex-p3-v576-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-wh-kardex-p3-v576-secret-32chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(tmp, 'sessions.db');
process.env.NODE_ENV = 'test';

const { getDB, initDB } = require('../db');
initDB();
const db = getDB();

const { buildStockLedger, stockToCsv } = require('../lib/ledgers');
const { getKardex, ledgerHasVariantColumn } = require('../lib/inventory/ledger');
const { computeLayerReconcile } = require('../lib/inventory/layer-reconcile');

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

if (!ledgerHasVariantColumn(db)) {
  try { db.exec('ALTER TABLE inventory_ledger ADD COLUMN variant_id INTEGER'); } catch (_) { /* exists */ }
}

let txSeq = 0;
function led(o) {
  txSeq += 1;
  return insert('inventory_ledger', {
    tx_no: `K3-${txSeq}`,
    event_type: 'receipt',
    status: 'posted',
    source_type: 'manual_test',
    source_id: 9000 + txSeq,
    qty_in: 0,
    qty_out: 0,
    amount_rial: 0,
    unit_cost_rial: 0,
    note: 'ردیف تست',
    ...o,
  });
}
const lastOf = (r) => r.lines[r.lines.length - 1];

function main() {
  console.log('\n=== warehouse phase 3 kardex v576 ===\n');
  const adminId = insert('users', { name: 'مدیر', username: 'k3_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
  const whA = insert('warehouses', { name: 'انبار الف', code: 'K3-A', active: 1, warehouse_type: 'finished_goods', inventory_system: 'perpetual' });
  const whB = insert('warehouses', { name: 'انبار ب', code: 'K3-B', active: 1, warehouse_type: 'finished_goods', inventory_system: 'perpetual' });
  const whW = insert('warehouses', { name: 'کار در جریان', code: 'K3-W', active: 1, warehouse_type: 'wip', kind: 'wip', inventory_system: 'perpetual' });
  const mkProduct = (name, code) => insert('products', {
    user_id: adminId, name, code, price: 200000, cost: 1000, average_cost_rial: 1000,
    stock: 0, warehouse_id: whA, unit: 'عدد',
  });

  // ── 1) ORDER: rows inserted out of date order (id 2 is EARLIER than id 1) ─────
  console.log('— 1) order by COALESCE(date,\'\'), id —');
  const p1 = mkProduct('کالای ۱۸۹', 'K3-189');
  led({ product_id: p1, warehouse_id: whA, event_type: 'opening', source_type: 'opening_inventory', qty_in: 5, amount_rial: 5000, unit_cost_rial: 1000, date: '1405/02/01' });
  led({ product_id: p1, warehouse_id: whA, event_type: 'opening', source_type: 'opening_inventory', qty_in: 1, amount_rial: 1000, unit_cost_rial: 1000, date: '1405/01/01' });
  const o1 = buildStockLedger(db, { product_id: p1, warehouse_id: whA });
  ok(o1.lines.length === 2, 'two opening rows listed', o1.lines.length);
  ok(o1.lines[0].date === '1405/01/01' && o1.lines[1].date === '1405/02/01', 'ordered by date (not id)', o1.lines.map((l) => l.date));
  ok(o1.lines[0].running_qty === 1 && o1.lines[1].running_qty === 6, 'running qty 1 then 6 (not 7)', o1.lines.map((l) => l.running_qty));
  ok(o1.lines[0].running_value_rial === 1000 && o1.lines[1].running_value_rial === 6000, 'running value 1000 then 6000', o1.lines.map((l) => l.running_value_rial));
  const k1 = getKardex(db, p1, { warehouseId: whA });
  ok(k1.rows.map((r) => r.running_qty).join() === '1,6', 'getKardex: same order + running qty 1,6', k1.rows.map((r) => r.running_qty));
  ok(k1.rows.map((r) => r.running_value_rial).join() === '1000,6000', 'getKardex: running value', k1.rows.map((r) => r.running_value_rial));

  // ── 2) running qty + value from the FILTER, not the header qty_balance ───────
  console.log('\n— 2) running balances for the same filter —');
  const p2 = mkProduct('کالای دو انباره', 'K3-2WH');
  led({ product_id: p2, warehouse_id: whA, event_type: 'purchase', source_type: 'purchase', source_id: 501, qty_in: 10, amount_rial: 10000, unit_cost_rial: 1000, date: '1405/03/01', qty_balance: 10 });
  led({ product_id: p2, warehouse_id: whB, event_type: 'purchase', source_type: 'purchase', source_id: 502, qty_in: 7, amount_rial: 14000, unit_cost_rial: 2000, date: '1405/03/02', qty_balance: 17 });
  led({ product_id: p2, warehouse_id: whA, event_type: 'sale', source_type: 'invoice', source_id: 601, qty_out: 4, amount_rial: 4000, unit_cost_rial: 1000, date: '1405/03/03', qty_balance: 13 });
  const aOnly = buildStockLedger(db, { product_id: p2, warehouse_id: whA });
  ok(aOnly.lines.map((l) => l.running_qty).join() === '10,6', 'wh A running qty 10,6 (header qty_balance ignored)', aOnly.lines.map((l) => l.running_qty));
  ok(aOnly.lines.map((l) => l.running_value_rial).join() === '10000,6000', 'wh A running value 10000,6000', aOnly.lines.map((l) => l.running_value_rial));
  ok(aOnly.closing_qty === 6 && aOnly.closing_value_rial === 6000, 'wh A closing qty/value', [aOnly.closing_qty, aOnly.closing_value_rial]);
  const bOnly = buildStockLedger(db, { product_id: p2, warehouse_id: whB });
  ok(bOnly.closing_qty === 7 && bOnly.closing_value_rial === 14000, 'wh B closing qty/value', [bOnly.closing_qty, bOnly.closing_value_rial]);
  const all = buildStockLedger(db, { product_id: p2 });
  ok(lastOf(all).running_qty === 13 && lastOf(all).running_value_rial === 20000, 'all warehouses running qty 13 / value 20000', [lastOf(all).running_qty, lastOf(all).running_value_rial]);
  const kA = getKardex(db, p2, { warehouseId: whA });
  ok(kA.closing_qty === 6 && kA.closing_value_rial === 6000
    && kA.rows[kA.rows.length - 1].running_value_rial === 6000, 'getKardex wh A closing = ledger Σ', [kA.closing_qty, kA.closing_value_rial]);

  // ── 3) from / to with opening qty + value ────────────────────────────────────
  console.log('\n— 3) from/to opening —');
  const per = buildStockLedger(db, { product_id: p2, warehouse_id: whA, from: '1405/03/02', to: '1405/03/31' });
  ok(per.opening_qty === 10 && per.opening_value_rial === 10000, 'opening qty/value before «from»', [per.opening_qty, per.opening_value_rial]);
  ok(per.lines.length === 1 && per.lines[0].running_qty === 6 && per.lines[0].running_value_rial === 6000, 'period line continues from opening', per.lines);
  const perK = getKardex(db, p2, { warehouseId: whA, from: '1405/03/02', to: '1405/03/31' });
  ok(perK.opening_qty === 10 && perK.opening_value_rial === 10000 && perK.rows.length === 1 && perK.rows[0].running_qty === 6, 'getKardex from/to opening', [perK.opening_qty, perK.rows.length]);
  const unpadded = getKardex(db, p2, { warehouseId: whA, from: '1405/3/2' });
  ok(unpadded.opening_qty === 10, 'unpadded Jalali from compares by date key', unpadded.opening_qty);

  // ── 4) pagination: > 500 rows, no hard LIMIT 500, page opening ───────────────
  console.log('\n— 4) pagination (>500 rows) —');
  const pBig = mkProduct('کالای زیاد', 'K3-BIG');
  const TOTAL = 520;
  db.transaction(() => {
    for (let i = 0; i < TOTAL; i += 1) {
      const day = String((i % 28) + 1).padStart(2, '0');
      led({ product_id: pBig, warehouse_id: whA, qty_in: 1, amount_rial: 100, unit_cost_rial: 100, date: `1405/04/${day}`, source_id: 70000 + i });
    }
  })();
  const bigAll = getKardex(db, pBig, { warehouseId: whA });
  ok(bigAll.rows.length === TOTAL, `getKardex without page returns all ${TOTAL} rows (no LIMIT 500)`, bigAll.rows.length);
  ok(bigAll.closing_qty === TOTAL && bigAll.closing_value_rial === TOTAL * 100, 'closing = Σledger', [bigAll.closing_qty, bigAll.closing_value_rial]);
  const bp1 = getKardex(db, pBig, { warehouseId: whA, page: 1, pageSize: 500 });
  const bp2 = getKardex(db, pBig, { warehouseId: whA, page: 2, pageSize: 500 });
  ok(bp1.rows.length === 500 && bp2.rows.length === 20 && bp2.total_pages === 2, 'page 1 = 500, last page = 20', [bp1.rows.length, bp2.rows.length, bp2.total_pages]);
  ok(bp1.opening_qty === 0 && bp2.opening_qty === 500 && bp2.opening_value_rial === 50000, 'last page opening = running after page 1', [bp2.opening_qty, bp2.opening_value_rial]);
  ok(bp2.page_closing_qty === TOTAL && bp2.closing_qty === TOTAL && bp2.page_closing_value_rial === TOTAL * 100, 'last page closing = Σledger', [bp2.page_closing_qty, bp2.closing_qty]);
  ok(bp2.rows[0].running_qty === 501, 'first row of last page continues the running balance', bp2.rows[0].running_qty);
  const capped = getKardex(db, pBig, { warehouseId: whA, page: 1, pageSize: 99999 });
  ok(capped.page_size === 500 && capped.rows.length === 500, 'page_size capped at 500', capped.page_size);
  const beyond = getKardex(db, pBig, { warehouseId: whA, page: 9, pageSize: 500 });
  ok(beyond.rows.length === 0 && beyond.opening_qty === TOTAL, 'page beyond the end → empty, opening = closing', [beyond.rows.length, beyond.opening_qty]);

  const lb1 = buildStockLedger(db, { product_id: pBig, warehouse_id: whA, page: 1, page_size: 200 });
  const lb3 = buildStockLedger(db, { product_id: pBig, warehouse_id: whA, page: 3, page_size: 200 });
  ok(lb1.lines.length === 200 && lb1.total_lines === TOTAL && lb1.total_pages === 3 && lb1.pagination.has_more === true, 'ledgers page 1/3 meta', lb1.pagination);
  ok(lb1.opening_qty === 0 && lb1.period_opening_qty === 0, 'page 1 opening = period opening', lb1.opening_qty);
  ok(lb3.lines.length === 120 && lb3.opening_qty === 400 && lb3.opening_value_rial === 40000, 'page 3 opening qty/value', [lb3.lines.length, lb3.opening_qty, lb3.opening_value_rial]);
  ok(lb3.page_closing_qty === TOTAL && lb3.closing_qty === TOTAL && lb3.pagination.has_more === false, 'last page closing = Σledger', [lb3.page_closing_qty, lb3.closing_qty]);
  ok(lb3.period_opening_qty === 0 && lb3.period_qty_in === TOTAL, 'period totals stay whole-range on a later page', [lb3.period_opening_qty, lb3.period_qty_in]);
  const lbCap = buildStockLedger(db, { product_id: pBig, warehouse_id: whA, page: 1, page_size: 5000 });
  ok(lbCap.page_size === 500 && lbCap.lines.length === 500, 'ledgers page_size capped at 500', lbCap.page_size);
  const lbNo = buildStockLedger(db, { product_id: pBig, warehouse_id: whA });
  ok(lbNo.lines.length === TOTAL && lbNo.pagination.paginated === false, 'no page params → everything (backward compatible)', lbNo.lines.length);
  ok(lastOf(lbNo).running_qty === TOTAL, 'unpaginated last running = Σledger', lastOf(lbNo).running_qty);

  // ── 5) variant filter ────────────────────────────────────────────────────────
  console.log('\n— 5) variant filter —');
  ok(ledgerHasVariantColumn(db), 'inventory_ledger.variant_id column present');
  const pV = mkProduct('کالای واریانت', 'K3-VAR');
  led({ product_id: pV, warehouse_id: whA, qty_in: 10, amount_rial: 10000, unit_cost_rial: 1000, date: '1405/05/01', variant_id: 11, source_id: 81001 });
  led({ product_id: pV, warehouse_id: whA, qty_in: 4, amount_rial: 8000, unit_cost_rial: 2000, date: '1405/05/02', variant_id: 12, source_id: 81002 });
  led({ product_id: pV, warehouse_id: whA, qty_out: 3, amount_rial: 3000, unit_cost_rial: 1000, date: '1405/05/03', variant_id: 11, source_id: 81003, event_type: 'issue' });
  const v11 = buildStockLedger(db, { product_id: pV, warehouse_id: whA, variant_id: 11 });
  ok(v11.variant_filter_applied === true && v11.lines.length === 2, 'variant 11 → its 2 rows only', v11.lines.length);
  ok(lastOf(v11).running_qty === 7 && lastOf(v11).running_value_rial === 7000, 'variant 11 running qty/value for that filter', [lastOf(v11).running_qty, lastOf(v11).running_value_rial]);
  ok(v11.closing_qty === 7 && v11.closing_value_rial === 7000, 'variant 11 closing', [v11.closing_qty, v11.closing_value_rial]);
  const v12 = buildStockLedger(db, { product_id: pV, warehouse_id: whA, variant_id: 12 });
  ok(v12.closing_qty === 4 && v12.closing_value_rial === 8000, 'variant 12 closing', [v12.closing_qty, v12.closing_value_rial]);
  ok(v11.book_gap_qty === 0, 'book_gap_qty not computed for a variant filter (warehouse_stock is not variant-scoped)', v11.book_gap_qty);
  const kv11 = getKardex(db, pV, { warehouseId: whA, variantId: 11 });
  ok(kv11.variant_filter_applied === true && kv11.rows.length === 2 && kv11.closing_qty === 7, 'getKardex variant filter', [kv11.rows.length, kv11.closing_qty]);
  const noVar = buildStockLedger(db, { product_id: pV, warehouse_id: whA });
  ok(noVar.closing_qty === 11 && noVar.variant_filter_applied === false, 'no variant filter → all rows', noVar.closing_qty);

  // ── 6) cancelled toggle — structural, no note regex ──────────────────────────
  console.log('\n— 6) cancelled (reversed) toggle —');
  const pC = mkProduct('کالای ابطال', 'K3-CANCEL');
  led({ product_id: pC, warehouse_id: whA, qty_in: 10, amount_rial: 10000, unit_cost_rial: 1000, date: '1405/06/01', source_id: 82001, note: 'خرید اول' });
  const origId = led({ product_id: pC, warehouse_id: whA, qty_in: 5, amount_rial: 5000, unit_cost_rial: 1000, date: '1405/06/02', source_id: 82002, status: 'reversed', note: 'رسید اشتباه' });
  const revId = led({ product_id: pC, warehouse_id: whA, event_type: 'reversal', qty_out: 5, amount_rial: 5000, unit_cost_rial: 1000, date: '1405/06/03', source_id: 82002, reversed_of: origId, note: 'برگشت رسید' });
  led({ product_id: pC, warehouse_id: whA, qty_out: 2, amount_rial: 2000, unit_cost_rial: 1000, date: '1405/06/04', event_type: 'issue', source_id: 82004, note: 'معکوس‌سازی ظاهری ولی سند عادی' });
  const cDef = buildStockLedger(db, { product_id: pC, warehouse_id: whA });
  ok(cDef.lines.length === 2 && cDef.lines.every((l) => !l.is_reversed), 'default: cancelled pair hidden', cDef.lines.map((l) => l.id));
  ok(cDef.closing_qty === 8 && cDef.closing_value_rial === 8000, 'default closing excludes the pair', [cDef.closing_qty, cDef.closing_value_rial]);
  const cShow = buildStockLedger(db, { product_id: pC, warehouse_id: whA, show_cancelled: 1 });
  const rvLines = cShow.lines.filter((l) => l.is_reversed);
  ok(cShow.lines.length === 4 && rvLines.length === 2, 'show_cancelled=1: original + reversal listed', cShow.lines.map((l) => [l.id, l.is_reversed]));
  ok(cShow.closing_qty === 8 && cShow.closing_value_rial === 8000, 'closing identical with/without cancelled rows', [cShow.closing_qty, cShow.closing_value_rial]);
  const lo = cShow.lines.find((l) => l.id === origId);
  const lr = cShow.lines.find((l) => l.id === revId);
  ok(lo && lo.reversed_by === revId && lo.status === 'reversed', 'original links to its reversal (reversed_by)', lo);
  ok(lr && lr.reversal_of === origId, 'reversal links back to the original (reversal_of)', lr);
  ok(lo.running_qty === 10 && lr.running_qty === 10 && lo.value_delta_rial === 0, 'cancelled rows carry no balance effect', [lo.running_qty, lr.running_qty]);
  ok(cShow.lines.filter((l) => !l.is_reversed).map((l) => l.running_qty).join() === '10,8', 'live running unaffected by cancelled rows', cShow.lines.map((l) => l.running_qty));
  ok(cShow.period_qty_in === 10 && cShow.period_qty_out === 2, 'period totals count live rows only', [cShow.period_qty_in, cShow.period_qty_out]);
  ok(cShow.toggles.show_cancelled === true && cDef.toggles.show_cancelled === false, 'toggles echoed');
  const kcDef = getKardex(db, pC, { warehouseId: whA });
  const kcShow = getKardex(db, pC, { warehouseId: whA, showCancelled: '1' });
  ok(kcDef.rows.length === 2 && kcShow.rows.length === 4 && kcShow.closing_qty === 8 && kcDef.closing_qty === 8, 'getKardex cancelled toggle', [kcDef.rows.length, kcShow.rows.length]);
  ok(kcShow.rows.filter((r) => r.is_reversed).length === 2 && kcShow.rows.find((r) => r.id === revId).reversal_of === origId, 'getKardex reversal link', null);
  // NO note regex: a live row whose note merely mentions «معکوس» stays in the stream and the balance.
  ok(cDef.lines.some((l) => /معکوس/.test(l.description || '')), 'live row with «معکوس» note is NOT treated as cancelled', cDef.lines.map((l) => l.description));
  // neutral note + structural flag (status) is still cancelled
  ok(cShow.lines.find((l) => l.id === origId).description === 'رسید اشتباه', 'cancelled detection ignores the note text', null);
  const srcLed = fs.readFileSync(path.join(__dirname, '../lib/ledgers.js'), 'utf8');
  const srcInv = fs.readFileSync(path.join(__dirname, '../lib/inventory/ledger.js'), 'utf8');
  const fnBody = (src, name) => {
    const i = src.indexOf(`function ${name}(`);
    return src.slice(i, src.indexOf('\n}\n', i) + 3);
  };
  const noRegexIn = (body) => !/\.test\(|\.match\(|\.replace\(|new RegExp|\.note\b|\.description\b/.test(body);
  ok(noRegexIn(fnBody(srcLed, 'isReversedStockRow')), 'isReversedStockRow: no regex / note access (source check)');
  ok(noRegexIn(fnBody(srcInv, 'isCancelledLedgerRow')), 'isCancelledLedgerRow: no regex / note access (source check)');

  // ── 7) WIP / warehouse-only toggles + Phase 1 parity ─────────────────────────
  console.log('\n— 7) show_wip / show_warehouse_only + Phase 1 parity —');
  const pP = mkProduct('کالای تطبیق', 'K3-PARITY');
  led({ product_id: pP, warehouse_id: whA, event_type: 'purchase', source_type: 'purchase', source_id: 83001, qty_in: 20, amount_rial: 40000, unit_cost_rial: 2000, date: '1405/07/01' });
  led({ product_id: pP, warehouse_id: whA, event_type: 'sale', source_type: 'invoice', source_id: 83002, qty_out: 6, amount_rial: 12000, unit_cost_rial: 2000, date: '1405/07/02' });
  led({ product_id: pP, warehouse_id: whA, event_type: 'landed_cost', source_type: 'landed_cost', source_id: 83003, qty_in: 0, qty_out: 0, amount_rial: 3000, date: '1405/07/03' });
  led({ product_id: pP, warehouse_id: whA, event_type: 'cutting_pack', source_type: 'cutting_pack', source_id: 83004, qty_in: 3, amount_rial: 900, unit_cost_rial: 300, date: '1405/07/04' });
  led({ product_id: pP, warehouse_id: whW, event_type: 'production_issue', source_type: 'production_issue', source_id: 83005, qty_in: 5, amount_rial: 2500, unit_cost_rial: 500, date: '1405/07/05' });
  const rev0 = led({ product_id: pP, warehouse_id: whA, event_type: 'purchase', source_type: 'purchase', source_id: 83006, qty_in: 9, amount_rial: 9000, unit_cost_rial: 1000, date: '1405/07/06', status: 'reversed' });
  led({ product_id: pP, warehouse_id: whA, event_type: 'reversal', source_type: 'purchase', source_id: 83006, qty_out: 9, amount_rial: 9000, unit_cost_rial: 1000, date: '1405/07/06', reversed_of: rev0 });

  const base = buildStockLedger(db, { product_id: pP, warehouse_id: whA });
  ok(base.closing_qty === 14 && !base.lines.some((l) => l.event_type === 'cutting_pack'), 'default hides warehouse-only (cutting_pack) rows', [base.closing_qty]);
  // value-only (landed cost) row moves value, not the table
  ok(base.closing_value_rial === 31000 && base.value_only_rial === 3000 && !base.lines.some((l) => l.event_type === 'landed_cost'),
    'value-only row folded into value, not listed', [base.closing_value_rial, base.value_only_rial]);
  const wo = buildStockLedger(db, { product_id: pP, warehouse_id: whA, show_warehouse_only: 1 });
  ok(wo.closing_qty === 17 && wo.lines.some((l) => l.event_type === 'cutting_pack'), 'show_warehouse_only=1 adds cutting_pack', [wo.closing_qty]);
  const noWipAll = buildStockLedger(db, { product_id: pP });
  const wipAll = buildStockLedger(db, { product_id: pP, show_wip: 1 });
  ok(wipAll.closing_qty === noWipAll.closing_qty + 5 && wipAll.lines.some((l) => l.warehouse_id === whW), 'show_wip=1 adds the WIP warehouse rows', [noWipAll.closing_qty, wipAll.closing_qty]);
  const wipView = buildStockLedger(db, { product_id: pP, warehouse_id: whW });
  ok(wipView.closing_qty === 5, 'explicit WIP warehouse filter shows WIP rows', wipView.closing_qty);

  const rec = computeLayerReconcile(db, { productId: pP });
  const recA = rec.rows.find((r) => r.warehouse_id === whA);
  const full = buildStockLedger(db, { product_id: pP, warehouse_id: whA, show_warehouse_only: 1, show_wip: 1 });
  ok(recA && full.closing_qty === recA.ledger_qty, 'kardex closing qty == Phase 1 reconcile Σledger (product×wh)', [full.closing_qty, recA && recA.ledger_qty]);
  ok(recA && full.closing_value_rial === recA.ledger_value_rial, 'kardex closing value == Phase 1 reconcile ledger value', [full.closing_value_rial, recA && recA.ledger_value_rial]);
  const fullK = getKardex(db, pP, { warehouseId: whA, showWarehouseOnly: 1, showWip: 1 });
  ok(recA && fullK.closing_qty === recA.ledger_qty && fullK.closing_value_rial === recA.ledger_value_rial, 'getKardex closing == Phase 1 reconcile (qty + value)', [fullK.closing_qty, fullK.closing_value_rial]);
  const recW = rec.rows.find((r) => r.warehouse_id === whW);
  ok(recW && wipView.closing_qty === recW.ledger_qty && wipView.closing_value_rial === recW.ledger_value_rial, 'WIP warehouse kardex == Phase 1 reconcile', [wipView.closing_qty, recW && recW.ledger_qty]);
  const sumPhase1 = rec.rows.reduce((s, r) => s + r.ledger_qty, 0);
  ok(Math.abs(sumPhase1 - (full.closing_qty + wipView.closing_qty)) < 1e-9, 'Σ per-warehouse kardex == Σ Phase 1 ledger', [sumPhase1]);

  // ── 8) source document links ─────────────────────────────────────────────────
  console.log('\n— 8) source links —');
  const pL = mkProduct('کالای لینک', 'K3-LINK');
  const L = (st, sid, extra = {}) => led({ product_id: pL, warehouse_id: whA, qty_in: 1, amount_rial: 10, date: '1405/08/01', source_type: st, source_id: sid, ...extra });
  L('production_receipt', 901, { event_type: 'production_receipt' });
  L('invoice_cogs', 902, { event_type: 'sale' });
  L('purchase', 903, { event_type: 'purchase' });
  L('inventory_adjust', 904, { event_type: 'adjustment' });
  L('stocktaking', 905, { event_type: 'cycle_count' });
  L('sales_return', 906, { event_type: 'sale_return' });
  L('production_receipt_reversal', 907, { event_type: 'production_receipt_reversal' });
  const lk = buildStockLedger(db, { product_id: pL, warehouse_id: whA, show_cancelled: 1 });
  const by = (sid) => lk.lines.find((l) => l.source_id === sid);
  ok(by(901).ref_type === 'production' && by(901).ref_id === 901, 'production_receipt → production link', [by(901).ref_type, by(901).ref_id]);
  ok(by(902).ref_type === 'invoice' && by(902).ref_id === 902, 'invoice_cogs → invoice link', by(902).ref_type);
  ok(by(903).ref_type === 'purchase' && by(903).ref_id === 903, 'purchase link', by(903).ref_type);
  ok(by(904).ref_type === 'adjust' && by(904).ref_id === 904, 'inventory_adjust → adjust link', by(904).ref_type);
  ok(by(905).ref_type === 'stocktaking' && by(905).ref_id === 905, 'stocktaking link', by(905).ref_type);
  ok(by(906).ref_type === 'sales_return' && by(906).ref_id === 906, 'sales_return link', by(906).ref_type);
  ok(by(907).ref_type === 'production', 'production reversal row still links to the production order', by(907).ref_type);
  ok(by(901).source_type === 'production_receipt', 'raw source_type preserved');
  // warehouse doc
  const wdId = insert('warehouse_docs', { num: 'WH-K3-1', type: 'receipt', warehouse_id: whA, date: '1405/08/02', status: 'posted', created_by: adminId });
  const mvId = insert('warehouse_moves', { doc_id: wdId, product_id: pL, warehouse_id: whA, type: 'receipt', qty: 1, date: '1405/08/02' });
  led({ product_id: pL, warehouse_id: whA, qty_in: 1, amount_rial: 10, date: '1405/08/02', source_type: 'warehouse_move', source_id: mvId, event_type: 'receipt' });
  const lk2 = buildStockLedger(db, { product_id: pL, warehouse_id: whA });
  const wdLine = lk2.lines.find((l) => l.wh_doc_id === wdId);
  ok(wdLine && wdLine.ref_type === 'warehouse_doc' && wdLine.ref_id === wdId, 'warehouse move → warehouse_doc link', wdLine && [wdLine.ref_type, wdLine.ref_id]);

  // ── 9) CSV + routes ──────────────────────────────────────────────────────────
  console.log('\n— 9) csv + route wiring —');
  const csv = stockToCsv(buildStockLedger(db, { product_id: p2, warehouse_id: whA }));
  ok(csv.includes('مانده ریالی') && csv.includes('10000'), 'csv carries running value');
  const routesLedgers = fs.readFileSync(path.join(__dirname, '../routes/ledgers.js'), 'utf8');
  for (const q of ['variant_id', 'page', 'page_size', 'show_wip', 'show_warehouse_only', 'show_cancelled']) {
    ok(routesLedgers.includes(`req.query.${q}`), `routes/ledgers.js wires ${q}`);
  }
  ok(/csv \? undefined : req\.query\.page/.test(routesLedgers), 'csv export is never paginated');
  const routesInv = fs.readFileSync(path.join(__dirname, '../routes/inventory.js'), 'utf8');
  for (const q of ['variant_id', 'page', 'page_size', 'show_wip', 'show_warehouse_only', 'show_cancelled', 'from', 'to']) {
    ok(new RegExp(`q\\.${q}\\b`).test(routesInv), `routes/inventory.js kardex wires ${q}`);
  }
  let badDate = null;
  try { buildStockLedger(db, { product_id: p1, variant_id: 'abc' }); } catch (e) { badDate = e; }
  ok(badDate && badDate.status === 400, 'invalid variant_id → 400', badDate && badDate.status);

  // field_sales cost stripping keeps no rial values
  const stripped = buildStockLedger(db, { product_id: p2, warehouse_id: whA }, { stripCost: true });
  ok(!JSON.stringify(stripped).includes('running_value_rial') && !JSON.stringify(stripped).includes('opening_value_rial'), 'stripCost removes value fields');

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

try { main(); } catch (e) { console.error(e); process.exit(1); }
