'use strict';

/* PCS-SHARED:faNorm */
function faNorm(s){
  return String(s==null?'':s)
    .normalize('NFKC')
    .replace(/[\u200B\u200D-\u200F\u202A-\u202E\u2060\uFEFF]/g,'')
    .replace(/[\u064A\u0649]/g,'\u06CC')
    .replace(/\u0643/g,'\u06A9')
    .replace(/[\u0622\u0623\u0625]/g,'\u0627')
    .replace(/\u0629/g,'\u0647')
    .replace(/[\u064B-\u065F\u0670]/g,'')
    .replace(/[۰-۹]/g,d=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g,d=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[\u200C\s\u00A0]+/g,' ')
    .trim()
    .toLowerCase();
}
/* /PCS-SHARED */

/* PCS-SHARED:prodColorFilter */
function prodColorFilter(list,q){
  const k=x=>faNorm(x).replace(/ /g,'');
  const nq=k(q);
  if(!nq) return Array.isArray(list)?list.slice():[];
  return (list||[]).filter(c=>c && (k(c.name).includes(nq) || k(c.code).includes(nq)));
}
/* /PCS-SHARED */

/**
 * Classify style colors for a warehouse view.
 * App version uses two args + global helpers; lib accepts optional helpers bag.
 */
function prodSkuClassifyColors(styleVars, _whId, helpers) {
  const h = helpers || {};
  const styleSet = h.styleColorIds
    ? h.styleColorIds(styleVars)
    : new Set(
        (styleVars || [])
          .filter((v) => v && Number(v.is_default) !== 1 && v.active !== 0)
          .map((v) => Number(v.color_id))
          .filter(Boolean)
      );
  const matrixSet = h.matrixColorIds
    ? h.matrixColorIds(styleVars)
    : new Set();
  const preserveSet = new Set(
    h.preserveColorIds ? h.preserveColorIds(styleVars) : []
  );
  const styleIds = [...styleSet].map(Number).filter(Boolean);
  const withStock = styleIds.filter((id) => matrixSet.has(id));
  const otherWh = [...preserveSet].map(Number).filter(Boolean);
  const otherSet = new Set(otherWh);
  const withoutStock = styleIds.filter((id) => !matrixSet.has(id) && !otherSet.has(id));
  return { withStock, withoutStock, otherWh };
}

/* PCS-SHARED:splitSizeLabel */
function splitSizeLabel(name){
  const raw=String(name||'').trim();
  const m=raw.match(/^(.+?)\s*[（(]\s*(.+?)\s*[）)]\s*$/);
  if(m) return { main:m[1].trim(), sub:m[2].trim(), full:raw };
  return { main:raw, sub:'', full:raw };
}
/* /PCS-SHARED */

function pcsDraftEnsure(draft, productId) {
  const pid = Number(productId) || 0;
  if (!draft || Number(draft.productId) !== pid) {
    return { productId: pid, byWh: {} };
  }
  if (!draft.byWh || typeof draft.byWh !== 'object') draft.byWh = {};
  return draft;
}

function pcsDraftGet(draft, whId, colorId, sizeId) {
  if (!draft || !draft.byWh) return undefined;
  const bag = draft.byWh[String(Number(whId) || 0)];
  if (!bag) return undefined;
  const key = `${Number(colorId)}:${Number(sizeId)}`;
  return Object.prototype.hasOwnProperty.call(bag, key) ? bag[key] : undefined;
}

function pcsDraftSet(draft, whId, colorId, sizeId, value, serverQty) {
  const d = draft && typeof draft === 'object' ? draft : { productId: 0, byWh: {} };
  if (!d.byWh) d.byWh = {};
  const wh = String(Number(whId) || 0);
  if (!d.byWh[wh]) d.byWh[wh] = {};
  const key = `${Number(colorId)}:${Number(sizeId)}`;
  const str = value == null ? '' : String(value);
  const serverStr = serverQty == null ? '' : String(serverQty);
  const same =
    str === serverStr ||
    (Number(str) === Number(serverStr) && str !== '' && serverStr !== '');
  if (same || (str === '' && (serverQty == null || Number(serverQty) === 0))) {
    delete d.byWh[wh][key];
    if (!Object.keys(d.byWh[wh]).length) delete d.byWh[wh];
  } else {
    d.byWh[wh][key] = str;
  }
  return d;
}

function pcsDraftClear(draft, whId) {
  if (!draft || !draft.byWh) return draft || { productId: 0, byWh: {} };
  if (whId == null) {
    draft.byWh = {};
    return draft;
  }
  delete draft.byWh[String(Number(whId) || 0)];
  return draft;
}

function pcsDraftCount(draft, whId) {
  if (!draft || !draft.byWh) return 0;
  if (whId != null) {
    const bag = draft.byWh[String(Number(whId) || 0)] || {};
    return Object.keys(bag).length;
  }
  return Object.keys(draft.byWh).reduce((n, k) => n + Object.keys(draft.byWh[k] || {}).length, 0);
}

/** Fill only empty/zero string cells with fillVal; leave others. Returns {next, filled}. */
function pcsFillEmptyValues(values, fillVal) {
  const fill = fillVal == null ? '1' : String(fillVal);
  const next = Array.isArray(values) ? values.slice() : [];
  let filled = 0;
  for (let i = 0; i < next.length; i++) {
    const v = next[i] == null ? '' : String(next[i]).trim();
    if (v === '' || v === '0') {
      next[i] = fill;
      filled += 1;
    }
  }
  return { next, filled };
}

function safeCssHex(h) {
  const s = String(h == null ? '' : h).trim();
  return /^#[0-9A-Fa-f]{3,8}$/.test(s) ? s : '';
}

/**
 * Pure swatch resolver (same rules as app.js pcsSwatchForColorId).
 * Source: catalog row hex/color_hex via safeCssHex — never invents hsl from name.
 */
function pcsSwatchForColorId(colorId, catalog) {
  const id = Number(colorId) || 0;
  const c = (catalog || []).find((x) => Number(x.id) === id);
  const hex = safeCssHex(c && (c.hex || c.color_hex));
  if (hex) return { hex, missing: false };
  return { hex: '', missing: true };
}

module.exports = {
  faNorm,
  prodColorFilter,
  prodSkuClassifyColors,
  splitSizeLabel,
  pcsDraftEnsure,
  pcsDraftGet,
  pcsDraftSet,
  pcsDraftClear,
  pcsDraftCount,
  pcsFillEmptyValues,
  safeCssHex,
  pcsSwatchForColorId,
};
