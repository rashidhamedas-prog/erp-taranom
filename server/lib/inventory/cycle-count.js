'use strict';
/**
 * Cycle count / stocktaking apply with accounting integrity (R9 acct, R1 rial, R8 txn).
 * Replaces hard-coded 1101/5101 in routes/stocktaking.js apply path.
 */
const { acct } = require('../coa-map');
const { postToLedger } = require('../ledger');
const {
  postInventoryMovement, reverseInventoryMovement, inventoryAccountForWarehouse,
  invErr, warehouseQty,
} = require('./ledger');
const { round3, parseQty } = require('../round3');
const { reverseJournalEntry } = require('../void-journal');
const { todayJalali } = require('../../jalali');

function variantLinesForProduct(db, productId, warehouseId) {
  const { hasActiveMatrixVariants, variantWarehouseQty } = require('./movement');
  if (!hasActiveMatrixVariants(db, productId)) return [];
  const variants = db.prepare(`
    SELECT pv.id
    FROM product_variants pv
    LEFT JOIN product_colors pc ON pc.id = pv.color_id
    LEFT JOIN product_sizes ps ON ps.id = pv.size_id
    WHERE pv.product_id=? AND pv.active=1 AND COALESCE(pv.is_default,0)=0
    ORDER BY pc.sort_order, ps.sort_order, pv.id
  `).all(productId);
  return variants.map((v) => ({
    variant_id: v.id,
    system_qty: variantWarehouseQty(db, v.id, warehouseId),
  }));
}

/**
 * Open sessions must count each color×size.
 * A header-only line on a matrix product is replaced.
 * New lines start counted = system so an untouched sheet does not move stock.
 */
function syncSessionVariantLines(db, sessionId) {
  const session = db.prepare('SELECT * FROM stocktaking_sessions WHERE id=?').get(sessionId);
  if (!session || session.status === 'adjusted') return { replaced: 0, added: 0 };
  const { hasActiveMatrixVariants } = require('./movement');
  let replaced = 0;
  let added = 0;
  const run = db.transaction(() => {
    const items = db.prepare('SELECT * FROM stocktaking_items WHERE session_id=?').all(session.id);
    const byProduct = new Map();
    for (const it of items) {
      if (!byProduct.has(it.product_id)) byProduct.set(it.product_id, []);
      byProduct.get(it.product_id).push(it);
    }
    const ins = db.prepare(`
      INSERT INTO stocktaking_items
        (session_id, product_id, variant_id, system_qty, counted_qty, count1_qty, confirmed_count)
      VALUES (?,?,?,?,?,?,1)
    `);
    for (const [productId, rows] of byProduct) {
      if (!hasActiveMatrixVariants(db, productId)) continue;
      const wanted = variantLinesForProduct(db, productId, session.warehouse_id);
      const have = new Set(rows.filter((r) => r.variant_id).map((r) => r.variant_id));
      for (const line of wanted) {
        if (have.has(line.variant_id)) continue;
        const sys = round3(line.system_qty);
        ins.run(session.id, productId, line.variant_id, sys, sys, sys);
        added += 1;
      }
      for (const row of rows) {
        if (row.variant_id) continue;
        db.prepare('DELETE FROM stocktaking_items WHERE id=?').run(row.id);
        replaced += 1;
      }
    }
  });
  run();
  return { replaced, added };
}

