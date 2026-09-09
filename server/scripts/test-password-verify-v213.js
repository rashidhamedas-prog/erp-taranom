'use strict';

const bcrypt = require('bcryptjs');
const {
  passwordsMatch,
  pickConfirmPassword,
  normalizeHash,
  normalizePlain,
} = require('../lib/password-verify');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg); }
  else { failed++; console.error('  ❌', msg); }
}

const hash = bcrypt.hashSync('AdminTest#1405', 10);
ok(passwordsMatch('AdminTest#1405', hash), 'correct password matches');
ok(!passwordsMatch('wrong', hash), 'wrong password rejected');
ok(passwordsMatch('AdminTest#1405', hash + '\n'), 'newline on stored hash trimmed');
ok(passwordsMatch('AdminTest#1405', '  ' + hash + '  '), 'hash whitespace trimmed');
ok(!passwordsMatch('AdminTest#1405', 'not-a-bcrypt-hash'), 'plaintext stored hash rejected');
ok(!passwordsMatch('AdminTest#1405', ''), 'empty hash rejected');
ok(normalizePlain('x'.repeat(200)).length === 128, 'plain sliced to 128 like login');
ok(normalizeHash('\uFEFF' + hash) === hash, 'BOM stripped from hash');
ok(pickConfirmPassword({ confirm_password: 'a' }) === 'a', 'confirm_password preferred');
ok(pickConfirmPassword({ password: 'b' }) === 'b', 'password fallback');
ok(pickConfirmPassword({ confirm_password: '', password: 'c' }) === 'c', 'empty confirm falls back');

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
