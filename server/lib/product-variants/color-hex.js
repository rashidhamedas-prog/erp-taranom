'use strict';
/**
 * INV-02 — product color hex validation, normalize, a11y contrast.
 * Accepts #RGB or #RRGGBB only. Empty hex is allowed (optional).
 */

const HEX_RE = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;

function parseHex(hex) {
  const t = String(hex || '').trim();
  if (!t) return null;
  const m = HEX_RE.exec(t);
  if (!m) return null;
  const raw = m[1];
  const full = raw.length === 3
    ? raw[0] + raw[0] + raw[1] + raw[1] + raw[2] + raw[2]
    : raw;
  const normalized = '#' + full.toUpperCase();
  return {
    normalized,
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function channelLin(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance(r, g, b) {
  return 0.2126 * channelLin(r) + 0.7152 * channelLin(g) + 0.0722 * channelLin(b);
}

function contrastRatio(l1, l2) {
  const a = Math.max(l1, l2);
  const b = Math.min(l1, l2);
  return (a + 0.05) / (b + 0.05);
}

function colorA11y(hex) {
  const parsed = parseHex(hex);
  if (!parsed) {
    return {
      hex_normalized: '',
      contrast_ok: null,
      contrast_on_white: null,
      contrast_on_black: null,
      contrast_fg: null,
    };
  }
  const L = relativeLuminance(parsed.r, parsed.g, parsed.b);
  const onWhite = contrastRatio(1, L);
  const onBlack = contrastRatio(L, 0);
  const AA = 4.5;
  return {
    hex_normalized: parsed.normalized,
    contrast_ok: onWhite >= AA || onBlack >= AA,
    contrast_on_white: Math.round(onWhite * 100) / 100,
    contrast_on_black: Math.round(onBlack * 100) / 100,
    contrast_fg: onWhite >= onBlack ? 'white' : 'black',
  };
}

function decorateColor(row) {
  if (!row) return row;
  return Object.assign({}, row, colorA11y(row.hex));
}

function normalizeAndAssertHex(hex, { required = false } = {}) {
  const t = String(hex == null ? '' : hex).trim();
  if (!t) {
    if (required) {
      throw Object.assign(new Error('کد رنگ hex الزامی است'), {
        status: 400,
        code: 'E_COLOR_INVALID_HEX',
      });
    }
    return '';
  }
  const parsed = parseHex(t);
  if (!parsed) {
    throw Object.assign(new Error('کد رنگ باید #RGB یا #RRGGBB باشد'), {
      status: 400,
      code: 'E_COLOR_INVALID_HEX',
    });
  }
  return parsed.normalized;
}

function assertUniqueHex(db, hex, excludeId) {
  const normalized = String(hex || '').trim();
  if (!normalized) return;
  const rows = db.prepare('SELECT id, hex FROM product_colors').all();
  for (const r of rows) {
    if (excludeId && Number(r.id) === Number(excludeId)) continue;
    const other = parseHex(r.hex);
    if (other && other.normalized === normalized) {
      throw Object.assign(new Error('این کد رنگ قبلاً ثبت شده است'), {
        status: 400,
        code: 'E_COLOR_DUPLICATE',
        existing_id: r.id,
      });
    }
  }
}

module.exports = {
  HEX_RE,
  parseHex,
  colorA11y,
  decorateColor,
  normalizeAndAssertHex,
  assertUniqueHex,
};
