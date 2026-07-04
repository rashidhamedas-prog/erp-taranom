const jwt = require('jsonwebtoken');
const { getDB } = require('../db');
const SECRET = process.env.JWT_SECRET || 'taranom-crm-secret-2024';

// Core authentication + mandatory tenant resolution.
// Every authenticated request gets req.tenantId — repositories/routes MUST filter by it.
function auth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'توکن یافت نشد' });
  try {
    const payload = jwt.verify(token, SECRET);
    if (payload.scope && payload.scope !== 'internal') {
      // B2B portal tokens are NOT valid on internal endpoints
      return res.status(401).json({ error: 'توکن نامعتبر' });
    }
    // Verify the account is still active on every request (blocks deactivated users immediately)
    const user = getDB().prepare('SELECT active, tenant_id, role FROM users WHERE id=?').get(payload.id);
    if (!user || !user.active) return res.status(401).json({ error: 'حساب کاربری غیرفعال است' });
    // Tenant must be active (platform owner has tenant_id=0 and no tenant row)
    if (user.role !== 'platform_owner') {
      const tenant = getDB().prepare('SELECT status FROM tenants WHERE id=?').get(user.tenant_id);
      if (!tenant || tenant.status !== 'active') {
        return res.status(403).json({ error: 'حساب کسب‌وکار شما غیرفعال است. با پشتیبانی تماس بگیرید.' });
      }
    }
    req.user = payload;
    req.user.role = user.role; // role changes take effect immediately, not at next login
    req.tenantId = user.tenant_id;
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

// Warehouse module: admin, accounting (cost view), and warehouse manager
function warehouseAccess(req, res, next) {
  if (!['admin', 'accounting', 'warehouse_manager'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'دسترسی ندارید' });
  }
  next();
}

// Warehouse managers have no access to customers/sales/financial modules (spec: بدون دسترسی مالی/مشتریان)
function noWarehouseManager(req, res, next) {
  if (req.user?.role === 'warehouse_manager') {
    return res.status(403).json({ error: 'دسترسی ندارید' });
  }
  next();
}

// Platform owner only (tenant management)
function platformOnly(req, res, next) {
  if (req.user?.role !== 'platform_owner') return res.status(403).json({ error: 'دسترسی ندارید' });
  next();
}

module.exports = { auth, adminOnly, adminOrAccounting, warehouseAccess, noWarehouseManager, platformOnly, SECRET };
