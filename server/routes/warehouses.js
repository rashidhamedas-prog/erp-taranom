const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting, requireWarehouseOps, requireWarehouseReportView } = require('../middleware/auth');

// Warehouse Phase 2 — /moves/* gated by acc_warehouse_ops: view | create | delete (=void).
// `negative` is enforced inside createWarehouseDoc (userMayWhNegative).
const opsView = requireWarehouseOps('view');
// v577 Phase 4: reports need acc_warehouse_ops:view OR reports:view (NOT invoices:view); accounting delegates keep access.
const reportView = requireWarehouseReportView({ orDelegatedAccounting: true });
const opsCreate = requireWarehouseOps('create');
const opsVoid = requireWarehouseOps('delete');
const opsRevise = requireWarehouseOps(['create', 'delete']); // revise = void + re-post
// Read helpers a storekeeper needs to fill a document (product search / stock lookup).
const opsViewOrWh = requireWarehouseOps('view', { orDelegatedAccounting: true });
const { voidWarehouseMove } = require('../lib/void-warehouse-move');
const {
  listWarehouseDocs, getWarehouseDoc, createWarehouseDoc,
  voidWarehouseDoc, reviseWarehouseDoc,
} = require('../lib/warehouse-docs');
const { searchWarehouseLineProducts } = require('../lib/inventory/product-line-search');
const { buildVariantStockReport } = require('../lib/inventory/variant-report');
const { productUnitCostRial } = require('../lib/inventory/product-unit-cost');

/** @deprecated use productUnitCostRial — kept name for audit tests */
function unitCostRialOf(p) {
  return productUnitCostRial(p);
}

/**
 * v577 Phase 4 — per-warehouse stock report.
 * Declared source = kardex (Σ inventory_ledger): qty + rial value per product × warehouse.
 * warehouse_stock / vws / header avg are comparison layers (ws_qty, drift_*, header_value_rial).
 * Rows with qty=0 but value≠0 (ghosts), negative qty/value or layer drift are always listed + flagged.
 * avg_unit_cost_rial per warehouse is WEIGHTED (Σvalue/Σqty over qty>0 rows), never a simple mean.
 */
