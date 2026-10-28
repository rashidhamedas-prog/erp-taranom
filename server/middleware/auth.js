const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getDB, isDevice, audit } = require('../db');
const {
  SECRET,
  verifyStaffToken,
  validateStaffSession,
  revokeAllStaffSessions,
  revokeCurrentStaffSession,
} = require('../lib/auth-sessions');
const { roleRequiresTwofa } = require('../lib/staff-security');

// Kept as a compatibility hook for callers that used to clear the 30-second
// cache. Security-sensitive user state is now read on every request.
function invalidateUserCache() {}

function currentUser(db, id) {
  try {
    return db.prepare(`
    SELECT id,username,name,role,phone,active,must_change_password,auth_epoch,branch_id
    FROM users WHERE id=?
  `).get(Number(id));
  } catch (error) {
    if (!/no such column: branch_id/i.test(String(error && error.message))) throw error;
    return db.prepare(`
    SELECT id,username,name,role,phone,active,must_change_password,auth_epoch
    FROM users WHERE id=?
  `).get(Number(id));
  }
}

function exactBearer(req) {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match ? match[1] : '';
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function isTrustedInternalReplay(req) {
  const supplied = req.headers['x-internal-replay'];
  const expected = req.app && req.app.get('internalReplayToken');
  return safeEqual(supplied, expected);
}

function revokeUserSessions(db, userId, { bumpEpoch = true } = {}) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('invalid user id');
  // Revoke the global store first. If the business DB update fails, the safe
  // failure mode is an extra login prompt, never a still-valid remote token.
  revokeAllStaffSessions(id);
  db.transaction(() => {
    if (bumpEpoch) {
      db.prepare('UPDATE users SET auth_epoch=COALESCE(auth_epoch,0)+1 WHERE id=?').run(id);
    }
    db.prepare('DELETE FROM user_device_sessions WHERE user_id=?').run(id);
  })();
  invalidateUserCache(id);
}

// While a forced password change is pending, only these endpoints stay usable.
const MUST_CHANGE_ALLOWED = ['/api/auth/change-password', '/api/auth/me', '/api/auth/logout'];
const TWOFA_SETUP_ALLOWED = [
  '/api/auth/change-password', '/api/auth/me', '/api/auth/logout',
  '/api/auth/2fa/status', '/api/auth/2fa/setup', '/api/auth/2fa/verify',
];

function impersonationForbidden(req, pathName) {
  if (!req.user || !req.user.impersonator) return false;
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  if (pathName === '/api/auth/impersonate/stop' || pathName === '/api/auth/logout') return false;
  if (pathName === '/api/auth/change-password'
      || pathName === '/api/auth/logout-all'
      || pathName === '/api/auth/reset-password'
      || pathName === '/api/auth/forgot'
      || pathName === '/api/auth/forgot-reset'
      || pathName === '/api/auth/impersonate') return true;
  if (pathName.startsWith('/api/auth/2fa')) return true;
  if (pathName.startsWith('/api/auth/device-sessions')) return true;
  if (pathName.startsWith('/api/admin/users')) return true;
  if (pathName.startsWith('/api/admin/backup')) return true;
  if (pathName.startsWith('/api/companies')) return true;
  if (pathName.startsWith('/api/users')) return true;
  return false;
}

