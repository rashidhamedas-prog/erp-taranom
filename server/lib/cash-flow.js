'use strict';
/**
 * Cash-flow statement from GL cash/bank lines, split by nature (operating / investing / financing).
 *
 * Standard basis — read before relying on this output:
 *   Only the IAS 7 "split by nature" *pattern* is borrowed here. This module makes NO claim of
 *   compliance with Iranian accounting standards (استاندارد حسابداری ۲ — صورت جریان‌های نقدی) or
 *   with any statutory presentation format. Counterpart classification and the proportional
 *   allocation below are bookkeeping heuristics; sign-off by a local standard-setter / auditor is
 *   still required before this report is used for statutory or external reporting.
 *
 * Result contract (`buildCashFlowReport`):
 *   status 'ok'         → computed; reconciliation identity holds. Unclassifiable cash movement is
 *                         NOT hidden in operating — it is exposed in `residual_rial` + `exceptions[]`
 *                         (and mentioned in `warning`).
 *   status 'incomplete' → computed, but the identity does not hold → route answers 422.
 *   status 'failed'     → not computable (bad input / exception) → no sections, no totals
 *                         (`sections`/`total_net_rial` are null) → route answers 422 / 500.
 *   A valid empty period is status 'ok' with zeros and reconciliation.ok === true.
 *
 * Reconciliation identity (integer rial, all terms explicit):
 *   opening_cash_rial + total_net_rial + residual_rial + transfer_net_rial(=0) = closing_cash_rial
 *   where opening = Σ cash/bank (debit − credit) of alive entries dated < from (0 when no `from`),
 *         closing = Σ cash/bank (debit − credit) of alive entries dated ≤ to (all dated entries when no `to`),
 *         total_net_rial = operating + investing + financing nets (classified parts only).
 */

const { acct } = require('./coa-map');
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('./money');

const SECTION_NAMES = ['operating', 'investing', 'financing'];
const RECONCILIATION_FORMULA =
  'opening_cash_rial + total_net_rial + residual_rial + transfer_net_rial = closing_cash_rial';

const EMPTY_SECTIONS = () => ({
  operating: { inflow_rial: 0, outflow_rial: 0, net_rial: 0, lines: [] },
  investing: { inflow_rial: 0, outflow_rial: 0, net_rial: 0, lines: [] },
  financing: { inflow_rial: 0, outflow_rial: 0, net_rial: 0, lines: [] },
});

/** Zero-valued *valid* report skeleton (an empty period). Not a failure vehicle. */
function emptyReport(from, to, warning) {
  return {
    status: 'ok',
    from: from || '',
    to: to || '',
    sections: EMPTY_SECTIONS(),
    transfers: { count: 0, gross_rial: 0, net_rial: 0, lines: [] },
    residual_rial: 0,
    exceptions: [],
    total_net_rial: 0,
    reconciliation: {
      ok: true,
      formula: RECONCILIATION_FORMULA,
      opening_cash_rial: 0,
      total_net_rial: 0,
      residual_rial: 0,
      transfer_net_rial: 0,
      closing_cash_rial: 0,
      difference_rial: 0,
    },
    method: 'proportional_largest_remainder',
    warning: warning || '',
  };
}

