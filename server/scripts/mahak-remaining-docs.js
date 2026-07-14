#!/usr/bin/env node
/** List remaining mahak_import journals with classification. */
const path = require('path');
const { parseMahakJournal, classifyMahakVoucher } = require('../lib/mahak-import-helpers');

const journalPath = process.argv[2] || path.join(__dirname, '../../..', 'daftar roznameh.xlsx');
const dbPath = process.argv[3] || path.join(__dirname, '..', 'crm-test-mahak.db');
process.env.DB_PATH = path.resolve(dbPath);
const { initDB, getDB } = require('../db');
initDB();
const db = getDB();

const vouchers = parseMahakJournal(journalPath);
const remaining = db.prepare("SELECT src_doc_no, ref_type, description FROM journal_entries WHERE src_system='mahak' AND ref_type='mahak_import' ORDER BY entry_date, src_doc_no").all();

const byType = {};
for (const r of remaining) {
  const v = vouchers.get(String(r.src_doc_no));
  const type = v ? classifyMahakVoucher(r.src_doc_no, v) : 'missing';
  byType[type] = byType[type] || [];
  byType[type].push({ docNo: r.src_doc_no, desc: (v?.desc || r.description || '').slice(0, 60) });
}
console.log('Remaining mahak_import:', remaining.length);
for (const [t, list] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n${t}: ${list.length}`);
  list.slice(0, 8).forEach(x => console.log(`  ${x.docNo} ${x.desc}`));
}
