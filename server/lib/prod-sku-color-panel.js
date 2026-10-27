'use strict';

/** Normalize Persian/Arabic for color search (ي/ك/آ، ZWNJ، ارقام). */
function faNorm(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF\u200C]/g, '')
    .replace(/ي/g, 'ی')
    .replace(/ى/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[آأإ]/g, 'ا')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Filter color catalog by name/code using faNorm. */
function prodColorFilter(list, q) {
  const nq = faNorm(q);
  if (!nq) return Array.isArray(list) ? list.slice() : [];
  return (list || []).filter((c) => {
    if (!c) return false;
    return faNorm(c.name).includes(nq) || faNorm(c.code).includes(nq);
  });
}

/**
 * Classify style colors for a warehouse view.
 * @param {object[]} styleVars
 * @param {number|string} [_whId] reserved (variants already scoped by API)
 * @param {object} helpers { styleColorIds, matrixColorIds, preserveColorIds } — Set or array factories
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

/** Split size label: main before paren, subtext inside. */
function splitSizeLabel(name) {
  const raw = String(name || '').trim();
  const m = raw.match(/^(.+?)\s*[（(]\s*(.+?)\s*[）)]\s*$/);
  if (m) return { main: m[1].trim(), sub: m[2].trim(), full: raw };
  return { main: raw, sub: '', full: raw };
}

module.exports = {
  faNorm,
  prodColorFilter,
  prodSkuClassifyColors,
  splitSizeLabel,
};
