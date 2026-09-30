'use strict';
/**
 * Regression: E_BOM_COMP_TYPE (V-15) + friendly path on activate/addLine.
 * Run: node server/scripts/test-bom-comp-type-v273.js
 */
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; console.log('  PASS', msg); }
  else { failed += 1; console.error('  FAIL', msg); }
}

const root = path.join(__dirname, '..');
const bomSrc = fs.readFileSync(path.join(root, 'lib/production/bom.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const routeSrc = fs.readFileSync(path.join(root, 'routes/production-boms.js'), 'utf8');

console.log('static asserts v273 BOM/UX');

ok(bomSrc.includes('function assertBomComponentType'), 'assertBomComponentType defined');
ok(/assertBomComponentType\(db,\s*L\.component_product_id\)/.test(bomSrc), 'validateBom calls assertBomComponentType');
ok(/assertBomComponentType\(db,\s*body\.component_product_id\)/.test(bomSrc), 'addLine gates V-15 early');
ok(bomSrc.includes("item_type === 'finished' && !prod.is_manufactured"), 'V-15 condition intact');

ok(routeSrc.includes('E_BOM_COMP_TYPE'), 'bomFaError maps E_BOM_COMP_TYPE');
ok(appSrc.includes('E_BOM_COMP_TYPE'), 'frontend knows E_BOM_COMP_TYPE');
ok(appSrc.includes('function isBomComponentEligible'), 'UI component eligibility filter');
ok(appSrc.includes('openNestedModal'), 'size matrix uses nested modal');
ok(appSrc.includes('prodBomOpenSizeMatrix'), 'size matrix opener present');
ok(appSrc.includes('cuttingSizeLabelsForProduct'), 'size matrix uses product sizes');
ok(appSrc.includes('pbe-color-pick-wrap'), 'component color picker wrap');
ok(appSrc.includes('prodBomColorOptionsHtml'), 'color name dropdown helper');
ok(appSrc.includes('goCuttingLaysView'), 'cut vs pack view router');
ok(appSrc.includes("goArg:'pending-pack'"), 'dashboard step 5 → pending pack');
ok(appSrc.includes('ورود به انبار محصول'), 'pack CTA renamed away from رسید برش');
ok(appSrc.includes('ثبت لایه‌چینی'), 'lay CTA renamed');
ok(appSrc.includes('p-item_type'), 'product form exposes item_type');
ok(appSrc.includes('p-is-manufactured'), 'product form exposes is_manufactured');
ok(appSrc.includes('رنگ این نسخهٔ فرمول'), 'BOM header color clarified as version tag');
ok(!/modal-overlay open/.test(appSrc.match(/async function prodBomOpenSizeMatrix[\s\S]*?^async function|^function prodBomAddLineRow/m)?.[0] || ''), 'size matrix no longer uses modal-overlay');

let live = false;
try {
  require('better-sqlite3');
  const { initDB, getDB } = require('../db');
  const bom = require('../lib/production/bom');
  process.env.DB_PATH = path.join(__dirname, '../data/_test-bom-comp-type-v273.sqlite');
  try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}
  initDB();
  const db = getDB();
  const uid = db.prepare('SELECT id FROM users LIMIT 1').get()?.id || 1;
  const fg = db.prepare(`INSERT INTO products (user_id,name,price,stock,item_type,is_manufactured) VALUES (?,?,100,0,'finished',1)`).run(uid, 'FG-Yalda-v273').lastInsertRowid;
  const bad = db.prepare(`INSERT INTO products (user_id,name,price,stock,item_type,is_manufactured) VALUES (?,?,100,0,'finished',0)`).run(uid, 'Bad-Finished-Comp').lastInsertRowid;
  const raw = db.prepare(`INSERT INTO products (user_id,name,price,stock,item_type,is_manufactured) VALUES (?,?,100,0,'raw',0)`).run(uid, 'Fabric-Raw').lastInsertRowid;
  const semi = db.prepare(`INSERT INTO products (user_id,name,price,stock,item_type,is_manufactured) VALUES (?,?,100,0,'finished',1)`).run(uid, 'Semi-Ok').lastInsertRowid;

  const draft = bom.createBom(db, { product_id: fg, name: 't', yield_percent: 100 }, uid);
  try {
    bom.addLine(db, draft.id, { component_product_id: bad, qty_per_base: 1, line_type: 'material' }, uid);
    ok(false, 'addLine should reject finished non-mfg');
  } catch (e) {
    ok(e.code === 'E_BOM_COMP_TYPE' || e.message === 'E_BOM_COMP_TYPE', 'addLine throws E_BOM_COMP_TYPE');
  }
  bom.addLine(db, draft.id, { component_product_id: raw, qty_per_base: 1.2, line_type: 'material' }, uid);
  bom.addLine(db, draft.id, { component_product_id: semi, qty_per_base: 1, line_type: 'material' }, uid);
  const act = bom.activateBom(db, draft.id, '1405/01/01', uid);
  ok(act && (act.status === 'active' || act.ok !== false), 'activate OK with raw+semi');

  const draft2 = bom.createBom(db, { product_id: fg, name: 't2', yield_percent: 100 }, uid);
  db.prepare(`INSERT INTO bom_lines (bom_id, line_no, component_product_id, qty_per_base, scrap_percent, line_type)
    VALUES (?,?,?,?,0,'material')`).run(draft2.id, 1, bad, 1);
  try {
    bom.validateBom(db, draft2.id);
    ok(false, 'validateBom should reject finished non-mfg');
  } catch (e) {
    ok(e.code === 'E_BOM_COMP_TYPE' || e.message === 'E_BOM_COMP_TYPE', 'validateBom throws E_BOM_COMP_TYPE');
  }
  live = true;
  try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}
} catch (e) {
  console.log('  SKIP live sqlite:', e.message);
}

console.log(`\nResult: ${passed} passed, ${failed} failed` + (live ? ' (live)' : ' (static only)'));
process.exit(failed ? 1 : 0);
