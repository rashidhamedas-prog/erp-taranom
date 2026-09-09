'use strict';
/**
 * Field UX v211 — auto-pack cart, color-chip CSP, products COUNT join,
 * CRM drill aliases, AI churn dedupe, dashboard firm sales.
 * Run: node server/scripts/test-field-ux-v211.js
 */
const fs = require('fs');
const path = require('path');
const { ok, freshDb, summary } = require('./lib/test-harness');
const { buildDrilldown } = require('../lib/crm-analytics');
const { todayJalali } = require('../jalali');

const root = path.join(__dirname, '..');
const pub = path.join(root, 'public');
const appJs = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
const mk = fs.readFileSync(path.join(pub, 'marketer-ui.js'), 'utf8');
const productsJs = fs.readFileSync(path.join(root, 'routes', 'products.js'), 'utf8');
const aiJs = fs.readFileSync(path.join(root, 'services', 'ai.js'), 'utf8');
const aiRoutes = fs.readFileSync(path.join(root, 'routes', 'ai.js'), 'utf8');
const crmA = fs.readFileSync(path.join(root, 'lib', 'crm-analytics.js'), 'utf8');
const acct = fs.readFileSync(path.join(root, 'routes', 'accounting.js'), 'utf8');

console.log('\n══ Field UX v211 ══\n');

try { new Function(appJs); ok('app.js parse', true); } catch (e) { ok('app.js parse', false, e.message); }
try { new Function(mk); ok('marketer-ui parse', true); } catch (e) { ok('marketer-ui parse', false, e.message); }

ok('applyAutoLivePack helper', appJs.includes('function applyAutoLivePack'));
ok('auto-pack gated to field/inside sales', appJs.includes('isRepRole(ME?.role)'));
ok('color chip bind uses this', appJs.includes("CSP.bind('click',filterInvVariantColorFromChip)"));
ok('chip handler uses this not currentTarget', appJs.includes('this&&this.getAttribute'));
ok('chip no longer uses event.currentTarget first', !/function filterInvVariantColorFromChip\(ev\)\{\s*const t=ev&&\(ev\.currentTarget/.test(appJs));
ok('receipt submit uses api()', appJs.includes("await api('POST','/reps/payments',fd,true)"));
ok('no raw fetch for rep payments', !appJs.includes("fetch('/api/reps/payments'"));
ok('dashboard sales includes normal+final', appJs.includes("i.type==='final'||i.type==='normal'"));
ok('dashboard falls back to commission salesTotal', appJs.includes('commSales||salesFromInvs'));
ok('rep dashboard defaults to all', appJs.includes("dashPreset='all'"));
ok('pack subtitle helper', appJs.includes('function packSubtitleFromRows'));
ok('CRM receivables KPI wired', appJs.includes("'receivables',true,true"));
ok('CRM repeat customers KPI wired', appJs.includes("'repeat_customers',false"));
ok('CRM open_complaints KPI wired', appJs.includes("'open_complaints',true"));
ok('AI UI dedupes insights', appJs.includes('seenAi'));
ok('marketer cart groups by product', mk.includes('function cartGroups'));
ok('marketer auto-pack', mk.includes("applyAutoLivePack(p, pack, 'marketer')"));
ok('marketer version 211', mk.includes("_ver: 'marketer-ui-v211'"));
ok('products COUNT joins categories', productsJs.includes('LEFT JOIN product_categories pc ON pc.id=p.category_id ${whereSql}'));
ok('AI wipe all generated kinds', aiJs.includes("DELETE FROM ai_insights WHERE kind IN ('churn_risk','opportunity','daily_action')"));
ok('AI period uses Jalali today', aiJs.includes('todayJalali()'));
ok('GET /ai/insights dedupes', aiRoutes.includes('function dedupeInsightRows'));
ok('drill metric aliases', crmA.includes('DRILL_METRIC_ALIASES'));
ok('receivables drill implemented', crmA.includes("m === 'receivables'"));
ok('cheques drill implemented', crmA.includes("m === 'cheques_due'"));
ok('product_sales drill implemented', crmA.includes("m === 'product_sales'"));
ok('open_complaints drill implemented', crmA.includes("m === 'open_complaints'"));
ok('my-commission accepts date range', acct.includes('computeRepCommission(db, u.id, range)'));

let dbHarness;
try {
  dbHarness = freshDb();
} catch (e) {
  console.log('  ⏭ live drilldown skipped —', e.message.split('\n')[0]);
  summary('Field UX v211');
}
const { db, cleanup } = dbHarness;
try {
  const today = todayJalali();
  const u1 = db.prepare(`INSERT INTO users (username,password,name,role,active) VALUES ('r1','x','ر۱','field_sales',1)`).run().lastInsertRowid;
  const c1 = db.prepare(`INSERT INTO customers (user_id,biz,phone,city,status) VALUES (?,'الف','0912','مشهد','active')`).run(u1).lastInsertRowid;
  db.prepare(`INSERT INTO invoices (user_id,cust_id,num,type,date,rows,subtotal,disc,disc_amt,final,pay_type)
    VALUES (?,?,?,?,?,'[]',5000,0,0,5000,'cash')`).run(u1, c1, 'N-v211', 'normal', today);

  const firm = buildDrilldown(db, 'firm_sales_rial', { from: today, to: today }, null);
  ok('alias firm_sales_rial drills', Array.isArray(firm) && firm.length >= 1, firm && firm.length);
  const recv = buildDrilldown(db, 'receivables', {}, null);
  ok('receivables drill returns rows', Array.isArray(recv));
  const recvAlias = buildDrilldown(db, 'receivables_rial', {}, null);
  ok('alias receivables_rial drills', Array.isArray(recvAlias));
  const complaints = buildDrilldown(db, 'open_complaints', {}, null);
  ok('open_complaints drill returns rows', Array.isArray(complaints));
  let unknown = false;
  try { buildDrilldown(db, 'not_a_metric', {}, null); } catch (e) { unknown = e.status === 400; }
  ok('still unknown metric 400 for garbage', unknown);
} catch (e) {
  ok('live drilldown probes', false, e.message);
} finally {
  try { cleanup(); } catch (_) {}
}

summary('Field UX v211');
