'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  SECURE_FILE_NAME,
  LEGACY_FILE_NAME,
  getOrCreateLocalJwtSecret
} = require('../local-secret-store');

const roots = [];
let passed = 0;

function makeDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-secret-test-'));
  roots.push(directory);
  return directory;
}

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from([...Buffer.from(value, 'utf8')].map(byte => byte ^ 0xa5)),
    decryptString: value => Buffer.from([...value].map(byte => byte ^ 0xa5)).toString('utf8')
  };
}

function test(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`ok ${passed} - ${name}\n`);
}

try {
  test('fresh packaged Windows secret is protected and stable', () => {
    const dataDir = makeDirectory();
    const storage = fakeSafeStorage();
    const first = getOrCreateLocalJwtSecret({ dataDir, safeStorage: storage, isPackaged: true, platform: 'win32' });
    const second = getOrCreateLocalJwtSecret({ dataDir, safeStorage: storage, isPackaged: true, platform: 'win32' });
    assert.strictEqual(first.length, 64);
    assert.strictEqual(second, first);
    assert.strictEqual(fs.existsSync(path.join(dataDir, SECURE_FILE_NAME)), true);
    assert.strictEqual(fs.existsSync(path.join(dataDir, LEGACY_FILE_NAME)), false);
    assert.strictEqual(fs.readFileSync(path.join(dataDir, SECURE_FILE_NAME), 'utf8').includes(first), false);
  });

  test('plaintext legacy secret migrates only after protected copy verifies', () => {
    const dataDir = makeDirectory();
    const legacy = 'legacy-secret-'.padEnd(64, 'x');
    fs.writeFileSync(path.join(dataDir, LEGACY_FILE_NAME), `${legacy}\n`);
    const actual = getOrCreateLocalJwtSecret({
      dataDir,
      safeStorage: fakeSafeStorage(),
      isPackaged: true,
      platform: 'win32'
    });
    assert.strictEqual(actual, legacy);
    assert.strictEqual(fs.existsSync(path.join(dataDir, LEGACY_FILE_NAME)), false);
    assert.strictEqual(fs.existsSync(path.join(dataDir, SECURE_FILE_NAME)), true);
  });

  test('a leftover plaintext copy is removed after protected secret loads', () => {
    const dataDir = makeDirectory();
    const storage = fakeSafeStorage();
    const secret = getOrCreateLocalJwtSecret({ dataDir, safeStorage: storage, isPackaged: true, platform: 'win32' });
    fs.writeFileSync(path.join(dataDir, LEGACY_FILE_NAME), secret);
    assert.strictEqual(getOrCreateLocalJwtSecret({ dataDir, safeStorage: storage, isPackaged: true, platform: 'win32' }), secret);
    assert.strictEqual(fs.existsSync(path.join(dataDir, LEGACY_FILE_NAME)), false);
  });

  test('packaged Windows fails closed when DPAPI is unavailable', () => {
    const dataDir = makeDirectory();
    assert.throws(() => getOrCreateLocalJwtSecret({
      dataDir,
      safeStorage: fakeSafeStorage(false),
      isPackaged: true,
      platform: 'win32'
    }), /startup is blocked/);
    assert.deepStrictEqual(fs.readdirSync(dataDir), []);
  });

  test('packaged Windows does not consume plaintext when DPAPI is unavailable', () => {
    const dataDir = makeDirectory();
    const legacyPath = path.join(dataDir, LEGACY_FILE_NAME);
    fs.writeFileSync(legacyPath, 'legacy-secret-'.padEnd(64, 'y'));
    assert.throws(() => getOrCreateLocalJwtSecret({
      dataDir,
      safeStorage: fakeSafeStorage(false),
      isPackaged: true,
      platform: 'win32'
    }), /startup is blocked/);
    assert.strictEqual(fs.existsSync(legacyPath), true);
  });

  test('corrupt protected storage fails closed without secret regeneration', () => {
    const dataDir = makeDirectory();
    fs.writeFileSync(path.join(dataDir, SECURE_FILE_NAME), '{broken');
    assert.throws(() => getOrCreateLocalJwtSecret({
      dataDir,
      safeStorage: fakeSafeStorage(),
      isPackaged: true,
      platform: 'win32'
    }), /corrupt/);
    assert.strictEqual(fs.existsSync(path.join(dataDir, LEGACY_FILE_NAME)), false);
  });

  test('failed plaintext deletion preserves both copies for retry without data loss', () => {
    const dataDir = makeDirectory();
    const legacy = 'legacy-secret-'.padEnd(64, 'z');
    const legacyPath = path.join(dataDir, LEGACY_FILE_NAME);
    fs.writeFileSync(legacyPath, legacy);
    const wrappedFs = new Proxy(fs, {
      get(target, property) {
        if (property === 'unlinkSync') {
          return filePath => {
            if (filePath === legacyPath) {
              const error = new Error('simulated locked file');
              error.code = 'EPERM';
              throw error;
            }
            return target.unlinkSync(filePath);
          };
        }
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    assert.throws(() => getOrCreateLocalJwtSecret({
      dataDir,
      safeStorage: fakeSafeStorage(),
      isPackaged: true,
      platform: 'win32',
      fileSystem: wrappedFs
    }), /plaintext cleanup failed/);
    assert.strictEqual(fs.existsSync(legacyPath), true);
    assert.strictEqual(fs.existsSync(path.join(dataDir, SECURE_FILE_NAME)), true);
    assert.strictEqual(getOrCreateLocalJwtSecret({
      dataDir,
      safeStorage: fakeSafeStorage(),
      isPackaged: true,
      platform: 'win32'
    }), legacy);
    assert.strictEqual(fs.existsSync(legacyPath), false);
  });

  test('unpackaged development has an explicit stable plaintext fallback', () => {
    const dataDir = makeDirectory();
    const unavailable = fakeSafeStorage(false);
    const first = getOrCreateLocalJwtSecret({ dataDir, safeStorage: unavailable, isPackaged: false, platform: 'win32' });
    const second = getOrCreateLocalJwtSecret({ dataDir, safeStorage: unavailable, isPackaged: false, platform: 'win32' });
    assert.strictEqual(second, first);
    assert.strictEqual(fs.existsSync(path.join(dataDir, LEGACY_FILE_NAME)), true);
    assert.strictEqual(fs.existsSync(path.join(dataDir, SECURE_FILE_NAME)), false);
  });

  console.log(`desktop local secret store: ${passed}/${passed} pass`);
} finally {
  for (const directory of roots) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* test cleanup */ }
  }
}
