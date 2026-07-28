#!/usr/bin/env node
/**
 * Regression: image-only PUT must not wipe stock/pack_size/price/code/note.
 * Also verifies restore-from-warehouse helper.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-img-wipe-'));
const dbPath = path.join(tmpDir, 'test.db');
const uploadsDir = path.join(tmpDir, 'uploads');
fs.mkdirSync(path.join(uploadsDir, 'products'), { recursive: true });

process.env.DB_PATH = dbPath;
process.env.UPLOADS_DIR = uploadsDir;
process.env.JWT_SECRET = 'test-secret-product-image-wipe-fix';
process.env.SYNC_ROLE = 'central';
process.env.NODE_ENV = 'test';

delete require.cache[require.resolve('../db')];
const { getDB, initDB } = require('../db');
initDB();
const db = getDB();

const user = db.prepare("SELECT id FROM users WHERE role='admin' AND active=1 LIMIT 1").get()
  || db.prepare('SELECT id FROM users WHERE active=1 LIMIT 1').get();
assert(user, 'need an active user');
// Clear must_change so auth doesn't block
try { db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(user.id); } catch (_) {}

const wh = db.prepare('SELECT id FROM warehouses LIMIT 1').get();
const whId = wh ? wh.id : null;

const ins = db.prepare(`
  INSERT INTO products (user_id, category, code, name, price, cost, stock, stock_alert, unit, note, colors, pack_size, warehouse_id)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
`).run(user.id, 'تست', 'T-WIPE-1', 'کالای تست وایپ', 150000, 100000, 48, 5, 'عدد', 'یادداشت', 2, 12, whId);
const pid = ins.lastInsertRowid;
if (whId) {
  db.prepare('INSERT OR REPLACE INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)')
    .run(pid, whId, 48);
}

const jwt = require('jsonwebtoken');
const { SECRET } = require('../middleware/auth');
const token = jwt.sign({ id: user.id, role: 'admin', name: 'test' }, SECRET, { expiresIn: '1h' });

const productsRouter = require('../routes/products');
const app = express();
app.use(express.json());
app.use('/api/products', productsRouter);
const server = http.createServer(app);

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function buildMultipart(fields, files) {
  const boundary = '----WipeTest' + Date.now();
  const parts = [];
  for (const [k, v] of Object.entries(fields || {})) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
    ));
  }
  for (const f of files || []) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: ${f.type || 'image/png'}\r\n\r\n`
    ));
    parts.push(f.buf);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

function req(method, urlPath, { fields, files } = {}) {
  return new Promise((resolve, reject) => {
    const { boundary, body } = buildMultipart(fields, files);
    const opts = {
      hostname: '127.0.0.1',
      port: server.address().port,
      path: urlPath,
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length,
      },
    };
    const r = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
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

server.listen(0, async () => {
  try {
    const putRes = await req('PUT', '/api/products/' + pid, {
      fields: { name: 'کالای تست وایپ' },
      files: [{ name: 'images', buf: PNG_1X1, filename: 'a.png' }],
    });
    assert.equal(putRes.status, 200, 'PUT status ' + putRes.status + ' ' + JSON.stringify(putRes.body));
    let row = db.prepare('SELECT stock, pack_size, price, code, note FROM products WHERE id=?').get(pid);
    assert.equal(Number(row.stock), 48, 'stock preserved after image PUT, got ' + row.stock);
    assert.equal(Number(row.pack_size), 12, 'pack_size preserved, got ' + row.pack_size);
    assert.equal(Number(row.price), 150000, 'price preserved, got ' + row.price);
    assert.equal(row.code, 'T-WIPE-1', 'code preserved');
    assert.equal(row.note, 'یادداشت', 'note preserved');

    const postRes = await req('POST', '/api/products/' + pid + '/images', {
      files: [{ name: 'images', buf: PNG_1X1, filename: 'b.png' }],
    });
    assert.equal(postRes.status, 200, 'POST images ' + postRes.status + ' ' + JSON.stringify(postRes.body));
    row = db.prepare('SELECT stock, pack_size, price FROM products WHERE id=?').get(pid);
    assert.equal(Number(row.stock), 48);
    assert.equal(Number(row.pack_size), 12);
    assert.equal(Number(row.price), 150000);

    db.prepare('UPDATE products SET stock=0, pack_size=1, price=0, code=?, note=? WHERE id=?')
      .run('', '', pid);
    const { restoreProductFieldsAfterImageWipe } = require('../lib/restore-product-fields');
    const bakDir = path.join(tmpDir, 'backups');
    fs.mkdirSync(bakDir, { recursive: true });
    const bakPath = path.join(bakDir, 'crm-prewipe.db');
    const bak = new Database(bakPath);
    bak.exec(`CREATE TABLE products (
      id INTEGER PRIMARY KEY, stock REAL, pack_size INTEGER, price REAL, code TEXT, note TEXT
    )`);
    bak.prepare('INSERT INTO products (id,stock,pack_size,price,code,note) VALUES (?,?,?,?,?,?)')
      .run(pid, 48, 12, 150000, 'T-WIPE-1', 'یادداشت');
    bak.close();
    // Empty decoy .db must not block the real backup (prod bug: pre-prod empty snapshot)
    const emptyBak = new Database(path.join(bakDir, 'zzz-empty-newer.db'));
    emptyBak.exec(`CREATE TABLE products (
      id INTEGER PRIMARY KEY, stock REAL, pack_size INTEGER, price REAL, code TEXT, note TEXT
    )`);
    emptyBak.close();
    const summary = restoreProductFieldsAfterImageWipe(db, { backupsDir: bakDir });
    row = db.prepare('SELECT stock, pack_size, price, code, note FROM products WHERE id=?').get(pid);
    assert.equal(Number(row.stock), 48, 'stock restored from warehouse');
    assert.equal(Number(row.pack_size), 12, 'pack restored from backup');
    assert.equal(Number(row.price), 150000, 'price restored from backup');
    assert.equal(row.code, 'T-WIPE-1');
    assert.equal(row.note, 'یادداشت');
    assert.ok(summary.stockFromWarehouse >= 1 || summary.packRestored >= 1);
    assert.ok((summary.priceRestored || 0) >= 1 && (summary.codeRestored || 0) >= 1, 'price+code from backup despite empty sibling db');

    console.log('OK product-image-stock-wipe', { pid, summary });
    server.close();
    process.exit(0);
  } catch (e) {
    console.error('FAIL', e);
    server.close();
    process.exit(1);
  }
});
