/**
 * products.website_stock_push gate — unit checks (no native sqlite / no network).
 * node server/scripts/test-website-stock-push-v330.js
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-website-stock-push-v330';

const {
  normalizeWebsiteStockPush,
  productAllowsWebsiteStockPush,
  ensureWebsiteStockOutbox,
  buildMatrixPayload,
  enqueueWebsiteStock,
  summarizeOutboxRow,
} = require('../lib/website-stock-sync');

let assertions = 0;

function ok(cond, msg) {
  assertions += 1;
  if (!cond) throw new Error(msg);
  console.log('PASS', msg);
}

const DEFAULT_SETTINGS = {
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

/** Minimal better-sqlite3-compatible stub for website-stock-sync queries. */
function makeFakeDb(seed = {}) {
  const settings = new Map(Object.entries({ ...DEFAULT_SETTINGS, ...(seed.settings || {}) }));
  const outbox = new Map(); // key product_id|channel → row
  let outboxSeq = 1;

  const productsById = new Map();
  if (seed.product) productsById.set(seed.product.id, { ...seed.product });
  for (const p of seed.products || []) productsById.set(p.id, { ...p });

  const variants = seed.variants || [];
  const vws = seed.vws || [];

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
    return [];
  }

  function get(sql, ...params) {
    if (sql.includes('FROM settings') && sql.includes('WHERE key=?')) {
      const key = params[0];
      return settings.has(key) ? { value: settings.get(key) } : { value: '' };
    }
    if (sql.includes('FROM products')) {
      const id = params[0];
      return productsById.get(id) || null;
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
    if (sql.includes('UPDATE settings SET value=?')) {
      const [value, key] = params;
      settings.set(key, value);
      return { changes: 1 };
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
          payload_hash: '',
          created_at: updated,
          updated_at: updated,
        });
      }
      return { changes: 1 };
    }
    if (sql.includes('UPDATE website_stock_outbox') && sql.includes("status='done'")) {
      const lastResult = params[0];
      const updatedAt = params[1];
      const productId = params[2];
      let changes = 0;
      for (const row of outbox.values()) {
        if (row.product_id === productId && row.status === 'pending') {
          row.status = 'done';
          row.attempts = 0;
          row.last_error = '';
          row.last_result = lastResult;
          row.updated_at = updatedAt;
          changes += 1;
        }
      }
      return { changes };
    }
    if (sql.includes('UPDATE website_stock_outbox')) {
      return { changes: 1 };
    }
    return { changes: 0 };
  }

  const api = {
    exec(sql) {
      void sql;
    },
    prepare(sql) {
      if (sql.includes('FROM settings WHERE key IN')) {
        return {
          all: (...keys) => keys.map((k) => ({
            key: k,
            value: settings.has(k) ? settings.get(k) : '',
          })),
          get: (...p) => get(sql, ...p),
          run: (...p) => run(sql, ...p),
        };
      }
      return {
        all: (...p) => all(sql, ...p),
        get: (...p) => get(sql, ...p),
        run: (...p) => run(sql, ...p),
      };
    },
    _outbox: outbox,
    _seedPending(productId, channel, extra = {}) {
      const now = Math.floor(Date.now() / 1000);
      const key = `${productId}|${channel}`;
      outbox.set(key, {
        id: outboxSeq++,
        product_id: productId,
        channel,
        next_at: now,
        attempts: 0,
        status: 'pending',
        last_error: '',
        last_result: '',
        payload_hash: '',
        created_at: now,
        updated_at: now,
        ...extra,
      });
    },
  };
  return api;
}

console.log('website-stock-push v330');

// —— 1) normalizeWebsiteStockPush / productAllowsWebsiteStockPush ——
ok(normalizeWebsiteStockPush(null) === 1, 'normalize null → 1');
ok(normalizeWebsiteStockPush('') === 1, 'normalize empty → 1');
ok(normalizeWebsiteStockPush('1') === 1, 'normalize "1" → 1');
ok(normalizeWebsiteStockPush('on') === 1, 'normalize on → 1');
ok(normalizeWebsiteStockPush(0) === 0, 'normalize 0 → 0');
ok(normalizeWebsiteStockPush('off') === 0, 'normalize off → 0');
ok(normalizeWebsiteStockPush('bogus', 0) === 0, 'normalize unknown with fb 0 → 0');

