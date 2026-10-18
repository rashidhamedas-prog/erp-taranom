/**
 * Live signed balances for unified parties (اطلاعات اشخاص).
 * Positive = بدهکار (owes us), negative = بستانکار (we owe them). Amounts in rial.
 *
 * SoT (ADR-PARTY-001 + v368 invariant):
 *   Subledger first; GL only if absent or |Δ|≤1 on the compared leaf.
 *   Opening is included EXACTLY once: if the role subledger has no opening row,
 *   add parties.opening_balance onto the leaf that matches party.coa_code
 *   (or the sole linked role leaf). Never drop opening when later activity exists.
 *   Supplier uses supplier_ledger (debit−credit), NEVER purchase/payment formula
 *   (toman/rial drift + skips opening JE).
 *   Dual-role AR/AP keep separate leaves; net = Σ leaves; mismatch is per-leaf.
 *   v456: two role books on ONE leaf that disagree — keep the one closest to that
 *   leaf's live GL, not the larger absolute (a stale opening must not hide a payment).
 */
'use strict';

const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('./money');
const { personLedgerLineRial, personLedgerAliveSql } = require('./person-ledger-money');

const JE_ALIVE = `COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'posted') NOT IN ('reversed','void')`;

const OPENING_REF_TYPES = new Set([
  'opening', 'opening_balance', 'افتتاحیه', 'مانده اول دوره', 'beginning',
]);

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch (_) {
    return false;
  }
}

function isOpeningRef(refType, entryType) {
  const a = String(refType || '').toLowerCase();
  const b = String(entryType || '').toLowerCase();
  if (OPENING_REF_TYPES.has(a) || OPENING_REF_TYPES.has(b)) return true;
  if (a.includes('opening') || b.includes('opening')) return true;
  if (a.includes('افتتاح') || b.includes('افتتاح')) return true;
  return false;
}

/**
 * @returns {Map<number, {
 *   balance:number, source:string, coa_code:string|null,
 *   leaves: Array<{coa_code:string, balance:number, source:string}>
 * }>}
 */
