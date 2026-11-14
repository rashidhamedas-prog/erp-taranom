#!/usr/bin/env node
/**
 * v650 — customer-opening-hotfix.
 * PUT /customers/:id must never touch openings (customer_ledger opening rows, opening_ledger /
 * opening_balance JEs, customers.balance column), whatever `balance` / `opening_balance_rial`
 * the body carries. An unchanged credit_limit_rial is treated as absent (no 403, no audit).
 * POST is unchanged. Synthetic temp DB only (no phone → no SMS; never product 342 / code 7217).
 * Run: node server/scripts/test-customer-opening-hotfix-v650.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coh-v650-'));
process.env.DB_PATH = path.join(tmpDir, 't.db');
process.env.COMPANIES_DIR = path.join(tmpDir, 'companies');
process.env.AUTH_SESSION_DB_PATH = path.join(tmpDir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'erp-test-isolation-jwt-secret-32chars!!';

const { ok, summary } = require('./lib/test-harness');
const { swAtLeast } = require('./lib/sw-at-least');

for (const rel of ['../db', '../routes/customers', '../lib/auth-sessions', '../lib/customer-books']) {
  try { delete require.cache[require.resolve(rel)]; } catch (_) {}
}
const dbMod = require('../db');
dbMod.initDB();
const db = dbMod.getDB();

const { customerLiveBalanceRial, ensureCustomerBooksRepaired } = require('../lib/customer-books');
const { buildStatement } = require('../routes/accounting');
const { upsertPartyOpening } = require('../lib/opening-post');

ensureCustomerBooksRepaired(db);

const pub = path.join(__dirname, '..', 'public');
const appJs = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');

/** The real client helper that builds bulk/PUT bodies from a cached row (extracted from app.js). */
function loadClientHelper() {
  const keys = (appJs.match(/const CUST_PUT_STRIP_KEYS\s*=\s*\[[^\]]*\];/) || [''])[0];
  const fn = (appJs.match(/function custRowForPut\(c\)\{[\s\S]*?\n\}/) || [''])[0];
  if (!keys || !fn) return null;
  try { return new Function(`${keys}\n${fn}\nreturn custRowForPut;`)(); } catch (_) { return null; }
}
const custRowForPut = loadClientHelper();

const hash = bcrypt.hashSync('pass1234', 4);
function mkUser(username, role) {
  return Number(db.prepare(`INSERT INTO users (username,password,name,role,active,must_change_password)
    VALUES (?,?,?,?,1,0)`).run(username, hash, username, role).lastInsertRowid);
}
const adminId = mkUser('adm_v650', 'admin');
const repId = mkUser('rep_v650', 'field_sales');
const mgrId = mkUser('mgr_v650', 'sales_manager');

