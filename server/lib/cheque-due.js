'use strict';
/**
 * Open incoming cheques for live alerts.
 *
 * Source of truth is cheque_records.lifecycle_status.
 * settlements.cheque_status is a mirror: وصول / خرج / برگشت / ابطال
 * used to leave it on pending, so the accounting dashboard kept showing
 * a cheque that had already cleared.
 */

const CLOSED_MIRROR = new Set([
  'reversed', 'cancelled', 'void', 'paid', 'endorsed', 'issued', 'expensed',
]);

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch (_) {
    return false;
  }
}

function tableHasColumn(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch (_) {
    return false;
  }
}

/** Machine lifecycle → settlements.cheque_status (pending|received|bounced|cancelled). */
function settlementStatusForCheque(row) {
  const recordStatus = String(row && row.record_status || 'posted').trim();
  const lc = String(row && row.lifecycle_status || '').trim();
  if (recordStatus === 'reversed' || CLOSED_MIRROR.has(lc)) return 'cancelled';
  if (lc === 'cleared') return 'received';
  if (lc === 'bounced') return 'bounced';
  return 'pending';
}

/**
 * Keep the settlement row aligned with the cheque book.
 * No-op when the cheque has no settlement (opening book, manual register).
 */
function syncSettlementChequeStatus(db, chequeId) {
  const id = Number(chequeId);
  if (!db || !id) return { updated: 0 };
  if (!tableExists(db, 'cheque_records') || !tableExists(db, 'settlements')) return { updated: 0 };
  if (!tableHasColumn(db, 'cheque_records', 'settlement_id')) return { updated: 0 };
  const row = db.prepare(`
    SELECT settlement_id, lifecycle_status, record_status
    FROM cheque_records WHERE id=?
  `).get(id);
  const sid = row && Number(row.settlement_id);
  if (!sid) return { updated: 0 };
  const status = settlementStatusForCheque(row);
  const r = db.prepare(`
    UPDATE settlements
    SET cheque_status=?
    WHERE id=? AND pay_type='cheque'
  `).run(status, sid);
  return { updated: r.changes || 0, cheque_status: status, settlement_id: sid };
}

/**
 * One-shot backfill: every settlement linked to a cheque book row
 * takes the status of the newest live record (else the newest void).
 */
function repairLinkedSettlementChequeStatus(db) {
  const FLAG = 'cheque_settlement_status_v326';
  if (!db || !tableExists(db, 'settings') || !tableExists(db, 'settlements') || !tableExists(db, 'cheque_records')) {
    return { skipped: true };
  }
  if (!tableHasColumn(db, 'cheque_records', 'settlement_id') || !tableHasColumn(db, 'cheque_records', 'lifecycle_status')) {
    return { skipped: true, reason: 'no_link' };
  }
  const flag = db.prepare('SELECT value FROM settings WHERE key=?').get(FLAG);
  if (flag && flag.value === '1') return { skipped: true };

  try {
    const info = db.prepare(`
      UPDATE settlements SET cheque_status = (
        SELECT CASE
          WHEN COALESCE(cr.record_status,'posted')='reversed'
            OR TRIM(COALESCE(cr.lifecycle_status,'')) IN ('reversed','cancelled','void','paid','endorsed','issued','expensed')
            THEN 'cancelled'
          WHEN TRIM(COALESCE(cr.lifecycle_status,''))='cleared' THEN 'received'
          WHEN TRIM(COALESCE(cr.lifecycle_status,''))='bounced' THEN 'bounced'
          ELSE 'pending'
        END
        FROM cheque_records cr
        WHERE cr.settlement_id = settlements.id
        ORDER BY CASE WHEN COALESCE(cr.record_status,'posted')='reversed' THEN 1 ELSE 0 END, cr.id DESC
        LIMIT 1
      )
      WHERE pay_type='cheque'
        AND EXISTS (SELECT 1 FROM cheque_records cr WHERE cr.settlement_id = settlements.id)
    `).run();
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(FLAG, '1');
    return { skipped: false, changes: info.changes || 0 };
  } catch (e) {
    return { skipped: true, reason: e && e.message };
  }
}

function recordAmountExpr(db) {
  if (tableHasColumn(db, 'cheque_records', 'amount_rial')) return 'COALESCE(amount_rial, amount, 0)';
  return 'COALESCE(amount, 0)';
}

const OPEN_IN_SQL = `
  direction='in'
  AND COALESCE(record_status,'posted') NOT IN ('void','reversed')
  AND TRIM(COALESCE(lifecycle_status,'')) IN ('','registered','in_hand','pending','in_collection')
`;

/**
 * Cheques still in hand or in collection, due on or before `horizon` (Jalali YYYY/MM/DD).
 * A cheque book row owns the cheque: a cleared/voided record is not replaced by a stale pending settlement.
 * Settlements with no cheque book row (legacy) still count while cheque_status is pending.
 */
