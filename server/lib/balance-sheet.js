/**
 * Balance sheet as of a Jalali date (or all-time).
 *
 * Invariant: if the journal is balanced and every line is classified
 * (COA type or inferred from code prefix), assets = liabilities + equity
 * where equity includes computed retained earnings (revenue − cogs − expense).
 */
const { DELETED_FILTER, jeNotDraftFor } = require('./ledger');
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('./money');

function inferCoaType(code, acc) {
  if (acc && acc.type) return acc.type;
  const c = String(code || '');
  const head = c.split('-')[0];
  if (head.startsWith('1')) return 'asset';
  if (head.startsWith('2')) return 'liability';
  if (head.startsWith('3') || head === '9999') return 'equity';
  if (head.startsWith('4')) return 'revenue';
  if (head.startsWith('51')) return 'cogs';
  if (head.startsWith('5') || head.startsWith('6')) return 'expense';
  return null;
}

function isPartyCurrentAccount(acc) {
  const c = String(acc.code || '');
  if (Number(acc.level) === 4 || c.length >= 12 || acc.tafsili_type) {
    const head = c.split('-')[0];
    return /^(1103|1106|2101)/.test(head);
  }
  const head = c.split('-')[0];
  return head === '1103' || head === '1106' || head === '2101';
}

function buildBalanceSheet(db, { asOf } = {}) {
  const safeDate = (v) => (v && /^[\d/]+$/.test(v) ? v : null);
  const s = safeDate(asOf);
  const dateWhere = s
    ? `WHERE je.entry_date <= '${s}' AND ${DELETED_FILTER} AND ${jeNotDraftFor(db)}`
    : `WHERE ${DELETED_FILTER} AND ${jeNotDraftFor(db)}`;
  const rows = db.prepare(`
    SELECT jl.account_code, COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) d, COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) c
    FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id
    ${dateWhere}
    GROUP BY jl.account_code
  `).all();
  const accounts = db.prepare('SELECT * FROM chart_of_accounts').all();
  const accMap = {};
  accounts.forEach((a) => { accMap[a.code] = a; });

  let revenueTotal = 0;
  let cogsTotal = 0;
  let expenseTotal = 0;
  const rawAsset = [];
  const rawLiab = [];
  const rawEquity = [];
  const unmapped = [];

  for (const r of rows) {
    const acc = accMap[r.account_code];
    const type = inferCoaType(r.account_code, acc);
    const name = acc ? acc.name : (`${r.account_code} (بدون کدینگ)`);
    if (!type) {
      unmapped.push({ code: r.account_code, name, d: r.d, c: r.c });
      continue;
    }
    const debitNormal = ['asset', 'expense', 'cogs'].includes(type);
    const balance = debitNormal ? (r.d - r.c) : (r.c - r.d);
    const line = {
      code: r.account_code,
      name,
      balance,
      type,
      level: acc ? acc.level : null,
      tafsili_type: acc ? acc.tafsili_type : null,
      unmapped: !acc,
    };
    if (type === 'revenue') revenueTotal += balance;
    else if (type === 'cogs') cogsTotal += balance;
    else if (type === 'expense') expenseTotal += balance;
    else if (type === 'asset') rawAsset.push(line);
    else if (type === 'liability') rawLiab.push(line);
    else if (type === 'equity') rawEquity.push(line);
    else unmapped.push({ code: r.account_code, name, d: r.d, c: r.c, type });
  }

  const assets = [];
  const liabilities = [];
  const equity = [];

  function keepOrReclass(list, side) {
    for (const x of list) {
      if (Math.abs(x.balance) < 1) continue;
      if (isPartyCurrentAccount(x) && x.balance < 0) {
        const moved = {
          ...x,
          balance: -x.balance,
          reclassified: true,
          reclass_from: side,
        };
        if (side === 'asset') liabilities.push(moved);
        else assets.push(moved);
        continue;
      }
      if (side === 'asset') assets.push(x);
      else if (side === 'liability') liabilities.push(x);
      else equity.push(x);
    }
  }
  keepOrReclass(rawAsset, 'asset');
  keepOrReclass(rawLiab, 'liability');
  keepOrReclass(rawEquity, 'equity');

  assets.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
  liabilities.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
  equity.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));

  const netProfit = revenueTotal - cogsTotal - expenseTotal;
  const totalAssets = assets.reduce((a, x) => a + x.balance, 0);
  const totalLiabilities = liabilities.reduce((a, x) => a + x.balance, 0);
  const capital = equity.reduce((a, x) => a + x.balance, 0);
  const totalEquity = capital + netProfit;
  const rhs = totalLiabilities + totalEquity;
  const gap = totalAssets - rhs;

  return {
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    capital,
    retainedEarnings: netProfit,
    totalEquity,
    gap,
    unmapped,
    balanced: Math.abs(gap) < 1,
  };
}

module.exports = { buildBalanceSheet, inferCoaType, isPartyCurrentAccount };
