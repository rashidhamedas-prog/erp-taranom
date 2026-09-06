'use strict';
/**
 * Shared helpers for ACC-CRM / HTTP harnesses:
 * - pick a free loopback port (or honor ACC_CRM_TEST_PORT / env override)
 * - definitive child-process cleanup (Windows process tree + Unix SIGKILL)
 * Avoids EADDRINUSE from stale servers left by aborted runs.
 */
const net = require('net');
const { execFileSync } = require('child_process');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Resolve preferred port from env, else 0 (= OS ephemeral). */
function preferredPort(envName, fallback) {
  const raw = process.env[envName];
  if (raw != null && String(raw).trim() !== '') {
    const n = parseInt(String(raw), 10);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  if (fallback != null) return fallback;
  return 0;
}

/**
 * Bind 127.0.0.1 briefly to claim a free port.
 * If preferred is busy and allowFallback=true, try ephemeral.
 */
function pickFreePort(preferred = 0, { allowFallback = true } = {}) {
  return new Promise((resolve, reject) => {
    const tryListen = (port) => {
      const srv = net.createServer();
      srv.unref();
      srv.once('error', (err) => {
        if (err && err.code === 'EADDRINUSE' && allowFallback && port !== 0) {
          tryListen(0);
          return;
        }
        reject(err);
      });
      srv.listen(port, '127.0.0.1', () => {
        const addr = srv.address();
        const chosen = typeof addr === 'object' && addr ? addr.port : port;
        srv.close((closeErr) => {
          if (closeErr) reject(closeErr);
          else resolve(chosen);
        });
      });
    };
    tryListen(preferred || 0);
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

async function assertPortsFree(ports) {
  for (const p of ports) {
    const free = await isPortFree(p);
    if (!free) {
      const err = new Error(
        `پورت ${p} اشغال است (اجرای قبلی؟) — ACC_CRM_TEST_PORT / SYNC_TEST_PORT_BASE را عوض کنید یا process را بکشید`
      );
      err.code = 'EADDRINUSE';
      throw err;
    }
  }
}

/** Kill a spawned Node server and its Windows process tree if needed. */
function killProcessTree(child, { graceMs = 1500 } = {}) {
  if (!child || child.killed || child.exitCode != null) {
    return Promise.resolve();
  }
  const pid = child.pid;
  try {
    if (process.platform === 'win32' && pid) {
      try {
        execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        try { child.kill(); } catch { /* */ }
      }
    } else {
      try { child.kill('SIGTERM'); } catch { /* */ }
    }
  } catch { /* */ }

  return new Promise((resolve) => {
    const done = () => resolve();
    if (child.exitCode != null) return done();
    child.once('exit', done);
    setTimeout(() => {
      if (child.exitCode == null) {
        try { child.kill('SIGKILL'); } catch { /* */ }
      }
      done();
    }, graceMs).unref?.();
  });
}

function installCleanupHooks(getChildren) {
  const run = () => {
    const list = typeof getChildren === 'function' ? getChildren() : [];
    for (const c of list || []) {
      try { killProcessTree(c); } catch { /* */ }
    }
  };
  process.on('exit', run);
  process.on('SIGINT', () => { run(); process.exit(130); });
  process.on('SIGTERM', () => { run(); process.exit(143); });
  process.on('uncaughtException', (e) => {
    console.error('uncaughtException:', e);
    run();
    process.exit(1);
  });
}

module.exports = {
  sleep,
  preferredPort,
  pickFreePort,
  isPortFree,
  assertPortsFree,
  killProcessTree,
  installCleanupHooks,
};
