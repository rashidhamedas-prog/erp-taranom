/**
 * داشبورد کنترل حساب اشخاص — KPI + پیری + لیست کنترل + worklist
 * مانده زنده از party-books (ریال، مثبت=بدهکار).
 */
'use strict';

const { j2g } = require('../jalali');
const { partySignedBalanceDetailMap, glSignedForCoa, partyBooksMismatch } = require('./party-books');
const { firmSaleAliveSql } = require('./sales-document');
const { customerArExposureRial, resolvePartyCreditLimitRial } = require('./party-credit');

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

/**
 * FIFO aging per customer (rial remaining after settlement pool) — same math as /adv-reports/aging.
 * Returns Map<custId, { oldest_days, b0_30, b31_60, b61_90, b90plus, total }>.
 */
function customerAgingFifoMap(db) {
  const map = new Map();
  if (!tableExists(db, 'customers') || !tableExists(db, 'invoices')) return map;

  let invoices = [];
  try {
    invoices = db.prepare(`
      SELECT cust_id, id, date, COALESCE(NULLIF(final_rial,0), ROUND(final), 0) AS final_rial
      FROM invoices
      WHERE ${firmSaleAliveSql()}
      ORDER BY cust_id ASC, date ASC, id ASC
    `).all();
  } catch (_) {
    return map;
  }

  const settled = new Map();
  try {
    for (const r of db.prepare(`
      SELECT cust_id,
             COALESCE(SUM(COALESCE(NULLIF(amount_rial,0), ROUND(amount), 0)), 0) AS s
      FROM settlements
      WHERE COALESCE(status,'posted')<>'reversed'
      GROUP BY cust_id
    `).all()) {
      settled.set(Number(r.cust_id), Number(r.s) || 0);
    }
  } catch (_) { /* */ }

  let curCust = null;
  let pool = 0;
  let oldestDays = null;
  let buckets = emptyAging();

  const flush = (cid) => {
    if (cid == null) return;
    if ((buckets.total || 0) > 0.01 || oldestDays != null) {
      map.set(cid, {
        oldest_days: oldestDays,
        b0_30: buckets.b0_30,
        b31_60: buckets.b31_60,
        b61_90: buckets.b61_90,
        b90plus: buckets.b90plus,
        total: buckets.total,
      });
    }
  };

  for (const inv of invoices) {
    const cid = Number(inv.cust_id);
    if (cid !== curCust) {
      flush(curCust);
      curCust = cid;
      pool = settled.get(cid) || 0;
      oldestDays = null;
      buckets = emptyAging();
    }
    let remaining = Number(inv.final_rial) || 0;
    if (pool > 0) {
      const applied = Math.min(pool, remaining);
      remaining -= applied;
      pool -= applied;
    }
    if (remaining <= 0.01) continue;
    const age = daysSinceJalali(inv.date);
    if (oldestDays == null || age > oldestDays) oldestDays = age;
    const b = agingBucket(age);
    buckets[b] += remaining;
    buckets.total += remaining;
  }
  flush(curCust);
  return map;
}

function emptyAging() {
  return { b0_30: 0, b31_60: 0, b61_90: 0, b90plus: 0, total: 0 };
}

/** parties.user_id is the کارت شخص «کارشناس»; customer owner is the fallback. */
function resolveExpertId(partyUserId, fallbackId) {
  const direct = Number(partyUserId) || 0;
  if (direct > 0) return direct;
  const fb = Number(fallbackId) || 0;
  return fb > 0 ? fb : null;
}

function parseExpertFilter(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s || s === 'all') return null;
  if (s === 'none' || s === '0') return 'none';
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return n > 0 ? n : null;
  }
  return null;
}

function primaryRole(roles) {
  const order = ['customer', 'supplier', 'employee', 'rep', 'shareholder', 'person', 'other'];
  const list = Array.isArray(roles) ? roles : [];
  for (const r of order) {
    if (list.includes(r)) return r;
  }
  return list[0] || 'other';
}

