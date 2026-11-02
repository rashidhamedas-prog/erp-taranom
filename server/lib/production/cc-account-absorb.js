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

function absorbJeIdsForPeriod(db, period) {
  if (!period) return [];
  try {
    return db.prepare(`
      SELECT DISTINCT je_id FROM cc_absorb_postings WHERE period_label=? AND status='posted' AND je_id IS NOT NULL
    `).all(period).map((r) => Number(r.je_id));
  } catch (_) { return []; }
}

/** excludePeriod: اسناد جذب همین دوره از مانده کنار می‌روند تا سهم مراکز بعدی کوچک نشود. */
function accountEndingBalance(db, accountCode, to, { excludePeriod } = {}) {
  const acc = db.prepare('SELECT type FROM chart_of_accounts WHERE code=?').get(accountCode);
  const skip = absorbJeIdsForPeriod(db, excludePeriod);
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(${SQL_JL_DEBIT_RIAL}),0) AS d,
      COALESCE(SUM(${SQL_JL_CREDIT_RIAL}),0) AS c
    FROM journal_lines jl
    JOIN journal_entries je ON jl.entry_id=je.id
    WHERE jl.account_code=? AND ${JE_ALIVE} AND je.entry_date <= ?
      ${skip.length ? `AND je.id NOT IN (${skip.map(() => '?').join(',')})` : ''}
  `).get(accountCode, to, ...skip);
  const dr = Math.round(Number(row?.d) || 0);
  const cr = Math.round(Number(row?.c) || 0);
  const type = String(acc?.type || 'expense');
  // Assets/expenses: debit-positive; liability/equity/income: credit-positive.
  if (type === 'liability' || type === 'equity' || type === 'income' || type === 'revenue') {
    return cr - dr;
  }
  return dr - cr;
}

function resolveBaseAmount(db, mapRow, { from, to, period } = {}) {
  const base = normalizeBaseType(mapRow.base_type);
  if (base === 'budget') {
    return Math.max(0, Math.round(Number(mapRow.budget_rial) || 0));
  }
  if (!from || !to) {
    throw absorbErr('E_DATE_RANGE', 400, 'بازه تاریخی برای مبنای گردش/مانده الزامی است');
  }
  if (base === 'period_debit') return Math.max(0, accountPeriodDebit(db, mapRow.account_code, from, to));
  return Math.max(0, accountEndingBalance(db, mapRow.account_code, to, { excludePeriod: period }));
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

  // R13: نگاشت حذف فیزیکی نمی‌شود (map_id در cc_absorb_postings مرجع گارد یک‌بار در دوره است).
  const tx = db.transaction(() => {
    const prev = db.prepare('SELECT account_code FROM cost_center_account_maps WHERE cost_center_id=?')
      .all(ccId).map((r) => r.account_code);
    const keep = new Set(normalized.map((m) => m.account_code));
    const off = db.prepare('UPDATE cost_center_account_maps SET active=0 WHERE cost_center_id=? AND account_code=?');
    for (const code of prev) if (!keep.has(code)) off.run(ccId, code);
    const up = upsertMapStmt(db);
    for (const m of normalized) {
      up.run(ccId, m.account_code, m.absorb_pct, m.base_type, m.budget_rial, m.active, m.note, userId || null);
    }
    assertAccountPctTotals(db, [...keep]);
  });
  tx();
  return listMaps(db, ccId, { includeInactive: true });
}

function upsertMapStmt(db) {
  return db.prepare(`
    INSERT INTO cost_center_account_maps
      (cost_center_id, account_code, absorb_pct, base_type, budget_rial, active, note, created_by)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(cost_center_id, account_code) DO UPDATE SET
      absorb_pct=excluded.absorb_pct, base_type=excluded.base_type, budget_rial=excluded.budget_rial,
      active=excluded.active, note=excluded.note
  `);
}

function fmtPct(n) {
  return (Math.round(Number(n) * 1000) / 1000).toLocaleString('fa-IR');
}

/** مجموع درصد جذب یک معین در همهٔ مراکز فعال نباید از ۱۰۰٪ بیشتر شود. */
function assertAccountPctTotals(db, accountCodes) {
  const codes = (accountCodes || []).map((c) => String(c || '').trim()).filter(Boolean);
  if (!codes.length) return;
  const rows = db.prepare(`
    SELECT account_code, SUM(absorb_pct) AS pct
    FROM cost_center_account_maps
    WHERE COALESCE(active,1)=1 AND account_code IN (${codes.map(() => '?').join(',')})
    GROUP BY account_code
    HAVING SUM(absorb_pct) > 100.001
  `).all(...codes);
  if (rows.length) {
    const r = rows[0];
    throw absorbErr('E_ACCOUNT_PCT_OVER_100', 400,
      `مجموع درصد جذب معین ${r.account_code} در همهٔ مراکز هزینه ${fmtPct(r.pct)}٪ می‌شود؛ حداکثر ۱۰۰٪ مجاز است`);
  }
}

function auditTo(db, userId, action, entity, entityId, detail, req) {
  if (req && req.headers) {
    try { require('../../db').audit(userId, action, entity, entityId, detail, req); return; } catch (_) { /* fallthrough */ }
  }
  try {
    db.prepare('INSERT INTO audit_log (user_id,action,entity,entity_id,detail) VALUES (?,?,?,?,?)')
      .run(userId || null, action, entity, entityId || null, detail || '');
  } catch (_) { /* audit table absent on stub DBs */ }
}

/* ── تسهیم سربار واقعی 61030x بین مراکز (تصمیم مالک: کارگاه cc1 / اتو و بسته‌بندی cc8) ── */

const SPLIT_SETTING_KEY = 'oh_actual_split';
const DEFAULT_SPLIT = Object.freeze({ 1: 50, 8: 50 });

function parseSplitValue(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch (_) {
      throw absorbErr('E_SPLIT_FORMAT', 400, 'فرمت نسبت تسهیم نامعتبر است');
    }
  }
  if (Array.isArray(obj)) {
    obj = Object.fromEntries(obj.map((r) => [r && r.cost_center_id, r && (r.pct != null ? r.pct : r.share_pct)]));
  }
  if (!obj || typeof obj !== 'object') throw absorbErr('E_SPLIT_FORMAT', 400, 'فرمت نسبت تسهیم نامعتبر است');
  return obj;
}

/** {ccId: pct} → اعتبارسنجی: مرکز موجود و فعال، ۰ تا ۱۰۰، جمع ≤ ۱۰۰٪. سهم صفر حذف می‌شود. */
function normalizeSplit(db, raw) {
  const obj = parseSplitValue(raw);
  const out = {};
  let sum = 0;
  for (const [k, v] of Object.entries(obj)) {
    const id = Number(k);
    if (!Number.isInteger(id) || id <= 0) throw absorbErr('E_SPLIT_CC', 400, 'شناسهٔ مرکز هزینه در نسبت تسهیم نامعتبر است');
    const pct = Number(v);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw absorbErr('E_SPLIT_PCT', 400, `سهم مرکز ${id} باید بین ۰ تا ۱۰۰ درصد باشد`);
    }
    if (pct === 0) continue;
    const cc = db.prepare('SELECT id, name, COALESCE(active,1) AS active FROM cost_centers WHERE id=?').get(id);
    if (!cc) throw absorbErr('E_CC_NOT_FOUND', 404, `مرکز هزینه ${id} یافت نشد`);
    if (!cc.active) throw absorbErr('E_CC_INACTIVE', 400, `مرکز هزینه «${cc.name}» غیرفعال است`);
    out[id] = Math.round(pct * 1000) / 1000;
    sum += out[id];
  }
  if (!Object.keys(out).length) throw absorbErr('E_SPLIT_EMPTY', 400, 'حداقل یک مرکز با سهم بیشتر از صفر لازم است');
  if (sum > 100.001) {
    throw absorbErr('E_SPLIT_OVER_100', 400, `مجموع سهم مراکز ${fmtPct(sum)}٪ است و نباید از ۱۰۰٪ بیشتر شود`);
  }
  return out;
}

function getSplit(db) {
  let raw = null;
  try { raw = db.prepare('SELECT value FROM settings WHERE key=?').get(SPLIT_SETTING_KEY)?.value; } catch (_) { raw = null; }
  if (raw) {
    try {
      const obj = parseSplitValue(raw);
      const split = {};
      for (const [k, v] of Object.entries(obj)) if (Number(k) > 0 && Number(v) > 0) split[Number(k)] = Number(v);
      if (Object.keys(split).length) return { split, is_default: false };
    } catch (_) { /* fall back to default */ }
  }
  return { split: { ...DEFAULT_SPLIT }, is_default: true };
}

/** معین‌های برگ 61030x با گردش (تا پایان دوره) + نگاشت فعلی هر کدام — پیشنهاد فرم تسهیم. */
function listOverheadLeafAccounts(db, periodLabel, { prefix = '61030' } = {}) {
  const to = periodLabel ? periodDateBounds(periodLabel).to : '9999/99/99';
  const accounts = db.prepare(`
    SELECT a.code, a.name
    FROM chart_of_accounts a
    WHERE a.code LIKE ? AND COALESCE(a.is_active,1)=1
      AND NOT EXISTS (SELECT 1 FROM chart_of_accounts c WHERE c.parent_code = a.code)
    ORDER BY a.code
  `).all(`${prefix}%`);
  const maps = db.prepare(`
    SELECT m.account_code, m.cost_center_id, m.absorb_pct, m.base_type, cc.name AS cc_name
    FROM cost_center_account_maps m LEFT JOIN cost_centers cc ON cc.id=m.cost_center_id
    WHERE COALESCE(m.active,1)=1 AND m.account_code LIKE ?
  `).all(`${prefix}%`);
  return accounts.map((a) => ({
    account_code: a.code,
    account_name: a.name,
    balance_rial: accountEndingBalance(db, a.code, to),
    maps: maps.filter((m) => m.account_code === a.code),
  })).filter((a) => a.balance_rial !== 0 || a.maps.length);
}

function mapsForAccounts(db, codes) {
  if (!codes.length) return [];
  return db.prepare(`
    SELECT id, cost_center_id, account_code, absorb_pct, base_type, budget_rial, COALESCE(active,1) AS active
    FROM cost_center_account_maps
    WHERE account_code IN (${codes.map(() => '?').join(',')})
    ORDER BY account_code, cost_center_id
  `).all(...codes);
}

/**
 * ذخیرهٔ نسبت تسهیم + (اختیاری) نگاشت معین‌ها به همان مراکز با سهم هر مرکز، در یک تراکنش.
 * removeOthers: نگاشت همان معین در مراکز خارج از نسبت غیرفعال می‌شود (حذف فیزیکی ندارد).
 */
function applySplit(db, { split, accounts, userId, removeOthers = true, req } = {}) {
  const norm = normalizeSplit(db, split);
  const ccIds = Object.keys(norm).map(Number);
  const seen = new Set();
  const accs = (Array.isArray(accounts) ? accounts : []).map((raw) => {
    const a = assertAccount(db, typeof raw === 'string' ? raw : (raw.account_code || raw.code));
    if (seen.has(a.code)) throw absorbErr('E_DUP_ACCOUNT', 400, `حساب ${a.code} تکراری است`);
    seen.add(a.code);
    const base_type = normalizeBaseType(typeof raw === 'string' ? 'period_debit' : raw.base_type);
    const budget_rial = Math.max(0, Math.round(Number(raw && raw.budget_rial) || 0));
    if (base_type === 'budget' && budget_rial <= 0) {
      throw absorbErr('E_BUDGET_REQUIRED', 400, `برای مبنای بودجه، مبلغ بودجهٔ ${a.code} الزامی است`);
    }
    return { account_code: a.code, base_type, budget_rial };
  });
  const codes = accs.map((a) => a.account_code);

  return db.transaction(() => {
    const beforeSplit = getSplit(db);
    const beforeMaps = mapsForAccounts(db, codes);
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(SPLIT_SETTING_KEY, JSON.stringify(norm));
    const up = upsertMapStmt(db);
    const off = db.prepare(`
      UPDATE cost_center_account_maps SET active=0
      WHERE account_code=? AND cost_center_id NOT IN (${ccIds.map(() => '?').join(',')}) AND COALESCE(active,1)=1
    `);
    for (const a of accs) {
      if (removeOthers) off.run(a.account_code, ...ccIds);
      for (const ccId of ccIds) {
        up.run(ccId, a.account_code, norm[ccId], a.base_type, a.budget_rial, 1, 'تسهیم سربار واقعی', userId || null);
      }
    }
    assertAccountPctTotals(db, codes);
    const afterMaps = mapsForAccounts(db, codes);
    auditTo(db, userId, 'update', 'oh_actual_split', null, JSON.stringify({
      before: { split: beforeSplit.split, is_default: beforeSplit.is_default, maps: beforeMaps },
      after: { split: norm, maps: afterMaps },
      accounts: codes,
      remove_others: !!removeOthers,
    }), req);
    return { ok: true, split: norm, accounts: codes, maps: afterMaps };
  })();
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
 * سهم هر نگاشت فعال (همهٔ مراکز) در دوره. معین مشترک بین چند مرکز (هم‌مبنا) یک‌بار
 * مبنا می‌گیرد؛ جمع = round(مبنا × Σدرصد) و سهم هر مرکز round(مبنا × درصد) — باقیماندهٔ
 * گرد کردن به آخرین مرکز (ترتیب seq). مبنای بودجه مخصوص همان نگاشت است و گروه نمی‌شود.
 */
function computeAbsorbShares(db, periodLabel) {
  const bounds = periodDateBounds(periodLabel);
  const maps = db.prepare(`
    SELECT m.*, a.name AS account_name, cc.code AS cc_code, cc.name AS cc_name, COALESCE(cc.seq,0) AS cc_seq
    FROM cost_center_account_maps m
    JOIN cost_centers cc ON cc.id = m.cost_center_id
    LEFT JOIN chart_of_accounts a ON a.code = m.account_code
    WHERE COALESCE(m.active,1)=1
    ORDER BY m.account_code, m.base_type, COALESCE(cc.seq,0), cc.id
  `).all();
  const groups = new Map();
  for (const m of maps) {
    const base = normalizeBaseType(m.base_type);
    const key = base === 'budget' ? `${m.account_code}|budget|${m.id}` : `${m.account_code}|${base}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  const lines = [];
  for (const group of groups.values()) {
    const first = group[0];
    const baseRial = resolveBaseAmount(db, first, bounds);
    const pcts = group.map((m) => clampAbsorbPct(m.absorb_pct != null ? m.absorb_pct : 100));
    const sumPct = pcts.reduce((s, p) => s + p, 0);
    if (sumPct > 100.001) {
      throw absorbErr('E_ACCOUNT_PCT_OVER_100', 409,
        `مجموع درصد جذب معین ${first.account_code} در همهٔ مراکز هزینه ${fmtPct(sumPct)}٪ می‌شود؛ حداکثر ۱۰۰٪ مجاز است`);
    }
    const total = Math.round(baseRial * (sumPct / 100));
    let allocated = 0;
    group.forEach((m, i) => {
      const share = i === group.length - 1 ? total - allocated : Math.round(baseRial * (pcts[i] / 100));
      allocated += share;
      lines.push({
        id: m.id,
        map_id: m.id,
        cost_center_id: Number(m.cost_center_id),
        cc_code: m.cc_code,
        cc_name: m.cc_name,
        cc_seq: Number(m.cc_seq) || 0,
        account_code: m.account_code,
        account_name: m.account_name,
        base_type: normalizeBaseType(m.base_type),
        base_rial: baseRial,
        absorb_pct: pcts[i],
        absorbed_rial: share,
      });
    });
  }
  return { bounds, lines };
}

