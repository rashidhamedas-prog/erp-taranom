/**
 * Website stock sync — ERP → Site-B2B matrix (color×size).
 *
 * System of record: variant_warehouse_stock for the warehouse configured
 * per channel (website_wh_wholesale_id / website_wh_retail_id).
 *
 * Push contract: PUT {resolved}/erp/inventory/matrix
 * URL resolution via siteApiUrl(): Nest API hosts (api.*) use /v1/...;
 * storefront origins use nginx /api/v1/... (strip /api on proxy).
 * Auth: Bearer / x-api-key = website_b2b_token (ERP_INVENTORY_API_KEY on site).
 *
 * Outbox + debounce coalesce bursts (invoice line storms) into one push per
 * product×channel. WooCommerce path kept for legacy when target includes woo.
 *
 * Success contract (NONTAX-P1, 2026-10-04): a push is successful only when the
 * HTTP call succeeded AND the site reported zero unmatched rows for the active
 * sellable variants we sent. Matching is exact SKU / explicit site-side mapping
 * only — ERP never merges by fuzzy name. See classifyMatrixPushResult().
 *
 * A previous product_sku_not_found does not veto the next pending delivery.
 * The site catalog is allowed to gain that SKU later (v323).
 *
 * Per product (v330): products.website_stock_push is the catalog gate.
 * 1 (default) may enqueue; 0 never leaves ERP — matrix/Woo/webhook/dry-run/full sync.
 * Turning off does not write zero on the site.
 */
'use strict';

const { safeRequestJSON } = require('./safe-outbound-request');
const { getSetting, getSettings } = require('./secret-settings');

const DEBOUNCE_MS = 2000;
const MAX_ATTEMPTS = 8;
/** Max unmatched rows echoed back as human examples in results/messages. */
const UNMATCHED_EXAMPLE_LIMIT = 5;
/** Keep batches small — matrix PUT can take tens of seconds under load. */
const DRAIN_BATCH = 5;
const MATRIX_TIMEOUT_MS = 45_000;
/**
 * Iran → site sometimes stalls once a matrix body grows past a handful of
 * variants (14 rows ~2.6KB timed out; 7 rows ~1.3KB returned in under a second).
 * Each chunk is an absolute stock set for those variants, so a retry is safe.
 */
const MATRIX_CHUNK_SIZE = 6;
const PING_TIMEOUT_MS = 15_000;
const DRAIN_INTERVAL_MS = 30_000;

const SECRET_LABELS = Object.freeze({
  website_b2b_token: 'کلید API موجودی سایت',
  website_wc_key: 'کلید ووکامرس',
  website_wc_secret: 'رمز ووکامرس',
  webhook_secret: 'رمز وب‌هوک',
});

function secretOpenError(key, cause) {
  const label = SECRET_LABELS[key] || key;
  const code = (cause && cause.code) || 'E_SECRET_OPEN';
  const err = new Error(
    code === 'E_SECRET_KEY_MISMATCH'
      ? `${label} قابل خواندن نیست؛ در تنظیمات → سینک موجودی وب‌سایت مقدار واقعی را دوباره وارد و ذخیره کنید`
      : `${label} خراب یا ناخواناست؛ دوباره ذخیره کنید`
  );
  err.code = code;
  err.key = key;
  if (cause) err.cause = cause;
  return err;
}

function openWebsiteSecret(db, key) {
  try {
    return getSetting(db, key);
  } catch (e) {
    throw secretOpenError(key, e);
  }
}

/**
 * Load website sync settings. Non-secrets first; decrypt only requested secrets
 * so a stale Woo/webhook ciphertext cannot block Site-B2B enqueue/test/dry-run.
 *
 * opts.needB2b / needWoo / needWebhook:
 *   undefined → infer from target (B2B/Woo) ; webhook never inferred (opt-in only)
 */
function getSettingsMap(db, opts = {}) {
  const s = getSettings(db, [
    'website_stock_sync_enabled',
    'website_stock_sync_mode',
    'website_stock_webhook_url',
    'website_wc_url',
    'website_target',
    'website_b2b_url',
    'website_b2b_channel',
    'website_wh_wholesale_id',
    'website_wh_retail_id',
  ]);
  s.website_b2b_token = '';
  s.website_wc_key = '';
  s.website_wc_secret = '';
  s.webhook_secret = '';

  const needB2b = opts.needB2b != null ? !!opts.needB2b : siteB2bEnabled(s);
  const needWoo = opts.needWoo != null ? !!opts.needWoo : wooEnabled(s);
  const needWebhook = !!opts.needWebhook;

  if (needB2b) {
    s.website_b2b_token = openWebsiteSecret(db, 'website_b2b_token');
  }
  if (needWoo) {
    s.website_wc_key = openWebsiteSecret(db, 'website_wc_key');
    s.website_wc_secret = openWebsiteSecret(db, 'website_wc_secret');
  }
  if (needWebhook) {
    s.webhook_secret = openWebsiteSecret(db, 'webhook_secret');
  }
  return s;
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

function normalizeWebsiteStockPush(raw, fallback = 1) {
  if (raw == null || raw === '') return fallback;
  if (raw === 0 || raw === '0') return 0;
  const s = String(raw).trim().toLowerCase();
  if (s === '0' || s === 'off' || s === 'false' || s === 'no') return 0;
  if (s === '1' || s === 'on' || s === 'true' || s === 'yes') return 1;
  return fallback;
}

function productAllowsWebsiteStockPush(row) {
  if (row == null) return false;
  if (!Object.prototype.hasOwnProperty.call(row, 'website_stock_push')) return true;
  return normalizeWebsiteStockPush(row.website_stock_push) === 1;
}

function readWebsiteStockPushRow(db, productId) {
  const pid = parseInt(productId, 10);
  if (!pid) return null;
  try {
    return db.prepare('SELECT id, website_stock_push FROM products WHERE id=?').get(pid);
  } catch (_) {
    return db.prepare('SELECT id FROM products WHERE id=?').get(pid);
  }
}

function silenceProductWebsiteOutbox(db, productId) {
  ensureWebsiteStockOutbox(db);
  const now = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ skipped: true, reason: 'product_website_stock_off' });
  return db.prepare(`
    UPDATE website_stock_outbox
    SET status='done', attempts=0, last_error='', last_result=?, updated_at=?
    WHERE product_id=? AND status='pending'
  `).run(body, now, productId);
}

