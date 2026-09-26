'use strict';
/**
 * Checkbook / leaf inventory dashboard — portal-ui renderChequebookReportTab.
 * Never throws to HTTP.
 */

const { todayJalali } = require('../jalali');

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

function countUsedLeaves(db, categoryId) {
  try {
    const row = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM purchase_invoices WHERE check_category_id=?)
      + (SELECT COUNT(*) FROM supplier_payments WHERE check_category_id=?)
      + (SELECT COUNT(*) FROM incentive_payments WHERE check_category_id=?)
      AS c
    `).get(categoryId, categoryId, categoryId);
    return Number(row && row.c) || 0;
  } catch (_) {
    return 0;
  }
}

function emptyPayload(warning) {
  return {
    generated_at: Date.now(),
    as_of: todayJalali(),
    health_score: 0,
    warning: warning || '',
    kpis: {
      book_count: 0,
      active_books: 0,
      total_leaves: 0,
      used_leaves: 0,
      remaining_leaves: 0,
      low_stock_books: 0,
      banks_without_books: 0,
      undelivered_pay_count: 0,
      undelivered_pay_rial: 0,
    },
    books: [],
    banks_without: [],
    recent_payable: [],
    compliance: [],
    alerts: warning ? [{
      severity: 'fail',
      title: 'خطای گزارش',
      detail: warning,
      action_nav: 'acc-chequebook-report',
    }] : [],
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

function buildChequebookDashboard(db) {
  try {
    if (!tableExists(db, 'check_categories')) {
      return emptyPayload('جدول دسته چک در دسترس نیست');
    }

    const rows = db.prepare(`
      SELECT cc.*, b.name AS bank_name
      FROM check_categories cc
      LEFT JOIN banks b ON b.id = cc.bank_id
      ORDER BY cc.active DESC, cc.id DESC
    `).all();

    const books = [];
    let totalLeaves = 0;
    let usedLeaves = 0;
    let remainingLeaves = 0;
    let activeBooks = 0;
    let lowStock = 0;

    for (const r of rows) {
      const used = countUsedLeaves(db, r.id);
      const leafCount = Number(r.leaf_count) || 0;
      const remaining = leafCount > 0 ? Math.max(0, leafCount - used) : null;
      const active = Number(r.active) !== 0;
      if (active) activeBooks++;
      if (leafCount > 0) {
        totalLeaves += leafCount;
        usedLeaves += used;
        if (remaining != null) remainingLeaves += remaining;
        const fillPct = Math.round((used / leafCount) * 1000) / 10;
        if (active && remaining != null && remaining <= Math.max(3, Math.ceil(leafCount * 0.1))) {
          lowStock++;
        }
        const alerts = [];
        if (remaining === 0) alerts.push({ severity: 'fail', text: 'برگه تمام شده' });
        else if (remaining != null && remaining <= 5) alerts.push({ severity: 'warn', text: `${remaining} برگه باقی` });
        books.push({
          id: r.id,
          name: r.name,
          bank_id: r.bank_id,
          bank_name: r.bank_name || '—',
          serial_from: r.serial_from || '',
          serial_to: r.serial_to || '',
          holder_name: r.holder_name || '',
          current_leaf: r.current_leaf || '',
          leaf_count: leafCount,
          used_leaves: used,
          remaining_leaves: remaining,
          fill_pct: leafCount > 0 ? Math.round((used / leafCount) * 1000) / 10 : 0,
          active,
          alerts,
        });
      } else {
        books.push({
          id: r.id,
          name: r.name,
          bank_id: r.bank_id,
          bank_name: r.bank_name || '—',
          serial_from: r.serial_from || '',
          serial_to: r.serial_to || '',
          holder_name: r.holder_name || '',
          current_leaf: r.current_leaf || '',
          leaf_count: 0,
          used_leaves: used,
          remaining_leaves: null,
          fill_pct: 0,
          active,
          alerts: [{ severity: 'warn', text: 'تعداد برگه ثبت نشده' }],
        });
      }
    }

    const banksWithout = [];
    if (tableExists(db, 'banks')) {
      try {
        const gap = db.prepare(`
          SELECT b.id, b.name FROM banks b
          WHERE COALESCE(b.active,1)=1
            AND NOT EXISTS (
              SELECT 1 FROM check_categories cc
              WHERE cc.bank_id=b.id AND COALESCE(cc.active,1)=1
            )
          ORDER BY b.name
        `).all();
        for (const g of gap) {
          banksWithout.push({ bank_id: g.id, bank_name: g.name });
        }
      } catch (_) { /* */ }
    }

    let undeliveredCount = 0;
    let undeliveredRial = 0;
    const recentPayable = [];
    if (tableExists(db, 'cheque_records')) {
      const amt = tableHasColumn(db, 'cheque_records', 'amount_rial')
        ? 'COALESCE(amount_rial, amount, 0)'
        : 'COALESCE(amount, 0)';
      const aliveParts = ['direction=\'out\''];
      if (tableHasColumn(db, 'cheque_records', 'reversed_at')) {
        aliveParts.push('COALESCE(reversed_at,0)=0');
      }
      const lc = tableHasColumn(db, 'cheque_records', 'lifecycle_status') ? 'lifecycle_status' : 'status';
      try {
        const pending = db.prepare(`
          SELECT COUNT(*) AS n, COALESCE(SUM(${amt}),0) AS s
          FROM cheque_records
          WHERE ${aliveParts.join(' AND ')}
            AND COALESCE(${lc},'') IN ('','registered')
        `).get();
        undeliveredCount = Number(pending && pending.n) || 0;
        undeliveredRial = Math.round(Number(pending && pending.s) || 0);
        const recent = db.prepare(`
          SELECT id, cheque_number, party_name, due_date, ${amt} AS amount_rial, ${lc} AS lc
          FROM cheque_records
          WHERE direction='out'
          ORDER BY id DESC LIMIT 12
        `).all();
        for (const x of recent) {
          recentPayable.push({
            id: x.id,
            cheque_number: x.cheque_number,
            party_name: x.party_name,
            due_date: x.due_date,
            amount_rial: Math.round(Number(x.amount_rial) || 0),
            lifecycle_status: x.lc || '',
          });
        }
      } catch (_) { /* */ }
    }

    const kpis = {
      book_count: books.length,
      active_books: activeBooks,
      total_leaves: totalLeaves,
      used_leaves: usedLeaves,
      remaining_leaves: remainingLeaves,
      low_stock_books: lowStock,
      banks_without_books: banksWithout.length,
      undelivered_pay_count: undeliveredCount,
      undelivered_pay_rial: undeliveredRial,
    };

    const compliance = [
      {
        id: 'leaf_inventory',
        label: 'موجودی برگه دسته چک',
        detail: lowStock === 0
          ? 'هیچ دسته‌ای در آستانه اتمام نیست'
          : `${lowStock} دسته کم‌موجود — سفارش برگه یا دسته جدید`,
        status: lowStock === 0 ? 'ok' : (lowStock <= 2 ? 'warn' : 'fail'),
        action_nav: 'acc-check-categories',
      },
      {
        id: 'banks_with_books',
        label: 'بانک‌های دارای دسته فعال',
        detail: banksWithout.length === 0
          ? 'هر بانک فعال حداقل یک دسته چک دارد'
          : `${banksWithout.length} بانک بدون دسته چک فعال`,
        status: banksWithout.length === 0 ? 'ok' : 'warn',
        action_nav: 'acc-check-categories',
      },
      {
        id: 'undelivered_pay',
        label: 'چک پرداختنی ثبت‌شده / تحویل‌نشده',
        detail: undeliveredCount === 0
          ? 'چک پرداختنی در وضعیت ثبت باز ندارید'
          : `${undeliveredCount} فقره · ${undeliveredRial.toLocaleString('fa-IR')} ریال`,
        status: undeliveredCount === 0 ? 'ok' : 'warn',
        action_nav: 'acc-cheques-pay',
      },
    ];

    const alerts = [];
    if (lowStock > 0) {
      alerts.push({
        severity: lowStock > 2 ? 'fail' : 'warn',
        title: 'کمبود برگه دسته چک',
        detail: `${lowStock} دسته به پایان برگه نزدیک است`,
        action_nav: 'acc-check-categories',
      });
    }
    if (banksWithout.length > 0) {
      alerts.push({
        severity: 'warn',
        title: 'بانک بدون دسته چک',
        detail: `${banksWithout.length} بانک فعال دسته چک ندارند`,
        action_nav: 'acc-check-categories',
      });
    }

    return {
      generated_at: Date.now(),
      as_of: todayJalali(),
      health_score: healthScore(compliance),
      warning: '',
      kpis,
      books,
      banks_without: banksWithout,
      recent_payable: recentPayable,
      compliance,
      alerts,
    };
  } catch (e) {
    console.error('chequebook-dashboard:', e && e.message);
    return emptyPayload('گزارش دفتر چک با خطا ساخته شد');
  }
}

module.exports = { buildChequebookDashboard };
