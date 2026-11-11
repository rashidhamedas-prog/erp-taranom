#!/usr/bin/env node
/**
 * Product image delete must clear/promote products.image (no ghost primary).
 * Temp DB + uploads only. Forbidden fixture ids: 100,114,12,108,151,342.
 */
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const FORBIDDEN_IDS = new Set([100, 114, 12, 108, 151, 342]);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-img-del-'));
const dbPath = path.join(tmpDir, 'test.db');
const uploadsDir = path.join(tmpDir, 'uploads');
const productsUpload = path.join(uploadsDir, 'products');
fs.mkdirSync(productsUpload, { recursive: true });

process.env.DB_PATH = dbPath;
process.env.UPLOADS_DIR = uploadsDir;
process.env.JWT_SECRET = 'test-secret-product-image-delete-primary-32!!';
process.env.AUTH_SESSION_DB_PATH = path.join(tmpDir, 'sessions.db');
process.env.SYNC_ROLE = 'central';
process.env.NODE_ENV = 'test';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

delete require.cache[require.resolve('../db')];
const { getDB, initDB } = require('../db');
initDB();
const db = getDB();

const user = db.prepare("SELECT * FROM users WHERE role='admin' AND active=1 LIMIT 1").get()
  || db.prepare('SELECT * FROM users WHERE active=1 LIMIT 1').get();
assert(user, 'need an active user');
try { db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(user.id); } catch (_) {}

const { issueStaffSession } = require('../lib/auth-sessions');
const { token } = issueStaffSession(db, user, { deviceName: 'img-del-test', deviceKind: 'web' });

const productsRouter = require('../routes/products');
const app = express();
app.use(express.json());
app.use('/api/products', productsRouter);
const server = http.createServer(app);

function mkFilename() {
  return `p_${crypto.randomBytes(18).toString('hex')}.webp`;
}

function writeFile(name, bytes) {
  fs.writeFileSync(path.join(productsUpload, name), bytes || Buffer.from('webp-test'));
}

