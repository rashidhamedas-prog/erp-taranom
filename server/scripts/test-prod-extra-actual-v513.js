'use strict';
/**
 * v513 — measured meters on shared lays + stage over-consumption (مصرف اضافهٔ مرحله).
 * Run: node server/scripts/test-prod-extra-actual-v513.js
 */
const fs = require('fs');
const path = require('path');
const { ok, eq, throws, freshDb, summary } = require('./lib/test-harness');

console.log('\n══ v513 actual meters + stage extra ══\n');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok('UI never falls back to planned meters', app.includes('cuttingMeasuredActual') && app.includes('cl-roll-laid'));
ok('UI stage extra modal', app.includes('prodStageExtraModal') && app.includes('prodStageExtraVoid'));
ok('help documents v513', app.includes('v513 متر واقعی لایه‌چینی'));
ok('analysis select is not disabled', !/sel\.disabled\s*=\s*true/.test(
  app.slice(app.indexOf('function prodOrderSyncAnalysisLock'), app.indexOf('function prodOrderSyncAnalysisLock') + 3000)
));
new Function(app);

let ctx;
try {
  ctx = freshDb();
} catch (e) {
  if (/bindings|better_sqlite3|NODE_MODULE_VERSION/i.test(String(e.message) + (e.tries || ''))) {
    console.log('  SKIP مسیر دیتابیس: better-sqlite3 روی این Node لود نشد');
    summary('extra-actual-v513');
  }
  throw e;
}
const { db, cleanup } = ctx;
const DATE = '1405/07/27';

function abnormalDebit(refType, refId) {
  return Number(db.prepare(`
    SELECT COALESCE(SUM(jl.debit),0) d FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.account_code='5221' AND je.ref_type=? AND je.ref_id=? AND COALESCE(je.deleted_at,0)=0
  `).get(refType, refId).d) || 0;
}

