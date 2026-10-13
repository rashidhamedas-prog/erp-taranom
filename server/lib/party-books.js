/**
 * Live signed balances for unified parties (اطلاعات اشخاص).
 * Positive = بدهکار (owes us), negative = بستانکار (we owe them). Amounts in rial.
 *
 * SoT rule (ADR-PARTY-001): subledger first; GL only if absent or |Δ|≤1.
 * Detail map also returns which leaf (coa_code) the balance came from so
 * «اختلاف دفتر» compares the same leaf — dual-role AR/AP must not false-flag.
 */
'use strict';

const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('./money');
const { personLedgerLineRial, personLedgerAliveSql } = require('./person-ledger-money');

const JE_ALIVE = `COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'posted') NOT IN ('reversed','void')`;

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch (_) {
    return false;
  }
}

function setDetail(map, fromSub, pid, balance, source, coaCode) {
  if (!Number.isFinite(pid)) return;
  map.set(pid, {
    balance: Math.round(Number(balance) || 0),
    source: source || 'opening',
    coa_code: coaCode ? String(coaCode) : null,
  });
  if (source && source !== 'opening' && source !== 'gl') fromSub.add(pid);
}

/**
 * @returns {Map<number, { balance:number, source:string, coa_code:string|null }>}
 */
function partySignedBalanceDetailMap(db) {
  const map = new Map();
  const fromSubledger = new Set();

  if (!tableExists(db, 'parties')) return map;

  const partyCoa = new Map();
  for (const r of db.prepare('SELECT id, opening_balance, coa_code FROM parties').all()) {
    const pid = Number(r.id);
    partyCoa.set(pid, r.coa_code || null);
    setDetail(map, fromSubledger, pid, r.opening_balance, 'opening', r.coa_code);
  }

  // Legacy person_ledger via persons.party_id — convert toman payroll rows to rial
  if (tableExists(db, 'person_ledger') && tableExists(db, 'persons')) {
    try {
      const alive = personLedgerAliveSql(db);
      const rows = db.prepare(`
        SELECT pe.party_id AS party_id, pe.coa_code AS person_coa,
               pl.debit, pl.credit, pl.ref_type, pl.ref_id
        FROM person_ledger pl
        JOIN persons pe ON pe.id = pl.person_id
        WHERE pe.party_id IS NOT NULL AND ${alive}
      `).all();
      const plBal = new Map();
      const plCoa = new Map();
      for (const r of rows) {
        const pid = Number(r.party_id);
        if (!Number.isFinite(pid)) continue;
        const amt = personLedgerLineRial(db, r);
        plBal.set(pid, (plBal.get(pid) || 0) + amt.debit - amt.credit);
        if (!plCoa.has(pid)) {
          plCoa.set(pid, r.person_coa || partyCoa.get(pid) || null);
        }
      }
      for (const [pid, bal] of plBal) {
        setDetail(map, fromSubledger, pid, bal, 'person', plCoa.get(pid) || partyCoa.get(pid));
      }
    } catch (_) { /* optional */ }
  }

  // Customer sub-ledger via customers.party_id
  if (tableExists(db, 'customer_ledger') && tableExists(db, 'customers')) {
    try {
      const rows = db.prepare(`
        SELECT c.party_id AS party_id, c.coa_code AS cust_coa,
          COALESCE(SUM(cl.debit) - SUM(cl.credit), 0) AS bal
        FROM customer_ledger cl
        JOIN customers c ON c.id = cl.customer_id
        WHERE c.party_id IS NOT NULL
        GROUP BY c.party_id
      `).all();
      for (const r of rows) {
        const pid = Number(r.party_id);
        if (!Number.isFinite(pid)) continue;
        setDetail(
          map, fromSubledger, pid, r.bal, 'customer',
          r.cust_coa || partyCoa.get(pid) || null
        );
      }
    } catch (_) { /* optional */ }
  }

  // Supplier payable → credit nature (negative signed); compare to supplier leaf
  if (tableExists(db, 'suppliers')) {
    try {
      const rows = db.prepare(`
        SELECT s.party_id AS party_id, s.coa_code AS sup_coa,
          COALESCE(s.balance, 0)
            + COALESCE(pi.total_purchased, 0)
            - COALESCE(sp.total_paid, 0)
            - COALESCE(pr.total_returned, 0) AS payable
        FROM suppliers s
        LEFT JOIN (
          SELECT supplier_id, SUM(final) AS total_purchased
          FROM purchase_invoices WHERE pay_type='credit' GROUP BY supplier_id
        ) pi ON pi.supplier_id = s.id
        LEFT JOIN (
          SELECT supplier_id, SUM(amount) AS total_paid
          FROM supplier_payments GROUP BY supplier_id
        ) sp ON sp.supplier_id = s.id
        LEFT JOIN (
          SELECT supplier_id, SUM(amount) AS total_returned
          FROM purchase_returns GROUP BY supplier_id
        ) pr ON pr.supplier_id = s.id
        WHERE s.party_id IS NOT NULL
      `).all();
      for (const r of rows) {
        const pid = Number(r.party_id);
        if (!Number.isFinite(pid)) continue;
        const payable = Math.round(Number(r.payable) || 0);
        if (payable !== 0) {
          setDetail(
            map, fromSubledger, pid, -payable, 'supplier',
            r.sup_coa || partyCoa.get(pid) || null
          );
        }
      }
    } catch (_) { /* optional */ }
  }

  // GL replaces the subledger only when there is no subledger, or the two agree on the SAME leaf.
  try {
    const glByCode = new Map();
    const glRows = db.prepare(`
      SELECT jl.account_code AS code,
        COALESCE(SUM(${SQL_JL_DEBIT_RIAL}), 0) - COALESCE(SUM(${SQL_JL_CREDIT_RIAL}), 0) AS signed
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      WHERE ${JE_ALIVE}
      GROUP BY jl.account_code
    `).all();
    for (const r of glRows) {
      glByCode.set(String(r.code), Math.round(Number(r.signed) || 0));
    }

    for (const [pid, cur] of [...map.entries()]) {
      const code = cur.coa_code || partyCoa.get(pid);
      if (!code || !glByCode.has(String(code))) continue;
      const glSigned = glByCode.get(String(code));
      if (!fromSubledger.has(pid) || Math.abs(cur.balance - glSigned) <= 1) {
        map.set(pid, {
          balance: glSigned,
          source: fromSubledger.has(pid) ? cur.source : 'gl',
          coa_code: code,
        });
      }
    }
  } catch (_) { /* optional */ }

  return map;
}

