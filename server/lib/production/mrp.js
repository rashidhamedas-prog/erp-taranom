'use strict';
/**
 * Production Module 5b — Simplified MRP (no ledger, no stock mutation)
 */
const { allocateNumber } = require('../../db');
const { todayJalali } = require('../../jalali');
const { explodeBom, resolveBom } = require('./bom');
const { backwardQty } = require('./bom-advanced');
const { err } = require('./posting');

function num(v) { return Number(v) || 0; }
function round6(n) { return Math.round(Number(n) * 1e6) / 1e6; }

function onHandQty(db, productId) {
  try {
    const ws = db.prepare(`
      SELECT COALESCE(SUM(ws.qty),0) q FROM warehouse_stock ws
      JOIN warehouses w ON w.id = ws.warehouse_id
      WHERE ws.product_id=? AND w.kind IN ('raw','general','packaging')
    `).get(productId);
    if (ws && num(ws.q) > 0) return num(ws.q);
  } catch { /* ignore */ }
  const p = db.prepare('SELECT stock FROM products WHERE id=?').get(productId);
  return num(p?.stock);
}

function reservedQty(db, productId) {
  try {
    const r = db.prepare(`
      SELECT COALESCE(SUM(qty - qty_consumed),0) q FROM production_reservations
      WHERE product_id=? AND status='active'
    `).get(productId);
    return num(r?.q);
  } catch {
    return 0;
  }
}

function collectDemand(db, { horizonDays = 30, date } = {}) {
  const rows = [];
  try {
    const orders = db.prepare(`
      SELECT id, product_id, qty_planned, date FROM production_orders
      WHERE status IN ('draft','released','in_progress')
    `).all();
    for (const o of orders) {
      rows.push({
        source: 'production_order',
        source_id: o.id,
        product_id: o.product_id,
        qty: num(o.qty_planned),
        date: o.date,
      });
    }
  } catch { /* ignore */ }

  try {
    const sos = db.prepare(`
      SELECT id, product_id, qty, date FROM orders
      WHERE status NOT IN ('cancelled','done') AND product_id IS NOT NULL
    `).all();
    for (const o of sos) {
      rows.push({
        source: 'sales_order',
        source_id: o.id,
        product_id: o.product_id,
        qty: num(o.qty),
        date: o.date || date,
      });
    }
  } catch { /* orders table may differ */ }

  return rows;
}

function mrpRun(db, { horizonDays = 30, date, userId, demandSource = 'orders' } = {}) {
  return db.transaction(() => {
    const runDate = date || todayJalali();
    let code = '';
    try { code = allocateNumber(db, 'mrp_run', 'MRP'); }
    catch { code = `MRP-${Date.now()}`; }

    const runId = db.prepare(`
      INSERT INTO mrp_runs
        (code, run_type, horizon_days, demand_source, status, date, created_by)
      VALUES (?,?,?,?,'running',?,?)
    `).run(code, 'net', Number(horizonDays) || 30, demandSource, runDate, userId || null)
      .lastInsertRowid;

    const demand = collectDemand(db, { horizonDays, date: runDate });
    const needMap = new Map();

    for (const d of demand) {
      if (!d.product_id || d.qty <= 0) continue;
      let bom;
      try {
        bom = resolveBom(db, { productId: d.product_id, date: runDate });
      } catch {
        continue;
      }
      const qtyStart = bom.has_routing
        ? backwardQty(db, bom.id, d.qty).qty_start
        : d.qty;
      const ex = explodeBom(db, {
        bomId: bom.id,
        qty: qtyStart,
        priceBasis: 'average',
        yieldOverride: bom.has_routing ? 100 : null,
      });
      for (const L of ex.lines) {
        const key = L.product_id;
        needMap.set(key, (needMap.get(key) || 0) + L.qty_final);
      }
    }

    let shortageCount = 0;
    const ins = db.prepare(`
      INSERT INTO mrp_requirements
        (run_id, product_id, gross_req_qty, on_hand_qty, reserved_qty, net_req_qty,
         suggested_qty, action, need_by_date)
      VALUES (?,?,?,?,?,?,?,?,?)
    `);

    for (const [productId, grossQty] of needMap) {
      const onHand = onHandQty(db, productId);
      const reserved = reservedQty(db, productId);
      const available = onHand - reserved;
      const shortage = Math.max(0, round6(grossQty - available));
      const action = shortage > 0 ? 'purchase' : 'none';
      if (shortage > 0) shortageCount++;

      ins.run(
        runId, productId, round6(grossQty), onHand, reserved,
        round6(Math.max(0, grossQty - reserved)), shortage, action, runDate
      );
    }

    db.prepare(`
      UPDATE mrp_runs SET status='completed', total_shortage_items=?
      WHERE id=?
    `).run(shortageCount, runId);

    const requirements = db.prepare(`
      SELECT mr.*, p.name AS product_name
      FROM mrp_requirements mr
      LEFT JOIN products p ON p.id = mr.product_id
      WHERE mr.run_id=?
      ORDER BY mr.suggested_qty DESC, mr.product_id
    `).all(runId);

    return {
      ok: true,
      run_id: runId,
      code,
      horizon_days: horizonDays,
      total_items: requirements.length,
      shortage_items: shortageCount,
      requirements,
    };
  })();
}

module.exports = { mrpRun, onHandQty, collectDemand };
