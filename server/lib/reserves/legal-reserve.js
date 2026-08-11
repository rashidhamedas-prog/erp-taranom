const { acct } = require('../coa-map');
const { postToLedger } = require('../ledger');
const { rialToLedger } = require('../money');
const { todayJalali } = require('../../jalali');
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../money');

function existingLegalReserveBalance(db) {
  const reserveAcct = acct(db, 'coa_legal_reserve');
  const row = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_CREDIT_RIAL} - ${SQL_JL_DEBIT_RIAL}), 0) bal
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.account_code = ?
      AND COALESCE(je.deleted_at, 0) = 0
      AND COALESCE(je.status, 'approved') <> 'reversed'
  `).get(reserveAcct.code);
  return Math.max(0, Math.round(row?.bal || 0));
}

function computeLegalReserveRial(db, profitRial, capitalRial) {
  const profit = Math.max(0, Math.round(Number(profitRial) || 0));
  const capital = Math.max(0, Math.round(Number(capitalRial) || 0));
  const fromProfit = Math.round(profit * 0.05);
  const headroom = Math.max(0, Math.round(capital * 0.10) - existingLegalReserveBalance(db));
  return Math.min(fromProfit, headroom);
}

function postLegalReserve(db, userId, opts) {
  const { profit_rial, capital_rial, date, fiscal_year_id } = opts;
  const profitRial = Math.round(Number(profit_rial) || 0);
  if (profitRial <= 0) throw new Error('سود قابل تخصیص باید بزرگ‌تر از صفر باشد');

  let capitalRial = capital_rial != null ? Math.round(Number(capital_rial) || 0) : null;
  if (capitalRial == null) {
    capitalRial = Math.round(Number(db.prepare("SELECT value FROM settings WHERE key='company_capital_rial'").get()?.value) || 0);
  }

  const reserveRial = computeLegalReserveRial(db, profitRial, capitalRial);
  if (reserveRial <= 0) throw new Error('اندوخته قانونی قابل ثبت نیست — سقف ۱۰٪ سرمایه تکمیل شده یا سود کافی نیست');

  const entryDate = date || todayJalali();
  const retained = acct(db, 'coa_retained_earnings');
  const reserve = acct(db, 'coa_legal_reserve');
  const amt = rialToLedger(reserveRial);

  const result = db.transaction(() => {
    const jeId = postToLedger(db, {
      sourceType: 'legal_reserve', sourceId: 0, date: entryDate,
      description: `تخصیص اندوخته قانونی — ${reserveRial.toLocaleString('fa-IR')} ریال`,
      createdBy: userId,
      lines: [
        { code: retained.code, name: retained.name, debit: amt, credit: 0, debit_rial: reserveRial },
        { code: reserve.code, name: reserve.name, debit: 0, credit: amt, credit_rial: reserveRial },
      ],
    });
    const ins = db.prepare(`
      INSERT INTO legal_reserve_entries (fiscal_year_id, profit_rial, reserve_rial, capital_rial, je_id, date, created_by)
      VALUES (?,?,?,?,?,?,?)
    `).run(fiscal_year_id || null, profitRial, reserveRial, capitalRial, jeId, entryDate, userId);
    return { id: ins.lastInsertRowid, je_id: jeId, reserve_rial: reserveRial, profit_rial: profitRial, capital_rial: capitalRial };
  })();

  return result;
}

module.exports = { postLegalReserve, computeLegalReserveRial, existingLegalReserveBalance };
