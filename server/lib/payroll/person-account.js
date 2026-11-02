'use strict';
/**
 * Employee net-pay must hit the person's leaf tafsili (same as manual vouchers),
 * not only the 2104/1106 control. Control is the fallback when no leaf exists.
 */
const { acct, allocTafsili } = require('../coa-map');

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

/* ───────── P5: production wage credit by person role ───────── */

const EMPLOYEE_EMPLOYMENT_TYPES = new Set(['monthly', 'daily', 'hourly']);

/**
 * Wage credits may only land on a liability. 1103 (customer AR) and 1106
 * (misc persons) leaves are assets even when they belong to the worker.
 * @returns {'asset'|'payable'|'other'|'missing'}
 */
function wageAccountClass(row) {
  if (!row || !row.code) return 'missing';
  const code = String(row.code);
  const type = String(row.type || '').trim().toLowerCase();
  if (type === 'asset' || code.startsWith('1103') || code.startsWith('1106')) return 'asset';
  if (!type && code.startsWith('1')) return 'asset';
  if (type === 'liability' || (!type && code.startsWith('2'))) return 'payable';
  return 'other';
}

function hasRowsForPerson(db, table, personId) {
  try {
    return !!db.prepare(`SELECT 1 FROM ${table} WHERE person_id=? LIMIT 1`).get(personId);
  } catch (_) {
    return false;
  }
}

function hasPersonColumn(db, col) {
  try {
    return db.prepare('PRAGMA table_info(persons)').all().some((c) => c.name === col);
  } catch (_) {
    return false;
  }
}

/**
 * employee = salaried staff registered in payroll (employment_type monthly/daily/hourly,
 * or any payroll/salary-structure history, or a monthly salary on file).
 * contractor = employment_type 'contractor', or no employment evidence at all
 * (flagged: the party role «employee» alone is not evidence — piece workers carry it too).
 */
function classifyLaborPersonRole(db, person) {
  if (!person) return { role: 'contractor', reason: 'no_person', flagged: true };
  const et = String(person.employment_type || '').trim().toLowerCase();
  if (et === 'contractor') return { role: 'contractor', reason: 'employment_type_contractor', flagged: false };
  if (EMPLOYEE_EMPLOYMENT_TYPES.has(et)) return { role: 'employee', reason: `employment_type_${et}`, flagged: false };
  const pid = Number(person.id);
  if (pid && (hasRowsForPerson(db, 'payroll_records', pid) || hasRowsForPerson(db, 'salary_structures', pid))) {
    return { role: 'employee', reason: 'payroll_history', flagged: false };
  }
  if (Math.round(Number(person.monthly_salary_rial) || 0) > 0) {
    return { role: 'employee', reason: 'monthly_salary', flagged: false };
  }
  return { role: 'contractor', reason: 'role_unknown_default_contractor', flagged: true };
}

function personDetailAccountId(db, person) {
  if (!person) return null;
  if (person.detail_account_id) return Number(person.detail_account_id) || null;
  try {
    const row = db.prepare(`
      SELECT id FROM detail_accounts
      WHERE linked_table='persons' AND linked_id=? AND COALESCE(is_active,1)=1
      ORDER BY id LIMIT 1
    `).get(person.id);
    return row ? row.id : null;
  } catch (_) {
    return null;
  }
}

function resolveEmployeeWagePayable(db, person) {
  const ctrl = acct(db, 'coa_payroll_payable');
  const own = loadCoa(db, person.coa_code);
  if (own && wageAccountClass(own) === 'payable' && String(own.code).startsWith(String(ctrl.code))) {
    return { account: own, reason: 'employee_own_payroll_leaf' };
  }
  return { account: loadCoa(db, ctrl.code) || ctrl, reason: 'employee_payroll_payable_control' };
}

