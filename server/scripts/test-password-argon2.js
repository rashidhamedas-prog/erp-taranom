'use strict';
const assert = require('assert');
const bcrypt = require('bcryptjs');
const {
  hashPassword, verifyPassword, needsRehash, passwordsMatch,
} = require('../lib/password-verify');
const { normalizeTwofaRoles, validateStaffPolicyBody } = require('../lib/staff-security');

(async () => {
  const plain = 'StaffPass9';
  const encoded = await hashPassword(plain);
  assert.ok(encoded.startsWith('$argon2id$'), 'new hashes are argon2id');
  assert.strictEqual(await verifyPassword(plain, encoded), true);
  assert.strictEqual(await verifyPassword('wrong-pass', encoded), false);
  assert.strictEqual(needsRehash(encoded), false);

  const legacy = bcrypt.hashSync(plain, 10);
  assert.strictEqual(needsRehash(legacy), true);
  assert.strictEqual(await verifyPassword(plain, legacy), true);
  assert.strictEqual(await verifyPassword(plain, legacy + '\n'), true);
  assert.strictEqual(passwordsMatch(plain, legacy), true);
  assert.strictEqual(await verifyPassword(plain, 'not-a-hash'), false);

  assert.strictEqual(normalizeTwofaRoles('admin, no-such, accounting,admin'), 'admin,accounting');
  const db = {
    prepare() {
      return { get() { return undefined; } };
    },
  };
  assert.deepStrictEqual(validateStaffPolicyBody({ session_absolute_hours: '12', session_idle_hours: '8' }, db), {
    ok: true, absolute: 12, idle: 8,
  });
  assert.strictEqual(validateStaffPolicyBody({ session_absolute_hours: '30' }, db).ok, false);
  assert.strictEqual(validateStaffPolicyBody({ session_absolute_hours: '8', session_idle_hours: '12' }, db).ok, false);
  console.log('test-password-argon2: ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
