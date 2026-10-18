'use strict';
/**
 * v461 — stage output / stage issue can cover a material shortage with an alternate SKU.
 * Run: node server/scripts/test-stage-material-alt-v461.js
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const fs = require('fs');
const path = require('path');
const { ok, eq, throws, freshDb, summary } = require('./lib/test-harness');
const bom = require('../lib/production/bom');
const advBom = require('../lib/production/bom-advanced');
const engine = require('../lib/production/engine');
const adv = require('../lib/production/engine-advanced');

console.log('\n══ v461 stage material alternate ══\n');

const { db, cleanup } = freshDb();
const adminId = 1;
const DATE = '1405/07/27';

function seedProduct(name, avg, stock, type) {
  const id = db.prepare('INSERT INTO products (user_id,name,price,stock) VALUES (1,?,?,?)')
    .run(name, 0, stock).lastInsertRowid;
  db.prepare(`
    UPDATE products SET average_cost_rial=?, item_type=?, is_manufactured=?, std_cost_rial=?, code=?
    WHERE id=?
  `).run(avg, type, type === 'finished' ? 1 : 0, avg, 'ALT-' + id, id);
  return id;
}

function putWh(pid, qty) {
  db.prepare(`
    INSERT INTO warehouse_stock (warehouse_id, product_id, qty)
    VALUES (?,?,?)
    ON CONFLICT(warehouse_id, product_id) DO UPDATE SET qty=excluded.qty
  `).run(whRaw, pid, qty);
  db.prepare('UPDATE products SET stock=? WHERE id=?').run(qty, pid);
}

function whQty(pid) {
  return Number(db.prepare(
    'SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND product_id=?'
  ).get(whRaw, pid)?.qty) || 0;
}

const pFg = seedProduct('کاپشن تست', 0, 0, 'finished');
const pFgVar = seedProduct('کاپشن متغیر', 0, 0, 'finished');
const pZip = seedProduct('زیپ کلاه', 50000, 70, 'raw');
const pAlt = seedProduct('زیپ ساده', 45000, 100, 'raw');
const ccId = db.prepare("SELECT id FROM cost_centers WHERE code='CC-40'").get()?.id
  || db.prepare('SELECT id FROM cost_centers WHERE COALESCE(is_stage,0)=1 LIMIT 1').get()?.id;
ok(!!ccId, 'stage cost center exists');

const whRaw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get()?.id;
const whFg = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get()?.id;
ok(!!whRaw, 'WH-RAW exists');
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_raw_id',?)").run(String(whRaw));
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_fg_id',?)").run(String(whFg));
putWh(pZip, 70);
putWh(pAlt, 100);

function makeOrder(analysis, productId) {
  const draft = bom.createBom(db, {
    product_id: productId,
    name: 'BOM stage alt ' + analysis,
    yield_percent: 100,
    base_qty: 1,
    has_routing: 1,
    lines: [
      {
        component_product_id: pZip,
        qty_per_base: 96,
        scrap_percent: 0,
        line_type: 'material',
        stage_cost_center_id: ccId,
        std_cost_rial: 50000,
      },
    ],
  }, adminId);
  advBom.addOperation(db, draft.id, {
    seq: 10,
    cost_center_id: ccId,
    operation_name: 'دوخت',
    labor_method: 'contract',
    yield_percent: 100,
  }, adminId);
  bom.activateBom(db, draft.id, '1405/01/01', adminId);
  const po = engine.createOrder(db, {
    product_id: productId,
    bom_id: draft.id,
    qty_planned: 1,
    analysis_type: analysis,
    date: DATE,
    warehouse_raw_id: whRaw,
    warehouse_fg_id: whFg,
    cost_center_id: ccId,
  }, adminId);
  engine.releaseOrder(db, po.id, adminId);
  const stage = adv.stageList(db, po.id)[0];
  return { po, stage };
}

const fixed = makeOrder('fixed_adv', pFg);
const tpl = adv.getStageIssueTemplate(db, fixed.po.id, fixed.stage.id);
const zipLine = (tpl.lines || []).find(L => Number(L.product_id) === pZip);
ok(!!zipLine && Number(zipLine.stock_short) === 1, 'template flags zip shortage 70<96', zipLine);
eq('template available', Number(zipLine.stock_available), 70);

throws('خروجی بدون جایگزین → E_NEGATIVE_STOCK', () => {
  adv.postStageOutputFixed(db, {
    orderId: fixed.po.id,
    stageId: fixed.stage.id,
    userId: adminId,
    body: { date: DATE, qty_out: 1, waste_normal: 0, waste_abnormal: 0, rework: 0 },
  });
}, 'E_NEGATIVE_STOCK');
eq('stock untouched after reject', whQty(pZip), 70);

throws('پوشش جزئی رد می‌شود', () => {
  adv.postStageOutputFixed(db, {
    orderId: fixed.po.id,
    stageId: fixed.stage.id,
    userId: adminId,
    body: {
      date: DATE, qty_out: 1, waste_normal: 0, waste_abnormal: 0, rework: 0,
      materials: [{ product_id: pZip, alternate_product_id: pAlt, alternate_qty: 10 }],
    },
  });
}, 'E_NEGATIVE_STOCK');
eq('partial does not move zip', whQty(pZip), 70);
eq('partial does not move alt', whQty(pAlt), 100);

throws('جایگزین همان قلم رد می‌شود', () => {
  adv.postStageOutputFixed(db, {
    orderId: fixed.po.id,
    stageId: fixed.stage.id,
    userId: adminId,
    body: {
      date: DATE, qty_out: 1, waste_normal: 0, waste_abnormal: 0, rework: 0,
      materials: [{ product_id: pZip, alternate_product_id: pZip, alternate_qty: 26 }],
    },
  });
}, 'E_SUBSTITUTE_INVALID');

const posted = adv.postStageOutputFixed(db, {
  orderId: fixed.po.id,
  stageId: fixed.stage.id,
  userId: adminId,
  body: {
    date: DATE, qty_out: 1, waste_normal: 0, waste_abnormal: 0, rework: 0,
    materials: [{ product_id: pZip, alternate_product_id: pAlt, alternate_qty: 26 }],
  },
});
ok(posted.ok && posted.stage && posted.stage.status === 'done', 'stage output with alternate posts', posted.stage);
eq('zip issued down to 0', whQty(pZip), 0);
eq('alt covers 26', whQty(pAlt), 74);

const rows = db.prepare(`
  SELECT product_id, issue_type, qty_standard, qty_actual, substitute_of_product_id
  FROM production_material_issues
  WHERE order_id=? AND stage_id=? AND status='posted'
  ORDER BY id
`).all(fixed.po.id, fixed.stage.id);
const prim = rows.find(r => Number(r.product_id) === pZip);
const sub = rows.find(r => Number(r.product_id) === pAlt);
eq('primary actual', Number(prim?.qty_actual), 70);
eq('primary standard stays on BOM item', Number(prim?.qty_standard), 96);
ok(sub && sub.issue_type === 'substitute', 'substitute type', sub && sub.issue_type);
ok(Number(sub?.substitute_of_product_id) === pZip, 'substitute points at zip');
ok(Number(sub?.qty_standard) === 0, 'partial substitute standard is 0');
ok(Number(sub?.qty_actual) === 26, 'substitute actual');

const varJe = db.prepare(`
  SELECT COUNT(*) c FROM journal_lines
  WHERE account_code IN ('5210','5211')
    AND ABS(COALESCE(debit,0))+ABS(COALESCE(credit,0)) <> 0
`).get().c;
eq('ADR-011 variance accounts stay 0', varJe, 0);

adv.reverseStage(db, {
  orderId: fixed.po.id,
  stageId: fixed.stage.id,
  reason: 'برگشت تست جایگزین',
  userId: adminId,
  date: DATE,
});
eq('reverse restores zip', whQty(pZip), 70);
eq('reverse restores alt', whQty(pAlt), 100);

putWh(pZip, 70);
putWh(pAlt, 40);
const variable = makeOrder('variable_adv', pFgVar);
const issued = adv.issueStageMaterials(db, {
  orderId: variable.po.id,
  stageId: variable.stage.id,
  userId: adminId,
  body: {
    date: DATE,
    materials: [{
      product_id: pZip,
      qty_actual: 96,
      alternate_product_id: pAlt,
      alternate_qty: 26,
    }],
  },
});
ok(issued && (issued.ok !== false), 'variable stage issue accepts alternate', issued.issue_no || issued.doc_no || true);
eq('variable zip on hand', whQty(pZip), 0);
eq('variable alt on hand', whQty(pAlt), 14);

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(app.includes('prodStageAltSearch'), 'stage UI searches alternate');
ok(app.includes('کسری مواد در مرحله (v462)'), 'admin help mentions stage alternate');
ok(app.includes("body.materials=alts") || app.includes('body.materials=alts'), 'output posts alternates');

new Function(app);

cleanup();
summary();
