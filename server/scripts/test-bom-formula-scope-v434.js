'use strict';
/**
 * v434 — نام/مقدار پایه/بازده روی سرفصل؛ تعداد هر محصول اصلی روی خروجی.
 * Run: node server/scripts/test-bom-formula-scope-v434.js
 */
process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-jwt-secret-bom-formula-scope-v434-key-32ch!!';

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  OK', msg); }
  else { failed++; console.log('  FAIL', msg, detail != null ? detail : ''); }
}
function eq(msg, a, b) {
  ok(Number(a) === Number(b) || a === b, msg, `got ${a} expected ${b}`);
}

console.log('\n══ BOM formula scope v434 ══\n');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const idxSrc = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
ok(appJs.includes('شناسنامهٔ فرمول'), 'UI formula identity section');
ok(appJs.includes('تعداد لنگر نسبت به پایه'), 'UI per-product anchor qty');
ok(appJs.includes('main_outputs'), 'UI sends main_outputs');
ok(appJs.includes('شناسنامهٔ فرمول در برابر تعداد محصول (v434)'), 'Help v434');
ok(swSrc.includes('erp-taranom-v434'), 'SW v434');
ok(idxSrc.includes('app.js?v=434'), 'index v434');
ok(!appJs.includes('_pbCoProducts'), 'legacy peer id list removed from create');

let Database;
try {
  Database = require('better-sqlite3');
  const probe = new Database(':memory:');
  probe.close();
} catch (e) {
  console.log('\nSKIP SQLite ABI — static checks only:', e.message);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const { freshDb } = require('./lib/test-harness');
const bom = require('../lib/production/bom');

const { db, cleanup } = freshDb();

function seedProduct(name) {
  const id = db.prepare('INSERT INTO products (user_id,name,price,stock) VALUES (1,?,?,0)')
    .run(name, 0).lastInsertRowid;
  db.prepare('UPDATE products SET item_type=?, is_manufactured=? WHERE id=?')
    .run('finished', 1, id);
  return id;
}

const pMain = seedProduct('بلوز');
const pPeer = seedProduct('دامن');

const draft = bom.createBom(db, {
  product_id: pMain,
  name: 'برش مشترک',
  has_routing: 1,
  has_coproducts: 1,
  yield_percent: 90,
  base_qty: 1,
  co_product_ids: [pPeer],
  main_outputs: [
    { product_id: pMain, qty_per_base: 1 },
    { product_id: pPeer, qty_per_base: 2 },
  ],
  auto_share_method: 'physical',
}, 1);

const header = db.prepare('SELECT name, base_qty, yield_percent, has_routing, product_id FROM bom_headers WHERE id=?').get(draft.id);
eq('T434-01 name on header', header.name, 'برش مشترک');
eq('T434-02 base on header', header.base_qty, 1);
eq('T434-03 routing forces header yield 100', header.yield_percent, 100);
eq('T434-04 anchor stays header product', header.product_id, pMain);

const outs = db.prepare(`
  SELECT product_id, qty_per_base FROM bom_outputs
  WHERE bom_id=? AND output_type='main'
`).all(draft.id);
eq('T434-05 anchor qty', outs.find(o => Number(o.product_id) === pMain)?.qty_per_base, 1);
eq('T434-06 peer qty', outs.find(o => Number(o.product_id) === pPeer)?.qty_per_base, 2);

const plan = bom.planBomFgOutputs(db, draft.id, 10, pMain);
eq('T434-07 order 10 anchor', plan.find(p => Number(p.product_id) === pMain)?.qty_planned, 10);
eq('T434-08 peer scales 2x', plan.find(p => Number(p.product_id) === pPeer)?.qty_planned, 20);

let rejected = false;
try {
  bom.createBom(db, {
    product_id: pMain,
    has_coproducts: 1,
    co_product_ids: [pPeer],
    main_outputs: [{ product_id: pPeer, qty_per_base: 0 }],
  }, 1);
} catch (e) {
  rejected = e.code === 'E_VALIDATION' || /VALIDATION|qty/i.test(String(e.message || e.code || e));
}
ok(rejected, 'T434-09 zero output qty rejected');

cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