function summarizeAbsorbLines(lines) {
  const byCc = new Map();
  const byAcc = new Map();
  for (const l of lines) {
    const c = byCc.get(l.cost_center_id) || {
      cost_center_id: l.cost_center_id, cc_code: l.cc_code, cc_name: l.cc_name, cc_seq: l.cc_seq, amount_rial: 0,
    };
    c.amount_rial += l.absorbed_rial;
    byCc.set(l.cost_center_id, c);
    const a = byAcc.get(l.account_code) || { account_code: l.account_code, account_name: l.account_name, amount_rial: 0 };
    a.amount_rial += l.absorbed_rial;
    byAcc.set(l.account_code, a);
  }
  const debit_by_cc = [...byCc.values()]
    .sort((x, y) => (x.cc_seq - y.cc_seq) || (x.cost_center_id - y.cost_center_id))
    .map(({ cc_seq, ...rest }) => rest);
  const credit_by_account = [...byAcc.values()].sort((x, y) => String(x.account_code).localeCompare(String(y.account_code)));
  return { debit_by_cc, credit_by_account, total_rial: lines.reduce((s, l) => s + l.absorbed_rial, 0) };
}

function postedMapIds(db, period) {
  return new Set(db.prepare(`
    SELECT map_id FROM cc_absorb_postings WHERE period_label=? AND status='posted'
  `).all(period).map((r) => Number(r.map_id)));
}

