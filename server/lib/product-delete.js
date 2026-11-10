'use strict';
/**
 * Safe product delete: structure-only cascade vs real-activity block + deactivate offer.
 * Callers own the transaction/route. Never writes production crm.db by itself.
 */
const path = require('path');
const fs = require('fs');
const { releaseTafsili } = require('./coa-map');

const WEBSITE_WARN =
  'کد این کالا روی وب‌سایت وجود دارد؛ حذف در ERP صفحهٔ سایت را پاک نمی‌کند';

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch (_) {
    return false;
  }
}

function colExists(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch (_) {
    return false;
  }
}

function blocker(kind, table, docNo, message, extra) {
  const err = {
    ok: false,
    code: 'E_PRODUCT_IN_USE',
    error: message,
    kind,
    table,
    doc_no: docNo != null ? String(docNo) : null,
    can_deactivate: true,
    suggest_deactivate: true,
  };
  if (extra && typeof extra === 'object') Object.assign(err, extra);
  return err;
}

function ledgerBlocker(kind, table, docNo, message) {
  return blocker(kind, table, docNo, message, { code: 'E_PRODUCT_HAS_LEDGER' });
}

/** Exact product_id / variant_id match in JSON text (34 must not match 344). */
function jsonIdExactRe(field, id) {
  const n = String(Number(id));
  if (!/^\d+$/.test(n)) return null;
  return new RegExp(`"${field}"\\s*:\\s*${n}(?!\\d)`);
}

function rowsJsonContainsId(rowsText, field, id) {
  const re = jsonIdExactRe(field, id);
  if (!re) return false;
  return re.test(String(rowsText || ''));
}

