'use strict';
/**
 * P2 — سند موجودی اول دوره (کالا × انبار × واریانت).
 *
 *   createDraft  → سند پیش‌نویس (بدون اثر روی موجودی/کاردکس/دفتر کل؛ فقط سطرهای سند)
 *   postDoc      → یک تراکنش: برای هر خط postInventoryMovement(opening, variantId, unitCostRial)
 *                  + postVariantLayer؛ یک JE: Dr حساب موجودی هر انبار / Cr coa_opening_balance
 *                  (تاریخ = fiscalOpeningDate؛ assertPeriodOpen). سازندهٔ سند نمی‌تواند همان را post کند
 *                  (maker-checker، حتی admin).
 *   voidDoc      → R13: برگشت کامل ledger + لایهٔ واریانت + JE (و در پیش‌نویس فقط وضعیت void)؛
 *                  ویرایش سند posted فقط با void و سند جدید.
 *
 * یکتایی: بین اسناد posted یک (fiscal_year, product, warehouse, variant) فقط یک‌بار
 * (ایندکس یکتای جزئی روی opening_stock_lines.active=1) → 409 E_OPENING_DUPLICATE.
 * حذف فیزیکی ممنوع — پیش‌نویس هم با void بسته می‌شود.
 */
const { assertNoLiveOpening } = require('./opening-guard');

const SOURCE = 'opening_stock_doc';
const PERM_RESOURCE = 'acc_warehouse_ops';

function osErr(code, status, message, extra) {
  const e = new Error(message || code);
  e.code = code;
  e.status = status || 400;
  if (extra) Object.assign(e, extra);
  return e;
}

function round3(n) { return Math.round((Number(n) || 0) * 1000) / 1000; }
function today() { return require('../../jalali').todayJalali(); }

function canView(user, db) {
  if (!user) return false;
  // بهای واحد/ارزش در سند هست — فقط acc_warehouse_ops:view (نه reports:view که فروشنده هم دارد).
  return require('../rbac').canDo(user, PERM_RESOURCE, 'view', db);
}
function canCreate(user, db) {
  if (!user) return false;
  return require('../rbac').canDo(user, PERM_RESOURCE, 'create', db);
}
/** post همان مجوز create را می‌خواهد + کاربرِ غیر از سازنده (assertMakerChecker). */
function canPost(user, db) { return canCreate(user, db); }
function canVoid(user, db) {
  if (!user) return false;
  return require('../rbac').canDo(user, PERM_RESOURCE, 'delete', db);
}

function tableOk(db) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='opening_stock_docs'").get();
  } catch (_) { return false; }
}

/** سال مالی فعال (یا null) + تاریخ افتتاحیه. */
function fiscalContext(db) {
  const { getActiveFiscalYear } = require('../fiscal-period');
  const { fiscalOpeningDate } = require('../opening-post');
  const fy = getActiveFiscalYear(db);
  return { fiscalYearId: fy ? fy.id : null, date: fiscalOpeningDate(db) };
}

/**
 * ورود گروهی/اکسل: کد کالا (product_code یا بارکد)، کد/نام انبار (warehouse_code/warehouse_name)،
 * SKU واریانت (variant_sku) → شناسه. شناسه‌های صریح اولویت دارند.
 */
function resolveRefs(db, raw, idx = 0) {
  const n = idx + 1;
  const out = { ...(raw || {}) };
  const clean = (v) => String(v == null ? '' : v).replace(/[\u200c\u200f\u200e]/g, '').trim();
  if (!(Number(out.product_id) > 0)) {
    const code = clean(out.product_code);
    if (code) {
      const p = db.prepare('SELECT id FROM products WHERE code=? OR barcode=? ORDER BY (code=?) DESC LIMIT 1').get(code, code, code);
      if (!p) throw osErr('E_OPENING_REF_NOT_FOUND', 404, `ردیف ${n}: کالا با کد «${code}» یافت نشد`);
      out.product_id = p.id;
    }
  }
  if (!(Number(out.warehouse_id) > 0)) {
    const wc = clean(out.warehouse_code) || clean(out.warehouse_name);
    if (wc) {
      const w = db.prepare('SELECT id FROM warehouses WHERE code=? OR name=? ORDER BY (code=?) DESC LIMIT 1').get(wc, wc, wc);
      if (!w) throw osErr('E_OPENING_REF_NOT_FOUND', 404, `ردیف ${n}: انبار «${wc}» یافت نشد`);
      out.warehouse_id = w.id;
    }
  }
  if (!(Number(out.variant_id) > 0)) {
    const sku = clean(out.variant_sku);
    if (sku) {
      const v = db.prepare('SELECT id FROM product_variants WHERE sku=? AND (?=0 OR product_id=?) LIMIT 1')
        .get(sku, Number(out.product_id) || 0, Number(out.product_id) || 0);
      if (!v) throw osErr('E_OPENING_REF_NOT_FOUND', 404, `ردیف ${n}: واریانت با SKU «${sku}» یافت نشد`);
      out.variant_id = v.id;
    }
  }
  return out;
}

