/**
 * حذف کامل کاربر از سیستم (نه فقط غیرفعال‌سازی).
 * اسناد/فاکتورها حفظ می‌شوند و مالکیت به admin جایگزین منتقل می‌شود.
 */

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch { return false; }
}

function hasColumn(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch { return false; }
}

function safeRun(db, sql, params = []) {
  try { db.prepare(sql).run(...params); } catch (_) { /* column/table may not exist */ }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} userId
 * @param {number} actorId  — admin انجام‌دهنده (برای انتقال مالکیت)
 */
function purgeUser(db, userId, actorId) {
  const id = Number(userId);
  const reassign = Number(actorId);
  if (!id || !reassign) throw new Error('شناسه نامعتبر');
  if (id === reassign) throw new Error('نمی‌توانید خودتان را حذف کنید');

  const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!user) throw Object.assign(new Error('کاربر یافت نشد'), { status: 404 });

  if (user.role === 'admin') {
    const otherAdmins = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1 AND id<>?").get(id)?.c || 0;
    if (otherAdmins < 1) throw Object.assign(new Error('آخرین مدیر فعال را نمی‌توان حذف کرد'), { status: 400 });
  }

  const run = db.transaction(() => {
    // 1) جداول فقط-کاربری
    const deleteByUser = [
      'two_factor_auth',
      'password_reset_otps',
      'user_permissions',
      'user_catalog_categories',
      'user_cost_centers',
      'api_keys',
      'webhooks',
      'reminders',
      'ai_insights',
      'production_idempotency',
    ];
    for (const t of deleteByUser) {
      if (!tableExists(db, t) || !hasColumn(db, t, 'user_id')) continue;
      safeRun(db, `DELETE FROM ${t} WHERE user_id=?`, [id]);
    }
    if (tableExists(db, 'messages')) {
      safeRun(db, 'DELETE FROM messages WHERE from_id=? OR to_id=?', [id, id]);
    }

    // 2) انتقال مالکیت (NOT NULL)
    const reassignCols = [
      ['customers', 'user_id'],
      ['orders', 'user_id'],
      ['followups', 'user_id'],
      ['invoices', 'user_id'],
      ['products', 'user_id'],
      ['stock_logs', 'user_id'],
      ['sms_log', 'user_id'],
      ['settlements', 'user_id'],
      ['purchase_invoices', 'user_id'],
      ['purchase_returns', 'user_id'],
      ['sales_returns', 'user_id'],
      ['incentive_payments', 'rep_id'],
      ['rep_ledger', 'rep_id'],
      ['rep_expenses', 'rep_id'],
      ['rep_advances', 'rep_id'],
      ['rep_commission_rules', 'rep_id'],
      ['rep_commission_tiers', 'rep_id'],
      ['rep_settlements', 'rep_id'],
      ['rep_visit_logs', 'rep_id'],
      ['rep_call_logs', 'rep_id'],
      ['rep_payment_submissions', 'rep_id'],
      ['rep_assignment_history', 'to_rep_id'],
    ];
    for (const [t, col] of reassignCols) {
      if (!tableExists(db, t) || !hasColumn(db, t, col)) continue;
      safeRun(db, `UPDATE ${t} SET ${col}=? WHERE ${col}=?`, [reassign, id]);
    }

    // 3) خالی‌کردن ارجاعات nullable
    const nullCols = [
      ['users', 'supervisor_id'],
      ['customers', 'assigned_to'],
      ['customers', 'created_by'],
      ['followups', 'assigned_to'],
      ['invoices', 'approved_by'],
      ['invoices', 'deleted_by'],
      ['invoices', 'reversed_by'],
      ['audit_log', 'user_id'],
      ['user_activity_log', 'user_id'],
      ['customer_ledger', 'user_id'],
      ['supplier_ledger', 'user_id'],
      ['person_ledger', 'user_id'],
      ['journal_entries', 'created_by'],
      ['journal_entries', 'deleted_by'],
      ['warehouse_moves', 'created_by'],
      ['warehouse_moves', 'reversed_by'],
      ['parties', 'user_id'],
      ['sync_devices', 'paired_by'],
      ['sync_conflicts', 'resolved_by'],
      ['sync_outbox', 'user_id'],
      ['rep_assignment_history', 'from_rep_id'],
      ['rep_assignment_history', 'created_by'],
      ['rep_territories', 'rep_id'],
      ['rep_payment_submissions', 'approved_by'],
      ['rep_payment_submissions', 'created_by'],
      ['stocktaking_sessions', 'responsible_user_id'],
      ['stocktaking_sessions', 'created_by'],
      ['stocktaking_sessions', 'approved_by'],
      ['fiscal_years', 'created_by'],
      ['fiscal_years', 'closed_by'],
      ['app_notifications', 'resolved_by'],
      ['account_transfers', 'user_id'],
    ];
    for (const [t, col] of nullCols) {
      if (!tableExists(db, t) || !hasColumn(db, t, col)) continue;
      safeRun(db, `UPDATE ${t} SET ${col}=NULL WHERE ${col}=?`, [id]);
    }

    // 4) شخص لینک‌شده کاربر — غیرفعال (اسناد تفصیلی حفظ می‌شود)
    if (user.party_id && tableExists(db, 'parties')) {
      safeRun(db, "UPDATE parties SET is_active=0, updated_at=strftime('%s','now') WHERE id=?", [user.party_id]);
    }
    safeRun(db, 'UPDATE users SET party_id=NULL WHERE id=?', [id]);

    // 5) حذف ردیف کاربر → tombstone سینک
    db.prepare('DELETE FROM users WHERE id=?').run(id);
  });

  run();
  return { ok: true, purged: id, name: user.name, username: user.username };
}

module.exports = { purgeUser };
