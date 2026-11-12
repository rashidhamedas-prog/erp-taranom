'use strict';
/**
 * variant-report-flags-fix (SW v641) — unattributed is not a real size/colour,
 * explained WS≠ΣVWS is not a cell flag, detail view does not throw on unattr rows.
 *
 * Run (Node 20): node server/scripts/test-variant-report-flags.js
 * Never product 342 / code 7217.
 */
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

console.log('\n══ variant-report-flags-fix ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrf-flags-'));
process.env.DB_PATH = path.join(dir, 'vrf.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'variant-report-flags-test-secret-at-least-32!!';
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
const n3 = (v) => Math.round(Number(v || 0) * 1000) / 1000;

function loadUi() {
  const vsrPath = path.join(__dirname, '../public/variant-stock-report.js');
  const src = fs.readFileSync(vsrPath, 'utf8');
  const sandbox = {
    console,
    window: { _vsrState: null, _vsrData: null, _vsrLayerMap: null, _vsrCharts: [] },
    localStorage: {
      _m: Object.create(null),
      getItem(k) { return this._m[k] == null ? null : this._m[k]; },
      setItem(k, v) { this._m[k] = String(v); },
    },
    CSP: {
      bind() { return 'csp'; },
      style(s) { return String(s || ''); },
    },
    esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
    el() { return null; },
    fmt(n) { return String(n == null ? 0 : n); },
    fmtQty(n) { return String(n == null ? 0 : n); },
    showToast() {},
    WH_REP_EPS_QTY: 0.0005,
    WH_REP_TOL_RIAL: 1,
  };
  sandbox.window = sandbox.window;
  // whRepNormRow + helpers (copied from app.js — UI test only)
  sandbox.whRepNum = function (o, keys) {
    if (!o) return null;
    for (let i = 0; i < keys.length; i++) {
      const v = o[keys[i]];
      if (v != null && v !== '' && isFinite(Number(v))) return Number(v);
    }
    return null;
  };
  sandbox.whRepFlagOn = function (o, keys) {
    if (!o) return false;
    const fl = (o.flags && typeof o.flags === 'object' && !Array.isArray(o.flags)) ? o.flags : null;
    const arr = Array.isArray(o.flags) ? o.flags.map(String) : [];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (o[k] === true || o[k] === 1 || o[k] === '1') return true;
      if (fl && (fl[k] === true || fl[k] === 1)) return true;
      if (arr.indexOf(k) >= 0) return true;
    }
    return false;
  };
  sandbox.whRepNormRow = function (p) {
    p = p || {};
    const hasKardex = p.kardex_qty != null || p.ledger_qty != null || p.ledger_value_rial != null || p.source === 'kardex';
    const qty = sandbox.whRepNum(p, ['kardex_qty', 'ledger_qty', 'qty', 'stock']);
    const wsQty = sandbox.whRepNum(p, ['ws_qty', 'warehouse_qty', 'stock_qty']);
    const value = sandbox.whRepNum(p, ['ledger_value_rial', 'value_rial', 'amount_rial', 'cost_value']);
    let avg = sandbox.whRepNum(p, ['avg_rate_rial', 'weighted_avg_rate_rial', 'weighted_avg_unit_rial', 'avg_cost_rial', 'unit_cost_rial', 'cost']);
    if (avg == null && qty && Math.abs(qty) > sandbox.WH_REP_EPS_QTY && value != null) avg = Math.round(value / qty);
    let driftQty = sandbox.whRepNum(p, ['drift_qty', 'stock_drift_qty', 'drift_qty_vs_ws', 'drift_ws_ledger_qty']);
    if (driftQty == null && hasKardex && wsQty != null && qty != null) driftQty = qty - wsQty;
    let driftVal = sandbox.whRepNum(p, ['drift_value_rial', 'drift_value', 'value_diff_rial', 'header_value_diff_rial', 'header_diff_rial']);
    if (driftVal == null) {
      const hv = sandbox.whRepNum(p, ['header_value_rial']);
      if (hv != null && value != null) driftVal = value - hv;
    }
    const qtyDrift = driftQty != null && Math.abs(driftQty) > sandbox.WH_REP_EPS_QTY;
    const valDrift = driftVal != null && Math.abs(driftVal) > sandbox.WH_REP_TOL_RIAL;
    const drift = sandbox.whRepFlagOn(p, ['drift_any', 'drift_ws_ledger', 'drift_ws_vws', 'layer_drift', 'header_drift', 'warehouse_drift', 'ws_vs_ledger', 'ws_vs_vws', 'header_vs_ws', 'mismatch', 'has_drift']) || qtyDrift;
    const negQty = sandbox.whRepFlagOn(p, ['negative_qty']) || (qty != null && qty < -sandbox.WH_REP_EPS_QTY);
    const negValFlag = sandbox.whRepFlagOn(p, ['negative_value']);
    const ghost = sandbox.whRepFlagOn(p, ['ghost_value', 'zero_qty_nonzero_value', 'zero_qty_value'])
      || (qty != null && Math.abs(qty) < sandbox.WH_REP_EPS_QTY && value != null && Math.abs(value) > sandbox.WH_REP_TOL_RIAL);
    const negVal = (negValFlag || (value != null && value < -sandbox.WH_REP_TOL_RIAL)) && !ghost;
    const flags = [];
    if (ghost) flags.push({ key: 'ghost', level: 'bad', label: 'مقدار ۰ با ارزش ≠ ۰' });
    if (drift) flags.push({ key: 'drift', level: 'bad', label: 'اختلاف با لایهٔ دیگر' });
    if (negQty && !ghost) flags.push({ key: 'negqty', level: 'warn', label: 'موجودی منفی' });
    if (negVal) flags.push({ key: 'negval', level: 'warn', label: 'ارزش منفی' });
    if (valDrift && !drift) flags.push({ key: 'valdrift', level: 'warn', label: 'ارزش ≠ سرستون' });
    return { qty, wsQty, value, avg, driftQty, driftVal, drift, ghost, flags, fromKardex: hasKardex };
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'variant-stock-report.js' });
  return sandbox;
}