/** پیش‌نمایش سند دوره (همهٔ مراکز): بد 5202 به تفکیک مرکز / بس یک ردیف برای هر معین. */
function previewAbsorbPeriod(db, periodLabel, { costCenterIds } = {}) {
  const { bounds, lines } = computeAbsorbShares(db, periodLabel);
  const posted = postedMapIds(db, bounds.period);
  const filterCc = Array.isArray(costCenterIds) && costCenterIds.length
    ? new Set(costCenterIds.map(Number)) : null;
  const scoped = lines.filter((l) => !filterCc || filterCc.has(l.cost_center_id));
  const pending = scoped.filter((l) => l.absorbed_rial > 0 && !posted.has(Number(l.map_id)));
  return {
    period_label: bounds.period,
    date_from: bounds.from,
    date_to: bounds.to,
    lines: scoped.map((l) => ({ ...l, posted: posted.has(Number(l.map_id)) })),
    already_posted_count: scoped.filter((l) => posted.has(Number(l.map_id))).length,
    pending_lines: pending,
    ...summarizeAbsorbLines(pending),
  };
}

function postAbsorbLines(db, { lines, bounds, userId, date, headerCcId, label }) {
  const { acct } = require('../coa-map');
  const { allocateNumber } = require('../../db');
  const { postEvent, err } = require('./posting');
  const { periodEndJalali } = require('../../jalali');
  const summary = summarizeAbsorbLines(lines);
  const ctl = acct(db, 'coa_overhead_control');
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
    docNo, bounds.period, l.cost_center_id, l.map_id, l.account_code, l.base_type, l.base_rial,
    l.absorb_pct, l.absorbed_rial, userId || null,
  ).lastInsertRowid);

  const jeLines = summary.debit_by_cc.map((c) => ({
    code: ctl.code, name: ctl.name, debit: c.amount_rial / 10, credit: 0, cost_center_id: c.cost_center_id,
    description: `سهم ${c.cc_name || c.cost_center_id}`,
  }));
  for (const a of summary.credit_by_account) {
    jeLines.push({ code: a.account_code, name: a.account_name || a.account_code, debit: 0, credit: a.amount_rial / 10 });
  }
  const je = postEvent(db, {
    event: 'PRD-06',
    sourceId: ids[0],
    date: entryDate,
    description: `جذب سربار واقعی معین‌ها به کنترل سربار — ${label} — دوره ${bounds.period} (${docNo})`,
    createdBy: userId,
    costCenterId: headerCcId || null,
    lines: jeLines,
  });
  if (!je || !je.je_id) throw err('E_JE_FAILED', 500, { doc_no: docNo });
  db.prepare(`UPDATE cc_absorb_postings SET je_id=? WHERE doc_no=? AND status='posted'`).run(je.je_id, docNo);

  auditTo(db, userId, 'create', 'cc_absorb_posting', ids[0], JSON.stringify({
    doc_no: docNo, period: bounds.period, je_id: je.je_id, total_rial: summary.total_rial,
    debit_by_cc: summary.debit_by_cc, credit_by_account: summary.credit_by_account,
    lines: lines.map((l) => ({
      map_id: l.map_id, cost_center_id: l.cost_center_id, account_code: l.account_code, amount_rial: l.absorbed_rial,
    })),
  }));
  return {
    ok: true, doc_no: docNo, period_label: bounds.period, je_id: je.je_id, total_rial: summary.total_rial,
    debit_by_cc: summary.debit_by_cc, credit_by_account: summary.credit_by_account,
    rows: listAbsorbPostings(db, { period: bounds.period }).filter((r) => r.doc_no === docNo),
  };
}

