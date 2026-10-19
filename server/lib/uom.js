'use strict';

/**
 * Units of measure — clothing ERP.
 *
 * Stock stays in the product's own unit. Conversion is allowed only inside
 * one physical dimension, using factor_to_ref toward that dimension's
 * reference unit (metre, kilogram, …). Count units with no universal ratio
 * (ست، جفت) keep factor_to_ref NULL and never convert to عدد.
 *
 * Codes follow UNECE Rec 20 (rev.14, still the 2025 e-invoice list):
 * H87 piece, MTR metre, YRD yard, KGM kilogram, NPR number of pairs, SET set.
 * Internal codes (PCS, M, YD, …) stay stable for existing rows.
 */

const DIMENSIONS = ['count', 'length', 'mass', 'area', 'volume', 'time'];

const SPECS = [
  { code: 'PCS', name: 'عدد', dimension: 'count', unece: 'H87', symbol: 'عدد', factor: 1, decimals: 0, reference: 1,
    aliases: ['عدد', 'pcs', 'pc', 'piece', 'pieces', 'ea', 'each', 'h87'] },
  { code: 'M', name: 'متر', dimension: 'length', unece: 'MTR', symbol: 'm', factor: 1, decimals: 3, reference: 1,
    aliases: ['متر', 'meter', 'metre', 'm', 'mtr'] },
  { code: 'YD', name: 'یارد', dimension: 'length', unece: 'YRD', symbol: 'yd', factor: 0.9144, decimals: 3, reference: 0,
    aliases: ['یارد', 'يارد', 'yard', 'yards', 'yd', 'yrd'] },
  { code: 'KG', name: 'کیلوگرم', dimension: 'mass', unece: 'KGM', symbol: 'kg', factor: 1, decimals: 3, reference: 1,
    aliases: ['کیلوگرم', 'کیلو', 'kg', 'kgs', 'kilogram', 'kilograms'] },
  { code: 'G', name: 'گرم', dimension: 'mass', unece: 'GRM', symbol: 'g', factor: 0.001, decimals: 3, reference: 0,
    aliases: ['گرم', 'gr', 'gram', 'grams', 'grm'] },
  { code: 'SET', name: 'ست', dimension: 'count', unece: 'SET', symbol: 'ست', factor: null, decimals: 0, reference: 0,
    aliases: ['ست', 'set'] },
  { code: 'PAIR', name: 'جفت', dimension: 'count', unece: 'NPR', symbol: 'جفت', factor: null, decimals: 0, reference: 0,
    aliases: ['جفت', 'pair', 'pairs', 'npr'] },
];

function httpErr(status, message, code) {
  const e = new Error(message);
  e.status = status;
  e.code = code || 'E_UOM';
  return e;
}

function normKey(v) {
  return String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, '');
}

function specByCode(code) {
  const c = String(code || '').trim().toUpperCase();
  return SPECS.find((s) => s.code === c) || null;
}

function specByAlias(text) {
  const k = normKey(text);
  if (!k) return null;
  return SPECS.find((s) => normKey(s.code) === k || normKey(s.name) === k || normKey(s.symbol) === k
    || s.aliases.some((a) => normKey(a) === k)) || null;
}

function columnExists(db, table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}

