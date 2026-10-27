'use strict';
/**
 * Cheque portfolio dashboard — matched to portal-ui renderChequeDashboardTab.
 * GL bridge 1109 / 1116 / 2109, aging, sayadi compliance, alerts.
 * Phase 4B: horizon KPIs (7/30/90), overdue, sayadi/sayad, leaf expiry, protest window, guarantee, cashflow.
 * Never throws to HTTP.
 */

const { todayJalali, addDaysToJalali } = require('../jalali');
const { glBalanceOnCode } = require('./treasury-dashboard');
const { daysUntilDue: daysUntilDueShared } = require('./cheque-quality');

const GL_RECV = '1109';
const GL_COLLECTION = '1116';
const GL_PAY = '2109';

const { CLOSED_IN, CLOSED_OUT } = require('./cheque-lifecycle');
const COLLECTION_LC = new Set(['in_collection']);
const REGISTERED_OPEN = new Set(['', 'registered', 'in_hand', 'pending']);
const BOUNCED_LC = new Set(['bounced', 'bounced_out']);

/** Blank leaves near 3-year صیاد validity (issue_date + ~1095d); warn window = 90 days. */
const LEAF_VALIDITY_DAYS = 1095;
const LEAF_NEAR_DAYS = 90;
/** Protest / واخواست rights vs endorser: 6 months ≈ 180d from due; near = ≤30d left. */
const PROTEST_WINDOW_DAYS = 180;
const PROTEST_NEAR_DAYS = 30;

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

function chequeAmountExpr(db) {
  if (tableHasColumn(db, 'cheque_records', 'amount_rial')) return 'COALESCE(amount_rial, amount, 0)';
  return 'COALESCE(amount, 0)';
}

function isAliveSql(db) {
  const parts = ['1=1'];
  if (tableHasColumn(db, 'cheque_records', 'reversed_at')) {
    parts.push('COALESCE(reversed_at,0)=0');
  }
  if (tableHasColumn(db, 'cheque_records', 'record_status')) {
    parts.push("COALESCE(record_status,'posted') NOT IN ('void','reversed')");
  }
  return parts.join(' AND ');
}

function lifecycleCol(db) {
  if (tableHasColumn(db, 'cheque_records', 'lifecycle_status')) return 'lifecycle_status';
  if (tableHasColumn(db, 'cheque_records', 'status')) return 'status';
  return null;
}

function isSayadiValid(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length === 16;
}

function daysUntilDue(due, today) {
  return daysUntilDueShared(due, today);
}

function emptyBucket() {
  return { count: 0, amount_rial: 0 };
}

function emptyHorizonDir() {
  return { in: emptyBucket(), out: emptyBucket(), total: emptyBucket() };
}

function bumpBucket(b, amt) {
  b.count += 1;
  b.amount_rial += amt;
}

function agingBucket(days) {
  if (days == null) return 'unknown';
  if (days < 0) return 'overdue';
  if (days <= 7) return '0_7';
  if (days <= 30) return '8_30';
  if (days <= 90) return '31_90';
  return '90_plus';
}

function emptyOpsKpis() {
  return {
    due_7d: emptyHorizonDir(),
    due_30d: emptyHorizonDir(),
    due_90d: emptyHorizonDir(),
    overdue_open: emptyHorizonDir(),
    missing_sayadi: emptyBucket(),
    sayad_not_registered: emptyBucket(),
    leaves_near_3y_expiry: { count: 0, book_count: 0, books: [] },
    protests_near_deadline: emptyBucket(),
    guarantee: emptyBucket(),
  };
}

function emptyCashflow() {
  return [
    { bucket: 'overdue', label: 'سررسیدگذشته', inflow_rial: 0, outflow_rial: 0, net_rial: 0, in_count: 0, out_count: 0 },
    { bucket: '0_7', label: '۰–۷ روز', inflow_rial: 0, outflow_rial: 0, net_rial: 0, in_count: 0, out_count: 0 },
    { bucket: '8_30', label: '۸–۳۰ روز', inflow_rial: 0, outflow_rial: 0, net_rial: 0, in_count: 0, out_count: 0 },
    { bucket: '31_90', label: '۳۱–۹۰ روز', inflow_rial: 0, outflow_rial: 0, net_rial: 0, in_count: 0, out_count: 0 },
    { bucket: '90_plus', label: 'بیش از ۹۰ روز', inflow_rial: 0, outflow_rial: 0, net_rial: 0, in_count: 0, out_count: 0 },
  ];
}

