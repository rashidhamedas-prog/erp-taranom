/**
 * CON-STITCH-P7 — CON-01 person/warehouse + CON-02 four settle paths + R13.
 * Run: node server/scripts/test-con-stitch-p7.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'con-stitch-p7-'));
const dbFile = path.join(dir, 't.db');
try { fs.unlinkSync(dbFile); } catch (_) {}
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-con-stitch-p7-secret-32-bytes-min';
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
const { FK_COLUMNS } = require('../sync/tables');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

function jeBalanced(jeId) {
  if (!jeId) return false;
  const row = db.prepare(`
    SELECT COALESCE(SUM(debit_rial),0) AS d, COALESCE(SUM(credit_rial),0) AS c
    FROM journal_lines WHERE entry_id=?
  `).get(jeId);
  return Math.abs((Number(row.d) || 0) - (Number(row.c) || 0)) < 1;
}

(async () => {
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test',
    device_name: 'con-stitch-p7',
    device_fingerprint: 'con-stitch-p7-fp',
  }).token;

  const salesId = db.prepare(`
    INSERT INTO users (name, username, password, role, active, must_change_password)
    VALUES ('فروشنده امانی','sales.con',?, 'field_sales', 1, 0)
  `).run(bcrypt.hashSync('SalesCon9', 10)).lastInsertRowid;
  const salesUser = db.prepare('SELECT id,username,role,name,phone,auth_epoch FROM users WHERE id=?').get(salesId);
  const salesTok = issueStaffSession(db, salesUser, {
    device_kind: 'test',
    device_name: 'con-sales',
    device_fingerprint: 'con-sales-fp',
  }).token;

  const app = express();
  app.use(express.json());
  app.use('/api/consignments', require('../routes/consignments'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const BASE = `http://127.0.0.1:${port}`;

  async function api(method, p, body, tok) {
    const res = await fetch(BASE + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (tok || token),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  }

  console.log('\n— schema + sync —');
  const cols = db.prepare('PRAGMA table_info(consignments)').all().map((c) => c.name);
  ['person_id', 'warehouse_id', 'invoice_id', 'settle_path', 'settle_je_id', 'issue_ledger_id', 'record_status', 'unit_price_rial']
    .forEach((c) => ok(cols.includes(c), 'column ' + c));
  ok(FK_COLUMNS.some((x) => x[0] === 'consignments' && x[1] === 'person_id'), 'FK person_id');
  ok(FK_COLUMNS.some((x) => x[0] === 'consignments' && x[1] === 'warehouse_id'), 'FK warehouse_id');
  ok(FK_COLUMNS.some((x) => x[0] === 'consignments' && x[1] === 'invoice_id'), 'FK invoice_id');
  ok(FK_COLUMNS.some((x) => x[0] === 'consignments' && x[1] === 'settle_je_id'), 'FK settle_je_id');
  ok(FK_COLUMNS.some((x) => x[0] === 'consignments' && x[1] === 'issue_ledger_id'), 'FK issue_ledger_id');
  const fkTail = FK_COLUMNS.slice(-2);
  ok(fkTail[0][1] === 'settle_je_id' && fkTail[1][1] === 'issue_ledger_id', 'COGS/issue FKs appended at end');

  let wh = db.prepare('SELECT id FROM warehouses WHERE COALESCE(active,1)=1 ORDER BY id LIMIT 1').get();
  if (!wh) {
    wh = { id: db.prepare("INSERT INTO warehouses (name, code, active) VALUES ('انبار امانی','WH-CON',1)").run().lastInsertRowid };
  }
  const personId = db.prepare("INSERT INTO persons (name, phone) VALUES ('امین امانی','09121112233')").run().lastInsertRowid;
  const personIn = db.prepare("INSERT INTO persons (name, phone) VALUES ('تأمین‌کننده امانی','09123334455')").run().lastInsertRowid;
  const pidOut = db.prepare(`
    INSERT INTO products (user_id, name, code, stock, warehouse_id, average_cost_rial, cost)
    VALUES (?,'مانتو ارسالی','CON-OUT',20,?,100000,10000)
  `).run(admin.id, wh.id).lastInsertRowid;
  db.prepare('INSERT OR REPLACE INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,20)').run(pidOut, wh.id);
  const pidIn = db.prepare(`
    INSERT INTO products (user_id, name, code, stock, warehouse_id, average_cost_rial, cost)
    VALUES (?,'شال دریافتی','CON-IN',10,?,80000,8000)
  `).run(admin.id, wh.id).lastInsertRowid;
  db.prepare('INSERT OR REPLACE INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,10)').run(pidIn, wh.id);

  console.log('\n— CON-01 create —');
  const missing = await api('POST', '/api/consignments', {
    direction: 'out', party_name: 'بدون شخص', product_id: pidOut, qty: 2,
  });
  ok(missing.status === 400 && missing.data && missing.data.code === 'E_PERSON_REQUIRED',
    'create without person_id → 400', missing.status + ' ' + (missing.data && missing.data.error));

  const createdOut = await api('POST', '/api/consignments', {
    direction: 'out', person_id: personId, product_id: pidOut, qty: 5,
    warehouse_id: wh.id, unit_price: 500000, unit_price_rial: 500000,
  });
  ok(createdOut.status === 200 && createdOut.data && createdOut.data.id, 'create out 200', createdOut.data && createdOut.data.error);
  ok(createdOut.data && createdOut.data.person_id === personId, 'person_id stored');
  ok(createdOut.data && createdOut.data.party_name === 'امین امانی', 'party_name snapshot');
  ok(warehouseQty(db, pidOut, wh.id) === 15, 'out issues warehouse qty 20→15', warehouseQty(db, pidOut, wh.id));

  const createdIn = await api('POST', '/api/consignments', {
    direction: 'in', person_id: personIn, product_id: pidIn, qty: 3,
    warehouse_id: wh.id, unit_price: 200000, unit_price_rial: 200000,
  });
  ok(createdIn.status === 200, 'create in 200', createdIn.data && createdIn.data.error);
  ok(warehouseQty(db, pidIn, wh.id) === 10, 'in does not add warehouse qty', warehouseQty(db, pidIn, wh.id));

  const listed = await api('GET', '/api/consignments');
  ok(listed.status === 200 && Array.isArray(listed.data) && listed.data.some((r) => r.person_name === 'امین امانی'),
    'GET list JOIN person_name');

  console.log('\n— sales role 403 —');
  const salesCreate = await api('POST', '/api/consignments', {
    direction: 'out', person_id: personId, product_id: pidOut, qty: 1, warehouse_id: wh.id,
  }, salesTok);
  ok(salesCreate.status === 403, 'sales role 403', String(salesCreate.status));

  console.log('\n— return + idempotent —');
  const previewRet = await api('POST', '/api/consignments/' + createdOut.data.id + '/settle', { path: 'return', preview: true });
  ok(previewRet.status === 200 && previewRet.data && previewRet.data.preview === true, 'return preview');
  ok(warehouseQty(db, pidOut, wh.id) === 15, 'preview does not write stock', warehouseQty(db, pidOut, wh.id));
  ok(db.prepare('SELECT status FROM consignments WHERE id=?').get(createdOut.data.id).status === 'open', 'preview keeps open');

  const ret = await api('POST', '/api/consignments/' + createdOut.data.id + '/settle', { path: 'return' });
  ok(ret.status === 200 && ret.data && ret.data.status === 'returned', 'return settles', ret.data);
  ok(warehouseQty(db, pidOut, wh.id) === 20, 'return restocks out 15→20', warehouseQty(db, pidOut, wh.id));
  const ret2 = await api('POST', '/api/consignments/' + createdOut.data.id + '/settle', { path: 'return' });
  ok(ret2.status === 409 && ret2.data && ret2.data.code === 'E_CONSIGNMENT_SETTLED',
    'second settle 409', ret2.status + ' ' + (ret2.data && ret2.data.code));

  console.log('\n— sale invoice no double stock —');
  const saleOut = await api('POST', '/api/consignments', {
    direction: 'out', person_id: personId, product_id: pidOut, qty: 4,
    warehouse_id: wh.id, unit_price: 400000, unit_price_rial: 400000,
  });
  ok(saleOut.status === 200, 'sale-source out 200', saleOut.data && saleOut.data.error);
  const qtyAfterIssue = warehouseQty(db, pidOut, wh.id);
  const sale = await api('POST', '/api/consignments/' + saleOut.data.id + '/settle', { path: 'sale' });
  ok(sale.status === 200 && sale.data && sale.data.status === 'sold', 'sale status sold', sale.data);
  ok(sale.data && sale.data.invoice_id, 'sale creates invoice', sale.data);
  ok(warehouseQty(db, pidOut, wh.id) === qtyAfterIssue, 'sale does not drop warehouse twice', warehouseQty(db, pidOut, wh.id));
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(sale.data.invoice_id);
  ok(inv && inv.type === 'normal' && Number(inv.stock_deducted) === 0, 'invoice normal stock_deducted=0');
  const invJe = db.prepare("SELECT id FROM journal_entries WHERE ref_type='invoice' AND ref_id=? AND COALESCE(deleted_at,0)=0").get(inv.id);
  ok(invJe && jeBalanced(invJe.id), 'invoice JE balanced', invJe && invJe.id);
  ok(sale.data && sale.data.settle_je_id, 'out+sale stores COGS on settle_je_id', sale.data);
  ok(jeBalanced(sale.data.settle_je_id), 'COGS JE balanced');
  const cogsHead = db.prepare('SELECT ref_type FROM journal_entries WHERE id=?').get(sale.data.settle_je_id);
  ok(cogsHead && cogsHead.ref_type === 'consignment_cogs', 'COGS ref_type consignment_cogs', cogsHead);
  const cogsLines = db.prepare('SELECT account_code, debit_rial, credit_rial FROM journal_lines WHERE entry_id=?').all(sale.data.settle_je_id);
  ok(cogsLines.some((l) => Number(l.debit_rial) > 0) && cogsLines.some((l) => Number(l.credit_rial) > 0),
    'COGS has inventory credit and expense debit', cogsLines);

  console.log('\n— M1 in+sale explicit buyer —');
  const inNoBuyer = await api('POST', '/api/consignments/' + createdIn.data.id + '/settle', { path: 'sale' });
  ok(inNoBuyer.status === 400 && inNoBuyer.data && inNoBuyer.data.code === 'E_CONSIGNMENT_BUYER',
    'in+sale without buyer → 400', inNoBuyer.status + ' ' + (inNoBuyer.data && inNoBuyer.data.code));
  const inSelf = await api('POST', '/api/consignments/' + createdIn.data.id + '/settle', {
    path: 'sale', buyer_person_id: personIn,
  });
  ok(inSelf.status === 400 && inSelf.data && inSelf.data.code === 'E_CONSIGNMENT_BUYER',
    'in+sale buyer=consignor → 400', inSelf.data);
  const buyerCustId = db.prepare(`
    INSERT INTO customers (user_id, biz, owner, phone, type, status)
    VALUES (?, 'بوتیک خریدار', 'خریدار امانی', '09125556677', 'بوتیک', 'active')
  `).run(admin.id).lastInsertRowid;
  const inSale = await api('POST', '/api/consignments/' + createdIn.data.id + '/settle', {
    path: 'sale', cust_id: buyerCustId,
  });
  ok(inSale.status === 200 && inSale.data && inSale.data.invoice_id, 'in+sale with other customer', inSale.data);
  const inInv = db.prepare('SELECT cust_id FROM invoices WHERE id=?').get(inSale.data.invoice_id);
  ok(inInv && Number(inInv.cust_id) === Number(buyerCustId), 'invoice is the buyer not consignor', inInv);
  const consignorCust = db.prepare("SELECT id FROM customers WHERE note LIKE ?").get('%consignment person#' + personIn + '%');
  ok(!consignorCust || Number(inInv.cust_id) !== Number(consignorCust.id), 'invoice customer is not consignor-linked');

  console.log('\n— purchase in —');
  const purchIn = await api('POST', '/api/consignments', {
    direction: 'in', person_id: personIn, product_id: pidIn, qty: 2,
    warehouse_id: wh.id, unit_price: 150000, unit_price_rial: 150000,
  });
  const qtyBeforePurch = warehouseQty(db, pidIn, wh.id);
  const purch = await api('POST', '/api/consignments/' + purchIn.data.id + '/settle', { path: 'purchase' });
  ok(purch.status === 200 && purch.data && purch.data.status === 'purchased', 'purchase in', purch.data);
  ok(warehouseQty(db, pidIn, wh.id) === qtyBeforePurch + 2, 'purchase receipts stock', warehouseQty(db, pidIn, wh.id));
  ok(purch.data && purch.data.settle_je_id && jeBalanced(purch.data.settle_je_id), 'purchase JE balanced');

  const purchOut = await api('POST', '/api/consignments/' + saleOut.data.id + '/settle', { path: 'purchase' });
  ok(purchOut.status === 409 || purchOut.status === 400, 'purchase on settled/out rejected', String(purchOut.status));

  const openOutForPurch = await api('POST', '/api/consignments', {
    direction: 'out', person_id: personId, product_id: pidOut, qty: 1,
    warehouse_id: wh.id, unit_price: 100000, unit_price_rial: 100000,
  });
  const badPurch = await api('POST', '/api/consignments/' + openOutForPurch.data.id + '/settle', { path: 'purchase' });
  ok(badPurch.status === 400 && badPurch.data && badPurch.data.code === 'E_CONSIGNMENT_PATH',
    'out + purchase 400', badPurch.data);

  console.log('\n— shortage no restock —');
  const shortOut = await api('POST', '/api/consignments', {
    direction: 'out', person_id: personId, product_id: pidOut, qty: 2,
    warehouse_id: wh.id, unit_price: 250000, unit_price_rial: 250000,
  });
  const qtyBeforeShort = warehouseQty(db, pidOut, wh.id);
  const short = await api('POST', '/api/consignments/' + shortOut.data.id + '/settle', { path: 'shortage' });
  ok(short.status === 200 && short.data && short.data.status === 'shortage', 'shortage status');
  ok(warehouseQty(db, pidOut, wh.id) === qtyBeforeShort, 'shortage does not restock', warehouseQty(db, pidOut, wh.id));
  ok(short.data && short.data.settle_je_id && jeBalanced(short.data.settle_je_id), 'shortage JE balanced');

  console.log('\n— R13 cancel / no physical DELETE —');
  const voidSrc = await api('POST', '/api/consignments', {
    direction: 'out', person_id: personId, product_id: pidOut, qty: 3,
    warehouse_id: wh.id, unit_price: 300000, unit_price_rial: 300000,
  });
  const qtyBeforeVoid = warehouseQty(db, pidOut, wh.id);
  const countBefore = db.prepare('SELECT COUNT(*) AS c FROM consignments').get().c;
  const canceled = await api('POST', '/api/consignments/' + voidSrc.data.id + '/cancel', {});
  ok(canceled.status === 200 && canceled.data && canceled.data.status === 'reversed', 'cancel reversed', canceled.data);
  ok(db.prepare('SELECT id,status,record_status FROM consignments WHERE id=?').get(voidSrc.data.id), 'row remains');
  ok(warehouseQty(db, pidOut, wh.id) === qtyBeforeVoid + 3, 'cancel restocks open out', warehouseQty(db, pidOut, wh.id));
  ok(db.prepare('SELECT COUNT(*) AS c FROM consignments').get().c === countBefore, 'no physical DELETE on cancel');

  const saleDel = await api('DELETE', '/api/consignments/' + sale.data.id);
  ok(saleDel.status === 200 && saleDel.data && saleDel.data.status === 'reversed', 'DELETE voids sale row');
  ok(db.prepare('SELECT id FROM consignments WHERE id=?').get(saleOut.data.id), 'sold row still present after DELETE');
  const invAfter = db.prepare('SELECT status,deleted_at FROM invoices WHERE id=?').get(inv.id);
  ok(invAfter && (invAfter.status === 'reversed' || invAfter.deleted_at), 'sale invoice voided');
  const cogsId = sale.data.settle_je_id;
  const cogsRev = db.prepare(`
    SELECT id FROM journal_entries WHERE description LIKE ? AND COALESCE(deleted_at,0)=0
  `).get('ابطال سند #' + cogsId + '%');
  ok(!!cogsRev, 'COGS reversal JE posted on cancel');
  const cogsNet = db.prepare(`
    SELECT account_code,
      COALESCE(SUM(debit_rial),0) AS d, COALESCE(SUM(credit_rial),0) AS c
    FROM journal_lines
    WHERE entry_id IN (?, ?)
    GROUP BY account_code
  `).all(cogsId, cogsRev && cogsRev.id);
  ok(cogsNet.length && cogsNet.every((r) => Math.abs((Number(r.d) || 0) - (Number(r.c) || 0)) < 1),
    'cancel nets COGS/inventory to zero', cogsNet);

  server.close();
  try { closeSessionStore(); } catch (_) {}
  console.log('\nCON-STITCH-P7: ' + (fail ? fail + ' failed' : pass + ' passed') + ` (${pass} ok)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
