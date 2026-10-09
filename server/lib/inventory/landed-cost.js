'use strict';
/**
 * Landed cost — allocate freight/customs/insurance onto inventory layers.
 * Posts inventory_ledger event_type=landed_cost (value-only).
 * Accounting: Dr Inventory / Cr Payable or Cash (counterpart).
 * R13: voidLandedCost reverses JE + avg + ledger.
 */
const { acct } = require('../coa-map');
const { postToLedger } = require('../ledger');
const {
  postInventoryMovement, reverseInventoryMovement, invErr,
  inventoryAccountForWarehouse, inventoryAmountLinesByWarehouse,
} = require('./ledger');
const { reverseJournalEntry } = require('../void-journal');

function nextDocNo(db) {
  try {
    const { allocateNumber } = require('../../db');
    return allocateNumber(db, 'landed_cost', 'LC');
  } catch (_) {
    return 'LC-' + Date.now().toString(36).toUpperCase();
  }
}

function createLandedCostDoc(db, {
  purchaseId = null, date, allocMethod = 'value', note = '', createdBy = null, lines = [],
}) {
  const no = nextDocNo(db);
  const r = db.prepare(`
    INSERT INTO landed_cost_docs (doc_no, purchase_id, date, alloc_method, status, note, created_by)
    VALUES (?,?,?,?,'draft',?,?)
  `).run(no, purchaseId, date || '', allocMethod, note || '', createdBy);
  const docId = r.lastInsertRowid;
  const ins = db.prepare(`
    INSERT INTO landed_cost_lines (doc_id, cost_type, amount_rial, note) VALUES (?,?,?,?)
  `);
  let total = 0;
  for (const ln of lines) {
    const amt = Math.round(Number(ln.amount_rial) || 0);
    if (amt <= 0) continue;
    ins.run(docId, ln.cost_type || 'freight', amt, ln.note || '');
    total += amt;
  }
  db.prepare('UPDATE landed_cost_docs SET total_cost_rial=? WHERE id=?').run(total, docId);
  return db.prepare('SELECT * FROM landed_cost_docs WHERE id=?').get(docId);
}

/**
 * Spread landed value across open cost layers without inventing phantom qty.
 * unit_cost_rial = amount / qty_remaining after bump.
 */
function bumpOpenLayersValue(db, {
  productId, warehouseId = null, amountRial, sourceType = 'landed_cost', sourceId = null,
}) {
  const share = Math.round(Number(amountRial) || 0);
  if (share <= 0) return;
  let sql = `
    SELECT * FROM inventory_cost_layers
    WHERE product_id=? AND status='open' AND qty_remaining>0
  `;
  const params = [productId];
  if (warehouseId != null) {
    sql += ' AND (warehouse_id=? OR warehouse_id IS NULL)';
    params.push(warehouseId);
  }
  sql += ' ORDER BY id ASC';
  const layers = db.prepare(sql).all(...params);
  if (!layers.length) return;
  const qtySum = layers.reduce((a, l) => a + (Number(l.qty_remaining) || 0), 0);
  if (qtySum <= 0) return;
  let left = share;
  const upd = db.prepare(`
    UPDATE inventory_cost_layers SET amount_rial=?, unit_cost_rial=? WHERE id=?
  `);
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const q = Number(layer.qty_remaining) || 0;
    let part = i === layers.length - 1
      ? left
      : Math.round(share * (q / qtySum));
    left -= part;
    const newAmt = Math.round(Number(layer.amount_rial) || 0) + part;
    const newUnit = q > 0 ? Math.round(newAmt / q) : Math.round(Number(layer.unit_cost_rial) || 0);
    upd.run(newAmt, newUnit, layer.id);
  }
  void sourceType;
  void sourceId;
}

/**
 * allocations: [{product_id, warehouse_id, qty, base_value_rial}]
 * Method: value | qty | weight | volume | manual (manual uses allocated_rial on each row)
 */
