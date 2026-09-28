/**
 * Website stock sync — ERP → Site-B2B matrix (color×size).
 *
 * System of record: variant_warehouse_stock for the warehouse configured
 * per channel (website_wh_wholesale_id / website_wh_retail_id).
 *
 * Push contract: PUT {base}/api/v1/erp/inventory/matrix
 * Auth: Bearer / x-api-key = website_b2b_token (ERP_INVENTORY_API_KEY on site).
 *
 * Outbox + debounce coalesce bursts (invoice line storms) into one push per
 * product×channel. WooCommerce path kept for legacy when target includes woo.
 */
'use strict';

const { safeRequestJSON } = require('./safe-outbound-request');
const { getSetting, getSettings } = require('./secret-settings');

const DEBOUNCE_MS = 2000;
const MAX_ATTEMPTS = 8;
const DRAIN_BATCH = 20;

function getSettingsMap(db) {
  return getSettings(db, [
    'website_stock_sync_enabled',
    'website_stock_sync_mode',
    'website_stock_webhook_url',
    'website_wc_url',
    'website_wc_key',
    'website_wc_secret',
    'webhook_secret',
    'website_target',
    'website_b2b_url',
    'website_b2b_token',
    'website_b2b_channel',
    'website_wh_wholesale_id',
    'website_wh_retail_id',
  ]);
}

function resolveTarget(s) {
  const t = String(s.website_target || '').trim().toLowerCase();
  if (t === 'woocommerce') return 'woo';
  if (t === 'woo' || t === 'site_b2b' || t === 'both') return t;
  return String(s.website_b2b_url || '').trim() ? 'site_b2b' : 'woo';
}

function syncPushEnabled(s) {
  return s.website_stock_sync_enabled === '1'
    && ['push', 'both'].includes(s.website_stock_sync_mode || 'pull');
}

function siteB2bEnabled(s) {
  const t = resolveTarget(s);
  return t === 'site_b2b' || t === 'both';
}

function wooEnabled(s) {
  const t = resolveTarget(s);
  return t === 'woo' || t === 'both';
}

function normalizeBase(urlStr) {
  return String(urlStr || '').trim().replace(/\/+$/, '');
}

function b2bAuthHeaders(token) {
  return {
    Authorization: `Bearer ${String(token || '').trim()}`,
    'x-api-key': String(token || '').trim(),
  };
}

