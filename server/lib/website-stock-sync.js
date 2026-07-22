/**
 * Real-time stock sync helpers for poshaktaranom.com / WooCommerce.
 * - Fires webhook event product.stock
 * - Optional push to WooCommerce REST (by SKU = product.code)
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

function getSettingsMap(db) {
  const rows = db.prepare("SELECT key,value FROM settings WHERE key LIKE 'website_%' OR key='webhook_secret'").all();
  const m = {};
  for (const r of rows) m[r.key] = r.value;
  return m;
}

function requestJSON(urlStr, method, body, headers = {}) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const lib = u.protocol === 'https:' ? https : http;
      const data = body != null ? JSON.stringify(body) : null;
      const opts = {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
        timeout: 15000,
      };
      const req = lib.request(opts, (res) => {
        let raw = '';
        res.on('data', (d) => (raw += d));
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      });
      req.on('error', (e) => resolve({ status: 0, body: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
      if (data) req.write(data);
      req.end();
    } catch (e) {
      resolve({ status: 0, body: e.message });
    }
  });
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
  const payload = stockPayload(product);
  const secret = db.prepare("SELECT value FROM settings WHERE key='webhook_secret'").get()?.value || '';
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

/** Call after any stock mutation (non-blocking). */
function notifyStockChanged(db, productId) {
  setImmediate(async () => {
    try {
      const p = db.prepare('SELECT id,code,barcode,name,stock,unit FROM products WHERE id=?').get(productId);
      if (!p) return;
      await fireStockWebhooks(db, p);
      await pushWooCommerceStock(db, p);
    } catch (e) {
      console.error('[website-stock-sync]', e.message);
    }
  });
}

module.exports = { notifyStockChanged, stockPayload, pushWooCommerceStock, fireStockWebhooks };
