'use strict';
/**
 * Hardened SheetJS (xlsx) access — Wave 0 dependency waiver mitigation.
 * Full library replace (exceljs) is deferred; until then every read goes through
 * size/sheet/cell caps so prototype-pollution / ReDoS inputs are harder to land.
 */
const XLSX = require('xlsx');

const MAX_BYTES = Math.min(
  parseInt(process.env.EXCEL_MAX_BYTES || '', 10) || 15 * 1024 * 1024,
  20 * 1024 * 1024
);
const MAX_SHEETS = Math.min(parseInt(process.env.EXCEL_MAX_SHEETS || '', 10) || 32, 64);
const MAX_CELLS = Math.min(parseInt(process.env.EXCEL_MAX_CELLS || '', 10) || 250000, 500000);

function assertBuffer(buf) {
  if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) {
    throw new Error('فایل اکسل نامعتبر است');
  }
  if (buf.length <= 0) throw new Error('فایل اکسل خالی است');
  if (buf.length > MAX_BYTES) throw new Error(`حجم فایل اکسل بیش از حد مجاز است (${MAX_BYTES} بایت)`);
}

function readWorkbook(buf, opts = {}) {
  assertBuffer(buf);
  const wb = XLSX.read(buf, {
    type: 'buffer',
    cellDates: true,
    dense: false,
    ...opts,
  });
  const names = wb.SheetNames || [];
  if (names.length > MAX_SHEETS) {
    throw new Error(`تعداد شیت‌های اکسل بیش از حد مجاز است (${MAX_SHEETS})`);
  }
  let cells = 0;
  for (const name of names) {
    const sheet = wb.Sheets[name];
    if (!sheet || !sheet['!ref']) continue;
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const count = (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1);
    cells += count;
    if (cells > MAX_CELLS) {
      throw new Error(`حجم سلول‌های اکسل بیش از حد مجاز است (${MAX_CELLS})`);
    }
  }
  return wb;
}

function sheetToJson(sheet, opts) {
  return XLSX.utils.sheet_to_json(sheet, opts);
}

module.exports = {
  XLSX,
  readWorkbook,
  sheetToJson,
  utils: XLSX.utils,
  write: (...args) => XLSX.write(...args),
  MAX_BYTES,
  MAX_SHEETS,
  MAX_CELLS,
};
