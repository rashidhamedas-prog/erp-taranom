'use strict';
/**
 * P9-fix — نوع ذی‌نفع پورسانت + انحصار موتور (P9 ↔ «انگیزه فروش» قدیمی).
 *
 * تصمیم حامد: برای هر شخص فقط یک موتور.
 *   - فعال‌کردن قاعده/طرف P9 برای شخصی که «انگیزه فروش» فعال دارد ⇒ ۴۰۹ E_COMMISSION_ENGINE_CONFLICT (و برعکس).
 *   - نگاشت شخص ↔ کاربرِ موتور قدیمی: users.person_id = persons.id یا users.party_id = persons.party_id.
 *   - «انگیزهٔ فعال» = کاربر فعال با نرخ نقد/چک/ثابت/سرپرستی > ۰ یا قاعده/پلکان فعال با نرخ > ۰ در موتور قدیمی.
 *   - «P9 فعال» = حداقل یک commission_rules با active=1.
 *
 * نوع ذی‌نفع (persons.commission_beneficiary_type): employee | agent؛ NULL ⇒ مشتق (کد پرسنلی/شمارهٔ کارمندی ⇒ employee).
 * فلگ‌های کارمند (persons.insurance_applicable / payroll_tax_applicable): NULL ⇒ مقدار پروندهٔ حقوق
 *   (insurance_type='none' ⇒ ۰؛ معاف کامل مالیات ⇒ ۰) وگرنه ۱. فقط روی ردیف پورسانت در حقوق اثر دارند.
 * نرخ کسر مالیات نماینده (settings.commission_agent_tax_rate، درصد) پیش‌فرض ۰؛ فقط مدیر.
 * هیچ نرخ بیمه/مالیات حقوق اینجا hard-code نیست — موتور حقوق از دوره/جدول مالیات می‌خواند.
 */

const ENGINE_CONFLICT = 'E_COMMISSION_ENGINE_CONFLICT';
const TYPES = new Set(['employee', 'agent']);
const AGENT_TAX_KEY = 'commission_agent_tax_rate';

function httpErr(status, message, code, extra) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function colSet(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

function settingValue(db, key) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : null;
}

// ── engine exclusion ──

const USER_RATE_COLS = ['commission_cash', 'commission_cheque', 'commission_fixed', 'supervisor_commission_pct'];

/** Incentive config active for a user. `override` = rate fields about to be saved (admin PUT). */
function incentiveActiveForUser(db, userId, override) {
  const uc = colSet(db, 'users');
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(Number(userId));
  if (!u) return false;
  const merged = { ...u, ...(override || {}) };
  if (!Number(merged.active)) return false;
  for (const c of USER_RATE_COLS) {
    if (uc.has(c) && Number(merged[c]) > 0) return true;
  }
  if (tableExists(db, 'rep_commission_rules')
    && db.prepare('SELECT 1 FROM rep_commission_rules WHERE rep_id=? AND active=1 AND (COALESCE(rate_cash,0)>0 OR COALESCE(rate_cheque,0)>0) LIMIT 1').get(u.id)) {
    return true;
  }
  if (tableExists(db, 'rep_commission_tiers')
    && db.prepare('SELECT 1 FROM rep_commission_tiers WHERE rep_id=? AND active=1 AND (COALESCE(rate_cash,0)>0 OR COALESCE(rate_cheque,0)>0) LIMIT 1').get(u.id)) {
    return true;
  }
  return false;
}

/** Users that represent the same human as a person (users.person_id or shared party). */
function usersForPerson(db, personId) {
  const uc = colSet(db, 'users');
  const pid = Number(personId);
  if (!pid) return [];
  const out = new Map();
  if (uc.has('person_id')) {
    for (const u of db.prepare('SELECT id, name FROM users WHERE person_id=?').all(pid)) out.set(u.id, u);
  }
  if (uc.has('party_id') && colSet(db, 'persons').has('party_id')) {
    const p = db.prepare('SELECT party_id FROM persons WHERE id=?').get(pid);
    if (p && p.party_id) {
      for (const u of db.prepare('SELECT id, name FROM users WHERE party_id=?').all(p.party_id)) out.set(u.id, u);
    }
  }
  return [...out.values()];
}

