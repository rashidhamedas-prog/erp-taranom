/**
 * Portal background jobs (central-only cron).
 * Spec edge 3: auto-approve stale under_review after configurable timeout (default 72h).
 */
const { audit } = require('../db');
const { notifyRoles } = require('./notifications');

function reviewTimeoutHours(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key='portal_review_timeout_hours'").get();
  const n = parseInt(row?.value, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 720) : 72;
}

/**
 * Move stale under_review logs back to in_progress and notify admin.
 * @returns {number} count of auto-approved reviews
 */
function autoApproveStalePortalReviews(db) {
  const hours = reviewTimeoutHours(db);
  const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
  const hasCol = db.prepare("PRAGMA table_info(op_parameter_dept_log)").all()
    .some(c => c.name === 'review_requested_at');
  if (!hasCol) return 0;

  const stale = db.prepare(`
    SELECT l.*, p.name AS param_name, p.id AS param_id
    FROM op_parameter_dept_log l
    JOIN op_parameters p ON p.id = l.parameter_id
    WHERE l.status = 'under_review'
      AND l.review_requested_at IS NOT NULL
      AND l.review_requested_at <= ?
  `).all(cutoff);

  let n = 0;
  for (const row of stale) {
    db.transaction(() => {
      db.prepare(`
        UPDATE op_parameter_dept_log SET status='in_progress' WHERE id=? AND status='under_review'
      `).run(row.id);
      db.prepare(`
        UPDATE op_parameters SET status='in_progress', updated_at=strftime('%s','now')
        WHERE id=? AND status='under_review'
      `).run(row.param_id);
      audit(null, 'auto_approve_review', 'op_parameter_dept', row.id,
        `تأیید خودکار بازبینی پس از ${hours} ساعت — پارامتر ${row.param_name || row.param_id}`);
      try {
        notifyRoles(db, {
          kind: 'portal_review_auto',
          entity_type: 'op_parameter',
          entity_id: row.param_id,
          title: 'تأیید خودکار بازبینی پورتال',
          body: `${row.param_name || '#' + row.param_id} — پس از ${hours} ساعت`,
          target_roles: ['admin', 'unit_manager'],
        });
      } catch (_) { /* non-fatal */ }
    })();
    n += 1;
  }
  return n;
}

module.exports = { autoApproveStalePortalReviews, reviewTimeoutHours };
