'use strict';
/**
 * Safe product delete: structure-only cascade vs real-activity block + deactivate offer.
 * No writes to production DB from this module itself — callers own the transaction/route.
 */
const path = require('path');
const fs = require('fs');
const { releaseTafsili } = require('./coa-map');
const { LEDGER_LIVE_SQL } = require('./inventory/layer-reconcile');

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

function invoiceLikeHit(db, table, pid, opts) {
  if (!tableExists(db, table)) return null;
  const numCol = colExists(db, table, 'num') ? 'num' : (colExists(db, table, 'doc_no') ? 'doc_no' : null);
  const select = numCol ? `id, ${numCol} AS doc_no` : 'id, id AS doc_no';
  const where = [];
  if (colExists(db, table, 'deleted_at')) where.push('COALESCE(deleted_at,0)=0');
  if (opts && opts.statusNotReversed && colExists(db, table, 'status')) {
    where.push("COALESCE(status,'posted')<>'reversed'");
  }
  const whereSql = where.length ? ` AND ${where.join(' AND ')}` : '';
  const patterns = [`%"product_id":${pid}%`, `%"product_id": ${pid}%`];
  for (const pat of patterns) {
    try {
      const row = db.prepare(`
        SELECT ${select} FROM ${table}
        WHERE rows LIKE ? ${whereSql}
        LIMIT 1
      `).get(pat);
      if (row) return row;
    } catch (_) { /* */ }
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

  // 1) Live non-zero inventory ledger
  if (tableExists(db, 'inventory_ledger')) {
    try {
      const led = db.prepare(`
        SELECT id, tx_no, event_type, source_type, source_id,
               COALESCE(qty_in,0) AS qty_in, COALESCE(qty_out,0) AS qty_out
        FROM inventory_ledger
        WHERE product_id=?
          AND (${LEDGER_LIVE_SQL})
          AND (ABS(COALESCE(qty_in,0)) > 1e-9 OR ABS(COALESCE(qty_out,0)) > 1e-9)
        ORDER BY id DESC
        LIMIT 1
      `).get(pid);
      if (led) {
        const doc = led.tx_no || `${led.source_type || 'ledger'}:${led.source_id || led.id}`;
        return blocker(
          'inventory_ledger',
          'inventory_ledger',
          doc,
          `این کالا گردش انبار زنده دارد (کاردکس ${doc}) و قابل حذف نیست — می‌توانید غیرفعال کنید`
        );
      }
    } catch (_) { /* schema drift */ }
  }

  // Non-zero stock caches (should not exist without ledger under SSOT — still block)
  if (tableExists(db, 'warehouse_stock')) {
    try {
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
    } catch (_) { /* */ }
  }
  if (tableExists(db, 'variant_warehouse_stock')) {
    try {
      const vws = db.prepare(`
        SELECT warehouse_id, variant_id, qty FROM variant_warehouse_stock
        WHERE product_id=? AND ABS(COALESCE(qty,0)) > 1e-9
        LIMIT 1
      `).get(pid);
      if (vws) {
        return blocker(
          'variant_warehouse_stock',
          'variant_warehouse_stock',
          `WH-${vws.warehouse_id}`,
          `این کالا موجودی واریانت غیرصفر دارد و قابل حذف نیست — می‌توانید غیرفعال کنید`
        );
      }
    } catch (_) { /* */ }
  }

  // 2) Sales / purchase / return invoices
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

  // 3) Posted opening docs
  if (tableExists(db, 'opening_stock_lines') && tableExists(db, 'opening_stock_docs')) {
    try {
      const op = db.prepare(`
        SELECT d.id, d.doc_no
        FROM opening_stock_lines l
        JOIN opening_stock_docs d ON d.id = l.doc_id
        WHERE l.product_id=?
          AND COALESCE(d.status,'posted')='posted'
          AND COALESCE(l.active,1)=1
        LIMIT 1
      `).get(pid);
      if (op) {
        const doc = op.doc_no || op.id;
        return blocker('opening', 'opening_stock_docs', doc, `این کالا در سند افتتاحیه ${doc} ثبت شده و قابل حذف نیست — می‌توانید غیرفعال کنید`);
      }
    } catch (_) { /* */ }
  }
  if (tableExists(db, 'product_opening_stock')) {
    try {
      const pos = db.prepare('SELECT id FROM product_opening_stock WHERE product_id=? LIMIT 1').get(pid);
      if (pos) {
        return blocker('opening', 'product_opening_stock', pos.id, `این کالا افتتاحیهٔ کالا دارد و قابل حذف نیست — می‌توانید غیرفعال کنید`);
      }
    } catch (_) { /* */ }
  }

  // 4) BOM headers / lines (including draft)
  if (tableExists(db, 'bom_headers')) {
    try {
      const bh = db.prepare(`
        SELECT id, code FROM bom_headers
        WHERE product_id=? AND deleted_at IS NULL
        LIMIT 1
      `).get(pid);
      if (bh) {
        const doc = bh.code || bh.id;
        return blocker('bom', 'bom_headers', doc, `این کالا فرمول تولید ${doc} دارد و قابل حذف نیست — می‌توانید غیرفعال کنید`);
      }
    } catch (_) { /* */ }
  }
  if (tableExists(db, 'bom_lines')) {
    try {
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
    } catch (_) { /* */ }
  }
  if (tableExists(db, 'bom_outputs') && colExists(db, 'bom_outputs', 'product_id')) {
    try {
      const bo = db.prepare('SELECT id, bom_id FROM bom_outputs WHERE product_id=? LIMIT 1').get(pid);
      if (bo) {
        return blocker('bom_output', 'bom_outputs', bo.bom_id || bo.id, 'این کالا در خروجی فرمول تولید استفاده شده و قابل حذف نیست — می‌توانید غیرفعال کنید');
      }
    } catch (_) { /* */ }
  }

  // 5) Production orders
  if (tableExists(db, 'production_orders')) {
    try {
      const po = db.prepare(`
        SELECT id, order_no FROM production_orders WHERE product_id=? LIMIT 1
      `).get(pid);
      if (po) {
        const doc = po.order_no || po.id;
        return blocker('production_order', 'production_orders', doc, `این کالا در سفارش تولید ${doc} استفاده شده و قابل حذف نیست — می‌توانید غیرفعال کنید`);
      }
    } catch (_) { /* */ }
  }
  if (tableExists(db, 'production_order_lines') && colExists(db, 'production_order_lines', 'product_id')) {
    try {
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
    } catch (_) { /* */ }
  }

  // 6) Journal lines on product tafsili
  const coa = String(product.coa_code || '').trim();
  if (coa && tableExists(db, 'journal_lines')) {
    try {
      let jl = null;
      if (colExists(db, 'journal_lines', 'account_code')) {
        jl = db.prepare(`
          SELECT jl.id, je.entry_no, je.id AS je_id
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
            SELECT jl.id, je.entry_no, je.id AS je_id
            FROM journal_lines jl
            LEFT JOIN journal_entries je ON je.id = jl.entry_id
            WHERE jl.detail_account_id=?
            LIMIT 1
          `).get(acc.id);
        }
      }
      if (jl) {
        const doc = jl.entry_no || jl.je_id || jl.id;
        return blocker(
          'journal',
          'journal_lines',
          doc,
          `تفصیلی این کالا در سند حسابداری ${doc} گردش دارد و قابل حذف نیست — می‌توانید غیرفعال کنید`
        );
      }
    } catch (_) { /* */ }
  }

  return null;
}

