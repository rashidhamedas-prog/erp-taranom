'use strict';

/** Normalize Persian/Arabic text so search matches regardless of yeh/kaf/digits/punctuation. */
function normalizeSearchText(input) {
  return String(input || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
    .replace(/ي/g, 'ی')
    .replace(/ى/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/ۀ/g, 'ه')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/أ|إ|آ/g, 'ا')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[()[\]{}«»""''،,.;:!?؟\-_/\\|+*=<>@#$%^&~`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function searchTokens(input) {
  return normalizeSearchText(input).split(/\s+/).filter(Boolean);
}

function escapeLike(s) {
  return String(s || '').replace(/([\\%_])/g, '\\$1');
}

/** SQL expression that loosely normalizes a text column for matching. */
function sqlNormExpr(col) {
  return `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(COALESCE(${col},'')),'ي','ی'),'ى','ی'),'ك','ک'),'(',' '),')',' ')`;
}

/**
 * AND of tokens across columns (OR within a token).
 * Also ORs a raw LIKE so pasted exact names with punctuation still match.
 */
function sqlTokenSearch(columns, rawQuery) {
  const tokens = searchTokens(rawQuery);
  const raw = String(rawQuery || '').trim();
  if (!tokens.length && !raw) return null;
  const params = [];
  const parts = [];

  if (tokens.length) {
    tokens.forEach(tok => {
      const like = '%' + escapeLike(tok) + '%';
      const ors = columns.map(c => `${sqlNormExpr(c)} LIKE ? ESCAPE '\\'`).join(' OR ');
      columns.forEach(() => params.push(like));
      parts.push(`(${ors})`);
    });
  }

  if (raw) {
    const likeRaw = '%' + escapeLike(raw) + '%';
    const ors = columns.map(c => `${c} LIKE ? ESCAPE '\\'`).join(' OR ');
    columns.forEach(() => params.push(likeRaw));
    // If we have tokens, raw is an alternative path (OR); else it's the only clause
    if (parts.length) {
      return { clause: '((' + parts.join(' AND ') + ') OR (' + ors + '))', params, tokens };
    }
    return { clause: `(${ors})`, params, tokens };
  }

  return { clause: '(' + parts.join(' AND ') + ')', params, tokens };
}

function textMatchesQuery(haystack, query) {
  const tokens = searchTokens(query);
  if (!tokens.length) {
    const raw = String(query || '').trim().toLowerCase();
    return !raw || String(haystack || '').toLowerCase().includes(raw);
  }
  const hay = normalizeSearchText(haystack);
  if (tokens.every(t => hay.includes(t))) return true;
  const raw = String(query || '').trim().toLowerCase();
  return !!(raw && String(haystack || '').toLowerCase().includes(raw));
}

module.exports = {
  normalizeSearchText,
  searchTokens,
  escapeLike,
  sqlTokenSearch,
  textMatchesQuery,
};
