'use strict';
/**
 * Phase 0 — invoice line warehouse stock API (read-only) + pure warning grouping lib.
 * Run: node server/scripts/test-invoice-line-wh-stock.js
 *
 * Isolated temp DB. Covers:
 *   GET /api/inventory/stock-by-warehouse (product + variant), POST .../batch (+ cap 100),
 *   RBAC (invoices.view), no INSERT side effects (warehouse_stock / variant_warehouse_stock counts),
 *   lib/invoice-line-wh-stock.js: key, effective wh, avail, grouped warnings (held, variants),
 *   XWH-SHARED parity with public/app.js when the markers exist there.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : JSON.stringify(extra)); }
}
function same(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
    ok(true, label);
  } catch (e) {
    ok(false, label, { actual, expected });
  }
}

console.log('\n══ Invoice line WH stock (Phase 0) ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-line-wh-'));
process.env.DB_PATH = path.join(dir, 'xwh.db');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'invoice-line-wh-stock-test-secret-32chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const dbMods = require('../db');
dbMods.initDB();
const db = dbMods.getDB();

const XWH = require('../lib/invoice-line-wh-stock');

function extractShared(src, name) {
  const open = '/* XWH-SHARED:' + name + ' */';
  const close = '/* /XWH-SHARED */';
  const a = src.indexOf(open);
  if (a < 0) return null;
  const b = src.indexOf(close, a + open.length);
  if (b < 0) return null;
  return src.slice(a + open.length, b).trim();
}

