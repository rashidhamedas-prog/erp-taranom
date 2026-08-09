/**
 * Moadian schema patch for ORCH to apply in server/db.js (do not apply here).
 * W1-F1 / MVP P0-F1 foundation — retry + status history fields.
 *
 * Suggested application (idempotent), same pattern as gap-accounting-schema.js:
 *   for (const [table, column, definition] of ENSURE_COLUMNS) {
 *     ensureColumn(db, table, column, definition);
 *   }
 *   db.exec(STATUS_HISTORY_SQL);
 */

'use strict';

/** @type {Array<[string, string, string]>} [table, column, definition] */
const ENSURE_COLUMNS = [
  ['moadian_queue', 'retry_count', 'INTEGER DEFAULT 0'],
  ['moadian_queue', 'next_retry_at', 'INTEGER'],
  ['moadian_queue', 'last_error', 'TEXT'],
  // JSON array of { at, from, to, note } appended by queue status helpers
  ['moadian_queue', 'status_notes', 'TEXT'],
];

const STATUS_HISTORY_SQL = `
CREATE TABLE IF NOT EXISTS moadian_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_id INTEGER NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_at INTEGER DEFAULT (strftime('%s','now')),
  FOREIGN KEY(queue_id) REFERENCES moadian_queue(id)
);
CREATE INDEX IF NOT EXISTS idx_moadian_status_history_queue
  ON moadian_status_history(queue_id);
CREATE INDEX IF NOT EXISTS idx_moadian_queue_next_retry
  ON moadian_queue(next_retry_at);
`;

/** Plain ALTER fragments (for docs / manual review). Prefer ENSURE_COLUMNS + ensureColumn. */
const ALTER_SQL = ENSURE_COLUMNS.map(
  ([table, column, definition]) => `ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`
);

module.exports = {
  ENSURE_COLUMNS,
  STATUS_HISTORY_SQL,
  ALTER_SQL,
};
