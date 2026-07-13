const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOnly, centralOnly } = require('../middleware/auth');
const { ACTIONS, RESOURCES, getUserPermissions, fillRoleDefaults } = require('../lib/rbac');

router.get('/matrix/:userId', auth, adminOnly, (req, res) => {
  const db = getDB();
  const user = db.prepare('SELECT id, role FROM users WHERE id=?').get(req.params.userId);
  if (!user) return res.status(404).json({ error: 'کاربر یافت نشد' });
  res.json({ resources: RESOURCES, actions: ACTIONS, permissions: getUserPermissions(db, user.id, user.role) });
});

router.put('/matrix/:userId', auth, adminOnly, centralOnly, (req, res) => {
  const db = getDB();
  const user = db.prepare('SELECT id, role FROM users WHERE id=?').get(req.params.userId);
  if (!user) return res.status(404).json({ error: 'کاربر یافت نشد' });
  const { permissions } = req.body;
  if (!permissions || typeof permissions !== 'object') return res.status(400).json({ error: 'permissions الزامی است' });
  const del = db.prepare('DELETE FROM user_permissions WHERE user_id=?');
  const ins = db.prepare('INSERT INTO user_permissions (user_id, resource, action, allowed) VALUES (?,?,?,?)');
  const defaults = fillRoleDefaults(user.role);
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

router.get('/me', auth, (req, res) => {
  const db = getDB();
  res.json(getUserPermissions(db, req.user.id, req.user.role));
});

module.exports = router;
