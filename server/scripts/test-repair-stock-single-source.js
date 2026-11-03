'use strict';
/**
 * Repair script + zero/zero revalue + back-dated opening.
 * Run: node scripts/test-repair-stock-single-source.js
 *
 * Temp DB. Chain pricing (10×1000, then qty 4 and qty 2 → 4000 and 2000),
 * back-dated opening hook, period-lock pending (no throw), then the repair
 * script: dry-run writes nothing; apply stamps variant_id, posts value-only
 * revalue rows, rebuilds caches. Trial balance stays even; recon does not worsen.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  OK  ', label); }
  else { fail += 1; console.log('  FAIL', label, extra == null ? '' : JSON.stringify(extra).slice(0, 1500)); }
}

console.log('\n══ repair stock single source ══\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-ss-'));
process.env.DB_PATH = path.join(dir, 'repair.db');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
process.env.SYNC_ROLE = 'central';
process.env.ERP_TEST_ISOLATION = '1';
process.env.SMS_DISABLED = '1';
process.env.JWT_SECRET = 'repair-stock-ss-test-secret-0123456789!!';
process.env.AUTH_SESSION_DB_PATH = path.join(dir, 'sessions.db');
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const dbMods = require('../db');
dbMods.initDB();
const db = dbMods.getDB();

const colsCache = new Map();
const cols = (t) => {
  if (!colsCache.has(t)) colsCache.set(t, new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)));
  return colsCache.get(t);
};
function insert(table, obj) {
  const c = cols(table);
  const keys = Object.keys(obj).filter((k) => c.has(k));
  return Number(db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => obj[k])).lastInsertRowid);
}
const q1 = (sql, ...p) => db.prepare(sql).get(...p);
const qa = (sql, ...p) => db.prepare(sql).all(...p);

function main() {
  const L = require('../lib/inventory/ledger');
  const TI = require('../lib/inventory/transfer-in-revalue');
  const PL = require('../lib/inventory/period-lock');
  const OP = require('../lib/opening-post');
  const SC = require('../lib/inventory/stock-cache');
  const { runRecon } = require('../lib/subledger-recon');
  const { todayJalali } = require('../jalali');
  require('../lib/inventory/movement').ensureInventorySchema(db);

  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('inventory_allow_negative','0')").run();
  const adminId = insert('users', { name: 'مدیر', username: 'rss_admin', password: 'x', role: 'admin', active: 1, must_change_password: 0 });
  const wh = (name, code) => insert('warehouses', {
    name, code, active: 1, allow_negative: 1, warehouse_type: 'finished_goods', inventory_system: 'perpetual',
  });
  const A = wh('مبدأ', 'RSS-A');
  const B = wh('مقصد', 'RSS-B');
  const product = (name, code, warehouseId) => insert('products', {
    user_id: adminId, name, code, price: 1000, cost: 0, stock: 0, warehouse_id: warehouseId,
    average_cost_rial: 0, unit: 'عدد',
  });
  const variant = (pid, sku) => insert('product_variants', {
    product_id: pid, sku, stock: 0, active: 1, is_default: 0, status: 'active',
  });

  function xfer(pid, from, to, qty, date, sourceId, variantId) {
    const out = L.postInventoryMovement(db, {
      eventType: 'transfer_out', productId: pid, warehouseId: from, variantId: variantId || null,
      qtyOut: qty, unitCostRial: 0, amountRial: 0, sourceType: 'warehouse_transfer', sourceId,
      date, allowZeroCost: true, skipStock: true, updateAvg: false, createdBy: adminId,
    });
    const inn = L.postInventoryMovement(db, {
      eventType: 'transfer_in', productId: pid, warehouseId: to, variantId: variantId || null,
      qtyIn: qty, unitCostRial: 0, amountRial: 0, sourceType: 'warehouse_transfer', sourceId,
      date, skipStock: true, updateAvg: false, createdBy: adminId,
    });
    return { out: Number(out.id), inn: Number(inn.id) };
  }

  // ── chain: one average, virtual rows keep the second transfer undiluted ──
  const pChain = product('زنجیره', 'RSS-CHAIN', A);
  L.postInventoryMovement(db, {
    eventType: 'opening', productId: pChain, warehouseId: A, qtyIn: 10, unitCostRial: 1000, amountRial: 10000,
    sourceType: 'opening_inventory', sourceId: pChain, date: '1405/01/01', skipStock: true, updateAvg: false, createdBy: adminId,
  });
  xfer(pChain, A, B, 4, '1405/01/02', 501);
  xfer(pChain, A, B, 2, '1405/01/03', 502);
  const chain = TI.computePlan(db, { includeZeroZero: true, productIds: [pChain] });
  const chainDeltas = chain.candidates.map((c) => c.delta_rial).sort((a, b) => b - a);
  ok(chain.candidates.length === 2 && chain.candidates.every((c) => c.kind === 'zero_zero') && chainDeltas[0] === 4000 && chainDeltas[1] === 2000,
    'chain as-of average: qty 4 → 4000 and qty 2 → 2000', chainDeltas);
  ok(chain.gl_effect_rial === 0, 'chain plan GL effect 0');

  // ── back-dated opening posts the two value-only legs ──
  const pHook = product('افتتاحیه معوق', 'RSS-HOOK', A);
  const vHook = variant(pHook, 'RSS-HOOK-1');
  const hookX = xfer(pHook, A, B, 4, '1405/02/01', 601, vHook);
  db.prepare('UPDATE inventory_ledger SET variant_id=NULL WHERE id IN (?,?)').run(hookX.out, hookX.inn);
  db.prepare(`INSERT INTO inventory_movements (product_id, variant_id, warehouse_id, qty_delta, doc_type, doc_id, note)
    VALUES (?,?,?,?,?,?,?)`).run(pHook, vHook, A, -4, 'wh_transfer_out', 601, 'hook out');
  db.prepare(`INSERT INTO inventory_movements (product_id, variant_id, warehouse_id, qty_delta, doc_type, doc_id, note)
    VALUES (?,?,?,?,?,?,?)`).run(pHook, vHook, B, 4, 'wh_transfer_in', 601, 'hook in');
  const hookJe = OP.postProductOpeningInventory(db, {
    productId: pHook, qty: 10, unitCostRial: 1000, date: '1405/01/15', userId: adminId, variantId: vHook,
  });
  ok(typeof hookJe === 'number' && hookJe > 0, 'opening returns a journal id', hookJe);
  const hookLegs = qa(`SELECT event_type, warehouse_id, amount_rial, qty_in, qty_out, variant_id, je_id
    FROM inventory_ledger WHERE product_id=? AND event_type IN ('transfer_out_revalue','transfer_in_revalue')
    ORDER BY event_type`, pHook);
  ok(hookLegs.length === 2, 'hook posted both revalue legs', hookLegs);
  const hookOut = hookLegs.find((r) => r.event_type === 'transfer_out_revalue');
  const hookIn = hookLegs.find((r) => r.event_type === 'transfer_in_revalue');
  ok(hookOut && hookIn && hookOut.amount_rial === -4000 && hookIn.amount_rial === 4000
    && hookOut.warehouse_id === A && hookIn.warehouse_id === B
    && hookOut.qty_in === 0 && hookOut.qty_out === 0 && hookIn.qty_in === 0 && hookIn.qty_out === 0
    && hookOut.variant_id === vHook && hookIn.variant_id === vHook
    && hookOut.je_id == null && hookIn.je_id == null, 'hook legs are value-only, opposite, variant stamped', hookLegs);
  const openLeg = q1(`SELECT variant_id, qty_in, amount_rial FROM inventory_ledger
    WHERE product_id=? AND event_type='opening' AND source_type='opening_inventory'`, pHook);
  ok(openLeg && openLeg.variant_id === vHook && openLeg.qty_in === 10, 'opening ledger row carries variantId', openLeg);
  ok(q1('SELECT average_cost_rial a FROM products WHERE id=?', pHook).a === 1000, 'header average stays the opening unit');

  // ── locked month: opening still posts, revalue is a pending note ──
  const pLock = product('قفل دوره', 'RSS-LOCK', A);
  const vLock = variant(pLock, 'RSS-LOCK-1');
  const TODAY = todayJalali();
  xfer(pLock, A, B, 2, '1405/03/01', 701, vLock);
  PL.closePeriod(db, TODAY.slice(0, 7), { id: adminId }, { reason: 'تست قفل اصلاح انتقال' });
  let lockThrew = null;
  let lockJe = null;
  try {
    lockJe = OP.postProductOpeningInventory(db, {
      productId: pLock, qty: 5, unitCostRial: 2000, date: '1405/01/20', userId: adminId, variantId: vLock,
    });
  } catch (e) { lockThrew = e && (e.code || e.message); }
  ok(!lockThrew && typeof lockJe === 'number', 'locked month does not throw; opening journal exists', { lockThrew, lockJe });
  ok(q1(`SELECT COUNT(*) c FROM inventory_ledger WHERE product_id=? AND event_type='opening'`, pLock).c === 1, 'opening row kept');
  ok(q1(`SELECT COUNT(*) c FROM inventory_ledger WHERE product_id=? AND event_type LIKE 'transfer_%revalue'`, pLock).c === 0,
    'no revalue rows while the month is locked');
  ok(q1(`SELECT COUNT(*) c FROM audit_log WHERE action='transfer_revalue_pending' AND entity_id=?`, pLock).c >= 1,
    'pending note is audited');
  PL.reopenPeriod(db, TODAY.slice(0, 7), { id: adminId }, { reason: 'بازگشایی تست' });

  // ── K-00009-like: null ledger variant, movements carry it, corrupt caches ──
  const pK = product('مانتو تست', 'K-00009', A);
  const vK = variant(pK, 'K-00009-1');
  L.postInventoryMovement(db, {
    eventType: 'opening', productId: pK, warehouseId: A, variantId: vK, qtyIn: 10, unitCostRial: 1000, amountRial: 10000,
    sourceType: 'opening_inventory', sourceId: pK, date: '1405/01/01', skipStock: true, updateAvg: false, createdBy: adminId,
  });
  db.prepare('UPDATE products SET average_cost_rial=1000 WHERE id=?').run(pK);
  const kX = xfer(pK, A, B, 4, '1405/04/01', 801, vK);
  db.prepare('UPDATE inventory_ledger SET variant_id=NULL WHERE id IN (?,?)').run(kX.out, kX.inn);
  db.prepare(`INSERT INTO inventory_movements (product_id, variant_id, warehouse_id, qty_delta, doc_type, doc_id, note)
    VALUES (?,?,?,?,?,?,?)`).run(pK, vK, A, -4, 'wh_transfer_out', 801, 'k out');
  db.prepare(`INSERT INTO inventory_movements (product_id, variant_id, warehouse_id, qty_delta, doc_type, doc_id, note)
    VALUES (?,?,?,?,?,?,?)`).run(pK, vK, B, 4, 'wh_transfer_in', 801, 'k in');
  const kRev = insert('inventory_ledger', {
    tx_no: 'K9-REV', event_type: 'reversal', product_id: pK, warehouse_id: A, qty_in: 0, qty_out: 0,
    unit_cost_rial: 0, amount_rial: 0, source_type: 'warehouse_transfer', source_id: 801,
    reversed_of: kX.out, status: 'posted', date: '1405/04/02', variant_id: null, note: 'ابطال آزمایشی',
  });
  const poLeg = insert('inventory_ledger', {
    tx_no: 'PO0019-KEEP', event_type: 'transfer_out', product_id: pK, warehouse_id: A, qty_in: 0, qty_out: 1,
    unit_cost_rial: 0, amount_rial: 0, source_type: 'warehouse_transfer', source_id: 802,
    status: 'void', date: '1405/04/03', variant_id: null, note: 'حواله PO-0019',
  });
  db.prepare(`INSERT INTO inventory_movements (product_id, variant_id, warehouse_id, qty_delta, doc_type, doc_id, note)
    VALUES (?,?,?,?,?,?,?)`).run(pK, vK, A, -1, 'wh_transfer_out', 802, 'حرکت متناظر');
  SC.rebuildStockCache(db, pK);
  db.prepare('UPDATE products SET stock=999 WHERE id=?').run(pK);
  db.prepare('UPDATE warehouse_stock SET qty=999 WHERE product_id=?').run(pK);
  db.prepare('UPDATE product_variants SET stock=999 WHERE id=?').run(vK);

  const before = {
    nulls: q1('SELECT COUNT(*) c FROM inventory_ledger WHERE id IN (?,?,?) AND variant_id IS NULL', kX.out, kX.inn, kRev).c,
    revalue: q1(`SELECT COUNT(*) c FROM inventory_ledger WHERE product_id=? AND event_type LIKE 'transfer_%revalue'`, pK).c,
    stock: q1('SELECT stock FROM products WHERE id=?', pK).stock,
    po: q1('SELECT variant_id FROM inventory_ledger WHERE id=?', poLeg).variant_id,
  };
  ok(before.nulls === 3 && before.revalue === 0 && before.stock === 999 && before.po == null, 'fixture is null-variant and corrupt', before);

  const script = path.join(__dirname, 'repair-stock-single-source.js');
  const outDry = path.join(dir, 'out-dry');
  const run = (args) => spawnSync(process.execPath, [script, ...args], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_PATH: process.env.DB_PATH },
    encoding: 'utf8',
    timeout: 180000,
  });
  const summaryOf = (r) => {
    const line = String(r.stdout || '').split(/\r?\n/).filter((l) => l.startsWith('SUMMARY '))[0];
    return line ? JSON.parse(line.slice('SUMMARY '.length)) : null;
  };

  const dry = run(['--db', process.env.DB_PATH, '--out', outDry, '--dry-run']);
  const drySum = summaryOf(dry);
  ok(dry.status === 0 && drySum && drySum.mode === 'dry-run', 'dry-run exits 0', { status: dry.status, err: dry.stderr && dry.stderr.slice(0, 800), out: (dry.stdout || '').slice(-500) });
  ok(q1('SELECT variant_id FROM inventory_ledger WHERE id=?', kX.out).variant_id == null, 'dry-run does not stamp variant_id');
  ok(q1(`SELECT COUNT(*) c FROM inventory_ledger WHERE product_id=? AND event_type LIKE 'transfer_%revalue'`, pK).c === 0, 'dry-run posts no revalue');
  ok(q1('SELECT stock FROM products WHERE id=?', pK).stock === 999, 'dry-run leaves the corrupt cache');
  ok(fs.existsSync(path.join(outDry, 'manual.csv')) && fs.existsSync(path.join(outDry, 'cache-diff.csv')), 'dry-run writes CSVs');
  ok(drySum && drySum.revalue.candidates >= 1 && drySum.revalue.sum_rial >= 4000, 'dry-run reports revalue candidates', drySum && drySum.revalue);
  const kPlan = TI.computePlan(db, { includeZeroZero: true, productIds: [pK] });
  ok(kPlan.candidates.some((c) => c.kind === 'zero_zero' && c.delta_rial === 4000 && c.in_id === kX.inn),
    'K-00009 pair prices at 4000', kPlan.candidates);

  const noGo = run(['--db', process.env.DB_PATH, '--out', path.join(dir, 'out-nogo'), '--apply']);
  ok(noGo.status === 2, 'apply without --i-have-go exits 2', noGo.status);
  ok(q1('SELECT stock FROM products WHERE id=?', pK).stock === 999, 'refused apply writes nothing');

  const trialBefore = q1(`SELECT COALESCE(SUM(debit_rial),0) d, COALESCE(SUM(credit_rial),0) c FROM journal_lines`);
  const reconBefore = runRecon(db, { persist: false });
  const score = (r) => ((r.summary.error || 0) * 100) + ((r.summary.warn || 0) * 10) + (r.summary.rounding || 0);
  const backupDir = path.join(dir, 'backups');
  const applied = run(['--db', process.env.DB_PATH, '--out', path.join(dir, 'out-apply'), '--backup-dir', backupDir, '--apply', '--i-have-go']);
  const appSum = summaryOf(applied);
  ok(applied.status === 0 && appSum && appSum.mode === 'apply' && !appSum.rolled_back, 'apply commits', {
    status: applied.status, err: (applied.stderr || '').slice(0, 1200), tail: (applied.stdout || '').slice(-800),
  });
  ok(appSum && appSum.backup && fs.existsSync(appSum.backup), 'backup file exists', appSum && appSum.backup);

  ok(q1('SELECT variant_id FROM inventory_ledger WHERE id=?', kX.out).variant_id === vK, 'apply stamps transfer_out');
  ok(q1('SELECT variant_id FROM inventory_ledger WHERE id=?', kX.inn).variant_id === vK, 'apply stamps transfer_in');
  ok(q1('SELECT variant_id FROM inventory_ledger WHERE id=?', kRev).variant_id === vK, 'reversal inherits variant_id');
  ok(q1('SELECT variant_id FROM inventory_ledger WHERE id=?', poLeg).variant_id == null, 'PO-0019 row is not stamped');

  const kLegs = qa(`SELECT event_type, warehouse_id, amount_rial, qty_in, qty_out, variant_id, je_id
    FROM inventory_ledger WHERE product_id=? AND event_type IN ('transfer_out_revalue','transfer_in_revalue')`, pK);
  ok(kLegs.length === 2 && kLegs.reduce((s, r) => s + r.amount_rial, 0) === 0, 'K revalue pair is value-neutral', kLegs);
  ok(kLegs.every((r) => r.qty_in === 0 && r.qty_out === 0 && r.variant_id === vK && r.je_id == null), 'K revalue rows are value-only');
  ok(q1('SELECT average_cost_rial a FROM products WHERE id=?', pK).a === 1000, 'header average unchanged');

  const vs = SC.stockCacheVsLedger(db, { productId: pK });
  ok(vs.mismatch_count === 0, 'K caches match the ledger', vs.rows);
  const allVs = SC.stockCacheVsLedger(db, { limit: 5000 });
  ok(allVs.mismatch_count === 0, 'no cache mismatches after rebuild', { n: allVs.mismatch_count, sample: allVs.rows.slice(0, 5) });
  ok(q1('SELECT stock FROM products WHERE id=?', pK).stock === 10, 'header cache rebuilt from ledger', q1('SELECT stock FROM products WHERE id=?', pK).stock);

  const trialAfter = q1(`SELECT COALESCE(SUM(debit_rial),0) d, COALESCE(SUM(credit_rial),0) c FROM journal_lines`);
  ok(trialAfter.d === trialAfter.c && trialAfter.d === trialBefore.d, 'trial balance unchanged and even', { trialBefore, trialAfter });
  const reconAfter = runRecon(db, { persist: false });
  ok((reconAfter.summary.error || 0) <= (reconBefore.summary.error || 0) && score(reconAfter) <= score(reconBefore),
    'recon did not get worse', { before: reconBefore.summary, after: reconAfter.summary });

  const again = TI.computePlan(db, { includeZeroZero: true, productIds: [pK] });
  ok(again.candidates.length === 0 && (again.excluded_summary.already_corrected || 0) >= 1, 'second plan is idempotent', again.excluded_summary);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

try { main(); }
catch (e) {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
}