function insertProduct(code, name) {
  const r = db.prepare(`
    INSERT INTO products (user_id, category, code, name, price, cost, stock, stock_alert, unit, note, colors, pack_size)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(user.id, 'تست', code, name, 1000, 500, 0, 0, 'عدد', '', 0, 1);
  const id = Number(r.lastInsertRowid);
  assert.ok(!FORBIDDEN_IDS.has(id), 'fixture id must not be forbidden: ' + id);
  return id;
}

function insertGallery(productId, filename, sortOrder) {
  const r = db.prepare(
    'INSERT INTO product_images (product_id,filename,sort_order) VALUES (?,?,?)'
  ).run(productId, filename, sortOrder);
  return Number(r.lastInsertRowid);
}

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const opts = {
      hostname: '127.0.0.1',
      port: server.address().port,
      path: urlPath,
      method,
      headers: {
        Authorization: 'Bearer ' + token,
      },
    };
    if (payload) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = payload.length;
    }
    const r = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function putMultipart(productId, fields) {
  return new Promise((resolve, reject) => {
    const boundary = '----ImgDel' + Date.now();
    const parts = [];
    for (const [k, v] of Object.entries(fields || {})) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
      ));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);
    const opts = {
      hostname: '127.0.0.1',
      port: server.address().port,
      path: '/api/products/' + productId,
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length,
      },
    };
    const r = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

function fileExists(name) {
  return fs.existsSync(path.join(productsUpload, name));
}

server.listen(0, async () => {
  let failed = null;
  try {
    assert.ok(!db.prepare('SELECT 1 FROM products WHERE id=342').get(), 'temp DB must not contain product 342');

    // 1) Delete by gallery id clears primary + unlinks
    {
      const pid = insertProduct('T-IMGDEL-1', 'حذف با id');
      const fn = mkFilename();
      writeFile(fn);
      const iid = insertGallery(pid, fn, 0);
      db.prepare('UPDATE products SET image=?, images_json=? WHERE id=?')
        .run(fn, JSON.stringify([fn]), pid);
      const del = await req('DELETE', '/api/products/images/' + iid);
      assert.equal(del.status, 200, 'delete by id status ' + del.status + ' ' + JSON.stringify(del.body));
      const row = db.prepare('SELECT image, images_json FROM products WHERE id=?').get(pid);
      assert.ok(!row.image, 'primary cleared, got ' + JSON.stringify(row.image));
      assert.equal(row.images_json, '[]');
      assert.equal(db.prepare('SELECT COUNT(*) c FROM product_images WHERE product_id=?').get(pid).c, 0);
      assert.equal(fileExists(fn), false, 'file unlinked');
    }

    // 2) Legacy ghost primary path
    {
      const pid = insertProduct('T-IMGDEL-2', 'حذف primary');
      const fn = mkFilename();
      writeFile(fn);
      db.prepare('UPDATE products SET image=?, images_json=? WHERE id=?')
        .run(fn, '[]', pid);
      assert.equal(db.prepare('SELECT COUNT(*) c FROM product_images WHERE product_id=?').get(pid).c, 0);
      const del = await req('DELETE', '/api/products/' + pid + '/images/primary', { filename: fn });
      assert.equal(del.status, 200, 'legacy delete ' + del.status + ' ' + JSON.stringify(del.body));
      const row = db.prepare('SELECT image, images_json FROM products WHERE id=?').get(pid);
      assert.ok(!row.image, 'legacy primary cleared');
      assert.equal(row.images_json, '[]');
      assert.equal(fileExists(fn), false);

      // missing file still clears column
      const fn2 = mkFilename();
      db.prepare('UPDATE products SET image=?, images_json=? WHERE id=?').run(fn2, '[]', pid);
      assert.equal(fileExists(fn2), false);
      const del2 = await req('DELETE', '/api/products/' + pid + '/images/primary');
      assert.equal(del2.status, 200, 'missing-file primary delete');
      const row2 = db.prepare('SELECT image FROM products WHERE id=?').get(pid);
      assert.ok(!row2.image, 'ghost column cleared without file');

      // Broken CSP embedding used to send literal "${safe}" → must still clear primary
      const fn3 = mkFilename();
      writeFile(fn3);
      db.prepare('UPDATE products SET image=?, images_json=? WHERE id=?').run(fn3, '[]', pid);
      const del3 = await req('DELETE', '/api/products/' + pid + '/images/primary', { filename: '${safe}' });
      assert.equal(del3.status, 200, 'garbage filename fallback ' + JSON.stringify(del3.body));
      const row3 = db.prepare('SELECT image FROM products WHERE id=?').get(pid);
      assert.ok(!row3.image, 'primary cleared despite garbage filename body');
      assert.equal(fileExists(fn3), false);
    }

    // 3) Two gallery images — delete primary promotes remaining
    {
      const pid = insertProduct('T-IMGDEL-3', 'promote');
      const a = mkFilename();
      const b = mkFilename();
      writeFile(a); writeFile(b);
      const iidA = insertGallery(pid, a, 0);
      insertGallery(pid, b, 1);
      db.prepare('UPDATE products SET image=?, images_json=? WHERE id=?')
        .run(a, JSON.stringify([a, b]), pid);
      const del = await req('DELETE', '/api/products/images/' + iidA);
      assert.equal(del.status, 200);
      const row = db.prepare('SELECT image, images_json FROM products WHERE id=?').get(pid);
      assert.equal(row.image, b, 'promoted to remaining');
      assert.deepEqual(JSON.parse(row.images_json), [b]);
      assert.equal(fileExists(a), false);
      assert.equal(fileExists(b), true);
    }

    // 4) PUT after delete does not resurrect
    {
      const pid = insertProduct('T-IMGDEL-4', 'no-resurrect');
      const fn = mkFilename();
      writeFile(fn);
      const iid = insertGallery(pid, fn, 0);
      db.prepare('UPDATE products SET image=?, images_json=? WHERE id=?')
        .run(fn, JSON.stringify([fn]), pid);
      const del = await req('DELETE', '/api/products/images/' + iid);
      assert.equal(del.status, 200);
      const put = await putMultipart(pid, { name: 'no-resurrect' });
      assert.equal(put.status, 200, 'PUT status ' + put.status + ' ' + JSON.stringify(put.body));
      const row = db.prepare('SELECT image, images_json FROM products WHERE id=?').get(pid);
      assert.ok(!row.image, 'PUT must not restore image');
      assert.equal(db.prepare('SELECT COUNT(*) c FROM product_images WHERE product_id=?').get(pid).c, 0);
      const parsed = row.images_json ? JSON.parse(row.images_json) : [];
      assert.deepEqual(parsed, []);
    }

    // 5) Shared filename not unlinked
    {
      const p1 = insertProduct('T-IMGDEL-5A', 'share-a');
      const p2 = insertProduct('T-IMGDEL-5B', 'share-b');
      const fn = mkFilename();
      writeFile(fn);
      const iid = insertGallery(p1, fn, 0);
      db.prepare('UPDATE products SET image=?, images_json=? WHERE id=?')
        .run(fn, JSON.stringify([fn]), p1);
      db.prepare('UPDATE products SET image=? WHERE id=?').run(fn, p2);
      const del = await req('DELETE', '/api/products/images/' + iid);
      assert.equal(del.status, 200);
      assert.equal(fileExists(fn), true, 'shared file must remain');
      const other = db.prepare('SELECT image FROM products WHERE id=?').get(p2);
      assert.equal(other.image, fn);
    }

    // 6) GET attaches legacy_primary without writing
    {
      const pid = insertProduct('T-IMGDEL-6', 'get-legacy');
      const fn = mkFilename();
      db.prepare('UPDATE products SET image=?, images_json=? WHERE id=?').run(fn, '[]', pid);
      const before = db.prepare('SELECT images_json FROM products WHERE id=?').get(pid).images_json;
      const get = await req('GET', '/api/products/' + pid);
      assert.equal(get.status, 200);
      assert.ok(Array.isArray(get.body.images));
      assert.ok(get.body.images.some((im) => im.filename === fn && im.legacy_primary === true && im.id === 0));
      const after = db.prepare('SELECT images_json FROM products WHERE id=?').get(pid).images_json;
      assert.equal(after, before, 'GET must not write DB');
    }

    assert.ok(!db.prepare('SELECT 1 FROM products WHERE id=342').get(), 'product 342 still absent');
    console.log('OK product-image-delete-clears-primary');
    server.close();
    process.exit(0);
  } catch (e) {
    failed = e;
    console.error('FAIL', e);
    server.close();
    process.exit(1);
  }
});
