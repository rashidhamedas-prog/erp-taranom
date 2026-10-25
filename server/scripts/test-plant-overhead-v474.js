'use strict';
const { swAtLeast } = require('./lib/sw-at-least');
/**
 * v474 — سربار کارگاه یک‌بار روی تعداد تمام‌شده؛ دفتر توزیع داخل بها نیست.
 * Run: node server/scripts/test-plant-overhead-v474.js
 */
const fs = require('fs');
const path = require('path');
const { ok, eq, summary } = require('./lib/test-harness');

const root = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const ohSrc = fs.readFileSync(path.join(root, 'lib/production/overhead.js'), 'utf8');
const advSrc = fs.readFileSync(path.join(root, 'lib/production/bom-advanced.js'), 'utf8');

ok('SW v474', swAtLeast(sw, 474));
ok('plant filter is workshop', ohSrc.includes("entity='workshop'"));
ok('roll-up adds plant once', advSrc.includes('سربار سراسری کارگاه'));
ok('Help v474', appSrc.includes('سربار سراسری کارگاه (v474)'));
ok('distribution stays out of plant query', !/entity='distribution_office'/.test(ohSrc.split('function listPlantCostCenters')[1].split('function ')[0]));

try {
  new Function(appSrc);
  ok('app.js parse', true);
} catch (e) {
  ok('app.js parse', false, e.message);
}

try {
  const { freshDb } = require('./lib/test-harness');
  const { rollUpBom } = require('../lib/production/bom-advanced');
  const { postPlantOverhead } = require('../lib/production/overhead');
  const { db, cleanup } = freshDb();
  try {
    const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get();
    const fg = db.prepare(`
      INSERT INTO products (user_id, name, code, unit, item_type, is_manufactured)
      VALUES (?, 'کاپشن تست', 'FG-474', 'عدد', 'finished', 1)
    `).run(admin.id).lastInsertRowid;

    function cc(code, name, entity, isStage) {
      const row = db.prepare('SELECT id FROM cost_centers WHERE code=?').get(code);
      if (row) {
        db.prepare('UPDATE cost_centers SET entity=?, active=1, is_stage=? WHERE id=?')
          .run(entity, isStage ? 1 : 0, row.id);
        return row.id;
      }
      return db.prepare(`
        INSERT INTO cost_centers (name, code, entity, active, is_stage, kind)
        VALUES (?,?,?,1,?,?)
      `).run(name, code, entity, isStage ? 1 : 0, isStage ? 'production' : 'service').lastInsertRowid;
    }
    const cut = cc('CC-10', 'برش', 'production', 1);
    const sew = cc('CC-30', 'دوخت', 'production', 1);
    const iron = cc('CC-60', 'اتو', 'production', 1);
    const plant = cc('CC-WORKSHOP', 'کارگاه نبوت', 'workshop', 0);
    const dist = cc('CC-DISTRIBUTION', 'دفتر توزیع کیمیا', 'distribution_office', 0);

    const period = '1405/07';
    for (const id of [cut, sew, iron, plant, dist]) {
      db.prepare(`
        INSERT INTO cost_center_rates
          (cost_center_id, period_label, driver, total_rate_rial, status, absorb_pct)
        VALUES (?,?,'output_qty',200000,'active',100)
      `).run(id, period);
    }

    const bomId = db.prepare(`
      INSERT INTO bom_headers (code, product_id, name, base_qty, status, has_routing, has_coproducts, created_by)
      VALUES ('BOM-474', ?, 'تست', 1, 'active', 1, 0, ?)
    `).run(fg, admin.id).lastInsertRowid;
    let seq = 10;
    for (const id of [cut, sew, iron]) {
      db.prepare(`
        INSERT INTO bom_operations (bom_id, seq, cost_center_id, yield_percent, labor_method, labor_rate_rial)
        VALUES (?,?,?,100,'contract',0)
      `).run(bomId, seq, id);
      seq += 10;
    }

    const sheet = rollUpBom(db, { bomId, qtyTarget: 300, period });
    const plantRow = sheet.stages.find((s) => s.plant === 1 && Number(s.cost_center_id) === Number(plant));
    const distRow = sheet.stages.find((s) => Number(s.cost_center_id) === Number(dist));
    ok(!!plantRow, 'cost sheet has workshop row');
    eq('workshop 200000 × 300', plantRow && plantRow.overhead_rial, 60000000);
    ok(!distRow, 'distribution is not on the cost sheet');
    const stageOh = sheet.stages.filter((s) => !s.plant).reduce((s, r) => s + (r.overhead_rial || 0), 0);
    eq('three stage centers stay 60M each', stageOh, 180000000);
    eq('total OH is stages plus one plant', sheet.breakdown.overhead_rial, 240000000);

    const orderId = db.prepare(`
      INSERT INTO production_orders (order_no, product_id, bom_id, qty_planned, date, status, cost_center_id)
      VALUES ('PO-474', ?, ?, 300, '1405/07/01', 'released', ?)
    `).run(fg, bomId, cut).lastInsertRowid;
    const posted = postPlantOverhead(db, {
      po: { id: orderId, cost_center_id: cut },
      qty: 300, laborRial: 0, matRial: 0,
      date: '1405/07/01', period, userId: admin.id,
      skipCcIds: [cut, sew, iron],
    });
    eq('actual plant absorb once', posted.amount_rial, 60000000);
    eq('only workshop posted', posted.lines.length, 1);
  } finally {
    cleanup();
  }
} catch (e) {
  ok('db plant overhead', false, e.message);
}

summary();
