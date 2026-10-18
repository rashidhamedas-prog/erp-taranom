const router = require('express').Router();
const { getDB, audit, resolveCashAccount } = require('../db');
const { postToLedger } = require('../lib/ledger');
const { auth, adminOrAccounting } = require('../middleware/auth');
const { todayJalali } = require('../jalali');
const {
  parseFeeCostCenterInput, resolveFeeCostCenterId,
  transferLines, transferReversalLines,
} = require('../lib/payment-bank-fee');
const {
  assertActiveBank, assertActiveCashBox, assertBankOverdraftOk, assertCashFloatCeilingOk,
} = require('../lib/treasury-guards');
const {
  assertTransferPair, assertPaymentDate, withPaymentIdempotency,
} = require('../lib/cash-payment-contract');

function resolveSide(db, type, id) {
  if (type === 'bank') return resolveCashAccount(db, 'bank', id, null);
  return resolveCashAccount(db, 'cash', null, id);
}

function sideName(db, type, id) {
  if (!id) return type === 'bank' ? 'بانک (عمومی)' : 'صندوق (عمومی)';
  const row = type === 'bank'
    ? db.prepare('SELECT name FROM banks WHERE id=?').get(id)
    : db.prepare('SELECT name FROM cash_boxes WHERE id=?').get(id);
  return row ? row.name : '-';
}

router.get('/', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare("SELECT t.*, u.name as recorder FROM account_transfers t LEFT JOIN users u ON t.user_id=u.id WHERE COALESCE(t.status,'posted')<>'reversed' ORDER BY t.date DESC, t.id DESC LIMIT 300").all();
  rows.forEach(r => {
    r.from_name = sideName(db, r.from_type, r.from_id);
    r.to_name = sideName(db, r.to_type, r.to_id);
  });
  res.json(rows);
});

router.post('/', auth, adminOrAccounting, (req, res) => {
  const { note, fee_cost_center_id, bank_fee_cost_center_id } = req.body;
  const db = getDB();
  try {
    const pair = assertTransferPair(req.body);
    const when = assertPaymentDate(db, req.body.date);
    const feeCcId = resolveFeeCostCenterId(db, {
      feeRial: pair.fee, fromType: pair.fromType,
      feeCostCenterId: parseFeeCostCenterInput({ fee_cost_center_id, bank_fee_cost_center_id }),
    });
    if (pair.fromType === 'bank') assertActiveBank(db, pair.fromId);
    else assertActiveCashBox(db, pair.fromId);
    if (pair.toType === 'bank') assertActiveBank(db, pair.toId);
    else assertActiveCashBox(db, pair.toId);
    if (pair.fromType === 'bank') assertBankOverdraftOk(db, pair.fromId, pair.amount + pair.fee);
    if (pair.toType === 'cash') assertCashFloatCeilingOk(db, pair.toId, pair.amount);
    const out = withPaymentIdempotency(db, {
      key: req.body.idempotency_key, userId: req.user.id, path: '/api/transfers', body: req.body,
    }, () => {
      if (pair.fromType === 'bank') assertBankOverdraftOk(db, pair.fromId, pair.amount + pair.fee);
      const result = db.prepare(
        'INSERT INTO account_transfers (date,from_type,from_id,to_type,to_id,amount,fee_rial,fee_cost_center_id,note,user_id) VALUES (?,?,?,?,?,?,?,?,?,?)'
      ).run(when, pair.fromType, pair.fromId, pair.toType, pair.toId, pair.amount, pair.fee, feeCcId, note || '', req.user.id);
      const transferId = result.lastInsertRowid;
      const src = resolveSide(db, pair.fromType, pair.fromId);
      const dst = resolveSide(db, pair.toType, pair.toId);
      const { lines } = transferLines(db, {
        amount: pair.amount, feeRial: pair.fee, fromType: pair.fromType, src, dst, feeCostCenterId: feeCcId,
      });
      const entryId = postToLedger(db, {
        sourceType: 'transfer', sourceId: transferId,
        date: when, description: `انتقال داخلی: ${sideName(db, pair.fromType, pair.fromId)} ← ${sideName(db, pair.toType, pair.toId)}`,
        createdBy: req.user.id,
        costCenterId: feeCcId,
        lines,
      });
      return {
        id: transferId, ok: true, fee_rial: pair.fee, fee_cost_center_id: feeCcId, journal_id: entryId,
      };
    });
    if (!out.replayed) audit(req.user.id, 'create', 'transfer', out.id, `انتقال داخلی ${pair.amount} ریال`);
    res.json(out);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('transfer', e);
    res.status(status).json({ error: e.message || 'ثبت انتقال ناموفق بود', code: e.code });
  }
});

router.delete('/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM account_transfers WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (row.status === 'reversed') return res.status(400).json({ error: 'این انتقال قبلاً ابطال شده است' });
  db.transaction(() => {
    const src = resolveSide(db, row.from_type, row.from_id);
    const dst = resolveSide(db, row.to_type, row.to_id);
    const { lines } = transferReversalLines(db, {
      amount: row.amount, feeRial: row.fee_rial || 0, src, dst,
      feeCostCenterId: row.fee_cost_center_id || null,
    });
    const reversalId = postToLedger(db, {
      sourceType: 'transfer_reversal', sourceId: row.id,
      date: todayJalali(), description: `ابطال انتقال وجه #${row.id}`, createdBy: req.user.id,
      costCenterId: row.fee_cost_center_id || null,
      lines,
    });
    db.prepare("UPDATE account_transfers SET status='reversed',reversal_journal_id=?,reversed_at=strftime('%s','now'),reversed_by=? WHERE id=?")
      .run(reversalId, req.user.id, row.id);
  })();
  audit(req.user.id, 'reverse', 'transfer', req.params.id, `ابطال انتقال وجه #${req.params.id}`);
  res.json({ ok: true });
});

module.exports = router;