function nextActionFor(r) {
  if (r.over_credit) {
    return { code: 'credit_limit', label: 'بررسی سقف اعتبار / پیگیری وصول' };
  }
  if (r.books_mismatch) {
    return { code: 'reconcile', label: 'تطبیق دفتر اشخاص با تفصیلی' };
  }
  if ((Number(r.aging_b90plus) || 0) > 0 || (r.aging_bucket === 'b90plus' && (Number(r.aging_total_rial) || 0) > 0)) {
    return { code: 'collect_overdue', label: 'وصول مطالبات دیرکرد ۹۰+ روز' };
  }
  if (r.aging_days != null && r.aging_days > 60 && (Number(r.aging_total_rial) || r.balance_rial > 0)) {
    return { code: 'follow_up', label: 'پیگیری وصول (۶۰+ روز)' };
  }
  if (r.balance_rial > 0) {
    return { code: 'collect', label: 'پیگیری دریافت' };
  }
  if (r.balance_rial < 0) {
    return { code: 'pay', label: 'بررسی پرداخت بدهی' };
  }
  return { code: 'review', label: 'بازبینی کارت شخص' };
}

function summarizeParties(rows) {
  const byRole = {};
  const aging = emptyAging();
  let totalDebit = 0;
  let totalCredit = 0;
  let withBal = 0;
  let overCreditCount = 0;
  let overCreditRial = 0;
  let mismatchCount = 0;
  let highRiskCount = 0;
  let mediumRiskCount = 0;
  for (const r of rows) {
    const roles = r.party_roles && r.party_roles.length ? r.party_roles : ['other'];
    // شمارش سمت‌ها برای فیلتر؛ مبلغ فقط روی سمت اصلی تا جمع سمت‌ها دوبل نشود
    const moneyRole = primaryRole(roles);
    for (const role of roles) {
      if (!byRole[role]) {
        byRole[role] = { role, label: ROLE_LABELS[role] || role, count: 0, debit_rial: 0, credit_rial: 0, with_balance: 0 };
      }
      byRole[role].count += 1;
      if (r.balance_rial !== 0) byRole[role].with_balance += 1;
    }
    if (!byRole[moneyRole]) {
      byRole[moneyRole] = { role: moneyRole, label: ROLE_LABELS[moneyRole] || moneyRole, count: 0, debit_rial: 0, credit_rial: 0, with_balance: 0 };
    }
    byRole[moneyRole].debit_rial += r.debit_rial;
    byRole[moneyRole].credit_rial += r.credit_rial;
    if (r.balance_rial !== 0) withBal += 1;
    totalDebit += r.debit_rial;
    totalCredit += r.credit_rial;
    if (r.over_credit) {
      overCreditCount += 1;
      overCreditRial += (Number(r.credit_used_rial) || 0) - (Number(r.credit_limit_rial) || 0);
    }
    if (r.books_mismatch) mismatchCount += 1;
    if (r.risk_level === 'high') highRiskCount += 1;
    else if (r.risk_level === 'medium') mediumRiskCount += 1;
    // پیری = ماندهٔ واقعی FIFO فاکتور (نه کل debit شخص)
    const aTot = Number(r.aging_total_rial) || 0;
    if (aTot > 0) {
      aging.b0_30 += Number(r.aging_b0_30) || 0;
      aging.b31_60 += Number(r.aging_b31_60) || 0;
      aging.b61_90 += Number(r.aging_b61_90) || 0;
      aging.b90plus += Number(r.aging_b90plus) || 0;
      aging.total += aTot;
    }
  }
  return {
    byRole, aging, totalDebit, totalCredit, withBal,
    overCreditCount, overCreditRial, mismatchCount, highRiskCount, mediumRiskCount,
  };
}

