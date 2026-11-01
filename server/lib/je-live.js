'use strict';
/**
 * FR-RECON: balances count only approved/posted journal entries. status='draft'
 * (e.g. the P9 agent-commission voucher awaiting approval) never moves an account
 * balance, trial balance, report total or subledger-recon gap. Dependency-free so any
 * module (including ones loaded while db.js boots) can require it.
 */
function jeNotDraftSql(alias = 'je') {
  return `COALESCE(${alias}.status,'approved')<>'draft'`;
}

const JE_NOT_DRAFT = jeNotDraftSql('je');

const _hasStatus = new WeakMap();

/** Same predicate, or '1=1' on legacy/minimal schemas whose journal_entries has no status column. */
function jeNotDraftFor(db, alias = 'je') {
  let has = _hasStatus.get(db) === true;
  if (!has) {
    try {
      has = db.prepare('PRAGMA table_info(journal_entries)').all().some((c) => c.name === 'status');
    } catch (_) {
      has = false;
    }
    if (has) _hasStatus.set(db, true);
  }
  return has ? jeNotDraftSql(alias) : '1=1';
}

module.exports = { JE_NOT_DRAFT, jeNotDraftSql, jeNotDraftFor };
