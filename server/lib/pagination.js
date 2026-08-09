'use strict';

/**
 * Shared list-query pagination for CRM entity GET handlers.
 * Style aligned with parties.js (page + limit) but normalized to pageSize.
 */

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const RESERVED_QUERY_KEYS = new Set([
  'page',
  'pageSize',
  'page_size',
  'limit',
  'offset',
  'sort',
  'total',
]);

function toPositiveInt(value, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

/**
 * Parse Express req.query (or plain object) into pagination + leftover filters.
 * @param {object} query
 * @param {{ defaultPageSize?: number, maxPageSize?: number, filterKeys?: string[] }} [opts]
 * @returns {{ page: number, pageSize: number, offset: number, sort: string|null, filters: object, includeTotal: boolean }}
 */
function parseListQuery(query = {}, opts = {}) {
  const defaultPageSize = opts.defaultPageSize || DEFAULT_PAGE_SIZE;
  const maxPageSize = opts.maxPageSize || MAX_PAGE_SIZE;

  const page = toPositiveInt(query.page, DEFAULT_PAGE);
  const rawSize = query.pageSize != null ? query.pageSize
    : (query.page_size != null ? query.page_size
      : (query.limit != null ? query.limit : defaultPageSize));
  let pageSize = toPositiveInt(rawSize, defaultPageSize);
  if (pageSize > maxPageSize) pageSize = maxPageSize;

  const offset = (page - 1) * pageSize;
  const sort = query.sort != null && String(query.sort).trim() !== ''
    ? String(query.sort).trim()
    : null;

  const filters = {};
  if (query.filters != null) {
    if (typeof query.filters === 'string' && query.filters.trim()) {
      try {
        const parsed = JSON.parse(query.filters);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          Object.assign(filters, parsed);
        }
      } catch (_) { /* ignore bad JSON */ }
    } else if (typeof query.filters === 'object' && !Array.isArray(query.filters)) {
      Object.assign(filters, query.filters);
    }
  }
  if (Array.isArray(opts.filterKeys) && opts.filterKeys.length) {
    for (const key of opts.filterKeys) {
      if (query[key] !== undefined && query[key] !== '') filters[key] = query[key];
    }
  } else {
    for (const [key, value] of Object.entries(query || {})) {
      if (RESERVED_QUERY_KEYS.has(key) || key === 'filters') continue;
      if (value === undefined || value === '') continue;
      filters[key] = value;
    }
  }

  // total=0|false|no → skip COUNT when callers honor includeTotal
  const totalRaw = query.total;
  const includeTotal = !(
    totalRaw === 0 || totalRaw === '0' ||
    totalRaw === false || totalRaw === 'false' ||
    totalRaw === 'no'
  );

  return { page, pageSize, offset, sort, filters, includeTotal };
}

/**
 * Wrap a list payload in the standard paginated envelope.
 * @param {any[]} data
 * @param {{ page: number, pageSize: number, total: number }} pagination
 */
function wrapListResponse(data, pagination) {
  const page = toPositiveInt(pagination && pagination.page, DEFAULT_PAGE);
  const pageSize = toPositiveInt(pagination && pagination.pageSize, DEFAULT_PAGE_SIZE);
  const total = Number.isFinite(Number(pagination && pagination.total))
    ? Math.max(0, Math.floor(Number(pagination.total)))
    : (Array.isArray(data) ? data.length : 0);
  return {
    success: true,
    data: Array.isArray(data) ? data : [],
    pagination: { page, pageSize, total },
  };
}

/** SQL fragment helpers for prepared statements. */
function sqlLimitOffset(pageSize, offset) {
  return { sql: ' LIMIT ? OFFSET ?', params: [pageSize, offset] };
}

function wantsPaginatedEnvelope(query = {}) {
  return query.page != null
    || query.pageSize != null
    || query.page_size != null
    || query.limit != null
    || query.paginated === '1'
    || query.paginated === 'true';
}

/**
 * Prefer envelope when client opts into pagination params; otherwise return raw array
 * for legacy UI/sync harness compatibility (still apply LIMIT/OFFSET internally).
 */
function listResponse(data, pagination, query = {}) {
  if (wantsPaginatedEnvelope(query)) return wrapListResponse(data, pagination);
  return Array.isArray(data) ? data : [];
}

module.exports = {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  parseListQuery,
  wrapListResponse,
  paginatedJson: wrapListResponse,
  wantsPaginatedEnvelope,
  listResponse,
  sqlLimitOffset,
};
