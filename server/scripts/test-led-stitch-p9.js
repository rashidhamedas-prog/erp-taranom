/**
 * LED-STITCH-P9 — LED-01 shared financial + stock ledgers.
 * Run: node server/scripts/test-led-stitch-p9.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'led-stitch-p9-'));
const dbFile = path.join(dir, 't.db');
try { fs.unlinkSync(dbFile); } catch (_) {}
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-led-stitch-p9-secret-32-bytes-min';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

delete require.cache[require.resolve('../db')];
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const { postToLedger } = require('../lib/ledger');
const { acct } = require('../lib/coa-map');
const { postInventoryMovement } = require('../lib/inventory/ledger');
const { parseCsvTotals } = require('../lib/ledgers');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

function identity(opening, periodNet, closing) {
  return Math.abs(Number(opening) + Number(periodNet) - Number(closing)) < 1;
}

(async () => {
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
  const token = issueStaffSession(db, admin, {
    device_kind: 'test',
    device_name: 'led-stitch-p9',
    device_fingerprint: 'led-stitch-p9-fp',
  }).token;

  const salesId = db.prepare(`
    INSERT INTO users (name, username, password, role, active, must_change_password)
    VALUES ('فروشنده دفتر','sales.led',?, 'field_sales', 1, 0)
  `).run(bcrypt.hashSync('SalesLed9', 10)).lastInsertRowid;
  const salesUser = db.prepare('SELECT id,username,role,name,phone,auth_epoch FROM users WHERE id=?').get(salesId);
  const salesTok = issueStaffSession(db, salesUser, {
    device_kind: 'test',
    device_name: 'led-sales',
    device_fingerprint: 'led-sales-fp',
  }).token;

  const app = express();
  app.use(express.json());
  app.use('/api/ledgers', require('../routes/ledgers'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const BASE = `http://127.0.0.1:${port}`;

  async function api(method, p, tok) {
    const res = await fetch(BASE + p, {
      method,
      headers: {
        Authorization: 'Bearer ' + (tok || token),
      },
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { data = text; }
    return { status: res.status, data, text };
  }

  const equity = acct(db, 'coa_opening_balance');
  ok(!!equity?.code, 'opening-balance COA', equity);

  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES ('1102-led1','بانک تست دفتر','asset','1102',4,1)
  `).run();
  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES ('1101-led1','صندوق تست دفتر','asset','1101',4,1)
  `).run();
  db.prepare(`
    INSERT INTO chart_of_accounts (code,name,type,parent_code,level,is_active)
    VALUES ('11039901','شخص تست دفتر','asset','1103',4,1)
  `).run();

  const bankId = db.prepare(`
    INSERT INTO banks (name, account_number, active, coa_code) VALUES ('ملت دفتر','010203',1,'1102-led1')
  `).run().lastInsertRowid;
  const cashId = db.prepare(`
    INSERT INTO cash_boxes (name, custodian, is_petty_cash, active, coa_code)
    VALUES ('صندوق دفتر','علی',0,1,'1101-led1')
  `).run().lastInsertRowid;
  const pettyId = db.prepare(`
    INSERT INTO cash_boxes (name, custodian, is_petty_cash, active, coa_code)
    VALUES ('تنخواه دفتر','رضا',1,1,'1101-led1')
  `).run().lastInsertRowid;
  const personGlId = db.prepare(`
    INSERT INTO persons (name, phone, coa_code, active) VALUES ('شریک دفتر','09120001111','11039901',1)
  `).run().lastInsertRowid;
  const personOnlyId = db.prepare(`
    INSERT INTO persons (name, phone, active) VALUES ('شخص فقط معین','09120002222',1)
  `).run().lastInsertRowid;
  db.prepare(`
    INSERT INTO person_ledger (person_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
    VALUES (?,'1405/02/01','opening','opening',NULL,'مانده اول',200000,0,?)
  `).run(personOnlyId, admin.id);
  db.prepare(`
    INSERT INTO person_ledger (person_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
    VALUES (?,'1405/04/10','adjustment','invoice',1,'بدهی دوره',50000,0,?)
  `).run(personOnlyId, admin.id);

  postToLedger(db, {
    sourceType: 'opening',
    sourceId: 1,
    date: '1405/02/01',
    description: 'افتتاحیه نقد و بانک',
    createdBy: admin.id,
    lines: [
      { code: '1101-led1', name: 'صندوق تست دفتر', debit: 100000, credit: 0 },
      { code: '1102-led1', name: 'بانک تست دفتر', debit: 80000, credit: 0 },
      { code: '11039901', name: 'شخص تست دفتر', debit: 40000, credit: 0 },
      { code: equity.code, name: equity.name, debit: 0, credit: 220000 },
    ],
  });
  postToLedger(db, {
    sourceType: 'invoice',
    sourceId: 7,
    date: '1405/04/15',
    description: 'گردش دوره دفتر',
    createdBy: admin.id,
    lines: [
      { code: '1101-led1', name: 'صندوق تست دفتر', debit: 25000, credit: 0 },
      { code: '1102-led1', name: 'بانک تست دفتر', debit: 15000, credit: 0 },
      { code: '11039901', name: 'شخص تست دفتر', debit: 10000, credit: 0 },
      { code: equity.code, name: equity.name, debit: 0, credit: 50000 },
    ],
  });

  const wh = db.prepare("SELECT id FROM warehouses WHERE active=1 ORDER BY id LIMIT 1").get();
  ok(!!wh?.id, 'warehouse exists', wh);
  const prodId = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit)
    VALUES (?, 'کالای دفتر', 'LED-SKU', 10000, 0, 'عدد')
  `).run(admin.id).lastInsertRowid;
  db.transaction(() => {
    postInventoryMovement(db, {
      eventType: 'opening', productId: prodId, warehouseId: wh.id,
      qty: 20, unitCostRial: 40000, sourceType: 'opening', sourceId: 1,
      date: '1405/02/01', note: 'موجودی اول دوره', createdBy: admin.id,
    });
    postInventoryMovement(db, {
      eventType: 'sale', productId: prodId, warehouseId: wh.id,
      qty: -5, sourceType: 'invoice', sourceId: 7,
      date: '1405/04/15', note: 'فروش دوره', createdBy: admin.id,
    });
  })();

  const from = '1405/03/01';
  const to = '1405/12/29';
  const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  console.log('\n— identity account / bank / person —');
  let r = await api('GET', `/api/ledgers/financial?entity_type=account&entity_id=${encodeURIComponent('1101-led1')}&${q}`);
  ok(r.status === 200, 'account financial 200', r.data?.error);
  ok(identity(r.data.opening_rial, r.data.period_net_rial, r.data.closing_rial),
    'account opening+period=closing',
    `${r.data.opening_rial}+${r.data.period_net_rial}=${r.data.closing_rial}`);
  ok(Number(r.data.opening_rial) === 1_000_000, 'account opening 1e6 rial', r.data.opening_rial);
  ok(Number(r.data.period_debit_rial) === 250_000, 'account period debit 250k', r.data.period_debit_rial);
  ok(r.data.lines?.every((l) => l.journal_id != null), 'account lines have journal_id');
  ok(r.data.lines?.some((l) => l.ref_type === 'invoice' && l.ref_id === 7),
    'account invoice source-doc link', r.data.lines?.[0]);

  const bankR = await api('GET', `/api/ledgers/financial?entity_type=bank&entity_id=${bankId}&${q}`);
  ok(bankR.status === 200, 'bank financial 200', bankR.data?.error);
  ok(identity(bankR.data.opening_rial, bankR.data.period_net_rial, bankR.data.closing_rial),
    'bank opening+period=closing',
    `${bankR.data.opening_rial}+${bankR.data.period_net_rial}=${bankR.data.closing_rial}`);
  ok(Number(bankR.data.opening_rial) === 800_000, 'bank opening 800k', bankR.data.opening_rial);

  const personR = await api('GET', `/api/ledgers/financial?entity_type=person&entity_id=${personGlId}&${q}`);
  ok(personR.status === 200 && personR.data.source === 'gl', 'person prefers GL', personR.data?.source);
  ok(identity(personR.data.opening_rial, personR.data.period_net_rial, personR.data.closing_rial),
    'person GL opening+period=closing',
    `${personR.data.opening_rial}+${personR.data.period_net_rial}=${personR.data.closing_rial}`);

  const plR = await api('GET', `/api/ledgers/financial?entity_type=person&entity_id=${personOnlyId}&${q}`);
  ok(plR.status === 200 && plR.data.source === 'person_ledger', 'person_ledger fallback labeled', plR.data?.source);
  ok(identity(plR.data.opening_rial, plR.data.period_net_rial, plR.data.closing_rial),
    'person_ledger opening+period=closing',
    `${plR.data.opening_rial}+${plR.data.period_net_rial}=${plR.data.closing_rial}`);
  ok(Number(plR.data.opening_rial) === 200000 && Number(plR.data.closing_rial) === 250000,
    'person_ledger totals', plR.data);

  const cashR = await api('GET', `/api/ledgers/financial?entity_type=cash&entity_id=${cashId}&${q}`);
  ok(cashR.status === 200, 'cash financial 200', cashR.data?.error);
  const pettyWrong = await api('GET', `/api/ledgers/financial?entity_type=cash&entity_id=${pettyId}&${q}`);
  ok(pettyWrong.status === 400, 'cash on petty box 400', pettyWrong.status);
  const pettyR = await api('GET', `/api/ledgers/financial?entity_type=petty&entity_id=${pettyId}&${q}`);
  ok(pettyR.status === 200, 'petty financial 200', pettyR.data?.error);

  console.log('\n— stock vs warehouse / kardex qty —');
  const stockR = await api('GET', `/api/ledgers/stock?product_id=${prodId}&warehouse_id=${wh.id}&${q}`);
  ok(stockR.status === 200, 'stock 200', stockR.data?.error);
  ok(identity(stockR.data.opening_qty, stockR.data.period_net_qty, stockR.data.closing_qty),
    'stock opening+period=closing',
    `${stockR.data.opening_qty}+${stockR.data.period_net_qty}=${stockR.data.closing_qty}`);
  ok(Number(stockR.data.opening_qty) === 20, 'stock opening 20', stockR.data.opening_qty);
  ok(Number(stockR.data.period_qty_out) === 5, 'stock period out 5', stockR.data.period_qty_out);
  ok(Number(stockR.data.closing_qty) === 15, 'stock closing 15', stockR.data.closing_qty);
  const ws = db.prepare(
    'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
  ).get(prodId, wh.id);
  ok(Number(ws?.qty) === 15, 'warehouse_stock qty=15', ws?.qty);
  const prod = db.prepare('SELECT stock FROM products WHERE id=?').get(prodId);
  ok(Number(prod.stock) === 15, 'products.stock=15', prod.stock);
  ok(Number(stockR.data.warehouse_qty) === 15, 'API warehouse_qty=15', stockR.data.warehouse_qty);
  ok(stockR.data.lines?.some((l) => l.ref_type === 'invoice' && l.ref_id === 7),
    'stock invoice source-doc link');

  console.log('\n— export totals match JSON —');
  const exp = await api('GET', `/api/ledgers/financial/export?format=csv&entity_type=account&entity_id=${encodeURIComponent('1101-led1')}&${q}`);
  ok(exp.status === 200 && typeof exp.text === 'string', 'financial export 200');
  const expTotals = parseCsvTotals(exp.text);
  ok(Number(expTotals.opening) === Number(r.data.opening_rial), 'export opening=JSON', expTotals.opening);
  ok(Number(expTotals.period_debit) === Number(r.data.period_debit_rial), 'export period debit=JSON', expTotals.period_debit);
  ok(Number(expTotals.period_credit) === Number(r.data.period_credit_rial), 'export period credit=JSON', expTotals.period_credit);
  ok(Number(expTotals.closing) === Number(r.data.closing_rial), 'export closing=JSON', expTotals.closing);
  ok(Number(expTotals.period_net) === Number(r.data.period_net_rial), 'export period net=JSON', expTotals.period_net);

  const stockExp = await api('GET', `/api/ledgers/stock/export?format=csv&product_id=${prodId}&warehouse_id=${wh.id}&${q}`);
  ok(stockExp.status === 200, 'stock export 200');
  const stExp = parseCsvTotals(stockExp.text);
  ok(Number(stExp.opening) === Number(stockR.data.opening_qty), 'stock export opening=JSON', stExp.opening);
  ok(Number(stExp.closing) === Number(stockR.data.closing_qty), 'stock export closing=JSON', stExp.closing);

  console.log('\n— RBAC + invalid —');
  const fsFin = await api('GET', `/api/ledgers/financial?entity_type=account&entity_id=${encodeURIComponent('1101-led1')}`, salesTok);
  ok(fsFin.status === 403, 'field_sales financial 403', fsFin.status);
  const fsStock = await api('GET', `/api/ledgers/stock?product_id=${prodId}`, salesTok);
  ok(fsStock.status === 403, 'field_sales stock 403', fsStock.status);
  const fsExp = await api('GET', `/api/ledgers/financial/export?format=csv&entity_type=account&entity_id=${encodeURIComponent('1101-led1')}`, salesTok);
  ok(fsExp.status === 403, 'field_sales export 403', fsExp.status);

  const badType = await api('GET', '/api/ledgers/financial?entity_type=wallet&entity_id=1');
  ok(badType.status === 400, 'invalid entity_type 400', badType.status);
  const missing = await api('GET', '/api/ledgers/financial?entity_type=person');
  ok(missing.status === 400, 'missing entity_id 400', missing.status);
  const noPerson = await api('GET', '/api/ledgers/financial?entity_type=person&entity_id=999999');
  ok(noPerson.status === 404, 'missing person 404', noPerson.status);
  const noAcct = await api('GET', '/api/ledgers/financial?entity_type=account&entity_id=NO-SUCH');
  ok(noAcct.status === 404, 'missing account 404', noAcct.status);
  const noProd = await api('GET', '/api/ledgers/stock?product_id=999999');
  ok(noProd.status === 404, 'missing product 404', noProd.status);
  const badDate = await api('GET', `/api/ledgers/financial?entity_type=account&entity_id=${encodeURIComponent('1101-led1')}&from=not-a-date`);
  ok(badDate.status === 400, 'invalid from date 400', badDate.status);

  const { SYNCABLE_TABLES } = require('../sync/tables');
  ok(!SYNCABLE_TABLES.some((t) => t.name === 'ledgers'), 'no new SYNCABLE table');

  server.close();
  try { closeSessionStore(); } catch (_) {}
  console.log(`\nLED-P9: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
