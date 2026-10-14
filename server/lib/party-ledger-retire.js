/**
 * Operational party books — retire on void/amend (no hollow «ابطال/اصلاح» rows).
 *
 * Policy (v373 / aligns with JE soft-void v285 + R13 reports):
 * - Soft-void the GL voucher (status=reversed + deleted_at); never post a paired reverse JE.
 * - On void/amend of a business doc, DELETE subledger rows for that ref instead of
 *   inserting entry_type='reversal' lines that pollute customer/supplier/person statements.
 * - Audit trail remains on journal_entries (soft-voided) + business status + audit_log.
 * - hideVoidedBookRows stays as a safety net for any legacy reverse rows.
 */
'use strict';

function asIdList(refTypes) {
  if (Array.isArray(refTypes)) return refTypes.filter(Boolean).map(String);
  if (refTypes == null || refTypes === '') return [];
  return [String(refTypes)];
}

function retireCustomerLedgerByRef(db, { refTypes, refId, customerId } = {}) {
  const types = asIdList(refTypes);
  const id = Number(refId);
  if (!types.length || !id) return 0;
  const ph = types.map(() => '?').join(',');
  const params = [...types, id];
  let sql = `DELETE FROM customer_ledger WHERE ref_type IN (${ph}) AND ref_id=?`;
  if (customerId != null) {
    sql += ' AND customer_id=?';
    params.push(Number(customerId));
  }
  return Number(db.prepare(sql).run(...params).changes || 0);
}

function retirePersonLedgerByRef(db, { refTypes, refId, personId } = {}) {
  const types = asIdList(refTypes);
  const id = Number(refId);
  if (!types.length || !id) return 0;
  try {
    const ph = types.map(() => '?').join(',');
    const params = [...types, id];
    let sql = `DELETE FROM person_ledger WHERE ref_type IN (${ph}) AND ref_id=?`;
    if (personId != null) {
      sql += ' AND person_id=?';
      params.push(Number(personId));
    }
    return Number(db.prepare(sql).run(...params).changes || 0);
  } catch (_) {
    return 0;
  }
}

function retireSupplierLedgerByRef(db, { refTypes, refId, supplierId } = {}) {
  const types = asIdList(refTypes);
  const id = Number(refId);
  if (!types.length || !id) return 0;
  try {
    const ph = types.map(() => '?').join(',');
    const params = [...types, id];
    let sql = `DELETE FROM supplier_ledger WHERE ref_type IN (${ph}) AND ref_id=?`;
    if (supplierId != null) {
      sql += ' AND supplier_id=?';
      params.push(Number(supplierId));
    }
    return Number(db.prepare(sql).run(...params).changes || 0);
  } catch (_) {
    return 0;
  }
}

/**
 * One-shot / boot-safe heal of hollow reverse subledger rows.
 * Idempotent. Does not touch live (posted) documents.
 */
