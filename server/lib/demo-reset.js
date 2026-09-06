'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { MARKER_NAME, exactSqliteSidecars, assertSafeDeleteTarget, tryRealpath, isInsideRoot } = require('./demo-paths');
const { getDemoState, resetDemoStateCache } = require('./demo-mode');

const ALLOWED_PROCESS_NAMES = new Set(['erp-taranom-demo-v2']);
const FORBIDDEN_PROCESS_NAMES = new Set(['erp-taranom', 'crm-taranom', 'erp-taranom-demo', 'crm-taranom-demo']);

function writeFileAtomic(filePath, contents, mode = 0o600) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, contents, { mode });
  fs.renameSync(tmp, filePath);
}

function acquireLock(root) {
  const lockPath = path.join(root, '.erp-demo-reset.lock');
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600);
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      const err = new Error('reset already in progress');
      err.code = 'DEMO_RESET_BUSY';
      throw err;
    }
    throw e;
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  } finally {
    fs.closeSync(fd);
  }
  return lockPath;
}

function releaseLock(lockPath) {
  try {
    if (lockPath && fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  } catch { /* ignore */ }
}

function setMaintenance(root, on) {
  const f = path.join(root, '.erp-demo-maintenance');
  if (on) writeFileAtomic(f, new Date().toISOString());
  else if (fs.existsSync(f)) fs.unlinkSync(f);
}

function unlinkExact(root, filePath) {
  const abs = assertSafeDeleteTarget(root, filePath);
  if (fs.existsSync(abs)) fs.unlinkSync(abs);
}

function renameExact(root, from, to) {
  const a = assertSafeDeleteTarget(root, from);
  const b = path.resolve(to);
  if (!isInsideRoot(root, tryRealpath(path.dirname(b)) || path.dirname(b))) {
    const err = new Error('rename target escapes demo root');
    err.code = 'DEMO_PATH_ESCAPE';
    throw err;
  }
  fs.renameSync(a, b);
}

function normalizeResetClientIp(raw) {
  let ip = String(raw || '').trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

function clientAllowed(req, allowRaw) {
  const ip = normalizeResetClientIp(req && (req.ip || (req.socket && req.socket.remoteAddress)) || '');
  const allow = String(allowRaw || process.env.ERP_DEMO_RESET_ALLOW_CIDR || '127.0.0.1,::1')
    .split(',')
    .map((s) => normalizeResetClientIp(s))
    .filter(Boolean);
  return allow.includes(ip);
}

function assertProcessName(name) {
  const n = String(name || '');
  if (FORBIDDEN_PROCESS_NAMES.has(n)) {
    const err = new Error('refusing to touch a production or legacy process name');
    err.code = 'DEMO_PROCESS_FORBIDDEN';
    throw err;
  }
  if (n && !ALLOWED_PROCESS_NAMES.has(n)) {
    const err = new Error('process name is not allowlisted');
    err.code = 'DEMO_PROCESS_FORBIDDEN';
    throw err;
  }
}

async function runSeedToTemp({ root, seedScript, timeoutMs = 180000, env }) {
  const id = crypto.randomBytes(6).toString('hex');
  const tmpDir = path.join(root, 'tmp', `reset-${id}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpDb = path.join(tmpDir, 'demo.db');
  const childEnv = {
    ...process.env,
    ...env,
    DB_PATH: tmpDb,
    UPLOADS_DIR: path.join(tmpDir, 'uploads'),
    COMPANIES_DIR: path.join(tmpDir, 'companies'),
    PRIVATE_UPLOADS_DIR: path.join(tmpDir, 'private-uploads'),
    AUTH_SESSION_DB_PATH: path.join(tmpDir, 'auth-sessions.db'),
    BACKUP_DIR: path.join(tmpDir, 'backups'),
    ERP_TEST_ISOLATION: '1',
  };
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [seedScript, tmpDb], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 200000) stdout = stdout.slice(-100000); });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 200000) stderr = stderr.slice(-100000); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      const err = new Error('seed timed out');
      err.code = 'DEMO_SEED_TIMEOUT';
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ tmpDir, tmpDb, stdout, stderr });
      else {
        const err = new Error(`seed failed with exit ${code}`);
        err.code = 'DEMO_SEED_FAILED';
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
  return { tmpDir, tmpDb };
}

function swapDb({ root, liveDb, tmpDb }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = `${liveDb}.bak-${stamp}`;
  const liveSidecars = exactSqliteSidecars(liveDb);
  const bakSidecars = exactSqliteSidecars(bak);
  const moved = [];
  try {
    for (let i = 0; i < liveSidecars.length; i++) {
      if (fs.existsSync(liveSidecars[i])) {
        renameExact(root, liveSidecars[i], bakSidecars[i]);
        moved.push({ from: bakSidecars[i], to: liveSidecars[i] });
      }
    }
    renameExact(root, tmpDb, liveDb);
    return { bak, stamp, bakFiles: bakSidecars };
  } catch (e) {
    for (const m of moved.reverse()) {
      try {
        if (fs.existsSync(m.from) && !fs.existsSync(m.to)) fs.renameSync(m.from, m.to);
      } catch { /* keep trying */ }
    }
    throw e;
  }
}

function unlinkBak(root, bak) {
  for (const f of exactSqliteSidecars(bak)) {
    if (fs.existsSync(f)) unlinkExact(root, f);
  }
}

function revokeDemoSessionStore(root, sessionDbPath) {
  const target = sessionDbPath || path.join(root, 'auth-sessions.db');
  for (const f of exactSqliteSidecars(target)) {
    if (fs.existsSync(f)) unlinkExact(root, f);
  }
}

function assertDemoRootReady(root, instanceId) {
  const marker = path.join(root, MARKER_NAME);
  if (!fs.existsSync(marker)) {
    const err = new Error('demo marker missing');
    err.code = 'DEMO_MARKER_MISSING';
    throw err;
  }
  const body = fs.readFileSync(marker, 'utf8').trim();
  if (body !== instanceId) {
    const err = new Error('demo marker mismatch');
    err.code = 'DEMO_MARKER_INVALID';
    throw err;
  }
}

async function resetDemoInstance(opts = {}) {
  resetDemoStateCache();
  const state = getDemoState({ reload: true });
  if (!state.enabled) {
    const err = new Error('reset requires Demo Mode');
    err.code = 'DEMO_NOT_ENABLED';
    throw err;
  }
  assertDemoRootReady(state.root, state.instanceId);
  if (opts.processName) assertProcessName(opts.processName);
  const lockPath = acquireLock(state.root);
  const liveDb = state.dbPath;
  let swapped = false;
  try {
    setMaintenance(state.root, true);
    const seedScript = opts.seedScript || path.join(__dirname, '..', 'scripts', 'seed-demo.js');
    const seeded = await runSeedToTemp({
      root: state.root,
      seedScript,
      timeoutMs: opts.timeoutMs || 180000,
      env: opts.env || {},
    });
    if (typeof opts.validate === 'function') {
      await opts.validate(seeded.tmpDb);
    }
    if (opts.beforeSwap) await opts.beforeSwap();
    const swappedFiles = swapDb({ root: state.root, liveDb, tmpDb: seeded.tmpDb });
    swapped = true;
    revokeDemoSessionStore(state.root, state.sessionDbPath);
    if (opts.afterSwap) await opts.afterSwap();
    if (opts.keepBackup !== true && swappedFiles && swappedFiles.bakFiles) {
      for (const f of swappedFiles.bakFiles) {
        if (fs.existsSync(f)) unlinkExact(state.root, f);
      }
    }
    setMaintenance(state.root, false);
    return { ok: true, dbPath: liveDb };
  } catch (e) {
    if (!swapped) setMaintenance(state.root, false);
    throw e;
  } finally {
    releaseLock(lockPath);
  }
}

module.exports = {
  ALLOWED_PROCESS_NAMES,
  FORBIDDEN_PROCESS_NAMES,
  acquireLock,
  assertProcessName,
  clientAllowed,
  normalizeResetClientIp,
  releaseLock,
  resetDemoInstance,
  revokeDemoSessionStore,
  setMaintenance,
  swapDb,
  unlinkExact,
  writeFileAtomic,
};
