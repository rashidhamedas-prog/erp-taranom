'use strict';

const VALID = new Set(['pending', 'sent', 'failed', 'cancelled', 'test_sent']);

function readSetting(db, key, fallback = '') {
  try {
    return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? fallback;
  } catch (_) {
    return fallback;
  }
}

function enqueueMoadian(db, docType, docId) {
  const enabled = readSetting(db, 'moadian_enabled');
  if (enabled !== '1') return null;
  const exists = db.prepare('SELECT id FROM moadian_queue WHERE doc_type=? AND doc_id=?').get(docType, docId);
  if (exists) return exists.id;

  let invoiceType = 1;
  if (docType === 'sales') {
    const inv = db.prepare('SELECT moadian_invoice_type FROM invoices WHERE id=?').get(docId);
    invoiceType = parseInt(inv?.moadian_invoice_type, 10) || 1;
  }
  const adapter = readSetting(db, 'moadian_adapter', 'stub') || 'stub';
  const r = db.prepare(`
    INSERT INTO moadian_queue (doc_type, doc_id, status, invoice_type, adapter, retry_count)
    VALUES (?,?,?,?,?,0)
  `).run(docType, docId, 'pending', invoiceType, adapter);
  return r.lastInsertRowid;
}

function appendStatusNote(db, queueId, fromStatus, toStatus, note) {
  try {
    db.prepare(`
      INSERT INTO moadian_status_history (queue_id, from_status, to_status, note)
      VALUES (?,?,?,?)
    `).run(queueId, fromStatus || null, toStatus, note || '');
  } catch (_) {
    /* history table may not exist until ORCH applies schema-sql */
  }
  try {
    const row = db.prepare('SELECT status_notes FROM moadian_queue WHERE id=?').get(queueId);
    let arr = [];
    if (row?.status_notes) {
      try { arr = JSON.parse(row.status_notes) || []; } catch (_) { arr = []; }
    }
    arr.push({ at: Math.floor(Date.now() / 1000), from: fromStatus, to: toStatus, note: note || '' });
    db.prepare('UPDATE moadian_queue SET status_notes=? WHERE id=?').run(JSON.stringify(arr), queueId);
  } catch (_) { /* status_notes column may be missing */ }
}

function transitionStatus(db, queueId, toStatus, note) {
  if (!VALID.has(toStatus)) throw new Error(`وضعیت نامعتبر: ${toStatus}`);
  const row = db.prepare('SELECT * FROM moadian_queue WHERE id=?').get(queueId);
  if (!row) throw new Error('صف مودیان یافت نشد');
  const from = row.status;
  db.prepare('UPDATE moadian_queue SET status=? WHERE id=?').run(toStatus, queueId);
  appendStatusNote(db, queueId, from, toStatus, note);
  return db.prepare('SELECT * FROM moadian_queue WHERE id=?').get(queueId);
}

function computeNextRetryAt(retryCount) {
  const base = 60;
  const delay = Math.min(3600, base * Math.pow(2, Math.max(0, retryCount)));
  return Math.floor(Date.now() / 1000) + delay;
}

function markFailed(db, queueId, errorMessage) {
  const row = db.prepare('SELECT * FROM moadian_queue WHERE id=?').get(queueId);
  if (!row) throw new Error('صف مودیان یافت نشد');
  const retry = (row.retry_count || 0) + 1;
  const next = computeNextRetryAt(retry);
  try {
    db.prepare(`
      UPDATE moadian_queue SET status='failed', retry_count=?, next_retry_at=?, last_error=? WHERE id=?
    `).run(retry, next, String(errorMessage || '').slice(0, 2000), queueId);
  } catch (_) {
    db.prepare(`UPDATE moadian_queue SET status='failed' WHERE id=?`).run(queueId);
  }
  appendStatusNote(db, queueId, row.status, 'failed', errorMessage);
  return db.prepare('SELECT * FROM moadian_queue WHERE id=?').get(queueId);
}

function markSent(db, queueId, taxId, responseObj) {
  const row = db.prepare('SELECT * FROM moadian_queue WHERE id=?').get(queueId);
  if (!row) throw new Error('صف مودیان یافت نشد');
  db.prepare(`
    UPDATE moadian_queue SET status='sent', tax_id=?, sent_at=strftime('%s','now'), response_json=?, last_error=NULL
    WHERE id=?
  `).run(taxId, JSON.stringify(responseObj || {}), queueId);
  appendStatusNote(db, queueId, row.status, 'sent', taxId);
  return db.prepare('SELECT * FROM moadian_queue WHERE id=?').get(queueId);
}

/** Sandbox / experimental send — does not lock invoice like live stamp. */
function markTestSent(db, queueId, taxId, responseObj) {
  const row = db.prepare('SELECT * FROM moadian_queue WHERE id=?').get(queueId);
  if (!row) throw new Error('صف مودیان یافت نشد');
  db.prepare(`
    UPDATE moadian_queue SET status='test_sent', tax_id=?, sent_at=strftime('%s','now'), response_json=?, last_error=NULL
    WHERE id=?
  `).run(taxId, JSON.stringify(responseObj || {}), queueId);
  appendStatusNote(db, queueId, row.status, 'test_sent', taxId);
  return db.prepare('SELECT * FROM moadian_queue WHERE id=?').get(queueId);
}

module.exports = {
  enqueueMoadian,
  transitionStatus,
  markFailed,
  markSent,
  markTestSent,
  computeNextRetryAt,
  VALID,
};
