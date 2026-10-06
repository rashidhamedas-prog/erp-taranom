/**
 * جمع‌کردن نمایشی ردیف‌های چاپ فاکتور (فروش و خرید).
 * دادهٔ ذخیره‌شده عوض نمی‌شود — فقط برای HTML چاپ.
 *
 * هویت چاپی کالا = کد کاتالوگ (+ نام استایل تمیز در صورت وجود).
 * SKU ماتریس (کد-رنگ-سایز) فقط هویت انبار/سایت است و در ستون کد فاکتور نمی‌آید.
 * رنگ / سایز / برچسب واریانت، از جمله «فری سایز (مناسب تا …)»، روی فاکتور چاپ نمی‌شود.
 */
'use strict';

function lineGross(r) {
  return Math.round((Number(r.qty) || 0) * (Number(r.price) || 0));
}

function lineDiscOf(r) {
  const amt = Math.max(0, Math.round(Number(r.disc_amount) || 0));
  if (amt > 0) return amt;
  return Math.round((Number(r.qty) || 0) * (Number(r.price) || 0) * (Number(r.disc) || 0) / 100);
}

function lineNet(r) {
  const sum = Math.round(Number(r.sum) || 0);
  if (sum > 0) return sum;
  return Math.max(0, lineGross(r) - lineDiscOf(r));
}

function canCollapse(r) {
  if (!r) return false;
  if (r.row_type === 'income') return false;
  if (r.batch_id) return false;
  if (r.is_fabric_roll) return false;
  if (!r.variant_id) return false;
  return true;
}

function groupKey(r) {
  return [r.product_id, r.price, r.warehouse_id || 0, r.disc || 0, r.disc_amount || 0, r.unit || 'عدد'].join('|');
}

function qtyFa(q) {
  const n = Number(q);
  if (Number.isFinite(n)) return n.toLocaleString('fa-IR');
  return String(q == null ? '' : q);
}

function skuBit(r) {
  const color = String(r.color_name || r.color || '').trim();
  const size = String(r.size_name || '').trim();
  const label = [color, size].filter(Boolean).join(' ');
  const q = qtyFa(r.qty);
  if (!label) return q ? '×' + q : '';
  return label + '×' + q;
}

function compactSummary(members) {
  const colors = [];
  const sizeMap = {};
  for (const r of members || []) {
    const c = String(r.color_name || r.color || '').trim();
    const s = String(r.size_name || '').trim();
    const q = Number(r.qty) || 0;
    if (c && colors.indexOf(c) < 0) colors.push(c);
    if (s) sizeMap[s] = (sizeMap[s] || 0) + q;
  }
  const sizePart = Object.keys(sizeMap).map((s) => s + '×' + qtyFa(sizeMap[s])).join(' ');
  const compact = [colors.join('، '), sizePart].filter(Boolean).join(' · ');
  if (compact) return compact;
  return members.map(skuBit).filter(Boolean).join('، ');
}

function uniqueNotes(members) {
  const seen = new Set();
  const notes = [];
  for (const r of members) {
    const d = String(r.description || '').trim();
    if (!d || seen.has(d)) continue;
    seen.add(d);
    notes.push(d);
  }
  return notes;
}

function sharedDisc(members) {
  const first = Number(members[0].disc) || 0;
  for (let i = 1; i < members.length; i++) {
    if ((Number(members[i].disc) || 0) !== first) return 0;
  }
  return first;
}

/** خلاصهٔ رنگ/سایز تولیدشده توسط سیستم — در چاپ نباید بیاید */
function looksLikeVariantSummary(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  // مثل «مشکی، سفید · L×۲ XL×۱» یا «مشکی L×۲»
  if (/[·•]/.test(s) && /×/.test(s)) return true;
  if (/×\s*[\d۰-۹]+/.test(s) && s.length < 80) return true;
  return false;
}

/**
 * برچسب واریانت به‌صورت نام کالا — مثل «سفید-سایز 1 (مناسب از 38 تا 42)»
 * یا تطبیق با color_name/size_name ردیف.
 */
