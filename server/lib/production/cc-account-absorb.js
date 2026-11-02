'use strict';
/**
 * Selective subsidiary-account → cost-center overhead absorption maps.
 * Base options: period_debit | ending_balance | budget.
 */
const { DELETED_FILTER, JE_NOT_DRAFT } = require('../ledger');
const { SQL_JL_DEBIT_RIAL, SQL_JL_CREDIT_RIAL } = require('../money');
const { clampAbsorbPct } = require('./overhead');

const BASE_TYPES = Object.freeze(['period_debit', 'ending_balance', 'budget']);
const JE_ALIVE = `${DELETED_FILTER} AND COALESCE(je.status,'posted')<>'reversed' AND ${JE_NOT_DRAFT}`;

function absorbErr(code, status, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

function normalizeBaseType(v) {
  const s = String(v || 'period_debit').trim();
  if (!BASE_TYPES.includes(s)) {
    throw absorbErr('E_BASE_TYPE', 400, 'مبنا باید گردش بدهکار، مانده پایان دوره، یا بودجه باشد');
  }
  return s;
}

function periodDateBounds(periodLabel) {
  const s = String(periodLabel || '').trim();
  const m = s.match(/^(\d{4})\/(\d{1,2})$/);
  if (!m) throw absorbErr('E_PERIOD_FORMAT', 400, 'دوره باید به صورت ۱۴۰۵/۰۷ باشد');
  const ym = `${m[1]}/${String(Number(m[2])).padStart(2, '0')}`;
  return { from: `${ym}/01`, to: `${ym}/31`, period: ym };
}

function assertAccount(db, code) {
  const c = String(code || '').trim();
  if (!c) throw absorbErr('E_ACCOUNT_REQUIRED', 400, 'کد معین الزامی است');
  const row = db.prepare(`
    SELECT code, name, type, COALESCE(is_active,1) AS is_active
    FROM chart_of_accounts WHERE code=?
  `).get(c);
  if (!row) throw absorbErr('E_ACCOUNT_NOT_FOUND', 404, `حساب ${c} یافت نشد`);
  if (!row.is_active) throw absorbErr('E_ACCOUNT_INACTIVE', 400, `حساب ${c} غیرفعال است`);
  return row;
}

function accountPeriodDebit(db, accountCode, from, to) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) AS d
    FROM journal_lines jl
    JOIN journal_entries je ON jl.entry_id=je.id
    WHERE jl.account_code=? AND ${JE_ALIVE}
      AND COALESCE(je.ref_type,'') <> 'production_overhead_actual_reversal'
      AND je.entry_date >= ? AND je.entry_date <= ?
  `).get(accountCode, from, to);
  return Math.round(Number(row?.d) || 0);
}

function accountEndingBalance(db, accountCode, to) {
  const acc = db.prepare('SELECT type FROM chart_of_accounts WHERE code=?').get(accountCode);
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) AS d,
      COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) AS c
    FROM journal_lines jl
    JOIN journal_entries je ON jl.entry_id=je.id
    WHERE jl.account_code=? AND ${JE_ALIVE} AND je.entry_date <= ?
  `).get(accountCode, to);
  const dr = Math.round(Number(row?.d) || 0);
  const cr = Math.round(Number(row?.c) || 0);
  const type = String(acc?.type || 'expense');
  // Assets/expenses: debit-positive; liability/equity/income: credit-positive.
  if (type === 'liability' || type === 'equity' || type === 'income' || type === 'revenue') {
    return cr - dr;
  }
  return dr - cr;
}

function resolveBaseAmount(db, mapRow, { from, to } = {}) {
  const base = normalizeBaseType(mapRow.base_type);
  if (base === 'budget') {
    return Math.max(0, Math.round(Number(mapRow.budget_rial) || 0));
  }
  if (!from || !to) {
    throw absorbErr('E_DATE_RANGE', 400, 'بازه تاریخی برای مبنای گردش/مانده الزامی است');
  }
  if (base === 'period_debit') return Math.max(0, accountPeriodDebit(db, mapRow.account_code, from, to));
  return Math.max(0, accountEndingBalance(db, mapRow.account_code, to));
}

