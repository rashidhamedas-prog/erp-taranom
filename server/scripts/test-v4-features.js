// Smoke test for features ported from CRM v4: 2FA (TOTP), AI insights, product barcode.
// Boots a real server on a temp DB and exercises the new endpoints end-to-end.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { authenticator } = require('otplib');

const PORT = 3477;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-v4feat-'));

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name); }
}

async function j(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* html endpoints */ }
  return { status: res.status, data };
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/system/time'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('server did not start');
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(TMP, 'test.db'), UPLOADS_DIR: path.join(TMP, 'uploads'), JWT_SECRET: 'v4feat-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  try {
    await waitUp();
    console.log('— login & 2FA —');
    let r = await j('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
    ok(r.status === 200 && r.data.token, 'plain login works (no 2FA yet)');
    const token = r.data.token;

    r = await j('GET', '/api/auth/2fa/status', null, token);
    ok(r.status === 200 && r.data.enabled === false, '2FA status: disabled initially');

    r = await j('POST', '/api/auth/2fa/setup', null, token);
    ok(r.status === 200 && r.data.secret && r.data.otpauth, '2FA setup returns secret + otpauth');
    const secret = r.data.secret;

    r = await j('POST', '/api/auth/2fa/verify', { code: '000000' }, token);
    ok(r.status === 400, 'wrong code rejected on enable');

    r = await j('POST', '/api/auth/2fa/verify', { code: authenticator.generate(secret) }, token);
    ok(r.status === 200 && Array.isArray(r.data.recovery_codes) && r.data.recovery_codes.length === 8, 'enable with valid TOTP → 8 recovery codes');
    const recovery = r.data.recovery_codes;

    r = await j('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
    ok(r.status === 200 && r.data.twofa_required && r.data.pre_token, 'login now requires 2FA (pre_token issued)');
    const pre = r.data.pre_token;

    r = await j('POST', '/api/auth/2fa/verify', { pre_token: pre, code: '123456' });
    ok(r.status === 401, 'wrong TOTP at login rejected');

    r = await j('POST', '/api/auth/2fa/verify', { pre_token: pre, code: authenticator.generate(secret) });
    ok(r.status === 200 && r.data.token, 'correct TOTP at login → real token');

    let r2 = await j('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
    r = await j('POST', '/api/auth/2fa/recovery-code', { pre_token: r2.data.pre_token, code: recovery[0] });
    ok(r.status === 200 && r.data.token && r.data.remaining_codes === 7, 'recovery code login works & consumes code');

    r2 = await j('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
    r = await j('POST', '/api/auth/2fa/recovery-code', { pre_token: r2.data.pre_token, code: recovery[0] });
    ok(r.status === 401, 'same recovery code cannot be reused');

    r = await j('GET', '/api/auth/2fa/admin-status', null, token);
    ok(r.status === 200 && r.data.some(u => u.twofa_enabled === 1), 'admin-status lists enabled user');

    r = await j('POST', '/api/auth/2fa/disable', { code: authenticator.generate(secret) }, token);
    ok(r.status === 200 && r.data.ok, 'disable own 2FA with valid code');

    r = await j('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
    ok(r.status === 200 && r.data.token, 'plain login restored after disable');

    console.log('— product barcode —');
    r = await j('POST', '/api/products/quick', { name: 'تست بارکد', price: 1000 }, token);
    ok(r.status === 200 && r.data.id, 'quick product created');
    const pid = r.data.id;

    r = await j('POST', `/api/products/${pid}/generate-barcode`, null, token);
    ok(r.status === 200 && /^\d{13}$/.test(r.data.barcode || ''), 'generated barcode is 13 digits');
    const bc = r.data.barcode;
    // EAN-13 check digit validation
    const digits = bc.split('').map(Number);
    const sum = digits.slice(0, 12).reduce((a, d, i) => a + d * (i % 2 === 0 ? 1 : 3), 0);
    ok((10 - (sum % 10)) % 10 === digits[12], 'EAN-13 check digit valid');

    r = await j('GET', '/api/products/by-barcode/' + bc, null, token);
    ok(r.status === 200 && r.data.id === pid, 'lookup by barcode finds product');

    const labels = await fetch(`${BASE}/api/products/${pid}/labels?token=${encodeURIComponent(token)}`);
    ok(labels.status === 200 && (await labels.text()).includes('JsBarcode'), 'labels page renders with token');
    const noAuth = await fetch(`${BASE}/api/products/${pid}/labels`);
    ok(noAuth.status === 401, 'labels page rejects missing token');

    console.log('— AI insights —');
    r = await j('POST', '/api/customers', { biz: 'فروشگاه تست', owner: 'تست', phone: '09150000000' }, token);
    ok(r.status === 200 && r.data.id, 'customer created');

    r = await j('POST', '/api/ai/insights/refresh', { weekly: true }, token);
    ok(r.status === 200 && r.data.ok, 'AI refresh runs (heuristic layer, no API key)');

    r = await j('GET', '/api/ai/insights', null, token);
    ok(r.status === 200 && Array.isArray(r.data), 'insights feed returns array');

    r = await j('GET', '/api/ai/weekly-summary', null, token);
    ok(r.status === 200 && r.data && r.data.kind === 'weekly_summary', 'weekly summary generated');

    r = await j('GET', '/api/customers', null, token);
    ok(r.status === 200 && r.data.every(c => typeof c.churn_score === 'number'), 'customers carry churn_score');

    console.log(`\n🎉 ${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
  } catch (e) {
    console.error('TEST HARNESS ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    srv.kill();
    setTimeout(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }, 500);
  }
})();
