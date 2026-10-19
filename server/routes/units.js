const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOrAccounting } = require('../middleware/auth');
const {
  convertQty,
  normalizeUnitInput,
  countInUse,
} = require('../lib/uom');

function sendErr(res, e) {
  if (e && e.status) return res.status(e.status).json({ error: e.message, code: e.code });
  throw e;
}

router.get('/', auth, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM products p WHERE p.unit_id = u.id) AS in_use
    FROM units_of_measure u
    ORDER BY u.dimension, u.is_reference DESC, u.name
  `).all();
  res.json(rows);
});

router.get('/convert', auth, (req, res) => {
  const db = getDB();
  try {
    res.json(convertQty(db, {
      qty: req.query.qty,
      from_id: req.query.from_id,
      to_id: req.query.to_id,
      from_code: req.query.from || req.query.from_code,
      to_code: req.query.to || req.query.to_code,
    }));
  } catch (e) {
    sendErr(res, e);
  }
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  let input;
  try {
    input = normalizeUnitInput(req.body || {}, null);
  } catch (e) {
    return sendErr(res, e);
  }
  try {
    const done = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO units_of_measure
          (code, name, dimension, unece_code, symbol, factor_to_ref, decimal_places, is_reference, is_active)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(
        input.code, input.name, input.dimension, input.unece_code, input.symbol,
        input.factor_to_ref, input.decimal_places, input.is_reference, input.is_active
      );
      if (input.is_reference) {
        db.prepare('UPDATE units_of_measure SET is_reference=0 WHERE dimension=? AND id!=?')
          .run(input.dimension, r.lastInsertRowid);
      }
      return r.lastInsertRowid;
    })();
    audit(req.user.id, 'create', 'unit_of_measure', done, input.name);
    res.json(db.prepare('SELECT * FROM units_of_measure WHERE id=?').get(done));
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      return res.status(409).json({ error: 'کد واحد تکراری است', code: 'E_UOM_DUP' });
    }
    throw e;
  }
});

router.put('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM units_of_measure WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  let input;
  try {
    input = normalizeUnitInput(req.body || {}, row);
  } catch (e) {
    return sendErr(res, e);
  }
  if (!input.is_active && countInUse(db, row.id) > 0) {
    return res.status(409).json({
      error: 'این واحد روی کالا یا فرمول استفاده شده و غیرفعال نمی‌شود',
      code: 'E_UOM_IN_USE',
    });
  }
  if (row.dimension && input.dimension !== row.dimension && countInUse(db, row.id) > 0) {
    return res.status(409).json({
      error: 'بعد واحدی که روی کالا نشسته عوض نمی‌شود',
      code: 'E_UOM_DIM_LOCKED',
    });
  }
  db.transaction(() => {
    db.prepare(`
      UPDATE units_of_measure
      SET name=?, dimension=?, unece_code=?, symbol=?, factor_to_ref=?, decimal_places=?, is_reference=?, is_active=?
      WHERE id=?
    `).run(
      input.name, input.dimension, input.unece_code, input.symbol, input.factor_to_ref,
      input.decimal_places, input.is_reference, input.is_active, row.id
    );
    if (input.is_reference) {
      db.prepare('UPDATE units_of_measure SET is_reference=0 WHERE dimension=? AND id!=?')
        .run(input.dimension, row.id);
    }
  })();
  audit(req.user.id, 'update', 'unit_of_measure', row.id, input.name);
  res.json(db.prepare('SELECT * FROM units_of_measure WHERE id=?').get(row.id));
});

module.exports = router;
