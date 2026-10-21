'use strict';
/**
 * v515 — پارچهٔ کیلوگرمی/مترمربعی بدون طاقه که در BOM فعال به عملیات برش وصل است
 * از سفارش اول هم پارچهٔ طاقه‌ای است (لایه‌چینی، نه حوالهٔ مرحله).
 * Run: node server/scripts/test-roll-fabric-detect-v515.js
 */
const fs = require('fs');
const path = require('path');
const { ok, summary } = require('./lib/test-harness');

const root = path.join(__dirname, '..');
const cutSrc = fs.readFileSync(path.join(root, 'lib/production/cutting.js'), 'utf8');
ok('detector checks cutting operation', /function isRollFabricProduct[\s\S]{0,1200}onActiveBomCuttingOperation\(db/.test(cutSrc));
const adv = fs.readFileSync(path.join(root, 'lib/production/engine-advanced.js'), 'utf8');
ok('resolveCuttingStage ignores reversed rolls',
  /function resolveCuttingStage[\s\S]{0,1200}kind,'generic'\)='fabric' AND COALESCE\(status,'active'\) <> 'reversed'/.test(adv));

let dbOk = false;
try {
  const { freshDb } = require('./lib/test-harness');
  const cutting = require('../lib/production/cutting');
  const { isRollFabricProduct, rollFabricUnitLabel } = cutting;
  const { resolveReceiptProfile } = require('../lib/inventory/fabric-rolls');
  const ctx = freshDb();
  const { db, cleanup } = ctx;
  try {
    const unit = (code) => db.prepare('SELECT * FROM units_of_measure WHERE UPPER(code)=?').get(code);
    const M = unit('M'); const KG = unit('KG'); const M2 = unit('M2'); const PCS = unit('PCS');
    ok('catalog M/KG/M2/PCS', !!(M && KG && M2 && PCS));
    const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get();
    const raw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get();

    const cc = (code, name, seq) => {
      const row = db.prepare('SELECT id FROM cost_centers WHERE code=?').get(code);
      if (row) return row.id;
      return db.prepare('INSERT INTO cost_centers (code,name,is_stage,active,seq) VALUES (?,?,1,1,?)')
        .run(code, name, seq).lastInsertRowid;
    };
    const ccCut = cc('CC-10', 'برش', 10);
    const ccSew = cc('CC-30', 'دوخت', 30);

    const product = (code, unitText, unitId, itemType = 'raw', manufactured = 0) => db.prepare(`
      INSERT INTO products (user_id, name, code, price, stock, unit, unit_id, average_cost_rial, cost, item_type, is_manufactured)
      VALUES (?, ?, ?, 0, 0, ?, ?, 1000, 1000, ?, ?)
    `).run(admin.id, 'کالا ' + code, code, unitText, unitId, itemType, manufactured).lastInsertRowid;

    let bomSeq = 0;
    // components: [{ productId, cc }] — each line assigned to the operation of that cost center.
    const bom = (components, status = 'active') => {
      bomSeq += 1;
      const fg = product('V515-FG-' + bomSeq, 'عدد', PCS.id, 'finished', 1);
      const bomId = db.prepare(`
        INSERT INTO bom_headers (code,product_id,version,status,base_qty,has_routing,yield_percent)
        VALUES (?,?,1,'draft',1,1,100)
      `).run('BOM-V515-' + bomSeq, fg).lastInsertRowid;
      const opCut = db.prepare(`
        INSERT INTO bom_operations (bom_id,seq,cost_center_id,operation_name,labor_method,yield_percent)
        VALUES (?,10,?,'برش','monthly',100)
      `).run(bomId, ccCut).lastInsertRowid;
      const opSew = db.prepare(`
        INSERT INTO bom_operations (bom_id,seq,cost_center_id,operation_name,labor_method,yield_percent)
        VALUES (?,30,?,'دوخت','piece',100)
      `).run(bomId, ccSew).lastInsertRowid;
      components.forEach((c, i) => {
        const lineId = db.prepare(`
          INSERT INTO bom_lines (bom_id,line_no,component_product_id,qty_per_base,stage_cost_center_id,line_type)
          VALUES (?,?,?,1,?,'material')
        `).run(bomId, i + 1, c.productId, c.cc).lastInsertRowid;
        db.prepare(`
          INSERT INTO bom_material_assignments (bom_id,bom_line_id,operation_id,allocation_mode)
          VALUES (?,?,?,'sole')
        `).run(bomId, lineId, c.cc === ccCut ? opCut : opSew);
      });
      if (status !== 'draft') db.prepare('UPDATE bom_headers SET status=? WHERE id=?').run(status, bomId);
      return { bomId, fg };
    };

    const kgCut = product('V515-KG-CUT', 'کیلوگرم', KG.id);
    const kgSew = product('V515-KG-SEW', 'کیلوگرم', KG.id);
    const areaCut = product('V515-M2-CUT', 'متر مربع', M2.id);
    const pcsCut = product('V515-PCS-CUT', 'عدد', PCS.id);
    const kgRev = product('V515-KG-REV', 'کیلوگرم', KG.id);
    const metre = product('V515-M', 'متر', M.id);
    const kgDraft = product('V515-KG-DRAFT', 'کیلوگرم', KG.id);
    const kgText = product('V515-KG-TEXT', 'کیلوگرم', null);

    const main = bom([
      { productId: kgCut, cc: ccCut },
      { productId: kgSew, cc: ccSew },
      { productId: areaCut, cc: ccCut },
      { productId: pcsCut, cc: ccCut },
      { productId: kgRev, cc: ccSew },
      { productId: kgText, cc: ccCut },
    ]);
    bom([{ productId: kgDraft, cc: ccCut }], 'draft');

    db.prepare(`
      INSERT INTO inventory_batches (batch_no, product_id, warehouse_id, qty_on_hand, qty_received, status, kind, unit)
      VALUES ('V515-REV', ?, ?, 0, 10, 'reversed', 'fabric', 'kg')
    `).run(kgRev, raw.id);

    ok('kg fabric without rolls on cutting op → roll fabric', isRollFabricProduct(db, kgCut) === true);
    ok('same kg material on sewing op → not roll fabric', isRollFabricProduct(db, kgSew) === false);
    ok('m² fabric on cutting op → roll fabric', isRollFabricProduct(db, areaCut) === true);
    ok('count unit on cutting op → not roll fabric', isRollFabricProduct(db, pcsCut) === false);
    ok('reversed-only roll → not roll fabric', isRollFabricProduct(db, kgRev) === false);
    ok('length product → roll fabric', isRollFabricProduct(db, metre) === true);
    ok('kg on cutting op of a draft BOM only → not roll fabric', isRollFabricProduct(db, kgDraft) === false);
    ok('kg unit text without unit_id on cutting op → roll fabric', isRollFabricProduct(db, kgText) === true);
    ok('product row object works too',
      isRollFabricProduct(db, db.prepare('SELECT id, unit, unit_id FROM products WHERE id=?').get(kgCut)) === true);

    ok('label falls back to product unit', rollFabricUnitLabel(db, { id: kgCut, unit: 'کیلوگرم' }) === 'کیلوگرم');
    const prodKg = db.prepare('SELECT * FROM products WHERE id=?').get(kgCut);
    ok('receipt of kg cutting fabric defaults to roll', resolveReceiptProfile(prodKg, {}, db) === 'fabric');
    const prodSew = db.prepare('SELECT * FROM products WHERE id=?').get(kgSew);
    ok('receipt of kg sewing material stays attr', resolveReceiptProfile(prodSew, {}, db) === 'attr');

    let code = '';
    try { cutting.assertFabricIssueAllowed(db, { productId: kgCut, qty: 1 }); } catch (e) { code = e.code; }
    ok('direct issue of kg cutting fabric → E_FABRIC_VIA_CUT', code === 'E_FABRIC_VIA_CUT', code);
    code = '';
    try { cutting.assertFabricIssueAllowed(db, { productId: kgSew, qty: 1 }); } catch (e) { code = e.code; }
    ok('direct issue of kg sewing material allowed', code === '', code);

    const solo = bom([{ productId: kgCut, cc: ccCut }]);
    const po = { id: 0, bom_id: solo.bomId, product_id: solo.fg, date: '1405/07/29', size_breakdown: '{}' };
    ok('order with kg cutting fabric requires lay-up', cutting.orderRequiresFabricCutting(db, po) === true);
    const soloSew = bom([{ productId: kgSew, cc: ccSew }]);
    const poSew = { id: 0, bom_id: soloSew.bomId, product_id: soloSew.fg, date: '1405/07/29', size_breakdown: '{}' };
    ok('order with kg sewing material only does not require lay-up', cutting.orderRequiresFabricCutting(db, poSew) === false);
    ok('main BOM exists', !!main.bomId);
    dbOk = true;
  } finally {
    cleanup();
  }
} catch (e) {
  if (/bindings|better_sqlite3|NODE_MODULE_VERSION/i.test(String(e.message) + e)) {
    console.log('  SKIP db path: better-sqlite3 not loaded on this Node');
    ok('db path skipped (static assertions still ran)', true);
  } else {
    ok('db path', false, e.stack || e.message);
  }
}
if (dbOk) ok('db roll-fabric detection path', true);

summary('roll-fabric-detect-v515');
