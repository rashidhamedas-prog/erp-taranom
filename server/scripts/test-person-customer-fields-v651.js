#!/usr/bin/env node
/**
 * v651 — person-customer-fields.
 * «مشتریان» form uses the same person-identity fields as «اشخاص» (prefix select, تلفن ۱/۲، موبایل، …)
 * regardless of coa_mode; customers ↔ parties stay in sync (incl. province/address);
 * v650 opening guard and v649 live-balance numbers stay identical.
 * Synthetic temp DB only (no phone on POST → no welcome SMS; never product 342 / code 7217).
 * Run: node server/scripts/test-person-customer-fields-v651.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-v651-'));
process.env.DB_PATH = path.join(tmpDir, 't.db');
process.env.COMPANIES_DIR = path.join(tmpDir, 'companies');
process.env.AUTH_SESSION_DB_PATH = path.join(tmpDir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'erp-test-isolation-jwt-secret-32chars!!';

const { ok, summary } = require('./lib/test-harness');
const { swAtLeast } = require('./lib/sw-at-least');

for (const rel of ['../db', '../routes/customers', '../routes/parties', '../lib/auth-sessions', '../lib/customer-books']) {
  try { delete require.cache[require.resolve(rel)]; } catch (_) {}
}
const dbMod = require('../db');
dbMod.initDB();
const db = dbMod.getDB();

const { customerLiveBalanceRial, ensureCustomerBooksRepaired } = require('../lib/customer-books');
const { buildStatement } = require('../routes/accounting');
const XLSX = require('../lib/excel-safe');

ensureCustomerBooksRepaired(db);

const pub = path.join(__dirname, '..', 'public');
const appJs = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');

function extract(re) { return (appJs.match(re) || [''])[0]; }
const custRowForPut = (() => {
  const keys = extract(/const CUST_PUT_STRIP_KEYS\s*=\s*\[[^\]]*\];/);
  const fn = extract(/function custRowForPut\(c\)\{[\s\S]*?\n\}/);
  try { return new Function(`${keys}\n${fn}\nreturn custRowForPut;`)(); } catch (_) { return null; }
})();
const clientHelpers = (() => {
  const opts = extract(/const PARTY_PREFIX_OPTIONS=\[[^\]]*\];/);
  const sel = extract(/function partyPrefixSelectHtml\(id, value, disabled\)\{[\s\S]*?\n\}/);
  const lbl = extract(/function custOwnerLabel\(c\)\{[\s\S]*?\n\}/);
  const esc = 'function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]));}';
  try { return new Function(`${esc}\n${opts}\n${sel}\n${lbl}\nreturn {partyPrefixSelectHtml,custOwnerLabel,PARTY_PREFIX_OPTIONS};`)(); } catch (_) { return null; }
})();

/** Valid synthetic 10-digit Iranian national id. */
function nationalId(base9) {
  const d = base9.split('').map(Number);
  const s = d.reduce((a, x, i) => a + x * (10 - i), 0) % 11;
  return base9 + String(s < 2 ? s : 11 - s);
}

const hash = bcrypt.hashSync('pass1234', 4);
function mkUser(username, role) {
  return Number(db.prepare(`INSERT INTO users (username,password,name,role,active,must_change_password)
    VALUES (?,?,?,?,1,0)`).run(username, hash, username, role).lastInsertRowid);
}
const adminId = mkUser('adm_v651', 'admin');
const repId = mkUser('rep_v651', 'field_sales');
const mgrId = mkUser('mgr_v651', 'sales_manager');

