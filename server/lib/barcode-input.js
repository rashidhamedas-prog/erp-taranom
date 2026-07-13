'use strict';

/** Shared barcode scan helpers (camera + USB wedge). Tested by scripts/test-barcode-input.js */

const DEFAULT_DEBOUNCE_MS = 400;
const WEDGE_MAX_GAP_MS = 80;
const WEDGE_MIN_LEN = 3;
const WEDGE_MAX_LEN = 64;

function normalizeBarcode(raw) {
  return String(raw || '').trim().replace(/[\r\n]+/g, '');
}

function shouldAcceptScan(lastAt, now = Date.now(), debounceMs = DEFAULT_DEBOUNCE_MS) {
  if (!lastAt) return true;
  return (now - lastAt) >= debounceMs;
}

function createWedgeState() {
  return { chars: '', lastKeyAt: 0 };
}

/**
 * Feed one key from a wedge scanner. Returns { code, state } where code is set on Enter.
 */
function feedWedgeKey(state, key, ts = Date.now()) {
  const s = state || createWedgeState();
  if (key === 'Enter') {
    const code = normalizeBarcode(s.chars);
    const next = createWedgeState();
    if (code.length >= WEDGE_MIN_LEN && code.length <= WEDGE_MAX_LEN) {
      return { code, state: next };
    }
    return { code: null, state: next };
  }
  if (!key || key.length !== 1) return { code: null, state: s };
  if (s.lastKeyAt && (ts - s.lastKeyAt) > WEDGE_MAX_GAP_MS) {
    return feedWedgeKey(createWedgeState(), key, ts);
  }
  if (!/^[\x20-\x7E]$/.test(key)) return { code: null, state: s };
  const chars = s.chars + key;
  if (chars.length > WEDGE_MAX_LEN) {
    return { code: null, state: createWedgeState() };
  }
  return { code: null, state: { chars, lastKeyAt: ts } };
}

function isWedgeTypingTarget(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || el.isContentEditable) return true;
  if (tag === 'input') {
    const type = (el.type || 'text').toLowerCase();
    if (type === 'button' || type === 'checkbox' || type === 'radio' || type === 'submit') return false;
    return true;
  }
  return false;
}

const api = {
  DEFAULT_DEBOUNCE_MS,
  WEDGE_MAX_GAP_MS,
  WEDGE_MIN_LEN,
  WEDGE_MAX_LEN,
  normalizeBarcode,
  shouldAcceptScan,
  createWedgeState,
  feedWedgeKey,
  isWedgeTypingTarget,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof globalThis !== 'undefined') {
  globalThis.BarcodeInput = api;
}
