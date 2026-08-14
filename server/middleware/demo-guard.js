'use strict';

const { getDemoState, refreshMaintenanceFlag, isDemoMode } = require('../lib/demo-mode');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const BLOCKED_PREFIXES = [
  '/api/admin/backup-restore',
  '/api/admin/backup-now',
  '/api/settings/test-sms',
  '/api/license/activate',
  '/api/license/deactivate',
  '/api/sync/pair',
  '/api/sync/pair-device',
  '/api/sync/update-central-url',
  '/api/sync/reset-pairing',
  '/api/sync/factory-reset-device',
  '/api/sync/devices',
  '/api/ai/refresh',
  '/api/ai/generate',
  '/api/demo/config',
];

const BLOCKED_EXACT = new Set([
  '/api/settings',
  '/api/settings/',
]);

const BLOCKED_METHODS = {
  '/api/admin/users': new Set(['POST']),
};

const EXPIRED_EXEMPT = [
  '/api/auth',
  '/api/demo/status',
  '/api/system/health',
  '/api/system/ready',
  '/api/system/time',
  '/api/system/app-info',
];

function normPath(req) {
  return String(req.originalUrl || req.url || '').split('?')[0];
}

function startsWithAny(p, prefixes) {
  return prefixes.some((pre) => p === pre || p.startsWith(pre + '/') || p.startsWith(pre));
}

function isExpiredExempt(p) {
  return EXPIRED_EXEMPT.some((pre) => p === pre || p.startsWith(pre + '/'));
}

function deny(req, res, reason) {
  try {
    const { audit } = require('../db');
    const uid = req.user && req.user.id ? req.user.id : null;
    audit(uid, 'demo_operation_blocked', 'demo', null, reason);
  } catch { /* audit must never throw */ }
  return res.status(403).json({
    error: 'این عملیات در نسخه نمایشی مجاز نیست',
    code: 'demo_operation_blocked',
    reason,
  });
}

function inspectBodyForBlockedSettings(body) {
  if (!body || typeof body !== 'object') return null;
  const keys = Object.keys(body);
  const secretish = [
    'telegram_bot_token', 'sms_api_key', 'niksms_api_key', 'smsir_api_key',
    'webhook_secret', 'backup_smtp_pass', 'backup_password', 'ai_api_key',
    'website_wc_key', 'website_wc_secret', 'rubika_bot_token',
    'smtp_pass', 'smtp_host', 'license_public_key', 'backup_encryption',
    'allowed_origins', 'cors',
  ];
  for (const k of keys) {
    if (secretish.includes(k)) return k;
  }
  return null;
}

function demoGuard(req, res, next) {
  if (!isDemoMode()) return next();
  const state = refreshMaintenanceFlag();
  const p = normPath(req);
  const method = String(req.method || '').toUpperCase();

  if (p === '/api/demo/status' || p === '/api/system/health') return next();

  if (state.maintenance && MUTATING.has(method) && !p.startsWith('/api/demo/operator')) {
    return deny(req, res, 'maintenance');
  }

  if (state.expired && MUTATING.has(method) && !isExpiredExempt(p)) {
    return deny(req, res, 'expired_readonly');
  }

  if (startsWithAny(p, BLOCKED_PREFIXES)) {
    return deny(req, res, 'blocked_prefix');
  }
  if (BLOCKED_EXACT.has(p) && MUTATING.has(method)) {
    return deny(req, res, 'blocked_settings');
  }
  const blockedMethods = BLOCKED_METHODS[p];
  if (blockedMethods && blockedMethods.has(method)) {
    return deny(req, res, 'blocked_user_create');
  }

  if (p.startsWith('/api/admin/users') && method === 'POST') {
    return deny(req, res, 'blocked_user_create');
  }
  if (p.startsWith('/api/admin/users') && method === 'DELETE') {
    return deny(req, res, 'blocked_user_delete');
  }
  if (p.startsWith('/api/admin/users') && (method === 'PUT' || method === 'PATCH')) {
    const role = req.body && req.body.role;
    if (role === 'admin') return deny(req, res, 'blocked_admin_role');
    const protectedNames = new Set(['demo_manager', 'demo_accountant', 'demo_sales', 'demo_production']);
    const username = req.body && req.body.username;
    if (username && protectedNames.has(String(username))) {
      return deny(req, res, 'blocked_protected_account');
    }
  }

  if ((p === '/api/settings' || p.startsWith('/api/settings/')) && MUTATING.has(method)) {
    const hit = inspectBodyForBlockedSettings(req.body);
    if (hit) return deny(req, res, 'blocked_secret_setting');
    return deny(req, res, 'blocked_settings');
  }

  if (p.startsWith('/api/license') && MUTATING.has(method)) {
    return deny(req, res, 'blocked_license');
  }

  if ((p.includes('/import') || p.endsWith('/import')) && MUTATING.has(method)) {
    return deny(req, res, 'blocked_import');
  }

  if (p.includes('data-wipe') || p.includes('factory-reset') || p.includes('wipe-all')) {
    return deny(req, res, 'blocked_destructive');
  }

  return next();
}

function redactSecretSettingsIfDemo(payload) {
  if (!isDemoMode() || !payload || typeof payload !== 'object') return payload;
  const out = { ...payload };
  for (const k of Object.keys(out)) {
    if (/token|secret|password|api_key|private/i.test(k) && typeof out[k] === 'string' && out[k]) {
      out[k] = '';
      out[`${k}_has_value`] = false;
      out[`${k}_demo_blocked`] = true;
    }
  }
  return out;
}

module.exports = {
  demoGuard,
  redactSecretSettingsIfDemo,
  BLOCKED_PREFIXES,
};