function countOpenDueCheques(db, horizon) {
  repairLinkedSettlementChequeStatus(db);
  let n = 0;
  if (tableExists(db, 'cheque_records') && tableHasColumn(db, 'cheque_records', 'due_date') && tableHasColumn(db, 'cheque_records', 'lifecycle_status')) {
    n += Number(db.prepare(`
      SELECT COUNT(*) c FROM cheque_records
      WHERE ${OPEN_IN_SQL}
        AND TRIM(COALESCE(due_date,''))<>''
        AND due_date<=?
    `).get(horizon)?.c) || 0;
  }
  if (tableExists(db, 'settlements') && tableHasColumn(db, 'settlements', 'cheque_due') && tableHasColumn(db, 'settlements', 'cheque_status')) {
    const reversed = tableHasColumn(db, 'settlements', 'status')
      ? "AND COALESCE(status,'posted')<>'reversed'"
      : '';
    const owned = tableExists(db, 'cheque_records') && tableHasColumn(db, 'cheque_records', 'settlement_id')
      ? 'AND NOT EXISTS (SELECT 1 FROM cheque_records cr WHERE cr.settlement_id = settlements.id)'
      : '';
    n += Number(db.prepare(`
      SELECT COUNT(*) c FROM settlements
      WHERE pay_type='cheque'
        AND COALESCE(NULLIF(TRIM(cheque_status),''),'pending')='pending'
        ${reversed}
        AND TRIM(COALESCE(cheque_due,''))<>''
        AND cheque_due<=?
        ${owned}
    `).get(horizon)?.c) || 0;
  }
  return n;
}

/** Live incoming portfolio for the treasury dashboard (rial). */
function openIncomingPortfolio(db, today) {
  repairLinkedSettlementChequeStatus(db);
  const out = { open_rial: 0, overdue_count: 0, overdue_rial: 0 };
  if (tableExists(db, 'cheque_records') && tableHasColumn(db, 'cheque_records', 'lifecycle_status')) {
    const amt = recordAmountExpr(db);
    const open = db.prepare(`
      SELECT COALESCE(SUM(${amt}),0) s FROM cheque_records WHERE ${OPEN_IN_SQL}
    `).get();
    out.open_rial += Math.round(Number(open && open.s) || 0);
    if (today && tableHasColumn(db, 'cheque_records', 'due_date')) {
      const od = db.prepare(`
        SELECT COUNT(*) n, COALESCE(SUM(${amt}),0) s
        FROM cheque_records
        WHERE ${OPEN_IN_SQL}
          AND TRIM(COALESCE(due_date,''))<>''
          AND due_date < ?
      `).get(today);
      out.overdue_count += Number(od && od.n) || 0;
      out.overdue_rial += Math.round(Number(od && od.s) || 0);
    }
  }
  if (tableExists(db, 'settlements') && tableHasColumn(db, 'settlements', 'cheque_status')) {
    const amtExpr = tableHasColumn(db, 'settlements', 'cheque_amount')
      ? 'COALESCE(cheque_amount, amount, 0)'
      : 'COALESCE(amount, 0)';
    const reversed = tableHasColumn(db, 'settlements', 'status')
      ? "AND COALESCE(status,'posted')<>'reversed'"
      : '';
    const owned = tableExists(db, 'cheque_records') && tableHasColumn(db, 'cheque_records', 'settlement_id')
      ? 'AND NOT EXISTS (SELECT 1 FROM cheque_records cr WHERE cr.settlement_id = settlements.id)'
      : '';
    const pending = db.prepare(`
      SELECT COALESCE(SUM(${amtExpr}),0) s
      FROM settlements
      WHERE pay_type='cheque'
        AND COALESCE(NULLIF(TRIM(cheque_status),''),'pending')='pending'
        ${reversed}
        ${owned}
    `).get();
    out.open_rial += Math.round(Number(pending && pending.s) || 0);
    if (today && tableHasColumn(db, 'settlements', 'cheque_due')) {
      const od = db.prepare(`
        SELECT COUNT(*) n, COALESCE(SUM(${amtExpr}),0) s
        FROM settlements
        WHERE pay_type='cheque'
          AND COALESCE(NULLIF(TRIM(cheque_status),''),'pending')='pending'
          ${reversed}
          AND TRIM(COALESCE(cheque_due,''))<>''
          AND cheque_due < ?
          ${owned}
      `).get(today);
      out.overdue_count += Number(od && od.n) || 0;
      out.overdue_rial += Math.round(Number(od && od.s) || 0);
    }
  }
  return out;
}

module.exports = {
  settlementStatusForCheque,
  syncSettlementChequeStatus,
  repairLinkedSettlementChequeStatus,
  countOpenDueCheques,
  openIncomingPortfolio,
};
