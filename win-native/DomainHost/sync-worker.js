'use strict';
/**
 * Background SyncWorker for Domain Host.
 * Optional: only meaningful when SYNC_ROLE=device and paired.
 * Never blocks local api.call; network failure is soft.
 */
class SyncWorker {
  constructor({ runtime, intervalMs } = {}) {
    this.runtime = runtime;
    this.intervalMs = Math.max(5000, intervalMs || Number(process.env.ERP_HOST_SYNC_INTERVAL_MS) || 30000);
    this.timer = null;
    this.enabled = false;
    this.last = null;
    this.lastError = null;
    this.runs = 0;
    this.sessionToken = null;
  }

  setSessionToken(token) {
    this.sessionToken = token || null;
  }

  get status() {
    return {
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      runs: this.runs,
      last: this.last,
      lastError: this.lastError,
      hasToken: !!this.sessionToken,
      syncRole: this.runtime?.syncRole || null,
    };
  }

  start() {
    if (this.enabled) return this.status;
    this.enabled = true;
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    this.tick().catch(() => {});
    return this.status;
  }

  stop() {
    this.enabled = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this.status;
  }

  async tick() {
    if (!this.runtime?.status?.running) {
      this.lastError = { code: 'E_RUNTIME_DOWN', message: 'runtime not running' };
      return this.lastError;
    }
    if (this.runtime.syncRole !== 'device') {
      this.last = {
        at: Date.now(),
        skipped: true,
        reason: 'SYNC_ROLE is not device — SyncWorker idle (local SoR only)',
      };
      this.lastError = null;
      return this.last;
    }
    if (!this.sessionToken) {
      this.lastError = { code: 'E_NO_SESSION', message: 'no session token for sync' };
      return this.lastError;
    }
    try {
      const st = await this.runtime.fetch('GET', '/api/sync/status', { token: this.sessionToken });
      if (st.status !== 200) {
        this.lastError = { code: 'E_SYNC_STATUS', status: st.status, body: st.body };
        return this.lastError;
      }
      if (!st.body?.paired) {
        this.last = { at: Date.now(), skipped: true, reason: 'not paired', status: st.body };
        this.lastError = null;
        return this.last;
      }
      const now = await this.runtime.fetch('POST', '/api/sync/now', { token: this.sessionToken, body: {} });
      this.runs += 1;
      this.last = { at: Date.now(), status: now.status, body: now.body };
      this.lastError = now.status >= 400 ? { code: 'E_SYNC_NOW', ...this.last } : null;
      return this.last;
    } catch (e) {
      this.lastError = { code: e.code || 'E_SYNC', message: e.message };
      return this.lastError;
    }
  }
}

module.exports = { SyncWorker };