function allocateAndPost(db, docId, allocations, { createdBy, counterpartAcctKey = 'coa_payable', date } = {}) {
  const doc = db.prepare('SELECT * FROM landed_cost_docs WHERE id=?').get(docId);
  if (!doc) throw invErr('E_LC_NOT_FOUND', 404);
  if (doc.status === 'posted') throw invErr('E_LC_ALREADY_POSTED', 409);
  if (doc.status === 'reversed') throw invErr('E_LC_REVERSED', 409);

  const total = Math.round(Number(doc.total_cost_rial) || 0);
  if (total <= 0) throw invErr('E_LC_ZERO', 400);
  if (!Array.isArray(allocations) || !allocations.length) throw invErr('E_LC_ALLOC', 400);

  const method = doc.alloc_method || 'value';
  let baseSum = 0;
  for (const a of allocations) {
    if (method === 'qty') baseSum += Number(a.qty) || 0;
    else if (method === 'manual') baseSum += Math.round(Number(a.allocated_rial) || 0);
    else baseSum += Math.round(Number(a.base_value_rial) || 0); // value | weight | volume fallback
  }
  if (method !== 'manual' && baseSum <= 0) throw invErr('E_LC_BASE', 400);

  const results = [];
  let allocatedSum = 0;
  const ctrAcct = acct(db, counterpartAcctKey);
  const shareByWh = [];

  db.transaction(() => {
    db.prepare('DELETE FROM landed_cost_allocations WHERE doc_id=?').run(docId);
    const ins = db.prepare(`
      INSERT INTO landed_cost_allocations
        (doc_id, product_id, warehouse_id, qty, base_value_rial, allocated_rial, ledger_id)
      VALUES (?,?,?,?,?,?,?)
    `);

    for (let i = 0; i < allocations.length; i++) {
      const a = allocations[i];
      let share;
      if (method === 'manual') {
        share = Math.round(Number(a.allocated_rial) || 0);
      } else {
        const base = method === 'qty'
          ? (Number(a.qty) || 0)
          : Math.round(Number(a.base_value_rial) || 0);
        share = Math.round(total * (base / baseSum));
      }
      if (i === allocations.length - 1) share = total - allocatedSum;
      allocatedSum += share;

      const prod = db.prepare('SELECT stock, average_cost_rial FROM products WHERE id=?').get(a.product_id);
      if (!prod) throw invErr('E_PRODUCT_NOT_FOUND', 404, { productId: a.product_id });
      const stock = Number(prod.stock) || 0;
      if (stock <= 0) {
        throw invErr('E_LC_NO_STOCK', 422, {
          productId: a.product_id,
          message: 'هزینه حمل فقط روی موجودی باقیمانده سرمایه می‌شود (IAS 2)',
        });
      }
      const prevAvg = Math.round(Number(prod.average_cost_rial) || 0);
      const newAvg = Math.round((stock * prevAvg + share) / stock);
      const { catalogCostFromAvgRial } = require('./product-unit-cost');
      db.prepare('UPDATE products SET average_cost_rial=?, cost=? WHERE id=?')
        .run(newAvg, catalogCostFromAvgRial(newAvg), a.product_id);

      bumpOpenLayersValue(db, {
        productId: a.product_id,
        warehouseId: a.warehouse_id || null,
        amountRial: share,
        sourceType: 'landed_cost',
        sourceId: docId,
      });

      const led = postInventoryMovement(db, {
        eventType: 'landed_cost',
        productId: a.product_id,
        warehouseId: a.warehouse_id || null,
        qtyIn: 0,
        qtyOut: 0,
        unitCostRial: share,
        amountRial: share,
        sourceType: 'landed_cost',
        sourceId: docId,
        date: date || doc.date,
        note: `هزینه حمل تسهیم‌شده — ${doc.doc_no}`,
        createdBy,
        updateAvg: false,
        skipStock: true,
        valueOnly: true,
      });

      let ledgerId = led?.id;
      if (!ledgerId) throw invErr('E_LC_LEDGER', 500);

      ins.run(docId, a.product_id, a.warehouse_id || null, Number(a.qty) || 0,
        Math.round(Number(a.base_value_rial) || 0), share, ledgerId);
      results.push({ product_id: a.product_id, allocated_rial: share, ledger_id: ledgerId });
      shareByWh.push({ warehouseId: a.warehouse_id || null, amountRial: share });
    }

    let invGroups = inventoryAmountLinesByWarehouse(db, shareByWh);
    if (!invGroups.length) {
      const fb = inventoryAccountForWarehouse(db, null);
      invGroups = [{ code: fb.code, name: fb.name, amountRial: total }];
    }
    const jeLines = invGroups.map((g) => ({
      code: g.code, name: g.name, debit: g.amountRial / 10, credit: 0, description: 'تسهیم هزینه حمل',
    }));
    jeLines.push({
      code: ctrAcct.code, name: ctrAcct.name, debit: 0, credit: total / 10, description: 'بدهی هزینه حمل',
    });
    const jeId = postToLedger(db, {
      sourceType: 'landed_cost',
      sourceId: docId,
      date: date || doc.date,
      description: `هزینه‌های جانبی خرید ${doc.doc_no}`,
      createdBy,
      lines: jeLines,
    });

    db.prepare("UPDATE landed_cost_docs SET status='posted', je_id=? WHERE id=?").run(jeId, docId);
    db.prepare('UPDATE inventory_ledger SET je_id=? WHERE source_type=? AND source_id=?')
      .run(jeId, 'landed_cost', docId);
  })();

  return { doc: db.prepare('SELECT * FROM landed_cost_docs WHERE id=?').get(docId), allocations: results };
}

