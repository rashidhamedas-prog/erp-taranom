/**
 * Operational party books — retire on void/amend (no hollow «ابطال/اصلاح» rows).
 *
 * Policy (v373 / aligns with JE soft-void v285 + R13 reports):
 * - Soft-void the GL voucher (status=reversed + deleted_at); never post a paired reverse JE.
 * - On void/amend of a business doc, DELETE subledger rows for that ref instead of
 *   inserting entry_type='reversal' lines that pollute customer/supplier/person statements.
 * - Audit trail remains on journal_entries (soft-voided) + business status + audit_log.
 * - hideVoidedBookRows stays as a safety net for any legacy reverse rows.
 * - v446: same for rep_ledger (انگیزه فروش / بازاریاب / نماینده) — no twin «پرداخت + ابطال».
 */
'use strict';

function asIdList(refTypes) {
  if (Array.isArray(refTypes)) return refTypes.filter(Boolean).map(String);
  if (refTypes == null || refTypes === '') return [];
  return [String(refTypes)];
}

function retireRepLedgerByRef(db, { refTypes, refId, repId } = {}) {
  const types = asIdList(refTypes);
  const id = Number(refId);
  if (!types.length || !id) return 0;
  try {
    const ph = types.map(() => '?').join(',');
    const params = [...types, id];
    let sql = `DELETE FROM rep_ledger WHERE ref_type IN (${ph}) AND ref_id=?`;
    if (repId != null) {
      sql += ' AND rep_id=?';
      params.push(Number(repId));
    }
    return Number(db.prepare(sql).run(...params).changes || 0);
  } catch (_) {
    return 0;
  }
}

/**
 * Safety net for marketer / rep / incentive statements (mirrors hideVoidedBookRows).
 * Drops reversed incentive payments, hollow reverse rows, and commission_reversal twins.
 */