/**
 * یک سند برای (دوره، مرکز): بد 5202 با مرکز هزینه / بس هر معین نگاشت‌شده به اندازهٔ
 * سهم همین مرکز. هر نگاشت در هر دوره فقط یک‌بار (ایندکس یکتای ux_cc_absorb_posted).
 */
function runAbsorb(db, { costCenterId, period, userId, date } = {}) {
  const ccId = Number(costCenterId);
  if (!ccId) throw absorbErr('E_CC_REQUIRED', 400, 'مرکز هزینه الزامی است');
  const cc = db.prepare('SELECT id, code, name FROM cost_centers WHERE id=?').get(ccId);
  if (!cc) throw absorbErr('E_CC_NOT_FOUND', 404, 'مرکز هزینه یافت نشد');
  const bounds = periodDateBounds(period);

  return db.transaction(() => {
    const preview = previewAbsorbPeriod(db, bounds.period, { costCenterIds: [ccId] });
    if (!preview.pending_lines.length) {
      throw absorbErr(preview.already_posted_count ? 'E_ALREADY_POSTED' : 'E_POOL_ZERO', 409,
        preview.already_posted_count
          ? `جذب معین‌های این مرکز برای دوره ${bounds.period} قبلاً ثبت شده است`
          : 'مبلغ جذبی از معین‌ها صفر است');
    }
    const out = postAbsorbLines(db, {
      lines: preview.pending_lines, bounds, userId, date, headerCcId: ccId, label: cc.name,
    });
    return { ...out, cost_center_id: ccId };
  })();
}

