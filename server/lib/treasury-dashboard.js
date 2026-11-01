'use strict';
/**
 * Treasury dashboard API — shape matched to portal-ui renderTreasuryDashboardTab.
 * Live GL + period flow + IAS 7 + bank recon compliance + alerts.
 * Never throws to HTTP.
 */

const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('./money');
const {
  buildCashFlowReport,
  collectCashBankCodes,
  sumCashBankBalanceRial,
} = require('./cash-flow');
const { todayJalali } = require('../jalali');
const { JE_NOT_DRAFT } = require('./je-live');

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch (_) {
    return false;
  }
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
    parts.push("COALESCE(je.status,'posted') NOT IN ('reversed','void')", JE_NOT_DRAFT);
  }
  return parts.join(' AND ');
}

function glBalanceOnCode(db, accountCode) {
  try {
    const row = db.prepare(`
      SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL} - ${SQL_JL_CREDIT_RIAL}), 0) AS bal
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.account_code = ?
        AND ${jeAliveSql(db)}
    `).get(accountCode);
    return Math.round(Number(row && row.bal) || 0);
  } catch (_) {
    return 0;
  }
}

function resolveBankCode(bank) {
  const code = String(bank.coa_code || '').trim();
  return code || ('1102-' + bank.id);
}

function resolveCashCode(box) {
  const code = String(box.coa_code || '').trim();
  return code || ('1101-' + box.id);
}