function hideVoidedRepLedgerRows(db, rows) {
  let reversedIncentives = new Set();
  try {
    reversedIncentives = new Set(
      db.prepare(`
        SELECT id FROM incentive_payments
        WHERE COALESCE(status,'posted')='reversed'
      `).all().map((r) => Number(r.id))
    );
  } catch (_) { /* optional */ }
  return (rows || []).filter((e) => {
    const refId = Number(e.ref_id);
    const rt = String(e.ref_type || '');
    const et = String(e.entry_type || '');
    if ((rt === 'incentive_payment' || rt === 'incentive_payment_reversal')
      && reversedIncentives.has(refId)) {
      return false;
    }
    if (et === 'reversal' || et === 'commission_reversal'
      || rt.endsWith('_reversal') || rt.includes('reversal')) {
      return false;
    }
    const desc = String(e.description || '');
    if (/^ابطال[\s/]/.test(desc)) return false;
    return true;
  });
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
  let repDeleted = 0;

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

    // Orphan hollow reverse lines (explicit void refs + opening-cheque mirror fixes)
    try {
      const r = db.prepare(`
        DELETE FROM customer_ledger
        WHERE entry_type='reversal'
          AND (
            ref_type LIKE '%\\_reversal' ESCAPE '\\'
            OR description LIKE 'ابطال %'
            OR description LIKE 'ابطال/%'
            OR description LIKE 'اصلاح:%'
            OR description LIKE 'اصلاح: %'
          )
      `).run();
      customerDeleted += Number(r.changes || 0);
    } catch (_) { /* ignore */ }

    // v376: after removing corrective «اصلاح:» debits, also drop phantom opening
    // cheque_in credits (notes/equity JE — never a customer receipt).
    try {
      const openIds = db.prepare(`
        SELECT id FROM cheque_records cr
        WHERE IFNULL(cr.note,'') LIKE '%مانده اول دوره%'
           OR IFNULL(cr.status,'') LIKE '%اول دوره%'
      `).all().map((r) => Number(r.id));
      for (const id of openIds) {
        customerDeleted += retireCustomerLedgerByRef(db, {
          refTypes: ['cheque_in'],
          refId: id,
        });
        personDeleted += retirePersonLedgerByRef(db, {
          refTypes: ['cheque_in'],
          refId: id,
        });
      }
    } catch (_) { /* optional */ }

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

    // v446 — reversed incentive payments: retire original + hollow reverse twins
    try {
      const ids = db.prepare(`
        SELECT id FROM incentive_payments
        WHERE COALESCE(status,'posted')='reversed'
      `).all().map((r) => Number(r.id));
      for (const id of ids) {
        repDeleted += retireRepLedgerByRef(db, {
          refTypes: ['incentive_payment', 'incentive_payment_reversal'],
          refId: id,
        });
      }
    } catch (_) { /* optional */ }

    // Soft-void live incentive_payment JEs whose payment is already reversed
    try {
      const { reverseJournalEntry } = require('./void-journal');
      const live = db.prepare(`
        SELECT je.id
        FROM journal_entries je
        JOIN incentive_payments ip ON ip.id = je.ref_id
        WHERE je.ref_type='incentive_payment'
          AND COALESCE(ip.status,'posted')='reversed'
          AND COALESCE(je.deleted_at,0)=0
          AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
      `).all();
      for (const row of live) {
        reverseJournalEntry(db, row.id, {
          reason: 'ابطال پرداخت انگیزه فروش (heal)',
          sourceType: 'incentive_payment_reversal',
        });
      }
    } catch (_) { /* optional */ }

    // Drop leftover standalone incentive_payment_reversal vouchers
    try {
      const { hardDeleteJournalEntry } = require('./void-journal');
      const revs = db.prepare(`
        SELECT id FROM journal_entries
        WHERE ref_type='incentive_payment_reversal'
          AND COALESCE(deleted_at,0)=0
      `).all();
      for (const row of revs) hardDeleteJournalEntry(db, row.id);
    } catch (_) { /* optional */ }

    // Soft-void commission accrual JEs that already have a hollow reverse twin in rep_ledger
    try {
      const { reverseJournalEntry } = require('./void-journal');
      const twins = db.prepare(`
        SELECT DISTINCT ref_type, ref_id FROM rep_ledger
        WHERE entry_type='commission_reversal'
      `).all();
      for (const t of twins) {
        const src = t.ref_type === 'invoice'
          ? 'commission_accrual_invoice'
          : t.ref_type === 'settlement'
            ? 'commission_accrual_settlement'
            : null;
        if (!src) continue;
        const je = db.prepare(`
          SELECT id FROM journal_entries
          WHERE ref_type=? AND ref_id=?
            AND COALESCE(deleted_at,0)=0
            AND COALESCE(status,'posted') NOT IN ('reversed','void')
          ORDER BY id ASC LIMIT 1
        `).get(src, t.ref_id);
        if (je) {
          reverseJournalEntry(db, je.id, {
            reason: 'ابطال تعهد انگیزه فروش (heal)',
            sourceType: `${src}_reversal`,
          });
        }
        repDeleted += retireRepLedgerByRef(db, {
          refTypes: [t.ref_type],
          refId: t.ref_id,
        });
        try {
          const { hardDeleteJournalEntry } = require('./void-journal');
          const revJe = db.prepare(`
            SELECT id FROM journal_entries
            WHERE ref_type=? AND ref_id=?
          `).all(`${src}_reversal`, t.ref_id);
          for (const r of revJe) hardDeleteJournalEntry(db, r.id);
        } catch (__) { /* ignore */ }
      }
    } catch (_) { /* optional */ }

    // Orphan hollow reverse lines on rep_ledger
    try {
      const r = db.prepare(`
        DELETE FROM rep_ledger
        WHERE entry_type='reversal'
           OR entry_type='commission_reversal'
           OR entry_type LIKE '%\\_reversal' ESCAPE '\\'
           OR ref_type LIKE '%\\_reversal' ESCAPE '\\'
           OR description LIKE 'ابطال %'
           OR description LIKE 'ابطال/%'
      `).run();
      repDeleted += Number(r.changes || 0);
    } catch (_) { /* ignore */ }
  });
  tx();

  return { relabeled, customerDeleted, personDeleted, supplierDeleted, repDeleted };
}

module.exports = {
  retireCustomerLedgerByRef,
  retirePersonLedgerByRef,
  retireSupplierLedgerByRef,
  retireRepLedgerByRef,
  hideVoidedRepLedgerRows,
  purgeHollowPartyLedgerReversals,
};
