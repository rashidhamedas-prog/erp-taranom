/**
 * Bank transfer fee (کارمزد انتقال) for outbound cash movements.
 *
 * Invariant:
 *   When pay_type is bank|bank_transfer and fee_rial > 0:
 *     Dr destination (principal amount)
 *     Dr 6115 coa_bank_fee (fee)
 *     Cr bank (amount + fee)
 *   Party / supplier / rep ledgers post `amount` only — fee is company expense.
 *   Cash / cheque / pos: fee forced to 0 (ignored).
 *   R13 reverse mirrors the same three lines.
 */
'use strict';

const { acct } = require('./coa-map');
const { rialToLedger } = require('./money');

const BANK_PAY_TYPES = new Set(['bank', 'bank_transfer']);

function parseFeeRial(raw, payType) {
  const fee = Math.max(0, Math.round(Number(raw) || 0));
  if (!fee) return 0;
  if (!BANK_PAY_TYPES.has(String(payType || '').toLowerCase())) return 0;
  return fee;
}

function bankFeeAccount(db) {
  return acct(db, 'coa_bank_fee');
}

function outboundPaymentLines(db, opts) {
  const amount = Math.round(Number(opts.amount) || 0);
  const fee = parseFeeRial(opts.feeRial, opts.payType);
  const dest = opts.dest;
  const cash = opts.cash;
  const desc = opts.destDescription || '';
  const lines = [
    { code: dest.code, name: dest.name, debit: rialToLedger(amount), credit: 0, description: desc },
  ];
  if (fee > 0) {
    const feeAcct = bankFeeAccount(db);
    lines.push({
      code: feeAcct.code,
      name: feeAcct.name,
      debit: rialToLedger(fee),
      credit: 0,
      description: 'کارمزد انتقال بانکی',
    });
  }
  lines.push({
    code: cash.code,
    name: cash.name,
    debit: 0,
    credit: rialToLedger(amount + fee),
  });
  return { lines, feeRial: fee, bankOutRial: amount + fee };
}

function outboundPaymentReversalLines(db, opts) {
  const amount = Math.round(Number(opts.amount) || 0);
  const fee = Math.max(0, Math.round(Number(opts.feeRial) || 0));
  const dest = opts.dest;
  const cash = opts.cash;
  const lines = [
    { code: cash.code, name: cash.name, debit: rialToLedger(amount + fee), credit: 0 },
  ];
  if (fee > 0) {
    const feeAcct = bankFeeAccount(db);
    lines.push({
      code: feeAcct.code,
      name: feeAcct.name,
      debit: 0,
      credit: rialToLedger(fee),
      description: 'ابطال کارمزد انتقال بانکی',
    });
  }
  lines.push({ code: dest.code, name: dest.name, debit: 0, credit: rialToLedger(amount) });
  return { lines, feeRial: fee, bankInRial: amount + fee };
}

function transferLines(db, opts) {
  const amount = Math.round(Number(opts.amount) || 0);
  const fromIsBank = String(opts.fromType || '') === 'bank';
  const fee = fromIsBank ? Math.max(0, Math.round(Number(opts.feeRial) || 0)) : 0;
  const src = opts.src;
  const dst = opts.dst;
  const lines = [
    { code: dst.code, name: dst.name, debit: rialToLedger(amount), credit: 0 },
  ];
  if (fee > 0) {
    const feeAcct = bankFeeAccount(db);
    lines.push({
      code: feeAcct.code,
      name: feeAcct.name,
      debit: rialToLedger(fee),
      credit: 0,
      description: 'کارمزد انتقال بانکی',
    });
  }
  lines.push({
    code: src.code,
    name: src.name,
    debit: 0,
    credit: rialToLedger(amount + fee),
  });
  return { lines, feeRial: fee };
}

function transferReversalLines(db, opts) {
  const amount = Math.round(Number(opts.amount) || 0);
  const fee = Math.max(0, Math.round(Number(opts.feeRial) || 0));
  const src = opts.src;
  const dst = opts.dst;
  const lines = [
    { code: src.code, name: src.name, debit: rialToLedger(amount + fee), credit: 0 },
  ];
  if (fee > 0) {
    const feeAcct = bankFeeAccount(db);
    lines.push({
      code: feeAcct.code,
      name: feeAcct.name,
      debit: 0,
      credit: rialToLedger(fee),
      description: 'ابطال کارمزد انتقال بانکی',
    });
  }
  lines.push({ code: dst.code, name: dst.name, debit: 0, credit: rialToLedger(amount) });
  return { lines, feeRial: fee };
}

module.exports = {
  BANK_PAY_TYPES,
  parseFeeRial,
  bankFeeAccount,
  outboundPaymentLines,
  outboundPaymentReversalLines,
  transferLines,
  transferReversalLines,
};
