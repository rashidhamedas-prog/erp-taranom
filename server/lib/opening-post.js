/**
 * Opening / beginning-balance journal helpers.
 * Used by parties, products, warehouse receipts, cheques — including Excel import.
 */
const { postToLedger } = require('./ledger');
const { acct } = require('./coa-map');
const { rialToLedger } = require('./money');
const { todayJalali } = require('../jalali');

function parseRoles(partyRoles, partyType) {
  let roles = [];
  try {
    roles = typeof partyRoles === 'string' ? JSON.parse(partyRoles || '[]') : (partyRoles || []);
  } catch (_) { roles = []; }
  if (!roles.length && partyType) {
    if (partyType === 'both') roles = ['customer', 'supplier'];
    else if (partyType) roles = [partyType];
  }
  return Array.isArray(roles) ? roles : [];
}

function controlAccountForParty(db, party) {
  const roles = parseRoles(party.party_roles, party.party_type);
  const nature = String(party.account_nature || '').toLowerCase();
  if (roles.includes('supplier') && !roles.includes('customer')) return acct(db, 'coa_payable');
  if (nature === 'credit' || nature === 'بستانکار') return acct(db, 'coa_payable');
  if (roles.includes('customer') || nature === 'debit' || nature === 'بدهکار') return acct(db, 'coa_receivable');
  if (roles.includes('supplier')) return acct(db, 'coa_payable');
  return acct(db, 'coa_misc_persons');
}

/**
 * Post opening-balance JE for a party (مانده اول دوره).
 * amountRial > 0 → party owes us (debit receivable / credit opening)
 * amountRial < 0 → we owe party (debit opening / credit payable)
 * @returns {number|null} journal entry id
 */
function postPartyOpeningBalance(db, {
  partyId, amountRial, date, userId, description, srcSystem,
}) {
  const amt = Math.round(Number(amountRial) || 0);
  if (!amt) return null;
  const party = db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
  if (!party) throw new Error('شخص برای سند افتتاحیه یافت نشد');

  const control = controlAccountForParty(db, party);
  const opening = acct(db, 'coa_opening_balance');
  const absToman = rialToLedger(Math.abs(amt));
  const lines = amt > 0
    ? [
      { code: control.code, name: control.name, debit: absToman, credit: 0 },
      { code: opening.code, name: opening.name, debit: 0, credit: absToman },
    ]
    : [
      { code: opening.code, name: opening.name, debit: absToman, credit: 0 },
      { code: control.code, name: control.name, debit: 0, credit: absToman },
    ];

  const entryId = postToLedger(db, {
    sourceType: 'opening_balance',
    sourceId: partyId,
    date: date || party.opening_balance_date || todayJalali(),
    description: description || `مانده اول دوره — ${party.full_name || party.biz || partyId}`,
    createdBy: userId,
    voucherType: 'opening',
    srcSystem: srcSystem || null,
    lines,
  });

  // Sub-ledgers (amounts in rial identity, same as customer_ledger after migration)
  try {
    const { createLedgerEntry } = require('../db');
    const debit = amt > 0 ? Math.abs(amt) : 0;
    const credit = amt < 0 ? Math.abs(amt) : 0;
    if (party.legacy_table === 'customers' && party.legacy_id) {
      db.prepare("DELETE FROM customer_ledger WHERE customer_id=? AND ref_type='opening'").run(party.legacy_id);
      createLedgerEntry(db, {
        customer_id: party.legacy_id, date: date || '', entry_type: 'opening',
        ref_type: 'opening', ref_id: party.legacy_id,
        description: 'مانده اولیه حساب', debit, credit, user_id: userId,
      });
      db.prepare('UPDATE customers SET balance=? WHERE id=?').run(amt, party.legacy_id);
    }
    // person_ledger FKs to persons(id) — only when a legacy persons row exists
    if (party.legacy_table === 'persons' && party.legacy_id) {
      const { createPersonLedgerEntry } = require('../db');
      createPersonLedgerEntry(db, {
        person_id: party.legacy_id, date: date || todayJalali(), entry_type: 'opening',
        ref_type: 'opening_balance', ref_id: entryId,
        description: description || 'مانده اول دوره', debit, credit, user_id: userId,
      });
    }
  } catch (e) {
    if (db.inTransaction) throw e;
  }
  return entryId;
}

/**
 * Beginning inventory JE when a product is created with opening stock + cost.
 * Dr inventory / Cr opening_balance
 */
function postProductOpeningInventory(db, {
  productId, qty, unitCostRial, date, userId, description, srcSystem,
}) {
  const q = Math.max(0, Math.trunc(Number(qty) || 0));
  const unit = Math.max(0, Math.round(Number(unitCostRial) || 0));
  if (!q || !unit) return null;
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!product) return null;

  const totalRial = q * unit;
  const inventory = acct(db, 'coa_inventory');
  const opening = acct(db, 'coa_opening_balance');
  const amtToman = rialToLedger(totalRial);

  return postToLedger(db, {
    sourceType: 'opening_inventory',
    sourceId: productId,
    date: date || todayJalali(),
    description: description || `موجودی اول دوره — ${product.name || productId} × ${q}`,
    createdBy: userId,
    voucherType: 'opening',
    srcSystem: srcSystem || null,
    lines: [
      { code: inventory.code, name: inventory.name, debit: amtToman, credit: 0 },
      { code: opening.code, name: opening.name, debit: 0, credit: amtToman },
    ],
  });
}

module.exports = {
  postPartyOpeningBalance,
  postProductOpeningInventory,
  controlAccountForParty,
  parseRoles,
};
