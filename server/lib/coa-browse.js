'use strict';

/**
 * چهارستون کدینگ: گروه → کل → معین → تفصیلی.
 * پوستهٔ فنی که ensureControlParents می‌سازد (معین ۴رقمی + '01'، مثل 210101)
 * سطح نمایش نیست. تفصیلی زنده همان کد ۱۲رقمی یا کد legacy (1102-3) است.
 * شماره‌های سند عوض نمی‌شوند.
 */

function isOperationalTafsili(account) {
  const code = String(account && account.code || '');
  if (Number(account && account.level) >= 4) return true;
  if (code.length >= 12) return true;
  if (code.includes('-')) return true;
  return false;
}

/**
 * پوستهٔ خودکار ستون تفصیلی: 2101 → 210101.
 * این الگو را برای «قابل انتخاب بودن حساب هزینه» به کار نبرید.
 * suggestChildCode اولین معین واقعی زیر کل را همین parent+'01' می‌دهد (6103 → 610301).
 */
function isAutoShell(code, moinCode) {
  const c = String(code || '');
  const m = String(moinCode || '');
  return m.length > 0 && c === m + '01' && c.length === m.length + 2;
}

function activeAccounts(accounts) {
  return (accounts || []).filter((a) => a && a.is_active !== 0 && a.code != null && String(a.code) !== '');
}

function childrenIndex(accounts) {
  const map = new Map();
  for (const a of accounts) {
    const p = a.parent_code ? String(a.parent_code) : '';
    if (!map.has(p)) map.set(p, []);
    map.get(p).push(a);
  }
  return map;
}

/**
 * تفصیلی‌های قابل نمایش زیر معین انتخاب‌شده.
 * @param {Array<object>} accounts
 * @param {string} moinCode کد معین ۴رقمی (مثلاً 2101) یا هر گره‌ای که کاربر در ستون معین زده
 */
function tafsiliUnderMoin(accounts, moinCode) {
  const moin = String(moinCode || '');
  if (!moin) return [];
  const list = activeAccounts(accounts);
  const kids = childrenIndex(list);
  const shellCode = moin + '01';
  const out = [];
  const seen = new Set();

  function add(account) {
    const code = String(account.code);
    if (seen.has(code) || code === moin || isAutoShell(code, moin)) return;
    seen.add(code);
    out.push(account);
  }

  function hasOperationalDescendant(code, stack) {
    if (stack.has(code)) return false;
    stack.add(code);
    for (const child of kids.get(code) || []) {
      const childCode = String(child.code);
      if (isOperationalTafsili(child) && !isAutoShell(childCode, moin)) return true;
      if (hasOperationalDescendant(childCode, stack)) return true;
    }
    return false;
  }

  function walk(parentCode, stack) {
    if (stack.has(parentCode)) return;
    stack.add(parentCode);
    for (const child of kids.get(String(parentCode)) || []) {
      const code = String(child.code);
      const descendants = kids.get(code) || [];
      const shell = isAutoShell(code, moin)
        || (!isOperationalTafsili(child) && hasOperationalDescendant(code, new Set()));
      if (shell) {
        walk(code, stack);
        continue;
      }
      if (isOperationalTafsili(child) || descendants.length === 0) add(child);
      if (descendants.length) walk(code, stack);
    }
  }

  walk(moin, new Set());

  for (const account of list) {
    const code = String(account.code);
    if (seen.has(code) || code === moin || isAutoShell(code, moin)) continue;
    if (!isOperationalTafsili(account)) continue;
    const parent = account.parent_code ? String(account.parent_code) : '';
    const underShell = code.startsWith(shellCode) && code.length > shellCode.length;
    const underMoin = code.startsWith(moin) && code.length > moin.length && (code.length >= 12 || code.includes('-'));
    if (underShell || parent === shellCode || (underMoin && (parent === moin || !parent))) add(account);
  }

  out.sort((a, b) => String(a.code).localeCompare(String(b.code), 'en'));
  return out;
}

/** والد پیشنهادی برای ساخت دستی: اگر پوسته هست، تفصیلی زیر همان پوسته می‌نشیند. */
function tafsiliCreateParent(accounts, moinCode) {
  const moin = String(moinCode || '');
  if (!moin) return '';
  const shell = moin + '01';
  const hit = activeAccounts(accounts).some((a) => String(a.code) === shell);
  return hit ? shell : moin;
}

module.exports = {
  tafsiliUnderMoin,
  tafsiliCreateParent,
  isAutoShell,
  isOperationalTafsili,
};
