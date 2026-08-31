'use strict';
/**
 * IAS 7-style cash-flow statement from GL cash/bank lines.
 * Must never throw to the HTTP layer — a bad journal row used to 500 the whole tab.
 */

const { acct } = require('./coa-map');
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('./money');

const EMPTY_SECTIONS = () => ({
  operating: { inflow_rial: 0, outflow_rial: 0, net_rial: 0, lines: [] },
  investing: { inflow_rial: 0, outflow_rial: 0, net_rial: 0, lines: [] },
  financing: { inflow_rial: 0, outflow_rial: 0, net_rial: 0, lines: [] },
});

function emptyReport(from, to, warning) {
  return {
    from: from || '',
    to: to || '',
    sections: EMPTY_SECTIONS(),
    total_net_rial: 0,
    warning: warning || '',
  };
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

/** All cash + bank control/tafsili codes (defaults, mapped banks/boxes, 1101/1102*). */
function collectCashBankCodes(db) {
  const codes = new Set();
  const add = (c) => {
    const s = String(c || '').trim();
    if (s) codes.add(s);
  };
  add(safeAcctCode(db, 'coa_cash_default') || '1101');
  add(safeAcctCode(db, 'coa_bank_default') || '1102');
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
    if (root && c.startsWith(root + '-')) return true;
  }
  return c.startsWith('1101') || c.startsWith('1102');
}

function buildCashFlowReport(db, from, to) {
  try {
    const typeMap = accountTypeMap(db);
    const cashCodes = collectCashBankCodes(db);
    const cashSet = new Set(cashCodes);
    const dateWhere = [];
    const dateParams = [];
    if (from) { dateWhere.push('je.entry_date>=?'); dateParams.push(from); }
    if (to) { dateWhere.push('je.entry_date<=?'); dateParams.push(to); }

    const debitSql = tableHasColumn(db, 'journal_lines', 'debit_rial')
      ? SQL_JL_DEBIT_RIAL
      : 'COALESCE(ROUND(jl.debit),0)';
    const creditSql = tableHasColumn(db, 'journal_lines', 'credit_rial')
      ? SQL_JL_CREDIT_RIAL
      : 'COALESCE(ROUND(jl.credit),0)';

    const rows = db.prepare(`
      SELECT je.id AS entry_id, je.entry_date AS date, je.description,
             jl.account_code,
             (${debitSql}) AS debit_rial,
             (${creditSql}) AS credit_rial
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      WHERE ${jeAliveSql(db)}
        ${dateWhere.length ? 'AND ' + dateWhere.join(' AND ') : ''}
    `).all(...dateParams);

    const byEntry = new Map();
    for (const r of rows) {
      const id = r.entry_id;
      if (!byEntry.has(id)) {
        byEntry.set(id, { id, date: r.date, description: r.description, cashNet: 0, others: [] });
      }
      const rec = byEntry.get(id);
      const code = r.account_code;
      const net = (Number(r.debit_rial) || 0) - (Number(r.credit_rial) || 0);
      if (isCashBankCode(code, cashSet)) rec.cashNet += net;
      else if (code) rec.others.push(String(code));
    }

    const sections = EMPTY_SECTIONS();
    for (const rec of byEntry.values()) {
      if (!rec.cashNet) continue;
      let section = 'operating';
      if (rec.others.length) {
        const counts = { operating: 0, investing: 0, financing: 0 };
        for (const code of rec.others) counts[classifyCashFlowCounterpart(code, typeMap)]++;
        section = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      }
      const item = {
        entry_id: rec.id,
        date: rec.date,
        description: rec.description,
        amount_rial: rec.cashNet,
      };
      sections[section].lines.push(item);
      if (rec.cashNet > 0) sections[section].inflow_rial += rec.cashNet;
      else sections[section].outflow_rial += Math.abs(rec.cashNet);
      sections[section].net_rial += rec.cashNet;
    }

    const totalNet = sections.operating.net_rial + sections.investing.net_rial + sections.financing.net_rial;
    return { from: from || '', to: to || '', sections, total_net_rial: totalNet, warning: '' };
  } catch (e) {
    console.error('cash-flow report:', e && e.message);
    return emptyReport(from, to, 'گزارش جریان نقد با دادهٔ ناقص ساخته شد');
  }
}

module.exports = { buildCashFlowReport, collectCashBankCodes, emptyReport, isCashBankCode };
