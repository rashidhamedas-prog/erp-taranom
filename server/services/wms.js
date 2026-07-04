// WMS core: per-warehouse stock, receipts/issues/transfers, and Moving Average Cost.
// products.stock is kept in sync as the aggregate across warehouses so all legacy
// flows (invoice stock check, low-stock alerts, catalog) keep working unchanged.
const { createJournalEntry } = require('../db');

function getDefaultWarehouse(db, tenantId) {
  let wh = db.prepare('SELECT * FROM warehouses WHERE tenant_id=? AND is_default=1').get(tenantId);
  if (!wh) wh = db.prepare('SELECT * FROM warehouses WHERE tenant_id=? ORDER BY id LIMIT 1').get(tenantId);
  return wh;
}

function totalStock(db, productId) {
  return db.prepare('SELECT COALESCE(SUM(qty),0) s FROM warehouse_stock WHERE product_id=?').get(productId).s;
}

function syncProductTotal(db, tenantId, productId) {
  const total = totalStock(db, productId);
  db.prepare('UPDATE products SET stock=? WHERE id=? AND tenant_id=?').run(total, productId, tenantId);
  return total;
}

function bumpWarehouseStock(db, warehouseId, productId, delta) {
  db.prepare(`
    INSERT INTO warehouse_stock (warehouse_id, product_id, qty) VALUES (?,?,?)
    ON CONFLICT(warehouse_id, product_id) DO UPDATE SET qty = qty + excluded.qty
  `).run(warehouseId, productId, delta);
}

// Weighted moving average: recalculated after every receipt.
// new_mac = (on_hand_qty × current_mac + received_qty × unit_cost) / (on_hand_qty + received_qty)
function recalcMAC(db, tenantId, productId, receiptQty, unitCost) {
  const prod = db.prepare('SELECT stock, mac_cost FROM products WHERE id=? AND tenant_id=?').get(productId, tenantId);
  if (!prod) return 0;
  const onHand = Math.max(0, prod.stock || 0);
  const oldMac = prod.mac_cost || 0;
  const denom = onHand + receiptQty;
  const newMac = denom > 0 ? ((onHand * oldMac) + (receiptQty * unitCost)) / denom : unitCost;
  db.prepare('UPDATE products SET mac_cost=? WHERE id=? AND tenant_id=?').run(newMac, productId, tenantId);
  return newMac;
}

