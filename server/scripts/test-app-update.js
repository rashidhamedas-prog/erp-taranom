/**
 * تست منطق تشخیص آپدیت — حتی بدون URL (اندروید local).
 */
const assert = require('assert');
const { compareVersion, buildUpdateResponse, resolveReleaseUrl } = require('../lib/app-update');

assert.ok(compareVersion('2.0.24', '2.0.25') < 0);
assert.ok(compareVersion('2.0.25', '2.0.25') === 0);
assert.ok(compareVersion('2.1.0', '2.0.25') > 0);
assert.strictEqual(
  resolveReleaseUrl('/releases/latest.yml', 'https://erp.poshaktaranom.com'),
  'https://erp.poshaktaranom.com/releases/latest.yml'
);
assert.strictEqual(resolveReleaseUrl('javascript:alert(1)', 'https://erp.poshaktaranom.com'), null);
assert.strictEqual(resolveReleaseUrl('../outside', 'https://erp.poshaktaranom.com'), null);

const manifest = {
  android: { version: '2.0.25', versionCode: 27, url: '', distribution: 'local', notes: 'sideload' },
  desktop: {
    version: '2.0.4',
    url: '/releases/ERP-Taranom-Setup-2.0.4.exe',
    sha256: 'a'.repeat(64),
    size: 123456,
    notes: 'exe'
  },
  web: { version: '2.1.3', notes: '' }
};

const and = buildUpdateResponse('android', '2.0.24', manifest, 'https://example.com');
assert.strictEqual(and.update_available, true, 'android newer without url');
assert.strictEqual(and.downloadable, false);
assert.strictEqual(and.url, null);
assert.strictEqual(and.distribution, 'local');

const andSame = buildUpdateResponse('android', '2.0.25', manifest, 'https://example.com');
assert.strictEqual(andSame.update_available, false);

const desk = buildUpdateResponse('desktop', '2.0.3', manifest, 'https://example.com');
assert.strictEqual(desk.update_available, true);
assert.strictEqual(desk.downloadable, true);
assert.ok(desk.url.includes('ERP-Taranom-Setup-2.0.4.exe'));
assert.strictEqual(desk.sha256, 'a'.repeat(64));
assert.strictEqual(desk.size, 123456);
assert.strictEqual(desk.integrity_valid, true);
assert.deepStrictEqual(desk.integrity, { algorithm: 'sha256', digest: 'a'.repeat(64), size: 123456 });

const missingIntegrity = buildUpdateResponse('desktop', '2.0.3', {
  desktop: { version: '2.0.4', url: '/releases/unverified.exe' }
}, 'https://example.com');
assert.strictEqual(missingIntegrity.update_available, true);
assert.strictEqual(missingIntegrity.downloadable, false, 'binary without checksum must not be downloadable');
assert.strictEqual(missingIntegrity.integrity_required, true);
assert.strictEqual(missingIntegrity.integrity_valid, false);

const malformedIntegrity = buildUpdateResponse('android', '1.0.0', {
  android: { version: '2.0.0', url: '/releases/app.apk', sha256: '../not-a-digest', size: -1 }
}, 'https://example.com');
assert.strictEqual(malformedIntegrity.downloadable, false, 'malformed integrity metadata must fail closed');
assert.strictEqual(malformedIntegrity.sha256, null);
assert.strictEqual(malformedIntegrity.size, null);

console.log('OK app-update', { and, desk });
