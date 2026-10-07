/**
 * Opening / beginning-balance journal helpers.
 * Used by parties, products, warehouse receipts, cheques — including Excel import.
 */
const { postToLedger } = require('./ledger');
const { acct } = require('./coa-map');
const { rialToLedger } = require('./money');
const { todayJalali } = require('../jalali');

function parseRoles(partyRoles, partyType) {
  let roles = [];
  try {
    roles = typeof partyRoles === 'string' ? JSON.parse(partyRoles || '[]') : (partyRoles || []);
  } catch (_) { roles = []; }
  if (!roles.length && partyType) {
    if (partyType === 'both') roles = ['customer', 'supplier'];
    else if (partyType) roles = [partyType];
  }
  return Array.isArray(roles) ? roles : [];
}

function controlAccountForParty(db, party) {
  const roles = parseRoles(party.party_roles, party.party_type);
  const nature = String(party.account_nature || '').toLowerCase();
  if (roles.includes('supplier') && !roles.includes('customer')) return acct(db, 'coa_payable');
  if (nature === 'credit' || nature === 'بستانکار') return acct(db, 'coa_payable');
  if (roles.includes('customer') || nature === 'debit' || nature === 'بدهکار') return acct(db, 'coa_receivable');
  if (roles.includes('supplier')) return acct(db, 'coa_payable');
  return acct(db, 'coa_misc_persons');
}

/**
 * Post opening-balance JE for a party (مانده اول دوره).
 * amountRial > 0 → party owes us (debit receivable / credit opening)
 * amountRial < 0 → we owe party (debit opening / credit payable)
 * @returns {number|null} journal entry id
 */
function postPartyOpeningBalance(db, {
  partyId, amountRial, date, userId, description, srcSystem,
}) {
  const amt = Math.round(Number(amountRial) || 0);
  if (!amt) return null;
  const party = db.prepare('SELECT * FROM parties WHERE id=?').get(partyId);
  if (!party) throw new Error('شخص برای سند افتتاحیه یافت نشد');

  let control = controlAccountForParty(db, party);
  if (party.legacy_table === 'customers' && party.legacy_id) {
    const c = db.prepare('SELECT coa_code FROM customers WHERE id=?').get(party.legacy_id);
    if (c?.coa_code) {
      const tafsili = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(c.coa_code);
      if (tafsili) control = tafsili;
    }
  } else if (party.coa_code) {
    const tafsili = db.prepare('SELECT code,name FROM chart_of_accounts WHERE code=?').get(party.coa_code);
    if (tafsili) control = tafsili;
  }
  const opening = acct(db, 'coa_opening_balance');
  const absToman = rialToLedger(Math.abs(amt));
  const lines = amt > 0
    ? [
      { code: control.code, name: control.name, debit: absToman, credit: 0 },
      { code: opening.code, name: opening.name, debit: 0, credit: absToman },
    ]
    : [
      { code: opening.code, name: opening.name, debit: absToman, credit: 0 },
      { code: control.code, name: control.name, debit: 0, credit: absToman },
    ];

  const entryId = postToLedger(db, {
    sourceType: 'opening_balance',
    sourceId: partyId,
    date: date || party.opening_balance_date || todayJalali(),
    description: description || `مانده اول دوره — ${party.full_name || party.biz || partyId}`,
    createdBy: userId,
    voucherType: 'opening',
    srcSystem: srcSystem || null,
    lines,
  });

  // Sub-ledgers (amounts in rial identity, same as customer_ledger after migration)
  try {
    const { createLedgerEntry } = require('../db');
    const debit = amt > 0 ? Math.abs(amt) : 0;
    const credit = amt < 0 ? Math.abs(amt) : 0;
    if (party.legacy_table === 'customers' && party.legacy_id) {
      db.prepare("DELETE FROM customer_ledger WHERE customer_id=? AND ref_type='opening'").run(party.legacy_id);
      createLedgerEntry(db, {
        customer_id: party.legacy_id, date: date || '', entry_type: 'opening',
        ref_type: 'opening', ref_id: party.legacy_id,
        description: 'مانده اولیه حساب', debit, credit, user_id: userId,
      });
      db.prepare('UPDATE customers SET balance=? WHERE id=?').run(amt, party.legacy_id);
    }
    // person_ledger FKs to persons(id) — only when a legacy persons row exists
    if (party.legacy_table === 'persons' && party.legacy_id) {
      const { createPersonLedgerEntry } = require('../db');
      createPersonLedgerEntry(db, {
        person_id: party.legacy_id, date: date || todayJalali(), entry_type: 'opening',
        ref_type: 'opening_balance', ref_id: entryId,
        description: description || 'مانده اول دوره', debit, credit, user_id: userId,
      });
    }
  } catch (e) {
    if (db.inTransaction) throw e;
  }
  return entryId;
}