async function main() {
  const express = require('express');
  const http = require('http');
  const { issueStaffSession } = require('../lib/auth-sessions');

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

  // ── seed ──
  const adminId = insert('users', {
    name: 'مدیر', username: 'xwh_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0,
  });
  const noPermId = insert('users', {
    name: 'بدون دسترسی', username: 'xwh_none', password: 'x', role: 'sales', active: 1, must_change_password: 0,
  });
  db.prepare('INSERT OR REPLACE INTO user_permissions (user_id,resource,action,allowed) VALUES (?,?,?,0)')
    .run(noPermId, 'invoices', 'view');

  const whA = Number(insert('warehouses', {
    name: 'انبار محصول', code: 'XFG', active: 1, allow_negative: 1, is_default: 1, warehouse_type: 'finished_goods',
  }));
  const whB = Number(insert('warehouses', {
    name: 'انبار کیمیا', code: 'XKIM', active: 1, allow_negative: 0, is_default: 0, warehouse_type: 'finished_goods',
  }));
  const whOff = Number(insert('warehouses', {
    name: 'انبار غیرفعال', code: 'XOFF', active: 0, allow_negative: 0, is_default: 0, warehouse_type: 'finished_goods',
  }));
  const prodId = Number(insert('products', {
    user_id: adminId, name: 'بارونی مموری 110', code: 'BR-110', price: 100000, cost: 50000,
    stock: 0, warehouse_id: whA, unit: 'عدد',
  }));
  const wsIns = db.prepare('INSERT OR REPLACE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)');
  wsIns.run(prodId, whA, 11);
  wsIns.run(prodId, whB, 14);

  const colorId = insert('product_colors', { name: 'مشکی', code: 'XBLK', active: 1 });
  const sizeId = insert('product_sizes', { name: 'L', code: 'XL', active: 1 });
  const varId = Number(insert('product_variants', {
    product_id: prodId, color_id: colorId, size_id: sizeId, sku: 'BR-110-BLK-L', stock: 0, active: 1, is_default: 0,
  }));
  const vwsIns = db.prepare('INSERT OR REPLACE INTO variant_warehouse_stock (variant_id,warehouse_id,qty) VALUES (?,?,?)');
  vwsIns.run(varId, whA, 11);
  vwsIns.run(varId, whB, 14);

  // second product with NO warehouse_stock rows at all (must read 0, must not be seeded)
  const prodBare = Number(insert('products', {
    user_id: adminId, name: 'محصول بدون ردیف', code: 'BARE-1', price: 1000, cost: 500,
    stock: 0, warehouse_id: 0, unit: 'عدد',
  }));

  const countWs = () => Number(db.prepare('SELECT COUNT(*) AS c FROM warehouse_stock').get().c);
  const countVws = () => Number(db.prepare('SELECT COUNT(*) AS c FROM variant_warehouse_stock').get().c);
  const beforeWs = countWs();
  const beforeVws = countVws();

  const tokenFor = (uid, tag) => issueStaffSession(db, db.prepare('SELECT * FROM users WHERE id=?').get(uid), {
    device_kind: 'test', device_name: 'xwh-' + tag, device_fingerprint: 'xwh-fp-' + tag,
  }).token;
  const tok = { admin: tokenFor(adminId, 'admin'), none: tokenFor(noPermId, 'none') };

  const app = express();
  app.use(express.json());
  app.use('/api/inventory', require('../routes/inventory'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;

  async function api(method, p, body, who = 'admin') {
    const headers = { 'Content-Type': 'application/json' };
    if (who) headers.Authorization = 'Bearer ' + tok[who];
    const res = await fetch(BASE + p, {
      method, headers, body: body == null ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, data };
  }
  const pick = (list, fields) => (list || [])
    .filter((w) => w.warehouse_id === whA || w.warehouse_id === whB)
    .map((w) => fields.reduce((o, f) => { o[f] = w[f]; return o; }, {}))
    .sort((a, b) => a.warehouse_id - b.warehouse_id);

  try {
    // ── API: GET ──
    console.log('— GET stock-by-warehouse —');
    const getProd = await api('GET', `/api/inventory/stock-by-warehouse?product_id=${prodId}`);
    ok(getProd.status === 200, 'GET product → 200', getProd.data);
    ok(getProd.data.product_id === prodId, 'GET product echoes product_id');
    same(pick(getProd.data.warehouses, ['warehouse_id', 'name', 'qty', 'allow_negative']), [
      { warehouse_id: whA, name: 'انبار محصول', qty: 11, allow_negative: 1 },
      { warehouse_id: whB, name: 'انبار کیمیا', qty: 14, allow_negative: 0 },
    ], 'GET product: whA=11 (allow_negative 1), whB=14');
    ok(getProd.data.warehouses.every((w) => w.warehouse_id !== whOff), 'GET: inactive warehouse excluded');
    const ids = getProd.data.warehouses.map((w) => w.warehouse_id);
    same(ids, ids.slice().sort((a, b) => a - b), 'GET: ordered by warehouse id');

    const getVar = await api('GET', `/api/inventory/stock-by-warehouse?product_id=${prodId}&variant_id=${varId}`);
    ok(getVar.status === 200, 'GET variant → 200', getVar.data);
    same(pick(getVar.data.warehouses, ['warehouse_id', 'qty']), [
      { warehouse_id: whA, qty: 11 },
      { warehouse_id: whB, qty: 14 },
    ], 'GET variant: whA=11, whB=14');

    const getBare = await api('GET', `/api/inventory/stock-by-warehouse?product_id=${prodBare}`);
    same(pick(getBare.data.warehouses, ['warehouse_id', 'qty']), [
      { warehouse_id: whA, qty: 0 },
      { warehouse_id: whB, qty: 0 },
    ], 'GET product without stock rows → 0 / 0');

    const noPid = await api('GET', '/api/inventory/stock-by-warehouse');
    ok(noPid.status === 400, 'GET without product_id → 400', noPid.data);
    const badPid = await api('GET', '/api/inventory/stock-by-warehouse?product_id=abc');
    ok(badPid.status === 400, 'GET product_id=abc → 400', badPid.data);

    // ── API: batch ──
    console.log('\n— POST batch —');
    const batch = await api('POST', '/api/inventory/stock-by-warehouse/batch', {
      items: [
        { product_id: prodId, variant_id: null },
        { product_id: prodId, variant_id: varId },
        { product_id: prodBare },
      ],
    });
    ok(batch.status === 200, 'batch → 200', batch.data);
    ok(Array.isArray(batch.data && batch.data.results) && batch.data.results.length === 3, 'batch: 3 results', batch.data);
    const res = batch.data.results;
    ok(res[0].product_id === prodId && !(res[0].variant_id > 0), 'batch[0] is product-level');
    same(pick(res[0].warehouses, ['warehouse_id', 'qty']), [
      { warehouse_id: whA, qty: 11 }, { warehouse_id: whB, qty: 14 },
    ], 'batch[0] product 11/14');
    ok(res[1].variant_id === varId, 'batch[1] echoes variant_id');
    same(pick(res[1].warehouses, ['warehouse_id', 'qty']), [
      { warehouse_id: whA, qty: 11 }, { warehouse_id: whB, qty: 14 },
    ], 'batch[1] variant 11/14');
    same(pick(res[2].warehouses, ['warehouse_id', 'qty']), [
      { warehouse_id: whA, qty: 0 }, { warehouse_id: whB, qty: 0 },
    ], 'batch[2] bare product 0/0');

    const items100 = Array.from({ length: 100 }, () => ({ product_id: prodId }));
    const b100 = await api('POST', '/api/inventory/stock-by-warehouse/batch', { items: items100 });
    ok(b100.status === 200 && b100.data.results.length === 100, 'batch: 100 items accepted');
    const items101 = Array.from({ length: 101 }, () => ({ product_id: prodId }));
    const b101 = await api('POST', '/api/inventory/stock-by-warehouse/batch', { items: items101 });
    ok(b101.status === 400, 'batch: 101 items → 400', b101.data);
    const bNone = await api('POST', '/api/inventory/stock-by-warehouse/batch', {});
    ok(bNone.status === 400, 'batch without items → 400', bNone.data);

    // ── RBAC ──
    console.log('\n— auth —');
    const anon = await api('GET', `/api/inventory/stock-by-warehouse?product_id=${prodId}`, null, null);
    ok(anon.status === 401, 'GET without token → 401', anon.status);
    const denied = await api('GET', `/api/inventory/stock-by-warehouse?product_id=${prodId}`, null, 'none');
    ok(denied.status === 403, 'GET without invoices.view → 403', denied.status);
    const deniedB = await api('POST', '/api/inventory/stock-by-warehouse/batch', { items: [{ product_id: prodId }] }, 'none');
    ok(deniedB.status === 403, 'batch without invoices.view → 403', deniedB.status);

    // ── no side effects ──
    console.log('\n— read-only —');
    ok(countWs() === beforeWs, 'warehouse_stock row count unchanged', { before: beforeWs, after: countWs() });
    ok(countVws() === beforeVws, 'variant_warehouse_stock row count unchanged', { before: beforeVws, after: countVws() });
    same(
      Number(db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(prodId, whA).qty),
      11, 'warehouse_stock qty untouched (whA=11)'
    );

    // ── lib: warning logic ──
    console.log('\n— warnings lib —');
    ok(XWH.invLineStockKey(5, null) === '5:0' && XWH.invLineStockKey(5, 0) === '5:0', 'key: no variant → pid:0');
    ok(XWH.invLineStockKey(5, 9) === '5:9', 'key: variant → pid:vid');
    ok(XWH.invEffectiveLineWh({ warehouse_id: whB }, whA) === whB, 'effective wh: row wins');
    ok(XWH.invEffectiveLineWh({}, whA) === whA, 'effective wh: header fallback');
    ok(XWH.invEffectiveLineWh({ warehouse_id: 0 }, whA) === whA, 'effective wh: row 0 → header');
    ok(XWH.invEffectiveLineWh({}, null) === null, 'effective wh: nothing → null');

    const stockCache = {};
    stockCache[XWH.invLineStockKey(prodId, 0)] = { [whA]: 11, [whB]: 14 };
    stockCache[XWH.invLineStockKey(prodId, varId)] = { [whA]: 11, [whB]: 14 };
    const whName = (id) => {
      if (Number(id) === whA) return 'انبار محصول';
      if (Number(id) === whB) return 'انبار کیمیا';
      return 'انبار ' + id;
    };
    // heldFn('product'|'sku', id, wh) → qty already reserved by the invoice being edited
    const heldOf = (map) => (kind, id, wh) => {
      const k = kind + ':' + id + '@' + wh;
      return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : 0;
    };
    const opts = (extra) => Object.assign({ headerWh: whA, stockCache, warehouseName: whName }, extra);
    const noExtra = {};

    ok(XWH.invLineAvail({ product_id: prodId, warehouse_id: whB }, whA, stockCache) === 14, 'avail: row in whB = 14');
    ok(XWH.invLineAvail({ product_id: prodId }, whA, stockCache) === 11, 'avail: header whA = 11');
    ok(XWH.invLineAvail({ product_id: prodId, variant_id: varId, warehouse_id: whB }, whA, stockCache) === 14, 'avail: variant whB = 14');
    ok(XWH.invLineAvail({ product_id: 999999 }, whA, stockCache) === 0, 'avail: unknown product → 0');
    ok(XWH.invLineAvail({ product_id: prodId, warehouse_id: 424242 }, whA, stockCache) === 0, 'avail: unknown warehouse → 0');

    const noWarn = XWH.collectInvoiceStockWarnings([
      { product_id: prodId, warehouse_id: whB, qty: 12, name: 'بارونی' },
    ], opts(noExtra));
    ok(noWarn.length === 0, 'row whB qty 12 / avail 14 → no warning', noWarn);

    const oneWarn = XWH.collectInvoiceStockWarnings([
      { product_id: prodId, warehouse_id: whA, qty: 12, name: 'بارونی' },
    ], opts(noExtra));
    ok(oneWarn.length === 1, 'same row in whA (avail 11) → exactly one warning', oneWarn);
    ok(oneWarn[0].after === -1 && oneWarn[0].need === 12 && oneWarn[0].avail === 11, 'warning: need 12 / avail 11 / after -1', oneWarn[0]);
    ok(oneWarn[0].kind === 'product' && oneWarn[0].warehouse_id === whA && oneWarn[0].product_id === prodId, 'warning fields: kind/warehouse_id/product_id', oneWarn[0]);
    ok(oneWarn[0].name.indexOf('انبار محصول') >= 0 && oneWarn[0].wh_name === 'انبار محصول', 'warning name + wh_name include warehouse name', oneWarn[0]);

    const headerFallback = XWH.collectInvoiceStockWarnings([
      { product_id: prodId, qty: 12, name: 'بارونی' },
    ], opts(noExtra));
    ok(headerFallback.length === 1 && headerFallback[0].warehouse_id === whA, 'row without wh uses header wh → warns in whA', headerFallback);

    const twoGroups = XWH.collectInvoiceStockWarnings([
      { product_id: prodId, warehouse_id: whA, qty: 12, name: 'بارونی' },
      { product_id: prodId, warehouse_id: whB, qty: 20, name: 'بارونی' },
    ], opts(noExtra));
    ok(twoGroups.length === 2, 'two rows, two warehouses → two separate groups', twoGroups);
    same(twoGroups.map((i) => [i.warehouse_id, i.after]).sort((a, b) => a[0] - b[0]),
      [[whA, -1], [whB, -6]].sort((a, b) => a[0] - b[0]), 'two groups: after -1 (whA) and -6 (whB)');

    const sumSameWh = XWH.collectInvoiceStockWarnings([
      { product_id: prodId, warehouse_id: whB, qty: 8, name: 'بارونی' },
      { product_id: prodId, warehouse_id: whB, qty: 8, name: 'بارونی' },
    ], opts(noExtra));
    ok(sumSameWh.length === 1 && sumSameWh[0].need === 16 && sumSameWh[0].after === -2, 'two rows same wh are summed (16 vs 14 → -2)', sumSameWh);

    const splitOk = XWH.collectInvoiceStockWarnings([
      { product_id: prodId, warehouse_id: whA, qty: 11, name: 'بارونی' },
      { product_id: prodId, warehouse_id: whB, qty: 14, name: 'بارونی' },
    ], opts(noExtra));
    ok(splitOk.length === 0, 'exact-fit split across warehouses → no warning', splitOk);

    const heldOk = XWH.collectInvoiceStockWarnings([
      { product_id: prodId, warehouse_id: whA, qty: 12, name: 'بارونی' },
    ], opts({ heldFn: heldOf({ ['product:' + prodId + '@' + whA]: 2 }) }));
    ok(heldOk.length === 0, 'held qty 2 in whA offsets need (11+2 ≥ 12)', heldOk);
    const heldOtherWh = XWH.collectInvoiceStockWarnings([
      { product_id: prodId, warehouse_id: whA, qty: 12, name: 'بارونی' },
    ], opts({ heldFn: heldOf({ ['product:' + prodId + '@' + whB]: 5 }) }));
    ok(heldOtherWh.length === 1, 'held qty in a different warehouse does not offset', heldOtherWh);

    const varWarn = XWH.collectInvoiceStockWarnings([
      { product_id: prodId, variant_id: varId, warehouse_id: whA, qty: 13, name: 'بارونی' },
    ], opts({ variantLabel: (c, s) => [c, s].filter(Boolean).join(' / ') }));
    const skuIssue = varWarn.filter((i) => i.kind === 'sku');
    ok(skuIssue.length === 1 && skuIssue[0].variant_id === varId && skuIssue[0].after === -2, 'variant row in whA: sku warning after -2', varWarn);
    ok(skuIssue[0].name.indexOf('انبار محصول') >= 0, 'sku warning name includes warehouse name');
    const varHeld = XWH.collectInvoiceStockWarnings([
      { product_id: prodId, variant_id: varId, warehouse_id: whA, qty: 13, name: 'بارونی' },
    ], opts({
      heldFn: heldOf({ ['sku:' + varId + '@' + whA]: 2, ['product:' + prodId + '@' + whA]: 2 }),
    }));
    ok(varHeld.length === 0, 'held sku/product qty offsets variant warning', varHeld);
    const varOk = XWH.collectInvoiceStockWarnings([
      { product_id: prodId, variant_id: varId, warehouse_id: whB, qty: 12, name: 'بارونی' },
    ], opts(noExtra));
    ok(varOk.length === 0, 'variant row in whB qty 12 / 14 → no warning', varOk);

    const skipRows = XWH.collectInvoiceStockWarnings([
      { product_id: prodId, warehouse_id: whA, qty: 50, name: 'درآمد', row_type: 'income' },
      { product_id: prodId, warehouse_id: whA, qty: 50, name: 'بچ', batch_id: 7 },
      { product_id: prodId, warehouse_id: whA, qty: 50, name: 'طاقه', is_fabric_roll: true },
    ], opts(noExtra));
    ok(skipRows.length === 0, 'income / batch / fabric-roll rows are ignored', skipRows);

    ok(XWH.collectInvoiceStockWarnings([], opts(noExtra)).length === 0, 'empty cart → no warnings');
    ok(XWH.collectInvoiceStockWarnings(null, opts(noExtra)).length === 0, 'null cart → no warnings');
    ok(XWH.collectInvoiceStockWarnings([{ product_id: prodId, warehouse_id: whA, qty: 0 }], opts(noExtra)).length === 0, 'qty 0 row → no warning');
    ok(XWH.collectInvoiceStockWarnings([{ product_id: prodId, qty: 50 }], { stockCache }).length === 0, 'no header wh and no row wh → skipped');

    // ── XWH-SHARED parity with app.js (only once the parent has wired the markers) ──
    console.log('\n— XWH-SHARED parity —');
    const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
    const libSrc = fs.readFileSync(path.join(__dirname, '../lib/invoice-line-wh-stock.js'), 'utf8');
    const sharedNames = ['invLineStockKey', 'invEffectiveLineWh', 'invLineAvail', 'collectInvoiceStockWarnings'];
    const missing = sharedNames.filter((n) => extractShared(appSrc, n) == null);
    if (missing.length === sharedNames.length) {
      console.log('  SKIP app.js has no XWH-SHARED blocks yet (parent wires UI) — parity check not run');
    } else {
      ok(missing.length === 0, 'app.js has every XWH-SHARED block', missing);
      for (const name of sharedNames) {
        if (missing.indexOf(name) >= 0) continue;
        ok(extractShared(appSrc, name) === extractShared(libSrc, name), 'parity ' + name);
      }
      if (missing.length === 0) {
        const sandbox = {};
        vm.createContext(sandbox);
        for (const name of sharedNames) vm.runInContext(extractShared(appSrc, name), sandbox);
        const vmIssues = sandbox.collectInvoiceStockWarnings([
          { product_id: prodId, warehouse_id: whA, qty: 12, name: 'بارونی' },
          { product_id: prodId, warehouse_id: whB, qty: 12, name: 'بارونی' },
        ], { headerWh: whA, stockCache, warehouseName: whName });
        ok(vmIssues.length === 1 && vmIssues[0].after === -1, 'vm(app.js): same results as lib', vmIssues);
      }
    }
    // the lib's own blocks must always be evaluable standalone (that is what app.js will copy)
    const libSandbox = {};
    vm.createContext(libSandbox);
    for (const name of sharedNames) {
      const block = extractShared(libSrc, name);
      ok(block != null, 'lib exposes XWH-SHARED:' + name);
      vm.runInContext(block, libSandbox);
    }
    const libVm = libSandbox.collectInvoiceStockWarnings([
      { product_id: prodId, warehouse_id: whA, qty: 12, name: 'بارونی' },
    ], { headerWh: whA, stockCache, warehouseName: whName });
    ok(libVm.length === 1 && libVm[0].after === -1, 'vm(lib blocks): standalone result matches');
  } finally {
    server.close();
  }

  console.log(`\n══ Result: ${pass} passed, ${fail} failed ══\n`);
  try { db.close(); } catch (_) { /* ignore */ }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
