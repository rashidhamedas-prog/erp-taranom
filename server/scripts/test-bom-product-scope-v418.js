'use strict';
/**
 * v418 — BOM multi-product line/op product_scope + exclusive cost split + co finalize JE
 */
const { ok, eq, throws, freshDb, summary } = require('./lib/test-harness');
const bom = require('../lib/production/bom');
const adv = require('../lib/production/bom-advanced');

console.log('\n══ BOM product_scope / exclusive / co finalize v418 ══\n');

const { db, cleanup } = freshDb();
const adminId = 1;

function seedProduct(name, avg, type, mfg, stock = 10000) {
  const id = db.prepare('INSERT INTO products (user_id,name,price,stock) VALUES (1,?,?,?)')
    .run(name, avg / 10, stock).lastInsertRowid;
  db.prepare('UPDATE products SET average_cost_rial=?, item_type=?, is_manufactured=?, std_cost_rial=? WHERE id=?')
    .run(avg, type, mfg, avg, id);
  return id;
}

const pMain = seedProduct('کاپشن یلدا', 0, 'finished', 1, 0);
const pCo = seedProduct('کاپشن آبان', 0, 'finished', 1, 0);
const pFab = seedProduct('پارچه مشترک', 1_000_000, 'raw', 0);
const pZipY = seedProduct('زیپ یلدا', 100_000, 'raw', 0);
const pZipA = seedProduct('زیپ آبان', 80_000, 'raw', 0);

const draft = bom.createBom(db, {
  product_id: pMain,
  name: 'BOM-MP',
  has_coproducts: 1,
  co_product_ids: [pCo],
  auto_share_method: 'physical',
  lines: [
    { component_product_id: pFab, qty_per_base: 2, line_type: 'material', product_scope: 'shared' },
    {
      component_product_id: pZipY, qty_per_base: 1, line_type: 'material',
      product_scope: 'exclusive', scoped_product_id: pMain,
    },
    {
      component_product_id: pZipA, qty_per_base: 1, line_type: 'material',
      product_scope: 'exclusive', scoped_product_id: pCo,
    },
  ],
}, adminId);

ok('T418-01 create multi', !!draft.id);
const full = bom.getBom(db, draft.id);
ok('T418-02 fg_products', full.is_multiproduct && full.fg_products.length === 2);
eq('T418-03 lines scopes', full.lines.filter(L => L.product_scope === 'exclusive').length, 2);

const exMain = bom.explodeBom(db, { bomId: draft.id, qty: 1, forProductId: pMain });
ok('T418-04 explode main excludes co zip',
  exMain.lines.some(L => Number(L.product_id) === pZipY)
  && !exMain.lines.some(L => Number(L.product_id) === pZipA)
  && exMain.lines.some(L => Number(L.product_id) === pFab));

const exCo = bom.explodeBom(db, { bomId: draft.id, qty: 1, forProductId: pCo });
ok('T418-05 explode co excludes main zip',
  exCo.lines.some(L => Number(L.product_id) === pZipA)
  && !exCo.lines.some(L => Number(L.product_id) === pZipY));

throws('T418-06 bad scope product', () => {
  bom.addLine(db, draft.id, {
    component_product_id: pFab, qty_per_base: 1,
    product_scope: 'exclusive', scoped_product_id: 999999,
  }, adminId);
}, 'E_SCOPED_PRODUCT_NOT_IN_BOM');

// Force equal 50/50 share for analytical check
db.prepare(`UPDATE bom_outputs SET cost_share_percent=50 WHERE bom_id=? AND output_type IN ('main','co')`).run(draft.id);

const roll = adv.rollUpBom(db, { bomId: draft.id, qtyTarget: 1, period: '1405/07', priceBasis: 'average' });
const outMain = (roll.outputs || []).find(o => o.type === 'main' || Number(o.product_id) === pMain);
const outCo = (roll.outputs || []).find(o => o.type === 'co' || Number(o.product_id) === pCo);
ok('T418-07 roll exclusive main', outMain && Number(outMain.exclusive_rial) >= 100_000);
ok('T418-08 roll exclusive co', outCo && Number(outCo.exclusive_rial) >= 80_000);
ok('T418-09 roll shared present', outMain && Number(outMain.shared_rial) > 0 && outCo && Number(outCo.shared_rial) > 0);

// Header sync co list
const updated = bom.updateBomHeader(db, draft.id, {
  name: 'BOM-MP2',
  has_coproducts: true,
  co_product_ids: [pCo],
}, adminId);
ok('T418-10 header sync', updated.has_coproducts === 1 || updated.is_multiproduct);

// Single-product BOM: exclusive coerced to shared
const single = bom.createBom(db, {
  product_id: pMain,
  name: 'BOM-S',
  revision: 'S',
  lines: [{
    component_product_id: pFab, qty_per_base: 1,
    product_scope: 'exclusive', scoped_product_id: pMain,
  }],
}, adminId);
const sLines = bom.getBom(db, single.id).lines;
eq('T418-11 single forces shared', sLines[0].product_scope, 'shared');
ok('T418-12 single scoped null', sLines[0].scoped_product_id == null);

cleanup();
summary();