/**
 * Beginning inventory JE when a product is created with opening stock + cost.
 * Dr inventory / Cr opening_balance
 */
function postProductOpeningInventory(db, {
  productId, qty, unitCostRial, date, userId, description, srcSystem,
}) {
  const q = Math.max(0, Number(qty) || 0);
  const unit = Math.max(0, Math.round(Number(unitCostRial) || 0));
  if (!(q > 0) || !unit) return null;
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!product) return null;

  const totalRial = Math.round(q * unit);
  const inventory = acct(db, 'coa_inventory');
  const opening = acct(db, 'coa_opening_balance');
  const amtToman = rialToLedger(totalRial);

  const entryId = postToLedger(db, {
    sourceType: 'opening_inventory',
    sourceId: productId,
    date: date || todayJalali(),
    description: description || `موجودی اول دوره — ${product.name || productId} × ${q}`,
    createdBy: userId,
    voucherType: 'opening',
    srcSystem: srcSystem || null,
    lines: [
      { code: inventory.code, name: inventory.name, debit: amtToman, credit: 0 },
      { code: opening.code, name: opening.name, debit: 0, credit: amtToman },
    ],
  });

  if (product.warehouse_id) {
    const { postInventoryMovement } = require('./inventory/ledger');
    postInventoryMovement(db, {
      eventType: 'opening',
      productId,
      warehouseId: product.warehouse_id,
      qty: q,
      unitCostRial: unit,
      sourceType: 'opening_inventory',
      sourceId: productId,
      jeId: entryId,
      date: date || todayJalali(),
      note: description || `موجودی اول دوره — ${product.name || productId}`,
      createdBy: userId,
      updateAvg: false,
      skipStock: true,
    });
  }
  const { catalogCostFromAvgRial } = require('./inventory/product-unit-cost');
  db.prepare(`
    UPDATE products SET average_cost_rial=?, cost=?
    WHERE id=? AND COALESCE(average_cost_rial,0)=0
  `).run(unit, catalogCostFromAvgRial(unit), productId);
  return entryId;
}

/**
 * Additive backfill: for each warehouse_stock row whose qty disagrees with
 * posted inventory_ledger net, insert an opening movement (skipStock).
 * Flag: settings.opening_inventory_ledger_backfill_v1
 * Rollback: DELETE ledger rows with note LIKE '%(backfill)%' then DELETE the setting.
 *
 * Note: this one-shot can seal with count=0 before warehouse_stock is seeded.
 * Prefer reconcileInventoryLedgerGaps for ongoing gaps (kardex empty while stock>0).
 */