/**
 * اعتبارسنجی یک خط (بدون نوشتن). qty>0، unit_cost>0، کالای ماتریسی ⇒ variant الزامی.
 */
function validateLine(db, raw, idx = 0) {
  const n = idx + 1;
  const productId = Number(raw && raw.product_id) || 0;
  if (!productId) throw osErr('E_OPENING_LINE', 400, `ردیف ${n}: کالا الزامی است`);
  const product = db.prepare('SELECT id, name, code, unit FROM products WHERE id=?').get(productId);
  if (!product) throw osErr('E_PRODUCT_NOT_FOUND', 404, `ردیف ${n}: کالا یافت نشد`);
  const warehouseId = Number(raw.warehouse_id) || 0;
  if (!warehouseId) throw osErr('E_OPENING_LINE', 400, `ردیف ${n}: انبار الزامی است`);
  const wh = db.prepare('SELECT id, active FROM warehouses WHERE id=?').get(warehouseId);
  if (!wh) throw osErr('E_WAREHOUSE_NOT_FOUND', 404, `ردیف ${n}: انبار یافت نشد`);
  if (wh.active != null && Number(wh.active) === 0) {
    throw osErr('E_WAREHOUSE_INACTIVE', 400, `ردیف ${n}: انبار غیرفعال است`);
  }
  const qty = round3(raw.qty);
  if (!Number.isFinite(qty) || !(qty > 0)) throw osErr('E_OPENING_QTY', 400, `ردیف ${n}: تعداد باید بزرگ‌تر از صفر باشد`);
  const unitCost = Math.round(Number(raw.unit_cost_rial));
  if (!Number.isFinite(unitCost) || !(unitCost > 0)) {
    throw osErr('E_OPENING_COST_REQUIRED', 422, `ردیف ${n}: بهای واحد (ریال) باید بزرگ‌تر از صفر باشد`);
  }
  if (require('./qty-policy').requiresIntegerQty(db, productId, product.unit) && Math.abs(qty - Math.round(qty)) > 1e-9) {
    throw osErr('E_QTY_NOT_INTEGER', 400, `ردیف ${n}: موجودی کالای قطعه‌ای باید عدد صحیح باشد`);
  }
  const variantId = raw.variant_id != null && raw.variant_id !== '' && Number(raw.variant_id) > 0
    ? Math.trunc(Number(raw.variant_id)) : null;
  const matrix = require('./movement').hasActiveMatrixVariants(db, productId);
  if (matrix && !variantId) {
    throw osErr('E_VARIANT_REQUIRED', 400, `ردیف ${n}: برای کالای ماتریسی «${product.name}» رنگ/سایز (واریانت) الزامی است`);
  }
  if (variantId) {
    const v = db.prepare('SELECT id, product_id, active FROM product_variants WHERE id=?').get(variantId);
    if (!v) throw osErr('E_VARIANT_NOT_FOUND', 404, `ردیف ${n}: واریانت یافت نشد`);
    if (Number(v.product_id) !== productId) throw osErr('E_VARIANT_MISMATCH', 400, `ردیف ${n}: واریانت متعلق به این کالا نیست`);
    if (!Number(v.active)) throw osErr('E_VARIANT_INACTIVE', 400, `ردیف ${n}: واریانت غیرفعال است`);
  }
  return {
    product_id: productId, warehouse_id: warehouseId, variant_id: variantId, qty, unit_cost_rial: unitCost,
    product_name: product.name,
  };
}