// Goods receipt (purchase/production/transfer-in/initial). Recalculates MAC, keeps a cost layer.
function addReceipt(db, { tenantId, warehouseId, productId, qty, unitCost, ref = 'purchase', refId = null, note = '', date = '', userId = null, skipJournal = false }) {
  const wh = db.prepare('SELECT * FROM warehouses WHERE id=? AND tenant_id=?').get(warehouseId, tenantId);
  if (!wh) throw new Error('انبار یافت نشد');
  const prod = db.prepare('SELECT * FROM products WHERE id=? AND tenant_id=?').get(productId, tenantId);
  if (!prod) throw new Error('محصول یافت نشد');
  qty = parseInt(qty);
  unitCost = parseFloat(unitCost) || 0;
  if (!qty || qty <= 0) throw new Error('مقدار رسید باید بزرگ‌تر از صفر باشد');

  const tx = db.transaction(() => {
    // MAC first (uses pre-receipt on-hand), except pure inter-warehouse movements
    let mac = prod.mac_cost || 0;
    if (ref !== 'transfer_in') mac = recalcMAC(db, tenantId, productId, qty, unitCost);
    const r = db.prepare(
      'INSERT INTO warehouse_receipts (tenant_id,warehouse_id,product_id,qty,unit_cost,ref,note,date,created_by) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(tenantId, warehouseId, productId, qty, unitCost, ref, note, date, userId);
    if (ref !== 'transfer_in') {
      db.prepare('INSERT INTO inventory_cost_layers (product_id,receipt_id,qty_remaining,unit_cost) VALUES (?,?,?,?)')
        .run(productId, r.lastInsertRowid, qty, unitCost);
    }
    bumpWarehouseStock(db, warehouseId, productId, qty);
    syncProductTotal(db, tenantId, productId);
    db.prepare('INSERT INTO stock_logs (tenant_id,product_id,user_id,change,note) VALUES (?,?,?,?,?)')
      .run(tenantId, productId, userId || 0, qty, `رسید انبار ${wh.name} (${ref})${note ? ' - ' + note : ''}`);
    // Inventory journal: Dr 1104 inventory / Cr 2101 payables — value received into stock
    if (!skipJournal && ref !== 'transfer_in' && unitCost > 0) {
      createJournalEntry(db, {
        tenant_id: tenantId, date, description: `رسید انبار ${wh.name} - ${prod.name} (${qty} ${prod.unit || 'عدد'})`,
        ref_type: 'warehouse_receipt', ref_id: r.lastInsertRowid, created_by: userId,
        lines: [
          { code: '1104', name: 'موجودی کالا', debit: qty * unitCost, credit: 0 },
          { code: '2101', name: 'حساب‌های پرداختنی', debit: 0, credit: qty * unitCost }
        ]
      });
    }
    return { receiptId: r.lastInsertRowid, mac };
  });
  return tx();
}

// Consume FIFO layers for traceability (costing itself is MAC-based)
function consumeLayers(db, productId, qty) {
  const layers = db.prepare('SELECT * FROM inventory_cost_layers WHERE product_id=? AND qty_remaining>0 ORDER BY created_at, id').all(productId);
  let remaining = qty;
  for (const layer of layers) {
    if (remaining <= 0) break;
    const take = Math.min(layer.qty_remaining, remaining);
    db.prepare('UPDATE inventory_cost_layers SET qty_remaining=qty_remaining-? WHERE id=?').run(take, layer.id);
    remaining -= take;
  }
}

// Goods issue (sale/waste/internal/transfer-out) at current MAC.
function addIssue(db, { tenantId, warehouseId, productId, qty, ref = 'sale', refId = null, note = '', date = '', userId = null, allowNegative = false }) {
  const wh = db.prepare('SELECT * FROM warehouses WHERE id=? AND tenant_id=?').get(warehouseId, tenantId);
  if (!wh) throw new Error('انبار یافت نشد');
  const prod = db.prepare('SELECT * FROM products WHERE id=? AND tenant_id=?').get(productId, tenantId);
  if (!prod) throw new Error('محصول یافت نشد');
  qty = parseInt(qty);
  if (!qty || qty <= 0) throw new Error('مقدار حواله باید بزرگ‌تر از صفر باشد');

  const cur = db.prepare('SELECT COALESCE(qty,0) qty FROM warehouse_stock WHERE warehouse_id=? AND product_id=?').get(warehouseId, productId);
  if (!allowNegative && (!cur || cur.qty < qty)) {
    throw new Error(`موجودی ${prod.name} در انبار ${wh.name} کافی نیست (موجود: ${cur ? cur.qty : 0})`);
  }

  const mac = prod.mac_cost || 0;
  const tx = db.transaction(() => {
    const r = db.prepare(
      'INSERT INTO warehouse_issues (tenant_id,warehouse_id,product_id,qty,unit_cost,ref,ref_id,note,date,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(tenantId, warehouseId, productId, qty, mac, ref, refId, note, date, userId);
    bumpWarehouseStock(db, warehouseId, productId, -qty);
    syncProductTotal(db, tenantId, productId);
    if (ref !== 'transfer_out') consumeLayers(db, productId, qty);
    db.prepare('INSERT INTO stock_logs (tenant_id,product_id,user_id,change,note) VALUES (?,?,?,?,?)')
      .run(tenantId, productId, userId || 0, -qty, `حواله انبار ${wh.name} (${ref})${note ? ' - ' + note : ''}`);
    // Waste/internal use hits expenses at MAC. Sales COGS is booked by the invoice engine.
    if ((ref === 'waste' || ref === 'internal') && mac > 0) {
      createJournalEntry(db, {
        tenant_id: tenantId, date, description: `حواله ${ref === 'waste' ? 'ضایعات' : 'مصرف داخلی'} - ${prod.name} (${qty} ${prod.unit || 'عدد'})`,
        ref_type: 'warehouse_issue', ref_id: r.lastInsertRowid, created_by: userId,
        lines: [
          { code: '6102', name: 'هزینه‌های عمومی و اداری', debit: qty * mac, credit: 0 },
          { code: '1104', name: 'موجودی کالا', debit: 0, credit: qty * mac }
        ]
      });
    }
    return { issueId: r.lastInsertRowid, mac };
  });
  return tx();
}

// Inter-warehouse transfer: paired issue/receipt documents + transfer record
function transfer(db, { tenantId, fromWarehouseId, toWarehouseId, productId, qty, date = '', note = '', userId = null }) {
  if (Number(fromWarehouseId) === Number(toWarehouseId)) throw new Error('انبار مبدأ و مقصد یکسان است');
  const tx = db.transaction(() => {
    addIssue(db, { tenantId, warehouseId: fromWarehouseId, productId, qty, ref: 'transfer_out', note: note || 'انتقال بین انبار', date, userId });
    const prod = db.prepare('SELECT mac_cost FROM products WHERE id=? AND tenant_id=?').get(productId, tenantId);
    addReceipt(db, { tenantId, warehouseId: toWarehouseId, productId, qty, unitCost: prod ? prod.mac_cost : 0, ref: 'transfer_in', note: note || 'انتقال بین انبار', date, userId, skipJournal: true });
    const t = db.prepare(
      'INSERT INTO warehouse_transfers (tenant_id,from_warehouse_id,to_warehouse_id,product_id,qty,date,note,created_by) VALUES (?,?,?,?,?,?,?,?)'
    ).run(tenantId, fromWarehouseId, toWarehouseId, productId, qty, date, note, userId);
    return { transferId: t.lastInsertRowid };
  });
  return tx();
}

// Sale deduction: split the quantity across warehouses (default first) until covered.
// Caller must have verified the aggregate stock; throws if the total is insufficient.
function issueForSale(db, { tenantId, productId, qty, refId = null, note = '', date = '', userId = null }) {
  const warehouses = db.prepare('SELECT * FROM warehouses WHERE tenant_id=? ORDER BY is_default DESC, id').all(tenantId);
  let remaining = parseInt(qty);
  const plan = [];
  for (const wh of warehouses) {
    if (remaining <= 0) break;
    const cur = db.prepare('SELECT COALESCE(qty,0) qty FROM warehouse_stock WHERE warehouse_id=? AND product_id=?').get(wh.id, productId);
    const avail = cur ? cur.qty : 0;
    if (avail <= 0) continue;
    const take = Math.min(avail, remaining);
    plan.push({ warehouseId: wh.id, take });
    remaining -= take;
  }
  if (remaining > 0) {
    const prod = db.prepare('SELECT name FROM products WHERE id=? AND tenant_id=?').get(productId, tenantId);
    throw new Error(`موجودی ${prod ? prod.name : productId} در انبارها کافی نیست`);
  }
  const tx = db.transaction(() => {
    for (const step of plan) {
      addIssue(db, { tenantId, warehouseId: step.warehouseId, productId, qty: step.take, ref: 'sale', refId, note, date, userId });
    }
  });
  tx();
}

// Restore stock into the default warehouse when a final invoice is deleted.
// Receipt at current MAC keeps the average unchanged; the invoice engine books the COGS reversal.
function restoreForSale(db, { tenantId, productId, qty, refId = null, note = '', date = '', userId = null }) {
  const wh = getDefaultWarehouse(db, tenantId);
  if (!wh) return;
  const prod = db.prepare('SELECT mac_cost FROM products WHERE id=? AND tenant_id=?').get(productId, tenantId);
  addReceipt(db, {
    tenantId, warehouseId: wh.id, productId, qty,
    unitCost: prod ? (prod.mac_cost || 0) : 0,
    ref: 'sale_return', refId, note, date, userId, skipJournal: true,
  });
}

module.exports = { getDefaultWarehouse, addReceipt, addIssue, transfer, syncProductTotal, recalcMAC, issueForSale, restoreForSale };
