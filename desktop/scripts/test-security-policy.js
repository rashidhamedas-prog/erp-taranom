'use strict';

const assert = require('assert');
const {
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
} = require('../security-policy');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`ok ${passed} - ${name}\n`);
}

test('exact loopback origin and port are allowed', () => {
  assert.strictEqual(isLoopbackUrl('http://127.0.0.1:43123/path?q=1#x', 43123), true);
});

test('loopback URL rejects alternate hosts, schemes, credentials, and ports', () => {
  const rejected = [
    'http://localhost:43123/',
    'http://[::1]:43123/',
    'https://127.0.0.1:43123/',
    'http://127.0.0.1:43124/',
    'http://user@127.0.0.1:43123/',
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)'
  ];
  for (const value of rejected) assert.strictEqual(isLoopbackUrl(value, 43123), false, value);
});

test('child windows allow only blank print documents or the exact loopback origin', () => {
  assert.strictEqual(isAllowedChildWindowUrl('about:blank', 43123), true);
  assert.strictEqual(isAllowedChildWindowUrl('http://127.0.0.1:43123/print', 43123), true);
  assert.strictEqual(isAllowedChildWindowUrl('about:srcdoc', 43123), false);
  assert.strictEqual(isAllowedChildWindowUrl('https://erp.poshaktaranom.com/', 43123), false);
});

test('external allowlist accepts only HTTPS Taranom hosts on 443', () => {
  const accepted = [
    'https://poshaktaranom.com/',
    'https://erp.poshaktaranom.com/releases/latest.yml',
    'https://downloads.poshaktaranom.com:443/releases/app.exe?token=public'
  ];
  for (const value of accepted) assert.strictEqual(isAllowedExternalUrl(value), true, value);
});

test('external allowlist rejects credentials, non-443 ports, and lookalike hosts', () => {
  const rejected = [
    'http://erp.poshaktaranom.com/',
    'https://erp.poshaktaranom.com:444/',
    'https://user:pass@erp.poshaktaranom.com/',
    'https://poshaktaranom.com.evil.example/',
    'https://evilposhaktaranom.com/',
    'https://poshaktaranom.com./',
    'https://127.0.0.1/',
    'file:///tmp/update.exe',
    'javascript:alert(1)'
  ];
  for (const value of rejected) assert.strictEqual(isAllowedExternalUrl(value), false, value);
});

test('SHA-256 and size normalization is strict', () => {
  assert.strictEqual(normalizeSha256('A'.repeat(64)), 'a'.repeat(64));
  assert.strictEqual(normalizeSha256('../bad'), null);
  assert.strictEqual(normalizeUpdateSize(1024), 1024);
  assert.strictEqual(normalizeUpdateSize('1024'), null);
  assert.strictEqual(normalizeUpdateSize(0), null);
  assert.strictEqual(normalizeUpdateSize(MAX_UPDATE_BYTES + 1), null);
});

test('manual installer payload must exactly match trusted main-process state', () => {
  const expected = {
    url: 'https://erp.poshaktaranom.com/releases/setup.exe',
    sha256: 'A'.repeat(64),
    size: 1234
  };
  const valid = validateManualUpdateMetadata({
    url: expected.url,
    sha256: 'a'.repeat(64),
    size: 1234
  }, expected);
  assert.deepStrictEqual(valid, {
    ok: true,
    value: { url: expected.url, sha256: 'a'.repeat(64), size: 1234 }
  });
  assert.strictEqual(validateManualUpdateMetadata({ ...expected, size: 1235 }, expected).ok, false);
  assert.strictEqual(validateManualUpdateMetadata({ ...expected, url: 'https://evil.example/setup.exe' }, expected).ok, false);
  assert.strictEqual(validateManualUpdateMetadata({ ...expected, sha256: 'b'.repeat(64) }, expected).ok, false);
});

test('manual installer rejects invalid trusted state even when renderer matches it', () => {
  const unsafe = { url: 'http://erp.poshaktaranom.com/setup.exe', sha256: 'a'.repeat(64), size: 10 };
  assert.deepStrictEqual(validateManualUpdateMetadata(unsafe, unsafe), {
    ok: false,
    code: 'E_UPDATE_METADATA_MISSING'
  });
});

test('streamed installer integrity accepts only the exact bytes and SHA-256', () => {
  const crypto = require('crypto');
  const first = Buffer.from('MZ-safe-update-');
  const second = Buffer.from('payload');
  const payload = Buffer.concat([first, second]);
  const digest = crypto.createHash('sha256').update(payload).digest('hex');
  const verifier = createUpdateIntegrityVerifier(digest, payload.length);
  verifier.update(first);
  verifier.update(second);
  assert.strictEqual(verifier.bytes, payload.length);
  assert.strictEqual(verifier.verify(), true);
  assert.throws(() => verifier.verify(), /already finalized/);
});

