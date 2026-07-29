/**
 * Multi-company + fiscal year ops integration test.
 * Spawns a temporary central server and exercises:
 *   create company, activate, open-clean FY, delete FY, delete company.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'co-fy-'));
const DB = path.join(TMP, 'main.db');
const COMPANIES_DIR = path.join(TMP, 'companies');
const PORT = 4317 + Math.floor(Math.random() * 200);
const JWT_SECRET = 'company-fy-test-secret';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg); }
  else { failed++; console.error('  ❌', msg); }
}

function req(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: '127.0.0.1', port: PORT, path: '/api' + urlPath, method,
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let j = null;
        try { j = buf ? JSON.parse(buf) : null; } catch { j = { raw: buf }; }
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitHealth(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await req('GET', '/system/health');
      if (r.status === 200) return;
    } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error('server health timeout');
}

async function main() {
  console.log('TMP', TMP, 'PORT', PORT);
  fs.mkdirSync(COMPANIES_DIR, { recursive: true });

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: DB,
      COMPANIES_DIR,
      JWT_SECRET,
      SYNC_ROLE: 'central',
      LISTEN_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });
  child.stdout.on('data', () => {});

  try {
    await waitHealth();

    // Login — default admin/admin123 on fresh DB, may need password change skip
    let login = await req('POST', '/auth/login', { username: 'admin', password: 'admin123' });
    if (login.status !== 200 || !login.body?.token) {
      // Some builds force password change; try reading error
      assert(false, 'login admin: ' + JSON.stringify(login.body));
      throw new Error('login failed');
    }
    let token = login.body.token;
    assert(!!token, 'login ok');

    // If must_change_password, set a password via API if available
    let adminPass = 'admin123';
    if (login.body.must_change_password || login.body.user?.must_change_password) {
      const ch = await req('POST', '/auth/change-password', {
        oldPass: 'admin123', newPass: 'AdminTest#1405',
      }, token);
      assert(ch.status === 200, 'change password: ' + JSON.stringify(ch.body));
      adminPass = 'AdminTest#1405';
      login = await req('POST', '/auth/login', { username: 'admin', password: adminPass });
      token = login.body?.token;
      assert(!!token, 're-login after password change');
    }

    // List companies — should have default
    let cos = await req('GET', '/companies', null, token);
    assert(cos.status === 200, 'GET /companies');
    assert((cos.body.companies || []).length >= 1, 'at least one company');
    const defaultId = cos.body.activeCompanyId;

    // Create second company (clean)
    const created = await req('POST', '/companies', {
      name: 'شرکت تست خام',
      code: 'TEST2',
      fiscal_label: 'سال مالی تست',
      start_date: '1405/01/01',
      activate: false,
    }, token);
    assert(created.status === 200 && created.body?.ok, 'create company: ' + JSON.stringify(created.body));
    const newId = created.body.company.id;
    assert(newId > 0, 'new company id');

    // Activate new company
    const act = await req('POST', `/companies/${newId}/activate`, {}, token);
    assert(act.status === 200 && act.body?.ok, 'activate company');

    // Fiscal years on new company should be clean (1 open year)
    let fy = await req('GET', '/fiscal-year', null, token);
    assert(fy.status === 200, 'GET fiscal-year on new co');
    assert((fy.body.years || []).length >= 1, 'has fiscal year');
    assert(fy.body.current?.status === 'open', 'current FY open');

    // Create another clean year (purge)
    const openClean = await req('POST', '/fiscal-year/open-clean', {
      label: 'سال خام ۲',
      start_date: '1406/01/01',
      confirm_text: 'OPEN-CLEAN-YEAR',
      confirm_password: adminPass,
      wipe_master: false,
    }, token);
    assert(openClean.status === 200 && openClean.body?.ok, 'open-clean year: ' + JSON.stringify(openClean.body));

    fy = await req('GET', '/fiscal-year', null, token);
    const years = fy.body.years || [];
    assert(years.some(y => y.label === 'سال خام ۲'), 'new clean year present');
    const inactive = years.find(y => !y.is_active);
    assert(!!inactive, 'has inactive year to delete');

    // Delete inactive year (no txns expected after clean)
    const delFy = await req('DELETE', `/fiscal-year/${inactive.id}`, {}, token);
    assert(delFy.status === 200 && delFy.body?.ok, 'delete inactive FY: ' + JSON.stringify(delFy.body));

    // Switch back to default company
    const back = await req('POST', `/companies/${defaultId}/activate`, {}, token);
    assert(back.status === 200 && back.body?.ok, 'activate default company');

    // Delete the test company (empty)
    let delCo = await req('DELETE', `/companies/${newId}`, { confirm_password: adminPass }, token);
    if (delCo.status === 400 && /DELETE-COMPANY/.test(delCo.body?.error || '')) {
      delCo = await req('DELETE', `/companies/${newId}`, {
        confirm_password: adminPass,
        confirm_text: 'DELETE-COMPANY',
      }, token);
    }
    assert(delCo.status === 200 && delCo.body?.ok, 'delete company: ' + JSON.stringify(delCo.body));

    cos = await req('GET', '/companies', null, token);
    assert(!(cos.body.companies || []).some(c => c.id === newId), 'company removed from list');

  } catch (e) {
    console.error('FATAL', e);
    failed++;
    if (stderr) console.error('SERVER STDERR:\n', stderr.slice(-2000));
  } finally {
    try { child.kill('SIGTERM'); } catch { /* */ }
    await sleep(500);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
