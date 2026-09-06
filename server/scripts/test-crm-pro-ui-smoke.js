#!/usr/bin/env node
/**
 * CRM-PRO UI smoke — parse app.js, required surfaces, no mock KPI literals.
 */
const fs = require('fs');
const path = require('path');
const { ok, summary } = require('./lib/test-harness');

console.log('══ CRM-PRO UI smoke ══');
const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/app.css'), 'utf8');
try {
  new Function(app);
  ok('app.js parses', true);
} catch (e) {
  ok('app.js parses', false, e.message);
}
ok('crm-dashboard route', app.includes("ROUTES['crm-dashboard']"));
ok('followups route', app.includes('ROUTES.followups'));
ok('destroyCrmCharts', app.includes('destroyCrmCharts'));
ok('fmtCrmRial helper', app.includes('function fmtCrmRial'));
ok('Chart.js local vendor', app.includes('/vendor/chart.umd.js'));
ok('funnel canvas', app.includes('crmFunnelChart'));
ok('trend canvas', app.includes('crmTrendChart'));
ok('pipeline canvas', app.includes('crmPipeChart'));
ok('drilldown fn', app.includes('async function crmDrill'));
ok('filter apply', app.includes('اعمال فیلتر'));
ok('filter clear', app.includes('پاک‌کردن فیلترها'));
ok('kanban persist drop', app.includes('crmKanbanDrop'));
ok('no Math.random KPI', !/Math\.random\(\).*firm_sales|mockKpi|sampleData\s*=\s*\[/.test(app));
ok('dark/rtl tokens in css', css.includes('.crm-dash') && css.includes('var(--card)'));
ok('mobile breakpoint', css.includes('max-width:800px'));
ok('help CRM pro', app.includes('pipeline_stage'));
summary('CRM-PRO UI smoke');
