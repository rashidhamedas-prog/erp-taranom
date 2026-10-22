'use strict';
/**
 * v523 — ابطال مرحله و ثبت دوباره:
 *  1) reverseEvent فقط همان سند را باطل می‌کند (نه همهٔ اسناد هم‌ref سفارش).
 *  2) ابطال دستی مرحله مصرف پارچهٔ لایهٔ زنده (cutting_lay) را روی سفارش نگه می‌دارد.
 *  3) آنالیز متغیر: خروجی تا حوالهٔ همهٔ اقلام فرمول مرحله ثبت نمی‌شود.
 * Run: node server/scripts/test-stage-reverse-integrity-v523.js
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const fs = require('fs');
const path = require('path');
const { ok, eq, throws, freshDb, summary } = require('./lib/test-harness');
const bom = require('../lib/production/bom');
const advBom = require('../lib/production/bom-advanced');
const engine = require('../lib/production/engine');
const adv = require('../lib/production/engine-advanced');

console.log('\n══ v523 stage reverse integrity ══\n');

const { db, cleanup } = freshDb();
const adminId = 1;
const DATE = '1405/07/30';

function seedProduct(name, avg, type) {
  const id = db.prepare('INSERT INTO products (user_id,name,price,stock) VALUES (1,?,?,0)')
    .run(name, 0).lastInsertRowid;
  db.prepare(`
    UPDATE products SET average_cost_rial=?, item_type=?, is_manufactured=?, std_cost_rial=?, code=?
    WHERE id=?
  `).run(avg, type, type === 'finished' ? 1 : 0, avg, 'V523-' + id, id);
  return id;
}

const whRaw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get()?.id;
const whFg = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get()?.id;
ok(!!whRaw && !!whFg, 'warehouses exist');
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_raw_id',?)").run(String(whRaw));
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_fg_id',?)").run(String(whFg));

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
function jeLive(id) {
  const r = db.prepare('SELECT status, deleted_at FROM journal_entries WHERE id=?').get(id);
  return !!r && !(Number(r.deleted_at) > 0) && r.status !== 'reversed';
}

const ccs = db.prepare('SELECT id FROM cost_centers WHERE COALESCE(is_stage,0)=1 ORDER BY id LIMIT 2').all().map(r => r.id);
ok(ccs.length === 2, 'two stage cost centers', ccs);
const [cc1, cc2] = ccs;

const pFg = seedProduct('سیوشرت v523', 0, 'finished');
const pThread = seedProduct('نخ v523', 10000, 'raw');
const pBand = seedProduct('بند v523', 30000, 'raw');
const pZip = seedProduct('زیپ v523', 50000, 'raw');
putWh(pThread, 100);
putWh(pBand, 100);
putWh(pZip, 100);

const draft = bom.createBom(db, {
  product_id: pFg,
  name: 'BOM v523',
  yield_percent: 100,
  base_qty: 1,
  has_routing: 1,
  lines: [
    { component_product_id: pThread, qty_per_base: 2, scrap_percent: 0, line_type: 'material', stage_cost_center_id: cc1, std_cost_rial: 10000 },
    { component_product_id: pBand, qty_per_base: 1, scrap_percent: 0, line_type: 'material', stage_cost_center_id: cc1, std_cost_rial: 30000 },
    { component_product_id: pZip, qty_per_base: 1, scrap_percent: 0, line_type: 'material', stage_cost_center_id: cc2, std_cost_rial: 50000 },
  ],
}, adminId);
advBom.addOperation(db, draft.id, { seq: 10, cost_center_id: cc1, operation_name: 'برش', labor_method: 'contract', yield_percent: 100, machine_minutes_per_unit: 1, run_minutes_per_unit: 1 }, adminId);
advBom.addOperation(db, draft.id, { seq: 20, cost_center_id: cc2, operation_name: 'دوخت', labor_method: 'contract', yield_percent: 100, machine_minutes_per_unit: 1, run_minutes_per_unit: 1 }, adminId);
bom.activateBom(db, draft.id, '1405/01/01', adminId);
const po = engine.createOrder(db, {
  product_id: pFg, bom_id: draft.id, qty_planned: 10, analysis_type: 'variable_adv',
  date: DATE, warehouse_raw_id: whRaw, warehouse_fg_id: whFg, cost_center_id: cc1,
}, adminId);
engine.releaseOrder(db, po.id, adminId);
let [s1, s2] = adv.stageList(db, po.id);
if (s1.status === 'pending') adv.startStage(db, po.id, s1.id, adminId);
s1 = adv.stageList(db, po.id)[0];

const outBody = (qty) => ({ date: DATE, qty_out: qty, waste_normal: 0, waste_abnormal: 0, rework: 0, qc_passed: 1 });

// ── 3) strict issue gate ──
adv.issueStageMaterials(db, {
  orderId: po.id, stageId: s1.id, userId: adminId,
  body: { date: DATE, materials: [{ product_id: pThread, qty_actual: 20 }, { product_id: pBand, qty_actual: 0 }] },
});
const tpl1 = adv.getStageIssueTemplate(db, po.id, s1.id);
ok(tpl1.analysis_type === 'variable_adv', 'template analysis_type', tpl1.analysis_type);
ok((tpl1.unissued || []).some(m => m.product_id === pBand), 'template lists band as unissued', tpl1.unissued);
eq('template issued_qty thread', Number((tpl1.lines || []).find(L => L.product_id === pThread)?.issued_qty), 20);
throws('output blocked while band not issued', () => {
  adv.postStageOutputVariable(db, { orderId: po.id, stageId: s1.id, userId: adminId, body: outBody(Number(s1.qty_in)) });
}, 'E_STAGE_MATERIAL_NOT_ISSUED');
adv.issueStageMaterials(db, {
  orderId: po.id, stageId: s1.id, userId: adminId,
  body: { date: DATE, materials: [{ product_id: pBand, qty_actual: 10 }] },
});
eq('template no unissued after band', (adv.getStageIssueTemplate(db, po.id, s1.id).unissued || []).length, 0);

// lay memo (cutting_lay) — مصرف پارچهٔ لایهٔ زنده؛ JE مال لایه است
const LAY_AMT = 777000;
const layIssueId = db.prepare(`
  INSERT INTO production_material_issues
    (doc_no, order_id, stage_id, cost_center_id, product_id, issue_type, qty_standard, qty_actual,
     unit_cost_rial, std_cost_rial, amount_rial, std_amount_rial, warehouse_id, date, period_label,
     status, variance_status, note, created_by)
  VALUES ('LAY-T523',?,?,?,?,'cutting_lay',7,7,111000,111000,?,?,?,?,'1405/07','posted','memo','لایه‌چینی LAY-T523 — مصرف پارچه مرحله برش',?)
`).run(po.id, s1.id, cc1, pThread, LAY_AMT, LAY_AMT, whRaw, DATE, adminId).lastInsertRowid;

adv.postStageOutputVariable(db, { orderId: po.id, stageId: s1.id, userId: adminId, body: outBody(Number(s1.qty_in)) });
s2 = adv.stageList(db, po.id)[1];
if (s2.status === 'pending') adv.startStage(db, po.id, s2.id, adminId);
s2 = adv.stageList(db, po.id)[1];

const je1 = db.prepare(`
  SELECT DISTINCT je_id FROM production_material_issues
  WHERE stage_id=? AND status='posted' AND je_id IS NOT NULL AND issue_type<>'cutting_lay'
`).all(s1.id).map(r => r.je_id);
ok(je1.length >= 1 && je1.every(jeLive), 'stage 1 issue JEs live', je1);

adv.issueStageMaterials(db, {
  orderId: po.id, stageId: s2.id, userId: adminId,
  body: { date: DATE, materials: [{ product_id: pZip, qty_actual: 10 }] },
});
adv.postStageOutputVariable(db, { orderId: po.id, stageId: s2.id, userId: adminId, body: outBody(Number(s2.qty_in)) });
eq('zip issued', whQty(pZip), 90);

// ── 1) ابطال مرحلهٔ ۲ نباید سند حوالهٔ مرحلهٔ ۱ (ref مشترک سفارش) را باطل کند ──
adv.reverseStage(db, { orderId: po.id, stageId: s2.id, reason: 'تست v523', userId: adminId, date: DATE });
ok(je1.every(jeLive), 'stage 1 issue JEs still live after reversing stage 2', je1.map(id => db.prepare('SELECT id,status,deleted_at FROM journal_entries WHERE id=?').get(id)));
eq('zip back to stock (regular issue reversed)', whQty(pZip), 100);

// ── 2) ابطال دستی مرحلهٔ ۱: لایهٔ زنده posted می‌ماند ──
adv.reverseStage(db, { orderId: po.id, stageId: s1.id, reason: 'تست v523', userId: adminId, date: DATE });
const layRow = db.prepare('SELECT status FROM production_material_issues WHERE id=?').get(layIssueId);
ok(layRow.status === 'posted', 'lay memo stays posted on manual reverse', layRow.status);
eq('thread back to stock', whQty(pThread), 100);
eq('band back to stock', whQty(pBand), 100);
const poAfter = db.prepare('SELECT material_cost_rial FROM production_orders WHERE id=?').get(po.id);
eq('order material cost = live lay only', Number(poAfter.material_cost_rial), LAY_AMT);
const s1After = adv.stageList(db, po.id)[0];
ok(s1After.status === 'in_progress', 'stage 1 in_progress', s1After.status);
eq('stage 1 material_added keeps lay', Number(s1After.material_added_rial), LAY_AMT);
ok(je1.every(id => !jeLive(id)), 'stage 1 own issue JEs voided by its own reverse');

// re-record: gate again (regular issues were reversed), then output works
throws('re-output blocked until re-issue', () => {
  adv.postStageOutputVariable(db, { orderId: po.id, stageId: s1.id, userId: adminId, body: outBody(Number(s1After.qty_in)) });
}, 'E_STAGE_MATERIAL_NOT_ISSUED');
adv.issueStageMaterials(db, {
  orderId: po.id, stageId: s1.id, userId: adminId,
  body: { date: DATE, materials: [{ product_id: pThread, qty_actual: 20 }, { product_id: pBand, qty_actual: 10 }] },
});
const re = adv.postStageOutputVariable(db, { orderId: po.id, stageId: s1.id, userId: adminId, body: outBody(Number(s1After.qty_in)) });
ok(re && re.ok !== false, 're-output after re-issue posts');
const s1Done = adv.stageList(db, po.id)[0];
eq('stage 1 cost_out includes lay + issues', Number(s1Done.material_added_rial), LAY_AMT + 20 * 10000 + 10 * 30000);

// lay void path: releaseLayIssueIds برچسب همان لایه را برمی‌دارد
adv.reverseStage(db, {
  orderId: po.id, stageId: s1.id, reason: 'ابطال لایه', userId: adminId, date: DATE,
  releaseLayIssueIds: [layIssueId],
});
ok(db.prepare('SELECT status FROM production_material_issues WHERE id=?').get(layIssueId).status === 'reversed', 'lay memo reversed when its lay is voided');
eq('order material cost 0 after lay release', Number(db.prepare('SELECT material_cost_rial FROM production_orders WHERE id=?').get(po.id).material_cost_rial), 0);

// ── 4) fixed_adv: backflush نباید ردیف لایه را مهر JE کند؛ ثبت دوباره بهای لایه را در مرحله نگه دارد ──
const poF = engine.createOrder(db, {
  product_id: pFg, bom_id: draft.id, qty_planned: 10, analysis_type: 'fixed_adv',
  date: DATE, warehouse_raw_id: whRaw, warehouse_fg_id: whFg, cost_center_id: cc1,
}, adminId);
engine.releaseOrder(db, poF.id, adminId);
let f1 = adv.stageList(db, poF.id)[0];
if (f1.status === 'pending') adv.startStage(db, poF.id, f1.id, adminId);
f1 = adv.stageList(db, poF.id)[0];
const LAY_F = 500000;
const layF = db.prepare(`
  INSERT INTO production_material_issues
    (doc_no, order_id, stage_id, cost_center_id, product_id, issue_type, qty_standard, qty_actual,
     unit_cost_rial, std_cost_rial, amount_rial, std_amount_rial, warehouse_id, date, period_label,
     status, variance_status, note, created_by)
  VALUES ('LAY-F523',?,?,?,?,'cutting_lay',5,5,100000,100000,?,?,?,?,'1405/07','posted','memo','لایه‌چینی LAY-F523 — مصرف پارچه مرحله برش',?)
`).run(poF.id, f1.id, cc1, pThread, LAY_F, LAY_F, whRaw, DATE, adminId).lastInsertRowid;
adv.postStageOutputFixed(db, { orderId: poF.id, stageId: f1.id, userId: adminId, body: outBody(Number(f1.qty_in)) });
ok(db.prepare('SELECT je_id FROM production_material_issues WHERE id=?').get(layF).je_id == null, 'fixed backflush does not stamp lay memo je_id');
const f1Done = adv.stageList(db, poF.id)[0];
ok(Number(f1Done.material_added_rial) >= LAY_F + 20 * 10000 + 10 * 30000, 'fixed stage material includes lay', f1Done.material_added_rial);
adv.reverseStage(db, { orderId: poF.id, stageId: f1.id, reason: 'تست v523 ثابت', userId: adminId, date: DATE });
ok(db.prepare('SELECT status FROM production_material_issues WHERE id=?').get(layF).status === 'posted', 'fixed: lay memo stays posted on manual reverse');
f1 = adv.stageList(db, poF.id)[0];
adv.postStageOutputFixed(db, { orderId: poF.id, stageId: f1.id, userId: adminId, body: outBody(Number(f1.qty_in)) });
const f1Re = adv.stageList(db, poF.id)[0];
eq('fixed re-post: stage material = lay + backflush', Number(f1Re.material_added_rial), Number(f1Done.material_added_rial));
eq('fixed re-post: order material = stage material', Number(db.prepare('SELECT material_cost_rial FROM production_orders WHERE id=?').get(poF.id).material_cost_rial), Number(f1Re.material_added_rial));

// ── 5) تطبیق دقیق شمارهٔ لایه: LAY-1 نباید LAY-10 را بگیرد ──
const globMid = '*LAY-1[^0-9]*';
const globEnd = '*LAY-1';
const m1 = db.prepare('SELECT (? GLOB ? OR ? GLOB ?) m').get('لایه‌چینی LAY-10 — مصرف', globMid, 'لایه‌چینی LAY-10 — مصرف', globEnd).m;
const m2 = db.prepare('SELECT (? GLOB ? OR ? GLOB ?) m').get('لایه‌چینی LAY-1 — مصرف', globMid, 'لایه‌چینی LAY-1 — مصرف', globEnd).m;
ok(m1 === 0 && m2 === 1, 'lay note glob is exact', { m1, m2 });
const advSrc = fs.readFileSync(path.join(__dirname, '../lib/production/engine-advanced.js'), 'utf8');
ok(!/issue_type='cutting_lay'[\s\S]{0,80}note LIKE/.test(advSrc), 'no loose LIKE lay matching in engine-advanced');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(app.includes('E_STAGE_MATERIAL_NOT_ISSUED'), 'UI maps E_STAGE_MATERIAL_NOT_ISSUED');
ok(app.includes('pso-unissued'), 'output modal shows unissued block');
ok(app.includes('ابطال مرحله و ثبت دوباره (v523)'), 'help updated');
new Function(app);

cleanup();
summary();
