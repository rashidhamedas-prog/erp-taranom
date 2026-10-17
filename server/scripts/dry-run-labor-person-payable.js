'use strict';
/**
 * Read-only list of historical production_labor person_ledger credits.
 * Does not update or delete. Do not point this at Iran without a copy.
 */
const { getDB } = require('../db');
const { listPersonLaborConflicts } = require('../lib/production/shared-cut');

const db = getDB();
const rows = listPersonLaborConflicts(db);
console.log(JSON.stringify({
  count: rows.length,
  credit_rial: rows.reduce((s, r) => s + Math.round(Number(r.credit) || 0), 0),
  sample: rows.slice(0, 20),
}, null, 2));
