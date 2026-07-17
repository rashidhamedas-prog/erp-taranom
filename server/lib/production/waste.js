'use strict';
/**
 * Waste classification helpers.
 */
const { setting } = require('./costing');

function normalWastePct(db, po) {
  if (po?.cost_center_id) {
    try {
      const cc = db.prepare('SELECT * FROM cost_centers WHERE id=?').get(po.cost_center_id);
      if (cc && cc.normal_waste_percent != null && Number(cc.normal_waste_percent) > 0) {
        return Number(cc.normal_waste_percent);
      }
    } catch { /* column may be missing on legacy cost_centers */ }
  }
  return Number(setting(db, 'production_normal_waste_default_pct', '3')) || 3;
}

/**
 * Cap normal waste; excess → abnormal (auto reclass).
 */
function classifyWaste(db, { qtyStarted, wNormal, wAbnormal, allowedPct }) {
  const started = Number(qtyStarted) || 0;
  const pct = allowedPct != null ? Number(allowedPct) : 3;
  const allowed = Math.floor(started * pct / 100);
  let wN = Number(wNormal) || 0;
  let wA = Number(wAbnormal) || 0;
  let autoReclass = 0;
  if (wN > allowed) {
    autoReclass = wN - allowed;
    wN = allowed;
    wA += autoReclass;
  }
  return { wN, wA, allowed, autoReclass };
}

module.exports = { classifyWaste, normalWastePct };