function ensureCol(db, table, column, ddl) {
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

function bootstrap(db) {
  ensureCol(db, 'units_of_measure', 'dimension', "TEXT DEFAULT 'count'");
  ensureCol(db, 'units_of_measure', 'unece_code', 'TEXT');
  ensureCol(db, 'units_of_measure', 'symbol', 'TEXT');
  ensureCol(db, 'units_of_measure', 'factor_to_ref', 'REAL');
  ensureCol(db, 'units_of_measure', 'decimal_places', 'INTEGER DEFAULT 0');
  ensureCol(db, 'units_of_measure', 'is_reference', 'INTEGER DEFAULT 0');

  const rows = db.prepare('SELECT * FROM units_of_measure').all();
  const upd = db.prepare(`
    UPDATE units_of_measure
    SET dimension=?, unece_code=?, symbol=?, factor_to_ref=?, decimal_places=?, is_reference=?
    WHERE id=?
  `);
  const seen = new Set();
  for (const row of rows) {
    const spec = specByCode(row.code) || specByAlias(row.name);
    if (!spec) continue;
    seen.add(spec.code);
    // Once unece_code is stored, the row is user-owned and later boots do not reset the factor.
    if (row.unece_code) continue;
    upd.run(spec.dimension, spec.unece, spec.symbol, spec.factor, spec.decimals, spec.reference ? 1 : 0, row.id);
  }

  const ins = db.prepare(`
    INSERT OR IGNORE INTO units_of_measure
      (code, name, dimension, unece_code, symbol, factor_to_ref, decimal_places, is_reference, is_active)
    VALUES (?,?,?,?,?,?,?,?,1)
  `);
  for (const spec of SPECS) {
    if (seen.has(spec.code)) continue;
    const exists = rows.some((r) => specByCode(r.code) === spec || specByAlias(r.name) === spec);
    if (exists) continue;
    ins.run(spec.code, spec.name, spec.dimension, spec.unece, spec.symbol, spec.factor, spec.decimals, spec.reference ? 1 : 0);
  }

  if (columnExists(db, 'products', 'unit_id')) {
    const pending = db.prepare(`
      SELECT id, unit FROM products
      WHERE unit_id IS NULL AND TRIM(COALESCE(unit,'')) != ''
    `).all();
    if (pending.length) {
      const catalog = db.prepare('SELECT * FROM units_of_measure').all();
      const link = db.prepare('UPDATE products SET unit_id=? WHERE id=? AND unit_id IS NULL');
      for (const p of pending) {
        const hit = matchIn(catalog, p.unit);
        if (hit) link.run(hit.id, p.id);
      }
    }
  }
}

function matchIn(catalog, text) {
  const k = normKey(text);
  if (!k) return null;
  const spec = specByAlias(text);
  if (spec) {
    const bySpec = catalog.find((r) => String(r.code || '').toUpperCase() === spec.code
      || normKey(r.name) === normKey(spec.name));
    if (bySpec) return bySpec;
  }
  return catalog.find((r) => normKey(r.code) === k || normKey(r.name) === k || normKey(r.symbol) === k) || null;
}

function allUnits(db) {
  return db.prepare('SELECT * FROM units_of_measure').all();
}

function matchText(db, text) {
  return matchIn(allUnits(db), text);
}

function getUnit(db, id) {
  const n = parseInt(id, 10);
  if (!n) return null;
  return db.prepare('SELECT * FROM units_of_measure WHERE id=?').get(n) || null;
}

function isLengthText(unit) {
  const s = String(unit == null ? '' : unit).trim().toLowerCase();
  const compact = s.replace(/\s+/g, '');
  if (!s) return false;
  if (s === 'm' || s === 'meter' || s === 'metre' || s === 'متر' || s === 'mtr' || s.includes('متر')) return true;
  if (compact === 'یارد' || compact === 'يارد' || s === 'yard' || s === 'yards' || s === 'yd' || s === 'yrd') return true;
  return false;
}

function isLengthProduct(db, prod) {
  if (!prod) return false;
  if (db && prod.unit_id) {
    const row = getUnit(db, prod.unit_id);
    if (row) return row.dimension === 'length';
  }
  return isLengthText(prod.unit) || isLengthText(prod.unit_code);
}

/** Batch token stored on fabric rolls: m or yd. Empty when not a length unit. */
function lengthTokenForProduct(db, prod) {
  if (!prod) return '';
  if (db && prod.unit_id) {
    const row = getUnit(db, prod.unit_id);
    if (row && row.dimension === 'length') {
      const code = String(row.code || '').toUpperCase();
      const unece = String(row.unece_code || '').toUpperCase();
      if (code === 'YD' || code === 'YRD' || unece === 'YRD') return 'yd';
      return 'm';
    }
    if (row) return '';
  }
  const s = String(prod.unit || '').trim().toLowerCase().replace(/\s+/g, '');
  if (s === 'یارد' || s === 'يارد' || s === 'yard' || s === 'yards' || s === 'yd' || s === 'yrd') return 'yd';
  if (isLengthText(prod.unit)) return 'm';
  return '';
}

function policyFromRow(row) {
  if (!row) return { known: false };
  return {
    known: true,
    dimension: row.dimension || 'count',
    decimal_places: Number(row.decimal_places) || 0,
    unit_id: row.id,
    code: row.code,
    name: row.name,
    factor_to_ref: row.factor_to_ref,
  };
}

function policyForProduct(db, productId) {
  if (!db || !productId) return { known: false };
  let row;
  try {
    row = db.prepare('SELECT unit, unit_id FROM products WHERE id=?').get(productId);
  } catch (_) {
    return { known: false };
  }
  if (!row) return { known: false };
  if (row.unit_id) {
    const u = getUnit(db, row.unit_id);
    if (u) return policyFromRow(u);
  }
  const m = matchText(db, row.unit);
  return m ? policyFromRow(m) : { known: false };
}

/**
 * Resolve the unit written on a product.
 * Known catalog text is stored as the catalog name plus unit_id.
 * Unknown text is kept and unit_id is cleared.
 */
function resolveProductUnit(db, body, existing) {
  const src = body || {};
  if (src.unit_id != null && src.unit_id !== '') {
    const row = getUnit(db, src.unit_id);
    if (!row || !row.is_active) throw httpErr(400, 'واحد اندازه‌گیری معتبر نیست', 'E_UOM_UNKNOWN');
    return { unit_id: row.id, unit: row.name };
  }
  const text = src.unit != null ? String(src.unit).trim() : '';
  if (text) {
    const row = matchText(db, text);
    if (row && row.is_active !== 0) return { unit_id: row.id, unit: row.name };
    return { unit_id: null, unit: text };
  }
  if (existing) return { unit_id: existing.unit_id || null, unit: existing.unit || 'عدد' };
  const pcs = matchText(db, 'عدد');
  return { unit_id: pcs ? pcs.id : null, unit: pcs ? pcs.name : 'عدد' };
}

function convertBetween(from, to, qty) {
  const q = Number(qty);
  if (!Number.isFinite(q)) throw httpErr(400, 'مقدار نامعتبر است', 'E_UOM_QTY');
  if (!from || !to) throw httpErr(400, 'هر دو واحد لازم است', 'E_UOM');
  if (Number(from.id) && Number(from.id) === Number(to.id)) return q;
  const dimA = from.dimension || 'count';
  const dimB = to.dimension || 'count';
  if (dimA !== dimB) {
    throw httpErr(400, 'تبدیل بین دو بعد متفاوت مجاز نیست', 'E_UOM_DIMENSION');
  }
  const fa = from.factor_to_ref == null ? null : Number(from.factor_to_ref);
  const fb = to.factor_to_ref == null ? null : Number(to.factor_to_ref);
  if (!(fa > 0) || !(fb > 0)) {
    throw httpErr(400, 'این واحد ضریب جهانی ندارد — نسبت را روی خود کالا تعریف کنید، نه در کاتالوگ', 'E_UOM_NOT_CONVERTIBLE');
  }
  const raw = q * fa / fb;
  // Factor precision (yard is 0.9144 m). Stock entry decimals stay on the unit row
  // and are applied by qty policy, not by shrinking the conversion itself.
  return Math.round(raw * 1e6) / 1e6;
}

function convertQty(db, opts) {
  const from = opts.from_id ? getUnit(db, opts.from_id) : matchText(db, opts.from_code || opts.from);
  const to = opts.to_id ? getUnit(db, opts.to_id) : matchText(db, opts.to_code || opts.to);
  if (!from || !to) throw httpErr(404, 'واحد یافت نشد', 'E_UOM_UNKNOWN');
  return {
    qty: convertBetween(from, to, opts.qty),
    from_code: from.code,
    to_code: to.code,
    dimension: from.dimension,
  };
}

function normalizeUnitInput(body, existing) {
  const src = body || {};
  const spec = specByCode(src.code || (existing && existing.code)) || specByAlias(src.name);
  const code = existing
    ? existing.code
    : String(src.code || '').trim().toUpperCase();
  if (!existing && !/^[A-Z0-9][A-Z0-9_-]{0,15}$/.test(code)) {
    throw httpErr(400, 'کد واحد فقط حروف لاتین، عدد و خط تیره است', 'E_UOM_CODE');
  }
  const name = String(src.name != null ? src.name : (existing && existing.name) || (spec && spec.name) || '').trim();
  if (!name) throw httpErr(400, 'نام واحد الزامی است', 'E_UOM_NAME');
  const dimension = String(
    src.dimension != null ? src.dimension : (existing && existing.dimension) || (spec && spec.dimension) || 'count'
  );
  if (!DIMENSIONS.includes(dimension)) throw httpErr(400, 'بعد واحد نامعتبر است', 'E_UOM_DIM');
  let decimals = src.decimal_places != null && src.decimal_places !== ''
    ? parseInt(src.decimal_places, 10)
    : (existing && existing.decimal_places != null
      ? Number(existing.decimal_places)
      : (spec ? spec.decimals : (dimension === 'count' ? 0 : 3)));
  if (!Number.isFinite(decimals) || decimals < 0 || decimals > 6) {
    throw httpErr(400, 'تعداد اعشار باید بین ۰ و ۶ باشد', 'E_UOM_DEC');
  }
  const isRef = src.is_reference != null
    ? (src.is_reference === true || src.is_reference === 1 || src.is_reference === '1' ? 1 : 0)
    : (existing ? (existing.is_reference ? 1 : 0) : (spec && spec.reference ? 1 : 0));
  let factor;
  if (src.factor_to_ref === '' || src.factor_to_ref === null) factor = null;
  else if (src.factor_to_ref != null) factor = Number(src.factor_to_ref);
  else if (existing && existing.unece_code) factor = existing.factor_to_ref;
  else if (spec) factor = spec.factor;
  else factor = existing ? existing.factor_to_ref : null;
  if (factor != null && (!Number.isFinite(factor) || factor <= 0)) {
    throw httpErr(400, 'ضریب تبدیل باید بزرگ‌تر از صفر باشد', 'E_UOM_FACTOR');
  }
  if (isRef) factor = 1;
  if (dimension !== 'count' && !(Number(factor) > 0)) {
    throw httpErr(400, 'واحد این بعد باید ضریب نسبت به واحد مرجع داشته باشد', 'E_UOM_FACTOR');
  }
  const uneceRaw = src.unece_code != null ? src.unece_code : (existing && existing.unece_code) || (spec && spec.unece) || '';
  const unece = String(uneceRaw || '').trim().toUpperCase() || null;
  const symbolRaw = src.symbol != null ? src.symbol : (existing && existing.symbol) || (spec && spec.symbol) || '';
  const symbol = String(symbolRaw || '').trim() || null;
  const isActive = src.is_active != null
    ? (src.is_active === false || src.is_active === 0 || src.is_active === '0' ? 0 : 1)
    : (existing ? (existing.is_active ? 1 : 0) : 1);
  return {
    code,
    name,
    dimension,
    unece_code: unece,
    symbol,
    factor_to_ref: factor,
    decimal_places: decimals,
    is_reference: isRef ? 1 : 0,
    is_active: isActive,
  };
}

function countInUse(db, id) {
  let n = 0;
  if (columnExists(db, 'products', 'unit_id')) {
    n += db.prepare('SELECT COUNT(*) c FROM products WHERE unit_id=?').get(id).c;
  }
  for (const table of ['bom_headers', 'bom_lines', 'bom_outputs']) {
    if (columnExists(db, table, 'unit_id')) {
      n += db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE unit_id=?`).get(id).c;
    }
  }
  return n;
}

module.exports = {
  DIMENSIONS,
  SPECS,
  bootstrap,
  matchText,
  getUnit,
  isLengthText,
  isLengthProduct,
  lengthTokenForProduct,
  policyForProduct,
  resolveProductUnit,
  convertBetween,
  convertQty,
  normalizeUnitInput,
  countInUse,
  httpErr,
};