function looksLikeVariantLabel(text, row) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (looksLikeVariantSummary(s)) return true;
  // «…-سایز N» یا «سایز N (مناسب از …)»
  if (/[-–]\s*سایز\s*[\d۰-۹A-Za-zآ-ی]+/u.test(s)) return true;
  if (/^سایز\s*[\d۰-۹A-Za-zآ-ی]+/u.test(s)) return true;
  if (/سایز\s*[\d۰-۹]+\s*\(/u.test(s)) return true;
  if (/مناسب\s+(?:از|تا)\s*[\d۰-۹]+/u.test(s) && /سایز/u.test(s)) return true;
  if (/^[\u0600-\u06FF0-9۰-۹]+[-–]فری[\s\u200c]*سایز\s*\(/u.test(s)) return true;

  const c = String((row && (row.color_name || row.color)) || '').trim();
  const sz = String((row && row.size_name) || '').trim();
  if (c && sz) {
    const norms = [
      `${c}-${sz}`, `${c}–${sz}`, `${c} ${sz}`, `${c}/${sz}`,
      `${c} · ${sz}`, `${c}·${sz}`, `${c} - ${sz}`,
    ];
    if (norms.some((n) => s === n || s.endsWith(n) || s.endsWith(`-${n}`))) return true;
  } else if (c && (s === c || s.endsWith(`-${c}`) || s.startsWith(`${c}-`))) {
    if (/سایز/u.test(s)) return true;
  }
  return false;
}

/**
 * نام چاپی تمیز: کد کالا در ستون جدا می‌ماند؛ رنگ/سایز از name حذف می‌شود.
 * اگر کل name فقط برچسب واریانت باشد → رشتهٔ خالی (هویت = کد).
 */
function sanitizePrintName(name, row) {
  let s = String(name || '').trim();
  if (!s) return '';
  if (looksLikeVariantLabel(s, row)) {
    return '';
  }
  const c = String((row && (row.color_name || row.color)) || '').trim();
  const sz = String((row && row.size_name) || '').trim();
  if (c && sz) {
    const suffixes = [
      `-${c}-${sz}`, `–${c}–${sz}`, ` ${c}-${sz}`, `-${c} ${sz}`,
      ` · ${c} · ${sz}`, ` · ${c}-${sz}`, `/${c}/${sz}`,
    ];
    for (const suf of suffixes) {
      if (s.endsWith(suf)) {
        s = s.slice(0, -suf.length).trim();
        break;
      }
    }
  }
  // پسوند عمومی: -رنگ-سایز N (توضیح)
  s = s.replace(/[-–]\s*\S+-سایز\s*[\d۰-۹A-Za-zآ-ی]+(?:\s*\([^)]*\))?$/u, '').trim();
  s = s.replace(/\s*سایز\s*[\d۰-۹]+\s*\([^)]*مناسب[^)]*\)\s*$/u, '').trim();
  s = s.replace(/[-–][^-–]{1,40}[-–]فری[\s\u200c]*سایز\s*\([^)]*مناسب[^)]*\)\s*$/u, '').trim();
  if (looksLikeVariantLabel(s, row)) return '';
  return s;
}

/** پسوند رنگ/سایز چسبیده به کد، مثل «-مشگی-فری سایز (مناسب تا ۴۸)». */
function isVariantTail(tail) {
  const t = String(tail || '').trim();
  if (!t || t.length > 120) return false;
  if (/مناسب/u.test(t)) return true;
  if (/سایز/u.test(t)) return true;
  return looksLikeVariantLabel(t, null);
}

function stripKnownColorSize(code, color, size) {
  const s = String(code || '').trim();
  const c = String(color || '').trim();
  const z = String(size || '').trim();
  if (!s || !c || !z) return s;
  const suffixes = [`-${c}-${z}`, `–${c}–${z}`, `-${c}–${z}`, `–${c}-${z}`];
  for (const suf of suffixes) {
    if (s.endsWith(suf) && s.length > suf.length) return s.slice(0, -suf.length).trim();
  }
  return s;
}

