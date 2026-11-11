'use strict';
/**
 * adjust-variant-sync-fix — cache mirrors ledger when attributed rows exist (incl. to 0);
 * colour report includes «بدون رنگ/سایز»; preview warns product-wide unattributed;
 * invariant guard rolls back divergent adjusts.
 *
 * Run (Node 20): node server/scripts/test-adjust-variant-sync.js
 * Never product 342 / code 7217.
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

console.log('\n══ adjust-variant-sync-fix ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adjust-variant-sync-'));
process.env.DB_PATH = path.join(dir, 'avs.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'adjust-variant-sync-test-secret-at-least-32!!';
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
const changes = () => q1('SELECT total_changes() AS n').n;

async function main() {
  const express = require('express');
  const L = require('../lib/inventory/ledger');
  const MA = require('../lib/inventory/manual-adjust');
  const cache = require('../lib/inventory/stock-cache');
  const { buildVariantStockReport } = require('../lib/inventory/variant-report');
  const M = require('../lib/inventory/movement');
  const { todayJalali } = require('../jalali');

  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('inventory_allow_negative','0')").run();
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
  db.prepare("UPDATE chart_of_accounts SET parent_code='6108' WHERE code='610801'").run();

  const ADMIN_ID = insert('users', {
    name: 'مدیر', username: 'avs_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0,
  });
  const WH_A = insert('warehouses', {
    name: 'انبار A', code: 'AVS-A', active: 1, allow_negative: 1,
    warehouse_type: 'finished_goods', inventory_system: 'perpetual', inventory_coa_code: '110402',
  });
  const WH_B = insert('warehouses', {
    name: 'انبار B', code: 'AVS-B', active: 1, allow_negative: 0,
    warehouse_type: 'finished_goods', inventory_system: 'perpetual', inventory_coa_code: '110403',
  });

  const authMw = require('../middleware/auth');
  authMw.auth = (req, _res, next) => {
    const u = q1('SELECT id, role, name, username FROM users WHERE id=?', ADMIN_ID);
    req.user = { id: u.id, role: u.role, name: u.name, username: u.username };
    next();
  };
  const app = express();
  app.use(express.json());
  app.use('/api/inventory', require('../routes/inventory'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch (_) { json = null; }
    return { status: res.status, body: json };
  };

  const admin = { id: ADMIN_ID, role: 'admin' };
  const D = todayJalali();
  const UNIT = 1000000;

  const vwsCache = (vid, wid) => {
    const r = q1('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?', vid, wid);
    return r ? n3(r.qty) : 0;
  };
  const pvStock = (vid) => n3(q1('SELECT stock FROM product_variants WHERE id=?', vid)?.stock);
  const ledVW = (pid, vid, wid) => n3(cache.derivedQty(db, { productId: pid, warehouseId: wid, variantId: vid }));
  const ledWh = (pid, wid) => n3(L.stockOf(db, { productId: pid, warehouseId: wid }));
  const assertMirror = (pid, label) => {
    const recon = cache.stockCacheVsLedger(db, { productId: pid });
    ok(recon.ok === true, `${label}: stockCacheVsLedger ok`, recon.rows);
    const vs = db.prepare('SELECT id FROM product_variants WHERE product_id=? AND COALESCE(is_default,0)=0').all(pid);
    for (const v of vs) {
      const vid = Number(v.id);
      for (const wh of [WH_A, WH_B]) {
        ok(Math.abs(vwsCache(vid, wh) - ledVW(pid, vid, wh)) < 1e-9,
          `${label}: VWS==ledger ${vid}@${wh}`, { vws: vwsCache(vid, wh), led: ledVW(pid, vid, wh) });
      }
      const sumWh = n3(ledVW(pid, vid, WH_A) + ledVW(pid, vid, WH_B));
      ok(Math.abs(pvStock(vid) - sumWh) < 1e-9, `${label}: pv==Σ ledger ${vid}`, { pv: pvStock(vid), sumWh });
    }
  };
  const reportEqKardex = (pid, wid, label) => {
    const rep = buildVariantStockReport(db, { product_id: pid, warehouse_id: wid });
    const sum = n3((rep.cells || []).filter((c) => c.source !== 'cache')
      .reduce((s, c) => s + (Number(c.qty) || 0), 0));
    const kardex = ledWh(pid, wid);
    ok(Math.abs(sum - kardex) < 1e-9, `${label}: report Σ == kardex`, { sum, kardex });
    return rep;
  };

  ok(!q1('SELECT 1 FROM products WHERE id=342 OR code=?', '7217'), 'product 342/7217 absent');

  // ── Fixture: 3 colours × 2 sizes, openings in A, transfer A→B, unattributed −5 in B ──
  const P = insert('products', {
    user_id: ADMIN_ID, name: 'ماتریس همگامی', code: 'AVS-MX', price: 1,
    average_cost_rial: UNIT, stock: 0, unit: 'عدد', has_variants: 1, is_style: 1,
  });
  ok(![342].includes(P), 'fixture id not 342', { P });
  const colors = [];
  const sizes = [];
  for (const [name, code] of [['مشکی', 'C1'], ['سرمه‌ای', 'C2'], ['نخودی', 'C3']]) {
    colors.push(insert('product_colors', { name, code, active: 1 }));
  }
  for (const [name, code] of [['سایز1', 'S1'], ['سایز2', 'S2']]) {
    sizes.push(insert('product_sizes', { name, code, active: 1 }));
  }
  const V = []; // [c][s]
  for (let ci = 0; ci < 3; ci++) {
    V[ci] = [];
    for (let si = 0; si < 2; si++) {
      V[ci][si] = insert('product_variants', {
        product_id: P, color_id: colors[ci], size_id: sizes[si],
        sku: `AVS-${ci}-${si}`, stock: 0, active: 1, is_default: 0,
      });
    }
  }
  // Openings attributed in A: each cell +2 except we'll use specific amounts later
  // Base: all 6 cells = 2 in A
  for (const ci of [0, 1, 2]) {
    for (const si of [0, 1]) {
      const vid = V[ci][si];
      L.postInventoryMovement(db, {
        eventType: 'opening', productId: P, warehouseId: WH_A, variantId: vid,
        qtyIn: 2, unitCostRial: UNIT, sourceType: 'opening_stock_doc', sourceId: 1,
        date: D, createdBy: ADMIN_ID,
      });
      M.postVariantLayer(db, {
        productId: P, variantId: vid, warehouseId: WH_A, qtyDelta: 2,
        docType: 'opening_stock_doc', docId: 1, userId: ADMIN_ID, note: 'seed',
      });
    }
  }
  // Transfer 1 of each of first 3 variants A→B (so B has attributed stock)
  let tDoc = 10;
  for (const vid of [V[0][0], V[0][1], V[1][0]]) {
    tDoc += 1;
    L.postInventoryMovement(db, {
      eventType: 'transfer_out', productId: P, warehouseId: WH_A, variantId: vid,
      qtyOut: 1, unitCostRial: UNIT, sourceType: 'wh_transfer', sourceId: tDoc,
      date: D, createdBy: ADMIN_ID,
    });
    M.postVariantLayer(db, {
      productId: P, variantId: vid, warehouseId: WH_A, qtyDelta: -1,
      docType: 'wh_transfer_out', docId: tDoc, userId: ADMIN_ID, note: 'xfer out',
    });
    L.postInventoryMovement(db, {
      eventType: 'transfer_in', productId: P, warehouseId: WH_B, variantId: vid,
      qtyIn: 1, unitCostRial: UNIT, sourceType: 'wh_transfer', sourceId: tDoc,
      date: D, createdBy: ADMIN_ID,
    });
    M.postVariantLayer(db, {
      productId: P, variantId: vid, warehouseId: WH_B, qtyDelta: 1,
      docType: 'wh_transfer_in', docId: tDoc, userId: ADMIN_ID, note: 'xfer in',
    });
  }
  // Unattributed live sale −5 in B (7154 shape)
  insert('inventory_ledger', {
    tx_no: 'AVS-UNATTR-SALE', event_type: 'sale', product_id: P, warehouse_id: WH_B,
    qty_in: 0, qty_out: 5, unit_cost_rial: UNIT, amount_rial: 5 * UNIT,
    source_type: 'invoice', source_id: 2, date: D, status: 'posted', created_by: ADMIN_ID,
  });
  cache.rebuildStockCache(db, P);
  assertMirror(P, 'seed');

  const posted = [];

  console.log('— 1. count loss to exactly 0 (106 case) —');
  {
    // V[1][1] still 2 in A → count to 0
    const vid = V[1][1];
    ok(ledVW(P, vid, WH_A) === 2 && vwsCache(vid, WH_A) === 2, 'pre: cell=2');
    const r = await call('POST', '/api/inventory/adjust', {
      product_id: P, warehouse_id: WH_A, variant_id: vid,
      mode: 'count', qty: 0, reason_code: 'shortage', date: D, note: 'case1',
    });
    ok(r.status === 200, 'case1 post', r.body);
    ok(vwsCache(vid, WH_A) === 0 && pvStock(vid) === ledVW(P, vid, WH_A) + ledVW(P, vid, WH_B),
      'case1 VWS/pv cleared to ledger', { vws: vwsCache(vid, WH_A), pv: pvStock(vid) });
    assertMirror(P, 'case1');
    posted.push(r.body.id);
  }

  console.log('— 2. count gain to 0 from negative (105 case) —');
  {
    // Drive V[2][0]@A to −2 then count to 0
    const vid = V[2][0];
    const down = await call('POST', '/api/inventory/adjust', {
      product_id: P, warehouse_id: WH_A, variant_id: vid,
      mode: 'delta', qty: -4, reason_code: 'shortage', date: D, note: 'case2-pre',
    });
    ok(down.status === 200 && ledVW(P, vid, WH_A) === -2, 'case2 pre → −2', { led: ledVW(P, vid, WH_A) });
    posted.push(down.body.id);
    const r = await call('POST', '/api/inventory/adjust', {
      product_id: P, warehouse_id: WH_A, variant_id: vid,
      mode: 'count', qty: 0, reason_code: 'surplus', date: D, note: 'case2',
    });
    ok(r.status === 200 && vwsCache(vid, WH_A) === 0, 'case2 VWS=0', { vws: vwsCache(vid, WH_A) });
    assertMirror(P, 'case2');
    posted.push(r.body.id);
  }

  console.log('— 3. delta gain inserting new VWS row (780 case) —');
  {
    // New colour with no VWS row yet
    const cNew = insert('product_colors', { name: 'کرمی', code: 'C4', active: 1 });
    const vid = insert('product_variants', {
      product_id: P, color_id: cNew, size_id: sizes[0],
      sku: 'AVS-NEW-780', stock: 0, active: 1, is_default: 0,
    });
    ok(!q1('SELECT 1 FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?', vid, WH_A),
      'case3 no VWS row yet');
    const r = await call('POST', '/api/inventory/adjust', {
      product_id: P, warehouse_id: WH_A, variant_id: vid,
      mode: 'delta', qty: 1, reason_code: 'surplus', date: D, note: 'case3',
    });
    ok(r.status === 200 && vwsCache(vid, WH_A) === 1, 'case3 VWS inserted=1', { vws: vwsCache(vid, WH_A) });
    assertMirror(P, 'case3');
    posted.push(r.body.id);
    V.push([vid]); // track for later voids if needed
  }

  console.log('— 4. delta loss to −1 (allow_neg A ok; B 409) —');
  {
    const vid = V[0][1]; // has 1 in A after transfer
    const rA = await call('POST', '/api/inventory/adjust', {
      product_id: P, warehouse_id: WH_A, variant_id: vid,
      mode: 'delta', qty: -2, reason_code: 'shortage', date: D, note: 'case4a',
    });
    ok(rA.status === 200 && vwsCache(vid, WH_A) === -1, 'case4 A → −1', { vws: vwsCache(vid, WH_A) });
    posted.push(rA.body.id);
    assertMirror(P, 'case4a');
    const c0 = changes();
    const rB = await call('POST', '/api/inventory/adjust', {
      product_id: P, warehouse_id: WH_B, variant_id: vid,
      mode: 'delta', qty: -2, reason_code: 'shortage', date: D, note: 'case4b',
    });
    // B has unattributed −5 → blocked by E_ADJUST_UNATTRIBUTED_EXISTS first,
    // OR if we used a clean variant in B without unattr... B has unattr so 409 unattr.
    ok(rB.status === 409 && changes() === c0, 'case4 B blocked (unattr or negative)', rB.body);
  }

  console.log('— 5. sequence all 6 cells of A —');
  {
    const cells = [];
    for (const ci of [0, 1, 2]) {
      for (const si of [0, 1]) cells.push(V[ci][si]);
    }
    for (let i = 0; i < cells.length; i++) {
      const vid = cells[i];
      const cur = ledVW(P, vid, WH_A);
      const target = i % 2 === 0 ? 0 : n3(cur + 1);
      const r = await call('POST', '/api/inventory/adjust', {
        product_id: P, warehouse_id: WH_A, variant_id: vid,
        mode: 'count', qty: Math.max(0, target), reason_code: target >= cur ? 'surplus' : 'shortage',
        date: D, note: `case5-${i}`,
      });
      if (r.status === 200) {
        posted.push(r.body.id);
        assertMirror(P, `case5-${i}`);
      } else if (r.body && r.body.code === 'E_ADJUST_NO_CHANGE') {
        ok(true, `case5-${i} no-change skip`);
      } else {
        ok(false, `case5-${i} unexpected`, r.body);
      }
    }
    reportEqKardex(P, WH_A, 'case5 final A');
  }

  console.log('— 6. void adjusts reverse order —');
  {
    const ids = [...posted].reverse();
    for (const id of ids) {
      const row = q1('SELECT * FROM inventory_ledger WHERE id=?', id);
      if (!row || row.reversed_of) continue;
      const r = await call('POST', `/api/inventory/ledger/${id}/reverse`, { note: 'void case6' });
      ok(r.status === 200, `void ${id}`, r.body && r.body.code);
      assertMirror(P, `void-${id}`);
    }
  }

  console.log('— 7. transfer last piece to 0 (K-00010 case) —');
  {
    // Ensure a cell has exactly 1 in A, transfer out
    const vid = V[2][1];
    const cur = ledVW(P, vid, WH_A);
    if (Math.abs(cur - 1) > 1e-9) {
      await call('POST', '/api/inventory/adjust', {
        product_id: P, warehouse_id: WH_A, variant_id: vid,
        mode: 'count', qty: 1, reason_code: cur > 1 ? 'shortage' : 'surplus', date: D, note: 'case7-prep',
      });
    }
    ok(ledVW(P, vid, WH_A) === 1, 'case7 prep=1', { led: ledVW(P, vid, WH_A) });
    const doc = 9001;
    L.postInventoryMovement(db, {
      eventType: 'transfer_out', productId: P, warehouseId: WH_A, variantId: vid,
      qtyOut: 1, unitCostRial: UNIT, sourceType: 'wh_transfer', sourceId: doc,
      date: D, createdBy: ADMIN_ID,
    });
    M.postVariantLayer(db, {
      productId: P, variantId: vid, warehouseId: WH_A, qtyDelta: -1,
      docType: 'wh_transfer_out', docId: doc, userId: ADMIN_ID, note: 'case7 out',
    });
    L.postInventoryMovement(db, {
      eventType: 'transfer_in', productId: P, warehouseId: WH_B, variantId: vid,
      qtyIn: 1, unitCostRial: UNIT, sourceType: 'wh_transfer', sourceId: doc,
      date: D, createdBy: ADMIN_ID,
    });
    M.postVariantLayer(db, {
      productId: P, variantId: vid, warehouseId: WH_B, qtyDelta: 1,
      docType: 'wh_transfer_in', docId: doc, userId: ADMIN_ID, note: 'case7 in',
    });
    ok(vwsCache(vid, WH_A) === 0 && ledVW(P, vid, WH_A) === 0, 'case7 A cell → 0', {
      vws: vwsCache(vid, WH_A), led: ledVW(P, vid, WH_A),
    });
    assertMirror(P, 'case7');
  }

  console.log('— 8. seed-only guard kept (4b) —');
  {
    const P2 = insert('products', {
      user_id: ADMIN_ID, name: 'فقط افتتاحیه بی‌رنگ', code: 'AVS-SEED', price: 1,
      average_cost_rial: UNIT, stock: 0, unit: 'عدد', has_variants: 1, is_style: 1,
    });
    const v1 = insert('product_variants', {
      product_id: P2, color_id: colors[0], size_id: sizes[0], sku: 'AVS-S-1', stock: 0, active: 1, is_default: 0,
    });
    const v2 = insert('product_variants', {
      product_id: P2, color_id: colors[0], size_id: sizes[1], sku: 'AVS-S-2', stock: 0, active: 1, is_default: 0,
    });
    insert('inventory_ledger', {
      tx_no: 'AVS-SEED-OPEN', event_type: 'opening', product_id: P2, warehouse_id: WH_A,
      qty_in: 7, qty_out: 0, unit_cost_rial: UNIT, amount_rial: 7 * UNIT,
      source_type: 'opening_inventory', source_id: 1, date: D, status: 'posted', created_by: ADMIN_ID,
    });
    cache.withCacheWriter(db, () => {
      db.prepare('INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,?)').run(v1, WH_A, 3);
      db.prepare('INSERT INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,?)').run(v2, WH_A, 4);
      db.prepare('UPDATE product_variants SET stock=? WHERE id=?').run(3, v1);
      db.prepare('UPDATE product_variants SET stock=? WHERE id=?').run(4, v2);
    });
    const sum = cache.rebuildStockCache(db, P2);
    ok(sum.preserved_variant_cells >= 2 && vwsCache(v1, WH_A) === 3 && vwsCache(v2, WH_A) === 4,
      'case8 seed preserved', sum);
    const rep = buildVariantStockReport(db, { product_id: P2, warehouse_id: WH_A });
    const unattr = (rep.cells || []).find((c) => c.unattributed);
    ok(unattr && n3(unattr.qty) === 7, 'case8 report بدون رنگ=7', unattr);
    ok(n3(rep.kpis.cache_only_qty) === 7, 'case8 cache_only_qty=7', rep.kpis);
    ok(n3(rep.kpis.total_qty) === 7, 'case8 total=7 (unattr only in totals)', rep.kpis);
  }

  console.log('— 9. report with unattributed −5 in B —');
  {
    const rep = reportEqKardex(P, WH_B, 'case9');
    const unattr = (rep.cells || []).find((c) => c.unattributed && c.warehouse_id === WH_B);
    ok(unattr && n3(unattr.qty) === -5, 'case9 بدون رنگ=−5', unattr);
    ok(!(rep.layers || []).some((l) => l.warehouse_id === WH_B && l.drift),
      'case9 layer_drift false for B', rep.layers);
    ok(n3(rep.kpis.unattributed_qty) === -5, 'case9 kpis.unattributed_qty', rep.kpis);
  }

  console.log('— 10. preview product-wide warning —');
  {
    const prev = await call('POST', '/api/inventory/adjust/preview', {
      product_id: P, warehouse_id: WH_A, variant_id: V[0][0],
      mode: 'delta', qty: 1, reason_code: 'surplus', date: D,
    });
    ok(prev.status === 200
      && Array.isArray(prev.body.unattributed_other)
      && prev.body.unattributed_other.some((u) => Number(u.warehouse_id) === WH_B && n3(u.qty) === -5)
      && (prev.body.warnings || []).some((w) => /بدون رنگ\/سایز/.test(w)),
      'case10 preview warns other WH −5', prev.body);
    const post = await call('POST', '/api/inventory/adjust', {
      product_id: P, warehouse_id: WH_A, variant_id: V[0][0],
      mode: 'delta', qty: 1, reason_code: 'surplus', date: D, note: 'case10',
    });
    ok(post.status === 200, 'case10 POST in A succeeds', post.body);
    if (post.body && post.body.id) {
      await call('POST', `/api/inventory/ledger/${post.body.id}/reverse`, { note: 'undo case10' });
    }
    const c0 = changes();
    const blocked = await call('POST', '/api/inventory/adjust', {
      product_id: P, warehouse_id: WH_B, variant_id: V[0][0],
      mode: 'delta', qty: 1, reason_code: 'surplus', date: D, note: 'case10b',
    });
    ok(blocked.status === 409 && blocked.body.code === 'E_ADJUST_UNATTRIBUTED_EXISTS' && changes() === c0,
      'case10 POST in B → 409 unattr', blocked.body);
  }

  console.log('— 11. invariant guard rolls back —');
  {
    const orig = cache.rebuildStockCache;
    cache.rebuildStockCache = function (dbx, productId, opts) {
      const summary = orig(dbx, productId, opts);
      // Skip writing VWS for the next adjust by corrupting after rebuild
      const vid = V[1][0];
      try {
        cache.withCacheWriter(dbx, () => {
          dbx.prepare('UPDATE variant_warehouse_stock SET qty=qty+99 WHERE variant_id=? AND warehouse_id=?')
            .run(vid, WH_A);
        });
      } catch (_) { /* */ }
      return summary;
    };
    // re-require MA so it uses same module instance (already same)
    const c0 = changes();
    const ledBefore = q1('SELECT COUNT(*) AS n FROM inventory_ledger').n;
    const jeBefore = q1('SELECT COUNT(*) AS n FROM journal_entries').n;
    const r = await call('POST', '/api/inventory/adjust', {
      product_id: P, warehouse_id: WH_A, variant_id: V[1][0],
      mode: 'delta', qty: 1, reason_code: 'surplus', date: D, note: 'case11',
    });
    cache.rebuildStockCache = orig;
    ok(r.status === 409 && r.body && r.body.code === 'E_STOCK_CACHE_DIVERGED',
      'case11 409 E_STOCK_CACHE_DIVERGED', r.body);
    ok(q1('SELECT COUNT(*) AS n FROM inventory_ledger').n === ledBefore
      && q1('SELECT COUNT(*) AS n FROM journal_entries').n === jeBefore,
      'case11 rolled back ledger/JE', { ledBefore, je: jeBefore });
    // heal corruption from monkey-patch if any leaked (tx should have rolled back)
    cache.rebuildStockCache(db, P);
    assertMirror(P, 'case11 heal');
  }

  console.log('— 12. non-matrix product —');
  {
    const PP = insert('products', {
      user_id: ADMIN_ID, name: 'ساده', code: 'AVS-PLAIN', price: 1,
      average_cost_rial: UNIT, stock: 0, unit: 'عدد',
    });
    L.postInventoryMovement(db, {
      eventType: 'opening', productId: PP, warehouseId: WH_A,
      qtyIn: 5, unitCostRial: UNIT, sourceType: 'opening_stock_doc', sourceId: 1,
      date: D, createdBy: ADMIN_ID,
    });
    cache.rebuildStockCache(db, PP);
    const r1 = await call('POST', '/api/inventory/adjust', {
      product_id: PP, warehouse_id: WH_A, mode: 'count', qty: 3, reason_code: 'shortage', date: D,
    });
    ok(r1.status === 200 && ledWh(PP, WH_A) === 3, 'case12 count', r1.body);
    const r2 = await call('POST', '/api/inventory/adjust', {
      product_id: PP, warehouse_id: WH_A, mode: 'delta', qty: 2, reason_code: 'surplus', date: D,
    });
    ok(r2.status === 200 && ledWh(PP, WH_A) === 5, 'case12 delta', r2.body);
    ok(cache.assertVariantCellMirrorsLedger(db, { productId: PP, variantId: null, warehouseId: WH_A }) === true,
      'case12 assert no-op without variant');
  }

  // diagnostic route
  {
    const chk = await call('GET', `/api/inventory/variant-sync-check?product_id=${P}`);
    ok(chk.status === 200 && Array.isArray(chk.body.products) && chk.body.products[0],
      'variant-sync-check 200', chk.body);
  }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