/**
 * @returns {Map<number, number>} party_id → signed balance (rial)
 */
function partySignedBalanceMap(db) {
  const detail = partySignedBalanceDetailMap(db);
  const map = new Map();
  for (const [pid, info] of detail) {
    map.set(pid, info.balance);
  }
  return map;
}

/** GL signed balance for one COA leaf (rial). null if no live lines. */
function glSignedForCoa(db, coaCode) {
  const code = String(coaCode || '').trim();
  if (!code || !tableExists(db, 'journal_lines')) return null;
  try {
    const row = db.prepare(`
      SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL}), 0) - COALESCE(SUM(${SQL_JL_CREDIT_RIAL}), 0) AS signed,
             COUNT(*) AS n
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.account_code = ? AND ${JE_ALIVE}
    `).get(code);
    if (!row || !row.n) return null;
    return Math.round(Number(row.signed) || 0);
  } catch (_) {
    return null;
  }
}

function applyPartyBalances(db, rows) {
  if (!rows || !rows.length) return rows;
  const map = partySignedBalanceMap(db);
  for (const r of rows) {
    if (!r || r.id == null) continue;
    const id = Number(r.id);
    if (map.has(id)) {
      r.balance = map.get(id);
      r.balance_source = 'live';
    } else {
      r.balance = Math.round(Number(r.opening_balance) || 0);
      r.balance_source = 'opening';
    }
  }
  return rows;
}

module.exports = {
  partySignedBalanceMap,
  partySignedBalanceDetailMap,
  glSignedForCoa,
  applyPartyBalances,
};