function invoiceLikeHit(db, table, pid, opts) {
  if (!tableExists(db, table) || !colExists(db, table, 'rows')) return null;
  const numCol = colExists(db, table, 'num') ? 'num'
    : (colExists(db, table, 'doc_no') ? 'doc_no' : null);
  const select = numCol ? `id, ${numCol} AS doc_no, rows` : 'id, id AS doc_no, rows';
  const where = [];
  if (colExists(db, table, 'deleted_at')) where.push('COALESCE(deleted_at,0)=0');
  if (opts && opts.statusNotReversed && colExists(db, table, 'status')) {
    where.push("COALESCE(status,'posted')<>'reversed'");
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // Broad prefilter then exact digit-boundary check in JS
  const likePat = `%"product_id":${Number(pid)}%`;
  const likePatSp = `%"product_id": ${Number(pid)}%`;
  let candidates = [];
  try {
    candidates = db.prepare(`
      SELECT ${select} FROM ${table}
      ${whereSql ? whereSql + ' AND' : 'WHERE'} (rows LIKE ? OR rows LIKE ?)
      LIMIT 50
    `).all(likePat, likePatSp);
  } catch (e) {
    throw e;
  }
  for (const row of candidates) {
    if (rowsJsonContainsId(row.rows, 'product_id', pid)) return row;
  }
  return null;
}

function variantIdsForProduct(db, productId) {
  if (!tableExists(db, 'product_variants')) return [];
  try {
    return db.prepare('SELECT id FROM product_variants WHERE product_id=?').all(productId).map((r) => Number(r.id));
  } catch (e) {
    throw e;
  }
}

function variantHasHistory(db, variantId) {
  const vid = Number(variantId);
  if (!vid) return null;
  if (tableExists(db, 'inventory_ledger') && colExists(db, 'inventory_ledger', 'variant_id')) {
    const led = db.prepare(`
      SELECT id, tx_no, source_type, source_id FROM inventory_ledger
      WHERE variant_id=? LIMIT 1
    `).get(vid);
    if (led) {
      return {
        table: 'inventory_ledger',
        doc: led.tx_no || `${led.source_type || 'ledger'}:${led.source_id || led.id}`,
      };
    }
  }
  if (tableExists(db, 'inventory_movements') && colExists(db, 'inventory_movements', 'variant_id')) {
    const mv = db.prepare(`
      SELECT id, doc_type, doc_id FROM inventory_movements WHERE variant_id=? LIMIT 1
    `).get(vid);
    if (mv) {
      return {
        table: 'inventory_movements',
        doc: `${mv.doc_type || 'mov'}:${mv.doc_id != null ? mv.doc_id : mv.id}`,
      };
    }
  }
  // Invoice / return JSON refs by variant_id
  for (const table of ['invoices', 'purchase_invoices', 'sales_returns', 'purchase_returns', 'purchase_orders']) {
    if (!tableExists(db, table) || !colExists(db, table, 'rows')) continue;
    const likePat = `%"variant_id":${vid}%`;
    const likePatSp = `%"variant_id": ${vid}%`;
    const cands = db.prepare(`
      SELECT id, rows, ${colExists(db, table, 'num') ? 'num' : (colExists(db, table, 'doc_no') ? 'doc_no' : 'id')} AS doc_no
      FROM ${table}
      WHERE rows LIKE ? OR rows LIKE ?
      LIMIT 20
    `).all(likePat, likePatSp);
    for (const row of cands) {
      if (rowsJsonContainsId(row.rows, 'variant_id', vid)) {
        return { table, doc: row.doc_no || row.id };
      }
    }
  }
  return null;
}

/**
 * First real-activity blocker for a product, or null if structure-only.
 */
function findProductRealActivity(db, productId, prod) {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid <= 0) {
    return blocker('invalid', 'products', null, 'شناسه کالا نامعتبر است', { can_deactivate: false, code: 'E_BAD_ID' });
  }
  const product = prod || db.prepare('SELECT * FROM products WHERE id=?').get(pid);
  if (!product) {
    return blocker('missing', 'products', null, 'یافت نشد', { can_deactivate: false, code: 'E_NOT_FOUND', status: 404 });
  }

  // 1) ANY inventory_ledger history (posted/reversed/reversal/zero-qty/amount-only)
  if (tableExists(db, 'inventory_ledger')) {
    const led = db.prepare(`
      SELECT id, tx_no, event_type, source_type, source_id, status,
             COALESCE(qty_in,0) AS qty_in, COALESCE(qty_out,0) AS qty_out,
             COALESCE(amount_rial,0) AS amount_rial
      FROM inventory_ledger
      WHERE product_id=?
      ORDER BY id DESC
      LIMIT 1
    `).get(pid);
    if (led) {
      const doc = led.tx_no || `${led.source_type || 'ledger'}:${led.source_id || led.id}`;
      return ledgerBlocker(
        'inventory_ledger',
        'inventory_ledger',
        doc,
        `این کالا سابقهٔ کاردکس دارد (کاردکس ${doc}) و قابل حذف نیست — می‌توانید غیرفعال کنید`
      );
    }
  }

  // Any inventory_movements for the product
  if (tableExists(db, 'inventory_movements')) {
    const mv = db.prepare(`
      SELECT id, doc_type, doc_id FROM inventory_movements WHERE product_id=? LIMIT 1
    `).get(pid);
    if (mv) {
      const doc = `${mv.doc_type || 'mov'}:${mv.doc_id != null ? mv.doc_id : mv.id}`;
      return ledgerBlocker(
        'inventory_movements',
        'inventory_movements',
        doc,
        `این کالا حرکت انبار دارد (${doc}) و قابل حذف نیست — می‌توانید غیرفعال کنید`
      );
    }
  }

  // Variant-level ledger / movement / invoice refs
  for (const vid of variantIdsForProduct(db, pid)) {
    const hit = variantHasHistory(db, vid);
    if (hit) {
      return ledgerBlocker(
        'variant_history',
        hit.table,
        hit.doc,
        `واریانت این کالا سابقهٔ انبار/سند دارد (${hit.doc}) و قابل حذف نیست — می‌توانید غیرفعال کنید`
      );
    }
  }

  // Non-zero stock caches
  if (tableExists(db, 'warehouse_stock')) {
    const ws = db.prepare(`
      SELECT warehouse_id, qty FROM warehouse_stock
      WHERE product_id=? AND ABS(COALESCE(qty,0)) > 1e-9
      LIMIT 1
    `).get(pid);
    if (ws) {
      return blocker(
        'warehouse_stock',
        'warehouse_stock',
        `WH-${ws.warehouse_id}`,
        `این کالا موجودی غیرصفر در انبار ${ws.warehouse_id} دارد و قابل حذف نیست — می‌توانید غیرفعال کنید`
      );
    }
  }
  if (tableExists(db, 'variant_warehouse_stock')) {
    let vws = null;
    if (colExists(db, 'variant_warehouse_stock', 'product_id')) {
      vws = db.prepare(`
        SELECT warehouse_id, variant_id, qty FROM variant_warehouse_stock
        WHERE product_id=? AND ABS(COALESCE(qty,0)) > 1e-9 LIMIT 1
      `).get(pid);
    } else {
      const vids = variantIdsForProduct(db, pid);
      for (const vid of vids) {
        vws = db.prepare(`
          SELECT warehouse_id, variant_id, qty FROM variant_warehouse_stock
          WHERE variant_id=? AND ABS(COALESCE(qty,0)) > 1e-9 LIMIT 1
        `).get(vid);
        if (vws) break;
      }
    }
    if (vws) {
      return blocker(
        'variant_warehouse_stock',
        'variant_warehouse_stock',
        `WH-${vws.warehouse_id}`,
        `این کالا موجودی واریانت غیرصفر دارد و قابل حذف نیست — می‌توانید غیرفعال کنید`
      );
    }
  }

  // 2) Sales / purchase / return invoices (exact product_id)
  const inv = invoiceLikeHit(db, 'invoices', pid, {});
  if (inv) {
    const doc = inv.doc_no || inv.id;
    return blocker('invoice', 'invoices', doc, `این کالا در فاکتور ${doc} استفاده شده و قابل حذف نیست — می‌توانید غیرفعال کنید`);
  }
  const pin = invoiceLikeHit(db, 'purchase_invoices', pid, { statusNotReversed: true });
  if (pin) {
    const doc = pin.doc_no || pin.id;
    return blocker('purchase', 'purchase_invoices', doc, `این کالا در فاکتور خرید ${doc} استفاده شده و قابل حذف نیست — می‌توانید غیرفعال کنید`);
  }
  const sret = invoiceLikeHit(db, 'sales_returns', pid, { statusNotReversed: true });
  if (sret) {
    const doc = sret.doc_no || sret.id;
    return blocker('sales_return', 'sales_returns', doc, `این کالا در برگشت از فروش ${doc} استفاده شده و قابل حذف نیست — می‌توانید غیرفعال کنید`);
  }
  const pret = invoiceLikeHit(db, 'purchase_returns', pid, { statusNotReversed: true });
  if (pret) {
    const doc = pret.doc_no || pret.id;
    return blocker('purchase_return', 'purchase_returns', doc, `این کالا در برگشت از خرید ${doc} استفاده شده و قابل حذف نیست — می‌توانید غیرفعال کنید`);
  }
  const poJson = invoiceLikeHit(db, 'purchase_orders', pid, {});
  if (poJson) {
    const doc = poJson.doc_no || poJson.id;
    return blocker('purchase_order', 'purchase_orders', doc, `این کالا در سفارش خرید ${doc} استفاده شده و قابل حذف نیست — می‌توانید غیرفعال کنید`);
  }

  // CRM orders.product_id
  if (tableExists(db, 'orders') && colExists(db, 'orders', 'product_id')) {
    const ord = db.prepare('SELECT id FROM orders WHERE product_id=? LIMIT 1').get(pid);
    if (ord) {
      return blocker('order', 'orders', ord.id, `این کالا در سفارش ${ord.id} استفاده شده و قابل حذف نیست — می‌توانید غیرفعال کنید`);
    }
  }

  // warehouse_moves
  if (tableExists(db, 'warehouse_moves')) {
    const wm = db.prepare('SELECT id, type, date FROM warehouse_moves WHERE product_id=? LIMIT 1').get(pid);
    if (wm) {
      const doc = wm.id;
      return blocker('warehouse_move', 'warehouse_moves', doc, `این کالا در حواله/انتقال انبار #${doc} استفاده شده و قابل حذف نیست — می‌توانید غیرفعال کنید`);
    }
  }

  // variant_reclass_docs
  if (tableExists(db, 'variant_reclass_docs')) {
    const vr = db.prepare('SELECT id, doc_no FROM variant_reclass_docs WHERE product_id=? LIMIT 1').get(pid);
    if (vr) {
      const doc = vr.doc_no || vr.id;
      return blocker('variant_reclass', 'variant_reclass_docs', doc, `این کالا در سند اصلاح واریانت ${doc} استفاده شده و قابل حذف نیست — می‌توانید غیرفعال کنید`);
    }
  }

  // Opening stock lines — draft AND posted
  if (tableExists(db, 'opening_stock_lines') && tableExists(db, 'opening_stock_docs')) {
    const op = db.prepare(`
      SELECT d.id, d.doc_no, d.status
      FROM opening_stock_lines l
      JOIN opening_stock_docs d ON d.id = l.doc_id
      WHERE l.product_id=?
      LIMIT 1
    `).get(pid);
    if (op) {
      const doc = op.doc_no || op.id;
      return blocker('opening', 'opening_stock_docs', doc, `این کالا در سند افتتاحیه ${doc} ثبت شده و قابل حذف نیست — می‌توانید غیرفعال کنید`);
    }
  }
  if (tableExists(db, 'product_opening_stock')) {
    const pos = db.prepare('SELECT id FROM product_opening_stock WHERE product_id=? LIMIT 1').get(pid);
    if (pos) {
      return blocker('opening', 'product_opening_stock', pos.id, 'این کالا افتتاحیهٔ کالا دارد و قابل حذف نیست — می‌توانید غیرفعال کنید');
    }
  }

  // Stocktaking items belonging to a session — never cascade silently
  if (tableExists(db, 'stocktaking_items')) {
    const st = db.prepare(`
      SELECT i.id, i.session_id, s.date AS session_date
      FROM stocktaking_items i
      LEFT JOIN stocktaking_sessions s ON s.id = i.session_id
      WHERE i.product_id=?
      LIMIT 1
    `).get(pid);
    if (st) {
      const doc = st.session_id || st.id;
      return blocker(
        'stocktaking',
        'stocktaking_items',
        doc,
        `این کالا در انبارگردانی #${doc}${st.session_date ? ' (' + st.session_date + ')' : ''} استفاده شده و قابل حذف نیست — می‌توانید غیرفعال کنید`
      );
    }
  }

  // Production receipts / material issues / runs / estimates
  if (tableExists(db, 'production_receipts')) {
    const pr = db.prepare('SELECT id, doc_no FROM production_receipts WHERE product_id=? LIMIT 1').get(pid);
    if (pr) {
      const doc = pr.doc_no || pr.id;
      return blocker('production_receipt', 'production_receipts', doc, `این کالا در رسید تولید ${doc} استفاده شده و قابل حذف نیست — می‌توانید غیرفعال کنید`);
    }
  }
  if (tableExists(db, 'production_material_issues')) {
    const pmi = db.prepare(`
      SELECT id, doc_no FROM production_material_issues
      WHERE product_id=? OR substitute_of_product_id=?
      LIMIT 1
    `).get(pid, pid);
    if (pmi) {
      const doc = pmi.doc_no || pmi.id;
      return blocker('production_issue', 'production_material_issues', doc, `این کالا در حواله مواد تولید ${doc} استفاده شده و قابل حذف نیست — می‌توانید غیرفعال کنید`);
    }
  }
  if (tableExists(db, 'production_runs')) {
    const run = db.prepare('SELECT id FROM production_runs WHERE product_id=? LIMIT 1').get(pid);
    if (run) {
      return blocker('production_run', 'production_runs', run.id, `این کالا در اجرای تولید #${run.id} استفاده شده و قابل حذف نیست — می‌توانید غیرفعال کنید`);
    }
  }
  if (tableExists(db, 'production_estimates')) {
    const pe = db.prepare('SELECT id, code FROM production_estimates WHERE product_id=? LIMIT 1').get(pid);
    if (pe) {
      const doc = pe.code || pe.id;
      return blocker('production_estimate', 'production_estimates', doc, `این کالا در برآورد تولید ${doc} استفاده شده و قابل حذف نیست — می‌توانید غیرفعال کنید`);
    }
  }

  // BOM headers / lines (including draft)
  if (tableExists(db, 'bom_headers')) {
    const bh = db.prepare(`
      SELECT id, code FROM bom_headers
      WHERE product_id=? AND deleted_at IS NULL
      LIMIT 1
    `).get(pid);
    if (bh) {
      const doc = bh.code || bh.id;
      return blocker('bom', 'bom_headers', doc, `این کالا فرمول تولید ${doc} دارد و قابل حذف نیست — می‌توانید غیرفعال کنید`);
    }
  }
  if (tableExists(db, 'bom_lines')) {
    const cols = db.prepare('PRAGMA table_info(bom_lines)').all().map((c) => c.name);
    if (cols.includes('component_product_id')) {
      const bl = db.prepare(`
        SELECT l.id, h.code
        FROM bom_lines l
        LEFT JOIN bom_headers h ON h.id = l.bom_id
        WHERE l.component_product_id=?
        LIMIT 1
      `).get(pid);
      if (bl) {
        const doc = bl.code || bl.id;
        return blocker('bom_line', 'bom_lines', doc, `این کالا در فرمول تولید ${doc} به‌عنوان جزء استفاده شده و قابل حذف نیست — می‌توانید غیرفعال کنید`);
      }
    }
    if (cols.includes('scoped_product_id')) {
      const bl = db.prepare('SELECT id FROM bom_lines WHERE scoped_product_id=? LIMIT 1').get(pid);
      if (bl) {
        return blocker('bom_line', 'bom_lines', bl.id, 'این کالا در تخصیص فرمول تولید استفاده شده و قابل حذف نیست — می‌توانید غیرفعال کنید');
      }
    }
  }
  if (tableExists(db, 'bom_outputs') && colExists(db, 'bom_outputs', 'product_id')) {
    const bo = db.prepare('SELECT id, bom_id FROM bom_outputs WHERE product_id=? LIMIT 1').get(pid);
    if (bo) {
      return blocker('bom_output', 'bom_outputs', bo.bom_id || bo.id, 'این کالا در خروجی فرمول تولید استفاده شده و قابل حذف نیست — می‌توانید غیرفعال کنید');
    }
  }

  // Production orders
  if (tableExists(db, 'production_orders')) {
    const po = db.prepare('SELECT id, order_no FROM production_orders WHERE product_id=? LIMIT 1').get(pid);
    if (po) {
      const doc = po.order_no || po.id;
      return blocker('production_order', 'production_orders', doc, `این کالا در سفارش تولید ${doc} استفاده شده و قابل حذف نیست — می‌توانید غیرفعال کنید`);
    }
  }
  if (tableExists(db, 'production_order_lines') && colExists(db, 'production_order_lines', 'product_id')) {
    const pol = db.prepare(`
      SELECT l.id, o.order_no
      FROM production_order_lines l
      LEFT JOIN production_orders o ON o.id = l.order_id
      WHERE l.product_id=?
      LIMIT 1
    `).get(pid);
    if (pol) {
      const doc = pol.order_no || pol.id;
      return blocker('production_order_line', 'production_order_lines', doc, `این کالا در سفارش تولید ${doc} استفاده شده و قابل حذف نیست — می‌توانید غیرفعال کنید`);
    }
  }

  // Journal lines on product tafsili — voucher_number (not entry_no); do not swallow errors
  const coa = String(product.coa_code || '').trim();
  if (coa && tableExists(db, 'journal_lines')) {
    let jl = null;
    if (colExists(db, 'journal_lines', 'account_code')) {
      jl = db.prepare(`
        SELECT jl.id, je.voucher_number, je.id AS je_id
        FROM journal_lines jl
        LEFT JOIN journal_entries je ON je.id = jl.entry_id
        WHERE jl.account_code=?
        LIMIT 1
      `).get(coa);
    }
    if (!jl && colExists(db, 'journal_lines', 'detail_account_id') && tableExists(db, 'chart_of_accounts')) {
      const acc = db.prepare('SELECT id FROM chart_of_accounts WHERE code=?').get(coa);
      if (acc) {
        jl = db.prepare(`
          SELECT jl.id, je.voucher_number, je.id AS je_id
          FROM journal_lines jl
          LEFT JOIN journal_entries je ON je.id = jl.entry_id
          WHERE jl.detail_account_id=?
          LIMIT 1
        `).get(acc.id);
      }
    }
    if (jl) {
      const doc = jl.voucher_number || jl.je_id || jl.id;
      return blocker(
        'journal',
        'journal_lines',
        doc,
        `تفصیلی این کالا در سند حسابداری ${doc} گردش دارد و قابل حذف نیست — می‌توانید غیرفعال کنید`
      );
    }
  }

  return null;
}

