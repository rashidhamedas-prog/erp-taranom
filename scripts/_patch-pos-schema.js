'use strict';
const fs = require('fs');
const p = '/home/taranom/crm-taranom/server/db.js';
let s = fs.readFileSync(p, 'utf8');
if (s.includes("require('./lib/pos').initPosSchema")) {
  console.log('DB_POS_ALREADY');
  process.exit(0);
}
const call = `
  // POS-01/02 — card terminals / receipts / settlement batches
  try {
    require('./lib/pos').initPosSchema(db, ensureColumn);
  } catch (e) {
    console.error('❌ pos schema init failed:', e.message);
    throw e;
  }
`;
const needles = [
  "  ensureColumn(db, 'consignments', 'unit_price_rial', 'INTEGER DEFAULT 0');",
  "  // CON-01/CON-02 — person FK, warehouse, settle metadata (no new table)",
  "  // One-shot: restore products.stock wiped by image-only PUT bug (stock→0 while warehouse_stock kept qty).",
  "ensureColumn(db, 'users', 'person_id', 'INTEGER');",
];
for (const needle of needles) {
  if (!s.includes(needle)) continue;
  if (needle.startsWith('ensureColumn') || needle.includes("unit_price_rial")) {
    s = s.replace(needle, needle + '\n' + call);
  } else {
    s = s.replace(needle, call + '\n' + needle);
  }
  fs.writeFileSync(p, s);
  console.log('DB_POS_PATCHED');
  process.exit(0);
}
console.log('DB_POS_NEEDLE_MISSING');
process.exit(2);