function auth(req, res, next) {
  const token = exactBearer(req);
  if (!token) return res.status(401).json({ error: 'توکن یافت نشد' });
  try {
    const db = getDB();
    let payload;

    // Sync replay tokens are short-lived and are accepted only together with
    // the unguessable per-process loopback header. Public callers cannot set a
    // valid header and therefore must always present a server-side session id.
    if (isTrustedInternalReplay(req)) {
      payload = jwt.verify(token, SECRET);
      if (payload.scope) throw new Error('scoped token');
    } else {
      payload = verifyStaffToken(token);
      if (payload.scope || !validateStaffSession(payload)) throw new Error('invalid session');
    }

    const user = currentUser(db, payload.id);
    if (!user || !user.active) return res.status(401).json({ error: 'حساب کاربری غیرفعال است' });
    if (Number(payload.ae || 0) !== Number(user.auth_epoch || 0)) {
      return res.status(401).json({ error: 'نشست کاربری باطل شده است' });
    }

    // Never authorize from stale role/name claims. The current database row is
    // authoritative on every request; sid is retained for logout/revocation.
    req.user = {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      phone: user.phone || '',
      branch_id: user.branch_id != null ? Number(user.branch_id) : null,
      ae: Number(user.auth_epoch || 0),
      sid: payload.sid,
      dslot: payload.dslot,
    };

    if (payload.act || payload.dslot === 'impersonation') {
      const act = payload.act;
      const actor = act && act.id ? currentUser(db, act.id) : null;
      if (!actor || !actor.active || actor.role !== 'admin'
          || Number(act.ae) !== Number(actor.auth_epoch || 0)) {
        return res.status(401).json({ error: 'نشست ورود مدیر باطل شده است' });
      }
      req.user.impersonator = { id: actor.id, username: actor.username, name: actor.name };
    }

    const requestPath = (req.originalUrl || '').split('?')[0];
    if (impersonationForbidden(req, requestPath)) {
      audit(req.user.impersonator.id, 'impersonate_denied', 'user', req.user.id,
        `${req.method} ${requestPath} در ورود به حساب ${req.user.username} بسته شد`, req);
      return res.status(403).json({
        error: 'در ورود به حساب کاربر، این کار بسته است تا نشست او قطع نشود',
        code: 'IMPERSONATION_FORBIDDEN',
      });
    }
    if (req.user.impersonator && !['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || 'GET').toUpperCase())
        && requestPath !== '/api/auth/impersonate' && requestPath !== '/api/auth/impersonate/stop') {
      res.on('finish', () => {
        if (res.statusCode >= 400) return;
        audit(req.user.impersonator.id, 'impersonated_write', 'user', req.user.id,
          `${req.method} ${requestPath} به‌جای ${req.user.username}`, req);
      });
    }
    if (req.user.impersonator) {
      return next();
    }
    if (user.must_change_password && !isDevice()) {
      if (!MUST_CHANGE_ALLOWED.includes(requestPath)) {
        return res.status(403).json({
          error: 'برای ادامه باید ابتدا رمز عبور خود را تغییر دهید',
          code: 'must_change_password',
        });
      }
    } else if (!isDevice() && roleRequiresTwofa(db, user.role)) {
      let enrolled = false;
      try {
        const tfa = db.prepare('SELECT enabled FROM two_factor_auth WHERE user_id=?').get(user.id);
        enrolled = !!(tfa && tfa.enabled);
      } catch { enrolled = true; }
      if (!enrolled && !TWOFA_SETUP_ALLOWED.includes(requestPath)) {
        return res.status(403).json({
          error: 'برای این نقش، ورود دو مرحله‌ای اجباری است. ابتدا آن را فعال کنید.',
          code: 'twofa_setup_required',
        });
      }
    }
  } catch {
    return res.status(401).json({ error: 'توکن یا نشست نامعتبر است' });
  }
  return next();
}

function revokeCurrentSession(req) {
  return revokeCurrentStaffSession(req.user || {});
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'دسترسی ندارید' });
  next();
}

function requestPath(req) {
  const raw = String(req.originalUrl || req.url || '').split('?')[0];
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/**
 * Non-admin, non-accounting users pass a role gate only for an accounting
 * section they were explicitly granted. Unmapped paths stay closed.
 */
function delegatedAccountingAllowed(req) {
  if (!req.user || req.user.role === 'admin' || req.user.role === 'accounting') return false;
  const { matchAccAccess, accessHitAllows } = require('../lib/accounting-access');
  const { getUserPermissions } = require('../lib/rbac');
  const hits = matchAccAccess(requestPath(req));
  if (!hits.length) return false;
  const perms = getUserPermissions(getDB(), req.user.id, req.user.role);
  const path = requestPath(req);
  return hits.some((hit) => accessHitAllows(hit, perms[hit.resource], req.method, path));
}

function adminOrAccounting(req, res, next) {
  if (req.user?.role === 'admin' || req.user?.role === 'accounting') return next();
  if (delegatedAccountingAllowed(req)) return next();
  return res.status(403).json({ error: 'دسترسی ندارید' });
}

function repModuleAdmin(req, res, next) {
  if (req.user && ['admin', 'accounting', 'sales_manager'].includes(req.user.role)) return next();
  if (delegatedAccountingAllowed(req)) return next();
  return res.status(403).json({ error: 'دسترسی ندارید' });
}

function isDesktopPlatform() {
  return process.env.APP_PLATFORM === 'desktop';
}

function centralOnly(req, res, next) {
  if (isDevice() && !isDesktopPlatform()) {
    return res.status(403).json({ error: 'این عملیات فقط روی سرور مرکزی یا نسخه دسکتاپ امکان‌پذیر است' });
  }
  next();
}

function centralOnlyStrict(req, res, next) {
  if (isDevice()) {
    return res.status(403).json({ error: 'این عملیات فقط روی سرور مرکزی امکان‌پذیر است' });
  }
  next();
}

function requirePermission(resource, action) {
  const { hasPermission } = require('../lib/rbac');
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'توکن یافت نشد' });
    if (hasPermission(getDB(), req.user, resource, action)) return next();
    return res.status(403).json({ error: 'دسترسی ندارید' });
  };
}