function remainingFkTables(db, productId) {
  const pid = Number(productId);
  const hits = [];
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  for (const t of tables) {
    let fks;
    try { fks = db.prepare(`PRAGMA foreign_key_list(${t.name})`).all(); }
    catch (_) { continue; }
    for (const fk of fks) {
      if (fk.table !== 'products') continue;
      try {
        const row = db.prepare(`SELECT 1 AS x FROM ${t.name} WHERE ${fk.from}=? LIMIT 1`).get(pid);
        if (row) hits.push(t.name);
      } catch (_) { /* */ }
    }
  }
  for (const soft of ['website_stock_outbox', 'variant_warehouse_stock', 'inventory_ledger', 'inventory_movements']) {
    if (!tableExists(db, soft) || hits.includes(soft)) continue;
    try {
      if (db.prepare(`SELECT 1 AS x FROM ${soft} WHERE product_id=? LIMIT 1`).get(pid)) hits.push(soft);
    } catch (_) { /* */ }
  }
  return [...new Set(hits)];
}

function fkBlockError(db, pid, cause) {
  const tables = remainingFkTables(db, pid);
  const named = tables.length ? tables.join(', ') : 'unknown';
  const err = new Error(
    tables.length
      ? `حذف کالا به‌خاطر وابستگی به جدول ${named} ممکن نیست`
      : ((cause && cause.message) || 'حذف ناموفق')
  );
  err.status = 409;
  err.code = 'E_PRODUCT_FK';
  err.table = tables[0] || null;
  err.tables = tables;
  err.payload = {
    ok: false,
    error: err.message,
    code: 'E_PRODUCT_FK',
    table: err.table,
    tables: err.tables,
    can_deactivate: true,
    suggest_deactivate: true,
  };
  return err;
}

