/**
 * Canonical invoice face / allocable amounts (Iran AR/AP — net after commercial discount).
 *
 * Trade / invoice discounts reduce the receivable/payable face. Allocation UIs and
 * open-invoice outstanding MUST use this face (final_rial), never gross line totals
 * or subtotal-before-header-discount.
 *
 * Aligns with:
 * - ERPNext: allocate Grand Total / current outstanding (not pre-discount gross)
 * - Iranian trade-discount practice + std 43: revenue/AR at net consideration
 * - Project COA receivable (legacy 1103 / Mahak 2030*): Dr AR = final after discount
 */
'use strict';

function moneyRial(v) {
  const n = Math.round(Number(v) || 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Invoice / purchase face amount in rial (after line + header commercial discount,
 * including VAT and freight charged to counterparty when stored in final).
 */
function invoiceFaceRial(row) {
  if (!row) return 0;
  const fr = moneyRial(row.final_rial);
  if (fr > 0) return fr;
  return moneyRial(row.final);
}

function purchaseInvoiceFaceRial(row) {
  return invoiceFaceRial(row);
}

/** SQL expression for sales invoice face (has final_rial). */
function sqlInvoiceFaceRial(alias) {
  const a = alias ? `${alias}.` : '';
  return `COALESCE(NULLIF(${a}final_rial,0), ROUND(${a}final), 0)`;
}

/**
 * SQL for purchase invoice face.
 * purchase_invoices may lack final_rial — use ROUND(final) only unless withRialCol.
 */
function sqlPurchaseFaceRial(alias, withRialCol = false) {
  const a = alias ? `${alias}.` : '';
  if (withRialCol) return `COALESCE(NULLIF(${a}final_rial,0), ROUND(${a}final), 0)`;
  return `COALESCE(ROUND(${a}final), 0)`;
}

/**
 * Shape a row for allocation / picker UIs.
 * @param {object} row — invoice or purchase_invoice (+ optional paid/outstanding)
 * @param {{ paid?: number, outstanding?: number }} [extra]
 */
function allocPickerFields(row, extra = {}) {
  const amount_rial = invoiceFaceRial(row);
  const paid = moneyRial(extra.paid != null ? extra.paid : row.paid);
  const outstanding = extra.outstanding != null
    ? moneyRial(extra.outstanding)
    : Math.max(0, amount_rial - paid);
  return {
    id: row.id,
    num: row.num,
    date: row.date,
    type: row.type || null,
    subtotal: moneyRial(row.subtotal),
    disc_amt: moneyRial(row.disc_amt),
    amount_rial,
    /** @deprecated use amount_rial — kept so older UI reading `.final` still gets net face */
    final: amount_rial,
    final_rial: amount_rial,
    paid,
    outstanding,
  };
}

module.exports = {
  moneyRial,
  invoiceFaceRial,
  purchaseInvoiceFaceRial,
  sqlInvoiceFaceRial,
  sqlPurchaseFaceRial,
  allocPickerFields,
};
