'use strict';
/**
 * v416 — BOM soft-delete unique, multi-product share outputs, overhead from budget rates
 */
const { ok, eq, throws, freshDb, summary } = require('./lib/test-harness');
const bom = require('../lib/production/bom');
const adv = require('../lib/production/bom-advanced');
const oh = require('../lib/production/overhead');

console.log('\n══ BOM multi-product / UNIQUE / OH v416 ══\n');

const { db, cleanup } = freshDb();
const adminId = 1;
const PERIOD = '1405/07';

function seedProduct(name, avg, type, mfg, stock = 10000) {
  const id = db.prepare('INSERT INTO products (user_id,name,price,stock) VALUES (1,?,?,?)')
    .run(name, avg / 10, stock).lastInsertRowid;
  db.prepare('UPDATE products SET average_cost_rial=?, item_type=?, is_manufactured=?, std_cost_rial=? WHERE id=?')
    .run(avg, type, mfg, avg, id);
  return id;
}

const pMain = seedProduct('کاپشن یلدا', 0, 'finished', 1, 0);
const pCo = seedProduct('کاپشن آبان', 0, 'finished', 1, 0);
const pFab = seedProduct('پارچه', 950000, 'raw', 0);

const cc10 = db.prepare("SELECT id FROM cost_centers WHERE code='CC-10'").get()?.id;
const cc30 = db.prepare("SELECT id FROM cost_centers WHERE code='CC-30'").get()?.id;

ok('T416-00 seed CC', !!(cc10 && cc30));

// Rate with budget only (total_rate_rial=0) — must enrich to non-zero for OH
db.prepare(`
  INSERT INTO cost_center_rates
    (cost_center_id, period_label, driver, budget_fixed_oh_rial, budget_var_oh_rial,
     budget_driver_qty, total_rate_rial, fixed_rate_rial, status, is_estimated, absorb_pct)
  VALUES (?,?, 'material_rial', 900000000, 0, 100, 0, 0, 'active', 0, 100)
`).run(cc10, PERIOD);
db.prepare(`
  INSERT INTO cost_center_rates
    (cost_center_id, period_label, driver, total_rate_rial, fixed_rate_rial,
     monthly_labor_rate_rial, status, is_estimated, absorb_pct)
  VALUES (?,?, 'direct_labor_rial', 350000, 350000, 0, 'active', 0, 100)
`).run(cc30, PERIOD);

const enriched = oh.getOverheadRate(db, cc10, PERIOD);
ok('T416-01 OH from budget', enriched && enriched.total_rate_rial === 9000000 && enriched.from_budget);

// Soft-delete must free unique slot for same product/version
const d1 = bom.createBom(db, {
  product_id: pMain, name: 'BOM-A', version: 1, revision: 'A',
  lines: [{ component_product_id: pFab, qty_per_base: 1, line_type: 'material', stage_cost_center_id: cc10 }],
}, adminId);
eq('T416-02 create v1', d1.version, 1);
bom.softDeleteBom(db, d1.id, adminId);
const gone = db.prepare('SELECT deleted_at, version, code FROM bom_headers WHERE id=?').get(d1.id);
ok('T416-03 tombstone', gone.deleted_at && Number(gone.version) < 0 && String(gone.code).includes('__del'));

const d2 = bom.createBom(db, {
  product_id: pMain, name: 'BOM-B', revision: 'A',
  has_routing: 1, has_coproducts: 1,
  co_product_ids: [pCo],
  auto_share_method: 'physical',
  lines: [
    { component_product_id: pFab, qty_per_base: 1.5, scrap_percent: 0, line_type: 'material', stage_cost_center_id: cc10 },
  ],
}, adminId);
ok('T416-04 recreate after soft-delete', d2.id && d2.status === 'draft');

const outs = db.prepare('SELECT * FROM bom_outputs WHERE bom_id=?').all(d2.id);
ok('T416-05 multi outputs', outs.length >= 2
  && outs.some(o => o.output_type === 'main' && Number(o.product_id) === pMain)
  && outs.some(o => o.output_type === 'co' && Number(o.product_id) === pCo));

const shareSum = outs.filter(o => ['main', 'co'].includes(o.output_type))
  .reduce((s, o) => s + (Number(o.cost_share_percent) || 0), 0);
ok('T416-06 share ~100', Math.abs(shareSum - 100) < 0.05);

adv.applyRoutingTemplate(db, d2.id, adminId);
// Keep only CC-10 and CC-30 ops for a lighter roll-up
const ops = db.prepare('SELECT id, seq, cost_center_id FROM bom_operations WHERE bom_id=?').all(d2.id);
for (const op of ops) {
  if (Number(op.cost_center_id) !== cc10 && Number(op.cost_center_id) !== cc30) {
    db.prepare('DELETE FROM bom_operations WHERE id=?').run(op.id);
  } else {
    db.prepare(`UPDATE bom_operations SET labor_method='piece', labor_rate_rial=100000, yield_percent=100 WHERE id=?`).run(op.id);
  }
}
adv.resequenceOperations(db, d2.id);

const roll = adv.rollUpBom(db, { bomId: d2.id, qtyTarget: 10, period: PERIOD, priceBasis: 'average' });
const stage10 = (roll.stages || []).find(s => Number(s.cost_center_id) === cc10);
ok('T416-07 OH linked CC-10', stage10 && stage10.overhead_rial > 0);
ok('T416-08 multi output costs', (roll.outputs || []).filter(o => o.type === 'main' || o.type === 'co').length >= 2);

bom.activateBom(db, d2.id, '1405/07/01', adminId);
const active = db.prepare("SELECT status FROM bom_headers WHERE id=?").get(d2.id);
eq('T416-09 activate ok', active.status, 'active');

const coDefault = db.prepare('SELECT default_bom_id FROM products WHERE id=?').get(pCo);
ok('T416-10 co default_bom', Number(coDefault?.default_bom_id) === Number(d2.id));

// Adding another product as "main" should coerce to co
bom.deactivateBom(db, d2.id, adminId);
const pCo2 = seedProduct('کاپشن بهمن', 0, 'finished', 1, 0);
const added = adv.addOutput(db, d2.id, { product_id: pCo2, output_type: 'main', qty_per_base: 1, cost_share_percent: 0 });
eq('T416-11 coerce main→co', added.output_type, 'co');

cleanup();
summary();
