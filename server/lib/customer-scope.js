'use strict';
/**
 * Customer ownership / visibility — single source of truth.
 *
 * Visibility (non-admin, non-accounting):
 *   customers.user_id = me OR customers.assigned_to = me
 * Admin + accounting see all. sales_manager does NOT see the whole team.
 *
 * After every assignment write: user_id === assigned_to === parties.user_id (when linked).
 * created_by is historical and never controls visibility.
 */

const { todayJalali } = require('../jalali');

function scopeUserId(req) {
  const role = req?.user?.role;
  if (role === 'admin' || role === 'accounting') return null;
  return req.user.id;
}

/** SQL fragment; caller binds the user id twice. */
function customerVisibilitySql(alias) {
  const a = alias || 'c';
  return `(${a}.user_id=? OR ${a}.assigned_to=?)`;
}

function hasRepAssignmentHistory(db) {
  return !!db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='rep_assignment_history'"
  ).get();
}

/**
 * Set customers.user_id = customers.assigned_to = ownerUserId;
 * if party_id set, parties.user_id too. Append history when owner changes.
 * Opens a transaction only when the caller is not already inside one.
 */
function assignCustomerOwner(db, { customerId, ownerUserId, actorId, note }) {
  const cid = parseInt(customerId, 10);
  const oid = parseInt(ownerUserId, 10);
  if (!cid || !oid) return null;

  const run = () => {
    const cust = db.prepare('SELECT id, user_id, assigned_to, party_id FROM customers WHERE id=?').get(cid);
    if (!cust) return null;

    const prevUser = cust.user_id != null ? Number(cust.user_id) : null;
    const prevAssigned = cust.assigned_to != null ? Number(cust.assigned_to) : null;
    const ownerUnchanged = prevUser === oid && prevAssigned === oid;

    db.prepare('UPDATE customers SET user_id=?, assigned_to=? WHERE id=?').run(oid, oid, cid);

    if (cust.party_id) {
      try {
        db.prepare('UPDATE parties SET user_id=?, updated_at=strftime(\'%s\',\'now\') WHERE id=?')
          .run(oid, cust.party_id);
      } catch (_) {
        db.prepare('UPDATE parties SET user_id=? WHERE id=?').run(oid, cust.party_id);
      }
    }

    if (!ownerUnchanged && hasRepAssignmentHistory(db)) {
      const fromRep = prevUser != null ? prevUser : prevAssigned;
      db.prepare(
        `INSERT INTO rep_assignment_history (customer_id,from_rep_id,to_rep_id,date,note,created_by)
         VALUES (?,?,?,?,?,?)`
      ).run(cid, fromRep, oid, todayJalali(), note || '', actorId || null);
    }

    return { customerId: cid, ownerUserId: oid, fromRepId: prevUser };
  };

  if (db.inTransaction) return run();
  return db.transaction(run)();
}

/**
 * One-shot drift repair (settings flag customer_owner_align_v1).
 * assigned_to wins when it differs from user_id; then copy onto parties.user_id.
 */
function alignCustomerOwners(db) {
  const flag = db.prepare("SELECT value FROM settings WHERE key='customer_owner_align_v1'").get();
  if (flag && String(flag.value) === '1') return { skipped: true };

  const run = () => {
    db.prepare(`
      UPDATE customers
      SET user_id = assigned_to
      WHERE assigned_to IS NOT NULL AND assigned_to != user_id
    `).run();

    db.prepare(`
      UPDATE parties
      SET user_id = (
        SELECT c.user_id FROM customers c WHERE c.party_id = parties.id LIMIT 1
      ),
      updated_at = strftime('%s','now')
      WHERE EXISTS (
        SELECT 1 FROM customers c
        WHERE c.party_id = parties.id
          AND c.user_id IS NOT NULL
          AND (parties.user_id IS NULL OR parties.user_id != c.user_id)
      )
    `).run();

    db.exec('CREATE INDEX IF NOT EXISTS idx_customers_assigned_to ON customers(assigned_to)');
    db.prepare(
      "INSERT INTO settings (key,value) VALUES ('customer_owner_align_v1','1') ON CONFLICT(key) DO UPDATE SET value='1'"
    ).run();
    return { aligned: true };
  };

  if (db.inTransaction) return run();
  return db.transaction(run)();
}

/** True if a non-null scope user can see this customer row. */
function customerVisibleTo(db, customerId, userId) {
  if (userId == null) return true;
  // Shared walk-in cash desk: visible to all sales users; txs filtered elsewhere.
  try {
    const { isWalkinCustomer } = require('./store-quick-sale');
    if (isWalkinCustomer(db, customerId)) return true;
  } catch (_) { /* optional */ }
  const row = db.prepare(
    `SELECT id FROM customers WHERE id=? AND ${customerVisibilitySql('customers')}`
  ).get(customerId, userId, userId);
  return !!row;
}

module.exports = {
  scopeUserId,
  customerVisibilitySql,
  assignCustomerOwner,
  alignCustomerOwners,
  customerVisibleTo,
};
