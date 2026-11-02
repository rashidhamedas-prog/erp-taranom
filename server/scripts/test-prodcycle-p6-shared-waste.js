'use strict';
/**
 * P6 — ضایعات غیرعادی برش مشترک همیشه بستانکار WIP (1111):
 *   PRD-01: Dr1111 / Cr1110 = کل پارچه (خالص + اتلاف)
 *   PRD-09: Dr5221 / Cr1111 = اتلاف (طولی + سهم غیرعادی پهن)
 *   خالص 1111 = common ؛ تخصیص = common ؛ ابطال → همه صفر.
 * Run: node server/scripts/test-prodcycle-p6-shared-waste.js
 */
const { ok, eq, freshDb, summary } = require('./lib/test-harness');

console.log('\n══ P6 shared-cut abnormal waste → Cr WIP ══\n');

let ctx;
try {
  ctx = freshDb();
} catch (e) {
  if (/bindings|better_sqlite3|NODE_MODULE_VERSION/i.test(String(e.message) + (e.tries || ''))) {
    console.log('  SKIP مسیر دیتابیس: better-sqlite3 روی این Node لود نشد');
    summary('prodcycle-p6-shared-waste');
  }
  throw e;
}
const { db, cleanup } = ctx;
const DATE = '1405/07/27';

