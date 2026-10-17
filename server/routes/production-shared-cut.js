'use strict';
const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, requirePermission } = require('../middleware/auth');
const { canSeeCost, stripCostFields } = require('../lib/production/access');
const {
  previewSharedCut, postSharedCut, getSharedCut, voidSharedCut, loadPolicy,
} = require('../lib/production/shared-cut');

function sendRow(req, res, data) {
  if (!canSeeCost(getDB(), req.user)) data = stripCostFields(data);
  return res.json(data);
}
function sendErr(res, e) {
  return res.status(e.status || 400).json({ error: e.message || String(e), code: e.code || undefined, errors: e.errors });
}

router.post('/preview', auth, requirePermission('production', 'view'), (req, res) => {
  try { sendRow(req, res, previewSharedCut(getDB(), req.body || {})); }
  catch (e) { sendErr(res, e); }
});

router.get('/policy', auth, requirePermission('production', 'view'), (req, res) => {
  try {
    sendRow(req, res, loadPolicy(getDB(), {
      marker_length_m: req.query.marker_length_m,
      fabric_product_id: req.query.fabric_product_id,
      width_cm: req.query.width_cm,
      warehouse_id: req.query.warehouse_id,
    }));
  } catch (e) { sendErr(res, e); }
});

router.post('/rules', auth, requirePermission('production', 'create'), (req, res) => {
  try {
    const db = getDB();
    const b = req.body || {};
    const mode = b.mode === 'fixed_m' ? 'fixed_m' : 'formula';
    const min = Number(b.min_remnant_m);
    const ratio = Number(b.remnant_ratio);
    if (!(min >= 0) || !(ratio >= 0)) {
      return res.status(400).json({ error: 'کف و نسبت ته‌طاقه نمی‌تواند منفی باشد', code: 'E_REMNANT_POLICY' });
    }
    const row = db.prepare(`
      INSERT INTO cutting_remnant_rules
        (fabric_product_id, width_cm, warehouse_id, mode, min_remnant_m, remnant_ratio, reason, created_by)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(
      b.fabric_product_id || null, b.width_cm || null, b.warehouse_id || null,
      mode, min, ratio, String(b.reason || ''), req.user.id
    );
    audit(req.user.id, 'create', 'cutting_remnant_rule', row.lastInsertRowid, 'سیاست ته‌طاقه');
    res.json(db.prepare('SELECT * FROM cutting_remnant_rules WHERE id=?').get(row.lastInsertRowid));
  } catch (e) { sendErr(res, e); }
});

router.get('/:id', auth, requirePermission('production', 'view'), (req, res) => {
  try { sendRow(req, res, getSharedCut(getDB(), req.params.id)); }
  catch (e) { sendErr(res, e); }
});

router.post('/', auth, requirePermission('production', 'create'), (req, res) => {
  try {
    const row = postSharedCut(getDB(), req.body || {}, req.user);
    audit(req.user.id, 'create', 'cutting_batch', row.id, `برش مشترک ${row.batch_no}`);
    sendRow(req, res, row);
  } catch (e) { sendErr(res, e); }
});

router.post('/:id/void', auth, requirePermission('production', 'delete'), (req, res) => {
  try {
    const row = voidSharedCut(getDB(), req.params.id, req.user, (req.body || {}).reason);
    audit(req.user.id, 'void', 'cutting_batch', row.id, 'ابطال برش مشترک');
    sendRow(req, res, row);
  } catch (e) { sendErr(res, e); }
});

module.exports = router;
