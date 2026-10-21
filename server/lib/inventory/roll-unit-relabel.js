'use strict';
/**
 * v515 — اصلاح برچسب واحد طاقه.
 *
 * Legacy receipts stored inventory_batches.unit='m' on fabrics whose stock unit
 * is kg (or another non-length unit) while every quantity (ledger, warehouse
 * stock, purchase line, qty_received) is already in the product unit. Only the
 * label is wrong, so the fix rewrites the label — no ledger or journal rows.
 * Each relabel is recorded per batch in fabric_roll_unit_relabels and can be
 * undone while the roll is still unused by any live cutting lay (R13).
 */

const crypto = require('crypto');
const uom = require('../uom');
const { liveBatchMeters } = require('./fabric-rolls');

const EPS = 1e-6;

function httpErr(status, message, code, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function unitBrief(row) {
  if (!row) return null;
  return {
    id: row.id, code: row.code, name: row.name, dimension: row.dimension || 'count',
    token: uom.rollUnitToken(row),
  };
}

/** Dimension of a stored roll token; null when the text is not in the catalog and not length-like. */
function tokenDimension(db, token) {
  const t = String(token == null ? '' : token).trim();
  // Empty roll unit is displayed and consumed as metres (rollUnitLabel).
  if (!t) return 'length';
  const row = uom.matchText(db, t);
  if (row) return row.dimension || 'count';
  return uom.isLengthText(t) ? 'length' : null;
}

function usedByLiveLay(db, batchId) {
  if (!tableExists(db, 'cutting_lay_rolls') || !tableExists(db, 'cutting_lays')) return false;
  return !!db.prepare(`
    SELECT 1 FROM cutting_lay_rolls r
    JOIN cutting_lays l ON l.id = r.lay_id
    WHERE r.batch_id=? AND COALESCE(l.status,'posted') <> 'reversed'
    LIMIT 1
  `).get(Number(batchId));
}

function parseRows(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

/**
 * Purchase evidence for a purchase-sourced roll. Goods receipts also write
 * source_type='purchase' with their own id, so the receipt ledger row decides
 * which document source_id belongs to.
 */
function purchaseEvidence(db, b) {
  const out = { purchase_qty: null, ledger_qty_in: null, purchase_doc: null };
  let led = null;
  if (b.ledger_id) {
    led = db.prepare('SELECT id, source_type, source_id, qty_in FROM inventory_ledger WHERE id=?').get(b.ledger_id) || null;
  }
  if (led) out.ledger_qty_in = Number(led.qty_in) || 0;
  const docType = led ? String(led.source_type || '') : 'purchase';
  const docId = led && led.source_id ? Number(led.source_id) : Number(b.source_id);
  if (docType !== 'purchase' || !docId || !tableExists(db, 'purchase_invoices')) return out;
  const inv = db.prepare('SELECT id, num, rows FROM purchase_invoices WHERE id=?').get(docId);
  if (!inv) return out;
  out.purchase_doc = { id: inv.id, num: inv.num || '' };
  const lines = parseRows(inv.rows).filter((r) => Number(r && r.product_id) === Number(b.product_id));
  if (!lines.length) return out;
  const received = Number(b.qty_received) || 0;
  const rollNo = String(b.batch_no || '');
  const hit = lines.find((r) => Number(r.batch_id) === Number(b.id))
    || lines.find((r) => rollNo && String(r.roll_no || r.batch_no || '') === rollNo)
    || lines.find((r) => Math.abs((Number(r.qty) || 0) - received) <= EPS)
    || lines[0];
  out.purchase_qty = Number(hit.qty) || 0;
  return out;
}

function previewRollUnitRelabel(db, productId) {
  const pid = Number(productId);
  if (!pid) throw httpErr(400, 'کالا الزامی است', 'E_RELABEL_PRODUCT');
  const prod = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
  if (!prod) throw httpErr(404, 'کالا یافت نشد', 'E_RELABEL_PRODUCT');

  const blockers = [];
  const stock = uom.stockUnitForProduct(db, prod);
  const stockToken = stock ? uom.rollUnitToken(stock) : '';
  if (!stock) {
    blockers.push({ code: 'E_RELABEL_STOCK_UNIT', message: `واحد کارت کالا («${prod.unit || '—'}») در کاتالوگ واحدها شناخته نشد` });
  } else if (!uom.ROLL_ENTRY_DIMENSIONS.includes(stock.dimension || 'count')) {
    blockers.push({ code: 'E_RELABEL_STOCK_DIM', message: `واحد انبار «${stock.name}» برای طاقه مجاز نیست (فقط طول، وزن یا مساحت)` });
  }

  const batchCols = columns(db, 'inventory_batches');
  const rows = db.prepare(`
    SELECT * FROM inventory_batches
    WHERE product_id=? AND COALESCE(kind,'generic')='fabric' AND COALESCE(status,'') <> 'reversed'
    ORDER BY id
  `).all(pid);

  const rolls = [];
  for (const b of rows) {
    if (!stock) break;
    const dim = tokenDimension(db, b.unit);
    if (!dim || dim === stock.dimension) continue;
    const live = liveBatchMeters(db, b.id);
    const item = {
      id: b.id,
      batch_no: b.batch_no,
      color: b.color || '',
      unit: b.unit || '',
      new_unit: stockToken,
      qty_on_hand: live != null ? Math.max(0, live) : (Number(b.qty_on_hand) || 0),
      qty_received: Number(b.qty_received) || 0,
      source_type: b.source_type || '',
      entry_unit_id: batchCols.includes('entry_unit_id') ? (b.entry_unit_id || null) : null,
      entry_qty: batchCols.includes('entry_qty') ? b.entry_qty : null,
      entry_factor: batchCols.includes('entry_factor') ? b.entry_factor : null,
      used_by_lay: usedByLiveLay(db, b.id) ? 1 : 0,
    };
    if (item.used_by_lay) {
      blockers.push({ code: 'E_RELABEL_LAY_USED', batch_id: b.id, message: `طاقه ${b.batch_no} در لایه‌چینی فعال مصرف شده است؛ ابتدا لایه را ابطال کنید` });
    }
    if (String(b.source_type || '') === 'purchase') {
      const ev = purchaseEvidence(db, b);
      item.purchase_qty = ev.purchase_qty;
      item.ledger_qty_in = ev.ledger_qty_in;
      item.purchase_doc = ev.purchase_doc;
      if (ev.purchase_qty == null && ev.ledger_qty_in == null) {
        blockers.push({ code: 'E_RELABEL_PURCHASE_LINE', batch_id: b.id, message: `ردیف خرید طاقه ${b.batch_no} پیدا نشد؛ نمی‌توان ثابت کرد مقدار به واحد کالاست` });
      }
      if (ev.purchase_qty != null && Math.abs(ev.purchase_qty - item.qty_received) > EPS) {
        blockers.push({ code: 'E_RELABEL_PURCHASE_QTY', batch_id: b.id, message: `مقدار طاقه ${b.batch_no} (${item.qty_received}) با مقدار ردیف خرید (${ev.purchase_qty}) برابر نیست؛ مقدار هم باید تبدیل شود، نه فقط برچسب` });
      }
      if (ev.ledger_qty_in != null && Math.abs(ev.ledger_qty_in - item.qty_received) > EPS) {
        blockers.push({ code: 'E_RELABEL_LEDGER_QTY', batch_id: b.id, message: `ورود دفتر انبار طاقه ${b.batch_no} (${ev.ledger_qty_in}) با مقدار دریافتی (${item.qty_received}) برابر نیست` });
      }
    }
    rolls.push(item);
  }
  if (stock && !rolls.length && !blockers.length) {
    blockers.push({ code: 'E_RELABEL_NONE', message: 'طاقهٔ فعالی با واحد ناهمخوان برای این کالا نیست' });
  }

  const led = db.prepare(`
    SELECT COALESCE(SUM(qty_in),0) - COALESCE(SUM(qty_out),0) AS bal, COUNT(*) AS n
    FROM inventory_ledger WHERE product_id=?
  `).get(pid);
  const wh = db.prepare('SELECT COALESCE(SUM(qty),0) AS q FROM warehouse_stock WHERE product_id=?').get(pid);

  return {
    product: { id: prod.id, name: prod.name, code: prod.code || '', unit: prod.unit || '', unit_id: prod.unit_id || null, stock: Number(prod.stock) || 0 },
    stock_unit: unitBrief(stock),
    rolls,
    rolls_live_total: rolls.reduce((s, r) => s + (Number(r.qty_on_hand) || 0), 0),
    ledger_balance: Number(led.bal) || 0,
    ledger_rows: Number(led.n) || 0,
    warehouse_stock: Number(wh.q) || 0,
    blockers,
    can_relabel: blockers.length === 0 && rolls.length > 0 ? 1 : 0,
  };
}

/**
 * A receipt typed in the old roll unit with factor 1 and the same qty as
 * qty_received is the same mislabel (it would feed lay-unit a 1 kg = 1 m
 * factor). Real conversions (factor ≠ 1) are kept.
 */
function entryNeedsReset(db, roll, stock) {
  if (!roll.entry_unit_id) return true;
  const entry = uom.getUnit(db, roll.entry_unit_id);
  if (!entry) return true;
  if ((entry.dimension || 'count') === stock.dimension) return false;
  const f = roll.entry_factor == null ? 1 : Number(roll.entry_factor);
  const q = roll.entry_qty == null ? roll.qty_received : Number(roll.entry_qty);
  return Math.abs(f - 1) <= EPS && Math.abs(q - roll.qty_received) <= EPS;
}

function relabelRollUnits(db, productId, { reason, confirm } = {}, user) {
  if (confirm !== true) throw httpErr(400, 'تأیید صریح لازم است', 'E_RELABEL_CONFIRM');
  const why = String(reason || '').trim();
  if (!why) throw httpErr(400, 'دلیل اصلاح الزامی است', 'E_RELABEL_REASON');
  const userId = user && user.id ? Number(user.id) : null;

  return db.transaction(() => {
    const pv = previewRollUnitRelabel(db, productId);
    if (pv.blockers.length) {
      throw httpErr(409, pv.blockers[0].message, 'E_RELABEL_BLOCKED', { blockers: pv.blockers });
    }
    const stock = uom.getUnit(db, pv.stock_unit.id);
    const token = pv.stock_unit.token;
    const cols = columns(db, 'inventory_batches');
    const hasEntry = cols.includes('entry_unit_id') && cols.includes('entry_qty') && cols.includes('entry_factor');
    const groupKey = 'rru-' + pv.product.id + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
    const ins = db.prepare(`
      INSERT INTO fabric_roll_unit_relabels
        (batch_id, product_id, old_unit, new_unit, old_entry_unit_id, old_entry_qty, old_entry_factor,
         entry_reset, reason, user_id, group_key)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);
    const ids = [];
    for (const r of pv.rolls) {
      const reset = hasEntry && entryNeedsReset(db, r, stock);
      const id = Number(ins.run(
        r.id, pv.product.id, r.unit, token,
        r.entry_unit_id, r.entry_qty == null ? null : Number(r.entry_qty),
        r.entry_factor == null ? null : Number(r.entry_factor),
        reset ? 1 : 0, why, userId, groupKey
      ).lastInsertRowid);
      ids.push(id);
      db.prepare('UPDATE inventory_batches SET unit=? WHERE id=?').run(token, r.id);
      if (reset) {
        db.prepare('UPDATE inventory_batches SET entry_unit_id=?, entry_qty=?, entry_factor=1 WHERE id=?')
          .run(stock.id, r.qty_received, r.id);
      }
    }
    return {
      id: ids[0],
      ids,
      group_key: groupKey,
      product_id: pv.product.id,
      new_unit: token,
      stock_unit: pv.stock_unit,
      count: ids.length,
      batch_ids: pv.rolls.map((r) => r.id),
    };
  })();
}

function undoRollUnitRelabel(db, ref, { reason } = {}, user) {
  const why = String(reason || '').trim();
  if (!why) throw httpErr(400, 'دلیل بازگردانی الزامی است', 'E_RELABEL_REASON');
  const userId = user && user.id ? Number(user.id) : null;
  let groupKey = String(ref == null ? '' : ref).trim();
  if (/^\d+$/.test(groupKey)) {
    const row = db.prepare('SELECT group_key FROM fabric_roll_unit_relabels WHERE id=?').get(Number(groupKey));
    if (!row) throw httpErr(404, 'اصلاح واحد یافت نشد', 'E_RELABEL_NOT_FOUND');
    groupKey = row.group_key;
  }
  return db.transaction(() => {
    const rows = db.prepare(`
      SELECT * FROM fabric_roll_unit_relabels WHERE group_key=? AND reversed_at IS NULL ORDER BY id
    `).all(groupKey);
    if (!rows.length) throw httpErr(409, 'این اصلاح قبلاً بازگردانی شده یا وجود ندارد', 'E_RELABEL_REVERSED');
    const blockers = [];
    for (const r of rows) {
      const b = db.prepare('SELECT id, batch_no, unit FROM inventory_batches WHERE id=?').get(r.batch_id);
      if (!b) { blockers.push({ code: 'E_RELABEL_BATCH', batch_id: r.batch_id, message: `طاقه #${r.batch_id} یافت نشد` }); continue; }
      if (usedByLiveLay(db, r.batch_id)) {
        blockers.push({ code: 'E_RELABEL_LAY_USED', batch_id: r.batch_id, message: `طاقه ${b.batch_no} پس از اصلاح در لایه‌چینی مصرف شده؛ بازگردانی ممکن نیست مگر لایه ابطال شود` });
      }
      if (String(b.unit || '') !== String(r.new_unit || '')) {
        blockers.push({ code: 'E_RELABEL_CHANGED', batch_id: r.batch_id, message: `واحد طاقه ${b.batch_no} پس از اصلاح دوباره تغییر کرده است` });
      }
    }
    if (blockers.length) {
      throw httpErr(409, blockers[0].message, 'E_RELABEL_UNDO_BLOCKED', { blockers });
    }
    for (const r of rows) {
      db.prepare('UPDATE inventory_batches SET unit=? WHERE id=?').run(r.old_unit, r.batch_id);
      if (Number(r.entry_reset) === 1) {
        db.prepare('UPDATE inventory_batches SET entry_unit_id=?, entry_qty=?, entry_factor=? WHERE id=?')
          .run(r.old_entry_unit_id, r.old_entry_qty, r.old_entry_factor, r.batch_id);
      }
      db.prepare(`
        UPDATE fabric_roll_unit_relabels
        SET reversed_at=strftime('%s','now'), reversed_by=?, reverse_reason=?
        WHERE id=?
      `).run(userId, why, r.id);
    }
    return {
      id: rows[0].id,
      group_key: groupKey,
      product_id: rows[0].product_id,
      count: rows.length,
      batch_ids: rows.map((r) => r.batch_id),
      restored_unit: rows[0].old_unit,
    };
  })();
}

function listRollUnitRelabels(db, query = {}) {
  const where = [];
  const params = [];
  if (query.product_id) { where.push('x.product_id=?'); params.push(Number(query.product_id)); }
  const rows = db.prepare(`
    SELECT x.*, b.batch_no, b.color, b.unit AS current_unit, p.name AS product_name,
           u.name AS user_name, ru.name AS reversed_by_name
    FROM fabric_roll_unit_relabels x
    LEFT JOIN inventory_batches b ON b.id = x.batch_id
    LEFT JOIN products p ON p.id = x.product_id
    LEFT JOIN users u ON u.id = x.user_id
    LEFT JOIN users ru ON ru.id = x.reversed_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY x.id DESC
    LIMIT 500
  `).all(...params);
  const groups = new Map();
  for (const r of rows) {
    let g = groups.get(r.group_key);
    if (!g) {
      g = {
        id: r.id, group_key: r.group_key, product_id: r.product_id, product_name: r.product_name,
        old_unit: r.old_unit, new_unit: r.new_unit, reason: r.reason, user_name: r.user_name,
        created_at: r.created_at, reversed_at: r.reversed_at, reverse_reason: r.reverse_reason,
        reversed_by_name: r.reversed_by_name, rolls: [],
      };
      groups.set(r.group_key, g);
    }
    g.id = Math.min(g.id, r.id);
    g.rolls.push({ id: r.id, batch_id: r.batch_id, batch_no: r.batch_no, color: r.color, current_unit: r.current_unit, reversed_at: r.reversed_at });
  }
  return { rows, groups: [...groups.values()] };
}

module.exports = {
  previewRollUnitRelabel,
  relabelRollUnits,
  undoRollUnitRelabel,
  listRollUnitRelabels,
};