function bindLayers(sandbox, payload) {
  sandbox.window._vsrData = payload;
  sandbox.window._vsrLayerMap = new Map(((payload.layers) || []).map((L) => [L.product_id + ':' + L.warehouse_id, L]));
  (payload.cells || []).forEach((c) => { delete c._vsrNorm; });
}

async function main() {
  const L = require('../lib/inventory/ledger');
  const cache = require('../lib/inventory/stock-cache');
  const M = require('../lib/inventory/movement');
  const { buildVariantStockReport } = require('../lib/inventory/variant-report');
  const { todayJalali } = require('../jalali');

  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('inventory_allow_negative','1')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('ledger_leaf_enforcement','warn')").run();
  for (const [code, name, type, parent] of [
    ['1104', 'موجودی کالا', 'asset', null],
    ['110402', 'موجودی انبار محصول', 'asset', '1104'],
    ['110403', 'موجودی انبار کیمیا', 'asset', '1104'],
    ['4205', 'اضافی انبارگردانی', 'revenue', '4000'],
    ['6108', 'کسری و ضایعات انبار', 'expense', '6000'],
    ['610801', 'خالص کسری انبار', 'expense', '6108'],
    ['6118', 'کسری و اضافات انبار', 'expense', '6000'],
    ['3102', 'افتتاحیه', 'equity', null],
  ]) {
    db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES (?,?,?,?,3,1)')
      .run(code, name, type, parent);
  }

  const ADMIN_ID = insert('users', {
    name: 'مدیر', username: 'vrf_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0,
  });
  const WH_A = insert('warehouses', {
    name: 'محصول', code: 'VRF-A', active: 1, allow_negative: 1,
    warehouse_type: 'finished_goods', inventory_system: 'perpetual', inventory_coa_code: '110402',
  });
  const WH_B = insert('warehouses', {
    name: 'کیمیا', code: 'VRF-B', active: 1, allow_negative: 1,
    warehouse_type: 'finished_goods', inventory_system: 'perpetual', inventory_coa_code: '110403',
  });

  ok(!q1('SELECT 1 FROM products WHERE id=342 OR code=?', '7217'), 'product 342/7217 absent');

  const D = todayJalali();
  const UNIT = 1000000;
  const P = insert('products', {
    user_id: ADMIN_ID, name: 'ماتریس پرچم', code: 'VRF-MX', price: 1,
    average_cost_rial: UNIT, stock: 0, unit: 'عدد', has_variants: 1, is_style: 1,
  });
  ok(![342].includes(P), 'fixture id not 342', { P });

  // 7 colours × 2 sizes (mirrors 7154 shape; never production ids)
  const colorNames = ['کرمی', 'مشکی', 'نخودی', 'یشمی۱', 'یشمی۲', 'زرشکی۱', 'زرشکی۲'];
  const colors = colorNames.map((name, i) => insert('product_colors', {
    name, code: 'VRF-C' + i, active: 1, sort_order: i + 1,
  }));
  const sizes = ['سایز1', 'سایز2'].map((name, i) => insert('product_sizes', {
    name, code: 'VRF-S' + i, active: 1, sort_order: i + 1,
  }));
  const V = [];
  for (let ci = 0; ci < 7; ci++) {
    V[ci] = [];
    for (let si = 0; si < 2; si++) {
      V[ci][si] = insert('product_variants', {
        product_id: P, color_id: colors[ci], size_id: sizes[si],
        sku: `VRF-${ci}-${si}`, stock: 0, active: 1, is_default: 0,
      });
    }
  }

  function openCell(pid, vid, wid, qty, docId) {
    L.postInventoryMovement(db, {
      eventType: 'opening', productId: pid, warehouseId: wid, variantId: vid,
      qtyIn: qty, unitCostRial: UNIT, sourceType: 'opening_stock_doc', sourceId: docId,
      date: D, createdBy: ADMIN_ID,
    });
    M.postVariantLayer(db, {
      productId: pid, variantId: vid, warehouseId: wid, qtyDelta: qty,
      docType: 'opening_stock_doc', docId: docId, userId: ADMIN_ID, note: 'seed',
    });
  }

  // A: کرمی / سایز1 = 1
  openCell(P, V[0][0], WH_A, 1, 1);
  // B attributed summing 7 across 6 cells (like 7154):
  // مشکی/2=2, نخودی/2=1, یشمی۱ both 1+1, زرشکی۱ both 1+1
  openCell(P, V[1][1], WH_B, 2, 2);
  openCell(P, V[2][1], WH_B, 1, 3);
  openCell(P, V[3][0], WH_B, 1, 4);
  openCell(P, V[3][1], WH_B, 1, 5);
  openCell(P, V[4][0], WH_B, 1, 6);
  openCell(P, V[4][1], WH_B, 1, 7);
  // B unattributed sale −5 (legacy invoice shape — direct ledger row, variant_id NULL)
  insert('inventory_ledger', {
    tx_no: 'VRF-UNATTR-SALE', event_type: 'sale', product_id: P, warehouse_id: WH_B,
    qty_in: 0, qty_out: 5, unit_cost_rial: UNIT, amount_rial: 5 * UNIT,
    source_type: 'invoice', source_id: 1766, date: D, status: 'posted', created_by: ADMIN_ID,
  });
  cache.rebuildStockCache(db, P);

  // ── Case 1: all-warehouse KPIs + explained layer B ──
  const all = buildVariantStockReport(db, { product_id: P });
  ok(all.kpis.total_qty === 3, '1: total_qty 3', all.kpis);
  ok(all.kpis.color_count === 5, '1: color_count 5', all.kpis);
  ok(all.kpis.size_count === 2, '1: size_count 2', all.kpis);
  ok(all.kpis.gap_count === 3, '1: gap_count 3', { gaps: all.gaps });
  ok(all.kpis.unattributed_qty === -5, '1: unattributed_qty −5', all.kpis);
  const layerB = (all.layers || []).find((x) => x.warehouse_id === WH_B);
  ok(!!layerB && layerB.ws_vs_vws === true, '1: layer B ws_vs_vws true', layerB);
  ok(!!layerB && layerB.ws_vs_vws_explained === true, '1: layer B explained true', layerB);
  ok(!!layerB && layerB.ws_vs_vws_unexplained === false, '1: layer B unexplained false', layerB);
  ok(!!layerB && layerB.drift === false, '1: layer B drift false', layerB);
  ok(!(all.by_product[0] && all.by_product[0].color_count === 6), '1: product color_count not inflated by unattr', all.by_product[0]);

  // ── Case 2: warehouse filters ──
  const onlyB = buildVariantStockReport(db, { product_id: P, warehouse_id: WH_B });
  ok(onlyB.kpis.total_qty === 2, '2: filter B total 2', onlyB.kpis);
  ok(onlyB.kpis.unattributed_qty === -5, '2: filter B unattr −5', onlyB.kpis);
  const onlyA = buildVariantStockReport(db, { product_id: P, warehouse_id: WH_A });
  ok(onlyA.kpis.total_qty === 1, '2: filter A total 1', onlyA.kpis);
  ok(!((onlyA.cells || []).some((c) => c.unattributed)), '2: filter A no unattr cell', onlyA.cells);

  // ── Case 4–6 UI (explained fixture) ──
  const ui = loadUi();
  bindLayers(ui, all);
  ui.window._vsrState = ui.vsrDefaultState();
  ui.window._vsrState.view = 'matrix';
  ui.window._vsrState.filters.product_id = String(P);
  ui.window._vsrState.matrixProduct = String(P);
  ui.window._vsrState.includeZero = true;

  const matrixHtml = ui.vsrHtmlMatrix(all);
  const gapCount = (matrixHtml.match(/vsr-gap/g) || []).length;
  const flagCount = (matrixHtml.match(/vsr-flagged/g) || []).length;
  const sizeHeaders = (matrixHtml.match(/<th>سایز/g) || []).length;
  ok(gapCount === 3, '4: matrix has exactly 3 vsr-gap', { gapCount });
  ok(flagCount === 0, '4: matrix has 0 vsr-flagged', { flagCount });
  ok(sizeHeaders === 2, '4: two size header columns', { sizeHeaders });
  ok(/<th>جمع<\/th>/.test(matrixHtml), '4: جمع column header present');
  ok(/بدون رنگ\/سایز/.test(matrixHtml) && /vsr-unattr/.test(matrixHtml), '4: unattr row present');
  ok(/neg-qty/.test(matrixHtml) && matrixHtml.indexOf(ui.vsrQty(-5)) >= 0, '4: unattr row shows −5', {
    qty: ui.vsrQty(-5),
  });
  ok(/در شکستگی حساب نمی‌شود/.test(matrixHtml), '4: legend mentions unattr exclusion');

  let detailOk = true;
  let detailHtml = '';
  try {
    ui.window._vsrState.view = 'detail';
    ui.window._vsrState.includeZero = true;
    detailHtml = ui.vsrHtmlDetail(all);
  } catch (e) {
    detailOk = false;
    ok(false, '5: vsrHtmlDetail threw', String(e && e.message || e));
  }
  if (detailOk) {
    ok(true, '5: vsrHtmlDetail does not throw with unattr row');
    ok(/class="vsr-unattr neg-qty"/.test(detailHtml), '5: unattr row class vsr-unattr neg-qty', detailHtml.slice(0, 200));
  }

  const status = ui.vsrStatusText(all);
  // vsrQty → Persian digits; vsrMoney/fmt stub → ASCII (production fmt is also fine either way)
  ok(/^موجودی ۳ · (۵|5) رنگ · (۲|2) سایز · (۳|3) شکستگی/.test(status), '6: status core text', status);
  ok(!/پرچم/.test(status), '6: status has no پرچم', status);
  ok(/بدون رنگ\/سایز/.test(status), '6: status has unattr note', status);

  // ── Case 3: real cache drift → unexplained + UI flags ──
  const bumpVid = V[1][1];
  db.prepare('UPDATE variant_warehouse_stock SET qty = qty + 1 WHERE variant_id=? AND warehouse_id=?')
    .run(bumpVid, WH_B);
  const drifted = buildVariantStockReport(db, { product_id: P });
  const layerB2 = (drifted.layers || []).find((x) => x.warehouse_id === WH_B);
  ok(!!layerB2 && layerB2.ws_vs_vws === true, '3: after VWS+1 still ws_vs_vws', layerB2);
  ok(!!layerB2 && layerB2.ws_vs_vws_unexplained === true, '3: unexplained true', layerB2);
  ok(!!layerB2 && layerB2.ws_vs_vws_explained === false, '3: explained false', layerB2);
  bindLayers(ui, drifted);
  const matrixDrift = ui.vsrHtmlMatrix(drifted);
  ok(/(vsr-flagged)/.test(matrixDrift), '3: UI flags warehouse cells when unexplained');
  // restore VWS for case 7
  db.prepare('UPDATE variant_warehouse_stock SET qty = qty - 1 WHERE variant_id=? AND warehouse_id=?')
    .run(bumpVid, WH_B);

  // ── Case 7: product without unattributed — no unattr row / same shape as attributed-only ──
  const P2 = insert('products', {
    user_id: ADMIN_ID, name: 'ماتریس تمیز', code: 'VRF-CLEAN', price: 1,
    average_cost_rial: UNIT, stock: 0, unit: 'عدد', has_variants: 1, is_style: 1,
  });
  const cClean = insert('product_colors', { name: 'آبی', code: 'VRF-CL', active: 1, sort_order: 1 });
  const s1 = sizes[0];
  const s2 = sizes[1];
  const v1 = insert('product_variants', {
    product_id: P2, color_id: cClean, size_id: s1, sku: 'VRF-CL-1', stock: 0, active: 1, is_default: 0,
  });
  const v2 = insert('product_variants', {
    product_id: P2, color_id: cClean, size_id: s2, sku: 'VRF-CL-2', stock: 0, active: 1, is_default: 0,
  });
  openCell(P2, v1, WH_A, 3, 90);
  openCell(P2, v2, WH_A, 2, 91);
  cache.rebuildStockCache(db, P2);
  const clean = buildVariantStockReport(db, { product_id: P2 });
  ok(Math.abs(Number(clean.kpis.unattributed_qty) || 0) < 1e-9, '7: no unattr qty', clean.kpis);
  ok(clean.kpis.color_count === 1 && clean.kpis.size_count === 2, '7: color/size counts', clean.kpis);
  ok(clean.kpis.total_qty === 5, '7: total 5', clean.kpis);
  bindLayers(ui, clean);
  const cleanMatrix = ui.vsrHtmlMatrix(clean);
  ok(!/vsr-unattr/.test(cleanMatrix), '7: no vsr-unattr class without unattr stock');
  ok(!/vsr-flagged/.test(cleanMatrix), '7: no false flags on clean product');
  ok(clean.kpis.gap_count === 0, '7: no gaps on fully stocked colour', clean.kpis);

  console.log(`\n── result: ${pass} passed, ${fail} failed ──\n`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