function tryDelete(db, sql, args) {
  try {
    db.prepare(sql).run(...args);
    return true;
  } catch (_) {
    return false;
  }
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
  // Also non-FK children that commonly block deletes
  for (const soft of ['website_stock_outbox', 'variant_warehouse_stock', 'inventory_ledger']) {
    if (!tableExists(db, soft) || hits.includes(soft)) continue;
    try {
      if (db.prepare(`SELECT 1 AS x FROM ${soft} WHERE product_id=? LIMIT 1`).get(pid)) hits.push(soft);
    } catch (_) { /* */ }
  }
  return [...new Set(hits)];
}

/**
 * Physically delete a structure-only product inside the caller's transaction.
 * Throws Error with .status=409 and .table when FK remains.
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

  // Break self-FK before variants go away
  if (colExists(db, 'products', 'default_variant_id')) {
    tryDelete(db, 'UPDATE products SET default_variant_id=NULL WHERE id=?', [pid]);
  }

  if (tableExists(db, 'website_stock_outbox')) {
    tryDelete(db, 'DELETE FROM website_stock_outbox WHERE product_id=?', [pid]);
  }
  if (tableExists(db, 'product_variants')) {
    tryDelete(db, 'DELETE FROM product_variants WHERE product_id=?', [pid]);
  }
  if (tableExists(db, 'product_style_colors')) {
    tryDelete(db, 'DELETE FROM product_style_colors WHERE product_id=?', [pid]);
  }
  if (tableExists(db, 'product_style_sizes')) {
    tryDelete(db, 'DELETE FROM product_style_sizes WHERE product_id=?', [pid]);
  }
  // Only zero cache rows
  if (tableExists(db, 'warehouse_stock')) {
    tryDelete(db, 'DELETE FROM warehouse_stock WHERE product_id=? AND ABS(COALESCE(qty,0))<=1e-9', [pid]);
  }
  if (tableExists(db, 'variant_warehouse_stock')) {
    tryDelete(db, 'DELETE FROM variant_warehouse_stock WHERE product_id=? AND ABS(COALESCE(qty,0))<=1e-9', [pid]);
  }
  if (tableExists(db, 'stock_logs')) {
    tryDelete(db, 'DELETE FROM stock_logs WHERE product_id=?', [pid]);
  }
  if (tableExists(db, 'stocktaking_items')) {
    tryDelete(db, 'DELETE FROM stocktaking_items WHERE product_id=?', [pid]);
  }
  if (tableExists(db, 'product_images')) {
    if (uploadDir) {
      try {
        const imgs = db.prepare('SELECT filename FROM product_images WHERE product_id=?').all(pid);
        for (const img of imgs) {
          if (!img.filename) continue;
          try { fs.unlinkSync(path.join(uploadDir, img.filename)); } catch (_) { /* */ }
        }
      } catch (_) { /* */ }
    }
    tryDelete(db, 'DELETE FROM product_images WHERE product_id=?', [pid]);
  }
  if (product.image && uploadDir) {
    try { fs.unlinkSync(path.join(uploadDir, product.image)); } catch (_) { /* */ }
  }

  try {
    db.prepare('DELETE FROM products WHERE id=?').run(pid);
  } catch (e) {
    const tables = remainingFkTables(db, pid);
    const named = tables.length ? tables.join(', ') : 'unknown';
    const err = new Error(
      tables.length
        ? `حذف کالا به‌خاطر وابستگی به جدول ${named} ممکن نیست`
        : (e && e.message) || 'حذف ناموفق'
    );
    err.status = 409;
    err.code = 'E_PRODUCT_FK';
    err.table = tables[0] || null;
    err.tables = tables;
    throw err;
  }

  if (product.coa_code) {
    const rel = releaseTafsili(db, product.coa_code);
    if (!rel.ok && rel.reason === 'in_use') {
      const err = new Error(rel.error || 'کدینگ در گردش است');
      err.status = 409;
      err.code = 'E_TAFSILI_IN_USE';
      throw err;
    }
  }

  return { ok: true, deleted_id: pid };
}

