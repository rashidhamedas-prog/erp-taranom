/**
 * حذف کامل کاربر از سیستم (نه فقط غیرفعال‌سازی).
 * اسناد/فاکتورها حفظ می‌شوند و مالکیت به admin جایگزین منتقل می‌شود.
 */

const DELETE_BY_USER_TABLES = new Set([
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
  'messages',
]);

/** ستون‌هایی که معمولاً NOT NULL هستند و باید به admin منتقل شوند */
const REASSIGN_COLS = new Set([
  'user_id', 'rep_id', 'to_rep_id', 'from_id', 'to_id',
]);

/** همهٔ نام‌ستون‌های ارجاع به users */
const USER_REF_COLS = new Set([
  'user_id', 'rep_id', 'from_rep_id', 'to_rep_id',
  'created_by', 'approved_by', 'deleted_by', 'reversed_by',
  'assigned_to', 'paired_by', 'resolved_by', 'responsible_user_id',
  'closed_by', 'supervisor_id', 'from_id', 'to_id',
]);

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

function listTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
}

function columnMeta(db, table) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all(); } catch { return []; }
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
    for (const t of DELETE_BY_USER_TABLES) {
      if (!tableExists(db, t)) continue;
      if (t === 'messages') {
        safeRun(db, 'DELETE FROM messages WHERE from_id=? OR to_id=?', [id, id]);
        continue;
      }
      if (hasColumn(db, t, 'user_id')) safeRun(db, `DELETE FROM ${t} WHERE user_id=?`, [id]);
    }

    // 2) جارو روی همه جداول برای هر ستون ارجاع به کاربر
    for (const t of listTables(db)) {
      if (t === 'users' || DELETE_BY_USER_TABLES.has(t)) continue;
      const cols = columnMeta(db, t);
      for (const col of cols) {
        const c = col.name;
        if (!USER_REF_COLS.has(c)) continue;
        const notNull = !!col.notnull;
        if (notNull || REASSIGN_COLS.has(c)) {
          safeRun(db, `UPDATE ${t} SET ${c}=? WHERE ${c}=?`, [reassign, id]);
        } else {
          safeRun(db, `UPDATE ${t} SET ${c}=NULL WHERE ${c}=?`, [id]);
        }
      }
    }

    // 3) شخص لینک‌شده کاربر — غیرفعال (اسناد تفصیلی حفظ می‌شود)
    if (user.party_id && tableExists(db, 'parties')) {
      safeRun(db, "UPDATE parties SET is_active=0, updated_at=strftime('%s','now') WHERE id=?", [user.party_id]);
    }
    safeRun(db, 'UPDATE users SET party_id=NULL WHERE id=?', [id]);

    // 4) حذف ردیف کاربر → tombstone سینک
    db.prepare('DELETE FROM users WHERE id=?').run(id);
  });

  run();
  return { ok: true, purged: id, name: user.name, username: user.username };
}

module.exports = { purgeUser };
