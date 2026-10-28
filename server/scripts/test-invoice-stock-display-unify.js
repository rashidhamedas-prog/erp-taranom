#!/usr/bin/env node
/**
 * v583 invoice-stock-display Phase 2 — client unification (popover / row label / picker card /
 * warnings / warehouse matrix) on top of POST /api/inventory/line-availability/batch (Phase 1).
 *
 * Fixtures (real isolated DB → real lineAvailabilityBatch → client cache mapping → shared client fns):
 *   • product 131 «بارونی مموری 110» olive pack: 421 (vws 1/1), 422 (vws 3/1) in wh 34/35, invoice
 *     being edited already holds 421×1 + 422×1 in wh 34 → popover must list SKUs separately
 *     (2 and 4 after add-back), never the old summed 4/2.
 *   • product 334 «کاپشن مموری آبان» pack of 8 SKUs (10,10,6×6) qty 1 each → label «کافی»,
 *     not the first-SKU number; a short SKU → «کمبود در n SKU».
 *   • parity: popover = row label = warning = picker card for one SKU/warehouse.
 *   • cache: TTL (60 s), clear on open / after save, exclude_invoice_id sent, chunking, fallback.
 * Run with Node 20 (better-sqlite3).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-display-unify-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'test-inv-display-unify-secret-32chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(tmp, 'sessions.db');
process.env.NODE_ENV = 'test';
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const { getDB, initDB } = require('../db');
initDB();
const db = getDB();
const { lineAvailabilityBatch } = require('../lib/inventory/line-availability');
const XWH = require('../lib/invoice-line-wh-stock');

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

const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(__dirname, '../public/app.css'), 'utf8');

function extractShared(src, name) {
  const open = '/* XWH-SHARED:' + name + ' */';
  const a = src.indexOf(open);
  if (a < 0) return null;
  const b = src.indexOf('/* /XWH-SHARED */', a + open.length);
  return b < 0 ? null : src.slice(a + open.length, b).trim();
}
/** Brace-matched function source (sync or async). */
function extractFn(src, name) {
  let a = src.indexOf('async function ' + name + '(');
  if (a < 0) a = src.indexOf('function ' + name + '(');
  if (a < 0) return null;
  const open = src.indexOf('{', src.indexOf(')', a));
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return src.slice(a, i + 1); }
  }
  return null;
}

const SHARED = [
  'invLineStockKey', 'invEffectiveLineWh', 'invLineStockEntry', 'invLineAvail',
  'invGroupStockAt', 'invGroupStockStatus', 'invCardAvail', 'invOtherWhQty',
  'collectInvoiceStockWarnings',
];

// ── client sandbox: the REAL app.js code (shared blocks + cache layer), fake window/api/clock ──
const clock = { t: 1700000000000 };
const apiCalls = [];
let apiImpl = async () => ({ results: [] });
const sb = {
  window: { _invBuilderId: 0 },
  Date: { now: () => clock.t },
  api: async (method, p, body, isForm, silent) => {
    apiCalls.push({ method, path: p, body: body && JSON.parse(JSON.stringify(body)), silent });
    return apiImpl(method, p, body);
  },
  invCart: [],
};
vm.createContext(sb);
SHARED.forEach((n) => {
  const code = extractShared(appSrc, n);
  if (!code) throw new Error('XWH-SHARED:' + n + ' missing in app.js');
  vm.runInContext(code, sb);
});
const cacheStart = appSrc.indexOf('/* v583: availability cache');
const cacheEnd = appSrc.indexOf('/* XWH-SHARED:invLineStockKey */');
vm.runInContext(appSrc.slice(cacheStart, cacheEnd), sb);
vm.runInContext(extractFn(appSrc, 'invLineStockItemsFor'), sb);
vm.runInContext(extractFn(appSrc, 'ensureInvLineStockForCart'), sb);

const lbl = (c, s) => [c, s].filter(Boolean).join(' / ');
const resultsToCache = (results) => {
  sb.window._invLineStock = {};
  sb.window._invLineStockAt = {};
  vm.runInContext('invLineStockStore(__r)', Object.assign(sb, { __r: JSON.parse(JSON.stringify(results)) }));
  return sb.window._invLineStock;
};