/**
 * Warehouse Phase 2 — acc_warehouse_ops per-action gate.
 * action: 'view' | 'create' | 'delete' (= void) | 'negative' (or an array = ALL required).
 * admin always passes; accounting passes through its role defaults (all flags) unless an
 * admin explicitly revoked them (role override / per-user deny).
 * opts.orDelegatedAccounting: on pass-fail fall back to adminOrAccounting (keeps delegates of the
 * sibling sections acc_warehouses / acc_stocktaking working on routes they already reached;
 * those sections never map to acc_warehouse_ops flags, so a create-only storekeeper gains nothing).
 */
function requireWarehouseOps(action, opts = {}) {
  const actions = Array.isArray(action) ? action : [action];
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'توکن یافت نشد' });
    const { hasPermission } = require('../lib/rbac');
    const db = getDB();
    if (actions.every((a) => hasPermission(db, req.user, 'acc_warehouse_ops', a))) return next();
    if (opts.orDelegatedAccounting) return adminOrAccounting(req, res, next);
    return res.status(403).json({
      error: 'دسترسی ندارید',
      code: 'E_PERMISSION',
      resource: 'acc_warehouse_ops',
      action: actions.join('+'),
    });
  };
}

/**
 * Phase 3C — cheque.operate. Admin/accounting always pass (no break).
 * Delegated users need resource `cheque` action `operate` (or create).
 */
function requireChequeOperate(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'توکن یافت نشد' });
  if (req.user.role === 'admin' || req.user.role === 'accounting') return next();
  const { hasPermission } = require('../lib/rbac');
  const db = getDB();
  if (hasPermission(db, req.user, 'cheque', 'operate')
      || hasPermission(db, req.user, 'cheque', 'create')) {
    return next();
  }
  return res.status(403).json({
    error: 'مجوز عملیات چک (cheque.operate) لازم است',
    code: 'E_CHEQUE_OPERATE',
  });
}

function chequeApproveThresholdRial(db) {
  try {
    const row = db.prepare(
      "SELECT value FROM settings WHERE key='cheque_approve_threshold_rial'"
    ).get();
    const n = Number(row && row.value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (_) {
    return 0;
  }
}

function chequeAmountFromReq(req, db) {
  if (req.body && req.body.amount != null) {
    const a = Number(req.body.amount);
    if (Number.isFinite(a) && a > 0) return a;
  }
  const ids = [];
  if (req.params && req.params.id) ids.push(Number(req.params.id));
  if (req.body && Array.isArray(req.body.ids)) {
    for (const id of req.body.ids) ids.push(Number(id));
  }
  let maxAmt = 0;
  for (const id of ids) {
    if (!Number.isFinite(id) || id <= 0) continue;
    const row = db.prepare('SELECT amount FROM cheque_records WHERE id=?').get(id);
    const a = Number(row && row.amount) || 0;
    if (a > maxAmt) maxAmt = a;
  }
  return maxAmt;
}

/**
 * Phase 3C — high-value clear/bounce/void needs cheque.approve above settings threshold.
 * Admin/accounting always pass. Threshold 0 / unset = no second gate.
 */
function requireChequeHighValueApprove(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'توکن یافت نشد' });
  if (req.user.role === 'admin' || req.user.role === 'accounting') return next();
  const db = getDB();
  const threshold = chequeApproveThresholdRial(db);
  if (!threshold) return next();
  const amount = chequeAmountFromReq(req, db);
  if (amount <= threshold) return next();
  const { hasPermission } = require('../lib/rbac');
  if (hasPermission(db, req.user, 'cheque', 'approve')) return next();
  return res.status(403).json({
    error: `این عملیات بالای سقف تأیید (${threshold.toLocaleString('fa-IR')} ریال) است و نیاز به مجوز cheque.approve دارد`,
    code: 'E_CHEQUE_APPROVE_REQUIRED',
    threshold_rial: threshold,
    amount_rial: amount,
  });
}

function managerOnly(req, res, next) {
  if (!req.user || !['admin', 'sales_manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'دسترسی ندارید — فقط مدیر' });
  }
  next();
}

module.exports = {
  auth,
  adminOnly,
  adminOrAccounting,
  repModuleAdmin,
  centralOnly,
  centralOnlyStrict,
  isDesktopPlatform,
  requirePermission,
  requireWarehouseOps,
  requireChequeOperate,
  requireChequeHighValueApprove,
  managerOnly,
  invalidateUserCache,
  revokeUserSessions,
  revokeCurrentSession,
  SECRET,
};
