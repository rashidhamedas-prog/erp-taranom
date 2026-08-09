'use strict';
/**
 * W1-F1 Moadian foundation tests (temp SQLite, no live SDK).
 */
const path = require('path');
const fs = require('fs');
function loadBetterSqlite3() {
  const candidates = [
    path.join(__dirname, '..', 'node_modules', 'better-sqlite3'),
    path.join(__dirname, '..', '..', '..', 'crm-taranom', 'erp-taranom1', 'server', 'node_modules', 'better-sqlite3'),
    'D:/soft/Claud/porje/crm-taranom/erp-taranom1/server/node_modules/better-sqlite3',
  ];
  for (const c of candidates) {
    try { return require(c); } catch (_) { /* next */ }
  }
  return require('better-sqlite3');
}
const Database = loadBetterSqlite3();
const os = require('os');
const moadian = require('../lib/moadian');

let passed = 0;
let failed = 0;
function ok(name, cond) {
  if (cond) { passed += 1; console.log(`  PASS ${name}`); }
  else { failed += 1; console.error(`  FAIL ${name}`); }
}

const dbPath = path.join(os.tmpdir(), `w1-f1-moadian-${Date.now()}.db`);
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE customers (
    id INTEGER PRIMARY KEY, national_id TEXT, economic_code TEXT, biz TEXT
  );
  CREATE TABLE invoices (
    id INTEGER PRIMARY KEY, type TEXT, num TEXT, date TEXT, final REAL,
    cust_id INTEGER, moadian_invoice_type INTEGER, moadian_tax_id TEXT, moadian_status TEXT,
    moadian_ref_tax_id TEXT, moadian_correction_type TEXT, rows TEXT
  );
  CREATE TABLE moadian_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_type TEXT, doc_id INTEGER, status TEXT, tax_id TEXT,
    invoice_type INTEGER, adapter TEXT, sent_at INTEGER, response_json TEXT,
    retry_count INTEGER DEFAULT 0, next_retry_at INTEGER, last_error TEXT, status_notes TEXT
  );
`);
db.exec(moadian.schemaSql.STATUS_HISTORY_SQL);

db.prepare("INSERT INTO settings(key,value) VALUES('moadian_enabled','1')").run();
db.prepare("INSERT INTO settings(key,value) VALUES('moadian_adapter','stub')").run();
db.prepare("INSERT INTO customers(id,national_id,biz) VALUES(1,'001','Cust')").run();
db.prepare(`INSERT INTO invoices(id,type,num,date,final,cust_id,moadian_invoice_type,rows)
  VALUES(10,'final','T-1','1405/01/01',1000,1,1,'[{"name":"A","qty":1,"price":1000}]')`).run();

console.log('W1-F1 test-moadian-foundation');

const payload = moadian.buildSalesPayload(
  db.prepare('SELECT i.*, c.national_id, c.economic_code FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.id=10').get(),
  { fiscalId: 'FISCAL1' }
);
ok('payload header', !!payload.header && payload.header.fiscalId === 'FISCAL1');
ok('payload body item', Array.isArray(payload.body) && payload.body.length === 1);

const id1 = moadian.enqueueMoadian(db, 'sales', 10);
const id2 = moadian.enqueueMoadian(db, 'sales', 10);
ok('enqueue returns id', !!id1);
ok('enqueue idempotent', id1 === id2);

const stub = moadian.getAdapter('stub');
(async () => {
  const signed = moadian.signPayload(payload);
  const stubRes = await stub.submit({ payload, signed });
  ok('stub submit ok', stubRes.ok && String(stubRes.taxId).startsWith('MOADIAN-'));

  const sandbox = moadian.getAdapter('sandbox');
  let rejected = false;
  try {
    await sandbox.submit({ payload: moadian.buildSalesPayload({ final: 1, rows: [] }, { fiscalId: '' }), signed });
  } catch (e) {
    rejected = e.code === 'MOADIAN_FISCAL_REQUIRED';
  }
  ok('sandbox rejects without fiscal id', rejected);

  const sbxOk = await sandbox.submit({
    payload: moadian.buildSalesPayload({ final: 1, rows: [] }, { fiscalId: 'ABC' }),
    signed,
    fiscalId: 'ABC',
  });
  ok('sandbox accepts with fiscal id', sbxOk.ok && String(sbxOk.taxId).startsWith('SBX-'));

  let liveRejected = false;
  try {
    moadian.getAdapter('live');
  } catch (e) {
    liveRejected = e.code === 'MOADIAN_LIVE_UNAVAILABLE';
  }
  ok('live adapter unavailable', liveRejected);

  moadian.markSent(db, id1, stubRes.taxId, stubRes.response);
  const sent = db.prepare('SELECT * FROM moadian_queue WHERE id=?').get(id1);
  ok('status sent', sent.status === 'sent' && sent.tax_id === stubRes.taxId);

  const idFail = moadian.enqueueMoadian(db, 'sales', 99);
  // force new doc without existing — insert fake invoice id 99 not needed for queue
  db.prepare("INSERT INTO moadian_queue(doc_type,doc_id,status,invoice_type,adapter) VALUES('sales',99,'pending',1,'stub')").run();
  const failId = db.prepare("SELECT id FROM moadian_queue WHERE doc_id=99 ORDER BY id DESC LIMIT 1").get().id;
  moadian.markFailed(db, failId, 'boom');
  const failedRow = db.prepare('SELECT * FROM moadian_queue WHERE id=?').get(failId);
  ok('status failed + retry', failedRow.status === 'failed' && (failedRow.retry_count || 0) >= 1);

  try {
    moadian.assertInvoiceEditableForMoadian({ moadian_status: 'sent', moadian_tax_id: 'X' });
    ok('lock throws', false);
  } catch (e) {
    ok('lock throws', e.code === 'MOADIAN_LOCKED');
  }

  db.close();
  try { fs.unlinkSync(dbPath); } catch (_) {}
  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
