'use strict';
/**
 * v522 — موتور ارزش‌گذاری موجودی (موج دوم)
 *  1) سطح ارزش‌گذاری لایه‌ای (کالا ← گروه ← انبار ← سراسری) + استخر مشترک/مستقل (mixed)
 *  2) انتقال با نرخ مبدأ (استخر مشترک ↔ مستقل)
 *  4) تغییر بها بعد از فروش → سند تأیید (تأیید/رد/ابطال تصمیم/ابطال سند مبدأ) + اعمال فوری اگر چیزی خارج نشده
 *  5) تسهیم انحراف دوره فقط روی کالاهای تولیدشده در همان دوره؛ سهم فروش‌رفته → COGS
 *  6) زمان‌بندی قواعد (schedule_json) + اجرای حداکثر یک‌بار در هر اسلات + مهاجرت
 *  7) قفل ماهانه (بستن/بازکردن با دلیل؛ 422 E_INV_PERIOD_LOCKED؛ خودکار → اولین روز باز)
 *  8) حساب مقابل تعدیل دستی بر اساس مرحله + دلیل
 *  9) مبنای «آخرین خرید» از همان استخر
 * Run: node server/scripts/test-inventory-valuation-v522.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-val-v522-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(dir, 't.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.JWT_SECRET = 'test-inv-valuation-v522-secret-32b-xx';
process.env.SYNC_ROLE = 'central';

let passed = 0, failed = 0;
function ok(c, m, extra) {
  if (c) { passed++; console.log('  OK', m); }
  else { failed++; console.error('  FAIL', m, extra !== undefined ? JSON.stringify(extra) : ''); }
}
function finish() {
  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  if (failed) process.exit(1);
}
function throwsCode(fn, codes) {
  try { fn(); return null; } catch (e) { return codes.includes(e.code) ? e.code : `unexpected:${e.code || e.message}`; }
}

let db;
try {
  const { initDB, getDB } = require('../db');
  initDB();
  db = getDB();
} catch (e) {
  console.log('SKIP — better-sqlite3 در دسترس نیست:', e.message);
  process.exit(0);
}

const V = require('../lib/inventory/valuation');
const R = require('../lib/inventory/revaluation');
const L = require('../lib/inventory/ledger');
const PL = require('../lib/inventory/period-lock');
const VA = require('../lib/inventory/value-accounts');
const VAP = require('../lib/inventory/value-approval');
const LC = require('../lib/inventory/landed-cost');
const { rebuildBaseCoa, acct } = require('../lib/coa-map');

if (!db.prepare('SELECT COUNT(*) c FROM chart_of_accounts').get().c) rebuildBaseCoa(db);
V.ensureValuationSchema(db);

const uid = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()?.id || 1;
const user = { id: uid, role: 'admin' };
const prod = (id) => db.prepare('SELECT * FROM products WHERE id=?').get(id);
const avg = (id) => Math.round(Number(prod(id).average_cost_rial) || 0);
const bucket = (p, w) => db.prepare('SELECT * FROM inventory_valuation_buckets WHERE product_id=? AND warehouse_id=?').get(p, w) || {};
let seq = 0;
function mkProduct(code, extra = {}) {
  seq++;
  const id = db.prepare(`
    INSERT INTO products (user_id,name,code,stock,average_cost_rial,cost,unit)
    VALUES (?,?,?,?,?,?,'عدد')
  `).run(uid, `کالا ${code}`, code, extra.stock || 0, extra.avg || 0, Math.round((extra.avg || 0) / 10)).lastInsertRowid;
  if (extra.item_type) db.prepare('UPDATE products SET item_type=? WHERE id=?').run(extra.item_type, id);
  return id;
}
function mkWarehouse(name, level = null) {
  const id = db.prepare("INSERT INTO warehouses (name, warehouse_type) VALUES (?, 'finished_goods')").run(name).lastInsertRowid;
  if (level) db.prepare('UPDATE warehouses SET valuation_level=? WHERE id=?').run(level, id);
  return id;
}
function buy(productId, qty, unit, date, warehouseId) {
  return L.postInventoryMovement(db, {
    eventType: 'purchase', productId, warehouseId, qtyIn: qty, unitCostRial: unit,
    sourceType: 'purchase', sourceId: 9000 + (++seq), date, createdBy: uid,
  });
}
function out(productId, qty, date, warehouseId, eventType = 'sale') {
  return L.postInventoryMovement(db, {
    eventType, productId, warehouseId, qtyOut: qty,
    sourceType: 'invoice', sourceId: 8000 + (++seq), date, createdBy: uid,
  });
}
/** Mirrors warehouse-docs transfer: out at header avg (engine swaps in pool rate), in at out amount. */
function transfer(productId, fromWh, toWh, qty, date) {
  const unit = avg(productId);
  const ledOut = L.postInventoryMovement(db, {
    eventType: 'transfer_out', productId, warehouseId: fromWh, qty: -qty, unitCostRial: unit,
    sourceType: 'warehouse_transfer', date, createdBy: uid, updateAvg: false,
  });
  const ledIn = L.postInventoryMovement(db, {
    eventType: 'transfer_in', productId, warehouseId: toWh, qty, unitCostRial: unit,
    amountRial: ledOut.amount_rial, sourceType: 'warehouse_transfer', date, createdBy: uid, updateAvg: false,
  });
  return { ledOut, ledIn };
}
function acctBal(code) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(jl.debit),0) - COALESCE(SUM(jl.credit),0) b
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE jl.account_code=? AND COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'posted')<>'reversed'
  `).get(code);
  return Math.round((Number(r && r.b) || 0) * 10);
}
function jeBalanced(jeId) {
  const r = db.prepare('SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM journal_lines WHERE entry_id=?').get(jeId);
  return Math.abs((r.d || 0) - (r.c || 0)) < 0.01 && r.d > 0;
}

console.log('\n══ v522 inventory valuation ══\n');

// ── 4) value change after sale → approval document ─────────────────────────
// (runs first: every warehouse still resolves to the shared pool here)
const W0 = mkWarehouse('انبار اصلی');
{
  console.log('[4] approvals');
  const clearing = VA.clearingAccount(db);
  const variance = VA.priceVarianceAccount(db);
  ok(clearing && clearing.code && /در انتظار تأیید/.test(clearing.name), 'clearing account «تعدیل بهای در انتظار تأیید» ensured', clearing);
  ok(variance && /انحراف بها/.test(variance.name), 'price variance account «انحراف بها» ensured', variance);
  ok(db.prepare("SELECT value FROM settings WHERE key='coa_value_change_clearing'").get()?.value === clearing.code, 'settings coa_value_change_clearing mapped');

  // nothing issued → immediate apply, no approval
  const pFree = mkProduct('APR-FREE');
  buy(pFree, 10, 100, '1405/07/01', W0);
  const d0 = LC.createLandedCostDoc(db, { date: '1405/07/02', lines: [{ cost_type: 'freight', amount_rial: 1000 }], createdBy: uid });
  const r0 = LC.allocateAndPost(db, d0.id, [{ product_id: pFree, warehouse_id: W0, qty: 10, base_value_rial: 1000 }], { createdBy: uid, date: '1405/07/02' });
  ok(!r0.value_approval, 'landed cost with nothing issued: applied immediately (no approval)');
  ok(avg(pFree) === 200, `immediate: avg 100 → 200 (got ${avg(pFree)})`);

  // 6 issued (4 sold + 2 to production) → whole change parked
  const p = mkProduct('APR-1');
  buy(p, 10, 100, '1405/07/01', W0);
  out(p, 2, '1405/07/02', W0, 'production_issue');
  out(p, 4, '1405/07/03', W0, 'sale');
  const clrBefore = acctBal(clearing.code);
  const doc = LC.createLandedCostDoc(db, { date: '1405/07/04', lines: [{ cost_type: 'freight', amount_rial: 1000 }], createdBy: uid });
  const r = LC.allocateAndPost(db, doc.id, [{ product_id: p, warehouse_id: W0, qty: 10, base_value_rial: 1000 }], { createdBy: uid, date: '1405/07/04' });
  ok(r.value_approval && r.value_approval.total_delta_rial === 1000, 'landed cost after sale → pending approval 1000', r.value_approval);
  ok(avg(p) === 100, `pending: avg unchanged 100 (got ${avg(p)})`);
  ok(acctBal(clearing.code) - clrBefore === 1000, 'pending: landed-cost JE debits clearing 1000');
  const aid = r.value_approval.id;
  let a = VAP.get(db, aid);
  ok(a.status === 'pending' && a.lines.length === 1, 'approval doc pending with one line');
  ok(Math.abs(a.lines[0].sold_qty - 6) < 1e-9 && Math.abs(a.lines[0].wip_qty - 2) < 1e-9, 'split: sold 6 of which 2 consumed by production', a.lines[0]);
  const notif = db.prepare("SELECT COUNT(*) c FROM app_notifications WHERE kind='value_change_approval'").get();
  ok(notif && notif.c >= 1, 'notification value_change_approval created');

  // approve
  const cogsBefore = acctBal(acct(db, 'coa_cogs').code);
  const wipBefore = acctBal(acct(db, 'coa_wip').code);
  a = VAP.approve(db, aid, user, { date: '1405/07/05' });
  ok(a.status === 'approved' && a.decision_je_id, 'approve → approved + decision JE');
  ok(jeBalanced(a.decision_je_id), 'approve JE balanced');
  ok(avg(p) === 200, `approve: in-stock share 400 → avg (4×100+400)/4 = 200 (got ${avg(p)})`);
  ok(acctBal(acct(db, 'coa_cogs').code) - cogsBefore === 400, 'approve: COGS +400 (sold share)');
  ok(acctBal(acct(db, 'coa_wip').code) - wipBefore === 200, 'approve: WIP +200 (production share)');
  ok(acctBal(clearing.code) === clrBefore, 'approve: clearing back to zero');
  ok(throwsCode(() => VAP.approve(db, aid, user, {}), ['E_APPROVAL_NOT_PENDING']) === 'E_APPROVAL_NOT_PENDING', 'approve twice rejected');

  // reopen (R13) → full reversal
  a = VAP.reopen(db, aid, user, { reason: 'اشتباه در تأیید' });
  ok(a.status === 'pending' && a.reopen_count === 1, 'reopen → pending, reopen_count 1');
  ok(avg(p) === 100, `reopen: avg back to 100 (got ${avg(p)})`);
  ok(acctBal(acct(db, 'coa_cogs').code) === cogsBefore, 'reopen: COGS restored');
  ok(acctBal(clearing.code) - clrBefore === 1000, 'reopen: clearing holds 1000 again');

  // reject → variance, rate unchanged
  const varBefore = acctBal(variance.code);
  a = VAP.reject(db, aid, user, { date: '1405/07/06', note: 'هزینه حمل قابل انتساب نیست' });
  ok(a.status === 'rejected', 'reject → rejected');
  ok(avg(p) === 100, 'reject: rate unchanged');
  ok(acctBal(variance.code) - varBefore === 1000, 'reject: «انحراف بها» +1000');
  ok(acctBal(clearing.code) === clrBefore, 'reject: clearing zero');

  // void the landed cost → decision undone + approval cancelled
  LC.voidLandedCost(db, doc.id, { createdBy: uid, reason: 'ابطال تست' });
  a = VAP.get(db, aid);
  ok(a.status === 'cancelled', 'source void → approval cancelled');
  ok(acctBal(variance.code) === varBefore, 'source void: variance reversed');
  ok(acctBal(clearing.code) === clrBefore, 'source void: clearing zero');
  ok(avg(p) === 100, 'source void: avg 100');
  ok(VAP.list(db, { status: 'all' }).some((x) => x.id === aid), 'list(all) includes the document');
}

// ── 1) layered valuation level + mixed pools ───────────────────────────────
const WA = mkWarehouse('انبار مشترک A');
const WB = mkWarehouse('انبار مشترک B');
const WS = mkWarehouse('انبار مستقل S', 'warehouse');
{
  console.log('\n[1] valuation level');
  const cat = db.prepare("INSERT INTO product_categories (name, code) VALUES ('گروه سطح', 991)").run().lastInsertRowid;
  const pL = mkProduct('LVL');
  ok(V.levelFor(db, pL, WS).level === 'warehouse' && V.levelFor(db, pL, WS).source === 'warehouse', 'warehouse layer: S → warehouse');
  ok(V.levelFor(db, pL, WA).source === 'global' && V.levelFor(db, pL, WA).level === 'product', 'no layer → global product');
  db.prepare('UPDATE products SET category_id=? WHERE id=?').run(cat, pL);
  db.prepare("UPDATE product_categories SET valuation_level='product' WHERE id=?").run(cat);
  ok(V.levelFor(db, pL, WS).source === 'category' && V.levelFor(db, pL, WS).level === 'product', 'category layer beats warehouse');
  V.setLayerLevel(db, 'products', pL, 'warehouse', { userId: uid });
  ok(V.levelFor(db, pL, WA).source === 'product' && V.levelFor(db, pL, WA).level === 'warehouse', 'product layer beats category');
  const rp = V.resolvePolicy(db, { productId: pL, warehouseId: WA });
  ok(rp.level === 'warehouse' && rp.level_source === 'product', 'resolvePolicy reports level + level_source');
  V.setLayerLevel(db, 'products', pL, '', { userId: uid });
  ok(prod(pL).valuation_level == null, 'empty level → NULL (inherit)');

  const p = mkProduct('MIX');
  buy(p, 10, 100, '1405/07/01', WA);
  buy(p, 10, 200, '1405/07/01', WB);
  buy(p, 10, 400, '1405/07/01', WS);
  const pools = V.productPools(db, p);
  ok(pools.mode === 'mixed' && pools.separate.has(WS) && pools.shared.has(WA), 'productPools: mixed (A,B shared; S separate)');
  ok(V.poolRate(db, p, WA).unit === 150, `shared pool rate (1000+2000)/20 = 150 (got ${V.poolRate(db, p, WA).unit})`);
  ok(V.poolRate(db, p, WS).unit === 400, 'separate pool rate = bucket 400');
  const sA = out(p, 2, '1405/07/02', WA);
  ok(Math.round(sA.amount_rial) === 300, `sale from shared A at pool rate 150 → 300 (got ${sA.amount_rial})`);
  const sS = out(p, 1, '1405/07/02', WS);
  ok(Math.round(sS.amount_rial) === 400, `sale from separate S at own rate 400 (got ${sS.amount_rial})`);
  ok(avg(p) === Math.round((2700 + 3600) / 27), `header stays company-wide avg (got ${avg(p)})`);
  const ex = V.explainEffective(db, { productId: p, warehouseId: WA });
  ok(ex && ex.pool_mode === 'mixed', 'explainEffective shows pool_mode mixed');

  // ── 2) transfers carry the source rate ──
  console.log('\n[2] transfers');
  const t1 = transfer(p, WS, WA, 2, '1405/07/03');
  ok(Math.round(t1.ledOut.amount_rial) === 800 && Math.round(t1.ledIn.amount_rial) === 800, `S→A carries S rate 400 (out ${t1.ledOut.amount_rial}, in ${t1.ledIn.amount_rial})`);
  const shared = V.sharedPoolState(db, p);
  ok(shared.qty === 20 && shared.value_rial === 2700 + 800, `shared pool now 20 qty / 3500 (got ${shared.qty}/${shared.value_rial})`);
  const t2 = transfer(p, WA, WS, 2, '1405/07/04');
  ok(Math.round(t2.ledOut.amount_rial) === 350, `A→S carries shared rate 175 (got ${t2.ledOut.amount_rial})`);
  ok(Math.round(Number(bucket(p, WS).value_rial)) === 2800 + 350, `S bucket = 7×400 + 350 (got ${bucket(p, WS).value_rial})`);
  const t3 = transfer(p, WA, WB, 1, '1405/07/05');
  ok(Math.round(t3.ledOut.amount_rial) === Math.round(V.sharedPoolState(db, p).avg_rial), 'shared → shared transfer at the shared rate (value-neutral)');

  // ── 9) last purchase from the same pool ──
  console.log('\n[9] last purchase per pool');
  buy(p, 1, 160, '1405/07/06', WA);
  buy(p, 1, 900, '1405/07/07', WS);
  ok(V.lastPurchaseUnitForPool(db, p, WA) === 160, 'shared pool last purchase 160 (ignores later S purchase)');
  ok(V.lastPurchaseUnitForPool(db, p, WS) === 900, 'separate pool last purchase 900');
  const pv = R.preview(db, { mode: 'manual', basis: 'last_purchase', product_ids: [p], date: '1405/07/08' });
  const l0 = pv.lines.find((l) => l.warehouse_id === 0);
  const lS = pv.lines.find((l) => l.warehouse_id === WS);
  ok(l0 && l0.new_unit_rial === 160, 'preview last_purchase: shared key → 160', l0);
  ok(lS && lS.new_unit_rial === 900, 'preview last_purchase: S key → 900', lS);
  const posted = R.post(db, { mode: 'manual', basis: 'last_purchase', product_ids: [p], date: '1405/07/08', preview_hash: pv.hash }, user);
  ok(posted && posted.id, 'post last_purchase revaluation');
  ok(V.poolRate(db, p, WA).unit === 160, `shared rate now 160 (got ${V.poolRate(db, p, WA).unit})`);
  ok(V.poolRate(db, p, WS).unit === 900, `S rate now 900 (got ${V.poolRate(db, p, WS).unit})`);
  R.reverse(db, posted.id, user, { reason: 'تست' });
  ok(V.poolRate(db, p, WS).unit !== 900, 'reverse restores pool rates');
}
// back to a single shared pool so later sections are not mixed
db.prepare('UPDATE warehouses SET valuation_level=NULL WHERE id=?').run(WS);

// ── 5) production close FG spread ──────────────────────────────────────────
{
  console.log('\n[5] production close FG spread');
  const C = require('../lib/production/close');
  const f1 = mkProduct('FG-1', { item_type: 'finished' });
  const f2 = mkProduct('FG-2', { item_type: 'finished' });
  buy(f2, 5, 1000, '1405/06/10', W0);
  L.postInventoryMovement(db, {
    eventType: 'production_receipt', productId: f1, warehouseId: W0, qtyIn: 10, unitCostRial: 1000,
    sourceType: 'production_order', sourceId: 1, date: '1405/04/05', createdBy: uid,
  });
  out(f1, 4, '1405/04/06', W0);
  const plan = C.previewFgAverages(db, { fgShareRial: 10000, period: '1405/04' });
  const u1 = plan.find((u) => u.product_id === f1);
  ok(plan.length === 1 && u1, 'spread only over FG produced in the period', plan);
  ok(u1 && u1.delta_rial === 6000 && u1.cogs_rial === 4000, 'in-stock 6/10 → 6000 inventory, sold 4/10 → 4000 COGS', u1);
  const upd = C.updateFgAverages(db, { fgShareRial: 10000, period: '1405/04', plan });
  ok(upd.find((u) => u.product_id === f1).ledger_id, 'value row posted for produced FG');
  ok(avg(f1) === 2000, `FG-1 avg (6×1000+6000)/6 = 2000 (got ${avg(f1)})`);
  ok(avg(f2) === 1000, 'FG-2 (not produced in period) untouched');
  const legacy = C.previewFgAverages(db, { fgShareRial: 1000, period: '1405/03' });
  ok(legacy.length >= 2 && legacy.every((u) => !u.basis), 'no production in period → legacy spread over on-hand FG');
  const src = fs.readFileSync(path.join(__dirname, '../lib/production/close.js'), 'utf8');
  ok(/soldShift/.test(src) && /allocation\.total\.cogs_rial \+= soldShift/.test(src), 'execute shifts sold share into PRD-23 COGS');
}

// ── 6) rule schedules ──────────────────────────────────────────────────────
{
  console.log('\n[6] schedules');
  const sch = R.normalizeSchedule({ mode: 'weekly', weekdays: [0, 3, 9], hour: 10, minute: 30 });
  ok(sch.mode === 'weekly' && sch.weekdays.join(',') === '0,3' && sch.hour === 10 && sch.minute === 30, 'normalize weekly (drops invalid weekday)', sch);
  ok(throwsCode(() => R.normalizeSchedule({ mode: 'monthly', monthdays: [] }), ['E_RULE_SCHEDULE']) === 'E_RULE_SCHEDULE', 'monthly without days rejected');
  ok(R.normalizeSchedule('daily').mode === 'daily', 'legacy string accepted');
  const sat = new Date(2026, 9, 24, 10, 31); // Saturday = شنبه, 1405/08/02
  ok(R.slotFor(sch, sat) === '1405/08/02 10:30', `weekly slot on Saturday (got ${R.slotFor(sch, sat)})`);
  ok(R.slotFor(sch, new Date(2026, 9, 24, 10, 29)) === null, 'before scheduled time → no slot');
  ok(R.slotFor(sch, new Date(2026, 9, 25, 11, 0)) === null, 'Sunday not in weekdays → no slot');
  const mon = R.normalizeSchedule({ mode: 'monthly', monthdays: [31], hour: 0, minute: 0 });
  ok(R.slotFor(mon, new Date(2026, 10, 21, 1, 0)) === '1405/08/30 00:00', 'monthday 31 → last day of a 30-day month');

  db.prepare("INSERT INTO inventory_revaluation_rules (name, triggers_json, basis, schedule, schedule_json) VALUES ('قدیمی','[\"schedule\"]','percent','weekly',NULL)").run();
  R.migrateRuleSchedulesV522(db);
  const mig = db.prepare("SELECT schedule_json FROM inventory_revaluation_rules WHERE name='قدیمی'").get();
  ok(mig && JSON.parse(mig.schedule_json).mode === 'weekly' && JSON.parse(mig.schedule_json).weekdays[0] === 0, 'migration: weekly → {mode weekly, weekdays [0]}');
  db.prepare("UPDATE inventory_revaluation_rules SET enabled=0 WHERE name='قدیمی'").run();

  const pr = mkProduct('SCH');
  buy(pr, 10, 1000, '1405/07/01', W0);
  const rule = R.createRule(db, {
    name: 'روزانه ۱۰٪', triggers: ['schedule'], basis: 'percent', percent: 10, product_ids: [pr],
    action: 'auto_post', schedule_json: { mode: 'daily', hour: 9, minute: 0 },
  }, user);
  ok(rule.schedule === 'daily' && rule.schedule_obj.hour === 9, 'rule stores schedule_json', rule.schedule_obj);
  const r1 = R.maybeRunScheduledRules(db, { now: new Date(2026, 9, 24, 8, 55) });
  ok(!r1.runs.some((x) => x.rule_id === rule.id), 'before 09:00 → not due');
  const r2 = R.maybeRunScheduledRules(db, { now: new Date(2026, 9, 24, 9, 5) });
  ok(r2.runs.some((x) => x.rule_id === rule.id && x.decision === 'posted'), 'after 09:00 → posted once', r2.runs);
  ok(avg(pr) === 1100, `percent rule applied (got ${avg(pr)})`);
  const r3 = R.maybeRunScheduledRules(db, { now: new Date(2026, 9, 24, 9, 10) });
  ok(!r3.runs.some((x) => x.rule_id === rule.id), 'same slot → not run again');
  ok(db.prepare('SELECT last_run_slot s FROM inventory_revaluation_rules WHERE id=?').get(rule.id).s === '1405/08/02 09:00', 'last_run_slot stored');
  const r4 = R.maybeRunScheduledRules(db, { now: new Date(2026, 9, 25, 9, 1) });
  ok(r4.runs.some((x) => x.rule_id === rule.id), 'next day → due again');
  R.toggleRule(db, rule.id, false);
}

// ── 7) monthly lock ────────────────────────────────────────────────────────
{
  console.log('\n[7] monthly lock');
  const p = mkProduct('LOCK');
  buy(p, 10, 100, '1405/05/01', W0);
  ok(throwsCode(() => PL.closePeriod(db, '1405/05', user, { reason: '' }), ['E_REASON_REQUIRED']) === 'E_REASON_REQUIRED', 'close requires reason');
  PL.closePeriod(db, '1405/05', user, { reason: 'بستن ماه مرداد' });
  ok(PL.isPeriodLocked(db, '1405/05/20'), 'period 1405/05 locked');
  ok(PL.listPeriods(db).some((r) => r.period === '1405/05' && r.status === 'closed'), 'listPeriods shows closed month');
  ok(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE entity='inventory_period_lock'").get().c >= 1, 'close audited');
  ok(throwsCode(() => V.postValueAdjustment(db, { productId: p, deltaRial: 100, date: '1405/05/20' }), ['E_INV_PERIOD_LOCKED']) === 'E_INV_PERIOD_LOCKED', 'value adjustment inside closed month → E_INV_PERIOD_LOCKED');
  const lockErr = (() => { try { V.postValueAdjustment(db, { productId: p, deltaRial: 100, date: '1405/05/20' }); return null; } catch (e) { return e; } })();
  ok(lockErr && lockErr.status === 422 && lockErr.extra && lockErr.extra.period === '1405/05', '422 with period');
  ok(throwsCode(() => R.preview(db, { mode: 'manual', basis: 'percent', percent: 5, product_ids: [p], date: '1405/05/25' }), ['E_INV_PERIOD_LOCKED']) === 'E_INV_PERIOD_LOCKED', 'manual revaluation inside closed month rejected');
  const auto = R.preview(db, { mode: 'auto', basis: 'percent', percent: 5, product_ids: [p], date: '1405/05/25' });
  ok(auto.date === '1405/06/01', `auto revaluation re-dated to first open day (got ${auto.date})`);
  ok(PL.firstOpenDate(db, '1405/05/10') === '1405/06/01', 'firstOpenDate');
  const qty = out(p, 1, '1405/05/21', W0);
  ok(qty && qty.id, 'ordinary sale inside closed month still allowed (not blocked this wave)');
  PL.reopenPeriod(db, '1405/05', user, { reason: 'اصلاح سند' });
  ok(!PL.isPeriodLocked(db, '1405/05/20'), 'reopen unlocks');
  const res = V.postValueAdjustment(db, { productId: p, deltaRial: 90, date: '1405/05/20' });
  ok(res.ledger_id, 'after reopen value adjustment posts');
  PL.closePeriod(db, '1405/05', user, { reason: 'بستن مجدد' });
  L.reverseInventoryMovement(db, res.ledger_id, { createdBy: uid, note: 'ابطال' });
  const rev = db.prepare('SELECT date FROM inventory_ledger WHERE reversed_of=?').get(res.ledger_id);
  ok(rev && rev.date === '1405/06/01', `reversal of a closed-month value row dated first open day (got ${rev && rev.date})`);
  ok(throwsCode(() => VAP.approve(db, 999999, user, {}), ['E_APPROVAL_NOT_FOUND']) === 'E_APPROVAL_NOT_FOUND', 'approve unknown → 404');
  PL.reopenPeriod(db, '1405/05', user, { reason: 'پایان تست' });
}

// ── 8) manual adjustment counter-account by stage + reason ────────────────
{
  console.log('\n[8] adjustment counter-account');
  const raw = acct(db, 'coa_raw_materials').code;
  const wip = acct(db, 'coa_wip').code;
  const fg = acct(db, 'coa_finished_goods').code;
  const m = VA.adjustCounterAccount(db, { inventoryCode: raw, reasonCode: 'shortage' });
  ok(m.stage === 'materials' && /کسری و اضافات انبار/.test(m.name), 'materials → «کسری و اضافات انبار»', m);
  const w = VA.adjustCounterAccount(db, { inventoryCode: wip, reasonCode: 'wastage' });
  ok(w.stage === 'wip' && w.code === acct(db, 'coa_overhead_control').code, 'WIP → overhead control', w);
  const g = VA.adjustCounterAccount(db, { inventoryCode: fg, reasonCode: 'damage' });
  ok(g.stage === 'goods' && g.code === acct(db, 'coa_cogs').code, 'FG/merchandise → COGS', g);
  const lossCode = acct(db, 'coa_inventory_loss').code;
  VA.setReasonAccounts(db, { damage: lossCode });
  const g2 = VA.adjustCounterAccount(db, { inventoryCode: fg, reasonCode: 'damage' });
  ok(g2.code === lossCode && g2.source === 'reason', 'reason mapping overrides stage default');
  ok(throwsCode(() => VA.setReasonAccounts(db, { damage: '000000' }), ['E_ADJUST_REASON_COA']) === 'E_ADJUST_REASON_COA', 'unknown COA rejected');
  ok(throwsCode(() => VA.normReason('bogus'), ['E_ADJUST_REASON']) === 'E_ADJUST_REASON', 'unknown reason rejected');
  const { postInventoryValueAdjustmentJe } = require('../lib/subledger-recon');
  const je = postInventoryValueAdjustmentJe(db, {
    warehouseId: W0, amountRial: -5000, date: '1405/07/10', userId: uid, sourceType: 'inventory_adjust', sourceId: 1,
    counterCode: m.code, counterName: m.name,
  });
  const ln = db.prepare('SELECT * FROM journal_lines WHERE entry_id=? AND account_code=?').get(je, m.code);
  ok(ln && Math.round(Number(ln.debit) * 10) === 5000, 'JE debits the stage/reason counter account', ln);
  const jeDef = postInventoryValueAdjustmentJe(db, { warehouseId: W0, amountRial: 1000, date: '1405/07/10', userId: uid, sourceType: 'inventory_adjust', sourceId: 2 });
  ok(db.prepare('SELECT 1 FROM journal_lines WHERE entry_id=? AND account_code=?').get(jeDef, acct(db, 'coa_adjustment').code), 'no reason → legacy adjustment account');
  const routeSrc = fs.readFileSync(path.join(__dirname, '../routes/inventory.js'), 'utf8');
  ok(/reason_code/.test(routeSrc) && /adjustCounterAccount/.test(routeSrc), '/api/inventory/adjust accepts reason_code');
}

// ── 10) closed month: documents post, value effect needs approval ─────────
{
  console.log('\n[10] closed month → value approval');
  const { postToLedger } = require('../lib/ledger');
  const clearing = VA.clearingAccount(db);
  const variance = VA.priceVarianceAccount(db);
  const inv = L.inventoryAccountForWarehouse(db, W0);
  const ap = acct(db, 'coa_payable');
  const p = mkProduct('CLS-1');
  buy(p, 10, 100, '1405/02/05', W0);
  const invBase = acctBal(inv.code);
  postToLedger(db, { sourceType: 'test_purchase', sourceId: 1, date: '1405/02/05', description: 'خرید اول', createdBy: uid,
    lines: [{ code: inv.code, name: inv.name, debit: 100, credit: 0 }, { code: ap.code, name: ap.name, debit: 0, credit: 100 }] });
  const value = () => Math.round(Number(prod(p).stock) * avg(p));
  const glMatchesLedger = (m) => ok(acctBal(inv.code) - invBase === value(), `${m}: GL inventory = stock value (${acctBal(inv.code) - invBase} vs ${value()})`);
  glMatchesLedger('opening');
  const clr0 = acctBal(clearing.code);
  PL.closePeriod(db, '1405/02', user, { reason: 'بستن اردیبهشت' });

  // a) back-dated purchase into the closed month: posts, value parked
  const mv = buy(p, 10, 200, '1405/02/10', W0);
  ok(mv && mv.id && Number(prod(p).stock) === 20, 'purchase in closed month posts qty (stock 20)');
  ok(mv.amount_rial === 2000 && mv.value_parked_rial === 1000 && mv.ledger_amount_rial === 1000, 'receipt enters at pool avg 100; difference 1000 parked', mv);
  ok(avg(p) === 100, `closed month: avg unchanged 100 (got ${avg(p)})`);
  postToLedger(db, { sourceType: 'test_purchase', sourceId: 2, date: '1405/02/10', description: 'خرید ماه قفل', createdBy: uid,
    lines: [{ code: inv.code, name: inv.name, debit: 200, credit: 0 }, { code: ap.code, name: ap.name, debit: 0, credit: 200 }] });
  let a = VAP.get(db, mv.value_approval_id);
  ok(a.status === 'pending' && a.reason === 'closed_period' && a.total_delta_rial === 1000, 'approval doc pending, reason closed_period, 1000', { s: a.status, r: a.reason, t: a.total_delta_rial });
  ok(a.lines[0].park_je_id && jeBalanced(a.lines[0].park_je_id), 'parking JE posted and balanced');
  ok(acctBal(clearing.code) - clr0 === 1000, 'clearing holds the parked 1000');
  glMatchesLedger('after closed-month purchase');
  ok(db.prepare("SELECT COUNT(*) c FROM app_notifications WHERE kind='value_change_approval' AND title LIKE '%قفل دوره%'").get().c >= 1, 'closed-period notification sent');
  ok(a.period_locked === true && a.next_open_date === '1405/03/01', 'doc reports locked month + next open day', { l: a.period_locked, n: a.next_open_date });

  // b) approve at the original date → lands in the closed month, lock stays closed
  ok(throwsCode(() => VAP.approve(db, a.id, user, { post_date_mode: 'bogus' }), ['E_POST_DATE_MODE']) === 'E_POST_DATE_MODE', 'invalid post_date_mode rejected');
  a = VAP.approve(db, a.id, user, { post_date_mode: 'original' });
  ok(a.status === 'approved' && a.decision_date === '1405/02/10' && a.post_date_mode === 'original', 'approve original: dated 1405/02/10', { d: a.decision_date, m: a.post_date_mode });
  ok(PL.isPeriodLocked(db, '1405/02/10'), 'lock still closed after approval');
  ok(avg(p) === 150, `approve original: avg (2000+1000)/20 = 150 (got ${avg(p)})`);
  const vrow = db.prepare("SELECT date FROM inventory_ledger WHERE source_type='inventory_value_approval' AND source_id=? AND status='posted' ORDER BY id DESC").get(a.id);
  ok(vrow && vrow.date === '1405/02/10', 'value row dated inside the closed month', vrow);
  ok(jeBalanced(a.decision_je_id) && acctBal(clearing.code) === clr0, 'decision JE balanced; clearing back to zero');
  glMatchesLedger('after approve original');

  // c) undo the decision → full reversal, even inside the closed month
  a = VAP.reopen(db, a.id, user, { reason: 'بازبینی' });
  ok(a.status === 'pending' && avg(p) === 100, `reopen: pending, avg back to 100 (got ${avg(p)})`);
  const rrow = db.prepare("SELECT date FROM inventory_ledger WHERE source_type='inventory_value_approval' AND source_id=? AND reversed_of IS NOT NULL ORDER BY id DESC").get(a.id);
  ok(rrow && rrow.date === '1405/02/10', 'reversal row keeps the decision date (closed month)', rrow);
  ok(acctBal(clearing.code) - clr0 === 1000 && PL.isPeriodLocked(db, '1405/02/01'), 'reopen: clearing 1000 again; month still locked');
  glMatchesLedger('after reopen');

  // d) approve at the first day of the next open month
  a = VAP.approve(db, a.id, user, { post_date_mode: 'next_open' });
  ok(a.decision_date === '1405/03/01' && a.post_date_mode === 'next_open' && avg(p) === 150, 'approve next_open: dated 1405/03/01, avg 150', { d: a.decision_date });
  glMatchesLedger('after approve next_open');
  a = VAP.reopen(db, a.id, user, { reason: 'تست رد' });
  ok(avg(p) === 100, 'reopen next_open decision: avg 100');

  // e) reject → variance, rate unchanged; undo restores
  const var0 = acctBal(variance.code);
  a = VAP.reject(db, a.id, user, {});
  ok(a.status === 'rejected' && a.decision_date === '1405/02/10' && avg(p) === 100, 'reject (default original date): rate unchanged');
  ok(acctBal(variance.code) - var0 === 1000 && acctBal(clearing.code) === clr0, 'reject: «انحراف بها» +1000, clearing zero');
  glMatchesLedger('after reject');
  a = VAP.reopen(db, a.id, user, { reason: 'برگشت رد' });
  ok(acctBal(variance.code) === var0 && acctBal(clearing.code) - clr0 === 1000, 'reopen reject: variance restored, clearing 1000');

  // f) landed cost dated in the closed month: nothing sold, still parked
  const d1 = LC.createLandedCostDoc(db, { date: '1405/02/12', lines: [{ cost_type: 'freight', amount_rial: 2000 }], createdBy: uid });
  const r1 = LC.allocateAndPost(db, d1.id, [{ product_id: p, warehouse_id: W0, qty: 20, base_value_rial: 2000 }], { createdBy: uid, date: '1405/02/12' });
  ok(r1.value_approval && VAP.get(db, r1.value_approval.id).reason === 'closed_period' && avg(p) === 100, 'landed cost in closed month → closed_period approval, avg unchanged');
  ok(acctBal(clearing.code) - clr0 === 3000, 'clearing 1000 + 2000');
  LC.voidLandedCost(db, d1.id, { createdBy: uid, reason: 'ابطال تست' });
  ok(VAP.get(db, r1.value_approval.id).status === 'cancelled' && acctBal(clearing.code) - clr0 === 1000, 'landed cost void → approval cancelled, clearing back to 1000');

  // g) manual IRV still blocked; direct value adjustment still 422
  ok(throwsCode(() => R.preview(db, { mode: 'manual', basis: 'percent', percent: 5, product_ids: [p], date: '1405/02/20' }), ['E_INV_PERIOD_LOCKED']) === 'E_INV_PERIOD_LOCKED', 'manual IRV in closed month still blocked');

  // h) source receipt reversed → approval cancelled, parking JE reversed (R13)
  L.reverseInventoryMovement(db, mv.id, { createdBy: uid, note: 'ابطال خرید' });
  a = VAP.get(db, mv.value_approval_id);
  ok(a.status === 'cancelled' && a.lines[0].status === 'cancelled', 'receipt reversal → approval cancelled', { s: a.status });
  ok(acctBal(clearing.code) === clr0, 'parking JE reversed: clearing zero');
  ok(Number(prod(p).stock) === 10 && avg(p) === 100, 'stock 10 @ 100 after reversal');

  // i) decided doc + source reversal → decision undone first
  const mv2 = buy(p, 10, 300, '1405/02/15', W0);
  VAP.approve(db, mv2.value_approval_id, user, {});
  ok(avg(p) === 200, `approve default (original): avg (1000+3000)/20 = 200 (got ${avg(p)})`);
  L.reverseInventoryMovement(db, mv2.id, { createdBy: uid, note: 'ابطال خرید ۲' });
  ok(VAP.get(db, mv2.value_approval_id).status === 'cancelled' && avg(p) === 100 && acctBal(clearing.code) === clr0,
    `approved receipt reversed → decision undone, avg 100, clearing zero (avg ${avg(p)})`);

  // j) permission: approve needs acc_inv_valuation.approve
  const routes = require('../routes/inventory-valuation');
  const layer = routes.stack.find((l) => l.route && l.route.path === '/approvals/:id/approve');
  const gateFn = layer && layer.route.stack.map((s) => s.handle).find((h) => /requireValuationAction/.test(h.toString()));
  const callGate = (u) => {
    let status = 200; let body = null; let nexted = false;
    const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
    gateFn({ user: u, params: { id: 1 }, body: {} }, res, () => { nexted = true; });
    return { status, body, nexted };
  };
  const denied = gateFn ? callGate({ id: uid, role: 'sales' }) : null;
  ok(denied && denied.status === 403 && denied.body && denied.body.code === 'E_VALUATION_FORBIDDEN' && !denied.nexted, 'user without approve → 403 E_VALUATION_FORBIDDEN', denied);
  const allowed = gateFn ? callGate({ id: uid, role: 'admin' }) : null;
  ok(allowed && allowed.nexted, 'admin passes the approve gate');
  PL.reopenPeriod(db, '1405/02', user, { reason: 'پایان تست' });
}

// ── routes gate + sync wiring ──────────────────────────────────────────────
{
  console.log('\n[routes/sync]');
  const routes = require('../routes/inventory-valuation');
  const gate = routes.requireValuationAction;
  ok(gate({ user: { role: 'accounting' } }, 'approve') && !gate({ user: { role: 'accounting' } }, 'period_lock'), 'requireValuationAction: accounting approves, cannot lock months');
  ok(gate({ user: { role: 'admin' } }, 'period_lock') && !gate({ user: { role: 'sales' } }, 'post'), 'requireValuationAction: admin locks, sales cannot post');
  const { SYNCABLE_TABLES } = require('../sync/tables');
  const names = SYNCABLE_TABLES.map((t) => t.name);
  ok(['inventory_value_approvals', 'inventory_value_approval_lines', 'inventory_period_locks'].every((n) => names.includes(n)), 'new tables appended to SYNCABLE_TABLES');
  ok(names.indexOf('inventory_period_locks') === names.length - 1, 'appended at the end');
  ok(db.prepare("SELECT value FROM settings WHERE key='sync_seq_backfill_v29'").get()?.value === '1', 'sync_seq_backfill_v29 ran');
}

finish();
