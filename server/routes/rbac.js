const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOnly, centralOnly, centralOnlyStrict } = require('../middleware/auth');
const {
  ACTIONS, RESOURCES, DEFAULT_ROLE_PERMISSIONS, getUserPermissions, fillRoleDefaults, applyLegacyGrants,
  codeRoleDefaults, getRoleOverrides, saveRoleOverrides,
} = require('../lib/rbac');

router.get('/matrix/:userId', auth, adminOnly, (req, res) => {
  const db = getDB();
  const user = db.prepare('SELECT id, role FROM users WHERE id=?').get(req.params.userId);
  if (!user) return res.status(404).json({ error: 'کاربر یافت نشد' });
  res.json({
    resources: RESOURCES, actions: ACTIONS, role: user.role,
    permissions: getUserPermissions(db, user.id, user.role),
    role_defaults: fillRoleDefaults(user.role, db),
  });
});

router.put('/matrix/:userId', auth, adminOnly, centralOnly, (req, res) => {
  const db = getDB();
  const user = db.prepare('SELECT id, role FROM users WHERE id=?').get(req.params.userId);
  if (!user) return res.status(404).json({ error: 'کاربر یافت نشد' });
  const { permissions } = req.body;
  if (!permissions || typeof permissions !== 'object') return res.status(400).json({ error: 'permissions الزامی است' });
  const del = db.prepare('DELETE FROM user_permissions WHERE user_id=?');
  const ins = db.prepare('INSERT INTO user_permissions (user_id, resource, action, allowed) VALUES (?,?,?,?)');
  const defaults = fillRoleDefaults(user.role, db);
  db.transaction(() => {
    del.run(user.id);
    for (const resource of RESOURCES) {
      const row = permissions[resource] || {};
      const def = defaults[resource] || {};
      for (const action of ACTIONS) {
        if (row[action] !== undefined && row[action] !== def[action]) {
          ins.run(user.id, resource, action, row[action] ? 1 : 0);
        }
      }
    }
  })();
  audit(req.user.id, 'update', 'user_permissions', user.id, `به‌روزرسانی دسترسی‌های کاربر #${user.id}`);
  res.json({ ok: true, permissions: getUserPermissions(db, user.id, user.role) });
});

// v522 role-level defaults (settings.role_permission_defaults); per-user rows still override.
router.get('/role-defaults/:role', auth, adminOnly, (req, res) => {
  const role = String(req.params.role || '');
  if (!DEFAULT_ROLE_PERMISSIONS[role]) return res.status(404).json({ error: 'نقش یافت نشد' });
  const db = getDB();
  res.json({
    role, resources: RESOURCES, actions: ACTIONS,
    code_defaults: codeRoleDefaults(role),
    overrides: getRoleOverrides(db)[role] || {},
    permissions: fillRoleDefaults(role, db),
  });
});

router.put('/role-defaults/:role', auth, adminOnly, centralOnlyStrict, (req, res) => {
  const role = String(req.params.role || '');
  if (!DEFAULT_ROLE_PERMISSIONS[role]) return res.status(404).json({ error: 'نقش یافت نشد' });
  if (role === 'admin') return res.status(400).json({ error: 'مدیر سیستم همیشه همهٔ دسترسی‌ها را دارد', code: 'E_ROLE_ADMIN' });
  const { permissions } = req.body || {};
  if (!permissions || typeof permissions !== 'object') return res.status(400).json({ error: 'permissions الزامی است' });
  const db = getDB();
  const code = codeRoleDefaults(role);
  const diff = {};
  for (const resource of RESOURCES) {
    const row = permissions[resource] || {};
    for (const action of ACTIONS) {
      if (row[action] === undefined || !!row[action] === !!(code[resource] || {})[action]) continue;
      if (!diff[resource]) diff[resource] = {};
      diff[resource][action] = !!row[action];
    }
  }
  const all = { ...getRoleOverrides(db), [role]: diff };
  db.transaction(() => saveRoleOverrides(db, all))();
  audit(req.user.id, 'update', 'role_permission_defaults', null, `به‌روزرسانی پیش‌فرض دسترسی نقش ${role}`);
  res.json({ ok: true, role, overrides: diff, permissions: fillRoleDefaults(role, db) });
});

router.get('/me', auth, (req, res) => {
  const db = getDB();
  res.json(applyLegacyGrants(getUserPermissions(db, req.user.id, req.user.role)));
});

module.exports = router;