function voidLandedCost(db, docId, { createdBy = null, reason = '' } = {}) {
  const doc = db.prepare('SELECT * FROM landed_cost_docs WHERE id=?').get(docId);
  if (!doc) throw invErr('E_LC_NOT_FOUND', 404);
  if (doc.status === 'reversed') throw invErr('E_LC_ALREADY_REVERSED', 409);
  if (doc.status !== 'posted') throw invErr('E_LC_NOT_POSTED', 409);

  db.transaction(() => {
    const allocs = db.prepare('SELECT * FROM landed_cost_allocations WHERE doc_id=?').all(docId);
    for (const a of allocs) {
      const share = Math.round(Number(a.allocated_rial) || 0);
      if (share <= 0) continue;
      const prod = db.prepare('SELECT stock, average_cost_rial FROM products WHERE id=?').get(a.product_id);
      if (!prod) continue;
      const stock = Number(prod.stock) || 0;
      if (stock > 0) {
        const prevAvg = Math.round(Number(prod.average_cost_rial) || 0);
        const newAvg = Math.max(0, Math.round((stock * prevAvg - share) / stock));
        const { catalogCostFromAvgRial } = require('./product-unit-cost');
        db.prepare('UPDATE products SET average_cost_rial=?, cost=? WHERE id=?')
          .run(newAvg, catalogCostFromAvgRial(newAvg), a.product_id);
      }
      bumpOpenLayersValue(db, {
        productId: a.product_id,
        warehouseId: a.warehouse_id || null,
        amountRial: -share,
        sourceType: 'landed_cost_void',
        sourceId: docId,
      });
    }

    const leds = db.prepare(`
      SELECT id FROM inventory_ledger
      WHERE source_type='landed_cost' AND source_id=? AND status='posted'
    `).all(docId);
    for (const led of leds) {
      reverseInventoryMovement(db, led.id, {
        createdBy,
        note: reason || `ابطال هزینه حمل ${doc.doc_no}`,
      });
    }

    if (doc.je_id) {
      reverseJournalEntry(db, doc.je_id, {
        userId: createdBy,
        reason: reason || `ابطال ${doc.doc_no}`,
        sourceType: 'landed_cost',
      });
    }
    db.prepare("UPDATE landed_cost_docs SET status='reversed' WHERE id=?").run(docId);
  })();

  return { ok: true, id: docId, status: 'reversed' };
}

module.exports = { createLandedCostDoc, allocateAndPost, voidLandedCost, bumpOpenLayersValue };