function backfillOpeningInventoryLedger(db) {
  if (process.env.SYNC_ROLE === 'device') {
    return { skipped: true, reason: 'device' };
  }
  const flag = db.prepare("SELECT value FROM settings WHERE key='opening_inventory_ledger_backfill_v1'").get();
  if (flag && String(flag.value).length) {
    try {
      const parsed = JSON.parse(flag.value);
      if (parsed && parsed.ok) return { skipped: true, count: parsed.count || 0 };
    } catch (_) {
      if (flag.value === '1') return { skipped: true };
    }
  }
  const result = reconcileInventoryLedgerGaps(db, {
    noteIn: 'موجودی اول دوره (backfill)',
    noteOut: 'هم‌ترازی کاردکس با موجودی انبار (backfill)',
    recordSetting: false,
  });
  const count = Number(result.count) || 0;
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('opening_inventory_ledger_backfill_v1',?)")
    .run(JSON.stringify({ ok: 1, count }));
  return { count, seeded_wh: result.seeded_wh || 0 };
}

function _defaultWarehouseId(db) {
  return db.prepare(`
    SELECT id FROM warehouses
    WHERE COALESCE(active,1)=1
    ORDER BY CASE WHEN COALESCE(is_default,0)=1 THEN 0 ELSE 1 END, id
    LIMIT 1
  `).get()?.id || null;
}

function _ledgerNet(db, productId, warehouseId) {
  return Number(db.prepare(`
    SELECT COALESCE(SUM(qty_in - qty_out),0) q
    FROM inventory_ledger
    WHERE product_id=? AND warehouse_id=? AND COALESCE(status,'posted')='posted'
  `).get(productId, warehouseId)?.q) || 0;
}

function _unitCostRial(product) {
  return Math.round(Number(product.average_cost_rial) || Number(product.cost) || 0);
}

/**
 * Ensure warehouse_stock exists for a product with header stock, then post
 * skipStock ledger rows so kardex net matches warehouse qty (both directions).
 * Safe to call repeatedly; does not change products.stock / warehouse_stock.
 */
function reconcileProductStockLedger(db, productId, {
  createdBy = null,
  noteIn = 'موجودی اول دوره (هم‌ترازی کاردکس)',
  noteOut = 'هم‌ترازی کاردکس با موجودی انبار',
} = {}) {
  const pid = parseInt(productId, 10);
  if (!Number.isFinite(pid) || pid <= 0) return { count: 0, seeded_wh: 0 };
  const hasLedger = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inventory_ledger'").get();
  if (!hasLedger) return { count: 0, seeded_wh: 0, skipped: true };

  const product = db.prepare(
    'SELECT id, name, stock, warehouse_id, average_cost_rial, cost FROM products WHERE id=?'
  ).get(pid);
  if (!product) return { count: 0, seeded_wh: 0 };

  let seeded = 0;
  let whId = product.warehouse_id || null;
  if (!whId) whId = _defaultWarehouseId(db);
  const headerStock = Number(product.stock) || 0;
  if (whId && Math.abs(headerStock) > 1e-9) {
    const existing = db.prepare(
      'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
    ).get(pid, whId);
    if (!existing) {
      db.prepare(
        'INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)'
      ).run(pid, whId, headerStock);
      if (!product.warehouse_id) {
        db.prepare('UPDATE products SET warehouse_id=? WHERE id=?').run(whId, pid);
      }
      seeded = 1;
    }
  }

  const { postInventoryMovement } = require('./inventory/ledger');
  const adminId = createdBy
    || db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get()?.id
    || 1;
  const unit = _unitCostRial(product);
  const rows = db.prepare(`
    SELECT warehouse_id, qty FROM warehouse_stock WHERE product_id=?
  `).all(pid);

  let count = 0;
  for (const r of rows) {
    const net = _ledgerNet(db, pid, r.warehouse_id);
    const gap = Number(r.qty) - net;
    if (Math.abs(gap) <= 1e-9) continue;
    if (gap > 0) {
      postInventoryMovement(db, {
        eventType: 'opening',
        productId: pid,
        warehouseId: r.warehouse_id,
        qty: gap,
        unitCostRial: unit,
        sourceType: 'opening_inventory',
        sourceId: pid,
        date: todayJalali(),
        note: noteIn,
        createdBy: adminId,
        skipStock: true,
        updateAvg: false,
      });
    } else {
      postInventoryMovement(db, {
        eventType: 'adjustment',
        productId: pid,
        warehouseId: r.warehouse_id,
        qty: gap,
        unitCostRial: unit,
        sourceType: 'stock_reconcile',
        sourceId: pid,
        date: todayJalali(),
        note: noteOut,
        createdBy: adminId,
        skipStock: true,
        updateAvg: false,
      });
    }
    count += 1;
  }
  return { count, seeded_wh: seeded };
}

