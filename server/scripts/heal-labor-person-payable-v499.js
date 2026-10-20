'use strict';
/**
 * Heal ADR-005-era piece/hourly labor JEs that credited 5201 while person_id was set.
 * Default dry-run. Apply: node server/scripts/heal-labor-person-payable-v499.js --apply
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const dryRun = !process.argv.includes('--apply');
const { getDB } = require('../db');
const { healPieceLaborPersonPayable } = require('../lib/production/labor');

const db = getDB();
const result = healPieceLaborPersonPayable(db, { dryRun });
console.log(JSON.stringify(result, null, 2));
if (result.errors && result.errors.length) process.exitCode = 2;
else if (!dryRun) console.log('applied healPieceLaborPersonPayable');
else console.log('dry-run only — pass --apply to write');
