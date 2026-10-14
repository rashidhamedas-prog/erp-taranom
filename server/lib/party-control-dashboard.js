/**
 * داشبورد کنترل حساب اشخاص — KPI + پیری + لیست کنترل + worklist
 * مانده زنده از party-books (ریال، مثبت=بدهکار).
 */
'use strict';

const { j2g } = require('../jalali');
const { partySignedBalanceDetailMap, glSignedForCoa, partyBooksMismatch } = require('./party-books');
const { firmSaleTypeSql } = require('./sales-document');

const ROLE_LABELS = {
  customer: 'مشتری',
  supplier: 'تأمین‌کننده',
  employee: 'کارمند',
  shareholder: 'سهامدار',
  other: 'سایر',
  person: 'شخص',
  rep: 'نماینده',
};

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch (_) {
    return false;
  }
}

function daysSinceJalali(dateStr) {
  try {
    const [jy, jm, jd] = String(dateStr || '').split('/').map(Number);
    if (!jy || !jm || !jd) return 0;
    const [gy, gm, gd] = j2g(jy, jm, jd);
    const then = new Date(gy, gm - 1, gd);
    const now = new Date();
    return Math.max(0, Math.floor((now - then) / (1000 * 60 * 60 * 24)));
  } catch (_) {
    return 0;
  }
}

function parseRoles(raw, partyType) {
  let roles = [];
  if (Array.isArray(raw)) roles = raw.slice();
  else if (typeof raw === 'string' && raw.trim()) {
    try {
      const j = JSON.parse(raw);
      if (Array.isArray(j)) roles = j;
      else roles = String(raw).split(/[|,،]/).map((s) => s.trim()).filter(Boolean);
    } catch (_) {
      roles = String(raw).split(/[|,،]/).map((s) => s.trim()).filter(Boolean);
    }
  }
  roles = roles.map((r) => String(r || '').toLowerCase().trim()).filter(Boolean);
  if (!roles.length && partyType) roles = [String(partyType).toLowerCase()];
  return [...new Set(roles)];
}

function agingBucket(days) {
  const d = Number(days) || 0;
  if (d <= 30) return 'b0_30';
  if (d <= 60) return 'b31_60';
  if (d <= 90) return 'b61_90';
  return 'b90plus';
}

/** Oldest unpaid firm-invoice age (days) per customer_id — FIFO vs settlements */
function customerAgingDaysMap(db) {
  const map = new Map();
  if (!tableExists(db, 'customers') || !tableExists(db, 'invoices')) return map;
  let customers;
  try {
    customers = db.prepare('SELECT id FROM customers').all();
  } catch (_) {
    return map;
  }
  for (const c of customers) {
    const invoices = db.prepare(`
      SELECT id, date, COALESCE(NULLIF(final_rial,0), ROUND(final), 0) AS final_rial
      FROM invoices
      WHERE cust_id=? AND ${firmSaleTypeSql()} AND COALESCE(deleted_at,0)=0
      ORDER BY date ASC, id ASC
    `).all(c.id);
    if (!invoices.length) continue;
    let settledPool = 0;
    try {
      settledPool = db.prepare(`
        SELECT COALESCE(SUM(COALESCE(NULLIF(amount_rial,0), ROUND(amount), 0)), 0) AS s
        FROM settlements
        WHERE cust_id=? AND COALESCE(status,'posted')<>'reversed'
      `).get(c.id).s;
    } catch (_) {
      settledPool = 0;
    }
    let oldestDays = null;
    for (const inv of invoices) {
      let remaining = Number(inv.final_rial) || 0;
      if (settledPool > 0) {
        const applied = Math.min(settledPool, remaining);
        remaining -= applied;
        settledPool -= applied;
      }
      if (remaining <= 0.01) continue;
      const age = daysSinceJalali(inv.date);
      if (oldestDays == null || age > oldestDays) oldestDays = age;
    }
    if (oldestDays != null) map.set(Number(c.id), oldestDays);
  }
  return map;
}

function emptyAging() {
  return { b0_30: 0, b31_60: 0, b61_90: 0, b90plus: 0, total: 0 };
}

