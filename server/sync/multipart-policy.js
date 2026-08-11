'use strict';

const RULES = Object.freeze([
  { name: 'product-create-image', method: 'POST', path: /^\/api\/products$/, fields: ['image'], profile: 'image', roles: ['admin', 'accounting'] },
  { name: 'product-update-image', method: 'PUT', path: /^\/api\/products\/\d+$/, fields: ['image'], profile: 'image', roles: ['admin', 'accounting'] },
  { name: 'product-add-image', method: 'POST', path: /^\/api\/products\/\d+\/images$/, fields: ['image', 'images'], profile: 'image', roles: ['admin', 'accounting'] },
  { name: 'voucher-attachment', method: 'POST', path: /^\/api\/accounting\/vouchers\/\d+\/attachment$/, fields: ['file'], profile: 'document', roles: ['admin', 'accounting'] },
  { name: 'invoice-cancel-image', method: 'POST', path: /^\/api\/accounting\/invoices\/\d+\/cancel$/, fields: ['image'], profile: 'messageImage', roles: ['admin', 'accounting'] },
  { name: 'invoice-rubika-image', method: 'POST', path: /^\/api\/accounting\/invoices\/\d+\/rubika$/, fields: ['image'], profile: 'messageImage', roles: ['admin', 'accounting'] },
  { name: 'rep-payment-receipt', method: 'POST', path: /^\/api\/reps\/payments$/, fields: ['receipt'], profile: 'messageImage', roles: ['field_sales'] },
  { name: 'rep-expense-create', method: 'POST', path: /^\/api\/reps\/\d+\/expenses$/, fields: ['receipt'], profile: 'messageImage', roles: ['admin', 'accounting', 'sales_manager', 'field_sales', 'inside_sales'] },
  { name: 'rep-expense-receipt', method: 'POST', path: /^\/api\/reps\/\d+\/expenses\/\d+\/receipt$/, fields: ['file'], profile: 'messageImage', roles: ['admin', 'accounting', 'sales_manager', 'field_sales', 'inside_sales'] },
  { name: 'rep-contract', method: 'POST', path: /^\/api\/reps\/\d+\/contract$/, fields: ['file'], profile: 'document', roles: ['admin', 'accounting'] },
  { name: 'rep-visit-photo', method: 'POST', path: /^\/api\/reps\/\d+\/visits$/, fields: ['photo', 'signature'], profile: 'messageImage', roles: ['admin', 'accounting', 'sales_manager', 'field_sales', 'inside_sales'] },
]);

class MultipartRelayError extends Error {
  constructor(message, code = 'SYNC_MULTIPART_REJECTED') {
    super(message);
    this.name = 'MultipartRelayError';
    this.code = code;
    this.status = 400;
  }
}

function strictControlValue(value, name) {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new MultipartRelayError(`${name} نامعتبر است`, `SYNC_BAD_${name.toUpperCase()}`);
  }
  return value;
}

function validateRelayPath(value) {
  const path = strictControlValue(value, 'path');
  if (!path.startsWith('/api/') || path.includes('%') || path.includes('\\') || path.includes('//')
      || path.includes('..') || path.includes('?') || path.includes('#') || !/^\/[A-Za-z0-9/_-]+$/.test(path)) {
    throw new MultipartRelayError('مسیر بازپخش فایل مجاز نیست', 'SYNC_MULTIPART_PATH_REJECTED');
  }
  return path;
}

function validateRelayUserId(value) {
  const raw = strictControlValue(value, 'user_id');
  if (!/^[1-9]\d{0,14}$/.test(raw)) throw new MultipartRelayError('شناسه کاربر بازپخش معتبر نیست', 'SYNC_MULTIPART_USER_REJECTED');
  const id = Number(raw);
  if (!Number.isSafeInteger(id)) throw new MultipartRelayError('شناسه کاربر بازپخش معتبر نیست', 'SYNC_MULTIPART_USER_REJECTED');
  return id;
}

function matchMultipartRelay({ path: rawPath, method: rawMethod, field: rawField, userId, userRole }) {
  const path = validateRelayPath(rawPath);
  const method = strictControlValue(rawMethod, 'method');
  const field = strictControlValue(rawField, 'field');
  if (!['POST', 'PUT'].includes(method) || method !== method.toUpperCase()) {
    throw new MultipartRelayError('روش بازپخش فایل مجاز نیست', 'SYNC_MULTIPART_METHOD_REJECTED');
  }
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new MultipartRelayError('شناسه کاربر بازپخش معتبر نیست', 'SYNC_MULTIPART_USER_REJECTED');
  }
  const rule = RULES.find((candidate) => candidate.method === method
    && candidate.path.test(path) && candidate.fields.includes(field));
  if (!rule) throw new MultipartRelayError('ترکیب مسیر، روش و فیلد فایل در allowlist نیست', 'SYNC_MULTIPART_RULE_REJECTED');
  if (!rule.roles.includes(String(userRole || ''))) {
    throw new MultipartRelayError('نقش کاربر برای این بازپخش فایل مجاز نیست', 'SYNC_MULTIPART_ROLE_REJECTED');
  }
  return { ...rule, path, method, field, userId };
}

function selectClientRelayField(rawPath, rawMethod) {
  const path = validateRelayPath(rawPath);
  const method = strictControlValue(rawMethod, 'method');
  const candidates = RULES.filter((rule) => rule.method === method && rule.path.test(path));
  if (candidates.length !== 1) {
    throw new MultipartRelayError('عملیات فایل محلی در allowlist بازپخش نیست یا فیلد آن مبهم است', 'SYNC_MULTIPART_CLIENT_RULE_REJECTED');
  }
  const rule = candidates[0];
  if (rule.fields.length !== 1) {
    throw new MultipartRelayError('بازپخش چندفیلدی باید به عملیات مستقل تبدیل شود', 'SYNC_MULTIPART_AMBIGUOUS_FIELD');
  }
  return { field: rule.fields[0], profile: rule.profile, name: rule.name };
}

module.exports = {
  RULES,
  MultipartRelayError,
  validateRelayPath,
  validateRelayUserId,
  matchMultipartRelay,
  selectClientRelayField,
};
