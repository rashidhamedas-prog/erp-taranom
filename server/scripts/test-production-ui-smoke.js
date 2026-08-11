'use strict';
/**
 * Static smoke test for the Production UI (vanilla JS, no jsdom).
 * Verifies the new UI files exist and contain the expected wiring —
 * does NOT execute browser JS, just greps for required strings.
 *
 * Note: SPA logic lives in app.js (index.html is the shell + asset tags).
 */
const fs = require('fs');
const path = require('path');
const { ok, summary } = require('./lib/test-harness');

console.log('\n══ Production UI Smoke ══\n');

const PUBLIC = path.join(__dirname, '..', 'public');

// ── 1. Base files exist ──
const cssPath = path.join(PUBLIC, 'prod-ui.css');
const jsPath = path.join(PUBLIC, 'prod-ui.js');
const navPath = path.join(PUBLIC, 'acc-nav.js');
const indexPath = path.join(PUBLIC, 'index.html');
const appPath = path.join(PUBLIC, 'app.js');

ok('prod-ui.css exists', fs.existsSync(cssPath));
ok('prod-ui.js exists', fs.existsSync(jsPath));
ok('app.js exists', fs.existsSync(appPath));

const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '';
const js = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf8') : '';
const nav = fs.readFileSync(navPath, 'utf8');
const html = fs.readFileSync(indexPath, 'utf8');
const app = fs.readFileSync(appPath, 'utf8');
const surface = `${html}\n${app}`;

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
['acc-production-estimate', 'acc-production-kanban', 'acc-production-variance', 'acc-production-mrp', 'acc-production-rates', 'acc-production-access'].forEach(id => {
  ok(`acc-nav.js registers ${id}`, nav.includes(`'${id}'`) || nav.includes(`"${id}"`));
});

// ── 5. index.html links the new assets (cache-busting query allowed) ──
ok('index.html links /prod-ui.css', /href="\/prod-ui\.css(\?[^"]*)?"/.test(html));
ok('index.html loads /prod-ui.js', /src="\/prod-ui\.js(\?[^"]*)?"/.test(html));

// ── 6. SPA surface sets window.__canSeeCost ──
ok('SPA sets window.__canSeeCost', surface.includes('window.__canSeeCost'));

// ── 7. SPA defines the new render functions ──
[
  'renderProductionEstimateTab',
  'renderProductionKanbanTab',
  'renderProductionVarianceTab',
  'renderProductionMrpTab',
  'renderProductionRatesTab',
  'renderProductionAccessTab',
].forEach(fn => {
  ok(`SPA defines ${fn}()`, new RegExp(`(?:async )?function ${fn}\\s*\\(`).test(surface));
});

// ── 8. SPA routes + tab dispatch for the new tabs ──
['production-estimate', 'production-kanban', 'production-variance', 'production-mrp', 'production-rates', 'production-access'].forEach(tab => {
  ok(`SPA dispatches tab '${tab}' in loadAccTab`, surface.includes(`tab==='${tab}'`));
});
['acc-production-estimate', 'acc-production-kanban', 'acc-production-variance', 'acc-production-mrp', 'acc-production-rates', 'acc-production-access'].forEach(id => {
  ok(`SPA registers ROUTES['${id}']`, surface.includes(`ROUTES['${id}']`));
});

// ── 9. Enhanced production-orders tab: multiple analysis types + stage modal ──
ok('SPA order create modal offers fixed_adv option', surface.includes('fixed_adv'));
ok('SPA order create modal offers variable_adv option', surface.includes('variable_adv'));
ok('SPA has stage detail modal (prodOrderStagesModal)', surface.includes('function prodOrderStagesModal'));
ok('SPA has variable material issue modal (prodOrderIssueModal)', surface.includes('function prodOrderIssueModal'));
ok('SPA posts stage output endpoint', /\/stages\/['"`]\s*\+\s*stageId\s*\+\s*['"`]\/output/.test(surface) || surface.includes("/stages/'+stageId+'/output"));
ok('SPA posts stage issue endpoint', /\/stages\/['"`]\s*\+\s*stageId\s*\+\s*['"`]\/issue/.test(surface) || surface.includes("/stages/'+stageId+'/issue"));
ok('SPA has subcontract send', surface.includes('subcontract/send'));
ok('SPA has subcontract receive', surface.includes('subcontract/receive'));
ok('prod-ui.js defines debounce()', /function debounce\s*\(/.test(js));

// ── 10. BOM tab enhancements: has_routing + activate ──
ok('SPA BOM tab shows has_routing', surface.includes('has_routing'));
ok('SPA BOM tab has activate action', surface.includes('prodBomActivate'));

// ── 11. Node module sanity (no ORM/TS/React introduced) ──
ok('prod-ui.js has no React import', !/from ['"]react['"]/i.test(js) && !js.includes('React.'));
ok('SPA new code has no React import', !surface.includes('import React'));

summary('Production UI Smoke');
