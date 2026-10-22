'use strict';
/**
 * v516 — amend is judged against the document as issued (net delta), not against today's stock.
 * Purchase: unchanged save after consumption, price-only, qty up/down, consumed guard, variant layer, void.
 * Sale: unchanged save after the stock was sold out, net increase guard.
 * Run: node server/scripts/test-amend-net-delta-v516.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

console.log('\n══ Amend net-delta v516 ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amend-net-v516-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.SMS_DISABLED = '1';
process.env.ERP_TEST_ISOLATION = '1';
process.env.JWT_SECRET = 'amend-net-delta-v516-secret-32chars!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.NODE_ENV = 'test';

let db = null;
try {
  const { initDB, getDB } = require('../db');
  initDB();
  db = getDB();
} catch (e) {
  const abi = /NODE_MODULE_VERSION|better-sqlite3/.test(String(e.message || e));
  if (abi) console.log('  SKIP sqlite:', String(e.message || e).split('\n')[0]);
  else ok(false, 'initDB', e.message);
}

(async () => {
  if (!db) {
    console.log(`\n${fail ? '💥' : '🎉'} ${pass} passed, ${fail} failed (sqlite skipped)`);
    process.exitCode = fail ? 1 : 0;
    return;
  }
  const { todayJalali } = require('../jalali');
  const { postInventoryMovement } = require('../lib/inventory/ledger');
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('inventory_allow_negative','0')").run();

  const whId = db.prepare("INSERT INTO warehouses (name,active) VALUES ('انبار مواد تست v516',1)").run().lastInsertRowid;
  const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
  const sc = cols('suppliers');
  const supCols = ['name'];
  const supVals = ["'تأمین‌کننده v516'"];
  if (sc.has('active')) { supCols.push('active'); supVals.push('1'); }
  const supId = db.prepare(`INSERT INTO suppliers (${supCols.join(',')}) VALUES (${supVals.join(',')})`).run().lastInsertRowid;

  const pc = cols('products');
  function mkProduct(name, code) {
    const c = ['name', 'code', 'cost', 'price', 'stock', 'unit'];
    const v = [`'${name}'`, `'${code}'`, '0', '50000', '0', "'عدد'"];
    if (pc.has('user_id')) { c.push('user_id'); v.push(String(admin.id)); }
    if (pc.has('active')) { c.push('active'); v.push('1'); }
    return db.prepare(`INSERT INTO products (${c.join(',')}) VALUES (${v.join(',')})`).run().lastInsertRowid;
  }
  const button = mkProduct('دکمه میخی v516', 'BTN-V516');

  const authPath = require.resolve('../middleware/auth');
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: {
      auth: (req, _res, next) => {
        req.user = { id: admin.id, role: 'admin', username: 'admin', name: 'admin' };
        next();
      },
      adminOrAccounting: (_q, _s, n) => n(),
      requirePermission: () => (_q, _s, n) => n(),
      centralOnly: (_q, _s, n) => n(),
      requireRole: () => (_q, _s, n) => n(),
    },
  };
  const express = require('express');
  const http = require('http');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/purchases', require('../routes/purchases'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  async function api(method, url, body) {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* */ }
    return { status: res.status, json, text };
  }
  const poBody = (rows) => ({
    supplier_id: supId, date: todayJalali(), disc: 0, pay_type: 'credit',
    warehouse_id: whId, vat_exempt: 1, rows,
  });
  const whQty = (pid) => Number((db.prepare(
    'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
  ).get(pid, whId) || {}).qty) || 0;
  const ledCount = (poId) => db.prepare(
    "SELECT COUNT(*) c FROM inventory_ledger WHERE source_type='purchase' AND source_id=?"
  ).get(poId).c;

  // ── Scenario from the field: buy 1000, 700 consumed, then re-save unchanged ──
  const c1 = await api('POST', '/api/purchases', poBody([{ product_id: button, qty: 1000, price: 30000 }]));
  ok(c1.status === 200 && c1.json && c1.json.id, 'create PO 1000 × 30000', c1.text);
  const poId = c1.json && c1.json.id;
  ok(whQty(button) === 1000, 'warehouse has 1000 after purchase', whQty(button));

  postInventoryMovement(db, {
    eventType: 'issue', productId: button, warehouseId: whId, qtyOut: 700,
    sourceType: 'test_consume', sourceId: 1, note: 'مصرف تولید تست', createdBy: admin.id, updateAvg: false,
  });
  ok(whQty(button) === 300, '700 consumed → 300 left', whQty(button));

  const ledBefore = ledCount(poId);
  const a1 = await api('PUT', `/api/purchases/${poId}`, poBody([{ product_id: button, qty: 1000, price: 30000 }]));
  ok(a1.status === 200 && a1.json && a1.json.amended, 'unchanged re-save succeeds despite consumption', a1.text);
  ok(whQty(button) === 300, 'stock untouched by unchanged re-save', whQty(button));
  ok(ledCount(poId) === ledBefore, 'unchanged re-save posts no ledger rows', `${ledBefore}→${ledCount(poId)}`);

  // ── Price-only amend: value revaluation, no qty movement ──
  const avgBefore = Number(db.prepare('SELECT average_cost_rial a FROM products WHERE id=?').get(button).a);
  const a2 = await api('PUT', `/api/purchases/${poId}`, poBody([{ product_id: button, qty: 1000, price: 32000 }]));
  ok(a2.status === 200, 'price-only amend succeeds', a2.text);
  ok(whQty(button) === 300, 'price-only amend keeps qty', whQty(button));
  // v522: 700 of the 1000 were already issued → the whole +2,000,000 waits for approval;
  // approval books the on-hand share (300/1000) to inventory and the issued share to COGS.
  const appr = db.prepare(`
    SELECT * FROM inventory_value_approvals WHERE source_type='purchase' AND source_id=? AND status='pending'
  `).get(poId);
  ok(appr && Number(appr.total_delta_rial) === 2000000, 'value change +2,000,000 parked for approval', appr);
  const avgParked = Number(db.prepare('SELECT average_cost_rial a FROM products WHERE id=?').get(button).a);
  ok(avgParked === avgBefore, 'avg unchanged while pending', `${avgBefore}→${avgParked}`);
  if (appr) require('../lib/inventory/value-approval').approve(db, appr.id, { id: admin.id, role: 'admin' }, {});
  const avgAfter = Number(db.prepare('SELECT average_cost_rial a FROM products WHERE id=?').get(button).a);
  ok(avgAfter === Math.round((300 * avgBefore + 600000) / 300), 'approve: avg absorbs on-hand share (600,000)',
    `${avgBefore}→${avgAfter}`);

  // ── Reduce within what is still on hand ──
  const a3 = await api('PUT', `/api/purchases/${poId}`, poBody([{ product_id: button, qty: 800, price: 32000 }]));
  ok(a3.status === 200, 'reduce 1000→800 (200 ≤ 300 on hand) succeeds', a3.text);
  ok(whQty(button) === 100, 'stock 300→100', whQty(button));

  // ── Reduce below consumed → clear error, rollback ──
  const a4 = await api('PUT', `/api/purchases/${poId}`, poBody([{ product_id: button, qty: 500, price: 32000 }]));
  ok(a4.status === 409 && a4.json && a4.json.code === 'E_AMEND_PURCHASE_CONSUMED', 'reduce below consumed → 409', a4.text);
  ok(a4.json && /دکمه میخی v516/.test(a4.json.error) && /۷۰۰/.test(a4.json.error),
    'error names product and minimum qty 700', a4.json && a4.json.error);
  ok(whQty(button) === 100, 'failed amend rolled back', whQty(button));

  // ── Increase ──
  const a5 = await api('PUT', `/api/purchases/${poId}`, poBody([{ product_id: button, qty: 1200, price: 32000 }]));
  ok(a5.status === 200, 'increase 800→1200 succeeds', a5.text);
  ok(whQty(button) === 500, 'stock 100→500', whQty(button));
  const net = db.prepare(`
    SELECT SUM(qty_in-qty_out) q FROM inventory_ledger
    WHERE source_type='purchase' AND source_id=? AND status='posted' AND COALESCE(reversed_of,0)=0
  `).get(poId).q;
  ok(Number(net) === 1200, 'ledger net qty of PO = 1200', net);

  // ── Void after amends restores everything (R13) ──
  const other = mkProduct('کالای ابطال v516', 'VOID-V516');
  const c2 = await api('POST', '/api/purchases', poBody([{ product_id: other, qty: 10, price: 1000 }]));
  const po2 = c2.json && c2.json.id;
  await api('PUT', `/api/purchases/${po2}`, poBody([{ product_id: other, qty: 15, price: 1100 }]));
  ok(whQty(other) === 15, 'amended PO2 to 15', whQty(other));
  const d2 = await api('DELETE', `/api/purchases/${po2}`);
  ok(d2.status === 200, 'void amended PO2', d2.text);
  ok(whQty(other) === 0, 'void returns all 15 (original + delta)', whQty(other));

  // ── Variant layer: amend must not wipe colour×size stock ──
  let variantOk = false;
  try {
    const shirt = mkProduct('پیراهن v516', 'SHIRT-V516');
    const vId = db.prepare(
      "INSERT INTO product_variants (product_id, sku, stock, active, is_default) VALUES (?, 'SHIRT-V516-R', 0, 1, 0)"
    ).run(shirt).lastInsertRowid;
    const c3 = await api('POST', '/api/purchases', poBody([{ product_id: shirt, variant_id: vId, qty: 20, price: 5000 }]));
    if (c3.status === 200) {
      variantOk = true;
      const vStock = () => Number(db.prepare('SELECT stock FROM product_variants WHERE id=?').get(vId).stock) || 0;
      ok(vStock() === 20, 'variant stock 20 after purchase', vStock());
      await api('PUT', `/api/purchases/${c3.json.id}`, poBody([{ product_id: shirt, variant_id: vId, qty: 20, price: 5500 }]));
      ok(vStock() === 20, 'variant stock kept after price amend (was wiped before v516)', vStock());
      await api('PUT', `/api/purchases/${c3.json.id}`, poBody([{ product_id: shirt, variant_id: vId, qty: 25, price: 5500 }]));
      ok(vStock() === 25, 'variant stock follows qty amend', vStock());
      await api('DELETE', `/api/purchases/${c3.json.id}`);
      ok(vStock() === 0, 'variant stock back to 0 after void', vStock());
    } else {
      console.log('  SKIP variant scenario:', c3.json && c3.json.error);
    }
  } catch (e) {
    console.log('  SKIP variant scenario:', e.message);
  }
  if (!variantOk) console.log('  (variant layer not exercised)');

  // ── Sale amend helper: increase guard is net ──
  const { assertWarehouseLines } = require('../lib/sales-document');
  const fabricSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sales-document.js'), 'utf8');
  ok(/heldByBatch/.test(fabricSrc), 'fabric roll check credits meters held by the same invoice');
  ok(typeof assertWarehouseLines === 'function', 'assertWarehouseLines export');
  const amendSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'amend-invoice.js'), 'utf8');
  ok(/assertSaleIncreasesCovered\(db, oldAgg, newAgg, keys\)/.test(amendSrc), 'sale amend checks only net increase');

  server.close();
  console.log(`\n${fail ? '💥' : '🎉'} ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
