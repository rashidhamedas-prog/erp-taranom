'use strict';
/**
 * Checkbook / leaf inventory dashboard — portal-ui renderChequebookReportTab.
 * Phase 4C: leaf sequence, void/lost, issued-but-not-cleared from cheque_book_leaves.
 * Never throws to HTTP.
 */

const { todayJalali } = require('../jalali');
const {
  countUsedLeaves,
  countBlankLeaves,
  countAllLeaves,
} = require('./cheque-book-leaves');

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

/** Legacy fallback when cheque_book_leaves empty for a category. */
function countUsedLeavesLegacy(db, categoryId) {
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
      blank_leaves: 0,
      void_lost_leaves: 0,
      issued_uncleared_leaves: 0,
      serial_gaps: 0,
      low_stock_books: 0,
      banks_without_books: 0,
      undelivered_pay_count: 0,
      undelivered_pay_rial: 0,
    },
    books: [],
    banks_without: [],
    recent_payable: [],
    void_lost_leaves: [],
    issued_uncleared: [],
    serial_gaps: [],
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

function leafClearedStatuses() {
  return new Set(['cleared', 'cleared_out', 'paid']);
}

function detectSerialGaps(leaves) {
  const gaps = [];
  const numeric = leaves
    .map((l) => ({ leaf: l, n: /^\d+$/.test(String(l.serial || '')) ? Number(l.serial) : null }))
    .filter((x) => x.n != null && Number.isSafeInteger(x.n))
    .sort((a, b) => a.n - b.n || a.leaf.id - b.leaf.id);
  for (let i = 1; i < numeric.length; i++) {
    const prev = numeric[i - 1].n;
    const cur = numeric[i].n;
    if (cur > prev + 1) {
      gaps.push({
        after_serial: String(numeric[i - 1].leaf.serial),
        before_serial: String(numeric[i].leaf.serial),
        missing_from: String(prev + 1),
        missing_to: String(cur - 1),
        missing_count: cur - prev - 1,
      });
    }
  }
  return gaps;
}

function buildLeafSections(db, categoryId, categoryName) {
  if (!tableExists(db, 'cheque_book_leaves')) {
    return {
      leaf_count: 0,
      used_leaves: 0,
      blank_leaves: 0,
      remaining_leaves: null,
      void_lost: [],
      issued_uncleared: [],
      serial_gaps: [],
      leaves_sequence: [],
      from_leaves_table: false,
    };
  }

  const leaves = db.prepare(`
    SELECT l.*,
           cr.lifecycle_status AS cheque_lifecycle,
           cr.status AS cheque_status,
           cr.cheque_number,
           cr.party_name,
           cr.due_date,
           cr.amount AS cheque_amount
    FROM cheque_book_leaves l
    LEFT JOIN cheque_records cr ON cr.id = l.cheque_record_id
    WHERE l.check_category_id=?
    ORDER BY l.serial ASC, l.id ASC
  `).all(categoryId);

  if (!leaves.length) {
    return {
      leaf_count: 0,
      used_leaves: 0,
      blank_leaves: 0,
      remaining_leaves: null,
      void_lost: [],
      issued_uncleared: [],
      serial_gaps: [],
      leaves_sequence: [],
      from_leaves_table: false,
    };
  }

  const cleared = leafClearedStatuses();
  const voidLost = [];
  const issuedUncleared = [];
  let blank = 0;
  let used = 0;

  const sequence = leaves.map((l) => {
    const st = String(l.status || '');
    if (st === 'blank') blank++;
    if (['issued', 'void', 'lost', 'cancelled'].includes(st)) used++;
    if (st === 'void' || st === 'lost' || st === 'cancelled') {
      voidLost.push({
        id: l.id,
        check_category_id: categoryId,
        category_name: categoryName,
        serial: l.serial,
        sayadi: l.sayadi || '',
        status: st,
        void_reason: l.void_reason || '',
        voided_at: l.voided_at || null,
      });
    }
    if (st === 'issued') {
      const lc = String(l.cheque_lifecycle || l.cheque_status || '').toLowerCase();
      if (!cleared.has(lc)) {
        issuedUncleared.push({
          id: l.id,
          check_category_id: categoryId,
          category_name: categoryName,
          serial: l.serial,
          sayadi: l.sayadi || '',
          cheque_record_id: l.cheque_record_id || null,
          cheque_number: l.cheque_number || '',
          party_name: l.party_name || '',
          due_date: l.due_date || '',
          amount_rial: Math.round(Number(l.cheque_amount) || 0),
          lifecycle_status: l.cheque_lifecycle || '',
        });
      }
    }
    return {
      id: l.id,
      serial: l.serial,
      sayadi: l.sayadi || '',
      status: st,
      cheque_record_id: l.cheque_record_id || null,
      cheque_number: l.cheque_number || '',
    };
  });

  const gaps = detectSerialGaps(leaves).map((g) => ({
    ...g,
    check_category_id: categoryId,
    category_name: categoryName,
  }));

  return {
    leaf_count: leaves.length,
    used_leaves: used,
    blank_leaves: blank,
    remaining_leaves: blank,
    void_lost: voidLost,
    issued_uncleared: issuedUncleared,
    serial_gaps: gaps,
    leaves_sequence: sequence,
    from_leaves_table: true,
  };
}

