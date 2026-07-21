// In-app notifications for managers/accountants — created on new invoices/followups.

const MANAGER_ROLES = ['admin', 'accounting', 'sales_manager'];

function notifyRoles(db, { kind, entity_type, entity_id, title, body, target_roles }) {
  const roles = target_roles || MANAGER_ROLES;
  const ins = db.prepare(`
    INSERT INTO app_notifications (kind, entity_type, entity_id, title, body, target_roles, created_at)
    VALUES (?,?,?,?,?,?,strftime('%s','now'))
  `);
  ins.run(kind, entity_type, entity_id, title, body || '', JSON.stringify(roles));
}

function notifyNewInvoice(db, inv, cust) {
  const biz = cust?.biz || 'مشتری';
  notifyRoles(db, {
    kind: 'invoice_new',
    entity_type: 'invoice',
    entity_id: inv.id,
    title: `فاکتور جدید ${inv.num || '#' + inv.id}`,
    body: `${inv.type === 'final' ? 'فاکتور رسمی' : 'پیش‌فاکتور'} — ${biz} — ${Number(inv.final || 0).toLocaleString('fa-IR')} ریال`,
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
  return db.prepare(`
    SELECT * FROM app_notifications
    WHERE resolved_at IS NULL
    ORDER BY created_at DESC LIMIT 100
  `).all().filter(n => {
    try {
      const roles = JSON.parse(n.target_roles || '[]');
      return roles.includes(role);
    } catch { return false; }
  });
}

function markResolved(db, id, userId) {
  db.prepare(`
    UPDATE app_notifications SET resolved_at=strftime('%s','now'), resolved_by=?
    WHERE id=? AND resolved_at IS NULL
  `).run(userId, id);
}

function markEntityViewed(db, entityType, entityId, userId) {
  db.prepare(`
    UPDATE app_notifications SET resolved_at=strftime('%s','now'), resolved_by=?
    WHERE entity_type=? AND entity_id=? AND resolved_at IS NULL
  `).run(userId, entityType, entityId);
}

module.exports = {
  notifyRoles, notifyNewInvoice, notifyNewFollowup,
  listForUser, markResolved, markEntityViewed, MANAGER_ROLES,
};