/** سند واحد دوره برای همهٔ مراکز: یک بد 5202 برای هر مرکز (سهم آن) / یک بس برای هر معین. */
function runAbsorbPeriod(db, { period, userId, date, costCenterIds } = {}) {
  const bounds = periodDateBounds(period);
  return db.transaction(() => {
    const preview = previewAbsorbPeriod(db, bounds.period, { costCenterIds });
    if (!preview.pending_lines.length) {
      throw absorbErr(preview.already_posted_count ? 'E_ALREADY_POSTED' : 'E_POOL_ZERO', 409,
        preview.already_posted_count
          ? `جذب معین‌ها برای دوره ${bounds.period} قبلاً ثبت شده است`
          : 'مبلغ جذبی از معین‌ها صفر است');
    }
    return postAbsorbLines(db, {
      lines: preview.pending_lines, bounds, userId, date, headerCcId: null, label: 'تسهیم بین مراکز',
    });
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
    auditTo(db, userId, 'delete', 'cc_absorb_posting', rows[0].id, JSON.stringify({
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
  assertAccountPctTotals,
  SPLIT_SETTING_KEY,
  DEFAULT_SPLIT,
  normalizeSplit,
  getSplit,
  applySplit,
  listOverheadLeafAccounts,
  computeAbsorbShares,
  previewAbsorbPeriod,
  runAbsorbPeriod,
};
