/**
 * RETAIL multi-warehouse SUM → one Site channel (v331).
 * Pure unit checks (no native sqlite / no network).
 * node server/scripts/test-website-retail-multi-wh-v331.js
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-website-retail-multi-wh-v331';

const {
  ensureWebsiteStockOutbox,
  buildMatrixPayload,
  enqueueWebsiteStock,
  channelWarehouseId,
  channelWarehouseIds,
  configuredChannels,
} = require('../lib/website-stock-sync');

function ok(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log('  ✓', msg);
}

function makeFakeDb(seed) {
  const settings = new Map(Object.entries(seed.settings || {}));
  const outbox = new Map();
  let outboxSeq = 1;
  const variants = seed.variants || [];
  const vws = seed.vws || [];
  const product = seed.product;

  function sumQty(variantId, warehouseIds) {
    let total = 0;
    for (const wid of warehouseIds) {
      const row = vws.find((x) => x.variant_id === variantId && x.warehouse_id === wid);
      total += row ? Number(row.qty) || 0 : 0;
    }
    return total;
  }

  function all(sql, ...params) {
    if (sql.includes('FROM product_variants v') && sql.includes('variant_warehouse_stock')) {
      let warehouseIds;
      let productId;
      if (sql.includes('warehouse_id IN (')) {
        productId = params[params.length - 1];
        warehouseIds = params.slice(0, -1).map((x) => Number(x));
      } else {
        warehouseIds = [Number(params[0])];
        productId = params[1];
      }
      return variants
        .filter((v) => v.product_id === productId && v.active !== 0 && !v.is_default)
        .map((v) => ({
          variant_id: v.id,
          sku: v.sku,
          barcode: v.barcode,
          color_name: v.color_name || '',
          size_name: v.size_name || '',
          qty: sumQty(v.id, warehouseIds),
        }));
    }
    return [];
  }

  function get(sql, ...params) {
    if (sql.includes('FROM products')) {
      if (product && product.id === params[0]) return product;
      return null;
    }
    return null;
  }

  function run(sql, ...params) {
    if (sql.includes('CREATE TABLE IF NOT EXISTS website_stock_outbox') || sql.includes('CREATE INDEX')) {
      return { changes: 0 };
    }
    if (sql.includes('INSERT INTO website_stock_outbox')) {
      const pid = params[0];
      const ch = params[1];
      const next = params[2];
      const updated = params[params.length - 1];
      const key = `${pid}|${ch}`;
      if (outbox.has(key)) {
        const row = outbox.get(key);
        row.next_at = next;
        row.status = 'pending';
        row.attempts = 0;
        row.last_error = '';
        if (sql.includes("last_result=''")) row.last_result = '';
        row.updated_at = updated;
      } else {
        outbox.set(key, {
          id: outboxSeq++,
          product_id: pid,
          channel: ch,
          next_at: next,
          attempts: 0,
          status: 'pending',
          last_error: '',
          last_result: '',
          updated_at: updated,
        });
      }
      return { changes: 1 };
    }
    return { changes: 0 };
  }

  const api = {
    exec() {},
    prepare(sql) {
      if (sql.includes('FROM settings WHERE key IN')) {
        return {
          all: (...keys) => keys.map((k) => ({
            key: k,
            value: settings.has(k) ? settings.get(k) : '',
          })),
          get: () => null,
          run: () => ({ changes: 0 }),
        };
      }
      return {
        all: (...params) => all(sql, ...params),
        get: (...params) => get(sql, ...params),
        run: (...params) => run(sql, ...params),
      };
    },
    _outbox: outbox,
  };
  return api;
}

console.log('website-retail-multi-wh v331');

// —— A) channelWarehouseIds / channelWarehouseId ——
ok(channelWarehouseIds({ website_wh_wholesale_id: '10' }, 'WHOLESALE').join(',') === '10', 'A1 wholesale [10]');
ok(channelWarehouseIds({ website_wh_wholesale_id: '' }, 'WHOLESALE').length === 0, 'A2 wholesale empty');
ok(channelWarehouseId({ website_wh_wholesale_id: '0' }, 'WHOLESALE') == null, 'A2b wholesale 0 → null');
ok(channelWarehouseIds({
  website_wh_wholesale_id: '10',
  website_wh_wholesale_2_id: '11',
}, 'WHOLESALE').join(',') === '10,11', 'A1b wholesale primary+_2');
ok(channelWarehouseIds({
  website_wh_wholesale_id: '',
  website_wh_wholesale_2_id: '11',
}, 'WHOLESALE').length === 0, 'A1c wholesale _2 alone → []');
ok(channelWarehouseIds({
  website_wh_wholesale_id: '10',
  website_wh_wholesale_2_id: '10',
}, 'WHOLESALE').join(',') === '10', 'A1d wholesale dedupe _2=primary');

ok(channelWarehouseIds({
  website_wh_retail_id: '20',
  website_wh_retail_2_id: '',
  website_wh_retail_3_id: '',
}, 'RETAIL').join(',') === '20', 'A3 retail primary only');

ok(channelWarehouseIds({
  website_wh_retail_id: '20',
  website_wh_retail_2_id: '30',
  website_wh_retail_3_id: '40',
}, 'RETAIL').join(',') === '20,30,40', 'A4 retail three');

ok(channelWarehouseIds({
  website_wh_retail_id: '20',
  website_wh_retail_2_id: '',
  website_wh_retail_3_id: '0',
}, 'RETAIL').join(',') === '20', 'A5a empty/_0 optionals ignored');
ok(channelWarehouseIds({
  website_wh_retail_id: '20',
  website_wh_retail_2_id: '30',
  website_wh_retail_3_id: '',
}, 'RETAIL').join(',') === '20,30', 'A5b trailing empty ignored');

ok(channelWarehouseIds({
  website_wh_retail_id: '20',
  website_wh_retail_2_id: 'abc',
  website_wh_retail_3_id: '-1',
}, 'RETAIL').join(',') === '20', 'A6 invalid tokens ignored');

ok(channelWarehouseIds({
  website_wh_retail_id: '20',
  website_wh_retail_2_id: '20',
  website_wh_retail_3_id: '30',
}, 'RETAIL').join(',') === '20,30', 'A7 dedupe 20,20,30');

ok(channelWarehouseIds({
  website_wh_retail_id: '20',
  website_wh_retail_2_id: '30',
  website_wh_retail_3_id: '20',
}, 'RETAIL').join(',') === '20,30', 'A8 dedupe 20,30,20');

ok(channelWarehouseIds({
  website_wh_retail_id: '',
  website_wh_retail_2_id: '30',
  website_wh_retail_3_id: '40',
}, 'RETAIL').length === 0, 'A9 optionals alone do not open RETAIL');

ok(channelWarehouseId({
  website_wh_retail_id: '20',
  website_wh_retail_2_id: '30',
  website_wh_retail_3_id: '40',
}, 'RETAIL') === 20, 'A10 primary only via channelWarehouseId');

// —— B) configuredChannels ——
ok(configuredChannels({
  website_wh_wholesale_id: '10',
  website_wh_retail_id: '20',
}).join(',') === 'WHOLESALE,RETAIL', 'B11 both');

ok(configuredChannels({
  website_wh_wholesale_id: '10',
  website_wh_retail_id: '',
  website_wh_retail_2_id: '30',
}).join(',') === 'WHOLESALE', 'B12 no retail without primary');

ok(configuredChannels({
  website_wh_retail_id: '20',
  website_wh_retail_2_id: '30',
}).join(',') === 'RETAIL', 'B13 retail primary only');

// —— C) buildMatrixPayload SUM ——
const baseSettings = {
  website_stock_sync_enabled: '1',
  website_stock_sync_mode: 'push',
  website_target: 'site_b2b',
  website_b2b_url: 'https://api.example.com',
  website_b2b_token: 'test-key',
  website_wh_wholesale_id: '10',
  website_wh_retail_id: '20',
  website_wh_retail_2_id: '30',
  website_wh_retail_3_id: '40',
};

const db = makeFakeDb({
  settings: baseSettings,
  product: { id: 1, code: 'TAK-01', name: 'تک', website_stock_push: 1 },
  variants: [
    { id: 11, product_id: 1, sku: 'TAK-01-A', barcode: '1', color_name: 'مشکی', size_name: '۱', is_default: 0, active: 1 },
    { id: 99, product_id: 1, sku: 'TAK-01', barcode: null, color_name: '', size_name: '', is_default: 1, active: 1 },
  ],
  vws: [
    { variant_id: 11, warehouse_id: 20, qty: 1 },
    { variant_id: 11, warehouse_id: 30, qty: 2 },
    { variant_id: 11, warehouse_id: 40, qty: 4 },
    { variant_id: 11, warehouse_id: 99, qty: 99 },
    { variant_id: 11, warehouse_id: 10, qty: 8 },
  ],
});

const r1 = buildMatrixPayload(db, 1, 'RETAIL', [20]);
ok(r1 && !r1.skip && r1.channel === 'RETAIL', 'C14 retail single channel');
ok(r1.variants.find((v) => v.erpVariantSku === 'TAK-01-A').qty === 1, 'C14 qty=1');

const r3 = buildMatrixPayload(db, 1, 'RETAIL', [20, 30, 40]);
ok(r3.variants[0].qty === 7, 'C15 sum 1+2+4=7');
ok(r3.warehouseIds.join(',') === '20,30,40', 'C19 warehouseIds');
ok(r3.warehouseId === 20, 'C19 warehouseId primary');
ok(String(r3.idempotencyKey).includes(':wh20+30+40:'), 'C20 idempotency embeds all WHs');

const rMiss = buildMatrixPayload(db, 1, 'RETAIL', [20, 50]);
ok(rMiss.variants[0].qty === 1, 'C16 missing WH = 0 in sum');

const rDedup = buildMatrixPayload(db, 1, 'RETAIL', [20, 20, 30]);
ok(rDedup.variants[0].qty === 3, 'C17 dedupe before sum');
ok(rDedup.warehouseIds.join(',') === '20,30', 'C17 warehouseIds deduped');

const w = buildMatrixPayload(db, 1, 'WHOLESALE', 10);
ok(w.variants[0].qty === 8 && w.warehouseIds.join(',') === '10', 'C18 wholesale single');

ok(r3.variants.length === 1, 'C21 default variant excluded');

const dbOff = makeFakeDb({
  settings: baseSettings,
  product: { id: 2, code: 'OFF', name: 'خاموش', website_stock_push: 0 },
  variants: [{ id: 21, product_id: 2, sku: 'OFF-A', is_default: 0, active: 1 }],
  vws: [{ variant_id: 21, warehouse_id: 20, qty: 5 }],
});
const skip = buildMatrixPayload(dbOff, 2, 'RETAIL', [20, 30]);
ok(skip && skip.skip && skip.reason === 'product_website_stock_off', 'C22 push-off skip');

// —— D) enqueue one RETAIL row ——
ensureWebsiteStockOutbox(db);
const enq = enqueueWebsiteStock(db, 1);
ok(enq.ok && enq.enqueued === 2, 'D23 enqueued WHOLESALE+RETAIL');
ok(db._outbox.size === 2, 'D23 outbox size 2 not 4');

const enqExtra = enqueueWebsiteStock(db, 1, { warehouseId: 30, force: true });
ok(enqExtra.ok && enqExtra.enqueued === 1, 'D23b move on retail_2 → only RETAIL');

const enqUnrelated = enqueueWebsiteStock(db, 1, { warehouseId: 99, force: true });
ok(enqUnrelated.ok && enqUnrelated.enqueued === 0, 'D23c unrelated WH → none');

console.log('ALL PASS');
process.exit(0);