async function main() {
  console.log('\n=== invoice stock display unify v583 (Phase 2 client) ===\n');

  // ── DB fixture ────────────────────────────────────────────────────────────────
  const adminId = Number(insert('users', { name: 'مدیر', username: 'ud_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0 }));
  const wh34 = Number(insert('warehouses', { name: 'انبار محصول', code: 'UD-34', active: 1, allow_negative: 0, warehouse_type: 'finished_goods', inventory_system: 'perpetual' }));
  const wh35 = Number(insert('warehouses', { name: 'کیمیا', code: 'UD-35', active: 1, allow_negative: 0, warehouse_type: 'finished_goods', inventory_system: 'perpetual' }));
  const custId = Number(insert('customers', { user_id: adminId, biz: 'مشتری', owner: 'م' }));
  const mk = (name, code) => Number(insert('products', {
    user_id: adminId, name, code, price: 5000000, cost: 1000, average_cost_rial: 1000, stock: 0, warehouse_id: wh34, unit: 'عدد',
  }));
  const color = (n) => Number(insert('product_colors', { name: n, code: 'UD' + n, active: 1 }));
  const size = (n) => Number(insert('product_sizes', { name: n, code: 'UDS' + n, active: 1 }));
  const vwsSet = db.prepare('INSERT OR REPLACE INTO variant_warehouse_stock (variant_id,warehouse_id,qty) VALUES (?,?,?)');
  const wsSet = db.prepare('INSERT OR REPLACE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)');
  const mkVar = (pid, c, s, sku) => Number(insert('product_variants', { product_id: pid, color_id: c, size_id: s, sku, stock: 0, active: 1, is_default: 0 }));

  // product 131 olive pack
  const p131 = mk('بارونی مموری 110', 'UD-131');
  const olive = color('زیتونی');
  const s1 = size('سایز1');
  const s2 = size('سایز2');
  const v421 = mkVar(p131, olive, s1, 'UD-131-O1');
  const v422 = mkVar(p131, olive, s2, 'UD-131-O2');
  vwsSet.run(v421, wh34, 1); vwsSet.run(v421, wh35, 1);
  vwsSet.run(v422, wh34, 3); vwsSet.run(v422, wh35, 1);
  wsSet.run(p131, wh34, 4); wsSet.run(p131, wh35, 2);

  // invoice being EDITED: already deducted 421×1 + 422×1 from wh 34
  const invEdit = Number(insert('invoices', {
    user_id: adminId, cust_id: custId, num: 'UD-EDIT-1', type: 'normal', date: '1405/05/02', stock_deducted: 1, warehouse_id: wh34,
    rows: JSON.stringify([{ product_id: p131, variant_id: v421, qty: 1 }, { product_id: p131, variant_id: v422, qty: 1 }]),
  }));

  // product 334 pack-8 : 4 colors × 2 sizes → 10,10,6×6
  const p334 = mk('کاپشن مموری آبان', 'UD-334');
  const sA = size('س1'); const sB = size('س2');
  const colors334 = ['مشکی', 'قرمز', 'آبی', 'سبز'].map(color);
  const v334 = [];
  const stock334 = [10, 10, 6, 6, 6, 6, 6, 6];
  let ix = 0;
  colors334.forEach((c) => [sA, sB].forEach((s) => {
    const v = mkVar(p334, c, s, 'UD-334-' + c + '-' + s);
    vwsSet.run(v, wh34, stock334[ix]); ix += 1;
    v334.push(v);
  }));
  wsSet.run(p334, wh34, 56);

  // ── server → client cache mapping (real API shape) ────────────────────────────
  const items131 = [
    { product_id: p131, variant_id: v421 }, { product_id: p131, variant_id: v422 }, { product_id: p131, variant_id: null },
  ];
  const srvEdit = lineAvailabilityBatch(db, items131, { excludeInvoiceId: invEdit });
  const cache131 = resultsToCache(srvEdit);
  const k421 = XWH.invLineStockKey(p131, v421);
  const k422 = XWH.invLineStockKey(p131, v422);
  console.log('— cache shape —');
  const c421 = cache131[k421][wh34];
  ok(c421 && ['on_hand', 'reserved', 'own', 'available', 'drift', 'note'].every((f) => f in c421),
    'cache entry has {on_hand,reserved,own,available,drift,note}', c421);
  ok(c421.on_hand === 1 && c421.own === 1 && c421.available === 2, '421@34: on_hand 1 + own 1 → available 2 (server add-back)', c421);
  ok(cache131[k422][wh34].available === 4, '422@34: on_hand 3 + own 1 → available 4', cache131[k422][wh34]);
  ok(cache131[k421][wh35].available === 1 && cache131[k422][wh35].available === 1, '@35 (other warehouse): no add-back → 1 / 1');

  // ── 1) popover: per SKU, never the sum ─────────────────────────────────────────
  console.log('\n— popover (per SKU) —');
  const rows131 = [
    { product_id: p131, variant_id: v421, qty: 1, color_name: 'زیتونی', size_name: 'سایز1', warehouse_id: wh34 },
    { product_id: p131, variant_id: v422, qty: 1, color_name: 'زیتونی', size_name: 'سایز2', warehouse_id: wh34 },
  ];
  const g34 = sb.invGroupStockAt(rows131, wh34, cache131, lbl);
  ok(g34.skus.length === 2, 'pack group → 2 separate SKU entries', g34.skus.map((s) => s.label));
  ok(g34.skus[0].available === 2 && g34.skus[1].available === 4, 'wh34: 2 and 4 (with add-back) — NOT summed 6 / old 4', g34.skus.map((s) => s.available));
  ok(!g34.skus.some((s) => s.available === 6), 'no summed value in the list');
  ok(/زیتونی/.test(g34.skus[0].label) && /سایز1/.test(g34.skus[0].label) && /سایز2/.test(g34.skus[1].label), 'labels carry colour/size', g34.skus.map((s) => s.label));
  const g35 = sb.invGroupStockAt(rows131, wh35, cache131, lbl);
  ok(g35.skus[0].available === 1 && g35.skus[1].available === 1, 'wh35: 1 and 1 (not old summed 2)', g35.skus.map((s) => s.available));
  ok(g34.skus[0].on_hand === 1 && g34.skus[0].own === 1 && g34.skus[0].reserved === 0, 'optional detail: on_hand / own / reserved exposed for «موجود X · رزرو Y»');
  ok(g34.ok === true, 'qty 1 / 1 vs available 2 / 4 → group ok');

  // ── 2) row label: all SKUs compared, not indices[0] ───────────────────────────
  console.log('\n— row label (کافی / کمبود در n SKU) —');
  const st131 = sb.invGroupStockStatus(g34);
  ok(st131.mode === 'ok' && st131.low === false, 'product 131 pack → «کافی»', st131);

  const srv334 = lineAvailabilityBatch(db, v334.map((v) => ({ product_id: p334, variant_id: v })), {});
  const cache334 = resultsToCache(srv334);
  const rows334 = v334.map((v, i) => ({ product_id: p334, variant_id: v, qty: 1, color_name: 'ر' + i, size_name: 'س', warehouse_id: wh34 }));
  const g334 = sb.invGroupStockAt(rows334, wh34, cache334, lbl);
  ok(g334.skus.length === 8, '334 pack has 8 SKUs');
  ok(g334.skus.map((s) => s.available).join(',') === '10,10,6,6,6,6,6,6', 'per-SKU available 10,10,6×6', g334.skus.map((s) => s.available));
  const st334 = sb.invGroupStockStatus(g334);
  ok(st334.mode === 'ok' && st334.low === false, '334 pack-8 qty 8 → «کافی» (not a single SKU number like 9)', st334);
  ok(st334.value === undefined, 'pack status carries no single misleading number');

  const rows334Short = rows334.map((r, i) => (i < 2 ? Object.assign({}, r, { qty: 11 }) : r)); // two SKUs need 11 > 10
  const gShort = sb.invGroupStockAt(rows334Short, wh34, cache334, lbl);
  const stShort = sb.invGroupStockStatus(gShort);
  ok(stShort.mode === 'short' && stShort.n === 2 && stShort.low === true, 'two SKUs short → «کمبود در 2 SKU»', stShort);
  const stOne = sb.invGroupStockStatus(sb.invGroupStockAt([rows334[0]], wh34, cache334, lbl));
  ok(stOne.mode === 'num' && stOne.value === 10 && stOne.low === false, 'single SKU → the number (10)', stOne);
  const stOneLow = sb.invGroupStockStatus(sb.invGroupStockAt([Object.assign({}, rows334[2], { qty: 7 })], wh34, cache334, lbl));
  ok(stOneLow.mode === 'num' && stOneLow.value === 6 && stOneLow.low === true, 'single SKU qty 7 > 6 → number + low', stOneLow);
  const stUnknown = sb.invGroupStockStatus(sb.invGroupStockAt(rows334, wh34, {}, lbl));
  ok(stUnknown.mode === 'unknown', 'empty cache → unknown (…), not 0', stUnknown);

  // ── 3) parity: popover = label = warning = card ───────────────────────────────
  console.log('\n— parity (one SKU / warehouse) —');
  const rowOne = { product_id: p131, variant_id: v422, qty: 5, color_name: 'زیتونی', size_name: 'سایز2', warehouse_id: wh34, name: 'بارونی مموری 110' };
  const avPop = sb.invGroupStockAt([rowOne], wh34, cache131, lbl).skus[0].available;
  const avLabel = sb.invGroupStockStatus(sb.invGroupStockAt([rowOne], wh34, cache131, lbl)).value;
  const avLine = sb.invLineAvail(rowOne, wh34, cache131);
  const warn = sb.collectInvoiceStockWarnings([rowOne], {
    headerWh: wh34, stockCache: cache131, warehouseName: () => 'انبار محصول',
    // the OLD client added this on top → double add-back. Must be ignored now.
    heldFn: () => 1,
    variantLabel: lbl,
  }).filter((i) => i.kind === 'sku')[0];
  ok(avPop === 4 && avLabel === 4 && avLine === 4, 'popover = label = invLineAvail = 4', { avPop, avLabel, avLine });
  ok(warn && warn.avail === 4 && warn.need === 5 && warn.after === -1, 'warning avail = 4 (no second invoiceHeldQty add-back)', warn);
  const cardRow = sb.invCardAvail(p131, wh34, cache131, 0, 0, 0);
  const prodWarn = sb.collectInvoiceStockWarnings([{ product_id: p131, qty: 99, warehouse_id: wh34, name: 'x' }], { headerWh: wh34, stockCache: cache131, heldFn: () => 1 })[0];
  ok(cardRow.base === prodWarn.avail && cardRow.from_cache === true, 'picker card base = product warning avail (same product-level number)', { cardRow, prodWarn });

  // ── 4) picker card: no double subtract ────────────────────────────────────────
  console.log('\n— picker card —');
  // product-level on_hand 4 + own 2 = available 6 ; the edited invoice holds 2.
  const cardIn = sb.invCardAvail(p131, wh34, cache131, 0, 0, 2); // cart qty == baseline (2)
  ok(cardIn.base === 6 && cardIn.available === 4, 'cart qty == baseline → shows on_hand 4 (own add-back minus own cart) — no extra −2', cardIn);
  const cardUp = sb.invCardAvail(p131, wh34, cache131, 0, 0, 3); // +1 vs baseline
  ok(cardUp.available === 3, 'cart +1 over baseline → on_hand − 1 = 3', cardUp);
  const cardDown = sb.invCardAvail(p131, wh34, cache131, 0, 0, 1); // reduced by 1
  ok(cardDown.available === 5, 'cart −1 vs baseline → frees 1 (5)', cardDown);
  const cardFallback = sb.invCardAvail(777, wh34, {}, 4, 2, 2); // no cache: wh_qty 4 + held 2 − cart 2
  ok(cardFallback.from_cache === false && cardFallback.base === 6 && cardFallback.available === 4, 'cache not loaded → wh_qty + baseline held fallback, still single subtract', cardFallback);
  const cardNoWh = sb.invCardAvail(p131, wh34, { [XWH.invLineStockKey(p131, 0)]: { [wh34]: 5 } }, 0, 0, 0);
  ok(cardNoWh.base === 5, 'legacy numeric cache entry still readable (= available)');

  // «در انبار دیگر» — product-level key only
  const otherOnly = sb.invOtherWhQty(p131, wh34, [wh34, wh35], cache131);
  ok(otherOnly === cache131[XWH.invLineStockKey(p131, 0)][wh35].available, '«در انبار دیگر» = product-level available of other warehouses only', otherOnly);
  const variantsOnly = { [k421]: cache131[k421], [k422]: cache131[k422] };
  ok(sb.invOtherWhQty(p131, wh34, [wh34, wh35], variantsOnly) === 0, 'variant keys are NEVER combined into «در انبار دیگر»');
  ok(sb.invOtherWhQty(p131, wh34, [wh34], cache131) === 0, 'header warehouse is excluded');

  // ── 5) drift badge ────────────────────────────────────────────────────────────
  console.log('\n— drift —');
  ok(cache131[k421][wh35].drift === true && /بدون سند/.test(cache131[k421][wh35].note), '421@35 drift + note come from the server (vws without movements)');
  const gDrift = sb.invGroupStockAt([{ product_id: p131, variant_id: v421, qty: 1, warehouse_id: wh35 }], wh35, cache131, lbl);
  ok(gDrift.drift === true && gDrift.skus[0].drift === true, 'group info exposes drift');
  ok(gDrift.skus[0].available === 1, 'drift never changes the number');
  const driftFn = extractFn(appSrc, 'invDriftBadgeHtml');
  ok(driftFn && /title="/.test(driftFn) && !/\sstyle=/.test(driftFn) && /inv-drift-badge/.test(driftFn), 'drift badge: class + title only (CSP-safe, no inline style)');
  ok(/ناهمخوان با کاردکس/.test(appSrc.slice(appSrc.indexOf('const INV_DRIFT_TEXT'), appSrc.indexOf('const INV_DRIFT_TEXT') + 80)), 'badge text «⚠ ناهمخوان با کاردکس»');
  ok(/\.inv-drift-badge\{/.test(cssSrc), 'app.css defines .inv-drift-badge');

  // ── 6) cache: exclude_invoice_id, TTL, clear, chunking, fallback ───────────────
  console.log('\n— cache (TTL / clear / exclude) —');
  sb.window._invBuilderId = invEdit;
  sb.window._invLineStock = {}; sb.window._invLineStockAt = {};
  apiCalls.length = 0;
  apiImpl = async (m, p, body) => ({ exclude_invoice_id: body.exclude_invoice_id || null, results: lineAvailabilityBatch(db, body.items, { excludeInvoiceId: body.exclude_invoice_id }) });
  sb.invCart = rows131.map((r) => Object.assign({}, r));
  await sb.ensureInvLineStockForCart(sb.invCart);
  ok(apiCalls.length === 1 && apiCalls[0].path === '/inventory/line-availability/batch', 'ensureInvLineStockForCart → POST /inventory/line-availability/batch (not stock-by-warehouse)', apiCalls.map((c) => c.path));
  ok(apiCalls[0].body.exclude_invoice_id === invEdit, 'exclude_invoice_id = window._invBuilderId', apiCalls[0].body);
  ok(apiCalls[0].body.items.some((i) => i.variant_id == null && i.product_id === p131), 'product-level key requested too (card / product warning)', apiCalls[0].body.items);
  ok(sb.window._invLineStock[k421][wh34].available === 2, 'API-mapped cache holds add-back available (2)', sb.window._invLineStock[k421]);
  await sb.ensureInvLineStockForCart(sb.invCart);
  ok(apiCalls.length === 1, 'second call inside TTL → no refetch');
  clock.t += 59000;
  await sb.ensureInvLineStockForCart(sb.invCart);
  ok(apiCalls.length === 1, '59 s later → still fresh');
  clock.t += 2000;
  await sb.ensureInvLineStockForCart(sb.invCart);
  ok(apiCalls.length === 2, '61 s later → TTL expired → refetched', apiCalls.length);

  sb.window._invLineStockSeq = 5;
  sb.window._invOtherWhTried = { x: 1 };
  vm.runInContext('invLineStockClear()', sb);
  ok(Object.keys(sb.window._invLineStock).length === 0 && Object.keys(sb.window._invLineStockAt).length === 0, 'invLineStockClear empties the cache');
  ok(Object.keys(sb.window._invOtherWhTried).length === 0, 'clear also resets the «انبار دیگر» tried-map');
  ok(sb.window._invLineStockSeq === 6 && sb.window._invLineStockGen === 1, 'clear bumps seq + gen (in-flight results are dropped)', [sb.window._invLineStockSeq, sb.window._invLineStockGen]);
  await sb.ensureInvLineStockForCart(sb.invCart);
  ok(apiCalls.length === 3, 'after clear (open invoice / after save) → refetch');

  // in-flight response after a clear must be discarded
  sb.window._invLineStock = {}; sb.window._invLineStockAt = {};
  let release;
  apiImpl = () => new Promise((res) => { release = () => res({ results: lineAvailabilityBatch(db, [{ product_id: p131, variant_id: v421 }], {}) }); });
  const inflight = sb.ensureInvLineStockForCart([rows131[0]]);
  vm.runInContext('invLineStockClear()', sb);
  release();
  await inflight;
  ok(Object.keys(sb.window._invLineStock).length === 0, 'response that lands after a clear (other invoice opened) is not stored');

  // chunking > 100 items + fallback when exclude invoice is rejected
  apiCalls.length = 0;
  sb.window._invLineStock = {}; sb.window._invLineStockAt = {};
  apiImpl = async (m, p, body) => ({ results: body.items.map((i) => ({ product_id: i.product_id, variant_id: i.variant_id, warehouses: [] })) });
  const many = Array.from({ length: 230 }, (_, i) => ({ product_id: 1000 + i, variant_id: null }));
  const fetched = await vm.runInContext('invFetchLineAvailability', sb)(many);
  ok(apiCalls.length === 3 && fetched.length === 230 && apiCalls.every((c) => c.body.items.length <= 100), '230 items → 3 requests of ≤100 (API limit)', apiCalls.map((c) => c.body.items.length));
  ok(apiCalls.every((c) => c.silent === true), 'requests are silent (no toast spam)');
  apiCalls.length = 0;
  sb.window._invBuilderId = 424242;
  apiImpl = async (m, p, body) => { if (body.exclude_invoice_id) throw new Error('403'); return { results: [] }; };
  await vm.runInContext('invFetchLineAvailability', sb)([{ product_id: 1, variant_id: null }]);
  ok(apiCalls.length === 2 && apiCalls[0].body.exclude_invoice_id === 424242 && apiCalls[1].body.exclude_invoice_id === undefined,
    'exclude_invoice_id rejected → retried once without it (degraded numbers beat an empty screen)', apiCalls);

  // failure never loops: unfetched keys get an empty map; error timestamp set
  sb.window._invLineStock = {}; sb.window._invLineStockAt = {};
  apiImpl = async () => ({ results: [] });
  await sb.ensureInvLineStockForCart([{ product_id: 888, variant_id: null, qty: 1 }]);
  ok(sb.window._invLineStock[XWH.invLineStockKey(888, 0)] && sb.window._invLineStockAt[XWH.invLineStockKey(888, 0)],
    'item the server did not return is stored as an empty fresh map (render loop guard)');
  sb.window._invLineStock = {}; sb.window._invLineStockAt = {};
  apiImpl = async () => { throw new Error('net'); };
  await sb.ensureInvLineStockForCart([{ product_id: 889, variant_id: null, qty: 1 }]);
  ok(sb.window._invLineStockErrAt > 0, 'network error sets _invLineStockErrAt (renderCart backs off 15 s)');

  // ── 7) wiring inside app.js ───────────────────────────────────────────────────
  console.log('\n— app.js wiring —');
  const ensureSrc = extractFn(appSrc, 'ensureInvLineStockForCart') + extractFn(appSrc, 'invFetchLineAvailability');
  ok(/line-availability\/batch/.test(ensureSrc) && !/stock-by-warehouse\/batch/.test(ensureSrc), 'ensureInvLineStockForCart / fetch use line-availability/batch only');
  ok(/exclude_invoice_id/.test(ensureSrc) && /_invBuilderId/.test(ensureSrc), 'exclude_invoice_id = window._invBuilderId');
  const hydrateSrc = extractFn(appSrc, 'hydrateInvOtherWhStock');
  ok(/invFetchLineAvailability/.test(hydrateSrc) && !/stock-by-warehouse/.test(hydrateSrc) && /INV_LINE_STOCK_TTL_MS/.test(hydrateSrc), 'hydrateInvOtherWhStock: line-availability + TTL (no unconditional once-only flag)');
  ok(!/if\(window\._invLineStock && window\._invLineStock\[key\]\) return;/.test(appSrc), 'unconditional «if(cache[key]) return» removed');
  ok(/const INV_LINE_STOCK_TTL_MS = 60000;/.test(appSrc), 'TTL = 60 s');
  const openIdx = appSrc.indexOf('window._invBuilderId = id || 0;');
  ok(openIdx > 0 && /invLineStockClear\(\)/.test(appSrc.slice(openIdx, openIdx + 220)), 'cache cleared when an invoice is opened');
  const saveSrc = extractFn(appSrc, 'saveInvoice');
  const savedAt = saveSrc.indexOf("await api('POST','/invoices',data)");
  ok(savedAt > 0 && saveSrc.indexOf('invLineStockClear()', savedAt) > savedAt && saveSrc.indexOf('invLineStockClear()', savedAt) < saveSrc.indexOf('closeModal()', savedAt), 'cache cleared right after a successful save (before closeModal)');
  ok(/invLineStockClear\(\)/.test(extractFn(appSrc, 'convertProforma')), 'cache cleared after proforma → invoice conversion');
  const renderCartSrc = extractFn(appSrc, 'renderCart');
  ok(/invGroupStockInfo\(indices, lineWhEff\)/.test(renderCartSrc) && !/invLineAvailRow\(r\)/.test(renderCartSrc), 'row label uses the whole group (invGroupStockInfo), not indices[0] only');
  ok(/کافی/.test(renderCartSrc) && /کمبود در/.test(renderCartSrc), 'row label texts «کافی» / «کمبود در n SKU»');
  const popQty = extractFn(appSrc, 'invXwhQtyAt');
  ok(/invGroupStockInfo/.test(popQty) && !/sum\s*\+=/.test(popQty), 'invXwhQtyAt no longer sums SKUs');
  const popHtml = extractFn(appSrc, 'invXwhPopHtml');
  ok(/inv-xwh-pop-skus/.test(popHtml) && /info\.skus\.map/.test(popHtml), 'popover lists each SKU (colour/size: qty) for pack groups');
  const pickSrc = extractFn(appSrc, 'renderInvPicker');
  ok(/invCardAvail\(/.test(pickSrc) && /invoiceHeldQty\('product'/.test(pickSrc), 'picker card uses invCardAvail (cache available, baseline only as fallback)');
  const otherSrc = extractFn(appSrc, 'invOtherWhQtyForProduct');
  ok(/invOtherWhQty\(/.test(otherSrc) && !/Object\.keys\(cache\)/.test(otherSrc), 'invOtherWhQtyForProduct: product-level key only (no variant fallback)');
  const warnOpts = extractFn(appSrc, 'invoiceStockWarnOpts');
  ok(/heldFn/.test(warnOpts), 'warn opts keep heldFn only as a pre-load fallback (shared fn ignores it when cache present)');
  const matrixSrc = extractFn(appSrc, 'openWhSkuMatrixModal');
  ok(/invFetchLineAvailability\(/.test(matrixSrc) && /on_hand/.test(matrixSrc) && /available/.test(matrixSrc), 'warehouse matrix: top-of-cell qty from line-availability (on_hand receipt / available issue+transfer)');
  ok(/outB\?\(Number\(w\.available\)\|\|0\):\(Number\(w\.on_hand\)\|\|0\)/.test(matrixSrc), 'matrix: issue/transfer → available, receipt → on_hand');
  ok(/await openWhSkuMatrixModal\(/.test(appSrc), 'whPickProduct awaits the (now async) matrix modal');

  // CSP: none of the new client code introduces inline style= / on*= attributes
  const newBits = [
    extractFn(appSrc, 'invDriftBadgeHtml'), extractFn(appSrc, 'invGroupStockInfo'),
    popHtml,
    appSrc.slice(appSrc.indexOf('// v583: هر SKU گروه'), appSrc.indexOf('// v583: هر SKU گروه') + 1400),
  ].join('\n');
  ok(!/\sstyle="/.test(newBits) && !/\son[a-z]+="/.test(newBits), 'CSP: no inline style=/on*= in new popover / label / badge code');

  // ── SW / cache-bust ───────────────────────────────────────────────────────────
  const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const swV = Number((sw.match(/erp-taranom-v(\d+)/) || [])[1]);
  const htV = Number((html.match(/app\.js\?v=(\d+)/) || [])[1]);
  ok(swV >= 583 && swV === htV, 'sw.js CACHE and index.html ?v= agree and are ≥ 583', { swV, htV });

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  try { db.close(); } catch (_) { /* ignore */ }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
