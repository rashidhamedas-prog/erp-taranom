'use strict';
/**
 * Shared cut golden cases: four rolls, remnant threshold, A/B pieces, rial split.
 * Run: node server/scripts/test-prod-cut-shared.js
 */
const { ok, eq, freshDb, summary } = require('./lib/test-harness');
const {
  remnantThreshold, classifyUsableRemaining, rollEquation, previewRolls, plannedPieces, allocateRial, previewSharedCut,
  postSharedCut, voidSharedCut,
} = require('../lib/production/shared-cut');

const marker = 5.9;
const openings = [79, 80, 90, 110];
const plies = [11, 11, 11, 15];
const expectReturn = [14.1, 15.1, 25.1, 21.5];

const policy = remnantThreshold({ mode: 'formula', min_remnant_m: 1.2, remnant_ratio: 0.2 }, marker);
eq('T پیش‌فرض', policy.threshold_m, 1.2, 0.001);
ok('۱٫۲۰ ته‌طاقه', classifyUsableRemaining(1.2, 1.2).destination === 'remnant');
ok('۱٫۲۱ برگشت طاقه', classifyUsableRemaining(1.21, 1.2).destination === 'return_roll');
ok('صفر بدون رسید', classifyUsableRemaining(0, 1.2).destination === 'none');
ok('عیب ضایعات', classifyUsableRemaining(0.4, 1.2, { defective: true }).destination === 'scrap');

const fixed = remnantThreshold({ mode: 'fixed_m', min_remnant_m: 2, remnant_ratio: 0.2 }, marker);
eq('حالت متر ثابت', fixed.threshold_m, 2, 0.001);

let returnedSum = 0;
openings.forEach((opening, i) => {
  const laid = Math.round(plies[i] * marker * 1000) / 1000;
  const row = rollEquation({
    opening_m: opening, laid_m: laid, returned_m: expectReturn[i], remnant_m: 0, length_loss_m: 0, adjustment_m: 0,
  }, 0.01);
  ok(`تراز طاقه ${opening}`, row.ok, row.diff_m);
  returnedSum += expectReturn[i];
});
eq('جمع برگشت ۷۵٫۸۰', Math.round(returnedSum * 100) / 100, 75.8, 0.001);
eq('قطعات A', plannedPieces(48, 1), 48);
eq('قطعات B', plannedPieces(48, 2), 96);

const split = allocateRial(100, [
  { product_id: 2, weight: 33.333 },
  { product_id: 1, weight: 66.667 },
]);
eq('جمع ریال سهم', split.reduce((s, r) => s + r.amount_rial, 0), 100);

const bare = previewRolls([
  { batch_id: 1, opening_m: 71, ply_count: 11, length_loss_m: 0 },
], { mode: 'formula', min_remnant_m: 1.2, remnant_ratio: 0.2 }, 6.56, 0.01);
ok('کسری دفتر بدون اضافه', bare[0].equation.ok === false, bare[0].equation.diff_m);
const coveredRoll = previewRolls([
  { batch_id: 1, opening_m: 71, ply_count: 11, length_loss_m: 0, extra_m: 1.16 },
], { mode: 'formula', min_remnant_m: 1.2, remnant_ratio: 0.2 }, 6.56, 0.01);
ok('اضافه طاقه تراز را می‌بندد', coveredRoll[0].equation.ok, coveredRoll[0].equation.diff_m);
eq('مانده دفتر جدا از اضافه', coveredRoll[0].opening_m, 71, 0.001);
eq('طول مؤثر', coveredRoll[0].effective_opening_m, 72.16, 0.001);
let extraRejected = false;
try {
  previewRolls([{ batch_id: 1, opening_m: 71, ply_count: 11, extra_m: -1 }], { mode: 'formula', min_remnant_m: 1.2, remnant_ratio: 0.2 }, 6.56, 0.01);
} catch (e) { extraRejected = e && e.code === 'E_ROLL_EXTRA'; }
ok('اضافه منفی رد می‌شود', extraRejected);