/** Explicit failure: no sections / totals so nothing can be mistaken for a computed report. */
function failedReport(from, to, error, code) {
  return {
    status: 'failed',
    code: code || 'exception',
    error: error || 'گزارش جریان نقد قابل محاسبه نیست',
    from: from || '',
    to: to || '',
    sections: null,
    total_net_rial: null,
    residual_rial: null,
    exceptions: [],
    reconciliation: { ok: false, formula: RECONCILIATION_FORMULA },
    warning: error || 'گزارش جریان نقد قابل محاسبه نیست',
  };
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Split an integer total across non-negative integer weights, proportionally, using the
 * largest-remainder (Hamilton) method so the parts sum to `total` exactly.
 * Deterministic: ties on remainder are broken by input order. BigInt keeps the intermediate
 * products exact for large rial values.
 * Returns int[] (same length as weights) or null when no positive weight exists.
 */
function allocateProportional(total, weights) {
  if (!Array.isArray(weights) || !weights.length) return null;
  const t = toInt(total);
  const w = weights.map((x) => Math.abs(toInt(x)));
  const sumW = w.reduce((a, b) => a + b, 0);
  if (!sumW) return null;
  if (!t) return w.map(() => 0);
  const sign = t < 0 ? -1n : 1n;
  const A = BigInt(Math.abs(t));
  const S = BigInt(sumW);
  const parts = w.map((x, i) => {
    const prod = A * BigInt(x);
    return { i, q: prod / S, r: prod % S };
  });
  let rem = A - parts.reduce((a, p) => a + p.q, 0n);
  // Largest remainder first; equal remainders keep input order. A zero-weight line has r=0 and can
  // never receive a remainder unit (strictly more than `rem` lines have r>0), so it stays at 0.
  const order = parts.slice().sort((a, b) => (a.r === b.r ? a.i - b.i : (b.r > a.r ? 1 : -1)));
  for (let k = 0; rem > 0n; k += 1) {
    order[k % order.length].q += 1n;
    rem -= 1n;
  }
  return parts.map((p) => Number(sign * p.q));
}

function tableHasColumn(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch (_) {
    return false;
  }
}

function jeAliveSql(db) {
  const parts = ['1=1'];
  if (tableHasColumn(db, 'journal_entries', 'deleted_at')) {
    parts.push('COALESCE(je.deleted_at,0)=0');
  }
  if (tableHasColumn(db, 'journal_entries', 'status')) {
    parts.push("COALESCE(je.status,'posted')<>'reversed'");
  }
  return parts.join(' AND ');
}

function safeAcctCode(db, key) {
  try {
    const a = acct(db, key);
    return a && a.code ? String(a.code) : '';
  } catch (_) {
    return '';
  }
}

/** All cash + bank control/tafsili codes (defaults, mapped banks/boxes, 1101/1102*, Mahak 206*). */
function collectCashBankCodes(db) {
  const codes = new Set();
  const add = (c) => {
    const s = String(c || '').trim();
    if (s) codes.add(s);
  };
  const cashRoot = safeAcctCode(db, 'coa_cash_default') || '1101';
  const bankRoot = safeAcctCode(db, 'coa_bank_default') || '1102';
  add(cashRoot);
  add(bankRoot);
  // Children under mapped roots (Mahak: 206001… / 206002… without hyphen)
  for (const root of [cashRoot, bankRoot]) {
    if (!root || root.length < 3) continue;
    try {
      for (const r of db.prepare('SELECT code FROM chart_of_accounts WHERE code LIKE ?').all(root + '%')) {
        add(r.code);
      }
    } catch (_) { /* */ }
  }
  try {
    for (const r of db.prepare("SELECT coa_code FROM banks WHERE COALESCE(coa_code,'')<>''").all()) add(r.coa_code);
  } catch (_) { /* banks.coa_code may be absent */ }
  try {
    for (const r of db.prepare("SELECT coa_code FROM cash_boxes WHERE COALESCE(coa_code,'')<>''").all()) add(r.coa_code);
  } catch (_) { /* cash_boxes optional */ }
  try {
    for (const r of db.prepare(`
      SELECT code FROM chart_of_accounts
      WHERE code LIKE '1101%' OR code LIKE '1102%'
         OR code LIKE '206001%' OR code LIKE '206002%'
    `).all()) add(r.code);
  } catch (_) { /* */ }
  return [...codes];
}

function classifyCashFlowCounterpart(code, typeMap) {
  const c = String(code || '');
  const type = typeMap[c] || '';
  if (c.startsWith('12')) return 'investing';
  if (type === 'liability' || type === 'equity') return 'financing';
  return 'operating';
}

function accountTypeMap(db) {
  const map = {};
  try {
    for (const r of db.prepare('SELECT code, type FROM chart_of_accounts').all()) {
      map[r.code] = r.type || '';
    }
  } catch (_) { /* */ }
  return map;
}

function isCashBankCode(code, cashSet) {
  const c = String(code || '');
  if (!c) return false;
  if (cashSet.has(c)) return true;
  for (const root of cashSet) {
    if (!root) continue;
    if (c === root) return true;
    if (c.startsWith(root + '-')) return true;
    // Mahak 12-digit under 206001 / 206002 (no hyphen between levels)
    if (root.length >= 4 && c.length > root.length && c.startsWith(root)) return true;
  }
  return c.startsWith('1101') || c.startsWith('1102')
    || c.startsWith('206001') || c.startsWith('206002');
}

/** Dashboard / KPI: net cash+bank from posted GL (includes Mahak bank/cash codes). */
function sumCashBankBalanceRial(db) {
  try {
    const cashSet = new Set(collectCashBankCodes(db));
    const rows = db.prepare(`
      SELECT jl.account_code,
        COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0)
        - COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) AS bal
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      WHERE ${jeAliveSql(db)}
      GROUP BY jl.account_code
    `).all();
    let total = 0;
    for (const r of rows) {
      if (isCashBankCode(r.account_code, cashSet)) total += Number(r.bal) || 0;
    }
    return Math.round(total);
  } catch (_) {
    return 0;
  }
}

/**
 * Pure classification of ONE journal entry (no DB access).
 * lines: [{ account_code, debit_rial, credit_rial }]
 * Returns one of
 *   { kind: 'none' }                                   — entry does not touch cash/bank
 *   { kind: 'transfer', cash_net: 0, moved_rial }      — cash/bank ↔ cash/bank only (net 0)
 *   { kind: 'allocated', cash_net, parts: [{ account_code, section, amount_rial }],
 *     residual: [{ account_code, amount_rial, reason }] }
 *   { kind: 'residual', cash_net, reason }             — cash moved but nothing classifiable
 *
 * The cash/bank net change is allocated across the non-cash counterpart lines in proportion to
 * each line's |debit|+|credit| (largest-remainder, exact integer rial). Lines whose account code is
 * empty are kept as counterparts with section=null so their share lands in `residual`, never in
 * operating. Counterparts are classified by the existing `classifyCashFlowCounterpart`.
 */
function classifyEntryLines(lines, cashSet, typeMap) {
  let cashNet = 0;
  let cashMovedIn = 0;
  let cashTouched = false;
  const counterparts = [];
  for (const l of lines || []) {
    const code = String(l.account_code || '').trim();
    const debit = toInt(l.debit_rial);
    const credit = toInt(l.credit_rial);
    const net = debit - credit;
    if (code && isCashBankCode(code, cashSet)) {
      cashNet += net;
      if (net > 0) cashMovedIn += net;
      if (net) cashTouched = true;
      continue;
    }
    const weight = Math.abs(debit) + Math.abs(credit);
    if (!weight) continue; // zero line: carries no information
    counterparts.push({
      account_code: code,
      weight,
      section: code ? classifyCashFlowCounterpart(code, typeMap) : null,
    });
  }

  if (!cashTouched) return { kind: 'none' };
  if (cashNet === 0) {
    // Every cash movement is offset by another cash/bank line → internal transfer, net 0.
    return { kind: 'transfer', cash_net: 0, moved_rial: cashMovedIn };
  }
  if (!counterparts.length) {
    return { kind: 'residual', cash_net: cashNet, reason: 'no_counterpart' };
  }
  const shares = allocateProportional(cashNet, counterparts.map((c) => c.weight));
  if (!shares) {
    return { kind: 'residual', cash_net: cashNet, reason: 'zero_weight_counterparts' };
  }
  const parts = [];
  const residual = [];
  counterparts.forEach((c, i) => {
    const amount = shares[i];
    if (!amount) return;
    if (!c.section || !SECTION_NAMES.includes(c.section)) {
      residual.push({
        account_code: c.account_code,
        amount_rial: amount,
        reason: c.account_code ? 'unclassified_account' : 'empty_account_code',
      });
      return;
    }
    parts.push({ account_code: c.account_code, section: c.section, amount_rial: amount });
  });
  return { kind: 'allocated', cash_net: cashNet, parts, residual };
}

function lineAmountSql(db) {
  const debitSql = tableHasColumn(db, 'journal_lines', 'debit_rial')
    ? SQL_JL_DEBIT_RIAL
    : 'COALESCE(ROUND(jl.debit),0)';
  const creditSql = tableHasColumn(db, 'journal_lines', 'credit_rial')
    ? SQL_JL_CREDIT_RIAL
    : 'COALESCE(ROUND(jl.credit),0)';
  return { debitSql, creditSql };
}

/** Σ cash/bank (debit − credit) over alive entries matching `whereSql` (same alive + cash rules as the period scan). */
function cashBalanceRial(db, cashSet, whereSql, params) {
  const { debitSql, creditSql } = lineAmountSql(db);
  const rows = db.prepare(`
    SELECT jl.account_code,
           COALESCE(SUM(${debitSql}),0) - COALESCE(SUM(${creditSql}),0) AS bal
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE ${jeAliveSql(db)} AND (${whereSql})
    GROUP BY jl.account_code
  `).all(...params);
  let total = 0;
  for (const r of rows) {
    const code = String(r.account_code || '').trim();
    if (code && isCashBankCode(code, cashSet)) total += toInt(r.bal);
  }
  return total;
}

function cleanDate(v) {
  return v == null ? '' : String(v).trim();
}

function buildCashFlowReport(db, fromRaw, toRaw) {
  const from = cleanDate(fromRaw);
  const to = cleanDate(toRaw);
  if (from && to && from > to) {
    return failedReport(from, to, 'تاریخ شروع بازه بعد از تاریخ پایان است', 'bad_range');
  }
  try {
    const typeMap = accountTypeMap(db);
    const cashSet = new Set(collectCashBankCodes(db));
    const { debitSql, creditSql } = lineAmountSql(db);

    const dateWhere = [];
    const dateParams = [];
    if (from) { dateWhere.push('je.entry_date>=?'); dateParams.push(from); }
    if (to) { dateWhere.push('je.entry_date<=?'); dateParams.push(to); }

    const rows = db.prepare(`
      SELECT je.id AS entry_id, je.entry_date AS date, je.description,
             jl.account_code,
             (${debitSql}) AS debit_rial,
             (${creditSql}) AS credit_rial
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      WHERE ${jeAliveSql(db)}
        ${dateWhere.length ? 'AND ' + dateWhere.join(' AND ') : ''}
      ORDER BY je.entry_date, je.id, jl.rowid
    `).all(...dateParams);

    const byEntry = new Map();
    for (const r of rows) {
      if (!byEntry.has(r.entry_id)) {
        byEntry.set(r.entry_id, { id: r.entry_id, date: r.date, description: r.description, lines: [] });
      }
      byEntry.get(r.entry_id).lines.push(r);
    }

    const report = emptyReport(from, to, '');
    const { sections, transfers, exceptions } = report;
    let residualRial = 0;

    const addSectionAmount = (section, entry, amount, accountCodes) => {
      const sec = sections[section];
      // One line per (entry, section): parts of the same entry landing in the same section are merged.
      let line = sec.lines.length ? sec.lines[sec.lines.length - 1] : null;
      if (!line || line.entry_id !== entry.id) {
        line = {
          entry_id: entry.id,
          date: entry.date,
          description: entry.description,
          amount_rial: 0,
          account_codes: [],
        };
        sec.lines.push(line);
      }
      line.amount_rial += amount;
      for (const c of accountCodes) if (!line.account_codes.includes(c)) line.account_codes.push(c);
      if (amount > 0) sec.inflow_rial += amount;
      else sec.outflow_rial += Math.abs(amount);
      sec.net_rial += amount;
    };
    const addException = (entry, amount, reason, accountCode) => {
      residualRial += amount;
      exceptions.push({
        entry_id: entry.id,
        date: entry.date,
        description: entry.description,
        account_code: accountCode || '',
        amount_rial: amount,
        reason,
      });
    };

    for (const entry of byEntry.values()) {
      const res = classifyEntryLines(entry.lines, cashSet, typeMap);
      if (res.kind === 'none') continue;
      if (res.kind === 'transfer') {
        transfers.count += 1;
        transfers.gross_rial += res.moved_rial;
        transfers.lines.push({
          entry_id: entry.id,
          date: entry.date,
          description: entry.description,
          amount_rial: res.moved_rial,
          net_rial: 0,
        });
        continue;
      }
      if (res.kind === 'residual') {
        addException(entry, res.cash_net, res.reason, '');
        continue;
      }
      for (const p of res.parts) addSectionAmount(p.section, entry, p.amount_rial, [p.account_code]);
      for (const r of res.residual) addException(entry, r.amount_rial, r.reason, r.account_code);
    }

    const totalNet = SECTION_NAMES.reduce((s, name) => s + sections[name].net_rial, 0);

    // Independent balances for the identity — same alive predicate and cash detection as above.
    const opening = from ? cashBalanceRial(db, cashSet, 'je.entry_date < ?', [from]) : 0;
    let closing;
    if (to) closing = cashBalanceRial(db, cashSet, 'je.entry_date <= ?', [to]);
    else if (from) closing = cashBalanceRial(db, cashSet, 'je.entry_date IS NOT NULL', []);
    else closing = cashBalanceRial(db, cashSet, '1=1', []);
    const difference = closing - (opening + totalNet + residualRial + transfers.net_rial);

    report.total_net_rial = totalNet;
    report.residual_rial = residualRial;
    report.reconciliation = {
      ok: difference === 0,
      formula: RECONCILIATION_FORMULA,
      opening_cash_rial: opening,
      total_net_rial: totalNet,
      residual_rial: residualRial,
      transfer_net_rial: transfers.net_rial,
      closing_cash_rial: closing,
      difference_rial: difference,
    };
    if (difference !== 0) {
      report.status = 'incomplete';
      report.error = `جمع جریان نقد با تغییر ماندهٔ صندوق/بانک برابر نیست (اختلاف ${difference} ریال)`;
      report.warning = report.error;
    } else if (exceptions.length) {
      report.status = 'ok';
      report.warning = `${residualRial} ریال از جریان نقد (${exceptions.length} سند) قابل طبقه‌بندی نبود و جداگانه در residual گزارش شده است`;
    }
    return report;
  } catch (e) {
    console.error('cash-flow report:', e && e.message);
    return failedReport(from, to, 'محاسبهٔ گزارش جریان نقد ناموفق بود: ' + ((e && e.message) || 'خطای نامشخص'), 'exception');
  }
}

module.exports = {
  RECONCILIATION_FORMULA,
  allocateProportional,
  buildCashFlowReport,
  classifyCashFlowCounterpart,
  classifyEntryLines,
  collectCashBankCodes,
  emptyReport,
  failedReport,
  isCashBankCode,
  sumCashBankBalanceRial,
};
