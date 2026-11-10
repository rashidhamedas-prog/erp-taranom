'use strict';
/**
 * product-delete-unused-cascade (SW v631)
 * structure_only → 200; invoice/ledger → 409 + can_deactivate; TB unchanged.
 * Run (Node 20): node server/scripts/test-product-delete-unused-cascade.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

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

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra != null ? extra : ''); }
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

function seedStructureProduct(code, name) {
  const wh = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get();
  const r = db.prepare(`
    INSERT INTO products (user_id, category, code, name, price, cost, stock, unit, warehouse_id, status)
    VALUES (1, 'تست', ?, ?, 0, 0, 0, 'عدد', ?, 'active')
  `).run(code, name, wh ? wh.id : null);
  const id = Number(r.lastInsertRowid);
  const def = ensureDefaultVariant(db, id);
  // style colors/sizes (may need catalog color/size ids)
  let colorId = null;
  let sizeId = null;
  try {
    colorId = db.prepare('SELECT id FROM product_colors ORDER BY id LIMIT 1').get()?.id
      || db.prepare("INSERT INTO product_colors (name, code) VALUES ('قرمز-تست','RED-T')").run().lastInsertRowid;
  } catch (_) { colorId = null; }
  try {
    sizeId = db.prepare('SELECT id FROM product_sizes ORDER BY id LIMIT 1').get()?.id
      || db.prepare("INSERT INTO product_sizes (name, code) VALUES ('M-تست','M-T')").run().lastInsertRowid;
  } catch (_) { sizeId = null; }
  if (colorId) {
    try {
      db.prepare('INSERT INTO product_style_colors (product_id, color_id, sort_order) VALUES (?,?,0)').run(id, colorId);
    } catch (_) { /* */ }
  }
  if (sizeId) {
    try {
      db.prepare('INSERT INTO product_style_sizes (product_id, size_id, sort_order) VALUES (?,?,0)').run(id, sizeId);
    } catch (_) { /* */ }
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
      db.prepare(`
        INSERT OR REPLACE INTO warehouse_stock (warehouse_id, product_id, qty)
        VALUES (?, ?, 0)
      `).run(wh.id, id);
    } catch (_) {
      try {
        db.prepare('INSERT INTO warehouse_stock (warehouse_id, product_id, qty) VALUES (?,?,0)').run(wh.id, id);
      } catch (__) { /* */ }
    }
  }
  return { id, defaultVariantId: def && def.id, warehouseId: wh && wh.id };
}

