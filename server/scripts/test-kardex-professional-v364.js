'use strict';
/**
 * Kardex professional v364 — amend ghosts retired; buildStockLedger hides zero rows.
 * Run: node server/scripts/test-kardex-professional-v364.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK', label); }
  else { fail += 1; console.log(' FAIL', label, extra == null ? '' : extra); }
}

console.log('\n══ Kardex professional v364 ══\n');

const amendSrc = fs.readFileSync(path.join(__dirname, '../lib/amend-invoice.js'), 'utf8');
ok(amendSrc.includes('retireAmendedMovement'), 'amend has retireAmendedMovement');
ok(amendSrc.includes("status='reversed'"), 'amend soft-retires with status=reversed');
ok(!/UPDATE inventory_ledger SET qty_out=0, amount_rial=0/.test(amendSrc),
  'amend no longer zeros qty in place as primary path');

const ledgersSrc = fs.readFileSync(path.join(__dirname, '../lib/ledgers.js'), 'utf8');
ok(ledgersSrc.includes('show_cancelled'), 'buildStockLedger supports show_cancelled');
ok(ledgersSrc.includes('isZeroQtyValueGhost') || ledgersSrc.includes('isStockLedgerGhost'),
  'buildStockLedger filters ghosts');

const invSrc = fs.readFileSync(path.join(__dirname, '../lib/inventory/ledger.js'), 'utf8');
ok(invSrc.includes('retireZeroQtyLedgerGhosts'), 'heal retireZeroQtyLedgerGhosts');
ok(invSrc.includes('softRetireLedgerRow'), 'softRetireLedgerRow exported');

const salesSrc = fs.readFileSync(path.join(__dirname, '../lib/sales-document.js'), 'utf8');
ok(salesSrc.includes('isZeroQtyValueGhost'), 'void path skips zero ghosts');

const appSrc = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
ok(appSrc.includes('kardexShowCanc') && appSrc.includes('_kardexOpenSource'),
  'UI has history toggle + drill');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kardex-v364-'));
const testDb = path.join(dir, 't.db');
process.env.DB_PATH = testDb;
process.env.SYNC_ROLE = 'central';
process.env.SMS_DISABLED = '1';
process.env.ERP_TEST_ISOLATION = '1';
process.env.JWT_SECRET = 'kardex-v364-secret-32chars!!!!!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
process.env.NODE_ENV = 'test';

let db = null;
try {
  delete require.cache[require.resolve('../db')];
  const { initDB, getDB } = require('../db');
  initDB();
  db = getDB();
} catch (e) {
  const abi = /NODE_MODULE_VERSION|better-sqlite3/.test(String(e.message || e));
  if (abi) {
    console.log('  SKIP sqlite:', String(e.message || e).split('\n')[0]);
    console.log(`\n${fail ? '💥' : '🎉'} ${pass} passed, ${fail} failed (sqlite skipped)`);
    process.exitCode = fail ? 1 : 0;
    return;
  }
  ok(false, 'initDB', e.message);
}

(function run() {
  if (!db) return;

  const { postInventoryMovement, retireZeroQtyLedgerGhosts, softRetireLedgerRow } = require('../lib/inventory/ledger');
  const { buildStockLedger } = require('../lib/ledgers');
  const { retireAmendedMovement } = (() => {
    // amend exports amendPostedInvoiceInPlace; retire is internal — exercise via softRetire + SQL ghost
    return { retireAmendedMovement: softRetireLedgerRow };
  })();

  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get();
  ok(!!admin, 'admin');

  let whId = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get()?.id;
  if (!whId) {
    const r = db.prepare("INSERT INTO warehouses (name, active, is_default) VALUES ('WH-K',1,1)").run();
    whId = r.lastInsertRowid;
  }

  const prod = db.prepare(`
    INSERT INTO products (user_id, name, code, unit, stock, cost, average_cost_rial, warehouse_id)
    VALUES (?, 'کالای کاردکس تست','KX-364','عدد',10,100,1000,?)
  `).run(admin.id, whId);
  const pid = prod.lastInsertRowid;

  // Opening stock so sale does not trip negative-stock trigger
  postInventoryMovement(db, {
    eventType: 'opening', productId: pid, warehouseId: whId,
    qtyIn: 10, unitCostRial: 1000, sourceType: 'opening', sourceId: pid,
    date: '1405/01/01', note: 'اول دوره تست', createdBy: admin.id, allowNegative: true,
  });

  // Live sale
  postInventoryMovement(db, {
    eventType: 'sale', productId: pid, warehouseId: whId,
    qtyOut: 2, unitCostRial: 1000, sourceType: 'invoice', sourceId: 9001,
    date: '1405/07/01', note: 'فروش T-TEST', createdBy: admin.id, allowNegative: true,
  });

  // Ghost as older amend left it (posted qty=0 amount=0 with unit cost)
  db.prepare(`
    INSERT INTO inventory_ledger (
      tx_no, event_type, product_id, warehouse_id,
      qty_in, qty_out, qty_balance, unit_cost_rial, amount_rial, avg_cost_after_rial,
      source_type, source_id, status, date, note, created_by
    ) VALUES (?,?,?,?,0,0,8,8762274,0,1000,'invoice',9001,'posted','1405/07/19','فروش T-0015 — اصلاح فاکتور',?)
  `).run('TX-GHOST-1', 'sale', pid, whId, admin.id);

  db.prepare(`
    INSERT INTO inventory_ledger (
      tx_no, event_type, product_id, warehouse_id,
      qty_in, qty_out, qty_balance, unit_cost_rial, amount_rial, avg_cost_after_rial,
      source_type, source_id, status, date, note, created_by
    ) VALUES (?,?,?,?,0,0,8,8762274,0,1000,'invoice',9001,'posted','1405/07/19','فروش T-0015 — اصلاح فاکتور',?)
  `).run('TX-GHOST-2', 'sale', pid, whId, admin.id);

  let ledger = buildStockLedger(db, { product_id: pid });
  ok(ledger.lines.length === 2, 'default kardex = opening+sale, hides 2 ghosts', ledger.lines.length);
  ok(!ledger.lines.some((l) => /اصلاح فاکتور/.test(l.description || '')),
    'no اصلاح فاکتور in active kardex');

  const healed = retireZeroQtyLedgerGhosts(db);
  ok(healed.count >= 2, 'heal retires ghosts', healed);

  ledger = buildStockLedger(db, { product_id: pid });
  ok(ledger.lines.length === 2, 'after heal still 2 active lines', ledger.lines.length);

  const withHist = buildStockLedger(db, { product_id: pid, show_cancelled: 1 });
  ok(withHist.lines.length >= 4, 'show_cancelled reveals retired rows', withHist.lines.length);
  ok(withHist.lines.some((l) => l.cancelled || l.status === 'reversed'),
    'history marks cancelled');

  // Soft-retire the sale line (amend-style) without reverse stock post
  const live = db.prepare(`
    SELECT * FROM inventory_ledger
    WHERE product_id=? AND status='posted' AND event_type='sale'
    ORDER BY id LIMIT 1
  `).get(pid);
  retireAmendedMovement(db, live.id, { note: (live.note || '') + ' — اصلاح فاکتور' });
  ledger = buildStockLedger(db, { product_id: pid });
  ok(ledger.lines.length === 1, 'after soft-retire sale, opening remains', ledger.lines.length);
  ok(ledger.lines[0].event_type === 'opening', 'remaining line is opening');

  console.log(`\n${fail ? '💥' : '🎉'} ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