function isStockPushEnabled(db) {
  try {
    const s = getSettingsMap(db, { needB2b: false, needWoo: false });
    return syncPushEnabled(s);
  } catch (_) {
    return false;
  }
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

/**
 * Build Site-B2B Nest inventory URL from configured base + resource path.
 * resourcePath examples: `erp/inventory/matrix`, `erp/inventory/ping`
 *
 * - base already ends with `/api/v1` or `/v1` → append resource
 * - host `api.*` or direct API (port 4000) → `${base}/v1/...`
 * - else storefront origin → `${base}/api/v1/...` (nginx strips `/api`)
 */
function siteApiUrl(base, resourcePath) {
  const root = normalizeBase(base);
  const path = String(resourcePath || '').replace(/^\/+/, '');
  if (!root || !path) return '';

  const lower = root.toLowerCase();
  if (lower.endsWith('/api/v1') || lower.endsWith('/v1')) {
    return `${root}/${path}`;
  }

  let host = '';
  let port = '';
  try {
    const u = new URL(root.includes('://') ? root : `https://${root}`);
    host = String(u.hostname || '').toLowerCase();
    port = String(u.port || '');
  } catch {
    // fall through to storefront default
  }

  const isLoopback = host === 'localhost' || host.startsWith('127.');
  const isNonStandardPort = port && port !== '80' && port !== '443';
  const isDirectApi = host.startsWith('api.') || port === '4000' || isLoopback || isNonStandardPort;
  if (isDirectApi) return `${root}/v1/${path}`;
  return `${root}/api/v1/${path}`;
}

/** @deprecated use siteApiUrl */
const siteB2bApiUrl = siteApiUrl;

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

function formatOutboundFailure(res) {
  if (!res) return 'ارتباط با سایت ناموفق';
  const code = String(res.reason || res.body || '').trim();
  if (code === 'OUTBOUND_TIMEOUT' || /timeout|مهلت/i.test(code)) {
    return 'مهلت ارتباط با API سایت تمام شد (timeout) — دوباره تلاش می‌شود';
  }
  if (code === 'OUTBOUND_DNS_FAILED' || code === 'OUTBOUND_DNS_EMPTY') {
    return 'نام میزبان API سایت resolve نشد';
  }
  if (code.startsWith('OUTBOUND_') || /آدرس|HTTPS|پورت|هدر/i.test(code)) {
    return code;
  }
  if (Number(res.status) > 0) return `HTTP ${res.status}`;
  return code || 'HTTP 0 — بدون پاسخ از سایت';
}

function isAllProductSkuNotFound(unmatched) {
  if (!Array.isArray(unmatched) || !unmatched.length) return false;
  return unmatched.every((u) => String(u && u.reason || '') === 'product_sku_not_found');
}

/**
 * Dry-run / retry accept either the internal products.id or the business code.
 * Operators type the code (7141). That number is not the row id (لاله is id 101).
 * If the typed digits are both an id and a different product's code, the code wins:
 * the field is the catalog code the site SKU is matched on.
 */
function resolveSyncProduct(db, raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { ok: false, error: 'کد یا شناسه کالا را وارد کنید' };
  const numeric = /^\d+$/.test(text) ? parseInt(text, 10) : null;
  const byId = numeric
    ? db.prepare('SELECT id, code, name FROM products WHERE id=?').get(numeric)
    : null;
  const byCode = db.prepare('SELECT id, code, name FROM products WHERE code=?').get(text);
  let product = null;
  let via = '';
  if (byCode && (!byId || Number(byId.id) !== Number(byCode.id))) {
    product = byCode;
    via = 'code';
  } else if (byId) {
    product = byId;
    via = 'id';
  }
  if (!product) {
    return { ok: false, error: `کالایی با کد یا شناسه «${text}» در ERP پیدا نشد` };
  }
  const code = String(product.code || '').trim();
  const name = String(product.name || '').trim();
  return {
    ok: true,
    via,
    product: { id: Number(product.id), code, name },
    label: `${name || 'بدون نام'} — کد ${code || '—'} — شناسه ${product.id}`,
  };
}

function formatUnmatchedReason(reason) {
  const r = String(reason || '').trim();
  if (r === 'product_sku_not_found') return 'کد کالا در سایت نیست';
  if (r === 'variant_not_matched') return 'همین رنگ/سایز در سایت نیست';
  return r;
}

function formatChannelFailReason(reason) {
  const r = String(reason || '').trim();
  if (r === 'no_matrix_variants') return 'این کالا ماتریس رنگ×سایز فعال ندارد';
  if (r === 'missing product.code') return 'کد کالا در ERP خالی است';
  if (r === 'warehouse_not_configured') return 'انبار این کانال انتخاب نشده';
  if (r === 'product_website_stock_off') return 'ارسال موجودی این کالا به سایت خاموش است';
  return r;
}

function matchedCount(value) {
  if (Array.isArray(value)) return value.length;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** One Persian line for the settings dry-run box. Never hides an empty unmatched list behind "—". */
function formatDryRunChannel(row) {
  const ch = String((row && row.channel) || '?');
  const unmatched = row && Array.isArray(row.unmatched) ? row.unmatched : [];
  if (!unmatched.length && row && row.reason && !row.ok) {
    return `${ch}: FAIL ${formatChannelFailReason(row.reason)}`;
  }
  const n = row && row.unmatchedCount != null ? Number(row.unmatchedCount) : unmatched.length;
  const sample = unmatched.slice(0, 4).map((u) => {
    const name = [u && u.color, u && u.size].map((x) => String(x || '').trim()).filter(Boolean).join(' / ')
      || String((u && (u.erpVariantSku || u.reason)) || '').trim();
    const why = formatUnmatchedReason(u && u.reason);
    return why && name ? `${name} (${why})` : (name || why);
  }).filter(Boolean).join('؛ ');
  const matched = matchedCount(row && row.matched);
  return `${ch}: ${row && row.ok ? 'OK' : 'FAIL'} matched=${matched} unmatched=${Number.isFinite(n) ? n : 0}${sample ? ' — ' + sample : ''}`;
}

/** Human label for one unmatched site row — colour/size first, then SKU, then reason. */
function formatUnmatchedExample(u) {
  const color = String((u && u.color) || '').trim();
  const size = String((u && u.size) || '').trim();
  const sku = String((u && (u.erpVariantSku || u.sku)) || '').trim();
  const reason = String((u && u.reason) || '').trim();
  const label = color && size ? `${color} / ${size}` : (color || size || sku || reason || 'نامشخص');
  const out = { label };
  if (sku) out.erpVariantSku = sku;
  if (color) out.color = color;
  if (size) out.size = size;
  if (reason) out.reason = reason;
  return out;
}

function formatOnSiteLabels(onSite, limit = 8) {
  if (!Array.isArray(onSite)) return [];
  const out = [];
  const cap = Math.max(1, Number(limit) || 8);
  for (const row of onSite) {
    let label = '';
    if (typeof row === 'string') label = row.trim();
    else {
      const color = String((row && row.color) || '').trim();
      const size = String((row && row.size) || '').trim();
      label = [color, size].filter(Boolean).join(' / ');
    }
    if (label && !out.includes(label)) out.push(label);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * A pending outbox row is a new delivery. An older "SKU missing" body must
 * not be replayed in place of a fresh site call — the product may exist now.
 * Always false: the historical short-circuit was the false «نیاز به رسیدگی».
 */
function priorCatalogMissBlocksDelivery(row) {
  void row;
  return false;
}

function unmatchedMessage({ catalogMissing, productSku, unmatchedCount, expected, examples, onSite }) {
  if (catalogMissing) {
    const sku = productSku ? ` «${productSku}»` : '';
    return `کد کالا${sku} در سایت پیدا نشد؛ کد را در سایت وصل یا بسازید (فقط نگاشت صریح؛ حدس از روی نام انجام نمی‌شود)، سپس همگام‌سازی را دوباره اجرا کنید.`;
  }
  const of = expected ? ` از ${expected}` : '';
  const sample = examples.map((e) => e.label).join('، ');
  const more = unmatchedCount > examples.length ? ' و …' : '';
  const present = formatOnSiteLabels(onSite, 8);
  const site = present.length ? ` روی سایت همین کالا این‌ها هست: ${present.join('، ')}.` : '';
  return `${unmatchedCount} رنگ/سایز${of} در سایت هم‌خوان نشد (${sample}${more}).${site} تا رفع نگاشت در سایت، این ارسال موفق محسوب نمی‌شود.`;
}

/**
 * Pure success predicate for one matrix push (no DB, no network, no mutation).
 *
 * Input `push`: { ok|transportOk?, status (HTTP), matched (array|number),
 *                 unmatched (array of {erpVariantSku,color,size,reason}), reason? }
 * Input `payload`: buildMatrixPayload() output — `variants` are already the
 *                  active, non-default (sellable) rows, so every unmatched row
 *                  the site reports is a sellable row that did not sync.
 *
 * Verdict: { ok, status: 'done'|'error', code, matched, expected,
 *            unmatchedCount, examples (≤ UNMATCHED_EXAMPLE_LIMIT), message (fa),
 *            catalogMissing, productSku?, channel? }
 * Calling it twice on the same inputs yields an identical verdict.
 */
function classifyMatrixPushResult(push, payload) {
  const p = push && typeof push === 'object' ? push : {};
  const httpStatus = Number(p.status) || 0;
  const transportOk = p.transportOk != null ? !!p.transportOk
    : (p.ok != null ? !!p.ok : (httpStatus >= 200 && httpStatus < 300));
  const unmatched = Array.isArray(p.unmatched) ? p.unmatched : [];
  const matched = Array.isArray(p.matched) ? p.matched.length : (Number(p.matched) || 0);
  const expected = payload && Array.isArray(payload.variants) ? payload.variants.length : null;
  const productSku = String((payload && payload.productSku) || p.productSku || '').trim();
  const channelRaw = String((payload && payload.channel) || p.channel || '').toUpperCase();
  const unmatchedCount = unmatched.length;
  const catalogMissing = isAllProductSkuNotFound(unmatched);
  const examples = unmatched.slice(0, UNMATCHED_EXAMPLE_LIMIT).map(formatUnmatchedExample);
  const onSite = formatOnSiteLabels(p.onSite, 12);

  const base = { matched, expected, unmatchedCount, examples, catalogMissing, onSite };
  if (productSku) base.productSku = productSku;
  if (channelRaw) base.channel = channelRaw;

  if (!transportOk) {
    return {
      ...base,
      ok: false,
      status: 'error',
      code: 'transport_failed',
      message: String(p.reason || '').trim() || formatOutboundFailure(p),
    };
  }
  if (unmatchedCount > 0) {
    return {
      ...base,
      ok: false,
      status: 'error',
      code: catalogMissing ? 'product_sku_not_found' : 'variants_unmatched',
      message: unmatchedMessage({ catalogMissing, productSku, unmatchedCount, expected, examples, onSite }),
    };
  }
  return {
    ...base,
    ok: true,
    status: 'done',
    code: 'all_matched',
    message: matched > 0 ? `${matched} رنگ/سایز در سایت به‌روز شد` : 'انجام شد',
  };
}

async function requestJSON(urlStr, method, body, headers = {}, options = {}) {
  try {
    return await safeRequestJSON(urlStr, method, body, headers, {
      timeoutMs: options.timeoutMs || 20_000,
      maxResponseBytes: 2 * 1024 * 1024,
      maxRedirects: 3,
    });
  } catch (error) {
    const code = error && error.code ? String(error.code) : '';
    const msg = error && error.message ? String(error.message) : 'outbound request rejected';
    return { status: 0, body: code || msg, reason: code || msg };
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
  let p = product;
  if (p && !Object.prototype.hasOwnProperty.call(p, 'website_stock_push')) {
    const row = readWebsiteStockPushRow(db, p.id);
    if (row) p = { ...p, ...row };
  }
  if (!productAllowsWebsiteStockPush(p)) {
    return { skipped: true, reason: 'product_website_stock_off' };
  }
  try {
    const { guardDemoEgressOrBlock } = require('./demo-egress');
    const blocked = guardDemoEgressOrBlock('webhook');
    if (blocked) return blocked;
  } catch {
    if (/^(true|1|yes)$/i.test(String(process.env.ERP_DEMO_MODE || ''))) {
      return { ok: false, simulated: true, demo: true, channel: 'webhook', code: 'demo_simulation' };
    }
  }
  const payload = stockPayload(p);
  const hooks = db.prepare('SELECT * FROM webhooks WHERE active=1').all()
    .filter((w) => String(w.events || '').includes('product.stock') || String(w.events || '').includes('*'));
  const s = getSettingsMap(db, { needB2b: false, needWoo: false });
  const wantHookUrl = String(s.website_stock_webhook_url || '').trim();
  const secret = wantHookUrl
    ? openWebsiteSecret(db, 'webhook_secret')
    : '';
  if (wantHookUrl) {
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
  let p = product;
  if (p && !Object.prototype.hasOwnProperty.call(p, 'website_stock_push')) {
    const row = readWebsiteStockPushRow(db, p.id);
    if (row) p = { ...p, ...row };
  }
  if (!productAllowsWebsiteStockPush(p)) {
    return { skipped: true, reason: 'product_website_stock_off' };
  }
  try {
    const { guardDemoEgressOrBlock } = require('./demo-egress');
    const blocked = guardDemoEgressOrBlock('woocommerce');
    if (blocked) return blocked;
  } catch {
    if (/^(true|1|yes)$/i.test(String(process.env.ERP_DEMO_MODE || ''))) {
      return { ok: false, simulated: true, demo: true, channel: 'woocommerce', code: 'demo_simulation' };
    }
  }
  const s = getSettingsMap(db, { needB2b: false, needWoo: true });
  if (s.website_stock_sync_enabled !== '1') return { skipped: true };
  if (!['push', 'both'].includes(s.website_stock_sync_mode || 'pull')) return { skipped: true };
  const base = (s.website_wc_url || '').replace(/\/$/, '');
  const key = s.website_wc_key || '';
  const secret = s.website_wc_secret || '';
  const sku = String(p.code || '').trim();
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
    { manage_stock: true, stock_quantity: Math.max(0, Math.round(Number(p.stock) || 0)) },
    { Authorization: `Basic ${auth}` }
  );
  return { ok: upd.status >= 200 && upd.status < 300, status: upd.status };
}

/**
 * Build matrix payload from variant_warehouse_stock for one product+channel.
 * Qty source is VWS only (never products.stock header).
 */
function buildMatrixPayload(db, productId, channel, warehouseId) {
  let product;
  try {
    product = db.prepare('SELECT id, code, name, website_stock_push FROM products WHERE id=?').get(productId);
  } catch (_) {
    product = db.prepare('SELECT id, code, name FROM products WHERE id=?').get(productId);
  }
  if (!product) return null;
  const productSku = String(product.code || '').trim();
  if (!productAllowsWebsiteStockPush(product)) {
    return { skip: true, reason: 'product_website_stock_off', productSku };
  }
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

/**
 * Split one product matrix into small PUTs. Chunk idempotency keys are stable
 * suffixes of the payload key so a finished chunk is not applied twice, and a
 * later chunk is not answered with the first chunk's cached body.
 */
function chunkMatrixRequests(payload, { dryRun = false, chunkSize = MATRIX_CHUNK_SIZE } = {}) {
  const variants = payload && Array.isArray(payload.variants) ? payload.variants : [];
  const size = Math.max(1, Number(chunkSize) || MATRIX_CHUNK_SIZE);
  const chunks = [];
  for (let i = 0; i < variants.length; i += size) chunks.push(variants.slice(i, i + size));
  if (!chunks.length) chunks.push([]);
  const baseKey = String((payload && payload.idempotencyKey) || '').trim();
  return chunks.map((rows, i) => ({
    idempotencyKey: baseKey ? `${baseKey}:c${i}` : undefined,
    channel: payload && payload.channel,
    productSku: payload && payload.productSku,
    variants: rows,
    dryRun: !!dryRun,
  }));
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
  const s = getSettingsMap(db, { needB2b: true, needWoo: false });
  if (!syncPushEnabled(s) && !dryRun) return { skipped: true, reason: 'stock sync push disabled' };
  if (!siteB2bEnabled(s)) return { skipped: true, reason: 'site_b2b target disabled' };
  const base = normalizeBase(s.website_b2b_url);
  const token = String(s.website_b2b_token || '').trim();
  if (!base || !token) return { skipped: true, reason: 'missing b2b config' };
  if (!payload || payload.skip) return { skipped: true, reason: (payload && payload.reason) || 'empty payload' };

  const url = siteApiUrl(base, 'erp/inventory/matrix');
  const requests = chunkMatrixRequests(payload, { dryRun });
  const matched = [];
  const unmatched = [];
  const onSite = [];
  let transportOk = true;
  let status = 0;
  let failReason = '';
  for (const body of requests) {
    const res = await requestJSON(url, 'PUT', body, b2bAuthHeaders(token), {
      timeoutMs: MATRIX_TIMEOUT_MS,
    });
    status = res.status;
    let parsed = null;
    try { parsed = JSON.parse(res.body); } catch { /* */ }
    const chunkOk = res.status >= 200 && res.status < 300;
    if (!chunkOk) {
      transportOk = false;
      failReason = formatOutboundFailure(res);
      break;
    }
    if (parsed && Array.isArray(parsed.matched)) matched.push(...parsed.matched);
    else if (parsed && Number(parsed.matched)) matched.push(...Array(Number(parsed.matched)).fill(null));
    if (parsed && Array.isArray(parsed.unmatched)) unmatched.push(...parsed.unmatched);
    if (parsed && Array.isArray(parsed.onSite)) onSite.push(...parsed.onSite);
  }
  // HTTP 2xx alone is not success: any unmatched sellable row fails the push.
  const verdict = classifyMatrixPushResult({
    ok: transportOk,
    status,
    matched,
    unmatched,
    onSite,
    reason: transportOk ? '' : failReason,
  }, payload);
  return {
    ok: verdict.ok,
    transportOk,
    status,
    reason: verdict.ok ? '' : verdict.message,
    code: verdict.code,
    channel: payload.channel,
    productSku: payload.productSku,
    matched,
    expected: verdict.expected,
    unmatched,
    unmatchedCount: verdict.unmatchedCount,
    examples: verdict.examples,
    onSite: verdict.onSite,
    message: verdict.message,
    body: { chunks: requests.length, matched: matched.length, unmatched: unmatched.length },
    dryRun: !!dryRun,
  };
}

/** Enqueue product for website push (debounced per product×channel). */
function enqueueWebsiteStock(db, productId, opts = {}) {
  const pid = parseInt(productId, 10);
  if (!pid) return { skipped: true };
  ensureWebsiteStockOutbox(db);
  const prodRow = readWebsiteStockPushRow(db, pid);
  if (!prodRow) return { skipped: true, reason: 'missing_product', enqueued: 0 };
  if (!productAllowsWebsiteStockPush(prodRow)) {
    silenceProductWebsiteOutbox(db, pid);
    return { skipped: true, reason: 'product_website_stock_off', enqueued: 0 };
  }
  const s = getSettingsMap(db, { needB2b: true, needWoo: false });
  if (!syncPushEnabled(s) && !opts.force) return { skipped: true, reason: 'disabled' };
  if (!siteB2bEnabled(s) && !opts.force) return { skipped: true, reason: 'target' };

  const channels = opts.channel
    ? [String(opts.channel).toUpperCase() === 'RETAIL' ? 'RETAIL' : 'WHOLESALE']
    : configuredChannels(s);

  const now = Math.floor(Date.now() / 1000);
  const nextAt = now + Math.ceil(DEBOUNCE_MS / 1000);
  // A new pending attempt must not keep the previous miss. clearHold is accepted
  // and ignored: every requeue clears last_result.
  void opts.clearHold;
  const upsert = db.prepare(`
    INSERT INTO website_stock_outbox (product_id, channel, next_at, attempts, status, last_error, last_result, updated_at)
    VALUES (?, ?, ?, 0, 'pending', '', '', ?)
    ON CONFLICT(product_id, channel) DO UPDATE SET
      next_at=excluded.next_at,
      status='pending',
      attempts=0,
      last_error='',
      last_result='',
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
    const s = getSettingsMap(db, { needB2b: true, needWoo: false });
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
        db.prepare(`UPDATE website_stock_outbox SET status='error', last_error=?, updated_at=? WHERE id=? AND updated_at=?`)
          .run('warehouse not configured for channel', now, row.id, row.updated_at);
        results.push({ id: row.id, ok: false, reason: 'no_warehouse' });
        continue;
      }

      const payload = buildMatrixPayload(db, row.product_id, channel, wh);
      if (!payload || payload.skip) {
        db.prepare(`UPDATE website_stock_outbox SET status='done', last_result=?, last_error='', updated_at=? WHERE id=? AND updated_at=?`)
          .run(JSON.stringify({ skipped: true, reason: payload && payload.reason }), now, row.id, row.updated_at);
        results.push({ id: row.id, skipped: true });
        continue;
      }

      // Pending means deliver. A stored product_sku_not_found is not proof
      // the SKU is still missing (priorCatalogMissBlocksDelivery is always false).
      if (priorCatalogMissBlocksDelivery(row)) continue;

      const push = await pushMatrixToSite(db, payload);
      if (push.skipped) {
        // Config changed between enqueue and drain — nothing was sent.
        db.prepare(`
          UPDATE website_stock_outbox
          SET status='done', last_result=?, last_error='', updated_at=?
          WHERE id=? AND updated_at=?
        `).run(JSON.stringify({ skipped: true, reason: push.reason || '' }), now, row.id, row.updated_at);
        results.push({ id: row.id, skipped: true, reason: push.reason || '' });
        continue;
      }
      if (push.transportOk) {
        // Site answered. 'done' only when every sellable row matched;
        // otherwise 'error' (needs attention) — no retry burn, no false green.
        const rowStatus = push.ok ? 'done' : 'error';
        db.prepare(`
          UPDATE website_stock_outbox
          SET status=?, last_result=?, last_error=?, payload_hash=?, updated_at=?
          WHERE id=? AND updated_at=?
        `).run(
          rowStatus,
          JSON.stringify({
            matched: matchedCount(push.matched),
            unmatched: push.unmatched,
            status: push.status,
            catalogMissing: isAllProductSkuNotFound(push.unmatched),
            expected: push.expected,
            unmatchedCount: push.unmatchedCount,
            examples: push.examples,
            onSite: push.onSite || [],
            code: push.code,
            message: push.message,
          }),
          push.ok ? '' : String(push.message || '').slice(0, 500),
          payload.idempotencyKey,
          now,
          row.id,
          row.updated_at
        );
        if (push.ok) {
          try {
            require('./product-variants/service').retireZeroStockColors(db, row.product_id);
          } catch (e) {
            console.error('[website-stock-sync] retire zero color', e && e.message);
          }
        }
        results.push({
          id: row.id,
          ok: push.ok,
          status: rowStatus,
          code: push.code,
          matched: push.matched,
          unmatchedCount: push.unmatchedCount,
          examples: push.examples,
          message: push.message,
          unmatched: push.unmatched,
        });
      } else {
        const attempts = (Number(row.attempts) || 0) + 1;
        const backoff = Math.min(3600, Math.pow(2, attempts) * 15);
        const status = attempts >= MAX_ATTEMPTS ? 'error' : 'pending';
        const errText = String(push.reason || formatOutboundFailure(push) || `HTTP ${push.status}`).slice(0, 500);
        db.prepare(`
          UPDATE website_stock_outbox
          SET attempts=?, next_at=?, status=?, last_error=?, last_result=COALESCE(last_result,''), updated_at=?
          WHERE id=? AND updated_at=?
        `).run(
          attempts,
          now + backoff,
          status,
          errText,
          now,
          row.id,
          row.updated_at
        );
        results.push({ id: row.id, ok: false, attempts, status, error: errText });
        if (status === 'pending') scheduleDrain(db);
      }
    }

    // Legacy webhook + woo for product header (optional)
    if (due.length && wooEnabled(s)) {
      const seen = new Set();
      for (const row of due) {
        if (seen.has(row.product_id)) continue;
        seen.add(row.product_id);
        let p;
        try {
          p = db.prepare('SELECT id,code,barcode,name,stock,unit,website_stock_push FROM products WHERE id=?').get(row.product_id);
        } catch (_) {
          p = db.prepare('SELECT id,code,barcode,name,stock,unit FROM products WHERE id=?').get(row.product_id);
        }
        if (p && productAllowsWebsiteStockPush(p)) {
          await fireStockWebhooks(db, p).catch(() => {});
          await pushWooCommerceStock(db, p).catch(() => {});
        }
      }
    }

    // More due rows? schedule another pass after this batch.
    const more = db.prepare(`
      SELECT COUNT(*) AS c FROM website_stock_outbox
      WHERE status='pending' AND next_at<=?
    `).get(Math.floor(Date.now() / 1000));
    if (more && Number(more.c) > 0) scheduleDrain(db);

    return { ok: true, processed: results.length, results };
  } finally {
    _drainRunning = false;
  }
}

let _drainLoop = null;

/**
 * One-shot reconcile after v323. Error rows were frozen on an old site answer.
 * Move them back to pending with an empty last_result so the next drain asks
 * the site again. Real color mismatches come back as error; SKUs that now
 * exist become done. Not synced to devices.
 */
function requeueFrozenWebsiteStockErrors(db) {
  ensureWebsiteStockOutbox(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS website_sync_marks (
      name TEXT PRIMARY KEY,
      applied_at INTEGER
    );
  `);
  const mark = 'requeue_matrix_reconcile_v323';
  const done = db.prepare('SELECT name FROM website_sync_marks WHERE name=?').get(mark);
  if (done) return { skipped: true, requeued: 0 };
  const now = Math.floor(Date.now() / 1000);
  const info = db.prepare(`
    UPDATE website_stock_outbox
    SET status='pending', next_at=?, attempts=0, last_error='', last_result='', updated_at=?
    WHERE status='error'
  `).run(now, now);
  db.prepare('INSERT INTO website_sync_marks (name, applied_at) VALUES (?, ?)').run(mark, now);
  const requeued = Number(info && info.changes) || 0;
  if (requeued) console.log('[website-stock-sync] requeued frozen errors', requeued);
  return { skipped: false, requeued };
}

/** Periodic drain so a crashed timer cannot leave the outbox stuck. Central only. */
function startWebsiteStockDrainLoop(db) {
  if (_drainLoop || !db) return;
  try {
    const { isDevice } = require('../db');
    if (typeof isDevice === 'function' && isDevice()) return;
  } catch { /* central path */ }
  try {
    requeueFrozenWebsiteStockErrors(db);
  } catch (e) {
    console.error('[website-stock-sync] requeue', e && e.message);
  }
  scheduleDrain(db);
  _drainLoop = setInterval(() => {
    drainWebsiteStockOutbox(db).catch((e) => {
      console.error('[website-stock-sync] loop', e && e.message);
    });
  }, DRAIN_INTERVAL_MS);
  if (typeof _drainLoop.unref === 'function') _drainLoop.unref();
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
  const baseMap = getSettingsMap(db, { needB2b: false, needWoo: false });
  const target = resolveTarget(baseMap);

  try {
    const { guardDemoEgressOrBlock } = require('./demo-egress');
    const blocked = guardDemoEgressOrBlock('site_b2b');
    if (blocked) return { ok: false, target, status: 0, reason: 'demo_simulation' };
  } catch {
    if (/^(true|1|yes)$/i.test(String(process.env.ERP_DEMO_MODE || ''))) {
      return { ok: false, target, status: 0, reason: 'demo_simulation' };
    }
  }

  if (siteB2bEnabled(baseMap)) {
    const s = getSettingsMap(db, { needB2b: true, needWoo: false });
    const base = normalizeBase(s.website_b2b_url);
    const token = String(s.website_b2b_token || '').trim();
    if (!base) return { ok: false, target, status: 0, reason: 'missing website_b2b_url' };
    if (!token) return { ok: false, target, status: 0, reason: 'missing website_b2b_token' };
    const res = await requestJSON(siteApiUrl(base, 'erp/inventory/ping'), 'GET', null, b2bAuthHeaders(token), {
      timeoutMs: PING_TIMEOUT_MS,
    });
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

  const s = getSettingsMap(db, { needB2b: false, needWoo: true });
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

/** Dry-run matrix for one product (no write on site). raw is products.id or products.code. */
async function dryRunProductMatrix(db, raw) {
  const resolved = resolveSyncProduct(db, raw);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error, results: [], lines: [] };
  }
  const productId = resolved.product.id;
  const s = getSettingsMap(db, { needB2b: true, needWoo: false });
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
  const failed = results.filter((r) => !r.ok);
  const lines = [
    `کالا: ${resolved.label} (جستجو با ${resolved.via === 'code' ? 'کد' : 'شناسه'})`,
    ...results.map(formatDryRunChannel),
  ];
  return {
    ok: failed.length === 0,
    productId,
    via: resolved.via,
    label: resolved.label,
    unmatchedCount: results.reduce((sum, r) => sum + (Number(r.unmatchedCount) || 0), 0),
    message: failed.length
      ? String(failed[0].message || formatChannelFailReason(failed[0].reason) || failed[0].reason || '')
      : '',
    lines,
    results,
  };
}

/** Enqueue every product that has matrix variants for both configured channels. */
function enqueueFullSync(db) {
  ensureWebsiteStockOutbox(db);
  // Site-B2B outbox only — never require Woo/webhook secrets here.
  const s = getSettingsMap(db, { needB2b: true, needWoo: false });
  if (!siteB2bEnabled(s)) return { ok: false, reason: 'site_b2b disabled' };
  let products;
  let skippedWebsiteStockOff = 0;
  try {
    const eligible = db.prepare(`
      SELECT DISTINCT v.product_id AS id
      FROM product_variants v
      INNER JOIN products p ON p.id = v.product_id
      WHERE COALESCE(v.active,1)=1 AND COALESCE(v.is_default,0)=0
        AND COALESCE(p.website_stock_push, 1)=1
    `).all();
    products = eligible;
    const total = db.prepare(`
      SELECT COUNT(DISTINCT product_id) AS c FROM product_variants
      WHERE COALESCE(active,1)=1 AND COALESCE(is_default,0)=0
    `).get();
    skippedWebsiteStockOff = Math.max(0, (Number(total && total.c) || 0) - products.length);
  } catch (_) {
    products = db.prepare(`
      SELECT DISTINCT product_id AS id FROM product_variants
      WHERE COALESCE(active,1)=1 AND COALESCE(is_default,0)=0
    `).all();
  }
  let n = 0;
  for (const p of products) {
    const r = enqueueWebsiteStock(db, p.id, { force: true });
    n += r.enqueued || 0;
  }
  return { ok: true, products: products.length, enqueued: n, skippedWebsiteStockOff };
}

function parseOutboxLastResult(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return {}; }
}

/** Human-facing summary for one outbox row (Persian, manager language). */
function summarizeOutboxRow(row) {
  const channel = String(row.channel || '').toUpperCase() === 'RETAIL' ? 'RETAIL' : 'WHOLESALE';
  const channelLabel = channel === 'RETAIL' ? 'سایت خرده‌فروشی' : 'سایت عمده';
  const code = String(row.product_code || '').trim();
  const name = String(row.product_name || '').trim();
  const productLabel = name && code ? `${name} — ${code}`
    : (name || code || `کالا شماره ${row.product_id}`);
  const status = String(row.status || '');
  const statusLabel = status === 'done' ? 'انجام شد'
    : status === 'error' ? 'نیاز به رسیدگی'
      : status === 'pending' ? 'در صف ارسال' : status || 'نامشخص';

  const lr = parseOutboxLastResult(row.last_result);
  const matched = matchedCount(lr.matched);
  const unmatched = Array.isArray(lr.unmatched) ? lr.unmatched : [];
  const unmatchedN = unmatched.length;
  const reasons = [...new Set(unmatched.map((u) => String(u && u.reason || '').trim()).filter(Boolean))];
  const err = String(row.last_error || '').trim();
  const isTimeout = /timeout|مهلت|OUTBOUND_TIMEOUT|HTTP 0/i.test(err);
  const catalogMissing = reasons.includes('product_sku_not_found')
    || lr.catalogMissing === true
    || (unmatchedN > 0 && matched === 0 && unmatched.every((u) => String(u && u.reason || '') === 'product_sku_not_found'));

  let outcome = '';
  let nextStep = '';
  let tone = 'ok'; // ok | warn | bad | wait
  // What the operator must fix. Independent of the status counter.
  // catalog = site SKU, variant = color/size names, site = API up,
  // auth = saved key, queued = drain has not run, ok = stock written.
  let cause = 'other';

  const httpMatch = err.match(/\bHTTP\s+(\d{3})\b/);
  const httpCode = httpMatch ? Number(httpMatch[1]) : 0;
  const authHttp = httpCode === 401 || httpCode === 403;
  const siteHttp = httpCode >= 500 || httpCode === 429
    || (httpCode === 0 && /HTTP\s+0|بدون پاسخ/.test(err));

  if (lr.skipped === true && lr.reason === 'product_website_stock_off') {
    outcome = 'ارسال موجودی این کالا به سایت خاموش است';
    nextStep = 'در کارت کالا گزینهٔ «ارسال موجودی به سایت» را فعال کنید تا دوباره در صف قرار گیرد.';
    tone = 'ok';
    cause = 'ok';
  } else if (status === 'pending' && !err && !unmatchedN) {
    outcome = 'هنوز نتیجه نیامده';
    nextStep = 'وابسته به نوبت تخلیهٔ صف است. تا جواب نیاید کد کالا را عوض نکنید.';
    tone = 'wait';
    cause = 'queued';
  } else if (catalogMissing) {
    outcome = 'کد کالا در سایت پیدا نشد';
    nextStep = 'وابسته به ساخت یا وصل همان کد در فروشگاه است، نه به رنگ و نه به بالا بودن سایت. بعد از ساخت کد، دوباره همگام‌سازی کنید.';
    tone = 'warn';
    cause = 'catalog';
  } else if (authHttp) {
    outcome = `کلید یا دسترسی API سایت رد شد (HTTP ${httpCode})`;
    nextStep = 'وابسته به کلید ذخیره‌شده در تنظیمات است، نه به این کالا. کلید را دوباره ذخیره کنید و آزمایش اتصال را بزنید.';
    tone = 'bad';
    cause = 'auth';
  } else if (isTimeout || siteHttp) {
    if (isTimeout) {
      outcome = 'پاسخ سایت به‌موقع نرسید';
      nextStep = 'کمی بعد دوباره تلاش می‌شود؛ اگر تکرار شد اتصال سایت را چک کنید';
    } else if (httpCode === 429) {
      outcome = `سایت درخواست را موقتاً محدود کرد (HTTP ${httpCode})`;
      nextStep = 'وابسته به ظرفیت API سایت است، نه به کد کالا. کمی بعد دوباره تلاش می‌شود.';
    } else {
      outcome = `سایت موقتاً جواب نداد (HTTP ${httpCode || 'نامشخص'})`;
      nextStep = 'وابسته به در دسترس بودن API سایت است. کد کالا را برای این خطا نسازید. ردیف در صف می‌ماند و دوباره فرستاده می‌شود.';
    }
    tone = status === 'error' ? 'bad' : 'warn';
    cause = 'site';
  } else if (status === 'done' && unmatchedN === 0 && !err) {
    outcome = matched > 0 ? 'موجودی در سایت به‌روز شد' : 'انجام شد';
    nextStep = '';
    tone = 'ok';
    cause = 'ok';
  } else if (unmatchedN > 0 && status !== 'pending') {
    // Partial match is never success (row is 'error' since NONTAX-P1; older
    // rows may still carry status 'done' from before the fix).
    outcome = `${matched} مورد هم‌خوان · ${unmatchedN} مورد بدون هم‌خوانی در سایت`;
    const present = formatOnSiteLabels(lr.onSite, 8);
    nextStep = present.length
      ? `روی سایت این رنگ/سایزها هست: ${present.join('، ')}. نام در ERP باید عین همان باشد؛ رنگ نزدیک حدس زده نمی‌شود.`
      : 'رنگ/سایزهای بدون هم‌خوانی را در سایت وصل کنید، بعد دوباره همگام‌سازی کنید';
    tone = 'warn';
    cause = 'variant';
  } else if (status === 'error') {
    outcome = err || 'ارسال ناموفق بود';
    nextStep = 'دوباره همگام‌سازی کنید یا پشتیبانی را در جریان بگذارید';
    tone = 'bad';
    cause = 'other';
  } else if (err) {
    outcome = err;
    nextStep = '';
    tone = 'warn';
    cause = 'other';
  } else {
    outcome = statusLabel;
    tone = status === 'pending' ? 'wait' : 'ok';
    cause = status === 'pending' ? 'queued' : (status === 'done' ? 'ok' : 'other');
  }

  const variantHints = unmatched.slice(0, 4).map((u) => {
    const color = String(u.color || '').trim();
    const size = String(u.size || '').trim();
    if (color && size) return `${color} / ${size}`;
    return String(u.erpVariantSku || u.reason || '').trim();
  }).filter(Boolean);

  return {
    id: row.id,
    product_id: row.product_id,
    product_code: code,
    product_name: name,
    productLabel,
    channel,
    channelLabel,
    status,
    statusLabel,
    attempts: Number(row.attempts) || 0,
    outcome,
    nextStep,
    tone,
    cause,
    matched,
    unmatched: unmatchedN,
    updated_at: row.updated_at || null,
    variantHints,
    last_error: err,
  };
}

const OUTBOX_REPORT_LIMIT = 180;
const OUTBOX_CAUSE_RANK = { site: 0, auth: 1, catalog: 2, variant: 3, other: 4, queued: 5, ok: 6 };

function outboxStatus(db) {
  ensureWebsiteStockOutbox(db);
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS c FROM website_stock_outbox GROUP BY status
  `).all();
  const all = db.prepare(`
    SELECT o.id, o.product_id, o.channel, o.status, o.attempts, o.last_error, o.last_result, o.updated_at,
           p.code AS product_code, p.name AS product_name
    FROM website_stock_outbox o
    LEFT JOIN products p ON p.id = o.product_id
    ORDER BY o.updated_at DESC
  `).all();
  const counts = {};
  for (const r of rows) counts[r.status] = r.c;
  const summarized = all.map(summarizeOutboxRow);
  const causes = { catalog: 0, variant: 0, site: 0, auth: 0, queued: 0, ok: 0, other: 0 };
  for (const it of summarized) {
    const key = causes[it.cause] == null ? 'other' : it.cause;
    causes[key] += 1;
  }
  const ranked = summarized.slice().sort((a, b) => {
    const d = (OUTBOX_CAUSE_RANK[a.cause] ?? 9) - (OUTBOX_CAUSE_RANK[b.cause] ?? 9);
    if (d) return d;
    return (Number(b.attempts) || 0) - (Number(a.attempts) || 0);
  });
  const attention = ranked.filter((it) => it.cause !== 'ok');
  const doneSample = ranked.filter((it) => it.cause === 'ok').slice(0, 12);
  const items = attention.length > OUTBOX_REPORT_LIMIT
    ? attention.slice(0, OUTBOX_REPORT_LIMIT)
    : attention.concat(doneSample);
  const truncated = Math.max(0, attention.length - (attention.length > OUTBOX_REPORT_LIMIT ? OUTBOX_REPORT_LIMIT : attention.length));
  const recent = all.slice(0, 30);
  const summary = {
    done: Number(counts.done || 0),
    pending: Number(counts.pending || 0),
    error: Number(counts.error || 0),
    line: `${Number(counts.done || 0)} انجام‌شده · ${Number(counts.pending || 0)} در صف · ${Number(counts.error || 0)} نیاز به رسیدگی`,
    shown: items.length,
    total: summarized.length,
    truncated,
  };
  return { counts, causes, summary, recent, items };
}

// Legacy alias used by older call sites
async function pushSiteB2bStock(db, product) {
  const r = enqueueWebsiteStock(db, product && product.id);
  return { ok: true, queued: r };
}

module.exports = {
  notifyStockChanged,
  isStockPushEnabled,
  enqueueWebsiteStock,
  drainWebsiteStockOutbox,
  buildMatrixPayload,
  pushMatrixToSite,
  testWebsiteConnection,
  dryRunProductMatrix,
  resolveSyncProduct,
  formatDryRunChannel,
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
  siteApiUrl,
  siteB2bApiUrl,
  normalizeBase,
  getSettingsMap,
  secretOpenError,
  startWebsiteStockDrainLoop,
  formatOutboundFailure,
  summarizeOutboxRow,
  classifyMatrixPushResult,
  chunkMatrixRequests,
  formatUnmatchedExample,
  formatOnSiteLabels,
  priorCatalogMissBlocksDelivery,
  requeueFrozenWebsiteStockErrors,
  normalizeWebsiteStockPush,
  productAllowsWebsiteStockPush,
  silenceProductWebsiteOutbox,
  DEBOUNCE_MS,
  MATRIX_TIMEOUT_MS,
  MATRIX_CHUNK_SIZE,
  DRAIN_BATCH,
  UNMATCHED_EXAMPLE_LIMIT,
};