let ctx;
try {
  ctx = freshDb();
} catch (e) {
  if (/bindings|better_sqlite3|NODE_MODULE_VERSION/i.test(String(e.message) + (e.tries || ''))) {
    console.log('  SKIP مسیر دیتابیس: better-sqlite3 روی این Node لود نشد');
    summary('shared-cut');
  }
  throw e;
}
const { db, cleanup } = ctx;
try {
  db.prepare("INSERT INTO settings (key,value) VALUES ('production_shared_cut','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get();
  const raw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get();
  if (!db.prepare("SELECT id FROM warehouses WHERE code='WH-WIP'").get()) {
    db.prepare("INSERT INTO warehouses (code,name,kind,warehouse_type,active) VALUES ('WH-WIP','انبار کار در جریان','wip','wip',1)").run();
  }
  const fab = db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, average_cost_rial, cost, item_type)
    VALUES (?, 'پارچه مشترک', 'FAB-SH', 0, 100000, 'متر', 1000, 1000, 'raw')
  `).run(admin.id).lastInsertRowid;
  db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,100000)').run(fab, raw.id);
  const a = db.prepare(`INSERT INTO products (user_id, name, code, unit, item_type, is_manufactured) VALUES (?,'A','FG-A','عدد','finished',1)`).run(admin.id).lastInsertRowid;
  const b = db.prepare(`INSERT INTO products (user_id, name, code, unit, item_type, is_manufactured) VALUES (?,'B','FG-B','عدد','finished',1)`).run(admin.id).lastInsertRowid;
  const poId = db.prepare(`
    INSERT INTO production_orders (order_no, product_id, qty_planned, date, status, analysis_type)
    VALUES ('PO-SHARED', ?, 48, '1405/07/26', 'released', 'fixed')
  `).run(a).lastInsertRowid;
  const ids = openings.map((m, i) => db.prepare(`
    INSERT INTO inventory_batches (batch_no, product_id, warehouse_id, qty_on_hand, qty_received, status, kind, unit, unit_cost_rial)
    VALUES (?,?,?,?,?,'active','fabric','متر', 9999)
  `).run('R' + m, fab, raw.id, m, m).lastInsertRowid);

  const body = {
    marker_length_m: marker,
    fabric_product_id: fab,
    warehouse_id: raw.id,
    width_cm: 150,
    date: '1405/07/26',
    idempotency_key: 'shared-gold-1',
    production_order_id: poId,
    outputs: [
      { product_id: a, size_code: 'ALL', pieces_per_ply: 1, weight: 40 },
      { product_id: b, size_code: 'ALL', pieces_per_ply: 2, weight: 60 },
    ],
    rolls: openings.map((opening, i) => ({ batch_id: ids[i], opening_m: opening, ply_count: plies[i] })),
  };
  const preview = previewSharedCut(db, body);
  ok('پیش‌نمایش متوازن', preview.balanced, JSON.stringify(preview.errors));
  eq('برگشت پیش‌نمایش', preview.returned_m, 75.8, 0.02);
  eq('ته‌طاقه پیش‌نمایش صفر', preview.remnant_m, 0, 0.001);
  eq('A برنامه', preview.outputs.find((o) => o.product_id === a).planned_pieces, 48);
  eq('B برنامه', preview.outputs.find((o) => o.product_id === b).planned_pieces, 96);

  const posted = postSharedCut(db, body, { id: admin.id });
  ok('ثبت شد', posted.status === 'posted', posted.status);
  eq('بهای مشترک', posted.common_rial, Math.round(preview.laid_m * 1000));
  const allocSum = posted.allocations.reduce((s, r) => s + r.amount_rial, 0);
  eq('جمع تخصیص', allocSum, posted.common_rial);
  ok('یک سند PRD-01', Number(posted.journal_id) > 0);
  const jeCount = db.prepare(`
    SELECT COUNT(*) c FROM journal_entries
    WHERE ref_type='production_material_issue' AND ref_id=? AND COALESCE(deleted_at,0)=0
  `).get(posted.lay_id).c;
  eq('یک مسیر PRD-01', jeCount, 1);
  openings.forEach((m, i) => {
    const left = db.prepare('SELECT qty_on_hand q FROM inventory_batches WHERE id=?').get(ids[i]).q;
    eq(`باقی طاقه ${m}`, Number(left), expectReturn[i], 0.02);
  });
  const again = postSharedCut(db, body, { id: admin.id });
  eq('تکرار همان شناسه', again.id, posted.id);
  const packs = db.prepare("SELECT COUNT(*) c FROM cutting_packs WHERE lay_id=? AND status='posted'").get(posted.lay_id).c;
  eq('برش چندمحصول هنوز PACK انبار نساخته', packs, 0);

  db.prepare("UPDATE settings SET value='2' WHERE key='production_remnant_min_m'").run();
  const snap = posted.policy;
  eq('اسنپ‌شات کف قبلی', Number(snap.min_remnant_m), 1.2, 0.001);
  const newer = previewSharedCut(db, {
    ...body,
    idempotency_key: 'shared-gold-2',
    rolls: [{ batch_id: ids[0], opening_m: 79, ply_count: 11, returned_m: 1.5, remnant_m: 0, laid_m: 77.5 }],
  });
  ok('سیاست جدید بارگذاری می‌شود', Number(newer.policy.min_remnant_m) === 2 || newer.policy.threshold_m === 2);

  const voided = voidSharedCut(db, posted.id, { id: admin.id }, 'آزمون');
  ok('ابطال', voided.status === 'reversed', voided.status);
  const leftAfter = db.prepare('SELECT qty_on_hand q FROM inventory_batches WHERE id=?').get(ids[0]).q;
  eq('برگشت متر پس از ابطال', Number(leftAfter), 79, 0.05);

  if (!db.prepare("SELECT id FROM warehouses WHERE code='WH-SCRAP'").get()) {
    db.prepare("INSERT INTO warehouses (code,name,kind,warehouse_type,active) VALUES ('WH-SCRAP','ضایعات','scrap','scrap',1)").run();
  }
  const lossId = db.prepare(`
    INSERT INTO inventory_batches (batch_no, product_id, warehouse_id, qty_on_hand, qty_received, status, kind, unit, unit_cost_rial)
    VALUES (?,?,?,?,?,'active','fabric','متر', 1000)
  `).run('R-LOSS', fab, raw.id, 7.5, 7.5).lastInsertRowid;
  const lossPosted = postSharedCut(db, {
    marker_length_m: marker,
    fabric_product_id: fab,
    warehouse_id: raw.id,
    width_cm: 150,
    date: '1405/07/26',
    idempotency_key: 'shared-loss-1',
    outputs: [{ product_id: a, size_code: 'ALL', pieces_per_ply: 1, weight: 100 }],
    rolls: [{ batch_id: lossId, opening_m: 7.5, ply_count: 1, length_loss_m: 0.5 }],
  }, { id: admin.id });
  ok('ته‌طاقه ثبت شد', lossPosted.rolls.some((r) => Number(r.remnant_m) > 0 && Number(r.remnant_ledger_id) > 0));
  const creditRaw = db.prepare(`
    SELECT COUNT(*) c FROM journal_lines
    WHERE entry_id=? AND account_code='1110' AND COALESCE(credit_rial,0) > 0
  `).get(lossPosted.waste_journal_id).c;
  eq('اتلاف بستانکار مواد', creditRaw, 1);
  const creditWip = db.prepare(`
    SELECT COUNT(*) c FROM journal_lines
    WHERE entry_id=? AND account_code='1111' AND COALESCE(credit_rial,0) > 0
  `).get(lossPosted.waste_journal_id).c;
  eq('اتلاف بستانکار WIP نیست', creditWip, 0);
  voidSharedCut(db, lossPosted.id, { id: admin.id }, 'آزمون اتلاف');
  const remLeft = db.prepare(`
    SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_batches
    WHERE source_type='cutting_remnant' AND source_id=?
  `).get(lossPosted.id).q;
  eq('ته‌طاقه بعد از ابطال صفر', Number(remLeft), 0, 0.001);

  const shortId = db.prepare(`
    INSERT INTO inventory_batches (batch_no, product_id, warehouse_id, qty_on_hand, qty_received, status, kind, unit, unit_cost_rial)
    VALUES ('R71',?,?,71,71,'active','fabric','متر',1000)
  `).run(fab, raw.id).lastInsertRowid;
  const shortBody = {
    marker_length_m: 6.56,
    fabric_product_id: fab,
    warehouse_id: raw.id,
    width_cm: 150,
    date: '1405/07/27',
    idempotency_key: 'shared-extra-1',
    production_order_id: poId,
    outputs: [
      { product_id: a, size_code: 'ALL', pieces_per_ply: 1, weight: 50 },
      { product_id: b, size_code: 'ALL', pieces_per_ply: 1, weight: 50 },
    ],
    rolls: [{ batch_id: shortId, opening_m: 71, ply_count: 11, length_loss_m: 0 }],
  };
  const shortPrev = previewSharedCut(db, shortBody);
  ok('بدون اضافه طاقه نامتوازن', shortPrev.balanced === false);
  ok('کسری حدود ۱٫۱۶', Math.abs(shortPrev.shortfall_m - 1.16) < 0.02, shortPrev.shortfall_m);
  shortBody.rolls[0].extra_m = 1.16;
  shortBody.idempotency_key = 'shared-extra-2';
  const covered = previewSharedCut(db, shortBody);
  ok('با اضافه طاقه متوازن', covered.balanced, JSON.stringify(covered.errors));
  eq('اضافه پیش‌نمایش', covered.extra_m, 1.16, 0.001);
  const extraPosted = postSharedCut(db, shortBody, { id: admin.id });
  eq('مانده بعد از اضافه', Number(db.prepare('SELECT qty_on_hand q FROM inventory_batches WHERE id=?').get(shortId).q), 0, 0.02);
  const extraJe = db.prepare('SELECT extra_journal_id id FROM cutting_lays WHERE id=?').get(extraPosted.lay_id).id;
  ok('سند اضافه طاقه', Number(extraJe) > 0);
  const varLine = db.prepare(`
    SELECT COUNT(*) c FROM journal_lines
    WHERE entry_id=? AND account_code='5211' AND COALESCE(credit_rial,0) > 0
  `).get(extraJe).c;
  eq('انحراف مقدار بستانکار', varLine, 1);
  voidSharedCut(db, extraPosted.id, { id: admin.id }, 'آزمون اضافه طاقه');
  eq('برگشت مانده ۷۱', Number(db.prepare('SELECT qty_on_hand q FROM inventory_batches WHERE id=?').get(shortId).q), 71, 0.02);
} catch (e) {
  ok('مسیر دیتابیس', false, e.stack || e.message);
} finally {
  cleanup();
}

summary('shared-cut');