function deactivateProduct(db, productId, opts) {
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
 * Best-effort: did this SKU sync to / exist on the website?
 * Returns true | false | null (unknown).
 */
function websiteSkuPresenceHint(db, product) {
  const pid = Number(product && product.id);
  if (!pid) return null;
  try {
    const { ensureWebsiteStockOutbox } = require('./website-stock-sync');
    ensureWebsiteStockOutbox(db);
    const rows = db.prepare(`
      SELECT status, last_result, last_error FROM website_stock_outbox WHERE product_id=?
    `).all(pid);
    let sawMiss = false;
    for (const r of rows) {
      const body = String(r.last_result || '');
      if (!body) continue;
      let j = null;
      try { j = JSON.parse(body); } catch (_) { j = null; }
      if (!j || typeof j !== 'object') continue;
      const reason = String(j.reason || j.message || '');
      if (/sku not found|not found on (website|site)|unmatched/i.test(reason)) {
        sawMiss = true;
        continue;
      }
      if (j.skip && /stock_off|missing/i.test(String(j.reason || ''))) continue;
      if (j.ok === false && /not found/i.test(reason)) { sawMiss = true; continue; }
      if (j.ok === true || j.siteProductId || j.wc_id || j.matched === true) return true;
    }
    if (sawMiss && rows.length) return false;
  } catch (_) { /* */ }
  return null;
}

async function probeWebsiteSkuExists(db, sku) {
  const code = String(sku || '').trim();
  if (!code) return { exists: null, reason: 'empty_sku' };
  try {
    const {
      getSettingsMap, requestJSON,
    } = (() => {
      const m = require('./website-stock-sync');
      return m;
    })();
    // Prefer Site-B2B / Woo settings already used by stock sync
    let s;
    try { s = getSettingsMap(db, { needB2b: true, needWoo: true }); }
    catch (_) { return { exists: null, reason: 'settings_unavailable' }; }
    const base = String(s.website_wc_url || '').replace(/\/$/, '');
    const key = s.website_wc_key || '';
    const secret = s.website_wc_secret || '';
    if (!base || !key || !secret) {
      // Site-B2B may still know the SKU via prior outbox — leave to hint
      return { exists: null, reason: 'wc_not_configured' };
    }
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
  WEBSITE_WARN,
};
