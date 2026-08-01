'use strict';

// The application has one process-global SQLite handle. A company switch is
// therefore safe only when no other API request can still resume against the
// handle after it has been replaced.
let activeRequests = 0;
let switching = false;

function requestGuard(req, res, next) {
  if (switching) {
    return res.status(503).json({
      error: 'تغییر شرکت در حال انجام است؛ درخواست را دوباره ارسال کنید',
      code: 'COMPANY_SWITCH_IN_PROGRESS',
    });
  }
  activeRequests += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeRequests = Math.max(0, activeRequests - 1);
  };
  res.once('finish', release);
  res.once('close', release);
  return next();
}

function beginCompanySwitch() {
  // The activation request itself is counted. Any value above one means an
  // earlier request is still in flight, so fail closed without changing the
  // registry or live database handle.
  if (switching || activeRequests > 1) {
    const error = new Error('درخواست فعال دیگری در حال اجراست؛ تغییر شرکت را چند لحظه دیگر تکرار کنید');
    error.code = 'COMPANY_SWITCH_BUSY';
    error.status = 409;
    throw error;
  }
  switching = true;
  let ended = false;
  return function endCompanySwitch() {
    if (ended) return;
    ended = true;
    switching = false;
  };
}

function state() {
  return { activeRequests, switching };
}

module.exports = { requestGuard, beginCompanySwitch, state };
