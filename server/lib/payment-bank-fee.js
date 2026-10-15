/**
 * Bank transfer fee (کارمزد انتقال) for outbound cash movements.
 *
 * Invariant:
 *   When pay_type is bank|bank_transfer and fee_rial > 0:
 *     Dr destination (principal amount)  — cost_center from document when stamped
 *     Dr 6115 coa_bank_fee (fee)         — cost_center = fee_cost_center_id
 *     Cr bank (amount + fee)
 *   Party / supplier / rep ledgers post `amount` only — fee is company expense.
 *   Cash / cheque / pos: fee forced to 0 (ignored).
 *   R13 reverse mirrors the same three lines (including fee CC on 6115).
 */
'use strict';

const { ensureLogicalPostable } = require('./coa-map');
const { rialToLedger } = require('./money');

const BANK_PAY_TYPES = new Set(['bank', 'bank_transfer']);

function parseFeeRial(raw, payType) {
  const fee = Math.max(0, Math.round(Number(raw) || 0));
  if (!fee) return 0;
  if (!BANK_PAY_TYPES.has(String(payType || '').toLowerCase())) return 0;
  return fee;
}

/** Accept fee_cost_center_id or bank_fee_cost_center_id from API/UI bodies. */
function parseFeeCostCenterInput(body) {
  if (!body || typeof body !== 'object') return null;
  const raw = body.fee_cost_center_id != null ? body.fee_cost_center_id : body.bank_fee_cost_center_id;
  if (raw == null || raw === '') return null;
  const id = parseInt(raw, 10);
  return id || null;
}

/**
 * Resolve CC for the 6115 fee line.
 * Default: document/header cost_center_id when fee CC omitted.
 * When require_cc_on_expense=1 and fee>0 → must resolve to an active CC.
 */
function resolveFeeCostCenterId(db, {
  feeRial, payType, feeCostCenterId, documentCostCenterId, fromType,
} = {}) {
  let fee = 0;
  if (fromType != null) {
    fee = String(fromType) === 'bank' ? Math.max(0, Math.round(Number(feeRial) || 0)) : 0;
  } else {
    fee = parseFeeRial(feeRial, payType);
  }
  if (!fee) return null;

  const {
    isActiveCostCenter, isRequireExpenseCostCenter,
  } = require('./cost-center-policy');

  const explicit = parseInt(feeCostCenterId, 10) || null;
  const doc = parseInt(documentCostCenterId, 10) || null;
  if (feeCostCenterId != null && String(feeCostCenterId).trim() !== '' && !explicit) {
    const err = new Error('مرکز هزینه کارمزد بانکی نامعتبر است');
    err.status = 400;
    err.code = 'E_FEE_CC_INVALID';
    throw err;
  }
  if (explicit && !isActiveCostCenter(db, explicit)) {
    const err = new Error('مرکز هزینه کارمزد بانکی یافت نشد یا غیرفعال است');
    err.status = 400;
    err.code = 'E_FEE_CC_NOT_FOUND';
    throw err;
  }
  const cc = explicit || doc || null;
  if (cc && !isActiveCostCenter(db, cc)) {
    const err = new Error('مرکز هزینه کارمزد بانکی یافت نشد یا غیرفعال است');
    err.status = 400;
    err.code = 'E_FEE_CC_NOT_FOUND';
    throw err;
  }
  if (!cc && isRequireExpenseCostCenter(db)) {
    const err = new Error('مرکز هزینه کارمزد بانکی الزامی است');
    err.status = 422;
    err.code = 'E_FEE_CC_REQUIRED';
    throw err;
  }
  return cc;
}

/** Always a postable leaf (heals when 6115 gained معین children). */
function bankFeeAccount(db) {
  const leaf = ensureLogicalPostable(db, 'coa_bank_fee');
  return { code: leaf.code, name: leaf.name };
}

function feeLineFields(db, fee, feeCostCenterId, description) {
  const feeAcct = bankFeeAccount(db);
  const line = {
    code: feeAcct.code,
    name: feeAcct.name,
    debit: rialToLedger(fee),
    credit: 0,
    description: description || 'کارمزد انتقال بانکی',
  };
  const cc = parseInt(feeCostCenterId, 10) || null;
  if (cc) line.cost_center_id = cc;
  return line;
}

function feeReversalLineFields(db, fee, feeCostCenterId) {
  const feeAcct = bankFeeAccount(db);
  const line = {
    code: feeAcct.code,
    name: feeAcct.name,
    debit: 0,
    credit: rialToLedger(fee),
    description: 'ابطال کارمزد انتقال بانکی',
  };
  const cc = parseInt(feeCostCenterId, 10) || null;
  if (cc) line.cost_center_id = cc;
  return line;
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
    lines.push(feeLineFields(db, fee, opts.feeCostCenterId, 'کارمزد انتقال بانکی'));
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
    lines.push(feeReversalLineFields(db, fee, opts.feeCostCenterId));
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
    lines.push(feeLineFields(db, fee, opts.feeCostCenterId, 'کارمزد انتقال بانکی'));
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
    lines.push(feeReversalLineFields(db, fee, opts.feeCostCenterId));
  }
  lines.push({ code: dst.code, name: dst.name, debit: 0, credit: rialToLedger(amount) });
  return { lines, feeRial: fee };
}

module.exports = {
  BANK_PAY_TYPES,
  parseFeeRial,
  parseFeeCostCenterInput,
  resolveFeeCostCenterId,
  bankFeeAccount,
  outboundPaymentLines,
  outboundPaymentReversalLines,
  transferLines,
  transferReversalLines,
};
