'use strict';

/**
 * Payment-instrument catalog for card terminals.
 *
 * Invariant: choosing an active terminal is part of posting a sales invoice
 * or a customer settlement, the same class as choosing a bank or a cash box.
 * It is not the POS administration section (define, deactivate, batch settle,
 * report). Those stay behind admin/accounting.
 *
 * A role default of "no accounting menu" must not hide terminals from a user
 * who is allowed to post the document. Per-user grants on invoices or
 * settlements are enough. The admin list (inactive rows, merchant id) is a
 * different resource and is not this catalog.
 */
const { hasPermission } = require('./rbac');

function canListPosChoices(db, user) {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'accounting') return true;
  if (hasPermission(db, user, 'invoices', 'create')) return true;
  if (hasPermission(db, user, 'invoices', 'edit')) return true;
  if (hasPermission(db, user, 'acc_settlements', 'create')) return true;
  if (hasPermission(db, user, 'acc_settlements', 'edit')) return true;
  if (hasPermission(db, user, 'acc_pos_devices', 'view')) return true;
  return false;
}

function toPosChoice(row) {
  return {
    id: row.id,
    name: row.name,
    terminal_id: row.terminal_id,
    bank_id: row.bank_id,
    bank_name: row.bank_name || '',
    active: Number(row.active) ? 1 : 0,
  };
}

module.exports = { canListPosChoices, toPosChoice };
