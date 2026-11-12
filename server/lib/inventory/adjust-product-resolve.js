'use strict';
/**
 * Pure product resolver for «تعدیل تجمیعی» add-picker (SW v645+).
 * Browser mirrors this in app.js `resolveAdjustDocProduct` — keep behavior aligned.
 */

function toAsciiDigits(s) {
  return String(s == null ? '' : s)
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

function omniNorm(s) {
  return toAsciiDigits(s)
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
    .replace(/ي/g, 'ی').replace(/ى/g, 'ی').replace(/ك/g, 'ک')
    .replace(/ۀ/g, 'ه').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/[أإآ]/g, 'ا')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[()[\]{}«»""''،,.;:!?؟\-_/\\|+*=<>@#$%^&~`]/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function textMatchesQuery(haystack, query) {
  const q = omniNorm(query);
  if (!q) return true;
  const hay = omniNorm(haystack);
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.every((t) => hay.includes(t))) return true;
  return String(haystack || '').toLowerCase().includes(String(query || '').trim().toLowerCase());
}

function pLabel(p) {
  return (p && p.code ? String(p.code) + ' — ' : '') + String((p && p.name) || '');
}

function normLabel(s) {
  return toAsciiDigits(String(s || ''))
    .replace(/[\u2013\u2014\-]+/g, '—')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {Array<object>} prods
 * @param {{ hiddenId?: string|number|null, raw?: string, cacheFailed?: boolean, cacheErrorMsg?: string }} opts
 * @returns {{ ok:true, product:object } | { ok:false, error:string }}
 */
function resolveAdjustDocProduct(prods, opts) {
  const o = opts || {};
  const list = Array.isArray(prods) ? prods : [];
  if (!list.length) {
    const base = 'فهرست کالا بارگذاری نشد';
    if (o.cacheFailed && o.cacheErrorMsg) return { ok: false, error: base + ' — ' + String(o.cacheErrorMsg).slice(0, 120) };
    return { ok: false, error: base };
  }

  const hid = o.hiddenId != null && String(o.hiddenId).trim() !== '' ? String(o.hiddenId).trim() : '';
  if (hid) {
    const byHid = list.find((p) => String(p.id) === hid);
    if (byHid) return { ok: true, product: byHid };
  }

  let raw = String(o.raw == null ? '' : o.raw).trim();
  if (!raw) return { ok: false, error: 'کالا را انتخاب کنید' };
  raw = toAsciiDigits(raw).trim();

  const amb = 'چند کالا با این عبارت هست؛ یکی را از فهرست انتخاب کنید';
  const miss = 'کالا در فهرست پیدا نشد';

  const exactId = list.filter((p) => String(p.id) === raw);
  if (exactId.length === 1) return { ok: true, product: exactId[0] };

  const exactCode = list.filter((p) => toAsciiDigits(String(p.code || '')).trim() === raw);
  if (exactCode.length === 1) return { ok: true, product: exactCode[0] };
  if (exactCode.length > 1) return { ok: false, error: amb };

  const exactBc = list.filter((p) => toAsciiDigits(String(p.barcode || '')).trim() === raw);
  if (exactBc.length === 1) return { ok: true, product: exactBc[0] };
  if (exactBc.length > 1) return { ok: false, error: amb };

  const exactSku = list.filter((p) => toAsciiDigits(String(p.sku || '')).trim() === raw);
  if (exactSku.length === 1) return { ok: true, product: exactSku[0] };
  if (exactSku.length > 1) return { ok: false, error: amb };

  const wantLabel = normLabel(raw);
  const exactLabel = list.filter((p) => normLabel(pLabel(p)) === wantLabel);
  if (exactLabel.length === 1) return { ok: true, product: exactLabel[0] };
  if (exactLabel.length > 1) return { ok: false, error: amb };

  const exactName = list.filter((p) => toAsciiDigits(String(p.name || '')).trim() === raw);
  if (exactName.length === 1) return { ok: true, product: exactName[0] };
  if (exactName.length > 1) return { ok: false, error: amb };

  const hits = list.filter((p) =>
    textMatchesQuery([p.name, p.code, p.barcode, p.sku].filter(Boolean).join(' '), raw)
  );
  if (hits.length === 1) return { ok: true, product: hits[0] };
  if (hits.length === 0) return { ok: false, error: miss };
  return { ok: false, error: amb };
}

module.exports = {
  resolveAdjustDocProduct,
  toAsciiDigits,
  textMatchesQuery,
  pLabel,
  omniNorm,
};
