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
    if (n.kind === 'app_update') return true; // همه نقش‌ها اعلان آپدیت را می‌بینند
    try {
      const roles = JSON.parse(n.target_roles || '[]');
      return roles.includes(role) || roles.includes('*');
    } catch { return false; }
  });
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
  return info.lastInsertRowid;
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
  notifyRoles, notifyNewInvoice, notifyNewFollowup, notifyAppUpdate,
  listForUser, markResolved, markEntityViewed, MANAGER_ROLES,
};
