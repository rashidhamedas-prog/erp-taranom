'use strict';
/**
 * Cycle count / stocktaking apply with accounting integrity (R9 acct, R1 rial, R8 txn).
 * Replaces hard-coded 1101/5101 in routes/stocktaking.js apply path.
 */
const { acct } = require('../coa-map');
const { postToLedger } = require('../ledger');
const { postInventoryMovement, reverseInventoryMovement, inventoryAccountForWarehouse, invErr } = require('./ledger');
const { parseQty } = require('../round3');
const { reverseJournalEntry } = require('../void-journal');
const { todayJalali } = require('../../jalali');

function applyCycleCount(db, sessionId, { createdBy } = {}) {
  const session = db.prepare('SELECT * FROM stocktaking_sessions WHERE id=?').get(sessionId);
  if (!session) throw invErr('E_STK_NOT_FOUND', 404);
  if (session.status === 'adjusted') throw invErr('E_STK_ALREADY', 409);

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
    const { postApparelLines } = require('./apparel-lines');
    const variantGroups = new Map();
    function bookHeader(productId, diff, note) {
      if (!diff) return null;
      const prod = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
      if (!prod) return null;
      const unit = Math.round(Number(prod.average_cost_rial) || 0)
        || Math.round((Number(prod.cost) || 0) * 10);
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
      const headerDiff = countedSum - headerQty;
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
        jeId = postToLedger(db, {
          sourceType: 'stocktaking',
          sourceId: session.id,
          date: session.date || '',
          description: `سند انبارگردانی #${session.id}`,
          createdBy,
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

module.exports = { applyCycleCount, voidCycleCount };
