/**
 * Real-time stock sync helpers for poshaktaranom.com.
 * Channels:
 * - webhook event product.stock (always, when configured)
 * - WooCommerce REST push (by SKU = product.code)
 * - Site-B2B (NestJS) push (by sku = product.code) via admin JWT
 *
 * Target selection (setting `website_target`): 'woo' | 'site_b2b' | 'both'.
 * When unset it defaults to 'both' if a Site-B2B URL is configured, else 'woo'
 * so existing WooCommerce-only deployments keep their behaviour.
 */
const { safeRequestJSON } = require('./safe-outbound-request');
const { getSetting, getSettings } = require('./secret-settings');

function getSettingsMap(db) {
  return getSettings(db, [
    'website_stock_sync_enabled',
    'website_stock_sync_mode',
    'website_stock_webhook_url',
    'website_wc_url',
    'website_wc_key',
    'website_wc_secret',
    'webhook_secret',
    // Site-B2B (NestJS) target
    'website_target',
    'website_b2b_url',
    'website_b2b_token',
    'website_b2b_channel',
  ]);
}

/** Resolve which website channel(s) should receive pushes. */
function resolveTarget(s) {
  const t = String(s.website_target || '').trim().toLowerCase();
  if (t === 'woocommerce') return 'woo';
  if (t === 'woo' || t === 'site_b2b' || t === 'both') return t;
  return String(s.website_b2b_url || '').trim() ? 'both' : 'woo';
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

function normalizeChannel(value) {
  const c = String(value || '').trim().toUpperCase();
  return c === 'RETAIL' ? 'RETAIL' : 'WHOLESALE';
}

/** Bearer header for Site-B2B admin API. Token is never logged. */
function b2bAuthHeaders(token) {
  return { Authorization: `Bearer ${String(token || '').trim()}` };
}

/** Locate a product in a Site-B2B catalog response by exact sku (case-insensitive). */
function findB2bProductBySku(responseBody, sku) {
  let parsed;
  try { parsed = JSON.parse(responseBody); } catch { return null; }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed && (parsed.data || parsed.items || parsed.products || parsed.results)) || [];
  if (!Array.isArray(list) || !list.length) return null;
  const want = String(sku).trim().toLowerCase();
  return list.find((p) => p && String(p.sku || '').trim().toLowerCase() === want)
    || null;
}

async function requestJSON(urlStr, method, body, headers = {}) {
  try {
    return await safeRequestJSON(urlStr, method, body, headers, {
      timeoutMs: 15_000,
      maxResponseBytes: 2 * 1024 * 1024,
      maxRedirects: 3,
    });
  } catch (error) {
    return { status: 0, body: error && error.code ? error.code : 'outbound request rejected' };
  }
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
      return { ok: false, simulated: true, demo: true, channel: 'webhook', code: 'demo_simulation', reason: 'در نسخه دمو ارسال واقعی انجام نمی‌شود' };
    }
  }
  const payload = stockPayload(product);
  const secret = getSetting(db, 'webhook_secret');
  const hooks = db.prepare("SELECT * FROM webhooks WHERE active=1").all()
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
      return { ok: false, simulated: true, demo: true, channel: 'woocommerce', code: 'demo_simulation', reason: 'در نسخه دمو ارسال واقعی انجام نمی‌شود' };
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
 * Push stock to Site-B2B (NestJS). Matches ERP product.code to Site-B2B sku,
 * then PATCH /api/v1/products/:id/stock with { stock, channel }.
 */
