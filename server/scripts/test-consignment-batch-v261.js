/**
 * CON-03 — multi-line consignment document (master–detail).
 * Run: node server/scripts/test-consignment-batch-v261.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'con-batch-v261-'));
const dbFile = path.join(dir, 't.db');
try { fs.unlinkSync(dbFile); } catch (_) {}
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-con-batch-v261-secret-32-bytes!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

delete require.cache[require.resolve('../db')];
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const { warehouseQty } = require('../lib/inventory/ledger');
const { SYNCABLE_TABLES, FK_COLUMNS } = require('../sync/tables');

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
    device_name: 'con-batch-v261',
    device_fingerprint: 'con-batch-v261-fp',
  }).token;

  const app = express();
  app.use(express.json());
  app.use('/api/consignments', require('../routes/consignments'));
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

  console.log('\n— schema + sync hygiene —');
  ok(!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='consignment_docs'").get(),
    'consignment_docs table');
  const cols = db.prepare('PRAGMA table_info(consignments)').all().map((c) => c.name);
  ok(cols.includes('doc_id'), 'consignments.doc_id');
  ok(cols.includes('line_no'), 'consignments.line_no');
  ok(SYNCABLE_TABLES.some((t) => t.name === 'consignment_docs'), 'SYNCABLE consignment_docs');
  ok(FK_COLUMNS.some((x) => x[0] === 'consignments' && x[1] === 'doc_id'), 'FK consignments.doc_id');
  ok(FK_COLUMNS.some((x) => x[0] === 'consignment_docs' && x[1] === 'person_id'), 'FK docs.person_id');
  ok(!!db.prepare('SELECT 1 FROM number_sequences WHERE key=?').get('consignment'), 'seq consignment');

  let wh = db.prepare('SELECT * FROM warehouses WHERE COALESCE(active,1)=1 ORDER BY id LIMIT 1').get();
  if (!wh) {
    db.prepare("INSERT INTO warehouses (name, active, is_default) VALUES ('انبار تست',1,1)").run();
    wh = db.prepare('SELECT * FROM warehouses ORDER BY id DESC LIMIT 1').get();
  }
  const personId = db.prepare(`
    INSERT INTO persons (name, phone) VALUES ('شخص امانی تجمعی','09120000061')
  `).run().lastInsertRowid;

  const p1 = db.prepare(`
    INSERT INTO products (name, code, stock, cost, price, warehouse_id)
    VALUES ('کالای امانی A','CS-A',100,10000,20000,?)
  `).run(wh.id).lastInsertRowid;
  const p2 = db.prepare(`
    INSERT INTO products (name, code, stock, cost, price, warehouse_id)
    VALUES ('کالای امانی B','CS-B',80,8000,18000,?)
  `).run(wh.id).lastInsertRowid;
  db.prepare(`
    INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)
    ON CONFLICT(product_id, warehouse_id) DO UPDATE SET qty=excluded.qty
  `).run(p1, wh.id, 100);
  db.prepare(`
    INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)
    ON CONFLICT(product_id, warehouse_id) DO UPDATE SET qty=excluded.qty
  `).run(p2, wh.id, 80);

  console.log('\n— batch create (out) atomic —');
  const qty1Before = warehouseQty(db, p1, wh.id);
  const qty2Before = warehouseQty(db, p2, wh.id);
  const batch = await api('POST', '/api/consignments', {
    direction: 'out',
    person_id: personId,
    warehouse_id: wh.id,
    date: '1405/07/07',
    note: 'سند تجمعی تست',
    lines: [
      { product_id: p1, qty: 5, unit_price_rial: 200000 },
      { product_id: p2, qty: 3, unit_price_rial: 150000 },
    ],
  });
  ok(batch.status === 200 && batch.data && batch.data.count === 2, 'batch 200 count=2', batch.data);
  ok(batch.data && batch.data.doc_id && batch.data.doc_num, 'doc_id + doc_num', batch.data && batch.data.doc_num);
  ok(String(batch.data.doc_num).startsWith('CS-'), 'num prefix CS-', batch.data && batch.data.doc_num);
  ok(Array.isArray(batch.data.lines) && batch.data.lines.length === 2, 'lines array');
  ok(warehouseQty(db, p1, wh.id) === qty1Before - 5, 'stock p1 -5', warehouseQty(db, p1, wh.id));
  ok(warehouseQty(db, p2, wh.id) === qty2Before - 3, 'stock p2 -3', warehouseQty(db, p2, wh.id));

  const docGet = await api('GET', '/api/consignments/docs/' + batch.data.doc_id);
  ok(docGet.status === 200 && docGet.data && docGet.data.lines.length === 2, 'GET doc+lines');
  ok(docGet.data.status === 'open', 'doc status open');

  console.log('\n— legacy single-line still works —');
  const single = await api('POST', '/api/consignments', {
    direction: 'in',
    person_id: personId,
    warehouse_id: wh.id,
    product_id: p1,
    qty: 2,
    unit_price_rial: 100000,
  });
  ok(single.status === 200 && single.data && single.data.id, 'legacy single id', single.data);
  ok(single.data.doc_id && single.data.count === 1, 'legacy wraps as 1-line doc');

  console.log('\n— duplicate line rejected —');
  const dup = await api('POST', '/api/consignments', {
    direction: 'out',
    person_id: personId,
    warehouse_id: wh.id,
    lines: [
      { product_id: p1, qty: 1, unit_price_rial: 1 },
      { product_id: p1, qty: 2, unit_price_rial: 1 },
    ],
  });
  ok(dup.status === 400 && dup.data && dup.data.code === 'E_CONSIGNMENT_DUP_LINE', 'dup line 400', dup.data);

  console.log('\n— empty lines rejected —');
  const empty = await api('POST', '/api/consignments', {
    direction: 'out', person_id: personId, warehouse_id: wh.id, lines: [],
  });
  ok(empty.status === 400, 'empty lines 400');

  console.log('\n— partial settle → doc partial —');
  const lineA = batch.data.lines[0];
  const ret = await api('POST', '/api/consignments/' + lineA.id + '/settle', { path: 'return' });
  ok(ret.status === 200 && ret.data.status === 'returned', 'settle one line return');
  const docAfter = db.prepare('SELECT status FROM consignment_docs WHERE id=?').get(batch.data.doc_id);
  ok(docAfter && docAfter.status === 'partial', 'doc status partial', docAfter);

  console.log('\n— void whole document —');
  const qty1Mid = warehouseQty(db, p1, wh.id);
  const qty2Mid = warehouseQty(db, p2, wh.id);
  const voidDoc = await api('POST', '/api/consignments/docs/' + batch.data.doc_id + '/cancel', {});
  ok(voidDoc.status === 200 && voidDoc.data && voidDoc.data.ok, 'void doc ok', voidDoc.data);
  const linesAfter = db.prepare('SELECT status FROM consignments WHERE doc_id=?').all(batch.data.doc_id);
  ok(linesAfter.every((l) => l.status === 'reversed'), 'all lines reversed', linesAfter);
  const docFin = db.prepare('SELECT status,record_status FROM consignment_docs WHERE id=?').get(batch.data.doc_id);
  ok(docFin && docFin.status === 'reversed' && docFin.record_status === 'reversed', 'doc reversed', docFin);
  // lineA was returned (stock already restored); voiding return reverses that receipt again?
  // voidConsignmentLineCore reverseStockBySource reverses ALL stock from source — returned line had receipt;
  // issue was already "consumed" by return. Net: void of returned line reverses the return receipt.
  // lineB was still open (issue outstanding) — void restocks.
  ok(warehouseQty(db, p2, wh.id) === qty2Mid + 3, 'void open out restocks p2', warehouseQty(db, p2, wh.id));
  ok(db.prepare('SELECT COUNT(*) AS c FROM consignments WHERE doc_id=?').get(batch.data.doc_id).c === 2,
    'no physical delete of lines');

  console.log('\n— list includes doc_num —');
  const listed = await api('GET', '/api/consignments');
  ok(listed.status === 200 && Array.isArray(listed.data), 'list ok');
  const withNum = (listed.data || []).filter((r) => r.doc_num);
  ok(withNum.length >= 1, 'list has doc_num');

  server.close();
  try { closeSessionStore(); } catch (_) {}
  console.log('\n' + (fail ? 'FAILED' : 'PASSED') + ` ${pass} ok / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
