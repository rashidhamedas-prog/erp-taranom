'use strict';
/** Minimal Taranom sample seed for production tests (expanded in later phases). */
function seedTaranom(db) {
  // Cost centers / warehouses / CoA are seeded by initProductionSchema.
  // Placeholder for product/BOM sample data used from P1 onward.
  return { ok: true };
}

module.exports = { seedTaranom };