const invCols = new Set(db.prepare('PRAGMA table_info(invoices)').all().map((c) => c.name));
let invSeq = 0;
function firmInvoice(custId, amount) {
  invSeq += 1;
  const fields = { user_id: adminId, cust_id: custId, num: 'V651-' + invSeq, type: 'normal', date: '1405/08/01', final: amount, rows: '[]' };
  if (invCols.has('status')) fields.status = 'final';
  const k = Object.keys(fields);
  const id = Number(db.prepare(`INSERT INTO invoices (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map((x) => fields[x])).lastInsertRowid);
  db.prepare(`INSERT INTO customer_ledger (customer_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(custId, '1405/08/02', 'invoice', 'invoice', id, 'v651 fixture', amount, 0, adminId);
  return id;
}

function snap(custId) {
  ensureCustomerBooksRepaired(db);
  ensureCustomerBooksRepaired(db);
  const rows = db.prepare('SELECT id,ref_type,ref_id,debit,credit FROM customer_ledger WHERE customer_id=? ORDER BY id').all(custId);
  const je = db.prepare('SELECT id,ref_type,ref_id,COALESCE(deleted_at,0) d,COALESCE(status,\'\') s FROM journal_entries ORDER BY id').all();
  const c = db.prepare('SELECT balance FROM customers WHERE id=?').get(custId);
  let closing = null;
  try { closing = Math.round(Number(buildStatement(db, custId).ledger_closing) || 0); } catch (_) {}
  return { rows: JSON.stringify(rows), je: JSON.stringify(je), col: c.balance, live: customerLiveBalanceRial(db, custId), closing };
}
function sameBooks(label, a, b) {
  ok(`${label}: customer_ledger rows unchanged`, a.rows === b.rows, `${a.rows} → ${b.rows}`);
  ok(`${label}: journal_entries unchanged`, a.je === b.je);
  ok(`${label}: customers.balance unchanged`, a.col === b.col, `${a.col} → ${b.col}`);
  ok(`${label}: live = before`, a.live === b.live, `${a.live} → ${b.live}`);
  ok(`${label}: statement closing = before`, a.closing === b.closing, `${a.closing} → ${b.closing}`);
}

(async () => {
  let server;
  const fixtures = [];
  try {
    const { issueStaffSession, closeSessionStore } = require('../lib/auth-sessions');
    const userRow = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
    const tok = (id, tag) => issueStaffSession(db, userRow(id), {
      device_kind: 'test', device_name: 'pcf-v651-' + tag, device_fingerprint: 'pcf-v651-fp-' + tag,
    }).token;
    const T = { admin: tok(adminId, 'adm'), rep: tok(repId, 'rep'), mgr: tok(mgrId, 'mgr') };

    const app = express();
    app.use(express.json());
    app.use('/api/customers', require('../routes/customers'));
    app.use('/api/parties', require('../routes/parties'));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const raw = (method, p, token, body, headersIn) => new Promise((resolve, reject) => {
      const headers = { Authorization: 'Bearer ' + token, ...(headersIn || {}) };
      if (body != null) headers['Content-Length'] = Buffer.byteLength(body);
      const r = http.request({ hostname: '127.0.0.1', port, path: p, method, headers }, (res) => {
        const chunks = []; res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
      });
      r.on('error', reject);
      if (body != null) r.write(body);
      r.end();
    });
    const call = async (method, p, token, body) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const r = await raw(method, p, token, payload, payload ? { 'Content-Type': 'application/json' } : {});
      let j = null; try { j = JSON.parse(r.buf.toString('utf8')); } catch (_) {}
      return { status: r.status, data: j };
    };
    let reqSeq = 0;
    const create = (token, body) => { reqSeq += 1; return call('POST', '/api/customers', token, { client_request_id: 'pcf-v651-' + reqSeq, ...body }); };
    const cached = async (token, id) => {
      const r = await call('GET', '/api/customers', token);
      const list = Array.isArray(r.data) ? r.data : (r.data && r.data.data) || [];
      return list.find((x) => Number(x.id) === Number(id)) || null;
    };
    const party = (custId) => db.prepare('SELECT p.* FROM parties p JOIN customers c ON c.party_id=p.id WHERE c.id=?').get(custId);

    console.log('══ v651 person-customer-fields ══');
    const coaMode = (db.prepare("SELECT value FROM settings WHERE key='coa_mode'").get() || {}).value;
    ok('0: coa_mode = standard', coaMode === 'standard', String(coaMode));

    // ── 1. identity fields saved on customer + copied to party (standard coa)
    const nid = nationalId('001234567');
    const p1 = await create(T.admin, {
      biz: 'بوتیک تست v651', owner: 'مریم تست', prefix: 'خانم', phone2: '05131234567', mobile: '09150000001',
      national_id: nid, postal_code: '9188812345', company_name: 'شرکت تست', province: 'خراسان رضوی', address: 'آدرس اول',
    });
    ok('1: admin POST 200', p1.status === 200, JSON.stringify(p1.data));
    const c1 = p1.data && p1.data.id;
    fixtures.push(c1);
    const cr1 = db.prepare('SELECT * FROM customers WHERE id=?').get(c1);
    ok('1: customer stored prefix/phone2/mobile/national_id/postal_code',
      cr1.prefix === 'خانم' && cr1.phone2 === '05131234567' && cr1.mobile === '09150000001' && cr1.national_id === nid && cr1.postal_code === '9188812345',
      JSON.stringify({ prefix: cr1.prefix, phone2: cr1.phone2, mobile: cr1.mobile, nid: cr1.national_id, pc: cr1.postal_code }));
    const pr1 = party(c1);
    ok('1: linked party exists', !!pr1);
    ok('1: party got prefix/secondary_phone/mobile/national_id/postal_code/company',
      pr1 && pr1.prefix === 'خانم' && pr1.secondary_phone === '05131234567' && pr1.mobile === '09150000001'
        && pr1.national_id === nid && pr1.postal_code === '9188812345' && pr1.company_name === 'شرکت تست',
      pr1 && JSON.stringify({ prefix: pr1.prefix, sp: pr1.secondary_phone, m: pr1.mobile, n: pr1.national_id, pc: pr1.postal_code, co: pr1.company_name }));
    ok('1: party got province/address on INSERT', pr1 && pr1.province === 'خراسان رضوی' && pr1.address === 'آدرس اول',
      pr1 && `${pr1.province} / ${pr1.address}`);

    // ── 2. party edit (UI-shaped body) copies back to the customer
    const partyId = pr1 && pr1.id;
    const g = await call('GET', '/api/parties/' + partyId, T.admin);
    const pd = (g.data && (g.data.data || g.data)) || {};
    const partyBody = (over) => ({
      full_name: pd.full_name, company_name: pd.company_name, phone: pd.phone || '-', secondary_phone: pd.secondary_phone,
      mobile: pd.mobile, prefix: pd.prefix, national_id: pd.national_id, postal_code: pd.postal_code,
      city: pd.city, province: pd.province, address: pd.address, party_group_id: pd.party_group_id,
      party_roles: pd.party_roles || ['customer'], ...over,
    });
    const u2 = await call('PUT', '/api/parties/' + partyId, T.admin, partyBody({ mobile: '09150000002', referrer: 'معرف v651', prefix: 'آقا' }));
    ok('2: party PUT 200', u2.status === 200, JSON.stringify(u2.data));
    const cr2 = db.prepare('SELECT prefix,mobile,referrer FROM customers WHERE id=?').get(c1);
    ok('2: party edit copied back to customer', cr2.prefix === 'آقا' && cr2.mobile === '09150000002' && cr2.referrer === 'معرف v651', JSON.stringify(cr2));

    // ── 3. province/address from the customer reach the party; a stale-free party save does not revert
    const row3 = await cached(T.admin, c1);
    const u3 = await call('PUT', '/api/customers/' + c1, T.admin, { ...custRowForPut(row3), province: 'تهران', city: 'تهران', address: 'آدرس جدید مشتری' });
    ok('3: customer PUT 200', u3.status === 200, JSON.stringify(u3.data));
    const pr3 = party(c1);
    ok('3: party province/address updated from customer', pr3.province === 'تهران' && pr3.address === 'آدرس جدید مشتری', `${pr3.province} / ${pr3.address}`);
    const g3 = await call('GET', '/api/parties/' + partyId, T.admin);
    const pd3 = (g3.data && (g3.data.data || g3.data)) || {};
    const u3b = await call('PUT', '/api/parties/' + partyId, T.admin, partyBody({
      province: pd3.province, address: pd3.address, city: pd3.city, prefix: pd3.prefix, mobile: pd3.mobile, notes: 'یادداشت شخص',
    }));
    ok('3: following party save 200', u3b.status === 200);
    const cr3 = db.prepare('SELECT province,address FROM customers WHERE id=?').get(c1);
    ok('3: party save did not revert customer province/address', cr3.province === 'تهران' && cr3.address === 'آدرس جدید مشتری', JSON.stringify(cr3));

    // ── 4. legacy prefix outside the list survives
    db.prepare("UPDATE customers SET prefix='دکتر' WHERE id=?").run(c1);
    const row4 = await cached(T.admin, c1);
    const u4 = await call('PUT', '/api/customers/' + c1, T.admin, { ...custRowForPut(row4), prefix: row4.prefix, note: 'ویرایش ۴' });
    ok('4: PUT 200', u4.status === 200);
    ok('4: legacy prefix «دکتر» unchanged', db.prepare('SELECT prefix FROM customers WHERE id=?').get(c1).prefix === 'دکتر');
    ok('4: client helpers extracted', !!clientHelpers);
    if (clientHelpers) {
      const html = clientHelpers.partyPrefixSelectHtml('c-prefix', 'دکتر', false);
      ok('4: prefix select keeps legacy value as selected option', /<option value="دکتر" selected>/.test(html), html);
      ok('4: prefix select lists all standard options', clientHelpers.PARTY_PREFIX_OPTIONS.every((x) => html.includes(`value="${x}"`)));
      ok('4: owner label = prefix + owner', clientHelpers.custOwnerLabel({ prefix: 'خانم', owner: 'مریم' }) === 'خانم مریم');
      ok('4: owner label without prefix = owner', clientHelpers.custOwnerLabel({ owner: 'مریم' }) === 'مریم');
    }

    // ── 5. v650 guard with the new full form payload
    const p5 = await create(T.admin, { biz: 'مشتری افتتاحیه v651', balance: 1000000 });
    const c5 = p5.data && p5.data.id;
    fixtures.push(c5);
    firmInvoice(c5, 500000);
    const s5 = snap(c5);
    const row5 = await cached(T.admin, c5);
    const formPayload = {
      biz: row5.biz, owner: 'رضا تست', province: '', city: '', address: '', phone: '', insta: '', type: 'بوتیک',
      status: 'active', note: '', source: '', auto_followup: 1, group_id: null, party_group_id: row5.party_group_id || null,
      prefix: 'آقا', company_name: 'شرکت ۵', phone2: '', mobile: '09150000005', fax: '', email: 'a@b.ir',
      national_id: nationalId('002345678'), economic_code: '', postal_code: '', birth_date: '', referrer: '',
      balance: 999, opening_balance_rial: 42000000, assigned_to: adminId,
    };
    const u5 = await call('PUT', '/api/customers/' + c5, T.admin, formPayload);
    ok('5: admin form PUT 200', u5.status === 200, JSON.stringify(u5.data));
    sameBooks('5', s5, snap(c5));
    ok('5: identity fields stored', db.prepare('SELECT prefix,email FROM customers WHERE id=?').get(c5).prefix === 'آقا');

    const pRep = await create(T.rep, { biz: 'مشتری کارشناس v651' });
    const cRep = pRep.data && pRep.data.id;
    fixtures.push(cRep);
    firmInvoice(cRep, 100000);
    for (const st of ['vip', 'silent', 'followup']) {
      const before = snap(cRep);
      const row = await cached(T.rep, cRep);
      const r = await call('PUT', '/api/customers/' + cRep, T.rep, { ...custRowForPut(row), status: st });
      ok(`5 bulk field_sales ${st}: 200`, r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
      sameBooks(`5 bulk ${st}`, before, snap(cRep));
    }
    {
      const before = snap(cRep);
      const row = await cached(T.rep, cRep);
      const r = await call('PUT', '/api/customers/' + cRep, T.rep, {
        ...custRowForPut(row), prefix: 'خانم', phone2: '05130000000', mobile: '09150000009', referrer: 'معرف کارشناس',
      });
      ok('5: field_sales owner edits identity fields → 200', r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
      ok('5: field_sales identity edit stored', db.prepare('SELECT prefix,referrer FROM customers WHERE id=?').get(cRep).referrer === 'معرف کارشناس');
      sameBooks('5 field_sales identity', before, snap(cRep));
    }

    // ── 6. credit ceiling
    const pMgr = await create(T.mgr, { biz: 'مشتری مدیر فروش v651' });
    const cMgr = pMgr.data && pMgr.data.id;
    fixtures.push(cMgr);
    {
      const row = await cached(T.mgr, cMgr);
      const r = await call('PUT', '/api/customers/' + cMgr, T.mgr, { ...custRowForPut(row), credit_limit_rial: 2000000 });
      ok('6: sales_manager sets ceiling 2,000,000 → 200', r.status === 200, String(r.status));
      ok('6: ceiling stored', db.prepare('SELECT credit_limit_rial l FROM customers WHERE id=?').get(cMgr).l === 2000000);
      const rowR = await cached(T.rep, cRep);
      const rr = await call('PUT', '/api/customers/' + cRep, T.rep, { ...custRowForPut(rowR), credit_limit_rial: 2000000 });
      ok('6: field_sales sending ceiling → 403', rr.status === 403, String(rr.status));
      const r0 = await call('PUT', '/api/customers/' + cMgr, T.mgr, { ...custRowForPut(row), credit_limit_rial: null });
      ok('6: sales_manager clears ceiling (null) → 200', r0.status === 200);
      ok('6: ceiling null', db.prepare('SELECT credit_limit_rial l FROM customers WHERE id=?').get(cMgr).l == null);
    }

    // ── 7. v649 invariance
    for (const id of fixtures) {
      let closing = null;
      try { closing = Math.round(Number(buildStatement(db, id).ledger_closing) || 0); } catch (_) {}
      ok(`7: customer ${id} live = statement closing`, customerLiveBalanceRial(db, id) === closing, `${customerLiveBalanceRial(db, id)} vs ${closing}`);
    }

    // ── 8. export trailing columns; import without them still works
    const ex = await raw('GET', '/api/customers/export/excel', T.admin, null);
    ok('8: export 200', ex.status === 200, String(ex.status));
    let header = [];
    try {
      const wb = await XLSX.readWorkbook(ex.buf);
      const ws = wb.Sheets[wb.SheetNames[0]];
      header = (XLSX.utils.sheet_to_json(ws, { header: 1 })[0]) || [];
    } catch (e) { ok('8: export parse ' + e.message, false); }
    const tail = ['پیشوند', 'تلفن ۲', 'موبایل اشخاص', 'ایمیل', 'کد ملی', 'شماره اقتصادی', 'کد پستی', 'نام شرکت'];
    ok('8: export has identity columns at the end', JSON.stringify(header.slice(-tail.length)) === JSON.stringify(tail), JSON.stringify(header));
    ok('8: export keeps «موبایل» (phone) column', header.includes('موبایل'));

    const importXlsx = async (rows) => {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'مشتریان');
      const buf = Buffer.from(await XLSX.write(wb));
      const boundary = '----pcfv651' + Date.now();
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="c.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`),
        buf,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const r = await raw('POST', '/api/customers/import', T.admin, body, { 'Content-Type': 'multipart/form-data; boundary=' + boundary });
      let j = null; try { j = JSON.parse(r.buf.toString('utf8')); } catch (_) {}
      return { status: r.status, data: j };
    };
    const im1 = await importXlsx([{ 'نام فروشگاه': 'ایمپورت قدیمی v651', 'نام کامل': 'الف', 'شهر': 'مشهد' }]);
    ok('8: import without new headers → inserted 1', im1.status === 200 && im1.data && im1.data.inserted === 1, JSON.stringify(im1));
    const old = db.prepare("SELECT prefix,mobile FROM customers WHERE biz='ایمپورت قدیمی v651'").get();
    ok('8: old import → empty identity fields', old && old.prefix === '' && old.mobile === '', JSON.stringify(old));
    const im2 = await importXlsx([{ 'نام فروشگاه': 'ایمپورت جدید v651', 'موبایل': '09151111111', 'پیشوند': 'خانم', 'موبایل اشخاص': '09152222222', 'کد پستی': '9188800000' }]);
    ok('8: import with new headers → inserted 1', im2.status === 200 && im2.data && im2.data.inserted === 1, JSON.stringify(im2));
    const neu = db.prepare("SELECT phone,prefix,mobile,postal_code FROM customers WHERE biz='ایمپورت جدید v651'").get();
    ok('8: new import maps headers (موبایل→phone, موبایل اشخاص→mobile)',
      neu && neu.phone === '09151111111' && neu.prefix === 'خانم' && neu.mobile === '09152222222' && neu.postal_code === '9188800000', JSON.stringify(neu));

    try { closeSessionStore(); } catch (_) {}
  } catch (e) {
    ok('HTTP harness: ' + e.message, false);
  }

  // ── 9. static
  const swJs = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');
  const idx = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const modal = extract(/async function custModal\(id\)\{[\s\S]*?\n\}/);
  const pModal = extract(/async function partyModal\(id\)\{[\s\S]*?\n\}/);
  const saveCust = extract(/async function saveCust\(id\)\{[\s\S]*?\n\}/);
  const extra = extract(/function custExtraFieldsHtml\(c\)\{[\s\S]*?\n\}/);
  const syncSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'parties-sync.js'), 'utf8');
  const syncFn = (syncSrc.match(/function syncCustomerToParty\(db, customerId\) \{[\s\S]*?\n\}/) || [''])[0];
  ok('static: custModal renders shared identity block ungated', modal.includes("partyIdentityFieldsHtml('c'") && modal.includes("partyPrefixSelectHtml('c-prefix'"));
  ok('static: custExtraFieldsHtml no longer holds identity fields', !/c-prefix|c-phone2|c-mobile|c-national_id/.test(extra));
  ok('static: partyModal uses shared prefix + identity helpers', pModal.includes("partyPrefixSelectHtml('pty-prefix'") && pModal.includes("partyIdentityFieldsHtml('pty'"));
  ok('static: PARTY_PREFIX_OPTIONS defined once', (appJs.match(/const PARTY_PREFIX_OPTIONS=/g) || []).length === 1);
  ok('static: saveCust identity keys not gated by usesExtendedCoa', saveCust.includes('CUST_IDENTITY_KEYS') && !saveCust.includes('usesExtendedCoa'));
  ok('static: saveCust sends balance only on POST', /if\(!id && el\('c-balance'\)\) data\.balance/.test(saveCust));
  ok('static: saveCust sends credit_limit_rial only when changed', /if\(next!==prevNorm\) data\.credit_limit_rial=next/.test(saveCust));
  ok('static: credit ceiling input only for isManager()', modal.includes('isManager() && editable') && modal.includes('id="c-credit_limit"'));
  ok('static: syncCustomerToParty writes province/address', /province=\?, address=\?/.test(syncFn) && /coa_code, province, address\)/.test(syncFn));
  ok('static: sw >= 651', swAtLeast(swJs, 651));
  const appV = Number((idx.match(/app\.js\?v=(\d+)/) || [])[1] || 0);
  ok('static: index app.js?v >= 651', appV >= 651, String(appV));
  let parsed = true;
  try { new Function(appJs); } catch (e) { parsed = false; console.log(e.message); }
  ok('static: new Function(app.js)', parsed);

  if (server) await new Promise((r) => server.close(r));
  try { db.close(); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  summary('v651 person-customer-fields');
})();
