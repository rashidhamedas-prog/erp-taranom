'use strict';
/**
 * Cost / price revaluation after production-period cost changes.
 * Modes: auto (date range + on-hand manufactured) | manual (one product).
 * R13: reverse = soft-void JE + restore prior cost/prices from lines.
 */
const { postToLedger } = require('../ledger');
const { reverseJournalEntry } = require('../void-journal');
const { acct } = require('../coa-map');
const { applyPricingFromCost, pricesFromCost, resolveMarkup } = require('../../routes/pricing-rules');
const { validatePeriodLabel } = require('./overhead');
const { clearRollUpMemo, rollUpUnitCost } = require('./bom-advanced');

function revErr(code, status, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (extra) e.extra = extra;
  return e;
}

function todayJalaliFallback() {
  try {
    return new Intl.DateTimeFormat('en-CA-u-ca-persian', {
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date()).replace(/-/g, '/');
  } catch {
    return '1405/01/01';
  }
}

function productOnHand(db, productId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(qty),0) AS q FROM warehouse_stock WHERE product_id=?
  `).get(productId);
  return Number(row?.q) || 0;
}

/** Inventory GL for cost reval — warehouse map only (never products.coa_code). */
function inventoryAccountForProduct(db, product) {
  const { inventoryAccountForWarehouse } = require('../inventory/ledger');
  const whId = product && product.warehouse_id != null ? parseInt(product.warehouse_id, 10) : null;
  return inventoryAccountForWarehouse(db, Number.isFinite(whId) && whId > 0 ? whId : null);
}

function computeNewUnitCost(db, product, periodLabel) {
  clearRollUpMemo();
  const period = validatePeriodLabel(periodLabel || todayJalaliFallback().slice(0, 7));
  const date = `${period}/15`;
  if (Number(product.is_manufactured) === 1) {
    try {
      const unit = Math.round(rollUpUnitCost(db, product.id, date, period));
      if (unit > 0) return { unit_cost_rial: unit, source: 'bom_rollup', period_label: period };
    } catch (_) { /* fall through */ }
  }
  const fallback = Math.round(
    Number(product.last_prod_cost_rial)
    || Number(product.std_cost_rial)
    || Number(product.average_cost_rial)
    || Number(product.cost)
    || 0
  );
  return { unit_cost_rial: fallback, source: 'fallback_product', period_label: period };
}

function candidatesAuto(db, { dateFrom, dateTo }) {
  const from = String(dateFrom || '').trim();
  const to = String(dateTo || '').trim();
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(from) || !/^\d{4}\/\d{2}\/\d{2}$/.test(to)) {
    throw revErr('E_DATE_RANGE', 400, 'بازه تاریخ باید به صورت ۱۴۰۵/۰۷/۰۱ باشد');
  }
  if (from > to) throw revErr('E_DATE_RANGE', 400, 'تاریخ شروع بعد از پایان است');

  let productIds = [];
  try {
    productIds = db.prepare(`
      SELECT DISTINCT product_id AS id FROM production_receipts
      WHERE COALESCE(status,'posted')='posted'
        AND COALESCE(date,'') BETWEEN ? AND ?
    `).all(from, to).map((r) => r.id);
  } catch (_) { productIds = []; }

  if (!productIds.length) {
    try {
      productIds = db.prepare(`
        SELECT DISTINCT product_id AS id FROM production_orders
        WHERE COALESCE(status,'') IN ('finalized','closed','done','completed','received')
          AND COALESCE(date,'') BETWEEN ? AND ?
      `).all(from, to).map((r) => r.id);
    } catch (_) { productIds = []; }
  }

  const out = [];
  for (const id of productIds) {
    const p = db.prepare('SELECT * FROM products WHERE id=?').get(id);
    if (!p || !Number(p.is_manufactured)) continue;
    const qty = productOnHand(db, id);
    if (qty <= 0) continue;
    out.push({ product: p, qty_on_hand: qty });
  }
  return out;
}

function buildLinePreview(db, product, qty, periodLabel) {
  const oldUnit = Math.round(
    Number(product.average_cost_rial) > 0
      ? Number(product.average_cost_rial)
      : (Number(product.cost) || 0)
  );
  const computed = computeNewUnitCost(db, product, periodLabel);
  const newUnit = computed.unit_cost_rial;
  const rule = resolveMarkup(db, product);
  const priced = pricesFromCost(newUnit, rule);
  const oldWh = Math.round(Number(product.price_rial || product.price) || 0);
  const oldRt = Math.round(Number(product.retail_price_rial || product.retail_price) || 0);
  const deltaUnit = newUnit - oldUnit;
  const deltaInv = Math.round(deltaUnit * qty);
  return {
    product_id: product.id,
    product_code: product.code,
    product_name: product.name,
    qty_on_hand: qty,
    old_unit_cost_rial: oldUnit,
    new_unit_cost_rial: newUnit,
    cost_source: computed.source,
    period_label: computed.period_label,
    old_wholesale_rial: oldWh,
    new_wholesale_rial: priced.wholesale,
    old_retail_rial: oldRt,
    new_retail_rial: priced.retail,
    delta_inventory_rial: deltaInv,
  };
}

function preview(db, opts = {}) {
  const mode = opts.mode === 'manual' ? 'manual' : 'auto';
  const periodLabel = opts.period_label
    ? validatePeriodLabel(opts.period_label)
    : (String(opts.date_to || todayJalaliFallback()).slice(0, 7));
  let items = [];
  if (mode === 'manual') {
    const pid = Number(opts.product_id);
    if (!pid) throw revErr('E_PRODUCT_REQUIRED', 400, 'کالا برای تعدیل دستی الزامی است');
    const p = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
    if (!p) throw revErr('E_PRODUCT_NOT_FOUND', 404, 'کالا یافت نشد');
    const qty = opts.qty_on_hand != null ? Number(opts.qty_on_hand) : productOnHand(db, pid);
    if (!(qty > 0)) throw revErr('E_NO_STOCK', 400, 'کالا موجودی ندارد');
    items = [{ product: p, qty_on_hand: qty }];
  } else {
    items = candidatesAuto(db, {
      dateFrom: opts.date_from,
      dateTo: opts.date_to,
    });
  }
  const allLines = items.map((it) => buildLinePreview(db, it.product, it.qty_on_hand, periodLabel));
  const deltaSum = allLines.reduce((s, l) => s + l.delta_inventory_rial, 0);
  return {
    mode,
    period_label: periodLabel,
    date_from: opts.date_from || '',
    date_to: opts.date_to || '',
    line_count: allLines.length,
    delta_inventory_rial: deltaSum,
    lines: allLines,
  };
}

function postRevaluation(db, opts = {}, user) {
  const previewed = preview(db, opts);
  if (!previewed.lines.length) {
    throw revErr('E_NO_LINES', 400, 'کالایی برای تعدیل بها یافت نشد');
  }
  const prior = db.prepare(`
    SELECT id FROM cost_revaluations
    WHERE status='posted' AND mode=? AND period_label=?
      AND COALESCE(product_id,0)=COALESCE(?,0)
      AND COALESCE(date_from,'')=? AND COALESCE(date_to,'')=?
    ORDER BY id DESC LIMIT 1
  `).get(
    previewed.mode,
    previewed.period_label,
    previewed.mode === 'manual' ? Number(opts.product_id) || null : null,
    previewed.date_from || '',
    previewed.date_to || ''
  );
  if (prior) return getRevaluation(db, prior.id);
  const date = String(opts.entry_date || opts.date_to || todayJalaliFallback()).trim();
  const note = String(opts.note || '').slice(0, 400);
  const userId = user?.id || null;

  const invGain = acct(db, 'coa_var_oh_budget');
  const result = db.transaction(() => {
    const again = db.prepare(`
      SELECT id FROM cost_revaluations
      WHERE status='posted' AND mode=? AND period_label=?
        AND COALESCE(product_id,0)=COALESCE(?,0)
        AND COALESCE(date_from,'')=? AND COALESCE(date_to,'')=?
      ORDER BY id DESC LIMIT 1
    `).get(
      previewed.mode,
      previewed.period_label,
      previewed.mode === 'manual' ? Number(opts.product_id) || null : null,
      previewed.date_from || '',
      previewed.date_to || ''
    );
    if (again) return db.prepare('SELECT * FROM cost_revaluations WHERE id=?').get(again.id);
    const head = db.prepare(`
      INSERT INTO cost_revaluations
        (mode, date_from, date_to, period_label, product_id, status, note,
         line_count, delta_inventory_rial, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      previewed.mode,
      previewed.date_from || '',
      previewed.date_to || '',
      previewed.period_label,
      previewed.mode === 'manual' ? Number(opts.product_id) || null : null,
      'posted',
      note,
      previewed.line_count,
      previewed.delta_inventory_rial,
      userId
    );
    const revId = head.lastInsertRowid;
    // v522: closed inventory month → value effect parked for approval; the JE
    // below still debits inventory and the parking JE moves the gated part to clearing.
    const valueGate = require('../inventory/value-approval').begin(db, {
      sourceType: 'cost_revaluation', sourceId: revId, date, createdBy: userId,
      label: `تعدیل بهای تولید #${revId}`,
    });
    const insLine = db.prepare(`
      INSERT INTO cost_revaluation_lines
        (revaluation_id, product_id, qty_on_hand,
         old_unit_cost_rial, new_unit_cost_rial,
         old_wholesale_rial, new_wholesale_rial,
         old_retail_rial, new_retail_rial,
         delta_inventory_rial, note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);

    const jeLines = [];
    for (const L of previewed.lines) {
      insLine.run(
        revId, L.product_id, L.qty_on_hand,
        L.old_unit_cost_rial, L.new_unit_cost_rial,
        L.old_wholesale_rial, L.new_wholesale_rial,
        L.old_retail_rial, L.new_retail_rial,
        L.delta_inventory_rial, L.cost_source || ''
      );
      const prod = db.prepare('SELECT * FROM products WHERE id=?').get(L.product_id);
      // Average moves by value through a value-only ledger row (kardex + buckets stay
      // consistent); std/last cost are catalog fields and are set directly.
      const invAcc = inventoryAccountForProduct(db, prod);
      // qty_on_hand is the current stock (not a past receipt), so only a closed month gates.
      const parked = !!L.delta_inventory_rial && valueGate.closed && valueGate.gate({
        productId: L.product_id, warehouseId: null, refQty: Number(L.qty_on_hand) || 0,
        deltaRial: L.delta_inventory_rial, inventoryCode: invAcc.code, inventoryName: invAcc.name,
        note: `تعدیل بهای تولید #${revId}`,
      });
      if (L.delta_inventory_rial && !parked) {
        require('../inventory/valuation').postValueAdjustment(db, {
          productId: L.product_id,
          deltaRial: L.delta_inventory_rial,
          date,
          sourceType: 'cost_revaluation',
          sourceId: revId,
          note: `تعدیل بها #${revId}`,
          createdBy: userId,
          eventType: 'cost_adjustment',
          emptyUnitRial: L.new_unit_cost_rial,
        });
      }
      db.prepare(`
        UPDATE products SET last_prod_cost_rial=?, std_cost_rial=? WHERE id=?
      `).run(L.new_unit_cost_rial, L.new_unit_cost_rial, L.product_id);
      applyPricingFromCost(db, L.product_id, L.new_unit_cost_rial);

      if (L.delta_inventory_rial !== 0) {
        const inv = inventoryAccountForProduct(db, prod);
        // postToLedger lines are toman; delta_inventory_rial is rial.
        const abs = Math.abs(L.delta_inventory_rial) / 10;
        if (L.delta_inventory_rial > 0) {
          jeLines.push({
            code: inv.code, name: inv.name, debit: abs, credit: 0,
            description: `تعدیل بها ${prod.code || prod.id}`,
          });
          jeLines.push({
            code: invGain.code, name: invGain.name, debit: 0, credit: abs,
            description: `تعدیل بها ${prod.code || prod.id}`,
          });
        } else {
          jeLines.push({
            code: invGain.code, name: invGain.name, debit: abs, credit: 0,
            description: `تعدیل بها ${prod.code || prod.id}`,
          });
          jeLines.push({
            code: inv.code, name: inv.name, debit: 0, credit: abs,
            description: `تعدیل بها ${prod.code || prod.id}`,
          });
        }
      }
    }

    // Collapse JE lines by account for balance clarity
    const byKey = new Map();
    for (const l of jeLines) {
      const k = l.code;
      const cur = byKey.get(k) || { code: l.code, name: l.name, debit: 0, credit: 0, description: l.description };
      cur.debit += l.debit;
      cur.credit += l.credit;
      byKey.set(k, cur);
    }
    const merged = [...byKey.values()].map((l) => {
      const net = l.debit - l.credit;
      if (net >= 0) return { code: l.code, name: l.name, debit: net, credit: 0, description: 'تعدیل بهای تمام‌شده' };
      return { code: l.code, name: l.name, debit: 0, credit: -net, description: 'تعدیل بهای تمام‌شده' };
    }).filter((l) => l.debit || l.credit);

    let jeId = null;
    if (merged.length) {
      jeId = postToLedger(db, {
        sourceType: 'cost_revaluation',
        sourceId: revId,
        date,
        description: `تعدیل بها (${previewed.mode}) #${revId}${note ? ' — ' + note : ''}`,
        createdBy: userId,
        lines: merged,
      });
      db.prepare('UPDATE cost_revaluations SET je_id=?, posted_at=strftime(\'%s\',\'now\') WHERE id=?')
        .run(jeId, revId);
    } else {
      db.prepare('UPDATE cost_revaluations SET posted_at=strftime(\'%s\',\'now\') WHERE id=?').run(revId);
    }
    const approval = valueGate.finish({ park: true });

    return { ...db.prepare('SELECT * FROM cost_revaluations WHERE id=?').get(revId), value_approval_id: approval ? approval.id : null };
  })();

  const lines = db.prepare('SELECT * FROM cost_revaluation_lines WHERE revaluation_id=?').all(result.id);
  return { ...result, lines };
}