async function pushSiteB2bStock(db, product) {
  try {
    const { guardDemoEgressOrBlock } = require('./demo-egress');
    const blocked = guardDemoEgressOrBlock('site_b2b');
    if (blocked) return blocked;
  } catch {
    if (/^(true|1|yes)$/i.test(String(process.env.ERP_DEMO_MODE || ''))) {
      return { ok: false, simulated: true, demo: true, channel: 'site_b2b', code: 'demo_simulation', reason: 'در نسخه دمو ارسال واقعی انجام نمی‌شود' };
    }
  }
  const s = getSettingsMap(db);
  if (!syncPushEnabled(s)) return { skipped: true, reason: 'stock sync push disabled' };
  if (!siteB2bEnabled(s)) return { skipped: true, reason: 'site_b2b target disabled' };
  const base = normalizeBase(s.website_b2b_url);
  const token = String(s.website_b2b_token || '').trim();
  const channel = normalizeChannel(s.website_b2b_channel);
  const sku = String(product.code || '').trim();
  if (!base || !token || !sku) return { skipped: true, reason: 'missing b2b config or sku' };

  const searchUrl = `${base}/api/v1/products?search=${encodeURIComponent(sku)}&limit=20`;
  const found = await requestJSON(searchUrl, 'GET', null, b2bAuthHeaders(token));
  if (!(found.status >= 200 && found.status < 300)) {
    return { ok: false, status: found.status, reason: 'site_b2b catalog lookup failed' };
  }
  const match = findB2bProductBySku(found.body, sku);
  if (!match || match.id == null) return { ok: false, status: found.status, reason: 'sku not found on site_b2b' };

  const stock = Math.max(0, Math.round(Number(product.stock) || 0));
  const upd = await requestJSON(
    `${base}/api/v1/products/${encodeURIComponent(match.id)}/stock`,
    'PATCH',
    { stock, channel },
    b2bAuthHeaders(token)
  );
  return { ok: upd.status >= 200 && upd.status < 300, status: upd.status, channel };
}

/**
 * Connectivity probe for the configured website target. Performs a lightweight
 * read (catalog page 1) and reports reachability. The auth token/secret is
 * never returned or logged.
 * @returns {Promise<{ok:boolean,target:string,status:number,reason:string}>}
 */
async function testWebsiteConnection(arg) {
  const db = arg && typeof arg.prepare === 'function' ? arg : (arg && arg.db);
  if (!db) return { ok: false, target: '', status: 0, reason: 'missing db' };
  const s = getSettingsMap(db);
  const target = resolveTarget(s);
  const prefer = siteB2bEnabled(s) ? 'site_b2b' : 'woo';

  try {
    const { guardDemoEgressOrBlock } = require('./demo-egress');
    const blocked = guardDemoEgressOrBlock(prefer);
    if (blocked) return { ok: false, target, status: 0, reason: 'demo_simulation' };
  } catch {
    if (/^(true|1|yes)$/i.test(String(process.env.ERP_DEMO_MODE || ''))) {
      return { ok: false, target, status: 0, reason: 'demo_simulation' };
    }
  }

  if (prefer === 'site_b2b') {
    const base = normalizeBase(s.website_b2b_url);
    const token = String(s.website_b2b_token || '').trim();
    if (!base) return { ok: false, target, status: 0, reason: 'missing website_b2b_url' };
    if (!token) return { ok: false, target, status: 0, reason: 'missing website_b2b_token' };
    const res = await requestJSON(`${base}/api/v1/products?limit=1`, 'GET', null, b2bAuthHeaders(token));
    const ok = res.status >= 200 && res.status < 300;
    return { ok, target, status: res.status, reason: ok ? 'ok' : 'site_b2b unreachable or unauthorized' };
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

/** Call after any stock mutation (non-blocking). */
function notifyStockChanged(db, productId) {
  setImmediate(async () => {
    try {
      const p = db.prepare('SELECT id,code,barcode,name,stock,unit FROM products WHERE id=?').get(productId);
      if (!p) return;
      const s = getSettingsMap(db);
      await fireStockWebhooks(db, p);
      if (siteB2bEnabled(s)) await pushSiteB2bStock(db, p);
      if (wooEnabled(s)) await pushWooCommerceStock(db, p);
    } catch (e) {
      console.error('[website-stock-sync]', e.message);
    }
  });
}

module.exports = {
  notifyStockChanged,
  stockPayload,
  pushWooCommerceStock,
  pushSiteB2bStock,
  testWebsiteConnection,
  fireStockWebhooks,
  requestJSON,
  resolveTarget,
};