/**
 * Physically delete a structure-only product inside the caller's transaction.
 */
function cascadeDeleteUnusedProduct(db, prod, opts) {
  const product = typeof prod === 'object' && prod ? prod : db.prepare('SELECT * FROM products WHERE id=?').get(prod);
  if (!product) {
    const e = new Error('یافت نشد');
    e.status = 404;
    e.code = 'E_NOT_FOUND';
    throw e;
  }
  const pid = Number(product.id);
  const block = findProductRealActivity(db, pid, product);
  if (block) {
    const e = new Error(block.error);
    e.status = block.status || 409;
    e.code = block.code;
    e.payload = block;
    throw e;
  }

  const uploadDir = (opts && opts.uploadDir) || null;

  if (colExists(db, 'products', 'default_variant_id')) {
    db.prepare('UPDATE products SET default_variant_id=NULL WHERE id=?').run(pid);
  }

  if (tableExists(db, 'website_stock_outbox')) {
    db.prepare('DELETE FROM website_stock_outbox WHERE product_id=?').run(pid);
  }

  // Delete variants only when each has no history (re-check; should be clean after activity gate)
  if (tableExists(db, 'product_variants')) {
    const variants = db.prepare('SELECT id FROM product_variants WHERE product_id=?').all(pid);
    for (const v of variants) {
      const hit = variantHasHistory(db, v.id);
      if (hit) {
        const e = new Error(`واریانت ${v.id} سابقه دارد (${hit.doc}) و قابل حذف نیست — می‌توانید غیرفعال کنید`);
        e.status = 409;
        e.code = 'E_PRODUCT_HAS_LEDGER';
        e.payload = ledgerBlocker('variant_history', hit.table, hit.doc, e.message);
        throw e;
      }
    }
    db.prepare('DELETE FROM product_variants WHERE product_id=?').run(pid);
  }

  if (tableExists(db, 'product_style_colors')) {
    db.prepare('DELETE FROM product_style_colors WHERE product_id=?').run(pid);
  }
  if (tableExists(db, 'product_style_sizes')) {
    db.prepare('DELETE FROM product_style_sizes WHERE product_id=?').run(pid);
  }
  if (tableExists(db, 'warehouse_stock')) {
    db.prepare('DELETE FROM warehouse_stock WHERE product_id=? AND ABS(COALESCE(qty,0))<=1e-9').run(pid);
  }
  if (tableExists(db, 'variant_warehouse_stock')) {
    if (colExists(db, 'variant_warehouse_stock', 'product_id')) {
      db.prepare('DELETE FROM variant_warehouse_stock WHERE product_id=? AND ABS(COALESCE(qty,0))<=1e-9').run(pid);
    }
  }
  if (tableExists(db, 'stock_logs')) {
    db.prepare('DELETE FROM stock_logs WHERE product_id=?').run(pid);
  }
  // stocktaking_items with a session are blocked above — never cascade real stocktake lines

  if (tableExists(db, 'product_images')) {
    if (uploadDir) {
      const imgs = db.prepare('SELECT filename FROM product_images WHERE product_id=?').all(pid);
      for (const img of imgs) {
        if (!img.filename) continue;
        try { fs.unlinkSync(path.join(uploadDir, img.filename)); } catch (_) { /* file may be absent */ }
      }
    }
    db.prepare('DELETE FROM product_images WHERE product_id=?').run(pid);
  }
  if (product.image && uploadDir) {
    try { fs.unlinkSync(path.join(uploadDir, product.image)); } catch (_) { /* */ }
  }

  try {
    db.prepare('DELETE FROM products WHERE id=?').run(pid);
  } catch (e) {
    throw fkBlockError(db, pid, e);
  }

  // releaseTafsili only when the leaf is unused (in_use → keep product already gone? rolled back by txn)
  if (product.coa_code) {
    const rel = releaseTafsili(db, product.coa_code);
    if (!rel.ok && rel.reason === 'in_use') {
      const err = new Error(rel.error || 'کدینگ در گردش است');
      err.status = 409;
      err.code = 'E_TAFSILI_IN_USE';
      err.payload = {
        ok: false,
        error: err.message,
        code: 'E_TAFSILI_IN_USE',
        can_deactivate: true,
        suggest_deactivate: true,
      };
      throw err;
    }
  }

  return { ok: true, deleted_id: pid };
}

