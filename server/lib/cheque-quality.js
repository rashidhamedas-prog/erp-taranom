'use strict';
/**
 * Cheque quality flags + Sayadi validation (Iran 16-digit unique id).
 * Old rows are flagged only; validation hard-fails on NEW create.
 */

const DUMMY_SAYADS = new Set([
  '1234567891234567',
  '0000000000000000',
  '1111111111111111',
  '1234567890123456',
]);

function toAsciiDigits(s) {
  return String(s == null ? '' : s)
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632));
}

function digitsOnly(s) {
  return toAsciiDigits(s).replace(/\D/g, '');
}

function isRepeatedDigit(d) {
  return d.length === 16 && /^(\d)\1{15}$/.test(d);
}

function isSequential(d) {
  if (d.length !== 16) return false;
  let asc = true;
  let desc = true;
  for (let i = 1; i < 16; i += 1) {
    const a = Number(d[i - 1]);
    const b = Number(d[i]);
    if (b !== (a + 1) % 10) asc = false;
    if (b !== (a + 9) % 10) desc = false;
  }
  return asc || desc;
}

/**
 * @returns {{ ok: boolean, code?: string, digits?: string, message?: string }}
 */
function validateSayadi(raw) {
  const digits = digitsOnly(raw);
  if (!digits) {
    return { ok: false, code: 'E_SAYAD_INVALID', digits: '', message: 'شناسه صیاد الزامی است (۱۶ رقم)' };
  }
  if (!/^\d{16}$/.test(digits)) {
    return { ok: false, code: 'E_SAYAD_INVALID', digits, message: 'شناسه صیاد باید دقیقاً ۱۶ رقم باشد' };
  }
  if (DUMMY_SAYADS.has(digits) || isRepeatedDigit(digits) || isSequential(digits)) {
    return { ok: false, code: 'E_SAYAD_DUMMY', digits, message: 'شناسه صیاد ساختگی یا نامعتبر است' };
  }
  return { ok: true, digits };
}

function normalizeSayadi(raw) {
  const v = validateSayadi(raw);
  return v.ok ? v.digits : digitsOnly(raw);
}

function jalaliOrdinal(s) {
  const parts = String(s || '').split(/[/-]/).map((x) => parseInt(x, 10));
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts[0] * 372 + parts[1] * 31 + parts[2];
}

function daysUntilDue(due, today) {
  const { diffJalaliDays } = require('../jalali');
  return diffJalaliDays(due, today);
}

/**
 * @param {object} row
 * @param {{ today?: string, dupSayads?: Set<string>, adminNames?: Set<string> }} ctx
 * @returns {string[]}
 */
function chequeQualityFlags(row, ctx = {}) {
  const flags = [];
  if (!row) return flags;
  const say = String(row.sayadi || '').trim();
  const digits = digitsOnly(say);
  if (!digits) flags.push('missing_sayad');
  else {
    const v = validateSayadi(say);
    if (!v.ok && v.code === 'E_SAYAD_DUMMY') flags.push('dummy_sayad');
    else if (!v.ok) flags.push('invalid_sayad');
  }
  if (digits && ctx.dupSayads && ctx.dupSayads.has(digits)) flags.push('dup_sayad');

  const partyName = String(row.party_name || '').trim();
  const partyId = row.party_id == null || row.party_id === '' ? null : Number(row.party_id);
  if (partyId == null || !Number.isFinite(partyId) || partyId <= 0) {
    flags.push('suspicious_party');
  } else if (ctx.adminNames && partyName && ctx.adminNames.has(partyName)) {
    flags.push('suspicious_party');
  }

  const branch = String(row.branch || '').trim();
  if (branch === '' || branch === '0') flags.push('branch_placeholder');

  if (!row.journal_entry_id && !row.settlement_id) flags.push('no_journal');

  const today = ctx.today || '';
  const due = String(row.due_date || '').trim();
  const status = String(row.status || '');
  const days = daysUntilDue(due, today);
  if (status.includes('اول دوره') && days != null && days < 0) flags.push('stale_label');
  if (days != null && days < 0) {
    const lc = String(row.lifecycle_status || '').trim().toLowerCase();
    if (!lc || lc === 'registered' || lc === 'in_hand' || lc === 'pending' || lc === 'in_collection') {
      flags.push('overdue');
    }
  }
  return flags;
}

const QUALITY_LABEL_FA = {
  missing_sayad: 'بدون صیاد',
  invalid_sayad: 'صیاد نامعتبر',
  dummy_sayad: 'صیاد ساختگی',
  dup_sayad: 'صیاد تکراری',
  suspicious_party: 'طرف حساب مشکوک',
  branch_placeholder: 'شعبه نامشخص',
  no_journal: 'بدون سند',
  stale_label: 'برچسب کهنه',
  overdue: 'سررسیدگذشته',
};

function buildDupSayadSet(db) {
  const set = new Set();
  try {
    const rows = db.prepare(`
      SELECT TRIM(sayadi) AS s, COUNT(*) AS n
      FROM cheque_records
      WHERE COALESCE(record_status,'posted')='posted'
        AND TRIM(COALESCE(sayadi,''))<>''
      GROUP BY direction, TRIM(sayadi)
      HAVING n>1
    `).all();
    for (const r of rows) {
      const d = digitsOnly(r.s);
      if (d) set.add(d);
    }
  } catch (_) { /* */ }
  return set;
}

function buildAdminNameSet(db) {
  const set = new Set();
  try {
    const users = db.prepare(`
      SELECT name FROM users
      WHERE COALESCE(is_active,1)=1 AND role IN ('admin','accounting')
    `).all();
    for (const u of users) {
      const n = String(u.name || '').trim();
      if (n) set.add(n);
    }
  } catch (_) { /* */ }
  return set;
}

module.exports = {
  DUMMY_SAYADS,
  toAsciiDigits,
  digitsOnly,
  validateSayadi,
  normalizeSayadi,
  jalaliOrdinal,
  daysUntilDue,
  chequeQualityFlags,
  QUALITY_LABEL_FA,
  buildDupSayadSet,
  buildAdminNameSet,
};
