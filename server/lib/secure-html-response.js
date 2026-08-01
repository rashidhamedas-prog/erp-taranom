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

function sendSecureHtml(res, input, options = {}) {
  const document = secureHtmlDocument(input, options);
  res.status(options.status || 200);
  res.type('html');
  res.setHeader('Content-Security-Policy', document.policy);
  res.setHeader('X-Taranom-Safe-HTML', '1');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  return res.send(document.html);
}

module.exports = {
  secureHtmlDocument,
  sendSecureHtml,
  assertNoInlineExecutableMarkup,
  buildPolicy,
};
