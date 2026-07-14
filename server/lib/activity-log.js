// User activity log — spec §9.34 / Phase 8

function logActivity(db, { userId, username, action, entityType, entityId, ip, details }) {
  try {
    db.prepare(`
      INSERT INTO user_activity_log (user_id, username, action, entity_type, entity_id, ip_address, details)
      VALUES (?,?,?,?,?,?,?)
    `).run(
      userId || null, username || '', action, entityType || null, entityId || null,
      ip || null, details ? JSON.stringify(details) : null
    );
  } catch (_) { /* table may not exist during boot */ }
}

function activityMiddleware() {
  return (req, res, next) => {
    if (!req.user || req.method === 'GET') return next();
    const origJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 400) {
        try {
          const { getDB } = require('../db');
          logActivity(getDB(), {
            userId: req.user.id,
            username: req.user.username || req.user.name,
            action: req.method.toLowerCase(),
            entityType: req.baseUrl?.replace('/api/', '') || 'api',
            ip: req.ip,
            details: { path: req.path },
          });
        } catch (_) {}
      }
      return origJson(body);
    };
    next();
  };
}

module.exports = { logActivity, activityMiddleware };
