'use strict';
/**
 * cheque_events append-only ledger + reverse-last helper scaffolding.
 */

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch (_) {
    return false;
  }
}

function insertChequeEvent(db, {
  chequeId, fromStatus, toStatus, eventDate, journalEntryId,
  reversesEventId, bankId, partyId, note, createdBy, clientRequestId,
}) {
  if (!tableExists(db, 'cheque_events')) return null;
  if (clientRequestId) {
    const existing = db.prepare('SELECT * FROM cheque_events WHERE client_request_id=?').get(clientRequestId);
    if (existing) return existing;
  }
  const r = db.prepare(`
    INSERT INTO cheque_events (
      cheque_id, from_status, to_status, event_date, journal_entry_id,
      reverses_event_id, bank_id, party_id, note, created_by, client_request_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    chequeId,
    fromStatus || null,
    toStatus,
    eventDate,
    journalEntryId || null,
    reversesEventId || null,
    bankId || null,
    partyId || null,
    note || null,
    createdBy || null,
    clientRequestId || null
  );
  return db.prepare('SELECT * FROM cheque_events WHERE id=?').get(r.lastInsertRowid);
}

function listChequeEvents(db, chequeId) {
  if (!tableExists(db, 'cheque_events')) return [];
  return db.prepare(`
    SELECT * FROM cheque_events WHERE cheque_id=?
    ORDER BY COALESCE(created_at,0) ASC, id ASC
  `).all(chequeId);
}

function lastReversibleEvent(db, chequeId) {
  if (!tableExists(db, 'cheque_events')) return null;
  return db.prepare(`
    SELECT e.* FROM cheque_events e
    WHERE e.cheque_id=?
      AND e.journal_entry_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM cheque_events r WHERE r.reverses_event_id=e.id
      )
    ORDER BY e.id DESC LIMIT 1
  `).get(chequeId);
}

function chequeEventDesc(row, actionFa) {
  const num = (row && row.cheque_number) || '';
  const say = (row && row.sayadi) || '';
  return `چک ${num} صیاد ${say} — ${actionFa}`;
}

module.exports = {
  tableExists,
  insertChequeEvent,
  listChequeEvents,
  lastReversibleEvent,
  chequeEventDesc,
};
