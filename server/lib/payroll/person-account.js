'use strict';
/**
 * Employee net-pay must hit the person's leaf tafsili (same as manual vouchers),
 * not only the 2104/1106 control. Control is the fallback when no leaf exists.
 */
const { acct } = require('../coa-map');

function loadCoa(db, code) {
  if (!code) return null;
  const row = db.prepare('SELECT code, name, type FROM chart_of_accounts WHERE code=?').get(String(code));
  return row || null;
}

function controlPayableCodes(db) {
  const codes = new Set();
  for (const key of ['coa_payroll_payable', 'coa_misc_persons']) {
    try {
      const a = acct(db, key);
      if (a && a.code) codes.add(String(a.code));
    } catch (_) { /* mapping optional on incomplete charts */ }
  }
  return codes;
}

function resolvePersonPayableAccount(db, person) {
  if (person) {
    const fromPerson = loadCoa(db, person.coa_code);
    if (fromPerson) return fromPerson;
    if (person.party_id) {
      const party = db.prepare('SELECT coa_code FROM parties WHERE id=?').get(person.party_id);
      const fromParty = loadCoa(db, party && party.coa_code);
      if (fromParty) return fromParty;
    }
  }
  try {
    return acct(db, 'coa_payroll_payable');
  } catch (_) {
    return acct(db, 'coa_misc_persons');
  }
}

module.exports = {
  loadCoa,
  controlPayableCodes,
  resolvePersonPayableAccount,
};