/**
 * Continuous (boot-safe) heal: warehouse_stock / header stock with no matching
 * inventory_ledger rows → opening/adjustment with skipStock so kardex shows history.
 * Unlike backfillOpeningInventoryLedger, this is NOT sealed by a one-shot flag.
 */
function reconcileInventoryLedgerGaps(db, {
  noteIn = 'موجودی اول دوره (هم‌ترازی کاردکس)',
  noteOut = 'هم‌ترازی کاردکس با موجودی انبار',
  recordSetting = true,
} = {}) {
  if (process.env.SYNC_ROLE === 'device') {
    return { skipped: true, reason: 'device', count: 0, seeded_wh: 0 };
  }
  const hasLedger = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inventory_ledger'").get();
  if (!hasLedger) return { skipped: true, count: 0, seeded_wh: 0 };
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='warehouse_stock'").get()) {
    return { skipped: true, count: 0, seeded_wh: 0 };
  }

  const adminId = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get()?.id || 1;
  const defaultWh = _defaultWarehouseId(db);
  let seeded = 0;

  // Header stock without a warehouse_stock row never entered the old one-shot backfill.
  const orphans = db.prepare(`
    SELECT p.id, p.stock, p.warehouse_id
    FROM products p
    WHERE ABS(COALESCE(p.stock,0)) > 1e-9
      AND NOT EXISTS (
        SELECT 1 FROM warehouse_stock ws WHERE ws.product_id=p.id AND ABS(COALESCE(ws.qty,0)) > 1e-9
      )
  `).all();
  for (const p of orphans) {
    const whId = p.warehouse_id || defaultWh;
    if (!whId) continue;
    db.prepare(
      'INSERT OR IGNORE INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)'
    ).run(p.id, whId, Number(p.stock) || 0);
    const row = db.prepare(
      'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
    ).get(p.id, whId);
    if (row && Math.abs(Number(row.qty) || 0) <= 1e-9 && Math.abs(Number(p.stock) || 0) > 1e-9) {
      db.prepare('UPDATE warehouse_stock SET qty=? WHERE product_id=? AND warehouse_id=?')
        .run(Number(p.stock) || 0, p.id, whId);
    }
    if (!p.warehouse_id) {
      db.prepare('UPDATE products SET warehouse_id=? WHERE id=?').run(whId, p.id);
    }
    seeded += 1;
  }

  const candidates = db.prepare(`
    SELECT DISTINCT product_id AS id FROM warehouse_stock
    WHERE ABS(COALESCE(qty,0)) > 1e-9
    UNION
    SELECT id FROM products WHERE ABS(COALESCE(stock,0)) > 1e-9
  `).all();

  let count = 0;
  let seededWh = seeded;
  const run = db.transaction(() => {
    for (const c of candidates) {
      const r = reconcileProductStockLedger(db, c.id, {
        createdBy: adminId, noteIn, noteOut,
      });
      count += Number(r.count) || 0;
      seededWh += Number(r.seeded_wh) || 0;
    }
  });
  run();

  if (recordSetting) {
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('inventory_ledger_gap_reconcile_v1',?)")
      .run(JSON.stringify({
        ok: 1, count, seeded_wh: seededWh, at: new Date().toISOString(),
      }));
  }
  return { count, seeded_wh: seededWh };
}

module.exports = {
  postPartyOpeningBalance,
  postProductOpeningInventory,
  backfillOpeningInventoryLedger,
  reconcileInventoryLedgerGaps,
  reconcileProductStockLedger,
  controlAccountForParty,
  parseRoles,
};