function periodMovementOnCodes(db, codes, from, to) {
  const unique = [...new Set((codes || []).filter(Boolean))];
  if (!unique.length) return { inflow_rial: 0, outflow_rial: 0, net_rial: 0 };
  const dateWhere = [];
  const params = [];
  if (from) { dateWhere.push('je.entry_date>=?'); params.push(from); }
  if (to) { dateWhere.push('je.entry_date<=?'); params.push(to); }
  const placeholders = unique.map(() => '?').join(',');
  try {
    const rows = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN (${SQL_JL_DEBIT_RIAL}) > 0 THEN (${SQL_JL_DEBIT_RIAL}) ELSE 0 END), 0) AS inflow,
        COALESCE(SUM(CASE WHEN (${SQL_JL_CREDIT_RIAL}) > 0 THEN (${SQL_JL_CREDIT_RIAL}) ELSE 0 END), 0) AS outflow
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.account_code IN (${placeholders})
        AND ${jeAliveSql(db)}
        ${dateWhere.length ? 'AND ' + dateWhere.join(' AND ') : ''}
    `).get(...unique, ...params);
    const inflow = Math.round(Number(rows && rows.inflow) || 0);
    const outflow = Math.round(Number(rows && rows.outflow) || 0);
    return { inflow_rial: inflow, outflow_rial: outflow, net_rial: inflow - outflow };
  } catch (_) {
    return { inflow_rial: 0, outflow_rial: 0, net_rial: 0 };
  }
}

function monthlyNetOnCodes(db, codes, from, to) {
  const unique = [...new Set((codes || []).filter(Boolean))];
  if (!unique.length) return [];
  const dateWhere = [];
  const params = [];
  if (from) { dateWhere.push('je.entry_date>=?'); params.push(from); }
  if (to) { dateWhere.push('je.entry_date<=?'); params.push(to); }
  const placeholders = unique.map(() => '?').join(',');
  try {
    const rows = db.prepare(`
      SELECT substr(je.entry_date,1,7) AS month,
        COALESCE(SUM(CASE WHEN (${SQL_JL_DEBIT_RIAL}) > 0 THEN (${SQL_JL_DEBIT_RIAL}) ELSE 0 END), 0) AS inflow,
        COALESCE(SUM(CASE WHEN (${SQL_JL_CREDIT_RIAL}) > 0 THEN (${SQL_JL_CREDIT_RIAL}) ELSE 0 END), 0) AS outflow
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.account_code IN (${placeholders})
        AND ${jeAliveSql(db)}
        ${dateWhere.length ? 'AND ' + dateWhere.join(' AND ') : ''}
      GROUP BY substr(je.entry_date,1,7)
      ORDER BY month
    `).all(...unique, ...params);
    return rows.map((r) => ({
      month: r.month,
      inflow_rial: Math.round(Number(r.inflow) || 0),
      outflow_rial: Math.round(Number(r.outflow) || 0),
      net_rial: Math.round((Number(r.inflow) || 0) - (Number(r.outflow) || 0)),
    }));
  } catch (_) {
    return [];
  }
}

function chequeStats(db) {
  const out = {
    pending_in_rial: 0,
    pending_out_rial: 0,
    overdue_in_count: 0,
    overdue_in_rial: 0,
  };
  const today = todayJalali();
  try {
    const live = require('./cheque-due').openIncomingPortfolio(db, today);
    out.pending_in_rial = live.open_rial;
    out.overdue_in_count = live.overdue_count;
    out.overdue_in_rial = live.overdue_rial;
  } catch (_) { /* */ }
  try {
    if (tableExists(db, 'cheque_records')) {
      const amtCol = tableHasColumn(db, 'cheque_records', 'amount_rial')
        ? 'amount_rial'
        : (tableHasColumn(db, 'cheque_records', 'amount') ? 'amount' : null);
      const typeCol = tableHasColumn(db, 'cheque_records', 'direction')
        ? 'direction'
        : (tableHasColumn(db, 'cheque_records', 'cheque_type') ? 'cheque_type' : null);
      const statusCol = tableHasColumn(db, 'cheque_records', 'lifecycle_status')
        ? 'lifecycle_status'
        : (tableHasColumn(db, 'cheque_records', 'status') ? 'status' : null);
      if (amtCol && typeCol && statusCol) {
        const pay = db.prepare(`
          SELECT COALESCE(SUM(${amtCol}),0) AS s
          FROM cheque_records
          WHERE (${typeCol} IN ('pay','payable','outgoing') OR ${typeCol} LIKE '%pay%')
            AND ${statusCol} NOT IN ('cleared','cancelled','void','paid')
            AND COALESCE(voided,0)=0
        `).get();
        out.pending_out_rial = Math.round(Number(pay && pay.s) || 0);
      }
    }
  } catch (_) { /* */ }
  return out;
}

function buildReconciliation(db, banks) {
  const empty = {
    open_count: 0,
    closed_count: 0,
    unmatched_open_items: 0,
    open: [],
    banks_without_open: [],
  };
  if (!tableExists(db, 'bank_reconciliations')) return empty;

  const activeBanks = banks.filter((b) => Number(b.active) !== 0);
  let closedCount = 0;
  let unmatched = 0;
  const open = [];
  const banksWithOpen = new Set();

  try {
    closedCount = Number(db.prepare(`
      SELECT COUNT(*) AS n FROM bank_reconciliations
      WHERE status='closed' AND COALESCE(voided_at,0)=0
    `).get()?.n) || 0;
  } catch (_) { /* */ }

  for (const b of activeBanks) {
    try {
      const row = db.prepare(`
        SELECT * FROM bank_reconciliations
        WHERE bank_id=? AND status='open' AND COALESCE(voided_at,0)=0
        ORDER BY id DESC LIMIT 1
      `).get(b.id);
      if (!row) continue;
      banksWithOpen.add(b.id);
      const code = resolveBankCode(b);
      const liveBook = glBalanceOnCode(db, code);
      let unmatchedItems = 0;
      let unmatchedLines = 0;
      if (tableExists(db, 'bank_reconciliation_items')) {
        try {
          unmatchedItems = Number(db.prepare(`
            SELECT COUNT(*) AS n FROM bank_reconciliation_items
            WHERE reconciliation_id=? AND COALESCE(matched,0)=0 AND COALESCE(voided,0)=0
          `).get(row.id)?.n) || 0;
        } catch (_) { /* */ }
      }
      if (tableExists(db, 'bank_statement_lines')) {
        try {
          unmatchedLines = Number(db.prepare(`
            SELECT COUNT(*) AS n FROM bank_statement_lines
            WHERE reconciliation_id=? AND COALESCE(matched,0)=0
          `).get(row.id)?.n) || 0;
        } catch (_) { /* */ }
      }
      unmatched += unmatchedItems + unmatchedLines;
      const stmtBal = Math.round(Number(row.statement_balance_rial) || 0);
      open.push({
        id: row.id,
        bank_id: b.id,
        bank_name: b.name,
        statement_date: row.statement_date,
        statement_balance_rial: stmtBal,
        book_balance_rial: Math.round(Number(row.book_balance_rial) || 0),
        live_book_balance_rial: liveBook,
        raw_difference_rial: stmtBal - liveBook,
        unmatched_items: unmatchedItems,
        unmatched_lines: unmatchedLines,
      });
    } catch (_) { /* */ }
  }

  const banks_without_open = activeBanks
    .filter((b) => !banksWithOpen.has(b.id) && !(b.is_foreign || (b.currency && b.currency !== 'IRR')))
    .map((b) => ({ id: b.id, name: b.name }));

  return {
    open_count: open.length,
    closed_count: closedCount,
    unmatched_open_items: unmatched,
    open,
    banks_without_open,
  };
}

function instrumentAlerts(row) {
  const alerts = [];
  if (row.balance_rial < 0) alerts.push('negative');
  if (!row.coa_code) alerts.push('missing_coa');
  return alerts;
}

function buildCompliance(kpis, recon, cheques, banks, boxes) {
  const items = [];
  const negBanks = banks.filter((b) => b.balance_rial < 0).length;
  const negCash = boxes.filter((c) => c.balance_rial < 0).length;
  const missingCoa = [...banks, ...boxes].filter((x) => !x.coa_code).length;

  items.push({
    id: 'live_balances',
    status: (negBanks + negCash) === 0 ? 'ok' : 'fail',
    label: 'مانده زنده دفتر کل',
    detail: (negBanks + negCash) === 0
      ? `همه حساب‌های فعال مانده غیرمنفی دارند (${kpis.bank_count_active} بانک · ${kpis.cash_count_active} صندوق)`
      : `${negBanks + negCash} حساب با مانده منفی — نیاز به بررسی`,
    action_nav: negBanks ? 'acc-banks' : 'acc-cash-boxes',
  });

  items.push({
    id: 'coa_mapping',
    status: missingCoa === 0 ? 'ok' : 'warn',
    label: 'اتصال به کد تفصیلی',
    detail: missingCoa === 0
      ? 'همه بانک/صندوق‌ها کد تفصیلی دارند'
      : `${missingCoa} مورد بدون کد تفصیلی — گزارش دفتر ناقص می‌شود`,
    action_nav: 'acc-banks',
  });

  items.push({
    id: 'bank_recon',
    status: recon.open_count === 0 && recon.banks_without_open.length === 0
      ? 'ok'
      : (recon.unmatched_open_items > 0 ? 'fail' : 'warn'),
    label: 'تطبیق بانک (استاندارد)',
    detail: recon.open_count
      ? `${recon.open_count} صورت باز · ${recon.unmatched_open_items} قلم تطبیق‌نشده`
      : (recon.banks_without_open.length
        ? `${recon.banks_without_open.length} بانک ریالی بدون صورت باز`
        : 'صورت بازی نیست — وضعیت پایدار'),
    action_nav: 'acc-bank-recon',
  });

  items.push({
    id: 'cash_flow_ias7',
    status: 'ok',
    label: 'صورت جریان وجوه نقد (IAS 7)',
    detail: 'طبقه‌بندی عملیاتی / سرمایه‌گذاری / تأمین مالی از گردش همه بانک‌ها و صندوق‌ها',
    action_nav: 'acc-cash-flow-std',
  });

  items.push({
    id: 'cheques',
    status: cheques.overdue_in_count > 0 ? 'fail' : (cheques.pending_in_rial > 0 ? 'warn' : 'ok'),
    label: 'چک‌های در جریان',
    detail: cheques.overdue_in_count > 0
      ? `${cheques.overdue_in_count} چک دریافتنی سررسیدگذشته (${cheques.overdue_in_rial.toLocaleString('fa-IR')} ریال)`
      : `دریافتنی در جریان ${cheques.pending_in_rial.toLocaleString('fa-IR')} · پرداختنی باز ${cheques.pending_out_rial.toLocaleString('fa-IR')}`,
    action_nav: 'acc-cheque-register',
  });

  return items;
}

function buildAlerts(banks, boxes, recon, cheques) {
  const alerts = [];
  for (const b of banks) {
    if (b.balance_rial < 0) {
      alerts.push({
        severity: 'fail',
        title: `مانده منفی بانک «${b.name}»`,
        detail: `${b.balance_rial.toLocaleString('fa-IR')} ریال — احتمال ثبت اشتباه یا چک برگشتی`,
        action_nav: 'acc-banks',
      });
    }
    if (!b.coa_code) {
      alerts.push({
        severity: 'warn',
        title: `بانک «${b.name}» بدون کد تفصیلی`,
        detail: 'مانده زنده و تطبیق ممکن است ناقص باشد',
        action_nav: 'acc-banks',
      });
    }
  }
  for (const c of boxes) {
    if (c.balance_rial < 0) {
      alerts.push({
        severity: 'fail',
        title: `مانده منفی صندوق «${c.name}»`,
        detail: `${c.balance_rial.toLocaleString('fa-IR')} ریال`,
        action_nav: 'acc-cash-boxes',
      });
    }
  }
  for (const r of recon.open || []) {
    if (Math.abs(r.raw_difference_rial || 0) > 0 || (r.unmatched_items + r.unmatched_lines) > 0) {
      alerts.push({
        severity: Math.abs(r.raw_difference_rial || 0) > 0 ? 'fail' : 'warn',
        title: `تطبیق باز «${r.bank_name}»`,
        detail: `اختلاف خام ${Number(r.raw_difference_rial || 0).toLocaleString('fa-IR')} · تطبیق‌نشده ${(r.unmatched_items || 0) + (r.unmatched_lines || 0)}`,
        action_nav: 'acc-bank-recon',
      });
    }
  }
  if (cheques.overdue_in_count > 0) {
    alerts.push({
      severity: 'fail',
      title: 'چک دریافتنی سررسیدگذشته',
      detail: `${cheques.overdue_in_count} فقره · ${cheques.overdue_in_rial.toLocaleString('fa-IR')} ریال`,
      action_nav: 'acc-cheque-register',
    });
  }
  return alerts.slice(0, 12);
}

function healthScore(compliance) {
  if (!compliance.length) return 100;
  let score = 100;
  for (const c of compliance) {
    if (c.status === 'fail') score -= 18;
    else if (c.status === 'warn') score -= 8;
  }
  return Math.max(0, Math.min(100, score));
}

function emptyPayload(from, to, warning) {
  return {
    generated_at: Date.now(),
    as_of: todayJalali(),
    from: from || '',
    to: to || '',
    health_score: 0,
    kpis: {
      total_liquidity_rial: 0,
      banks_total_rial: 0,
      cash_total_rial: 0,
      petty_cash_rial: 0,
      bank_count_active: 0,
      cash_count_active: 0,
      period_inflow_rial: 0,
      period_outflow_rial: 0,
      period_net_rial: 0,
    },
    banks: [],
    cash_boxes: [],
    cash_flow: {
      sections: {
        operating: { inflow_rial: 0, outflow_rial: 0, net_rial: 0, lines: [] },
        investing: { inflow_rial: 0, outflow_rial: 0, net_rial: 0, lines: [] },
        financing: { inflow_rial: 0, outflow_rial: 0, net_rial: 0, lines: [] },
      },
      total_net_rial: 0,
      warning: warning || '',
    },
    reconciliation: {
      open_count: 0,
      closed_count: 0,
      unmatched_open_items: 0,
      open: [],
      banks_without_open: [],
    },
    cheques: {
      pending_in_rial: 0,
      pending_out_rial: 0,
      overdue_in_count: 0,
      overdue_in_rial: 0,
    },
    concentration: { top_name: null, top_pct: 0, risk: 'ok' },
    compliance: [],
    alerts: warning ? [{ severity: 'fail', title: 'خطای داشبورد', detail: warning, action_nav: 'acc-treasury-dashboard' }] : [],
    monthly_net: [],
    warning: warning || '',
  };
}

function buildTreasuryDashboard(db, from, to) {
  try {
    const banksRaw = tableExists(db, 'banks')
      ? db.prepare('SELECT * FROM banks ORDER BY name').all()
      : [];
    const boxesRaw = tableExists(db, 'cash_boxes')
      ? db.prepare('SELECT * FROM cash_boxes ORDER BY name').all()
      : [];

    const allCodes = [];
    const banks = [];
    const cash_boxes = [];
    let banksTotal = 0;
    let cashTotal = 0;
    let pettyTotal = 0;
    let bankActive = 0;
    let cashActive = 0;

    for (const b of banksRaw) {
      const code = resolveBankCode(b);
      let bal = glBalanceOnCode(db, code);
      if (bal === 0) {
        const legacy = '1102-' + b.id;
        if (legacy !== code) {
          const leg = glBalanceOnCode(db, legacy);
          if (leg) bal = leg;
        }
      }
      allCodes.push(code);
      const active = Number(b.active) !== 0;
      if (active) {
        banksTotal += bal;
        bankActive++;
      }
      const row = {
        id: b.id,
        name: b.name,
        coa_code: String(b.coa_code || '').trim() || null,
        balance_rial: bal,
        opening_balance_rial: Math.round(Number(b.opening_balance_rial) || 0),
        active,
        currency: b.currency || 'IRR',
        is_foreign: !!b.is_foreign,
        share_pct: 0,
        alerts: [],
      };
      row.alerts = instrumentAlerts(row);
      banks.push(row);
    }

    for (const c of boxesRaw) {
      const code = resolveCashCode(c);
      let bal = glBalanceOnCode(db, code);
      if (bal === 0) {
        const legacy = '1101-' + c.id;
        if (legacy !== code) {
          const leg = glBalanceOnCode(db, legacy);
          if (leg) bal = leg;
        }
      }
      allCodes.push(code);
      const active = Number(c.active) !== 0;
      const isPetty = !!c.is_petty_cash;
      if (active) {
        cashActive++;
        if (isPetty) pettyTotal += bal;
        else cashTotal += bal;
      }
      const row = {
        id: c.id,
        name: c.name,
        coa_code: String(c.coa_code || '').trim() || null,
        balance_rial: bal,
        opening_balance_rial: Math.round(Number(c.opening_balance_rial) || 0),
        active,
        is_petty_cash: isPetty,
        currency: c.currency || 'IRR',
        share_pct: 0,
        alerts: [],
      };
      row.alerts = instrumentAlerts(row);
      cash_boxes.push(row);
    }

    const totalLive = sumCashBankBalanceRial(db);
    const denom = Math.abs(totalLive) || 1;
    for (const r of banks) {
      r.share_pct = Math.round((Math.abs(r.balance_rial) / denom) * 1000) / 10;
    }
    for (const r of cash_boxes) {
      r.share_pct = Math.round((Math.abs(r.balance_rial) / denom) * 1000) / 10;
    }
    banks.sort((a, b) => Math.abs(b.balance_rial) - Math.abs(a.balance_rial));
    cash_boxes.sort((a, b) => Math.abs(b.balance_rial) - Math.abs(a.balance_rial));

    const movement = periodMovementOnCodes(db, allCodes, from, to);
    const cashFlow = buildCashFlowReport(db, from, to);
    const recon = buildReconciliation(db, banksRaw);
    const cheques = chequeStats(db);
    const monthly_net = monthlyNetOnCodes(db, allCodes, from, to);

    const kpis = {
      total_liquidity_rial: Math.round(totalLive),
      banks_total_rial: Math.round(banksTotal),
      cash_total_rial: Math.round(cashTotal),
      petty_cash_rial: Math.round(pettyTotal),
      bank_count_active: bankActive,
      cash_count_active: cashActive,
      period_inflow_rial: movement.inflow_rial,
      period_outflow_rial: movement.outflow_rial,
      period_net_rial: movement.net_rial,
    };

    const combined = [
      ...banks.filter((b) => b.active).map((b) => ({ name: b.name, bal: b.balance_rial })),
      ...cash_boxes.filter((c) => c.active).map((c) => ({ name: c.name, bal: c.balance_rial })),
    ].sort((a, b) => Math.abs(b.bal) - Math.abs(a.bal));
    const top = combined[0];
    const topPct = top && Math.abs(totalLive) > 0
      ? Math.round((Math.abs(top.bal) / Math.abs(totalLive)) * 1000) / 10
      : 0;
    const concentration = {
      top_name: top ? top.name : null,
      top_pct: topPct,
      risk: topPct >= 70 ? 'high' : (topPct >= 45 ? 'medium' : 'ok'),
    };

    const compliance = buildCompliance(kpis, recon, cheques, banks.filter((b) => b.active), cash_boxes.filter((c) => c.active));
    const alerts = buildAlerts(banks.filter((b) => b.active), cash_boxes.filter((c) => c.active), recon, cheques);

    // Ensure cash-flow codes coverage includes our instruments (already via collectCashBankCodes)
    void collectCashBankCodes;

    return {
      generated_at: Date.now(),
      as_of: todayJalali(),
      from: from || '',
      to: to || '',
      health_score: healthScore(compliance),
      kpis,
      banks,
      cash_boxes,
      cash_flow: {
        sections: cashFlow.sections,
        total_net_rial: cashFlow.total_net_rial,
        warning: cashFlow.warning || '',
      },
      reconciliation: recon,
      cheques,
      concentration,
      compliance,
      alerts,
      monthly_net,
      warning: '',
    };
  } catch (e) {
    console.error('treasury-dashboard:', e && e.message);
    return emptyPayload(from, to, 'داشبورد نقدینگی با خطا ساخته شد');
  }
}

module.exports = {
  buildTreasuryDashboard,
  glBalanceOnCode,
  periodMovementOnCodes,
};
