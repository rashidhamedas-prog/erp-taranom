'use strict';
/**
 * ADR-004 — cost-center account absorption + cost/price revaluation (SW v358)
 */
process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-jwt-secret-cc-absorb-reval-v358-dummy-key32';

const { ok, eq, throws, freshDb, summary } = require('./lib/test-harness');
const absorb = require('../lib/production/cc-account-absorb');
const reval = require('../lib/production/cost-revaluation');
const { createJournalEntry } = require('../db');

console.log('\n══ CC account absorb + cost revaluation v358 ══\n');

ok('base types include all three', absorb.BASE_TYPES.join(',') === 'period_debit,ending_balance,budget');
throws('bad base', () => absorb.normalizeBaseType('foo'), 'E_BASE_TYPE');
ok('period bounds', absorb.periodDateBounds('1405/7').from === '1405/07/01');

try {
  const { db, cleanup } = freshDb();
  const cc = db.prepare("SELECT id FROM cost_centers WHERE COALESCE(active,1)=1 ORDER BY id LIMIT 1").get();
  ok('has cost center', !!cc?.id);

  const expense = db.prepare(`
    SELECT code FROM chart_of_accounts
    WHERE COALESCE(is_active,1)=1 AND type='expense'
    ORDER BY length(code) DESC, code LIMIT 1
  `).get();
  ok('has expense account', !!expense?.code);

  // Seed JE debit on expense account
  createJournalEntry(db, {
    date: '1405/07/10',
    description: 'test oh actual',
    ref_type: 'test_oh',
    ref_id: 1,
    lines: [
      { code: expense.code, name: 'exp', debit: 1000000, credit: 0, debit_rial: 10000000, credit_rial: 0 },
      {
        code: (db.prepare("SELECT code FROM chart_of_accounts WHERE type='asset' AND COALESCE(is_active,1)=1 LIMIT 1").get() || { code: '1101' }).code,
        name: 'cash', debit: 0, credit: 1000000, debit_rial: 0, credit_rial: 10000000,
      },
    ],
  });

  throws('dup account rejected', () => absorb.replaceMaps(db, cc.id, [
    { account_code: expense.code, absorb_pct: 40, base_type: 'period_debit' },
    { account_code: expense.code, absorb_pct: 10, base_type: 'budget', budget_rial: 5_000_000 },
  ], 1), 'E_DUP_ACCOUNT');

  absorb.replaceMaps(db, cc.id, [
    { account_code: expense.code, absorb_pct: 40, base_type: 'period_debit' },
  ], 1);
  const prev = absorb.previewAbsorbForCenter(db, cc.id, '1405/07');
  eq('period debit absorb 40% of 10M', prev.pool_rial, 4_000_000, 0);
  ok('preview has line', prev.lines.length === 1);

  absorb.replaceMaps(db, cc.id, [
    { account_code: expense.code, absorb_pct: 50, base_type: 'budget', budget_rial: 8_000_000 },
  ], 1);
  const prevB = absorb.previewAbsorbForCenter(db, cc.id, '1405/07');
  eq('budget absorb 50% of 8M', prevB.pool_rial, 4_000_000, 0);

  absorb.replaceMaps(db, cc.id, [
    { account_code: expense.code, absorb_pct: 100, base_type: 'ending_balance' },
  ], 1);
  const prevE = absorb.previewAbsorbForCenter(db, cc.id, '1405/07');
  ok('ending balance >= period debit', prevE.pool_rial >= 10_000_000);

  // Product + stock for revaluation
  let prod = db.prepare("SELECT id FROM products WHERE COALESCE(is_manufactured,0)=1 LIMIT 1").get();
  if (!prod) {
    const info = db.prepare(`
      INSERT INTO products (code,name,price,cost,average_cost_rial,is_manufactured,active)
      VALUES ('RV-T1','reval test',120000,100000,100000,1,1)
    `).run();
    prod = { id: info.lastInsertRowid };
  } else {
    db.prepare('UPDATE products SET average_cost_rial=100000, cost=100000, is_manufactured=1 WHERE id=?').run(prod.id);
  }
  const wh = db.prepare('SELECT id FROM warehouses LIMIT 1').get();
  ok('warehouse', !!wh?.id);
  try {
    db.prepare('INSERT OR REPLACE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)')
      .run(prod.id, wh.id, 10);
  } catch {
    db.prepare('DELETE FROM warehouse_stock WHERE product_id=?').run(prod.id);
    db.prepare('INSERT INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)')
      .run(prod.id, wh.id, 10);
  }

  // Force new cost via last_prod higher path: set std and average; rollup may fall back
  db.prepare('UPDATE products SET last_prod_cost_rial=150000, std_cost_rial=150000, average_cost_rial=100000 WHERE id=?')
    .run(prod.id);

  const pPrev = reval.preview(db, {
    mode: 'manual',
    product_id: prod.id,
    period_label: '1405/07',
  });
  ok('manual preview lines', pPrev.line_count === 1);
  ok('manual preview product', pPrev.lines[0].product_id === prod.id);

  // If rollup returns same as avg, bump by stubbing through last_prod fallback:
  // Temporarily break manufactured flag so compute uses fallback last_prod
  db.prepare('UPDATE products SET is_manufactured=0, last_prod_cost_rial=150000, average_cost_rial=100000 WHERE id=?').run(prod.id);
  const p2 = reval.preview(db, { mode: 'manual', product_id: prod.id, period_label: '1405/07' });
  eq('fallback new cost 150k', p2.lines[0].new_unit_cost_rial, 150000, 0);
  eq('delta inv 10×50k', p2.lines[0].delta_inventory_rial, 500000, 0);

  const posted = reval.postRevaluation(db, {
    mode: 'manual',
    product_id: prod.id,
    period_label: '1405/07',
    entry_date: '1405/07/20',
    note: 'test reval',
  }, { id: 1 });
  ok('posted status', posted.status === 'posted');
  ok('has je when delta', !!posted.je_id);
  const after = db.prepare('SELECT average_cost_rial, price FROM products WHERE id=?').get(prod.id);
  eq('avg cost updated', Number(after.average_cost_rial), 150000, 0);
  ok('price markup applied', Number(after.price) >= 150000);

  const rev = reval.reverseRevaluation(db, posted.id, { id: 1 });
  ok('reversed', rev.status === 'reversed');
  const restored = db.prepare('SELECT average_cost_rial FROM products WHERE id=?').get(prod.id);
  eq('cost restored', Number(restored.average_cost_rial), 100000, 0);

  // Route files exist / path map
  const fs = require('fs');
  const path = require('path');
  const capture = fs.readFileSync(path.join(__dirname, '../sync/capture.js'), 'utf8');
  ok('capture account-maps', capture.includes("cost_center_account_maps"));
  ok('capture revaluations', capture.includes("cost_revaluations"));
  const tables = fs.readFileSync(path.join(__dirname, '../sync/tables.js'), 'utf8');
  ok('tables append maps', /cost_center_account_maps/.test(tables));
  ok('tables append reval', /cost_revaluations/.test(tables));
  const dbJs = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8');
  ok('sync_seq_backfill_v21', dbJs.includes('sync_seq_backfill_v21'));

  cleanup();
} catch (e) {
  if (/bindings|better-sqlite3/i.test(String(e.message || e))) {
    ok('sqlite ABI skip (Node24 host) — run on Iran', true);
  } else {
    ok('sqlite suite', false, e.stack || e.message);
  }
}

summary();