function resolveContractorWagePayable(db, person, { allocate }) {
  const isPayable = (row) => wageAccountClass(row) === 'payable';
  const own = loadCoa(db, person.coa_code);
  if (isPayable(own)) return { account: own, reason: 'contractor_own_payable' };

  const canStore = hasPersonColumn(db, 'labor_payable_coa_code');
  const stored = canStore ? loadCoa(db, person.labor_payable_coa_code) : null;
  if (isPayable(stored)) return { account: stored, reason: 'contractor_labor_payable_leaf' };

  if (person.party_id) {
    const party = db.prepare('SELECT coa_code FROM parties WHERE id=?').get(person.party_id);
    const fromParty = loadCoa(db, party && party.coa_code);
    if (isPayable(fromParty)) return { account: fromParty, reason: 'contractor_party_payable' };

    const supplier = db.prepare('SELECT id, coa_code FROM suppliers WHERE party_id=? ORDER BY id LIMIT 1')
      .get(person.party_id);
    if (supplier) {
      const existing = loadCoa(db, supplier.coa_code);
      if (isPayable(existing)) return { account: existing, reason: 'contractor_supplier_payable' };
      if (allocate) {
        const { ensureSupplierTafsili } = require('../party-tafsili');
        const leaf = loadCoa(db, ensureSupplierTafsili(db, supplier.id));
        if (isPayable(leaf)) return { account: leaf, reason: 'contractor_supplier_payable' };
      }
    }
  }

  if (allocate && canStore) {
    const code = allocTafsili(db, 'supplier', person.name || `شخص ${person.id}`);
    const leaf = loadCoa(db, code);
    if (isPayable(leaf)) {
      db.prepare('UPDATE persons SET labor_payable_coa_code=? WHERE id=?').run(leaf.code, person.id);
      return { account: leaf, reason: 'contractor_new_payable_leaf' };
    }
  }

  const ctrl = acct(db, 'coa_payable');
  return { account: loadCoa(db, ctrl.code) || ctrl, reason: 'contractor_payable_control' };
}

function laborPayableErr(code, extra) {
  const e = new Error(code);
  e.code = code;
  e.status = 422;
  e.extra = extra || {};
  return e;
}

/**
 * Which account a piece/hourly production wage is credited to.
 * employee → coa_payroll_payable (or the person's own leaf under it);
 * contractor → the person's own AP leaf (person/party/supplier, else a new leaf
 * under coa_payable stored on persons.labor_payable_coa_code).
 * Never returns an asset account (throws E_LABOR_PAYABLE_ASSET on a misconfigured key).
 * `allocate:false` (dry-run/preview) never writes to the chart.
 * @returns {{ account_code, account_name, detail_account_id, role, role_reason, reason,
 *   flagged:boolean, legacy_code:string|null, legacy_rejected:boolean }}
 */
function resolveLaborPayableForPerson(db, person, { allocate = true } = {}) {
  if (!person) throw laborPayableErr('E_PERSON_MISSING');
  const roleInfo = classifyLaborPersonRole(db, person);
  const legacy = resolvePersonPayableAccount(db, person);
  const res = roleInfo.role === 'employee'
    ? resolveEmployeeWagePayable(db, person)
    : resolveContractorWagePayable(db, person, { allocate });
  const account = res.account;
  if (!account || !account.code) throw laborPayableErr('E_PERSON_NO_COA', { person_id: person.id });
  if (wageAccountClass(account) === 'asset') {
    throw laborPayableErr('E_LABOR_PAYABLE_ASSET', { person_id: person.id, account_code: account.code });
  }
  const legacyRejected = !!(legacy && legacy.code && String(legacy.code) !== String(account.code)
    && wageAccountClass(legacy) === 'asset');
  if (roleInfo.flagged || legacyRejected) {
    try {
      console.warn('[labor-payable]', JSON.stringify({
        person_id: person.id,
        role: roleInfo.role,
        role_reason: roleInfo.reason,
        account_code: String(account.code),
        legacy_code: legacy && legacy.code ? String(legacy.code) : null,
        legacy_rejected: legacyRejected,
      }));
    } catch (_) { /* logging only */ }
  }
  return {
    account_code: String(account.code),
    account_name: account.name || '',
    detail_account_id: personDetailAccountId(db, person),
    role: roleInfo.role,
    role_reason: roleInfo.reason,
    reason: res.reason,
    flagged: !!roleInfo.flagged,
    legacy_code: legacy && legacy.code ? String(legacy.code) : null,
    legacy_rejected: legacyRejected,
  };
}

module.exports = {
  loadCoa,
  controlPayableCodes,
  resolvePersonPayableAccount,
  wageAccountClass,
  classifyLaborPersonRole,
  resolveLaborPayableForPerson,
};