function buildWarehouseStockRows(db, {
  warehouseId = null, q = '', category = '', includeZero = false, asOverview = false,
} = {}) {
  const { buildLedgerValuationRows, weightedAvgRial } = require('../lib/inventory/valuation');
  const allWh = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
  const prodMeta = new Map();
  for (const p of db.prepare(`
    SELECT p.id, p.code, p.name, p.unit, p.cost, p.price, p.category, p.average_cost_rial,
      pc.name AS category_name
    FROM products p
    LEFT JOIN product_categories pc ON pc.id=p.category_id
  `).all()) prodMeta.set(p.id, p);

  const val = buildLedgerValuationRows(db, { warehouseId: warehouseId || undefined });
  const byWh = new Map();
  for (const r of val.rows) {
    if (!byWh.has(r.warehouse_id)) byWh.set(r.warehouse_id, []);
    byWh.get(r.warehouse_id).push(r);
  }
  const hasLedgerWeight = (wid) => (byWh.get(wid) || []).some(
    (r) => r.ledger_qty !== 0 || r.ledger_value_rial !== 0,
  );
  // active warehouses, plus inactive ones that still carry kardex qty/value (nothing may vanish)
  const warehouses = allWh
    .filter((w) => (Number(w.active) === 1 || hasLedgerWeight(w.id)))
    .filter((w) => !warehouseId || w.id === warehouseId);
  const blocks = warehouses.map((w) => ({
    id: w.id, name: w.name, code: w.code, meta: w, rows: byWh.get(w.id) || [],
  }));
  // kardex rows without a warehouse (warehouse_id NULL) — never dropped silently
  if (!warehouseId && (byWh.get(0) || []).some((r) => r.ledger_qty !== 0 || r.ledger_value_rial !== 0)) {
    blocks.push({
      id: 0, name: 'بدون انبار (کاردکس)', code: null,
      meta: { id: 0, name: 'بدون انبار (کاردکس)', code: null, active: 1 }, rows: byWh.get(0),
    });
  }

  return blocks.map((w) => {
    const products = [];
    for (const r of w.rows) {
      const p = prodMeta.get(r.product_id);
      if (!p) continue;
      const qty = r.ledger_qty;
      const visible = includeZero || qty > 0 || r.flags.exception_any || r.flags.drift_any;
      if (!visible) continue;
      const cat = p.category_name || p.category || '';
      if (category && cat !== category) continue;
      if (q) {
        const hay = `${p.code || ''} ${p.name || ''} ${p.unit || ''}`.toLowerCase();
        if (!hay.includes(q.toLowerCase())) continue;
      }
      const headerUnit = unitCostRialOf(p);
      const unitPriceRial = Math.round(Number(p.price) || 0);
      products.push({
        id: p.id, code: p.code, name: p.name, unit: p.unit, category: cat,
        source: 'kardex',
        qty,
        kardex_qty: qty,
        avg_rate_rial: r.weighted_avg_unit_rial,
        // unit cost = Σledger value / qty when qty>0 (weighted); header cost only as fallback / comparison
        unit_cost_rial: qty > 0 && r.ledger_value_rial !== 0 ? r.weighted_avg_unit_rial : headerUnit,
        unit_price_rial: unitPriceRial,
        avg_cost_rial: r.weighted_avg_unit_rial,
        weighted_avg_unit_rial: r.weighted_avg_unit_rial,
        header_unit_cost_rial: headerUnit,
        amount_rial: r.ledger_value_rial,
        ledger_value_rial: r.ledger_value_rial,
        header_value_rial: r.header_value_rial,
        header_value_diff_rial: r.header_value_diff_rial,
        sales_value_rial: Math.round(qty * unitPriceRial),
        ws_qty: r.ws_qty,
        vws_sum: r.vws_sum,
        drift_qty: r.drift_qty,
        bucket_qty: r.bucket_qty,
        bucket_value_rial: r.bucket_value_rial,
        flags: r.flags,
        flagged: r.flagged,
      });
    }
    const weighted = weightedAvgRial(products, 'qty', 'amount_rial');
    const flagged = products.filter((x) => x.flagged);
    const ghosts = products.filter((x) => x.flags.zero_qty_nonzero_value);
    const base = {
      warehouse_id: w.id, warehouse_name: w.name, warehouse_code: w.code,
      source: 'kardex',
      product_count: products.length,
      total_qty: products.reduce((a, x) => a + x.qty, 0),
      total_amount_rial: products.reduce((a, x) => a + x.amount_rial, 0),
      total_sales_value_rial: products.reduce((a, x) => a + x.sales_value_rial, 0),
      total_header_value_rial: products.reduce((a, x) => a + x.header_value_rial, 0),
      kardex_total_qty: products.reduce((a, x) => a + x.qty, 0),
      ledger_total_value_rial: products.reduce((a, x) => a + x.amount_rial, 0),
      avg_unit_cost_rial: weighted,
      weighted_avg_unit_cost_rial: weighted,
      avg_rate_rial: weighted,
      flagged_count: flagged.length,
      ghost_count: ghosts.length,
      ghost_value_rial: ghosts.reduce((a, x) => a + x.amount_rial, 0),
      drift_count: products.filter((x) => x.flags.drift_any).length,
      products,
    };
    return asOverview ? { ...w.meta, ...base } : base;
  });
}

// Stock overview — all warehouses with product quantities (Phase 4: kardex source)
router.get('/stock/overview', auth, reportView, (req, res) => {
  const db = getDB();
  res.json(buildWarehouseStockRows(db, { includeZero: true, asOverview: true }));
});

/** Comprehensive per-warehouse stock report with filters (kardex Σ qty / Σ rial) */
router.get('/stock/report', auth, reportView, (req, res) => {
  const db = getDB();
  const warehouseId = req.query.warehouse_id ? parseInt(req.query.warehouse_id, 10) : null;
  const q = String(req.query.q || '').trim();
  const category = String(req.query.category || '').trim();
  const includeZero = req.query.include_zero === '1';
  res.json({
    filters: { warehouse_id: warehouseId, q, category, include_zero: includeZero },
    source: 'kardex',
    value_basis: 'sum_ledger_rial',
    rows: buildWarehouseStockRows(db, { warehouseId, q, category, includeZero }),
  });
});