function applyCycleCount(db, sessionId, { createdBy } = {}) {
  const session = db.prepare('SELECT * FROM stocktaking_sessions WHERE id=?').get(sessionId);
  if (!session) throw invErr('E_STK_NOT_FOUND', 404);
  if (session.status === 'adjusted') throw invErr('E_STK_ALREADY', 409);

  syncSessionVariantLines(db, session.id);
  const items = db.prepare('SELECT * FROM stocktaking_items WHERE session_id=?').all(session.id);
  let totalGainRial = 0;
  let totalLossRial = 0;
  const lineBuckets = new Map(); // acctCode -> {gain, loss, name}

  function bucket(whId) {
    const a = inventoryAccountForWarehouse(db, whId);
    const key = a.code;
    if (!lineBuckets.has(key)) lineBuckets.set(key, { code: a.code, name: a.name, gain: 0, loss: 0 });
    return lineBuckets.get(key);
  }

  db.transaction(() => {
    // Claim apply inside TX — concurrent second apply loses the race.
    const claimed = db.prepare(`
      UPDATE stocktaking_sessions SET status='adjusted'
      WHERE id=? AND COALESCE(status,'')<>'adjusted'
    `).run(session.id);
    if (!claimed.changes) throw invErr('E_STK_ALREADY', 409);
    try {
      const { assertJournalIdempotent } = require('../sales-document');
      assertJournalIdempotent(db, 'stocktaking', session.id);
    } catch (e) {
      if (e && e.code === 'E_JE_DUPLICATE') throw invErr('E_STK_ALREADY', 409);
      throw e;
    }

    const { postApparelLines } = require('./apparel-lines');
    const variantGroups = new Map();
    function bookHeader(productId, diff, note) {
      if (!diff) return null;
      const prod = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
      if (!prod) return null;
      const { productUnitCostRial } = require('./product-unit-cost');
      const unit = productUnitCostRial(prod);
      if (!unit) {
        throw invErr('E_STK_ZERO_COST', 422, {
          productId,
          message: 'برای اختلاف انبارگردانی باید بهای واحد کالا صفر نباشد',
        });
      }
      const amount = Math.round(Math.abs(diff) * unit);
      const led = postInventoryMovement(db, {
        eventType: 'cycle_count',
        productId,
        warehouseId: session.warehouse_id,
        qty: diff,
        unitCostRial: unit,
        amountRial: amount,
        sourceType: 'stocktaking',
        sourceId: session.id,
        date: session.date || '',
        note,
        createdBy,
        updateAvg: diff > 0,
      });
      const b = bucket(session.warehouse_id);
      if (diff > 0) {
        totalGainRial += amount;
        b.gain += amount;
      } else {
        totalLossRial += amount;
        b.loss += amount;
      }
      return { led, unit, amount };
    }

    // Re-snapshot system_qty at apply time (variance vs live books, not session start).
    const { variantWarehouseQty } = require('./movement');
    for (const it of items) {
      let liveSystem;
      if (it.variant_id) {
        liveSystem = variantWarehouseQty(db, it.variant_id, session.warehouse_id);
      } else {
        liveSystem = warehouseQty(db, it.product_id, session.warehouse_id);
      }
      db.prepare('UPDATE stocktaking_items SET system_qty=? WHERE id=?').run(liveSystem, it.id);
      it.system_qty = liveSystem;
    }

    for (const it of items) {
      const counted = Math.max(0, parseQty(it.counted_qty));
      const system = Number(it.system_qty) || 0;
      const diff = counted - system;
      if (it.variant_id) {
        if (!variantGroups.has(it.product_id)) variantGroups.set(it.product_id, []);
        variantGroups.get(it.product_id).push({ it, counted, diff });
        continue;
      }
      if (diff === 0) continue;
      const booked = bookHeader(it.product_id, diff, `انبارگردانی #${session.id}`);
      if (!booked) continue;
      db.prepare(`
        UPDATE stocktaking_items SET unit_cost_rial=?, amount_rial=?, ledger_id=? WHERE id=?
      `).run(booked.unit, booked.amount * Math.sign(diff), booked.led.id, it.id);
    }

    for (const [productId, rows] of variantGroups) {
      for (const row of rows) {
        if (!row.diff) continue;
        postApparelLines(db, {
          productId,
          warehouseId: session.warehouse_id,
          lines: [{ variantId: row.it.variant_id, qty: Math.abs(row.diff) }],
          docType: 'stocktaking_sku',
          docId: session.id,
          docLineStart: row.it.id,
          userId: createdBy,
          note: `انبارگردانی #${session.id}`,
          sign: row.diff > 0 ? 1 : -1,
          allowNegative: false,
        });
      }
      const countedSum = rows.reduce((acc, row) => acc + row.counted, 0);
      const systemSum = rows.reduce((acc, row) => acc + (Number(row.it.system_qty) || 0), 0);
      const untouched = rows.every((row) => Math.abs(row.counted - (Number(row.it.system_qty) || 0)) < 0.001);
      const ws = db.prepare(
        'SELECT qty FROM warehouse_stock WHERE product_id=? AND warehouse_id=?'
      ).get(productId, session.warehouse_id);
      let headerQty = ws ? Number(ws.qty) || 0 : 0;
      if (!ws) {
        const anyWh = db.prepare('SELECT COUNT(*) c FROM warehouse_stock WHERE product_id=?').get(productId).c;
        const owned = db.prepare('SELECT stock, warehouse_id FROM products WHERE id=?').get(productId);
        if (!anyWh && owned) {
          headerQty = Number(owned.stock) || 0;
          db.prepare(
            'INSERT INTO warehouse_stock (product_id, warehouse_id, qty) VALUES (?,?,?)'
          ).run(productId, session.warehouse_id, headerQty);
        } else if (owned && owned.warehouse_id === session.warehouse_id) {
          headerQty = Number(owned.stock) || 0;
        }
      }
      let headerDiff = countedSum - headerQty;
      if (untouched && Math.abs(systemSum - headerQty) > 0.001) headerDiff = 0;
      const booked = bookHeader(productId, headerDiff, `انبارگردانی رنگ×سایز #${session.id}`);
      if (booked) {
        db.prepare(`
          UPDATE stocktaking_items SET unit_cost_rial=?, amount_rial=?, ledger_id=? WHERE id=?
        `).run(booked.unit, booked.amount * Math.sign(headerDiff), booked.led.id, rows[0].it.id);
      }
    }

    let jeId = null;
    if (totalGainRial > 0 || totalLossRial > 0) {
      const gainAcct = (() => {
        try { return acct(db, 'coa_inventory_gain'); }
        catch { return { code: '4205', name: 'اضافی انبارگردانی' }; }
      })();
      const lossAcct = (() => {
        try { return acct(db, 'coa_inventory_loss'); }
        catch { return { code: '6108', name: 'کسری و ضایعات انبار' }; }
      })();

      const lines = [];
      for (const b of lineBuckets.values()) {
        if (b.gain > 0) {
          lines.push({ code: b.code, name: b.name, debit: b.gain / 10, credit: 0, description: 'اضافی انبارگردانی' });
          lines.push({ code: gainAcct.code, name: gainAcct.name, debit: 0, credit: b.gain / 10, description: 'اضافی انبارگردانی' });
        }
        if (b.loss > 0) {
          lines.push({ code: lossAcct.code, name: lossAcct.name, debit: b.loss / 10, credit: 0, description: 'کسری انبارگردانی' });
          lines.push({ code: b.code, name: b.name, debit: 0, credit: b.loss / 10, description: 'کسری انبارگردانی' });
        }
      }

      if (lines.length) {
        let whCc = null;
        try {
          const { warehouseCostCenterId } = require('../cost-center-policy');
          whCc = warehouseCostCenterId(db, session.warehouse_id);
        } catch (_) { whCc = null; }
        jeId = postToLedger(db, {
          sourceType: 'stocktaking',
          sourceId: session.id,
          date: session.date || '',
          description: `سند انبارگردانی #${session.id}`,
          createdBy,
          costCenterId: whCc,
          warehouseId: session.warehouse_id,
          lines,
        });
        db.prepare('UPDATE inventory_ledger SET je_id=? WHERE source_type=? AND source_id=?')
          .run(jeId, 'stocktaking', session.id);
      }
    }

    db.prepare(`
      UPDATE stocktaking_sessions
      SET status='adjusted', approved_by=?, approved_at=strftime('%s','now'),
          je_id=?, total_gain_rial=?, total_loss_rial=?
      WHERE id=?
    `).run(createdBy, jeId, totalGainRial, totalLossRial, session.id);
  })();

  return {
    ok: true,
    total_gain_rial: totalGainRial,
    total_loss_rial: totalLossRial,
  };
}

