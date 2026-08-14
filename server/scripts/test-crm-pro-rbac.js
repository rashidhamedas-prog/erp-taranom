#!/usr/bin/env node
/**
 * CRM-PRO RBAC — scoped user_id cannot widen; timeline/drilldown/export same scope.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ok, freshDb, summary } = require('./lib/test-harness');
const { buildDashboard, buildDrilldown, buildTimeline, resolveEffectiveUserId } = require('../lib/crm-analytics');
const { pickFreePort, killProcessTree } = require('./lib/test-server-boot');
const { todayJalali } = require('../jalali');

console.log('══ CRM-PRO RBAC ══');
const { db, cleanup } = freshDb();
try {
  const ua = db.prepare(`INSERT INTO users (username,password,name,role,active) VALUES ('sa','x','A','field_sales',1)`).run().lastInsertRowid;
  const ub = db.prepare(`INSERT INTO users (username,password,name,role,active) VALUES ('sb','x','B','field_sales',1)`).run().lastInsertRowid;
  const ca = db.prepare(`INSERT INTO customers (user_id,biz,phone,status) VALUES (?,'کا','1','active')`).run(ua).lastInsertRowid;
  const cb = db.prepare(`INSERT INTO customers (user_id,biz,phone,status) VALUES (?,'کب','2','active')`).run(ub).lastInsertRowid;
  const today = todayJalali();
  db.prepare(`INSERT INTO invoices (user_id,cust_id,num,type,date,rows,subtotal,disc,disc_amt,final,pay_type)
    VALUES (?,?,?,?,?,'[]',100,0,0,100,'cash')`).run(ua, ca, 'A1', 'normal', today);
  db.prepare(`INSERT INTO invoices (user_id,cust_id,num,type,date,rows,subtotal,disc,disc_amt,final,pay_type)
    VALUES (?,?,?,?,?,'[]',900,0,0,900,'cash')`).run(ub, cb, 'B1', 'normal', today);

  ok('scoped ignores other user_id', buildDashboard(db, { user_id: String(ub) }, ua).kpis.firm_invoice_count === 1);
  ok('user_id=0 keeps scope', buildDashboard(db, { user_id: '0' }, ua).filters.user_id === ua);
  const drill = buildDrilldown(db, 'firm_sales', { user_id: String(ub) }, ua);
  ok('drilldown scoped', drill.every((r) => r.cust_id === ca));
  let denied = false;
  try { buildTimeline(db, { customerId: cb, scopeUserId: ua }); } catch (e) { denied = e.status === 403; }
  ok('timeline 403 other customer', denied);
  ok('resolve ignores 0', resolveEffectiveUserId(ua, { user_id: '0' }) === ua);
  const { crmScopeUserId } = require('../lib/crm-analytics-scope');
  ok('sales_manager scope null', crmScopeUserId({ user: { id: 9, role: 'sales_manager' } }) == null);
  ok('accounting scope null', crmScopeUserId({ user: { id: 8, role: 'accounting' } }) == null);
  ok('admin scope null', crmScopeUserId({ user: { id: 1, role: 'admin' } }) == null);
  ok('field_sales scoped', crmScopeUserId({ user: { id: ua, role: 'field_sales' } }) === ua);
} finally { cleanup(); }

(async () => {
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k];
  process.env.NO_PROXY = '127.0.0.1,localhost';
  const PORT = await pickFreePort(0, { allowFallback: true });
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-pro-rbac-'));
  const env = {
    ...process.env, PORT: String(PORT), DB_PATH: path.join(TMP, 't.db'),
    UPLOADS_DIR: path.join(TMP, 'u'), JWT_SECRET: 'crm-pro-rbac-test-jwt-secret-32chars!!',
    SYNC_ROLE: 'central', NO_PROXY: '127.0.0.1,localhost',
  };
  delete env.HTTP_PROXY; delete env.HTTPS_PROXY;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const base = `http://127.0.0.1:${PORT}`;
    let up = false;
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(base + '/api/system/time'); if (r.ok) { up = true; break; } } catch (_) {}
      await new Promise((r) => setTimeout(r, 250));
    }
    ok('server up', up);
    const login = async (username, password) => {
      const r = await fetch(base + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      return r.json();
    };
    let adminLogin = await login('admin', 'admin123');
    let adminTok = adminLogin.token;
    if (adminLogin.must_change_password && adminTok) {
      await fetch(base + '/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminTok },
        body: JSON.stringify({ oldPass: 'admin123', newPass: 'CrmProAdm1!' }),
      });
      adminLogin = await login('admin', 'CrmProAdm1!');
      adminTok = adminLogin.token;
    }
    ok('admin login', !!adminTok);
    const uname = 'repz_' + Date.now();
    const mk = await fetch(base + '/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminTok },
      body: JSON.stringify({ username: uname, password: 'Repz12345!', name: 'رپ', role: 'field_sales', active: 1 }),
    });
    const created = await mk.json();
    let repLogin = await login(uname, 'Repz12345!');
    if (repLogin.must_change_password && repLogin.token) {
      await fetch(base + '/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + repLogin.token },
        body: JSON.stringify({ oldPass: 'Repz12345!', newPass: 'Repz22345!' }),
      });
      repLogin = await login(uname, 'Repz22345!');
    }
    const tok = repLogin.token;
    ok('rep login', !!tok, JSON.stringify(repLogin.error || created.error || ''));
    const dash = await fetch(base + '/api/crm/dashboard?user_id=1', { headers: { Authorization: 'Bearer ' + tok } });
    const dj = await dash.json();
    ok('http scoped ignores user_id', dash.ok && Number(dj.filters?.user_id) === Number(created.id));
    const zero = await fetch(base + '/api/crm/dashboard?user_id=0', { headers: { Authorization: 'Bearer ' + tok } });
    const zj = await zero.json();
    ok('http user_id=0 still scoped', zero.ok && Number(zj.filters?.user_id) === Number(created.id));
    const unk = await fetch(base + '/api/crm/drilldown?metric=nope', { headers: { Authorization: 'Bearer ' + tok } });
    ok('unknown metric http 400', unk.status === 400);
    const pipeUnk = await fetch(base + '/api/crm/drilldown?metric=pipeline_not_a_stage', { headers: { Authorization: 'Bearer ' + tok } });
    ok('unknown pipeline http 400', pipeUnk.status === 400);
    const foreign = await fetch(base + '/api/followups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
      body: JSON.stringify({ cust_id: 1, subject: 'x', pipeline_stage: 'lost', lost_reason: 'x' }),
    });
    ok('followup other customer 403', foreign.status === 403);
  } finally {
    await killProcessTree(srv);
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  summary('CRM-PRO RBAC');
})().catch((e) => { console.error(e); process.exit(1); });