function emptyPayload(from, to, warning) {
  return {
    generated_at: Date.now(),
    as_of: todayJalali(),
    from: from || '',
    to: to || '',
    health_score: 0,
    warning: warning || '',
    kpis: {
      recv_open_rial: 0,
      recv_collection_rial: 0,
      pay_open_rial: 0,
      recv_open_count: 0,
      pay_open_count: 0,
      overdue_recv_count: 0,
      overdue_recv_rial: 0,
      due_14d_count: 0,
      due_14d_rial: 0,
      bounced_count: 0,
      trust_open_count: 0,
    },
    ops_kpis: emptyOpsKpis(),
    cashflow_forecast: emptyCashflow(),
    gl_bridge: {
      gl_recv_1109_rial: 0,
      gl_collection_1116_rial: 0,
      gl_pay_2109_rial: 0,
      ops_recv_rial: 0,
      ops_collection_rial: 0,
      ops_pay_rial: 0,
      variance_recv_rial: 0,
      variance_collection_rial: 0,
      variance_pay_rial: 0,
    },
    aging: [],
    sayadi: { total_open: 0, valid_count: 0, missing_count: 0, invalid_count: 0, rate_pct: 0 },
    compliance: [],
    alerts: warning ? [{
      severity: 'fail',
      title: 'خطای داشبورد',
      detail: warning,
      action_nav: 'acc-cheque-dashboard',
    }] : [],
    highlights: { overdue: [], due_soon: [] },
  };
}

function healthScore(compliance) {
  const items = compliance || [];
  if (!items.length) return 0;
  let ok = 0;
  for (const c of items) {
    if (c.status === 'ok') ok++;
    else if (c.status === 'warn') ok += 0.5;
  }
  return Math.round((ok / items.length) * 100);
}

function buildCompliance(kpis, gl, sayadi) {
  const list = [];
  const tol = 500_000;
  const vRecv = Math.abs(gl.variance_recv_rial || 0);
  const vCol = Math.abs(gl.variance_collection_rial || 0);
  const vPay = Math.abs(gl.variance_pay_rial || 0);
  list.push({
    id: 'gl_recv_bridge',
    label: 'تطبیق اسناد دریافتنی (۱۱۰۹)',
    detail: vRecv <= tol
      ? 'مانده دفتر با پرتفوی عملیاتی هم‌خوان است'
      : `اختلاف ${vRecv.toLocaleString('fa-IR')} ریال — بررسی اسناد و چرخه چک`,
    status: vRecv <= tol ? 'ok' : (vRecv <= tol * 10 ? 'warn' : 'fail'),
    action_nav: 'acc-journal-docs',
  });
  list.push({
    id: 'gl_collection_bridge',
    label: 'تطبیق در جریان وصول (۱۱۱۶)',
    detail: vCol <= tol
      ? 'مانده دفتر با چک‌های واگذارشده هم‌خوان است'
      : `اختلاف ${vCol.toLocaleString('fa-IR')} ریال`,
    status: vCol <= tol ? 'ok' : (vCol <= tol * 10 ? 'warn' : 'fail'),
    action_nav: 'acc-cheque-register',
  });
  list.push({
    id: 'gl_pay_bridge',
    label: 'تطبیق اسناد پرداختنی (۲۱۰۹)',
    detail: vPay <= tol
      ? 'مانده دفتر با چک‌های پرداختنی باز هم‌خوان است'
      : `اختلاف ${vPay.toLocaleString('fa-IR')} ریال`,
    status: vPay <= tol ? 'ok' : (vPay <= tol * 10 ? 'warn' : 'fail'),
    action_nav: 'acc-cheques-pay',
  });
  list.push({
    id: 'sayadi_compliance',
    label: 'شناسه صیاد ۱۶ رقمی',
    detail: sayadi.missing_count + sayadi.invalid_count === 0
      ? 'همه چک‌های باز صیاد معتبر دارند'
      : `${sayadi.missing_count} بدون صیاد · ${sayadi.invalid_count} نامعتبر`,
    status: (sayadi.missing_count + sayadi.invalid_count) === 0 ? 'ok'
      : (sayadi.rate_pct >= 80 ? 'warn' : 'fail'),
    action_nav: 'acc-cheques-recv',
  });
  list.push({
    id: 'overdue_recv',
    label: 'سررسید گذشته (دریافتنی)',
    detail: kpis.overdue_recv_count === 0
      ? 'چک دریافتنی سررسیدگذشته باز ندارید'
      : `${kpis.overdue_recv_count} فقره · ${(kpis.overdue_recv_rial || 0).toLocaleString('fa-IR')} ریال`,
    status: kpis.overdue_recv_count === 0 ? 'ok' : (kpis.overdue_recv_count <= 3 ? 'warn' : 'fail'),
    action_nav: 'acc-cheque-register',
  });
  return list;
}

