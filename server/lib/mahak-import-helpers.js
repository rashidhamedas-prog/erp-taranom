// Shared helpers for Mahak Excel import (entity parsing, product categories).
const fa = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/** Split Mahak person tafsili title → owner / business / phone. */
function parsePersonName(name) {
  const raw = fa(name);
  const phoneMatch = raw.match(/\b(0\d{10})\b/);
  const phone = phoneMatch ? phoneMatch[1] : '';
  let clean = raw.replace(/\b0\d{10}\b/g, '').replace(/\s+/g, ' ').trim();
  const parts = clean.split(/\s*[-–/]\s*/).map(p => p.trim()).filter(Boolean);
  let owner = '', biz = clean;
  if (/^(آقاي|آقای|خانم|اقاي|اقای)\s/i.test(clean)) {
    owner = parts[0] || clean;
    biz = parts.length > 1 ? parts.slice(1).join(' — ') : owner;
  } else if (/^(فروشگاه|شرکت|کارگاه|تولیدی|پوشاک|مانتو)/.test(clean)) {
    biz = clean;
    owner = '';
  } else if (parts.length >= 2) {
    owner = parts[0];
    biz = parts.slice(1).join(' — ');
  }
  if (!biz) biz = owner || clean;
  return { owner, biz, phone };
}

/** Classify inventory row for product_categories (مواد اولیه vs محصول نهایی). */
function guessProductCategory(name) {
  const n = fa(name);
  if (/پارچه|مغزی|نخ\b|جارو|کاور|پاکت|برچسب|دکمه|مارک|ته طاق|بسته|پلمپ|چسب|قفل|زیپ|آستر|آستین|یقه|الگو|شابلون|قیصری|کاور|نخ|رنگ|رنگر|دوخت|ملزوم|خرجکار|پوشاک\s*$/i.test(n))
    return 'مواد اولیه';
  if (/مانتو|پیراهن|دامن|شلوار|کت\b|ست\b|بالاپوش|لباس|پالتو|کاپشن|تیشرت|بلوز|شومیز/i.test(n))
    return 'محصول نهایی';
  return 'محصول نهایی';
}

/** Build map full12 → {debit,credit,count} from parsed vouchers. */
function buildAccountUsage(docList) {
  const accountUsage = new Map();
  for (const [, v] of docList) {
    for (const l of v.lines) {
      const u = accountUsage.get(l.code) || { debit: 0, credit: 0, count: 0, kol: l.code.slice(0, 3), taf: l.code.slice(6) };
      u.debit += l.debit;
      u.credit += l.credit;
      u.count++;
      accountUsage.set(l.code, u);
    }
  }
  return accountUsage;
}

/** taf6 → { receivable?: full12, payable?: full12, misc?: full12 } */
function mapPersonAccounts(accountUsage, tafBestFull) {
  const byTaf = new Map();
  for (const full of accountUsage.keys()) {
    const kol = full.slice(0, 3), taf = full.slice(6);
    if (!['203', '501', '204'].includes(kol)) continue;
    if (!byTaf.has(taf)) byTaf.set(taf, {});
    const slot = kol === '203' ? 'receivable' : kol === '501' ? 'payable' : 'misc';
    byTaf.get(taf)[slot] = full;
  }
  for (const [taf, full] of tafBestFull) {
    if (!byTaf.has(taf)) byTaf.set(taf, {});
    const o = byTaf.get(taf);
    const kol = full.slice(0, 3);
    if (kol === '203' && !o.receivable) o.receivable = full;
    if (kol === '501' && !o.payable) o.payable = full;
    if (kol === '204' && !o.misc) o.misc = full;
  }
  return byTaf;
}

module.exports = { fa, parsePersonName, guessProductCategory, buildAccountUsage, mapPersonAccounts };