function buildPartyControlDashboard(db, query = {}) {
  const q = query || {};
  const search = String(q.search || '').replace(/ي/g, 'ی').replace(/ك/g, 'ک').trim();
  const roleFilter = String(q.role || '').toLowerCase().trim();
  const side = String(q.side || 'all').toLowerCase(); // debit | credit | all
  const balanceMode = String(q.balance || 'nonzero').toLowerCase(); // nonzero | zero | all
  const risk = String(q.risk || 'all').toLowerCase(); // over_credit | mismatch | high | medium | all
  const agingBucketFilter = String(q.aging_bucket || q.aging || '').toLowerCase().trim(); // b0_30|b31_60|b61_90|b90plus
  const groupId = q.party_group_id ? parseInt(q.party_group_id, 10) : null;
  const positionId = q.position_id ? parseInt(q.position_id, 10) : null;
  const sort = String(q.sort || 'balance_abs').toLowerCase();
  const lim = Math.min(500, Math.max(20, parseInt(q.limit, 10) || 200));
  const worklistLim = Math.min(50, Math.max(10, parseInt(q.worklist_limit, 10) || 25));
  const expertFilter = parseExpertFilter(q.expert_id != null && q.expert_id !== '' ? q.expert_id : q.expert);

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
      by_role: [],
      aging: emptyAging(),
      parties: [],
      worklist: [],
      alerts: [],
      filters: q,
    };
  }

  const balDetail = partySignedBalanceDetailMap(db);
  const agingByCust = customerAgingFifoMap(db);

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

  const expertNameById = new Map();
  if (tableExists(db, 'users')) {
    try {
      for (const u of db.prepare('SELECT id, name FROM users').all()) {
        expertNameById.set(Number(u.id), String(u.name || '').trim());
      }
    } catch (_) { /* */ }
  }
  const custExpertByParty = new Map();
  if (tableExists(db, 'customers')) {
    try {
      const custs = db.prepare(`
        SELECT party_id, user_id, assigned_to
        FROM customers
        WHERE party_id IS NOT NULL
        ORDER BY id ASC
      `).all();
      for (const c of custs) {
        const pid = Number(c.party_id);
        const eid = Number(c.assigned_to) || Number(c.user_id) || 0;
        if (!pid || !eid || custExpertByParty.has(pid)) continue;
        custExpertByParty.set(pid, eid);
      }
    } catch (_) { /* assigned_to may be absent on a very old db */ }
  }

  const rows = db.prepare(`
    SELECT p.id, p.person_code, p.party_type, p.party_roles, p.full_name, p.company_name, p.biz,
           p.phone, p.mobile, p.city, p.coa_code, p.credit_limit, p.opening_balance,
           p.party_group_id, p.position_id, p.is_active, p.user_id,
           pg.name AS party_group_name, pp.name AS position_name
    FROM parties p
    LEFT JOIN party_groups pg ON pg.id = p.party_group_id
    LEFT JOIN person_positions pp ON pp.id = p.position_id
    WHERE COALESCE(p.is_active,1)=1
  `).all();

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
    const debitSide = balance > 0 ? balance : 0;
    const creditSide = balance < 0 ? -balance : 0;

    const custId = custLink.get(id) || null;
    const supId = supLink.get(id) || null;

    // سقف اعتبار = همان SoT گیت فروش (party-credit)؛ نه ماندهٔ خالص چندنقشی
    let creditLimit = Math.round(Number(p.credit_limit) || 0);
    let creditUsed = 0;
    if (custId) {
      try {
        creditLimit = resolvePartyCreditLimitRial(db, custId);
        creditUsed = customerArExposureRial(db, custId);
      } catch (_) {
        creditUsed = roles.includes('customer') ? Math.max(0, balance) : 0;
      }
    } else if (roles.includes('customer')) {
      creditUsed = Math.max(0, balance);
    }
    const overCredit = creditLimit > 0 && creditUsed > creditLimit;
    const utilPct = creditLimit > 0
      ? Math.round((creditUsed / creditLimit) * 1000) / 10
      : null;

    const fifo = custId ? agingByCust.get(custId) : null;
    const ageDays = fifo && fifo.oldest_days != null ? fifo.oldest_days : null;
    const agingTotal = fifo ? (Number(fifo.total) || 0) : 0;
    const bucket = ageDays != null && agingTotal > 0 ? agingBucket(ageDays) : null;
    const expertId = resolveExpertId(p.user_id, custExpertByParty.get(id));
    const expertName = expertId ? (expertNameById.get(expertId) || ('#' + expertId)) : '';

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
      aging_b0_30: fifo ? (Number(fifo.b0_30) || 0) : 0,
      aging_b31_60: fifo ? (Number(fifo.b31_60) || 0) : 0,
      aging_b61_90: fifo ? (Number(fifo.b61_90) || 0) : 0,
      aging_b90plus: fifo ? (Number(fifo.b90plus) || 0) : 0,
      aging_total_rial: agingTotal,
      linked_customer_id: custId,
      linked_supplier_id: supId,
      expert_id: expertId,
      expert_name: expertName,
      risk_score: riskScore,
      risk_level: overCredit || (bucket === 'b90plus' && agingTotal > 0)
        ? 'high'
        : (booksMismatch || (ageDays != null && ageDays > 60 && agingTotal > 0) ? 'medium' : 'ok'),
      primary_role: primaryRole(roles),
    });
  }

  const expertCounts = new Map();
  let unassignedCount = 0;
  for (const r of all) {
    if (!r.expert_id) {
      unassignedCount += 1;
      continue;
    }
    const cur = expertCounts.get(r.expert_id) || { id: r.expert_id, name: r.expert_name, count: 0 };
    cur.count += 1;
    if (!cur.name && r.expert_name) cur.name = r.expert_name;
    expertCounts.set(r.expert_id, cur);
  }
  const experts = [...expertCounts.values()]
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'fa'));

  let scope = all;
  if (expertFilter === 'none') scope = all.filter((r) => !r.expert_id);
  else if (expertFilter) scope = all.filter((r) => r.expert_id === expertFilter);

  const summary = summarizeParties(scope);
  const byRole = summary.byRole;
  const aging = summary.aging;
  const totalDebit = summary.totalDebit;
  const totalCredit = summary.totalCredit;
  const withBal = summary.withBal;
  const overCreditCount = summary.overCreditCount;
  const overCreditRial = summary.overCreditRial;
  const mismatchCount = summary.mismatchCount;
  const highRiskCount = summary.highRiskCount;
  const mediumRiskCount = summary.mediumRiskCount;

  // Filters for table/worklist (expert already narrowed KPI scope)
  let filtered = scope.slice();
  if (search) {
    const s = search.toLowerCase();
    filtered = filtered.filter((r) => {
      const hay = [r.name, r.company_name, r.phone, r.person_code, r.coa_code, r.city, r.expert_name, ...(r.party_roles || [])]
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
  else if (risk === 'medium') filtered = filtered.filter((r) => r.risk_level === 'medium' || r.risk_level === 'high');
  if (agingBucketFilter && ['b0_30', 'b31_60', 'b61_90', 'b90plus'].includes(agingBucketFilter)) {
    filtered = filtered.filter((r) => {
      const key = 'aging_' + agingBucketFilter;
      const bucketAmt = Number(r[key]) || 0;
      return bucketAmt > 0 || (r.aging_bucket === agingBucketFilter && (Number(r.aging_total_rial) || 0) > 0);
    });
  }

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

  // Worklist = صف اقدام (نه کپی کامل جدول): ریسک/اختلاف/سقف/دیرکرد، سپس بزرگ‌ترین مانده‌ها
  const actionable = filtered.filter((r) => r.balance_rial !== 0 && (
    r.over_credit || r.books_mismatch || r.risk_level === 'high' || r.risk_level === 'medium'
    || (r.aging_days != null && r.aging_days >= 60)
  ));
  const workSrc = (actionable.length ? actionable : filtered.filter((r) => r.balance_rial !== 0))
    .slice()
    .sort((a, b) => b.risk_score - a.risk_score || Math.abs(b.balance_rial) - Math.abs(a.balance_rial));
  const worklist = workSrc.slice(0, worklistLim).map((r) => {
    const act = nextActionFor(r);
    return {
      id: r.id,
      name: r.name,
      person_code: r.person_code,
      coa_code: r.coa_code,
      balance_rial: r.balance_rial,
      debit_rial: r.debit_rial,
      credit_rial: r.credit_rial,
      risk_score: r.risk_score,
      risk_level: r.risk_level,
      over_credit: r.over_credit,
      books_mismatch: r.books_mismatch,
      aging_days: r.aging_days,
      aging_bucket: r.aging_bucket,
      credit_limit_rial: r.credit_limit_rial,
      credit_used_rial: r.credit_used_rial,
      credit_util_pct: r.credit_util_pct,
      party_roles: r.party_roles,
      role_labels: r.role_labels,
      primary_role: r.primary_role,
      expert_id: r.expert_id,
      expert_name: r.expert_name,
      linked_customer_id: r.linked_customer_id,
      linked_supplier_id: r.linked_supplier_id,
      next_action: act.label,
      next_action_code: act.code,
    };
  });

  const topDebtors = scope
    .filter((r) => r.balance_rial > 0)
    .slice()
    .sort((a, b) => b.balance_rial - a.balance_rial);
  const top5Debit = topDebtors.slice(0, 5).reduce((s, r) => s + r.balance_rial, 0);
  const concentrationPct = totalDebit > 0
    ? Math.round((top5Debit / totalDebit) * 1000) / 10
    : 0;

  const alerts = [];
  if (overCreditCount) {
    alerts.push({
      severity: 'fail',
      title: 'عبور از سقف اعتبار',
      detail: `${overCreditCount} شخص از سقف عبور کرده‌اند (مازاد ${overCreditRial.toLocaleString('fa-IR')} ریال)`,
      action_nav: 'acc-party-control-dashboard',
      action_filter: { risk: 'over_credit', balance: 'nonzero' },
    });
  }
  if (mismatchCount) {
    alerts.push({
      severity: 'warn',
      title: 'اختلاف دفتر و تفصیلی',
      detail: `${mismatchCount} شخص ماندهٔ زنده با دفتر کل تفصیلی یکی نیست`,
      action_nav: 'acc-party-control-dashboard',
      action_filter: { risk: 'mismatch', balance: 'all' },
    });
  }
  if (aging.b90plus > 0) {
    alerts.push({
      severity: 'warn',
      title: 'مطالبات دیرکرد ۹۰+ روز',
      detail: `${aging.b90plus.toLocaleString('fa-IR')} ریال در سبد ۹۰ روز به بالا`,
      action_nav: 'acc-party-control-dashboard',
      action_filter: { aging_bucket: 'b90plus', side: 'debit', balance: 'nonzero' },
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
    version: 534,
    kpis: {
      parties_total: all.length,
      parties_in_scope: scope.length,
      parties_with_balance: withBal,
      parties_filtered: filtered.length,
      total_debit_rial: totalDebit,
      total_credit_rial: totalCredit,
      net_signed_rial: totalDebit - totalCredit,
      over_credit_count: overCreditCount,
      over_credit_rial: overCreditRial,
      mismatch_count: mismatchCount,
      high_risk_count: highRiskCount,
      medium_risk_count: mediumRiskCount,
      aging_90_rial: aging.b90plus || 0,
      top5_debtor_share_pct: concentrationPct,
      worklist_count: worklist.length,
    },
    by_role: Object.values(byRole).sort((a, b) => (b.debit_rial + b.credit_rial) - (a.debit_rial + a.credit_rial)),
    aging,
    parties,
    worklist,
    alerts,
    experts,
    unassigned_count: unassignedCount,
    concentration: {
      top5_debit_rial: top5Debit,
      top5_share_pct: concentrationPct,
      top_debtors: topDebtors.slice(0, 5).map((r) => ({
        id: r.id, name: r.name, balance_rial: r.balance_rial, expert_name: r.expert_name,
      })),
    },
    filters: {
      search, role: roleFilter || 'all', side, balance: balanceMode, risk,
      aging_bucket: agingBucketFilter || '',
      expert_id: expertFilter == null ? '' : expertFilter,
      party_group_id: groupId, position_id: positionId, sort, limit: lim,
      worklist_limit: worklistLim,
    },
  };
}

module.exports = {
  buildPartyControlDashboard,
  ROLE_LABELS,
  primaryRole,
  nextActionFor,
  customerAgingFifoMap,
};