test('streamed installer integrity fails on oversize, truncation, or digest mismatch', () => {
  const crypto = require('crypto');
  const payload = Buffer.from('MZ-payload');
  const digest = crypto.createHash('sha256').update(payload).digest('hex');

  const oversize = createUpdateIntegrityVerifier(digest, payload.length - 1);
  assert.throws(() => oversize.update(payload), /exceeds/);

  const truncated = createUpdateIntegrityVerifier(digest, payload.length);
  truncated.update(payload.subarray(0, payload.length - 1));
  assert.throws(() => truncated.verify(), /size/);

  const changed = createUpdateIntegrityVerifier('f'.repeat(64), payload.length);
  changed.update(payload);
  assert.throws(() => changed.verify(), /SHA-256/);
});

test('electron-updater install requires ready state and exact source', () => {
  assert.deepStrictEqual(evaluateUpdateInstallPolicy({
    state: { status: 'ready', installerSource: 'electron-updater', signatureVerified: false },
    updaterAvailable: true,
    requireSigned: false
  }), { ok: true, mode: 'electron-updater' });
  assert.strictEqual(evaluateUpdateInstallPolicy({
    state: { status: 'ready', installerSource: 'verified-manifest' },
    updaterAvailable: true,
    requireSigned: false
  }).ok, false);
});

test('REQUIRE_SIGNED_UPDATES blocks unverified electron-updater state', () => {
  assert.deepStrictEqual(evaluateUpdateInstallPolicy({
    state: { status: 'ready', installerSource: 'electron-updater', signatureVerified: false },
    updaterAvailable: true,
    requireSigned: true
  }), { ok: false, code: 'E_UPDATE_SIGNATURE_REQUIRED' });
  assert.strictEqual(evaluateUpdateInstallPolicy({
    state: { status: 'ready', installerSource: 'electron-updater', signatureVerified: true },
    updaterAvailable: true,
    requireSigned: true
  }).ok, true);
});

test('manifest fallback is accepted only as a verified main-process source', () => {
  assert.deepStrictEqual(evaluateUpdateInstallPolicy({
    state: { status: 'available-fallback', installerSource: 'verified-manifest' },
    updaterAvailable: false,
    requireSigned: true
  }), { ok: true, mode: 'verified-manifest', verifySignature: true });
  assert.strictEqual(evaluateUpdateInstallPolicy({
    state: { status: 'available-fallback', installerSource: null },
    updaterAvailable: false,
    requireSigned: false
  }).ok, false);
});

test('signed update flag is opt-in and exact', () => {
  assert.strictEqual(signedUpdatesRequired('1'), true);
  assert.strictEqual(signedUpdatesRequired('true'), false);
  assert.strictEqual(signedUpdatesRequired('0'), false);
});

test('packaged Windows defaults to signed updates with explicit rollback override', () => {
  assert.strictEqual(resolveSignedUpdatesFlag(undefined, { isPackaged: true, platform: 'win32' }), '1');
  assert.strictEqual(resolveSignedUpdatesFlag('', { isPackaged: true, platform: 'win32' }), '1');
  assert.strictEqual(resolveSignedUpdatesFlag(undefined, { isPackaged: false, platform: 'win32' }), '0');
  assert.strictEqual(resolveSignedUpdatesFlag(undefined, { isPackaged: true, platform: 'linux' }), '0');
  assert.strictEqual(resolveSignedUpdatesFlag('0', { isPackaged: true, platform: 'win32' }), '0');
  assert.strictEqual(resolveSignedUpdatesFlag('1', { isPackaged: false, platform: 'win32' }), '1');
  assert.throws(
    () => resolveSignedUpdatesFlag('true', { isPackaged: true, platform: 'win32' }),
    /exactly 0 or 1/
  );
});

test('publisher names are bounded, trimmed, and deduplicated', () => {
  assert.deepStrictEqual(normalizePublisherNames([' CN=Taranom ', 'CN=Taranom', '', null]), ['CN=Taranom']);
  assert.deepStrictEqual(normalizePublisherNames('CN=Taranom'), ['CN=Taranom']);
});

test('child windows cannot inherit Node, preload, or webview privileges', () => {
  const options = secureChildWindowOptions();
  assert.strictEqual(options.webPreferences.sandbox, true);
  assert.strictEqual(options.webPreferences.contextIsolation, true);
  assert.strictEqual(options.webPreferences.nodeIntegration, false);
  assert.strictEqual(options.webPreferences.nodeIntegrationInSubFrames, false);
  assert.strictEqual(options.webPreferences.webviewTag, false);
  assert.strictEqual(Object.hasOwn(options.webPreferences, 'preload'), false);
});

test('webview preferences are stripped and hardened before rejection', () => {
  const preferences = {
    preload: 'C:/evil.js',
    preloadURL: 'file:///C:/evil.js',
    nodeIntegration: true,
    sandbox: false,
    webviewTag: true
  };
  hardenWebviewPreferences(preferences);
  assert.strictEqual(Object.hasOwn(preferences, 'preload'), false);
  assert.strictEqual(Object.hasOwn(preferences, 'preloadURL'), false);
  assert.strictEqual(preferences.nodeIntegration, false);
  assert.strictEqual(preferences.sandbox, true);
  assert.strictEqual(preferences.webviewTag, false);
});

console.log(`desktop security policy: ${passed}/${passed} pass`);