/** Color × size stock dashboard. Snapshot, not a date-ranged ledger. */
router.get('/stock/variant-report', auth, reportView, (req, res) => {
  try {
    res.json(buildVariantStockReport(getDB(), req.query));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || String(e) });
  }
});

// INV-03 — shared picker for receipt/issue/transfer lines (before /:id)
router.get('/products/search', auth, opsViewOrWh, (req, res) => {
  try {
    const db = getDB();
    res.json(searchWarehouseLineProducts(db, req.user, req.query));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || String(e), code: e.code });
  }
});

// Read-only list is open to all authenticated users — the products/catalog
// page needs it for its warehouse filter (spec 1.0.9 §2: sales users were
// getting "access denied" on the catalog). Mutations below stay restricted.
router.get('/', auth, (req, res) => {
  const db = getDB();
  const { inventoryAccountForWarehouse } = require('../lib/inventory/ledger');
  const rows = db.prepare(`
    SELECT w.*, cc.name AS cost_center_name, cc.code AS cost_center_code
    FROM warehouses w
    LEFT JOIN cost_centers cc ON cc.id = w.cost_center_id
    ORDER BY w.name
  `).all();
  res.json(rows.map((w) => {
    try {
      const inv = inventoryAccountForWarehouse(db, w.id);
      return { ...w, inventory_account_code: inv.code, inventory_account_name: inv.name };
    } catch (_) {
      return w;
    }
  }));
});

// v585 Phase 1 — read-only leaf-mapping report (admin/accounting); never writes.
router.get('/coa-leaf-report', auth, adminOrAccounting, (req, res) => {
  try {
    res.json(require('../lib/coa-leaf-report').buildCoaLeafReport(getDB()));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || String(e), code: e.code });
  }
});