const invCols = new Set(db.prepare('PRAGMA table_info(invoices)').all().map((c) => c.name));
let invSeq = 0;
function firmInvoice(custId, amount) {
  invSeq += 1;
  const fields = { user_id: adminId, cust_id: custId, num: 'V650-' + invSeq, type: 'normal', date: '1405/08/01', final: amount, rows: '[]' };
  if (invCols.has('status')) fields.status = 'final';
  const k = Object.keys(fields);
  const id = Number(db.prepare(`INSERT INTO invoices (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map((x) => fields[x])).lastInsertRowid);
  db.prepare(`INSERT INTO customer_ledger (customer_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(custId, '1405/08/02', 'invoice', 'invoice', id, 'v650 fixture', amount, 0, adminId);
  return id;
}

/** Settle the central read-path heals first (GET /customers runs them too) so a diff means the PUT. */
function snap(custId) {
  ensureCustomerBooksRepaired(db);
  ensureCustomerBooksRepaired(db); // second pass: GL→books copy re-adds what the stale-mirror pass removed
  const rows = db.prepare('SELECT id,ref_type,ref_id,debit,credit FROM customer_ledger WHERE customer_id=? ORDER BY id').all(custId);
  const cl = db.prepare('SELECT COUNT(*) n, COALESCE(MAX(id),0) mx FROM customer_ledger').get();
  const je = db.prepare('SELECT id,ref_type,ref_id,COALESCE(deleted_at,0) d,COALESCE(status,\'\') s FROM journal_entries ORDER BY id').all();
  const c = db.prepare('SELECT balance,credit_limit_rial FROM customers WHERE id=?').get(custId);
  let closing = null;
  try { closing = Math.round(Number(buildStatement(db, custId).ledger_closing) || 0); } catch (_) {}
  return {
    rows: JSON.stringify(rows),
    clN: cl.n,
    clMax: cl.mx,
    je: JSON.stringify(je),
    col: c.balance,
    limit: c.credit_limit_rial,
    live: customerLiveBalanceRial(db, custId),
    closing,
  };
}
function sameBooks(label, a, b) {
  ok(`${label}: customer rows unchanged`, a.rows === b.rows, `${a.rows} → ${b.rows}`);
  ok(`${label}: customer_ledger n/max unchanged`, a.clN === b.clN && a.clMax === b.clMax, `${a.clN}/${a.clMax} → ${b.clN}/${b.clMax}`);
  ok(`${label}: journal_entries unchanged`, a.je === b.je);
  ok(`${label}: customers.balance column unchanged`, a.col === b.col, `${a.col} → ${b.col}`);
  ok(`${label}: live balance unchanged`, a.live === b.live, `${a.live} → ${b.live}`);
  ok(`${label}: statement closing unchanged`, a.closing === b.closing, `${a.closing} → ${b.closing}`);
}
const creditAudits = (custId) => db.prepare(
  "SELECT COUNT(*) n FROM audit_log WHERE entity='customer' AND entity_id=? AND detail LIKE '%سقف اعتبار%'"
).get(custId).n;

(async () => {
  let server;
  try {
    const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
    const userRow = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
    const tok = (id, tag) => issueStaffSession(db, userRow(id), {
      device_kind: 'test', device_name: 'coh-v650-' + tag, device_fingerprint: 'coh-v650-fp-' + tag,
    }).token;
    const T = { admin: tok(adminId, 'adm'), rep: tok(repId, 'rep'), mgr: tok(mgrId, 'mgr') };

    const app = express();
    app.use(express.json());
    app.use('/api/customers', require('../routes/customers'));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const call = (method, p, token, body) => new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const headers = { Authorization: 'Bearer ' + token };
      if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
      const r = http.request({ hostname: '127.0.0.1', port, path: p, method, headers }, (res) => {
        let buf = ''; res.on('data', (c) => { buf += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, data: j }); });
      });
      r.on('error', reject);
      if (payload) r.write(payload);
      r.end();
    });
    let reqSeq = 0;
    const create = async (token, body) => {
      reqSeq += 1;
      const r = await call('POST', '/api/customers', token, { client_request_id: 'coh-v650-' + reqSeq, ...body });
      return r;
    };
    const cached = async (token, id) => {
      const r = await call('GET', '/api/customers', token);
      const list = Array.isArray(r.data) ? r.data : (r.data && r.data.data) || [];
      return list.find((x) => Number(x.id) === Number(id)) || null;
    };

    console.log('══ v650 customer-opening-hotfix ══');

    // ── 1. admin POST opening 1,000,000 + firm invoice 500,000 → admin PUT full cached row
    const p1 = await create(T.admin, { biz: 'مشتری افتتاحیه v650', balance: 1000000 });
    ok('1: admin POST 200', p1.status === 200, JSON.stringify(p1.data));
    const c1 = p1.data && p1.data.id;
    const open1 = db.prepare("SELECT id,debit FROM customer_ledger WHERE customer_id=? AND ref_type='opening'").all(c1);
    ok('1: POST created one opening row 1,000,000', open1.length === 1 && open1[0].debit === 1000000, JSON.stringify(open1));
    const je1 = db.prepare("SELECT id FROM journal_entries WHERE ref_type='opening_ledger' AND ref_id=? AND COALESCE(deleted_at,0)=0").all(c1);
    ok('1: POST posted opening_ledger JE (coa present)', je1.length === 1, JSON.stringify(je1));
    firmInvoice(c1, 500000);
    ok('1: live 1,500,000 right after POST + invoice', customerLiveBalanceRial(db, c1) === 1500000, String(customerLiveBalanceRial(db, c1)));
    const s1 = snap(c1);
    const row1 = await cached(T.admin, c1);
    ok('1: cached row balance = live', row1 && Math.round(row1.balance) === s1.live, row1 && `${row1.balance} vs ${s1.live}`);
    ok('1: cached row balance ≠ customers.balance column (bug trigger armed)', row1 && Math.round(row1.balance) !== Math.round(s1.col || 0), row1 && `${row1.balance} vs ${s1.col}`);
    const u1 = await call('PUT', '/api/customers/' + c1, T.admin, { ...row1 });
    ok('1: admin PUT full row 200', u1.status === 200, JSON.stringify(u1.data));
    sameBooks('1', s1, snap(c1));

    // ── 2. balance 0 / '999'
    for (const bal of [0, '999']) {
      const before = snap(c1);
      const r = await call('PUT', '/api/customers/' + c1, T.admin, { ...row1, balance: bal });
      ok(`2: admin PUT balance=${JSON.stringify(bal)} 200`, r.status === 200);
      sameBooks(`2 (balance=${JSON.stringify(bal)})`, before, snap(c1));
    }

    // ── 3. opening from the party path (opening-post) → admin PUT full row
    const p3 = await create(T.admin, { biz: 'مشتری شخص v650' });
    const c3 = p3.data && p3.data.id;
    const party3 = db.prepare('SELECT party_id FROM customers WHERE id=?').get(c3);
    ok('3: customer linked to a party', !!(party3 && party3.party_id));
    let pje3 = null;
    try { pje3 = db.transaction(() => upsertPartyOpening(db, party3.party_id, 700000, adminId))(); }
    catch (e) { ok('3: upsertPartyOpening ' + e.message, false); }
    const mirror3 = db.prepare("SELECT id,ref_id,debit FROM customer_ledger WHERE customer_id=? AND ref_type IN ('opening','opening_balance')").all(c3);
    ok('3: party opening mirror present', mirror3.length === 1 && mirror3[0].debit === 700000, JSON.stringify(mirror3));
    firmInvoice(c3, 200000);
    const s3 = snap(c3);
    const row3 = await cached(T.admin, c3);
    const u3 = await call('PUT', '/api/customers/' + c3, T.admin, { ...row3 });
    ok('3: admin PUT 200', u3.status === 200);
    sameBooks('3', s3, snap(c3));
    const liveJe3 = db.prepare("SELECT COUNT(*) n FROM journal_entries WHERE id=? AND COALESCE(deleted_at,0)=0").get(pje3).n;
    ok('3: party opening_balance JE still live', liveJe3 === 1);
    ok('3: no opening_ledger JE created', db.prepare("SELECT COUNT(*) n FROM journal_entries WHERE ref_type='opening_ledger' AND ref_id=?").get(c3).n === 0);

    // ── 4. import-style opening_balance row
    const p4 = await create(T.admin, { biz: 'مشتری ایمپورت v650' });
    const c4 = p4.data && p4.data.id;
    db.prepare(`INSERT INTO customer_ledger (customer_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(c4, '', 'opening', 'opening_balance', null, 'v650 import', 0, 300000, adminId);
    const s4 = snap(c4);
    const row4 = await cached(T.admin, c4);
    const u4 = await call('PUT', '/api/customers/' + c4, T.admin, { ...row4, balance: 5 });
    ok('4: admin PUT 200', u4.status === 200);
    sameBooks('4', s4, snap(c4));

    // ── 5. opening_balance_rial in body → ignored
    {
      const before = snap(c1);
      const r = await call('PUT', '/api/customers/' + c1, T.admin, { ...row1, opening_balance_rial: 42000000 });
      ok('5: PUT with opening_balance_rial 200', r.status === 200);
      sameBooks('5', before, snap(c1));
    }

    // ── 6. bulk status bodies (field_sales owner / sales_manager / admin), credit_limit 2,000,000
    ok('6: client helper custRowForPut found in app.js', typeof custRowForPut === 'function');
    const helper = custRowForPut || ((c) => c);
    const pRep = await create(T.rep, { biz: 'مشتری کارشناس v650', note: 'یادداشت ثابت' });
    const pMgr = await create(T.mgr, { biz: 'مشتری مدیر فروش v650', note: 'یادداشت ثابت' });
    ok('6: rep/mgr POST 200', pRep.status === 200 && pMgr.status === 200, `${pRep.status}/${pMgr.status} ${JSON.stringify(pRep.data)}`);
    const cRep = pRep.data && pRep.data.id;
    const cMgr = pMgr.data && pMgr.data.id;
    for (const cid of [cRep, cMgr]) {
      db.prepare('UPDATE customers SET credit_limit_rial=? WHERE id=?').run(2000000, cid);
      firmInvoice(cid, 100000);
    }
    const bulkCases = [['field_sales', T.rep, cRep, 'vip'], ['sales_manager', T.mgr, cMgr, 'vip'], ['admin', T.admin, cRep, 'silent']];
    for (const [who, token, cid, status] of bulkCases) {
      const before = snap(cid);
      const fixed = db.prepare('SELECT biz,owner,note,type,user_id,assigned_to FROM customers WHERE id=?').get(cid);
      const auditsBefore = creditAudits(cid);
      const row = await cached(token, cid);
      ok(`6 ${who}: cached row visible`, !!row);
      const body = { ...helper(row || {}), status };
      ok(`6 ${who}: body has no balance/credit_limit_rial`, !('balance' in body) && !('credit_limit_rial' in body));
      const r = await call('PUT', '/api/customers/' + cid, token, body);
      ok(`6 ${who}: bulk PUT 200`, r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
      ok(`6 ${who}: status changed`, db.prepare('SELECT status FROM customers WHERE id=?').get(cid).status === status);
      const fixedAfter = db.prepare('SELECT biz,owner,note,type,user_id,assigned_to FROM customers WHERE id=?').get(cid);
      ok(`6 ${who}: other fields unchanged`, JSON.stringify(fixed) === JSON.stringify(fixedAfter), `${JSON.stringify(fixed)} → ${JSON.stringify(fixedAfter)}`);
      ok(`6 ${who}: no credit-limit audit`, creditAudits(cid) === auditsBefore);
      const after = snap(cid);
      sameBooks(`6 ${who}`, before, after);
      ok(`6 ${who}: credit_limit_rial unchanged`, after.limit === 2000000, String(after.limit));
    }
    {
      const before = snap(cRep);
      const auditsBefore = creditAudits(cRep);
      const row = await cached(T.rep, cRep);
      const r = await call('PUT', '/api/customers/' + cRep, T.rep, { ...row, status: 'followup' });
      ok('6 old-client {...c,status} by field_sales → 200', r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
      ok('6 old-client: no credit-limit audit', creditAudits(cRep) === auditsBefore);
      sameBooks('6 old-client', before, snap(cRep));
    }

    // ── 7. changed credit_limit_rial: field_sales → 403; sales_manager → stored + one audit
    {
      const row = await cached(T.rep, cRep);
      const r = await call('PUT', '/api/customers/' + cRep, T.rep, { ...row, credit_limit_rial: 3000000 });
      ok('7: field_sales changing credit_limit → 403', r.status === 403, String(r.status));
      ok('7: limit not stored', db.prepare('SELECT credit_limit_rial l FROM customers WHERE id=?').get(cRep).l === 2000000);
      const auditsBefore = creditAudits(cMgr);
      const rowM = await cached(T.mgr, cMgr);
      const rm = await call('PUT', '/api/customers/' + cMgr, T.mgr, { ...rowM, credit_limit_rial: 3000000 });
      ok('7: sales_manager changing credit_limit → 200', rm.status === 200, String(rm.status));
      ok('7: sales_manager limit stored', db.prepare('SELECT credit_limit_rial l FROM customers WHERE id=?').get(cMgr).l === 3000000);
      ok('7: exactly one credit-limit audit', creditAudits(cMgr) === auditsBefore + 1);
      const rn = await call('PUT', '/api/customers/' + cRep, T.rep, { ...row, credit_limit_rial: -5 });
      ok('7: field_sales invalid credit_limit → 403 (unchanged rule)', rn.status === 403, String(rn.status));
    }

    // ── 8. POST unchanged: admin balance → opening row (+JE); non-admin balance ignored
    {
      const r = await create(T.admin, { biz: 'مشتری جدید ادمین v650', balance: 250000 });
      const id = r.data && r.data.id;
      const rows = db.prepare("SELECT debit FROM customer_ledger WHERE customer_id=? AND ref_type='opening'").all(id);
      ok('8: admin POST balance → opening row', rows.length === 1 && rows[0].debit === 250000, JSON.stringify(rows));
      ok('8: admin POST balance → opening_ledger JE', db.prepare("SELECT COUNT(*) n FROM journal_entries WHERE ref_type='opening_ledger' AND ref_id=? AND COALESCE(deleted_at,0)=0").get(id).n === 1);
      const rr = await create(T.rep, { biz: 'مشتری جدید کارشناس v650', balance: 250000 });
      const rid = rr.data && rr.data.id;
      ok('8: non-admin POST balance ignored', rr.status === 200
        && db.prepare("SELECT COUNT(*) n FROM customer_ledger WHERE customer_id=? AND ref_type IN ('opening','opening_balance')").get(rid).n === 0);
    }

    // ── 9. test-sync style PUT {biz}
    {
      const before = snap(c1);
      const r = await call('PUT', '/api/customers/' + c1, T.admin, { biz: 'نام جدید v650' });
      ok('9: PUT {biz} 200', r.status === 200);
      ok('9: biz updated', db.prepare('SELECT biz FROM customers WHERE id=?').get(c1).biz === 'نام جدید v650');
      sameBooks('9', before, snap(c1));
    }
    try { closeSessionStore(); } catch (_) {}
  } catch (e) {
    ok('HTTP harness: ' + e.message, false);
  }

  // ── 10. static
  const swJs = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');
  const idx = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'customers.js'), 'utf8');
  const saveCust = (appJs.match(/async function saveCust\(id\)\{[\s\S]*?\n\}/) || [''])[0];
  const bulk = (appJs.match(/async function bulkCustStatus\(status\)\{[\s\S]*?\n\}/) || [''])[0];
  const modal = (appJs.match(/async function custModal\(id\)\{[\s\S]*?\n\}/) || [''])[0];
  const putSrc = (routeSrc.match(/router\.put\('\/:id', auth,[\s\S]*?\n\}\);/) || [''])[0];
  ok('static: saveCust found', saveCust.length > 100);
  ok('static: saveCust sends balance only when !id', /if\(!id && el\('c-balance'\)\) data\.balance/.test(saveCust) && !/^\s*if\(el\('c-balance'\)\)/m.test(saveCust));
  ok('static: bulkCustStatus uses custRowForPut', bulk.includes('custRowForPut(c)') && !bulk.includes('{...c, status}'));
  const strip = (appJs.match(/const CUST_PUT_STRIP_KEYS\s*=\s*\[[^\]]*\];/) || [''])[0];
  ok('static: strip keys cover balance + credit_limit_rial', strip.includes("'balance'") && strip.includes("'credit_limit_rial'"));
  const editStart = modal.indexOf('${id\n            ? `');
  const editEnd = editStart >= 0 ? modal.indexOf('\n            : `', editStart) : -1;
  const editBranch = editEnd > editStart ? modal.slice(editStart, editEnd) : '';
  ok('static: custModal edit branch shows live balance read-only', editBranch.includes('ماندهٔ فعلی حساب (صورت‌حساب)') && editBranch.includes('custBalSideText(c.balance)'));
  ok('static: custModal edit branch has no c-balance input', editBranch.length > 0 && !editBranch.includes('c-balance'));
  ok('static: custModal new-customer branch keeps c-balance', modal.slice(editEnd).includes('id="c-balance"'));
  ok('static: custModal points to «اشخاص»', modal.includes('مانده افتتاحیه از «اشخاص» اصلاح می‌شود'));
  ok('static: PUT handler found', putSrc.length > 200);
  ok('static: PUT has no syncOpeningLedger(', putSrc.length > 200 && !putSrc.includes('syncOpeningLedger('));
  ok('static: sw >= 650', swAtLeast(swJs, 650));
  ok('static: index app.js?v=650', idx.includes('app.js?v=650'));
  let parsed = true;
  try { new Function(appJs); } catch (e) { parsed = false; console.log(e.message); }
  ok('static: new Function(app.js)', parsed);

  if (server) await new Promise((r) => server.close(r));
  try { db.close(); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  summary('v650 customer-opening-hotfix');
})();