(async () => {
  console.log('\n══ product-delete-unused-cascade (v631) ══\n');

  const swSrc = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const routeSrc = fs.readFileSync(path.join(__dirname, '../routes/products.js'), 'utf8');
  ok(swAtLeast(swSrc, 631), 'SW >= v631');
  ok(appSrc.includes('offerProductDeactivate') && appSrc.includes('deactivateProductInstead'), 'UI deactivate offer');
  ok(appSrc.includes('website_warning'), 'UI website warning toast');
  ok(routeSrc.includes('cascadeDeleteUnusedProduct') && routeSrc.includes('/:id/deactivate'), 'route wired');

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

  // ── 1) structure_only → 200 ──
  const p1 = seedStructureProduct('788888-TEST', 'کالای ساختار فقط');
  ok(!!db.prepare('SELECT id FROM product_variants WHERE product_id=?').get(p1.id), 'variant exists before delete');
  ok(!!db.prepare('SELECT 1 FROM website_stock_outbox WHERE product_id=?').get(p1.id), 'outbox exists before delete');
  const del1 = await api('DELETE', '/api/products/' + p1.id);
  ok(del1.status === 200 && del1.data.ok === true, 'structure_only DELETE → 200', del1);
  ok(!db.prepare('SELECT id FROM products WHERE id=?').get(p1.id), 'product row gone');
  ok(!db.prepare('SELECT id FROM product_variants WHERE product_id=?').get(p1.id), 'variants cascaded');
  ok(!db.prepare('SELECT 1 FROM website_stock_outbox WHERE product_id=?').get(p1.id), 'outbox cascaded');
  ok(!db.prepare('SELECT 1 FROM product_style_colors WHERE product_id=?').get(p1.id), 'style colors cascaded');
  ok(!db.prepare('SELECT 1 FROM product_style_sizes WHERE product_id=?').get(p1.id), 'style sizes cascaded');

  // ── 2) invoice → 409 ──
  const p2 = seedStructureProduct('722222-TEST', 'کالای با فاکتور');
  const cust = db.prepare('SELECT id FROM customers ORDER BY id LIMIT 1').get()
    || (() => {
      const id = db.prepare(`
        INSERT INTO customers (user_id, biz, owner, city, phone, type, status)
        VALUES (1,'تست','','','09000000000','','active')
      `).run().lastInsertRowid;
      return { id };
    })();
  const invNum = 'T-PD-DEL-1';
  db.prepare(`
    INSERT INTO invoices (user_id, cust_id, num, type, date, rows, subtotal, final, status)
    VALUES (?, ?, ?, 'final', '1405/08/19', ?, 1000, 1000, 'posted')
  `).run(
    admin.id,
    cust.id,
    invNum,
    JSON.stringify([{ product_id: p2.id, name: 'x', qty: 1, price: 1000 }])
  );
  const del2 = await api('DELETE', '/api/products/' + p2.id);
  ok(del2.status === 409 && del2.data.can_deactivate === true, 'invoice DELETE → 409 + can_deactivate', del2);
  ok(String(del2.data.doc_no || del2.data.error || '').includes(invNum)
    || String(del2.data.error || '').includes(invNum), '409 names invoice number', del2.data);
  ok(!!db.prepare('SELECT id FROM products WHERE id=?').get(p2.id), 'product kept after invoice block');

  const deact = await api('POST', '/api/products/' + p2.id + '/deactivate');
  ok(deact.status === 200 && deact.data.deactivated === true, 'deactivate offered path works', deact);
  const st = db.prepare('SELECT status FROM products WHERE id=?').get(p2.id);
  ok(st && st.status === 'inactive', 'status=inactive after deactivate', st);

  // ── 3) live non-zero ledger → 409 ──
  const p3 = seedStructureProduct('PD-LEDGER-1', 'کالای با کاردکس');
  const whId = p3.warehouseId || db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get()?.id;
  db.prepare(`
    INSERT INTO inventory_ledger (
      tx_no, event_type, product_id, warehouse_id, qty_in, qty_out, qty_balance,
      unit_cost_rial, amount_rial, avg_cost_after_rial, source_type, source_id,
      status, date, note, created_by
    ) VALUES (?, 'receipt', ?, ?, 5, 0, 5, 1000, 5000, 1000, 'test', 1, 'posted', '1405/08/19', 'fixture', ?)
  `).run('TX-PD-DEL-' + p3.id, p3.id, whId, admin.id);
  const del3 = await api('DELETE', '/api/products/' + p3.id);
  ok(del3.status === 409 && del3.data.kind === 'inventory_ledger', 'ledger DELETE → 409 ledger', del3);
  ok(del3.data.can_deactivate === true, 'ledger block offers deactivate');
  ok(!!db.prepare('SELECT id FROM products WHERE id=?').get(p3.id), 'product kept after ledger block');

  // ── 4) TB unchanged ──
  const tb1 = tbTotals();
  ok(tb1.d === tb0.d && tb1.c === tb0.c, 'trial balance totals unchanged', { tb0, tb1 });

  // ── 5) website warning when outbox proves site match ──
  const p4 = seedStructureProduct('PD-WEB-1', 'کالای وب');
  ensureWebsiteStockOutbox(db);
  db.prepare(`
    INSERT OR REPLACE INTO website_stock_outbox
      (product_id, channel, next_at, attempts, status, last_error, last_result, updated_at)
    VALUES (?, 'retail', strftime('%s','now'), 1, 'done', '', ?, strftime('%s','now'))
  `).run(p4.id, JSON.stringify({ ok: true, siteProductId: 99901, matched: true }));
  const del4 = await api('DELETE', '/api/products/' + p4.id);
  ok(del4.status === 200 && del4.data.ok === true, 'website-hint product still deletable', del4);
  ok(!!del4.data.website_warning && /وب‌سایت|سایت/.test(del4.data.website_warning),
    'website_warning present when SKU known on site', del4.data);

  server.close();
  try { closeSessionStore(); } catch (_) { /* */ }
  try { closeDB(); } catch (_) { /* */ }

  console.log(`\n══ Result: ${pass} passed, ${fail} failed ══\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
