'use strict';

const crypto = require('crypto');

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function assertNoInlineExecutableMarkup(html, { allowPrintScript = false } = {}) {
  if (/\son[a-z0-9_-]+\s*=/i.test(html)) {
    throw new Error('Secure HTML response rejected an inline event handler');
  }
  if (/\sstyle\s*=/i.test(html)) {
    throw new Error('Secure HTML response rejected an inline style attribute');
  }
  if (/javascript\s*:/i.test(html)) {
    throw new Error('Secure HTML response rejected a javascript: URL');
  }
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attributes = match[1] || '';
    const body = match[2] || '';
    const src = /\bsrc\s*=\s*(["'])([^"']+)\1/i.exec(attributes);
    if (!src || body.trim()) {
      throw new Error('Secure HTML response permits only empty external script tags');
    }
    if (!allowPrintScript || src[2] !== '/print-page.js') {
      throw new Error('Secure HTML response rejected a non-approved script source');
    }
  }
}

function buildPolicy(nonce, { allowPrintScript = false } = {}) {
  const script = allowPrintScript ? "script-src 'self'" : "script-src 'none'";
  const sandbox = allowPrintScript
    ? 'sandbox allow-same-origin allow-scripts allow-modals'
    : 'sandbox allow-same-origin';
  return [
    "default-src 'none'",
    script,
    "script-src-attr 'none'",
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'none'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    sandbox,
  ].join('; ');
}

function secureHtmlDocument(input, options = {}) {
  let html = String(input || '');
  assertNoInlineExecutableMarkup(html, options);

  const nonce = crypto.randomBytes(18).toString('base64');
  html = html.replace(/<style\b([^>]*)>/gi, (_whole, rawAttributes) => {
    const attributes = String(rawAttributes || '').replace(/\snonce\s*=\s*(["']).*?\1/gi, '');
    return `<style nonce="${escapeAttribute(nonce)}"${attributes}>`;
  });

  const policy = buildPolicy(nonce, options);
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}">`
    + '<meta name="referrer" content="no-referrer">';
  if (/<head\b[^>]*>/i.test(html)) {
    html = html.replace(/<head\b([^>]*)>/i, (whole) => `${whole}${meta}`);
  } else {
    throw new Error('Secure HTML response requires a head element');
  }
  return { html, policy, nonce };
}

function publicAssetOriginFromReq(req) {
  if (!req || !req.headers) return '';
  const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/.test(rawHost)) return '';
  const protoRaw = String(req.headers['x-forwarded-proto'] || req.protocol || 'https')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(rawHost);
  const proto = isLocal && protoRaw === 'http' ? 'http' : 'https';
  return `${proto}://${rawHost}`;
}

function absolutizeRootRelativeAssets(html, origin) {
  if (!origin) return html;
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    return html;
  }
  if (!/^https?:$/i.test(originUrl.protocol)) return html;
  const base = originUrl.href.endsWith('/') ? originUrl.href : `${originUrl.href}/`;
  return String(html).replace(
    /\b(href|src)=(["'])(\/[^"'>\s]*)\2/gi,
    (whole, attr, quote, assetPath) => {
      if (assetPath.startsWith('//')) return whole;
      const abs = new URL(assetPath, base);
      if (abs.origin !== originUrl.origin) return whole;
      return `${attr}=${quote}${abs.href}${quote}`;
    },
  );
}

function sendSecureHtml(res, input, options = {}) {
  const document = secureHtmlDocument(input, options);
  const origin = options.assetOrigin || publicAssetOriginFromReq(res && res.req);
  const html = absolutizeRootRelativeAssets(document.html, origin);
  res.status(options.status || 200);
  res.type('html');
  res.setHeader('Content-Security-Policy', document.policy);
  res.setHeader('X-Taranom-Safe-HTML', '1');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  return res.send(html);
}

module.exports = {
  secureHtmlDocument,
  sendSecureHtml,
  assertNoInlineExecutableMarkup,
  buildPolicy,
  publicAssetOriginFromReq,
  absolutizeRootRelativeAssets,
};
