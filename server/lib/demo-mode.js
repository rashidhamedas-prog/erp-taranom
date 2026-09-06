'use strict';

const fs = require('fs');
const path = require('path');
const { demoNow, parseExpiresAt, isExpired } = require('./demo-clock');
const paths = require('./demo-paths');

let _state = undefined;

function parseDemoFlag(raw) {
  if (raw == null || String(raw).trim() === '') return false;
  const s = String(raw).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  const err = new Error('ERP_DEMO_MODE must be true or false');
  err.code = 'DEMO_MODE_INVALID';
  throw err;
}

function requireEnv(name, { minLen = 1 } = {}) {
  const v = process.env[name];
  if (v == null || String(v).trim() === '') {
    const err = new Error(`${name} is required when ERP_DEMO_MODE=true`);
    err.code = 'DEMO_CONFIG_INCOMPLETE';
    throw err;
  }
  const s = String(v).trim();
  if (s.length < minLen) {
    const err = new Error(`${name} is too short`);
    err.code = 'DEMO_CONFIG_INCOMPLETE';
    throw err;
  }
  return s;
}

function loadDemoState(env = process.env) {
  const enabled = parseDemoFlag(env.ERP_DEMO_MODE);
  if (!enabled) {
    return Object.freeze({
      enabled: false,
      maintenance: false,
      expired: false,
    });
  }

  const rootAbs = paths.assertAbsolute('ERP_DEMO_ROOT', requireEnv.call({ env }, 'ERP_DEMO_ROOT'));
  const rootReal = paths.tryRealpath(rootAbs);
  if (!rootReal) {
    const err = new Error('ERP_DEMO_ROOT could not be resolved');
    err.code = 'DEMO_PATH_UNRESOLVED';
    throw err;
  }
  paths.assertNotForbiddenRoot(rootReal);

  const instanceId = (env.ERP_DEMO_INSTANCE_ID || '').trim();
  if (!instanceId || instanceId.length < 8 || instanceId.length > 128) {
    const err = new Error('ERP_DEMO_INSTANCE_ID is required (8–128 chars)');
    err.code = 'DEMO_CONFIG_INCOMPLETE';
    throw err;
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(instanceId)) {
    const err = new Error('ERP_DEMO_INSTANCE_ID contains invalid characters');
    err.code = 'DEMO_CONFIG_INCOMPLETE';
    throw err;
  }

  const marker = paths.readMarker(rootReal);
  if (marker.instanceId !== instanceId) {
    const err = new Error('demo marker does not match ERP_DEMO_INSTANCE_ID');
    err.code = 'DEMO_MARKER_INVALID';
    throw err;
  }

  const expiresAt = parseExpiresAt(env.ERP_DEMO_EXPIRES_AT);
  if (String(env.BACKUP_S3_URI || '').trim() || String(env.BACKUP_OFFSITE_DIR || '').trim()) {
    const err = new Error('Demo Mode refuses BACKUP_S3_URI / BACKUP_OFFSITE_DIR');
    err.code = 'DEMO_BACKUP_OFFSITE_FORBIDDEN';
    throw err;
  }
  const jwt = (env.JWT_SECRET || '').trim();
  if (!jwt || jwt.length < 32) {
    const err = new Error('JWT_SECRET must be at least 32 characters in Demo Mode');
    err.code = 'DEMO_CONFIG_INCOMPLETE';
    throw err;
  }
  if (/^(demo-seed-secret|laptop-demo-secret)$/i.test(jwt)) {
    const err = new Error('JWT_SECRET rejects known insecure demo placeholders');
    err.code = 'DEMO_SECRET_INSECURE';
    throw err;
  }

  const defaults = paths.productionDefaults();
  const dbPath = paths.ensureInside(rootReal, 'DB_PATH', env.DB_PATH);
  const uploads = paths.ensureInside(rootReal, 'UPLOADS_DIR', env.UPLOADS_DIR);
  const companies = paths.ensureInside(rootReal, 'COMPANIES_DIR', env.COMPANIES_DIR);
  if (paths.samePath(dbPath, defaults.db)) {
    const err = new Error('DB_PATH must not be the production default');
    err.code = 'DEMO_PATH_PRODUCTION';
    throw err;
  }
  if (paths.samePath(uploads, defaults.uploads)) {
    const err = new Error('UPLOADS_DIR must not be the production uploads directory');
    err.code = 'DEMO_PATH_PRODUCTION';
    throw err;
  }
  if (path.basename(dbPath) === 'crm.db' && paths.samePath(path.dirname(dbPath), path.dirname(defaults.db))) {
    const err = new Error('DB_PATH must not be the production default');
    err.code = 'DEMO_PATH_PRODUCTION';
    throw err;
  }

  const privateUploads = env.PRIVATE_UPLOADS_DIR
    ? paths.ensureInside(rootReal, 'PRIVATE_UPLOADS_DIR', env.PRIVATE_UPLOADS_DIR)
    : path.join(rootReal, 'private-uploads');
  const backups = env.BACKUP_DIR
    ? paths.ensureInside(rootReal, 'BACKUP_DIR', env.BACKUP_DIR)
    : path.join(rootReal, 'backups');
  const sessions = env.AUTH_SESSION_DB_PATH
    ? paths.ensureInside(rootReal, 'AUTH_SESSION_DB_PATH', env.AUTH_SESSION_DB_PATH)
    : path.join(rootReal, 'auth-sessions.db');

  const maintenanceFile = path.join(rootReal, '.erp-demo-maintenance');
  const maintenance = fs.existsSync(maintenanceFile);
  const expired = isExpired(expiresAt, demoNow());

  let salesUrl = null;
  if (env.ERP_DEMO_SALES_URL && String(env.ERP_DEMO_SALES_URL).trim()) {
    salesUrl = String(env.ERP_DEMO_SALES_URL).trim();
    let u;
    try { u = new URL(salesUrl); } catch {
      const err = new Error('ERP_DEMO_SALES_URL is not a valid URL');
      err.code = 'DEMO_SALES_URL_INVALID';
      throw err;
    }
    if (u.protocol !== 'https:') {
      const err = new Error('ERP_DEMO_SALES_URL must be https');
      err.code = 'DEMO_SALES_URL_INVALID';
      throw err;
    }
  }

  return Object.freeze({
    enabled: true,
    root: rootReal,
    instanceId,
    expiresAt: expiresAt.toISOString(),
    expired,
    maintenance,
    dbPath,
    uploadsDir: uploads,
    companiesDir: companies,
    privateUploadsDir: privateUploads,
    backupDir: backups,
    sessionDbPath: sessions,
    salesUrl,
    watermark: 'نسخه نمایشی — داده‌ها واقعی نیستند',
  });
}

