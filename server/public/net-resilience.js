/* ERP Taranom — login/API transport resilience (UMD).
   Covers PM2 restart, Cloudflare 521/502/503/524, and brief origin downtime. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NetResilience = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TRANSIENT_STATUS = {
    408: 1, 425: 1, 429: 1, 500: 1, 502: 1, 503: 1, 504: 1,
    520: 1, 521: 1, 522: 1, 523: 1, 524: 1
  };

  function isTransientStatus(status) {
    return !!TRANSIENT_STATUS[Number(status)];
  }

  function classifyTransportError(err) {
    const msg = String((err && err.message) || err || '');
    const name = String((err && err.name) || '');
    if (name === 'AbortError' || name === 'TimeoutError' || /timeout|aborted/i.test(msg)) {
      return {
        code: 'TIMEOUT',
        retryable: true,
        message: 'پاسخ سرور طول کشید؛ در حال تلاش دوباره…',
      };
    }
    if (/Failed to fetch|NetworkError|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ERR_CONNECTION|ERR_NETWORK|ERR_FAILED|load failed|network/i.test(msg)) {
      return {
        code: 'NETWORK',
        retryable: true,
        message: 'ارتباط لحظه‌ای قطع شد (راه‌اندازی یا شبکه). چند ثانیه صبر کنید؛ سامانه خودش دوباره تلاش می‌کند.',
      };
    }
    return {
      code: 'NETWORK',
      retryable: true,
      message: 'خطای ارتباط با سرور — اگر چند ثانیه پیش به‌روزرسانی بوده، کمی صبر کنید و دوباره وارد شوید.',
    };
  }

  function classifyHttpFailure(status, body) {
    const code = body && body.code;
    const errText = (body && (body.error || body.message)) || '';
    if (status === 503 && (code === 'STARTING' || code === 'RESTARTING')) {
      return { code: code, retryable: true, message: errText || 'سرور در حال راه‌اندازی است؛ چند ثانیه صبر کنید' };
    }
    if (status === 521 || status === 522) {
      return { code: 'ORIGIN_DOWN', retryable: true, message: 'سرور در حال راه‌اندازی مجدد است؛ چند ثانیه صبر کنید' };
    }
    if (status === 524 || status === 504) {
      return { code: 'GATEWAY_TIMEOUT', retryable: true, message: 'سرور شلوغ است؛ در حال تلاش دوباره…' };
    }
    if (status === 502 || status === 520) {
      return { code: 'BAD_GATEWAY', retryable: true, message: 'درگاه میانی پاسخ نگرفت؛ در حال تلاش دوباره…' };
    }
    if (Number(status) === 429) {
      return { code: 'RATE_LIMIT', retryable: false, message: errText || 'تعداد تلاش‌ها زیاد است. کمی بعد دوباره وارد شوید.' };
    }
    if (isTransientStatus(status)) {
      return { code: 'TRANSIENT', retryable: true, message: errText || ('سرور موقتاً در دسترس نیست (' + status + ')') };
    }
    return { code: 'HTTP', retryable: false, message: errText || ('خطای سرور (' + status + ')') };
  }

  function retryDelayMs(attempt) {
    return [400, 900, 1800, 3200][attempt] || 4000;
  }

  function shouldRetryLogin(status, hadTransportError) {
    if (hadTransportError) return true;
    if (status == null) return true;
    if (Number(status) === 429) return false;
    return isTransientStatus(status);
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function abortAfter(ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(function () {
      try { ctrl.abort(); } catch (_) {}
    }, ms);
    return {
      signal: ctrl.signal,
      clear: function () { clearTimeout(timer); },
    };
  }

  async function fetchOnce(url, opts, policy) {
    const timeoutMs = (policy && policy.timeoutMs) || 20000;
    const gate = abortAfter(timeoutMs);
    const headers = Object.assign({}, (opts && opts.headers) || {});
    try {
      return await fetch(url, Object.assign({}, opts || {}, {
        cache: 'no-store',
        signal: gate.signal,
        headers: headers,
      }));
    } finally {
      gate.clear();
    }
  }

  async function fetchWithRetry(url, opts, policy) {
    const attempts = (policy && policy.attempts) || 5;
    const mode = (policy && policy.mode) || 'login';
    let lastTransport = null;
    let lastRes = null;
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await fetchOnce(url, opts, policy);
        lastRes = r;
        if (r.ok) return r;
        const retry = mode === 'login'
          ? shouldRetryLogin(r.status, false)
          : (mode === 'get' && isTransientStatus(r.status) && r.status !== 429);
        if (!retry || i === attempts - 1) return r;
      } catch (e) {
        lastTransport = e;
        if (i === attempts - 1) throw e;
      }
      await sleep(retryDelayMs(i));
    }
    if (lastRes) return lastRes;
    throw lastTransport || new Error('Failed to fetch');
  }

  async function waitUntilReady(fetchFn, policy) {
    const attempts = (policy && policy.attempts) || 6;
    const timeoutMs = (policy && policy.timeoutMs) || 4000;
    const doFetch = fetchFn || function (url, opts) { return fetch(url, opts); };
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await fetchOnce('/api/system/ready', { method: 'GET' }, { timeoutMs: timeoutMs });
        if (r && r.ok) return true;
      } catch (_) { /* restart window */ }
      if (typeof doFetch !== 'function') { /* keep signature for tests */ }
      if (i < attempts - 1) await sleep(retryDelayMs(i));
    }
    return false;
  }

  return {
    isTransientStatus,
    classifyTransportError,
    classifyHttpFailure,
    retryDelayMs,
    shouldRetryLogin,
    sleep,
    fetchOnce,
    fetchWithRetry,
    waitUntilReady,
  };
}));
