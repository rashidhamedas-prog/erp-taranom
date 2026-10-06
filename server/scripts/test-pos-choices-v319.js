/**
 * POS catalog for invoice/settlement pickers.
 * Active terminals are visible to anyone who may post an invoice or a
 * customer settlement. The admin device list stays closed.
 * Run: node server/scripts/test-pos-choices-v319.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-choices-v319-'));
const dbFile = path.join(dir, 't.db');
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-pos-choices-v319-secret-32b-min';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

delete require.cache[require.resolve('../db')];
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

function sessionFor(user, name) {
  const { issueStaffSession } = require('../lib/auth-sessions');
  return issueStaffSession(db, user, {
    device_kind: 'test',
    device_name: name,
    device_fingerprint: name + '-fp',
  }).token;
}

function insertUser(username, role) {
  const id = db.prepare(`
    INSERT INTO users (name, username, password, role, active, must_change_password)
    VALUES (?,?,?,?,1,0)
  `).run(username, username, bcrypt.hashSync('Choices9', 10), role).lastInsertRowid;
  return db.prepare('SELECT id,username,role,name,phone,auth_epoch FROM users WHERE id=?').get(id);
}

(async () => {
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(admin.id);
  const adminTok = sessionFor(admin, 'pos-choices-admin');
  const sales = insertUser('sales.choices', 'field_sales');
  const office = insertUser('office.choices', 'distribution_office');
  const granted = insertUser('sharafi.choices', 'distribution_office');
  db.prepare(`
    INSERT INTO user_permissions (user_id, resource, action, allowed) VALUES (?,?,?,1)
  `).run(granted.id, 'invoices', 'create');
  const settleOnly = insertUser('settle.choices', 'distribution_office');
  db.prepare(`
    INSERT INTO user_permissions (user_id, resource, action, allowed) VALUES (?,?,?,1)
  `).run(settleOnly.id, 'acc_settlements', 'create');

  const salesTok = sessionFor(sales, 'pos-choices-sales');
  const officeTok = sessionFor(office, 'pos-choices-office');
  const grantedTok = sessionFor(granted, 'pos-choices-granted');
  const settleTok = sessionFor(settleOnly, 'pos-choices-settle');

  const app = express();
  app.use(express.json());
  app.use('/api/pos', require('../routes/pos'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const BASE = `http://127.0.0.1:${port}`;

  async function api(method, p, body, tok) {
    const headers = { 'Content-Type': 'application/json' };
    if (tok) headers.Authorization = 'Bearer ' + tok;
    const res = await fetch(BASE + p, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  }

  const bankCoa = '1102-pos-choice';
  db.prepare('INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level) VALUES (?,?,?,?,?)')
    .run(bankCoa, 'بانک تست فهرست', 'asset', '1102', 4);
  const bankId = db.prepare(`
    INSERT INTO banks (name, account_number, active, coa_code) VALUES ('ملت دفتر پخش','9955',1,?)
  `).run(bankCoa).lastInsertRowid;

  const created = await api('POST', '/api/pos/terminals', {
    name: 'دفتر پخش ۱۷ شهریور', terminal_id: 'POS-OK', bank_id: bankId, merchant_id: 'SECRET-MERCHANT',
  }, adminTok);
  ok(created.status === 200 && created.data && created.data.id, 'admin creates terminal', created.data && created.data.error);

  const hidden = await api('POST', '/api/pos/terminals', {
    name: 'خاموش', terminal_id: 'POS-OFF', bank_id: bankId, merchant_id: 'SECRET-OFF',
  }, adminTok);
  ok(hidden.status === 200 && hidden.data && hidden.data.id, 'admin creates second terminal');
  const deactivated = await api('DELETE', '/api/pos/terminals/' + hidden.data.id, undefined, adminTok);
  ok(deactivated.status === 200, 'admin deactivates second terminal', deactivated.status);

  const anon = await api('GET', '/api/pos/terminals/choices');
  ok(anon.status === 401, 'anonymous choices 401', String(anon.status));

  const bare = await api('GET', '/api/pos/terminals/choices', undefined, officeTok);
  ok(bare.status === 403 && bare.data && bare.data.code === 'E_POS_CHOICES',
    'distribution_office without invoice grant 403', bare.status + ' ' + (bare.data && bare.data.code));

  const salesAdminList = await api('GET', '/api/pos/terminals', undefined, salesTok);
  ok(salesAdminList.status === 403, 'field_sales admin list stays 403', String(salesAdminList.status));
  const salesMut = await api('POST', '/api/pos/terminals', {
    name: 'غیرمجاز', terminal_id: 'POS-X', bank_id: bankId,
  }, salesTok);
  ok(salesMut.status === 403, 'field_sales mutate stays 403', String(salesMut.status));

  async function assertChoices(label, tok) {
    const res = await api('GET', '/api/pos/terminals/choices', undefined, tok);
    const rows = Array.isArray(res.data) ? res.data : [];
    const hit = rows.find((t) => t.terminal_id === 'POS-OK');
    ok(res.status === 200 && !!hit, label + ' sees active terminal', res.status + ' ' + JSON.stringify(res.data));
    ok(hit && hit.name === 'دفتر پخش ۱۷ شهریور' && hit.bank_name === 'ملت دفتر پخش',
      label + ' choice has name and bank');
    ok(!rows.some((t) => t.terminal_id === 'POS-OFF'), label + ' hides inactive');
    ok(hit && !('merchant_id' in hit) && !JSON.stringify(hit).includes('SECRET'),
      label + ' omits merchant id');
  }

  await assertChoices('field_sales', salesTok);
  await assertChoices('distribution_office with invoices.create', grantedTok);
  await assertChoices('distribution_office with settlements.create', settleTok);

  const adminChoices = await api('GET', '/api/pos/terminals/choices', undefined, adminTok);
  ok(adminChoices.status === 200 && Array.isArray(adminChoices.data)
    && adminChoices.data.some((t) => t.terminal_id === 'POS-OK')
    && !adminChoices.data.some((t) => t.terminal_id === 'POS-OFF'),
  'admin choices are active-only too');

  server.close();
  try { require('../lib/auth-sessions').closeSessionStore(); } catch (_) {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
