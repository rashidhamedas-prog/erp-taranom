const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getDB, isDevice } = require('../db');
const {
  SECRET,
  verifyStaffToken,
  validateStaffSession,
  revokeAllStaffSessions,
  revokeCurrentStaffSession,
} = require('../lib/auth-sessions');

// Kept as a compatibility hook for callers that used to clear the 30-second
// cache. Security-sensitive user state is now read on every request.
function invalidateUserCache() {}

function currentUser(db, id) {
  return db.prepare(`
    SELECT id,username,name,role,phone,active,must_change_password,auth_epoch,branch_id
    FROM users WHERE id=?
  `).get(Number(id));
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

    if (user.must_change_password && !isDevice()) {
      const requestPath = (req.originalUrl || '').split('?')[0];
      if (!MUST_CHANGE_ALLOWED.includes(requestPath)) {
        return res.status(403).json({
          error: 'برای ادامه باید ابتدا رمز عبور خود را تغییر دهید',
          code: 'must_change_password',
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

function adminOrAccounting(req, res, next) {
  if (req.user?.role !== 'admin' && req.user?.role !== 'accounting') {
    return res.status(403).json({ error: 'دسترسی ندارید' });
  }
  next();
}

function repModuleAdmin(req, res, next) {
  if (!['admin', 'accounting', 'sales_manager'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'دسترسی ندارید' });
  }
  next();
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
  managerOnly,
  invalidateUserCache,
  revokeUserSessions,
  revokeCurrentSession,
  SECRET,
};
