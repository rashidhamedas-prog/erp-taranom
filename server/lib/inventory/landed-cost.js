'use strict';
/**
 * Landed cost — allocate freight/customs/insurance onto inventory layers.
 * Posts inventory_ledger event_type=landed_cost (value-only, qty 0 via amount bump).
 * Accounting: Dr Inventory / Cr Payable or Cash (counterpart).
 */
const { acct } = require('../coa-map');
const { postToLedger } = require('../ledger');
const { postInventoryMovement, invErr } = require('./ledger');
const { applyCostLayerIn } = require('./costing');

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
 * allocations: [{product_id, warehouse_id, qty, base_value_rial}]
 * Method: value | qty | weight | volume | manual (manual uses allocated_rial on each row)
 */
function allocateAndPost(db, docId, allocations, { createdBy, counterpartAcctKey = 'coa_payable', date } = {}) {
  const doc = db.prepare('SELECT * FROM landed_cost_docs WHERE id=?').get(docId);
  if (!doc) throw invErr('E_LC_NOT_FOUND', 404);
  if (doc.status === 'posted') throw invErr('E_LC_ALREADY_POSTED', 409);

  const total = Math.round(Number(doc.total_cost_rial) || 0);
  if (total <= 0) throw invErr('E_LC_ZERO', 400);
  if (!Array.isArray(allocations) || !allocations.length) throw invErr('E_LC_ALLOC', 400);

  const method = doc.alloc_method || 'value';
  let baseSum = 0;
  for (const a of allocations) {
    if (method === 'qty') baseSum += Number(a.qty) || 0;
    else if (method === 'manual') baseSum += Math.round(Number(a.allocated_rial) || 0);
    else baseSum += Math.round(Number(a.base_value_rial) || 0);
  }
  if (method !== 'manual' && baseSum <= 0) throw invErr('E_LC_BASE', 400);

  const results = [];
  let allocatedSum = 0;
  const invAcct = acct(db, 'coa_inventory');
  const ctrAcct = acct(db, counterpartAcctKey);

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
      // Rounding plug on last line
      if (i === allocations.length - 1) share = total - allocatedSum;
      allocatedSum += share;

      // Value-only inventory bump: qty_in=0 not allowed — use tiny qty path via amount on existing stock
      // We post a ledger line with qty_in=0 conceptually by updating avg without qty change:
      const prod = db.prepare('SELECT stock, average_cost_rial FROM products WHERE id=?').get(a.product_id);
      if (!prod) throw invErr('E_PRODUCT_NOT_FOUND', 404, { productId: a.product_id });
      const stock = Number(prod.stock) || 0;
      const prevAvg = Math.round(Number(prod.average_cost_rial) || 0);
      const newAvg = stock > 0 ? Math.round((stock * prevAvg + share) / stock) : prevAvg;
      db.prepare('UPDATE products SET average_cost_rial=?, cost=? WHERE id=?')
        .run(newAvg, newAvg / 10, a.product_id);

      applyCostLayerIn(db, {
        productId: a.product_id,
        warehouseId: a.warehouse_id || null,
        qty: Number(a.qty) || 0 || 0.0001,
        unitCostRial: share,
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
    }

    // JE: Dr Inventory / Cr Payable (toman for postToLedger)
    const jeId = postToLedger(db, {
      sourceType: 'landed_cost',
      sourceId: docId,
      date: date || doc.date,
      description: `هزینه‌های جانبی خرید ${doc.doc_no}`,
      createdBy,
      lines: [
        { code: invAcct.code, name: invAcct.name, debit: total / 10, credit: 0, description: 'تسهیم هزینه حمل' },
        { code: ctrAcct.code, name: ctrAcct.name, debit: 0, credit: total / 10, description: 'بدهی هزینه حمل' },
      ],
    });

    db.prepare("UPDATE landed_cost_docs SET status='posted', je_id=? WHERE id=?").run(jeId, docId);
    db.prepare('UPDATE inventory_ledger SET je_id=? WHERE source_type=? AND source_id=?')
      .run(jeId, 'landed_cost', docId);
  })();

  return { doc: db.prepare('SELECT * FROM landed_cost_docs WHERE id=?').get(docId), allocations: results };
}

module.exports = { createLandedCostDoc, allocateAndPost };
