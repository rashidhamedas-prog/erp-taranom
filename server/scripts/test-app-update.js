/**
 * تست منطق تشخیص آپدیت — حتی بدون URL (اندروید local).
 */
const assert = require('assert');
const { compareVersion, buildUpdateResponse } = require('../lib/app-update');

assert.ok(compareVersion('2.0.24', '2.0.25') < 0);
assert.ok(compareVersion('2.0.25', '2.0.25') === 0);
assert.ok(compareVersion('2.1.0', '2.0.25') > 0);

const manifest = {
  android: { version: '2.0.25', versionCode: 27, url: '', distribution: 'local', notes: 'sideload' },
  desktop: { version: '2.0.4', url: '/releases/ERP-Taranom-Setup-2.0.4.exe', notes: 'exe' },
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

console.log('OK app-update', { and, desk });