function reverseRevaluation(db, revaluationId, user) {
  const id = Number(revaluationId);
  const head = db.prepare('SELECT * FROM cost_revaluations WHERE id=?').get(id);
  if (!head) throw revErr('E_NOT_FOUND', 404, 'تعدیل بها یافت نشد');
  if (head.status === 'reversed') throw revErr('E_ALREADY_REVERSED', 400, 'قبلاً ابطال شده');
  if (head.status !== 'posted') throw revErr('E_NOT_POSTED', 400, 'فقط تعدیل ثبت‌شده قابل ابطال است');

  const lines = db.prepare('SELECT * FROM cost_revaluation_lines WHERE revaluation_id=?').all(id);
  db.transaction(() => {
    require('../inventory/value-approval').cancelForSource(db, 'cost_revaluation', id, user || null, `ابطال تعدیل بها #${id}`);
    // Average comes back by value (reverse the value-only rows), not by snapshot.
    const { reverseInventoryMovement } = require('../inventory/ledger');
    const valueRows = db.prepare(`
      SELECT id FROM inventory_ledger
      WHERE source_type='cost_revaluation' AND source_id=? AND status='posted'
        AND COALESCE(qty_in,0)=0 AND COALESCE(qty_out,0)=0
    `).all(id);
    for (const r of valueRows) {
      reverseInventoryMovement(db, r.id, { createdBy: user?.id || null, note: `ابطال تعدیل بها #${id}` });
    }
    for (const L of lines) {
      db.prepare(`
        UPDATE products SET
          last_prod_cost_rial=?,
          price=?, price_rial=?, retail_price=?, retail_price_rial=?
        WHERE id=?
      `).run(
        L.old_unit_cost_rial,
        L.old_wholesale_rial, L.old_wholesale_rial, L.old_retail_rial, L.old_retail_rial,
        L.product_id
      );
      const p = db.prepare('SELECT stock, average_cost_rial FROM products WHERE id=?').get(L.product_id);
      const { catalogCostFromAvgRial } = require('../inventory/product-unit-cost');
      let avgNow = Math.round(Number(p?.average_cost_rial) || 0);
      // Undo the value-neutral seed done at post time when the header had zero on-hand.
      if (Math.abs(Number(p?.stock) || 0) < 1e-9 && avgNow === Math.round(Number(L.new_unit_cost_rial) || 0)) {
        avgNow = Math.round(Number(L.old_unit_cost_rial) || 0);
        db.prepare('UPDATE products SET average_cost_rial=? WHERE id=?').run(avgNow, L.product_id);
      }
      db.prepare('UPDATE products SET cost=? WHERE id=?')
        .run(avgNow > 0 ? catalogCostFromAvgRial(avgNow) : L.old_unit_cost_rial, L.product_id);
    }
    if (head.je_id) {
      reverseJournalEntry(db, head.je_id, {
        userId: user?.id,
        reason: 'ابطال تعدیل بها',
        sourceType: 'cost_revaluation',
      });
    }
    db.prepare(`
      UPDATE cost_revaluations SET status='reversed', reversed_at=strftime('%s','now'),
        reversed_je_id=? WHERE id=?
    `).run(head.je_id || null, id);
  })();

  return db.prepare('SELECT * FROM cost_revaluations WHERE id=?').get(id);
}

function listRevaluations(db, { limit = 50 } = {}) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  return db.prepare(`
    SELECT r.*, p.code AS product_code, p.name AS product_name
    FROM cost_revaluations r
    LEFT JOIN products p ON p.id = r.product_id
    ORDER BY r.id DESC
    LIMIT ?
  `).all(lim);
}

function getRevaluation(db, id) {
  const head = db.prepare(`
    SELECT r.*, p.code AS product_code, p.name AS product_name
    FROM cost_revaluations r
    LEFT JOIN products p ON p.id = r.product_id
    WHERE r.id=?
  `).get(Number(id));
  if (!head) throw revErr('E_NOT_FOUND', 404, 'تعدیل بها یافت نشد');
  const lines = db.prepare(`
    SELECT l.*, pr.code AS product_code, pr.name AS product_name
    FROM cost_revaluation_lines l
    JOIN products pr ON pr.id = l.product_id
    WHERE l.revaluation_id=?
  `).all(head.id);
  return { ...head, lines };
}

module.exports = {
  preview,
  postRevaluation,
  reverseRevaluation,
  listRevaluations,
  getRevaluation,
  computeNewUnitCost,
  productOnHand,
  buildLinePreview,
};
