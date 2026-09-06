/**
 * INV-STITCH-P4 — INV-02 color hex + INV-03 warehouse line product search.
 * Run: node server/scripts/test-inv-stitch-p4.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-stitch-p4-'));
const dbFile = path.join(dir, 't.db');
try { fs.unlinkSync(dbFile); } catch (_) {}
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-inv-stitch-p4-secret-at-least-32b';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');

delete require.cache[require.resolve('../db')];

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const { createReservation, availableQty } = require('../lib/inventory/reservation');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

(async () => {
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test',
    device_name: 'inv-stitch-p4',
    device_fingerprint: 'inv-stitch-p4-fp',
  }).token;

  const app = express();
  app.use(express.json());
  app.use('/api/product-variants', require('../routes/product-variants'));
  app.use('/api/products', require('../routes/products'));
  app.use('/api/inventory', require('../routes/inventory'));
  app.use('/api/warehouses', require('../routes/warehouses'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const BASE = `http://127.0.0.1:${port}`;

  async function api(method, p, body) {
    const res = await fetch(BASE + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  }

  console.log('\n— INV-02 color hex —');
  let r = await api('POST', '/api/product-variants/colors', {
    name: 'قرمز یاقوتی',
    code: 'RUBY',
    hex: '#F00',
  });
  ok(r.status === 201, 'POST #RGB 201', r.data?.error);
  ok(r.data && r.data.name === 'قرمز یاقوتی', 'Persian name kept', r.data?.name);
  ok(r.data && r.data.hex === '#FF0000', 'hex normalized to #RRGGBB', r.data?.hex);
  ok(r.data && r.data.contrast_ok === true, 'contrast_ok computed', r.data?.contrast_ok);
  ok(r.data && (r.data.contrast_fg === 'white' || r.data.contrast_fg === 'black'),
    'contrast_fg vs white/black', r.data?.contrast_fg);
  const redId = r.data && r.data.id;

  r = await api('POST', '/api/product-variants/colors', {
    name: 'قرمز تکراری',
    code: 'RUBY2',
    hex: '#ff0000',
  });
  ok(r.status === 400 && r.data && r.data.code === 'E_COLOR_DUPLICATE',
    'duplicate hex → 400 E_COLOR_DUPLICATE', r.data);

  r = await api('POST', '/api/product-variants/colors', {
    name: 'نامعتبر',
    code: 'BAD',
    hex: 'FF0000',
  });
  ok(r.status === 400 && r.data && r.data.code === 'E_COLOR_INVALID_HEX',
    'missing # → 400 E_COLOR_INVALID_HEX', r.data);

  r = await api('POST', '/api/product-variants/colors', {
    name: 'نامعتبر۲',
    code: 'BAD2',
    hex: '#GG0000',
  });
  ok(r.status === 400 && r.data && r.data.code === 'E_COLOR_INVALID_HEX',
    'invalid chars → 400 E_COLOR_INVALID_HEX', r.data);

  r = await api('POST', '/api/product-variants/colors', {
    name: 'بدون رنگ',
    code: 'NONE',
    hex: '',
  });
  ok(r.status === 201 && r.data && r.data.name === 'بدون رنگ',
    'empty hex allowed', r.data?.error);
  ok(r.data && r.data.contrast_ok == null, 'empty hex contrast_ok is null', r.data?.contrast_ok);

  r = await api('PUT', '/api/product-variants/colors/' + redId, { hex: '#12' });
  ok(r.status === 400 && r.data && r.data.code === 'E_COLOR_INVALID_HEX',
    'PUT short hex rejected', r.data);

  r = await api('PUT', '/api/product-variants/colors/' + redId, { hex: '#F00' });
  ok(r.status === 200 && r.data && r.data.hex === '#FF0000',
    'PUT same color same hex ok', r.data?.hex);

  r = await api('GET', '/api/product-variants/colors?all=1');
  const listed = Array.isArray(r.data) ? r.data : [];
  const listedRed = listed.find(c => Number(c.id) === Number(redId));
  ok(r.status === 200 && listedRed && listedRed.contrast_ok === true,
    'GET colors includes contrast_ok', listedRed && listedRed.contrast_ok);

  console.log('\n— INV-03 warehouse product search —');
  let wh = db.prepare('SELECT id FROM warehouses WHERE active=1 LIMIT 1').get();
  if (!wh) {
    const ins = db.prepare("INSERT INTO warehouses (name, code, warehouse_type, active) VALUES ('انبار تست','WH-P4','finished_goods',1)").run();
    wh = { id: ins.lastInsertRowid };
  }
  const pid = db.prepare(`
    INSERT INTO products (user_id, name, code, barcode, stock, warehouse_id)
    VALUES (?,'مانتو یاقوت','MNT-RUBY','555111222333',10,?)
  `).run(admin.id, wh.id).lastInsertRowid;
  db.prepare(`
    INSERT OR REPLACE INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,10)
  `).run(pid, wh.id);
  db.prepare(`
    INSERT INTO product_variants (product_id, sku, barcode, is_default, active)
    VALUES (?,?,?,0,1)
  `).run(pid, 'STY-RUBY-L', '888777666555');

  r = await api('GET', '/api/warehouses/products/search?q=' + encodeURIComponent('STY-RUBY-L') + '&warehouse_id=' + wh.id + '&page=1&pageSize=20');
  ok(r.status === 200, 'warehouse search 200', r.data?.error);
  const skuHits = Array.isArray(r.data?.data) ? r.data.data : [];
  ok(skuHits.some(p => Number(p.id) === Number(pid)), 'search by variant SKU', skuHits.map(p => p.id));
  ok(r.data && r.data.pagination && r.data.pagination.page === 1, 'paginated envelope', r.data?.pagination);

  r = await api('GET', '/api/warehouses/products/search?q=555111222333&warehouse_id=' + wh.id);
  const bcHits = Array.isArray(r.data?.data) ? r.data.data : [];
  ok(bcHits.some(p => Number(p.id) === Number(pid)), 'search by product barcode');

  r = await api('GET', '/api/warehouses/products/search?q=' + encodeURIComponent('مانتو') + '&warehouse_id=' + wh.id);
  const nameHits = Array.isArray(r.data?.data) ? r.data.data : [];
  ok(nameHits.some(p => Number(p.id) === Number(pid)), 'search by Persian name');

  r = await api('GET', '/api/products?q=MNT-RUBY&warehouse_id=' + wh.id + '&page=1&pageSize=20&include_zero=1');
  const prodHits = Array.isArray(r.data?.data) ? r.data.data : (Array.isArray(r.data) ? r.data : []);
  ok(prodHits.some(p => Number(p.id) === Number(pid)), 'GET /products?q= finds by code');

  const atp = availableQty(db, pid, wh.id);
  r = await api('GET', '/api/inventory/available/' + pid + '?warehouse_id=' + wh.id);
  ok(r.status === 200 && Number(r.data?.available) === atp, 'ATP endpoint matches helper', r.data);

  r = await api('GET', '/api/warehouses/products/search?q=MNT-RUBY&warehouse_id=' + wh.id);
  const line = (r.data?.data || []).find(p => Number(p.id) === Number(pid));
  ok(line && Number(line.available) === atp, 'search available equals ATP', line && line.available);

  createReservation(db, {
    kind: 'sales',
    productId: pid,
    warehouseId: wh.id,
    qty: 4,
    createdBy: admin.id,
  });
  const atpAfter = availableQty(db, pid, wh.id);
  ok(atpAfter === atp - 4, 'reservation reduces ATP', atpAfter);
  r = await api('GET', '/api/warehouses/products/search?q=MNT-RUBY&warehouse_id=' + wh.id);
  const line2 = (r.data?.data || []).find(p => Number(p.id) === Number(pid));
  ok(line2 && Number(line2.available) === atpAfter, 'search ATP after reservation', line2 && line2.available);

  r = await api('GET', '/api/warehouses/products/search?q=zzz-no-such-sku&warehouse_id=' + wh.id);
  ok(r.status === 200 && Array.isArray(r.data?.data) && r.data.data.length === 0,
    'empty search returns empty page', r.data);

  r = await api('GET', '/api/warehouses/products/search?q=مانتو&page=1&pageSize=1');
  ok(r.status === 200 && r.data?.pagination?.pageSize === 1, 'pageSize honored', r.data?.pagination);

  server.close();
  try { closeSessionStore(); } catch (_) {}
  console.log('\nINV-STITCH-P4: ' + (fail ? fail + ' failed' : pass + ' passed') + ` (${pass} ok)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
