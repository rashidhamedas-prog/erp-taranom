'use strict';
const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting, requirePermission } = require('../middleware/auth');
const { runHealthCheck } = require('../lib/production/health-check');
const PROD_ROLES = ['admin', 'accounting', 'production_manager', 'production_operator'];

function handle(res, fn) {
  try {
    res.json(fn());
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message,
      code: e.code || e.message,
      ...(e.extra || {}),
    });
  }
}

function listProductionUsers(db) {
  const users = db.prepare(`
    SELECT id, name, username, role, active
    FROM users
    WHERE role IN (${PROD_ROLES.map(() => '?').join(',')})
    ORDER BY name
  `).all(...PROD_ROLES);
  const counts = {};
  db.prepare('SELECT user_id, COUNT(*) c FROM user_cost_centers GROUP BY user_id').all()
    .forEach(r => { counts[r.user_id] = r.c; });
  return users.map(u => ({
    ...u,
    cc_count: counts[u.id] || 0,
    unrestricted: !(counts[u.id] > 0),
  }));
}

function getUserCostCenterPayload(db, userId) {
  const user = db.prepare('SELECT id, name, username, role, active FROM users WHERE id=?').get(userId);
  if (!user) {
    throw Object.assign(new Error('کاربر یافت نشد'), { status: 404, code: 'E_NOT_FOUND' });
  }
  const centers = db.prepare(`
    SELECT ucc.cost_center_id, ucc.can_view, ucc.can_post, cc.code, cc.name
    FROM user_cost_centers ucc
    JOIN cost_centers cc ON cc.id = ucc.cost_center_id
    WHERE ucc.user_id=?
    ORDER BY cc.seq, cc.code
  `).all(userId);
  const all_cost_centers = db.prepare(`
    SELECT id, code, name, seq
    FROM cost_centers
    WHERE COALESCE(active, 1) = 1
    ORDER BY COALESCE(seq, 0), code
  `).all();
  return {
    user,
    centers,
    all_cost_centers,
    unrestricted: centers.length === 0,
  };
}

function setUserCostCenters(db, userId, centers, actorId) {
  const user = db.prepare('SELECT id, name FROM users WHERE id=?').get(userId);
  if (!user) {
    throw Object.assign(new Error('کاربر یافت نشد'), { status: 404, code: 'E_NOT_FOUND' });
  }
  const list = Array.isArray(centers) ? centers : [];
  db.transaction(() => {
    db.prepare('DELETE FROM user_cost_centers WHERE user_id=?').run(userId);
    const ins = db.prepare(`
      INSERT INTO user_cost_centers (user_id, cost_center_id, can_view, can_post)
      VALUES (?,?,?,?)
    `);
    for (const c of list) {
      const ccId = Number(c.cost_center_id);
      if (!ccId) continue;
      ins.run(userId, ccId, c.can_view ? 1 : 0, c.can_post ? 1 : 0);
    }
  })();
  audit(actorId, 'update', 'user_cost_centers', userId,
    `تخصیص مراکز هزینه تولید — ${user.name} (${list.length} مرکز)`);
  return getUserCostCenterPayload(db, userId);
}

router.get('/health-check', auth, requirePermission('production', 'view'), (req, res) => {
  handle(res, () => runHealthCheck(getDB()));
});

router.get('/user-cost-centers', auth, adminOrAccounting, (req, res) => {
  handle(res, () => {
    const db = getDB();
    const userId = req.query.user_id != null ? Number(req.query.user_id) : null;
    if (userId) return getUserCostCenterPayload(db, userId);
    return { users: listProductionUsers(db) };
  });
});

router.put('/user-cost-centers/:userId', auth, adminOrAccounting, (req, res) => {
  handle(res, () => {
    const userId = Number(req.params.userId);
    const centers = req.body?.centers ?? req.body?.cost_centers ?? [];
    return setUserCostCenters(getDB(), userId, centers, req.user.id);
  });
});

module.exports = router;
module.exports.getUserCostCenterPayload = getUserCostCenterPayload;
module.exports.setUserCostCenters = setUserCostCenters;
module.exports.listProductionUsers = listProductionUsers;
