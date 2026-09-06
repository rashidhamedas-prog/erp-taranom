#!/usr/bin/env node
/**
 * CRM-PRO performance — bounded queries, pagination, indexes.
 */
const { ok, freshDb, summary } = require('./lib/test-harness');
const { buildDashboard, buildTimeline, buildDrilldown } = require('../lib/crm-analytics');

console.log('══ CRM-PRO performance ══');
const { db, cleanup } = freshDb();
try {
  const t0 = Date.now();
  buildDashboard(db, {}, null);
  const dashMs = Date.now() - t0;
  ok('dashboard < 2000ms empty-ish db', dashMs < 2000, dashMs + 'ms');

  const tl = buildTimeline(db, { customerId: 1, limit: 20, offset: 0 });
  ok('timeline has total', typeof tl.total === 'number');
  ok('timeline page bounded', (tl.events || []).length <= 20);

  const rows = buildDrilldown(db, 'firm_sales', { page: 1, page_size: 10 }, null);
  ok('drilldown page_size honored', rows.length <= 10);
  ok('drilldown has total', typeof rows.total === 'number');

  const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_crm%'`).all();
  ok('crm indexes exist', idx.length >= 5, idx.map((i) => i.name).join(','));

  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM crm_opportunities WHERE pipeline_stage=? AND status=?`).all('lead', 'open');
  const planTxt = plan.map((p) => p.detail).join(' | ');
  ok('opportunity query planned', planTxt.length > 0);

  const t1 = Date.now();
  for (let i = 0; i < 20; i++) buildDashboard(db, { from: '1404/01/01', to: '1404/12/29' }, null);
  ok('20 dashboards < 2000ms', Date.now() - t1 < 2000);
} finally { cleanup(); }
summary('CRM-PRO performance');
