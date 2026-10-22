#!/usr/bin/env node
'use strict';
/**
 * v527 — اتصال سخت‌گیرانهٔ مواد به عملیات (strict routing).
 *
 *  A) قلم بدون عملیات ⇒ فعال‌سازی فرمول رد می‌شود (E_BOM_LINES_UNASSIGNED)؛ نگاشت خودکار
 *     اتصال‌های موجود را نگه می‌دارد و قلمِ مبهم را گزارش می‌کند؛ اتصال صریح → فعال‌سازی OK.
 *  B) سفارش: هر قلم فقط روی مرحلهٔ عملیات خودش؛ خروجی برش به خاطر قلم بسته‌بندی بسته نمی‌شود.
 *  C) اتصال مواد روی فرمول فعال مجاز + ثبت در bom_change_log؛ اقلام/عملیات همچنان قفل؛
 *     فرمول بایگانی‌شده → E_BOM_ASSIGN_LOCKED.
 *  D) نسخهٔ جدید / کپی / ذخیرهٔ اقلام اتصال‌ها را گم نمی‌کنند؛ قلم جدیدِ بی‌عملیات دوباره گیت می‌خورد.
 *  E) سفارش چندفرمولی (PO-0019): هر فرمول با تعداد خودش باز می‌شود؛ برش مشترک فقط اقلام برشِ
 *     هر دو فرمول؛ بند روی مرحلهٔ اختصاصی = ۸۴ (نه ۱۶۸ روی برش)؛ قطع اتصال ⇒ material_gaps.
 *  F) نشانه‌های UI/route.
 */
const fs = require('fs');
const path = require('path');
const { ok, eq, throws, freshDb, summary } = require('./lib/test-harness');
const bom = require('../lib/production/bom');
const advBom = require('../lib/production/bom-advanced');
const asg = require('../lib/production/bom-assignments');
const engine = require('../lib/production/engine');
const adv = require('../lib/production/engine-advanced');
const { assertBomReady } = require('../lib/production/product-completeness');

const { db, cleanup } = freshDb();
const adminId = 1;
const DATE = '1405/08/01';

