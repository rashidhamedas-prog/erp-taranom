/**
 * Full void of a warehouse_moves row (R12/R13): reverse inventory ledgers + batch JE.
 */
const { reverseInventoryMovement } = require('./inventory/ledger');
const { reverseJournalEntry } = require('./void-journal');
const { todayJalali } = require('../jalali');
const { audit } = require('../db');

function voidOneMoveInTx(db, move, userId) {
  if (!move || move.status === 'reversed') return;
  const date = todayJalali();

  if (move.type === 'transfer') {
    const leds = db.prepare(`
      SELECT id FROM inventory_ledger
      WHERE source_type='warehouse_transfer' AND source_id=? AND COALESCE(status,'posted')='posted'
      ORDER BY id DESC
    `).all(move.id);
    for (const l of leds) {
      reverseInventoryMovement(db, l.id, { createdBy: userId, date, note: `ابطال انتقال انبار #${move.id}` });
    }
  } else if (move.ledger_id) {
    const led = db.prepare('SELECT id, status FROM inventory_ledger WHERE id=?').get(move.ledger_id);
    if (led && led.status !== 'reversed') {
      reverseInventoryMovement(db, led.id, { createdBy: userId, date, note: `ابطال عملیات انبار #${move.id}` });
    }
  }

  db.prepare(`
    UPDATE warehouse_moves SET status='reversed', reversed_at=strftime('%s','now'), reversed_by=?
    WHERE id=?
  `).run(userId, move.id);
}

/**
 * Void move; if it shares a batch JE, void all sibling moves with same je_id first/together.
 */
function voidWarehouseMove(db, moveId, user) {
  const move = db.prepare('SELECT * FROM warehouse_moves WHERE id=?').get(moveId);
  if (!move) {
    const err = new Error('عملیات انبار یافت نشد');
    err.status = 404;
    throw err;
  }
  if (move.status === 'reversed') {
    const err = new Error('این عملیات قبلاً ابطال شده است');
    err.status = 400;
    throw err;
  }

  let voidedIds = [];
  db.transaction(() => {
    let targets = [move];
    if (move.je_id) {
      targets = db.prepare(`
        SELECT * FROM warehouse_moves
        WHERE je_id=? AND COALESCE(status,'posted')<>'reversed'
        ORDER BY id DESC
      `).all(move.je_id);
      if (!targets.length) targets = [move];
    }

    for (const m of targets) voidOneMoveInTx(db, m, user.id);
    voidedIds = targets.map(t => t.id);

    if (move.je_id) {
      reverseJournalEntry(db, move.je_id, {
        userId: user.id,
        reason: `ابطال عملیات انبار #${move.id}`,
        sourceType: 'warehouse_move_reversal',
      });
    } else {
      // Legacy batch JE linked only via sourceId = first move id
      const batchJe = db.prepare(`
        SELECT id FROM journal_entries
        WHERE ref_type IN ('warehouse_receipt_batch','warehouse_issue_batch')
          AND ref_id=? AND COALESCE(deleted_at,0)=0
        ORDER BY id DESC LIMIT 1
      `).get(move.id);
      if (batchJe) {
        reverseJournalEntry(db, batchJe.id, {
          userId: user.id,
          reason: `ابطال عملیات انبار #${move.id}`,
          sourceType: 'warehouse_move_reversal',
        });
      }
    }
  })();

  audit(user.id, 'reverse', 'warehouse_move', move.id, `ابطال عملیات انبار #${move.id}`);
  return { ok: true, voidedIds, count: voidedIds.length };
}

module.exports = { voidWarehouseMove, voidOneMoveInTx };
