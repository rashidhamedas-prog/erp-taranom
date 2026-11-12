// In-app notifications for managers/accountants — created on new invoices/followups.

const MANAGER_ROLES = ['admin', 'accounting', 'sales_manager'];

function notifyRoles(db, { kind, entity_type, entity_id, title, body, target_roles }) {
  const roles = target_roles || MANAGER_ROLES;
  const ins = db.prepare(`
    INSERT INTO app_notifications (kind, entity_type, entity_id, title, body, target_roles, created_at)
    VALUES (?,?,?,?,?,?,strftime('%s','now'))
  `);
  ins.run(kind, entity_type, entity_id, title, body || '', JSON.stringify(roles));
  try {
    const { broadcastNotification } = require('../routes/notifications');
    if (typeof broadcastNotification === 'function') broadcastNotification({ type: 'changed' });
  } catch { /* producers must never break */ }
}

function notifyNewInvoice(db, inv, cust) {
  const biz = cust?.biz || 'مشتری';
  const { invoiceTypeLabel } = require('./sales-document');
  const label = invoiceTypeLabel(inv.type);
  notifyRoles(db, {
    kind: 'invoice_new',
    entity_type: 'invoice',
    entity_id: inv.id,
    title: `فاکتور جدید ${inv.num || '#' + inv.id}`,
    body: `${label} — ${biz} — ${Number(inv.final || 0).toLocaleString('fa-IR')} ریال`,
  });
}

function notifyNewFollowup(db, fup, cust) {
  const biz = cust?.biz || 'مشتری';
  notifyRoles(db, {
    kind: 'followup_new',
    entity_type: 'followup',
    entity_id: fup.id,
    title: 'پیگیری جدید',
    body: `${biz} — ${fup.subject || ''}`,
    target_roles: ['admin', 'sales_manager'],
  });
}

function listForUser(db, user) {
  const role = user.role;
  // B11: role filter before limit (keep cheque_due for legacy GET /)
  return db.prepare(`
    SELECT * FROM app_notifications
    WHERE resolved_at IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 400
  `).all().filter((n) => {
    if (n.kind === 'app_update') return true;
    try {
      const roles = JSON.parse(n.target_roles || '[]');
      return roles.includes(role) || roles.includes('*');
    } catch { return false; }
  }).slice(0, 100);
}

/** اعلان نسخه جدید — بدون تکرار برای همان platform+version تا وقتی resolve نشود */
function notifyAppUpdate(db, { platform, version, notes }) {
  const plat = String(platform || 'app');
  const ver = String(version || '');
  if (!ver) return null;
  const title = `به‌روزرسانی ${plat === 'android' ? 'اندروید' : plat === 'desktop' ? 'ویندوز' : 'برنامه'} ${ver}`;
  const body = notes || 'نسخه جدید آماده است — از تنظیمات → به‌روزرسانی نرم‌افزار اقدام کنید.';
  const existing = db.prepare(`
    SELECT id FROM app_notifications
    WHERE kind='app_update' AND resolved_at IS NULL AND title=?
    LIMIT 1
  `).get(title);
  if (existing) return existing.id;
  const info = db.prepare(`
    INSERT INTO app_notifications (kind, entity_type, entity_id, title, body, target_roles, created_at)
    VALUES ('app_update','app_update',NULL,?,?,?,strftime('%s','now'))
  `).run(title, body, JSON.stringify(['*']));
  try {
    const { broadcastNotification } = require('../routes/notifications');
    if (typeof broadcastNotification === 'function') broadcastNotification({ type: 'changed' });
  } catch { /* ignore */ }
  return info.lastInsertRowid;
}

function markResolved(db, id, userId) {
  db.prepare(`
    UPDATE app_notifications SET resolved_at=strftime('%s','now'), resolved_by=?
    WHERE id=? AND resolved_at IS NULL
  `).run(userId, id);
}

/** Legacy global resolve — kept for admin resolve endpoint only. */
function markEntityViewed(db, entityType, entityId, userId) {
  // v642: per-user read; do not globally resolve.
  const inbox = require('./notification-inbox');
  const user = { id: userId, role: null };
  try {
    const row = db.prepare('SELECT id, role FROM users WHERE id=?').get(userId);
    if (row) { user.role = row.role; user.id = row.id; }
  } catch { /* ignore */ }
  if (!user.role) {
    // fallback: still avoid global resolve
    return;
  }
  inbox.markEntityViewedForUser(db, user, entityType, entityId);
}

function userMayResolve(db, user, row) {
  if (!row) return false;
  if (user.role === 'admin') return true;
  try {
    const roles = JSON.parse(row.target_roles || '[]');
    return roles.includes(user.role) || roles.includes('*');
  } catch {
    return false;
  }
}

module.exports = {
  notifyRoles, notifyNewInvoice, notifyNewFollowup, notifyAppUpdate,
  listForUser, markResolved, markEntityViewed, userMayResolve, MANAGER_ROLES,
};