/** Persons that represent the same human as a user. */
function personsForUser(db, userId) {
  const uc = colSet(db, 'users');
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(Number(userId));
  if (!u) return [];
  const ids = new Set();
  if (uc.has('person_id') && u.person_id) ids.add(Number(u.person_id));
  if (uc.has('party_id') && u.party_id && colSet(db, 'persons').has('party_id')) {
    for (const p of db.prepare('SELECT id FROM persons WHERE party_id=?').all(u.party_id)) ids.add(Number(p.id));
  }
  return [...ids];
}

function p9ActiveForPerson(db, personId) {
  if (!tableExists(db, 'commission_rules')) return false;
  return !!db.prepare('SELECT 1 FROM commission_rules WHERE person_id=? AND active=1 LIMIT 1').get(Number(personId));
}

function personName(db, id) {
  const p = db.prepare('SELECT name FROM persons WHERE id=?').get(Number(id));
  return p ? p.name : `#${id}`;
}

/** Throws 409 when activating P9 for a person whose linked user has an active sales incentive. */
function assertNoIncentiveForPerson(db, personId) {
  const hits = usersForPerson(db, personId).filter((u) => incentiveActiveForUser(db, u.id));
  if (hits.length) {
    throw httpErr(409,
      `برای «${personName(db, personId)}» موتور «انگیزه فروش» (کاربر ${hits.map((u) => u.name).join('، ')}) فعال است؛ برای هر شخص فقط یک موتور مجاز است — ابتدا انگیزه فروش را صفر/غیرفعال کنید`,
      ENGINE_CONFLICT, { person_id: Number(personId), user_ids: hits.map((u) => u.id) });
  }
}

/** Throws 409 when activating the legacy incentive for a user whose person has active P9 rules. */
function assertNoP9ForUser(db, userId) {
  const hits = personsForUser(db, userId).filter((pid) => p9ActiveForPerson(db, pid));
  if (hits.length) {
    throw httpErr(409,
      `برای «${hits.map((pid) => personName(db, pid)).join('، ')}» قاعدهٔ فعال «پورسانت سرپرست/فروشنده» (P9) وجود دارد؛ برای هر شخص فقط یک موتور مجاز است — ابتدا قاعده‌های P9 را غیرفعال کنید`,
      ENGINE_CONFLICT, { user_id: Number(userId), person_ids: hits });
  }
}

/** Legacy data where both engines are active: Map person_id → { person_id, name, user_ids }. */
function engineConflicts(db) {
  const out = new Map();
  if (!tableExists(db, 'commission_rules')) return out;
  const pids = db.prepare('SELECT DISTINCT person_id FROM commission_rules WHERE active=1').all().map((r) => Number(r.person_id));
  for (const pid of pids) {
    const users = usersForPerson(db, pid).filter((u) => incentiveActiveForUser(db, u.id));
    if (users.length) out.set(pid, { person_id: pid, name: personName(db, pid), user_ids: users.map((u) => u.id) });
  }
  return out;
}

// ── beneficiary type + employee flags ──

function isEmployeeRecord(person) {
  if (!person) return false;
  return !!(String(person.personnel_code || '').trim() || String(person.employee_no || '').trim());
}

function latestStructure(db, personId) {
  if (!tableExists(db, 'salary_structures')) return null;
  return db.prepare(`
    SELECT insurance_type, tax_exemption_type, tax_exemption_percent_bp FROM salary_structures
    WHERE person_id=? ORDER BY COALESCE(active,1) DESC, fiscal_year DESC, id DESC LIMIT 1
  `).get(Number(personId)) || null;
}

/** Payroll-file defaults: insurance_type 'none' ⇒ 0; fully tax-exempt ⇒ 0; otherwise 1. */
function payrollFileDefaults(db, person) {
  const s = latestStructure(db, person.id);
  const insType = String((s && s.insurance_type) || person.insurance_type || '').trim();
  const taxType = String((s && s.tax_exemption_type) || person.tax_exemption_type || '').trim();
  const fullyExempt = Number(person.is_tax_exempt) === 1 || taxType === 'tax_exempt'
    || (s && Number(s.tax_exemption_percent_bp) >= 10000);
  return { insurance_applicable: insType === 'none' ? 0 : 1, payroll_tax_applicable: fullyExempt ? 0 : 1 };
}

