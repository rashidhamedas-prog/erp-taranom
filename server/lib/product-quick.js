'use strict';

/**
 * Product master-data writes used by POST /products/quick and Excel commit.
 * Domain rules stay here — routes only adapt HTTP.
 */
const { assignProductTafsili } = require('./product-tafsili');
const { parseQty } = require('./round3');

function nextProductCode(db) {
  const row = db.prepare("SELECT code FROM products WHERE code GLOB 'K-[0-9]*' ORDER BY id DESC LIMIT 1").get();
  let n = 1;
  if (row && row.code) {
    const m = row.code.match(/K-(\d+)/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `K-${String(n).padStart(5, '0')}`;
}

function httpErr(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function resolveCategory(db, { category, category_id }) {
  let catName = category || '';
  let catId = category_id || null;
  if (catId) {
    const c = db.prepare('SELECT name FROM product_categories WHERE id=?').get(catId);
    if (!c) throw httpErr(400, 'گروه کالا یافت نشد');
    catName = c.name;
  } else if (catName) {
    const c = db.prepare('SELECT id,name FROM product_categories WHERE name=?').get(catName);
    if (c) { catId = c.id; catName = c.name; }
  }
  return { catName, catId };
}

/**
 * Create a product (same invariants as POST /products/quick).
 * @returns {number} new product id
 */
function createQuickProduct(db, user, body) {
  const {
    name, category_id, category, code, price, cost, warehouse_id, unit, stock, stock_alert,
    note, colors, pack_size, barcode, full_name, product_type, product_index, tax_id,
    consumer_price, location, opening_price, sms_code,
  } = body || {};
  if (!name) throw httpErr(400, 'نام محصول الزامی است');
  const codeTrim = code && String(code).trim();
  const barcodeTrim = barcode && String(barcode).trim();
  if (codeTrim && db.prepare('SELECT id FROM products WHERE code=?').get(codeTrim)) {
    throw httpErr(409, 'کد کالا تکراری است — داده تکراری ذخیره نمی‌شود');
  }
  if (barcodeTrim && db.prepare('SELECT id FROM products WHERE barcode=?').get(barcodeTrim)) {
    throw httpErr(409, 'بارکد تکراری است — داده تکراری ذخیره نمی‌شود');
  }
  if (db.prepare('SELECT id FROM products WHERE name=?').get(String(name).trim())) {
    throw httpErr(409, 'نام کالا تکراری است — داده تکراری ذخیره نمی‌شود');
  }
  const { catName, catId } = resolveCategory(db, { category, category_id });
  const defaultWarehouse = warehouse_id || db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get()?.id || null;
  const prodCode = (code && String(code).trim()) || nextProductCode(db);
  const openingStock = Math.max(0, parseQty(stock, 0));
  const costRial = Math.round(parseFloat(cost) || 0);
  const openingPriceRial = Math.round(parseFloat(opening_price) || 0);
  const unitCostForOpening = costRial || openingPriceRial;
  if (openingStock > 0 && !unitCostForOpening) {
    throw httpErr(422, 'موجودی اول دوره بدون بها مجاز نیست — بهای تمام‌شده یا قیمت اول دوره را وارد کنید');
  }
  const userId = user && user.id;
  const { resolveProductUnit } = require('./uom');
  const resolvedUnit = resolveProductUnit(db, body || {}, null);

  // P2: موجودی اول دوره فقط از مسیر سند پیش‌نویس (opening_stock_docs) — کالا با موجودی صفر ساخته می‌شود.
  const useOpeningDoc = openingStock > 0 && unitCostForOpening > 0 && !!defaultWarehouse;
  return db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO products (
        user_id,category,category_id,code,name,price,cost,stock,stock_alert,unit,warehouse_id,
        note,colors,pack_size,barcode,full_name,product_type,product_index,tax_id,consumer_price,
        location,opening_price,sms_code,tax_stuff_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      userId, catName, catId, prodCode, name, parseFloat(price) || 0, costRial,
      useOpeningDoc ? 0 : openingStock, parseInt(stock_alert, 10) || 5, resolvedUnit.unit || 'عدد', defaultWarehouse,
      note || '', Math.max(1, parseInt(colors, 10) || 1), Math.max(1, parseInt(pack_size, 10) || 1),
      String(barcode || '').trim() || null, full_name || '', product_type || '', product_index || '',
      tax_id || '', parseFloat(consumer_price) || 0, location || '', openingPriceRial,
      sms_code || '', String(body.tax_stuff_id || '').trim() || null
    );
    const productId = result.lastInsertRowid;
    if (resolvedUnit.unit_id) {
      db.prepare('UPDATE products SET unit_id=? WHERE id=?').run(resolvedUnit.unit_id, productId);
    }
    if (body.retail_price != null && body.retail_price !== '') {
      const retail = Math.round(parseFloat(body.retail_price) || 0);
      db.prepare('UPDATE products SET retail_price=?, retail_price_rial=? WHERE id=?')
        .run(retail, retail, productId);
    }
    if (defaultWarehouse) {
      db.prepare('INSERT OR REPLACE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,?)')
        .run(productId, defaultWarehouse, useOpeningDoc ? 0 : openingStock);
    }
    try { assignProductTafsili(db, productId, name); } catch (_) { /* optional */ }
    if (useOpeningDoc) {
      require('./inventory/opening-stock').createSingleLineDraftForNewProduct(db, user, {
        productId,
        warehouseId: defaultWarehouse,
        qty: openingStock,
        unitCostRial: unitCostForOpening,
        source: body.from_excel || body.src_system === 'excel' ? 'excel' : null,
      });
      return productId;
    }
    if (openingStock > 0 && unitCostForOpening > 0) {
      const { postProductOpeningInventory } = require('./opening-post');
      postProductOpeningInventory(db, {
        productId,
        qty: openingStock,
        unitCostRial: unitCostForOpening,
        userId,
        srcSystem: body.from_excel || body.src_system === 'excel' ? 'excel' : null,
      });
    }
    if (openingStock > 0) {
      try {
        db.prepare('INSERT INTO stock_logs (product_id,change,reason,user_id) VALUES (?,?,?,?)')
          .run(productId, openingStock, 'موجودی اول دوره', userId);
      } catch (_) {}
    }
    return productId;
  })();
}

/**
 * Excel upsert: update fields without wiping photo/code.
 * Mirrors the excel_upsert branch of PUT /products/:id.
 */
function updateProductFromExcel(db, user, productId, body) {
  const prod = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!prod) throw httpErr(404, 'یافت نشد');
  const src = body || {};
  const nameVal = src.name != null && String(src.name).trim() !== '' ? src.name : prod.name;
  const codeVal = src.code && String(src.code).trim() ? String(src.code).trim() : (prod.code || '');
  const { catName, catId } = src.category || src.category_id
    ? resolveCategory(db, { category: src.category || prod.category, category_id: src.category_id || prod.category_id })
    : { catName: prod.category || '', catId: prod.category_id };
  const requestedStock = src.stock != null ? parseQty(src.stock) : parseQty(prod.stock);
  const hasMoves = !!db.prepare('SELECT 1 FROM warehouse_moves WHERE product_id=? LIMIT 1').get(productId);
  const stockVal = hasMoves ? parseQty(prod.stock) : requestedStock;
  const whId = src.warehouse_id != null && src.warehouse_id !== ''
    ? (parseInt(src.warehouse_id, 10) || null)
    : prod.warehouse_id;

  db.prepare(`UPDATE products SET category=?,category_id=?,code=?,name=?,price=?,cost=?,stock=?,stock_alert=?,unit=?,note=?,
    colors=?,pack_size=?,warehouse_id=?,barcode=?,full_name=?,product_type=?,product_index=?,tax_id=?,
    consumer_price=?,location=?,opening_price=?,sms_code=? WHERE id=?`)
    .run(
      catName, catId, codeVal, nameVal,
      src.price != null ? (parseFloat(src.price) || 0) : (Number(prod.price) || 0),
      src.cost != null ? (parseFloat(src.cost) || 0) : (Number(prod.cost) || 0),
      stockVal,
      src.stock_alert != null ? (parseInt(src.stock_alert, 10) || 5) : (parseInt(prod.stock_alert, 10) || 5),
      src.unit != null ? (src.unit || 'عدد') : (prod.unit || 'عدد'),
      src.note != null ? (src.note || '') : (prod.note || ''),
      src.colors != null ? Math.max(1, parseInt(src.colors, 10) || 1) : Math.max(1, parseInt(prod.colors, 10) || 1),
      src.pack_size != null ? Math.max(1, parseInt(src.pack_size, 10) || 1) : Math.max(1, parseInt(prod.pack_size, 10) || 1),
      whId,
      src.barcode != null ? (String(src.barcode).trim() || null) : prod.barcode,
      src.full_name != null ? (src.full_name || '') : (prod.full_name || ''),
      src.product_type != null ? (src.product_type || '') : (prod.product_type || ''),
      src.product_index != null ? (src.product_index || '') : (prod.product_index || ''),
      src.tax_id != null ? (src.tax_id || '') : (prod.tax_id || ''),
      src.consumer_price != null ? (parseFloat(src.consumer_price) || 0) : (Number(prod.consumer_price) || 0),
      src.location != null ? (src.location || '') : (prod.location || ''),
      src.opening_price != null ? (parseFloat(src.opening_price) || 0) : (Number(prod.opening_price) || 0),
      src.sms_code != null ? (src.sms_code || '') : (prod.sms_code || ''),
      productId
    );
  if (src.retail_price != null && src.retail_price !== '') {
    const retail = Math.round(parseFloat(src.retail_price) || 0);
    db.prepare('UPDATE products SET retail_price=?, retail_price_rial=? WHERE id=?')
      .run(retail, retail, productId);
  }
  if (whId && !hasMoves) {
    db.prepare('INSERT OR IGNORE INTO warehouse_stock (product_id,warehouse_id,qty) VALUES (?,?,0)')
      .run(productId, whId);
    db.prepare('UPDATE warehouse_stock SET qty=? WHERE product_id=? AND warehouse_id=?')
      .run(stockVal, productId, whId);
  }
  const avgNow = Math.round(Number(prod.average_cost_rial) || 0);
  const unitNow = Math.round(parseFloat(src.cost) || 0) || Math.round(parseFloat(src.opening_price) || 0);
  if (stockVal > 0 && !avgNow && !unitNow) {
    throw httpErr(422, `«${nameVal}»: موجودی بدون بها — ستون بهای تمام‌شده یا قیمت اول دوره را پر کنید`);
  }
  if (stockVal > 0 && !avgNow && unitNow > 0) {
    const { seedMissingAverageCost } = require('./inventory/seed-avg');
    seedMissingAverageCost(db, {
      productId, unitCostRial: unitNow, userId: user && user.id,
    });
  }
  if (prod.image) {
    db.prepare('UPDATE products SET image=? WHERE id=?').run(prod.image, productId);
  }
  return productId;
}

function applyExcelProductAction(db, user, action) {
  const method = String(action.method || 'POST').toUpperCase();
  const body = Object.assign({}, action.body || {}, { from_excel: true, src_system: 'excel' });
  if (method === 'PUT' && action.path) {
    const m = String(action.path).match(/\/products\/(\d+)/);
    if (!m) throw httpErr(400, 'مسیر به‌روزرسانی کالا نامعتبر است');
    return { id: updateProductFromExcel(db, user, Number(m[1]), body), upsert: 'update' };
  }
  const id = createQuickProduct(db, user, body);
  return { id, upsert: 'create' };
}

module.exports = {
  nextProductCode,
  createQuickProduct,
  updateProductFromExcel,
  applyExcelProductAction,
};