function channelWarehouseId(s, channel) {
  const key = channel === 'RETAIL' ? 'website_wh_retail_id' : 'website_wh_wholesale_id';
  const n = parseInt(s[key], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function configuredChannels(s) {
  const out = [];
  if (channelWarehouseId(s, 'WHOLESALE')) out.push('WHOLESALE');
  if (channelWarehouseId(s, 'RETAIL')) out.push('RETAIL');
  // Legacy single-channel setting as fallback when no WH ids set
  if (!out.length) {
    const legacy = String(s.website_b2b_channel || 'WHOLESALE').toUpperCase() === 'RETAIL'
      ? 'RETAIL' : 'WHOLESALE';
    out.push(legacy);
  }
  return out;
}

async function requestJSON(urlStr, method, body, headers = {}) {
  try {
    return await safeRequestJSON(urlStr, method, body, headers, {
      timeoutMs: 20_000,
      maxResponseBytes: 2 * 1024 * 1024,
      maxRedirects: 3,
    });
  } catch (error) {
    return { status: 0, body: error && error.code ? error.code : 'outbound request rejected' };
  }
}

function ensureWebsiteStockOutbox(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS website_stock_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      channel TEXT NOT NULL,
      next_at INTEGER NOT NULL,
      attempts INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      last_error TEXT DEFAULT '',
      last_result TEXT DEFAULT '',
      payload_hash TEXT DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(product_id, channel)
    );
    CREATE INDEX IF NOT EXISTS idx_website_stock_outbox_due
      ON website_stock_outbox(status, next_at);
  `);
}

function stockPayload(product) {
  return {
    event: 'product.stock',
    id: product.id,
    code: product.code || '',
    barcode: product.barcode || '',
    name: product.name || '',
    stock: Number(product.stock) || 0,
    unit: product.unit || 'عدد',
    updated_at: Math.floor(Date.now() / 1000),
  };
}

async function fireStockWebhooks(db, product) {
  try {
    const { guardDemoEgressOrBlock } = require('./demo-egress');
    const blocked = guardDemoEgressOrBlock('webhook');
    if (blocked) return blocked;
  } catch {
    if (/^(true|1|yes)$/i.test(String(process.env.ERP_DEMO_MODE || ''))) {
      return { ok: false, simulated: true, demo: true, channel: 'webhook', code: 'demo_simulation' };
    }
  }
  const payload = stockPayload(product);
  const secret = getSetting(db, 'webhook_secret');
  const hooks = db.prepare('SELECT * FROM webhooks WHERE active=1').all()
    .filter((w) => String(w.events || '').includes('product.stock') || String(w.events || '').includes('*'));
  const s = getSettingsMap(db);
  if (s.website_stock_webhook_url) {
    hooks.push({ url: s.website_stock_webhook_url, secret: secret || '' });
  }
  await Promise.all(hooks.map(async (h) => {
    const headers = {};
    const sec = h.secret || secret;
    if (sec) headers['X-Webhook-Secret'] = sec;
    await requestJSON(h.url, 'POST', payload, headers);
  }));
}

async function pushWooCommerceStock(db, product) {
  try {
    const { guardDemoEgressOrBlock } = require('./demo-egress');
    const blocked = guardDemoEgressOrBlock('woocommerce');
    if (blocked) return blocked;
  } catch {
    if (/^(true|1|yes)$/i.test(String(process.env.ERP_DEMO_MODE || ''))) {
      return { ok: false, simulated: true, demo: true, channel: 'woocommerce', code: 'demo_simulation' };
    }
  }
  const s = getSettingsMap(db);
  if (s.website_stock_sync_enabled !== '1') return { skipped: true };
  if (!['push', 'both'].includes(s.website_stock_sync_mode || 'pull')) return { skipped: true };
  const base = (s.website_wc_url || '').replace(/\/$/, '');
  const key = s.website_wc_key || '';
  const secret = s.website_wc_secret || '';
  const sku = String(product.code || '').trim();
  if (!base || !key || !secret || !sku) return { skipped: true, reason: 'missing wc config or sku' };

  const auth = Buffer.from(`${key}:${secret}`).toString('base64');
  const listUrl = `${base}/wp-json/wc/v3/products?sku=${encodeURIComponent(sku)}`;
  const found = await requestJSON(listUrl, 'GET', null, { Authorization: `Basic ${auth}` });
  let products = [];
  try { products = JSON.parse(found.body); } catch { /* */ }
  if (!Array.isArray(products) || !products.length) return { ok: false, reason: 'sku not found on website' };
  const wcId = products[0].id;
  const upd = await requestJSON(
    `${base}/wp-json/wc/v3/products/${wcId}`,
    'PUT',
    { manage_stock: true, stock_quantity: Math.max(0, Math.round(Number(product.stock) || 0)) },
    { Authorization: `Basic ${auth}` }
  );
  return { ok: upd.status >= 200 && upd.status < 300, status: upd.status };
}

/**
 * Build matrix payload from variant_warehouse_stock for one product+channel.
 * Qty source is VWS only (never products.stock header).
 */
function buildMatrixPayload(db, productId, channel, warehouseId) {
  const product = db.prepare('SELECT id, code, name FROM products WHERE id=?').get(productId);
  if (!product) return null;
  const productSku = String(product.code || '').trim();
  if (!productSku) return { skip: true, reason: 'missing product.code' };

  const rows = db.prepare(`
    SELECT v.id AS variant_id, v.sku, v.barcode,
           COALESCE(c.name, '') AS color_name,
           COALESCE(s.name, '') AS size_name,
           COALESCE(vws.qty, 0) AS qty
    FROM product_variants v
    LEFT JOIN product_colors c ON c.id = v.color_id
    LEFT JOIN product_sizes s ON s.id = v.size_id
    LEFT JOIN variant_warehouse_stock vws
      ON vws.variant_id = v.id AND vws.warehouse_id = ?
    WHERE v.product_id = ?
      AND COALESCE(v.active, 1) = 1
      AND COALESCE(v.is_default, 0) = 0
    ORDER BY c.sort_order, s.sort_order, v.id
  `).all(warehouseId, productId);

  if (!rows.length) {
    return { skip: true, reason: 'no_matrix_variants', productSku };
  }

  const variants = rows.map((r) => ({
    erpVariantSku: String(r.sku || '').trim() || `V-${r.variant_id}`,
    barcode: String(r.barcode || '').trim() || undefined,
    color: String(r.color_name || '').trim() || 'بدون‌رنگ',
    size: String(r.size_name || '').trim() || 'فری سایز',
    qty: Math.max(0, Math.round(Number(r.qty) || 0)),
  }));

  const idempotencyKey = `erp:${channel}:p${productId}:wh${warehouseId}:h${hashVariants(variants)}`;
  return {
    productSku,
    channel,
    warehouseId,
    idempotencyKey,
    variants,
  };
}

function hashVariants(variants) {
  const crypto = require('crypto');
  return crypto.createHash('sha1')
    .update(JSON.stringify(variants))
    .digest('hex')
    .slice(0, 12);
}

async function pushMatrixToSite(db, payload, { dryRun = false } = {}) {
  try {
    const { guardDemoEgressOrBlock } = require('./demo-egress');
    const blocked = guardDemoEgressOrBlock('site_b2b');
    if (blocked) return blocked;
  } catch {
    if (/^(true|1|yes)$/i.test(String(process.env.ERP_DEMO_MODE || ''))) {
      return { ok: false, simulated: true, demo: true, channel: 'site_b2b', code: 'demo_simulation' };
    }
  }
  const s = getSettingsMap(db);
  if (!syncPushEnabled(s) && !dryRun) return { skipped: true, reason: 'stock sync push disabled' };
  if (!siteB2bEnabled(s)) return { skipped: true, reason: 'site_b2b target disabled' };
  const base = normalizeBase(s.website_b2b_url);
  const token = String(s.website_b2b_token || '').trim();
  if (!base || !token) return { skipped: true, reason: 'missing b2b config' };
  if (!payload || payload.skip) return { skipped: true, reason: (payload && payload.reason) || 'empty payload' };

  const body = {
    idempotencyKey: payload.idempotencyKey,
    channel: payload.channel,
    productSku: payload.productSku,
    variants: payload.variants,
    dryRun: !!dryRun,
  };
  const url = `${base}/api/v1/erp/inventory/matrix`;
  const res = await requestJSON(url, 'PUT', body, b2bAuthHeaders(token));
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { /* */ }
  const ok = res.status >= 200 && res.status < 300;
  return {
    ok,
    status: res.status,
    channel: payload.channel,
    productSku: payload.productSku,
    matched: parsed && parsed.matched ? parsed.matched.length : 0,
    unmatched: parsed && parsed.unmatched ? parsed.unmatched : [],
    body: parsed,
    dryRun: !!dryRun,
  };
}

/** Enqueue product for website push (debounced per product×channel). */
function enqueueWebsiteStock(db, productId, opts = {}) {
  const pid = parseInt(productId, 10);
  if (!pid) return { skipped: true };
  ensureWebsiteStockOutbox(db);
  const s = getSettingsMap(db);
  if (!syncPushEnabled(s) && !opts.force) return { skipped: true, reason: 'disabled' };
  if (!siteB2bEnabled(s) && !opts.force) return { skipped: true, reason: 'target' };

  const channels = opts.channel
    ? [String(opts.channel).toUpperCase() === 'RETAIL' ? 'RETAIL' : 'WHOLESALE']
    : configuredChannels(s);

  const now = Math.floor(Date.now() / 1000);
  const nextAt = now + Math.ceil(DEBOUNCE_MS / 1000);
  const upsert = db.prepare(`
    INSERT INTO website_stock_outbox (product_id, channel, next_at, attempts, status, updated_at)
    VALUES (?, ?, ?, 0, 'pending', ?)
    ON CONFLICT(product_id, channel) DO UPDATE SET
      next_at=excluded.next_at,
      status='pending',
      updated_at=excluded.updated_at
  `);

  let n = 0;
  for (const ch of channels) {
    const wh = channelWarehouseId(s, ch);
    if (!wh && !opts.force) continue;
    upsert.run(pid, ch, nextAt, now);
    n += 1;
  }
  scheduleDrain(db);
  return { ok: true, enqueued: n };
}

let _drainTimer = null;
let _drainRunning = false;

function scheduleDrain(db) {
  if (_drainTimer) return;
  _drainTimer = setTimeout(() => {
    _drainTimer = null;
    drainWebsiteStockOutbox(db).catch((e) => {
      console.error('[website-stock-sync] drain', e.message);
    });
  }, DEBOUNCE_MS + 50);
}

async function drainWebsiteStockOutbox(db) {
  if (_drainRunning) return { busy: true };
  _drainRunning = true;
  try {
    ensureWebsiteStockOutbox(db);
    const s = getSettingsMap(db);
    if (!syncPushEnabled(s)) return { skipped: true };

    const now = Math.floor(Date.now() / 1000);
    const due = db.prepare(`
      SELECT * FROM website_stock_outbox
      WHERE status='pending' AND next_at<=?
      ORDER BY next_at ASC LIMIT ?
    `).all(now, DRAIN_BATCH);

    const results = [];
    for (const row of due) {
      const channel = row.channel === 'RETAIL' ? 'RETAIL' : 'WHOLESALE';
      const wh = channelWarehouseId(s, channel);
      if (!wh) {
        db.prepare(`UPDATE website_stock_outbox SET status='error', last_error=?, updated_at=? WHERE id=?`)
          .run('warehouse not configured for channel', now, row.id);
        results.push({ id: row.id, ok: false, reason: 'no_warehouse' });
        continue;
      }

      const payload = buildMatrixPayload(db, row.product_id, channel, wh);
      if (!payload || payload.skip) {
        db.prepare(`UPDATE website_stock_outbox SET status='done', last_result=?, last_error='', updated_at=? WHERE id=?`)
          .run(JSON.stringify({ skipped: true, reason: payload && payload.reason }), now, row.id);
        results.push({ id: row.id, skipped: true });
        continue;
      }

      const push = await pushMatrixToSite(db, payload);
      if (push.ok || push.skipped) {
        db.prepare(`
          UPDATE website_stock_outbox
          SET status='done', last_result=?, last_error='', payload_hash=?, updated_at=?
          WHERE id=?
        `).run(
          JSON.stringify({
            matched: push.matched,
            unmatched: push.unmatched,
            status: push.status,
          }),
          payload.idempotencyKey,
          now,
          row.id
        );
        results.push({ id: row.id, ok: true, unmatched: push.unmatched });
      } else {
        const attempts = (Number(row.attempts) || 0) + 1;
        const backoff = Math.min(3600, Math.pow(2, attempts) * 5);
        const status = attempts >= MAX_ATTEMPTS ? 'error' : 'pending';
        db.prepare(`
          UPDATE website_stock_outbox
          SET attempts=?, next_at=?, status=?, last_error=?, updated_at=?
          WHERE id=?
        `).run(
          attempts,
          now + backoff,
          status,
          String(push.reason || push.body || `HTTP ${push.status}`).slice(0, 500),
          now,
          row.id
        );
        results.push({ id: row.id, ok: false, attempts, status });
        if (status === 'pending') scheduleDrain(db);
      }
    }

    // Legacy webhook + woo for product header (optional)
    if (due.length && wooEnabled(s)) {
      const seen = new Set();
      for (const row of due) {
        if (seen.has(row.product_id)) continue;
        seen.add(row.product_id);
        const p = db.prepare('SELECT id,code,barcode,name,stock,unit FROM products WHERE id=?').get(row.product_id);
        if (p) {
          await fireStockWebhooks(db, p).catch(() => {});
          await pushWooCommerceStock(db, p).catch(() => {});
        }
      }
    }

    return { ok: true, processed: results.length, results };
  } finally {
    _drainRunning = false;
  }
}

/** Call after any stock mutation (non-blocking). */
function notifyStockChanged(db, productId) {
  setImmediate(() => {
    try {
      enqueueWebsiteStock(db, productId);
    } catch (e) {
      console.error('[website-stock-sync]', e.message);
    }
  });
}

async function testWebsiteConnection(arg) {
  const db = arg && typeof arg.prepare === 'function' ? arg : (arg && arg.db);
  if (!db) return { ok: false, target: '', status: 0, reason: 'missing db' };
  const s = getSettingsMap(db);
  const target = resolveTarget(s);

  try {
    const { guardDemoEgressOrBlock } = require('./demo-egress');
    const blocked = guardDemoEgressOrBlock('site_b2b');
    if (blocked) return { ok: false, target, status: 0, reason: 'demo_simulation' };
  } catch {
    if (/^(true|1|yes)$/i.test(String(process.env.ERP_DEMO_MODE || ''))) {
      return { ok: false, target, status: 0, reason: 'demo_simulation' };
    }
  }

  if (siteB2bEnabled(s)) {
    const base = normalizeBase(s.website_b2b_url);
    const token = String(s.website_b2b_token || '').trim();
    if (!base) return { ok: false, target, status: 0, reason: 'missing website_b2b_url' };
    if (!token) return { ok: false, target, status: 0, reason: 'missing website_b2b_token' };
    const res = await requestJSON(`${base}/api/v1/erp/inventory/ping`, 'GET', null, b2bAuthHeaders(token));
    const ok = res.status >= 200 && res.status < 300;
    const whW = channelWarehouseId(s, 'WHOLESALE');
    const whR = channelWarehouseId(s, 'RETAIL');
    return {
      ok,
      target,
      status: res.status,
      reason: ok ? 'ok' : 'site_b2b unreachable or unauthorized',
      warehouses: { wholesale: whW, retail: whR },
    };
  }

  const base = normalizeBase(s.website_wc_url);
  const key = String(s.website_wc_key || '').trim();
  const secret = String(s.website_wc_secret || '').trim();
  if (!base) return { ok: false, target, status: 0, reason: 'missing website_wc_url' };
  if (!key || !secret) return { ok: false, target, status: 0, reason: 'missing woo credentials' };
  const auth = Buffer.from(`${key}:${secret}`).toString('base64');
  const res = await requestJSON(`${base}/wp-json/wc/v3/products?per_page=1`, 'GET', null, { Authorization: `Basic ${auth}` });
  const ok = res.status >= 200 && res.status < 300;
  return { ok, target, status: res.status, reason: ok ? 'ok' : 'woocommerce unreachable or unauthorized' };
}

/** Dry-run matrix for one product (no write on site). */
async function dryRunProductMatrix(db, productId) {
  const s = getSettingsMap(db);
  const channels = configuredChannels(s);
  const results = [];
  for (const channel of channels) {
    const wh = channelWarehouseId(s, channel);
    if (!wh) {
      results.push({ channel, ok: false, reason: 'warehouse_not_configured' });
      continue;
    }
    const payload = buildMatrixPayload(db, productId, channel, wh);
    if (!payload || payload.skip) {
      results.push({ channel, ok: false, reason: payload && payload.reason });
      continue;
    }
    const push = await pushMatrixToSite(db, payload, { dryRun: true });
    results.push(push);
  }
  return { ok: results.every((r) => r.ok), results };
}

/** Enqueue every product that has matrix variants for both configured channels. */
function enqueueFullSync(db) {
  ensureWebsiteStockOutbox(db);
  const s = getSettingsMap(db);
  if (!siteB2bEnabled(s)) return { ok: false, reason: 'site_b2b disabled' };
  const products = db.prepare(`
    SELECT DISTINCT product_id AS id FROM product_variants
    WHERE COALESCE(active,1)=1 AND COALESCE(is_default,0)=0
  `).all();
  let n = 0;
  for (const p of products) {
    const r = enqueueWebsiteStock(db, p.id, { force: true });
    n += r.enqueued || 0;
  }
  return { ok: true, products: products.length, enqueued: n };
}

function outboxStatus(db) {
  ensureWebsiteStockOutbox(db);
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS c FROM website_stock_outbox GROUP BY status
  `).all();
  const recent = db.prepare(`
    SELECT id, product_id, channel, status, attempts, last_error, last_result, updated_at
    FROM website_stock_outbox
    ORDER BY updated_at DESC LIMIT 30
  `).all();
  const counts = {};
  for (const r of rows) counts[r.status] = r.c;
  return { counts, recent };
}

// Legacy alias used by older call sites
async function pushSiteB2bStock(db, product) {
  const r = enqueueWebsiteStock(db, product && product.id);
  return { ok: true, queued: r };
}

module.exports = {
  notifyStockChanged,
  enqueueWebsiteStock,
  drainWebsiteStockOutbox,
  buildMatrixPayload,
  pushMatrixToSite,
  testWebsiteConnection,
  dryRunProductMatrix,
  enqueueFullSync,
  outboxStatus,
  ensureWebsiteStockOutbox,
  stockPayload,
  pushWooCommerceStock,
  pushSiteB2bStock,
  fireStockWebhooks,
  requestJSON,
  resolveTarget,
  channelWarehouseId,
  configuredChannels,
  DEBOUNCE_MS,
};
