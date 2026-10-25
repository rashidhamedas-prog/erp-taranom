'use strict';
/** Audit 7D — SW cache pin helper (at-least, not exact). */

function swCacheVersion(swSrc) {
  const m = String(swSrc || '').match(/erp-taranom-v(\d+)/);
  return m ? Number(m[1]) : 0;
}

function swAtLeast(swSrc, n) {
  return swCacheVersion(swSrc) >= Number(n);
}

module.exports = { swCacheVersion, swAtLeast };