function lineKey(l) { return `${l.product_id}|${l.warehouse_id}|${l.variant_id || 0}`; }

/** خط فعالِ posted دیگری با همان کلید در همان سال مالی؟ */
function findActiveDuplicate(db, fiscalYearId, l, exceptDocId) {
  return db.prepare(`
    SELECT s.id, s.doc_id, d.doc_no
    FROM opening_stock_lines s JOIN opening_stock_docs d ON d.id=s.doc_id
    WHERE s.active=1 AND COALESCE(s.fiscal_year_id,0)=COALESCE(?,0)
      AND s.product_id=? AND s.warehouse_id=? AND COALESCE(s.variant_id,0)=COALESCE(?,0)
      AND (? IS NULL OR s.doc_id<>?)
    LIMIT 1
  `).get(fiscalYearId, l.product_id, l.warehouse_id, l.variant_id, exceptDocId || null, exceptDocId || null);
}

function dupErr(l, hit) {
  return osErr('E_OPENING_DUPLICATE', 409,
    `موجودی اول دوره برای «${l.product_name || l.product_id}» در این انبار/واریانت قبلاً با سند ${hit && hit.doc_no ? hit.doc_no : '#' + (hit && hit.doc_id)} ثبت شده است — برای اصلاح، سند قبلی را ابطال و سند جدید بزنید`,
    { product_id: l.product_id, warehouse_id: l.warehouse_id, variant_id: l.variant_id, doc_id: hit ? hit.doc_id : null });
}

function nextDocNo(db) {
  const { allocateNumber, isDevice } = require('../../db');
  return isDevice()
    ? ('موقت-OP-' + Date.now().toString(36).toUpperCase())
    : allocateNumber(db, 'opening_stock', 'OP');
}

function voucherNo(db, jeId) {
  if (!jeId) return null;
  try {
    const r = db.prepare('SELECT * FROM journal_entries WHERE id=?').get(jeId);
    return r ? (r.voucher_number || r.entry_no || r.num || String(r.id)) : null;
  } catch (_) { return String(jeId); }
}

function getDoc(db, id, { withLines = true } = {}) {
  const doc = db.prepare(`
    SELECT d.*, cu.name AS created_by_name, pu.name AS posted_by_name, vu.name AS voided_by_name
    FROM opening_stock_docs d
    LEFT JOIN users cu ON cu.id=d.created_by
    LEFT JOIN users pu ON pu.id=d.posted_by
    LEFT JOIN users vu ON vu.id=d.voided_by
    WHERE d.id=?
  `).get(id);
  if (!doc) return null;
  doc.je_no = voucherNo(db, doc.je_id);
  if (withLines) {
    doc.lines = db.prepare(`
      SELECT s.*, p.name AS product_name, p.code AS product_code, p.unit AS unit,
        w.name AS warehouse_name, c.name AS color_name, z.name AS size_name, v.sku AS variant_sku
      FROM opening_stock_lines s
      LEFT JOIN products p ON p.id=s.product_id
      LEFT JOIN warehouses w ON w.id=s.warehouse_id
      LEFT JOIN product_variants v ON v.id=s.variant_id
      LEFT JOIN product_colors c ON c.id=v.color_id
      LEFT JOIN product_sizes z ON z.id=v.size_id
      WHERE s.doc_id=? ORDER BY s.id
    `).all(id).map((r) => ({ ...r, amount_rial: Math.round((Number(r.qty) || 0) * (Number(r.unit_cost_rial) || 0)) }));
    doc.total_rial = doc.lines.reduce((a, r) => a + r.amount_rial, 0);
    doc.total_qty = round3(doc.lines.reduce((a, r) => a + (Number(r.qty) || 0), 0));
  }
  return doc;
}

