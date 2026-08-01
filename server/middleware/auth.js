const jwt = require('jsonwebtoken');
const { getDB, isDevice } = require('../db');
const SECRET = process.env.JWT_SECRET || 'taranom-crm-secret-2024';

const _activeCache = new Map(); // userId -> { active, mustChange, t }
const ACTIVE_TTL_MS = 30000;

function getUserState(id) {
  const hit = _activeCache.get(id);
  if (hit && Date.now() - hit.t < ACTIVE_TTL_MS) return hit;
  const user = getDB().prepare('SELECT active, must_change_password, auth_epoch FROM users WHERE id=?').get(id);
  const state = {
    active: !!(user && user.active),
    mustChange: !!(user && user.must_change_password),
    authEpoch: Number(user && user.auth_epoch || 0),
    t: Date.now()
  };
  _activeCache.set(id, state);
  return state;
}

// Invalidate the cached state after password/active changes take effect immediately
function invalidateUserCache(id) { _activeCache.delete(id); }

// While a forced password change is pending, only these endpoints stay usable.
const MUST_CHANGE_ALLOWED = ['/api/auth/change-password', '/api/auth/me'];

function auth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'توکن یافت نشد' });
  try {
    const payload = jwt.verify(token, SECRET);
    // Scoped tokens (B2B portal customers, pre-2FA step) share the signing
    // secret but must never pass internal staff auth.
    if (payload.scope) return res.status(401).json({ error: 'توکن نامعتبر' });
    const state = getUserState(payload.id);
    if (!state.active) return res.status(401).json({ error: 'حساب کاربری غیرفعال است' });
    // Central web/API sessions are revocable immediately. Offline device
    // sessions cannot be invalidated safely by a pulled epoch while the user
    // is mid-operation; device access is controlled by its pairing token.
    if (!isDevice() && Number(payload.ae || 0) !== state.authEpoch) return res.status(401).json({ error: 'نشست کاربری باطل شده است' });
    // Forced password change is enforced on central only. Device builds pull
    // the users table from central, and a local change would be overwritten
    // by the next sync pull — the change must happen on central.
    if (state.mustChange && !isDevice()) {
      const p = (req.originalUrl || '').split('?')[0];
      if (!MUST_CHANGE_ALLOWED.includes(p)) {
        return res.status(403).json({
          error: 'برای ادامه باید ابتدا رمز عبور خود را تغییر دهید',
          code: 'must_change_password'
        });
      }
    }
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'توکن نامعتبر' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'دسترسی ندارید' });
  next();
}

// Accounting staff have full access to the accounting module (admin included)
function adminOrAccounting(req, res, next) {
  if (req.user?.role !== 'admin' && req.user?.role !== 'accounting') {
    return res.status(403).json({ error: 'دسترسی ندارید' });
  }
  next();
}

// Rep module admin: finance + sales managers
function repModuleAdmin(req, res, next) {
  if (!['admin', 'accounting', 'sales_manager'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'دسترسی ندارید' });
  }
  next();
}

function isDesktopPlatform() {
  return process.env.APP_PLATFORM === 'desktop';
}

// Business config that used to be central-only: desktop is a full peer;
// Android/other device builds stay blocked.
function centralOnly(req, res, next) {
  if (isDevice() && !isDesktopPlatform()) {
    return res.status(403).json({ error: 'این عملیات فقط روی سرور مرکزی یا نسخه دسکتاپ امکان‌پذیر است' });
  }
  next();
}

/** Infra/security surfaces that must never run on any device build. */
function centralOnlyStrict(req, res, next) {
  if (isDevice()) {
    return res.status(403).json({ error: 'این عملیات فقط روی سرور مرکزی امکان‌پذیر است' });
  }
  next();
}

// Granular RBAC — checks user_permissions overrides + role defaults
function requirePermission(resource, action) {
  const { getDB } = require('../db');
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
  auth, adminOnly, adminOrAccounting, repModuleAdmin,
  centralOnly, centralOnlyStrict, isDesktopPlatform,
  requirePermission, managerOnly, invalidateUserCache, SECRET
};
