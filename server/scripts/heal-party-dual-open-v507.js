'use strict';
/**
 * v507 heal: retire dual-role opening mirrors (same header amount on customer+supplier).
 * Default dry-run. Apply: node server/scripts/heal-party-dual-open-v507.js --apply
 * Optional: --party=136
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const apply = process.argv.includes('--apply');
let partyId = null;
for (const a of process.argv.slice(2)) {
  const m = /^--party=(\d+)$/.exec(a);
  if (m) partyId = Number(m[1]);
}

const { getDB } = require('../db');
const { retireDuplicateRoleOpeningMirrors } = require('../lib/opening-post');

const db = getDB();
const out = retireDuplicateRoleOpeningMirrors(db, { apply, partyId });
console.log(JSON.stringify({ apply, partyId, ...out }, null, 2));
process.exit(0);
