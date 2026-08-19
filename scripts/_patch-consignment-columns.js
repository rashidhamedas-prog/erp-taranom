'use strict';
const fs = require('fs');
const p = '/home/taranom/crm-taranom/server/db.js';
let s = fs.readFileSync(p, 'utf8');
if (s.includes("ensureColumn(db, 'consignments', 'settle_je_id'")) {
  console.log('DB_CON_ALREADY');
  process.exit(0);
}
const block = `
  // CON-01/CON-02 — person FK, warehouse, settle metadata (no new table)
  ensureColumn(db, 'consignments', 'person_id', 'INTEGER');
  ensureColumn(db, 'consignments', 'warehouse_id', 'INTEGER');
  ensureColumn(db, 'consignments', 'invoice_id', 'INTEGER');
  ensureColumn(db, 'consignments', 'settle_path', 'TEXT');
  ensureColumn(db, 'consignments', 'settle_je_id', 'INTEGER');
  ensureColumn(db, 'consignments', 'issue_ledger_id', 'INTEGER');
  ensureColumn(db, 'consignments', 'record_status', "TEXT DEFAULT 'active'");
  ensureColumn(db, 'consignments', 'unit_price_rial', 'INTEGER DEFAULT 0');
`;
const needles = [
  "  // One-shot: restore products.stock wiped by image-only PUT bug (stock→0 while warehouse_stock kept qty).",
  "  // One-shot: restore products.stock wiped by image-only PUT bug",
  "ensureColumn(db, 'product_categories', 'created_by', 'INTEGER');",
  "ensureColumn(db, 'users', 'person_id', 'INTEGER');",
];
for (const needle of needles) {
  if (!s.includes(needle)) continue;
  if (needle.startsWith('ensureColumn')) {
    s = s.replace(needle, needle + '\n' + block);
  } else {
    s = s.replace(needle, block + '\n' + needle);
  }
  fs.writeFileSync(p, s);
  console.log('DB_CON_PATCHED');
  process.exit(0);
}
console.log('DB_CON_NEEDLE_MISSING');
process.exit(2);
