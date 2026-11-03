'use strict';
/**
 * P8b — اسکریپت‌های اصلاح دفتر کل روی دیتابیس آزمایشی (fixture): apply + reverse.
 *   P8b-1: دستمزد قطعه‌ای بستانکار دارایی شخص → پرداختنی (گزینه A و B)، person_ledger بدون تغییر
 *   P8b-2: اتلاف برش مشترک قدیمی (Cr1110) → شکل P6 (ناخالص + Cr1111)، خالص GL صفر، ستون‌های سفارش
 * Run: node server/scripts/test-prodcycle-p8b.js
 */
const { ok, eq, freshDb, summary } = require('./lib/test-harness');

function throws(name, fn, text) {
  try {
    fn();
    ok(name, false, 'خطایی رخ نداد');
  } catch (e) {
    ok(name, String(e.message).includes(text), `انتظار «${text}» · دریافت ${e.message}`);
  }
}

console.log('\n══ P8b GL data-correction scripts (fixture apply + reverse) ══\n');

let ctx;
try {
  ctx = freshDb();
} catch (e) {
  if (/bindings|better_sqlite3|NODE_MODULE_VERSION/i.test(String(e.message))) {
    console.log('  SKIP: better-sqlite3 روی این Node لود نشد');
    summary('prodcycle-p8b');
  }
  throw e;
}
const { db, cleanup } = ctx;
const DATE = '1405/07/15';

const L = require('./p8b-labor-payable-reclass');
const W = require('./p8b-shared-waste-reclass');
const C = require('./lib/p8b-common');
const { createJournalEntry } = require('../db');

function net(code) { return C.glBalance(db, code).net_rial; }
function jeCount() { return db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c; }
function plNet(pid) {
  const r = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(debit),0)-COALESCE(SUM(credit),0) v FROM person_ledger WHERE person_id=? AND COALESCE(deleted_at,0)=0').get(pid);
  return `${r.n}:${Math.round(r.v)}`;
}
function je(lines, extra = {}) {
  return createJournalEntry(db, {
    date: extra.date || DATE, description: extra.description || 'fixture', ref_type: extra.ref_type || 'fixture',
    ref_id: extra.ref_id || null, created_by: 1, status: 'approved', voucher_type: extra.voucher_type || 'auto',
    doc_type: extra.doc_type || null,
    lines: lines.map(([code, d, c, cc]) => ({ code, name: code, debit: d / 10, credit: c / 10, debit_rial: d, credit_rial: c, cost_center_id: cc || null })),
  });
}