function deactivateProduct(db, productId) {
  const pid = Number(productId);
  const prod = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
  if (!prod) {
    const e = new Error('یافت نشد');
    e.status = 404;
    e.code = 'E_NOT_FOUND';
    throw e;
  }
  if (!colExists(db, 'products', 'status')) {
    const e = new Error('ستون status برای کالا در دسترس نیست');
    e.status = 500;
    e.code = 'E_NO_STATUS';
    throw e;
  }
  db.prepare("UPDATE products SET status='inactive' WHERE id=?").run(pid);
  return { ok: true, deactivated: true, id: pid, status: 'inactive' };
}

/**
 * Real Site-B2B / matrix outbox payload shapes:
 *   { matched:<number>, catalogMissing:false, code:'all_matched', ... }
 *   error with catalogMissing:false + matched>0 / onSite → SKU still on site
 * Read-only — never ensureWebsiteStockOutbox / CREATE TABLE here.
 */
function websiteSkuPresenceHint(db, product) {
  const pid = Number(product && product.id);
  if (!pid) return null;
  if (!tableExists(db, 'website_stock_outbox')) return null;
  const rows = db.prepare(`
    SELECT status, last_result, last_error FROM website_stock_outbox WHERE product_id=?
  `).all(pid);
  let sawMiss = false;
  let sawPresent = false;
  for (const r of rows) {
    const body = String(r.last_result || '');
    if (!body) continue;
    let j;
    try { j = JSON.parse(body); } catch (_) { continue; }
    if (!j || typeof j !== 'object') continue;

    const matchedN = Array.isArray(j.matched) ? j.matched.length : (Number(j.matched) || 0);
    const catalogMissing = j.catalogMissing === true
      || j.code === 'product_sku_not_found'
      || /product_sku_not_found|sku not found|not found on (website|site)/i.test(String(j.code || j.reason || j.message || ''));
    const onSite = Array.isArray(j.onSite) ? j.onSite.length : (j.onSite ? 1 : 0);

    if (catalogMissing) {
      sawMiss = true;
      continue;
    }
    if (j.code === 'all_matched' || (matchedN > 0 && j.catalogMissing === false)) {
      sawPresent = true;
      continue;
    }
    // Error result that still shows the SKU on the site (e.g. variants_unmatched)
    if (j.catalogMissing === false && (matchedN > 0 || onSite > 0 || j.code === 'variants_unmatched')) {
      sawPresent = true;
    }
  }
  if (sawPresent) return true;
  if (sawMiss) return false;
  return null;
}