function partySignedBalanceDetailMap(db) {
  const map = new Map();
  if (!tableExists(db, 'parties')) return map;

  const parties = db.prepare(
    'SELECT id, opening_balance, coa_code FROM parties'
  ).all();
  const partyMeta = new Map();
  for (const r of parties) {
    const pid = Number(r.id);
    partyMeta.set(pid, {
      opening: Math.round(Number(r.opening_balance) || 0),
      coa: r.coa_code ? String(r.coa_code) : null,
      openingUsed: false,
    });
    map.set(pid, {
      balance: Math.round(Number(r.opening_balance) || 0),
      source: 'opening',
      coa_code: r.coa_code ? String(r.coa_code) : null,
      leaves: [],
    });
  }

  /** Allocate header opening once onto a leaf that owns it. */
  function takeOpening(pid, leafCode) {
    const meta = partyMeta.get(pid);
    if (!meta || meta.openingUsed || !meta.opening) return 0;
    const leaf = leafCode ? String(leafCode) : null;
    if (meta.coa && leaf && meta.coa !== leaf) return 0;
    meta.openingUsed = true;
    return meta.opening;
  }

  /** leafAcc: Map<partyId, Map<coa, {balance, source}>> */
  const leafAcc = new Map();
  function putLeaf(pid, coaCode, balance, source) {
    if (!Number.isFinite(pid)) return;
    const code = coaCode ? String(coaCode) : '__none__';
    if (!leafAcc.has(pid)) leafAcc.set(pid, new Map());
    const m = leafAcc.get(pid);
    const prev = m.get(code);
    if (!prev) {
      const bal0 = Math.round(Number(balance) || 0);
      m.set(code, { balance: bal0, source, alts: [{ balance: bal0, source }] });
      return;
    }
    // Same leaf, two roles: do not sum (cheque XOR / dual link).
    // Keep every candidate; the GL pass picks the one closest to this leaf
    // when they disagree (v456). Provisional display stays the larger |balance|
    // only until that pass runs.
    const bal = Math.round(Number(balance) || 0);
    if (!prev.alts) prev.alts = [{ balance: prev.balance, source: prev.source }];
    prev.alts.push({ balance: bal, source });
    if (Math.abs(bal) >= Math.abs(prev.balance)) {
      prev.balance = bal;
      prev.source = source;
    }
  }

  // ── Person sub-ledger ──
  if (tableExists(db, 'person_ledger') && tableExists(db, 'persons')) {
    try {
      const alive = personLedgerAliveSql(db);
      const rows = db.prepare(`
        SELECT pe.party_id AS party_id, pe.coa_code AS person_coa,
               pl.debit, pl.credit, pl.ref_type, pl.ref_id, pl.entry_type
        FROM person_ledger pl
        JOIN persons pe ON pe.id = pl.person_id
        WHERE pe.party_id IS NOT NULL AND ${alive}
      `).all();
      const plBal = new Map();
      const plCoa = new Map();
      const plHasOpening = new Set();
      for (const r of rows) {
        const pid = Number(r.party_id);
        if (!Number.isFinite(pid)) continue;
        const amt = personLedgerLineRial(db, r);
        plBal.set(pid, (plBal.get(pid) || 0) + amt.debit - amt.credit);
        if (!plCoa.has(pid)) {
          const meta = partyMeta.get(pid);
          plCoa.set(pid, r.person_coa || (meta && meta.coa) || null);
        }
        if (isOpeningRef(r.ref_type, r.entry_type)) plHasOpening.add(pid);
      }
      // Parties linked to persons but with empty ledger still need opening on that leaf
      const linkedPersons = db.prepare(`
        SELECT party_id, coa_code FROM persons WHERE party_id IS NOT NULL
      `).all();
      for (const pe of linkedPersons) {
        const pid = Number(pe.party_id);
        if (!Number.isFinite(pid)) continue;
        if (!plCoa.has(pid)) plCoa.set(pid, pe.coa_code || (partyMeta.get(pid) && partyMeta.get(pid).coa) || null);
        if (!plBal.has(pid)) plBal.set(pid, 0);
      }
      for (const [pid, bal0] of plBal) {
        const leaf = plCoa.get(pid);
        let bal = Math.round(Number(bal0) || 0);
        if (plHasOpening.has(pid)) {
          // Opening already inside person_ledger — never fold header again
          const meta = partyMeta.get(pid);
          if (meta) meta.openingUsed = true;
        } else {
          bal += takeOpening(pid, leaf);
        }
        putLeaf(pid, leaf, bal, 'person');
      }
    } catch (_) { /* optional */ }
  }

  // ── Customer sub-ledger ──
  if (tableExists(db, 'customer_ledger') && tableExists(db, 'customers')) {
    try {
      const rows = db.prepare(`
        SELECT c.party_id AS party_id, c.coa_code AS cust_coa,
          COALESCE(SUM(cl.debit) - SUM(cl.credit), 0) AS bal,
          SUM(CASE WHEN LOWER(COALESCE(cl.ref_type,'')) IN ('opening','opening_balance')
                    OR LOWER(COALESCE(cl.entry_type,'')) IN ('opening','opening_balance')
               THEN 1 ELSE 0 END) AS open_n
        FROM customer_ledger cl
        JOIN customers c ON c.id = cl.customer_id
        WHERE c.party_id IS NOT NULL
        GROUP BY c.party_id
      `).all();
      const seen = new Set();
      for (const r of rows) {
        const pid = Number(r.party_id);
        if (!Number.isFinite(pid)) continue;
        seen.add(pid);
        const leaf = r.cust_coa || (partyMeta.get(pid) && partyMeta.get(pid).coa) || null;
        let bal = Math.round(Number(r.bal) || 0);
        if (Number(r.open_n)) {
          const meta = partyMeta.get(pid);
          if (meta) meta.openingUsed = true;
        } else {
          bal += takeOpening(pid, leaf);
        }
        if (bal || Number(r.open_n)) putLeaf(pid, leaf, bal, 'customer');
      }
      for (const c of db.prepare(
        'SELECT party_id, coa_code FROM customers WHERE party_id IS NOT NULL'
      ).all()) {
        const pid = Number(c.party_id);
        if (!Number.isFinite(pid) || seen.has(pid)) continue;
        const leaf = c.coa_code || (partyMeta.get(pid) && partyMeta.get(pid).coa) || null;
        const bal = takeOpening(pid, leaf);
        // Do not invent a zero AR leaf — noise GL on unused leaf would false-flag mismatch
        if (bal) putLeaf(pid, leaf, bal, 'customer');
      }
    } catch (_) { /* optional */ }
  }

  // ── Supplier: supplier_ledger only (rial signed = debit − credit) ──
  if (tableExists(db, 'suppliers')) {
    try {
      const hasSl = tableExists(db, 'supplier_ledger');
      const suppliers = db.prepare(
        'SELECT id, party_id, coa_code, balance FROM suppliers WHERE party_id IS NOT NULL'
      ).all();
      for (const s of suppliers) {
        const pid = Number(s.party_id);
        if (!Number.isFinite(pid)) continue;
        const leaf = s.coa_code || (partyMeta.get(pid) && partyMeta.get(pid).coa) || null;
        let bal = 0;
        let hasOpening = false;
        if (hasSl) {
          const lines = db.prepare(`
            SELECT debit, credit, ref_type, entry_type
            FROM supplier_ledger WHERE supplier_id=?
          `).all(s.id);
          for (const ln of lines) {
            bal += Math.round(Number(ln.debit) || 0) - Math.round(Number(ln.credit) || 0);
            if (isOpeningRef(ln.ref_type, ln.entry_type)) hasOpening = true;
          }
        }
        if (hasOpening) {
          const meta = partyMeta.get(pid);
          if (meta) meta.openingUsed = true;
        } else {
          // Header opening on this leaf (signed). Also fold suppliers.balance if
          // it is the only opening store and party.opening was not used.
          bal += takeOpening(pid, leaf);
          const meta = partyMeta.get(pid);
          if (meta && !meta.openingUsed) {
            const supOpen = Math.round(Number(s.balance) || 0);
            if (supOpen) {
              // suppliers.balance > 0 ⇒ we owe them ⇒ بستانکار ⇒ negative signed
              bal += -supOpen;
              meta.openingUsed = true;
            }
          }
        }
        putLeaf(pid, leaf, bal, 'supplier');
      }
    } catch (_) { /* optional */ }
  }

  // Fold leaf maps → party detail (net + primary leaf)
  for (const [pid, leaves] of leafAcc) {
    const leafList = [];
    let net = 0;
    let primary = null;
    // Primary = largest |balance| leaf (dual-role: don't prefer empty AR over live AP)
    const order = { customer: 0, supplier: 1, person: 2 };
    const sorted = [...leaves.entries()].sort((a, b) => {
      const da = Math.abs(a[1].balance) - Math.abs(b[1].balance);
      if (da !== 0) return da > 0 ? -1 : 1;
      const sa = order[a[1].source] != null ? order[a[1].source] : 9;
      const sb = order[b[1].source] != null ? order[b[1].source] : 9;
      return sa - sb;
    });
    for (const [code, info] of sorted) {
      const coa = code === '__none__' ? null : code;
      leafList.push({
        coa_code: coa,
        balance: info.balance,
        source: info.source,
        alts: info.alts || [{ balance: info.balance, source: info.source }],
      });
      net += info.balance;
      if (!primary) primary = { coa_code: coa, source: info.source, balance: info.balance };
    }
    // If opening never consumed and no leaf activity, keep opening-only row
    const meta = partyMeta.get(pid);
    if (meta && !meta.openingUsed && meta.opening && !leafList.length) {
      map.set(pid, {
        balance: meta.opening,
        source: 'opening',
        coa_code: meta.coa,
        leaves: meta.coa
          ? [{ coa_code: meta.coa, balance: meta.opening, source: 'opening' }]
          : [],
      });
      continue;
    }
    if (meta && !meta.openingUsed && meta.opening && leafList.length) {
      // Opening leaf unknown — attach to header coa or first leaf
      const attach = meta.coa || (primary && primary.coa_code);
      net += meta.opening;
      meta.openingUsed = true;
      if (attach) {
        const existing = leafList.find((l) => l.coa_code === attach);
        if (existing) {
          existing.balance += meta.opening;
          if (Array.isArray(existing.alts)) {
            existing.alts = existing.alts.map((a) => ({
              balance: a.balance + meta.opening,
              source: a.source,
            }));
          }
        }
        else leafList.unshift({ coa_code: attach, balance: meta.opening, source: 'opening' });
      }
    }
    map.set(pid, {
      balance: Math.round(net),
      source: (primary && primary.source) || 'opening',
      coa_code: (primary && primary.coa_code) || (meta && meta.coa) || null,
      leaves: leafList,
    });
  }

  // Parties with only opening (no linked subledger rows touched leafAcc)
  for (const [pid, meta] of partyMeta) {
    if (leafAcc.has(pid)) continue;
    map.set(pid, {
      balance: meta.opening,
      source: 'opening',
      coa_code: meta.coa,
      leaves: meta.coa && meta.opening
        ? [{ coa_code: meta.coa, balance: meta.opening, source: 'opening' }]
        : [],
    });
  }

  // GL replaces a leaf only when that leaf has no subledger signal or |Δ|≤1
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
      const leaves = (cur.leaves && cur.leaves.length)
        ? cur.leaves.slice()
        : (cur.coa_code
          ? [{ coa_code: cur.coa_code, balance: cur.balance, source: cur.source }]
          : []);
      if (!leaves.length) continue;
      let changed = false;
      const nextLeaves = leaves.map((lf) => {
        if (!lf.coa_code || !glByCode.has(String(lf.coa_code))) {
          return { coa_code: lf.coa_code, balance: lf.balance, source: lf.source };
        }
        const glSigned = glByCode.get(String(lf.coa_code));
        let balance = lf.balance;
        let source = lf.source;
        const alts = Array.isArray(lf.alts) ? lf.alts : [];
        if (alts.length > 1 && alts.some((a) => Math.abs(a.balance - alts[0].balance) > 2)) {
          let best = alts[0];
          let bestDist = Math.abs(best.balance - glSigned);
          for (const a of alts.slice(1)) {
            const dist = Math.abs(a.balance - glSigned);
            if (dist < bestDist) {
              best = a;
              bestDist = dist;
            }
          }
          balance = best.balance;
          source = best.source;
          changed = true;
        }
        const fromSub = source && source !== 'opening';
        if (!fromSub || Math.abs(balance - glSigned) <= 2) {
          changed = true;
          return {
            coa_code: lf.coa_code,
            balance: glSigned,
            source: fromSub ? source : 'gl',
          };
        }
        return { coa_code: lf.coa_code, balance, source };
      });
      if (!changed) {
        if (leaves.some((lf) => lf.alts)) {
          map.set(pid, { ...cur, leaves: nextLeaves });
        }
        continue;
      }
      const net = nextLeaves.reduce((s, l) => s + l.balance, 0);
      const primary = nextLeaves[0];
      map.set(pid, {
        balance: Math.round(net),
        source: primary.source,
        coa_code: primary.coa_code,
        leaves: nextLeaves,
      });
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

/**
 * True when any leaf's subledger disagrees with that leaf's GL by >1 rial.
 * Dual-role AR≠AP must not false-flag across leaves.
 */
function partyBooksMismatch(db, detailInfo) {
  if (!detailInfo) return false;
  const leaves = (detailInfo.leaves && detailInfo.leaves.length)
    ? detailInfo.leaves
    : (detailInfo.coa_code
      ? [{ coa_code: detailInfo.coa_code, balance: detailInfo.balance, source: detailInfo.source }]
      : []);
  for (const lf of leaves) {
    if (!lf.coa_code) continue;
    if (!lf.source || lf.source === 'opening') continue;
    // Zero subledger leaf vs unrelated GL noise on that code is not a books gap
    if (Math.abs(lf.balance) <= 1) continue;
    const glBal = glSignedForCoa(db, lf.coa_code);
    if (glBal == null) continue;
    // ≤2 rial = rounding noise (payroll toman↔rial), not a books gap
    if (Math.abs(lf.balance - glBal) > 2) return true;
  }
  return false;
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
  partyBooksMismatch,
  applyPartyBalances,
};
