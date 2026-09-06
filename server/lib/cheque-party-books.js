'use strict';
/**
 * Cheque received from a party must hit that party's books at registration
 * (Dr notes receivable / Cr customer or person tafsili + mirror ledgers).
 * Clear/send-to-bank stay asset conversions; they only backfill if register
 * never posted (legacy rows).
 */
const { postToLedger } = require('./ledger');
const { acct } = require('./coa-map');
const { todayJalali } = require('../jalali');

const OPENING_NOTE = 'مانده اول دوره';

function isOpeningCheque(row) {
  const note = String((row && row.note) || '');
  const status = String((row && row.status) || '');
  return !!(row && (note.includes(OPENING_NOTE) || status.includes('اول دوره')));
}

function chequeAmountRial(row) {
  const amountRial = Math.round(Number(row && row.amount) || 0);
  if (amountRial <= 0) {
    const err = new Error('مبلغ چک نامعتبر است');
    err.status = 400;
    throw err;
  }
  return amountRial;
}

function findLinkedPersonId(db, partyId) {
  if (!partyId) return null;
  try {
    const row = db.prepare('SELECT id FROM persons WHERE party_id=?').get(partyId);
    return row ? Number(row.id) : null;
  } catch (_) {
    return null;
  }
}

function findCustomerId(db, { partyId, customerId }) {
  if (customerId) return Number(customerId);
  if (!partyId) return null;
  try {
    const byParty = db.prepare('SELECT id FROM customers WHERE party_id=?').get(partyId);
    if (byParty) return Number(byParty.id);
  } catch (_) { /* optional */ }
  try {
    const party = db.prepare('SELECT legacy_table, legacy_id FROM parties WHERE id=?').get(partyId);
    if (party && party.legacy_table === 'customers' && party.legacy_id) {
      return Number(party.legacy_id);
    }
  } catch (_) { /* optional */ }
  return null;
}

function resolveChequeInCredit(db, { partyId, customerId }) {
  const cid = findCustomerId(db, { partyId, customerId });
  if (cid) {
    const { receivableAcct } = require('./customer-books');
    return {
      creditAcct: receivableAcct(db, cid),
      customerId: cid,
      personId: findLinkedPersonId(db, partyId),
    };
  }
  let person = null;
  if (partyId) {
    try {
      person = db.prepare('SELECT id, coa_code FROM persons WHERE party_id=?').get(partyId);
    } catch (_) { person = null; }
  }
  if (person && person.coa_code) {
    const a = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(person.coa_code);
    if (a) {
      return { creditAcct: a, customerId: null, personId: Number(person.id) };
    }
  }
  if (partyId) {
    try {
      const p = db.prepare('SELECT coa_code FROM parties WHERE id=?').get(partyId);
      if (p && p.coa_code) {
        const a = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(p.coa_code);
        if (a) {
          return {
            creditAcct: a,
            customerId: null,
            personId: person ? Number(person.id) : findLinkedPersonId(db, partyId),
          };
        }
      }
    } catch (_) { /* optional */ }
  }
  return {
    creditAcct: acct(db, 'coa_receivable'),
    customerId: null,
    personId: person ? Number(person.id) : findLinkedPersonId(db, partyId),
  };
}

function postChequePartyBooks(db, {
  chequeId, customerId, personId, date, description, amountRial, userId, refType,
}) {
  const rial = Math.round(Number(amountRial) || 0);
  if (!(rial > 0) || !chequeId) return;
  if (customerId) {
    const exists = db.prepare(`
      SELECT 1 FROM customer_ledger
      WHERE ref_type=? AND ref_id=? AND customer_id=? AND entry_type<>'reversal'
      LIMIT 1
    `).get(refType, chequeId, customerId);
    if (!exists) {
      const { createLedgerEntry } = require('../db');
      createLedgerEntry(db, {
        customer_id: customerId,
        date: date || '',
        entry_type: 'cheque',
        ref_type: refType,
        ref_id: chequeId,
        description: description || '',
        debit: 0,
        credit: rial,
        user_id: userId || null,
      });
    }
  }
  if (personId) {
    let exists = null;
    try {
      exists = db.prepare(`
        SELECT 1 FROM person_ledger
        WHERE ref_type=? AND ref_id=? AND person_id=? AND COALESCE(entry_type,'')<>'reversal'
        LIMIT 1
      `).get(refType, chequeId, personId);
    } catch (_) { exists = null; }
    if (!exists) {
      const { createPersonLedgerEntry } = require('../db');
      createPersonLedgerEntry(db, {
        person_id: personId,
        date: date || '',
        entry_type: 'cheque',
        ref_type: refType,
        ref_id: chequeId,
        description: description || '',
        debit: 0,
        credit: rial,
        user_id: userId || null,
      });
    }
  }
}

