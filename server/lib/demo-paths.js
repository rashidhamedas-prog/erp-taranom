'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER_NAME = '.erp-demo-root';
const PROTECTED_BASENAMES = new Set(['crm.db', 'auth-sessions.db']);

function isTruthyEnv(name) {
  const v = String(process.env[name] || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function isUncOrNetwork(p) {
  const n = String(p || '').replace(/\//g, '\\');
  if (n.startsWith('\\\\')) return true;
  if (/^[a-zA-Z]:\\/.test(n) === false && n.startsWith('//')) return true;
  return false;
}

function tryRealpath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

function assertAbsolute(label, p) {
  if (!p || typeof p !== 'string' || !String(p).trim()) {
    const err = new Error(`${label} must be a non-empty path`);
    err.code = 'DEMO_PATH_EMPTY';
    throw err;
  }
  const resolved = path.resolve(String(p).trim());
  if (!path.isAbsolute(resolved)) {
    const err = new Error(`${label} must be an absolute path`);
    err.code = 'DEMO_PATH_NOT_ABSOLUTE';
    throw err;
  }
  if (resolved.includes('\0')) {
    const err = new Error(`${label} contains a NUL byte`);
    err.code = 'DEMO_PATH_TRAVERSAL';
    throw err;
  }
  if (isUncOrNetwork(resolved) && !isTruthyEnv('ERP_DEMO_ALLOW_NETWORK')) {
    const err = new Error(`${label} network/UNC path is not allowed`);
    err.code = 'DEMO_PATH_NETWORK';
    throw err;
  }
  return resolved;
}

function isInsideRoot(rootReal, candidateReal) {
  const a = rootReal.replace(/[\\/]+$/, '');
  const b = candidateReal.replace(/[\\/]+$/, '');
  if (process.platform === 'win32') {
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    return bl === al || bl.startsWith(al + path.sep.toLowerCase()) || bl.startsWith(al + '\\') || bl.startsWith(al + '/');
  }
  return b === a || b.startsWith(a + path.sep);
}

function forbiddenRoots() {
  const list = [
    path.parse(process.cwd()).root,
    os.homedir() && path.resolve(os.homedir()),
  ].filter(Boolean);
  try {
    list.push(path.resolve(__dirname, '..', '..'));
  } catch { /* ignore */ }
  return list.map((p) => {
    const real = tryRealpath(p);
    return real || path.resolve(p);
  });
}

function assertNotForbiddenRoot(rootReal) {
  const home = os.homedir() ? (tryRealpath(os.homedir()) || path.resolve(os.homedir())) : null;
  const repo = tryRealpath(path.resolve(__dirname, '..', '..')) || path.resolve(__dirname, '..', '..');
  const winRoot = path.parse(rootReal).root;
  const norm = (p) => (process.platform === 'win32' ? String(p).replace(/[\\/]+$/, '').toLowerCase() : String(p).replace(/[\\/]+$/, ''));
  const r = norm(rootReal);
  if (winRoot && r === norm(winRoot)) {
    const err = new Error('ERP_DEMO_ROOT cannot be a filesystem root');
    err.code = 'DEMO_ROOT_FORBIDDEN';
    throw err;
  }
  if (home && r === norm(home)) {
    const err = new Error('ERP_DEMO_ROOT cannot be the user home directory');
    err.code = 'DEMO_ROOT_FORBIDDEN';
    throw err;
  }
  if (r === norm(repo)) {
    const err = new Error('ERP_DEMO_ROOT cannot be the repository root');
    err.code = 'DEMO_ROOT_FORBIDDEN';
    throw err;
  }
}

function productionDefaults() {
  const serverDir = path.resolve(__dirname, '..');
  return {
    db: path.resolve(serverDir, 'crm.db'),
    uploads: path.resolve(serverDir, 'public', 'uploads'),
    privateUploads: path.resolve(serverDir, 'private-uploads'),
    backups: path.resolve(serverDir, 'backups'),
  };
}

function samePath(a, b) {
  const na = process.platform === 'win32' ? String(a).toLowerCase() : String(a);
  const nb = process.platform === 'win32' ? String(b).toLowerCase() : String(b);
  return na === nb;
}

function readMarker(rootReal) {
  const markerPath = path.join(rootReal, MARKER_NAME);
  if (!fs.existsSync(markerPath)) {
    const err = new Error(`missing ${MARKER_NAME} in demo root`);
    err.code = 'DEMO_MARKER_MISSING';
    throw err;
  }
  const stat = fs.lstatSync(markerPath);
  if (stat.isSymbolicLink()) {
    const err = new Error('demo marker must not be a symlink/junction');
    err.code = 'DEMO_MARKER_INVALID';
    throw err;
  }
  if (!stat.isFile()) {
    const err = new Error('demo marker must be a regular file');
    err.code = 'DEMO_MARKER_INVALID';
    throw err;
  }
  const body = fs.readFileSync(markerPath, 'utf8').trim();
  if (!body || body.length > 200) {
    const err = new Error('demo marker contents are invalid');
    err.code = 'DEMO_MARKER_INVALID';
    throw err;
  }
  return { markerPath, instanceId: body };
}

function ensureInside(rootReal, label, rawPath, { mustExist = false } = {}) {
  const abs = assertAbsolute(label, rawPath);
  const parent = path.dirname(abs);
  if (mustExist && !fs.existsSync(abs) && !fs.existsSync(parent)) {
    const err = new Error(`${label} does not exist`);
    err.code = 'DEMO_PATH_MISSING';
    throw err;
  }
  const existing = fs.existsSync(abs) ? abs : (fs.existsSync(parent) ? parent : null);
  const real = existing ? tryRealpath(existing) : abs;
  if (!real) {
    const err = new Error(`${label} could not be resolved`);
    err.code = 'DEMO_PATH_UNRESOLVED';
    throw err;
  }
  const compare = fs.existsSync(abs) ? real : path.join(tryRealpath(parent) || parent, path.basename(abs));
  if (!isInsideRoot(rootReal, compare)) {
    const err = new Error(`${label} escapes ERP_DEMO_ROOT`);
    err.code = 'DEMO_PATH_ESCAPE';
    throw err;
  }
  return path.resolve(abs);
}

function exactSqliteSidecars(dbPath) {
  return [
    dbPath,
    `${dbPath}-wal`,
    `${dbPath}-shm`,
    `${dbPath}-journal`,
  ];
}

function assertSafeDeleteTarget(rootReal, targetPath) {
  const abs = assertAbsolute('delete target', targetPath);
  const real = fs.existsSync(abs) ? tryRealpath(abs) : abs;
  if (!real) {
    const err = new Error('delete target could not be resolved');
    err.code = 'DEMO_PATH_UNRESOLVED';
    throw err;
  }
  if (!isInsideRoot(rootReal, real)) {
    const err = new Error('delete target escapes ERP_DEMO_ROOT');
    err.code = 'DEMO_PATH_ESCAPE';
    throw err;
  }
  const base = path.basename(abs);
  if (base === '.' || base === '..' || base === '') {
    const err = new Error('refusing to delete a directory root');
    err.code = 'DEMO_DELETE_REFUSED';
    throw err;
  }
  return abs;
}

module.exports = {
  MARKER_NAME,
  PROTECTED_BASENAMES,
  assertAbsolute,
  assertNotForbiddenRoot,
  assertSafeDeleteTarget,
  ensureInside,
  exactSqliteSidecars,
  forbiddenRoots,
  isInsideRoot,
  isUncOrNetwork,
  productionDefaults,
  readMarker,
  samePath,
  tryRealpath,
};
