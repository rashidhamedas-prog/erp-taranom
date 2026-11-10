'use strict';
/**
 * product-delete-unused-cascade harden (SW v632)
 * Never touches live product id 342 / code 7217 — synthetic ids only.
 * Run (Node 20): node server/scripts/test-product-delete-unused-cascade.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const FORBIDDEN_LIVE_ID = 342;
const FORBIDDEN_LIVE_CODE = '7217';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'product-delete-cascade-'));
process.env.DB_PATH = path.join(dir, 't.db');
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-product-delete-cascade-secret-32c!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

delete require.cache[require.resolve('../db')];
const { initDB, getDB, closeDB } = require('../db');
initDB();
const db = getDB();

const { ensureDefaultVariant } = require('../lib/product-variants/service');
const { ensureWebsiteStockOutbox } = require('../lib/website-stock-sync');
const { swAtLeast } = require('./lib/sw-at-least');
const {
  rowsJsonContainsId,
  websiteSkuPresenceHint,
  WEBSITE_WARN,
} = require('../lib/product-delete');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra != null ? extra : ''); }
}

function assertNotLiveProduct(id, code) {
  if (Number(id) === FORBIDDEN_LIVE_ID) throw new Error('REFUSING to use live product id 342');
  if (String(code) === FORBIDDEN_LIVE_CODE) throw new Error('REFUSING to use live product code 7217');
}

function tbTotals() {
  try {
    const row = db.prepare(`
      SELECT COALESCE(SUM(COALESCE(debit_rial, ROUND(debit*10))),0) AS d,
             COALESCE(SUM(COALESCE(credit_rial, ROUND(credit*10))),0) AS c
      FROM journal_lines
    `).get();
    return { d: Number(row.d) || 0, c: Number(row.c) || 0 };
  } catch (_) {
    const row = db.prepare(`
      SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c FROM journal_lines
    `).get();
    return { d: Number(row.d) || 0, c: Number(row.c) || 0 };
  }
}

function fkCheck() {
  try { return db.pragma('foreign_key_check'); }
  catch (_) { return []; }
}

function seedStructureProduct(code, name) {
  assertNotLiveProduct(null, code);
  const wh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get();
  const r = db.prepare(`
    INSERT INTO products (user_id, category, code, name, price, cost, stock, unit, warehouse_id, status)
    VALUES (1, 'تست', ?, ?, 0, 0, 0, 'عدد', ?, 'active')
  `).run(code, name, wh ? wh.id : null);
  const id = Number(r.lastInsertRowid);
  assertNotLiveProduct(id, code);
  const def = ensureDefaultVariant(db, id);
  let colorId = null;
  let sizeId = null;
  try {
    colorId = db.prepare('SELECT id FROM product_colors ORDER BY id LIMIT 1').get()?.id
      || db.prepare("INSERT INTO product_colors (name, code) VALUES ('قرمز-تست','RED-PD')").run().lastInsertRowid;
  } catch (_) { colorId = null; }
  try {
    sizeId = db.prepare('SELECT id FROM product_sizes ORDER BY id LIMIT 1').get()?.id
      || db.prepare("INSERT INTO product_sizes (name, code) VALUES ('M-تست','M-PD')").run().lastInsertRowid;
  } catch (_) { sizeId = null; }
  if (colorId) {
    try { db.prepare('INSERT INTO product_style_colors (product_id, color_id, sort_order) VALUES (?,?,0)').run(id, colorId); }
    catch (_) { /* */ }
  }
  if (sizeId) {
    try { db.prepare('INSERT INTO product_style_sizes (product_id, size_id, sort_order) VALUES (?,?,0)').run(id, sizeId); }
    catch (_) { /* */ }
  }
  ensureWebsiteStockOutbox(db);
  try {
    db.prepare(`
      INSERT OR REPLACE INTO website_stock_outbox
        (product_id, channel, next_at, attempts, status, last_error, last_result, updated_at)
      VALUES (?, 'retail', strftime('%s','now'), 0, 'pending', '', '', strftime('%s','now'))
    `).run(id);
  } catch (_) { /* */ }
  if (wh) {
    try {
      db.prepare('INSERT OR REPLACE INTO warehouse_stock (warehouse_id, product_id, qty) VALUES (?,?,0)').run(wh.id, id);
    } catch (_) {
      try { db.prepare('INSERT INTO warehouse_stock (warehouse_id, product_id, qty) VALUES (?,?,0)').run(wh.id, id); }
      catch (__) { /* */ }
    }
  }
  return { id, defaultVariantId: def && def.id, warehouseId: wh && wh.id, code };
}

