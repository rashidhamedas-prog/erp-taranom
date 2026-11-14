#!/usr/bin/env node
/**
 * v649 — ماندهٔ رسمی مشتری در فاکتور/POS/برگشت.
 * customerLiveBalanceRial === customerSignedBalanceMap.get === buildStatement.ledger_closing;
 * customerArExposureRial = max(0, live); GET /api/customers/:id/balance (visibility, walk-in, no writes);
 * static checks on app.js / sw.js.
 * Synthetic temp DB only (never product 342 / code 7217).
 * Run: node server/scripts/test-invoice-customer-balance-v649.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icb-v649-'));
process.env.DB_PATH = path.join(tmpDir, 't.db');
process.env.COMPANIES_DIR = path.join(tmpDir, 'companies');
process.env.AUTH_SESSION_DB_PATH = path.join(tmpDir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'erp-test-isolation-jwt-secret-32chars!!';

const { ok, summary } = require('./lib/test-harness');
const { swAtLeast } = require('./lib/sw-at-least');

for (const rel of ['../db', '../routes/customers', '../lib/auth-sessions', '../lib/customer-books', '../lib/party-credit']) {
  try { delete require.cache[require.resolve(rel)]; } catch (_) {}
}
const dbMod = require('../db');
dbMod.initDB();
const db = dbMod.getDB();

const {
  customerLiveBalanceRial, customerSignedBalanceMap, ensureCustomerBooksRepaired,
} = require('../lib/customer-books');
const { customerArExposureRial, assertPartyCreditLimitOk } = require('../lib/party-credit');
const { buildStatement } = require('../routes/accounting');
const sqs = require('../lib/store-quick-sale');

ensureCustomerBooksRepaired(db);

const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
const invCols = cols('invoices');
const setCols = cols('settlements');

const hash = bcrypt.hashSync('pass1234', 4);
function mkUser(username, role) {
  return db.prepare(`INSERT INTO users (username,password,name,role,active,must_change_password)
    VALUES (?,?,?,?,1,0)`).run(username, hash, username, role).lastInsertRowid;
}
const adminId = mkUser('adm_v649', 'admin');
const repA = mkUser('rep_a_v649', 'field_sales');
const repB = mkUser('rep_b_v649', 'field_sales');

function mkCust(biz, owner, phone, userId) {
  return Number(db.prepare(`INSERT INTO customers (user_id,biz,owner,phone,status,created_by,assigned_to)
    VALUES (?,?,?,?,'active',?,?)`).run(userId, biz, owner, phone, userId, userId).lastInsertRowid);
}
function led(custId, entryType, refType, refId, debit, credit, userId) {
  db.prepare(`INSERT INTO customer_ledger (customer_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(custId, '1405/08/01', entryType, refType, refId, 'v649 fixture', debit, credit, userId || adminId);
}
let invSeq = 0;
function mkInvoice(custId, type, final, extra = {}) {
  invSeq += 1;
  const fields = { user_id: extra.user_id || adminId, cust_id: custId, num: 'V649-' + invSeq, type, date: '1405/08/01', final, rows: '[]' };
  if (extra.status && invCols.has('status')) fields.status = extra.status;
  if (extra.deleted_at && invCols.has('deleted_at')) fields.deleted_at = extra.deleted_at;
  const k = Object.keys(fields);
  return Number(db.prepare(`INSERT INTO invoices (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map((x) => fields[x])).lastInsertRowid);
}
function mkSettlement(custId, amount, status) {
  const fields = { user_id: adminId, cust_id: custId, amount, pay_type: 'cash', date: '1405/08/01' };
  if (status && setCols.has('status')) fields.status = status;
  const k = Object.keys(fields);
  return Number(db.prepare(`INSERT INTO settlements (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map((x) => fields[x])).lastInsertRowid);
}

console.log('══ v649 customer live balance ══');

// ── Customer A: opening 1,000,000 + firm 500,000 − settle 300,000 − reversed settle 200,000 (excluded)
//    + soft-voided invoice (excluded) + firm invoice missing from ledger 250,000 (included)
//    (opening rows use ref_type 'legacy_opening' (NULL ref_type drops out of sqlCustomerLedgerLive via SQL NULL logic): the boot «stale opening mirror» heal deletes ref_type='opening'
//     rows whose party has no opening_balance — a fixture artefact, not this feature.)
const A = mkCust('مشتری الف v649', 'الف', '09150006491', repA);
led(A, 'opening', 'legacy_opening', null, 1000000, 0);
const iA1 = mkInvoice(A, 'normal', 500000);
led(A, 'invoice', 'invoice', iA1, 500000, 0);
const sA1 = mkSettlement(A, 300000, 'posted');
led(A, 'settlement', 'settlement', sA1, 0, 300000);
const sA2 = mkSettlement(A, 200000, 'reversed');
led(A, 'settlement', 'settlement', sA2, 0, 200000);
const iAvoid = mkInvoice(A, 'normal', 700000, { status: 'void', deleted_at: Math.floor(Date.now() / 1000) });
led(A, 'invoice', 'invoice', iAvoid, 700000, 0);
mkInvoice(A, 'final', 250000); // firm, missing from customer_ledger
mkInvoice(A, 'proforma', 999000); // proforma never counts
const EXPECT_A = 1000000 + 500000 - 300000 + 250000;

const map1 = customerSignedBalanceMap(db);
const liveA = customerLiveBalanceRial(db, A);
const stA = buildStatement(db, A);
ok('A: live === expected (void/reversed excluded, missing firm included)', liveA === EXPECT_A, `live=${liveA} exp=${EXPECT_A}`);
ok('A: live === customerSignedBalanceMap', liveA === Math.round(map1.get(A) || 0), `map=${map1.get(A)}`);
ok('A: live === buildStatement.ledger_closing', liveA === Math.round(Number(stA.ledger_closing) || 0), `stmt=${stA.ledger_closing}`);
ok('A: exposure = max(0, live)', customerArExposureRial(db, A) === Math.max(0, liveA));
ok('A: live after statement heal still equals map', customerLiveBalanceRial(db, A) === Math.round(customerSignedBalanceMap(db).get(A) || 0));

// ── Customer B: creditor (advance)
const B = mkCust('مشتری ب v649', 'ب', '09150006492', repA);
const sB = mkSettlement(B, 400000, 'posted');
led(B, 'settlement', 'settlement', sB, 0, 400000);
ok('B: negative live balance', customerLiveBalanceRial(db, B) === -400000, String(customerLiveBalanceRial(db, B)));
ok('B: exposure 0 for creditor', customerArExposureRial(db, B) === 0);

// ── Customer C: ceiling 2,000,000; balance 1,500,000
const C = mkCust('مشتری ج v649', 'ج', '09150006493', repA);
led(C, 'opening', 'legacy_opening', null, 1500000, 0);
db.prepare('UPDATE customers SET credit_limit_rial=? WHERE id=?').run(2000000, C);
let threw = null;
try { assertPartyCreditLimitOk(db, C, 600000); } catch (e) { threw = e; }
ok('C: 600,000 over available 500,000 → throws', !!threw && threw.code === 'E_CREDIT_LIMIT');
ok('C: own ceiling → 422', threw && threw.status === 422);
ok('C: error balance = canonical', threw && threw.balance === 1500000, threw && String(threw.balance));
ok('C: 500,000 fits', (() => { try { assertPartyCreditLimitOk(db, C, 500000); return true; } catch (_) { return false; } })());
// raw-vs-live: a reversed settlement row must not lower exposure (raw SUM would have)
const sC = mkSettlement(C, 300000, 'reversed');
led(C, 'settlement', 'settlement', sC, 0, 300000);
ok('C: exposure follows live rule (reversed settlement ignored)', customerArExposureRial(db, C) === 1500000, String(customerArExposureRial(db, C)));

// ── Customer D: no ceiling, party limit 0 → unlimited
const D = mkCust('مشتری د v649', 'د', '09150006494', repB);
led(D, 'opening', 'legacy_opening', null, 100000, 0);

// ── Dual-role party with person_ledger activity
const E = mkCust('مشتری دونقشی v649', 'ه', '09150006495', repA);
led(E, 'opening', 'legacy_opening', null, 50000, 0);
let partyE = null;
try {
  partyE = Number(db.prepare(`INSERT INTO parties (person_code, party_type, full_name, phone, opening_balance)
    VALUES ('P-V649E','customer','ه دونقشی','09150006495',0)`).run().lastInsertRowid);
  try { db.prepare("UPDATE parties SET party_roles=? WHERE id=?").run(JSON.stringify(['customer', 'employee']), partyE); } catch (_) {}
  try { db.prepare('UPDATE parties SET is_active=1 WHERE id=?').run(partyE); } catch (_) {}
  db.prepare('UPDATE customers SET party_id=? WHERE id=?').run(partyE, E);
  const personE = Number(db.prepare("INSERT INTO persons (name, phone) VALUES ('ه دونقشی','09150006495')").run().lastInsertRowid);
  db.prepare('UPDATE persons SET party_id=? WHERE id=?').run(partyE, personE);
  db.prepare(`INSERT INTO person_ledger (person_id,date,entry_type,ref_type,description,debit,credit,user_id)
    VALUES (?,?,?,?,?,?,?,?)`).run(personE, '1405/08/01', 'manual', 'manual', 'مساعده', 900000, 0, adminId);
} catch (e) { ok('dual-role fixture: ' + e.message, false); }
ok('E: balance excludes person_ledger', customerLiveBalanceRial(db, E) === 50000, String(customerLiveBalanceRial(db, E)));

// ── Walk-in
const walkinId = sqs.ensureWalkinCustomer(db);
mkInvoice(walkinId, 'normal', 120000, { user_id: repA });
mkInvoice(walkinId, 'normal', 80000, { user_id: repB });

(async () => {
  let server;
  try {
    const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
    const userRow = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
    const tok = (id, tag) => issueStaffSession(db, userRow(id), {
      device_kind: 'test', device_name: 'icb-v649-' + tag, device_fingerprint: 'icb-v649-fp-' + tag,
    }).token;
    const tAdmin = tok(adminId, 'adm');
    const tRepA = tok(repA, 'ra');

    const app = express();
    app.use(express.json());
    app.use('/api/customers', require('../routes/customers'));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const get = (p, token) => new Promise((resolve, reject) => {
      const r = http.request({ hostname: '127.0.0.1', port, path: p, method: 'GET', headers: { Authorization: 'Bearer ' + token } }, (res) => {
        let buf = ''; res.on('data', (c) => { buf += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, data: j, headers: res.headers }); });
      });
      r.on('error', reject); r.end();
    });

    const before = db.prepare('SELECT total_changes() AS n').get().n;
    const rA = await get('/api/customers/' + A + '/balance', tRepA);
    ok('route: rep sees own customer (200)', rA.status === 200, String(rA.status));
    ok('route: balance_rial = canonical', rA.data && rA.data.balance_rial === EXPECT_A, JSON.stringify(rA.data));
    ok('route: side debit', rA.data && rA.data.side === 'debit');
    ok('route: Cache-Control no-store', String(rA.headers['cache-control'] || '').includes('no-store'));
    const rD = await get('/api/customers/' + D + '/balance', tRepA);
    ok("route: other rep's customer → 404", rD.status === 404, String(rD.status));
    const rDa = await get('/api/customers/' + D + '/balance', tAdmin);
    ok('route: admin sees D', rDa.status === 200);
    ok('route: D unlimited', rDa.data && rDa.data.credit_unlimited === true && rDa.data.available_credit_rial === null && rDa.data.credit_limit_rial === null);
    const rB = await get('/api/customers/' + B + '/balance', tRepA);
    ok('route: B side credit', rB.data && rB.data.side === 'credit' && rB.data.balance_rial === -400000);
    const rC = await get('/api/customers/' + C + '/balance', tRepA);
    ok('route: C available 500,000', rC.data && rC.data.credit_limit_rial === 2000000 && rC.data.available_credit_rial === 500000 && rC.data.credit_unlimited === false, JSON.stringify(rC.data));
    const rE = await get('/api/customers/' + E + '/balance', tRepA);
    ok('route: E party_hint.has_person_activity', rE.data && rE.data.party_hint && rE.data.party_hint.has_person_activity === true, JSON.stringify(rE.data));
    ok('route: E party_hint has only two fields', rE.data && rE.data.party_hint && Object.keys(rE.data.party_hint).sort().join(',') === 'has_person_activity,person_coa');
    ok('route: E balance excludes person', rE.data && rE.data.balance_rial === 50000);
    const rW = await get('/api/customers/' + walkinId + '/balance', tRepA);
    ok('route: walk-in under scoped user → personal balance', rW.status === 200 && rW.data.walkin === true && rW.data.balance_rial === 120000, JSON.stringify(rW.data));
    const r404 = await get('/api/customers/99999999/balance', tAdmin);
    ok('route: missing → 404', r404.status === 404 && r404.data && r404.data.error === 'مشتری یافت نشد');
    const after = db.prepare('SELECT total_changes() AS n').get().n;
    ok('route: no writes (total_changes unchanged)', after === before, `${before} → ${after}`);
    try { closeSessionStore(); } catch (_) {}
  } catch (e) {
    ok('HTTP harness: ' + e.message, false);
  }

  // ── Static checks
  const pub = path.join(__dirname, '..', 'public');
  const appJs = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
  const swJs = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');
  const idx = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  ok('static: inv-cust-bal', appJs.includes('id="inv-cust-bal"'));
  ok('static: storeQsCustBal', appJs.includes('id="storeQsCustBal"'));
  ok('static: sr-cust-bal', appJs.includes('id="sr-cust-bal"'));
  ok("static: /balance' fetch", appJs.includes("'/customers/'+id+'/balance'"));
  ok('static: «باقیماندهٔ این فاکتور»', appJs.includes('باقیماندهٔ این فاکتور'));
  ok('static: «ماندهٔ قبلی مشتری»', appJs.includes('ماندهٔ قبلی مشتری'));
  const core = (appJs.match(/function renderInvReceiptLedgerCore\(\)\{[\s\S]*?\n\}/) || [''])[0];
  ok('static: renderInvReceiptLedgerCore found', core.length > 100);
  ok('static: «مانده روی حساب مشتری» gone from renderInvReceiptLedgerCore', core && !core.includes('مانده روی حساب مشتری'));
  ok('static: sw >= 649', swAtLeast(swJs, 649));
  ok('static: index app.js?v=649+', /app\.js\?v=(649|6[5-9]\d|[7-9]\d\d)/.test(idx));
  let parsed = true;
  try { new Function(appJs); } catch (e) { parsed = false; console.log(e.message); }
  ok('static: new Function(app.js)', parsed);

  if (server) await new Promise((r) => server.close(r));
  try { db.close(); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  summary('v649 invoice-customer-balance');
})();
