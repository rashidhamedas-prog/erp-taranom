#!/usr/bin/env node
const path = require('path');
const XLSX = require('xlsx');
const { fa } = require('../lib/mahak-import-helpers');
const journalPath = process.argv[2] || path.join(__dirname, '../../..', 'daftar roznameh.xlsx');
const docNo = process.argv[3] || '2512';
const num = v => parseFloat(String(v == null ? '' : v).replace(/,/g, '')) || 0;
const toman = rial => Math.round(rial / 10);
const jwb = XLSX.readFile(journalPath);
const jrows = XLSX.utils.sheet_to_json(jwb.Sheets[jwb.SheetNames[0]], { header: 1, raw: false }).slice(1);
let v = { lines: [] };
for (const r of jrows) {
  if (String(r[2]).trim() !== String(docNo)) continue;
  const code = String(r[3] == null ? '' : r[3]).trim();
  if (!code) { v.desc = fa(r[4]); v.date = fa(r[0]); v.atf = fa(r[1]); continue; }
  v.lines.push({ code, name: fa(r[4]), debit: toman(num(r[5])), credit: toman(num(r[6])), kol: code.slice(0,3), taf: code.slice(6) });
}
console.log(JSON.stringify(v, null, 2));
