#!/usr/bin/env node
'use strict';
/**
 * v642 — professional notification inbox (jalali Tehran, live cheques, per-user state).
 * Run with Node 20: node server/scripts/test-notifications-inbox-v642.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const vm = require('vm');
const { swAtLeast } = require('./lib/sw-at-least');

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-inbox-v642-'));
const dbFile = path.join(dir, 't.db');
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-notifications-inbox-v642-secret-32c!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';
process.env.NODE_ENV = 'test';

const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

const jalali = require('../jalali');
const { addJalaliDaysApprox } = require('../lib/cheque-register-query');
const inbox = require('../lib/notification-inbox');
const notif = require('../lib/notifications');

console.log('\n[1] diffJalaliDays / addJalaliDaysExact');
{
  ok(jalali.diffJalaliDays('1405/08/22', '1405/08/21') === 1, '08/22−08/21 = 1');
  ok(jalali.diffJalaliDays('1405/08/20', '1405/08/21') === -1, '08/20−08/21 = −1');
  ok(jalali.diffJalaliDays('1405/09/17', '1405/08/21') === 26, '09/17−08/21 = 26');
  ok(jalali.diffJalaliDays('1405/10/25', '1405/08/21') === 64, '10/25−08/21 = 64');
  ok(jalali.diffJalaliDays('1405/09/01', '1405/08/30') === 1, '09/01−08/30 = 1');
  ok(jalali.diffJalaliDays('1406/01/01', '1405/12/29') === 1, '1406/01/01−1405/12/29 = 1');
  ok(addJalaliDaysApprox('1405/08/29', 3) === '1405/09/02', 'add 3 from 08/29');
  ok(addJalaliDaysApprox('1405/12/28', 3) === '1406/01/02', 'add 3 across year');
}

console.log('\n[2] todayJalaliTehran around midnight');
{
  ok(jalali.todayJalaliTehran(new Date('2026-11-11T20:31:00Z')) === '1405/08/21', '00:01 Tehran');
  ok(jalali.todayJalaliTehran(new Date('2026-11-11T20:29:00Z')) === '1405/08/20', '23:59 Tehran prev');
}

function seedUser(username, role) {
  const info = db.prepare(`
    INSERT INTO users (name, username, password, role, active, must_change_password)
    VALUES (?,?,?,?,1,0)
  `).run(username, username, 'x', role);
  return { id: Number(info.lastInsertRowid), username, role, name: username };
}

const adminA = seedUser('admin_a_v642', 'admin');
const adminB = seedUser('admin_b_v642', 'admin');
const distUser = seedUser('dist_office_v642', 'distribution_office');

function insertCheque({ id, number, direction, due, amount, party, lifecycle = 'registered', record = 'posted' }) {
  db.prepare(`
    INSERT INTO cheque_records (
      id, direction, cheque_number, due_date, amount, party_name,
      lifecycle_status, record_status, created_at
    ) VALUES (?,?,?,?,?,?,?,?,strftime('%s','now'))
  `).run(id, direction, number, due, amount, party, lifecycle, record);
}

console.log('\n[3] live cheque buckets (screenshot fixtures)');
{
  insertCheque({ id: 25, number: '12398', direction: 'out', due: '1405/08/21', amount: 287500000, party: 'حامد' });
  insertCheque({ id: 28, number: '491522', direction: 'in', due: '1405/08/20', amount: 300000000, party: 'راهدان' });
  insertCheque({ id: 15, number: '315110', direction: 'in', due: '1405/08/22', amount: 800000000, party: 'بیوتی' });
  insertCheque({ id: 99, number: 'FAR', direction: 'in', due: '1405/09/17', amount: 1, party: 'دور' });
  // stale cheque_due rows must not render
  db.prepare(`
    INSERT INTO app_notifications (id, kind, entity_type, entity_id, title, body, target_roles, created_at)
    VALUES (101,'cheque_due','cheque_record',25,'سررسید چک ۳ روز دیگر','x','["admin","accounting"]',strftime('%s','now'))
  `).run();
  db.prepare(`
    INSERT INTO app_notifications (kind, entity_type, entity_id, title, body, target_roles, created_at)
    VALUES ('cheque_due','cheque_record',25,'سررسید چک امروز','x','["admin","accounting"]',strftime('%s','now'))
  `).run();

  const now = new Date('2026-11-12T12:02:00Z');
  const built = inbox.buildInbox(db, adminA, { now });
  const chq = built.items.filter((i) => i.source === 'cheque');
  const c25 = chq.filter((i) => i.target && i.target.id === 25);
  ok(c25.length === 1, 'cheque 25 exactly once', c25.length);
  ok(c25[0] && c25[0].bucket === 'today', '25 today', c25[0] && c25[0].bucket);
  ok(c25[0] && c25[0].title === 'چک پرداختی — سررسید امروز', '25 title', c25[0] && c25[0].title);
  const c28 = chq.find((i) => i.target && i.target.id === 28);
  ok(c28 && c28.bucket === 'overdue' && c28.days === -1, '28 overdue -1', c28);
  ok(c28 && /1 روز از سررسید گذشته/.test(c28.title) && c28.severity === 'danger', '28 title/severity', c28 && c28.title);
  const c15 = chq.find((i) => i.target && i.target.id === 15);
  ok(c15 && c15.bucket === 'soon' && c15.days === 1, '15 soon tomorrow', c15);
  ok(c15 && /فردا/.test(c15.title), '15 title فردا', c15 && c15.title);
  ok(!chq.some((i) => i.target && i.target.id === 99), 'far due hidden');
  ok(!built.items.some((i) => i.kind === 'cheque_due'), 'legacy cheque_due not rendered');
}

console.log('\n[4] cleared cheque + bucket key change');
{
  db.prepare("UPDATE cheque_records SET lifecycle_status='cleared' WHERE id=28").run();
  let built = inbox.buildInbox(db, adminA, { now: new Date('2026-11-12T12:02:00Z') });
  ok(!built.items.some((i) => i.source === 'cheque' && i.target.id === 28), 'cleared gone');
  db.prepare("UPDATE cheque_records SET lifecycle_status='registered' WHERE id=28").run();
  // day roll for 15: 08/22 → today when now is 08/22
  built = inbox.buildInbox(db, adminA, { now: new Date('2026-11-13T12:02:00Z') });
  const c15 = built.items.find((i) => i.source === 'cheque' && i.target.id === 15);
  ok(c15 && c15.bucket === 'today' && c15.key.includes(':today'), '15 becomes today key', c15 && c15.key);
  ok(c15 && !c15.read, 'new bucket unread');
}

console.log('\n[5] invoice_new title from join');
{
  const custId = db.prepare("INSERT INTO customers (user_id,biz,phone,balance) VALUES (?,?,?,0)")
    .run(adminA.id, 'مشتری تست v642', '09120000000').lastInsertRowid;
  const invN = db.prepare(`
    INSERT INTO invoices (user_id,cust_id,num,date,type,rows,subtotal,final,approved,deleted_at)
    VALUES (?,?,?,?,?,?,?,?,0,NULL)
  `).run(adminA.id, custId, 'T-9058', '1405/08/21', 'normal', '[]', 12470000, 12470000).lastInsertRowid;
  const invP = db.prepare(`
    INSERT INTO invoices (user_id,cust_id,num,date,type,rows,subtotal,final,approved)
    VALUES (?,?,?,?,?,?,?,?,0)
  `).run(adminA.id, custId, 'T-9060', '1405/08/21', 'proforma', '[]', 100, 100).lastInsertRowid;
  const invDel = db.prepare(`
    INSERT INTO invoices (user_id,cust_id,num,date,type,rows,subtotal,final,approved,deleted_at)
    VALUES (?,?,?,?,?,?,?,?,0,strftime('%s','now'))
  `).run(adminA.id, custId, 'T-9061', '1405/08/21', 'normal', '[]', 50, 50).lastInsertRowid;

  db.prepare(`
    INSERT INTO app_notifications (kind, entity_type, entity_id, title, body, target_roles, created_at)
    VALUES ('invoice_new','invoice',?, 'فاکتور جدید T-9058', 'پیش‌فاکتور — x', '["admin","accounting"]', strftime('%s','now'))
  `).run(invN);
  db.prepare(`
    INSERT INTO app_notifications (kind, entity_type, entity_id, title, body, target_roles, created_at)
    VALUES ('invoice_new','invoice',?, 'فاکتور جدید T-9060', 'بد', '["admin","accounting"]', strftime('%s','now'))
  `).run(invP);
  db.prepare(`
    INSERT INTO app_notifications (kind, entity_type, entity_id, title, body, target_roles, created_at)
    VALUES ('invoice_new','invoice',?, 'فاکتور جدید T-9061', 'bad', '["admin","accounting"]', strftime('%s','now'))
  `).run(invDel);

  const built = inbox.buildInbox(db, adminA, { now: new Date('2026-11-12T12:02:00Z') });
  const n1 = built.items.find((i) => i.ref_label === 'T-9058');
  const n2 = built.items.find((i) => i.ref_label === 'T-9060');
  const n3 = built.items.find((i) => i.ref_label === 'T-9061');
  ok(n1 && n1.title === 'فاکتور معمولی جدید T-9058', 'normal title', n1 && n1.title);
  ok(n1 && n1.amount_rial === 12470000, 'amount numeric');
  ok(n2 && n2.title === 'پیش‌فاکتور جدید T-9060', 'proforma title', n2 && n2.title);
  ok(n3 && n3.severity === 'muted' && /باطل/.test(n3.subtitle || ''), 'deleted muted');
}

console.log('\n[6] recon nightly dedupe + history + GET /runs/:id');
(async () => {
  const recon = require('../lib/subledger-recon');
  for (let i = 0; i < 5; i++) {
    const run = recon.runNightlyRecon(db, { date: `1405/08/${10 + i}` });
    ok(!!run.run_id, 'run ' + i);
  }
  const built = inbox.buildInbox(db, adminA, { now: new Date('2026-11-12T12:02:00Z') });
  const reconItems = built.items.filter((i) => i.kind === 'subledger_recon_nightly');
  ok(reconItems.length === 1, 'only latest recon item', reconItems.length);
  ok(built.recon_history.length >= 5, 'history >=5', built.recon_history.length);

  const app = express();
  app.use(express.json());
  app.use('/api/notifications', require('../routes/notifications'));
  app.use('/api/accounting/subledger-recon', require('../routes/subledger-recon'));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const { issueStaffSession } = require('../lib/auth-sessions');
  const tokenA = issueStaffSession(db, adminA, {
    device_kind: 'test', device_name: 'v642a', device_fingerprint: 'v642a',
  }).token;
  const tokenB = issueStaffSession(db, adminB, {
    device_kind: 'test', device_name: 'v642b', device_fingerprint: 'v642b',
  }).token;
  const tokenD = issueStaffSession(db, distUser, {
    device_kind: 'test', device_name: 'v642d', device_fingerprint: 'v642d',
  }).token;

  function req(method, url, body, token) {
    return new Promise((resolve, reject) => {
      const data = body != null ? JSON.stringify(body) : null;
      const r = http.request({
        hostname: '127.0.0.1', port, path: url, method,
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch { json = buf; }
          resolve({ status: res.statusCode, json });
        });
      });
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });
  }

  const runId = built.recon_history[0].run_id;
  const got = await req('GET', '/api/accounting/subledger-recon/runs/' + runId, null, tokenA);
  ok(got.status === 200 && got.json && got.json.run_id === runId, 'GET /runs/:id', got.status);

  console.log('\n[7] per-user read/dismiss');
  const beforeNotif = db.prepare("SELECT COUNT(*) n, SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) u FROM app_notifications").get();
  const beforeChq = db.prepare('SELECT COUNT(*) n, SUM(id) s, SUM(amount) a FROM cheque_records').get();
  const chqKey = inbox.buildInbox(db, adminA, { now: new Date('2026-11-12T12:02:00Z') })
    .items.find((i) => i.source === 'cheque' && i.target.id === 25)?.key;
  ok(!!chqKey, 'has chq key');
  let r = await req('POST', '/api/notifications/read', { keys: [chqKey] }, tokenA);
  ok(r.status === 200 && r.json.accepted >= 1, 'A read accepted');
  r = await req('POST', '/api/notifications/dismiss', { keys: [chqKey] }, tokenA);
  ok(r.status === 200 && r.json.accepted >= 1, 'A dismiss accepted');
  const forB = inbox.buildInbox(db, adminB, { now: new Date('2026-11-12T12:02:00Z') });
  const bItem = forB.items.find((i) => i.key === chqKey);
  ok(bItem && !bItem.read && !bItem.dismissed, 'B still unread');
  const afterNotif = db.prepare("SELECT COUNT(*) n, SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) u FROM app_notifications").get();
  const afterChq = db.prepare('SELECT COUNT(*) n, SUM(id) s, SUM(amount) a FROM cheque_records').get();
  ok(beforeNotif.n === afterNotif.n && beforeNotif.u === afterNotif.u, 'app_notifications unchanged');
  ok(beforeChq.n === afterChq.n && beforeChq.s === afterChq.s && beforeChq.a === afterChq.a, 'cheque_records unchanged');
  r = await req('POST', '/api/notifications/read-all', {}, tokenA);
  ok(r.status === 200, 'read-all');
  const afterAll = inbox.buildInbox(db, adminA, { now: new Date('2026-11-12T12:02:00Z') });
  ok(afterAll.counts.unread === 0, 'A unread=0', afterAll.counts.unread);

  console.log('\n[8] RBAC');
  const distInbox = inbox.buildInbox(db, distUser, { now: new Date('2026-11-12T12:02:00Z') });
  ok(distInbox.items.every((i) => i.kind === 'app_update' || i.source === 'action'), 'dist mostly app_update/actions', distInbox.items.map((i) => i.kind).join(','));
  ok(!distInbox.items.some((i) => i.source === 'cheque'), 'dist no cheques');
  r = await req('POST', '/api/notifications/read', { keys: [chqKey] }, tokenD);
  ok(r.status === 200 && (r.json.accepted || 0) === 0, 'dist read cheque accepted:0', r.json);
  // seed a notification targeted only to admin for resolve 403
  const nid = db.prepare(`
    INSERT INTO app_notifications (kind, entity_type, entity_id, title, body, target_roles, created_at)
    VALUES ('alert','production_health',NULL,'x','y','["admin","accounting"]',strftime('%s','now'))
  `).run().lastInsertRowid;
  r = await req('POST', `/api/notifications/${nid}/resolve`, {}, tokenD);
  ok(r.status === 403, 'resolve 403 for dist', r.status);
  const beforeResolve = db.prepare('SELECT resolved_at FROM app_notifications WHERE id=?').get(nid);
  await req('POST', '/api/notifications/entity-viewed', { entity_type: 'production_health', entity_id: 0 }, tokenA);
  // entity_id nullish — use real invoice entity
  const invRow = db.prepare("SELECT id FROM invoices WHERE num='T-9058'").get();
  const nInv = db.prepare("SELECT id, resolved_at FROM app_notifications WHERE entity_type='invoice' AND entity_id=?").get(invRow.id);
  await req('POST', '/api/notifications/entity-viewed', { entity_type: 'invoice', entity_id: invRow.id }, tokenA);
  const nInvAfter = db.prepare('SELECT resolved_at FROM app_notifications WHERE id=?').get(nInv.id);
  ok(nInvAfter.resolved_at == null, 'entity-viewed does not global resolve', nInvAfter);

  console.log('\n[9] register-update mismatch');
  r = await req('POST', '/api/notifications/register-update', { platform: 'web', version: '0.0.0-bad' }, tokenA);
  ok(r.status === 400, 'bad version 400', r.status);
  const updCount = db.prepare("SELECT COUNT(*) n FROM app_notifications WHERE kind='app_update' AND title LIKE '%0.0.0-bad%'").get().n;
  ok(updCount === 0, 'no bad update row');

  console.log('\n[10] maybeRunNightlyRecon Tehran clock');
  {
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('subledger_recon_nightly_enabled','1')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('subledger_recon_nightly_time','02:00')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('subledger_recon_nightly_last_date','1405/08/20')").run();
    // 2026-11-11 22:31 UTC = 1405/08/21 02:01 Tehran
    const ran = recon.maybeRunNightlyRecon(db, { now: new Date('2026-11-11T22:31:00Z') });
    ok(ran.ran === true, 'runs at 02:01 Tehran', ran);
    const again = recon.maybeRunNightlyRecon(db, { now: new Date('2026-11-11T22:40:00Z') });
    ok(again.ran === false && again.reason === 'already_ran', 'already_ran same Tehran day', again);
  }

  console.log('\n[11] production notifyRoles inserts');
  {
    const before = db.prepare("SELECT COUNT(*) n FROM app_notifications WHERE kind='production_cost_deviation'").get().n;
    // call checkCostDeviation via require path: simulate notify
    notif.notifyRoles(db, {
      kind: 'production_cost_deviation', entity_type: 'production_order', entity_id: 1,
      title: 'انحراف بهای تولید', body: 'test', target_roles: ['admin', 'accounting'],
    });
    notif.notifyRoles(db, {
      kind: 'production_period_reopen', entity_type: 'production_period_close', entity_id: 1,
      title: 'بازکردن دوره', body: 'test', target_roles: ['admin', 'accounting'],
    });
    const afterDev = db.prepare("SELECT COUNT(*) n FROM app_notifications WHERE kind='production_cost_deviation'").get().n;
    const afterRe = db.prepare("SELECT COUNT(*) n FROM app_notifications WHERE kind='production_period_reopen'").get().n;
    ok(afterDev === before + 1, 'cost deviation inserted');
    ok(afterRe >= 1, 'period reopen inserted');
    // source code wiring
    const engine = fs.readFileSync(path.join(__dirname, '../lib/production/engine.js'), 'utf8');
    const close = fs.readFileSync(path.join(__dirname, '../lib/production/close.js'), 'utf8');
    ok(/production_cost_deviation/.test(engine), 'engine.js uses kind');
    ok(/production_period_reopen/.test(close), 'close.js uses kind');
  }

  console.log('\n[12] UI vm smoke');
  {
    const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
    ok(/async function notifClick\(/.test(appJs), 'notifClick present');
    ok(/openChequeLeafModal/.test(appJs), 'cheque modal wired');
    ok(!/POST','\/notifications\/'\+id\+'\/resolve'/.test(appJs) && !/\/notifications\/'\s*\+\s*id\s*\+\s*'\/resolve'/.test(appJs),
      'notifClick does not call /resolve');
    // soft check: old resolve pattern removed from notifClick body
    const fn = appJs.match(/async function notifClick\([\s\S]*?\nasync function /);
    const body = fn ? fn[0] : '';
    ok(!/\/notifications\/'\+id\+'\/resolve/.test(body), 'no resolve in notifClick', !!body);
    ok(/سررسید گذشته/.test(appJs), 'group overdue label');
    ok(/۷ روز آینده/.test(appJs), 'group soon label');
    ok(/_notifBadgeText/.test(appJs), 'badge helper');
    ok(/toFa\(99\)\+'\+'/.test(appJs) || /n>99/.test(appJs), '99+ badge');
    const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
    ok(swAtLeast(sw, 642), 'SW >= 642');
    try {
      // eslint-disable-next-line no-new-func
      new Function(appJs);
      ok(true, 'app.js parses');
    } catch (e) {
      ok(false, 'app.js parse', e.message);
    }
  }

  server.close();
  try { require('../lib/auth-sessions').closeSessionStore(); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
