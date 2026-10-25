'use strict';
/**
 * Audit 7B — read-only scan: parties / persons that would hit E_NO_PAYABLE_LEAF
 * when resolving a payable leaf (opening dest or consignment payable).
 *
 * Usage:
 *   node server/scripts/dry-run-misclassified-payable.js
 *   $env:DB_PATH="D:/path/to/copy.db"; node server/scripts/dry-run-misclassified-payable.js
 *
 * Never opens crm.db by default. If DB_PATH is missing/empty → skip exit 0.
 * Does NOT heal or write.
 */
const path = require('path');
const fs = require('fs');

const raw = process.env.DB_PATH || '';
if (!raw || !String(raw).trim()) {
  console.log('dry-run-misclassified-payable: DB_PATH empty — skip (no scan).');
  process.exit(0);
}
if (/^crm\.db$/i.test(path.basename(raw)) && !process.env.ALLOW_CRM_DB_SCAN) {
  console.error('Refusing default production crm.db. Set ALLOW_CRM_DB_SCAN=1 for an explicit read-only copy path.');
  process.exit(2);
}
const dbPath = path.resolve(raw);
if (!fs.existsSync(dbPath)) {
  console.log('dry-run-misclassified-payable: DB not found — skip:', dbPath);
  process.exit(0);
}

let Database;
try {
  Database = require('better-sqlite3');
} catch (_) {
  Database = require('node:sqlite').DatabaseSync;
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const { resolveOpeningDestAccount } = require('../lib/customer-books');
const { payableAcct } = require('../lib/consignments');

const hits = [];

function tableExists(name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch (_) {
    return false;
  }
}

if (tableExists('parties')) {
  const parties = db.prepare(`
    SELECT id, name, party_roles, party_type, coa_code, legacy_table
    FROM parties ORDER BY id
  `).all();
  for (const p of parties) {
    try {
      resolveOpeningDestAccount(db, p.id);
    } catch (e) {
      if (e && e.code === 'E_NO_PAYABLE_LEAF') {
        hits.push({
          kind: 'opening_dest',
          party_id: p.id,
          name: p.name,
          party_type: p.party_type,
          party_roles: p.party_roles,
          message: e.message,
        });
      }
    }
  }
}

if (tableExists('persons')) {
  const persons = db.prepare('SELECT id, name, coa_code, party_id FROM persons ORDER BY id').all();
  for (const person of persons) {
    try {
      payableAcct(db, person, { allocate: false });
    } catch (e) {
      if (e && e.code === 'E_NO_PAYABLE_LEAF') {
        hits.push({
          kind: 'consignment_payable',
          person_id: person.id,
          party_id: person.party_id,
          name: person.name,
          message: e.message,
        });
      }
    }
  }
}

try { db.close(); } catch (_) { /* ignore */ }

console.log(JSON.stringify({
  db: dbPath,
  count: hits.length,
  hits: hits.slice(0, 200),
  truncated: hits.length > 200,
}, null, 2));
process.exit(0);