function flagValue(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  return Number(v) ? 1 : 0;
}

/** Effective beneficiary info of a person (stored value, else derived). */
function beneficiaryOf(db, personOrId) {
  const person = typeof personOrId === 'object' && personOrId
    ? personOrId
    : db.prepare('SELECT * FROM persons WHERE id=?').get(Number(personOrId));
  if (!person) return null;
  const stored = TYPES.has(String(person.commission_beneficiary_type || '')) ? person.commission_beneficiary_type : null;
  const type = stored || (isEmployeeRecord(person) ? 'employee' : 'agent');
  const defs = payrollFileDefaults(db, person);
  return {
    person_id: person.id,
    name: person.name,
    beneficiary_type: type,
    beneficiary_type_derived: stored ? 0 : 1,
    insurance_applicable: flagValue(person.insurance_applicable, defs.insurance_applicable),
    payroll_tax_applicable: flagValue(person.payroll_tax_applicable, defs.payroll_tax_applicable),
  };
}

/** Flags passed (server-side) to the payroll engine for the commission row. */
function payrollCommissionFlags(db, personId) {
  const b = beneficiaryOf(db, personId);
  if (!b) return { commission_insurance_applicable: 1, commission_tax_applicable: 1 };
  return { commission_insurance_applicable: b.insurance_applicable, commission_tax_applicable: b.payroll_tax_applicable };
}

/**
 * Idempotent backfill (central only): fill NULL type/flags from current data; never overwrite non-null.
 * Only employees (personnel code / employee no) and persons already in P9 rules/transfers — other persons
 * stay NULL so the type keeps following their record if they are hired later.
 * Marker: settings.commission_beneficiary_backfill_v1.
 */
function backfillBeneficiaries(db) {
  const FLAG = 'commission_beneficiary_backfill_v1';
  if (settingValue(db, FLAG) === '1') return { skipped: true };
  const pc = colSet(db, 'persons');
  if (!pc.has('commission_beneficiary_type') || !pc.has('insurance_applicable') || !pc.has('payroll_tax_applicable')) {
    return { skipped: true, reason: 'columns' };
  }
  let n = 0;
  db.transaction(() => {
    const hasRules = tableExists(db, 'commission_rules');
    const hasTransfers = tableExists(db, 'commission_transfers');
    const rows = db.prepare(`
      SELECT * FROM persons p
      WHERE (p.commission_beneficiary_type IS NULL OR p.insurance_applicable IS NULL OR p.payroll_tax_applicable IS NULL)
        AND (TRIM(COALESCE(p.personnel_code,''))<>'' OR TRIM(COALESCE(p.employee_no,''))<>''
          ${hasRules ? 'OR EXISTS (SELECT 1 FROM commission_rules r WHERE r.person_id=p.id)' : ''}
          ${hasTransfers ? 'OR EXISTS (SELECT 1 FROM commission_transfers t WHERE t.person_id=p.id)' : ''})
    `).all();
    const upd = db.prepare(`
      UPDATE persons SET
        commission_beneficiary_type=COALESCE(commission_beneficiary_type, ?),
        insurance_applicable=COALESCE(insurance_applicable, ?),
        payroll_tax_applicable=COALESCE(payroll_tax_applicable, ?)
      WHERE id=?
    `);
    for (const p of rows) {
      const b = beneficiaryOf(db, p);
      n += upd.run(b.beneficiary_type, b.insurance_applicable, b.payroll_tax_applicable, p.id).changes;
    }
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(FLAG, '1');
  })();
  return { skipped: false, updated: n };
}

