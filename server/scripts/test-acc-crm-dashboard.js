#!/usr/bin/env node
const { ok, freshDb, summary } = require('./lib/test-harness');
const { buildDashboard, buildTimeline } = require('../lib/crm-analytics');

console.log('══ ACC-CRM dashboard analytics ══');
const { db, cleanup } = freshDb();
try {
  const u = db.prepare(`
    INSERT INTO users (username,password,name,role,active)
    VALUES ('crm_dash_u','x','کارشناس CRM','field_sales',1)
  `).run();
  const userId = u.lastInsertRowid;
  const c = db.prepare(`
    INSERT INTO customers (user_id,biz,phone,city,status)
    VALUES (?,'مشتری CRM','09155550005','مشهد','active')
  `).run(userId);
  const custId = c.lastInsertRowid;
  db.prepare(`
    INSERT INTO followups (user_id,cust_id,date,type,subject,status,priority,next_date)
    VALUES (?,?,date('now'),'call','پیگیری تست','open','mid',date('now','-1 day'))
  `).run(userId, custId);
  db.prepare(`
    INSERT INTO invoices (user_id,cust_id,num,type,date,rows,subtotal,disc,disc_amt,final,pay_type)
    VALUES (?,?,?,?,date('now'),'[]',1000,0,0,1000,'credit')
  `).run(userId, custId, 'T-CRM-1', 'normal');
  db.prepare(`
    INSERT INTO invoices (user_id,cust_id,num,type,date,rows,subtotal,disc,disc_amt,final,pay_type)
    VALUES (?,?,?,?,date('now'),'[]',500,0,0,500,'credit')
  `).run(userId, custId, 'T-CRM-2', 'proforma');

  const dash = buildDashboard(db, {}, null);
  ok('dashboard has kpis', !!dash.kpis);
  ok('open_followups >= 1', dash.kpis.open_followups >= 1);
  ok('firm_invoice_count >= 1', dash.kpis.firm_invoice_count >= 1);
  ok('invoices_by_type array', Array.isArray(dash.invoices_by_type));

  const scoped = buildDashboard(db, {}, userId);
  ok('scoped dashboard firm count >= 1', scoped.kpis.firm_invoice_count >= 1);

  const tl = buildTimeline(db, { customerId: custId, limit: 20 });
  ok('timeline has events', tl.total >= 2);
  ok('timeline includes invoice', tl.events.some((e) => e.kind === 'invoice'));
  ok('timeline includes followup', tl.events.some((e) => e.kind === 'followup'));
} finally {
  cleanup();
}
summary('ACC-CRM dashboard');