/** Full reverse of an applied stocktaking (R13): inventory ledgers + JE + session → completed. */
function voidCycleCount(db, sessionId, { createdBy } = {}) {
  const session = db.prepare('SELECT * FROM stocktaking_sessions WHERE id=?').get(sessionId);
  if (!session) throw invErr('E_STK_NOT_FOUND', 404);
  if (session.status !== 'adjusted') {
    const err = new Error('فقط انبارگردانی اعمال‌شده قابل ابطال است');
    err.status = 400;
    throw err;
  }

  db.transaction(() => {
    const leds = db.prepare(`
      SELECT id FROM inventory_ledger
      WHERE source_type='stocktaking' AND source_id=? AND COALESCE(status,'posted')='posted'
      ORDER BY id DESC
    `).all(session.id);
    for (const l of leds) {
      reverseInventoryMovement(db, l.id, {
        createdBy,
        date: todayJalali(),
        note: `ابطال انبارگردانی #${session.id}`,
      });
    }
    require('./apparel-lines').reverseApparelDoc(db, {
      docType: 'stocktaking_sku',
      docId: session.id,
      userId: createdBy,
      note: `ابطال انبارگردانی #${session.id}`,
    });
    if (session.je_id) {
      reverseJournalEntry(db, session.je_id, {
        userId: createdBy,
        reason: `ابطال انبارگردانی #${session.id}`,
        sourceType: 'stocktaking_reversal',
      });
    }
    db.prepare(`
      UPDATE stocktaking_items SET ledger_id=NULL, unit_cost_rial=NULL, amount_rial=NULL WHERE session_id=?
    `).run(session.id);
    db.prepare(`
      UPDATE stocktaking_sessions
      SET status='completed', je_id=NULL, total_gain_rial=0, total_loss_rial=0,
          approved_by=NULL, approved_at=NULL
      WHERE id=?
    `).run(session.id);
  })();

  return { ok: true };
}

module.exports = {
  applyCycleCount,
  voidCycleCount,
  syncSessionVariantLines,
  variantLinesForProduct,
};