function existingChequeInJe(db, chequeId) {
  return db.prepare(`
    SELECT id FROM journal_entries
    WHERE ref_type='cheque_in' AND ref_id=? AND COALESCE(deleted_at,0)=0
      AND COALESCE(status,'posted') NOT IN ('reversed','void')
    LIMIT 1
  `).get(chequeId);
}

/**
 * Post (or backfill) the party-credit JE + ledgers for a receivable cheque.
 * Idempotent. Opening cheques only get ledger mirrors (JE already exists).
 */
function postChequeInReceipt(db, row, userId, date) {
  if (!row || row.direction !== 'in') return null;
  const amountRial = chequeAmountRial(row);
  const credit = resolveChequeInCredit(db, {
    partyId: row.party_id,
    customerId: row.customer_id,
  });
  const when = date || row.receive_date || row.issue_date || todayJalali();
  const desc = `${isOpeningCheque(row) ? 'چک اول دوره' : 'ثبت چک'} ${row.cheque_number || row.id}`;

  if (isOpeningCheque(row)) {
    postChequePartyBooks(db, {
      chequeId: row.id,
      customerId: credit.customerId,
      personId: credit.personId,
      date: when,
      description: desc,
      amountRial,
      userId,
      refType: 'cheque_in',
    });
    return row.journal_entry_id || null;
  }

  const existing = existingChequeInJe(db, row.id);
  if (existing) {
    postChequePartyBooks(db, {
      chequeId: row.id,
      customerId: credit.customerId,
      personId: credit.personId,
      date: when,
      description: desc,
      amountRial,
      userId,
      refType: 'cheque_in',
    });
    return existing.id;
  }

  const notes = acct(db, 'coa_cheques_receivable');
  const amt = amountRial / 10;
  const jeId = postToLedger(db, {
    sourceType: 'cheque_in',
    sourceId: row.id,
    date: when,
    description: `${desc}${row.party_name ? ' — ' + row.party_name : ''}`,
    createdBy: userId,
    lines: [
      { code: notes.code, name: notes.name, debit: amt, credit: 0, debit_rial: amountRial },
      {
        code: credit.creditAcct.code,
        name: credit.creditAcct.name,
        debit: 0,
        credit: amt,
        credit_rial: amountRial,
      },
    ],
  });
  postChequePartyBooks(db, {
    chequeId: row.id,
    customerId: credit.customerId,
    personId: credit.personId,
    date: when,
    description: desc,
    amountRial,
    userId,
    refType: 'cheque_in',
  });
  if (!row.journal_entry_id) {
    try {
      db.prepare('UPDATE cheque_records SET journal_entry_id=? WHERE id=? AND journal_entry_id IS NULL')
        .run(jeId, row.id);
    } catch (_) { /* column always present in current schema */ }
  }
  return jeId;
}

function bounceContraAccount(db, row) {
  if (row && row.lifecycle_status === 'in_collection') {
    return acct(db, 'coa_cheques_in_collection');
  }
  const bankId = row && row.collection_bank_id;
  if (bankId) {
    const b = db.prepare('SELECT coa_code, name FROM banks WHERE id=?').get(bankId);
    if (b && b.coa_code) return { code: b.coa_code, name: b.name };
  }
  return acct(db, 'coa_bank_default');
}

function postChequeBounceBooks(db, {
  chequeId, customerId, personId, date, description, amountRial, userId,
}) {
  const rial = Math.round(Number(amountRial) || 0);
  if (!(rial > 0) || !chequeId) return;
  if (customerId) {
    const exists = db.prepare(`
      SELECT 1 FROM customer_ledger
      WHERE ref_type='cheque_bounce' AND ref_id=? AND customer_id=? AND entry_type<>'reversal'
      LIMIT 1
    `).get(chequeId, customerId);
    if (!exists) {
      const { createLedgerEntry } = require('../db');
      createLedgerEntry(db, {
        customer_id: customerId,
        date: date || '',
        entry_type: 'cheque',
        ref_type: 'cheque_bounce',
        ref_id: chequeId,
        description: description || '',
        debit: rial,
        credit: 0,
        user_id: userId || null,
      });
    }
  }
  if (personId) {
    let exists = null;
    try {
      exists = db.prepare(`
        SELECT 1 FROM person_ledger
        WHERE ref_type='cheque_bounce' AND ref_id=? AND person_id=? AND COALESCE(entry_type,'')<>'reversal'
        LIMIT 1
      `).get(chequeId, personId);
    } catch (_) { exists = null; }
    if (!exists) {
      const { createPersonLedgerEntry } = require('../db');
      createPersonLedgerEntry(db, {
        person_id: personId,
        date: date || '',
        entry_type: 'cheque',
        ref_type: 'cheque_bounce',
        ref_id: chequeId,
        description: description || '',
        debit: rial,
        credit: 0,
        user_id: userId || null,
      });
    }
  }
}

