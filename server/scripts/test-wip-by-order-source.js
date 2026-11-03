'use strict';
/**
 * v_wip_by_order resolves each WIP document to its order through the owning source row
 * (lay / shared-cut batch / labor / receipt / align …), never through a bare ref_id.
 * Fixture ids are chosen so that ref_id collides with the other order's id.
 */
const { ok, eq, freshDb, summary } = require('./lib/test-harness');
const { acct } = require('../lib/coa-map');
const { postToLedger } = require('../lib/ledger');

console.log('\n══ v_wip_by_order source resolution ══\n');

const { db, cleanup } = freshDb();
const DATE = '1405/08/10';
const wip = acct(db, 'coa_wip').code;
const raw = acct(db, 'coa_raw_materials').code;

function je(refType, refId, wipRial) {
  const amt = Math.abs(wipRial) / 10;
  return postToLedger(db, {
    sourceType: refType,
    sourceId: refId,
    date: DATE,
    description: refType,
    createdBy: 1,
    lines: wipRial > 0
      ? [{ code: wip, name: wip, debit: amt, credit: 0 }, { code: raw, name: raw, debit: 0, credit: amt }]
      : [{ code: raw, name: raw, debit: amt, credit: 0 }, { code: wip, name: wip, debit: 0, credit: amt }],
  });
}

const cc = db.prepare("SELECT id FROM cost_centers WHERE code='CC-30'").get().id;
const whRaw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get().id;
const whFg = db.prepare("SELECT id FROM warehouses WHERE code='WH-FG'").get().id;
const pid = db.prepare(`
  INSERT INTO products (user_id, name, price, stock, item_type, is_manufactured)
  VALUES (1, 'WIP-SRC', 0, 0, 'finished', 1)
`).run().lastInsertRowid;
const newOrder = (no) => db.prepare(`
  INSERT INTO production_orders (order_no, product_id, analysis_type, qty_planned, date, period_label, status,
    warehouse_raw_id, warehouse_fg_id, cost_center_id)
  VALUES (?, ?, 'fixed', 10, ?, '1405/08', 'in_progress', ?, ?, ?)
`).run(no, pid, DATE, whRaw, whFg, cc).lastInsertRowid;
const A = Number(newOrder('PO-WSRC-A'));
const B = Number(newOrder('PO-WSRC-B'));

// Single lay of A whose id equals B: material issue + abnormal waste carry ref_id = lay id.
const j1 = je('production_material_issue', B, 1_000_000);
const j2 = je('production_waste', B, -100_000);
db.prepare(`INSERT INTO cutting_lays (id, lay_no, product_id, production_order_id, amount_rial, journal_id, waste_journal_id, status)
  VALUES (?, 'LAY-WSRC-1', ?, ?, 1000000, ?, ?, 'posted')`).run(B, pid, A, j1, j2);

// Shared-cut batch over a lay of A (300) and a lay of B (100): split by lay share.
const j3 = je('production_material_issue', 900, 400_000);
db.prepare(`INSERT INTO cutting_batches (id, batch_no, journal_id, status) VALUES (77, 'CB-WSRC', ?, 'posted')`).run(j3);
db.prepare(`INSERT INTO cutting_lays (id, lay_no, product_id, production_order_id, batch_id, amount_rial, journal_id, status)
  VALUES (900, 'LAY-WSRC-2', ?, ?, 77, 300000, ?, 'posted')`).run(pid, A, j3);
db.prepare(`INSERT INTO cutting_lays (id, lay_no, product_id, production_order_id, batch_id, amount_rial, journal_id, status)
  VALUES (901, 'LAY-WSRC-3', ?, ?, 77, 100000, ?, 'posted')`).run(pid, B, j3);

// Labor of B posted with ref_id = A.
const j4 = je('production_labor', A, 200_000);
db.prepare(`INSERT INTO production_labor_entries (order_id, cost_center_id, amount_rial, date, je_id)
  VALUES (?, ?, 200000, ?, ?)`).run(B, cc, DATE, j4);

// Receipt of A whose id equals B.
const j5 = je('production_receipt', B, -900_000);
db.prepare(`INSERT INTO production_receipts (id, order_id, product_id, qty, unit_cost_rial, amount_rial, warehouse_id, date, je_id)
  VALUES (?, ?, ?, 9, 100000, 900000, ?, ?, ?)`).run(B, A, pid, whFg, DATE, j5);

// Receipt-align of A (ref_id = order by design).
je('order_cost_receipt_align', A, -300_000);

// Orphan: production_* doc with ref_id = B but no owning row — must not land on B.
const j7 = je('production_overhead', B, 50_000);

// Voided labor of B — soft-deleted, ignored.
const j8 = je('production_labor', B, 70_000);
db.prepare(`INSERT INTO production_labor_entries (order_id, cost_center_id, amount_rial, date, je_id, status)
  VALUES (?, ?, 70000, ?, ?, 'reversed')`).run(B, cc, DATE, j8);
db.prepare("UPDATE journal_entries SET status='reversed', deleted_at=strftime('%s','now') WHERE id=?").run(j8);

// Closed-year counter voucher of B's labor inherits B.
const j9 = je('production_labor_reversal_cv', A, -200_000);
db.prepare('UPDATE journal_entries SET reverses_je_id=? WHERE id=?').run(j4, j9);
db.prepare('UPDATE journal_entries SET reversed_by_je_id=? WHERE id=?').run(j9, j4);

const wipOf = (id) => db.prepare('SELECT wip_rial FROM v_wip_by_order WHERE order_id=?').get(id).wip_rial;
eq('order A (lay + batch share + receipt + align) = 0', wipOf(A), 0);
eq('order B (batch share only; labor netted by counter voucher) = 100,000', wipOf(B), 100_000);

const gl = db.prepare(`
  SELECT COALESCE(SUM(jl.debit_rial - jl.credit_rial), 0) s
  FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
  WHERE jl.account_code = ? AND COALESCE(je.deleted_at,0) = 0 AND COALESCE(je.status,'approved') <> 'draft'
`).get(wip).s;
const sumOrders = db.prepare('SELECT SUM(wip_rial) s FROM v_wip_by_order').get().s;
eq('GL WIP = sum(orders) + orphan', gl, sumOrders + 50_000);

const weights = db.prepare('SELECT je_id, SUM(weight) w FROM v_wip_doc_order GROUP BY je_id').all();
ok('every mapped doc carries total weight 1', weights.every((r) => Math.abs(r.w - 1) < 1e-9),
  JSON.stringify(weights.filter((r) => Math.abs(r.w - 1) >= 1e-9)));
const multi = db.prepare('SELECT je_id FROM v_wip_doc_order GROUP BY je_id HAVING COUNT(DISTINCT order_id) > 1').all();
ok('only the shared-cut batch doc spans two orders', multi.length === 1 && multi[0].je_id === j3, JSON.stringify(multi));
ok('orphan ref_id doc is not attributed', !db.prepare('SELECT 1 FROM v_wip_doc_order WHERE je_id=?').get(j7));
ok('voided doc contributes nothing', db.prepare(`
  SELECT COUNT(*) c FROM v_wip_doc_order m JOIN journal_entries je ON je.id = m.je_id
  WHERE m.je_id = ? AND COALESCE(je.deleted_at,0) = 0`).get(j8).c === 0);
ok('counter voucher mapped to B', db.prepare('SELECT order_id FROM v_wip_doc_order WHERE je_id=?').get(j9)?.order_id === B);

cleanup();
summary('v_wip_by_order source resolution');
