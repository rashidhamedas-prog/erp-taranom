'use strict';
/**
 * Phase 2A — helpers for cheque book leaves (دسته‌چک / برگ).
 * Idempotent generate from serial range; void/lost; link leaf on out issue.
 */

const USED_STATUSES = ['issued', 'void', 'lost', 'cancelled'];
const MAX_LEAVES_PER_GENERATE = 5000;

function expandSerialRange(serialFrom, serialTo) {
  const from = String(serialFrom == null ? '' : serialFrom).trim();
  const to = String(serialTo == null ? '' : serialTo).trim();
  if (!from || !to) {
    const err = new Error('بازه سریال (از/تا) الزامی است');
    err.status = 400;
    err.code = 'E_SERIAL_RANGE';
    throw err;
  }
  if (!/^\d+$/.test(from) || !/^\d+$/.test(to)) {
    if (from === to) return [from];
    const err = new Error('بازه سریال باید عددی باشد');
    err.status = 400;
    err.code = 'E_SERIAL_RANGE';
    throw err;
  }
  const start = Number(from);
  const end = Number(to);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    const err = new Error('سریال خارج از محدوده مجاز است');
    err.status = 400;
    err.code = 'E_SERIAL_RANGE';
    throw err;
  }
  if (end < start) {
    const err = new Error('سریال پایانی کوچک‌تر از ابتدایی است');
    err.status = 400;
    err.code = 'E_SERIAL_RANGE';
    throw err;
  }
  const count = end - start + 1;
  if (count > MAX_LEAVES_PER_GENERATE) {
    const err = new Error(`حداکثر ${MAX_LEAVES_PER_GENERATE} برگ در هر تولید مجاز است`);
    err.status = 400;
    err.code = 'E_SERIAL_RANGE';
    throw err;
  }
  const pad = Math.max(from.length, to.length);
  const out = [];
  for (let n = start; n <= end; n++) {
    out.push(String(n).padStart(pad, '0'));
  }
  return out;
}

/** تعداد برگ‌های مصرف‌شده (صادر/باطل/مفقود/لغو) برای یک دسته */
function countUsedLeaves(db, categoryId) {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS c FROM cheque_book_leaves
      WHERE check_category_id=? AND status IN ('issued','void','lost','cancelled')
    `).get(categoryId);
    return Number(row && row.c) || 0;
  } catch (_) {
    return 0;
  }
}

function countBlankLeaves(db, categoryId) {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS c FROM cheque_book_leaves
      WHERE check_category_id=? AND status='blank'
    `).get(categoryId);
    return Number(row && row.c) || 0;
  } catch (_) {
    return 0;
  }
}

function countAllLeaves(db, categoryId) {
  try {
    const row = db.prepare(
      'SELECT COUNT(*) AS c FROM cheque_book_leaves WHERE check_category_id=?'
    ).get(categoryId);
    return Number(row && row.c) || 0;
  } catch (_) {
    return 0;
  }
}

/**
 * تولید برگ سفید از بازه. تکراری‌ها نادیده گرفته می‌شوند (idempotent).
 * @returns {{ created: number, skipped: number, total: number, serials: string[] }}
 */
function generateLeaves(db, categoryId, serialFrom, serialTo, opts) {
  const options = opts || {};
  const serials = expandSerialRange(
    serialFrom != null ? serialFrom : options.serial_from,
    serialTo != null ? serialTo : options.serial_to
  );
  const insert = db.prepare(`
    INSERT OR IGNORE INTO cheque_book_leaves (check_category_id, serial, sayadi, status)
    VALUES (?, ?, '', 'blank')
  `);
  let created = 0;
  const run = db.transaction(() => {
    for (const serial of serials) {
      const r = insert.run(categoryId, serial);
      if (r.changes > 0) created++;
    }
    // هم‌راستا کردن leaf_count با تعداد واقعی برگ‌ها (در صورت خالی بودن قبلی)
    if (options.updateLeafCount !== false) {
      const total = countAllLeaves(db, categoryId);
      try {
        db.prepare('UPDATE check_categories SET leaf_count=? WHERE id=?').run(total, categoryId);
      } catch (_) { /* */ }
    }
  });
  run();
  return {
    created,
    skipped: serials.length - created,
    total: countAllLeaves(db, categoryId),
    serials,
  };
}

function getLeaf(db, categoryId, leafId) {
  return db.prepare(
    'SELECT * FROM cheque_book_leaves WHERE id=? AND check_category_id=?'
  ).get(leafId, categoryId);
}

/**
 * باطل یا مفقود کردن برگ سفید با دلیل + audit از بیرون.
 * @param {'void'|'lost'|'cancelled'} newStatus
 */