function listDocs(db, { status = null, limit = 100 } = {}) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  const where = [];
  const params = [];
  if (status && ['draft', 'posted', 'void'].includes(String(status))) { where.push('d.status=?'); params.push(String(status)); }
  return db.prepare(`
    SELECT d.*, cu.name AS created_by_name, pu.name AS posted_by_name,
      (SELECT COUNT(*) FROM opening_stock_lines s WHERE s.doc_id=d.id) AS line_count,
      (SELECT COALESCE(SUM(ROUND(s.qty*s.unit_cost_rial)),0) FROM opening_stock_lines s WHERE s.doc_id=d.id) AS total_rial
    FROM opening_stock_docs d
    LEFT JOIN users cu ON cu.id=d.created_by
    LEFT JOIN users pu ON pu.id=d.posted_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY d.id DESC LIMIT ?
  `).all(...params, lim).map((r) => ({ ...r, je_no: voucherNo(db, r.je_id) }));
}

/**
 * پیش‌نویس سند. هیچ حرکت موجودی/JE ساخته نمی‌شود.
 * body: { note, lines:[{product_id,warehouse_id,variant_id?,qty,unit_cost_rial}] }
 */
function createDraft(db, body, user) {
  const rawLines = Array.isArray(body && body.lines) ? body.lines : [];
  if (!rawLines.length) throw osErr('E_OPENING_EMPTY', 400, 'سند افتتاحیه حداقل یک ردیف می‌خواهد');
  if (rawLines.length > 2000) throw osErr('E_OPENING_TOO_MANY', 400, 'حداکثر ۲۰۰۰ ردیف در هر سند');
  let docId;
  db.transaction(() => {
    const ctx = fiscalContext(db);
    const seen = new Set();
    const lines = rawLines.map((r, i) => {
      const l = validateLine(db, resolveRefs(db, r, i), i);
      const k = lineKey(l);
      if (seen.has(k)) throw osErr('E_OPENING_DUP_LINE', 400, `ردیف ${i + 1}: کالا/انبار/واریانت تکراری در همین سند`);
      seen.add(k);
      return l;
    });
    for (const l of lines) {
      const hit = findActiveDuplicate(db, ctx.fiscalYearId, l, null);
      if (hit) throw dupErr(l, hit);
      // نگهبان مشترک: افتتاحیهٔ زندهٔ دیگر (کاردکس قدیمی / product_opening_stock / رسید افتتاحیه) ⇒ 409 E_OPENING_EXISTS
      assertNoLiveOpening(db, { productId: l.product_id, warehouseId: l.warehouse_id, variantId: l.variant_id, fiscalYearId: ctx.fiscalYearId });
    }
    const docNo = nextDocNo(db);
    const note = String((body && body.note) || '').trim().slice(0, 300);
    docId = db.prepare(`
      INSERT INTO opening_stock_docs (doc_no, fiscal_year_id, date, status, created_by, note)
      VALUES (?,?,?,'draft',?,?)
    `).run(docNo, ctx.fiscalYearId, ctx.date, user ? user.id : null, note).lastInsertRowid;
    const ins = db.prepare(`
      INSERT INTO opening_stock_lines (doc_id, fiscal_year_id, product_id, warehouse_id, variant_id, qty, unit_cost_rial, active)
      VALUES (?,?,?,?,?,?,?,0)
    `);
    for (const l of lines) {
      ins.run(docId, ctx.fiscalYearId, l.product_id, l.warehouse_id, l.variant_id, l.qty, l.unit_cost_rial);
    }
  })();
  return getDoc(db, docId);
}

/**
 * Post: ledger + لایهٔ واریانت + یک JE تراز، همه در یک تراکنش.
 */
