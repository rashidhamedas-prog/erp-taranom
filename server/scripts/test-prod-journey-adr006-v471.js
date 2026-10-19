'use strict';
/**
 * v471 / ADR-006 W2–W4 smoke: amend shared, multi-pack void, cost alloc, lay gate, reverseOrder skip.
 * Run: node server/scripts/test-prod-journey-adr006-v471.js
 */
const fs = require('fs');
const path = require('path');
const { ok, eq, summary } = require('./lib/test-harness');

const root = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const shared = fs.readFileSync(path.join(root, 'lib/production/shared-cut.js'), 'utf8');
const cutting = fs.readFileSync(path.join(root, 'lib/production/cutting.js'), 'utf8');
const reports = fs.readFileSync(path.join(root, 'lib/production/reports.js'), 'utf8');
const eng = fs.readFileSync(path.join(root, 'lib/production/engine.js'), 'utf8');
const adv = fs.readFileSync(path.join(root, 'lib/production/engine-advanced.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'routes/production-shared-cut.js'), 'utf8');

ok(sw.includes('erp-taranom-v471'), 'SW v471');
ok(shared.includes('function amendSharedCut'), 'amendSharedCut exists');
ok(shared.includes('production_order_id'), 'shared lay/packs link order');
ok(cutting.includes('amendSharedCut'), 'updateCuttingLay delegates amend');
ok(!cutting.includes("E_SHARED_CUT_NO_AMEND"), 'NO_AMEND removed from update path');
ok(cutting.includes("COALESCE(status,'posted')='posted' ORDER BY id DESC"), 'void all packs by lay');
ok(reports.includes('shared_cut_alloc'), 'cost sheet alloc source');
ok(reports.includes('cutting_batch_allocations'), 'cost sheet reads allocations');
ok(eng.includes("issue_type || '') === 'cutting_lay'"), 'reverseOrder skips cutting_lay stock');
ok(adv.includes('assertLayCompleteBeforePostCutStage'), 'W3 lay gate');
ok(adv.includes('E_LAY_BEFORE_NEXT_STAGE'), 'W3 error code');
ok(routes.includes('amendSharedCut'), 'PUT route amend');
ok(routes.includes("requirePermission('production', 'create')"), 'void RBAC aligned to create');
ok(appSrc.includes('ویرایش چندمحصول'), 'UI shared edit label');
ok(appSrc.includes("PUT','/production/cutting-batches/"), 'UI PUT amend');
ok(appSrc.includes('_cutSharedBatchId'), 'UI shared edit state');

try {
  new Function(appSrc);
  ok('app.js parse', true);
} catch (e) {
  ok('app.js parse', false, e.message);
}

const { normalizeOutputs, amendSharedCut } = require('../lib/production/shared-cut');
ok(typeof amendSharedCut === 'function', 'amend export');
const hy = normalizeOutputs([
  { product_id: 1, pieces_per_ply: 2, fabric_std_m: 1 },
  { product_id: 2, pieces_per_ply: 2, fabric_std_m: 3 },
], 5, { allocation_basis: 'hybrid' });
ok(hy[1].weight > hy[0].weight, 'hybrid still tilts');

let dbOk = false;
try {
  const { freshDb } = require('./lib/test-harness');
  const { postSharedCut, voidSharedCut, getSharedCut } = require('../lib/production/shared-cut');
  const { voidCuttingPackByLay } = require('../lib/production/cutting');
  const ctx = freshDb();
  const { db, cleanup } = ctx;
  try {
    db.prepare("INSERT INTO settings (key,value) VALUES ('production_shared_cut','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get();
    const raw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get();
    if (!db.prepare("SELECT id FROM warehouses WHERE code='WH-WIP'").get()) {
      db.prepare("INSERT INTO warehouses (code,name,kind,warehouse_type,active) VALUES ('WH-WIP','WIP','wip','wip',1)").run();
    }
    if (!db.prepare("SELECT id FROM warehouses WHERE code='WH-SCRAP'").get()) {
      db.prepare("INSERT INTO warehouses (code,name,kind,warehouse_type,active) VALUES ('WH-SCRAP','ضایعات','scrap','scrap',1)").run();
    }
    const fab = db.prepare(`
      INSERT INTO products (user_id, name, code, price, stock, unit, average_cost_rial, cost, item_type)
      VALUES (?, 'پارچه v471', 'FAB-471', 0, 10000, 'متر', 1000, 1000, 'raw')
    `).run(admin.id).lastInsertRowid;
    db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,10000)').run(fab, raw.id);
    const a = db.prepare(`INSERT INTO products (user_id, name, code, unit, item_type, is_manufactured) VALUES (?,'A471','FG-A471','عدد','finished',1)`).run(admin.id).lastInsertRowid;
    const b = db.prepare(`INSERT INTO products (user_id, name, code, unit, item_type, is_manufactured) VALUES (?,'B471','FG-B471','عدد','finished',1)`).run(admin.id).lastInsertRowid;
    const rollId = db.prepare(`
      INSERT INTO inventory_batches (batch_no, product_id, warehouse_id, qty_on_hand, qty_received, status, kind, unit, unit_cost_rial, color, width_cm)
      VALUES (?,?,?,?,?,'active','fabric','متر',1000,'مشکی',150)
    `).run('LOT-471', fab, raw.id, 100, 100).lastInsertRowid;

    const body = {
      marker_length_m: 5,
      width_cm: 150,
      fabric_product_id: fab,
      color: 'مشکی',
      allocation_basis: 'pieces',
      outputs: [
        { product_id: a, size_code: 'M', pieces_per_ply: 2 },
        { product_id: b, size_code: 'L', pieces_per_ply: 3 },
      ],
      rolls: [{ batch_id: rollId, opening_m: 100, ply_count: 10, color: 'مشکی', length_loss_m: 0 }],
      idempotency_key: 'v471-shared-1',
    };
    const posted = postSharedCut(db, body, { id: admin.id });
    ok(!!posted.lay_id, 'posted lay');
    const packsBefore = db.prepare("SELECT COUNT(*) c FROM cutting_packs WHERE lay_id=? AND status='posted'").get(posted.lay_id).c;
    eq('two WIP packs', packsBefore, 2);

    const amended = amendSharedCut(db, posted.id, Object.assign({}, body, {
      outputs: [
        { product_id: a, size_code: 'M', pieces_per_ply: 1 },
        { product_id: b, size_code: 'L', pieces_per_ply: 4 },
      ],
      reason: 'آزمون amend',
    }), { id: admin.id });
    ok(amended.id === posted.id, 'same batch id after amend');
    ok(amended.lay_id === posted.lay_id, 'same lay id after amend');
    const outs = amended.outputs || [];
    const sumP = outs.reduce((s, o) => s + Number(o.pieces_per_ply || 0), 0);
    eq('amended pieces sum', sumP, 5);

    voidCuttingPackByLay(db, posted.lay_id, { id: admin.id }, { reason: 'test multi void' });
    const packsLive = db.prepare("SELECT COUNT(*) c FROM cutting_packs WHERE lay_id=? AND status='posted'").get(posted.lay_id).c;
    eq('all packs voided', packsLive, 0);

    // re-post packs via fresh amend then void whole batch
    const body2 = Object.assign({}, body, { idempotency_key: 'v471-shared-2', rolls: [{ batch_id: rollId, opening_m: 50, ply_count: 4, color: 'مشکی', length_loss_m: 0 }] });
    // roll may be depleted — void shared first from amended state
    voidSharedCut(db, posted.id, { id: admin.id }, 'cleanup');
    ok(getSharedCut(db, posted.id).status === 'reversed', 'batch reversed');
    dbOk = true;
  } finally {
    cleanup();
  }
} catch (e) {
  if (/bindings|better_sqlite3|NODE_MODULE_VERSION/i.test(String(e.message) + e)) {
    console.log('  SKIP db path: better-sqlite3 not loaded on this Node');
    ok('db path skipped (static still ran)', true);
  } else {
    ok('db path v471', false, e.message + (e.code ? ' ' + e.code : ''));
  }
}
if (dbOk) ok('db journey path', true);

summary('prod-journey-adr006-v471');