function updateBeneficiary(db, personId, body) {
  return db.transaction(() => {
    const person = db.prepare('SELECT * FROM persons WHERE id=?').get(Number(personId));
    if (!person) throw httpErr(404, 'شخص یافت نشد');
    const cur = beneficiaryOf(db, person);
    const b = body || {};
    let type = cur.beneficiary_type;
    if (b.commission_beneficiary_type !== undefined) {
      type = String(b.commission_beneficiary_type || '');
      if (!TYPES.has(type)) throw httpErr(400, 'نوع ذی‌نفع باید employee (کارمند) یا agent (نماینده آزاد) باشد', 'E_BENEFICIARY_TYPE');
    }
    if (type !== cur.beneficiary_type && tableExists(db, 'commission_transfers')) {
      const live = db.prepare("SELECT doc_no FROM commission_transfers WHERE person_id=? AND status IN ('pending','in_payroll') LIMIT 1").get(person.id);
      if (live) throw httpErr(409, `انتقال حقوقی زنده (${live.doc_no}) دارد؛ ابتدا آن را ابطال کنید`, 'E_COMMISSION_LOCKED');
    }
    const ins = b.insurance_applicable === undefined ? cur.insurance_applicable : (Number(b.insurance_applicable) ? 1 : 0);
    const tax = b.payroll_tax_applicable === undefined ? cur.payroll_tax_applicable : (Number(b.payroll_tax_applicable) ? 1 : 0);
    db.prepare('UPDATE persons SET commission_beneficiary_type=?, insurance_applicable=?, payroll_tax_applicable=? WHERE id=?')
      .run(type, ins, tax, person.id);
    return beneficiaryOf(db, person.id);
  })();
}

/** Persons with active P9 rules (or a given list) with beneficiary info. */
function listBeneficiaries(db) {
  if (!tableExists(db, 'commission_rules')) return [];
  const ids = db.prepare('SELECT DISTINCT person_id FROM commission_rules WHERE active=1 ORDER BY person_id').all().map((r) => r.person_id);
  const conflicts = engineConflicts(db);
  return ids.map((id) => beneficiaryOf(db, id)).filter(Boolean)
    .map((b) => ({ ...b, engine_conflict: conflicts.has(b.person_id) ? 1 : 0 }));
}

// ── agent withholding tax ──

function agentTaxRatePct(db) {
  const v = Number(settingValue(db, AGENT_TAX_KEY));
  return Number.isFinite(v) && v > 0 ? Math.min(v, 100) : 0;
}

function setAgentTaxRatePct(db, value) {
  const v = Number(String(value == null ? '' : value).replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))));
  if (!Number.isFinite(v) || v < 0 || v > 100) throw httpErr(400, 'نرخ کسر مالیات نماینده باید بین ۰ تا ۱۰۰ درصد باشد', 'E_TAX_RATE');
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(AGENT_TAX_KEY, String(v));
  return agentTaxRatePct(db);
}

// ── read-only account suggestions (no settings write) ──

const SUGGEST_KEYS = {
  expense: 'coa_rep_commission_expense',
  payable: 'coa_rep_commission_payable',
  tax: 'coa_payroll_tax_payable',
};
const HEURISTICS = {
  expense: { prefix: '6', type: 'expense', strong: /پورسانت|کمیسیون|حق[\s‌]?العمل/, weak: /انگیزه|بازاریاب|فروش/ },
  payable: { prefix: '2', type: 'liability', strong: /پورسانت|کمیسیون|حق[\s‌]?العمل/, weak: /انگیزه|نماینده|بازاریاب/ },
  tax: { prefix: '2', type: 'liability', strong: /تکلیفی|۱۰۴|104|حق[\s‌]?العمل/, weak: /مالیات/ },
};

function isLeaf(db, code) {
  return !db.prepare('SELECT 1 FROM chart_of_accounts WHERE parent_code=? AND COALESCE(is_active,1)=1 LIMIT 1').get(code);
}

function currentMapping(db, key) {
  const { LEGACY } = require('./coa-map');
  const legacy = LEGACY[key];
  const raw = settingValue(db, key);
  const code = String(raw || (legacy && legacy.code) || '');
  const row = code ? db.prepare('SELECT code, name, type, COALESCE(is_active,1) AS is_active FROM chart_of_accounts WHERE code=?').get(code) : null;
  return {
    key,
    code,
    name: row ? row.name : (legacy && legacy.name) || '',
    source: raw ? 'settings' : 'default',
    exists: row ? 1 : 0,
    active: row ? Number(row.is_active) : 0,
    leaf: row ? (isLeaf(db, code) ? 1 : 0) : 0,
  };
}

