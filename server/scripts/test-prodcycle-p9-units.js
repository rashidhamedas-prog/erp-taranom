/**
 * P9 — واحد طاقه/مواد = واحد خود کالا (یارد برای پارچهٔ مموری).
 * Run: node server/scripts/test-prodcycle-p9-units.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}
function near(a, b, tol = 1e-6) { return Math.abs(Number(a) - Number(b)) < tol; }
function codeOf(fn) { try { fn(); return ''; } catch (e) { return e.code || e.message; } }

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
try { new Function(app); ok(true, 'app.js parses'); } catch (e) { ok(false, 'app.js parses', e.message); }
ok(app.includes('واحد طاقه و مواد = واحد خود کالا (P9)'), 'help: P9 section in renderAdminGuide');
ok(app.includes('function invoiceRollUnitWord'), 'invoice roll panel uses product unit word');
ok(fs.existsSync(path.join(__dirname, 'p9-roll-unit-relabel.js')), 'relabel script exists');

let Database;
try { Database = require('better-sqlite3'); new Database(':memory:').close(); }
catch (e) {
  console.log('  - skip db part:', e.message.split('\n')[0]);
  console.log(`PASS ${pass} FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-p9-units-'));
const dbFile = path.join(dir, 't.db');
process.env.DB_PATH = dbFile;
process.env.SYNC_ROLE = 'central';
process.env.JWT_SECRET = 'test-prodcycle-p9-units-secret-at-least-32b';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.ERP_TEST_ISOLATION = '1';

delete require.cache[require.resolve('../db')];
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();
const uom = require('../lib/uom');
const FR = require('../lib/inventory/fabric-rolls');
const OR = require('../lib/inventory/opening-rolls');
const { resolveLayUnit } = require('../lib/production/lay-unit');
const { rollFabricUnitLabel } = require('../lib/production/cutting');
const { postInventoryMovement } = require('../lib/inventory/ledger');
const relabel = require('./p9-roll-unit-relabel');

const admin = db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get() || db.prepare('SELECT * FROM users LIMIT 1').get();
const raw = db.prepare("SELECT * FROM warehouses WHERE code='WH-RAW' OR warehouse_type='raw_material' OR kind='raw' LIMIT 1").get();
ok(!!(admin && raw), 'admin + WH-RAW');
let sup = db.prepare('SELECT id FROM suppliers LIMIT 1').get();
if (!sup) sup = { id: db.prepare("INSERT INTO suppliers (name, phone, coa_code) VALUES ('تأمین P9', '', '2101')").run().lastInsertRowid };
const unit = (code) => db.prepare('SELECT * FROM units_of_measure WHERE code=?').get(code);
const M = unit('M'); const YD = unit('YD'); const KG = unit('KG'); const G = unit('G'); const PCS = unit('PCS');
ok(!!(M && YD && KG && G && PCS), 'catalog M/YD/KG/G/PCS');
ok(near(YD.factor_to_ref, 0.9144), 'YD = 0.9144 m');

function product(code, unitText, unitId) {
  return Number(db.prepare(`
    INSERT INTO products (user_id, name, code, price, stock, unit, unit_id, average_cost_rial, cost, item_type)
    VALUES (?, ?, ?, 0, 0, ?, ?, 10000, 10000, 'raw')
  `).run(admin.id, 'پارچه ' + code, code, unitText, unitId).lastInsertRowid);
}
const prodRow = (id) => db.prepare('SELECT * FROM products WHERE id=?').get(id);
const batch = (id) => db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(id);
const pY = product('P9-MEMORY', 'یارد', YD.id);
const pKg = product('P9-KG', 'کیلوگرم', KG.id);

let k = 0;
function recv(pid, extra) {
  k += 1;
  return FR.receiveFabricRoll(db, {
    product_id: pid, warehouse_id: raw.id, color: 'مشکی', width_cm: 150, date: '1405/08/10',
    supplier_id: sup.id, idempotency_key: 'p9-' + k, roll_no: 'P9-' + k, ...extra,
  }, admin);
}

// ── 1. yard product, receipt typed in metres → stored in yards ─────────────
const r1 = recv(pY, { profile: 'fabric', entry_unit_id: M.id, entry_qty: 9.144, unit_cost_rial: 100000 });
ok(near(r1.qty_received, 10, 1e-4) && r1.unit === 'yd', '9.144 m → 10 yd stored, token yd', `${r1.qty_received} ${r1.unit}`);
const b1 = batch(r1.id);
ok(Number(b1.entry_unit_id) === Number(M.id) && near(b1.entry_qty, 9.144) && near(b1.entry_factor, 1 / 0.9144, 1e-5), 'entry unit m + factor kept on batch', `${b1.entry_unit_id} ${b1.entry_factor}`);
const r2 = recv(pY, { profile: 'fabric', unit: 'متر', meters: 18.288, unit_cost_rial: 100000 });
ok(near(r2.qty_received, 20, 1e-4) && r2.unit === 'yd', 'legacy {unit:"متر", meters} also converted to yd', r2.qty_received);
const r3 = recv(pY, { profile: 'fabric', entry_unit_id: YD.id, entry_qty: 15, unit_cost_rial: 100000 });
ok(near(r3.qty_received, 15) && r3.unit === 'yd', 'typed in yd stays yd');
const listY = FR.listFabricRolls(db, { product_id: pY });
ok(listY.length === 3 && listY.every((r) => r.unit_label === 'یارد' && Number(r.unit_mismatch) === 0), 'list: unit_label یارد, no mismatch', JSON.stringify(listY.map((r) => r.unit_label)));
const ledIn = db.prepare('SELECT COALESCE(SUM(qty_in),0) q FROM inventory_ledger WHERE product_id=?').get(pY).q;
ok(near(ledIn, 45, 1e-3), 'kardex qty_in in yards (10+20+15)', ledIn);
const circ = FR.listFabricCirculation(db, { product_id: pY, kind: 'all' });
ok(circ.unit_label === 'یارد' && circ.mixed_units === 0 && circ.rows.every((r) => r.unit_label === 'یارد'), 'roll kardex (circulation) labelled یارد');
const layY = resolveLayUnit(db, { batchIds: [r1.id, r3.id], soft: true });
ok(layY.qty_unit === 'yd' && layY.unit_name === 'یارد' && layY.marker_factor === 1, 'lay unit یارد for yard rolls');
ok(rollFabricUnitLabel(db, prodRow(pY)) === 'یارد طاقه', 'cutting message label = یارد طاقه');

// ── 2. mismatch rejected / material conversion ─────────────────────────────
ok(codeOf(() => uom.assertRollUnitMatchesProduct(db, prodRow(pY), 'm')) === 'E_FABRIC_UNIT_MISMATCH', 'assert: m token on yard product rejected');
ok(codeOf(() => uom.assertRollUnitMatchesProduct(db, prodRow(pY), 'yd')) === '', 'assert: yd token accepted');
let msg = '';
try { uom.assertRollUnitMatchesProduct(db, prodRow(pY), 'm'); } catch (e) { msg = e.message; }
ok(/واحد کالا «یارد»/.test(msg) && /متر/.test(msg), 'mismatch message is Persian and names both units', msg);
const pMat = product('P9-ELASTIC', 'کیلوگرم', KG.id);
ok(codeOf(() => recv(pMat, { profile: 'attr', qty: 3, unit: 'عدد', unit_cost_rial: 1000 })) === 'E_FABRIC_UNIT_MISMATCH', 'attr material: «عدد» on kg product rejected');
ok(codeOf(() => recv(pMat, { profile: 'attr', qty: 3, unit: 'یارد', unit_cost_rial: 1000 })) === 'E_FABRIC_UNIT_MISMATCH', 'attr material: cross-dimension unit rejected');
const a1 = recv(pMat, { profile: 'attr', qty: 500, unit: 'گرم', unit_cost_rial: 20 });
ok(near(a1.qty_received, 0.5) && uom.rollTokenMatchesProduct(db, prodRow(pMat), a1.unit), 'attr material: 500 g → 0.5 kg in product unit', `${a1.qty_received} ${a1.unit}`);
ok(Number(batch(a1.id).entry_unit_id) === Number(G.id) && near(batch(a1.id).entry_factor, 0.001), 'attr material: entry unit g kept');
const a2 = recv(pMat, { profile: 'attr', qty: 2, unit_cost_rial: 1000 });
ok(near(a2.qty_received, 2) && a2.unit === 'کیلوگرم', 'attr material without unit keeps product unit text');

// ── 3. P7 opening rolls: typed in m → yd; stale draft rejected at post ─────
const line = OR.normalizeLine(db, {
  product_id: pY, warehouse_id: raw.id, entry_unit_id: M.id, unit_cost_rial: 90000,
  rolls: [{ roll_no: 'OP-P9-1', color: 'مشکی', entry_qty: 9.144 }],
}, 0);
ok(line.rolls[0].unit === 'yd' && near(line.rolls[0].stock_qty, 10, 1e-3) && near(line.qty, 10, 1e-3), 'opening line: 9.144 m → 10 yd', JSON.stringify(line.rolls[0]));
ok(codeOf(() => OR.normalizeLine(db, {
  product_id: pMat, warehouse_id: raw.id, profile: 'attr', unit: 'عدد', unit_cost_rial: 1000,
  rolls: [{ qty: 3 }],
}, 0)) === 'E_FABRIC_UNIT_MISMATCH', 'opening attr line with foreign unit rejected');
const jeBefore = db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c;
ok(codeOf(() => OR.postRollsLine(db, {
  doc: { id: 999, doc_no: 'OP-T' },
  row: { profile: 'fabric', rolls_json: JSON.stringify([{ roll_no: 'OP-STALE', color: 'x', unit: 'm', stock_qty: 5, amount_rial: 5000 }]) },
  l: { product_id: pY, warehouse_id: raw.id }, date: '1405/01/01', user: admin, source: 'opening_stock_doc',
})) === 'E_FABRIC_UNIT_MISMATCH', 'opening post: stale «m» roll on yard product rejected');
ok(!db.prepare("SELECT 1 FROM inventory_batches WHERE batch_no='OP-STALE'").get() && db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c === jeBefore, 'rejected opening post wrote nothing');

// ── 4. kg fabric unaffected ────────────────────────────────────────────────
const rk = recv(pKg, { profile: 'fabric', meters: 12, unit_cost_rial: 5000 });
ok(rk.unit === 'kg' && near(rk.qty_received, 12), 'kg fabric roll stays kg');
const lk = FR.listFabricRolls(db, { product_id: pKg });
ok(lk.length === 1 && lk[0].unit_label === 'کیلوگرم' && Number(lk[0].unit_mismatch) === 0, 'kg list label کیلوگرم');
const layK = resolveLayUnit(db, { batchIds: [rk.id], markerFactor: 0.3 });
ok(layK.qty_unit === 'kg' && layK.marker_unit === 'm' && near(layK.marker_factor, 0.3), 'kg lay: marker in m, factor to kg');
ok(rollFabricUnitLabel(db, prodRow(pKg)) === 'کیلوگرم طاقه', 'kg cutting label');

// ── 5. legacy mislabelled yard rolls (prod 333 pattern) + relabel script ───
function legacyRoll(pid, qty, unitToken, extra = {}) {
  const no = 'LEG-' + (++k);
  const bid = Number(db.prepare(`
    INSERT INTO inventory_batches (batch_no, product_id, warehouse_id, qty_on_hand, qty_received, status, kind, unit,
      unit_cost_rial, color, width_cm, entry_unit_id, entry_qty, entry_factor, source_type, source_id)
    VALUES (?,?,?,?,?,'active','fabric',?,3623357,'مشکی',150,?,?,?,'opening_v_test',NULL)
  `).run(no, pid, raw.id, qty, qty, unitToken, extra.entry_unit_id || null, extra.entry_qty || null, extra.entry_factor || null).lastInsertRowid);
  const led = postInventoryMovement(db, {
    eventType: 'opening', productId: pid, warehouseId: raw.id, qtyIn: qty, unitCostRial: 3623357,
    amountRial: Math.round(qty * 3623357), sourceType: 'opening_p9_test', sourceId: bid, batchId: bid,
    date: '1405/01/01', note: 'P9 legacy roll', createdBy: admin.id,
  });
  db.prepare('UPDATE inventory_batches SET ledger_id=? WHERE id=?').run(led.id, bid);
  return bid;
}
const pLeg = product('P9-333', 'یارد', YD.id);
const L1 = legacyRoll(pLeg, 8.72, 'm');
const L2 = legacyRoll(pLeg, 5.01, 'm');
const pConv = product('P9-CONV', 'یارد', YD.id);
const C1 = legacyRoll(pConv, 10, 'm', { entry_unit_id: M.id, entry_qty: 10, entry_factor: 1 });
const pKgLeg = product('P9-KGLEG', 'کیلوگرم', KG.id);
const K1 = legacyRoll(pKgLeg, 7, 'm');

const listLeg = FR.listFabricRolls(db, { product_id: pLeg });
ok(listLeg.every((r) => r.unit_label === 'یارد' && r.batch_unit_label === 'متر' && Number(r.unit_mismatch) === 1), 'legacy roll: shown in یارد, flagged, stored label متر');
const layLeg = resolveLayUnit(db, { batchIds: [L1, L2], soft: true });
ok(layLeg.qty_unit === 'yd' && layLeg.label_mismatch_batch_ids.length === 2, 'legacy roll: lay consumes in yd (product unit), label flagged');
const pOther = product('P9-OTHER-M', 'متر', M.id);
const oRoll = recv(pOther, { profile: 'fabric', meters: 5, unit_cost_rial: 1000 });
ok(codeOf(() => resolveLayUnit(db, { batchIds: [L1, oRoll.id] })) === 'E_CUT_ROLL_UNIT', 'lay mixing yd and m products still rejected');

const rows = relabel.scan(db, {});
const byBatch = new Map(rows.map((r) => [r.batch_id, r]));
ok(byBatch.get(L1) && byBatch.get(L1).classification === 'relabel' && byBatch.get(L1).proposed_new_unit === 'yd'
  && byBatch.get(L1).qty_change === 0 && byBatch.get(L1).amount_change === 0, 'scan: 333-pattern → relabel m→yd, qty/amount unchanged');
ok(byBatch.get(C1) && byBatch.get(C1).classification === 'conversion_needed' && !byBatch.get(C1).proposed_new_unit, 'scan: unconverted metre entry → conversion_needed (no silent relabel)', byBatch.get(C1) && byBatch.get(C1).issues);
ok(byBatch.get(K1) && byBatch.get(K1).classification === 'review_cross_dimension', 'scan: m on kg without purchase evidence → review_cross_dimension');
ok(!byBatch.has(r1.id) && !byBatch.has(rk.id) && !byBatch.has(a1.id), 'scan: correct batches not listed');

// CLI dry-run (readonly) on the same file
db.pragma('wal_checkpoint(TRUNCATE)');
const csv = path.join(dir, 'dry.csv');
const relCount0 = db.prepare('SELECT COUNT(*) c FROM fabric_roll_unit_relabels').get().c;
const cli = spawnSync(process.execPath, [path.join(__dirname, 'p9-roll-unit-relabel.js'), '--db=' + dbFile, '--csv=' + csv], { encoding: 'utf8' });
ok(cli.status === 0 && fs.existsSync(csv), 'CLI dry-run exit 0 + CSV written', cli.stderr);
const csvText = fs.existsSync(csv) ? fs.readFileSync(csv, 'utf8') : '';
ok(csvText.includes('classification') && csvText.includes('P9-333') && csvText.includes('conversion_needed'), 'CSV has header + rows');
ok(db.prepare('SELECT COUNT(*) c FROM fabric_roll_unit_relabels').get().c === relCount0 && batch(L1).unit === 'm', 'dry-run wrote nothing');
const cliNo = spawnSync(process.execPath, [path.join(__dirname, 'p9-roll-unit-relabel.js'), '--db=' + dbFile, '--apply', '--product=' + pLeg, '--reason=x'], { encoding: 'utf8' });
ok(cliNo.status === 2 && batch(L1).unit === 'm', 'apply without --i-have-approval refused (exit 2)');

// apply (module, same temp DB)
const snap = (pid) => ({
  led: db.prepare('SELECT COUNT(*) n, COALESCE(SUM(qty_in),0) qi, COALESCE(SUM(amount_rial),0) a FROM inventory_ledger WHERE product_id=?').get(pid),
  je: db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c,
  qty: db.prepare('SELECT GROUP_CONCAT(qty_received) q FROM inventory_batches WHERE product_id=?').get(pid).q,
});
const s0 = snap(pLeg);
const res = relabel.applyRelabel(db, { productIds: [pLeg, pConv], reason: 'مالک: عددها یارد است', userId: admin.id });
ok(res.relabeled === 2 && res.batch_ids.includes(L1) && res.batch_ids.includes(L2), 'apply: 2 legacy rolls relabelled', JSON.stringify(res));
ok(res.skipped.some((x) => x.batch_id === C1 && x.classification === 'conversion_needed') && batch(C1).unit === 'm', 'apply: conversion_needed batch untouched');
ok(batch(L1).unit === 'yd' && Number(batch(L1).entry_unit_id) === Number(YD.id) && near(batch(L1).entry_factor, 1) && near(batch(L1).entry_qty, 8.72), 'apply: unit yd + entry YD×1 set');
const s1 = snap(pLeg);
ok(JSON.stringify(s0) === JSON.stringify(s1), 'apply: ledger/JE/qty unchanged');
ok(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='p9_roll_unit_relabel'").get().c === 2, 'apply: audit_log rows');
ok(FR.listFabricRolls(db, { product_id: pLeg }).every((r) => Number(r.unit_mismatch) === 0), 'apply: mismatch flag cleared');
ok(!relabel.scan(db, { productIds: [pLeg] }).length, 'apply: re-scan clean');

// reverse
const rev = relabel.reverseRelabel(db, { groupKey: res.group_key, reason: 'آزمون بازگردانی', userId: admin.id });
ok(rev.reversed === 2 && batch(L1).unit === 'm' && batch(L1).entry_unit_id == null && batch(L1).entry_factor == null, 'reverse: label + entry restored');
ok(db.prepare('SELECT COUNT(*) c FROM fabric_roll_unit_relabels WHERE group_key=? AND reversed_at IS NOT NULL').get(res.group_key).c === 2, 'reverse: audit rows marked reversed (no delete)');
ok(JSON.stringify(snap(pLeg)) === JSON.stringify(s0), 'reverse: ledger/JE/qty unchanged');
ok(/nothing to reverse/.test(codeOf(() => relabel.reverseRelabel(db, { groupKey: res.group_key, reason: 'x' }))), 'reverse twice refused');

try { db.close(); } catch (_) { /* ignore */ }
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
console.log(`\nP9 units: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
