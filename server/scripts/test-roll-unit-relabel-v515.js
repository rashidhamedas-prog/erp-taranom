'use strict';
/**
 * v515 — اصلاح برچسب واحد طاقه (طاقهٔ «m» روی پارچهٔ کیلوگرمی، مقدار از قبل به کیلوگرم).
 * Run: node server/scripts/test-roll-unit-relabel-v515.js
 */
const fs = require('fs');
const path = require('path');
const { ok, eq, summary } = require('./lib/test-harness');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// ── static wiring ──────────────────────────────────────────────
{
  const { SYNCABLE_TABLES, FK_COLUMNS } = require('../sync/tables');
  const last = SYNCABLE_TABLES[SYNCABLE_TABLES.length - 1];
  ok('tables.js: fabric_roll_unit_relabels is the last entry', last && last.name === 'fabric_roll_unit_relabels' && last.upsertKey === 'id');
  ok('tables.js: registered once', SYNCABLE_TABLES.filter((t) => t.name === 'fabric_roll_unit_relabels').length === 1);
  ok('tables.js: FK batch_id/product_id', FK_COLUMNS.some(([t, c]) => t === 'fabric_roll_unit_relabels' && c === 'batch_id')
    && FK_COLUMNS.some(([t, c]) => t === 'fabric_roll_unit_relabels' && c === 'product_id'));

  const cap = read('sync/capture.js');
  const iSpecific = cap.indexOf("['/api/inventory/fabric-rolls/relabel-unit', 'fabric_roll_unit_relabels']");
  const iGeneral = cap.indexOf("['/api/inventory/fabric-rolls', 'inventory_batches']");
  ok('capture.js: relabel-unit mapped above fabric-rolls', iSpecific > 0 && iGeneral > 0 && iSpecific < iGeneral);
  try {
    const { tableForPath } = require('../sync/capture');
    ok('tableForPath relabel POST', tableForPath('/api/inventory/fabric-rolls/relabel-unit') === 'fabric_roll_unit_relabels');
    ok('tableForPath relabel undo', tableForPath('/api/inventory/fabric-rolls/relabel-unit/7/undo') === 'fabric_roll_unit_relabels');
    ok('tableForPath roll void unchanged', tableForPath('/api/inventory/fabric-rolls/7/void') === 'inventory_batches');
  } catch (e) {
    if (/bindings|better_sqlite3|NODE_MODULE_VERSION/i.test(String(e.message))) ok('tableForPath skipped (no sqlite)', true);
    else ok('tableForPath', false, e.message);
  }

  const dbSrc = read('db.js');
  const vs = [...dbSrc.matchAll(/sync_seq_backfill_v(\d+)/g)].map((m) => Number(m[1]));
  const maxV = Math.max(...vs);
  ok('db.js: new sync_seq backfill step is the latest', maxV >= 27 && /v27: fabric_roll_unit_relabels/.test(dbSrc), String(maxV));
  ok('schema.js creates fabric_roll_unit_relabels', /CREATE TABLE IF NOT EXISTS fabric_roll_unit_relabels/.test(read('lib/inventory/schema.js')));

  const routes = read('routes/inventory.js');
  const iPrev = routes.indexOf("'/fabric-rolls/relabel-unit/preview'");
  const iUndo = routes.indexOf("'/fabric-rolls/relabel-unit/:id/undo'");
  const iId = routes.indexOf("'/fabric-rolls/:id");
  ok('routes: relabel-unit before /fabric-rolls/:id', iPrev > 0 && iUndo > 0 && iId > 0 && iPrev < iId && iUndo < iId);
  ok('routes: admin/accounting guard', /relabel-unit', auth, adminOrAccounting/.test(routes));

  const app = read('public/app.js');
  try { new Function(app); ok('app.js parses', true); } catch (e) { ok('app.js parses', false, e.message); }
  ok('UI button + modal', app.includes('اصلاح برچسب واحد طاقه‌ها') && app.includes('function fabricRelabelUnitModal')
    && app.includes('/inventory/fabric-rolls/relabel-unit/preview?product_id='));
  ok('UI undo', app.includes("'/inventory/fabric-rolls/relabel-unit/'+id+'/undo'") && app.includes('بازگردانی'));
  ok('help v515 relabel', app.includes('اصلاح برچسب واحد طاقه (v515)'));
}

let dbOk = false;
try {
  const { freshDb } = require('./lib/test-harness');
  const ctx = freshDb();
  const { db, cleanup } = ctx;
  try {
    const relabel = require('../lib/inventory/roll-unit-relabel');
    const { resolveLayUnit } = require('../lib/production/lay-unit');
    const { postCuttingLay, voidCuttingLay } = require('../lib/production/cutting');
    const { postInventoryMovement } = require('../lib/inventory/ledger');
    const { listFabricRolls } = require('../lib/inventory/fabric-rolls');

    const unit = (code) => db.prepare('SELECT * FROM units_of_measure WHERE UPPER(code)=?').get(code);
    const M = unit('M'); const KG = unit('KG');
    ok('catalog M/KG', !!(M && KG));
    const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get();
    const user = { id: admin.id };
    const raw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get();
    if (!db.prepare("SELECT id FROM warehouses WHERE code='WH-WIP'").get()) {
      db.prepare("INSERT INTO warehouses (code,name,kind,warehouse_type,active) VALUES ('WH-WIP','WIP','wip','wip',1)").run();
    }
    if (!db.prepare("SELECT id FROM warehouses WHERE code='WH-SCRAP'").get()) {
      db.prepare("INSERT INTO warehouses (code,name,kind,warehouse_type,active) VALUES ('WH-SCRAP','ضایعات','scrap','scrap',1)").run();
    }

    const fabric = (code, unitText, unitId) => db.prepare(`
      INSERT INTO products (user_id, name, code, price, stock, unit, unit_id, average_cost_rial, cost, item_type)
      VALUES (?, ?, ?, 0, 0, ?, ?, 1000, 1000, 'raw')
    `).run(admin.id, 'پارچه ' + code, code, unitText, unitId).lastInsertRowid;
    let lot = 0;
    // Received in kg (ledger + qty_received) like production, then the label is forced to 'm'.
    const roll = (pid, qty, extra = {}) => {
      lot += 1;
      const bid = db.prepare(`
        INSERT INTO inventory_batches (batch_no, product_id, warehouse_id, qty_on_hand, qty_received, status, kind, unit,
          unit_cost_rial, color, width_cm, entry_unit_id, entry_qty, entry_factor, source_type, source_id)
        VALUES (?,?,?,?,?,'active','fabric','kg',1000,'مشکی',150,?,?,?,?,?)
      `).run('RRU-' + lot, pid, raw.id, qty, qty,
        extra.entry_unit_id || null, extra.entry_qty || null, extra.entry_factor || null,
        extra.source_type || null, extra.source_id || null).lastInsertRowid;
      const led = postInventoryMovement(db, {
        eventType: 'opening', productId: pid, warehouseId: raw.id, qtyIn: qty,
        unitCostRial: 1000, amountRial: qty * 1000, sourceType: extra.ledger_source_type || 'opening_v515r',
        sourceId: extra.ledger_source_id || bid, batchId: bid, date: '1405/07/01', note: 'v515 relabel roll', createdBy: admin.id,
      });
      db.prepare('UPDATE inventory_batches SET ledger_id=? WHERE id=?').run(led.id, bid);
      db.prepare("UPDATE inventory_batches SET unit='m' WHERE id=?").run(bid);
      return bid;
    };
    const unitOf = (id) => db.prepare('SELECT unit FROM inventory_batches WHERE id=?').get(id).unit;
    const batch = (id) => db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(id);
    const snap = (pid) => {
      const l = db.prepare(`
        SELECT COUNT(*) n, COALESCE(SUM(qty_in),0) qi, COALESCE(SUM(qty_out),0) qo, COALESCE(SUM(amount_rial),0) a
        FROM inventory_ledger WHERE product_id=?
      `).get(pid);
      return {
        ledger: `${l.n}|${l.qi}|${l.qo}|${l.a}`,
        je: db.prepare('SELECT COUNT(*) c FROM journal_entries').get().c,
        jl: db.prepare('SELECT COUNT(*) c FROM journal_lines').get().c,
        wh: db.prepare('SELECT COALESCE(SUM(qty),0) q FROM warehouse_stock WHERE product_id=?').get(pid).q,
        qty: db.prepare('SELECT qty_on_hand, qty_received FROM inventory_batches WHERE product_id=? ORDER BY id').all(pid)
          .map((r) => `${r.qty_on_hand}/${r.qty_received}`).join(','),
      };
    };
    const codeOf = (fn) => { try { fn(); return ''; } catch (e) { return e.code || e.message; } };

    // ── A: kg product, 2 rolls labelled 'm' ───────────────────────
    const fA = fabric('RRU-A', 'کیلوگرم', KG.id);
    const rA1 = roll(fA, 20, { entry_unit_id: M.id, entry_qty: 20, entry_factor: 1 });
    const rA2 = roll(fA, 15);
    const listed = listFabricRolls(db, { product_id: fA });
    ok('list flags unit_mismatch on legacy rolls', listed.length === 2 && listed.every((r) => Number(r.unit_mismatch) === 1));
    const before = resolveLayUnit(db, { batchIds: [rA1, rA2], soft: true });
    ok('before: lay engine would consume in m', before.qty_unit === 'm', before.qty_unit);

    const pv = relabel.previewRollUnitRelabel(db, fA);
    ok('preview: stock unit kg', pv.stock_unit && pv.stock_unit.token === 'kg', JSON.stringify(pv.stock_unit));
    ok('preview: 2 candidates', pv.rolls.length === 2 && pv.rolls.every((r) => r.unit === 'm' && r.new_unit === 'kg'));
    ok('preview: no blockers', pv.blockers.length === 0 && pv.can_relabel === 1, JSON.stringify(pv.blockers));
    eq('preview: ledger balance 35', pv.ledger_balance, 35, 1e-9);
    eq('preview: rolls live total 35', pv.rolls_live_total, 35, 1e-9);

    const s0 = snap(fA);
    ok('relabel without confirm → E_RELABEL_CONFIRM', codeOf(() => relabel.relabelRollUnits(db, fA, { reason: 'x' }, user)) === 'E_RELABEL_CONFIRM');
    ok('relabel without reason → E_RELABEL_REASON', codeOf(() => relabel.relabelRollUnits(db, fA, { reason: '  ', confirm: true }, user)) === 'E_RELABEL_REASON');
    ok('rejected calls changed nothing', unitOf(rA1) === 'm' && unitOf(rA2) === 'm'
      && db.prepare('SELECT COUNT(*) c FROM fabric_roll_unit_relabels').get().c === 0);

    const res = relabel.relabelRollUnits(db, fA, { reason: 'رسید قدیمی متر زده بود', confirm: true }, user);
    ok('relabel: 2 rows, one group', res.count === 2 && !!res.group_key && Number.isInteger(res.id));
    ok('relabel: units now kg', unitOf(rA1) === 'kg' && unitOf(rA2) === 'kg');
    ok('relabel: artefact entry (m × 1) reset to KG', Number(batch(rA1).entry_unit_id) === Number(KG.id)
      && Number(batch(rA1).entry_factor) === 1 && Number(batch(rA1).entry_qty) === 20);
    ok('relabel: empty entry filled with KG', Number(batch(rA2).entry_unit_id) === Number(KG.id) && Number(batch(rA2).entry_qty) === 15);
    const s1 = snap(fA);
    ok('relabel: ledger rows/sums unchanged', s1.ledger === s0.ledger, `${s0.ledger} → ${s1.ledger}`);
    ok('relabel: journal entries/lines unchanged', s1.je === s0.je && s1.jl === s0.jl);
    ok('relabel: warehouse stock + roll qty unchanged', s1.wh === s0.wh && s1.qty === s0.qty, `${s0.qty} → ${s1.qty}`);
    const rows = db.prepare('SELECT * FROM fabric_roll_unit_relabels WHERE group_key=? ORDER BY id').all(res.group_key);
    ok('audit rows keep old values', rows.length === 2 && rows[0].old_unit === 'm' && rows[0].new_unit === 'kg'
      && Number(rows[0].old_entry_unit_id) === Number(M.id) && Number(rows[0].entry_reset) === 1 && rows[0].user_id === admin.id);
    ok('relabel rows carry sync_seq column', db.prepare('PRAGMA table_info(fabric_roll_unit_relabels)').all().some((c) => c.name === 'sync_seq'));

    const after = resolveLayUnit(db, { batchIds: [rA1, rA2], soft: true });
    ok('after: lay engine uses kg', after.qty_unit === 'kg', after.qty_unit);
    ok('after: list no longer flags mismatch', listFabricRolls(db, { product_id: fA }).every((r) => Number(r.unit_mismatch) === 0));
    const pv2 = relabel.previewRollUnitRelabel(db, fA);
    ok('second preview: nothing to fix', pv2.rolls.length === 0 && pv2.blockers.some((b) => b.code === 'E_RELABEL_NONE'));
    ok('second relabel → 409', codeOf(() => relabel.relabelRollUnits(db, fA, { reason: 'x', confirm: true }, user)) === 'E_RELABEL_BLOCKED');

    const hist = relabel.listRollUnitRelabels(db, { product_id: fA });
    ok('history: one group with 2 rolls', hist.groups.length === 1 && hist.groups[0].rolls.length === 2 && !hist.groups[0].reversed_at);

    // ── undo blocked while a live lay uses a relabelled roll ───────
    const fg = db.prepare(`
      INSERT INTO products (user_id, name, code, price, stock, unit, item_type, is_manufactured)
      VALUES (?, 'مانتو RRU', 'FG-RRU', 0, 0, 'عدد', 'finished', 1)
    `).run(admin.id).lastInsertRowid;
    const lay = postCuttingLay(db, {
      product_id: fg, fabric_product_id: fA, warehouse_id: raw.id, color: 'مشکی', width_cm: 150,
      marker_length_m: 2, ply_count: 5, actual_meters: 3, marker_factor: 0.3, size_breakdown: { S: 5, M: 5 },
      rolls: [{ batch_id: rA1, meters: 3 }], date: '1405/07/29', idempotency_key: 'rru-lay-1',
    }, user);
    ok('kg lay posts on relabelled roll', lay && lay.status === 'posted' && lay.qty_unit === 'kg', lay && lay.qty_unit);
    ok('undo blocked by live lay', codeOf(() => relabel.undoRollUnitRelabel(db, res.id, { reason: 'x' }, user)) === 'E_RELABEL_UNDO_BLOCKED');
    ok('blocked undo changed nothing', unitOf(rA1) === 'kg' && unitOf(rA2) === 'kg');
    voidCuttingLay(db, lay.id, user, { reason: 'آزمون v515 relabel' });
    ok('undo requires reason', codeOf(() => relabel.undoRollUnitRelabel(db, res.id, {}, user)) === 'E_RELABEL_REASON');

    const s2 = snap(fA);
    const und = relabel.undoRollUnitRelabel(db, res.id, { reason: 'آزمون بازگردانی' }, user);
    ok('undo: 2 rolls back to m', und.count === 2 && unitOf(rA1) === 'm' && unitOf(rA2) === 'm');
    ok('undo: entry restored', Number(batch(rA1).entry_unit_id) === Number(M.id) && Number(batch(rA1).entry_factor) === 1
      && batch(rA2).entry_unit_id == null && batch(rA2).entry_qty == null);
    const s3 = snap(fA);
    ok('undo: ledger + journals unchanged', s3.ledger === s2.ledger && s3.je === s2.je && s3.jl === s2.jl);
    ok('undo: rows marked reversed (no delete)', db.prepare('SELECT COUNT(*) c FROM fabric_roll_unit_relabels WHERE group_key=? AND reversed_at IS NOT NULL AND reverse_reason IS NOT NULL').get(res.group_key).c === 2);
    ok('undo twice → E_RELABEL_REVERSED', codeOf(() => relabel.undoRollUnitRelabel(db, res.group_key, { reason: 'x' }, user)) === 'E_RELABEL_REVERSED');

    // ── B: roll used by a posted lay → blocker ─────────────────────
    const fB = fabric('RRU-B', 'کیلوگرم', KG.id);
    const rB1 = roll(fB, 10);
    roll(fB, 12);
    const layId = db.prepare(`
      INSERT INTO cutting_lays (lay_no, product_id, fabric_product_id, warehouse_id, status, date)
      VALUES ('LAY-RRU-B', ?, ?, ?, 'posted', '1405/07/20')
    `).run(fg, fB, raw.id).lastInsertRowid;
    db.prepare("INSERT INTO cutting_lay_rolls (lay_id, batch_id, meters, status) VALUES (?,?,2,'posted')").run(layId, rB1);
    const pvB = relabel.previewRollUnitRelabel(db, fB);
    ok('lay-used roll → E_RELABEL_LAY_USED blocker', pvB.blockers.some((b) => b.code === 'E_RELABEL_LAY_USED' && b.batch_id === rB1)
      && pvB.rolls.find((r) => r.id === rB1).used_by_lay === 1);
    ok('relabel refused with blockers', (() => {
      try { relabel.relabelRollUnits(db, fB, { reason: 'x', confirm: true }, user); return false; } catch (e) {
        return e.status === 409 && e.code === 'E_RELABEL_BLOCKED' && Array.isArray(e.blockers) && e.blockers.length > 0;
      }
    })());
    ok('refused relabel wrote nothing', unitOf(rB1) === 'm' && db.prepare('SELECT COUNT(*) c FROM fabric_roll_unit_relabels WHERE product_id=?').get(fB).c === 0);
    db.prepare("UPDATE cutting_lays SET status='reversed' WHERE id=?").run(layId);
    ok('reversed lay no longer blocks', relabel.previewRollUnitRelabel(db, fB).blockers.length === 0);

    // ── C: purchase-sourced rolls ──────────────────────────────────
    const sup = db.prepare("INSERT INTO suppliers (name) VALUES ('تأمین RRU')").run().lastInsertRowid;
    const fC = fabric('RRU-C', 'کیلوگرم', KG.id);
    const inv = db.prepare(`
      INSERT INTO purchase_invoices (user_id, supplier_id, num, date, rows) VALUES (?,?,?,?,?)
    `).run(admin.id, sup, 'P-RRU-1', '1405/07/01', JSON.stringify([{ product_id: fC, qty: 40, price: 1000 }])).lastInsertRowid;
    const rC = roll(fC, 40, { source_type: 'purchase', source_id: inv, ledger_source_type: 'purchase', ledger_source_id: inv });
    const pvC = relabel.previewRollUnitRelabel(db, fC);
    ok('purchase roll: line qty matches → no blocker', pvC.blockers.length === 0 && pvC.rolls[0].purchase_qty === 40
      && pvC.rolls[0].ledger_qty_in === 40, JSON.stringify(pvC.blockers));
    const fD = fabric('RRU-D', 'کیلوگرم', KG.id);
    const invD = db.prepare(`
      INSERT INTO purchase_invoices (user_id, supplier_id, num, date, rows) VALUES (?,?,?,?,?)
    `).run(admin.id, sup, 'P-RRU-2', '1405/07/01', JSON.stringify([{ product_id: fD, qty: 50, price: 1000 }])).lastInsertRowid;
    roll(fD, 45, { source_type: 'purchase', source_id: invD, ledger_source_type: 'purchase', ledger_source_id: invD });
    const pvD = relabel.previewRollUnitRelabel(db, fD);
    ok('purchase roll: qty ≠ line qty → E_RELABEL_PURCHASE_QTY', pvD.blockers.some((b) => b.code === 'E_RELABEL_PURCHASE_QTY'), JSON.stringify(pvD.blockers));
    void rC;

    // ── E: stock unit unresolved ───────────────────────────────────
    const fE = fabric('RRU-E', 'واحد ناشناس', null);
    roll(fE, 5);
    const pvE = relabel.previewRollUnitRelabel(db, fE);
    ok('unknown stock unit → E_RELABEL_STOCK_UNIT', pvE.blockers.some((b) => b.code === 'E_RELABEL_STOCK_UNIT') && pvE.can_relabel === 0);

    // ── F: metre product with 'm' rolls has nothing to fix ─────────
    const fF = fabric('RRU-F', 'متر', M.id);
    roll(fF, 30);
    db.prepare("UPDATE inventory_batches SET unit='m' WHERE product_id=?").run(fF);
    ok('metre product: no candidates', relabel.previewRollUnitRelabel(db, fF).rolls.length === 0);

    dbOk = true;
  } finally {
    cleanup();
  }
} catch (e) {
  if (/bindings|better_sqlite3|NODE_MODULE_VERSION/i.test(String(e.message) + e)) {
    console.log('  SKIP db path: better-sqlite3 not loaded on this Node');
    ok('db path skipped (static assertions still ran)', true);
  } else {
    ok('db path', false, e.stack || e.message);
  }
}
if (dbOk) ok('db roll-unit relabel path', true);

summary('roll-unit-relabel-v515');