function absorbedRial(db, mapRow, bounds) {
  const pct = clampAbsorbPct(mapRow.absorb_pct != null ? mapRow.absorb_pct : 100);
  const baseAmt = resolveBaseAmount(db, mapRow, bounds);
  return {
    base_type: normalizeBaseType(mapRow.base_type),
    base_rial: baseAmt,
    absorb_pct: pct,
    absorbed_rial: Math.round(baseAmt * (pct / 100)),
  };
}

function listMaps(db, costCenterId, { includeInactive = false } = {}) {
  const ccId = Number(costCenterId);
  if (!ccId) throw absorbErr('E_CC_REQUIRED', 400, 'مرکز هزینه الزامی است');
  const rows = db.prepare(`
    SELECT m.*, a.name AS account_name, a.type AS account_type
    FROM cost_center_account_maps m
    LEFT JOIN chart_of_accounts a ON a.code = m.account_code
    WHERE m.cost_center_id=?
      AND (${includeInactive ? '1=1' : 'COALESCE(m.active,1)=1'})
    ORDER BY m.account_code
  `).all(ccId);
  return rows;
}

function replaceMaps(db, costCenterId, maps, userId) {
  const ccId = Number(costCenterId);
  if (!ccId) throw absorbErr('E_CC_REQUIRED', 400, 'مرکز هزینه الزامی است');
  const cc = db.prepare('SELECT id FROM cost_centers WHERE id=?').get(ccId);
  if (!cc) throw absorbErr('E_CC_NOT_FOUND', 404, 'مرکز هزینه یافت نشد');
  const list = Array.isArray(maps) ? maps : [];
  const seen = new Set();
  const normalized = list.map((raw) => {
    const acc = assertAccount(db, raw.account_code || raw.code);
    if (seen.has(acc.code)) {
      throw absorbErr('E_DUP_ACCOUNT', 400, `حساب ${acc.code} تکراری است`);
    }
    seen.add(acc.code);
    const absorb_pct = clampAbsorbPct(raw.absorb_pct != null ? raw.absorb_pct : 100);
    const base_type = normalizeBaseType(raw.base_type);
    const budget_rial = Math.max(0, Math.round(Number(raw.budget_rial) || 0));
    if (base_type === 'budget' && budget_rial <= 0) {
      throw absorbErr('E_BUDGET_REQUIRED', 400, `برای مبنای بودجه، مبلغ بودجهٔ ${acc.code} الزامی است`);
    }
    return {
      account_code: acc.code,
      absorb_pct,
      base_type,
      budget_rial,
      note: String(raw.note || '').slice(0, 240),
      active: raw.active === 0 || raw.active === false ? 0 : 1,
    };
  });

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM cost_center_account_maps WHERE cost_center_id=?').run(ccId);
    const ins = db.prepare(`
      INSERT INTO cost_center_account_maps
        (cost_center_id, account_code, absorb_pct, base_type, budget_rial, active, note, created_by)
      VALUES (?,?,?,?,?,?,?,?)
    `);
    for (const m of normalized) {
      ins.run(ccId, m.account_code, m.absorb_pct, m.base_type, m.budget_rial, m.active, m.note, userId || null);
    }
  });
  tx();
  return listMaps(db, ccId, { includeInactive: true });
}

function softDeactivateMap(db, mapId) {
  const id = Number(mapId);
  const row = db.prepare('SELECT * FROM cost_center_account_maps WHERE id=?').get(id);
  if (!row) throw absorbErr('E_NOT_FOUND', 404, 'نگاشت یافت نشد');
  db.prepare('UPDATE cost_center_account_maps SET active=0 WHERE id=?').run(id);
  return { ok: true, id };
}

