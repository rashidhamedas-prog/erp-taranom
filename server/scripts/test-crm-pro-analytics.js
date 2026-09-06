#!/usr/bin/env node
/**
 * CRM-PRO-ANALYTICS — model, pipeline, conversion, filters, reconciliation.
 */
const { ok, eq, freshDb, summary } = require('./lib/test-harness');
const { buildDashboard, buildDrilldown, resolveEffectiveUserId } = require('../lib/crm-analytics');
const { migrateFollowupsToOpportunities, STAMP } = require('../lib/crm-pro-schema');
const crmPro = require('../lib/crm-pro');
const analytics = require('../lib/crm-pro-analytics');
const { todayJalali, addDaysToJalali } = require('../jalali');

console.log('══ CRM-PRO analytics ══');
const { db, cleanup } = freshDb();
try {
  const u1 = db.prepare(`INSERT INTO users (username,password,name,role,active) VALUES ('r1','x','ر۱','field_sales',1)`).run().lastInsertRowid;
  const u2 = db.prepare(`INSERT INTO users (username,password,name,role,active) VALUES ('r2','x','ر۲','field_sales',1)`).run().lastInsertRowid;
  const c1 = db.prepare(`INSERT INTO customers (user_id,biz,phone,city,status) VALUES (?,'الف','0912','مشهد','active')`).run(u1).lastInsertRowid;
  const c2 = db.prepare(`INSERT INTO customers (user_id,biz,phone,city,status) VALUES (?,'ب','0913','تهران','active')`).run(u2).lastInsertRowid;
  const today = todayJalali();
  db.prepare(`INSERT INTO followups (user_id,cust_id,date,type,subject,status,priority,pipeline_stage,purchase_prob,next_date)
    VALUES (?,?,?,'call','A','open','mid','proposal',40,?)`).run(u1, c1, today, addDaysToJalali(today, -2));
  db.prepare(`INSERT INTO followups (user_id,cust_id,date,type,subject,status,priority,pipeline_stage,purchase_prob)
    VALUES (?,?,?,'call','B','done','mid','lead',10)`).run(u2, c2, today);
  db.prepare(`INSERT INTO invoices (user_id,cust_id,num,type,date,rows,subtotal,disc,disc_amt,final,pay_type)
    VALUES (?,?,?,?,?,'[]',5000,0,0,5000,'cash')`).run(u1, c1, 'N-1', 'normal', today);
  db.prepare(`INSERT INTO invoices (user_id,cust_id,num,type,date,rows,subtotal,disc,disc_amt,final,pay_type)
    VALUES (?,?,?,?,?,'[]',9000,0,0,9000,'cash')`).run(u1, c1, 'P-1', 'proforma', today);
  db.prepare(`INSERT INTO invoices (user_id,cust_id,num,type,date,rows,subtotal,disc,disc_amt,final,pay_type,status)
    VALUES (?,?,?,?,?,'[]',111,0,0,111,'cash','reversed')`).run(u1, c1, 'R-1', 'normal', today);

  const stamp1 = db.prepare('SELECT value FROM settings WHERE key=?').get(STAMP)?.value;
  ok('migration stamped on init', stamp1 === '1');
  const migSeed = migrateFollowupsToOpportunities(db);
  ok('seed followups backfilled', migSeed.created >= 1);
  const firstCount = db.prepare('SELECT COUNT(*) AS c FROM crm_opportunities').get().c;
  ok('opportunities after backfill', firstCount >= 1);
  const mig2 = migrateFollowupsToOpportunities(db);
  ok('second migration skipped', mig2.skipped === true);
  eq('no extra opportunities on rerun', db.prepare('SELECT COUNT(*) AS c FROM crm_opportunities').get().c, firstCount);
  ok('legacy followups still visible', db.prepare('SELECT COUNT(*) AS c FROM followups').get().c >= 2);

  const dash = buildDashboard(db, { from: today, to: today }, null);
  ok('pipeline uses stage not status', (dash.pipeline || []).every((p) => !['open', 'done', 'cancel'].includes(p.stage) || p.cnt === 0 || ['lead', 'qualified', 'proposal'].includes(p.stage)));
  const pipeStages = (dash.pipeline_detail || dash.pipeline || []).map((p) => p.stage);
  ok('pipeline has proposal or lead', pipeStages.includes('proposal') || pipeStages.includes('lead') || pipeStages.includes('first_order'));
  ok('proforma excluded from firm count', dash.kpis.firm_invoice_count === 1);
  ok('reversed excluded', dash.kpis.firm_sales_rial === 5000);
  ok('firm includes normal', dash.kpis.firm_invoice_count === 1);

  const drillFirm = buildDrilldown(db, 'firm_sales', { from: today, to: today }, null);
  eq('firm drilldown total == KPI', drillFirm.total, dash.kpis.firm_invoice_count);
  eq('firm drilldown amount', drillFirm.reduce((a, r) => a + (r.final_rial || r.final || 0), 0), dash.kpis.firm_sales_rial);

  let unknown = false;
  try { buildDrilldown(db, 'not_a_metric', {}, null); } catch (e) { unknown = e.status === 400; }
  ok('unknown metric 400', unknown);

  const opp = db.prepare('SELECT * FROM crm_opportunities WHERE customer_id=?').get(c1);
  ok('opportunity migrated', !!opp);
  const histBefore = db.prepare('SELECT COUNT(*) AS c FROM crm_stage_history WHERE opportunity_id=?').get(opp.id).c;
  const same = crmPro.changeOpportunityStage(db, opp.id, opp.pipeline_stage, { userId: u1 });
  ok('same stage no extra history', same.changed === false);
  eq('history unchanged on repeat', db.prepare('SELECT COUNT(*) AS c FROM crm_stage_history WHERE opportunity_id=?').get(opp.id).c, histBefore);

  let lostFail = false;
  try { crmPro.changeOpportunityStage(db, opp.id, 'lost', { userId: u1 }); } catch (e) { lostFail = e.status === 400; }
  ok('lost without reason rejected', lostFail);
  const lost = crmPro.changeOpportunityStage(db, opp.id, 'lost', { userId: u1, lostReason: 'قیمت' });
  ok('lost with reason ok', lost.changed === true && lost.opportunity.pipeline_stage === 'lost');

  const wonInv = db.prepare(`SELECT id FROM invoices WHERE num='N-1'`).get();
  const fresh = db.prepare(`INSERT INTO crm_opportunities (customer_id,owner_user_id,title,pipeline_stage,status,estimated_amount_rial,probability_percent,weighted_amount_rial,entered_stage_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(c2, u2, 'فرصت ب', 'negotiation', 'open', 100000, 50, 50000, 1, 1, 1).lastInsertRowid;
  const won = crmPro.changeOpportunityStage(db, fresh, 'won', { userId: u2, wonInvoiceId: wonInv.id });
  ok('won linked to firm invoice', won.opportunity.won_invoice_id === wonInv.id);
  eq('probability clamped', crmPro.clampProb(250), 100);
  eq('weighted', crmPro.weightedRial(200, 50), 100);

  const scoped = buildDashboard(db, { user_id: String(u2) }, u1);
  ok('date+owner filter: scoped ignores other user', scoped.kpis.firm_invoice_count === 1);
  ok('user_id=0 ignored', resolveEffectiveUserId(u1, { user_id: '0' }) === u1);

  const rate = analytics.safeRate(0, 0);
  ok('zero denominator null rate', rate.rate === null);

  crmPro.runSegmentation(db);
  const seg = db.prepare('SELECT * FROM crm_customer_segments WHERE customer_id=?').get(c1);
  ok('segment row exists', !!seg);
  const n1 = db.prepare('SELECT COUNT(*) AS c FROM crm_customer_segments').get().c;
  crmPro.runSegmentation(db);
  eq('segmentation idempotent row count', db.prepare('SELECT COUNT(*) AS c FROM crm_customer_segments').get().c, n1);

  const auto1 = crmPro.runAutomations(db);
  const auto2 = crmPro.runAutomations(db);
  eq('automation second run creates zero', auto2.created, 0);
  void auto1;

  const histSeg = db.prepare('SELECT COUNT(*) AS c FROM crm_segment_history').get().c;
  analytics.buildSegmentReport(db, {}, null);
  eq('GET segments does not write history', db.prepare('SELECT COUNT(*) AS c FROM crm_segment_history').get().c, histSeg);

  const dashDated = buildDashboard(db, { from: today, to: today }, null);
  const drillNew = buildDrilldown(db, 'new_customers', { from: today, to: today }, null);
  eq('new_customers drill == KPI', drillNew.total, dashDated.kpis_compare?.new_customers?.current ?? dashDated.kpis.new_customers);
  const drillFirm2 = buildDrilldown(db, 'firm_sales', { from: today, to: today, campaign: 'no-such' }, null);
  eq('firm_sales + unknown campaign empty', drillFirm2.total, 0);
  const kpiNormal = analytics.computeKpiSet(db, analytics.parseFilters({ from: today, to: today, invoice_type: 'normal' }, null));
  const drillNormal = buildDrilldown(db, 'firm_sales', { from: today, to: today, invoice_type: 'normal' }, null);
  eq('firm_sales + invoice_type=normal drill == KPI', drillNormal.total, kpiNormal.firm_invoice_count);
  let pipeUnknown = false;
  try { buildDrilldown(db, 'pipeline_not_a_stage', {}, null); } catch (e) { pipeUnknown = e.status === 400; }
  ok('unknown pipeline metric 400', pipeUnknown);
} finally {
  cleanup();
}
summary('CRM-PRO analytics');