function requireEnvFromProcess(name, opts) {
  const prev = process.env;
  try {
    return (function requireEnvInner() {
      const v = process.env[name];
      if (v == null || String(v).trim() === '') {
        const err = new Error(`${name} is required when ERP_DEMO_MODE=true`);
        err.code = 'DEMO_CONFIG_INCOMPLETE';
        throw err;
      }
      const s = String(v).trim();
      if (opts && opts.minLen && s.length < opts.minLen) {
        const err = new Error(`${name} is too short`);
        err.code = 'DEMO_CONFIG_INCOMPLETE';
        throw err;
      }
      return s;
    }());
  } finally {
    void prev;
  }
}

function loadDemoStateFromProcess() {
  const enabled = parseDemoFlag(process.env.ERP_DEMO_MODE);
  if (!enabled) {
    return Object.freeze({ enabled: false, maintenance: false, expired: false });
  }
  const env = process.env;
  const rootAbs = paths.assertAbsolute('ERP_DEMO_ROOT', requireEnvFromProcess('ERP_DEMO_ROOT'));
  const rootReal = paths.tryRealpath(rootAbs);
  if (!rootReal) {
    const err = new Error('ERP_DEMO_ROOT could not be resolved');
    err.code = 'DEMO_PATH_UNRESOLVED';
    throw err;
  }
  paths.assertNotForbiddenRoot(rootReal);
  const instanceId = requireEnvFromProcess('ERP_DEMO_INSTANCE_ID');
  if (instanceId.length < 8 || instanceId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(instanceId)) {
    const err = new Error('ERP_DEMO_INSTANCE_ID is invalid');
    err.code = 'DEMO_CONFIG_INCOMPLETE';
    throw err;
  }
  const marker = paths.readMarker(rootReal);
  if (marker.instanceId !== instanceId) {
    const err = new Error('demo marker does not match ERP_DEMO_INSTANCE_ID');
    err.code = 'DEMO_MARKER_INVALID';
    throw err;
  }
  const expiresAt = parseExpiresAt(requireEnvFromProcess('ERP_DEMO_EXPIRES_AT'));
  if (String(env.BACKUP_S3_URI || '').trim() || String(env.BACKUP_OFFSITE_DIR || '').trim()) {
    const err = new Error('Demo Mode refuses BACKUP_S3_URI / BACKUP_OFFSITE_DIR');
    err.code = 'DEMO_BACKUP_OFFSITE_FORBIDDEN';
    throw err;
  }
  const jwt = requireEnvFromProcess('JWT_SECRET', { minLen: 32 });
  if (/^(demo-seed-secret|laptop-demo-secret)$/i.test(jwt)) {
    const err = new Error('JWT_SECRET rejects known insecure demo placeholders');
    err.code = 'DEMO_SECRET_INSECURE';
    throw err;
  }
  const defaults = paths.productionDefaults();
  if (!env.DB_PATH || !env.UPLOADS_DIR || !env.COMPANIES_DIR) {
    const err = new Error('DB_PATH, UPLOADS_DIR and COMPANIES_DIR are required in Demo Mode');
    err.code = 'DEMO_CONFIG_INCOMPLETE';
    throw err;
  }
  const dbPath = paths.ensureInside(rootReal, 'DB_PATH', env.DB_PATH);
  const uploads = paths.ensureInside(rootReal, 'UPLOADS_DIR', env.UPLOADS_DIR);
  const companies = paths.ensureInside(rootReal, 'COMPANIES_DIR', env.COMPANIES_DIR);
  if (paths.samePath(dbPath, defaults.db) || paths.samePath(uploads, defaults.uploads)) {
    const err = new Error('Demo Mode refuses production DB_PATH or UPLOADS_DIR');
    err.code = 'DEMO_PATH_PRODUCTION';
    throw err;
  }
  const privateUploads = env.PRIVATE_UPLOADS_DIR
    ? paths.ensureInside(rootReal, 'PRIVATE_UPLOADS_DIR', env.PRIVATE_UPLOADS_DIR)
    : path.join(rootReal, 'private-uploads');
  const backups = env.BACKUP_DIR
    ? paths.ensureInside(rootReal, 'BACKUP_DIR', env.BACKUP_DIR)
    : path.join(rootReal, 'backups');
  const sessions = env.AUTH_SESSION_DB_PATH
    ? paths.ensureInside(rootReal, 'AUTH_SESSION_DB_PATH', env.AUTH_SESSION_DB_PATH)
    : path.join(rootReal, 'auth-sessions.db');
  const maintenance = fs.existsSync(path.join(rootReal, '.erp-demo-maintenance'));
  let salesUrl = null;
  if (env.ERP_DEMO_SALES_URL && String(env.ERP_DEMO_SALES_URL).trim()) {
    const raw = String(env.ERP_DEMO_SALES_URL).trim();
    let u;
    try { u = new URL(raw); } catch {
      const err = new Error('ERP_DEMO_SALES_URL is not a valid URL');
      err.code = 'DEMO_SALES_URL_INVALID';
      throw err;
    }
    if (u.protocol !== 'https:') {
      const err = new Error('ERP_DEMO_SALES_URL must be https');
      err.code = 'DEMO_SALES_URL_INVALID';
      throw err;
    }
    salesUrl = raw;
  }
  return Object.freeze({
    enabled: true,
    root: rootReal,
    instanceId,
    expiresAt: expiresAt.toISOString(),
    expired: isExpired(expiresAt, demoNow()),
    maintenance,
    dbPath,
    uploadsDir: uploads,
    companiesDir: companies,
    privateUploadsDir: privateUploads,
    backupDir: backups,
    sessionDbPath: sessions,
    salesUrl,
    watermark: 'نسخه نمایشی — داده‌ها واقعی نیستند',
  });
}

