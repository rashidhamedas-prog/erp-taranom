'use strict';
/**
 * v515 — واحد کالا با «ي/ك» عربی، نیم‌فاصله و کشیده:
 * matchText / stockUnitForProduct / بک‌فیل unit_id / برچسب طاقهٔ خرید (kg نه m)
 * و syncFabricProductWarehouse که موجودی خارج از طاقه را حذف نکند.
 * Run: node server/scripts/test-roll-units-arabic-v515.js
 */
const { ok, eq, summary } = require('./lib/test-harness');

let dbOk = false;
try {
  const { freshDb } = require('./lib/test-harness');
  const ctx = freshDb();
  const { db, cleanup } = ctx;
  try {
    const uom = require('../lib/uom');
    const {
      attachFabricIdentityOnPurchase, syncFabricProductWarehouse,
    } = require('../lib/inventory/fabric-rolls');
    const { postInventoryMovement, reverseInventoryMovement } = require('../lib/inventory/ledger');
    const { postCuttingLay } = require('../lib/production/cutting');

    const unit = (code) => db.prepare('SELECT * FROM units_of_measure WHERE UPPER(code)=?').get(code);
    const M = unit('M'); const YD = unit('YD'); const KG = unit('KG'); const M2 = unit('M2');
    ok('catalog M/YD/KG/M2', !!(M && YD && KG && M2));

    // ── matchText variants ───────────────────────────────────────
    const cases = [
      ['کيلو گرم', KG], ['كيلوگرم', KG], ['کیلو\u200cگرم', KG], ['کیـلوگرم', KG], [' کيلو ', KG],
      ['مـتر', M], ['متر\u200c', M], ['METER', M],
      ['يارد', YD], ['یـارد', YD], ['ي ا ر د', YD],
      ['m۲', M2], ['متر\u200cمربع', M2],
    ];
    for (const [text, row] of cases) {
      const hit = uom.matchText(db, text);
      ok(`matchText «${text}» → ${row.code}`, !!hit && hit.id === row.id, hit ? hit.code : 'null');
    }
    ok('matchText unknown → null', uom.matchText(db, 'توپ') === null);
    ok('isLengthText Arabic yard', uom.isLengthText('يارد') && uom.isLengthText('مـتر'));
    ok('isLengthText kg false', !uom.isLengthText('کيلو گرم'));
    ok('lengthTokenForProduct Arabic yard → yd', uom.lengthTokenForProduct(db, { unit: 'ي ارد' }) === 'yd');

    // ── stockUnitForProduct with unit_id NULL ────────────────────
    const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get();
    const user = { id: admin.id };
    const raw = db.prepare("SELECT id FROM warehouses WHERE code='WH-RAW'").get();
    ok('WH-RAW exists', !!raw);
    if (!db.prepare("SELECT id FROM warehouses WHERE code='WH-WIP'").get()) {
      db.prepare("INSERT INTO warehouses (code,name,kind,warehouse_type,active) VALUES ('WH-WIP','WIP','wip','wip',1)").run();
    }
    if (!db.prepare("SELECT id FROM warehouses WHERE code='WH-SCRAP'").get()) {
      db.prepare("INSERT INTO warehouses (code,name,kind,warehouse_type,active) VALUES ('WH-SCRAP','ضایعات','scrap','scrap',1)").run();
    }
    const product = (code, unitText, unitId = null) => db.prepare(`
      INSERT INTO products (user_id, name, code, price, stock, unit, unit_id, average_cost_rial, cost, item_type)
      VALUES (?, ?, ?, 0, 0, ?, ?, 1000, 1000, 'raw')
    `).run(admin.id, 'پارچه ' + code, code, unitText, unitId).lastInsertRowid;
    const prodRow = (id) => db.prepare('SELECT * FROM products WHERE id=?').get(id);

    const pK = product('AR-K', 'کيلو گرم');
    const pT = product('AR-T', 'توپ');
    ok('fixture unit_id NULL', prodRow(pK).unit_id == null);
    const su = uom.stockUnitForProduct(db, prodRow(pK));
    ok('stockUnitForProduct «کيلو گرم» → KG', !!su && su.id === KG.id, su ? su.code : 'null');
    ok('fabricReceiptUnits stock_ok for Arabic kg', uom.fabricReceiptUnits(db, prodRow(pK)).stock_ok === 1);
    ok('policyForProduct Arabic kg known', uom.policyForProduct(db, pK).unit_id === KG.id);

    // ── boot backfill links unit_id (idempotent) ─────────────────
    const pK2 = product('AR-K2', 'كيلو\u200cگرم');
    uom.bootstrap(db);
    eq('bootstrap links Arabic kg product', prodRow(pK2).unit_id, KG.id);
    ok('bootstrap leaves unknown text unlinked', prodRow(pT).unit_id == null);
    uom.bootstrap(db);
    eq('bootstrap idempotent', prodRow(pK2).unit_id, KG.id);
    db.prepare('UPDATE products SET unit_id=NULL WHERE id=?').run(pK2);

    // ── purchase roll label ──────────────────────────────────────
    const purchase = (pid, qty, src) => {
      const mv = postInventoryMovement(db, {
        eventType: 'purchase', productId: pid, warehouseId: raw.id, qtyIn: qty,
        unitCostRial: 1000, sourceType: 'purchase', sourceId: src, date: '1405/07/29',
        note: 'v515 ar purchase', createdBy: admin.id,
      });
      return attachFabricIdentityOnPurchase(db, {
        row: { product_id: pid, qty, price: 1000, color: 'سفید', is_fabric_roll: 1 },
        movement: mv, supplierId: null, user, date: '1405/07/29', warehouseId: raw.id, sourceId: src,
      });
    };
    const bK = purchase(pK2, 12, 9101);
    ok('purchase roll on «كيلو‌گرم» → unit kg', bK && bK.unit === 'kg', bK && bK.unit);
    eq('purchase roll entry_unit_id = KG', bK.entry_unit_id, KG.id);
    const bT = purchase(pT, 5, 9102);
    ok('purchase roll on unknown unit keeps product text (not m)', bT && bT.unit === 'توپ', bT && bT.unit);
    const pM = product('AR-M', 'مـتر');
    const bM = purchase(pM, 7, 9103);
    ok('purchase roll on «مـتر» → m', bM && bM.unit === 'm', bM && bM.unit);

    // ── sync guard: untracked opening + roll ─────────────────────
    const ws = (pid) => Number(db.prepare('SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?').get(pid, raw.id)?.qty) || 0;
    const ledgerQty = (pid) => {
      const r = db.prepare(`
        SELECT COALESCE(SUM(qty_in-qty_out),0) q FROM inventory_ledger l
        WHERE product_id=? AND warehouse_id=?
          AND (status='posted' OR EXISTS (SELECT 1 FROM inventory_ledger r WHERE r.reversed_of=l.id AND r.status='posted'))
      `).get(pid, raw.id);
      return Number(r.q) || 0;
    };
    let lot = 0;
    const roll = (pid, tok, qty) => {
      lot += 1;
      const bid = db.prepare(`
        INSERT INTO inventory_batches (batch_no, product_id, warehouse_id, qty_on_hand, qty_received, status, kind, unit,
          unit_cost_rial, color, width_cm)
        VALUES (?,?,?,?,?,'active','fabric',?,1000,'مشکی',150)
      `).run('AR515-' + lot, pid, raw.id, qty, qty, tok).lastInsertRowid;
      postInventoryMovement(db, {
        eventType: 'opening', productId: pid, warehouseId: raw.id, qtyIn: qty,
        unitCostRial: 1000, amountRial: qty * 1000, sourceType: 'opening_v515ar', sourceId: bid,
        batchId: bid, date: '1405/07/01', note: 'v515 ar roll', createdBy: admin.id,
      });
      return bid;
    };
    const untracked = (pid, qty) => postInventoryMovement(db, {
      eventType: 'opening', productId: pid, warehouseId: raw.id, qtyIn: qty,
      unitCostRial: 1000, amountRial: qty * 1000, sourceType: 'opening_v515ar', sourceId: pid,
      date: '1405/07/01', note: 'v515 untracked opening', createdBy: admin.id,
    });

    // kg (Arabic text) — consumption tagged to the roll
    const pS = product('AR-S', 'کيلو گرم');
    untracked(pS, 20);
    const rS = roll(pS, 'kg', 10);
    eq('kg: ws 30 before sync', ws(pS), 30, 1e-9);
    const s1 = syncFabricProductWarehouse(db, pS, raw.id);
    eq('kg: sync keeps untracked 20 (ws 30)', ws(pS), 30, 1e-9);
    ok('kg: sync reports rolls 10 / ledger 30', Math.abs(s1.rolls - 10) < 1e-9 && Math.abs(s1.ledger - 30) < 1e-9, JSON.stringify(s1));
    const out = postInventoryMovement(db, {
      eventType: 'production_issue', productId: pS, warehouseId: raw.id, qtyOut: 4,
      batchId: rS, sourceType: 'v515ar', sourceId: 1, date: '1405/07/29', note: 'v515 ar issue', createdBy: admin.id,
    });
    syncFabricProductWarehouse(db, pS, raw.id);
    eq('kg: after roll issue ws = 26 (not 6)', ws(pS), 26, 1e-9);
    eq('kg: ws equals ledger', ws(pS), ledgerQty(pS), 1e-9);
    reverseInventoryMovement(db, out.id, { createdBy: admin.id, date: '1405/07/29' });
    syncFabricProductWarehouse(db, pS, raw.id);
    eq('kg: after reversal ws = 30', ws(pS), 30, 1e-9);
    eq('kg: ws equals ledger after reversal', ws(pS), ledgerQty(pS), 1e-9);

    // metre — real lay consumes the roll; untracked opening survives
    const pL = product('AR-L', 'متر', M.id);
    untracked(pL, 20);
    const rL = roll(pL, 'm', 10);
    const fg = db.prepare(`
      INSERT INTO products (user_id, name, code, price, stock, unit, item_type, is_manufactured)
      VALUES (?, 'مانتو ar515', 'FG-AR515', 0, 0, 'عدد', 'finished', 1)
    `).run(admin.id).lastInsertRowid;
    const lay = postCuttingLay(db, {
      product_id: fg, fabric_product_id: pL, warehouse_id: raw.id, color: 'مشکی', width_cm: 150,
      marker_length_m: 0.5, ply_count: 8, actual_meters: 4, size_breakdown: { S: 4, M: 4 },
      rolls: [{ batch_id: rL, meters: 4 }], date: '1405/07/29', idempotency_key: 'v515-ar-lay-1',
    }, user);
    ok('m: lay posted', lay && lay.status === 'posted', lay && lay.status);
    eq('m: roll 10 → 6', Number(db.prepare('SELECT qty_on_hand q FROM inventory_batches WHERE id=?').get(rL).q), 6, 1e-6);
    eq('m: ws = 20 untracked + 6 roll', ws(pL), 26, 1e-6);
    eq('m: ws equals ledger after lay', ws(pL), ledgerQty(pL), 1e-6);

    // fully-on-roll product: untagged drain still realigns up to Σ rolls (unchanged behaviour)
    const pR = product('AR-R', 'متر', M.id);
    roll(pR, 'm', 10);
    postInventoryMovement(db, {
      eventType: 'production_issue', productId: pR, warehouseId: raw.id, qtyOut: 3,
      sourceType: 'v515ar', sourceId: 2, date: '1405/07/29', note: 'v515 untagged drain', createdBy: admin.id,
    });
    eq('drain: ws 7 before sync', ws(pR), 7, 1e-9);
    syncFabricProductWarehouse(db, pR, raw.id);
    eq('drain: sync restores Σ rolls 10', ws(pR), 10, 1e-9);
    const pF = product('AR-F', 'متر', M.id);
    roll(pF, 'm', 8);
    const sF = syncFabricProductWarehouse(db, pF, raw.id);
    ok('fully on rolls: no change', sF && sF.delta === 0 && ws(pF) === 8, JSON.stringify(sF));
    dbOk = true;
  } finally {
    cleanup();
  }
} catch (e) {
  if (/bindings|better_sqlite3|NODE_MODULE_VERSION/i.test(String(e.message) + e)) {
    console.log('  SKIP db path: better-sqlite3 not loaded on this Node');
    ok('db path skipped', true);
  } else {
    ok('db path', false, e.stack || e.message);
  }
}
if (dbOk) ok('db roll-units-arabic path', true);

summary('roll-units-arabic-v515');