function buildChequebookDashboard(db) {
  try {
    if (!tableExists(db, 'check_categories')) {
      return emptyPayload('جدول دسته چک در دسترس نیست');
    }

    const hasLeavesTable = tableExists(db, 'cheque_book_leaves');
    const softDel = tableHasColumn(db, 'check_categories', 'deleted_at')
      ? 'WHERE COALESCE(cc.deleted_at, 0)=0'
      : '';
    const rows = db.prepare(`
      SELECT cc.*, b.name AS bank_name
      FROM check_categories cc
      LEFT JOIN banks b ON b.id = cc.bank_id
      ${softDel}
      ORDER BY cc.active DESC, cc.id DESC
    `).all();

    const books = [];
    let totalLeaves = 0;
    let usedLeaves = 0;
    let remainingLeaves = 0;
    let blankLeaves = 0;
    let activeBooks = 0;
    let lowStock = 0;
    const allVoidLost = [];
    const allIssuedUncleared = [];
    const allGaps = [];

    for (const r of rows) {
      const active = Number(r.active) !== 0;
      if (active) activeBooks++;

      const leafInfo = buildLeafSections(db, r.id, r.name);
      let leafCount;
      let used;
      let remaining;
      let blank;

      if (leafInfo.from_leaves_table) {
        leafCount = leafInfo.leaf_count;
        used = leafInfo.used_leaves;
        remaining = leafInfo.remaining_leaves;
        blank = leafInfo.blank_leaves;
        allVoidLost.push(...leafInfo.void_lost);
        allIssuedUncleared.push(...leafInfo.issued_uncleared);
        allGaps.push(...leafInfo.serial_gaps);
      } else {
        // Fallback: category leaf_count + document-based used count
        leafCount = Number(r.leaf_count) || 0;
        used = hasLeavesTable
          ? (countUsedLeaves(db, r.id) || countUsedLeavesLegacy(db, r.id))
          : countUsedLeavesLegacy(db, r.id);
        blank = hasLeavesTable ? countBlankLeaves(db, r.id) : null;
        remaining = leafCount > 0 ? Math.max(0, leafCount - used) : (blank != null ? blank : null);
        if (hasLeavesTable) {
          const all = countAllLeaves(db, r.id);
          if (all > 0) leafCount = all;
        }
      }

      if (leafCount > 0) {
        totalLeaves += leafCount;
        usedLeaves += used;
        if (remaining != null) remainingLeaves += remaining;
        if (blank != null) blankLeaves += blank;
        if (active && remaining != null && remaining <= Math.max(3, Math.ceil(leafCount * 0.1))) {
          lowStock++;
        }
      }

      const alerts = [];
      if (remaining === 0 && leafCount > 0) alerts.push({ severity: 'fail', text: 'برگه تمام شده' });
      else if (remaining != null && remaining <= 5 && leafCount > 0) {
        alerts.push({ severity: 'warn', text: `${remaining} برگه باقی` });
      }
      if (leafInfo.serial_gaps.length) {
        alerts.push({ severity: 'warn', text: `${leafInfo.serial_gaps.length} گسست سریال` });
      }
      if (leafInfo.void_lost.length) {
        alerts.push({ severity: 'warn', text: `${leafInfo.void_lost.length} باطل/مفقود` });
      }

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
        blank_leaves: blank != null ? blank : remaining,
        remaining_leaves: remaining,
        fill_pct: leafCount > 0 ? Math.round((used / leafCount) * 1000) / 10 : 0,
        active,
        from_leaves_table: leafInfo.from_leaves_table,
        void_lost_count: leafInfo.void_lost.length,
        issued_uncleared_count: leafInfo.issued_uncleared.length,
        serial_gap_count: leafInfo.serial_gaps.length,
        leaves_sequence: leafInfo.leaves_sequence.slice(0, 80),
        alerts,
      });
    }

    const banksWithout = [];
    if (tableExists(db, 'banks')) {
      try {
        const delClause = tableHasColumn(db, 'check_categories', 'deleted_at')
          ? 'AND COALESCE(cc.deleted_at,0)=0'
          : '';
        const gap = db.prepare(`
          SELECT b.id, b.name FROM banks b
          WHERE COALESCE(b.active,1)=1
            AND NOT EXISTS (
              SELECT 1 FROM check_categories cc
              WHERE cc.bank_id=b.id AND COALESCE(cc.active,1)=1
                ${delClause}
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
      const aliveParts = ["direction='out'"];
      if (tableHasColumn(db, 'cheque_records', 'reversed_at')) {
        aliveParts.push('COALESCE(reversed_at,0)=0');
      }
      aliveParts.push("COALESCE(record_status,'posted')<>'reversed'");
      const lc = tableHasColumn(db, 'cheque_records', 'lifecycle_status') ? 'lifecycle_status' : 'status';
      try {
        const pending = db.prepare(`
          SELECT COUNT(*) AS n, COALESCE(SUM(${amt}),0) AS s
          FROM cheque_records
          WHERE ${aliveParts.join(' AND ')}
            AND COALESCE(${lc},'') IN ('','registered','in_hand','pending')
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
      blank_leaves: blankLeaves || remainingLeaves,
      void_lost_leaves: allVoidLost.length,
      issued_uncleared_leaves: allIssuedUncleared.length,
      serial_gaps: allGaps.length,
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
        id: 'void_lost',
        label: 'برگ باطل / مفقود',
        detail: allVoidLost.length === 0
          ? 'برگ باطل یا مفقودی ثبت نشده'
          : `${allVoidLost.length} برگ باطل/مفقود/لغو`,
        status: allVoidLost.length === 0 ? 'ok' : 'warn',
        action_nav: 'acc-check-categories',
      },
      {
        id: 'issued_uncleared',
        label: 'صادرشدهٔ پاس‌نشده',
        detail: allIssuedUncleared.length === 0
          ? 'همهٔ برگ‌های صادرشده پاس/وصول شده‌اند یا در جریان‌اند'
          : `${allIssuedUncleared.length} برگ صادرشده هنوز پاس نشده`,
        status: allIssuedUncleared.length === 0 ? 'ok' : 'warn',
        action_nav: 'acc-cheques-pay',
      },
      {
        id: 'serial_gaps',
        label: 'توالی شماره برگ',
        detail: allGaps.length === 0
          ? 'گسست سریال در دسته‌ها دیده نشد'
          : `${allGaps.length} گسست در توالی سریال`,
        status: allGaps.length === 0 ? 'ok' : 'warn',
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
    if (allGaps.length > 0) {
      alerts.push({
        severity: 'warn',
        title: 'گسست توالی برگ',
        detail: `${allGaps.length} بازهٔ شماره مفقود در دسته‌ها`,
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
      void_lost_leaves: allVoidLost.slice(0, 200),
      issued_uncleared: allIssuedUncleared.slice(0, 200),
      serial_gaps: allGaps.slice(0, 100),
      compliance,
      alerts,
    };
  } catch (e) {
    console.error('chequebook-dashboard:', e && e.message);
    return emptyPayload('گزارش دفتر چک با خطا ساخته شد');
  }
}

module.exports = { buildChequebookDashboard };
