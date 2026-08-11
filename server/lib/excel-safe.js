'use strict';
/**
 * Hardened Excel access via exceljs (Wave 0 — replaces vulnerable `xlsx`).
 * Every read goes through size/sheet/cell caps.
 */
const {
  utils,
  readWorkbookAsync,
  writeWorkbook,
  book_new,
  json_to_sheet,
  aoa_to_sheet,
  book_append_sheet,
} = require('./excel-io');

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

async function readWorkbook(buf, _opts = {}) {
  assertBuffer(buf);
  const wb = await readWorkbookAsync(buf);
  const names = wb.SheetNames || [];
  if (names.length > MAX_SHEETS) {
    throw new Error(`تعداد شیت‌های اکسل بیش از حد مجاز است (${MAX_SHEETS})`);
  }
  if ((wb._cellEstimate || 0) > MAX_CELLS) {
    throw new Error(`حجم سلول‌های اکسل بیش از حد مجاز است (${MAX_CELLS})`);
  }
  return wb;
}

function sheetToJson(sheet, opts) {
  return utils.sheet_to_json(sheet, opts);
}

/** Compatibility object shaped like former SheetJS export. */
const XLSX = {
  utils: {
    ...utils,
    book_new,
    json_to_sheet,
    aoa_to_sheet,
    book_append_sheet,
    sheet_to_json: sheetToJson,
  },
  write: writeWorkbook,
  read: readWorkbook,
};

module.exports = {
  XLSX,
  readWorkbook,
  sheetToJson,
  writeWorkbook,
  utils: XLSX.utils,
  write: writeWorkbook,
  MAX_BYTES,
  MAX_SHEETS,
  MAX_CELLS,
};
