'use strict';
/**
 * Lay unit = the unit the chosen rolls are stocked in.
 *
 * Every lay quantity (actual, per-roll laid, remnant, waste, BOM standard) is
 * in that unit, because roll balances and the fabric's BOM line already are.
 * The marker is a physical length:
 *  - length rolls (m, yd, cm, …): the marker is typed in the same unit → factor 1.
 *  - mass / area rolls (kg, m², …): the marker is typed in metres and
 *    marker_factor says how many roll units one marker metre consumes.
 *    Area derives it from roll width; mass needs a per-metre weight taken
 *    from the roll receipt, the previous lay of this fabric, or the user.
 */

const uom = require('../uom');

function httpErr(status, message, code, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function round6(n) {
  return Math.round((Number(n) || 0) * 1e6) / 1e6;
}

function metreRow(db) {
  return db.prepare("SELECT * FROM units_of_measure WHERE UPPER(code)='M'").get() || null;
}

/** Catalog row for a roll's unit token (m / yd / kg / catalog code / Persian name). */
function unitRowForToken(db, token) {
  const t = String(token == null ? '' : token).trim();
  if (!t) return metreRow(db);
  try {
    const row = uom.matchText(db, t);
    if (row) return row;
  } catch (_) { /* catalog table missing in old harnesses */ }
  if (uom.isLengthText(t)) return metreRow(db);
  return null;
}

function tokenOf(db, row, fallback) {
  if (row) return uom.rollUnitToken(row) || String(fallback || '').trim().toLowerCase();
  return String(fallback || 'm').trim().toLowerCase() || 'm';
}

function loadBatches(db, batchIds) {
  const ids = [...new Set((batchIds || []).map(Number).filter((n) => n > 0))];
  if (!ids.length) return [];
  const cols = db.prepare('PRAGMA table_info(inventory_batches)').all().map((c) => c.name);
  const extra = ['entry_unit_id', 'entry_factor'].filter((c) => cols.includes(c));
  const sel = ['id', 'product_id', 'unit', 'width_cm', 'batch_no', ...extra].join(', ');
  return db.prepare(`SELECT ${sel} FROM inventory_batches WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
}

/** kg (or other mass unit) per marker metre from rolls received in a length unit. */
function massFactorFromRolls(db, batches, unitRow) {
  const vals = [];
  for (const b of batches) {
    const f = Number(b.entry_factor);
    if (!(f > 0) || !b.entry_unit_id) continue;
    const entry = uom.getUnit(db, b.entry_unit_id);
    if (!entry || entry.dimension !== 'length' || !(Number(entry.factor_to_ref) > 0)) continue;
    // entry_factor = stock units per 1 entry unit; per metre = / (metres in one entry unit).
    vals.push(f / Number(entry.factor_to_ref));
  }
  if (!vals.length || !unitRow) return 0;
  return round6(vals.reduce((s, n) => s + n, 0) / vals.length);
}

function lastLayFactor(db, fabricProductId, token) {
  if (!fabricProductId) return 0;
  try {
    const r = db.prepare(`
      SELECT marker_factor FROM cutting_lays
      WHERE fabric_product_id=? AND qty_unit=? AND marker_factor > 0
        AND COALESCE(status,'posted') <> 'reversed'
      ORDER BY id DESC LIMIT 1
    `).get(Number(fabricProductId), token);
    return Number(r && r.marker_factor) || 0;
  } catch (_) {
    return 0;
  }
}

/**
 * @param {object} opts
 * @param {number} [opts.fabricProductId]
 * @param {number[]} [opts.batchIds]
 * @param {number} [opts.markerFactor] user value (roll units per marker metre) for mass/area rolls
 * @param {number} [opts.widthCm]
 * @param {boolean} [opts.soft] do not throw when a mass factor is missing (UI probe)
 */
function resolveLayUnit(db, opts = {}) {
  const batches = loadBatches(db, opts.batchIds);
  let row = null;
  let token = '';
  if (batches.length) {
    const seen = new Map();
    for (const b of batches) {
      const r = unitRowForToken(db, b.unit);
      const key = r ? `id:${r.id}` : `t:${String(b.unit || 'm').trim().toLowerCase()}`;
      if (!seen.has(key)) seen.set(key, { row: r, token: b.unit, batch: b });
    }
    if (seen.size > 1) {
      const names = [...seen.values()].map((v) => (v.row ? v.row.name : String(v.token || 'm')));
      throw httpErr(400, `طاقه‌های یک لایه باید یک واحد داشته باشند (${names.join('، ')})`, 'E_CUT_ROLL_UNIT', {
        units: names,
      });
    }
    const only = [...seen.values()][0];
    row = only.row;
    token = tokenOf(db, row, only.token);
  } else if (opts.fabricProductId) {
    const prod = db.prepare('SELECT id, unit, unit_id FROM products WHERE id=?').get(Number(opts.fabricProductId));
    try { row = prod ? uom.stockUnitForProduct(db, prod) : null; } catch (_) { row = null; }
    if (!row) row = metreRow(db);
    token = tokenOf(db, row, prod && prod.unit);
  } else {
    row = metreRow(db);
    token = 'm';
  }

  const dimension = row ? (row.dimension || 'count') : 'length';
  const name = row ? row.name : (token === 'm' ? 'متر' : token);
  const base = {
    qty_unit: token,
    unit_id: row ? row.id : null,
    unit_name: name,
    unit_symbol: row ? (row.symbol || '') : '',
    dimension,
    decimal_places: row ? Number(row.decimal_places) || 0 : 3,
  };

  if (dimension === 'length' || !row) {
    // Unknown legacy tokens behave as before: numbers are taken as-is.
    const ref = row && Number(row.factor_to_ref) > 0 ? Number(row.factor_to_ref) : 1;
    return {
      ...base,
      marker_in_unit: 1,
      marker_unit: token,
      marker_unit_name: name,
      marker_factor: 1,
      metre_to_unit: round6(1 / ref),
      factor_source: 'same_unit',
      need_factor: 0,
    };
  }
  if (dimension !== 'mass' && dimension !== 'area') {
    throw httpErr(400, `واحد طاقه «${name}» برای لایه‌چینی معنی ندارد (فقط طول، وزن یا مساحت)`, 'E_CUT_ROLL_UNIT_DIM', {
      unit: name, dimension,
    });
  }

  let factor = Number(opts.markerFactor);
  let source = 'user';
  if (!(factor > 0) || !Number.isFinite(factor)) {
    factor = 0;
    if (dimension === 'area') {
      const w = Number(opts.widthCm) || Number((batches.find((b) => Number(b.width_cm) > 0) || {}).width_cm) || 0;
      const ref = Number(row.factor_to_ref) > 0 ? Number(row.factor_to_ref) : 1;
      if (w > 0) { factor = round6((w / 100) / ref); source = 'width'; }
    } else {
      factor = massFactorFromRolls(db, batches, row);
      if (factor > 0) source = 'roll_receipt';
    }
    if (!(factor > 0)) {
      factor = lastLayFactor(db, opts.fabricProductId || (batches[0] && batches[0].product_id), token);
      if (factor > 0) source = 'last_lay';
    }
  }
  if (!(factor > 0)) {
    if (opts.soft) {
      return {
        ...base, marker_in_unit: 0, marker_unit: 'm', marker_unit_name: 'متر',
        marker_factor: 0, metre_to_unit: 0, factor_source: 'missing', need_factor: 1,
      };
    }
    const what = dimension === 'area' ? 'عرض طاقه یا مساحت هر متر' : `وزن هر متر (${name})`;
    throw httpErr(400, `طاقه «${name}» است؛ برای تبدیل طول مارکر، ${what} را وارد کنید`, 'E_CUT_MARKER_FACTOR', {
      unit: name, dimension,
    });
  }
  factor = round6(factor);
  return {
    ...base,
    marker_in_unit: 0,
    marker_unit: 'm',
    marker_unit_name: 'متر',
    marker_factor: factor,
    metre_to_unit: factor,
    factor_source: source,
    need_factor: 0,
  };
}

/** Marker length (as typed) → roll units. */
function markerToUnit(layUnit, marker) {
  return round6((Number(marker) || 0) * (Number(layUnit && layUnit.marker_factor) || 1));
}

/** Remnant policy minimum is kept in metres; express it in roll units. */
function metresToUnit(layUnit, metres) {
  const k = Number(layUnit && layUnit.metre_to_unit);
  return round6((Number(metres) || 0) * (k > 0 ? k : 1));
}

function layUnitWord(layUnit) {
  return (layUnit && layUnit.unit_name) || 'متر';
}

module.exports = {
  resolveLayUnit,
  unitRowForToken,
  markerToUnit,
  metresToUnit,
  layUnitWord,
};