// v586 Phase 4 (optional) — read-only inventory GL ↔ kardex gap; never writes / no JE suggestions.
router.get('/inventory-gl-gap-report', auth, adminOrAccounting, (req, res) => {
  try {
    const acct = String(req.query.acct || '1104').trim();
    const warehouses = String(req.query.warehouses || '').trim();
    const cutoff = String(req.query.cutoff || '').trim();
    if (!warehouses || !cutoff) {
      return res.status(400).json({
        error: 'پارامترهای warehouses و cutoff الزامی‌اند (مثال: warehouses=34,35&cutoff=1405/08/30)',
        code: 'E_GAP_PARAMS',
      });
    }
    const rep = require('../lib/inventory-gl-gap-report').buildInventoryGlGapReport(getDB(), {
      acct, warehouses, cutoff,
    });
    res.json(rep);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || String(e), code: e.code });
  }
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const { name, address, code, entity, warehouse_type, cost_center_id, is_default, allow_negative, costing_method, inventory_system, inventory_coa_code } = req.body;
  const cogs_coa_code = req.body.cogs_coa_code;
  if (!name) return res.status(400).json({ error: 'نام انبار الزامی است' });
  const db = getDB();
  const { resolveWarehouseCostCenter } = require('../lib/cost-center-repair');
  const whCode = code || ('WH-' + Date.now().toString(36).toUpperCase());
  const ent = entity || 'distribution_office';
  let ccId;
  try {
    ccId = resolveWarehouseCostCenter(db, { cost_center_id, entity: ent, code: whCode });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
  const invSys = String(inventory_system || 'perpetual').toLowerCase() === 'periodic' ? 'periodic' : 'perpetual';
  const invCoa = String(inventory_coa_code || '').trim() || null;
  const cogsCoa = String(cogs_coa_code || '').trim() || null;
  // v585 Phase 1: perpetual ⇒ leaf inventory + leaf COGS accounts required; periodic exempt.
  const coaErr = require('../lib/coa-leaf-policy').validateWarehouseCoaInput(db, {
    warehouse_type: warehouse_type || 'finished_goods', inventory_system: invSys,
    inventory_coa_code: invCoa, cogs_coa_code: cogsCoa,
  });
  if (coaErr && coaErr.status >= 400) {
    return res.status(coaErr.status).json({ error: coaErr.error, code: coaErr.code, warnings: coaErr.warnings });
  }
  const coaWarning = (coaErr && (coaErr.warning || (coaErr.warnings && coaErr.warnings[0]))) || null;
  const result = db.transaction(() => {
    if (is_default) db.prepare('UPDATE warehouses SET is_default=0').run();
    return db.prepare(`
      INSERT INTO warehouses (name,address,code,entity,warehouse_type,cost_center_id,is_default,allow_negative,costing_method,inventory_system,inventory_coa_code,cogs_coa_code)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      name, address || '', whCode,
      ent,
      warehouse_type || 'finished_goods',
      ccId,
      is_default ? 1 : 0,
      allow_negative ? 1 : 0,
      costing_method || null,
      invSys,
      invCoa,
      cogsCoa
    );
  })();
  if (req.body.valuation_level !== undefined) {
    try { require('../lib/inventory/valuation').setLayerLevel(db, 'warehouses', result.lastInsertRowid, req.body.valuation_level, { userId: req.user.id }); } catch (_) { /* column optional */ }
  }
  audit(req.user.id, 'create', 'warehouse', result.lastInsertRowid, `ساخت انبار ${name}`);
  const created = db.prepare('SELECT * FROM warehouses WHERE id=?').get(result.lastInsertRowid);
  if (coaWarning) created.warning = coaWarning;
  res.json(created);
});

router.put('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM warehouses WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const { name, address, active, entity, warehouse_type, cost_center_id, is_default, code, allow_negative, costing_method, inventory_system, inventory_coa_code } = req.body;
  const invSys = inventory_system !== undefined
    ? (String(inventory_system || 'perpetual').toLowerCase() === 'periodic' ? 'periodic' : 'perpetual')
    : (row.inventory_system || 'perpetual');
  let nextCc = row.cost_center_id;
  if (cost_center_id != null) {
    try {
      nextCc = cost_center_id
        ? require('../lib/cost-center-repair').requireCostCenter(db, cost_center_id)
        : null;
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
  }
  let nextInvCoa = row.inventory_coa_code || null;
  if (inventory_coa_code !== undefined) {
    nextInvCoa = String(inventory_coa_code || '').trim() || null;
  }
  let nextCogsCoa = row.cogs_coa_code || null;
  if (req.body.cogs_coa_code !== undefined) {
    nextCogsCoa = String(req.body.cogs_coa_code || '').trim() || null;
  }
  // v585 Phase 1: validate the resulting mapping when the request touches it and the warehouse
  // stays active (deactivating / toggling flags of a legacy unmapped warehouse stays possible).
  const touchesCoa = ['inventory_coa_code', 'cogs_coa_code', 'inventory_system', 'warehouse_type']
    .some((k) => req.body[k] !== undefined);
  const nextActive = active != null ? (active ? 1 : 0) : row.active;
  if (touchesCoa && Number(nextActive) === 1) {
    const coaErr = require('../lib/coa-leaf-policy').validateWarehouseCoaInput(db, {
      warehouse_type: warehouse_type || row.warehouse_type || 'finished_goods',
      inventory_system: invSys,
      inventory_coa_code: nextInvCoa,
      cogs_coa_code: nextCogsCoa,
    });
    if (coaErr && coaErr.status >= 400) {
      return res.status(coaErr.status).json({ error: coaErr.error, code: coaErr.code, warnings: coaErr.warnings });
    }
    if (coaErr && (coaErr.warning || (coaErr.warnings && coaErr.warnings[0]))) {
      res.locals.coaWarning = coaErr.warning || coaErr.warnings[0];
    }
  }
  db.transaction(() => {
    const def = is_default != null ? (is_default ? 1 : 0) : (row.is_default || 0);
    if (def) db.prepare('UPDATE warehouses SET is_default=0 WHERE id<>?').run(req.params.id);
    db.prepare(`
      UPDATE warehouses SET name=?,address=?,active=?,entity=?,warehouse_type=?,cost_center_id=?,is_default=?,code=?,allow_negative=?,costing_method=?,inventory_system=?,inventory_coa_code=?,cogs_coa_code=?
      WHERE id=?
    `).run(
      name || row.name, address ?? row.address,
      active != null ? (active ? 1 : 0) : row.active,
      entity || row.entity || 'distribution_office',
      warehouse_type || row.warehouse_type || 'finished_goods',
      nextCc,
      def,
      code || row.code || null,
      allow_negative != null ? (allow_negative ? 1 : 0) : (row.allow_negative || 0),
      costing_method !== undefined ? (costing_method || null) : (row.costing_method || null),
      invSys,
      nextInvCoa,
      nextCogsCoa,
      req.params.id
    );
    if (req.body.valuation_level !== undefined) {
      require('../lib/inventory/valuation').setLayerLevel(db, 'warehouses', Number(req.params.id), req.body.valuation_level, { userId: req.user.id });
    }
  })();
  audit(req.user.id, 'update', 'warehouse', req.params.id, `ویرایش انبار ${name || row.name}`);
  const out = { ok: true };
  if (res.locals.coaWarning) out.warning = res.locals.coaWarning;
  res.json(out);
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM warehouses WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  const whId = req.params.id;
  const inUse = db.prepare('SELECT COUNT(*) c FROM products WHERE warehouse_id=?').get(whId).c;
  if (inUse > 0) return res.status(400).json({ error: 'این انبار دارای کالا است و قابل حذف نیست — می‌توانید آن را غیرفعال کنید' });
  const wsQty = db.prepare('SELECT COALESCE(SUM(ABS(qty)),0) c FROM warehouse_stock WHERE warehouse_id=?').get(whId).c;
  if (Number(wsQty) > 0) {
    return res.status(400).json({ error: 'این انبار موجودی دارد و قابل حذف نیست — ابتدا موجودی را صفر یا انبار را غیرفعال کنید' });
  }
  const moveCount = db.prepare(`
    SELECT COUNT(*) c FROM warehouse_moves
    WHERE (from_warehouse_id=? OR to_warehouse_id=?) AND COALESCE(status,'posted')<>'reversed'
  `).get(whId, whId).c;
  let ledgerCount = 0;
  try {
    ledgerCount = db.prepare('SELECT COUNT(*) c FROM inventory_ledger WHERE warehouse_id=?').get(whId).c;
  } catch (_) { ledgerCount = 0; }
  let vwsCount = 0;
  try {
    vwsCount = db.prepare('SELECT COUNT(*) c FROM variant_warehouse_stock WHERE warehouse_id=? AND COALESCE(qty,0)<>0').get(whId).c;
  } catch (_) { vwsCount = 0; }
  let docCount = 0;
  try {
    docCount = db.prepare(`
      SELECT COUNT(*) c FROM warehouse_docs
      WHERE from_warehouse_id=? OR to_warehouse_id=?
    `).get(whId, whId).c;
  } catch (_) { docCount = 0; }
  // Any ledger / nonzero vws / warehouse doc history → soft-deactivate only (never physical delete).
  if (moveCount > 0 || ledgerCount > 0 || vwsCount > 0 || docCount > 0) {
    db.prepare('UPDATE warehouses SET active=0 WHERE id=?').run(whId);
    audit(req.user.id, 'update', 'warehouse', whId, `غیرفعال‌سازی انبار ${row.name} (سابقه کاردکس/اسناد)`);
    return res.json({ ok: true, deactivated: true });
  }
  db.prepare('DELETE FROM warehouses WHERE id=?').run(whId);
  // Prevent boot-time seed from recreating default warehouses after intentional deletes
  const left = db.prepare('SELECT COUNT(*) c FROM warehouses').get().c;
  if (left === 0) {
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('warehouses_user_cleared','1')").run();
    for (const k of [
      'production_wh_raw_id', 'production_wh_fg_id', 'production_wh_sub_id',
      'production_wh_scrap_id', 'production_wh_dist_id',
    ]) {
      try { db.prepare('DELETE FROM settings WHERE key=?').run(k); } catch (_) {}
    }
  } else {
    // Drop production_* links that pointed at this warehouse
    for (const k of [
      'production_wh_raw_id', 'production_wh_fg_id', 'production_wh_sub_id',
      'production_wh_scrap_id', 'production_wh_dist_id',
    ]) {
      const cur = db.prepare('SELECT value FROM settings WHERE key=?').get(k);
      if (cur && String(cur.value) === String(req.params.id)) {
        db.prepare('DELETE FROM settings WHERE key=?').run(k);
      }
    }
  }
  audit(req.user.id, 'delete', 'warehouse', req.params.id, `حذف انبار ${row.name}`);
  res.json({ ok: true });
});

// Products currently assigned to a warehouse (= "warehouse stock report")
router.get('/:id/stock', auth, opsViewOrWh, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT p.id, p.code, p.name, ws.qty AS stock, p.unit, p.stock_alert
    FROM warehouse_stock ws
    JOIN products p ON p.id=ws.product_id
    WHERE ws.warehouse_id=?
    ORDER BY p.name
  `).all(req.params.id);
  // v577: `stock` stays the operational warehouse_stock qty; kardex (Σ ledger) is the declared
  // report source and is added next to it together with the drift flag.
  try {
    const { buildLedgerValuationRows } = require('../lib/inventory/valuation');
    const k = new Map(buildLedgerValuationRows(db, { warehouseId: Number(req.params.id), skipDrift: true })
      .rows.map((r) => [r.product_id, r]));
    for (const row of rows) {
      const r = k.get(row.id);
      row.kardex_qty = r ? r.ledger_qty : 0;
      row.kardex_value_rial = r ? r.ledger_value_rial : 0;
      row.weighted_avg_unit_rial = r ? r.weighted_avg_unit_rial : 0;
      row.drift = Math.abs((Number(row.stock) || 0) - row.kardex_qty) > 1e-6;
    }
  } catch (_) { /* kardex columns optional */ }
  res.json(rows);
});

router.get('/:id/period-closes', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  res.json(db.prepare(`
    SELECT * FROM warehouse_period_closes WHERE warehouse_id=? ORDER BY period_label DESC, id DESC
  `).all(req.params.id));
});

