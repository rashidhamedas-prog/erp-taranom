/**
 * برچسب‌های نمایشی رنگ/سایز/کد — بدون تغییر دادهٔ کاتالوگ یا SKU ذخیره‌شده.
 *
 * نام سایز در master می‌تواند توضیح تناسب داشته باشد، مثل
 * «فری سایز (مناسب تا ۴۸)» یا «سایز 1 (مناسب از 38 تا 42)».
 * این توضیح برای picking/چاپ/لیست‌های عملیاتی لازم نیست؛
 * نگاشت سایت و هویت واریانت از نام کامل ذخیره‌شده استفاده می‌کنند.
 */
'use strict';

const { canonicalPrintCode } = require('./print-line-collapse');

/**
 * حذف پرانتز توضیح تناسب از انتهای (یا میانهٔ) نام سایز.
 * «فری سایز (مناسب تا 48)» → «فری سایز»
 * «سایز 1 (مناسب از 38 تا 42)» → «سایز 1»
 */
function stripSizeFitNote(name) {
  let s = String(name == null ? '' : name).trim();
  if (!s) return '';
  // پرانتز فارسی/لاتین با «مناسب از|تا …»
  s = s.replace(/\s*[\(（]\s*مناسب\s+(?:از|تا)[^\)）]*[\)）]/gu, '');
  // فاصلهٔ اضافه بعد از حذف
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

function displaySizeName(name) {
  return stripSizeFitNote(name);
}

/** رنگ + سایز تمیز برای زیرنویس/جدول */
function variantAttrsLabel(color, size, sep) {
  const c = String(color == null ? '' : color).trim();
  const z = displaySizeName(size);
  return [c, z].filter(Boolean).join(sep == null ? ' / ' : sep);
}

/**
 * کد نمایشی حواله/لیست: کد کاتالوگ، نه SKU ماتریس.
 * روی ردیف‌هایی که code = buildSku(...) مانده، پسوند رنگ/سایز جدا می‌شود.
 */
function displayProductCode(row) {
  return canonicalPrintCode(row || {});
}

module.exports = {
  stripSizeFitNote,
  displaySizeName,
  variantAttrsLabel,
  displayProductCode,
  canonicalPrintCode,
};
