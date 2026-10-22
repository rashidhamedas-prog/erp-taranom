'use strict';
/**
 * v521 — موتور ارزش‌گذاری موجودی
 * سیاست (سطح/روش/اولویت)، باکت‌ها، بازیابی منفی، برگشت ورودی بر مبنای ارزش،
 * سطح انبار، postValueAdjustment، بازپخش تاریخ‌گذشته، سند تجدید ارزیابی + ابطال،
 * قواعد خودکار، و ابطال رسید تولید بدون بازگردانی snapshot.
 * Run: node server/scripts/test-inventory-valuation-v521.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-val-v521-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(dir, 't.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.JWT_SECRET = 'test-inv-valuation-v521-secret-32b-xx';
process.env.SYNC_ROLE = 'central';

let passed = 0, failed = 0;
function ok(c, m) {
  if (c) { passed++; console.log('  OK', m); }
  else { failed++; console.error('  FAIL', m); }
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
const { rebuildBaseCoa } = require('../lib/coa-map');

if (!db.prepare('SELECT COUNT(*) c FROM chart_of_accounts').get().c) rebuildBaseCoa(db);
V.ensureValuationSchema(db);

const uid = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()?.id || 1;
const user = { id: uid, role: 'admin' };
const setS = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(k, String(v));
const prod = (id) => db.prepare('SELECT * FROM products WHERE id=?').get(id);
const avg = (id) => Math.round(Number(prod(id).average_cost_rial) || 0);
let seq = 0;
function mkProduct(code, extra = {}) {
  seq++;
  const id = db.prepare(`
    INSERT INTO products (user_id,name,code,stock,average_cost_rial,cost,unit)
    VALUES (?,?,?,?,?,?,'عدد')
  `).run(uid, `کالا ${code}`, code, extra.stock || 0, extra.avg || 0, Math.round((extra.avg || 0) / 10)).lastInsertRowid;
  if (extra.costing_method !== undefined) {
    db.prepare('UPDATE products SET costing_method=? WHERE id=?').run(extra.costing_method, id);
  }
  return id;
}
function mkWarehouse(name, extra = {}) {
  const id = db.prepare("INSERT INTO warehouses (name, warehouse_type) VALUES (?, 'finished_goods')").run(name).lastInsertRowid;
  if (extra.costing_method) db.prepare('UPDATE warehouses SET costing_method=? WHERE id=?').run(extra.costing_method, id);
  return id;
}
function buy(productId, qty, unit, date, warehouseId = null, extra = {}) {
  return L.postInventoryMovement(db, {
    eventType: 'purchase', productId, warehouseId, qtyIn: qty, unitCostRial: unit,
    sourceType: 'purchase', sourceId: 9000 + (++seq), date, createdBy: uid, ...extra,
  });
}
function sell(productId, qty, date, warehouseId = null, extra = {}) {
  return L.postInventoryMovement(db, {
    eventType: 'sale', productId, warehouseId, qtyOut: qty,
    sourceType: 'invoice', sourceId: 8000 + (++seq), date, createdBy: uid, allowNegative: true, ...extra,
  });
}
function pending(productId, reason) {
  return db.prepare(`
    SELECT * FROM inventory_valuation_queue WHERE product_id=? AND status='pending' ${reason ? 'AND reason=?' : ''}
  `).all(...(reason ? [productId, reason] : [productId]));
}
function jeBalance(jeId) {
  return db.prepare(`
    SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c, COUNT(*) n FROM journal_lines WHERE entry_id=?
  `).get(jeId);
}

console.log('\n══ v521 inventory valuation ══\n');

// ── 1) policy + migration ──────────────────────────────────────────────────
{
  const pDef = mkProduct('POL-DEF');
  db.prepare("UPDATE products SET costing_method='moving_average' WHERE id=?").run(pDef);
  setS('valuation_policy_v521_migrated', '');
  db.prepare("DELETE FROM settings WHERE key IN ('costing_method_precedence','inventory_valuation_level')").run();
  setS('costing_scope', 'per-warehouse');
  V.migratePolicyV521(db);
  const pol = V.getPolicy(db);
  ok(pol.precedence === 'warehouse_first', 'migration: costing_scope per-warehouse → warehouse_first');
  ok(pol.level === 'product', 'migration: level defaults to product');
  ok(prod(pDef).costing_method == null, "migration: products.costing_method 'moving_average' → NULL (inherit)");

  const wSpec = mkWarehouse('انبار specific', { costing_method: 'specific' });
  const pFifo = mkProduct('POL-FIFO', { costing_method: 'fifo' });
  let r = V.resolvePolicy(db, { productId: pFifo, warehouseId: wSpec });
  ok(r.method === 'specific' && r.method_source === 'warehouse', 'warehouse_first: warehouse method wins');
  V.setPolicy(db, { precedence: 'product_first' });
  r = V.resolvePolicy(db, { productId: pFifo, warehouseId: wSpec });
  ok(r.method === 'fifo' && r.method_source === 'product', 'product_first: product method wins');
  r = V.resolvePolicy(db, { productId: pDef, warehouseId: wSpec });
  ok(r.method === 'specific', 'product inherit (NULL) falls through to warehouse');
  r = V.resolvePolicy(db, { productId: pDef });
  ok(r.method === 'moving_average' && r.method_source === 'global', 'no override → global moving_average');
  ok(L.costingMethod(db, { productId: pFifo, warehouseId: wSpec }) === 'fifo', 'ledger.costingMethod delegates to resolvePolicy');
  ok(throwsCode(() => V.setPolicy(db, { level: 'bogus' }), ['E_POLICY_LEVEL']) === 'E_POLICY_LEVEL', 'setPolicy rejects bad level');
  const ex = V.explainEffective(db, { productId: pFifo, warehouseId: wSpec });
  ok(ex && ex.policy.method === 'fifo' && ex.effective_outbound_source === 'cost_layers', 'explainEffective returns effective method + outbound source');
}

// ── 2) negative-stock recovery ─────────────────────────────────────────────
{
  const p = mkProduct('NEG', { avg: 100 });
  sell(p, 2, '1405/07/01');
  ok(Number(prod(p).stock) === -2, 'negative: stock -2 after sale with allowNegative');
  buy(p, 5, 120, '1405/07/02');
  ok(avg(p) === 120, `negative: avg after recovery = inbound unit 120 (got ${avg(p)})`);
  const q = pending(p, 'negative_recovery');
  ok(q.length === 1 && Number(q[0].amount_rial) === 40, `negative: queue negative_recovery trueup 40 (got ${q[0] && q[0].amount_rial})`);
}

// ── 3) inbound reversal is value-correct ───────────────────────────────────
{
  const p = mkProduct('REV');
  buy(p, 10, 100, '1405/07/01');
  sell(p, 5, '1405/07/02');
  const p2 = buy(p, 5, 200, '1405/07/03');
  ok(avg(p) === 150, `reversal: avg 150 before reversal (got ${avg(p)})`);
  L.reverseInventoryMovement(db, p2.id, { createdBy: uid });
  ok(Number(prod(p).stock) === 5 && avg(p) === 100, `reversal: avg back to 100 by value (got ${avg(p)})`);
}

// ── 4) warehouse level: bucket outbound + transfer moves value ────────────
{
  V.setPolicy(db, { level: 'warehouse' });
  const wA = mkWarehouse('انبار A');
  const wB = mkWarehouse('انبار B');
  const p = mkProduct('WH');
  buy(p, 10, 100, '1405/07/01', wA);
  buy(p, 10, 300, '1405/07/01', wB);
  ok(avg(p) === 200, 'warehouse: header avg 200 (blended)');
  const bA = V.getBucket(db, p, wA);
  const bB = V.getBucket(db, p, wB);
  ok(bA && Number(bA.avg_rial) === 100 && bB && Number(bB.avg_rial) === 300, 'warehouse: bucket avgs 100 / 300');
  const s = sell(p, 2, '1405/07/02', wA);
  ok(s.amount_rial === 200 && s.unit_cost_rial === 100, `warehouse: outbound from A costed at bucket avg (got ${s.unit_cost_rial})`);
  const out = L.postInventoryMovement(db, {
    eventType: 'transfer_out', productId: p, warehouseId: wB, qtyOut: 4,
    sourceType: 'warehouse_transfer', sourceId: 1, date: '1405/07/03', createdBy: uid,
  });
  ok(out.amount_rial === 1200, `warehouse: transfer_out from B at 300 (got ${out.amount_rial})`);
  L.postInventoryMovement(db, {
    eventType: 'transfer_in', productId: p, warehouseId: wA, qtyIn: 4, amountRial: out.amount_rial,
    unitCostRial: out.unit_cost_rial, sourceType: 'warehouse_transfer', sourceId: 1, date: '1405/07/03', createdBy: uid,
  });
  const a2 = V.getBucket(db, p, wA);
  const b2 = V.getBucket(db, p, wB);
  ok(Number(a2.qty) === 12 && Number(a2.value_rial) === 2000, `warehouse: A = 12 / 2000 (got ${a2.qty}/${a2.value_rial})`);
  ok(Number(b2.qty) === 6 && Number(b2.value_rial) === 1800, `warehouse: B = 6 / 1800 (got ${b2.qty}/${b2.value_rial})`);
  const before = JSON.stringify(V.listBuckets(db, { productId: p }).map((b) => [b.warehouse_id, b.qty, b.value_rial, b.avg_rial]));
  V.rebuildBuckets(db, { productId: p });
  const after = JSON.stringify(V.listBuckets(db, { productId: p }).map((b) => [b.warehouse_id, b.qty, b.value_rial, b.avg_rial]));
  ok(before === after, 'warehouse: rebuildBuckets == incremental buckets');
  V.setPolicy(db, { level: 'product' });
}

// ── 5) postValueAdjustment ─────────────────────────────────────────────────
{
  const p = mkProduct('VAL');
  buy(p, 10, 100, '1405/07/01');
  const r = V.postValueAdjustment(db, { productId: p, deltaRial: 500, date: '1405/07/02', sourceType: 'test_value', sourceId: 1 });
  ok(r.applied_rial === 500 && r.unapplied_rial === 0 && avg(p) === 150, `value adj qty>0: avg 150 (got ${avg(p)})`);
  const z = mkProduct('VAL0');
  const r0 = V.postValueAdjustment(db, { productId: z, deltaRial: 300, date: '1405/07/02', sourceType: 'test_value', sourceId: 2 });
  ok(r0.applied_rial === 0 && r0.unapplied_rial === 300 && avg(z) === 0, 'value adj qty≤0: nothing applied, unapplied 300');
  ok(pending(z, 'value_change_after_sale').length === 1, 'value adj qty≤0: queued value_change_after_sale');
  L.reverseInventoryMovement(db, r.ledger_id, { createdBy: uid });
  ok(avg(p) === 100, `value adj reversal restores avg 100 (got ${avg(p)})`);
}

// ── 6) back-dated receipt → previewReplay + replay revaluation ────────────
let replayProduct;
{
  const p = mkProduct('BACK');
  replayProduct = p;
  buy(p, 10, 100, '1405/07/01');
  sell(p, 5, '1405/07/05');
  buy(p, 10, 400, '1405/07/03');
  ok(avg(p) === 300, `back-dated: actual avg 300 (got ${avg(p)})`);
  ok(pending(p, 'back_dated').length === 1, 'back-dated: queued back_dated');
  const pr = V.previewReplay(db, { productId: p, fromDate: '1405/07/03' });
  const sale = pr.lines.find((l) => l.event_type === 'sale');
  ok(sale && sale.delta_rial === 750 && sale.new_amount_rial === 1250, `replay: sale re-costed 500 → 1250 (got ${sale && sale.delta_rial})`);
  ok(sale && sale.counter_code === require('../lib/coa-map').acct(db, 'coa_cogs').code, 'replay: counter is COGS');
  ok(pr.keys[0] && pr.keys[0].onhand_delta_rial === -750, `replay: on-hand delta -750 (got ${pr.keys[0] && pr.keys[0].onhand_delta_rial})`);

  const pv = R.preview(db, { basis: 'replay', product_ids: [p], date: '1405/07/10' });
  ok(pv.lines.length === 1 && pv.lines[0].delta_cogs_rial === 750, 'replay preview: COGS +750');
  const doc = R.post(db, { basis: 'replay', product_ids: [p], date: '1405/07/10', preview_hash: pv.hash }, user);
  ok(doc && doc.status === 'posted' && doc.je_id, 'replay post: document + JE');
  const bal = jeBalance(doc.je_id);
  ok(bal.n >= 2 && Math.abs(bal.d - bal.c) < 1e-6 && bal.d > 0, 'replay post: JE balanced');
  ok(avg(p) === 250, `replay post: avg corrected to 250 (got ${avg(p)})`);
  ok(pending(p).length === 0, 'replay post: queue cleared');
  const again = R.preview(db, { basis: 'replay', product_ids: [p], date: '1405/07/10' });
  ok(again.lines.length === 0, 'replay: second preview has nothing (adjustments counted)');
  R.reverse(db, doc.id, user, { reason: 'تست' });
  ok(avg(p) === 300, `replay reverse: avg back to 300 (got ${avg(p)})`);
  const je = db.prepare('SELECT * FROM journal_entries WHERE id=?').get(doc.je_id);
  ok(je && (je.status === 'reversed' || Number(je.deleted_at) > 0), 'replay reverse: JE voided');
  ok(pending(p).length >= 1, 'replay reverse: queue back to pending');
}

// ── 7) manual_unit revaluation + reverse + idempotency ─────────────────────
{
  const p = mkProduct('MAN');
  buy(p, 10, 100, '1405/07/01');
  const body = { basis: 'manual_unit', product_ids: [p], unit_cost_rial: 130, date: '1405/07/10' };
  ok(throwsCode(() => R.preview(db, { basis: 'manual_unit', date: '1405/07/10', unit_cost_rial: 1 }), ['E_SCOPE_REQUIRED']) === 'E_SCOPE_REQUIRED', 'manual: scope required');
  const pv = R.preview(db, body);
  ok(pv.lines.length === 1 && pv.delta_inventory_rial === 300, 'manual preview: +300');
  const doc = R.post(db, { ...body, preview_hash: pv.hash }, user);
  ok(avg(p) === 130, `manual post: avg 130 (got ${avg(p)})`);
  const bal = jeBalance(doc.je_id);
  ok(bal.n === 2 && Math.abs(bal.d - bal.c) < 1e-6 && bal.d > 0, 'manual post: JE balanced (2 lines)');
  const vrow = db.prepare(`
    SELECT * FROM inventory_ledger WHERE source_type='inventory_revaluation' AND source_id=? AND status='posted'
  `).get(doc.id);
  ok(vrow && Number(vrow.amount_rial) === 300 && Number(vrow.qty_in) === 0 && vrow.je_id === doc.je_id, 'manual post: value row 300 linked to JE');
  const dupCode = throwsCode(() => R.post(db, { ...body, preview_hash: pv.hash }, user),
    ['E_PREVIEW_STALE', 'E_DUPLICATE_REVALUATION', 'E_NO_LINES']);
  ok(dupCode && !dupCode.startsWith('unexpected'), `manual: double post rejected (${dupCode})`);
  ok(db.prepare("SELECT COUNT(*) c FROM inventory_revaluations WHERE scope_json LIKE ?").get(`%[${p}]%`).c === 1, 'manual: still one document');
  R.reverse(db, doc.id, user, {});
  ok(avg(p) === 100, `manual reverse: avg 100 (got ${avg(p)})`);
  const je = db.prepare('SELECT * FROM journal_entries WHERE id=?').get(doc.je_id);
  ok(je && (je.status === 'reversed' || Number(je.deleted_at) > 0), 'manual reverse: JE voided');
  ok(throwsCode(() => R.reverse(db, doc.id, user, {}), ['E_ALREADY_REVERSED']) === 'E_ALREADY_REVERSED', 'manual: second reverse rejected');
  const doc2 = R.post(db, body, user);
  ok(doc2 && doc2.status === 'posted', 'manual: same revaluation may be re-posted after reversal');
  R.reverse(db, doc2.id, user, {});
}

// ── 8) auto rules ──────────────────────────────────────────────────────────
{
  const p = mkProduct('AUTO');
  buy(p, 10, 100, '1405/07/01');
  sell(p, 4, '1405/07/05');
  buy(p, 10, 200, '1405/07/03');
  ok(pending(p, 'back_dated').length === 1, 'auto: back_dated queued');
  ok(throwsCode(() => R.createRule(db, { name: 'x', triggers: ['back_dated'], basis: 'percent', percent: 5 }, user), ['E_RULE_TRIGGER']) === 'E_RULE_TRIGGER',
    'auto: non-replay rule without schedule rejected');
  const rule = R.createRule(db, { name: 'بازپخش AUTO', triggers: ['back_dated'], basis: 'replay', action: 'review', product_ids: [p] }, user);
  let run = R.runAutoRules(db, { dryRun: true, ruleId: rule.id });
  ok(run.runs[0] && run.runs[0].decision === 'needs_review', `auto: review rule without threshold → needs_review (got ${run.runs[0] && run.runs[0].decision})`);
  R.updateRule(db, rule.id, { action: 'auto_post' });
  run = R.runAutoRules(db, { dryRun: true, ruleId: rule.id });
  ok(run.runs[0] && run.runs[0].decision === 'would_post', 'auto: dry-run auto_post → would_post');
  ok(pending(p).length >= 1 && db.prepare('SELECT COUNT(*) c FROM inventory_revaluations WHERE rule_id=?').get(rule.id).c === 0, 'auto: dry-run writes nothing');
  run = R.runAutoRules(db, { dryRun: false, ruleId: rule.id, user });
  ok(run.runs[0] && run.runs[0].decision === 'posted', `auto: auto_post → posted (got ${run.runs[0] && run.runs[0].decision} ${run.runs[0] && run.runs[0].error || ''})`);
  ok(pending(p).length === 0, 'auto: queue cleared after post');
  R.toggleRule(db, rule.id, false);
  const sched = R.maybeRunScheduledRules(db);
  ok(sched && Array.isArray(sched.runs) && !sched.runs.some((x) => x.rule_id === rule.id), 'auto: disabled rule skipped by scheduler');
}

// ── 9) production receipt void does not restore a stale snapshot ──────────
{
  const { reverseReceiptStock } = require('../lib/production/costing');
  const p = mkProduct('FG');
  buy(p, 10, 100, '1405/07/01');
  L.postInventoryMovement(db, {
    eventType: 'production_receipt', productId: p, qtyIn: 10, unitCostRial: 200,
    sourceType: 'production_receipt', sourceId: 777, date: '1405/07/02', createdBy: uid,
  });
  buy(p, 10, 300, '1405/07/03');
  ok(avg(p) === 200, `receipt void: avg 200 before void (got ${avg(p)})`);
  reverseReceiptStock(db, { productId: p, qty: 10, orderId: 777, prevAvgRial: 100, userId: uid, date: '1405/07/04' });
  ok(Number(prod(p).stock) === 20 && avg(p) === 200, `receipt void: avg by value 200, not snapshot 100 (got ${avg(p)})`);
}

finish();