function insertLedger(opts) {
  const {
    productId, variantId, warehouseId, txNo, qtyIn, qtyOut, amountRial, status, eventType, reversedOf, userId,
  } = opts;
  db.prepare(`
    INSERT INTO inventory_ledger (
      tx_no, event_type, product_id, warehouse_id, variant_id, qty_in, qty_out, qty_balance,
      unit_cost_rial, amount_rial, avg_cost_after_rial, source_type, source_id,
      status, reversed_of, date, note, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1000, ?, 1000, 'test', 1, ?, ?, '1405/08/19', 'fixture', ?)
  `).run(
    txNo,
    eventType || 'receipt',
    productId,
    warehouseId || null,
    variantId != null ? variantId : null,
    qtyIn || 0,
    qtyOut || 0,
    (qtyIn || 0) - (qtyOut || 0),
    amountRial != null ? amountRial : 0,
    status || 'posted',
    reversedOf != null ? reversedOf : null,
    userId || 1
  );
}

(async () => {
  console.log('\n══ product-delete-unused-cascade harden (v632) ══\n');

  ok(!db.prepare('SELECT id FROM products WHERE id=? OR code=?').get(FORBIDDEN_LIVE_ID, FORBIDDEN_LIVE_CODE),
    'fixture DB has no live product 342/7217');

  const swSrc = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const routeSrc = fs.readFileSync(path.join(__dirname, '../routes/products.js'), 'utf8');
  const libSrc = fs.readFileSync(path.join(__dirname, '../lib/product-delete.js'), 'utf8');
  ok(swAtLeast(swSrc, 632), 'SW >= v632');
  ok(appSrc.includes('offerProductDeactivate'), 'UI deactivate offer');
  ok(routeSrc.includes('cascadeDeleteUnusedProduct'), 'route wired');
  ok(libSrc.includes('E_PRODUCT_HAS_LEDGER') && libSrc.includes('voucher_number'), 'ledger code + voucher_number');
  ok(!/ensureWebsiteStockOutbox\s*\(/.test(libSrc), 'product-delete.js never calls ensureWebsiteStockOutbox');

  // JSON id boundary unit checks
  ok(rowsJsonContainsId('[{"product_id":34,"qty":1}]', 'product_id', 34), 'exact id 34 matches');
  ok(!rowsJsonContainsId('[{"product_id":344,"qty":1}]', 'product_id', 34), 'id 34 does not match 344');
  ok(rowsJsonContainsId('[{"product_id": 34 }]', 'product_id', 34), 'spaced id 34 matches');

  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get()
    || db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get();
  ok(!!admin, 'admin present');
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test', device_name: 'pd-del', device_fingerprint: 'pd-del-fp',
  }).token;

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/products', require('../routes/products'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  async function api(method, url, body) {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  const tb0 = tbTotals();
  const whId = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get()?.id;

  // ── unused synthetic → 200 ──
  const pOk = seedStructureProduct('SYN-PD-OK-1', 'کالای مصنوعی قابل حذف');
  const delOk = await api('DELETE', '/api/products/' + pOk.id);
  ok(delOk.status === 200 && delOk.data.ok === true, 'unused synthetic DELETE → 200', delOk);
  ok(!db.prepare('SELECT id FROM products WHERE id=?').get(pOk.id), 'synthetic product gone');
  ok(!db.prepare('SELECT id FROM product_variants WHERE product_id=?').get(pOk.id), 'no variant orphans');

  // ── short id must not match longer id in invoice JSON ──
  const p34 = seedStructureProduct('SYN-PD-34', 'کالای کوتاه');
  const p344 = seedStructureProduct('SYN-PD-344', 'کالای بلند');
  // Force ids if possible — if not 34/344, still test matching helpers; also plant invoice only for p344
  const cust = db.prepare('SELECT id FROM customers ORDER BY id LIMIT 1').get()
    || { id: db.prepare(`INSERT INTO customers (user_id,biz,owner,city,phone,type,status) VALUES (1,'تست','','','09001112233','','active')`).run().lastInsertRowid };
  db.prepare(`
    INSERT INTO invoices (user_id, cust_id, num, type, date, rows, subtotal, final, status)
    VALUES (?, ?, 'T-PD-344', 'final', '1405/08/19', ?, 1000, 1000, 'posted')
  `).run(admin.id, cust.id, JSON.stringify([{ product_id: p344.id, qty: 1, price: 1000 }]));
  const delShort = await api('DELETE', '/api/products/' + p34.id);
  ok(delShort.status === 200, 'product without own invoice still deletable (no false match)', delShort);
  const delLong = await api('DELETE', '/api/products/' + p344.id);
  ok(delLong.status === 409 && delLong.data.can_deactivate === true, 'true invoice match → 409', delLong);

  // ── reversed-only ledger → 409, no orphans ──
  const pRev = seedStructureProduct('SYN-PD-REV', 'کالای کاردکس معکوس');
  insertLedger({
    productId: pRev.id, warehouseId: whId, txNo: 'TX-REV-' + pRev.id,
    qtyIn: 2, qtyOut: 0, amountRial: 2000, status: 'reversed', userId: admin.id,
  });
  const delRev = await api('DELETE', '/api/products/' + pRev.id);
  ok(delRev.status === 409 && delRev.data.code === 'E_PRODUCT_HAS_LEDGER', 'reversed ledger → E_PRODUCT_HAS_LEDGER', delRev);
  ok(!!db.prepare('SELECT id FROM products WHERE id=?').get(pRev.id), 'product kept');
  ok(!!db.prepare('SELECT id FROM product_variants WHERE product_id=?').get(pRev.id), 'variants not orphaned/deleted');

  // ── zero-qty / amount-only variant ledger → 409 ──
  const pAmt = seedStructureProduct('SYN-PD-AMT', 'کالای مبلغ‌فقط');
  insertLedger({
    productId: pAmt.id, variantId: pAmt.defaultVariantId, warehouseId: whId,
    txNo: 'TX-AMT-' + pAmt.id, qtyIn: 0, qtyOut: 0, amountRial: 5000, status: 'posted', userId: admin.id,
  });
  const delAmt = await api('DELETE', '/api/products/' + pAmt.id);
  ok(delAmt.status === 409 && delAmt.data.code === 'E_PRODUCT_HAS_LEDGER', 'zero-qty amount ledger → 409', delAmt);

  // ── +10 / −10 pair → 409 ──
  const pPair = seedStructureProduct('SYN-PD-PAIR', 'کالای جفت صفر');
  insertLedger({
    productId: pPair.id, warehouseId: whId, txNo: 'TX-IN-' + pPair.id,
    qtyIn: 10, qtyOut: 0, amountRial: 10000, status: 'posted', userId: admin.id,
  });
  insertLedger({
    productId: pPair.id, warehouseId: whId, txNo: 'TX-OUT-' + pPair.id,
    qtyIn: 0, qtyOut: 10, amountRial: 10000, status: 'posted', eventType: 'issue', userId: admin.id,
  });
  const delPair = await api('DELETE', '/api/products/' + pPair.id);
  ok(delPair.status === 409 && delPair.data.code === 'E_PRODUCT_HAS_LEDGER', '+10/−10 pair → 409', delPair);

  // ── inventory_movements → 409 ──
  const pMov = seedStructureProduct('SYN-PD-MOV', 'کالای حرکت');
  db.prepare(`
    INSERT INTO inventory_movements (product_id, variant_id, warehouse_id, qty_delta, doc_type, doc_id, user_id)
    VALUES (?, ?, ?, 1, 'transfer', 9001, ?)
  `).run(pMov.id, pMov.defaultVariantId, whId, admin.id);
  const delMov = await api('DELETE', '/api/products/' + pMov.id);
  ok(delMov.status === 409 && /حرکت|کاردکس|ledger|mov/i.test(JSON.stringify(delMov.data)), 'movements → 409', delMov);

  // ── warehouse_moves → 409 ──
  const pWm = seedStructureProduct('SYN-PD-WM', 'کالای حواله');
  db.prepare(`
    INSERT INTO warehouse_moves (type, product_id, from_warehouse_id, to_warehouse_id, qty, date, created_by)
    VALUES ('transfer', ?, ?, ?, 1, '1405/08/19', ?)
  `).run(pWm.id, whId, whId, admin.id);
  const delWm = await api('DELETE', '/api/products/' + pWm.id);
  ok(delWm.status === 409 && delWm.data.kind === 'warehouse_move', 'warehouse_moves → 409', delWm);

  // ── variant_reclass_docs → 409 ──
  const pVr = seedStructureProduct('SYN-PD-VR', 'کالای VR');
  // Need a dummy ledger id for NOT NULL source_ledger_id — use a ledger on another synthetic product
  const pVrSrc = seedStructureProduct('SYN-PD-VRSRC', 'منبع VR');
  insertLedger({
    productId: pVrSrc.id, warehouseId: whId, txNo: 'TX-VRSRC-' + pVrSrc.id,
    qtyIn: 1, amountRial: 100, userId: admin.id,
  });
  const srcLed = db.prepare('SELECT id FROM inventory_ledger WHERE product_id=?').get(pVrSrc.id);
  db.prepare(`
    INSERT INTO variant_reclass_docs (doc_no, date, product_id, warehouse_id, source_ledger_id, lines_json, reason, status, created_by)
    VALUES (?, '1405/08/19', ?, ?, ?, '[]', 'تست اصلاح واریانت برای حذف', 'posted', ?)
  `).run('VR-PD-' + pVr.id, pVr.id, whId, srcLed.id, admin.id);
  const delVr = await api('DELETE', '/api/products/' + pVr.id);
  ok(delVr.status === 409 && delVr.data.kind === 'variant_reclass', 'variant_reclass → 409', delVr);

  // ── draft opening → 409 ──
  const pOp = seedStructureProduct('SYN-PD-OP', 'کالای افتتاحیه پیش‌نویس');
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='opening_stock_docs'").get()) {
    const fy = db.prepare('SELECT id FROM fiscal_years ORDER BY id LIMIT 1').get();
    const docId = db.prepare(`
      INSERT INTO opening_stock_docs (doc_no, fiscal_year_id, date, status, created_by, note)
      VALUES (?, ?, '1405/08/01', 'draft', ?, 'fixture')
    `).run('OP-PD-' + pOp.id, fy ? fy.id : null, admin.id).lastInsertRowid;
    db.prepare(`
      INSERT INTO opening_stock_lines (doc_id, fiscal_year_id, product_id, warehouse_id, variant_id, qty, unit_cost_rial, active)
      VALUES (?, ?, ?, ?, NULL, 0, 0, 1)
    `).run(docId, fy ? fy.id : null, pOp.id, whId);
    const delOp = await api('DELETE', '/api/products/' + pOp.id);
    ok(delOp.status === 409 && delOp.data.kind === 'opening', 'draft opening → 409', delOp);
  } else {
    ok(false, 'opening_stock_docs missing');
  }

  // ── purchase return → 409 ──
  const pPr = seedStructureProduct('SYN-PD-PR', 'کالای برگشت خرید');
  const sup = db.prepare('SELECT id FROM suppliers ORDER BY id LIMIT 1').get()
    || { id: db.prepare(`INSERT INTO suppliers (name, phone) VALUES ('تأمین‌کننده تست','')`).run().lastInsertRowid };
  db.prepare(`
    INSERT INTO purchase_returns (user_id, supplier_id, date, rows, amount, status)
    VALUES (?, ?, '1405/08/19', ?, 500, 'posted')
  `).run(admin.id, sup.id, JSON.stringify([{ product_id: pPr.id, qty: 1, price: 500 }]));
  const delPr = await api('DELETE', '/api/products/' + pPr.id);
  ok(delPr.status === 409 && delPr.data.kind === 'purchase_return', 'purchase_returns → 409', delPr);

  // ── stocktaking session item → 409 (not cascaded) ──
  const pSt = seedStructureProduct('SYN-PD-ST', 'کالای انبارگردانی');
  const sess = db.prepare(`
    INSERT INTO stocktaking_sessions (warehouse_id, date, status, created_by)
    VALUES (?, '1405/08/19', 'draft', ?)
  `).run(whId, admin.id).lastInsertRowid;
  db.prepare(`
    INSERT INTO stocktaking_items (session_id, product_id, system_qty, counted_qty)
    VALUES (?, ?, 0, 0)
  `).run(sess, pSt.id);
  const delSt = await api('DELETE', '/api/products/' + pSt.id);
  ok(delSt.status === 409 && delSt.data.kind === 'stocktaking', 'stocktaking session item → 409', delSt);
  ok(!!db.prepare('SELECT id FROM stocktaking_items WHERE product_id=?').get(pSt.id), 'stocktake line not cascaded');

  // ── production-shaped outbox → website_warning ──
  const pWeb = seedStructureProduct('SYN-PD-WEB', 'کالای وب ماتریس');
  ensureWebsiteStockOutbox(db);
  db.prepare(`
    INSERT OR REPLACE INTO website_stock_outbox
      (product_id, channel, next_at, attempts, status, last_error, last_result, updated_at)
    VALUES (?, 'retail', strftime('%s','now'), 1, 'done', '', ?, strftime('%s','now'))
  `).run(pWeb.id, JSON.stringify({
    matched: 3,
    expected: 3,
    unmatchedCount: 0,
    catalogMissing: false,
    code: 'all_matched',
    status: 'done',
    ok: true,
    message: '3 رنگ/سایز در سایت به‌روز شد',
  }));
  ok(websiteSkuPresenceHint(db, { id: pWeb.id, code: pWeb.code }) === true, 'hint detects all_matched payload');
  // error but SKU still on site
  ok(websiteSkuPresenceHint(db, {
    id: (() => {
      const t = seedStructureProduct('SYN-PD-WEB2', 'کالای وب unmatched');
      db.prepare(`
        INSERT OR REPLACE INTO website_stock_outbox
          (product_id, channel, next_at, attempts, status, last_error, last_result, updated_at)
        VALUES (?, 'wholesale', strftime('%s','now'), 1, 'error', 'x', ?, strftime('%s','now'))
      `).run(t.id, JSON.stringify({
        matched: 1,
        unmatchedCount: 2,
        catalogMissing: false,
        code: 'variants_unmatched',
        ok: false,
        status: 'error',
        onSite: ['RED/M'],
      }));
      // keep for hint unit test only — delete via API later if unused
      global.__web2 = t;
      return t.id;
    })(),
  }) === true, 'hint detects error payload with SKU on site');

  const delWeb = await api('DELETE', '/api/products/' + pWeb.id);
  ok(delWeb.status === 200 && delWeb.data.website_warning === WEBSITE_WARN,
    'production outbox shape → website_warning', delWeb);

  // clean web2 if still present and unused
  if (global.__web2) {
    await api('DELETE', '/api/products/' + global.__web2.id);
  }

  // ── TB + FK check ──
  const tb1 = tbTotals();
  ok(tb1.d === tb0.d && tb1.c === tb0.c, 'trial balance unchanged', { tb0, tb1 });
  const fkc = fkCheck();
  ok(Array.isArray(fkc) && fkc.length === 0, 'foreign_key_check = 0', fkc);

  // guard: never referenced forbidden live codes in this run
  ok(!String(process.argv.join(' ')).includes(FORBIDDEN_LIVE_CODE), 'argv clean of 7217');

  server.close();
  try { closeSessionStore(); } catch (_) { /* */ }
  try { closeDB(); } catch (_) { /* */ }

  console.log(`\n══ Result: ${pass} passed, ${fail} failed ══\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