/**
 * کد چاپی = کد کاتالوگ.
 * buildSku رشتهٔ style-color-size می‌سازد؛ اگر نام سایز «فری سایز (مناسب تا ۴۸)» باشد
 * همان متن وارد ستون کد می‌شود. اینجا فقط پیشوند کد کالا می‌ماند.
 */
function peelStyleCode(code) {
  const s = String(code || '').trim();
  if (!s) return '';
  const m = s.match(/^([A-Za-z]{1,8}-\d{2,8}|\d{3,8})[-–](.+)$/);
  if (!m) return s;
  if (isVariantTail(m[2])) return m[1];
  return s;
}

function canonicalPrintCode(row) {
  const color = String((row && (row.color_name || row.color)) || '').trim();
  const size = String((row && row.size_name) || '').trim();
  const explicit = peelStyleCode(stripKnownColorSize(String((row && row.product_code) || '').trim(), color, size));
  const raw = peelStyleCode(stripKnownColorSize(
    String((row && (row.code || row.sku || row.barcode)) || '').trim(),
    color,
    size
  ));
  if (explicit) return explicit;
  return raw;
}

function sanitizePrintDescription(desc, row) {
  const s = String(desc || '').trim();
  if (!s) return '';
  if (looksLikeVariantLabel(s, row)) return '';
  return s;
}

/** یک ردیف آمادهٔ چاپ: بدون رنگ/سایز در نام و شرح */
function sanitizePrintLine(r) {
  if (!r || r.row_type === 'income') return r;
  const code = canonicalPrintCode(r);
  const name = sanitizePrintName(r.name, r);
  const description = sanitizePrintDescription(r.description, r);
  return Object.assign({}, r, {
    name,
    description,
    code,
    sku: code,
    color_name: '',
    size_name: '',
    color: '',
  });
}

function mergeGroup(members) {
  const first = members[0];
  const qty = members.reduce((a, r) => a + (Number(r.qty) || 0), 0);
  const sum = members.reduce((a, r) => a + lineNet(r), 0);
  const discAmount = members.reduce((a, r) => a + lineDiscOf(r), 0);
  // چاپ فشرده: رنگ×سایز روی فاکتور چاپ نمی‌شود (فقط نام تمیز + کد + تعداد جمع‌شده).
  const notes = uniqueNotes(members).filter((n) => !looksLikeVariantLabel(n, first));
  const description = notes.length ? notes.join('، ') : '';
  const productCode = first.code || first.sku || first.barcode || '';
  return sanitizePrintLine(Object.assign({}, first, {
    name: first.name || '',
    qty,
    price: first.price,
    sum,
    disc_amount: discAmount,
    disc: sharedDisc(members),
    unit: first.unit || 'عدد',
    code: productCode,
    sku: productCode,
    description,
    color_name: first.color_name || '',
    size_name: first.size_name || '',
    color: first.color || '',
  }));
}

function truncateDesc(desc, max) {
  const s = String(desc || '');
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function collapsePrintRows(rows, opts) {
  const list = Array.isArray(rows) ? rows : [];
  const thermal = !!(opts && opts.thermal);
  const out = [];
  const seen = new Array(list.length).fill(false);

  for (let i = 0; i < list.length; i++) {
    if (seen[i]) continue;
    const r = list[i];
    if (!canCollapse(r)) {
      seen[i] = true;
      out.push(sanitizePrintLine(r));
      continue;
    }
    const key = groupKey(r);
    const members = [r];
    seen[i] = true;
    for (let j = i + 1; j < list.length; j++) {
      if (seen[j]) continue;
      const o = list[j];
      if (!canCollapse(o) || groupKey(o) !== key) continue;
      members.push(o);
      seen[j] = true;
    }
    out.push(mergeGroup(members));
  }

  if (!thermal) return out;
  return out.map((r) => {
    const d = String(r.description || '');
    if (d.length <= 70) return r;
    return Object.assign({}, r, { description: truncateDesc(d, 70) });
  });
}

module.exports = {
  collapsePrintRows,
  lineNet,
  lineDiscOf,
  looksLikeVariantSummary,
  looksLikeVariantLabel,
  sanitizePrintName,
  sanitizePrintDescription,
  sanitizePrintLine,
  canonicalPrintCode,
  compactSummary,
};
