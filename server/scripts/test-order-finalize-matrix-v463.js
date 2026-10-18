'use strict';
/**
 * v463 — نهایی‌سازی چندمحصولی: رنگ×سایز هر محصول جدا، نه جمع مرحلهٔ مشترک
 * Run: node server/scripts/test-order-finalize-matrix-v463.js
 */
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

console.log('\n══ multiproduct finalize keeps each product color×size v463 ══\n');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const advSrc = fs.readFileSync(path.join(__dirname, '../lib/production/engine-advanced.js'), 'utf8');
ok(appJs.includes('prodOrderFinalizeMulti'), 'finalize modal has a multiproduct path');
ok(appJs.includes('data-pid="${p.product_id}"') && appJs.includes('class="pf-vqty'), 'each color row is tagged with its product');
ok(appJs.includes('جمع رنگ×سایز همین محصول باید با تعداد رسید خودش برابر باشد'), 'hint sums to that product, not the shared stage');
ok(advSrc.includes('fgLinesByProduct') && advSrc.includes('resolveProductApparelLines'), 'server posts a matrix per main product');
ok(!advSrc.includes('Apparel matrix only on the order product'), 'co-product matrix is no longer dropped');

let Database;
try {
  Database = require('better-sqlite3');
  const probe = new Database(':memory:');
  probe.close();
} catch (e) {
  console.log('\nSKIP SQLite ABI — static checks done:', e.message);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const { freshDb } = require('./lib/test-harness');
const bom = require('../lib/production/bom');
const advBom = require('../lib/production/bom-advanced');
const engine = require('../lib/production/engine');
const engAdv = require('../lib/production/engine-advanced');

const { db, cleanup } = freshDb();
try {
  const adminId = 1;
  const DATE = '1405/07/27';
  function seedProduct(name) {
    const id = db.prepare('INSERT INTO products (user_id,name,price,stock) VALUES (1,?,?,0)').run(name, 0).lastInsertRowid;
    db.prepare(`UPDATE products SET item_type='finished', is_manufactured=1, average_cost_rial=0, unit='عدد', code=? WHERE id=?`)
      .run('T463-' + id, id);
    return Number(id);
  }
  function seedVariants(pid, tag) {
    const c1 = db.prepare('INSERT INTO product_colors (code, name) VALUES (?,?)').run('C' + tag + 'A', 'مشکی').lastInsertRowid;
    const c2 = db.prepare('INSERT INTO product_colors (code, name) VALUES (?,?)').run('C' + tag + 'B', 'سرمه‌ای').lastInsertRowid;
    const s1 = db.prepare('INSERT INTO product_sizes (code, name) VALUES (?,?)').run('S' + tag, 'فری').lastInsertRowid;
    const ins = db.prepare(`
      INSERT INTO product_variants (product_id, color_id, size_id, sku, stock, active, is_default)
      VALUES (?,?,?,?,0,1,0)
    `);
    return {
      c1: Number(c1), c2: Number(c2), s1: Number(s1),
      v1: Number(ins.run(pid, c1, s1, 'SKU-' + tag + '-1').lastInsertRowid),
      v2: Number(ins.run(pid, c2, s1, 'SKU-' + tag + '-2').lastInsertRowid),
    };
  }
  function vqty(vid) {
    const row = db.prepare('SELECT qty FROM variant_warehouse_stock WHERE variant_id=? AND warehouse_id=?').get(vid, whFg);
    return Number(row && row.qty) || 0;
  }
  const pA = seedProduct('یلدا');
  const pB = seedProduct('آبان');
  const pFab = seedProduct('پارچه');
  db.prepare(`UPDATE products SET item_type='raw', is_manufactured=0, average_cost_rial=1000, stock=1000 WHERE id=?`).run(pFab);
  const va = seedVariants(pA, 'A');
  const vb = seedVariants(pB, 'B');
  const cc = db.prepare("SELECT id FROM cost_centers WHERE code='CC-10'").get()?.id
    || db.prepare('SELECT id FROM cost_centers LIMIT 1').get()?.id;
  const whRaw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get()?.id
    || db.prepare('SELECT id FROM warehouses LIMIT 1').get()?.id;
  const whFg = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get()?.id || whRaw;
  ok(!!cc && !!whRaw && !!whFg, 'db seed centers');
  db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,1000)').run(pFab, whRaw);

  const draft = bom.createBom(db, {
    product_id: pA,
    name: 'BOM-FIN-MX',
    has_routing: 1,
    has_coproducts: 1,
    co_product_ids: [pB],
    auto_share_method: 'physical',
    base_qty: 1,
    yield_percent: 100,
    lines: [{
      component_product_id: pFab, qty_per_base: 1, line_type: 'material',
      product_scope: 'shared', stage_cost_center_id: cc,
    }],
  }, adminId);
  advBom.addOperation(db, draft.id, {
    seq: 10, cost_center_id: cc, operation_name: 'بسته‌بندی',
    labor_method: 'contract', yield_percent: 100, product_scope: 'shared',
  }, adminId);
  bom.activateBom(db, draft.id, '1405/01/01', adminId);
  db.prepare(`UPDATE bom_outputs SET cost_share_percent=60 WHERE bom_id=? AND product_id=?`).run(draft.id, pA);
  db.prepare(`UPDATE bom_outputs SET cost_share_percent=40, qty_per_base=1 WHERE bom_id=? AND product_id=?`).run(draft.id, pB);

  function openOrder(tag) {
    const po = engine.createOrder(db, {
      product_id: pA, bom_id: draft.id, qty_planned: 4,
      analysis_type: 'fixed_adv', date: DATE,
      warehouse_raw_id: whRaw, warehouse_fg_id: whFg, cost_center_id: cc,
      fg_plan: [{ product_id: pA, qty: 4 }, { product_id: pB, qty: 2 }],
      matrix_lines: [
        { product_id: pA, color_id: va.c1, size_id: va.s1, qty_planned: 3 },
        { product_id: pA, color_id: va.c2, size_id: va.s1, qty_planned: 1 },
        { product_id: pB, color_id: vb.c1, size_id: vb.s1, qty_planned: 2 },
      ],
    }, adminId);
    engine.releaseOrder(db, po.id, adminId);
    const st = engAdv.stageList(db, po.id)[0];
    eq(tag + ' shared stage is the sum 6', st.qty_in, 6);
    engAdv.postStageOutputFixed(db, {
      orderId: po.id, stageId: st.id,
      body: { date: DATE, qty_out: 6, waste_normal: 0, waste_abnormal: 0 },
      userId: adminId,
    });
    return po;
  }

  const po1 = openOrder('auto');
  const fin = engAdv.finalizeAdvancedOrder(db, {
    orderId: po1.id,
    body: {
      date: DATE,
      qty_produced: 6,
      outputs: [
        { product_id: pA, qty: 4 },
        { product_id: pB, qty: 2 },
      ],
    },
    userId: adminId,
  });
  eq('two FG receipts', (fin.receipts || []).length, 2);
  eq('header color 1 from its own plan', vqty(va.v1), 3);
  eq('header color 2 from its own plan', vqty(va.v2), 1);
  eq('peer color from its own plan, not dropped', vqty(vb.v1), 2);
  eq('peer second color stays empty', vqty(vb.v2), 0);
  const peerRec = db.prepare(`SELECT variant_lines_json FROM production_receipts WHERE order_id=? AND product_id=?`).get(po1.id, pB);
  ok(String(peerRec && peerRec.variant_lines_json || '').includes(String(vb.v1)), 'peer receipt stores its variant lines');

  const po2 = openOrder('mismatch');
  let mismatch = null;
  try {
    engAdv.finalizeAdvancedOrder(db, {
      orderId: po2.id,
      body: {
        date: DATE,
        outputs: [
          { product_id: pA, qty: 4 },
          { product_id: pB, qty: 5 },
        ],
      },
      userId: adminId,
    });
  } catch (e) { mismatch = e; }
  ok(mismatch && mismatch.code === 'E_VARIANT_QTY', 'peer plan that does not match its receipt is refused', mismatch && (mismatch.code || mismatch.message));
  eq('refused finalize did not add more peer stock', vqty(vb.v1), 2);

  const po3 = openOrder('tagged');
  engAdv.finalizeAdvancedOrder(db, {
    orderId: po3.id,
    body: {
      date: DATE,
      outputs: [
        { product_id: pA, qty: 4 },
        { product_id: pB, qty: 2 },
      ],
      variant_lines: [
        { product_id: pA, variant_id: va.v1, qty: 3 },
        { product_id: pA, variant_id: va.v2, qty: 1 },
        { product_id: pB, variant_id: vb.v2, qty: 2 },
      ],
    },
    userId: adminId,
  });
  eq('tagged body keeps header colors', vqty(va.v1), 6);
  eq('tagged body puts the peer qty on the color the user sent', vqty(vb.v2), 2);
  eq('untagged peer color did not absorb the header qty', vqty(vb.v1), 2);
} catch (e) {
  ok(false, 'sqlite scenario', e && (e.stack || e.message || e));
} finally {
  try { cleanup(); } catch (_) {}
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
