'use strict';
/**
 * Parametrized filter builder for cheque register list / export / totals.
 * Never concatenates user input into SQL — only placeholders.
 */

const { OPENING_NOTE, sqlIsRegistered } = require('./cheque-lifecycle');
const { digitsOnly, jalaliOrdinal } = require('./cheque-quality');

const SORT_WHITELIST = {
  due_asc: 'due_date ASC, id DESC',
  due_desc: 'due_date DESC, id DESC',
  amount_asc: 'amount ASC, id DESC',
  amount_desc: 'amount DESC, id DESC',
  issue_asc: 'issue_date ASC, id DESC',
  issue_desc: 'issue_date DESC, id DESC',
  id_desc: 'id DESC',
  id_asc: 'id ASC',
};

function asArray(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

function parseJalali(s) {
  const t = String(s || '').trim();
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(t)) return null;
  return t;
}

function parseAmount(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} params query-like object
 * @returns {{ whereSql: string, params: any[], orderSql: string, page: number, pageSize: number, offset: number }}
 */
function buildChequeRegisterQuery(params = {}) {
  const where = [];
  const bind = [];

  const includeReversed = String(params.include_reversed || '0') === '1';
  if (!includeReversed) {
    where.push("COALESCE(record_status,'posted')<>'reversed'");
  }

  const direction = String(params.direction || '').trim();
  if (direction === 'in' || direction === 'out') {
    where.push('direction=?');
    bind.push(direction);
  }

  const lifecycles = asArray(params.lifecycle || params.lifecycles);
  if (lifecycles.length) {
    const expanded = new Set();
    for (const lc of lifecycles) {
      expanded.add(lc);
      if (lc === 'registered') {
        expanded.add('');
        expanded.add('in_hand');
        expanded.add('pending');
      }
    }
    const list = [...expanded];
    where.push(`TRIM(COALESCE(lifecycle_status,'')) IN (${list.map(() => '?').join(',')})`);
    bind.push(...list);
  }

  const bank = String(params.bank || params.bank_name || '').trim();
  if (bank) {
    if (/^\d+$/.test(bank)) {
      where.push('(collection_bank_id=? OR bank_name IN (SELECT name FROM banks WHERE id=?))');
      bind.push(Number(bank), Number(bank));
    } else {
      where.push('(bank_name LIKE ? OR collection_bank_id IN (SELECT id FROM banks WHERE name LIKE ?))');
      bind.push('%' + bank + '%', '%' + bank + '%');
    }
  }

  const partyId = parseInt(params.party_id, 10);
  if (Number.isFinite(partyId) && partyId > 0) {
    where.push('party_id=?');
    bind.push(partyId);
  } else {
    const partyQ = String(params.party_q || params.party || '').trim();
    if (partyQ) {
      where.push('party_name LIKE ?');
      bind.push('%' + partyQ + '%');
    }
  }

  const dueFrom = parseJalali(params.due_from);
  if (dueFrom) { where.push('due_date>=?'); bind.push(dueFrom); }
  const dueTo = parseJalali(params.due_to);
  if (dueTo) { where.push('due_date<=?'); bind.push(dueTo); }

  const issueFrom = parseJalali(params.issue_from);
  if (issueFrom) { where.push("COALESCE(NULLIF(issue_date,''), receive_date)>=?"); bind.push(issueFrom); }
  const issueTo = parseJalali(params.issue_to);
  if (issueTo) { where.push("COALESCE(NULLIF(issue_date,''), receive_date)<=?"); bind.push(issueTo); }

  const amin = parseAmount(params.amount_min);
  if (amin != null) { where.push('amount>=?'); bind.push(amin); }
  const amax = parseAmount(params.amount_max);
  if (amax != null) { where.push('amount<=?'); bind.push(amax); }

  const sayadi = digitsOnly(params.sayadi || params.sayad || '');
  if (sayadi) {
    where.push("REPLACE(REPLACE(REPLACE(COALESCE(sayadi,''),' ',''),'-',''),'/','') LIKE ?");
    bind.push('%' + sayadi + '%');
  }

  const chqNum = String(params.cheque_number || '').trim();
  if (chqNum) {
    where.push('cheque_number LIKE ?');
    bind.push('%' + chqNum + '%');
  }

  const catId = parseInt(params.check_category_id, 10);
  if (Number.isFinite(catId) && catId > 0) {
    where.push('check_category_id=?');
    bind.push(catId);
  }

  if (String(params.overdue || '') === '1') {
    const today = parseJalali(params.today) || null;
    if (today) {
      where.push(`due_date<>'' AND due_date<? AND (
        ${sqlIsRegistered('lifecycle_status')}
        OR TRIM(COALESCE(lifecycle_status,''))='in_collection'
      )`);
      bind.push(today);
    }
  }

  const opening = String(params.opening || '');
  if (opening === '1') {
    where.push('(note LIKE ? OR status LIKE ?)');
    bind.push('%' + OPENING_NOTE + '%', '%اول دوره%');
  } else if (opening === '0') {
    where.push('(COALESCE(note,\'\') NOT LIKE ? AND COALESCE(status,\'\') NOT LIKE ?)');
    bind.push('%' + OPENING_NOTE + '%', '%اول دوره%');
  }

  const quality = String(params.quality || '').trim();
  if (quality === 'missing_sayad') {
    where.push("TRIM(COALESCE(sayadi,''))=''");
  } else if (quality === 'dummy_sayad') {
    where.push("REPLACE(REPLACE(COALESCE(sayadi,''),' ',''),'-','') IN ('1234567891234567','0000000000000000','1111111111111111','1234567890123456')");
  } else if (quality === 'dup_sayad') {
    where.push(`TRIM(COALESCE(sayadi,''))<>'' AND EXISTS (
      SELECT 1 FROM cheque_records c2
      WHERE c2.id<>cheque_records.id
        AND COALESCE(c2.record_status,'posted')='posted'
        AND c2.direction=cheque_records.direction
        AND TRIM(c2.sayadi)=TRIM(cheque_records.sayadi)
    )`);
  } else if (quality === 'suspicious_party') {
    where.push(`(
      party_id IS NULL OR party_id=0
      OR TRIM(COALESCE(party_name,'')) IN (SELECT TRIM(name) FROM users WHERE role IN ('admin','accounting') AND COALESCE(is_active,1)=1)
    )`);
  } else if (quality === 'no_je') {
    where.push('COALESCE(journal_entry_id,0)=0 AND COALESCE(settlement_id,0)=0');
  } else if (quality === 'stale_label') {
    const today = parseJalali(params.today);
    if (today) {
      where.push("status LIKE '%اول دوره%' AND due_date<>'' AND due_date<?");
      bind.push(today);
    }
  } else if (quality === 'branch_placeholder') {
    where.push("TRIM(COALESCE(branch,'')) IN ('','0')");
  }

  const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
  const sortKey = String(params.sort || 'due_asc').trim();
  const orderSql = SORT_WHITELIST[sortKey] || SORT_WHITELIST.due_asc;

  let page = parseInt(params.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  let pageSize = parseInt(params.page_size || params.pageSize, 10);
  if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = 100;
  if (pageSize > 500) pageSize = 500;
  const offset = (page - 1) * pageSize;

  return { whereSql, params: bind, orderSql, page, pageSize, offset, sortKey };
}

/**
 * Run list + totals for register endpoint.
 */
function runChequeRegister(db, queryParams, enrichFn) {
  const q = buildChequeRegisterQuery(queryParams);
  const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM cheque_records ${q.whereSql}`).get(...q.params);
  const total_count = Number(totalRow && totalRow.n) || 0;

  const rows = db.prepare(`
    SELECT * FROM cheque_records
    ${q.whereSql}
    ORDER BY ${q.orderSql}
    LIMIT ? OFFSET ?
  `).all(...q.params, q.pageSize, q.offset);

  const enriched = enrichFn ? rows.map((r) => enrichFn(r)) : rows;

  const byDir = db.prepare(`
    SELECT direction,
           COUNT(*) AS count,
           COALESCE(SUM(amount),0) AS amount
    FROM cheque_records
    ${q.whereSql}
    GROUP BY direction
  `).all(...q.params);

  const byLc = db.prepare(`
    SELECT TRIM(COALESCE(lifecycle_status,'')) AS lifecycle,
           COUNT(*) AS count,
           COALESCE(SUM(amount),0) AS amount
    FROM cheque_records
    ${q.whereSql}
    GROUP BY TRIM(COALESCE(lifecycle_status,''))
  `).all(...q.params);

  const by_direction = {
    in: { count: 0, amount: 0 },
    out: { count: 0, amount: 0 },
  };
  for (const r of byDir) {
    const d = r.direction === 'out' ? 'out' : 'in';
    by_direction[d] = { count: Number(r.count) || 0, amount: Number(r.amount) || 0 };
  }
  const by_lifecycle = {};
  for (const r of byLc) {
    const key = r.lifecycle || 'registered';
    by_lifecycle[key] = { count: Number(r.count) || 0, amount: Number(r.amount) || 0 };
  }

  return {
    rows: enriched,
    total_count,
    totals: { by_direction, by_lifecycle },
    page: q.page,
    page_size: q.pageSize,
    sort: q.sortKey,
  };
}

/**
 * Summary cards + aging for dashboard strip.
 */
function runChequeSummary(db, todayRaw) {
  const today = parseJalali(todayRaw) || (() => {
    try { return require('../jalali').todayJalali(); } catch (_) { return '1405/01/01'; }
  })();
  const alive = "COALESCE(record_status,'posted')='posted'";
  const amt = 'COALESCE(amount,0)';
  const reg = sqlIsRegistered('lifecycle_status');

  function bucket(extraWhere, extraParams = []) {
    const row = db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(${amt}),0) AS amount
      FROM cheque_records
      WHERE ${alive} AND ${extraWhere}
    `).get(...extraParams);
    return { count: Number(row.count) || 0, amount: Number(row.amount) || 0 };
  }

  // end of current Jalali month approx: today year/month + /31
  const parts = today.split('/');
  const monthEnd = parts[0] + '/' + parts[1] + '/31';
  const plus7 = addJalaliDaysApprox(today, 7);

  const cards = {
    in_hand: bucket(`direction='in' AND ${reg}`),
    in_collection: bucket("direction='in' AND lifecycle_status='in_collection'"),
    due_today: bucket(`due_date=? AND ((direction='in' AND (${reg} OR lifecycle_status='in_collection')) OR (direction='out' AND ${reg}))`, [today]),
    due_7d: bucket(`due_date>? AND due_date<=? AND ((direction='in' AND (${reg} OR lifecycle_status='in_collection')) OR (direction='out' AND ${reg}))`, [today, plus7]),
    due_month: bucket(`due_date>=? AND due_date<=? AND ((direction='in' AND (${reg} OR lifecycle_status='in_collection')) OR (direction='out' AND ${reg}))`, [parts[0] + '/' + parts[1] + '/01', monthEnd]),
    overdue: bucket(`due_date<>'' AND due_date<? AND ((direction='in' AND (${reg} OR lifecycle_status='in_collection')) OR (direction='out' AND ${reg}))`, [today]),
    bounced: bucket("lifecycle_status='bounced' OR lifecycle_status='bounced_out'"),
    endorsed: bucket("lifecycle_status='endorsed'"),
    out_open: bucket(`direction='out' AND ${reg}`),
    out_overdue: bucket(`direction='out' AND ${reg} AND due_date<>'' AND due_date<?`, [today]),
  };

  const openRows = db.prepare(`
    SELECT due_date, ${amt} AS amount, direction, lifecycle_status
    FROM cheque_records
    WHERE ${alive}
      AND (
        (direction='in' AND (${reg} OR lifecycle_status='in_collection'))
        OR (direction='out' AND ${reg})
      )
  `).all();

  const aging = {
    past: { '0-30': { count: 0, amount: 0 }, '31-60': { count: 0, amount: 0 }, '61-90': { count: 0, amount: 0 }, '90+': { count: 0, amount: 0 } },
    future: { '0-7': { count: 0, amount: 0 }, '8-30': { count: 0, amount: 0 }, '31-90': { count: 0, amount: 0 }, '90+': { count: 0, amount: 0 } },
  };

  for (const r of openRows) {
    const days = (() => {
      const a = jalaliOrdinal(r.due_date);
      const b = jalaliOrdinal(today);
      if (a == null || b == null) return null;
      return a - b;
    })();
    if (days == null) continue;
    const amtR = Number(r.amount) || 0;
    if (days < 0) {
      const overdue = -days;
      const key = overdue <= 30 ? '0-30' : overdue <= 60 ? '31-60' : overdue <= 90 ? '61-90' : '90+';
      aging.past[key].count += 1;
      aging.past[key].amount += amtR;
    } else {
      const key = days <= 7 ? '0-7' : days <= 30 ? '8-30' : days <= 90 ? '31-90' : '90+';
      aging.future[key].count += 1;
      aging.future[key].amount += amtR;
    }
  }

  return { today, cards, aging };
}

/** Approximate Jalali day add using ordinal (good enough for filters). */
function addJalaliDaysApprox(today, n) {
  const o = jalaliOrdinal(today);
  if (o == null) return today;
  const target = o + n;
  const y = Math.floor(target / 372);
  const rem = target % 372;
  const m = Math.min(12, Math.max(1, Math.floor(rem / 31)));
  const d = Math.min(31, Math.max(1, rem % 31 || 1));
  return String(y).padStart(4, '0') + '/' + String(m).padStart(2, '0') + '/' + String(d).padStart(2, '0');
}

module.exports = {
  SORT_WHITELIST,
  buildChequeRegisterQuery,
  runChequeRegister,
  runChequeSummary,
  addJalaliDaysApprox,
};
