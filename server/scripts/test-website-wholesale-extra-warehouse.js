#!/usr/bin/env node
/**
 * website-wholesale-extra-warehouse (v648)
 * Optional second wholesale warehouse summed into one Site WHOLESALE channel.
 * Never touches product 342. No live site / no production writes.
 */
'use strict';

process.env.SYNC_ROLE = 'central';
process.env.WEBSITE_STOCK_CHUNK_GAP_MS = '0';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-wholesale-extra-wh-v648';

const { ok, eq, freshDb, summary } = require('./lib/test-harness');
const path = require('path');
const fs = require('fs');

console.log('══ website-wholesale-extra-warehouse (v648) ══');
const { db, cleanup } = freshDb();
const sync = require('../lib/website-stock-sync');
const { setSetting } = require('../lib/secret-settings');

function setSettings(map) {
  for (const [k, v] of Object.entries(map)) setSetting(db, k, v);
}

(async () => {
try {
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const uid = user ? user.id : db.prepare("INSERT INTO users (username,password,name,role,active) VALUES ('t','x','t','admin',1)").run().lastInsertRowid;

  const whA = Number(db.prepare("INSERT INTO warehouses (name, active) VALUES ('انبار محصول',1)").run().lastInsertRowid);
  const whB = Number(db.prepare("INSERT INTO warehouses (name, active) VALUES ('انبار کیمیا',1)").run().lastInsertRowid);
  const whR1 = Number(db.prepare("INSERT INTO warehouses (name, active) VALUES ('انبار تکی۱',1)").run().lastInsertRowid);
  const whR2 = Number(db.prepare("INSERT INTO warehouses (name, active) VALUES ('انبار تکی۲',1)").run().lastInsertRowid);

  const P = Number(db.prepare(
    'INSERT INTO products (user_id, code, name, price, stock) VALUES (?,?,?,0,0)'
  ).run(uid, 'T-W648', 'کالای عمده تست').lastInsertRowid);
  ok('fixture never uses product 342', P !== 342);

  const c1 = Number(db.prepare("INSERT INTO product_colors (name) VALUES ('آبی')").run().lastInsertRowid);
  const s1 = Number(db.prepare("INSERT INTO product_sizes (name) VALUES ('M')").run().lastInsertRowid);
  const v1 = Number(db.prepare(
    'INSERT INTO product_variants (product_id, color_id, size_id, sku, active, is_default) VALUES (?,?,?,?,1,0)'
  ).run(P, c1, s1, 'T-W648-1').lastInsertRowid);

  const vws = (v, w, q) => db.prepare(
    'INSERT OR REPLACE INTO variant_warehouse_stock (variant_id, warehouse_id, qty) VALUES (?,?,?)'
  ).run(v, w, q);
  vws(v1, whA, 10);
  vws(v1, whB, 7);
  vws(v1, whR1, 4);
  vws(v1, whR2, 2);

  // —— A) channelWarehouseIds WHOLESALE ——
  ok('A1 primary+2 → [A,B]',
    sync.channelWarehouseIds({
      website_wh_wholesale_id: String(whA),
      website_wh_wholesale_2_id: String(whB),
    }, 'WHOLESALE').join(',') === `${whA},${whB}`);

  ok('A2 primary only → [A]',
    sync.channelWarehouseIds({
      website_wh_wholesale_id: String(whA),
      website_wh_wholesale_2_id: '',
    }, 'WHOLESALE').join(',') === String(whA));

  ok('A3 _2 set, primary empty → []',
    sync.channelWarehouseIds({
      website_wh_wholesale_id: '',
      website_wh_wholesale_2_id: String(whB),
    }, 'WHOLESALE').length === 0);

  ok('A4 _2 equal primary → dedupe [A]',
    sync.channelWarehouseIds({
      website_wh_wholesale_id: String(whA),
      website_wh_wholesale_2_id: String(whA),
    }, 'WHOLESALE').join(',') === String(whA));

  ok('A5 channelWarehouseId stays primary only',
    sync.channelWarehouseId({
      website_wh_wholesale_id: String(whA),
      website_wh_wholesale_2_id: String(whB),
    }, 'WHOLESALE') === whA);

  ok('A6 RETAIL pair still sums ids',
    sync.channelWarehouseIds({
      website_wh_retail_id: String(whR1),
      website_wh_retail_2_id: String(whR2),
    }, 'RETAIL').join(',') === `${whR1},${whR2}`);

  // —— B) getSettingsMap includes new key ——
  setSettings({
    website_stock_sync_enabled: '1',
    website_stock_sync_mode: 'push',
    website_target: 'site_b2b',
    website_b2b_url: 'https://api.example.com',
    website_b2b_token: 'test-token',
    website_wh_wholesale_id: String(whA),
    website_wh_wholesale_2_id: String(whB),
    website_wh_retail_id: String(whR1),
    website_wh_retail_2_id: String(whR2),
  });
  const sm = sync.getSettingsMap(db, { needB2b: false, needWoo: false });
  ok('B1 getSettingsMap has wholesale_2', String(sm.website_wh_wholesale_2_id) === String(whB));
  const whIds = sync.channelWarehouseIds(sm, 'WHOLESALE');
  ok('B2 live settings map → [A,B]', whIds.join(',') === `${whA},${whB}`);

  // —— C) buildMatrixPayload SUM + idempotency ——
  const pl = sync.buildMatrixPayload(db, P, 'WHOLESALE', whIds);
  const total = pl.variants.reduce((a, v) => a + (Number(v.qty) || 0), 0);
  ok('C1 WHOLESALE multi-wh total = 17', total === 17, `total=${total}`);
  ok('C2 idempotencyKey contains both ids in channel order',
    String(pl.idempotencyKey).includes(`wh${whA}+${whB}`), pl.idempotencyKey);

  const plOne = sync.buildMatrixPayload(db, P, 'WHOLESALE', [whA]);
  ok('C3 primary-only still 10', plOne.variants[0].qty === 10);

  const retailIds = sync.channelWarehouseIds(sm, 'RETAIL');
  const plR = sync.buildMatrixPayload(db, P, 'RETAIL', retailIds);
  ok('C4 RETAIL still sums 4+2=6', plR.variants[0].qty === 6);

  // —— D) breakdown lines ——
  const lineW = sync.channelWarehouseBreakdown
    ? sync.channelWarehouseBreakdown(db, P, 'WHOLESALE', whIds)
    : sync.retailWarehouseBreakdown(db, P, whIds);
  ok('D1 wholesale breakdown label عمده', /^عمده = /.test(lineW), lineW);
  ok('D2 wholesale breakdown shows 10 + 7 = 17',
    lineW.includes('10') && lineW.includes('7') && /= 17$/.test(lineW), lineW);

  const lineR = sync.retailWarehouseBreakdown(db, P, retailIds);
  ok('D3 retail wording kept تکی', /^تکی = /.test(lineR), lineR);

  const lineOne = sync.channelWarehouseBreakdown(db, P, 'WHOLESALE', [whA]);
  ok('D4 single-wh wholesale breakdown', /^عمده = انبار محصول 10$/.test(lineOne), lineOne);

  // —— E) dry-run includes WHOLESALE breakdown ——
  let calls = [];
  sync.requestJSON = async (url, method, body) => {
    calls.push({ url, method, body });
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({ matched: (body.variants || []).map((v) => v.erpVariantSku), unmatched: [] }),
    };
  };
  const dry = await sync.dryRunProductMatrix(db, 'T-W648');
  ok('E1 dry-run ok', dry.ok === true, JSON.stringify(dry.lines));
  ok('E2 dry-run has عمده breakdown', dry.lines.some((l) => String(l).startsWith('عمده = ')), JSON.stringify(dry.lines));
  ok('E3 dry-run has تکی breakdown', dry.lines.some((l) => String(l).startsWith('تکی = ')), JSON.stringify(dry.lines));

  // —— F) ping warehouses.wholesaleIds ——
  calls = [];
  sync.requestJSON = async (url, method, body, headers) => {
    calls.push({ url, method, body, headers });
    return { status: 200, body: '{}', headers: {} };
  };
  const ping = await sync.testWebsiteConnection(db);
  ok('F1 ping ok', ping.ok === true, JSON.stringify(ping));
  ok('F2 ping has wholesaleIds', Array.isArray(ping.warehouses && ping.warehouses.wholesaleIds)
    && ping.warehouses.wholesaleIds.join(',') === `${whA},${whB}`, JSON.stringify(ping.warehouses));
  ok('F3 ping keeps retailIds', Array.isArray(ping.warehouses.retailIds)
    && ping.warehouses.retailIds.join(',') === `${whR1},${whR2}`);

  // —— G) warehouseSetKey compare (same set no change) ——
  const before = sync.channelWarehouseIds(sm, 'WHOLESALE');
  const afterSame = sync.channelWarehouseIds({
    ...sm,
    website_wh_wholesale_2_id: String(whB),
  }, 'WHOLESALE');
  ok('G1 same set key equal', sync.warehouseSetKey(before) === sync.warehouseSetKey(afterSame));
  const afterChanged = sync.channelWarehouseIds({
    ...sm,
    website_wh_wholesale_2_id: '',
  }, 'WHOLESALE');
  ok('G2 clearing _2 changes WHOLESALE set', sync.warehouseSetKey(before) !== sync.warehouseSetKey(afterChanged));
  const retailSame = sync.channelWarehouseIds(sm, 'RETAIL');
  const retailAfterWh2Change = sync.channelWarehouseIds({
    ...sm,
    website_wh_wholesale_2_id: '',
  }, 'RETAIL');
  ok('G3 changing wholesale_2 does not change RETAIL set',
    sync.warehouseSetKey(retailSame) === sync.warehouseSetKey(retailAfterWh2Change));

  // —— H) settings allowlist + schema default ——
  const settingsRoute = require('../routes/settings');
  ok('H1 NON_COA allows wholesale_2', settingsRoute.NON_COA_ALLOWED_KEYS.includes('website_wh_wholesale_2_id'));
  const schemaSrc = fs.readFileSync(path.join(__dirname, '../lib/update-md-schema.js'), 'utf8');
  ok('H2 update-md-schema default for wholesale_2', /website_wh_wholesale_2_id:\s*''/.test(schemaSrc));

  // —— I) extraWhQtyOnUnmatched for WHOLESALE multi-wh ——
  sync.ensureWebsiteStockOutbox(db);
  db.prepare('DELETE FROM website_stock_outbox').run();
  const now = Math.floor(Date.now() / 1000);
  const rowId = Number(db.prepare(`
    INSERT INTO website_stock_outbox
      (product_id, channel, next_at, attempts, status, last_error, last_result, updated_at)
    VALUES (?,?,?,?, 'pending', '', '', ?)
  `).run(P, 'WHOLESALE', now - 10, 0, now - 20).lastInsertRowid);

  sync.requestJSON = async (_url, _method, body) => ({
    status: 200,
    headers: {},
    body: JSON.stringify({
      matched: [],
      unmatched: (body.variants || []).map((v) => ({
        erpVariantSku: v.erpVariantSku,
        color: v.color,
        size: v.size,
        reason: 'variant_unmatched',
      })),
    }),
  });
  await sync.drainWebsiteStockOutbox(db);
  const out = db.prepare('SELECT status, last_result FROM website_stock_outbox WHERE id=?').get(rowId);
  let lr = {};
  try { lr = JSON.parse(out.last_result || '{}'); } catch (_) { lr = {}; }
  ok('I1 WHOLESALE unmatched stays error', out.status === 'error');
  ok('I2 extraWhQtyOnUnmatched populated for WHOLESALE multi-wh',
    Number(lr.extraWhQtyOnUnmatched) === 7, JSON.stringify(lr));

  // —— J) UI / SW stamps (source) ——
  const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const swSrc = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  const idxSrc = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  ok('J1 app has wholesale_2 select id', appSrc.includes('s-website_wh_wholesale_2_id'));
  ok('J2 app save keys include wholesale_2', /website_wh_wholesale_2_id/.test(appSrc));
  ok('J3 app label عمده ۱', appSrc.includes('انبار عمده ۱ — اصلی (WHOLESALE)'));
  ok('J4 app label عمده ۲', appSrc.includes('انبار عمده ۲ (اختیاری — جمع با اصلی)'));
  ok('J5 SW v648', /erp-taranom-v648/.test(swSrc));
  ok('J6 index app.js?v=648', /app\.js\?v=648/.test(idxSrc));
  const swAtLeast = Number((swSrc.match(/erp-taranom-v(\d+)/) || [])[1] || 0);
  ok('J7 swAtLeast >= 648', swAtLeast >= 648, String(swAtLeast));

  // —— K) exports ——
  ok('K1 channelWarehouseBreakdown exported', typeof sync.channelWarehouseBreakdown === 'function');
  ok('K2 retailWarehouseBreakdown still exported', typeof sync.retailWarehouseBreakdown === 'function');
} catch (e) {
  console.error(e);
  ok('unexpected exception', false, e && e.stack);
} finally {
  try { cleanup(); } catch (_) { /* */ }
}
summary('website-wholesale-extra-warehouse');
})();
