'use strict';

const dns = require('dns');
const https = require('https');
const net = require('net');
const { URL } = require('url');

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

class OutboundUrlError extends Error {
  constructor(message, code = 'OUTBOUND_URL_REJECTED') {
    super(message);
    this.name = 'OutboundUrlError';
    this.code = code;
    this.status = 400;
  }
}

function parseIPv4(address) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) return null;
  const parts = address.split('.').map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return null;
  return parts;
}

function normalizeMappedIPv4(address) {
  const lower = String(address || '').toLowerCase();
  const dotted = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return dotted[1];
  const hex = lower.match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >>> 8}.${hi & 255}.${lo >>> 8}.${lo & 255}`;
}

function isPublicIPv4(address) {
  const p = parseIPv4(address);
  if (!p) return false;
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

function expandIPv6(address) {
  let input = String(address || '').toLowerCase().split('%')[0];
  const mapped = normalizeMappedIPv4(input);
  if (mapped) return { mapped };
  if (!net.isIPv6(input)) return null;

  // Turn an IPv4 tail into two hexadecimal groups before expanding "::".
  const tail = input.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tail) {
    const p = parseIPv4(tail[1]);
    if (!p) return null;
    input = input.slice(0, -tail[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right].map((part) => parseInt(part || '0', 16));
  if (groups.length !== 8 || groups.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)) return null;
  return { groups };
}

function isPublicIPv6(address) {
  const parsed = expandIPv6(address);
  if (!parsed) return false;
  if (parsed.mapped) return isPublicIPv4(parsed.mapped);
  const g = parsed.groups;
  // unspecified / loopback
  if (g.slice(0, 7).every((part) => part === 0) && (g[7] === 0 || g[7] === 1)) return false;
  // Unique-local fc00::/7, link-local fe80::/10, multicast ff00::/8.
  if ((g[0] & 0xfe00) === 0xfc00) return false;
  if ((g[0] & 0xffc0) === 0xfe80) return false;
  if ((g[0] & 0xff00) === 0xff00) return false;
  // Documentation, benchmarking, discard-only and protocol-assignment ranges.
  if (g[0] === 0x100 && g.slice(1, 4).every((part) => part === 0)) return false; // 100::/64
  if (g[0] === 0x0064 && g[1] === 0xff9b && g.slice(2, 6).every((part) => part === 0)) return false; // NAT64 well-known /96
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0x0001) return false; // local-use NAT64 /48
  if (g[0] === 0x2001 && g[1] === 0x0000) return false; // Teredo 2001::/32
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2001 && g[1] === 0x0002) return false; // benchmarking
  if (g[0] === 0x2001 && (g[1] & 0xfff0) === 0x0010) return false; // ORCHID
  if (g[0] === 0x2002) return false; // 6to4 embeds an IPv4 target
  // Only global-unicast 2000::/3 is accepted.
  return (g[0] & 0xe000) === 0x2000;
}

function assertPublicAddress(address) {
  const family = net.isIP(String(address || ''));
  const ok = family === 4 ? isPublicIPv4(address) : family === 6 ? isPublicIPv6(address) : false;
  if (!ok) throw new OutboundUrlError('آدرس مقصد عمومی و مجاز نیست', 'OUTBOUND_PRIVATE_ADDRESS');
  return family;
}

function validateOutboundUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new OutboundUrlError('آدرس خروجی معتبر نیست');
  }
  if (url.protocol !== 'https:') {
    throw new OutboundUrlError('فقط آدرس HTTPS برای ارتباط خروجی مجاز است', 'OUTBOUND_HTTPS_REQUIRED');
  }
  if (url.username || url.password) {
    throw new OutboundUrlError('قرار دادن نام کاربری یا رمز در URL مجاز نیست', 'OUTBOUND_CREDENTIALS_REJECTED');
  }
  if (url.port && url.port !== '443') {
    throw new OutboundUrlError('ارتباط خروجی فقط روی پورت ۴۴۳ مجاز است', 'OUTBOUND_PORT_REJECTED');
  }
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1) : url.hostname;
  if (!hostname || hostname.length > 253 || /[\u0000-\u001f\u007f\s]/.test(hostname)) {
    throw new OutboundUrlError('نام میزبان مقصد معتبر نیست');
  }
  if (url.hash) url.hash = '';
  if (net.isIP(hostname)) assertPublicAddress(hostname);
  return url;
}

async function defaultLookup(hostname) {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

async function resolvePublicTarget(value, lookup = defaultLookup) {
  const url = value instanceof URL ? validateOutboundUrl(value.href) : validateOutboundUrl(value);
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1) : url.hostname;
  let records;
  if (net.isIP(hostname)) {
    records = [{ address: hostname, family: net.isIP(hostname) }];
  } else {
    try {
      records = await lookup(hostname);
    } catch {
      throw new OutboundUrlError('نام میزبان مقصد قابل resolve نیست', 'OUTBOUND_DNS_FAILED');
    }
  }
  if (!Array.isArray(records)) records = records ? [records] : [];
  if (!records.length) throw new OutboundUrlError('مقصد هیچ IP قابل استفاده‌ای ندارد', 'OUTBOUND_DNS_EMPTY');
  const normalized = records.map((record) => ({
    address: String(record.address || ''),
    family: Number(record.family) || net.isIP(String(record.address || '')),
  }));
  for (const record of normalized) {
    const family = assertPublicAddress(record.address);
    if (record.family !== family) record.family = family;
  }
  return { url, hostname, address: normalized[0].address, family: normalized[0].family, addresses: normalized };
}

function sanitizeRedirectHeaders(headers, fromUrl, toUrl) {
  const out = { ...(headers || {}) };
  if (fromUrl.origin !== toUrl.origin) {
    for (const key of Object.keys(out)) {
      if (/^(authorization|proxy-authorization|cookie|x-webhook-secret)$/i.test(key)) delete out[key];
    }
  }
  return out;
}

function sanitizeCallerHeaders(headers) {
  const allowed = new Set(['authorization', 'x-webhook-secret', 'user-agent']);
  const out = {};
  for (const [key, rawValue] of Object.entries(headers || {})) {
    const lower = String(key).toLowerCase();
    if (!allowed.has(lower)) continue;
    const value = String(rawValue == null ? '' : rawValue);
    if (!value || /[\r\n]/.test(value) || value.length > 8192) {
      throw new OutboundUrlError('هدر ارتباط خروجی معتبر نیست', 'OUTBOUND_HEADER_REJECTED');
    }
    const canonical = lower === 'authorization' ? 'Authorization'
      : lower === 'x-webhook-secret' ? 'X-Webhook-Secret' : 'User-Agent';
    out[canonical] = value;
  }
  return out;
}

function dispatchHttps(target, { method, data, headers, timeoutMs, maxResponseBytes }) {
  return new Promise((resolve, reject) => {
    const url = target.url;
    const requestHeaders = {
      Accept: 'application/json',
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      ...sanitizeCallerHeaders(headers),
    };
    const req = https.request({
      protocol: 'https:',
      hostname: target.hostname,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method,
      headers: requestHeaders,
      servername: net.isIP(target.hostname) ? undefined : target.hostname,
      lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
      timeout: timeoutMs,
      rejectUnauthorized: true,
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxResponseBytes) {
          res.destroy(new OutboundUrlError('پاسخ مقصد بیش از حد مجاز است', 'OUTBOUND_RESPONSE_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({
        status: Number(res.statusCode) || 0,
        headers: res.headers || {},
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new OutboundUrlError('مهلت ارتباط خروجی تمام شد', 'OUTBOUND_TIMEOUT')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function safeRequestJSON(urlValue, method = 'GET', body = null, headers = {}, options = {}) {
  const lookup = options.lookup || defaultLookup;
  const dispatch = options.dispatch || dispatchHttps;
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), 30_000);
  const maxResponseBytes = Math.min(Math.max(Number(options.maxResponseBytes) || DEFAULT_MAX_RESPONSE_BYTES, 1024), 8 * 1024 * 1024);
  const maxRedirects = Math.min(Math.max(Number(options.maxRedirects) || DEFAULT_MAX_REDIRECTS, 0), 5);
  let current = validateOutboundUrl(urlValue);
  let requestMethod = String(method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(requestMethod)) {
    throw new OutboundUrlError('روش HTTP خروجی مجاز نیست', 'OUTBOUND_METHOD_REJECTED');
  }
  let data = body == null ? null : JSON.stringify(body);
  let currentHeaders = sanitizeCallerHeaders(headers);

  for (let redirect = 0; ; redirect += 1) {
    const target = await resolvePublicTarget(current, lookup);
    const response = await dispatch(target, {
      method: requestMethod,
      data,
      headers: currentHeaders,
      timeoutMs,
      maxResponseBytes,
    });
    if (!REDIRECT_CODES.has(response.status)) return response;
    if (redirect >= maxRedirects) throw new OutboundUrlError('تعداد تغییر مسیر خروجی بیش از حد مجاز است', 'OUTBOUND_REDIRECT_LIMIT');
    const location = response.headers && response.headers.location;
    if (!location) throw new OutboundUrlError('پاسخ تغییر مسیر بدون مقصد معتبر است', 'OUTBOUND_REDIRECT_INVALID');
    let next;
    try { next = validateOutboundUrl(new URL(location, current).href); }
    catch (error) {
      if (error instanceof OutboundUrlError) throw error;
      throw new OutboundUrlError('مقصد تغییر مسیر معتبر نیست', 'OUTBOUND_REDIRECT_INVALID');
    }
    currentHeaders = sanitizeRedirectHeaders(currentHeaders, current, next);
    if (response.status === 303) {
      requestMethod = 'GET';
      data = null;
    }
    current = next;
  }
}

async function assertSafeOutboundTarget(value, options = {}) {
  return resolvePublicTarget(value, options.lookup || defaultLookup);
}

module.exports = {
  OutboundUrlError,
  validateOutboundUrl,
  assertPublicAddress,
  resolvePublicTarget,
  assertSafeOutboundTarget,
  safeRequestJSON,
  sanitizeRedirectHeaders,
  _test: { isPublicIPv4, isPublicIPv6, expandIPv6, dispatchHttps, sanitizeCallerHeaders },
};