router.post('/:id/period-close', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const b = req.body || {};
    if (!b.period_label && !b.periodLabel) throw new Error('برچسب دوره الزامی است');
    if (!b.start_date && !b.startDate) throw new Error('تاریخ شروع الزامی است');
    if (!b.end_date && !b.endDate) throw new Error('تاریخ پایان الزامی است');
    const { closePeriodicWarehouse } = require('../lib/inventory/periodic-close');
    const result = closePeriodicWarehouse(db, {
      warehouseId: Number(req.params.id),
      periodLabel: b.period_label || b.periodLabel,
      startDate: b.start_date || b.startDate,
      endDate: b.end_date || b.endDate,
      counts: Array.isArray(b.counts) ? b.counts : [],
      purchasesRial: b.purchases_rial ?? b.purchasesRial ?? 0,
      beginningInventoryRial: b.beginning_inventory_rial ?? b.beginningInventoryRial ?? 0,
      note: b.note || '',
      userId: req.user.id,
      date: b.date,
    });
    audit(req.user.id, 'close', 'warehouse_period', result.id, `بستن دوره ادواری انبار #${req.params.id}`);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.post('/:id/period-closes/:closeId/reopen', auth, adminOrAccounting, (req, res) => {
  try {
    const db = getDB();
    const closeId = Number(req.params.closeId);
    const row = db.prepare('SELECT * FROM warehouse_period_closes WHERE id=?').get(closeId);
    if (!row) return res.status(404).json({ error: 'یافت نشد', code: 'E_CLOSE_NOT_FOUND' });
    if (Number(row.warehouse_id) !== Number(req.params.id)) {
      return res.status(400).json({ error: 'این بستن دوره متعلق به این انبار نیست', code: 'E_WH_MISMATCH' });
    }
    const { reopenPeriodicWarehouse } = require('../lib/inventory/periodic-close');
    const result = reopenPeriodicWarehouse(db, {
      closeId,
      reason: (req.body && req.body.reason) || '',
      userId: req.user.id,
      date: req.body && req.body.date,
    });
    audit(req.user.id, 'reopen', 'warehouse_period', closeId, `بازگشایی دوره ادواری #${closeId}`);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

// ---- Warehouse documents (aggregated remittance / receipt / transfer) ----
router.get('/moves/docs', auth, opsView, (req, res) => {
  try {
    const db = getDB();
    res.json(listWarehouseDocs(db, {
      limit: req.query.limit,
      includeReversed: req.query.include_reversed === '1',
    }));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.get('/moves/docs/:id', auth, opsView, (req, res) => {
  try {
    const db = getDB();
    const doc = getWarehouseDoc(db, req.params.id);
    if (!doc) return res.status(404).json({ error: 'سند انبار یافت نشد' });
    res.json(doc);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

/** چاپ حواله / رسید / انتقال انبار (A4|A5) — عملیاتی بدون مبلغ */
router.get('/moves/docs/:id/print', auth, opsView, (req, res) => {
  try {
    const db = getDB();
    const doc = getWarehouseDoc(db, req.params.id);
    if (!doc) return res.status(404).send('سند انبار یافت نشد');
    const paperQ = String(req.query.paper || 'A4').toUpperCase();
    const paper = paperQ === 'A5' ? 'A5' : 'A4';
    const { buildWarehouseDocSlip, companySettings } = require('../lib/warehouse-slip-print');
    const { sendSecureHtml } = require('../lib/secure-html-response');
    const getSetting = (d, key) => {
      const r = d.prepare('SELECT value FROM settings WHERE key=?').get(key);
      return r ? r.value : '';
    };
    const html = buildWarehouseDocSlip(doc, companySettings(db, getSetting), paper);
    return sendSecureHtml(res, html, { allowPrintScript: true });
  } catch (e) {
    console.error('warehouse doc print:', e && e.message);
    return res.status(500).send('خطا در ساخت چاپ سند انبار');
  }
});

router.post('/moves/docs', auth, opsCreate, (req, res) => {
  try {
    const db = getDB();
    const result = createWarehouseDoc(db, req.body, req.user);
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.post('/moves/docs/:id/void', auth, opsVoid, (req, res) => {
  try {
    const db = getDB();
    const result = voidWarehouseDoc(db, req.params.id, req.user, {
      reason: req.body && req.body.reason,
    });
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.post('/moves/docs/:id/revise', auth, opsRevise, (req, res) => {
  try {
    const db = getDB();
    const result = reviseWarehouseDoc(db, req.params.id, req.body, req.user);
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

// ---- Warehouse movement history (line-level; kept for debug/excel) ----
router.get('/moves/list', auth, opsView, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT m.*, p.name as product_name, p.code as product_code,
      fw.name as from_warehouse_name, tw.name as to_warehouse_name, u.name as recorder,
      d.num as doc_num
    FROM warehouse_moves m
    LEFT JOIN warehouse_docs d ON d.id=m.doc_id
    LEFT JOIN products p ON m.product_id=p.id
    LEFT JOIN warehouses fw ON m.from_warehouse_id=fw.id
    LEFT JOIN warehouses tw ON m.to_warehouse_id=tw.id
    LEFT JOIN users u ON m.created_by=u.id
    WHERE COALESCE(m.status,'posted')<>'reversed'
    ORDER BY m.created_at DESC LIMIT 300
  `).all();
  res.json(rows);
});

// Void warehouse move (R13 — if doc_id present, voids whole document)
router.post('/moves/:id/void', auth, opsVoid, (req, res) => {
  try {
    const db = getDB();
    const result = voidWarehouseMove(db, req.params.id, req.user);
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.post('/moves/receipt', auth, opsCreate, (req, res) => {
  try {
    const db = getDB();
    const result = createWarehouseDoc(db, {
      type: 'receipt',
      warehouse_id: req.body.warehouse_id,
      to_warehouse_id: req.body.warehouse_id,
      date: req.body.date,
      note: req.body.note,
      opening: req.body.opening,
      lines: [{
        product_id: req.body.product_id,
        qty: req.body.qty,
        variant_id: req.body.variant_id,
        unit_cost_rial: req.body.unit_cost_rial,
        batch_id: req.body.batch_id,
      }],
    }, req.user);
    res.json({ id: result.ids[0], doc_id: result.id, num: result.num, ledger_id: null, ok: true, ...result });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.post('/moves/issue', auth, opsCreate, (req, res) => {
  try {
    const db = getDB();
    const b = req.body || {};
    const result = createWarehouseDoc(db, {
      type: 'issue',
      warehouse_id: b.warehouse_id,
      from_warehouse_id: b.warehouse_id,
      date: b.date,
      note: b.note,
      issue_type: b.issue_type,
      cost_center_id: b.cost_center_id,
      person_id: b.person_id,
      supplier_id: b.supplier_id,
      recipient: b.recipient,
      lines: [{
        product_id: b.product_id,
        qty: b.qty,
        variant_id: b.variant_id,
        batch_id: b.batch_id,
      }],
    }, req.user);
    res.json({ id: result.ids[0], doc_id: result.id, num: result.num, ok: true, ...result });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.post('/moves/transfer', auth, opsCreate, (req, res) => {
  try {
    const db = getDB();
    const result = createWarehouseDoc(db, {
      type: 'transfer',
      from_warehouse_id: req.body.from_warehouse_id,
      to_warehouse_id: req.body.to_warehouse_id,
      date: req.body.date,
      note: req.body.note,
      lines: [{
        product_id: req.body.product_id,
        qty: req.body.qty,
        variant_id: req.body.variant_id,
      }],
    }, req.user);
    res.json({ id: result.ids[0], doc_id: result.id, num: result.num, ok: true, ...result });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

const DEFAULT_WAREHOUSE_ENTITIES = [
  { value: 'workshop', label: 'کارگاه (نوبرت)' },
  { value: 'distribution_office', label: 'دفتر توزیع (کیمیا)' },
];
const DEFAULT_WAREHOUSE_TYPES = [
  { value: 'raw_material', label: 'مواد اولیه' },
  { value: 'packaging', label: 'بسته‌بندی' },
  { value: 'wip', label: 'در جریان ساخت (WIP)' },
  { value: 'finished_goods', label: 'محصول نهایی' },
  { value: 'consignment', label: 'امانی' },
  { value: 'scrap', label: 'ضایعات' },
];

function readLookupOptions(db, key, defaults) {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
  if (!row?.value) return defaults;
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) && parsed.length ? parsed : defaults;
  } catch (_) { return defaults; }
}

router.get('/lookup-options', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  res.json({
    entities: readLookupOptions(db, 'warehouse_entities', DEFAULT_WAREHOUSE_ENTITIES),
    types: readLookupOptions(db, 'warehouse_types', DEFAULT_WAREHOUSE_TYPES),
  });
});

router.post('/lookup-options', auth, adminOrAccounting, (req, res) => {
  const { kind, value, label } = req.body;
  if (!kind || !value || !label) return res.status(400).json({ error: 'نوع، مقدار و برچسب الزامی است' });
  const key = kind === 'type' ? 'warehouse_types' : 'warehouse_entities';
  const defaults = kind === 'type' ? DEFAULT_WAREHOUSE_TYPES : DEFAULT_WAREHOUSE_ENTITIES;
  const db = getDB();
  const list = readLookupOptions(db, key, defaults);
  if (!list.some(x => x.value === value)) list.push({ value: String(value), label: String(label) });
  db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, JSON.stringify(list));
  res.json({ ok: true, list });
});

/** Multi-line warehouse document — proxies to warehouse_docs (backward compatible). */
router.post('/moves/batch', auth, opsCreate, (req, res) => {
  try {
    const db = getDB();
    const result = createWarehouseDoc(db, req.body, req.user);
    res.json(result);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

module.exports = router;