function buildAlerts(kpis, gl, sayadi, highlights, ops) {
  const alerts = [];
  if (kpis.overdue_recv_count > 0) {
    alerts.push({
      severity: kpis.overdue_recv_count > 5 ? 'fail' : 'warn',
      title: 'چک دریافتنی سررسیدگذشته',
      detail: `${kpis.overdue_recv_count} فقره نیازمند پیگیری وصول یا برگشت`,
      action_nav: 'acc-cheque-register',
    });
  }
  if (sayadi.missing_count > 0) {
    alerts.push({
      severity: 'warn',
      title: 'صیاد ناقص',
      detail: `${sayadi.missing_count} چک باز بدون شناسه ۱۶ رقمی`,
      action_nav: 'acc-cheques-recv',
    });
  }
  if (ops && ops.sayad_not_registered && ops.sayad_not_registered.count > 0) {
    alerts.push({
      severity: 'warn',
      title: 'صیاد ثبت‌نشده در سامانه',
      detail: `${ops.sayad_not_registered.count} چک باز با شناسه ولی بدون ثبت سامانه`,
      action_nav: 'acc-cheque-register',
    });
  }
  if (ops && ops.leaves_near_3y_expiry && ops.leaves_near_3y_expiry.count > 0) {
    alerts.push({
      severity: 'warn',
      title: 'انقضای ۳ساله برگ صیادی',
      detail: `${ops.leaves_near_3y_expiry.count} برگ سفید نزدیک انقضا در ${ops.leaves_near_3y_expiry.book_count} دسته`,
      action_nav: 'acc-check-categories',
    });
  }
  if (ops && ops.protests_near_deadline && ops.protests_near_deadline.count > 0) {
    alerts.push({
      severity: 'fail',
      title: 'مهلت ۶ماهه واخواست',
      detail: `${ops.protests_near_deadline.count} چک برگشتی نزدیک/گذشته از مهلت ظهرنویس`,
      action_nav: 'acc-cheque-register',
    });
  }
  if (Math.abs(gl?.variance_recv_rial || 0) > 5_000_000) {
    alerts.push({
      severity: 'fail',
      title: 'اختلاف دفتر ۱۱۰۹',
      detail: 'مانده حساب اسناد دریافتنی با پرتفوی عملیاتی فاصله دارد',
      action_nav: 'acc-trial-balance',
    });
  }
  if (kpis.due_14d_count > 0) {
    alerts.push({
      severity: 'warn',
      title: 'سررسید ۱۴ روز آینده',
      detail: `${kpis.due_14d_count} چک دریافتنی نزدیک سررسید`,
      action_nav: 'acc-cheque-dashboard',
    });
  }
  void highlights;
  return alerts;
}

function isOpenPortfolio(dir, lcVal) {
  if (dir === 'in') {
    if (COLLECTION_LC.has(lcVal)) return true;
    if (lcVal === 'guarantee') return false;
    return !CLOSED_IN.has(lcVal);
  }
  if (dir === 'out') {
    if (lcVal === 'guarantee') return false;
    return !CLOSED_OUT.has(lcVal) && REGISTERED_OPEN.has(lcVal);
  }
  return false;
}

