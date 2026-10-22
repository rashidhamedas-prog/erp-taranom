'use strict';
/**
 * Monthly inventory valuation lock (v522).
 *
 * inventory_period_locks(period 'YYYY/MM' Jalali). While a month is closed:
 *  - manual value-only postings (IRV revaluation, direct value adjustment) → 422 E_INV_PERIOD_LOCKED;
 *  - automatic/replay postings and reversals are moved forward to the first open day;
 *  - ordinary documents (purchases, sales, receipts, landed cost, amendments, production
 *    close; v525: covered cutting-lay delta, order receipt align, sales returns, inbound
 *    warehouse transfers) still post their qty + document JE, but their VALUE effect is parked in an
 *    approval doc (reason 'closed_period', see value-approval.js). Approving it posts at
 *    the original date (withLockBypass) or the first day of the next open month.
 */

const PERIOD_RE = /^\d{4}\/\d{2}$/;
const DATE_RE = /^\d{4}\/\d{2}\/\d{2}$/;

function lockErr(code, status, message, extra) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  if (extra) e.extra = extra;
  return e;
}

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch (_) { return false; }
}

function ensurePeriodLockSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_period_locks (
      period       TEXT PRIMARY KEY,
      status       TEXT NOT NULL DEFAULT 'closed',
      closed_by    INTEGER,
      closed_at    INTEGER,
      reopened_by  INTEGER,
      reopened_at  INTEGER,
      reason       TEXT DEFAULT '',
      updated_at   INTEGER
    );
  `);
}

function normPeriod(p) {
  const s = String(p || '').trim().replace(/-/g, '/');
  if (PERIOD_RE.test(s)) return s;
  if (DATE_RE.test(s)) return s.slice(0, 7);
  return '';
}

function isPeriodLocked(db, date) {
  const period = normPeriod(date);
  if (!period || !tableExists(db, 'inventory_period_locks')) return false;
  const r = db.prepare('SELECT status FROM inventory_period_locks WHERE period=?').get(period);
  return !!(r && r.status === 'closed');
}

function nextMonthFirst(period) {
  let [y, m] = period.split('/').map(Number);
  m += 1;
  if (m > 12) { m = 1; y += 1; }
  return `${y}/${String(m).padStart(2, '0')}/01`;
}

/** First date ≥ date whose month is open (forward-only dating for auto/replay/reversal rows). */
function firstOpenDate(db, date) {
  let d = String(date || '');
  if (!DATE_RE.test(d)) return d;
  for (let i = 0; i < 240 && isPeriodLocked(db, d); i++) d = nextMonthFirst(d.slice(0, 7));
  return d;
}

/**
 * An approved closed-period value approval is the permit to post into a closed month.
 * Only that approval's own postings run inside withLockBypass (synchronous, same tx).
 */
let bypassDepth = 0;
function withLockBypass(fn) {
  bypassDepth++;
  try { return fn(); } finally { bypassDepth--; }
}

/** Closed month for value effects (false inside an approval's bypass and on devices). */
function isValueLocked(db, date) {
  if (bypassDepth > 0 || process.env.SYNC_ROLE === 'device') return false;
  return isPeriodLocked(db, date);
}

/** First day of the first open month strictly after the month of `date`. */
function nextOpenMonthFirst(db, date) {
  const period = normPeriod(date);
  if (!period) return String(date || '');
  return firstOpenDate(db, nextMonthFirst(period));
}

function assertPeriodOpen(db, date, what) {
  if (bypassDepth > 0) return;
  if (!isPeriodLocked(db, date)) return;
  const period = normPeriod(date);
  throw lockErr('E_INV_PERIOD_LOCKED', 422,
    `ماه ${period} در ارزش‌گذاری موجودی قفل است${what ? ` (${what})` : ''}؛ ابتدا مدیر ماه را باز کند، ثبت کند و دوباره ببندد`,
    { period });
}

function listPeriods(db, { limit = 36 } = {}) {
  if (!tableExists(db, 'inventory_period_locks')) return [];
  return db.prepare(`
    SELECT l.*, u1.name AS closed_by_name, u2.name AS reopened_by_name
    FROM inventory_period_locks l
    LEFT JOIN users u1 ON u1.id=l.closed_by
    LEFT JOIN users u2 ON u2.id=l.reopened_by
    ORDER BY l.period DESC LIMIT ?
  `).all(Math.min(240, Math.max(1, Number(limit) || 36)));
}

function writeAudit(userId, action, period, detail) {
  try { require('../../db').audit(userId || null, action, 'inventory_period_lock', null, `${period} — ${detail}`); } catch (_) { /* optional */ }
}

function closePeriod(db, period, user, { reason } = {}) {
  const p = normPeriod(period);
  if (!p) throw lockErr('E_PERIOD', 400, 'دوره باید به صورت ۱۴۰۵/۰۷ باشد');
  const why = String(reason || '').trim();
  if (why.length < 3) throw lockErr('E_REASON_REQUIRED', 400, 'دلیل بستن ماه الزامی است');
  ensurePeriodLockSchema(db);
  db.transaction(() => {
    db.prepare(`
      INSERT INTO inventory_period_locks (period, status, closed_by, closed_at, reason, updated_at)
      VALUES (?, 'closed', ?, strftime('%s','now'), ?, strftime('%s','now'))
      ON CONFLICT(period) DO UPDATE SET status='closed', closed_by=excluded.closed_by,
        closed_at=excluded.closed_at, reason=excluded.reason, updated_at=excluded.updated_at
    `).run(p, user?.id || null, why.slice(0, 300));
  })();
  writeAudit(user?.id, 'close', p, why);
  return db.prepare('SELECT * FROM inventory_period_locks WHERE period=?').get(p);
}

function reopenPeriod(db, period, user, { reason } = {}) {
  const p = normPeriod(period);
  if (!p) throw lockErr('E_PERIOD', 400, 'دوره باید به صورت ۱۴۰۵/۰۷ باشد');
  const why = String(reason || '').trim();
  if (why.length < 3) throw lockErr('E_REASON_REQUIRED', 400, 'دلیل بازگشایی ماه الزامی است');
  ensurePeriodLockSchema(db);
  const row = db.prepare('SELECT * FROM inventory_period_locks WHERE period=?').get(p);
  if (!row || row.status !== 'closed') throw lockErr('E_PERIOD_NOT_CLOSED', 409, `ماه ${p} بسته نیست`);
  db.prepare(`
    UPDATE inventory_period_locks SET status='open', reopened_by=?, reopened_at=strftime('%s','now'),
      reason=?, updated_at=strftime('%s','now') WHERE period=?
  `).run(user?.id || null, why.slice(0, 300), p);
  writeAudit(user?.id, 'reopen', p, why);
  return db.prepare('SELECT * FROM inventory_period_locks WHERE period=?').get(p);
}

module.exports = {
  ensurePeriodLockSchema,
  isPeriodLocked,
  assertPeriodOpen,
  firstOpenDate,
  nextOpenMonthFirst,
  isValueLocked,
  withLockBypass,
  listPeriods,
  closePeriod,
  reopenPeriod,
  normPeriod,
};
