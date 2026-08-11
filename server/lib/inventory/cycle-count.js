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
    for (const it of items) {
      const counted = Math.max(0, parseQty(it.counted_qty));
      const system = Number(it.system_qty) || 0;
      const diff = counted - system;
      if (diff === 0) continue;

      const prod = db.prepare('SELECT * FROM products WHERE id=?').get(it.product_id);
      if (!prod) continue;
      const unit = Math.round(Number(prod.average_cost_rial) || 0)
        || Math.round((Number(prod.cost) || 0) * 10);
      const amount = Math.round(Math.abs(diff) * unit);

      const led = postInventoryMovement(db, {
        eventType: 'cycle_count',
        productId: it.product_id,
        warehouseId: session.warehouse_id,
        qty: diff,
        unitCostRial: unit,
        amountRial: amount,
        sourceType: 'stocktaking',
        sourceId: session.id,
        date: session.date || '',
        note: `انبارگردانی #${session.id}`,
        createdBy,
        updateAvg: diff > 0,
      });

      db.prepare(`
        UPDATE stocktaking_items SET unit_cost_rial=?, amount_rial=?, ledger_id=? WHERE id=?
      `).run(unit, amount * Math.sign(diff), led.id, it.id);

      const b = bucket(session.warehouse_id);
      if (diff > 0) {
        totalGainRial += amount;
        b.gain += amount;
      } else {
        totalLossRial += amount;
        b.loss += amount;
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
