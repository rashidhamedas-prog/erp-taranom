'use strict';

const DOC_TYPES = new Set([
  'manual',
  'opening',
  'افتتاحیه',
  'opening_balance',
  'مانده اول دوره',
  'beginning_inventory',
  'موجودی اول دوره',
  'fiscal_opening',
]);

const TEMPLATE_LINE_KEYS = [
  'code', 'person_id', 'party_id', 'target_type', 'debit', 'credit', 'description',
  'detail_account_id', 'cost_center_id', 'project_id', 'tax_type', 'tafsili2_code',
];

function parseVoucherAmount(raw) {
  if (raw == null || raw === '') return { value: 0 };
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return { error: 'مبلغ نامعتبر است', code: 'E_AMOUNT' };
  if (n < 0) return { error: 'مبلغ منفی مجاز نیست', code: 'E_AMOUNT' };
  if (Math.abs(n - Math.round(n)) > 1e-6) return { error: 'مبلغ باید عدد صحیح ریال باشد', code: 'E_AMOUNT' };
  return { value: Math.round(n) };
}

function normalizeDocType(raw) {
  const value = String(raw || 'manual').trim();
  const key = value.toLowerCase();
  if (!DOC_TYPES.has(value) && !DOC_TYPES.has(key)) {
    return { error: 'نوع سند مجاز نیست', code: 'E_DOC_TYPE' };
  }
  return { value: DOC_TYPES.has(value) ? value : key };
}

function sanitizeTemplateLine(line) {
  const src = line && typeof line === 'object' ? line : {};
  const out = {};
  for (const key of TEMPLATE_LINE_KEYS) {
    if (src[key] != null && src[key] !== '') out[key] = src[key];
  }
  return out;
}

function nextNumericCode(existing, prefix) {
  let max = 0;
  const re = new RegExp('^' + prefix + '(\\d+)$');
  for (const code of existing || []) {
    const m = String(code || '').match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10) || 0);
  }
  return prefix + String(max + 1).padStart(3, '0');
}

function coaStructureLocked(row, body, movementCount) {
  if (!row || !(movementCount > 0)) return null;
  if (body && body.type && body.type !== row.type) {
    return { error: 'حساب دارای گردش است؛ نوع آن عوض نمی‌شود', code: 'E_COA_TYPE_LOCKED' };
  }
  if (body && Object.prototype.hasOwnProperty.call(body, 'parent_code')) {
    const next = body.parent_code || null;
    const prev = row.parent_code || null;
    if (String(next || '') !== String(prev || '')) {
      return { error: 'حساب دارای گردش است؛ والد آن عوض نمی‌شود', code: 'E_COA_PARENT_LOCKED' };
    }
  }
  return null;
}

module.exports = {
  DOC_TYPES,
  TEMPLATE_LINE_KEYS,
  parseVoucherAmount,
  normalizeDocType,
  sanitizeTemplateLine,
  nextNumericCode,
  coaStructureLocked,
};