function buildPartyControlDashboard(db, query = {}) {
  const q = query || {};
  const search = String(q.search || '').replace(/ي/g, 'ی').replace(/ك/g, 'ک').trim();
  const roleFilter = String(q.role || '').toLowerCase().trim();
  const side = String(q.side || 'all').toLowerCase(); // debit | credit | all
  const balanceMode = String(q.balance || 'nonzero').toLowerCase(); // nonzero | zero | all
  const risk = String(q.risk || 'all').toLowerCase(); // over_credit | mismatch | high | all
  const groupId = q.party_group_id ? parseInt(q.party_group_id, 10) : null;
  const positionId = q.position_id ? parseInt(q.position_id, 10) : null;
  const sort = String(q.sort || 'balance_abs').toLowerCase();
  const lim = Math.min(500, Math.max(20, parseInt(q.limit, 10) || 200));

  if (!tableExists(db, 'parties')) {
    return {
      generated_at: Date.now(),
      health_score: 100,
      kpis: {
        parties_total: 0,
        parties_with_balance: 0,
        total_debit_rial: 0,
        total_credit_rial: 0,
        net_signed_rial: 0,
        over_credit_count: 0,
        mismatch_count: 0,
      },
      by_role: {},
      aging: emptyAging(),
      parties: [],
      worklist: [],
      alerts: [],
      filters: q,
    };
  }

  const balDetail = partySignedBalanceDetailMap(db);
  const agingByCust = customerAgingDaysMap(db);

  const custLink = new Map();
  const supLink = new Map();
  if (tableExists(db, 'customers')) {
    try {
      for (const r of db.prepare('SELECT id, party_id FROM customers WHERE party_id IS NOT NULL').all()) {
        custLink.set(Number(r.party_id), Number(r.id));
      }
    } catch (_) { /* */ }
  }
  if (tableExists(db, 'suppliers')) {
    try {
      for (const r of db.prepare('SELECT id, party_id FROM suppliers WHERE party_id IS NOT NULL').all()) {
        supLink.set(Number(r.party_id), Number(r.id));
      }
    } catch (_) { /* */ }
  }

  const rows = db.prepare(`
    SELECT p.id, p.person_code, p.party_type, p.party_roles, p.full_name, p.company_name, p.biz,
           p.phone, p.mobile, p.city, p.coa_code, p.credit_limit, p.opening_balance,
           p.party_group_id, p.position_id, p.is_active,
           pg.name AS party_group_name, pp.name AS position_name
    FROM parties p
    LEFT JOIN party_groups pg ON pg.id = p.party_group_id
    LEFT JOIN person_positions pp ON pp.id = p.position_id
    WHERE COALESCE(p.is_active,1)=1
  `).all();

  const byRole = {};
  const aging = emptyAging();
  let totalDebit = 0;
  let totalCredit = 0;
  let withBal = 0;
  let overCreditCount = 0;
  let overCreditRial = 0;
  let mismatchCount = 0;

  const all = [];
  for (const p of rows) {
    const id = Number(p.id);
    const roles = parseRoles(p.party_roles, p.party_type);
    const info = balDetail.get(id) || {
      balance: Math.round(Number(p.opening_balance) || 0),
      source: 'opening',
      coa_code: p.coa_code || null,
    };
    const balance = info.balance;
    // Per-leaf compare (dual-role AR≠AP must not false-flag across leaves)
    const leaf = info.coa_code || p.coa_code || null;
    const glBal = leaf ? glSignedForCoa(db, leaf) : null;
    const booksMismatch = partyBooksMismatch(db, info);
    const creditLimit = Math.round(Number(p.credit_limit) || 0);
    const debitSide = balance > 0 ? balance : 0;
    const creditSide = balance < 0 ? -balance : 0;
    const creditUsed = roles.includes('customer') ? Math.max(0, balance) : 0;
    const overCredit = creditLimit > 0 && creditUsed > creditLimit;
    const utilPct = creditLimit > 0
      ? Math.round((creditUsed / creditLimit) * 1000) / 10
      : null;

    const custId = custLink.get(id) || null;
    const supId = supLink.get(id) || null;
    let ageDays = null;
    if (custId && agingByCust.has(custId) && balance > 0) {
      ageDays = agingByCust.get(custId);
    }
    const bucket = ageDays != null ? agingBucket(ageDays) : null;

    // Role aggregates (unfiltered universe for KPI by_role)
    for (const role of (roles.length ? roles : ['other'])) {
      if (!byRole[role]) byRole[role] = { role, label: ROLE_LABELS[role] || role, count: 0, debit_rial: 0, credit_rial: 0, with_balance: 0 };
      byRole[role].count += 1;
      byRole[role].debit_rial += debitSide;
      byRole[role].credit_rial += creditSide;
      if (balance !== 0) byRole[role].with_balance += 1;
    }

    if (balance !== 0) withBal += 1;
    totalDebit += debitSide;
    totalCredit += creditSide;
    if (overCredit) {
      overCreditCount += 1;
      overCreditRial += creditUsed - creditLimit;
    }
    if (booksMismatch) mismatchCount += 1;
    if (bucket && balance > 0) {
      aging[bucket] += debitSide;
      aging.total += debitSide;
    }

    const riskScore = Math.round(
      Math.abs(balance)
      * (1 + (ageDays || 0) / 60)
      * (overCredit ? 2.2 : 1)
      * (booksMismatch ? 1.6 : 1)
      * (bucket === 'b90plus' ? 1.4 : 1)
    );

    all.push({
      id,
      person_code: p.person_code || '',
      name: p.full_name || p.biz || p.company_name || ('#' + id),
      company_name: p.company_name || '',
      phone: p.phone || p.mobile || '',
      city: p.city || '',
      party_type: p.party_type || '',
      party_roles: roles,
      role_labels: roles.map((r) => ROLE_LABELS[r] || r),
      party_group_id: p.party_group_id || null,
      party_group_name: p.party_group_name || '',
      position_id: p.position_id || null,
      position_name: p.position_name || '',
      coa_code: p.coa_code || '',
      balance_rial: balance,
      debit_rial: debitSide,
      credit_rial: creditSide,
      credit_limit_rial: creditLimit,
      credit_used_rial: creditUsed,
      credit_util_pct: utilPct,
      over_credit: overCredit,
      books_mismatch: booksMismatch,
      gl_balance_rial: glBal,
      balance_source: info.source || null,
      balance_coa_code: leaf,
      aging_days: ageDays,
      aging_bucket: bucket,
      linked_customer_id: custId,
      linked_supplier_id: supId,
      risk_score: riskScore,
      risk_level: overCredit || (bucket === 'b90plus' && balance > 0)
        ? 'high'
        : (booksMismatch || (ageDays != null && ageDays > 60) ? 'medium' : 'ok'),
    });
  }

  // Filters for table/worklist
  let filtered = all.slice();
  if (search) {
    const s = search.toLowerCase();
    filtered = filtered.filter((r) => {
      const hay = [r.name, r.company_name, r.phone, r.person_code, r.coa_code, r.city, ...(r.party_roles || [])]
        .join(' ').toLowerCase();
      return hay.includes(s);
    });
  }
  if (roleFilter && roleFilter !== 'all') {
    filtered = filtered.filter((r) => (r.party_roles || []).includes(roleFilter) || r.party_type === roleFilter);
  }
  if (groupId) filtered = filtered.filter((r) => Number(r.party_group_id) === groupId);
  if (positionId) filtered = filtered.filter((r) => Number(r.position_id) === positionId);
  if (side === 'debit') filtered = filtered.filter((r) => r.balance_rial > 0);
  else if (side === 'credit') filtered = filtered.filter((r) => r.balance_rial < 0);
  if (balanceMode === 'nonzero') filtered = filtered.filter((r) => r.balance_rial !== 0);
  else if (balanceMode === 'zero') filtered = filtered.filter((r) => r.balance_rial === 0);
  if (risk === 'over_credit') filtered = filtered.filter((r) => r.over_credit);
  else if (risk === 'mismatch') filtered = filtered.filter((r) => r.books_mismatch);
  else if (risk === 'high') filtered = filtered.filter((r) => r.risk_level === 'high');

  const sorter = {
    balance_abs: (a, b) => Math.abs(b.balance_rial) - Math.abs(a.balance_rial),
    balance: (a, b) => b.balance_rial - a.balance_rial,
    name: (a, b) => String(a.name).localeCompare(String(b.name), 'fa'),
    credit_util: (a, b) => (b.credit_util_pct || 0) - (a.credit_util_pct || 0),
    risk: (a, b) => b.risk_score - a.risk_score,
    aging: (a, b) => (b.aging_days || 0) - (a.aging_days || 0),
  };
  filtered.sort(sorter[sort] || sorter.balance_abs);

  const parties = filtered.slice(0, lim);
  const worklist = filtered
    .filter((r) => r.balance_rial !== 0 && (r.over_credit || r.books_mismatch || r.risk_level !== 'ok' || Math.abs(r.balance_rial) > 0))
    .slice()
    .sort((a, b) => b.risk_score - a.risk_score)
    .slice(0, 25)
    .map((r) => ({
      id: r.id,
      name: r.name,
      balance_rial: r.balance_rial,
      risk_score: r.risk_score,
      risk_level: r.risk_level,
      over_credit: r.over_credit,
      books_mismatch: r.books_mismatch,
      aging_days: r.aging_days,
      aging_bucket: r.aging_bucket,
      party_roles: r.party_roles,
      next_action: r.over_credit
        ? 'بررسی سقف اعتبار / پیگیری وصول'
        : (r.books_mismatch
          ? 'تطبیق دفتر اشخاص با تفصیلی'
          : (r.balance_rial > 0 ? 'پیگیری دریافت' : 'بررسی پرداخت بدهی')),
    }));

  const alerts = [];
  if (overCreditCount) {
    alerts.push({
      severity: 'fail',
      title: 'عبور از سقف اعتبار',
      detail: `${overCreditCount} شخص از سقف عبور کرده‌اند (مازاد ${overCreditRial.toLocaleString('fa-IR')} ریال)`,
      action_nav: 'acc-party-control-dashboard',
    });
  }
  if (mismatchCount) {
    alerts.push({
      severity: 'warn',
      title: 'اختلاف دفتر و تفصیلی',
      detail: `${mismatchCount} شخص ماندهٔ زنده با دفتر کل تفصیلی یکی نیست`,
      action_nav: 'acc-party-control-dashboard',
    });
  }
  if (aging.b90plus > 0) {
    alerts.push({
      severity: 'warn',
      title: 'مطالبات دیرکرد ۹۰+ روز',
      detail: `${aging.b90plus.toLocaleString('fa-IR')} ریال در سبد ۹۰ روز به بالا`,
      action_nav: 'acc-receivables',
    });
  }

  const healthPenalty =
    Math.min(40, overCreditCount * 8)
    + Math.min(30, mismatchCount * 5)
    + (aging.total > 0 ? Math.min(25, Math.round((aging.b90plus / Math.max(1, aging.total)) * 25)) : 0);
  const health_score = Math.max(0, 100 - healthPenalty);

  return {
    generated_at: Date.now(),
    health_score,
    unit: 'rial',
    kpis: {
      parties_total: all.length,
      parties_with_balance: withBal,
      parties_filtered: filtered.length,
      total_debit_rial: totalDebit,
      total_credit_rial: totalCredit,
      net_signed_rial: totalDebit - totalCredit,
      over_credit_count: overCreditCount,
      over_credit_rial: overCreditRial,
      mismatch_count: mismatchCount,
    },
    by_role: Object.values(byRole).sort((a, b) => (b.debit_rial + b.credit_rial) - (a.debit_rial + a.credit_rial)),
    aging,
    parties,
    worklist,
    alerts,
    filters: {
      search, role: roleFilter || 'all', side, balance: balanceMode, risk,
      party_group_id: groupId, position_id: positionId, sort, limit: lim,
    },
  };
}

module.exports = { buildPartyControlDashboard, ROLE_LABELS };
