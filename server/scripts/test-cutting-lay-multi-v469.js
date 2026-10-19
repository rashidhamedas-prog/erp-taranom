'use strict';
/**
 * v469 — چندمحصول روی یک مارکر: وزن خودکار، ابطال از لایه‌چینی، UI helpers در app.js.
 * Run: node server/scripts/test-cutting-lay-multi-v469.js
 */
const fs = require('fs');
const path = require('path');
const { ok, eq, summary } = require('./lib/test-harness');

const appPath = path.join(__dirname, '../public/app.js');
const appSrc = fs.readFileSync(appPath, 'utf8');
ok(appSrc.includes('cuttingIsMultiMode'), 'UI multi mode helper');
ok(appSrc.includes('cuttingBuildSharedBody'), 'UI shared body builder');
ok(appSrc.includes('چند محصول روی یک مارکر'), 'modal switch label');
ok(appSrc.includes('cutting-batches/preview'), 'preview routes to shared-cut');
ok(appSrc.includes('E_SHARED_CUT_NO_AMEND') || appSrc.includes('ویرایش مستقیم ندارد'), 'edit blocked messaging');
ok(appSrc.includes('قطعه در مارکر'), 'pieces-in-marker copy');

const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
ok(sw.includes("erp-taranom-v469"), 'SW bumped to v469');

const schema = fs.readFileSync(path.join(__dirname, '../lib/production/schema.js'), 'utf8');
ok(schema.includes("production_shared_cut: '1'"), 'default flag on');
ok(schema.includes('production_shared_cut_ui_v469'), 'one-shot enable migration');

const shared = fs.readFileSync(path.join(__dirname, '../lib/production/shared-cut.js'), 'utf8');
ok(shared.includes('جمع قطعه در مارکر صفر است') || shared.includes('E_SHARE_ZERO'), 'auto weight from pieces');

const cutting = fs.readFileSync(path.join(__dirname, '../lib/production/cutting.js'), 'utf8');
ok(cutting.includes('voidSharedCut'), 'void lay delegates shared');
ok(cutting.includes('E_SHARED_CUT_NO_AMEND'), 'amend blocked for batch lays');
ok(cutting.includes('shared_outputs'), 'list exposes outputs');

try {
  new Function(appSrc);
  ok('app.js parse', true);
} catch (e) {
  ok('app.js parse', false, e.message);
}

let dbOk = false;
try {
  const { freshDb } = require('./lib/test-harness');
  const { normalizeOutputs, previewSharedCut, postSharedCut, voidSharedCut } = require('../lib/production/shared-cut');
  const { voidCuttingLay, listCuttingLays } = require('../lib/production/cutting');
  const ctx = freshDb();
  const { db, cleanup } = ctx;
  try {
    db.prepare("INSERT INTO settings (key,value) VALUES ('production_shared_cut','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    const auto = normalizeOutputs([
      { product_id: 10, size_code: 'M', pieces_per_ply: 2 },
      { product_id: 11, size_code: 'L', pieces_per_ply: 3 },
    ], 10);
    eq('وزن A از قطعه', auto[0].weight, 40, 0.01);
    eq('وزن B از قطعه', auto[1].weight, 60, 0.01);
    eq('برنامه A', auto[0].planned_pieces, 20);
    eq('برنامه B', auto[1].planned_pieces, 30);

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
      VALUES (?, 'پارچه چند', 'FAB-M', 0, 10000, 'متر', 1000, 1000, 'raw')
    `).run(admin.id).lastInsertRowid;
    db.prepare('INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,10000)').run(fab, raw.id);
    const a = db.prepare(`INSERT INTO products (user_id, name, code, unit, item_type, is_manufactured) VALUES (?,'ژاکت','FG-J','عدد','finished',1)`).run(admin.id).lastInsertRowid;
    const b = db.prepare(`INSERT INTO products (user_id, name, code, unit, item_type, is_manufactured) VALUES (?,'شلوار','FG-P','عدد','finished',1)`).run(admin.id).lastInsertRowid;
    const rollId = db.prepare(`
      INSERT INTO inventory_batches (batch_no, product_id, warehouse_id, qty_on_hand, qty_received, status, kind, unit, unit_cost_rial, color, width_cm)
      VALUES (?,?,?,?,?,'active','fabric','متر',1000,'شکلاتی',150)
    `).run('LOT-M1', fab, raw.id, 80, 80).lastInsertRowid;

    const body = {
      marker_length_m: 6,
      fabric_product_id: fab,
      warehouse_id: raw.id,
      width_cm: 150,
      color: 'شکلاتی',
      date: '1405/07/27',
      idempotency_key: 'v469-multi-1',
      outputs: [
        { product_id: a, size_code: 'فری', pieces_per_ply: 2 },
        { product_id: b, size_code: 'فری', pieces_per_ply: 3 },
      ],
      rolls: [{ batch_id: rollId, opening_m: 80, ply_count: 11 }],
    };
    const preview = previewSharedCut(db, body);
    ok('پیش‌نمایش متوازن', preview.balanced, JSON.stringify(preview.errors));
    eq('وزن خودکار ۲ از ۵', preview.outputs[0].weight + preview.outputs[1].weight, 100, 0.05);
    const posted = postSharedCut(db, body, { id: admin.id });
    ok('ثبت batch', posted.status === 'posted');
    ok('lay_no', !!posted.lay_no);
    const listed = listCuttingLays(db, {});
    const row = listed.find((r) => r.id === posted.lay_id);
    ok('لیست shared', row && Number(row.is_shared_cut) === 1);
    ok('نام دو محصول', row && (row.shared_product_names || []).length >= 2);

    let amendBlocked = false;
    try {
      const { updateCuttingLay } = require('../lib/production/cutting');
      updateCuttingLay(db, posted.lay_id, { product_id: a, marker_length_m: 6, ply_count: 11, size_breakdown: { فری: 2 }, rolls: [] }, { id: admin.id });
    } catch (e) {
      amendBlocked = e.code === 'E_SHARED_CUT_NO_AMEND';
    }
    ok('amend مسدود', amendBlocked);

    voidCuttingLay(db, posted.lay_id, { id: admin.id }, { reason: 'آزمون v469' });
    const layAfter = db.prepare('SELECT status FROM cutting_lays WHERE id=?').get(posted.lay_id);
    ok('وضعیت لایه reversed', layAfter && layAfter.status === 'reversed', layAfter && layAfter.status);
    const batchAfter = db.prepare('SELECT status FROM cutting_batches WHERE id=?').get(posted.id);
    ok('وضعیت batch reversed', batchAfter && batchAfter.status === 'reversed', batchAfter && batchAfter.status);
    const left = db.prepare('SELECT qty_on_hand q FROM inventory_batches WHERE id=?').get(rollId).q;
    eq('برگشت طاقه', Number(left), 80, 0.05);
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
if (dbOk) ok('db multi path', true);

summary('cutting-lay-multi-v469');
