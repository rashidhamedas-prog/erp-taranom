/**
 * Website matrix stock sync — unit checks (no native sqlite / no network).
 * node server/scripts/test-website-stock-matrix-v256.js
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-website-stock-matrix-v256';

const {
  ensureWebsiteStockOutbox,
  buildMatrixPayload,
  enqueueWebsiteStock,
  channelWarehouseId,
  configuredChannels,
  resolveTarget,
  siteB2bApiUrl,
} = require('../lib/website-stock-sync');

function ok(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log('  ✓', msg);
}

/** Minimal better-sqlite3-compatible stub for the queries this module uses. */
function makeFakeDb(seed) {
  const settings = new Map(Object.entries(seed.settings || {}));
  const outbox = new Map(); // key product_id|channel → row
  let outboxSeq = 1;

  const variants = seed.variants || [];
  const vws = seed.vws || []; // {variant_id, warehouse_id, qty}
  const product = seed.product;

  function all(sql, ...params) {
    if (sql.includes('FROM product_variants v') && sql.includes('variant_warehouse_stock')) {
      const [warehouseId, productId] = params;
      return variants
        .filter((v) => v.product_id === productId && v.active !== 0 && !v.is_default)
        .map((v) => {
          const row = vws.find((x) => x.variant_id === v.id && x.warehouse_id === warehouseId);
          return {
            variant_id: v.id,
            sku: v.sku,
            barcode: v.barcode,
            color_name: v.color_name || '',
            size_name: v.size_name || '',
            qty: row ? row.qty : 0,
          };
        });
    }
    if (sql.includes('FROM website_stock_outbox') && sql.includes('GROUP BY status')) {
      const counts = {};
      for (const r of outbox.values()) counts[r.status] = (counts[r.status] || 0) + 1;
      return Object.entries(counts).map(([status, c]) => ({ status, c }));
    }
    if (sql.includes('FROM website_stock_outbox') && sql.includes('ORDER BY updated_at')) {
      return [...outbox.values()].sort((a, b) => b.updated_at - a.updated_at).slice(0, 30);
    }
    if (sql.includes('FROM website_stock_outbox') && sql.includes("status='pending'")) {
      const now = params[0];
      const limit = params[1] || 20;
      return [...outbox.values()]
        .filter((r) => r.status === 'pending' && r.next_at <= now)
        .sort((a, b) => a.next_at - b.next_at)
        .slice(0, limit);
    }
    if (sql.includes('DISTINCT product_id')) {
      const ids = [...new Set(variants.filter((v) => !v.is_default).map((v) => v.product_id))];
      return ids.map((id) => ({ id }));
    }
    return [];
  }

  function get(sql, ...params) {
    if (sql.includes('FROM settings')) {
      const key = params[0];
      const v = settings.has(key) ? settings.get(key) : '';
      return { value: v };
    }
    if (sql.includes('FROM products')) {
      if (product && product.id === params[0]) return product;
      return null;
    }
    if (sql.includes('FROM website_stock_outbox') && sql.includes('WHERE id=?')) {
      return [...outbox.values()].find((r) => r.id === params[0]) || null;
    }
    return null;
  }

  function run(sql, ...params) {
    if (sql.includes('CREATE TABLE IF NOT EXISTS website_stock_outbox') || sql.includes('CREATE INDEX')) {
      return { changes: 0 };
    }
    if (sql.includes('INSERT INTO website_stock_outbox')) {
      const [product_id, channel, next_at, attempts, , updated_at] = params;
      // ON CONFLICT upsert shape from module uses 4 bind params in INSERT then update
      // Actual: INSERT ... VALUES (?, ?, ?, 0, 'pending', ?) → product_id, channel, next_at, updated_at
      const pid = params[0];
      const ch = params[1];
      const next = params[2];
      const updated = params[params.length - 1];
      const key = `${pid}|${ch}`;
      if (outbox.has(key)) {
        const row = outbox.get(key);
        row.next_at = next;
        row.status = 'pending';
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
          payload_hash: '',
          created_at: updated,
          updated_at: updated,
        });
      }
      return { changes: 1 };
    }
    if (sql.includes('UPDATE website_stock_outbox')) {
      return { changes: 1 };
    }
    return { changes: 0 };
  }

  const api = {
    exec(sql) {
      // multi-statement create — no-op for stub
      void sql;
    },
    prepare(sql) {
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

console.log('website-stock-matrix v256');

ok(resolveTarget({ website_target: 'site_b2b' }) === 'site_b2b', 'resolveTarget site_b2b');
ok(channelWarehouseId({
  website_wh_wholesale_id: '10',
  website_wh_retail_id: '20',
}, 'WHOLESALE') === 10, 'WH wholesale');
ok(channelWarehouseId({
  website_wh_wholesale_id: '10',
  website_wh_retail_id: '20',
}, 'RETAIL') === 20, 'WH retail');
ok(configuredChannels({
  website_wh_wholesale_id: '10',
  website_wh_retail_id: '20',
}).join(',') === 'WHOLESALE,RETAIL', 'both channels');

ok(
  siteB2bApiUrl('https://api.poshaktaranom.com', 'erp/inventory/matrix')
    === 'https://api.poshaktaranom.com/v1/erp/inventory/matrix',
  'api host → /v1 matrix'
);
ok(
  siteB2bApiUrl('https://poshaktaranom.com', 'erp/inventory/ping')
    === 'https://poshaktaranom.com/api/v1/erp/inventory/ping',
  'storefront → /api/v1 ping'
);
ok(
  siteB2bApiUrl('https://x.example/v1', 'erp/inventory/matrix')
    === 'https://x.example/v1/erp/inventory/matrix',
  'base ends /v1'
);
ok(
  siteB2bApiUrl('https://x.example/api/v1', 'erp/inventory/matrix')
    === 'https://x.example/api/v1/erp/inventory/matrix',
  'base ends /api/v1'
);

const db = makeFakeDb({
  settings: {
    website_stock_sync_enabled: '1',
    website_stock_sync_mode: 'push',
    website_target: 'site_b2b',
    website_b2b_url: 'https://api.example.com',
    website_b2b_token: 'test-key',
    website_wh_wholesale_id: '10',
    website_wh_retail_id: '20',
  },
  product: { id: 1, code: 'ERIKA-01', name: 'اریکا', stock: 99 },
  variants: [
    { id: 11, product_id: 1, sku: 'ERIKA-01-MSH-1', barcode: '200001', color_name: 'مشکی', size_name: 'سایز ۱', is_default: 0, active: 1 },
    { id: 12, product_id: 1, sku: 'ERIKA-01-MSH-2', barcode: '200002', color_name: 'مشکی', size_name: 'سایز ۲', is_default: 0, active: 1 },
    { id: 13, product_id: 1, sku: 'ERIKA-01-CRM-1', barcode: '200003', color_name: 'کرم', size_name: 'سایز ۱', is_default: 0, active: 1 },
    { id: 14, product_id: 1, sku: 'ERIKA-01', barcode: null, color_name: '', size_name: '', is_default: 1, active: 1 },
  ],
  vws: [
    { variant_id: 11, warehouse_id: 10, qty: 5 },
    { variant_id: 12, warehouse_id: 10, qty: 7 },
    { variant_id: 13, warehouse_id: 10, qty: 0 },
    { variant_id: 11, warehouse_id: 20, qty: 1 },
    { variant_id: 12, warehouse_id: 20, qty: 2 },
    { variant_id: 13, warehouse_id: 20, qty: 3 },
  ],
});

// secret-settings getSettings reads via SELECT key,value — our stub returns single key.
// Patch getSettings path: website-stock-sync uses getSettings(db, keys) which does
// prepare('SELECT key,value FROM settings WHERE key IN (...)').all()
// Adjust stub to support that pattern.
const _prep = db.prepare.bind(db);
db.prepare = (sql) => {
  if (sql.includes('FROM settings WHERE key IN')) {
    return {
      all: (...keys) => keys.map((k) => {
        // getSettings builds IN (?,?,?) and spreads keys — our seed Settings map
        const seed = {
          website_stock_sync_enabled: '1',
          website_stock_sync_mode: 'push',
          website_target: 'site_b2b',
          website_b2b_url: 'https://api.example.com',
          website_b2b_token: 'test-key',
          website_wh_wholesale_id: '10',
          website_wh_retail_id: '20',
          website_stock_webhook_url: '',
          website_wc_url: '',
          website_wc_key: '',
          website_wc_secret: '',
          webhook_secret: '',
          website_b2b_channel: '',
        };
        return { key: k, value: seed[k] != null ? seed[k] : '' };
      }),
      get: () => null,
      run: () => ({ changes: 0 }),
    };
  }
  return _prep(sql);
};

const payloadW = buildMatrixPayload(db, 1, 'WHOLESALE', 10);
ok(payloadW && !payloadW.skip, 'wholesale payload built');
ok(payloadW.productSku === 'ERIKA-01', 'productSku from products.code');
ok(payloadW.variants.length === 3, 'default variant excluded');
ok(payloadW.variants.find((v) => v.erpVariantSku === 'ERIKA-01-MSH-1').qty === 5, 'VWS qty wholesale');
ok(payloadW.variants.every((v) => typeof v.color === 'string' && typeof v.size === 'string'), 'color/size present');
ok(Number(payloadW.variants.reduce((s, v) => s + v.qty, 0)) === 12, 'sum VWS not products.stock=99');

const payloadR = buildMatrixPayload(db, 1, 'RETAIL', 20);
ok(payloadR.variants.find((v) => v.erpVariantSku === 'ERIKA-01-MSH-1').qty === 1, 'VWS qty retail');
ok(payloadR.variants.find((v) => v.erpVariantSku === 'ERIKA-01-CRM-1').qty === 3, 'retail cream size1');

ensureWebsiteStockOutbox(db);
const enq = enqueueWebsiteStock(db, 1);
ok(enq.ok && enq.enqueued === 2, 'enqueue both channels');
ok(db._outbox.size === 2, 'outbox pending rows');

console.log('ALL PASS');
process.exit(0);