function accountSuggestions(db) {
  const accounts = db.prepare('SELECT code, name, type, COALESCE(is_active,1) AS is_active FROM chart_of_accounts').all()
    .filter((a) => Number(a.is_active) === 1);
  const out = { note: 'فقط پیشنهاد و گزارش — هیچ تنظیم/نگاشت کدینگی تغییر داده نمی‌شود', current: {}, suggestions: {} };
  for (const [kind, key] of Object.entries(SUGGEST_KEYS)) {
    out.current[kind] = currentMapping(db, key);
    const h = HEURISTICS[kind];
    const scored = [];
    for (const a of accounts) {
      const name = String(a.name || '');
      const code = String(a.code || '');
      const groupOk = code.startsWith(h.prefix) || String(a.type || '').toLowerCase() === h.type;
      if (!groupOk) continue;
      let score = 0;
      const reasons = [];
      if (h.strong.test(name)) { score += 10; reasons.push('نام حساب'); }
      else if (h.weak.test(name)) { score += 3; reasons.push('نام مشابه'); }
      if (!score) continue;
      const leaf = isLeaf(db, code);
      if (leaf) { score += 2; reasons.push('برگ (قابل ثبت)'); }
      if (code === out.current[kind].code) { score += 1; reasons.push('نگاشت فعلی'); }
      scored.push({ code, name, type: a.type, leaf: leaf ? 1 : 0, score, reasons });
    }
    scored.sort((x, y) => y.score - x.score || x.code.localeCompare(y.code));
    out.suggestions[kind] = scored.slice(0, 10);
  }
  return out;
}

// ── monthly review report ──

function monthRange(month) {
  const s = String(month == null ? '' : month).trim()
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/-/g, '/');
  if (!/^\d{4}\/\d{2}$/.test(s)) throw httpErr(400, 'ماه نامعتبر است — قالب ۱۴۰۵/۰۷', 'E_MONTH');
  return { month: s, from: `${s}/01`, to: `${s}/31` };
}

/** Persons with commission in the month whose insurance/tax flag is off, agents at 0% tax, and engine conflicts. */
function reviewReport(db, month) {
  const { month: m, from, to } = monthRange(month);
  const CM = require('./commissions-multi');
  const rep = CM.commissionReport(db, { from, to });
  const taxRate = agentTaxRatePct(db);
  const rows = [];
  for (const r of rep.rows) {
    if (!r.total_rial) continue;
    const b = beneficiaryOf(db, r.person_id);
    if (!b) continue;
    const reasons = [];
    if (b.beneficiary_type === 'employee') {
      if (!b.insurance_applicable) reasons.push('insurance_off');
      if (!b.payroll_tax_applicable) reasons.push('payroll_tax_off');
    } else if (!(taxRate > 0)) {
      reasons.push('agent_tax_zero');
    }
    if (!reasons.length) continue;
    rows.push({
      person_id: r.person_id, name: r.name, beneficiary_type: b.beneficiary_type,
      insurance_applicable: b.insurance_applicable, payroll_tax_applicable: b.payroll_tax_applicable,
      total_rial: r.total_rial, reasons,
    });
  }
  return { month: m, from, to, agent_tax_rate_pct: taxRate, rows, engine_conflicts: rep.engine_conflicts || [] };
}

module.exports = {
  ENGINE_CONFLICT,
  AGENT_TAX_KEY,
  incentiveActiveForUser,
  usersForPerson,
  personsForUser,
  p9ActiveForPerson,
  assertNoIncentiveForPerson,
  assertNoP9ForUser,
  engineConflicts,
  isEmployeeRecord,
  beneficiaryOf,
  payrollCommissionFlags,
  backfillBeneficiaries,
  updateBeneficiary,
  listBeneficiaries,
  agentTaxRatePct,
  setAgentTaxRatePct,
  accountSuggestions,
  reviewReport,
};
