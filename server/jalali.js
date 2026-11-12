// Proven Gregorian <-> Jalali conversion (jalaali-js algorithm).
function div(a, b) { return ~~(a / b); }

function g2j(gy, gm, gd) {
  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const gy2 = (gm > 2) ? (gy + 1) : gy;
  let days = 355666 + (365 * gy) + div(gy2 + 3, 4) - div(gy2 + 99, 100) + div(gy2 + 399, 400) + gd + g_d_m[gm - 1];
  let jy = -1595 + (33 * div(days, 12053));
  days %= 12053;
  jy += 4 * div(days, 1461);
  days %= 1461;
  if (days > 365) { jy += div(days - 1, 365); days = (days - 1) % 365; }
  let jm, jd;
  if (days < 186) { jm = 1 + div(days, 31); jd = 1 + (days % 31); }
  else { jm = 7 + div(days - 186, 30); jd = 1 + ((days - 186) % 30); }
  return [jy, jm, jd];
}

function j2g(jy, jm, jd) {
  let gy, gm, gd, days;
  jy += 1595;
  days = -355668 + (365 * jy) + (div(jy, 33) * 8) + div(((jy % 33) + 3), 4) + jd + ((jm < 7) ? (jm - 1) * 31 : ((jm - 7) * 30) + 186);
  gy = 400 * div(days, 146097); days %= 146097;
  if (days > 36524) { gy += 100 * div(--days, 36524); days %= 36524; if (days >= 365) days++; }
  gy += 4 * div(days, 1461); days %= 1461;
  if (days > 365) { gy += div((days - 1), 365); days = (days - 1) % 365; }
  gd = days + 1;
  const sal_a = [0, 31, ((gy % 4 === 0 && gy % 100 !== 0) || (gy % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (gm = 0; gm < 13 && gd > sal_a[gm]; gm++) gd -= sal_a[gm];
  return [gy, gm, gd];
}

function todayJalali() {
  const d = new Date();
  const [jy, jm, jd] = g2j(d.getFullYear(), d.getMonth() + 1, d.getDate());
  return `${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')}`;
}

/** Asia/Tehran calendar+clock parts (independent of process TZ). */
function tehranParts(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    gy: Number(get('year')),
    gm: Number(get('month')),
    gd: Number(get('day')),
    hh: Number(get('hour')),
    mi: Number(get('minute')),
  };
}

function todayJalaliTehran(now = new Date()) {
  const { gy, gm, gd } = tehranParts(now);
  const [jy, jm, jd] = g2j(gy, gm, gd);
  return `${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')}`;
}

function jalaliDayNumber(s) {
  const parts = String(s || '').trim().split(/[/-]/).map((x) => parseInt(x, 10));
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [jy, jm, jd] = parts;
  if (jm < 1 || jm > 12 || jd < 1 || jd > 31) return null;
  try {
    const [gy, gm, gd] = j2g(jy, jm, jd);
    return Date.UTC(gy, gm - 1, gd) / 86400000;
  } catch {
    return null;
  }
}

function diffJalaliDays(a, b) {
  const na = jalaliDayNumber(a);
  const nb = jalaliDayNumber(b);
  if (na == null || nb == null) return null;
  return na - nb;
}

function addJalaliDaysExact(s, n) {
  const base = jalaliDayNumber(s);
  if (base == null) return null;
  const target = base + Number(n || 0);
  const ms = target * 86400000;
  const d = new Date(ms);
  const [jy, jm, jd] = g2j(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  return `${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')}`;
}

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Add N calendar days to a Jalali date string "YYYY/MM/DD"
function addDaysToJalali(jalaliStr, days) {
  try {
    const parts = jalaliStr.split('/').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return todayJalali();
    const [jy, jm, jd] = parts;
    const [gy, gm, gd] = j2g(jy, jm, jd);
    const d = new Date(gy, gm - 1, gd);
    d.setDate(d.getDate() + days);
    const [ny, nm, nd] = g2j(d.getFullYear(), d.getMonth() + 1, d.getDate());
    return `${ny}/${String(nm).padStart(2, '0')}/${String(nd).padStart(2, '0')}`;
  } catch {
    return todayJalali();
  }
}

/** Jalali leap: Esfand has 30 days (jalaali-js / algorithm used by j2g). */
function isJalaliLeapYear(jy) {
  const y = Number(jy);
  if (!Number.isFinite(y)) return false;
  // Round-trip: 30 Esfand only exists in leap years.
  const [gy, gm, gd] = j2g(y, 12, 30);
  const back = g2j(gy, gm, gd);
  return back[0] === y && back[1] === 12 && back[2] === 30;
}

function daysInJalaliMonth(jy, jm) {
  const m = Number(jm);
  if (m >= 1 && m <= 6) return 31;
  if (m >= 7 && m <= 11) return 30;
  if (m === 12) return isJalaliLeapYear(jy) ? 30 : 29;
  return 0;
}

/** End date for Jalali period label `YYYY/MM` (or `YYYY/MM/DD` passthrough via caller). */
function periodEndJalali(period) {
  const parts = String(period || '').split('/');
  if (parts.length >= 2) {
    const jy = Number(parts[0]);
    const jm = Number(parts[1]);
    const dim = daysInJalaliMonth(jy, jm);
    if (!dim) return `${parts[0]}/${String(parts[1] || '01').padStart(2, '0')}/01`;
    return `${parts[0]}/${String(jm).padStart(2, '0')}/${String(dim).padStart(2, '0')}`;
  }
  return `${period}/29`;
}

module.exports = {
  g2j, j2g, todayJalali, nowHHMM, addDaysToJalali,
  isJalaliLeapYear, daysInJalaliMonth, periodEndJalali,
  tehranParts, todayJalaliTehran, jalaliDayNumber, diffJalaliDays, addJalaliDaysExact,
};