function markLeafUnavailable(db, categoryId, leafId, newStatus, reason, userId) {
  if (!['void', 'lost', 'cancelled'].includes(newStatus)) {
    const err = new Error('وضعیت نامعتبر');
    err.status = 400;
    throw err;
  }
  const why = String(reason || '').trim();
  if (!why) {
    const err = new Error('دلیل الزامی است');
    err.status = 400;
    err.code = 'E_VOID_REASON';
    throw err;
  }
  const leaf = getLeaf(db, categoryId, leafId);
  if (!leaf) {
    const err = new Error('برگ یافت نشد');
    err.status = 404;
    throw err;
  }
  if (leaf.status !== 'blank') {
    const err = new Error('فقط برگ سفید قابل ابطال/مفقودی است');
    err.status = 400;
    err.code = 'E_LEAF_NOT_BLANK';
    throw err;
  }
  db.prepare(`
    UPDATE cheque_book_leaves
    SET status=?, void_reason=?, voided_by=?, voided_at=strftime('%s','now')
    WHERE id=? AND check_category_id=? AND status='blank'
  `).run(newStatus, why, userId || null, leafId, categoryId);
  return getLeaf(db, categoryId, leafId);
}

/**
 * اتصال برگ هنگام صدور چک out — وضعیت issued + leaf_id روی cheque_records.
 */
function issueLeafForCheque(db, categoryId, leafId, chequeRecordId) {
  const cid = Number(chequeRecordId);
  if (!Number.isInteger(cid) || cid <= 0) {
    const err = new Error('شناسه رکورد چک الزامی است');
    err.status = 400;
    throw err;
  }
  const leaf = getLeaf(db, categoryId, leafId);
  if (!leaf) {
    const err = new Error('برگ یافت نشد');
    err.status = 404;
    throw err;
  }
  if (leaf.status !== 'blank') {
    const err = new Error('فقط برگ سفید قابل صدور است');
    err.status = 400;
    err.code = 'E_LEAF_NOT_BLANK';
    throw err;
  }
  const cheque = db.prepare('SELECT id, direction, leaf_id FROM cheque_records WHERE id=?').get(cid);
  if (!cheque) {
    const err = new Error('رکورد چک یافت نشد');
    err.status = 404;
    throw err;
  }
  if (String(cheque.direction || '') !== 'out') {
    const err = new Error('فقط چک پرداختی (out) به برگ وصل می‌شود');
    err.status = 400;
    err.code = 'E_LEAF_DIRECTION';
    throw err;
  }
  if (cheque.leaf_id && Number(cheque.leaf_id) !== Number(leafId)) {
    const err = new Error('این چک قبلاً به برگ دیگری وصل شده است');
    err.status = 400;
    err.code = 'E_CHEQUE_HAS_LEAF';
    throw err;
  }
  const run = db.transaction(() => {
    const upd = db.prepare(`
      UPDATE cheque_book_leaves
      SET status='issued', cheque_record_id=?
      WHERE id=? AND check_category_id=? AND status='blank'
    `).run(cid, leafId, categoryId);
    if (!upd.changes) {
      const err = new Error('صدور برگ ناموفق بود');
      err.status = 409;
      throw err;
    }
    db.prepare('UPDATE cheque_records SET leaf_id=? WHERE id=?').run(leafId, cid);
  });
  run();
  return getLeaf(db, categoryId, leafId);
}

/**
 * به‌روزرسانی صیاد برگ سفید (برای ثبت قبل از صدور).
 */
function updateLeafSayadi(db, categoryId, leafId, sayadi) {
  const leaf = getLeaf(db, categoryId, leafId);
  if (!leaf) {
    const err = new Error('برگ یافت نشد');
    err.status = 404;
    throw err;
  }
  if (leaf.status !== 'blank') {
    const err = new Error('فقط برگ سفید قابل ویرایش صیاد است');
    err.status = 400;
    throw err;
  }
  const val = String(sayadi == null ? '' : sayadi).trim();
  try {
    db.prepare(
      'UPDATE cheque_book_leaves SET sayadi=? WHERE id=? AND check_category_id=?'
    ).run(val, leafId, categoryId);
  } catch (e) {
    if (/UNIQUE|unique/i.test(String(e && e.message))) {
      const err = new Error('شماره صیاد تکراری است');
      err.status = 409;
      err.code = 'E_SAYADI_DUP';
      throw err;
    }
    throw e;
  }
  return getLeaf(db, categoryId, leafId);
}

function listLeaves(db, categoryId, query) {
  const q = query || {};
  const params = [categoryId];
  let sql = 'SELECT * FROM cheque_book_leaves WHERE check_category_id=?';
  if (q.status) {
    sql += ' AND status=?';
    params.push(String(q.status));
  }
  sql += ' ORDER BY serial ASC, id ASC';
  return db.prepare(sql).all(...params);
}

module.exports = {
  USED_STATUSES,
  MAX_LEAVES_PER_GENERATE,
  expandSerialRange,
  countUsedLeaves,
  countBlankLeaves,
  countAllLeaves,
  generateLeaves,
  getLeaf,
  markLeafUnavailable,
  issueLeafForCheque,
  updateLeafSayadi,
  listLeaves,
};
