'use strict';
/**
 * Domain Host IPC protocol — newline-delimited JSON over Named Pipe / Unix socket.
 *
 * Commands:
 *   ping | version | schema.hash | contract.hash | brand.get
 *   runtime.start | runtime.status | runtime.stop
 *   auth.login | auth.logout | auth.me
 *   api.call  { sessionId?, method, path, body?, idempotencyKey? }
 *   sync.status | sync.now | sync.start | sync.stop
 *   backup.local | backup.list
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { backupLocal, listLocalBackups } = require('./local-backup');

const ROOT = path.join(__dirname, '..', '..');

function loadBrand(brandId) {
  const p = path.join(ROOT, 'branding', brandId || 'taranom', 'brand.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readSha(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').trim();
}

function createSessionStore() {
  const sessions = new Map();
  const idempo = new Map();
  return { sessions, idempo };
}

function sessionOrThrow(store, sessionId) {
  const sess = store.sessions.get(sessionId);
  if (!sess) {
    const err = new Error('session not found');
    err.code = 'E_SESSION';
    throw err;
  }
  return sess;
}

async function handleCommand(command, payload = {}, ctx = {}) {
  const runtime = ctx.runtime;
  const store = ctx.store;
  const syncWorker = ctx.syncWorker;

  switch (command) {
    case 'ping':
      return { pong: true, ts: Date.now() };
    case 'version':
      return {
        host: 'domain-host',
        version: '0.3.0',
        phase: '1-sync-backup',
        node: process.versions.node,
        platform: process.platform,
      };
    case 'schema.hash':
      return { sha256: readSha('docs/native/schema.v1.sha256') };
    case 'contract.hash':
      return { sha256: readSha('docs/native/OPERATION-CONTRACT.sha256') };
    case 'brand.get':
      return loadBrand(payload.brandId || ctx.brandId || 'taranom');

    case 'runtime.start':
      return runtime.start();
    case 'runtime.status':
      return { ...runtime.status, sync: syncWorker.status };
    case 'runtime.stop':
      syncWorker.stop();
      store.sessions.clear();
      store.idempo.clear();
      return runtime.stop();

    case 'auth.login': {
      await runtime.start();
      let res = await runtime.fetch('POST', '/api/auth/login', {
        body: { username: payload.username, password: payload.password },
      });
      if (res.status === 200 && res.body.must_change_password && res.body.token) {
        const newPass = payload.newPassword || 'DomainHost1!';
        await runtime.fetch('POST', '/api/auth/change-password', {
          token: res.body.token,
          body: { oldPass: payload.password, newPass },
        });
        res = await runtime.fetch('POST', '/api/auth/login', {
          body: { username: payload.username, password: newPass },
        });
        res.body._passwordRotated = true;
      }
      if (res.status !== 200 || !res.body.token) {
        const err = new Error(res.body.error || res.body.message || 'login failed');
        err.code = 'E_AUTH';
        err.status = res.status;
        throw err;
      }
      const sessionId = crypto.randomBytes(16).toString('hex');
      store.sessions.set(sessionId, {
        token: res.body.token,
        user: {
          id: res.body.user?.id,
          username: res.body.user?.username || payload.username,
          role: res.body.user?.role,
          name: res.body.user?.name,
        },
        createdAt: Date.now(),
      });
      syncWorker.setSessionToken(res.body.token);
      return {
        sessionId,
        user: store.sessions.get(sessionId).user,
        passwordRotated: !!res.body._passwordRotated,
      };
    }

    case 'auth.logout': {
      if (payload.sessionId) store.sessions.delete(payload.sessionId);
      syncWorker.setSessionToken(null);
      return { loggedOut: true };
    }

    case 'auth.me': {
      const sess = sessionOrThrow(store, payload.sessionId);
      const res = await runtime.fetch('GET', '/api/auth/me', { token: sess.token });
      return { status: res.status, body: res.body, user: sess.user };
    }

    case 'api.call': {
      await runtime.start();
      const method = String(payload.method || 'GET').toUpperCase();
      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
      if (mutating && payload.idempotencyKey) {
        const hit = store.idempo.get(payload.idempotencyKey);
        if (hit) return { ...hit, idempotentReplay: true };
      }
      let token = null;
      if (payload.sessionId) {
        token = sessionOrThrow(store, payload.sessionId).token;
      } else if (payload.token) {
        token = payload.token;
      }
      const res = await runtime.fetch(method, payload.path, {
        token,
        body: payload.body,
      });
      const out = { status: res.status, body: res.body };
      if (mutating && payload.idempotencyKey && res.status >= 200 && res.status < 300) {
        store.idempo.set(payload.idempotencyKey, out);
      }
      return out;
    }

    case 'sync.status':
      return syncWorker.status;
    case 'sync.now': {
      if (payload.sessionId) {
        syncWorker.setSessionToken(sessionOrThrow(store, payload.sessionId).token);
      }
      return syncWorker.tick();
    }
    case 'sync.start':
      if (payload.sessionId) {
        syncWorker.setSessionToken(sessionOrThrow(store, payload.sessionId).token);
      }
      return syncWorker.start();
    case 'sync.stop':
      return syncWorker.stop();

    case 'backup.local':
      await runtime.start();
      return backupLocal(runtime, payload);
    case 'backup.list':
      return { backups: listLocalBackups(runtime) };

    default: {
      const err = new Error('unknown command: ' + command);
      err.code = 'E_UNKNOWN_COMMAND';
      throw err;
    }
  }
}

function parseLine(line) {
  const msg = JSON.parse(line);
  if (!msg || typeof msg !== 'object') throw Object.assign(new Error('invalid message'), { code: 'E_BAD_MSG' });
  if (!msg.id) throw Object.assign(new Error('id required'), { code: 'E_BAD_MSG' });
  if (!msg.command) throw Object.assign(new Error('command required'), { code: 'E_BAD_MSG' });
  return msg;
}

function formatOk(id, result) {
  return JSON.stringify({ id, ok: true, result }) + '\n';
}

function formatErr(id, err) {
  return JSON.stringify({
    id: id || null,
    ok: false,
    error: {
      code: err.code || 'E_HOST',
      message: err.message || String(err),
      status: err.status || null,
    },
  }) + '\n';
}

module.exports = {
  handleCommand,
  parseLine,
  formatOk,
  formatErr,
  loadBrand,
  createSessionStore,
  ROOT,
};
