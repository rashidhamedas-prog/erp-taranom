// VAT calculation — spec Phase 3

function getVatRate(db) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='vat_rate'").get();
    const n = parseFloat(row?.value);
    return Number.isFinite(n) ? n : 10;
  } catch (_) { return 10; }
}

function lineVatExempt(vatClass) {
  return vatClass === 'exempt' || vatClass === 'zero-rated';
}

/** Build invoice/purchase totals with optional VAT on taxable lines. */
function calcDocTotals(db, builtRows, discPct, options = {}) {
  const rate = options.vatRate != null ? options.vatRate : getVatRate(db);
  const subtotal = builtRows.subtotal || 0;
  const discAmt = Math.round(subtotal * (parseFloat(discPct) || 0) / 100);
  const netBeforeVat = subtotal - discAmt;

  if (options.vatExempt) {
    return { subtotal, discAmt, netBeforeVat, vatAmount: 0, vatRate: 0, final: netBeforeVat, taxableBase: 0 };
  }

  let taxableBase = 0;
  for (const r of builtRows.rows || []) {
    const prod = db.prepare('SELECT vat_class FROM products WHERE id=?').get(r.product_id);
    if (!lineVatExempt(prod?.vat_class)) taxableBase += r.sum || 0;
  }
  if (subtotal > 0 && discAmt > 0) {
    taxableBase = Math.round(taxableBase * (1 - discAmt / subtotal));
  }
  const vatAmount = Math.round(taxableBase * rate / 100);
  const final = netBeforeVat + vatAmount;
  return { subtotal, discAmt, netBeforeVat, vatAmount, vatRate: rate, final, taxableBase };
}

module.exports = { getVatRate, lineVatExempt, calcDocTotals };
