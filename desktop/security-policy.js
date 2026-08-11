'use strict';

const crypto = require('crypto');

const ALLOWED_EXTERNAL_HOSTS = Object.freeze([
  'poshaktaranom.com',
  'erp.poshaktaranom.com'
]);

const MAX_UPDATE_BYTES = 1024 * 1024 * 1024;

function parseUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function hasNoCredentials(url) {
  return url.username === '' && url.password === '';
}

function isLoopbackUrl(value, port) {
  const url = parseUrl(value);
  if (!url || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !hasNoCredentials(url)) {
    return false;
  }
  if (port === undefined || port === null || port === '') return url.port !== '';
  return url.port === String(port);
}

function isAllowedChildWindowUrl(value, port) {
  return value === 'about:blank' || isLoopbackUrl(value, port);
}

function isAllowedExternalHost(hostname) {
  return ALLOWED_EXTERNAL_HOSTS.includes(hostname)
    || hostname.endsWith('.poshaktaranom.com');
}

function isAllowedExternalUrl(value) {
  const url = parseUrl(value);
  return !!(
    url
    && url.protocol === 'https:'
    && hasNoCredentials(url)
    && (url.port === '' || url.port === '443')
    && isAllowedExternalHost(url.hostname)
  );
}

function normalizeSha256(value) {
  const digest = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-f0-9]{64}$/.test(digest) ? digest : null;
}

function normalizeUpdateSize(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_UPDATE_BYTES ? value : null;
}

function normalizePublisherNames(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item.length > 0 && item.length <= 512))];
}

function signedUpdatesRequired(value = process.env.REQUIRE_SIGNED_UPDATES) {
  return String(value || '').trim() === '1';
}

function resolveSignedUpdatesFlag(value, { isPackaged, platform }) {
  const configured = value === undefined || value === null ? '' : String(value).trim();
  if (configured === '0' || configured === '1') return configured;
  if (configured !== '') {
    throw new Error('REQUIRE_SIGNED_UPDATES must be exactly 0 or 1');
  }
  return platform === 'win32' && !!isPackaged ? '1' : '0';
}

function validateManualUpdateMetadata(input, expected) {
  const expectedUrl = expected && expected.url;
  const expectedSha256 = normalizeSha256(expected && expected.sha256);
  const expectedSize = normalizeUpdateSize(expected && expected.size);
  const inputSha256 = normalizeSha256(input && input.sha256);
  const inputSize = normalizeUpdateSize(input && input.size);

  if (!isAllowedExternalUrl(expectedUrl) || !expectedSha256 || !expectedSize) {
    return { ok: false, code: 'E_UPDATE_METADATA_MISSING' };
  }
  if (!input || input.url !== expectedUrl || inputSha256 !== expectedSha256 || inputSize !== expectedSize) {
    return { ok: false, code: 'E_UPDATE_METADATA_MISMATCH' };
  }
  return {
    ok: true,
    value: { url: expectedUrl, sha256: expectedSha256, size: expectedSize }
  };
}

function createUpdateIntegrityVerifier(expectedSha256, expectedSize, cryptoModule = crypto) {
  const sha256 = normalizeSha256(expectedSha256);
  const size = normalizeUpdateSize(expectedSize);
  if (!sha256 || !size) throw new Error('Invalid update integrity metadata');

  const hash = cryptoModule.createHash('sha256');
  let bytes = 0;
  let finalized = false;
  return {
    update(chunk) {
      if (finalized) throw new Error('Update integrity verifier is already finalized');
      if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
      bytes += chunk.length;
      if (bytes > size) throw new Error('Update exceeds its declared size');
      hash.update(chunk);
    },
    verify() {
      if (finalized) throw new Error('Update integrity verifier is already finalized');
      finalized = true;
      if (bytes !== size) throw new Error('Update size does not match the manifest');
      const actual = Buffer.from(hash.digest('hex'), 'hex');
      const expected = Buffer.from(sha256, 'hex');
      if (actual.length !== expected.length || !cryptoModule.timingSafeEqual(actual, expected)) {
        throw new Error('Update SHA-256 verification failed');
      }
      return true;
    },
    get bytes() { return bytes; }
  };
}

function evaluateUpdateInstallPolicy({ state, updaterAvailable, requireSigned }) {
  if (!state || (state.status !== 'ready' && state.status !== 'available-fallback')) {
    return { ok: false, code: 'E_UPDATE_NOT_READY' };
  }
  if (state.status === 'ready') {
    if (!updaterAvailable || state.installerSource !== 'electron-updater') {
      return { ok: false, code: 'E_UPDATE_SOURCE' };
    }
    if (requireSigned && state.signatureVerified !== true) {
      return { ok: false, code: 'E_UPDATE_SIGNATURE_REQUIRED' };
    }
    return { ok: true, mode: 'electron-updater' };
  }
  if (state.installerSource !== 'verified-manifest') {
    return { ok: false, code: 'E_UPDATE_SOURCE' };
  }
  return { ok: true, mode: 'verified-manifest', verifySignature: !!requireSigned };
}

function secureChildWindowOptions() {
  return {
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false
    }
  };
}

function hardenWebviewPreferences(webPreferences) {
  if (!webPreferences || typeof webPreferences !== 'object') return;
  delete webPreferences.preload;
  delete webPreferences.preloadURL;
  Object.assign(webPreferences, secureChildWindowOptions().webPreferences);
}

module.exports = {
  ALLOWED_EXTERNAL_HOSTS,
  MAX_UPDATE_BYTES,
  isLoopbackUrl,
  isAllowedChildWindowUrl,
  isAllowedExternalUrl,
  normalizeSha256,
  normalizeUpdateSize,
  normalizePublisherNames,
  signedUpdatesRequired,
  resolveSignedUpdatesFlag,
  validateManualUpdateMetadata,
  createUpdateIntegrityVerifier,
  evaluateUpdateInstallPolicy,
  secureChildWindowOptions,
  hardenWebviewPreferences
};