try {
  function seedProduct(name, avg, type) {
    const id = db.prepare('INSERT INTO products (user_id,name,price,stock) VALUES (1,?,?,0)')
      .run(name, 0).lastInsertRowid;
    db.prepare(`
      UPDATE products SET average_cost_rial=?, item_type=?, is_manufactured=?, std_cost_rial=?, code=?
      WHERE id=?
    `).run(avg, type, type === 'finished' ? 1 : 0, avg, 'V527-' + id, id);
    return id;
  }
  const whRaw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get()?.id;
  const whFg = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get()?.id;
  ok('warehouses exist', !!whRaw && !!whFg);
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_raw_id',?)").run(String(whRaw));
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_fg_id',?)").run(String(whFg));
  function putWh(pid, qty) {
    db.prepare(`
      INSERT INTO warehouse_stock (warehouse_id, product_id, qty) VALUES (?,?,?)
      ON CONFLICT(warehouse_id, product_id) DO UPDATE SET qty=excluded.qty
    `).run(whRaw, pid, qty);
    db.prepare('UPDATE products SET stock=? WHERE id=?').run(qty, pid);
  }
  const ccOf = (code) => db.prepare('SELECT id FROM cost_centers WHERE code=?').get(code)?.id;
  const cc10 = ccOf('CC-10'), cc30 = ccOf('CC-30'), cc60 = ccOf('CC-60');
  ok('stage cost centers CC-10/30/60 exist', cc10 && cc30 && cc60);

  const pFg = seedProduct('هودی v527', 0, 'finished');
  const pLining = seedProduct('لایی v527', 20000, 'raw');
  const pThread = seedProduct('نخ v527', 10000, 'raw');
  const pCord = seedProduct('بند کلاه v527', 30000, 'raw');
  const pZip = seedProduct('زیپ v527', 50000, 'raw');
  for (const p of [pLining, pThread, pCord, pZip]) putWh(p, 10000);

  const opsOf = (bomId) => db.prepare('SELECT * FROM bom_operations WHERE bom_id=? ORDER BY seq, id').all(bomId);
  const linesOf = (bomId) => db.prepare('SELECT * FROM bom_lines WHERE bom_id=? ORDER BY line_no, id').all(bomId);
  const lineFor = (bomId, pid) => linesOf(bomId).find(L => Number(L.component_product_id) === Number(pid));
  const opSeq = (bomId, seq) => opsOf(bomId).find(o => Number(o.seq) === seq);
  const tplLines = (po, st) => (adv.getStageIssueTemplate(db, po.id, st.id).lines || []);
  const hasProd = (lines, pid) => lines.some(L => Number(L.product_id) === Number(pid));
  const qtyOf = (lines, pid) => Number(lines.find(L => Number(L.product_id) === Number(pid))?.qty_standard) || 0;

  // ───────────────────────── A) strict gate on activation ─────────────────────────
  console.log('\nA) strict gate');
  const draft = bom.createBom(db, {
    product_id: pFg, name: 'BOM v527', yield_percent: 100, base_qty: 1, has_routing: 1,
    lines: [
      { component_product_id: pLining, qty_per_base: 1.5, line_type: 'material', stage_cost_center_id: cc10, std_cost_rial: 20000 },
      { component_product_id: pThread, qty_per_base: 2, line_type: 'material', stage_cost_center_id: cc30, std_cost_rial: 10000 },
      { component_product_id: pCord, qty_per_base: 1, line_type: 'material', std_cost_rial: 30000 }, // بدون مرکز هزینه
    ],
  }, adminId);
  const B = draft.id;
  advBom.addOperation(db, B, { seq: 10, cost_center_id: cc10, operation_name: 'برش', labor_method: 'contract', yield_percent: 100, machine_minutes_per_unit: 1, run_minutes_per_unit: 1 }, adminId);
  advBom.addOperation(db, B, { seq: 30, cost_center_id: cc30, operation_name: 'دوخت', labor_method: 'contract', yield_percent: 100, machine_minutes_per_unit: 1, run_minutes_per_unit: 1 }, adminId);
  advBom.addOperation(db, B, { seq: 60, cost_center_id: cc60, operation_name: 'بسته‌بندی', labor_method: 'contract', yield_percent: 100, machine_minutes_per_unit: 1, run_minutes_per_unit: 1 }, adminId);

  let un = asg.unassignedBomLines(db, B);
  eq('one unassigned line (cord)', un.length, 1);
  ok('unassigned is the cord', un[0] && Number(un[0].component_product_id) === pCord);
  ok('message names the cord', /بند کلاه/.test(asg.unassignedLinesMessage(un)));
  throws('activate blocked by unassigned line', () => bom.activateBom(db, B, '1405/01/01', adminId), 'E_BOM_LINES_UNASSIGNED');
  throws('assertBomReady(activate) hard', () => assertBomReady(db, B, 'activate'), 'E_BOM_LINES_UNASSIGNED');
  ok('still draft after failed activate', db.prepare('SELECT status FROM bom_headers WHERE id=?').get(B).status === 'draft');

  const bf = asg.backfillAssignmentsFromStageCc(db, B, adminId);
  eq('backfill assigned 2 (lining→cut, thread→sew)', bf.assigned, 2);
  eq('backfill kept 0', bf.kept, 0);
  eq('backfill: cord ambiguous (no_stage_cc)', bf.ambiguous.length, 1);
  ok('ambiguous reason', bf.ambiguous[0]?.reason === 'no_stage_cc');
  eq('backfill: still 1 unassigned', bf.unassigned.length, 1);
  throws('activate still blocked', () => bom.activateBom(db, B, '1405/01/01', adminId), 'E_BOM_LINES_UNASSIGNED');

  const keep = asg.listAssignments(db, B).map(a => ({ bom_line_id: a.bom_line_id, operation_id: a.operation_id, allocation_mode: a.allocation_mode }));
  asg.replaceAssignments(db, B, [...keep, { bom_line_id: lineFor(B, pCord).id, operation_id: opSeq(B, 60).id, allocation_mode: 'sole' }], adminId);
  eq('no unassigned after explicit link', asg.unassignedBomLines(db, B).length, 0);
  bom.activateBom(db, B, '1405/01/01', adminId);
  ok('activated once every line is linked', db.prepare('SELECT status FROM bom_headers WHERE id=?').get(B).status === 'active');

  // ───────────────────────── B) order: no orphan → first stage ─────────────────────────
  console.log('\nB) order routing');
  const po = engine.createOrder(db, {
    product_id: pFg, bom_id: B, qty_planned: 10, analysis_type: 'variable_adv',
    date: DATE, warehouse_raw_id: whRaw, warehouse_fg_id: whFg, cost_center_id: cc10,
  }, adminId);
  engine.releaseOrder(db, po.id, adminId);
  let [s1, s2, s3] = adv.stageList(db, po.id);
  ok('three stages', s1 && s2 && s3);
  let L1 = tplLines(po, s1), L2 = tplLines(po, s2), L3 = tplLines(po, s3);
  ok('cut: lining only (no cord)', hasProd(L1, pLining) && !hasProd(L1, pCord) && !hasProd(L1, pThread));
  eq('cut lining qty 10×1.5', qtyOf(L1, pLining), 15);
  ok('sew: thread only', hasProd(L2, pThread) && L2.length === 1);
  ok('pack: cord only', hasProd(L3, pCord) && L3.length === 1);
  eq('order material_gaps empty', adv.orderMaterialGaps(db, po).length, 0);
  eq('template bom_gaps empty', (adv.getStageIssueTemplate(db, po.id, s1.id).bom_gaps || []).length, 0);

  if (s1.status === 'pending') adv.startStage(db, po.id, s1.id, adminId);
  s1 = adv.stageList(db, po.id)[0];
  adv.issueStageMaterials(db, { orderId: po.id, stageId: s1.id, userId: adminId, body: { date: DATE, materials: [{ product_id: pLining, qty_actual: 15 }] } });
  eq('cut: nothing unissued (cord is not here)', (adv.getStageIssueTemplate(db, po.id, s1.id).unissued || []).length, 0);
  let outRes = null;
  try {
    outRes = adv.postStageOutputVariable(db, { orderId: po.id, stageId: s1.id, userId: adminId, body: { date: DATE, qty_out: Number(s1.qty_in), waste_normal: 0, waste_abnormal: 0, rework: 0, qc_passed: 1 } });
  } catch (e) { outRes = { error: e.code || e.message }; }
  ok('cut output posts — not blocked by the pack-stage cord', outRes && !outRes.error, outRes && outRes.error);

  // ───────────────────────── C) assignments editable on ACTIVE + audit ─────────────────────────
  console.log('\nC) active BOM assignment edit');
  throws('lines still locked on active (E_BOM_LOCKED)', () => bom.replaceLines(db, B, [{ component_product_id: pLining, qty_per_base: 1 }], adminId), 'E_BOM_LOCKED');
  const before = db.prepare("SELECT COUNT(*) c FROM bom_change_log WHERE bom_id=? AND change_type='assignments_replace'").get(B).c;
  const moved = asg.listAssignments(db, B).map(a => ({
    bom_line_id: a.bom_line_id,
    operation_id: Number(a.bom_line_id) === Number(lineFor(B, pCord).id) ? opSeq(B, 30).id : a.operation_id,
    allocation_mode: 'sole',
  }));
  asg.replaceAssignments(db, B, moved, adminId);
  const after = db.prepare("SELECT COUNT(*) c FROM bom_change_log WHERE bom_id=? AND change_type='assignments_replace'").get(B).c;
  eq('audit row written for active-BOM assignment change', after - before, 1);
  const logRow = db.prepare("SELECT * FROM bom_change_log WHERE bom_id=? AND change_type='assignments_replace' ORDER BY id DESC LIMIT 1").get(B);
  ok('audit has before/after', logRow && /bom_line_id/.test(String(logRow.before_json)) && /bom_line_id/.test(String(logRow.after_json)));
  L2 = tplLines(po, s2); L3 = tplLines(po, s3);
  ok('cord now issues on sew (live order follows the formula)', hasProd(L2, pCord) && hasProd(L2, pThread));
  eq('pack stage now empty', L3.length, 0);
  ok('empty_hint explains linkage', /وصل/.test(String(adv.getStageIssueTemplate(db, po.id, s3.id).empty_hint || '')));
  // archived → frozen
  db.prepare("UPDATE bom_headers SET status='archived' WHERE id=?").run(B);
  throws('archived BOM: assignments frozen', () => asg.replaceAssignments(db, B, moved, adminId), 'E_BOM_ASSIGN_LOCKED');
  db.prepare("UPDATE bom_headers SET status='active' WHERE id=?").run(B);
  // qty/cost untouched by assignment edits
  eq('line qty untouched', Number(lineFor(B, pCord).qty_per_base), 1);

  // ───────────────────────── D) version-up / clone / replaceLines keep links ─────────────────────────
  console.log('\nD) preservation');
  const v2 = bom.versionUpBom(db, B, 'تست v527', adminId);
  eq('version-up copies 3 assignments', asg.listAssignments(db, v2.id).length, 3);
  eq('version-up: no unassigned', asg.unassignedBomLines(db, v2.id).length, 0);
  const cordV2 = asg.listAssignments(db, v2.id).find(a => Number(a.component_product_id) === pCord);
  ok('version-up: cord still → seq 30 (remapped by seq)', cordV2 && Number(cordV2.operation_seq) === 30);
  ok('version-up: assignments point to the new BOM ids', asg.listAssignments(db, v2.id).every(a => Number(a.bom_id) === Number(v2.id)));

  const cl = bom.cloneBom(db, B, { product_id: pFg, name: 'کپی v527' }, adminId);
  eq('clone copies 3 assignments', asg.listAssignments(db, cl.id).length, 3);

  // replaceLines on the draft v2: reorder + qty change must keep links; new orphan component gets flagged
  bom.replaceLines(db, v2.id, [
    { component_product_id: pCord, qty_per_base: 2, line_type: 'material', std_cost_rial: 30000 },
    { component_product_id: pThread, qty_per_base: 2, line_type: 'material', stage_cost_center_id: cc30, std_cost_rial: 10000 },
    { component_product_id: pLining, qty_per_base: 1.5, line_type: 'material', stage_cost_center_id: cc10, std_cost_rial: 20000 },
  ], adminId);
  eq('replaceLines keeps 3 assignments (remapped by component)', asg.listAssignments(db, v2.id).length, 3);
  eq('replaceLines: no unassigned', asg.unassignedBomLines(db, v2.id).length, 0);
  bom.replaceLines(db, v2.id, [
    { component_product_id: pCord, qty_per_base: 1, line_type: 'material', std_cost_rial: 30000 },
    { component_product_id: pLining, qty_per_base: 1.5, line_type: 'material', stage_cost_center_id: cc10, std_cost_rial: 20000 },
    { component_product_id: pZip, qty_per_base: 1, line_type: 'material', std_cost_rial: 50000 }, // جدید، بدون عملیات
  ], adminId);
  un = asg.unassignedBomLines(db, v2.id);
  ok('new orphan component (zipper) flagged', un.length === 1 && Number(un[0].component_product_id) === pZip);
  throws('v2 activate blocked by zipper', () => bom.activateBom(db, v2.id, '1405/01/01', adminId), 'E_BOM_LINES_UNASSIGNED');

  // ───────────────────────── E) peer-BOM order (PO-0019 shape) ─────────────────────────
  console.log('\nE) peer-BOM order');
  const pHood = seedProduct('هودی سِت v527', 0, 'finished');
  const pPants = seedProduct('شلوار سِت v527', 0, 'finished');
  const pElastic = seedProduct('کش ۴ سانت v527', 15000, 'raw');
  const pCord2 = seedProduct('بند شلوار v527', 25000, 'raw');
  for (const p of [pElastic, pCord2]) putWh(p, 10000);
  function routedBom(productId, name, lines, seqs) {
    const d = bom.createBom(db, { product_id: productId, name, yield_percent: 100, base_qty: 1, has_routing: 1, lines }, adminId);
    for (const s of seqs) {
      advBom.addOperation(db, d.id, { seq: s.seq, cost_center_id: s.cc, operation_name: s.name, labor_method: 'contract', yield_percent: 100, machine_minutes_per_unit: 1, run_minutes_per_unit: 1 }, adminId);
    }
    return d.id;
  }
  const bomH = routedBom(pHood, 'هودی', [
    { component_product_id: pLining, qty_per_base: 1.5, line_type: 'material', stage_cost_center_id: cc10, std_cost_rial: 20000 },
    { component_product_id: pCord, qty_per_base: 1, line_type: 'material', std_cost_rial: 30000 },
  ], [{ seq: 10, cc: cc10, name: 'برش' }, { seq: 60, cc: cc60, name: 'بسته‌بندی' }]);
  const bomP = routedBom(pPants, 'شلوار', [
    { component_product_id: pLining, qty_per_base: 2, line_type: 'material', stage_cost_center_id: cc10, std_cost_rial: 20000 },
    { component_product_id: pElastic, qty_per_base: 1, line_type: 'material', stage_cost_center_id: cc30, std_cost_rial: 15000 },
    { component_product_id: pCord2, qty_per_base: 1, line_type: 'material', std_cost_rial: 25000 },
  ], [{ seq: 10, cc: cc10, name: 'برش' }, { seq: 30, cc: cc30, name: 'دوخت' }, { seq: 60, cc: cc60, name: 'بسته‌بندی' }]);
  throws('hood BOM blocked (cord unlinked)', () => bom.activateBom(db, bomH, '1405/01/01', adminId), 'E_BOM_LINES_UNASSIGNED');
  asg.replaceAssignments(db, bomH, [
    { bom_line_id: lineFor(bomH, pLining).id, operation_id: opSeq(bomH, 10).id, allocation_mode: 'sole' },
    { bom_line_id: lineFor(bomH, pCord).id, operation_id: opSeq(bomH, 60).id, allocation_mode: 'sole' },
  ], adminId);
  asg.replaceAssignments(db, bomP, [
    { bom_line_id: lineFor(bomP, pLining).id, operation_id: opSeq(bomP, 10).id, allocation_mode: 'sole' },
    { bom_line_id: lineFor(bomP, pElastic).id, operation_id: opSeq(bomP, 30).id, allocation_mode: 'sole' },
    { bom_line_id: lineFor(bomP, pCord2).id, operation_id: opSeq(bomP, 60).id, allocation_mode: 'sole' },
  ], adminId);
  bom.activateBom(db, bomH, '1405/01/01', adminId);
  bom.activateBom(db, bomP, '1405/01/01', adminId);

  const peer = engine.createOrder(db, {
    product_id: pHood, bom_id: bomH, qty_planned: 84, date: DATE, analysis_type: 'fixed',
    warehouse_raw_id: whRaw, warehouse_fg_id: whFg, cost_center_id: cc10,
    order_products: [{ product_id: pPants, bom_id: bomP, qty: 84 }],
  }, adminId);
  engine.releaseOrder(db, peer.id, adminId);
  const peerPo = engine.getOrderDetail(db, peer.id);
  const pst = adv.stageList(db, peer.id);
  const shared = pst.filter(s => String(s.product_scope || 'shared') === 'shared');
  const excl = pst.filter(s => s.product_scope === 'exclusive');
  eq('one shared cut stage', shared.length, 1);
  eq('three exclusive stages (pack-H, sew-P, pack-P)', excl.length, 3);
  const pieces = adv.orderMaterialPieces(db, peerPo);
  eq('two material pieces (one per formula)', pieces.length, 2);
  ok('each piece explodes its own formula', pieces.every(p => p.lines.every(L => Number(L.bom_id) === Number(p.bom_id))));
  const cutL = tplLines(peerPo, shared[0]);
  ok('shared cut: no cord/elastic', !hasProd(cutL, pCord) && !hasProd(cutL, pCord2) && !hasProd(cutL, pElastic));
  eq('shared cut: lining merged 84×1.5 + 84×2', qtyOf(cutL, pLining), 84 * 1.5 + 84 * 2);
  const packH = excl.find(s => Number(s.scoped_product_id) === pHood && Number(s.cost_center_id) === Number(cc60));
  const sewP = excl.find(s => Number(s.scoped_product_id) === pPants && Number(s.cost_center_id) === Number(cc30));
  const packP = excl.find(s => Number(s.scoped_product_id) === pPants && Number(s.cost_center_id) === Number(cc60));
  ok('exclusive stages resolved', packH && sewP && packP);
  const packHL = tplLines(peerPo, packH);
  eq('pack-H: hood cord = 84 (not 168)', qtyOf(packHL, pCord), 84);
  ok('pack-H: no pants cord', !hasProd(packHL, pCord2));
  eq('sew-P: elastic = 84', qtyOf(tplLines(peerPo, sewP), pElastic), 84);
  const packPL = tplLines(peerPo, packP);
  eq('pack-P: pants cord = 84', qtyOf(packPL, pCord2), 84);
  ok('pack-P: no hood cord', !hasProd(packPL, pCord));
  eq('peer order: no gaps', adv.orderMaterialGaps(db, peerPo).length, 0);
  // unlink hood cord on the ACTIVE formula → gap reported, and it still lands on no stage
  asg.replaceAssignments(db, bomH, [
    { bom_line_id: lineFor(bomH, pLining).id, operation_id: opSeq(bomH, 10).id, allocation_mode: 'sole' },
  ], adminId);
  const gaps = adv.orderMaterialGaps(db, peerPo);
  ok('material_gaps lists the hood cord with its formula', gaps.length === 1 && Number(gaps[0].component_product_id) === pCord && Number(gaps[0].bom_id) === Number(bomH));
  ok('unlinked cord does NOT fall back to the shared cut', !hasProd(tplLines(peerPo, shared[0]), pCord));
  eq('unlinked cord gone from pack-H', tplLines(peerPo, packH).length, 0);
  const tplGap = adv.getStageIssueTemplate(db, peer.id, shared[0].id);
  ok('issue template bom_gaps carries the cord', (tplGap.bom_gaps || []).some(g => Number(g.component_product_id) === pCord));
  throws('issue-like readiness blocked while a line is unlinked', () => require('../lib/production/product-completeness').assertOrderReady(db, peer.id, 'issue'), 'E_BOM_LINES_UNASSIGNED');

  // ───────────────────────── F) static markers ─────────────────────────
  console.log('\nF) static');
  const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  ok('UI maps the new error codes', appJs.includes('E_BOM_LINES_UNASSIGNED') && appJs.includes('E_BOM_ASSIGN_LOCKED'));
  ok('UI renders material_gaps / bom_gaps', appJs.includes('material_gaps') && appJs.includes('bom_gaps'));
  ok('Help documents v527', /v527/.test(appJs) && /اتصال سخت‌گیرانهٔ مواد به عملیات/.test(appJs));
  const routeExec = fs.readFileSync(path.join(__dirname, '../routes/production-execution.js'), 'utf8');
  ok('stages route returns material_gaps', routeExec.includes('material_gaps'));
  const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  ok('SW v527+', /erp-taranom-v52[7-9]|erp-taranom-v5[3-9]\d/.test(sw));
} finally {
  cleanup();
}
summary('bom-strict-assignment-v527');
