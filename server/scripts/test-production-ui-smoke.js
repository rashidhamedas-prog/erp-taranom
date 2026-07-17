'use strict';
/**
 * Static smoke test for the Production UI (vanilla JS, no jsdom).
 * Verifies the new UI files exist and contain the expected wiring —
 * does NOT execute browser JS, just greps for required strings.
 */
const fs = require('fs');
const path = require('path');
const { ok, summary } = require('./lib/test-harness');

console.log('\n══ Production UI Smoke ══\n');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8');

// ── 1. Base files exist ──
const cssPath = path.join(PUBLIC, 'prod-ui.css');
const jsPath = path.join(PUBLIC, 'prod-ui.js');
const navPath = path.join(PUBLIC, 'acc-nav.js');
const indexPath = path.join(PUBLIC, 'index.html');

ok('prod-ui.css exists', fs.existsSync(cssPath));
ok('prod-ui.js exists', fs.existsSync(jsPath));

const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '';
const js = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf8') : '';
const nav = fs.readFileSync(navPath, 'utf8');
const html = fs.readFileSync(indexPath, 'utf8');

// ── 2. prod-ui.css has required design tokens + components ──
ok('prod-ui.css has --brand-dark token', css.includes('--brand-dark'));
ok('prod-ui.css has --brand-mid token', css.includes('--brand-mid'));
ok('prod-ui.css has --brand-gold token', css.includes('--brand-gold'));
ok('prod-ui.css has .prod-kpi component', css.includes('.prod-kpi'));
ok('prod-ui.css has .prod-badge component', css.includes('.prod-badge'));
ok('prod-ui.css has .prod-stage-flow component', css.includes('.prod-stage-flow'));
ok('prod-ui.css has .prod-load-bar/.prod-load-row component', css.includes('.prod-load-row') || css.includes('.prod-load-bar'));
ok('prod-ui.css has .prod-locked component', css.includes('.prod-locked'));
ok('prod-ui.css has .prod-var-fav component', css.includes('.prod-var-fav'));
ok('prod-ui.css has .prod-var-unfav component', css.includes('.prod-var-unfav'));
ok('prod-ui.css has mobile media query', /@media\s*\(max-width:\s*768px\)/.test(css));
ok('prod-ui.css has print media query', /@media\s+print/.test(css));

// ── 3. prod-ui.js exposes window.ProdUI helpers ──
ok('prod-ui.js attaches window.ProdUI', js.includes('global.ProdUI = ProdUI') || js.includes('window.ProdUI'));
['toman', 'rial', 'qty', 'pct', 'variance', 'short', 'badge', 'moneyCell', 'varianceCell', 'stageFlow', 'kpiCard', 'loadBar'].forEach(fn => {
  ok(`prod-ui.js defines ${fn}()`, new RegExp(`function ${fn}\\s*\\(`).test(js));
});

// ── 4. acc-nav.js has the 5 new PRODUCTION menu items ──
['acc-production-estimate', 'acc-production-kanban', 'acc-production-variance', 'acc-production-mrp', 'acc-production-rates'].forEach(id => {
  ok(`acc-nav.js registers ${id}`, nav.includes(`'${id}'`) || nav.includes(`"${id}"`));
});

// ── 5. index.html links the new assets ──
ok('index.html links /prod-ui.css', html.includes('href="/prod-ui.css"'));
ok('index.html loads /prod-ui.js', html.includes('src="/prod-ui.js"'));

// ── 6. index.html wires window.__canSeeCost ──
ok('index.html sets window.__canSeeCost', html.includes('window.__canSeeCost'));

// ── 7. index.html defines the new render functions ──
[
  'renderProductionEstimateTab',
  'renderProductionKanbanTab',
  'renderProductionVarianceTab',
  'renderProductionMrpTab',
  'renderProductionRatesTab',
].forEach(fn => {
  ok(`index.html defines ${fn}()`, new RegExp(`async function ${fn}\\s*\\(`).test(html));
});

// ── 8. index.html routes + tab dispatch for the new tabs ──
['production-estimate', 'production-kanban', 'production-variance', 'production-mrp', 'production-rates'].forEach(tab => {
  ok(`index.html dispatches tab '${tab}' in loadAccTab`, html.includes(`tab==='${tab}'`));
});
['acc-production-estimate', 'acc-production-kanban', 'acc-production-variance', 'acc-production-mrp', 'acc-production-rates'].forEach(id => {
  ok(`index.html registers ROUTES['${id}']`, html.includes(`ROUTES['${id}']`));
});

// ── 9. Enhanced production-orders tab: multiple analysis types + stage modal ──
ok('index.html order create modal offers fixed_adv option', html.includes('fixed_adv'));
ok('index.html order create modal offers variable_adv option', html.includes('variable_adv'));
ok('index.html has stage detail modal (prodOrderStagesModal)', html.includes('function prodOrderStagesModal'));
ok('index.html has variable material issue modal (prodOrderIssueModal)', html.includes('function prodOrderIssueModal'));
ok('index.html posts stage output endpoint', html.includes('/stages/\'+stageId+\'/output'));
ok('index.html posts stage issue endpoint', html.includes('/stages/\'+stageId+\'/issue'));

// ── 10. BOM tab enhancements: has_routing + activate ──
ok('index.html BOM tab shows has_routing', html.includes('has_routing'));
ok('index.html BOM tab has activate action', html.includes('prodBomActivate'));

// ── 11. Node module sanity (no ORM/TS/React introduced) ──
ok('prod-ui.js has no React import', !/from ['"]react['"]/i.test(js) && !js.includes('React.'));
ok('index.html new code has no React import', !html.includes('import React'));

summary('Production UI Smoke');