function countLeavesNearExpiry(db, today) {
  const out = { count: 0, book_count: 0, books: [] };
  if (!tableExists(db, 'check_categories') || !tableHasColumn(db, 'check_categories', 'issue_date')) {
    return out;
  }
  try {
    const books = db.prepare(`
      SELECT id, name, issue_date, COALESCE(active,1) AS active
      FROM check_categories
      WHERE COALESCE(issue_date,'')<>''
        AND COALESCE(active,1)=1
        ${tableHasColumn(db, 'check_categories', 'deleted_at') ? 'AND COALESCE(deleted_at,0)=0' : ''}
    `).all();
    const hasLeaves = tableExists(db, 'cheque_book_leaves');
    for (const b of books) {
      const expiry = addDaysToJalali(String(b.issue_date).trim(), LEAF_VALIDITY_DAYS);
      const daysLeft = daysUntilDue(expiry, today);
      if (daysLeft == null) continue;
      if (daysLeft > LEAF_NEAR_DAYS) continue;
      let blank = 0;
      if (hasLeaves) {
        const row = db.prepare(`
          SELECT COUNT(*) AS n FROM cheque_book_leaves
          WHERE check_category_id=? AND status='blank'
        `).get(b.id);
        blank = Number(row && row.n) || 0;
      } else if (tableHasColumn(db, 'check_categories', 'leaf_count')) {
        blank = Math.max(0, Number(b.leaf_count) || 0);
      }
      if (blank <= 0 && daysLeft > 0) continue;
      out.book_count += 1;
      out.count += blank;
      out.books.push({
        id: b.id,
        name: b.name,
        issue_date: b.issue_date,
        expiry_date: expiry,
        days_left: daysLeft,
        blank_leaves: blank,
      });
    }
    out.books.sort((a, b) => (a.days_left || 0) - (b.days_left || 0));
    out.books = out.books.slice(0, 12);
  } catch (e) {
    console.error('cheque-dashboard leaves:', e && e.message);
  }
  return out;
}

/**
 * Phase 4B focused KPIs + cashflow (efficient single scan + small leaf query).
 * Used by GET /cheque-records/dashboard-kpis and embedded in buildChequeDashboard.
 */
function buildChequeDashboardKpis(db, todayRaw) {
  const today = String(todayRaw || todayJalali()).trim() || todayJalali();
  const ops = emptyOpsKpis();
  const cashflow = emptyCashflow();
  const cfByBucket = Object.fromEntries(cashflow.map((c) => [c.bucket, c]));

  try {
    if (!tableExists(db, 'cheque_records')) {
      return {
        generated_at: Date.now(),
        as_of: today,
        ops_kpis: ops,
        cashflow_forecast: cashflow,
        warning: 'جدول چک در دسترس نیست',
      };
    }

    const amt = chequeAmountExpr(db);
    const alive = isAliveSql(db);
    const lc = lifecycleCol(db);
    const hasSayadReg = tableHasColumn(db, 'cheque_records', 'sayad_registered');
    const hasIsGuarantee = tableHasColumn(db, 'cheque_records', 'is_guarantee');

    const cols = [
      'id', 'direction',
      `${lc ? lc : "''"} AS lc`,
      'due_date', 'sayadi',
      `${amt} AS amount_rial`,
    ];
    if (hasSayadReg) cols.push('COALESCE(sayad_registered,0) AS sayad_registered');
    else cols.push('0 AS sayad_registered');
    if (hasIsGuarantee) cols.push('COALESCE(is_guarantee,0) AS is_guarantee');
    else cols.push('0 AS is_guarantee');

    const rows = db.prepare(`
      SELECT ${cols.join(', ')}
      FROM cheque_records
      WHERE ${alive}
    `).all();

    for (const r of rows) {
      const dir = String(r.direction || '').trim();
      const lcVal = String(r.lc || '').trim().toLowerCase();
      const amtR = Math.round(Number(r.amount_rial) || 0);
      const isIn = dir === 'in';
      const isOut = dir === 'out';
      const dirKey = isIn ? 'in' : (isOut ? 'out' : null);
      const open = isOpenPortfolio(dir, lcVal);
      const isGuarantee = lcVal === 'guarantee' || Number(r.is_guarantee) === 1;

      if (isGuarantee) {
        bumpBucket(ops.guarantee, amtR);
      }

      if (BOUNCED_LC.has(lcVal)) {
        const due = String(r.due_date || '').trim();
        if (due) {
          const deadline = addDaysToJalali(due, PROTEST_WINDOW_DAYS);
          const daysTo = daysUntilDue(deadline, today);
          if (daysTo != null && daysTo <= PROTEST_NEAR_DAYS) {
            bumpBucket(ops.protests_near_deadline, amtR);
          }
        }
      }

      // تضمینی از افق سررسید/معوق باز جدا است
      if (!open || !dirKey || isGuarantee) continue;

      const say = String(r.sayadi || '').trim();
      if (!say) bumpBucket(ops.missing_sayadi, amtR);
      else if (Number(r.sayad_registered) !== 1) bumpBucket(ops.sayad_not_registered, amtR);

      const days = daysUntilDue(r.due_date, today);
      if (days == null) continue;

      if (days < 0) {
        bumpBucket(ops.overdue_open[dirKey], amtR);
        bumpBucket(ops.overdue_open.total, amtR);
      } else {
        if (days <= 7) {
          bumpBucket(ops.due_7d[dirKey], amtR);
          bumpBucket(ops.due_7d.total, amtR);
        }
        if (days <= 30) {
          bumpBucket(ops.due_30d[dirKey], amtR);
          bumpBucket(ops.due_30d.total, amtR);
        }
        if (days <= 90) {
          bumpBucket(ops.due_90d[dirKey], amtR);
          bumpBucket(ops.due_90d.total, amtR);
        }
      }

      const buck = agingBucket(days);
      const cf = cfByBucket[buck];
      if (cf) {
        if (isIn) {
          cf.inflow_rial += amtR;
          cf.in_count += 1;
        } else if (isOut) {
          cf.outflow_rial += amtR;
          cf.out_count += 1;
        }
        cf.net_rial = cf.inflow_rial - cf.outflow_rial;
      }
    }

    ops.leaves_near_3y_expiry = countLeavesNearExpiry(db, today);

    return {
      generated_at: Date.now(),
      as_of: today,
      ops_kpis: ops,
      cashflow_forecast: cashflow,
      warning: '',
    };
  } catch (e) {
    console.error('cheque-dashboard-kpis:', e && e.message);
    return {
      generated_at: Date.now(),
      as_of: today,
      ops_kpis: emptyOpsKpis(),
      cashflow_forecast: emptyCashflow(),
      warning: 'KPI داشبورد چک با خطا ساخته شد',
    };
  }
}