function postDoc(db, id, user) {
  const { assertMakerChecker } = require('../rbac');
  const L = require('./ledger');
  const M = require('./movement');
  const { acct } = require('../coa-map');
  const { postToLedger } = require('../ledger');
  const { rialToLedger } = require('../money');
  const { assertPeriodOpen } = require('./period-lock');

  db.transaction(() => {
    const doc = db.prepare('SELECT * FROM opening_stock_docs WHERE id=?').get(id);
    if (!doc) throw osErr('E_OPENING_NOT_FOUND', 404, 'سند افتتاحیه یافت نشد');
    if (doc.status !== 'draft') throw osErr('E_OPENING_NOT_DRAFT', 409, 'فقط سند پیش‌نویس قابل ثبت قطعی است');
    assertMakerChecker(user, doc.created_by);

    const rows = db.prepare('SELECT * FROM opening_stock_lines WHERE doc_id=? ORDER BY id').all(id);
    if (!rows.length) throw osErr('E_OPENING_EMPTY', 400, 'سند افتتاحیه ردیف ندارد');

    const date = doc.date || fiscalContext(db).date;
    assertPeriodOpen(db, date, 'موجودی اول دوره');

    // Re-validate at post time (variants/products may have changed since the draft) + duplicates.
    const checked = rows.map((r, i) => {
      const l = validateLine(db, r, i);
      const hit = findActiveDuplicate(db, doc.fiscal_year_id, l, doc.id);
      if (hit) throw dupErr(l, hit);
      assertNoLiveOpening(db, { productId: l.product_id, warehouseId: l.warehouse_id, variantId: l.variant_id, fiscalYearId: doc.fiscal_year_id });
      return { row: r, l };
    });
    require('./cycle-count').assertWarehouseNotCounting(db, [...new Set(checked.map((c) => c.l.warehouse_id))], { label: 'موجودی اول دوره' });

    const byWh = [];
    for (const { row, l } of checked) {
      const note = `سند افتتاحیه انبار ${doc.doc_no} — ${l.product_name}`.slice(0, 300);
      const led = L.postInventoryMovement(db, {
        eventType: 'opening',
        productId: l.product_id,
        warehouseId: l.warehouse_id,
        variantId: l.variant_id,
        qty: l.qty,
        unitCostRial: l.unit_cost_rial,
        sourceType: SOURCE,
        sourceId: doc.id,
        date,
        note,
        createdBy: user ? user.id : null,
      });
      if (l.variant_id) {
        M.postVariantLayer(db, {
          productId: l.product_id, variantId: l.variant_id, warehouseId: l.warehouse_id,
          qtyDelta: l.qty, docType: SOURCE, docId: doc.id, docLine: row.id,
          userId: user ? user.id : null, note,
        });
      }
      let claimed;
      try {
        claimed = db.prepare('UPDATE opening_stock_lines SET ledger_id=?, active=1 WHERE id=?').run(led.id, row.id);
      } catch (e) {
        // backstop: ایندکس یکتای جزئی (race بین دو post هم‌زمان)
        if (e && /UNIQUE|constraint/i.test(String(e.code || '') + String(e.message || ''))) throw dupErr(l, null);
        throw e;
      }
      if (!claimed.changes) throw osErr('E_OPENING_STATE', 409, 'وضعیت ردیف تغییر کرده است');
      byWh.push({ warehouseId: l.warehouse_id, amountRial: Math.round(Number(led.amount_rial) || 0), ledgerId: led.id, l });
    }

    const invLines = L.inventoryAmountLinesByWarehouse(db, byWh);
    const debitLines = invLines.map((x) => ({ code: x.code, name: x.name, debit: rialToLedger(x.amountRial), credit: 0 }));
    const totalDebit = debitLines.reduce((a, x) => a + x.debit, 0);
    const opening = acct(db, 'coa_opening_balance');
    const jeId = postToLedger(db, {
      sourceType: SOURCE,
      sourceId: doc.id,
      date,
      description: `موجودی اول دوره — سند ${doc.doc_no}${doc.note ? ' — ' + doc.note.slice(0, 120) : ''}`,
      createdBy: user ? user.id : null,
      voucherType: 'opening',
      lines: [...debitLines, { code: opening.code, name: opening.name, debit: 0, credit: totalDebit }],
    });
    const upLed = db.prepare('UPDATE inventory_ledger SET je_id=? WHERE id=?');
    for (const b of byWh) upLed.run(jeId, b.ledgerId);
    const POS = require('./product-opening-stock');
    for (const b of byWh) {
      POS.recordFromOpeningDoc(db, {
        fiscalYearId: doc.fiscal_year_id, productId: b.l.product_id, variantId: b.l.variant_id, warehouseId: b.l.warehouse_id,
        qty: b.l.qty, unitCostRial: b.l.unit_cost_rial, valueRial: b.amountRial, ledgerId: b.ledgerId, jeId,
        userId: user ? user.id : null,
      });
    }
    db.prepare(`
      UPDATE opening_stock_docs
      SET status='posted', posted_by=?, posted_at=strftime('%s','now'), je_id=?
      WHERE id=? AND status='draft'
    `).run(user ? user.id : null, jeId, doc.id);
  })();
  return getDoc(db, id);
}