function gl(code) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(jl.debit),0) d, COALESCE(SUM(jl.credit),0) c
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0
  `).get(code);
  return { d: Math.round(Number(r.d) * 10), c: Math.round(Number(r.c) * 10) };
}
function snap() {
  return { raw: gl('1110'), wip: gl('1111'), waste: gl('5221') };
}
function delta(a, b) {
  const f = (k) => ({ d: b[k].d - a[k].d, c: b[k].c - a[k].c });
  return { raw: f('raw'), wip: f('wip'), waste: f('waste') };
}
function jeLines(jeId) {
  return db.prepare('SELECT account_code, debit, credit FROM journal_lines WHERE entry_id=?').all(jeId)
    .map((l) => ({ code: l.account_code, d: Math.round(Number(l.debit) * 10), c: Math.round(Number(l.credit) * 10) }));
}
function invNetOut(layId, batchId) {
  const out = db.prepare(`
    SELECT COALESCE(SUM(amount_rial),0) s FROM inventory_ledger
    WHERE source_type='cutting_lay' AND source_id=? AND COALESCE(qty_out,0)>0 AND COALESCE(status,'posted')='posted'
  `).get(layId).s;
  const back = db.prepare(`
    SELECT COALESCE(SUM(amount_rial),0) s FROM inventory_ledger
    WHERE source_type='cutting_remnant' AND source_id=? AND COALESCE(status,'posted')='posted'
  `).get(batchId).s;
  return Math.round(Number(out) - Number(back));
}

try {
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get() || { id: 1 };
  const whRaw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get().id;
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_raw_id',?)").run(String(whRaw));
  db.prepare("INSERT INTO settings (key,value) VALUES ('production_shared_cut','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  db.prepare("INSERT INTO settings (key,value) VALUES ('production_normal_waste_default_pct','3') ON CONFLICT(key) DO UPDATE SET value='3'").run();
  for (const [code, name, kind] of [['WH-WIP', 'انبار کار در جریان', 'wip'], ['WH-SCRAP', 'ضایعات', 'scrap']]) {
    if (!db.prepare('SELECT id FROM warehouses WHERE code=?').get(code)) {
      db.prepare('INSERT INTO warehouses (code,name,kind,warehouse_type,active) VALUES (?,?,?,?,1)').run(code, name, kind, kind);
    }
  }
  const shared = require('../lib/production/shared-cut');
  const OCR = require('../lib/production/order-cost-reconcile');

  const fab = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, average_cost_rial, cost, item_type)
    VALUES (?, 'پارچه P6', 'FAB-P6', 0, 100000, 'متر', 1000, 1000, 'raw')
  `).run(admin.id).lastInsertRowid;
  db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,100000)').run(fab, whRaw);
  const a = db.prepare(`INSERT INTO products (user_id, name, code, unit, item_type, is_manufactured) VALUES (?,'A-P6','FG-AP6','عدد','finished',1)`).run(admin.id).lastInsertRowid;
  const b = db.prepare(`INSERT INTO products (user_id, name, code, unit, item_type, is_manufactured) VALUES (?,'B-P6','FG-BP6','عدد','finished',1)`).run(admin.id).lastInsertRowid;
  const poId = db.prepare(`
    INSERT INTO production_orders (order_no, product_id, qty_planned, date, status, analysis_type)
    VALUES ('PO-P6', ?, 48, ?, 'released', 'fixed')
  `).run(a, DATE).lastInsertRowid;
  const marker = 5.9;
  const openings = [90, 90, 90, 120];
  const plies = [11, 11, 11, 15];
  const ids = openings.map((m, i) => db.prepare(`
    INSERT INTO inventory_batches (batch_no, product_id, warehouse_id, qty_on_hand, qty_received, status, kind, unit, unit_cost_rial)
    VALUES (?,?,?,?,?,'active','fabric','متر', 1000)
  `).run('RP6-' + i, fab, whRaw, m, m).lastInsertRowid);
  const mkBody = (loss, actual) => ({
    marker_length_m: marker,
    fabric_product_id: fab,
    warehouse_id: whRaw,
    width_cm: 150,
    date: DATE,
    idempotency_key: 'p6-shared-1',
    production_order_id: poId,
    actual_meters: actual,
    outputs: [
      { product_id: a, size_code: 'ALL', pieces_per_ply: 1, weight: 40, fabric_std_m: 2 },
      { product_id: b, size_code: 'ALL', pieces_per_ply: 2, weight: 60, fabric_std_m: 2 },
    ],
    rolls: openings.map((opening, i) => ({
      batch_id: ids[i], opening_m: opening, ply_count: plies[i], length_loss_m: i === 0 ? loss : 0,
    })),
  });

  // ── ۱) ثبت: اتلاف طولی + سهم غیرعادی پهن ────────────────────────────
  const s0 = snap();
  const body1 = mkBody(1.5, 310);
  const pv = shared.previewSharedCut(db, body1);
  ok('پیش‌نمایش: سهم غیرعادی پهن دارد', Number(pv.laid_abnormal_m) > 0, pv.laid_abnormal_m);
  const posted = shared.postSharedCut(db, { ...body1, override_balance: true }, { id: admin.id });
  ok('ثبت شد', posted.status === 'posted', posted.status);
  const lay = db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(posted.lay_id);
  const common = Number(posted.common_rial);
  const waste = Number(lay.waste_amount_rial);
  ok('اتلاف = طولی (۱٫۵م×۱۰۰۰) + سهم غیرعادی', waste > 1500, waste);
  eq('amount لایه = کل', lay.amount_rial, common + waste);
  const d1 = delta(s0, snap());
  eq('Cr1110 = کل پارچه', d1.raw.c - d1.raw.d, common + waste, 1);
  eq('Dr5221 = اتلاف', d1.waste.d - d1.waste.c, waste, 1);
  eq('Dr1111 = کل پارچه', d1.wip.d, common + waste, 1);
  eq('Cr1111 = اتلاف', d1.wip.c, waste, 1);
  eq('خالص 1111 = common', d1.wip.d - d1.wip.c, common, 1);
  const prd01 = jeLines(lay.journal_id);
  ok('PRD-01 فقط 1111/1110', prd01.every((l) => ['1111', '1110'].includes(l.code)), JSON.stringify(prd01));
  const prd09 = jeLines(lay.waste_journal_id);
  ok('PRD-09: Dr5221', prd09.some((l) => l.code === '5221' && l.d > 0), JSON.stringify(prd09));
  ok('PRD-09: Cr1111 (نه 1110)', prd09.some((l) => l.code === '1111' && l.c > 0) && !prd09.some((l) => l.code === '1110'), JSON.stringify(prd09));
  const alloc = posted.allocations.reduce((s, r) => s + Number(r.amount_rial), 0);
  eq('جمع تخصیص = common (خالص WIP)', alloc, common);
  eq('خروج موجودی پارچه = کل (بدون تغییر)', invNetOut(posted.lay_id, posted.id), common + waste, 2);
  eq('اتلاف مؤثر WIP شامل لایهٔ مشترک P6', OCR.classicLayWasteRial(db, poId), waste);
  eq('اتلاف مشترک قدیمی صفر', OCR.sharedLayWasteRial(db, poId), 0);
  const mi = db.prepare(`SELECT COALESCE(SUM(amount_rial),0) s FROM production_material_issues WHERE order_id=? AND status='posted'`).get(poId).s;
  ok('سفارش ساده: بدون ردیف مرحله', Number(mi) === 0 || Number(mi) === common + waste, mi);

  // ── ۲) ویرایش: اتلاف و متر تغییر می‌کند ───────────────────────────────
  const body2 = { ...mkBody(3, 305), idempotency_key: 'p6-shared-1-amend', override_balance: true, reason: 'آزمون P6' };
  const amended = shared.amendSharedCut(db, posted.id, body2, { id: admin.id });
  ok('ویرایش ثبت شد', amended.status === 'posted', amended.status);
  const lay2 = db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(posted.lay_id);
  const common2 = Number(amended.common_rial);
  const waste2 = Number(lay2.waste_amount_rial);
  ok('اتلاف تغییر کرد', waste2 !== waste, `${waste} → ${waste2}`);
  const d2 = delta(s0, snap());
  eq('بعد از ویرایش: Cr1110 خالص = کل جدید', d2.raw.c - d2.raw.d, common2 + waste2, 1);
  eq('بعد از ویرایش: 5221 = اتلاف جدید', d2.waste.d - d2.waste.c, waste2, 1);
  eq('بعد از ویرایش: خالص 1111 = common جدید', d2.wip.d - d2.wip.c, common2, 1);
  const prd09b = jeLines(lay2.waste_journal_id);
  ok('ویرایش: PRD-09 بستانکار 1111', prd09b.some((l) => l.code === '1111' && l.c > 0) && !prd09b.some((l) => l.code === '1110'));
  const alloc2 = amended.allocations.reduce((s, r) => s + Number(r.amount_rial), 0);
  eq('ویرایش: جمع تخصیص = common', alloc2, common2);
  eq('ویرایش: خروج موجودی = کل جدید', invNetOut(posted.lay_id, posted.id), common2 + waste2, 2);
  eq('ویرایش: اتلاف مؤثر WIP', OCR.classicLayWasteRial(db, poId), waste2);

  // ── ۳) ابطال: همه صفر ──────────────────────────────────────────────
  const voided = shared.voidSharedCut(db, posted.id, { id: admin.id }, 'آزمون P6');
  ok('ابطال', voided.status === 'reversed', voided.status);
  const d3 = delta(s0, snap());
  eq('ابطال: 1110 صفر', d3.raw.d - d3.raw.c, 0, 1);
  eq('ابطال: 1111 صفر', d3.wip.d - d3.wip.c, 0, 1);
  eq('ابطال: 5221 صفر', d3.waste.d - d3.waste.c, 0, 1);
  openings.forEach((m, i) => {
    eq(`ابطال: مانده طاقه ${i}`, Number(db.prepare('SELECT qty_on_hand q FROM inventory_batches WHERE id=?').get(ids[i]).q), m, 0.02);
  });
  eq('ابطال: اتلاف مؤثر WIP صفر', OCR.classicLayWasteRial(db, poId), 0);

  // ── ۴) سند قدیمی (بستانکار مواد) همچنان «مشترک قدیمی» شمرده می‌شود ─────
  const legacyLay = db.prepare(`
    INSERT INTO cutting_lays (lay_no, product_id, marker_length_m, ply_count, date, status, waste_amount_rial, production_order_id, amount_rial, batch_id)
    VALUES ('LAY-LEGACY', ?, 1, 1, ?, 'posted', 7000, ?, 50000, ?)
  `).run(a, DATE, poId, posted.id).lastInsertRowid;
  const legacyJe = db.prepare(`
    INSERT INTO journal_entries (entry_date, description, ref_type, ref_id) VALUES (?, 'legacy', 'production_waste', ?)
  `).run(DATE, legacyLay).lastInsertRowid;
  db.prepare(`INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit) VALUES (?, '5221', 'w', 700, 0)`).run(legacyJe);
  db.prepare(`INSERT INTO journal_lines (entry_id, account_code, account_name, debit, credit) VALUES (?, '1110', 'm', 0, 700)`).run(legacyJe);
  db.prepare('UPDATE cutting_lays SET waste_journal_id=? WHERE id=?').run(legacyJe, legacyLay);
  eq('قدیمی: اتلاف مشترک قدیمی', OCR.sharedLayWasteRial(db, poId), 7000);
  eq('قدیمی: در WIP شمرده نمی‌شود', OCR.classicLayWasteRial(db, poId), 0);

  // ── ۵) سفارش پیشرفته: مرحلهٔ برش و ستون‌های سفارش با WIP یکی است ─────
  const bom = require('../lib/production/bom');
  const advBom = require('../lib/production/bom-advanced');
  const engine = require('../lib/production/engine');
  const adv = require('../lib/production/engine-advanced');
  const whFg = (db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get() || {}).id;
  const ccCut = (db.prepare("SELECT id FROM cost_centers WHERE code='CC-10'").get() || {}).id
    || db.prepare('SELECT id FROM cost_centers WHERE COALESCE(is_stage,0)=1 LIMIT 1').get().id;
  const ccSew = (db.prepare("SELECT id FROM cost_centers WHERE code='CC-40'").get() || {}).id || ccCut;
  const draft = bom.createBom(db, {
    product_id: a, name: 'BOM P6', yield_percent: 100, base_qty: 1, has_routing: 1,
    lines: [{
      component_product_id: fab, qty_per_base: 2, scrap_percent: 0,
      line_type: 'material', stage_cost_center_id: ccCut, std_cost_rial: 1000,
    }],
  }, admin.id);
  advBom.addOperation(db, draft.id, {
    seq: 10, cost_center_id: ccCut, operation_name: 'برش', labor_method: 'contract', yield_percent: 100,
  }, admin.id);
  advBom.addOperation(db, draft.id, {
    seq: 20, cost_center_id: ccSew, operation_name: 'دوخت', labor_method: 'contract', yield_percent: 100,
  }, admin.id);
  bom.activateBom(db, draft.id, '1405/01/01', admin.id);
  const advPo = engine.createOrder(db, {
    product_id: a, bom_id: draft.id, qty_planned: 500, analysis_type: 'fixed_adv', date: DATE,
    warehouse_raw_id: whRaw, warehouse_fg_id: whFg, cost_center_id: ccCut,
  }, admin.id);
  engine.releaseOrder(db, advPo.id, admin.id);
  const ids2 = openings.map((m, i) => db.prepare(`
    INSERT INTO inventory_batches (batch_no, product_id, warehouse_id, qty_on_hand, qty_received, status, kind, unit, unit_cost_rial)
    VALUES (?,?,?,?,?,'active','fabric','متر', 1000)
  `).run('RP6B-' + i, fab, whRaw, m, m).lastInsertRowid);
  const advBody = {
    ...mkBody(1.5, 310),
    idempotency_key: 'p6-shared-adv',
    production_order_id: advPo.id,
    override_balance: true,
    rolls: openings.map((opening, i) => ({
      batch_id: ids2[i], opening_m: opening, ply_count: plies[i], length_loss_m: i === 0 ? 1.5 : 0,
    })),
  };
  const advPosted = shared.postSharedCut(db, advBody, { id: admin.id });
  const advLay = db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(advPosted.lay_id);
  const advCommon = Number(advPosted.common_rial);
  const advWaste = Number(advLay.waste_amount_rial);
  ok('پیشرفته: لایه به مرحله وصل شد', Number(advLay.stage_id) > 0, JSON.stringify(advPosted.stage_bind || null));
  const cutStage = db.prepare('SELECT * FROM production_order_stages WHERE id=?').get(advLay.stage_id);
  eq('پیشرفته: مواد مرحله = کل پارچه', cutStage.material_added_rial, advCommon + advWaste);
  const pv5 = OCR.previewOrderCostReconcile(db, advPo.id);
  eq('پیشرفته: مواد سفارش = کل پارچه', pv5.documents.material_cost_rial, advCommon + advWaste);
  eq('پیشرفته: ضایعات مؤثر WIP = اتلاف', pv5.wip_abnormal_waste_rial, advWaste);
  eq('پیشرفته: اتلاف مشترک قدیمی صفر', pv5.shared_lay_waste_rial, 0);
  eq('پیشرفته: رسید مورد انتظار = خالص WIP', pv5.expected_receipts_rial, advCommon);
  ok('پیشرفته: ستون‌ها با اسناد یکی', pv5.aligned, JSON.stringify({ before: pv5.before, docs: pv5.documents }));
  shared.voidSharedCut(db, advPosted.id, { id: admin.id }, 'آزمون P6 پیشرفته');
  const cutStage2 = db.prepare('SELECT * FROM production_order_stages WHERE id=?').get(cutStage.id);
  eq('پیشرفته ابطال: مواد مرحله صفر', cutStage2.material_added_rial, 0);
  const pv6 = OCR.previewOrderCostReconcile(db, advPo.id);
  eq('پیشرفته ابطال: مواد سفارش صفر', pv6.documents.material_cost_rial, 0);
  eq('پیشرفته ابطال: ضایعات صفر', pv6.documents.abnormal_waste_rial, 0);
  ok('پیشرفته ابطال: ستون‌ها یکی', pv6.aligned, JSON.stringify(pv6.before));
} catch (e) {
  ok('مسیر دیتابیس', false, e.stack || e.message);
} finally {
  cleanup();
}

summary('prodcycle-p6-shared-waste');
