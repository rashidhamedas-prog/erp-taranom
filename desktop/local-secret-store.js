'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SECURE_FILE_NAME = 'jwt-secret.dpapi';
const LEGACY_FILE_NAME = 'jwt-secret';
const ENVELOPE_VERSION = 1;
const MIN_SECRET_LENGTH = 32;

function assertRegularFile(fileSystem, filePath) {
  const stat = fileSystem.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Refusing non-regular secret file: ${path.basename(filePath)}`);
  }
}

function normalizeSecret(value) {
  const secret = typeof value === 'string' ? value.trim() : '';
  if (secret.length < MIN_SECRET_LENGTH || secret.includes('\0')) {
    throw new Error('Local JWT secret is missing or invalid');
  }
  return secret;
}

function safeStorageAvailable(safeStorage) {
  try {
    return !!(
      safeStorage
      && typeof safeStorage.isEncryptionAvailable === 'function'
      && safeStorage.isEncryptionAvailable()
      && typeof safeStorage.encryptString === 'function'
      && typeof safeStorage.decryptString === 'function'
    );
  } catch {
    return false;
  }
}

function serializeEnvelope(encrypted) {
  if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
    throw new Error('safeStorage returned an invalid encrypted value');
  }
  return Buffer.from(JSON.stringify({
    version: ENVELOPE_VERSION,
    provider: 'electron.safeStorage',
    ciphertext: encrypted.toString('base64')
  }) + '\n', 'utf8');
}

function parseEnvelope(raw) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
  } catch {
    throw new Error('Protected local JWT secret is corrupt');
  }
  if (
    !parsed
    || parsed.version !== ENVELOPE_VERSION
    || parsed.provider !== 'electron.safeStorage'
    || typeof parsed.ciphertext !== 'string'
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(parsed.ciphertext)
  ) {
    throw new Error('Protected local JWT secret has an unsupported format');
  }
  const encrypted = Buffer.from(parsed.ciphertext, 'base64');
  if (encrypted.length === 0 || encrypted.toString('base64') !== parsed.ciphertext) {
    throw new Error('Protected local JWT secret has invalid ciphertext');
  }
  return encrypted;
}

function atomicWrite(fileSystem, cryptoModule, destination, data) {
  const suffix = cryptoModule.randomBytes(8).toString('hex');
  const tempPath = `${destination}.tmp-${process.pid}-${suffix}`;
  let descriptor = null;
  try {
    descriptor = fileSystem.openSync(tempPath, 'wx', 0o600);
    fileSystem.writeFileSync(descriptor, data);
    if (typeof fileSystem.fsyncSync === 'function') fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = null;
    fileSystem.renameSync(tempPath, destination);
    try { fileSystem.chmodSync(destination, 0o600); } catch { /* Windows ACLs are handled by DPAPI. */ }
  } catch (error) {
    if (descriptor !== null) {
      try { fileSystem.closeSync(descriptor); } catch { /* best effort */ }
    }
    try { fileSystem.unlinkSync(tempPath); } catch { /* best effort */ }
    throw error;
  }
}

function readProtectedSecret(fileSystem, safeStorage, securePath) {
  assertRegularFile(fileSystem, securePath);
  if (!safeStorageAvailable(safeStorage)) {
    throw new Error('OS protected storage is unavailable; refusing to read the local JWT secret');
  }
  const encrypted = parseEnvelope(fileSystem.readFileSync(securePath));
  let decrypted;
  try {
    decrypted = safeStorage.decryptString(encrypted);
  } catch {
    throw new Error('OS protected storage could not decrypt the local JWT secret');
  }
  return normalizeSecret(decrypted);
}

function removeLegacySecret(fileSystem, legacyPath, failClosed) {
  if (!fileSystem.existsSync(legacyPath)) return;
  assertRegularFile(fileSystem, legacyPath);
  try {
    fileSystem.unlinkSync(legacyPath);
  } catch (error) {
    if (failClosed) {
      throw new Error(`Protected secret is ready, but plaintext cleanup failed: ${error.code || 'unknown'}`);
    }
  }
}

function protectSecret(fileSystem, cryptoModule, safeStorage, securePath, secret) {
  let encrypted;
  try {
    encrypted = safeStorage.encryptString(secret);
  } catch {
    throw new Error('OS protected storage could not encrypt the local JWT secret');
  }
  atomicWrite(fileSystem, cryptoModule, securePath, serializeEnvelope(encrypted));
  const verified = readProtectedSecret(fileSystem, safeStorage, securePath);
  if (verified !== secret) {
    throw new Error('Protected local JWT secret verification failed');
  }
}

/**
 * Loads or creates the embedded server JWT secret.
 *
 * Packaged Windows builds always fail closed unless Electron safeStorage (DPAPI)
 * is usable. Existing plaintext files are migrated by atomically committing and
 * verifying the protected copy before the plaintext file is removed.
 */
function getOrCreateLocalJwtSecret(options) {
  const {
    dataDir,
    safeStorage,
    isPackaged = false,
    platform = process.platform,
    fileSystem = fs,
    cryptoModule = crypto
  } = options || {};

  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    throw new Error('A local application data directory is required');
  }

  fileSystem.mkdirSync(dataDir, { recursive: true });
  const securePath = path.join(dataDir, SECURE_FILE_NAME);
  const legacyPath = path.join(dataDir, LEGACY_FILE_NAME);
  const mustUseProtectedStorage = platform === 'win32' && !!isPackaged;
  const protectionAvailable = safeStorageAvailable(safeStorage);

  if (fileSystem.existsSync(securePath)) {
    const secret = readProtectedSecret(fileSystem, safeStorage, securePath);
    removeLegacySecret(fileSystem, legacyPath, true);
    return secret;
  }

  if (mustUseProtectedStorage && !protectionAvailable) {
    throw new Error('Windows DPAPI is unavailable; packaged application startup is blocked');
  }

  if (fileSystem.existsSync(legacyPath)) {
    assertRegularFile(fileSystem, legacyPath);
    const secret = normalizeSecret(fileSystem.readFileSync(legacyPath, 'utf8'));
    if (!protectionAvailable) return secret;

    protectSecret(fileSystem, cryptoModule, safeStorage, securePath, secret);
    removeLegacySecret(fileSystem, legacyPath, true);
    return secret;
  }

  const secret = cryptoModule.randomBytes(32).toString('hex');
  if (protectionAvailable) {
    protectSecret(fileSystem, cryptoModule, safeStorage, securePath, secret);
    return secret;
  }

  // Development-only fallback. A packaged Windows app never reaches this path.
  atomicWrite(fileSystem, cryptoModule, legacyPath, Buffer.from(`${secret}\n`, 'utf8'));
  return secret;
}

module.exports = {
  SECURE_FILE_NAME,
  LEGACY_FILE_NAME,
  getOrCreateLocalJwtSecret,
  _test: {
    normalizeSecret,
    safeStorageAvailable,
    serializeEnvelope,
    parseEnvelope,
    atomicWrite
  }
};