async function probeWebsiteSkuExists(db, sku) {
  const code = String(sku || '').trim();
  if (!code) return { exists: null, reason: 'empty_sku' };
  try {
    const { getSettingsMap, requestJSON } = require('./website-stock-sync');
    let s;
    try { s = getSettingsMap(db, { needB2b: true, needWoo: true }); }
    catch (_) { return { exists: null, reason: 'settings_unavailable' }; }
    const base = String(s.website_wc_url || '').replace(/\/$/, '');
    const key = s.website_wc_key || '';
    const secret = s.website_wc_secret || '';
    if (!base || !key || !secret) return { exists: null, reason: 'wc_not_configured' };
    const auth = Buffer.from(`${key}:${secret}`).toString('base64');
    const listUrl = `${base}/wp-json/wc/v3/products?sku=${encodeURIComponent(code)}`;
    const found = await requestJSON(listUrl, 'GET', null, { Authorization: `Basic ${auth}` });
    let products = [];
    try { products = JSON.parse(found.body); } catch { products = []; }
    if (Array.isArray(products) && products.length) return { exists: true, reason: 'wc_sku' };
    if (found.status >= 200 && found.status < 300) return { exists: false, reason: 'wc_miss' };
    return { exists: null, reason: 'wc_http_' + found.status };
  } catch (e) {
    return { exists: null, reason: (e && e.message) || 'probe_failed' };
  }
}

async function resolveWebsiteWarning(db, product) {
  const hint = websiteSkuPresenceHint(db, product);
  if (hint === true) return WEBSITE_WARN;
  if (hint === false) return null;
  const probe = await probeWebsiteSkuExists(db, product && product.code);
  if (probe && probe.exists === true) return WEBSITE_WARN;
  return null;
}

module.exports = {
  findProductRealActivity,
  cascadeDeleteUnusedProduct,
  deactivateProduct,
  websiteSkuPresenceHint,
  probeWebsiteSkuExists,
  resolveWebsiteWarning,
  remainingFkTables,
  rowsJsonContainsId,
  jsonIdExactRe,
  variantHasHistory,
  WEBSITE_WARN,
};
