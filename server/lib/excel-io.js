'use strict';
/**
 * Shared Excel I/O via exceljs (async). SheetJS-shaped helpers for routes.
 */
const ExcelJS = require('exceljs');

function cellValue(raw) {
  if (raw == null || raw === '') return '';
  if (raw instanceof Date) return raw;
  if (typeof raw !== 'object') return raw;
  if (raw.text != null) return raw.text;
  if (raw.result != null) return raw.result;
  if (raw.richText) return raw.richText.map((p) => p.text || '').join('');
  if (raw.formula != null || raw.sharedFormula != null) return raw.result != null ? raw.result : '';
  if (raw.hyperlink && raw.text != null) return raw.text;
  return '';
}

function sheetToJson(worksheet, opts = {}) {
  if (!worksheet) return [];
  const defval = opts.defval !== undefined ? opts.defval : '';
  const values = worksheet.getSheetValues ? worksheet.getSheetValues() : [];
  const rows = [];
  for (let r = 1; r < values.length; r += 1) {
    if (values[r]) rows.push(values[r]);
  }
  if (!rows.length) return [];

  if (opts.header === 1) {
    return rows.map((row) => {
      const out = [];
      const max = Math.max(0, ...Object.keys(row).map(Number).filter(Number.isFinite));
      for (let c = 1; c <= max; c += 1) out.push(cellValue(row[c] != null ? row[c] : defval));
      while (out.length && (out[out.length - 1] === '' || out[out.length - 1] == null)) out.pop();
      return out;
    });
  }

  const headerRow = rows[0] || [];
  const headers = [];
  const maxH = Math.max(0, ...Object.keys(headerRow).map(Number).filter(Number.isFinite));
  for (let c = 1; c <= maxH; c += 1) {
    const h = cellValue(headerRow[c]);
    headers.push(h === '' || h == null ? `COL${c}` : String(h));
  }
  const out = [];
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i] || [];
    const obj = {};
    let empty = true;
    headers.forEach((h, idx) => {
      const v = cellValue(row[idx + 1] != null ? row[idx + 1] : defval);
      obj[h] = v;
      if (v !== '' && v != null) empty = false;
    });
    if (!empty || opts.blankrows) out.push(obj);
  }
  return out;
}

function estimateCells(wb) {
  let cells = 0;
  for (const ws of wb.worksheets) {
    const rowCount = ws.rowCount || 0;
    const colCount = ws.columnCount || 0;
    cells += Math.max(rowCount, 1) * Math.max(colCount, 1);
  }
  return cells;
}

async function readWorkbookAsync(input) {
  const wb = new ExcelJS.Workbook();
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    await wb.xlsx.load(Buffer.from(input));
  } else if (typeof input === 'string') {
    await wb.xlsx.readFile(input);
  } else {
    throw new Error('فایل اکسل نامعتبر است');
  }
  const SheetNames = wb.worksheets.map((ws) => ws.name);
  const Sheets = {};
  for (const ws of wb.worksheets) Sheets[ws.name] = ws;
  return { _wb: wb, SheetNames, Sheets, _cellEstimate: estimateCells(wb) };
}

function book_new() {
  return { SheetNames: [], Sheets: {}, _pending: [] };
}

function json_to_sheet(rows) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  return { __exceljs_rows: list, __kind: 'json', '!cols': undefined };
}

function aoa_to_sheet(aoa) {
  return { __exceljs_rows: Array.isArray(aoa) ? aoa.slice() : [], __kind: 'aoa' };
}

function book_append_sheet(book, sheet, name) {
  const title = String(name || 'Sheet1').slice(0, 31) || 'Sheet1';
  book._pending = book._pending || [];
  book._pending.push({ name: title, sheet });
  book.SheetNames.push(title);
  book.Sheets[title] = sheet;
}

async function writeWorkbook(book) {
  const wb = new ExcelJS.Workbook();
  const pending = book._pending || [];
  for (const item of pending) {
    const ws = wb.addWorksheet(item.name);
    const payload = item.sheet || {};
    if (payload.__kind === 'aoa') {
      (payload.__exceljs_rows || []).forEach((row, rIdx) => {
        ws.addRow(Array.isArray(row) ? row : []);
        if (rIdx === 0) ws.getRow(1).font = { bold: true };
      });
    } else {
      const rows = payload.__exceljs_rows || [];
      if (!rows.length) {
        ws.addRow([]);
      } else {
        const keys = Object.keys(rows[0] || {});
        ws.columns = keys.map((k) => ({
          header: k,
          key: k,
          width: Math.max(12, Math.min(35, String(k).length + 6)),
        }));
        rows.forEach((row) => ws.addRow(row));
        ws.getRow(1).font = { bold: true };
      }
    }
    if (Array.isArray(payload['!cols'])) {
      payload['!cols'].forEach((col, i) => {
        if (col && col.wch) {
          try { ws.getColumn(i + 1).width = col.wch; } catch { /* */ }
        }
      });
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const utils = {
  sheet_to_json: sheetToJson,
  book_new,
  json_to_sheet,
  aoa_to_sheet,
  book_append_sheet,
};

module.exports = {
  ExcelJS,
  utils,
  readWorkbookAsync,
  writeWorkbook,
  readFile: readWorkbookAsync,
  sheetToJson,
  book_new,
  json_to_sheet,
  aoa_to_sheet,
  book_append_sheet,
};