function reverseChequeLedgerByRef(db, { chequeId, refTypes, date, userId, descriptionPrefix }) {
  const types = Array.isArray(refTypes) ? refTypes : [refTypes];
  if (!chequeId || !types.length) return;
  const { createLedgerEntry } = require('../db');
  const originals = db.prepare(`
    SELECT * FROM customer_ledger
    WHERE ref_type IN (${types.map(() => '?').join(',')}) AND ref_id=? AND entry_type<>'reversal'
  `).all(...types, chequeId);
  for (const led of originals) {
    const rev = db.prepare(`
      SELECT 1 FROM customer_ledger
      WHERE ref_type=? AND ref_id=? AND customer_id=? AND entry_type='reversal'
      LIMIT 1
    `).get(led.ref_type, chequeId, led.customer_id);
    if (rev) continue;
    createLedgerEntry(db, {
      customer_id: led.customer_id,
      date: date || todayJalali(),
      entry_type: 'reversal',
      ref_type: led.ref_type,
      ref_id: chequeId,
      description: `${descriptionPrefix || 'ابطال'} ${led.ref_type}`,
      debit: led.credit || 0,
      credit: led.debit || 0,
      user_id: userId || null,
    });
  }
  try {
    const { createPersonLedgerEntry } = require('../db');
    const personRows = db.prepare(`
      SELECT * FROM person_ledger
      WHERE ref_type IN (${types.map(() => '?').join(',')}) AND ref_id=?
        AND COALESCE(entry_type,'')<>'reversal'
    `).all(...types, chequeId);
    for (const led of personRows) {
      const rev = db.prepare(`
        SELECT 1 FROM person_ledger
        WHERE ref_type=? AND ref_id=? AND person_id=? AND entry_type='reversal'
        LIMIT 1
      `).get(led.ref_type, chequeId, led.person_id);
      if (rev) continue;
      createPersonLedgerEntry(db, {
        person_id: led.person_id,
        date: date || todayJalali(),
        entry_type: 'reversal',
        ref_type: led.ref_type,
        ref_id: chequeId,
        description: `${descriptionPrefix || 'ابطال'} چک`,
        debit: led.credit || 0,
        credit: led.debit || 0,
        user_id: userId || null,
      });
    }
  } catch (_) { /* person_ledger optional on older DBs */ }
}

/**
 * Bounce a receivable cheque: restore party AR (Dr tafsili) and reverse
 * the in-collection or bank asset. Opening cheques never credited customer
 * GL at register, so this is the line that appears on the statement.
 */
function postChequeBounce(db, row, userId, date) {
  if (!row || row.direction !== 'in') {
    const err = new Error('چک دریافتنی یافت نشد');
    err.status = 404;
    throw err;
  }
  const amountRial = chequeAmountRial(row);
  const party = resolveChequeInCredit(db, {
    partyId: row.party_id,
    customerId: row.customer_id,
  });
  const contra = bounceContraAccount(db, row);
  const amt = amountRial / 10;
  const when = date || todayJalali();
  const desc = `برگشت چک${isOpeningCheque(row) ? ' اول دوره' : ''} ${row.cheque_number || row.id}`;
  const jeId = postToLedger(db, {
    sourceType: 'cheque_bounce',
    sourceId: row.id,
    date: when,
    description: `${desc}${row.party_name ? ' — ' + row.party_name : ''}`,
    createdBy: userId,
    lines: [
      {
        code: party.creditAcct.code,
        name: party.creditAcct.name,
        debit: amt,
        credit: 0,
        debit_rial: amountRial,
      },
      {
        code: contra.code,
        name: contra.name,
        debit: 0,
        credit: amt,
        credit_rial: amountRial,
      },
    ],
  });
  postChequeBounceBooks(db, {
    chequeId: row.id,
    customerId: party.customerId,
    personId: party.personId,
    date: when,
    description: desc,
    amountRial,
    userId,
  });
  return jeId;
}

module.exports = {
  OPENING_NOTE,
  isOpeningCheque,
  chequeAmountRial,
  resolveChequeInCredit,
  postChequePartyBooks,
  postChequeInReceipt,
  bounceContraAccount,
  postChequeBounceBooks,
  reverseChequeLedgerByRef,
  postChequeBounce,
};
