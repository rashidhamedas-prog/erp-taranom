'use strict';
/**
 * Undo mistaken settlement voids when the sale JE already carried the cash pair
 * (legacy path) and a later settlement_reversal put AR back on the books.
 * Idempotent via settings flag + per-row checks.
 */
const FLAG = 'spurious_settlement_void_repair_v1';

function softReverseJournal(db, jeId) {
  if (!jeId) return;
  try {
    db.prepare(`
      UPDATE journal_entries
      SET status='reversed'
      WHERE id=? AND COALESCE(status,'posted') NOT IN ('reversed','void')
    `).run(jeId);
  } catch (_) { /* ignore */ }
}

function repairSpuriousSettlementVoids(db, opts = {}) {
  const force = !!(opts && opts.force);
  if (!force) {
    const done = db.prepare('SELECT value FROM settings WHERE key=?').get(FLAG);
    if (done && done.value === '1') return { skipped: true, fixed: 0 };
  }

  let fixed = 0;
  const run = db.transaction(() => {
    // Live settlement_reversal JEs whose settlement is reversed and whose invoice
    // already posts "دریافت هنگام فاکتور" (cash already on sale voucher).
    const rows = db.prepare(`
      SELECT je.id AS rev_je_id, je.ref_id AS settlement_id, s.invoice_id, s.amount
      FROM journal_entries je
      JOIN settlements s ON s.id=je.ref_id
      WHERE je.ref_type='settlement_reversal'
        AND COALESCE(je.deleted_at,0)=0
        AND COALESCE(je.status,'posted') NOT IN ('reversed','void')
        AND COALESCE(s.status,'posted')='reversed'
        AND s.invoice_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM journal_lines jl
          JOIN journal_entries ije ON ije.id=jl.entry_id
          WHERE ije.ref_type='invoice' AND ije.ref_id=s.invoice_id
            AND COALESCE(ije.deleted_at,0)=0
            AND COALESCE(ije.status,'posted') NOT IN ('reversed','void')
            AND jl.description LIKE '%دریافت هنگام فاکتور%'
            AND COALESCE(jl.debit_rial, jl.debit, 0) > 0
        )
    `).all();

    for (const r of rows) {
      softReverseJournal(db, r.rev_je_id);
      // Drop the customer_ledger "ابطال تسویه" row that re-opened AR.
      db.prepare(`
        DELETE FROM customer_ledger
        WHERE ref_type='settlement' AND ref_id=? AND entry_type='reversal'
          AND description LIKE 'ابطال تسویه%'
      `).run(r.settlement_id);
      // Keep the original settlement credit row so statement shows invoice + receipt.
      fixed += 1;
    }

    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?, '1')").run(FLAG);
  });
  run();
  return { skipped: false, fixed, scanned: undefined };
}

module.exports = { repairSpuriousSettlementVoids, FLAG };
