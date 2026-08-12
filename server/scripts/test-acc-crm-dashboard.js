#!/usr/bin/env node
/**
 * ACC-CRM dashboard analytics + RBAC negative cases (unit + HTTP).
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ok, freshDb, summary } = require('./lib/test-harness');
const {
  buildDashboard, buildDrilldown, buildTimeline, resolveEffectiveUserId,
} = require('../lib/crm-analytics');
const {
  pickFreePort, killProcessTree, preferredPort,
} = require('./lib/test-server-boot');

console.log('══ ACC-CRM dashboard analytics ══');
const { db, cleanup } = freshDb();
try {
  const ua = db.prepare(`
    INSERT INTO users (username,password,name,role,active)
    VALUES ('rep_a','x','کارشناس A','field_sales',1)
  `).run();
  const ub = db.prepare(`
    INSERT INTO users (username,password,name,role,active)
    VALUES ('rep_b','x','کارشناس B','field_sales',1)
  `).run();
  const repA = ua.lastInsertRowid;
  const repB = ub.lastInsertRowid;

  const ca = db.prepare(`
    INSERT INTO customers (user_id,biz,phone,city,status)
    VALUES (?,'هم‌نام','09155550005','مشهد','active')
  `).run(repA);
  const cb = db.prepare(`
    INSERT INTO customers (user_id,biz,phone,city,status)
    VALUES (?,'هم‌نام','09155550006','تهران','active')
  `).run(repB);
  const custA = ca.lastInsertRowid;
  const custB = cb.lastInsertRowid;

  // Attach parties for stable cheque binding
  const pa = db.prepare(`
    INSERT INTO parties (person_code, party_type, full_name, phone, legacy_table, legacy_id)
    VALUES ('P-CRM-A','customer','هم‌نام','09155550005','customers',?)
  `).run(custA);
  const pb = db.prepare(`
    INSERT INTO parties (person_code, party_type, full_name, phone, legacy_table, legacy_id)
    VALUES ('P-CRM-B','customer','هم‌نام','09155550006','customers',?)
  `).run(custB);
  db.prepare('UPDATE customers SET party_id=? WHERE id=?').run(pa.lastInsertRowid, custA);
  db.prepare('UPDATE customers SET party_id=? WHERE id=?').run(pb.lastInsertRowid, custB);

  db.prepare(`
    INSERT INTO followups (user_id,cust_id,date,type,subject,status,priority,next_date)
    VALUES (?,?,date('now'),'call','پیگیری A','open','mid',date('now','-1 day'))
  `).run(repA, custA);
  db.prepare(`
    INSERT INTO followups (user_id,cust_id,date,type,subject,status,priority,next_date)
    VALUES (?,?,date('now'),'call','پیگیری B','open','mid',date('now','-1 day'))
  `).run(repB, custB);
  db.prepare(`
    INSERT INTO invoices (user_id,cust_id,num,type,date,rows,subtotal,disc,disc_amt,final,pay_type)
    VALUES (?,?,?,?,date('now'),'[]',1000,0,0,1000,'credit')
  `).run(repA, custA, 'T-CRM-A', 'normal');
  db.prepare(`
    INSERT INTO invoices (user_id,cust_id,num,type,date,rows,subtotal,disc,disc_amt,final,pay_type)
    VALUES (?,?,?,?,date('now'),'[]',9000,0,0,9000,'credit')
  `).run(repB, custB, 'T-CRM-B', 'normal');

  // Cheques: A via customer_id; B via party_id; ambiguous name-only should not leak
  try {
    db.prepare(`
      INSERT INTO cheque_records (direction, cheque_number, due_date, party_name, status, amount, customer_id, party_id, lifecycle_status)
      VALUES ('incoming','CH-A',date('now','+7 day'),'هم‌نام','pending',100000,?,?, 'registered')
    `).run(custA, pa.lastInsertRowid);
  } catch {
    db.exec(`ALTER TABLE cheque_records ADD COLUMN customer_id INTEGER`);
    db.exec(`ALTER TABLE cheque_records ADD COLUMN party_id INTEGER`);
    db.exec(`ALTER TABLE cheque_records ADD COLUMN lifecycle_status TEXT`);
    db.prepare(`
      INSERT INTO cheque_records (direction, cheque_number, due_date, party_name, status, amount, customer_id, party_id, lifecycle_status)
      VALUES ('incoming','CH-A',date('now','+7 day'),'هم‌نام','pending',100000,?,?, 'registered')
    `).run(custA, pa.lastInsertRowid);
  }
  db.prepare(`
    INSERT INTO cheque_records (direction, cheque_number, due_date, party_name, status, amount, customer_id, party_id, lifecycle_status)
    VALUES ('incoming','CH-B',date('now','+7 day'),'هم‌نام','pending',200000,?,?, 'registered')
  `).run(custB, pb.lastInsertRowid);
  db.prepare(`
    INSERT INTO cheque_records (direction, cheque_number, due_date, party_name, status, amount, lifecycle_status)
    VALUES ('incoming','CH-AMB',date('now','+7 day'),'هم‌نام','pending',999999,'registered')
  `).run();

  const dash = buildDashboard(db, {}, null);
  ok('dashboard has kpis', !!dash.kpis);
  ok('open_followups >= 2 privileged', dash.kpis.open_followups >= 2);
  ok('firm_invoice_count >= 2 privileged', dash.kpis.firm_invoice_count >= 2);
  ok('privileged cheque KPI company-wide >= 2', dash.kpis.cheques_due_14d >= 2);

  const scopedA = buildDashboard(db, { user_id: String(repB) }, repA);
  ok('scoped ignores user_id=rep_b (firm only own)', scopedA.kpis.firm_invoice_count === 1);
  ok('scoped filters.user_id stays repA', scopedA.filters.user_id === repA);
  ok('scoped cheque KPI not company-wide', scopedA.kpis.cheques_due_14d === 1);

  const scopedZero = buildDashboard(db, { user_id: '0' }, repA);
  ok('user_id=0 does not drop scope', scopedZero.kpis.firm_invoice_count === 1
    && scopedZero.filters.user_id === repA);

  const drillB = buildDrilldown(db, 'firm_sales', { user_id: String(repB) }, repA);
  ok('drilldown ignores override — no rep_b rows', !drillB.some((r) => r.cust_id === custB));
  ok('drilldown still has rep_a', drillB.some((r) => r.cust_id === custA));

  const tlA = buildTimeline(db, { customerId: custA, limit: 50 });
  ok('timeline A has invoice', tlA.events.some((e) => e.kind === 'invoice'));
  ok('timeline A cheque via customer_id (not ambiguous name leak of CH-AMB alone as only)',
    tlA.events.filter((e) => e.kind === 'cheque').some((e) => e.title.includes('CH-A')));
  // Same-name customers: ambiguous party_name must NOT attach CH-AMB uniquely
  const ambOnA = tlA.events.filter((e) => e.kind === 'cheque' && e.title.includes('CH-AMB'));
  ok('ambiguous same-name cheque not attached via legacy name', ambOnA.length === 0);

  let denied = false;
  try {
    buildTimeline(db, { customerId: custB, scopeUserId: repA });
  } catch (e) {
    denied = e.status === 403;
  }
  ok('timeline 403 for other rep customer', denied);

  ok('resolveEffectiveUserId scoped ignores 0',
    resolveEffectiveUserId(repA, { user_id: '0' }) === repA);
  ok('resolveEffectiveUserId privileged allows filter',
    resolveEffectiveUserId(null, { user_id: String(repB) }) === repB);
} finally {
  cleanup();
}

// ---- HTTP negative ----
(async () => {
  console.log('\n══ ACC-CRM dashboard HTTP RBAC ══');
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete process.env[k];
  }
  process.env.NO_PROXY = '127.0.0.1,localhost';
  const PORT = await pickFreePort(0, { allowFallback: true });
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-crm-dash-'));
  const env = {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: path.join(TMP, 't.db'),
    UPLOADS_DIR: path.join(TMP, 'u'),
    JWT_SECRET: 'acc-crm-unify-test-jwt-secret-32chars!!',
    SYNC_ROLE: 'central',
    NO_PROXY: '127.0.0.1,localhost',
  };
  delete env.HTTP_PROXY; delete env.HTTPS_PROXY; delete env.http_proxy; delete env.https_proxy;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  srv.stderr.on('data', (d) => { stderr += d.toString(); });
  srv.stdout.on('data', (d) => { stdout += d.toString(); });
  const base = `http://127.0.0.1:${PORT}`;
  console.log('[http] PORT=' + PORT);
  try {
    let up = false;
    for (let i = 0; i < 120; i++) {
      if (srv.exitCode != null) throw new Error('exit ' + srv.exitCode + ' ' + (stderr + stdout).slice(-800));
      try {
        const r = await fetch(base + '/api/system/time', { signal: AbortSignal.timeout(1500) });
        if (r.ok) { up = true; break; }
      } catch { /* */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!up) throw new Error('server not up: ' + (stderr + stdout).slice(-800));

    let login = await (await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    })).json();
    let adminTok = login.token;
    if (login.must_change_password) {
      await fetch(base + '/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminTok },
        body: JSON.stringify({ oldPass: 'admin123', newPass: 'AccCrmDash1!' }),
      });
      login = await (await fetch(base + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'AccCrmDash1!' }),
      })).json();
      adminTok = login.token;
    }

    const unameA = 'http_rep_a_' + Date.now();
    const unameB = 'http_rep_b_' + Date.now();
    const mkUser = async (username) => {
      const r = await fetch(base + '/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminTok },
        body: JSON.stringify({
          username, password: 'RepPass1!', name: username, role: 'field_sales',
          phone: '0915' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0'),
        }),
      });
      const body = await r.json();
      return { ...body, username, id: body.id || body.user?.id, status: r.status };
    };
    const a = await mkUser(unameA);
    const b = await mkUser(unameB);
    ok('created http reps', a.status < 300 && b.status < 300 && a.id && b.id,
      JSON.stringify({ a: a.error || a.status, b: b.error || b.status }));
    const idA = a.id;
    const idB = b.id;

    let loginA = await (await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: unameA, password: 'RepPass1!' }),
    })).json();
    if (loginA.must_change_password && loginA.token) {
      await fetch(base + '/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + loginA.token },
        body: JSON.stringify({ oldPass: 'RepPass1!', newPass: 'RepPass2!' }),
      });
      loginA = await (await fetch(base + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: unameA, password: 'RepPass2!' }),
      })).json();
    }
    const tokenA = loginA.token;
    ok('rep_a login', !!tokenA, JSON.stringify(loginA.error || { must: loginA.must_change_password }));

    const Database = require('better-sqlite3');
    const raw = new Database(path.join(TMP, 't.db'));
    raw.prepare(`
      INSERT INTO customers (user_id,biz,phone,city,status) VALUES (?,'CustA','09151110001','مشهد','active')
    `).run(idA);
    raw.prepare(`
      INSERT INTO customers (user_id,biz,phone,city,status) VALUES (?,'CustB','09151110002','تهران','active')
    `).run(idB);
    const cA = raw.prepare("SELECT id FROM customers WHERE biz='CustA'").get().id;
    const cB = raw.prepare("SELECT id FROM customers WHERE biz='CustB'").get().id;
    raw.prepare(`
      INSERT INTO invoices (user_id,cust_id,num,type,date,rows,subtotal,disc,disc_amt,final,pay_type)
      VALUES (?,?,?,?,date('now'),'[]',111,0,0,111,'credit')
    `).run(idA, cA, 'HA-1', 'normal');
    raw.prepare(`
      INSERT INTO invoices (user_id,cust_id,num,type,date,rows,subtotal,disc,disc_amt,final,pay_type)
      VALUES (?,?,?,?,date('now'),'[]',222,0,0,222,'credit')
    `).run(idB, cB, 'HB-1', 'normal');
    raw.close();

    const dashOverrideRes = await fetch(base + '/api/crm/dashboard?user_id=' + idB, {
      headers: { Authorization: 'Bearer ' + tokenA },
    });
    const dashOverride = await dashOverrideRes.json();
    ok('HTTP scoped ignores user_id=rep_b',
      dashOverrideRes.status === 200
      && Number(dashOverride.filters?.user_id) === Number(idA)
      && Number(dashOverride.kpis?.firm_invoice_count) === 1,
      JSON.stringify({ status: dashOverrideRes.status, filters: dashOverride.filters, kpis: dashOverride.kpis, err: dashOverride.error }));

    const dash0Res = await fetch(base + '/api/crm/dashboard?user_id=0', {
      headers: { Authorization: 'Bearer ' + tokenA },
    });
    const dash0 = await dash0Res.json();
    ok('HTTP user_id=0 keeps scope',
      dash0Res.status === 200
      && Number(dash0.filters?.user_id) === Number(idA)
      && Number(dash0.kpis?.firm_invoice_count) === 1,
      JSON.stringify({ status: dash0Res.status, filters: dash0.filters, kpis: dash0.kpis }));

    const drillRes = await fetch(base + '/api/crm/drilldown?metric=firm_sales&user_id=' + idB, {
      headers: { Authorization: 'Bearer ' + tokenA },
    });
    const drill = await drillRes.json();
    ok('HTTP drilldown no rep_b rows',
      drillRes.status === 200 && !(drill.rows || []).some((r) => r.cust_id === cB),
      JSON.stringify({ status: drillRes.status, n: (drill.rows || []).length, err: drill.error }));
  } catch (e) {
    console.error('HTTP harness error', e.message);
    ok('HTTP harness', false, e.message);
  } finally {
    await killProcessTree(srv);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
  }
  summary('ACC-CRM dashboard');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
