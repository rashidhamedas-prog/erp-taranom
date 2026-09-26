/**
 * Live signed balances for unified parties (اطلاعات اشخاص).
 * Positive = بدهکار (owes us), negative = بستانکار (we owe them). Amounts in rial.
 */
'use strict';

const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('./money');

const JE_ALIVE = `COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'posted') NOT IN ('reversed','void')`;

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch (_) {
    return false;
  }
}

/**
 * @returns {Map<number, number>} party_id → signed balance (rial)
 */
function partySignedBalanceMap(db) {
  const map = new Map();
  const fromSubledger = new Set();

  if (!tableExists(db, 'parties')) return map;

  for (const r of db.prepare('SELECT id, opening_balance FROM parties').all()) {
    map.set(Number(r.id), Math.round(Number(r.opening_balance) || 0));
  }

  // Legacy person_ledger via persons.party_id
  if (tableExists(db, 'person_ledger') && tableExists(db, 'persons')) {
    try {
      const rows = db.prepare(`
        SELECT pe.party_id AS party_id,
          COALESCE(SUM(pl.debit) - SUM(pl.credit), 0) AS bal
        FROM person_ledger pl
        JOIN persons pe ON pe.id = pl.person_id
        WHERE pe.party_id IS NOT NULL
        GROUP BY pe.party_id
      `).all();
      for (const r of rows) {
        const pid = Number(r.party_id);
        if (!Number.isFinite(pid)) continue;
        map.set(pid, Math.round(Number(r.bal) || 0));
        fromSubledger.add(pid);
      }
    } catch (_) { /* optional */ }
  }

  // Customer sub-ledger via customers.party_id
  if (tableExists(db, 'customer_ledger') && tableExists(db, 'customers')) {
    try {
      const rows = db.prepare(`
        SELECT c.party_id AS party_id,
          COALESCE(SUM(cl.debit) - SUM(cl.credit), 0) AS bal
        FROM customer_ledger cl
        JOIN customers c ON c.id = cl.customer_id
        WHERE c.party_id IS NOT NULL
        GROUP BY c.party_id
      `).all();
      for (const r of rows) {
        const pid = Number(r.party_id);
        if (!Number.isFinite(pid)) continue;
        map.set(pid, Math.round(Number(r.bal) || 0));
        fromSubledger.add(pid);
      }
    } catch (_) { /* optional */ }
  }

  // Supplier payable → credit nature (negative signed)
  if (tableExists(db, 'suppliers')) {
    try {
      const rows = db.prepare(`
        SELECT s.party_id AS party_id,
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
          map.set(pid, -payable);
          fromSubledger.add(pid);
        }
      }
    } catch (_) { /* optional */ }
  }

  // GL replaces the subledger only when there is no subledger, or the two agree.
  // A freshly allocated tafsili must not hide person/customer history.
  try {
    const glRows = db.prepare(`
      SELECT p.id AS party_id,
        COALESCE(SUM(${SQL_JL_DEBIT_RIAL}), 0) - COALESCE(SUM(${SQL_JL_CREDIT_RIAL}), 0) AS signed
      FROM parties p
      JOIN journal_lines jl ON jl.account_code = p.coa_code
      JOIN journal_entries je ON je.id = jl.entry_id
      WHERE p.coa_code IS NOT NULL AND TRIM(p.coa_code) <> ''
        AND ${JE_ALIVE}
      GROUP BY p.id
    `).all();
    for (const r of glRows) {
      const pid = Number(r.party_id);
      const glSigned = Math.round(Number(r.signed) || 0);
      const cur = map.has(pid) ? map.get(pid) : 0;
      if (!fromSubledger.has(pid) || Math.abs(cur - glSigned) <= 1) {
        map.set(pid, glSigned);
      }
    }
  } catch (_) { /* optional */ }

  return map;
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

module.exports = { partySignedBalanceMap, applyPartyBalances };
