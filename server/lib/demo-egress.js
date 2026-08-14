'use strict';

const { isDemoMode } = require('./demo-mode');

let _outboundCount = 0;

function noteOutboundAttempt() {
  _outboundCount += 1;
}

function getOutboundAttemptCount() {
  return _outboundCount;
}

function resetOutboundAttemptCount() {
  _outboundCount = 0;
}

function demoNoopResult(channel) {
  return {
    ok: false,
    simulated: true,
    demo: true,
    channel,
    code: 'demo_simulation',
    reason: 'در نسخه دمو ارسال واقعی انجام نمی‌شود',
  };
}

function isDemoEnvFlag() {
  return /^(true|1|yes)$/i.test(String(process.env.ERP_DEMO_MODE || ''));
}

function guardDemoEgress(channel) {
  if (!isDemoMode()) return null;
  noteOutboundAttempt();
  return demoNoopResult(channel);
}

/** Fail-closed in demo even if getDemoState throws; production continues if guard cannot load. */
function guardDemoEgressOrBlock(channel) {
  try {
    return guardDemoEgress(channel);
  } catch {
    if (isDemoEnvFlag()) {
      noteOutboundAttempt();
      return demoNoopResult(channel);
    }
    return null;
  }
}

function assertNoDemoNetwork() {
  if (isDemoMode()) {
    const err = new Error('Demo Mode forbids outbound network requests');
    err.code = 'DEMO_EGRESS_BLOCKED';
    throw err;
  }
}

module.exports = {
  assertNoDemoNetwork,
  demoNoopResult,
  getOutboundAttemptCount,
  guardDemoEgress,
  guardDemoEgressOrBlock,
  noteOutboundAttempt,
  resetOutboundAttemptCount,
};
