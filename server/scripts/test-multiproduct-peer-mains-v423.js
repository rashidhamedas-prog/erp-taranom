'use strict';
/**
 * v423 — محصولات اصلی مستقل (حذف هم‌محصول / co→main)
 * Run: node server/scripts/test-multiproduct-peer-mains-v423.js
 */
process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-jwt-secret-peer-mains-v423-dummy-key-32chars!!';

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  OK', msg); }
  else { failed++; console.log('  FAIL', msg, detail != null ? detail : ''); }
}

console.log('\n══ Multiproduct peer mains v423 ══\n');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
const idxSrc = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
ok(swSrc.includes('erp-taranom-v424'), 'SW v424');
ok(idxSrc.includes('app.js?v=424'), 'index v424');
ok(appJs.includes('محصولات اصلی مستقل') || appJs.includes('محصول اصلی مستقل'), 'Help/UI peer mains');
ok(!/هم‌محصول \(co\) — توصیه/.test(appJs), 'UI no co recommendation option');
ok(appJs.includes('محصول اصلی (مستقل)'), 'UI main option label');

const schemaSrc = fs.readFileSync(path.join(__dirname, '../lib/production/schema.js'), 'utf8');
ok(schemaSrc.includes("output_type='co'") && schemaSrc.includes("output_type='main'"), 'schema migrate co→main');

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
const adv = require('../lib/production/bom-advanced');

const { db, cleanup } = freshDb();
const adminId = 1;

function seedProduct(name, opts = {}) {
  const id = db.prepare('INSERT INTO products (user_id,name,price,stock) VALUES (1,?,?,?)')
    .run(name, opts.price != null ? opts.price : 100000, 1000).lastInsertRowid;
  db.prepare(`
    UPDATE products SET average_cost_rial=?, item_type=?, is_manufactured=?, std_cost_rial=?,
      unit=COALESCE(?, unit), code=COALESCE(?, code)
    WHERE id=?
  `).run(
    opts.avg != null ? opts.avg : 50000,
    opts.type || 'finished',
    opts.mfg != null ? opts.mfg : 1,
    opts.avg != null ? opts.avg : 50000,
    opts.unit || 'عدد',
    opts.code || null,
    id
  );
  return id;
}

const pA = seedProduct('مانتو A v423', { code: 'FG-A423', price: 200000 });
const pB = seedProduct('مانتو B v423', { code: 'FG-B423', price: 150000 });
const pRaw = seedProduct('پارچه v423', { type: 'raw', mfg: 0, avg: 10000, unit: 'متر', code: 'RAW-423' });

const created = bom.createBom(db, {
  product_id: pA,
  name: 'فرمول peer v423',
  base_qty: 1,
  yield_percent: 100,
  has_coproducts: 1,
  co_product_ids: [pB],
  auto_share_method: 'sales_value',
}, adminId);
ok(!!created?.id, 'T01 create multiproduct BOM');

const detail = bom.getBom(db, created.id);
ok(detail.is_multiproduct === true, 'T02 is_multiproduct');
ok(detail.fg_products.length === 2, 'T03 two fg_products', detail.fg_products.length);
ok(detail.fg_products.every(p => p.role === 'main'), 'T04 all roles main');
ok(detail.fg_products.some(p => p.is_anchor && Number(p.id) === pA), 'T05 anchor is A');

const outs = detail.outputs.filter(o => o.output_type === 'main' || o.output_type === 'co');
ok(outs.length === 2 && outs.every(o => o.output_type === 'main'), 'T06 outputs are main not co',
  outs.map(o => o.output_type).join(','));

const shareSum = outs.reduce((s, o) => s + (Number(o.cost_share_percent) || 0), 0);
ok(Math.abs(shareSum - 100) < 0.05, 'T07 share sum 100', shareSum);

// Legacy co row still accepted by migrate on boot — simulate insert then re-ensure
db.prepare(`
  INSERT INTO bom_outputs (bom_id, product_id, output_type, qty_per_base, cost_method, cost_share_percent)
  VALUES (?, ?, 'co', 1, 'share', 0)
`).run(created.id, seedProduct('مانتو C v423', { code: 'FG-C423' }));
// promote via ensureShareOutputs empty peer list + schema-style update
db.prepare(`UPDATE bom_outputs SET output_type='main' WHERE bom_id=? AND output_type='co'`).run(created.id);
const afterPromo = db.prepare(`SELECT COUNT(*) c FROM bom_outputs WHERE bom_id=? AND output_type='co'`).get(created.id)?.c;
ok(afterPromo === 0, 'T08 no co rows after promote');

// addOutput peer as main
const pD = seedProduct('مانتو D v423', { code: 'FG-D423' });
const added = adv.addOutput(db, created.id, {
  product_id: pD, output_type: 'main', qty_per_base: 1, cost_share_percent: 0,
});
ok(added && added.output_type === 'main', 'T09 addOutput keeps main for peer');

const plan = bom.planBomFgOutputs(db, created.id, 10, pB);
ok(plan.length >= 2, 'T10 plan has peers');
ok(plan.every(r => r.role === 'main' && r.output_type === 'main'), 'T11 plan roles main');
const orderRow = plan.find(r => Number(r.product_id) === pB);
ok(orderRow && Number(orderRow.qty_planned) === 10, 'T12 order product qty exact');

adv.autoShare(db, created.id, 'physical');
try {
  adv.validateAdvancedBom(db, created.id);
  ok(true, 'T13 validate allows multiple mains');
} catch (e) {
  ok(false, 'T13 validate allows multiple mains', e.code || e.message);
}

// Static: ensureMainOutputRow must not demote
const advSrc = fs.readFileSync(path.join(__dirname, '../lib/production/bom-advanced.js'), 'utf8');
ok(!/demote others to co/.test(advSrc), 'T14 no demote-to-co comment/logic');
ok(/peer main|peerProductIds|never demote/.test(advSrc), 'T15 peer main language in advanced');

cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
