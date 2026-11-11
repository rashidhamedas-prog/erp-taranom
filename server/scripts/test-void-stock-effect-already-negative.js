'use strict';
/**
 * void-stock-effect-fix — with_stock gate when warehouse is already negative.
 * Run: node server/scripts/test-void-stock-effect-already-negative.js
 *
 * Temp fixtures only. Never product ids 122 / 100 / 151 / 342.
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

console.log('\n══ void-stock-effect — already-negative OUT void ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'void-stock-fx-'));
process.env.DB_PATH = path.join(dir, 'void-stock.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'void-stock-effect-already-negative-secret!!';
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
const changes = () => q1('SELECT total_changes() AS n').n;

const ADMIN_ID = insert('users', {
  name: 'مدیر تست', username: 'void_stock_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0,
});

const authMw = require('../middleware/auth');
authMw.auth = (req, _res, next) => {
  const u = q1('SELECT id, role, name, username FROM users WHERE id=?', ADMIN_ID);
  req.user = { id: u.id, role: u.role, name: u.name, username: u.username };
  next();
};

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/inventory', require('../routes/inventory'));

const L = require('../lib/inventory/ledger');
const cache = require('../lib/inventory/stock-cache');
const D = '1405/07/19';

function liveKardex(pid, wid) {
  const r = q1(`SELECT COALESCE(SUM(qty_in-qty_out),0) q
    FROM inventory_ledger WHERE product_id=? AND warehouse_id=? AND status='posted' AND reversed_of IS NULL
      AND COALESCE(event_type,'')<>'reversal' AND COALESCE(event_type,'') NOT GLOB '*_reversal'`, pid, wid);
  return Math.round((Number(r && r.q) || 0) * 1000) / 1000;
}
function vws(vid, wid) {
  return cache.derivedQty(db, {
    productId: q1('SELECT product_id FROM product_variants WHERE id=?', vid).product_id,
    warehouseId: wid,
    variantId: vid,
  });
}

async function main() {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-user': String(ADMIN_ID) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch (_) { json = null; }
    return { status: res.status, body: json };
  };

  try {
    db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('ledger_leaf_enforcement','warn')").run();
    db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('inventory_allow_negative','0')").run();
    db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES ('1104','موجودی کالا','asset',NULL,2,1)").run();
    db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES ('110499','موجودی تست void','asset','1104',3,1)").run();
    db.prepare("INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level,is_active) VALUES ('3102','افتتاحیه','equity',NULL,3,1)").run();

    const WH = insert('warehouses', {
      name: 'انبار تست void-stock', code: 'WH-VOID-FX', active: 1, allow_negative: 0,
      warehouse_type: 'finished_goods', inventory_system: 'perpetual', inventory_coa_code: '110499',
    });
    const WH_NEG = insert('warehouses', {
      name: 'انبار منفی مجاز', code: 'WH-VOID-NEG', active: 1, allow_negative: 1,
      warehouse_type: 'finished_goods', inventory_system: 'perpetual', inventory_coa_code: '110499',
    });
    const P = insert('products', {
      user_id: ADMIN_ID, name: 'کالای تست void-stock', code: 'VOID-FX-1', price: 1,
      average_cost_rial: 1000000, stock: 0, unit: 'عدد',
    });
    const V1 = insert('product_variants', {
      product_id: P, sku: 'VOID-FX-1-A', color: 'سفید', size: '1', active: 1, is_default: 0, stock: 0,
    });
    const V2 = insert('product_variants', {
      product_id: P, sku: 'VOID-FX-1-B', color: 'سفید', size: '2', active: 1, is_default: 0, stock: 0,
    });

    ok(!q1('SELECT id FROM products WHERE id IN (122,100,151,342) OR code IN (\'7217\',\'7132\')'),
      'fixture DB has no product 122/100/151/342');

    // Shape like INV-4091/4092: attributed +1/+1, unattributed sale −2, then two attributed OUT 1.
    L.postInventoryMovement(db, {
      eventType: 'transfer_in', productId: P, warehouseId: WH, variantId: V1, qtyIn: 1, amountRial: 1000000,
      sourceType: 'warehouse_transfer', sourceId: 9001, date: D, skipStock: true, createdBy: ADMIN_ID,
    });
    L.postInventoryMovement(db, {
      eventType: 'transfer_in', productId: P, warehouseId: WH, variantId: V2, qtyIn: 1, amountRial: 1000000,
      sourceType: 'warehouse_transfer', sourceId: 9002, date: D, skipStock: true, createdBy: ADMIN_ID,
    });
    // Unattributed sale (legacy shape): postInventoryMovement refuses matrix without variant_id,
    // so insert the live ledger row directly — same as production INV rebuilds without attribution.
    insert('inventory_ledger', {
      tx_no: 'VOID-FX-SALE', event_type: 'sale', product_id: P, warehouse_id: WH,
      qty_in: 0, qty_out: 2, unit_cost_rial: 1000000, amount_rial: 2000000,
      qty_balance: 0, avg_cost_after_rial: 1000000, source_type: 'invoice', source_id: 9003,
      date: D, status: 'posted', created_by: ADMIN_ID,
    });
    const out1 = L.postInventoryMovement(db, {
      eventType: 'adjustment', productId: P, warehouseId: WH, variantId: V1, qtyOut: 1, amountRial: 4909063,
      sourceType: 'stock_reconcile', date: D, note: 'هم‌ترازی تست OUT1', skipStock: true, createdBy: ADMIN_ID,
    });
    const out2 = L.postInventoryMovement(db, {
      eventType: 'adjustment', productId: P, warehouseId: WH, variantId: V2, qtyOut: 1, amountRial: 4909063,
      sourceType: 'stock_reconcile', date: D, note: 'هم‌ترازی تست OUT2', skipStock: true, createdBy: ADMIN_ID,
    });
    const jeId = insert('journal_entries', {
      entry_date: D, description: 'JE هم‌ترازی مشترک تست', ref_type: 'stock_reconcile',
      ref_id: out1.id, created_by: ADMIN_ID, status: 'approved', deleted_at: 0,
    });
    insert('journal_lines', {
      entry_id: jeId, account_code: '3102', account_name: 'افتتاحیه',
      debit: 981812.6, credit: 0, debit_rial: 9818126, credit_rial: 0, line_no: 1,
    });
    insert('journal_lines', {
      entry_id: jeId, account_code: '110499', account_name: 'موجودی تست void',
      debit: 0, credit: 981812.6, debit_rial: 0, credit_rial: 9818126, line_no: 2,
    });
    db.prepare('UPDATE inventory_ledger SET je_id=? WHERE id IN (?,?)').run(jeId, out1.id, out2.id);
    cache.rebuildStockCache(db, P);

    ok(liveKardex(P, WH) === -2 && vws(V1, WH) === 0 && vws(V2, WH) === 0,
      'fixture: product WH −2, V1/V2 layers 0', { k: liveKardex(P, WH), v1: vws(V1, WH), v2: vws(V2, WH) });

    console.log('— (1) OUT void on already-negative warehouse: preview + POST —');
    {
      const prev = await call('GET', `/api/inventory/ledger/${out1.id}/reverse-correction-preview?stock_effect=with_stock`);
      const b = prev.body || {};
      const warns = b.warnings || [];
      ok(prev.status === 200 && b.qty_delta === 1
        && b.warehouse_stock.after_with_stock === -1
        && b.variant_warehouse_stock && b.variant_warehouse_stock.after_with_stock === 1
        && b.with_stock_allowed === true,
        'preview: qty_delta +1, after_with −1 / variant 1, with_stock_allowed', b);
      ok(!warns.some((w) => /منفی می‌شود/.test(w) || /رنگ‌سایز 1/.test(w)),
        'preview: no false negativity warning (and no positive variant-as-shortage)', warns);
      ok(b.kardex_only_allowed === false, 'preview: kardex_only_allowed=false');

      const otherIds = db.prepare('SELECT id FROM products WHERE id<>?').all(P).map((r) => r.id);
      const otherStock0 = Object.fromEntries(otherIds.map((id) => [id, Number(q1('SELECT stock FROM products WHERE id=?', id).stock)]));

      const r = await call('POST', `/api/inventory/ledger/${out1.id}/reverse-correction`, {
        reason: 'ابطال OUT روی انبار از قبل منفی', confirm: true, stock_effect: 'with_stock',
      });
      ok(r.status === 200 && r.body.ok === true && r.body.qty_delta === 1, 'POST with_stock OUT1 ⇒ 200', r.body);
      ok(liveKardex(P, WH) === -1 && vws(V1, WH) === 1, 'after OUT1 void: product −1, V1=1', {
        k: liveKardex(P, WH), v1: vws(V1, WH),
      });
      ok(q1('SELECT status FROM inventory_ledger WHERE id=?', out1.id).status === 'reversed'
        && q1('SELECT id FROM inventory_ledger WHERE reversed_of=?', out1.id),
        'OUT1 reversed + one reversal row');
      const draft1 = Number(r.body.voucher_draft_id);
      ok(draft1 > 0, 'first void created one reversing draft', r.body);
      for (const id of otherIds) {
        ok(Number(q1('SELECT stock FROM products WHERE id=?', id).stock) === otherStock0[id],
          `other product ${id} stock untouched`);
      }
      ok(!q1('SELECT id FROM products WHERE id=342 OR code=?', '7217'), 'product 342 still absent after POST');

      console.log('— (2) sibling OUT void → product 0; same JE ⇒ one draft —');
      const drafts0 = q1('SELECT COUNT(*) c FROM voucher_drafts').c;
      const prev2 = await call('GET', `/api/inventory/ledger/${out2.id}/reverse-correction-preview`);
      ok(prev2.status === 200 && prev2.body.with_stock_allowed === true
        && prev2.body.warehouse_stock.after_with_stock === 0
        && prev2.body.voucher_draft && prev2.body.voucher_draft.will_create === false
        && Number(prev2.body.voucher_draft.reuse_draft_id) === draft1,
        'preview OUT2: allowed, after 0, reuses draft', prev2.body && prev2.body.voucher_draft);
      const r2 = await call('POST', `/api/inventory/ledger/${out2.id}/reverse-correction`, {
        reason: 'ابطال OUT دوم روی همان انبار', confirm: true, stock_effect: 'with_stock',
      });
      ok(r2.status === 200 && liveKardex(P, WH) === 0 && vws(V2, WH) === 1, 'OUT2 void ⇒ product 0, V2=1', {
        body: r2.body, k: liveKardex(P, WH), v2: vws(V2, WH),
      });
      ok(Number(r2.body.voucher_draft_id) === draft1
        && q1('SELECT COUNT(*) c FROM voucher_drafts').c === drafts0,
        'second void reuses same draft; no second draft', { draft: r2.body.voucher_draft_id, drafts: drafts0 });
    }

    console.log('— (3) IN void 2→−3 still blocked —');
    {
      const P3 = insert('products', {
        user_id: ADMIN_ID, name: 'کالای IN-neg', code: 'VOID-FX-IN', price: 1, average_cost_rial: 0, stock: 0, unit: 'عدد',
      });
      const led = L.postInventoryMovement(db, {
        eventType: 'opening', productId: P3, warehouseId: WH, qtyIn: 5, amountRial: 500000,
        sourceType: 'opening_inventory', date: D, skipStock: true, createdBy: ADMIN_ID,
      });
      L.postInventoryMovement(db, {
        eventType: 'sale', productId: P3, warehouseId: WH, qtyOut: 3, amountRial: 300000,
        sourceType: 'invoice', sourceId: 9100, date: D, skipStock: true, createdBy: ADMIN_ID,
      });
      cache.rebuildStockCache(db, P3);
      ok(liveKardex(P3, WH) === 2, 'IN-neg fixture on-hand 2');
      const prev = await call('GET', `/api/inventory/ledger/${led.id}/reverse-correction-preview?stock_effect=with_stock`);
      const warns = (prev.body && prev.body.warnings) || [];
      ok(prev.status === 200 && prev.body.with_stock_allowed === false
        && prev.body.warehouse_stock.after_with_stock === -3, 'preview IN void blocked 2→−3', prev.body);
      ok(warns.some((w) => /منفی می‌شود/.test(w) && /انبار -3/.test(w))
        && !warns.some((w) => /رنگ‌سایز/.test(w) && !/رنگ‌سایز -/.test(w)),
        'blocked warning names warehouse shortage only', warns);
      const c0 = changes();
      const r = await call('POST', `/api/inventory/ledger/${led.id}/reverse-correction`, {
        reason: 'تست منفی‌شدن ورود', confirm: true, stock_effect: 'with_stock',
      });
      ok(r.status === 409 && r.body.code === 'E_REVERSE_STOCK_NEGATIVE' && changes() === c0
        && q1('SELECT status FROM inventory_ledger WHERE id=?', led.id).status === 'posted',
        'POST IN void ⇒ 409 E_REVERSE_STOCK_NEGATIVE, zero writes', r.body);
    }

    console.log('— (4) allow_negative=1: decreasing void may end negative —');
    {
      const P4 = insert('products', {
        user_id: ADMIN_ID, name: 'کالای allow-neg', code: 'VOID-FX-AN', price: 1, average_cost_rial: 0, stock: 0, unit: 'عدد',
      });
      const led = L.postInventoryMovement(db, {
        eventType: 'opening', productId: P4, warehouseId: WH_NEG, qtyIn: 5, amountRial: 500000,
        sourceType: 'opening_inventory', date: D, skipStock: true, createdBy: ADMIN_ID,
      });
      L.postInventoryMovement(db, {
        eventType: 'sale', productId: P4, warehouseId: WH_NEG, qtyOut: 3, amountRial: 300000,
        sourceType: 'invoice', sourceId: 9200, date: D, skipStock: true, createdBy: ADMIN_ID,
      });
      cache.rebuildStockCache(db, P4);
      const prev = await call('GET', `/api/inventory/ledger/${led.id}/reverse-correction-preview?stock_effect=with_stock`);
      ok(prev.status === 200 && prev.body.with_stock_allowed === true
        && prev.body.warehouse_stock.after_with_stock === -3, 'allow_negative=1: IN void preview allowed', prev.body);
      const r = await call('POST', `/api/inventory/ledger/${led.id}/reverse-correction`, {
        reason: 'ابطال ورود در انبار منفی‌مجاز', confirm: true, stock_effect: 'with_stock',
      });
      ok(r.status === 200 && liveKardex(P4, WH_NEG) === -3, 'allow_negative=1 POST ⇒ 200, on-hand −3', {
        status: r.status, k: liveKardex(P4, WH_NEG),
      });
    }

    console.log('— (5) kardex_only still SSOT-refused —');
    {
      const P5 = insert('products', {
        user_id: ADMIN_ID, name: 'کالای kardex_only', code: 'VOID-FX-KO', price: 1, average_cost_rial: 0, stock: 0, unit: 'عدد',
      });
      const led = L.postInventoryMovement(db, {
        eventType: 'adjustment', productId: P5, warehouseId: WH, qtyOut: 1, amountRial: 1000,
        sourceType: 'stock_reconcile', date: D, skipStock: true, createdBy: ADMIN_ID,
      });
      // Seed +1 so with_stock would be fine; we only assert kardex_only refusal.
      L.postInventoryMovement(db, {
        eventType: 'opening', productId: P5, warehouseId: WH, qtyIn: 2, amountRial: 2000,
        sourceType: 'opening_inventory', date: D, skipStock: true, createdBy: ADMIN_ID,
      });
      cache.rebuildStockCache(db, P5);
      const c0 = changes();
      const k = await call('POST', `/api/inventory/ledger/${led.id}/reverse-correction`, {
        reason: 'تست فقط کاردکس', confirm: true, stock_effect: 'kardex_only',
      });
      ok(k.status === 409 && k.body.code === 'E_LEDGER_SSOT_REQUIRES_STOCK_EFFECT' && changes() === c0,
        'kardex_only ⇒ 409 E_LEDGER_SSOT_REQUIRES_STOCK_EFFECT', k.body);
    }
  } catch (e) {
    fail += 1;
    console.log('  FAIL exception', e && e.stack);
  } finally {
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  try { db.close(); } catch (_) { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(fail ? 1 : 0);
}

main();