function previewAbsorbForCenter(db, costCenterId, periodLabel) {
  const bounds = periodDateBounds(periodLabel);
  const maps = listMaps(db, costCenterId);
  const lines = maps.map((m) => {
    const calc = absorbedRial(db, m, bounds);
    return {
      id: m.id,
      account_code: m.account_code,
      account_name: m.account_name,
      ...calc,
      budget_rial: Math.round(Number(m.budget_rial) || 0),
    };
  });
  const pool = lines.reduce((s, l) => s + l.absorbed_rial, 0);
  return {
    cost_center_id: Number(costCenterId),
    period_label: bounds.period,
    date_from: bounds.from,
    date_to: bounds.to,
    pool_rial: pool,
    lines,
  };
}

function suggestBudgetFromMaps(db, costCenterId, periodLabel) {
  return previewAbsorbForCenter(db, costCenterId, periodLabel);
}

/* ── P3: اجرای واقعی جذب معین‌ها → کنترل سربار (5202) ─────────────────── */

function listAbsorbPostings(db, { period, costCenterId, includeReversed = true } = {}) {
  const where = [];
  const params = [];
  if (period) { where.push('p.period_label=?'); params.push(periodDateBounds(period).period); }
  if (costCenterId) { where.push('p.cost_center_id=?'); params.push(Number(costCenterId)); }
  if (!includeReversed) where.push("p.status='posted'");
  return db.prepare(`
    SELECT p.*, a.name AS account_name, cc.code AS cc_code, cc.name AS cc_name
    FROM cc_absorb_postings p
    LEFT JOIN chart_of_accounts a ON a.code = p.account_code
    LEFT JOIN cost_centers cc ON cc.id = p.cost_center_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY p.id DESC
  `).all(...params);
}

/**
 * یک سند برای (دوره، مرکز): بد 5202 با مرکز هزینه / بس هر معین نگاشت‌شده به اندازهٔ
 * مبنا × درصد جذب. هر نگاشت در هر دوره فقط یک‌بار (ایندکس یکتای ux_cc_absorb_posted).
 */
function runAbsorb(db, { costCenterId, period, userId, date } = {}) {
  const { acct } = require('../coa-map');
  const { allocateNumber } = require('../../db');
  const { postEvent, err } = require('./posting');
  const ccId = Number(costCenterId);
  if (!ccId) throw absorbErr('E_CC_REQUIRED', 400, 'مرکز هزینه الزامی است');
  const cc = db.prepare('SELECT id, code, name FROM cost_centers WHERE id=?').get(ccId);
  if (!cc) throw absorbErr('E_CC_NOT_FOUND', 404, 'مرکز هزینه یافت نشد');
  const bounds = periodDateBounds(period);

  return db.transaction(() => {
    const preview = previewAbsorbForCenter(db, ccId, bounds.period);
    const already = db.prepare(`
      SELECT map_id FROM cc_absorb_postings
      WHERE period_label=? AND cost_center_id=? AND status='posted'
    `).all(bounds.period, ccId).map((r) => Number(r.map_id));
    const lines = preview.lines.filter((l) => l.absorbed_rial > 0 && !already.includes(Number(l.id)));
    if (!lines.length) {
      throw absorbErr(already.length ? 'E_ALREADY_POSTED' : 'E_POOL_ZERO', 409,
        already.length
          ? `جذب معین‌های این مرکز برای دوره ${bounds.period} قبلاً ثبت شده است`
          : 'مبلغ جذبی از معین‌ها صفر است');
    }
    const total = lines.reduce((s, l) => s + l.absorbed_rial, 0);
    const ctl = acct(db, 'coa_overhead_control');
    const { periodEndJalali } = require('../../jalali');
    const entryDate = String(date || periodEndJalali(bounds.period) || bounds.to).trim();
    let docNo = '';
    try { docNo = allocateNumber(db, 'cc_absorb', 'CCA'); } catch { docNo = `CCA-${Date.now()}`; }

    const ins = db.prepare(`
      INSERT INTO cc_absorb_postings
        (doc_no, period_label, cost_center_id, map_id, account_code, base_type, base_rial,
         absorb_pct, amount_rial, status, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,'posted',?)
    `);
    const ids = lines.map((l) => ins.run(
      docNo, bounds.period, ccId, l.id, l.account_code, l.base_type, l.base_rial,
      l.absorb_pct, l.absorbed_rial, userId || null,
    ).lastInsertRowid);

    const jeLines = [{ code: ctl.code, name: ctl.name, debit: total / 10, credit: 0 }];
    for (const l of lines) {
      jeLines.push({ code: l.account_code, name: l.account_name || l.account_code, debit: 0, credit: l.absorbed_rial / 10 });
    }
    const je = postEvent(db, {
      event: 'PRD-06',
      sourceId: ids[0],
      date: entryDate,
      description: `جذب سربار واقعی معین‌ها به کنترل سربار — ${cc.name} — دوره ${bounds.period} (${docNo})`,
      createdBy: userId,
      costCenterId: ccId,
      lines: jeLines,
    });
    if (!je || !je.je_id) throw err('E_JE_FAILED', 500, { doc_no: docNo });
    db.prepare(`UPDATE cc_absorb_postings SET je_id=? WHERE doc_no=? AND status='posted'`).run(je.je_id, docNo);

    const { audit } = require('../../db');
    audit(userId, 'create', 'cc_absorb_posting', ids[0], JSON.stringify({
      doc_no: docNo, period: bounds.period, cost_center_id: ccId, je_id: je.je_id, total_rial: total,
      lines: lines.map((l) => ({ map_id: l.id, account_code: l.account_code, amount_rial: l.absorbed_rial })),
    }));
    return {
      ok: true, doc_no: docNo, period_label: bounds.period, cost_center_id: ccId,
      je_id: je.je_id, total_rial: total, rows: listAbsorbPostings(db, { period: bounds.period, costCenterId: ccId })
        .filter((r) => r.doc_no === docNo),
    };
  })();
}