function buildChequeDashboard(db, from, to) {
  void from;
  void to;
  try {
    if (!tableExists(db, 'cheque_records')) {
      return emptyPayload(from, to, 'جدول چک در دسترس نیست');
    }
    const amt = chequeAmountExpr(db);
    const alive = isAliveSql(db);
    const lc = lifecycleCol(db);
    const today = todayJalali();
    const phase4 = buildChequeDashboardKpis(db, today);

    const rows = db.prepare(`
      SELECT id, direction, ${lc ? lc : "''"} AS lc, due_date, sayadi, party_name, cheque_number, ${amt} AS amount_rial
      FROM cheque_records
      WHERE ${alive}
    `).all();

    const kpis = {
      recv_open_rial: 0,
      recv_collection_rial: 0,
      pay_open_rial: 0,
      recv_open_count: 0,
      pay_open_count: 0,
      overdue_recv_count: 0,
      overdue_recv_rial: 0,
      due_14d_count: 0,
      due_14d_rial: 0,
      bounced_count: 0,
      trust_open_count: 0,
    };

    const agingMap = {
      overdue: { bucket: 'overdue', label: 'سررسید گذشته', count: 0, amount_rial: 0 },
      '0_7': { bucket: '0_7', label: '۰–۷ روز', count: 0, amount_rial: 0 },
      '8_30': { bucket: '8_30', label: '۸–۳۰ روز', count: 0, amount_rial: 0 },
      '31_90': { bucket: '31_90', label: '۳۱–۹۰ روز', count: 0, amount_rial: 0 },
      '90_plus': { bucket: '90_plus', label: 'بیش از ۹۰ روز', count: 0, amount_rial: 0 },
      unknown: { bucket: 'unknown', label: 'بدون سررسید', count: 0, amount_rial: 0 },
    };

    let sayadiTotal = 0;
    let sayadiValid = 0;
    let sayadiMissing = 0;
    let sayadiInvalid = 0;
    const overdueList = [];
    const dueSoonList = [];

    for (const r of rows) {
      const dir = String(r.direction || '').trim();
      const lcVal = String(r.lc || '').trim().toLowerCase();
      const amtR = Math.round(Number(r.amount_rial) || 0);
      if (lcVal === 'bounced' || lcVal === 'bounced_out') kpis.bounced_count++;

      const isIn = dir === 'in';
      const isOut = dir === 'out';
      const closedIn = CLOSED_IN.has(lcVal);
      const closedOut = CLOSED_OUT.has(lcVal);

      if (isIn && COLLECTION_LC.has(lcVal)) {
        kpis.recv_collection_rial += amtR;
      } else if (isIn && !closedIn && lcVal !== 'guarantee') {
        kpis.recv_open_rial += amtR;
        kpis.recv_open_count++;
        sayadiTotal++;
        if (!String(r.sayadi || '').trim()) sayadiMissing++;
        else if (isSayadiValid(r.sayadi)) sayadiValid++;
        else sayadiInvalid++;

        const days = daysUntilDue(r.due_date, today);
        const bucket = agingBucket(days);
        if (agingMap[bucket]) {
          agingMap[bucket].count++;
          agingMap[bucket].amount_rial += amtR;
        }
        if (days != null && days < 0) {
          kpis.overdue_recv_count++;
          kpis.overdue_recv_rial += amtR;
          overdueList.push({
            id: r.id,
            cheque_number: r.cheque_number,
            party_name: r.party_name,
            due_date: r.due_date,
            amount_rial: amtR,
            days_overdue: -days,
          });
        } else if (days != null && days >= 0 && days <= 14) {
          kpis.due_14d_count++;
          kpis.due_14d_rial += amtR;
          dueSoonList.push({
            id: r.id,
            cheque_number: r.cheque_number,
            party_name: r.party_name,
            due_date: r.due_date,
            amount_rial: amtR,
            days_left: days,
          });
        }
      } else if (isOut && !closedOut && REGISTERED_OPEN.has(lcVal)) {
        kpis.pay_open_rial += amtR;
        kpis.pay_open_count++;
        sayadiTotal++;
        if (!String(r.sayadi || '').trim()) sayadiMissing++;
        else if (isSayadiValid(r.sayadi)) sayadiValid++;
        else sayadiInvalid++;
      }
    }

    if (tableExists(db, 'trust_checks')) {
      try {
        const tr = db.prepare(`
          SELECT COUNT(*) AS n FROM trust_checks
          WHERE COALESCE(status,'open') NOT IN ('returned','closed','cancelled')
            ${tableHasColumn(db, 'trust_checks', 'deleted_at') ? 'AND COALESCE(deleted_at,0)=0' : ''}
        `).get();
        kpis.trust_open_count = Number(tr && tr.n) || 0;
      } catch (_) { /* */ }
    }

    const gl_bridge = {
      gl_recv_1109_rial: glBalanceOnCode(db, GL_RECV),
      gl_collection_1116_rial: glBalanceOnCode(db, GL_COLLECTION),
      gl_pay_2109_rial: glBalanceOnCode(db, GL_PAY),
      ops_recv_rial: kpis.recv_open_rial,
      ops_collection_rial: kpis.recv_collection_rial,
      ops_pay_rial: kpis.pay_open_rial,
      variance_recv_rial: glBalanceOnCode(db, GL_RECV) - kpis.recv_open_rial,
      variance_collection_rial: glBalanceOnCode(db, GL_COLLECTION) - kpis.recv_collection_rial,
      variance_pay_rial: glBalanceOnCode(db, GL_PAY) - kpis.pay_open_rial,
    };
    const sayadi = {
      total_open: sayadiTotal,
      valid_count: sayadiValid,
      missing_count: sayadiMissing,
      invalid_count: sayadiInvalid,
      rate_pct: sayadiTotal > 0 ? Math.round((sayadiValid / sayadiTotal) * 100) : 100,
    };

    overdueList.sort((a, b) => (b.days_overdue || 0) - (a.days_overdue || 0));
    dueSoonList.sort((a, b) => (a.days_left || 0) - (b.days_left || 0));

    const ops_kpis = phase4.ops_kpis || emptyOpsKpis();
    const compliance = buildCompliance(kpis, gl_bridge, sayadi);
    const alerts = buildAlerts(
      kpis, gl_bridge, sayadi,
      { overdue: overdueList, due_soon: dueSoonList },
      ops_kpis,
    );

    return {
      generated_at: Date.now(),
      as_of: today,
      from: from || '',
      to: to || '',
      health_score: healthScore(compliance),
      warning: phase4.warning || '',
      kpis,
      ops_kpis,
      cashflow_forecast: phase4.cashflow_forecast || emptyCashflow(),
      gl_bridge,
      aging: Object.values(agingMap).filter((a) => a.count > 0 || a.bucket === 'overdue'),
      sayadi,
      compliance,
      alerts,
      highlights: {
        overdue: overdueList.slice(0, 8),
        due_soon: dueSoonList.slice(0, 8),
      },
    };
  } catch (e) {
    console.error('cheque-dashboard:', e && e.message);
    return emptyPayload(from, to, 'داشبورد چک با خطا ساخته شد');
  }
}

module.exports = {
  buildChequeDashboard,
  buildChequeDashboardKpis,
};
