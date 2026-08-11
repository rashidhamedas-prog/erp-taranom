'use strict';

function buildSalesPayload(invoice, opts = {}) {
  if (!invoice) throw new Error('فاکتور الزامی است');
  const fiscalId = opts.fiscalId || '';
  const invoiceType = parseInt(invoice.moadian_invoice_type || opts.invoiceType || 1, 10) || 1;
  const rawRows = invoice.rows;
  let items = [];
  if (Array.isArray(rawRows)) {
    items = rawRows;
  } else if (typeof rawRows === 'string' && rawRows.trim()) {
    try { items = JSON.parse(rawRows); } catch (_) { items = []; }
  }
  if (!Array.isArray(items)) items = [];
  return {
    header: {
      taxid: null,
      indatim: invoice.date || '',
      inty: invoiceType,
      inp: 1,
      inso: invoice.num || '',
      tins: opts.sellerEconomic || '',
      tinb: invoice.economic_code || invoice.national_id || '',
      tob: invoice.economic_code ? 2 : 1,
      setm: 1,
      cap: Number(invoice.final) || 0,
      tvam: 0,
      todam: 0,
      tbill: Number(invoice.final) || 0,
      fiscalId,
    },
    body: items.map((r, i) => ({
      sstid: r.tax_stuff_id || r.tax_id || '',
      sstt: r.name || r.product_name || `item-${i + 1}`,
      am: Number(r.qty) || 0,
      fee: Number(r.price) || 0,
      prdis: Number(r.qty || 0) * Number(r.price || 0),
    })),
  };
}

module.exports = { buildSalesPayload };