/** R13 — ابطال کامل یک اجرا: سند معکوس + وضعیت reversed برای همهٔ ردیف‌های همان سند. */
function reverseAbsorb(db, { docNo, reason, userId, date } = {}) {
  const { reverseEvent } = require('./posting');
  const { todayJalali } = require('../../jalali');
  const doc = String(docNo || '').trim();
  if (!doc) throw absorbErr('E_DOC_REQUIRED', 400, 'شمارهٔ سند جذب الزامی است');
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) throw absorbErr('E_REASON_REQUIRED', 422, 'دلیل ابطال الزامی است');
  return db.transaction(() => {
    const rows = db.prepare(`SELECT * FROM cc_absorb_postings WHERE doc_no=? AND status='posted'`).all(doc);
    if (!rows.length) throw absorbErr('E_NOT_FOUND', 404, 'سند جذب فعال یافت نشد (شاید قبلاً ابطال شده)');
    const jeId = rows[0].je_id;
    let revId = null;
    if (jeId) {
      revId = reverseEvent(db, { jeId, reason: cleanReason, userId, date: date || todayJalali() });
    }
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      UPDATE cc_absorb_postings
      SET status='reversed', reversal_je_id=?, reverse_reason=?, reversed_by=?, reversed_at=?
      WHERE doc_no=? AND status='posted'
    `).run(revId || null, cleanReason, userId || null, now, doc);
    const { audit } = require('../../db');
    audit(userId, 'delete', 'cc_absorb_posting', rows[0].id, JSON.stringify({
      doc_no: doc, je_id: jeId, reversal_je_id: revId, reason: cleanReason,
      total_rial: rows.reduce((s, r) => s + (Number(r.amount_rial) || 0), 0),
    }));
    return { ok: true, doc_no: doc, je_id: jeId, reversal_je_id: revId, count: rows.length };
  })();
}

module.exports = {
  BASE_TYPES,
  normalizeBaseType,
  periodDateBounds,
  assertAccount,
  resolveBaseAmount,
  absorbedRial,
  listMaps,
  replaceMaps,
  softDeactivateMap,
  previewAbsorbForCenter,
  suggestBudgetFromMaps,
  listAbsorbPostings,
  runAbsorb,
  reverseAbsorb,
  clampAbsorbPct,
};
