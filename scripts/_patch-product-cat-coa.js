'use strict';
const fs = require('fs');
const p = '/home/taranom/crm-taranom/server/db.js';
let s = fs.readFileSync(p, 'utf8');
if (s.includes("product_categories', 'coa_code'")) {
  console.log('DB_COA_ALREADY');
  process.exit(0);
}
const needle = "ensureColumn(db, 'product_categories', 'created_by', 'INTEGER');";
if (!s.includes(needle)) {
  console.log('DB_NEEDLE_MISSING');
  process.exit(2);
}
s = s.replace(needle, needle + "\n  ensureColumn(db, 'product_categories', 'coa_code', 'TEXT');");
fs.writeFileSync(p, s);
console.log('DB_COA_PATCHED');