ok(productAllowsWebsiteStockPush(null) === false, 'productAllows null → false');
ok(productAllowsWebsiteStockPush({ id: 1 }) === true, 'missing website_stock_push → allow');
ok(productAllowsWebsiteStockPush({ id: 1, website_stock_push: 1 }) === true, 'push 1 → allow');
ok(productAllowsWebsiteStockPush({ id: 1, website_stock_push: 0 }) === false, 'push 0 → block');
ok(productAllowsWebsiteStockPush({ id: 1, website_stock_push: null }) === true, 'push null present → allow');

const sharedVariants = [
  { id: 21, product_id: 2, sku: 'OFF-01-MSH-1', barcode: '300001', color_name: 'مشکی', size_name: '۱', is_default: 0, active: 1 },
];
const sharedVws = [{ variant_id: 21, warehouse_id: 10, qty: 4 }];

// —— 2) enqueue skipped when push off ——
const dbOff = makeFakeDb({
  product: { id: 2, code: 'OFF-01', name: 'خاموش', website_stock_push: 0 },
  variants: sharedVariants,
  vws: sharedVws,
});
ensureWebsiteStockOutbox(dbOff);
const skipEnq = enqueueWebsiteStock(dbOff, 2);
ok(skipEnq.skipped === true, 'enqueue push off → skipped');
ok(skipEnq.reason === 'product_website_stock_off', 'enqueue push off reason');
ok(skipEnq.enqueued === 0, 'enqueue push off enqueued 0');
ok(dbOff._outbox.size === 0, 'enqueue push off no outbox rows');

// —— 3) silence pending when push off ——
const dbPending = makeFakeDb({
  product: { id: 2, code: 'OFF-01', name: 'خاموش', website_stock_push: 0 },
  variants: sharedVariants,
  vws: sharedVws,
});
ensureWebsiteStockOutbox(dbPending);
dbPending._seedPending(2, 'WHOLESALE');
dbPending._seedPending(2, 'RETAIL');
const silenceEnq = enqueueWebsiteStock(dbPending, 2);
ok(silenceEnq.reason === 'product_website_stock_off', 'silence enqueue reason');
ok([...dbPending._outbox.values()].every((r) => r.status === 'done'), 'pending → done');
const expectedSkipBody = JSON.stringify({ skipped: true, reason: 'product_website_stock_off' });
ok(
  [...dbPending._outbox.values()].every((r) => r.last_result === expectedSkipBody),
  'pending last_result product_website_stock_off',
);

// —— 4) push on (explicit 1) and legacy row without property ——
const dbOn = makeFakeDb({
  product: { id: 3, code: 'ON-01', name: 'روشن', website_stock_push: 1 },
  variants: [
    { id: 31, product_id: 3, sku: 'ON-01-MSH-1', barcode: '400001', color_name: 'مشکی', size_name: '۱', is_default: 0, active: 1 },
  ],
  vws: [{ variant_id: 31, warehouse_id: 10, qty: 2 }],
});
ensureWebsiteStockOutbox(dbOn);
const enqOn = enqueueWebsiteStock(dbOn, 3);
ok(enqOn.ok === true && enqOn.enqueued === 2, 'enqueue push 1 both channels');

const dbLegacy = makeFakeDb({
  product: { id: 4, code: 'LEG-01', name: 'قدیمی' },
  variants: [
    { id: 41, product_id: 4, sku: 'LEG-01-MSH-1', barcode: '500001', color_name: 'مشکی', size_name: '۱', is_default: 0, active: 1 },
  ],
  vws: [{ variant_id: 41, warehouse_id: 10, qty: 1 }],
});
ensureWebsiteStockOutbox(dbLegacy);
const enqLegacy = enqueueWebsiteStock(dbLegacy, 4);
ok(enqLegacy.ok === true && enqLegacy.enqueued === 2, 'enqueue legacy product without column');

// —— 5) buildMatrixPayload skip ——
const payloadOff = buildMatrixPayload(dbOff, 2, 'WHOLESALE', 10);
ok(payloadOff && payloadOff.skip === true, 'buildMatrixPayload skip');
ok(payloadOff.reason === 'product_website_stock_off', 'buildMatrixPayload skip reason');

// —— 6) summarizeOutboxRow skipped off → cause ok ——
const summary = summarizeOutboxRow({
  product_id: 2,
  product_code: 'OFF-01',
  product_name: 'خاموش',
  channel: 'WHOLESALE',
  status: 'done',
  last_error: '',
  last_result: expectedSkipBody,
});
ok(summary.cause === 'ok', 'summarizeOutboxRow cause ok for push off');
ok(summary.tone === 'ok', 'summarizeOutboxRow tone ok for push off');

console.log(`ALL PASS (${assertions} assertions)`);
process.exit(0);