try {
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get() || { id: 1 };

  // ─────────────── P8b-1 ───────────────
  console.log('— P8b-1: دستمزد قطعه‌ای → پرداختنی —');
  const addCoa = (code, name, type, parent) => db.prepare(
    'INSERT OR IGNORE INTO chart_of_accounts (code,name,type,parent_code,level) VALUES (?,?,?,?,4)',
  ).run(code, name, type, parent);
  const ASSET = '110301009901';
  const PAY = '210101009901';
  addCoa(ASSET, 'پیمانکار P8b (دریافتنی)', 'asset', '110301');
  addCoa(PAY, 'پیمانکار P8b (پرداختنی)', 'liability', '210101');
  const partyId = db.prepare(`
    INSERT INTO parties (person_code, party_type, party_roles, full_name, phone, coa_code, opening_balance, is_active, biz)
    VALUES ('P8B-1','other','["supplier","employee"]','پیمانکار P8b','09120009901',NULL,0,1,'پیمانکار P8b')
  `).run().lastInsertRowid;
  const personId = db.prepare('INSERT INTO persons (name, phone, party_id, active, coa_code) VALUES (?,?,?,1,?)')
    .run('پیمانکار P8b', '', partyId, ASSET).lastInsertRowid;
  db.prepare('INSERT INTO suppliers (name, coa_code, party_id) VALUES (?,?,?)').run('پیمانکار P8b', PAY, partyId);

  const productId = db.prepare(
    "INSERT INTO products (user_id,name,code,price,stock,is_manufactured) VALUES (1,'کالا P8b','P-P8B',0,0,1)",
  ).run().lastInsertRowid;
  const ccId = db.prepare('SELECT id FROM cost_centers WHERE COALESCE(is_stage,0)=1 LIMIT 1').get()?.id
    || db.prepare("INSERT INTO cost_centers (code,name,is_stage,kind) VALUES ('CC-P8B','دوخت',1,'production')").run().lastInsertRowid;
  const orderId = db.prepare(`
    INSERT INTO production_orders (order_no, product_id, qty_planned, status, analysis_type, cost_center_id, date)
    VALUES ('PO-P8B1',?,100,'in_progress','fixed',?,?)
  `).run(productId, ccId, DATE).lastInsertRowid;

  const bank = String(require('../lib/coa-map').acct(db, 'coa_bank_default').code);
  je([['3102', 40396000, 0], [ASSET, 0, 40396000]], { ref_type: 'opening_balance', ref_id: personId });
  const laborAmts = [192000000, 211200000, 136000000];
  const laborJes = [];
  for (const amt of laborAmts) {
    const id = je([['1111', amt, 0, ccId], [ASSET, 0, amt, ccId]], { ref_type: 'production_labor' });
    const le = db.prepare(`
      INSERT INTO production_labor_entries (order_id, cost_center_id, person_id, method, qty, rate_rial, amount_rial, date, je_id, status, note)
      VALUES (?,?,?,'piece',1,?,?,?,?,'posted','fixture')
    `).run(orderId, ccId, personId, amt, amt, DATE, id).lastInsertRowid;
    db.prepare('UPDATE journal_entries SET ref_id=? WHERE id=?').run(le, id);
    db.prepare(`INSERT INTO person_ledger (person_id,date,entry_type,ref_type,ref_id,description,debit,credit,user_id)
      VALUES (?,?,'production_labor','production_labor',?,'fixture',0,?,1)`).run(personId, DATE, le, amt);
    laborJes.push(id);
  }
  // سند ابطال‌شده — نباید شمرده شود
  const deadJe = je([['1111', 50400000, 0, ccId], [ASSET, 0, 50400000, ccId]], { ref_type: 'production_labor' });
  db.prepare(`
    INSERT INTO production_labor_entries (order_id, cost_center_id, person_id, method, qty, rate_rial, amount_rial, date, je_id, reversed_je_id, status, note)
    VALUES (?,?,?,'piece',1,50400000,50400000,?,?,?,'reversed','fixture dead')
  `).run(orderId, ccId, personId, DATE, deadJe, deadJe);
  db.prepare("UPDATE journal_entries SET status='reversed', deleted_at=strftime('%s','now') WHERE id=?").run(deadJe);
  je([[ASSET, 17024000, 0], ['4101', 0, 17024000]], { ref_type: 'invoice' });
  for (const amt of [270000000, 150000000]) {
    je([[ASSET, amt, 0], [bank, 0, amt]], { ref_type: 'manual_voucher', doc_type: 'person_payment', voucher_type: 'manual' });
  }

  const plan = L.planLaborReclass(db, { personId });
  eq('دستمزد زنده (بدون سند ابطالی)', plan.labor_total_rial, 539200000);
  eq('پرداخت‌های شخص', plan.payments_total_rial, 420000000);
  ok('resolver → پرداختنی شخص', plan.payable.code === PAY, JSON.stringify(plan.resolver));
  eq('ماندهٔ دارایی قبل', net(ASSET), -(40396000 + 539200000) + 17024000 + 420000000);
  eq('پیش‌بینی A: دارایی', plan.after.A.asset_net_rial, net(ASSET) + 539200000);
  eq('پیش‌بینی B: پرداختنی', plan.after.B.payable_net_rial, -539200000 + 420000000);

  const assetBefore = net(ASSET);
  const payBefore = net(PAY);
  const plBefore = plNet(personId);
  const jeBefore = jeCount();
  throws('apply بدون گزینه رد می‌شود', () => L.applyLaborReclass(db, { personId, reason: 'test' }), '--option');

  const rB = db.transaction(() => L.applyLaborReclass(db, { personId, option: 'B', date: '1405/08/11', reason: 'آزمون B', userId: admin.id }))();
  ok('B: سند اصلاحی با شماره JV', /^JV-/.test(String(rB.head.voucher_number || '')), rB.head.voucher_number);
  eq('B: دارایی بعد', net(ASSET), plan.after.B.asset_net_rial);
  eq('B: پرداختنی بعد', net(PAY), plan.after.B.payable_net_rial);
  ok('B: person_ledger بدون تغییر', plNet(personId) === plBefore, `${plBefore} → ${plNet(personId)}`);
  ok('B: اسناد اصلی دست‌نخورده', laborJes.every((id) => C.liveJe(db, id)));
  ok('B: audit ثبت شد', !!db.prepare("SELECT 1 FROM audit_log WHERE action='p8b_apply' AND entity=? AND entity_id=?").get(L.REF_TYPE, rB.je_id));
  throws('B: تکرار apply رد می‌شود', () => L.applyLaborReclass(db, { personId, option: 'B', reason: 'تکرار' }), 'قبلاً');

  const rv = db.transaction(() => L.reverseLaborReclass(db, { personId, reason: 'آزمون ابطال', userId: admin.id }))();
  eq('ابطال: دارایی برگشت', net(ASSET), assetBefore);
  eq('ابطال: پرداختنی برگشت', net(PAY), payBefore);
  const dead = db.prepare('SELECT status, deleted_at FROM journal_entries WHERE id=?').get(rv.reversed_je_id);
  ok('ابطال: soft-void (حذف فیزیکی نه)', dead && dead.status === 'reversed' && Number(dead.deleted_at) > 0, JSON.stringify(dead));
  eq('ابطال: تعداد اسناد (فقط یکی اضافه)', jeCount(), jeBefore + 1);
  ok('ابطال: person_ledger بدون تغییر', plNet(personId) === plBefore);

  const rA = db.transaction(() => L.applyLaborReclass(db, { personId, option: 'A', date: '1405/08/11', reason: 'آزمون A', userId: admin.id }))();
  eq('A: دارایی بعد', net(ASSET), plan.after.A.asset_net_rial);
  eq('A: پرداختنی بعد', net(PAY), -539200000);
  ok('A: پرداخت‌ها جابه‌جا نشدند', !C.jeLines(db, rA.je_id).some((l) => String(l.description).includes('پرداخت')));
  db.transaction(() => L.reverseLaborReclass(db, { personId, reason: 'آزمون ابطال A', userId: admin.id }))();
  eq('ابطال A: دارایی برگشت', net(ASSET), assetBefore);

  // ─────────────── P8b-2 ───────────────
  console.log('— P8b-2: اتلاف برش مشترک قدیمی → شکل P6 —');
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
  const P = require('../lib/production/posting');
  const { reverseJournalEntry } = require('../lib/void-journal');
  const bom = require('../lib/production/bom');
  const advBom = require('../lib/production/bom-advanced');
  const engine = require('../lib/production/engine');

  const fab = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, average_cost_rial, cost, item_type)
    VALUES (?, 'پارچه P8b', 'FAB-P8B', 0, 100000, 'متر', 1000, 1000, 'raw')
  `).run(admin.id).lastInsertRowid;
  require('../lib/inventory/ledger').postInventoryMovement(db, {
    eventType: 'opening', productId: fab, warehouseId: whRaw, qtyIn: 100000, unitCostRial: 1000,
    sourceType: 'test_fixture', note: 'fixture opening', updateAvg: false,
  });
  const a = db.prepare(`INSERT INTO products (user_id, name, code, unit, item_type, is_manufactured) VALUES (?,'A-P8b','FG-AP8B','عدد','finished',1)`).run(admin.id).lastInsertRowid;
  const b = db.prepare(`INSERT INTO products (user_id, name, code, unit, item_type, is_manufactured) VALUES (?,'B-P8b','FG-BP8B','عدد','finished',1)`).run(admin.id).lastInsertRowid;
  const whFg = (db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get() || {}).id;
  const ccCut = (db.prepare("SELECT id FROM cost_centers WHERE code='CC-10'").get() || {}).id
    || db.prepare('SELECT id FROM cost_centers WHERE COALESCE(is_stage,0)=1 LIMIT 1').get().id;
  const ccSew = (db.prepare("SELECT id FROM cost_centers WHERE code='CC-40'").get() || {}).id || ccCut;
  const draft = bom.createBom(db, {
    product_id: a, name: 'BOM P8b', yield_percent: 100, base_qty: 1, has_routing: 1,
    lines: [{ component_product_id: fab, qty_per_base: 2, scrap_percent: 0, line_type: 'material', stage_cost_center_id: ccCut, std_cost_rial: 1000 }],
  }, admin.id);
  advBom.addOperation(db, draft.id, { seq: 10, cost_center_id: ccCut, operation_name: 'برش', labor_method: 'contract', yield_percent: 100 }, admin.id);
  advBom.addOperation(db, draft.id, { seq: 20, cost_center_id: ccSew, operation_name: 'دوخت', labor_method: 'contract', yield_percent: 100 }, admin.id);
  bom.activateBom(db, draft.id, '1405/01/01', admin.id);
  const po = engine.createOrder(db, {
    product_id: a, bom_id: draft.id, qty_planned: 500, analysis_type: 'fixed_adv', date: DATE,
    warehouse_raw_id: whRaw, warehouse_fg_id: whFg, cost_center_id: ccCut,
  }, admin.id);
  engine.releaseOrder(db, po.id, admin.id);
  const openings = [90, 90, 90, 120];
  const plies = [11, 11, 11, 15];
  const rolls = openings.map((m, i) => db.prepare(`
    INSERT INTO inventory_batches (batch_no, product_id, warehouse_id, qty_on_hand, qty_received, status, kind, unit, unit_cost_rial)
    VALUES (?,?,?,?,?,'active','fabric','متر', 1000)
  `).run('RP8B-' + i, fab, whRaw, m, m).lastInsertRowid);
  const posted = shared.postSharedCut(db, {
    marker_length_m: 5.9, fabric_product_id: fab, warehouse_id: whRaw, width_cm: 150, date: DATE,
    idempotency_key: 'p8b-shared', production_order_id: po.id, actual_meters: 310, override_balance: true,
    outputs: [
      { product_id: a, size_code: 'ALL', pieces_per_ply: 1, weight: 40, fabric_std_m: 2 },
      { product_id: b, size_code: 'ALL', pieces_per_ply: 2, weight: 60, fabric_std_m: 2 },
    ],
    rolls: openings.map((opening, i) => ({ batch_id: rolls[i], opening_m: opening, ply_count: plies[i], length_loss_m: i === 0 ? 1.5 : 0 })),
  }, { id: admin.id });
  const lay0 = db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(posted.lay_id);
  const common = Number(posted.common_rial);
  const waste = Number(lay0.waste_amount_rial);
  ok('fixture: لایه به مرحله وصل است', Number(lay0.stage_id) > 0);
  ok('fixture: اتلاف دارد', waste > 0, waste);

  // تبدیل به شکل قدیمی (قبل از P6): PRD-01 خالص، PRD-09 بستانکار مواد، حواله و مرحله خالص
  const stg0 = db.prepare('SELECT * FROM production_order_stages WHERE id=?').get(lay0.stage_id);
  db.transaction(() => {
    reverseJournalEntry(db, lay0.journal_id, { userId: admin.id, reason: 'fixture legacy' });
    reverseJournalEntry(db, lay0.waste_journal_id, { userId: admin.id, reason: 'fixture legacy' });
    const j1 = P.postEvent(db, { event: 'PRD-01', sourceId: lay0.id, date: DATE, createdBy: admin.id, costCenterId: lay0.cost_center_id,
      description: 'مصرف خالص برش مشترک (قدیمی)', lines: [P.dr(db, 'coa_wip', common), P.cr(db, 'coa_raw_materials', common)] });
    const j2 = P.postEvent(db, { event: 'PRD-09', sourceId: lay0.id, date: DATE, createdBy: admin.id, costCenterId: lay0.cost_center_id,
      description: 'اتلاف طولی برش (قدیمی)', lines: [P.dr(db, 'coa_abnormal_waste', waste), P.cr(db, 'coa_raw_materials', waste)] });
    db.prepare('UPDATE cutting_lays SET journal_id=?, waste_journal_id=? WHERE id=?').run(j1.je_id, j2.je_id, lay0.id);
    db.prepare('UPDATE cutting_batches SET journal_id=?, waste_journal_id=? WHERE id=?').run(j1.je_id, j2.je_id, posted.id);
    db.prepare("UPDATE production_material_issues SET amount_rial=?, std_amount_rial=? WHERE order_id=? AND issue_type='cutting_lay' AND status='posted'")
      .run(common, common, po.id);
    if (stg0.status === 'done') {
      db.prepare('UPDATE production_order_stages SET material_added_rial=material_added_rial-?, waste_abnormal_rial=waste_abnormal_rial-? WHERE id=?').run(waste, waste, stg0.id);
    } else {
      db.prepare('UPDATE production_order_stages SET material_added_rial=material_added_rial-? WHERE id=?').run(waste, stg0.id);
    }
    OCR.applyDocumentCosts(db, po.id);
  })();
  const ocrL = OCR.previewOrderCostReconcile(db, po.id);
  eq('قدیمی: اتلاف مشترک قدیمی = اتلاف', ocrL.shared_lay_waste_rial, waste);
  eq('قدیمی: اتلاف داخل WIP صفر', ocrL.wip_abnormal_waste_rial, 0);

  const snap = () => ({
    raw: net('1110'), wip: net('1111'), w: net('5221'),
    mi: db.prepare("SELECT amount_rial FROM production_material_issues WHERE order_id=? AND issue_type='cutting_lay' AND status='posted'").get(po.id).amount_rial,
    stage: db.prepare('SELECT material_added_rial, waste_abnormal_rial, cost_out_rial FROM production_order_stages WHERE id=?').get(stg0.id),
    order: db.prepare('SELECT material_cost_rial, abnormal_waste_rial FROM production_orders WHERE id=?').get(po.id),
    ocr: OCR.previewOrderCostReconcile(db, po.id),
  });
  const s0 = snap();
  const wPlan = W.planSharedWaste(db, { orderId: po.id });
  eq('plan: یک لایهٔ قدیمی', wPlan.items.length, 1);
  eq('plan: جمع اتلاف', wPlan.total_waste_rial, waste);
  ok('plan: بدون ناسازگاری', wPlan.items.every((i) => !i.problems.length), JSON.stringify(wPlan.items.map((i) => i.problems)));

  const res = db.transaction(() => W.applySharedWaste(db, { orderId: po.id, reason: 'آزمون P8b-2', userId: admin.id }))();
  const s1 = snap();
  eq('apply: 1110 بدون تغییر', s1.raw, s0.raw);
  eq('apply: 1111 بدون تغییر', s1.wip, s0.wip);
  eq('apply: 5221 بدون تغییر', s1.w, s0.w);
  eq('apply: حواله = ناخالص', s1.mi, common + waste);
  eq('apply: مواد سفارش + اتلاف', s1.order.material_cost_rial, s0.order.material_cost_rial + waste);
  eq('apply: ستون ضایعات سفارش ثابت', s1.order.abnormal_waste_rial, s0.order.abnormal_waste_rial);
  eq('apply: اتلاف داخل WIP', s1.ocr.wip_abnormal_waste_rial, waste);
  eq('apply: اتلاف مشترک قدیمی صفر', s1.ocr.shared_lay_waste_rial, 0);
  eq('apply: رسید مورد انتظار ثابت', s1.ocr.expected_receipts_rial, s0.ocr.expected_receipts_rial);
  eq('apply: cost_out مرحله ثابت', s1.stage.cost_out_rial, s0.stage.cost_out_rial);
  eq('apply: مواد مرحله + اتلاف', s1.stage.material_added_rial, s0.stage.material_added_rial + waste);
  const layA = db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(lay0.id);
  const wl = C.jeLines(db, layA.waste_journal_id);
  ok('apply: PRD-09 جدید بستانکار 1111', wl.some((l) => l.account_code === '1111' && l.credit_rial === waste) && !wl.some((l) => l.account_code === '1110'));
  const il = C.jeLines(db, layA.journal_id);
  ok('apply: PRD-01 جدید ناخالص', il.some((l) => l.account_code === '1111' && l.debit_rial === common + waste));
  const old = res.done[0];
  const oldHeads = [old.issue_je.id, old.waste_je.id].map((id) => db.prepare('SELECT status, deleted_at FROM journal_entries WHERE id=?').get(id));
  ok('apply: اسناد قدیمی soft-void (موجود در جدول)', oldHeads.every((h) => h && h.status === 'reversed' && Number(h.deleted_at) > 0));
  throws('apply: تکرار رد می‌شود', () => W.applySharedWaste(db, { orderId: po.id, reason: 'تکرار' }), 'قبلاً');

  db.transaction(() => W.reverseSharedWaste(db, { orderId: po.id, reason: 'آزمون ابطال P8b-2', userId: admin.id }))();
  const s2 = snap();
  eq('ابطال: 1110', s2.raw, s0.raw);
  eq('ابطال: 1111', s2.wip, s0.wip);
  eq('ابطال: 5221', s2.w, s0.w);
  eq('ابطال: حواله خالص', s2.mi, s0.mi);
  eq('ابطال: مواد سفارش', s2.order.material_cost_rial, s0.order.material_cost_rial);
  eq('ابطال: مواد مرحله', s2.stage.material_added_rial, s0.stage.material_added_rial);
  eq('ابطال: ضایعات مرحله', s2.stage.waste_abnormal_rial, s0.stage.waste_abnormal_rial);
  eq('ابطال: اتلاف مشترک قدیمی برگشت', s2.ocr.shared_lay_waste_rial, waste);
  const layR = db.prepare('SELECT * FROM cutting_lays WHERE id=?').get(lay0.id);
  ok('ابطال: سند اتلاف دوباره شکل قدیم (Cr1110)', C.jeLines(db, layR.waste_journal_id).some((l) => l.account_code === '1110' && l.credit_rial === waste));
  ok('ابطال: اسناد اصلاحی soft-void', [old.new_issue_je_id, old.new_waste_je_id].every((id) => !C.liveJe(db, id)
    && db.prepare('SELECT 1 FROM journal_entries WHERE id=?').get(id)));

  const again = db.transaction(() => W.applySharedWaste(db, { orderId: po.id, reason: 'اعمال دوباره', userId: admin.id }))();
  eq('اعمال دوباره بعد از ابطال', again.done.length, 1);
  eq('اعمال دوباره: مواد سفارش', snap().order.material_cost_rial, s0.order.material_cost_rial + waste);

  // ─────────────── dry-run هرگز نمی‌نویسد ───────────────
  console.log('— dry-run rollback —');
  const before = jeCount();
  const out = C.runTxn(db, 'dry-run', () => L.applyLaborReclass(db, { personId, option: 'A', reason: 'dry', userId: admin.id }));
  ok('dry-run: نتیجه دارد', out && out.je_id > 0);
  eq('dry-run: هیچ سندی نماند', jeCount(), before);
  eq('dry-run: دارایی دست‌نخورده', net(ASSET), assetBefore);
  throws('apply بدون تأیید رد می‌شود', () => C.modeOf({ apply: true, reason: 'xxxxxx' }), 'i-have-approval');
  throws('apply بدون دلیل رد می‌شود', () => C.modeOf({ apply: true, 'i-have-approval': true }), 'reason');
} catch (e) {
  ok('مسیر دیتابیس', false, e.stack || e.message);
} finally {
  cleanup();
}

summary('prodcycle-p8b');