function getDemoState({ reload = false } = {}) {
  if (_state !== undefined && !reload) return _state;
  _state = loadDemoStateFromProcess();
  return _state;
}

function resetDemoStateCache() {
  _state = undefined;
}

function isDemoMode() {
  return !!getDemoState().enabled;
}

function assertDemoBoot() {
  const state = getDemoState({ reload: true });
  if (!state.enabled) return state;
  for (const dir of [state.uploadsDir, state.companiesDir, state.privateUploadsDir, state.backupDir, path.join(state.root, 'tmp'), path.join(state.root, 'logs')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return state;
}

function publicDemoStatus() {
  const s = getDemoState();
  if (!s.enabled) return { demo: false };
  return {
    demo: true,
    instance_id: s.instanceId,
    expires_at: s.expiresAt,
    expired: !!s.expired,
    maintenance: !!s.maintenance,
    watermark: s.watermark,
    sales_url: s.salesUrl,
    message: s.expired
      ? 'نسخه نمایشی منقضی شده است — فقط خواندن امن مجاز است'
      : 'نسخه نمایشی — داده‌ها واقعی نیستند',
  };
}

function refreshMaintenanceFlag() {
  if (!_state || !_state.enabled) return getDemoState();
  const maintenance = fs.existsSync(path.join(_state.root, '.erp-demo-maintenance'));
  const expired = isExpired(_state.expiresAt, demoNow());
  _state = Object.freeze({ ..._state, maintenance, expired });
  return _state;
}

module.exports = {
  assertDemoBoot,
  getDemoState,
  isDemoMode,
  loadDemoStateFromProcess,
  parseDemoFlag,
  publicDemoStatus,
  refreshMaintenanceFlag,
  resetDemoStateCache,
};