/**
 * Void (R13). پیش‌نویس: فقط وضعیت. posted: برگشت کامل ledger + لایهٔ واریانت + JE
 * در یک تراکنش؛ اگر موجودی مصرف شده و برگشت منفی می‌شود ⇒ 409 E_NEGATIVE_STOCK و هیچ چیز تغییر نمی‌کند.
 */
function voidDoc(db, id, user, { reason } = {}) {
  const L = require('./ledger');
  const why = String(reason || '').trim().slice(0, 300) || 'ابطال سند افتتاحیه';
  db.transaction(() => {
    const doc = db.prepare('SELECT * FROM opening_stock_docs WHERE id=?').get(id);
    if (!doc) throw osErr('E_OPENING_NOT_FOUND', 404, 'سند افتتاحیه یافت نشد');
    if (doc.status === 'void') throw osErr('E_OPENING_ALREADY_VOID', 409, 'سند قبلاً ابطال شده است');
    if (doc.status === 'posted') {
      const rows = db.prepare('SELECT * FROM opening_stock_lines WHERE doc_id=? AND active=1 ORDER BY id').all(id);
      const date = today();
      for (const r of rows) {
        if (!r.ledger_id) continue;
        const led = db.prepare('SELECT status FROM inventory_ledger WHERE id=?').get(r.ledger_id);
        if (led && led.status !== 'reversed') {
          L.reverseInventoryMovement(db, r.ledger_id, {
            createdBy: user ? user.id : null, date,
            note: `ابطال سند افتتاحیه انبار ${doc.doc_no}`,
          });
        }
      }
      require('./movement').reverseStockDocument(db, {
        docType: SOURCE, docId: doc.id, userId: user ? user.id : null,
        note: `ابطال سند افتتاحیه انبار ${doc.doc_no}`, applyHeaderStock: false,
      });
      if (doc.je_id) {
        require('../void-journal').reverseJournalEntry(db, doc.je_id, {
          userId: user ? user.id : null, reason: `ابطال سند افتتاحیه انبار ${doc.doc_no} — ${why}`,
        });
      }
      db.prepare('UPDATE opening_stock_lines SET active=0 WHERE doc_id=?').run(id);
      require('./product-opening-stock').voidFromOpeningDoc(db, rows.map((r) => r.ledger_id), user ? user.id : null);
    }
    db.prepare(`
      UPDATE opening_stock_docs
      SET status='void', voided_by=?, voided_at=strftime('%s','now'), void_reason=?
      WHERE id=?
    `).run(user ? user.id : null, why, id);
  })();
  return getDoc(db, id);
}

/**
 * مسیر ایجاد کالا: stock>0 ⇒ سند تک‌خطی پیش‌نویس (جایگزین مسیر قدیمی postProductOpeningInventory).
 * موجودی کالا تا ثبت قطعی توسط کاربر دیگر صفر می‌ماند. باید داخل تراکنش صدا زده شود.
 */
function createSingleLineDraftForNewProduct(db, user, { productId, warehouseId, qty, unitCostRial, source }) {
  const q = round3(qty);
  const unit = Math.round(Number(unitCostRial) || 0);
  if (!(q > 0) || !(unit > 0) || !warehouseId) return null;
  const doc = createDraft(db, {
    note: source === 'excel' ? 'ایجاد کالا (ورود اکسل)' : 'ایجاد کالا',
    lines: [{ product_id: productId, warehouse_id: warehouseId, qty: q, unit_cost_rial: unit }],
  }, user);
  return { id: doc.id, doc_no: doc.doc_no, status: doc.status };
}

module.exports = {
  SOURCE,
  osErr,
  canView,
  canCreate,
  canPost,
  canVoid,
  tableOk,
  validateLine,
  getDoc,
  listDocs,
  createDraft,
  postDoc,
  voidDoc,
  createSingleLineDraftForNewProduct,
};