function purgeHollowPartyLedgerReversals(db) {
  let relabeled = 0;
  let customerDeleted = 0;
  let personDeleted = 0;
  let supplierDeleted = 0;

  const tx = db.transaction(() => {
    // Live sales returns were wrongly tagged entry_type='reversal' → label as sales_return
    try {
      const r = db.prepare(`
        UPDATE customer_ledger
        SET entry_type='sales_return'
        WHERE ref_type='sales_return'
          AND entry_type='reversal'
          AND COALESCE(description,'') NOT LIKE 'ابطال%'
      `).run();
      relabeled += Number(r.changes || 0);
    } catch (_) { /* ignore */ }

    // Drop all ledger rows for reversed sales returns (original + void lines)
    try {
      const ids = db.prepare(`
        SELECT id FROM sales_returns WHERE COALESCE(status,'posted')='reversed'
      `).all().map((r) => Number(r.id));
      for (const id of ids) {
        customerDeleted += retireCustomerLedgerByRef(db, {
          refTypes: ['sales_return', 'sales_return_reversal'],
          refId: id,
        });
      }
    } catch (_) { /* table optional */ }

    // Reversed POS receipts
    try {
      const ids = db.prepare(`
        SELECT id FROM pos_receipts
        WHERE COALESCE(status,'open') IN ('reversed','void')
      `).all().map((r) => Number(r.id));
      for (const id of ids) {
        customerDeleted += retireCustomerLedgerByRef(db, {
          refTypes: ['pos_receipt'],
          refId: id,
        });
      }
    } catch (_) { /* optional */ }

    // Reversed settlements — remove original + any reverse lines
    try {
      const ids = db.prepare(`
        SELECT id FROM settlements WHERE COALESCE(status,'posted')='reversed'
      `).all().map((r) => Number(r.id));
      for (const id of ids) {
        customerDeleted += retireCustomerLedgerByRef(db, {
          refTypes: ['settlement'],
          refId: id,
        });
      }
    } catch (_) { /* optional */ }

    // Reversed / cancelled invoices
    try {
      const ids = db.prepare(`
        SELECT id FROM invoices
        WHERE COALESCE(status,'') IN ('reversed','void','cancelled')
           OR COALESCE(deleted_at,0)>0
      `).all().map((r) => Number(r.id));
      for (const id of ids) {
        customerDeleted += retireCustomerLedgerByRef(db, {
          refTypes: ['invoice', 'invoice_payment', 'invoice_ar_reclass'],
          refId: id,
        });
      }
    } catch (_) {
      try {
        const ids = db.prepare(`
          SELECT id FROM invoices WHERE COALESCE(deleted_at,0)>0
        `).all().map((r) => Number(r.id));
        for (const id of ids) {
          customerDeleted += retireCustomerLedgerByRef(db, {
            refTypes: ['invoice', 'invoice_payment'],
            refId: id,
          });
        }
      } catch (__) { /* ignore */ }
    }

    // Orphan hollow reverse lines (explicit void refs)
    try {
      const r = db.prepare(`
        DELETE FROM customer_ledger
        WHERE entry_type='reversal'
          AND (
            ref_type LIKE '%\\_reversal' ESCAPE '\\'
            OR description LIKE 'ابطال %'
            OR description LIKE 'ابطال/%'
          )
      `).run();
      customerDeleted += Number(r.changes || 0);
    } catch (_) { /* ignore */ }

    // Reversed cheques — drop book rows (hideVoided already filters; purge cleans DB)
    try {
      const ids = db.prepare(`
        SELECT id FROM cheque_records
        WHERE COALESCE(record_status,'posted')='reversed'
      `).all().map((r) => Number(r.id));
      for (const id of ids) {
        customerDeleted += retireCustomerLedgerByRef(db, {
          refTypes: ['cheque', 'cheque_in', 'cheque_endorse', 'cheque_clear', 'cheque_bounce'],
          refId: id,
        });
        personDeleted += retirePersonLedgerByRef(db, {
          refTypes: ['cheque', 'cheque_in', 'cheque_endorse', 'cheque_clear', 'cheque_bounce'],
          refId: id,
        });
      }
    } catch (_) { /* optional */ }

    // Reversed fabric rolls
    try {
      const ids = db.prepare(`
        SELECT id FROM inventory_batches
        WHERE COALESCE(kind,'generic')='fabric'
          AND COALESCE(status,'')='reversed'
      `).all().map((r) => Number(r.id));
      for (const id of ids) {
        supplierDeleted += retireSupplierLedgerByRef(db, {
          refTypes: ['fabric_roll'],
          refId: id,
        });
      }
    } catch (_) { /* optional */ }

    // Supplier: reversed purchases / returns / payments
    try {
      const purchIds = db.prepare(`
        SELECT id FROM purchase_invoices
        WHERE COALESCE(status,'posted') IN ('reversed','void','cancelled')
      `).all().map((r) => Number(r.id));
      for (const id of purchIds) {
        supplierDeleted += retireSupplierLedgerByRef(db, {
          refTypes: ['purchase', 'purchase_invoice'],
          refId: id,
        });
      }
    } catch (_) { /* optional */ }
    try {
      const retIds = db.prepare(`
        SELECT id FROM purchase_returns
        WHERE COALESCE(status,'posted')='reversed'
      `).all().map((r) => Number(r.id));
      for (const id of retIds) {
        supplierDeleted += retireSupplierLedgerByRef(db, {
          refTypes: ['purchase_return', 'purchase_return_reversal'],
          refId: id,
        });
      }
    } catch (_) { /* optional */ }
    try {
      const payIds = db.prepare(`
        SELECT id FROM supplier_payments
        WHERE COALESCE(status,'posted')='reversed'
      `).all().map((r) => Number(r.id));
      for (const id of payIds) {
        supplierDeleted += retireSupplierLedgerByRef(db, {
          refTypes: ['supplier_payment'],
          refId: id,
        });
      }
    } catch (_) { /* optional */ }

    // Person ledger hollow reversals (incl. payroll_payment_reversal leftovers)
    try {
      const r = db.prepare(`
        DELETE FROM person_ledger
        WHERE (
          entry_type='reversal'
          OR entry_type LIKE '%\\_reversal' ESCAPE '\\'
          OR ref_type LIKE '%\\_reversal' ESCAPE '\\'
          OR description LIKE 'ابطال %'
          OR description LIKE 'ابطال/%'
        )
      `).run();
      personDeleted += Number(r.changes || 0);
    } catch (_) {
      try {
        const r2 = db.prepare(`
          UPDATE person_ledger SET deleted_at=strftime('%s','now')
          WHERE COALESCE(deleted_at,0)=0
            AND (
              entry_type='reversal'
              OR entry_type LIKE '%\\_reversal' ESCAPE '\\'
              OR ref_type LIKE '%\\_reversal' ESCAPE '\\'
              OR description LIKE 'ابطال %'
            )
        `).run();
        personDeleted += Number(r2.changes || 0);
      } catch (__) { /* ignore */ }
    }

    try {
      const r = db.prepare(`
        DELETE FROM supplier_ledger
        WHERE entry_type='reversal'
          AND (
            ref_type LIKE '%\\_reversal' ESCAPE '\\'
            OR description LIKE 'ابطال %'
            OR description LIKE 'ابطال/%'
          )
      `).run();
      supplierDeleted += Number(r.changes || 0);
    } catch (_) { /* ignore */ }
  });
  tx();

  return { relabeled, customerDeleted, personDeleted, supplierDeleted };
}

module.exports = {
  retireCustomerLedgerByRef,
  retirePersonLedgerByRef,
  retireSupplierLedgerByRef,
  purgeHollowPartyLedgerReversals,
};