try {
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get() || { id: 1 };
  const whRaw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get().id;
  const whFg = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get()?.id;
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_raw_id',?)").run(String(whRaw));
  if (whFg) db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_wh_fg_id',?)").run(String(whFg));

  // ── ۱) برش مشترک: متر واقعی سربرگ، ماتریس و ضایعات ─────────────────────
  const shared = require('../lib/production/shared-cut');
  db.prepare("INSERT INTO settings (key,value) VALUES ('production_shared_cut','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  db.prepare("INSERT INTO settings (key,value) VALUES ('production_normal_waste_default_pct','3') ON CONFLICT(key) DO UPDATE SET value='3'").run();
  if (!db.prepare("SELECT id FROM warehouses WHERE code='WH-WIP'").get()) {
    db.prepare("INSERT INTO warehouses (code,name,kind,warehouse_type,active) VALUES ('WH-WIP','انبار کار در جریان','wip','wip',1)").run();
  }
  const fab = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, average_cost_rial, cost, item_type)
    VALUES (?, 'پارچه v513', 'FAB-511', 0, 100000, 'متر', 1000, 1000, 'raw')
  `).run(admin.id).lastInsertRowid;
  require('../lib/inventory/ledger').postInventoryMovement(db, {
    eventType: 'opening', productId: fab, warehouseId: whRaw, qtyIn: 100000, unitCostRial: 1000,
    sourceType: 'test_fixture', note: 'fixture opening', updateAvg: false,
  });
  const a = db.prepare(`INSERT INTO products (user_id, name, code, unit, item_type, is_manufactured) VALUES (?,'A511','FG-A511','عدد','finished',1)`).run(admin.id).lastInsertRowid;
  const b = db.prepare(`INSERT INTO products (user_id, name, code, unit, item_type, is_manufactured) VALUES (?,'B511','FG-B511','عدد','finished',1)`).run(admin.id).lastInsertRowid;
  const poShared = db.prepare(`
    INSERT INTO production_orders (order_no, product_id, qty_planned, date, status, analysis_type)
    VALUES ('PO-511-SH', ?, 48, ?, 'released', 'fixed')
  `).run(a, DATE).lastInsertRowid;
  const marker = 5.9;
  const openings = [90, 90, 90, 120];
  const plies = [11, 11, 11, 15];
  const ids = openings.map((m, i) => db.prepare(`
    INSERT INTO inventory_batches (batch_no, product_id, warehouse_id, qty_on_hand, qty_received, status, kind, unit, unit_cost_rial)
    VALUES (?,?,?,?,?,'active','fabric','متر', 1000)
  `).run('R511-' + i, fab, whRaw, m, m).lastInsertRowid);
  const body = {
    marker_length_m: marker,
    fabric_product_id: fab,
    warehouse_id: whRaw,
    width_cm: 150,
    date: DATE,
    idempotency_key: 'v513-shared-1',
    production_order_id: poShared,
    actual_meters: 310,
    outputs: [
      { product_id: a, size_code: 'ALL', pieces_per_ply: 1, weight: 40, fabric_std_m: 2 },
      { product_id: b, size_code: 'ALL', pieces_per_ply: 2, weight: 60, fabric_std_m: 2 },
    ],
    rolls: openings.map((opening, i) => ({ batch_id: ids[i], opening_m: opening, ply_count: plies[i] })),
  };
  const pv = shared.previewSharedCut(db, body);
  ok('پیش‌نمایش: منبع متر واقعی = سربرگ', pv.actual_source === 'header', pv.actual_source);
  eq('پیش‌نمایش: استاندارد مارکر×لایه', pv.planned_meters, 283.2, 0.01);
  eq('پیش‌نمایش: متر واقعی تبدیل به استاندارد نمی‌شود', pv.actual_meters, 310, 0.01);
  eq('پیش‌نمایش: ماتریس BOM', pv.matrix_meters, 288, 0.01);
  eq('ضایعات عادی = سقف ۳٪ واقعی', pv.waste_normal_m, 9.3, 0.01);
  eq('ضایعات غیرعادی پهن', pv.waste_abnormal_m, 12.7, 0.01);
  eq('انحراف پارچه', pv.fabric_variance_m, 22, 0.01);

  const posted = shared.postSharedCut(db, body, { id: admin.id });
  ok('برش مشترک ثبت شد', posted.status === 'posted', posted.status);
  const lay = db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(posted.lay_id);
  eq('لایه: planned', lay.planned_meters, 283.2, 0.01);
  eq('لایه: actual ذخیره = متر واقعی', lay.actual_meters, 310, 0.01);
  eq('لایه: matrix', lay.matrix_meters, 288, 0.01);
  eq('لایه: waste_abnormal_m', lay.waste_abnormal_m, 12.7, 0.01);
  const laidRows = db.prepare(`
    SELECT COALESCE(SUM(laid_m),0) s FROM cutting_lay_rolls WHERE lay_id=?
  `).get(posted.lay_id);
  if (laidRows) eq('جمع پهن طاقه‌ها = متر واقعی', laidRows.s, 310, 0.02);
  const abRial = Math.round(310 * 1000 * 12.7 / 310);
  eq('بهای مشترک WIP بدون سهم غیرعادی', posted.common_rial, 310 * 1000 - abRial, 2);
  ok('سهم غیرعادی به ۵۲۲۱ رفت',
    abnormalDebit('production_waste', posted.lay_id) + abnormalDebit('production_material_issue', posted.lay_id) > 0
    || Number(db.prepare("SELECT COALESCE(SUM(debit),0) d FROM journal_lines WHERE account_code='5221'").get().d) * 10 >= abRial - 2);

  throws('متر واقعی نامعتبر رد می‌شود', () => shared.previewSharedCut(db, { ...body, idempotency_key: 'v513-bad', actual_meters: -5 }), 'E_CUT_ACTUAL');

  // ── ۲) مصرف اضافهٔ مرحله (زیپ خراب) ────────────────────────────────────
  const bom = require('../lib/production/bom');
  const advBom = require('../lib/production/bom-advanced');
  const engine = require('../lib/production/engine');
  const adv = require('../lib/production/engine-advanced');

  function seed(name, avg, stock, type) {
    const id = db.prepare('INSERT INTO products (user_id,name,price,stock) VALUES (1,?,?,?)').run(name, 0, stock).lastInsertRowid;
    db.prepare(`
      UPDATE products SET average_cost_rial=?, item_type=?, is_manufactured=?, std_cost_rial=?, code=? WHERE id=?
    `).run(avg, type, type === 'finished' ? 1 : 0, avg, 'X511-' + id, id);
    if (stock) {
      require('../lib/inventory/ledger').postInventoryMovement(db, {
        eventType: 'opening', productId: id, warehouseId: whRaw, qtyIn: stock, unitCostRial: avg || 1,
        sourceType: 'test_fixture', note: 'fixture opening', updateAvg: false,
      });
    }
    return id;
  }
  const whQty = (pid) => Number(db.prepare('SELECT qty FROM warehouse_stock WHERE warehouse_id=? AND product_id=?').get(whRaw, pid)?.qty) || 0;

  const pFg = seed('مانتو v513', 0, 0, 'finished');
  const pZip = seed('زیپ v513', 50000, 100, 'raw');
  const pBtn = seed('دکمه خارج فرمول', 1000, 50, 'raw');
  const ccId = db.prepare("SELECT id FROM cost_centers WHERE code='CC-40'").get()?.id
    || db.prepare('SELECT id FROM cost_centers WHERE COALESCE(is_stage,0)=1 LIMIT 1').get()?.id;
  ok('مرکز هزینهٔ مرحله', !!ccId);
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('production_material_extra_normal_pct','10')").run();

  const draft = bom.createBom(db, {
    product_id: pFg, name: 'BOM v513', yield_percent: 100, base_qty: 1, has_routing: 1,
    lines: [{
      component_product_id: pZip, qty_per_base: 1, scrap_percent: 0,
      line_type: 'material', stage_cost_center_id: ccId, std_cost_rial: 50000,
    }],
  }, admin.id);
  advBom.addOperation(db, draft.id, {
    seq: 10, cost_center_id: ccId, operation_name: 'دوخت', labor_method: 'contract', yield_percent: 100,
  }, admin.id);
  bom.activateBom(db, draft.id, '1405/01/01', admin.id);
  const po = engine.createOrder(db, {
    product_id: pFg, bom_id: draft.id, qty_planned: 10, analysis_type: 'fixed_adv', date: DATE,
    warehouse_raw_id: whRaw, warehouse_fg_id: whFg, cost_center_id: ccId,
  }, admin.id);
  engine.releaseOrder(db, po.id, admin.id);
  let stage = adv.stageList(db, po.id)[0];
  if (stage.status !== 'in_progress' && typeof adv.startStage === 'function') {
    adv.startStage(db, po.id, stage.id, admin.id);
    stage = adv.stageList(db, po.id)[0];
  }
  ok('مرحلهٔ دوخت در جریان', stage.status === 'in_progress', stage.status);

  throws('بدون دلیل رد می‌شود', () => adv.issueStageExtraMaterials(db, {
    orderId: po.id, stageId: stage.id, userId: admin.id,
    body: { date: DATE, lines: [{ product_id: pZip, qty: 2 }] },
  }), 'E_EXTRA_REASON');
  throws('«سایر» بدون توضیح رد می‌شود', () => adv.issueStageExtraMaterials(db, {
    orderId: po.id, stageId: stage.id, userId: admin.id,
    body: { date: DATE, lines: [{ product_id: pZip, qty: 2, reason_code: 'other' }] },
  }), 'E_EXTRA_REASON');
  throws('قلم خارج فرمول مرحله رد می‌شود', () => adv.issueStageExtraMaterials(db, {
    orderId: po.id, stageId: stage.id, userId: admin.id,
    body: { date: DATE, lines: [{ product_id: pBtn, qty: 2, reason_code: 'material_defect' }] },
  }), 'E_STAGE_MATERIAL_OWNER');
  eq('رد شده‌ها موجودی را تکان نمی‌دهند', whQty(pZip), 100);

  const r1 = adv.issueStageExtraMaterials(db, {
    orderId: po.id, stageId: stage.id, userId: admin.id,
    body: { date: DATE, lines: [{ product_id: pZip, qty: 3, reason_code: 'bom_understated' }] },
  });
  const n1 = r1.lines.find((l) => l.extra_class === 'normal');
  const a1 = r1.lines.find((l) => l.extra_class === 'abnormal');
  eq('عادی تا سقف ۱۰٪ استاندارد (۱ از ۱۰)', n1 && n1.qty, 1);
  eq('مازاد سقف غیرعادی', a1 && a1.qty, 2);
  eq('موجودی زیپ ۳ کم شد', whQty(pZip), 97);
  eq('PRD-24 بدهکار ۵۲۲۱ (تومان)', abnormalDebit('production_material_extra', a1.id), 100000 / 10);

  const r2 = adv.issueStageExtraMaterials(db, {
    orderId: po.id, stageId: stage.id, userId: admin.id,
    body: { date: DATE, lines: [{ product_id: pZip, qty: 10, reason_code: 'material_defect', note: 'زیپ خراب' }] },
  });
  ok('زیپ خراب کامل غیرعادی', r2.lines.length === 1 && r2.lines[0].extra_class === 'abnormal');
  eq('موجودی زیپ ۸۷', whQty(pZip), 87);
  eq('stage material_added = فقط عادی', Number(adv.stageList(db, po.id)[0].material_added_rial), 50000);

  const listed = adv.listStageExtraIssues(db, po.id, stage.id);
  eq('فهرست مصرف اضافه', listed.rows.length, 3);
  ok('فهرست دلایل', listed.reasons.some((r) => r.code === 'material_defect' && r.default_class === 'abnormal'));

  const v = adv.voidStageExtraIssue(db, {
    orderId: po.id, stageId: stage.id, issueId: r2.lines[0].id, reason: 'اشتباه ثبت', userId: admin.id, date: DATE,
  });
  ok('ابطال مصرف اضافه', v.status === 'reversed');
  eq('ابطال موجودی را برمی‌گرداند', whQty(pZip), 97);
  eq('سند ۵۲۲۱ برگشت خورد', abnormalDebit('production_material_extra', r2.lines[0].id) - Number(db.prepare(`
    SELECT COALESCE(SUM(jl.credit),0) c FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE jl.account_code='5221' AND je.id=?
  `).get(v.reversed_je_id).c), 0);
  throws('ابطال دوباره رد می‌شود', () => adv.voidStageExtraIssue(db, {
    orderId: po.id, stageId: stage.id, issueId: r2.lines[0].id, reason: 'x', userId: admin.id, date: DATE,
  }), 'E_ALREADY_REVERSED');

  const out = adv.postStageOutputFixed(db, {
    orderId: po.id, stageId: stage.id, userId: admin.id,
    body: { date: DATE, qty_out: 10, waste_normal: 0, waste_abnormal: 0, rework: 0 },
  });
  ok('خروجی مرحله ثبت شد', out.ok && out.stage && out.stage.status === 'done', out.stage && out.stage.status);
  eq('backflush استاندارد + مصرف اضافه', whQty(pZip), 87);
  const done = adv.stageList(db, po.id)[0];
  eq('بهای مواد مرحله = استاندارد + اضافهٔ عادی', Number(done.material_added_rial), 10 * 50000 + 50000);

  throws('مصرف اضافه روی مرحلهٔ تمام‌شده رد می‌شود', () => adv.issueStageExtraMaterials(db, {
    orderId: po.id, stageId: stage.id, userId: admin.id,
    body: { date: DATE, lines: [{ product_id: pZip, qty: 1, reason_code: 'lost' }] },
  }), 'E_INVALID_STATUS');

  adv.reverseStage(db, { orderId: po.id, stageId: stage.id, reason: 'برگشت تست v513', userId: admin.id, date: DATE });
  eq('ابطال مرحله همهٔ مصرف‌ها را برمی‌گرداند', whQty(pZip), 100);
  const live = db.prepare(`
    SELECT COUNT(*) c FROM production_material_issues WHERE stage_id=? AND issue_type='extra' AND status='posted'
  `).get(stage.id).c;
  eq('هیچ مصرف اضافهٔ فعالی نمی‌ماند', live, 0);
} finally {
  cleanup();
}
summary('extra-actual-v513');
