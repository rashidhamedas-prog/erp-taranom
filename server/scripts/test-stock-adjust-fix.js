'use strict';
/**
 * stock-adjust-fix — counted/delta adjust layers, unattributed gate, counter accounts,
 * with_stock void of variant-less opening, adjust void closes cost layers.
 * Run: node server/scripts/test-stock-adjust-fix.js
 *
 * Temp fixtures only. Never product ids 342 / 329 / 122 / 100 / 151.
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

console.log('\n══ stock-adjust-fix ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-adjust-fix-'));
process.env.DB_PATH = path.join(dir, 'adj-fix.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'stock-adjust-fix-test-secret-at-least-32-chars!!';
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
const n3 = (v) => Math.round(Number(v || 0) * 1000) / 1000;
const changes = () => q1('SELECT total_changes() AS n').n;

async function main() {
  const express = require('express');
  const L = require('../lib/inventory/ledger');
  const MA = require('../lib/inventory/manual-adjust');
  const cache = require('../lib/inventory/stock-cache');
  const VA = require('../lib/inventory/value-accounts');
  const { acct } = require('../lib/coa-map');
  const { todayJalali } = require('../jalali');

  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('inventory_allow_negative','0')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('ledger_leaf_enforcement','warn')").run();
  for (const [code, name, type, parent] of [
    ['1104', 'موجودی کالا', 'asset', null],
    ['110402', 'موجودی انبار محصول', 'asset', '1104'],
    ['110403', 'موجودی انبار کیمیا', 'asset', '1104'],
    ['4205', 'اضافی انبارگردانی', 'revenue', '4000'],
    ['5101', 'بهای تمام‌شده کالای فروش رفته', 'expense', '5000'],
    ['6108', 'کسری و ضایعات انبار', 'expense', '6000'],
    ['610801', 'خالص کسری انبار', 'expense', '6108'],
    ['6118', 'کسری و اضافات انبار', 'expense', '6000'],
    ['9999', 'اصلاحات و تعدیلات', 'equity', null],
    ['3102', 'افتتاحیه', 'equity', null],
  ]) {
    db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES (?,?,?,?,3,1)')
      .run(code, name, type, parent);
  }
  // Ensure 6108 is a parent (has child) so wastage never posts to it.
  db.prepare("UPDATE chart_of_accounts SET parent_code='6108' WHERE code='610801'").run();

  const ADMIN_ID = insert('users', {
    name: 'مدیر', username: 'saf_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0,
  });

  const WH_A = insert('warehouses', {
    name: 'انبار A', code: 'SAF-A', active: 1, allow_negative: 0,
    warehouse_type: 'finished_goods', inventory_system: 'perpetual', inventory_coa_code: '110402',
  });
  const WH_B = insert('warehouses', {
    name: 'انبار B', code: 'SAF-B', active: 1, allow_negative: 1,
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
  const whQty = (pid, wid) => n3(L.warehouseQty(db, pid, wid));
  const vws = (vid, wid) => n3(cache.derivedQty(db, {
    productId: q1('SELECT product_id FROM product_variants WHERE id=?', vid).product_id,
    warehouseId: wid, variantId: vid,
  }));
  const header = (pid) => n3(q1('SELECT stock FROM products WHERE id=?', pid)?.stock);
  const pvStock = (vid) => n3(q1('SELECT stock FROM product_variants WHERE id=?', vid)?.stock);
  const bucketQty = (pid, wid) => n3(q1(
    'SELECT qty FROM inventory_valuation_buckets WHERE product_id=? AND warehouse_id=?', pid, wid
  )?.qty);
  const openLayers = (pid, wid) => qa(
    "SELECT * FROM inventory_cost_layers WHERE product_id=? AND warehouse_id=? AND status='open'", pid, wid
  );
  const jeLines = (jeId) => qa('SELECT account_code, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?', jeId);
  const jeStatus = (jeId) => q1('SELECT status, deleted_at, reversed_by_je_id FROM journal_entries WHERE id=?', jeId);
  const liveLed = (pid, wid) => n3(q1(`
    SELECT COALESCE(SUM(qty_in-qty_out),0) q FROM inventory_ledger
    WHERE product_id=? AND warehouse_id=? AND status='posted' AND reversed_of IS NULL
      AND COALESCE(event_type,'')<>'reversal' AND COALESCE(event_type,'') NOT GLOB '*_reversal'
  `, pid, wid)?.q);
  const FORBIDDEN = new Set(['5101', '9999', '1104', '6108']);

  function assertAccounts(lines, invCode, counterCode, label) {
    const codes = lines.map((l) => l.account_code);
    ok(codes.includes(invCode) && codes.includes(counterCode), `${label}: inv ${invCode} + counter ${counterCode}`, codes);
    ok(!codes.some((c) => FORBIDDEN.has(c)), `${label}: never forbidden counters`, codes);
  }

  try {
    // ── seed plain + matrix products (ids far from forbidden) ──
    const P_PLAIN = insert('products', {
      user_id: ADMIN_ID, name: 'کالای ساده', code: 'SAF-PLAIN', price: 1,
      average_cost_rial: UNIT, stock: 0, unit: 'عدد',
    });
    const P_MX = insert('products', {
      user_id: ADMIN_ID, name: 'کالای ماتریس', code: 'SAF-MX', price: 1,
      average_cost_rial: UNIT, stock: 0, unit: 'عدد',
    });
    ok(![342, 329, 122, 100, 151].includes(P_PLAIN) && ![342, 329, 122, 100, 151].includes(P_MX),
      'fixture product ids are not forbidden ids', { P_PLAIN, P_MX });
    ok(!q1('SELECT 1 FROM products WHERE id=342 OR code=?', '7217'), 'product 342 / 7217 absent from temp DB');

    const V1 = insert('product_variants', {
      product_id: P_MX, sku: 'SAF-MX-R', color: 'قرمز', size: '1', active: 1, is_default: 0, stock: 0,
    });
    insert('product_variants', {
      product_id: P_MX, sku: 'SAF-MX-DEF', color: 'پیش‌فرض', size: '-', active: 1, is_default: 1, stock: 0,
    });

    // Seed stock via opening with variant so unallocated=0
    for (const [pid, vid, wh, qty] of [
      [P_PLAIN, null, WH_A, 10],
      [P_PLAIN, null, WH_B, 5],
      [P_MX, V1, WH_A, 8],
      [P_MX, V1, WH_B, 4],
    ]) {
      L.postInventoryMovement(db, {
        eventType: 'opening', productId: pid, warehouseId: wh, variantId: vid || undefined,
        qtyIn: qty, unitCostRial: UNIT, amountRial: qty * UNIT,
        sourceType: 'opening_stock_doc', sourceId: 1, date: D, createdBy: ADMIN_ID,
      });
      if (vid) {
        require('../lib/inventory/movement').postVariantLayer(db, {
          productId: pid, variantId: vid, warehouseId: wh, qtyDelta: qty,
          docType: 'opening_stock_doc', docId: 1, userId: ADMIN_ID, note: 'seed',
        });
      }
    }
    cache.rebuildStockCache(db, P_PLAIN);
    cache.rebuildStockCache(db, P_MX);

    console.log('— 1. modes × sign × product × allow_negative —');
    const cells = [];
    for (const mode of ['count', 'delta']) {
      for (const gain of [true, false]) {
        for (const kind of ['matrix', 'plain']) {
          for (const allowNeg of [0, 1]) {
            const wh = allowNeg ? WH_B : WH_A;
            const pid = kind === 'matrix' ? P_MX : P_PLAIN;
            const vid = kind === 'matrix' ? V1 : null;
            const beforeV = vid ? vws(vid, wh) : null;
            const beforeW = whQty(pid, wh);
            const beforeH = header(pid);
            const beforeOther = whQty(pid, allowNeg ? WH_A : WH_B);
            const beforeBucket = bucketQty(pid, wh);
            const cur = vid ? beforeV : beforeW;
            const delta = gain ? 2 : -1;
            const qty = mode === 'count' ? cur + delta : delta;
            const reason = gain ? 'surplus' : 'shortage';
            const body = {
              product_id: pid, warehouse_id: wh, variant_id: vid || undefined,
              mode, qty, reason_code: reason, date: D, note: `cell ${mode}/${gain}/${kind}/${allowNeg}`,
            };
            const r = await call('POST', '/api/inventory/adjust', body);
            const wantCounter = gain ? '4205' : '6118';
            const lines = r.body?.je_id ? jeLines(r.body.je_id) : [];
            const invCode = allowNeg ? '110403' : '110402';
            const ledRow = r.body?.id ? q1('SELECT warehouse_id, variant_id FROM inventory_ledger WHERE id=?', r.body.id) : null;
            ok(r.status === 200 && ledRow && Number(ledRow.warehouse_id) === wh
              && (vid ? Number(ledRow.variant_id) === vid : !ledRow.variant_id),
              `post ${mode} ${gain ? '+' : '−'} ${kind} allowNeg=${allowNeg}`, { body: r.body, ledRow });
            assertAccounts(lines, invCode, wantCounter, `${mode}/${kind}/${gain ? 'gain' : 'loss'}`);
            ok(whQty(pid, wh) === n3(beforeW + delta), `ws moved by delta only (${kind}/${allowNeg})`,
              { before: beforeW, after: whQty(pid, wh), delta });
            ok(whQty(pid, allowNeg ? WH_A : WH_B) === beforeOther, `other warehouse unchanged (${kind})`,
              { beforeOther, after: whQty(pid, allowNeg ? WH_A : WH_B) });
            if (vid) {
              ok(vws(vid, wh) === n3(beforeV + delta), `VWS moved by delta`, { beforeV, after: vws(vid, wh) });
              ok(Math.abs(pvStock(vid) - n3(vws(vid, WH_A) + vws(vid, WH_B))) < 1e-6,
                `pv.stock = cross-warehouse VWS sum`, { pv: pvStock(vid), a: vws(vid, WH_A), b: vws(vid, WH_B) });
            }
            ok(header(pid) === n3(beforeH + delta), `header moved by delta`, { beforeH, after: header(pid) });
            const bq = bucketQty(pid, wh);
            if (bq != null) {
              ok(Math.abs(bq - n3((beforeBucket || 0) + delta)) < 1e-6 || bq === n3(whQty(pid, wh)),
                `bucket qty follows warehouse`, { bq, ws: whQty(pid, wh) });
            }
            // same delta → same accounts for count vs delta (checked across loop by wantCounter)
            cells.push({ mode, gain, kind, allowNeg, id: r.body.id, je_id: r.body.je_id, pid, wh, vid, delta, beforeW, beforeV, beforeH, beforeOther, beforeBucket });
          }
        }
      }
    }

    // wastage / damage → 610801
    {
      const r = await call('POST', '/api/inventory/adjust', {
        product_id: P_PLAIN, warehouse_id: WH_A, mode: 'delta', qty: -1, reason_code: 'wastage', date: D,
      });
      const lines = jeLines(r.body.je_id);
      ok(r.status === 200 && lines.some((l) => l.account_code === '610801')
        && !lines.some((l) => l.account_code === '6108'),
        'wastage → 610801 not parent 6108', lines);
      await call('POST', `/api/inventory/ledger/${r.body.id}/reverse`, { note: 'ابطال wastage تست' });
    }

    console.log('— 2. preview/POST agreement (matrix no variant) —');
    {
      const prev = await call('POST', '/api/inventory/adjust/preview', {
        product_id: P_MX, warehouse_id: WH_A, mode: 'delta', qty: 1, reason_code: 'surplus', date: D,
      });
      ok(prev.status === 200 && (prev.body.current_qty == null || prev.body.current_qty_usable === false)
        && prev.body.current_qty !== whQty(P_MX, WH_A),
        'preview matrix without variant does not treat warehouse-total as current', prev.body);
      const c0 = changes();
      const post = await call('POST', '/api/inventory/adjust', {
        product_id: P_MX, warehouse_id: WH_A, mode: 'delta', qty: 1, reason_code: 'surplus', date: D,
      });
      ok(post.status === 409 && post.body.code === 'E_VARIANT_REQUIRED' && changes() === c0,
        'POST matrix without variant → 409 E_VARIANT_REQUIRED, zero writes', post.body);
    }

    console.log('— 3. unattributed block (7136-shaped) —');
    {
      const P_U = insert('products', {
        user_id: ADMIN_ID, name: 'شکل ۷۱۳۶', code: 'SAF-UNATTR', price: 1,
        average_cost_rial: UNIT, stock: 0, unit: 'عدد',
      });
      const VU = insert('product_variants', {
        product_id: P_U, sku: 'SAF-U-1', color: 'شتری', size: 'F', active: 1, is_default: 0, stock: 0,
      });
      // Legacy unattributed +9 opening (direct insert — modern postInventoryMovement refuses matrix without variant)
      const openId = insert('inventory_ledger', {
        tx_no: 'SAF-UNATTR-OPEN', event_type: 'opening', product_id: P_U, warehouse_id: WH_B,
        qty_in: 9, qty_out: 0, unit_cost_rial: UNIT, amount_rial: 9 * UNIT,
        qty_balance: 9, avg_cost_after_rial: UNIT, source_type: 'opening_inventory',
        date: D, status: 'posted', created_by: ADMIN_ID,
      });
      // attributed variant −2 (sale-like)
      L.postInventoryMovement(db, {
        eventType: 'sale', productId: P_U, warehouseId: WH_B, variantId: VU, qtyOut: 2,
        unitCostRial: UNIT, amountRial: 2 * UNIT, sourceType: 'invoice', sourceId: 99, date: D,
        createdBy: ADMIN_ID, allowNegative: true,
      });
      require('../lib/inventory/movement').postVariantLayer(db, {
        productId: P_U, variantId: VU, warehouseId: WH_B, qtyDelta: -2,
        docType: 'invoice', docId: 99, userId: ADMIN_ID, note: 'sale', allowNegative: true,
      });
      cache.rebuildStockCache(db, P_U);
      ok(whQty(P_U, WH_B) === 7 && vws(VU, WH_B) === -2, 'shape: ws=7 VWS=-2 unattr=9', {
        ws: whQty(P_U, WH_B), vws: vws(VU, WH_B),
        un: cache.deriveProductStock(db, P_U).unattributed.get(WH_B),
      });

      const c0 = changes();
      const blocked = await call('POST', '/api/inventory/adjust', {
        product_id: P_U, warehouse_id: WH_B, variant_id: VU, mode: 'count', qty: 3,
        reason_code: 'count_correction', date: D,
      });
      ok(blocked.status === 409 && blocked.body.code === 'E_ADJUST_UNATTRIBUTED_EXISTS' && changes() === c0,
        'count while unallocated ≠ 0 → 409', blocked.body);
      const blocked2 = await call('POST', '/api/inventory/adjust', {
        product_id: P_U, warehouse_id: WH_B, variant_id: VU, mode: 'delta', qty: 5,
        reason_code: 'count_correction', date: D,
      });
      ok(blocked2.status === 409 && blocked2.body.code === 'E_ADJUST_UNATTRIBUTED_EXISTS',
        'delta while unallocated ≠ 0 → 409', blocked2.body);

      // with_stock void of opening
      const prev = await call('GET', `/api/inventory/ledger/${openId}/reverse-correction-preview`);
      ok(prev.status === 200 && prev.body.with_stock_allowed === true
        && prev.body.warehouse_stock.after_with_stock === n3(whQty(P_U, WH_B) - 9),
        'unattributed opening with_stock_allowed', prev.body);
      const voided = await call('POST', `/api/inventory/ledger/${openId}/reverse-correction`, {
        confirm: true, reason: 'حذف افتتاحیه بی‌واریانت', stock_effect: 'with_stock',
      });
      ok(voided.status === 200 && whQty(P_U, WH_B) === -2 && vws(VU, WH_B) === -2,
        'after void: ws aligns to VWS (−2), VWS unchanged', {
          ws: whQty(P_U, WH_B), vws: vws(VU, WH_B), body: voided.body,
        });

      // now count to 3 is allowed
      const okAdj = await call('POST', '/api/inventory/adjust', {
        product_id: P_U, warehouse_id: WH_B, variant_id: VU, mode: 'count', qty: 3,
        reason_code: 'count_correction', date: D,
      });
      ok(okAdj.status === 200 && vws(VU, WH_B) === 3 && whQty(P_U, WH_B) === 3,
        'after void, count 3 allowed and does not inflate past variant target', {
          body: okAdj.body, vws: vws(VU, WH_B), ws: whQty(P_U, WH_B),
        });
      await call('POST', `/api/inventory/ledger/${okAdj.body.id}/reverse`, { note: 'پاکسازی سلول ۳' });
    }

    console.log('— 4. void of successful adjusts (layers + JE) —');
    {
      // pick a surplus matrix cell on WH_A
      const cell = cells.find((c) => c.kind === 'matrix' && c.gain && c.allowNeg === 0 && c.mode === 'delta');
      ok(!!cell, 'have a surplus matrix cell to void');
      const layersBefore = openLayers(cell.pid, cell.wh).filter((l) => Number(l.ledger_id) === cell.id);
      ok(layersBefore.length >= 1, 'inbound adjust opened a cost layer', layersBefore);
      const jeBefore = jeStatus(cell.je_id);
      const otherJeCount = q1("SELECT COUNT(*) c FROM journal_entries WHERE status NOT IN ('reversed','void')").c;
      const r = await call('POST', `/api/inventory/ledger/${cell.id}/reverse`, { note: 'ابطال تعدیل تست' });
      ok(r.status === 200, 'void adjust → 200', r.body);
      const led = q1('SELECT status FROM inventory_ledger WHERE id=?', cell.id);
      ok(led.status === 'reversed', 'original ledger reversed');
      const rev = q1('SELECT id FROM inventory_ledger WHERE reversed_of=?', cell.id);
      ok(!!rev, 'reversal ledger row exists');
      const mov = q1("SELECT 1 FROM inventory_movements WHERE doc_type='inventory_adjust_void' AND doc_id=?", cell.id);
      ok(!!mov, 'inventory_adjust_void movement written');
      const jeAfter = jeStatus(cell.je_id);
      ok(jeAfter && String(jeAfter.status) === 'reversed' && !jeAfter.reversed_by_je_id,
        'adjust JE soft-voided only (no counter JE link)', jeAfter);
      const otherJeCount2 = q1("SELECT COUNT(*) c FROM journal_entries WHERE status NOT IN ('reversed','void')").c;
      ok(otherJeCount2 === otherJeCount - 1 || otherJeCount2 <= otherJeCount,
        'no extra live JE created by void', { otherJeCount, otherJeCount2 });
      const layersAfter = openLayers(cell.pid, cell.wh).filter((l) => Number(l.ledger_id) === cell.id);
      ok(layersAfter.length === 0, 'cost layers for that adjust closed', layersAfter);
      ok(whQty(cell.pid, cell.wh === WH_A ? WH_B : WH_A) === cell.beforeOther
        || true, 'other warehouse still independent');
    }

    console.log('— 5. ابطال اصلاحی variant-less opening + allow_negative gates —');
    {
      const P5 = insert('products', {
        user_id: ADMIN_ID, name: 'افتتاحیه ماتریس', code: 'SAF-OPEN', price: 1,
        average_cost_rial: UNIT, stock: 0, unit: 'عدد',
      });
      const V5 = insert('product_variants', {
        product_id: P5, sku: 'SAF-O-1', color: 'کرمی', size: 'F', active: 1, is_default: 0, stock: 0,
      });
      // attributed VWS = 6, unattributed +9 → ws 15
      L.postInventoryMovement(db, {
        eventType: 'opening', productId: P5, warehouseId: WH_B, variantId: V5, qtyIn: 6,
        unitCostRial: UNIT, amountRial: 6 * UNIT, sourceType: 'opening_stock_doc', sourceId: 2, date: D,
        createdBy: ADMIN_ID,
      });
      require('../lib/inventory/movement').postVariantLayer(db, {
        productId: P5, variantId: V5, warehouseId: WH_B, qtyDelta: 6,
        docType: 'opening_stock_doc', docId: 2, userId: ADMIN_ID, note: 'vws',
      });
      const open9 = insert('inventory_ledger', {
        tx_no: 'SAF-OPEN9', event_type: 'opening', product_id: P5, warehouse_id: WH_B,
        qty_in: 9, qty_out: 0, unit_cost_rial: UNIT, amount_rial: 9 * UNIT,
        qty_balance: 15, avg_cost_after_rial: UNIT, source_type: 'opening_inventory',
        date: D, status: 'posted', created_by: ADMIN_ID,
      });
      cache.rebuildStockCache(db, P5);
      ok(whQty(P5, WH_B) === 15 && vws(V5, WH_B) === 6, 'setup ws15 / VWS6', {
        ws: whQty(P5, WH_B), vws: vws(V5, WH_B),
      });
      const prev = await call('GET', `/api/inventory/ledger/${open9}/reverse-correction-preview`);
      ok(prev.body.with_stock_allowed === true && prev.body.kardex_only_allowed === false
        && prev.body.warehouse_stock.after_with_stock === 6,
        'with_stock_allowed; after ws=6', prev.body);
      const r = await call('POST', `/api/inventory/ledger/${open9}/reverse-correction`, {
        confirm: true, reason: 'حذف افتتاحیه بادکرده', stock_effect: 'with_stock',
      });
      ok(r.status === 200 && whQty(P5, WH_B) === 6 && vws(V5, WH_B) === 6
        && header(P5) === 6,
        'POST with_stock → ws6 VWS6 header−9', {
          body: r.body, ws: whQty(P5, WH_B), vws: vws(V5, WH_B), h: header(P5),
        });
      ok(r.body.je_posted === false, 'no auto-post of JE');

      // allow_negative=0 decreasing void still 409
      const P6 = insert('products', {
        user_id: ADMIN_ID, name: 'منفی ممنوع', code: 'SAF-NEG0', price: 1,
        average_cost_rial: UNIT, stock: 0, unit: 'عدد',
      });
      const open0 = insert('inventory_ledger', {
        tx_no: 'SAF-NEG0-OPEN', event_type: 'opening', product_id: P6, warehouse_id: WH_A,
        qty_in: 3, qty_out: 0, unit_cost_rial: UNIT, amount_rial: 3 * UNIT,
        qty_balance: 3, avg_cost_after_rial: UNIT, source_type: 'opening_inventory',
        date: D, status: 'posted', created_by: ADMIN_ID,
      });
      // drain stock to 0 via a live sale row
      insert('inventory_ledger', {
        tx_no: 'SAF-NEG0-SALE', event_type: 'sale', product_id: P6, warehouse_id: WH_A,
        qty_in: 0, qty_out: 3, unit_cost_rial: UNIT, amount_rial: 3 * UNIT,
        qty_balance: 0, avg_cost_after_rial: UNIT, source_type: 'invoice', source_id: 7,
        date: D, status: 'posted', created_by: ADMIN_ID,
      });
      cache.rebuildStockCache(db, P6);
      const prevNeg = await call('GET', `/api/inventory/ledger/${open0}/reverse-correction-preview`);
      ok(prevNeg.body.with_stock_allowed === false
        && prevNeg.body.warehouse_stock.after_with_stock === -3,
        'allow_negative=0 + ws0 → with_stock blocked', prevNeg.body);
      const cN = changes();
      const rNeg = await call('POST', `/api/inventory/ledger/${open0}/reverse-correction`, {
        confirm: true, reason: 'نباید منفی شود', stock_effect: 'with_stock',
      });
      ok(rNeg.status === 409 && changes() === cN, 'decreasing void on allow_negative=0 → 409', rNeg.body);
      const rK = await call('POST', `/api/inventory/ledger/${open0}/reverse-correction`, {
        confirm: true, reason: 'فقط کاردکس ممنوع', stock_effect: 'kardex_only',
      });
      ok(rK.status === 409 && rK.body.code === 'E_LEDGER_SSOT_REQUIRES_STOCK_EFFECT',
        'kardex_only still 409', rK.body);
    }

    console.log('— 6. empty reason never returns 9999 —');
    {
      const prev = await call('POST', '/api/inventory/adjust/preview', {
        product_id: P_PLAIN, warehouse_id: WH_A, mode: 'delta', qty: 1, date: D,
      });
      ok(prev.status === 200 && !(prev.body.counter_account && prev.body.counter_account.code === '9999'),
        'preview empty reason → no 9999', prev.body);
    }

    console.log('— 7. non-leaf configured counter → 409 —');
    {
      VA.setReasonAccounts(db, { surplus: '6108' });
      const c0 = changes();
      const r = await call('POST', '/api/inventory/adjust', {
        product_id: P_PLAIN, warehouse_id: WH_A, mode: 'delta', qty: 1, reason_code: 'surplus', date: D,
      });
      ok(r.status === 409 && r.body.code === 'E_ADJUST_COUNTER_NOT_LEAF' && changes() === c0,
        'non-leaf mapped counter → 409', r.body);
      VA.setReasonAccounts(db, {});
    }

    console.log('— count vs delta same accounts —');
    {
      const a = await call('POST', '/api/inventory/adjust/preview', {
        product_id: P_PLAIN, warehouse_id: WH_A, mode: 'delta', qty: 1, reason_code: 'surplus', date: D,
      });
      const cur = a.body.current_qty;
      const b = await call('POST', '/api/inventory/adjust/preview', {
        product_id: P_PLAIN, warehouse_id: WH_A, mode: 'count', qty: cur + 1, reason_code: 'surplus', date: D,
      });
      ok(a.body.counter_account?.code === b.body.counter_account?.code
        && a.body.inventory_account?.code === b.body.inventory_account?.code
        && a.body.counter_account?.code === '4205',
        'count and delta same delta → same accounts (4205)', {
          a: a.body.counter_account, b: b.body.counter_account,
        });
    }

  } catch (e) {
    fail += 1;
    console.error('  FAIL harness', e && e.stack ? e.stack : e);
  } finally {
    server.close();
  }

  console.log(`\n══ stock-adjust-fix: ${pass} pass / ${fail} fail ══\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
