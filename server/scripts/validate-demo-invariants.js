#!/usr/bin/env node
'use strict';
/**
 * Read-only demo invariant checks (no server).
 *
 *   node server/scripts/validate-demo-invariants.js <absolute-db-path>
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const PERSIAN_LETTER = /[\u0600-\u06FF]/;

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function columns(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  } catch {
    return new Set();
  }
}

function validateDemoInvariants(dbPath) {
  const failures = [];
  const abs = path.resolve(String(dbPath || ''));
  if (!abs || !fs.existsSync(abs)) {
    return { ok: false, failures: [`database not found: ${abs}`], errors: [`database not found: ${abs}`] };
  }

  const db = new Database(abs, { readonly: true, fileMustExist: true });
  try {
    if (tableExists(db, 'journal_lines')) {
      const n = db.prepare('SELECT COUNT(*) c FROM journal_lines').get().c;
      if (n > 0) {
        const sums = db.prepare(
          'SELECT COALESCE(SUM(debit_rial),0) d, COALESCE(SUM(credit_rial),0) c FROM journal_lines'
        ).get();
        const delta = Math.abs(Number(sums.d) - Number(sums.c));
        if (delta > 1) {
          failures.push(`trial balance mismatch: debit_rial=${sums.d} credit_rial=${sums.c} delta=${delta}`);
        }
      }
    }

    if (tableExists(db, 'warehouse_stock')) {
      const allowCol = tableExists(db, 'warehouses') && columns(db, 'warehouses').has('allow_negative');
      const neg = allowCol
        ? db.prepare(`
            SELECT COUNT(*) c FROM warehouse_stock ws
            LEFT JOIN warehouses w ON w.id = ws.warehouse_id
            WHERE ws.qty < 0 AND COALESCE(w.allow_negative, 0) = 0
          `).get().c
        : db.prepare('SELECT COUNT(*) c FROM warehouse_stock WHERE qty < 0').get().c;
      if (neg > 0) failures.push('negative warehouse_stock qty without allow_negative');
    }

    if (tableExists(db, 'users') && tableExists(db, 'parties') && columns(db, 'users').has('party_id')) {
      const orphans = db.prepare(`
        SELECT COUNT(*) c FROM users u
        LEFT JOIN parties p ON p.id = u.party_id
        WHERE u.party_id IS NOT NULL AND p.id IS NULL
      `).get().c;
      if (orphans > 0) failures.push('orphan users.party_id');

      const dups = db.prepare(`
        SELECT party_id, COUNT(*) c
        FROM users
        WHERE party_id IS NOT NULL AND COALESCE(active, 1) = 1
        GROUP BY party_id
        HAVING c > 1
      `).all();
      if (dups.length) failures.push('duplicate active users.party_id');
    }

    if (tableExists(db, 'invoices')) {
      const types = new Set(
        db.prepare('SELECT DISTINCT type FROM invoices').all().map((r) => String(r.type || ''))
      );
      for (const t of ['proforma', 'normal', 'final']) {
        if (!types.has(t)) failures.push(`missing invoice type: ${t}`);
      }
      const invCols = columns(db, 'invoices');
      let voided = 0;
      if (invCols.has('status')) {
        voided += db.prepare(
          `SELECT COUNT(*) c FROM invoices WHERE lower(COALESCE(status,'')) IN ('reversed','cancelled','canceled','void','voided')`
        ).get().c;
      }
      if (invCols.has('deleted_at')) {
        voided += db.prepare('SELECT COUNT(*) c FROM invoices WHERE COALESCE(deleted_at,0) <> 0').get().c;
      }
      if (voided < 1) {
        failures.push('no void/cancelled invoice row remains (physical delete suspected or void missing)');
      }
    } else {
      failures.push('invoices table missing');
    }

    if (tableExists(db, 'customers')) {
      const persian = db.prepare("SELECT biz FROM customers WHERE biz IS NOT NULL AND biz <> ''").all()
        .some((r) => PERSIAN_LETTER.test(String(r.biz || '')));
      if (!persian) failures.push('no customer.biz with a Persian letter');
    } else {
      failures.push('customers table missing');
    }
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }

  return { ok: failures.length === 0, failures, errors: failures };
}

function main() {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error('usage: node server/scripts/validate-demo-invariants.js <absolute-db-path>');
    process.exit(2);
  }
  if (!path.isAbsolute(dbPath)) {
    console.error('database path must be absolute');
    process.exit(2);
  }
  const result = validateDemoInvariants(dbPath);
  if (!result.ok) {
    console.error('demo invariants failed:');
    for (const e of result.failures) console.error('  -', e);
    process.exit(1);
  }
  console.log('demo invariants ok');
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('validate-demo-invariants:', e.message || e);
    process.exit(1);
  }
}

module.exports = { validateDemoInvariants };
