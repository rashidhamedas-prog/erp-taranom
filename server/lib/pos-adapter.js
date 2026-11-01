'use strict';
/**
 * P6 — card-reader adapter.
 *
 *   requestPayment(terminal, amountRial, opts?) → { status, trace, last4, mode, stub?, fallback? }
 *
 * No real bank connection in this phase.
 *  - manual (default): the operator keys the card on the standalone reader; the app only records
 *    the optional slip references (trace / last4) handed in via opts. Always status 'manual'.
 *  - integrated: a STUB behind the flag POS_INTEGRATED_STUB=1 (env) or setting `pos_integrated_enabled='1'`.
 *    It approves instantly with a synthetic trace so UI/contract can be exercised end to end.
 *    With the flag off an integrated-only terminal falls back to manual (`fallback:true`) — a card
 *    sale is never blocked because a reader integration is not wired.
 *  - both: manual unless the flag is on and opts.prefer==='integrated'.
 *
 * trace / last4 are OPTIONAL in every mode (the sale never fails for missing slip data).
 */

function integratedEnabled(db) {
  if (String(process.env.POS_INTEGRATED_STUB || '') === '1') return true;
  if (!db) return false;
  try {
    const r = db.prepare("SELECT value FROM settings WHERE key='pos_integrated_enabled'").get();
    return !!(r && String(r.value) === '1');
  } catch (_) {
    return false;
  }
}

function asciiDigits(v) {
  return String(v == null ? '' : v)
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

function clean4(v) {
  const s = asciiDigits(v).replace(/\D/g, '');
  return s ? s.slice(-4) : null;
}

function cleanTrace(v) {
  const s = String(v == null ? '' : v).trim();
  return s || null;
}

function manualResult(terminal, opts, extra) {
  return Object.assign({
    status: 'manual',
    trace: cleanTrace(opts && opts.trace),
    last4: clean4(opts && opts.last4),
    mode: (terminal && terminal.mode) || 'manual',
  }, extra || {});
}

function requestPayment(terminal, amountRial, opts) {
  const o = opts || {};
  const mode = String((terminal && terminal.mode) || 'manual').toLowerCase();
  const amount = Math.round(Number(amountRial) || 0);
  if (!(amount > 0)) {
    const e = new Error('مبلغ کارتخوان باید بزرگ‌تر از صفر باشد');
    e.status = 400;
    e.code = 'E_POS_AMOUNT';
    throw e;
  }
  if (mode === 'manual') return manualResult(terminal, o);

  const wantsIntegrated = mode === 'integrated' || (mode === 'both' && o.prefer === 'integrated');
  if (!wantsIntegrated) return manualResult(terminal, o);

  if (!integratedEnabled(o.db)) {
    return manualResult(terminal, o, { fallback: true });
  }
  // STUB — deterministic fake approval; replace with a real PSP driver in a later phase.
  return {
    status: 'approved',
    trace: cleanTrace(o.trace) || `STUB-${terminal && terminal.id ? terminal.id : 0}-${amount}`,
    last4: clean4(o.last4),
    mode,
    stub: true,
  };
}

module.exports = { requestPayment, integratedEnabled };
