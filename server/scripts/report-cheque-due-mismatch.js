#!/usr/bin/env node
'use strict';
/**
 * Read-only report: cheque due mismatches (Phase 0).
 * Usage: node scripts/report-cheque-due-mismatch.js --db=/path/to/crm.db
 * Never writes to the DB.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const dbArg = args.find((a) => a.startsWith('--db='));
const dbPath = dbArg ? dbArg.slice(5) : '';
if (!dbPath) {
  console.error('Usage: node scripts/report-cheque-due-mismatch.js --db=/path/to.db');
  process.exit(2);
}
if (!fs.existsSync(dbPath)) {
  console.error('DB not found:', dbPath);
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const q1 = db.prepare(`
SELECT cr.id, cr.cheque_number, cr.sayadi, cr.receive_date, cr.due_date, cr.settlement_id, s.cheque_row, s.installment_group
FROM cheque_records cr LEFT JOIN settlements s ON s.id=cr.settlement_id
WHERE cr.record_status='posted' AND cr.direction='in' AND cr.due_date<=cr.receive_date
`).all();

const q2 = db.prepare(`
SELECT cr.id, cr.invoice_id, cr.cheque_number, cr.sayadi, cr.due_date AS register_due,
       json_extract(j.value,'$.cheque_due') AS invoice_due
FROM cheque_records cr
JOIN invoices i ON i.id=cr.invoice_id
JOIN json_each(i.pay_splits_json) j
  ON json_extract(j.value,'$.pay_type')='cheque'
 AND (TRIM(json_extract(j.value,'$.sayadi'))=TRIM(cr.sayadi) OR TRIM(json_extract(j.value,'$.cheque_number'))=TRIM(cr.cheque_number))
WHERE cr.record_status='posted' AND COALESCE(json_extract(j.value,'$.cheque_due'),'')<>'' AND json_extract(j.value,'$.cheque_due')<>cr.due_date
`).all();

const q3 = db.prepare(`
SELECT cr.id, cr.due_date, s.cheque_due FROM cheque_records cr JOIN settlements s ON s.id=cr.settlement_id
WHERE cr.record_status='posted' AND COALESCE(s.cheque_due,'')<>COALESCE(cr.due_date,'')
`).all();

function toCsv(rows) {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]);
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  return [keys.join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join('\n');
}

console.log('=== 1) due <= receive (posted in) ===');
console.log(q1.length ? q1 : '(none)');
console.log('=== 2) mismatch vs invoice pay_splits ===');
console.log(q2.length ? q2 : '(none)');
console.log('=== 3) settlement vs cheque_record due ===');
console.log(q3.length ? q3 : '(none)');

const outDir = path.join(process.cwd(), 'cheque-due-mismatch-report');
try {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'q1-due-le-receive.csv'), toCsv(q1) || 'id\n');
  fs.writeFileSync(path.join(outDir, 'q2-vs-pay-splits.csv'), toCsv(q2) || 'id\n');
  fs.writeFileSync(path.join(outDir, 'q3-settlement-mismatch.csv'), toCsv(q3) || 'id\n');
  console.log('CSV written under', outDir);
} catch (e) {
  console.warn('CSV write skipped:', e.message);
}

console.log(JSON.stringify({
  q1_ids: q1.map((r) => r.id),
  q2_ids: q2.map((r) => r.id),
  q3_ids: q3.map((r) => r.id),
}, null, 2));

db.close();
