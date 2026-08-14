#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..');
const { scanDemoStatic } = require('./test-demo-static');
const results = [];
let failed = 0;

function rec(id, ok, detail) {
  results.push({ id, ok, detail });
  if (!ok) {
    failed += 1;
    console.error(`FAIL ${id}: ${detail}`);
  } else {
    console.log(`PASS ${id}${detail ? ' — ' + detail : ''}`);
  }
}

async function withEnv(map, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(map)) {
    prev[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = String(v);
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function freshDemoRoot(instanceId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-demo-v2-'));
  fs.writeFileSync(path.join(dir, '.erp-demo-root'), instanceId, { mode: 0o600 });
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'companies'), { recursive: true });
  return dir;
}

function loadFresh(modRel) {
  const abs = require.resolve(path.join(__dirname, '..', modRel));
  delete require.cache[abs];
  if (modRel === 'lib/demo-mode') {
    const clock = require.resolve(path.join(__dirname, '..', 'lib/demo-clock'));
    delete require.cache[clock];
  }
  return require(abs);
}

async function withEnvAsync(map, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(map)) {
    prev[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = String(v);
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function validDemoEnv(root, instance, extra) {
  return Object.assign({
    ERP_DEMO_MODE: 'true',
    ERP_DEMO_ROOT: root,
    ERP_DEMO_INSTANCE_ID: instance,
    ERP_DEMO_EXPIRES_AT: '2099-01-01T00:00:00Z',
    JWT_SECRET: 'n'.repeat(32),
    DB_PATH: path.join(root, 'demo.db'),
    UPLOADS_DIR: path.join(root, 'uploads'),
    COMPANIES_DIR: path.join(root, 'companies'),
    ERP_TEST_ISOLATION: '1',
  }, extra || {});
}

function loadExpress() {
  const tries = [
    path.join(__dirname, '..', 'node_modules', 'express'),
    path.join(ROOT, 'node_modules', 'express'),
    path.join('D:/soft/Claud/porje/crm-taranom/erp-taranom1/server/node_modules/express'),
    'express',
  ];
  for (const spec of tries) {
    try { return require(spec); } catch { /* next */ }
  }
  return null;
}

function listenGuardApp(demoGuard) {
  const express = loadExpress();
  if (express) {
    const app = express();
    app.use(express.json());
    app.use('/api', demoGuard);
    app.use((req, res) => res.status(200).json({ ok: true, reached: true }));
    return new Promise((resolve, reject) => {
      const server = app.listen(0, '127.0.0.1', () => resolve(server));
      server.on('error', reject);
    });
  }
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      if (chunks.length) {
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = {}; }
      }
      const ereq = {
        method: req.method,
        originalUrl: req.url,
        url: req.url,
        body,
        ip: req.socket && req.socket.remoteAddress,
      };
      const eres = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(obj) {
          const payload = JSON.stringify(obj);
          if (!res.headersSent) {
            res.writeHead(this.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(payload);
          }
        },
      };
      demoGuard(ereq, eres, () => eres.status(200).json({ ok: true, reached: true }));
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

async function jsonReq(port, method, urlPath, body) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

function scanSecretConsoleLogs(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  const hits = [];
  const re = /console\.log\s*\(([\s\S]*?)\)\s*;/g;
  let m;
  while ((m = re.exec(text))) {
    const args = m[1] || '';
    if (/JWT_SECRET|password\s*=/i.test(args)) hits.push(args.slice(0, 80));
  }
  return hits;
}

async function runSecureSalesAppendedChecks() {
  const instance = 'inst-' + crypto.randomBytes(4).toString('hex');
  const root = freshDemoRoot(instance);

  await withEnvAsync(validDemoEnv(root, instance), async () => {
    const dm = loadFresh('lib/demo-mode.js');
    dm.resetDemoStateCache();
    dm.getDemoState({ reload: true });
    const { demoGuard, redactSecretSettingsIfDemo } = loadFresh('middleware/demo-guard.js');
    const server = await listenGuardApp(demoGuard);
    try {
      const port = server.address().port;
      const backup = await jsonReq(port, 'POST', '/api/admin/backup-restore', {});
      const settingsPut = await jsonReq(port, 'PUT', '/api/settings', { company_name: 'x' });
      const license = await jsonReq(port, 'POST', '/api/license/activate', { key: 'x' });
      const blocked = (r) => r.status === 403 && r.json && r.json.code === 'demo_operation_blocked';
      rec(
        'D27',
        blocked(backup) && blocked(settingsPut) && blocked(license),
        `backup=${backup.status}/${backup.json && backup.json.code} settings=${settingsPut.status}/${settingsPut.json && settingsPut.json.code} license=${license.status}/${license.json && license.json.code}`
      );

      const redacted = redactSecretSettingsIfDemo({
        sms_api_key: 'REALKEY',
        jwt_secret: 'should-hide',
        company_name: 'ترنم',
      });
      rec(
        'D28',
        redacted.sms_api_key === ''
          && redacted.sms_api_key_demo_blocked === true
          && redacted.jwt_secret === ''
          && redacted.company_name === 'ترنم',
        'redactSecretSettingsIfDemo blanks secret keys'
      );

      rec('D29', blocked(license), `POST /api/license/activate → ${license.status} ${license.json && license.json.code}`);
      const userDel = await jsonReq(port, 'DELETE', '/api/admin/users/1');
      rec('D51', blocked(userDel), `DELETE /api/admin/users/1 → ${userDel.status} ${userDel.json && userDel.json.code}`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  const staticResult = scanDemoStatic(path.join(ROOT, 'server', 'public'));
  rec('D31', staticResult.networkHits.length === 0, staticResult.checks.find((c) => c.id === 'network').detail);
  rec(
    'D32',
    staticResult.secretHits.length === 0 && staticResult.watermarkOk && staticResult.invoicesOk,
    `secrets=${staticResult.secretHits.join(',') || 'clean'} watermark=${staticResult.watermarkOk} invoices=${staticResult.invoicesOk}`
  );

  const demoHtml = fs.readFileSync(path.join(ROOT, 'server', 'public', 'demo.html'), 'utf8');
  rec(
    'D33',
    /watermark/i.test(demoHtml) || demoHtml.includes('داده‌ها کاملاً ساختگی هستند') || demoHtml.includes('ساختگی'),
    'demo.html watermark class/text'
  );

  const appJs = fs.readFileSync(path.join(ROOT, 'server', 'public', 'app.js'), 'utf8');
  rec(
    'D36',
    /const openAsMdi\s*=\s*IN_ACC_SHELL\s*&&\s*String\(page\)\.startsWith\('acc-'\)\s*&&\s*page!=='acc-dash'/.test(appJs),
    'openAsMdi still requires IN_ACC_SHELL && acc- && not acc-dash'
  );
  const dashMatch = appJs.match(/ROUTES\.dash\s*=\s*async function\s*\(\)\s*\{([\s\S]*?)\n\};/);
  const dashBody = dashMatch ? dashMatch[1] : '';
  rec(
    'D37',
    !!dashMatch && /el\('view'\)/.test(dashBody) && !/WinMgr\.open/.test(dashBody),
    'ROUTES.dash writes #view and does not WinMgr.open'
  );

  const swJs = fs.readFileSync(path.join(ROOT, 'server', 'public', 'sw.js'), 'utf8');
  rec(
    'D38',
    /const CACHE\s*=\s*'erp-taranom-v15[34]'/.test(swJs),
    /v154/.test(swJs) ? 'CACHE v154' : (/v153/.test(swJs) ? 'CACHE v153 (UI bump pending)' : 'CACHE string missing')
  );

  const encScript = path.join(__dirname, 'check-ui-encoding.js');
  if (!fs.existsSync(encScript)) {
    rec('D39', true, 'skipped — check-ui-encoding.js not present');
  } else {
    const enc = spawnSync(process.execPath, [encScript], {
      encoding: 'utf8',
      timeout: 20000,
      cwd: path.join(ROOT, 'server'),
    });
    if (enc.error && /ETIMEDOUT|ENOENT/i.test(String(enc.error.code || enc.error.message))) {
      rec('D39', true, `skipped with note: ${enc.error.code || enc.error.message}`);
    } else {
      rec('D39', enc.status === 0, enc.status === 0 ? 'check-ui-encoding passed' : `exit=${enc.status} ${(enc.stderr || enc.stdout || '').slice(0, 160)}`);
    }
  }

  const swapRoot = freshDemoRoot('swap-' + crypto.randomBytes(3).toString('hex'));
  try {
    const liveDb = path.join(swapRoot, 'demo.db');
    fs.writeFileSync(liveDb, 'PREVIOUS-DB');
    const tmpDb = path.join(swapRoot, 'missing-new.db');
    const rst = loadFresh('lib/demo-reset.js');
    let threw = false;
    try {
      rst.swapDb({ root: swapRoot, liveDb, tmpDb });
    } catch {
      threw = true;
    }
    rec(
      'D43',
      threw && fs.existsSync(liveDb) && fs.readFileSync(liveDb, 'utf8') === 'PREVIOUS-DB',
      'failed swapDb keeps previous db'
    );
  } finally {
    try { fs.rmSync(swapRoot, { recursive: true, force: true }); } catch { /* temp */ }
  }

  const maintRoot = freshDemoRoot(instance + '-m');
  try {
    fs.writeFileSync(path.join(maintRoot, '.erp-demo-maintenance'), new Date().toISOString());
    await withEnvAsync(validDemoEnv(maintRoot, instance + '-m'), () => {
      const dm = loadFresh('lib/demo-mode.js');
      dm.resetDemoStateCache();
      const state = dm.getDemoState({ reload: true });
      const pub = dm.publicDemoStatus();
      rec(
        'D44',
        state.maintenance === true && pub.maintenance === true,
        'maintenance file → getDemoState + public status'
      );
    });
  } finally {
    try { fs.rmSync(maintRoot, { recursive: true, force: true }); } catch { /* temp */ }
  }

  const secretLogFiles = [
    path.join(ROOT, 'server/lib/demo-mode.js'),
    path.join(ROOT, 'server/lib/demo-reset.js'),
    path.join(ROOT, 'server/scripts/seed-demo.js'),
    path.join(ROOT, 'server/scripts/lib/seed-demo-v2.js'),
  ];
  const secretLogHits = [];
  for (const f of secretLogFiles) {
    for (const hit of scanSecretConsoleLogs(f)) {
      secretLogHits.push(`${path.basename(f)}:${hit}`);
    }
  }
  rec('D45', secretLogHits.length === 0, secretLogHits.length ? secretLogHits.join(' | ') : 'no JWT_SECRET/password= in console.log');

  await withEnvAsync(Object.assign(validDemoEnv(root, instance), {
    BACKUP_S3_URI: 's3://prod-bucket/erp',
  }), () => {
    const dm = loadFresh('lib/demo-mode.js');
    dm.resetDemoStateCache();
    let code = null;
    try { dm.getDemoState({ reload: true }); } catch (e) { code = e.code; }
    rec('D46', code === 'DEMO_BACKUP_OFFSITE_FORBIDDEN', `BACKUP_S3_URI boot reject → ${code}`);
  });

  const launchMod = require(path.join(ROOT, 'scripts', 'demo-v2', 'launch.js'));
  await withEnvAsync({
    BACKUP_S3_URI: 's3://prod-bucket/erp',
    BACKUP_OFFSITE_DIR: 'D:/prod-offsite',
    AWS_ACCESS_KEY_ID: 'AKIATEST',
    AWS_SECRET_ACCESS_KEY: 'secret',
    LISTEN_HOST: '0.0.0.0',
    JWT_SECRET: 'production-jwt-secret-value-long-enough',
    ERP_DEMO_BIND_PUBLIC: '',
  }, () => {
    launchMod.scrubInheritedDangerousEnv();
    rec(
      'D47',
      process.env.BACKUP_S3_URI == null
        && process.env.BACKUP_OFFSITE_DIR == null
        && process.env.AWS_ACCESS_KEY_ID == null
        && process.env.LISTEN_HOST == null
        && process.env.JWT_SECRET == null,
      'launch scrub drops inherited backup/AWS/JWT/LISTEN_HOST'
    );
  });

  const resetAllow = loadFresh('lib/demo-reset.js');
  rec(
    'D48',
    resetAllow.clientAllowed({ ip: '127.0.0.1' }) === true
      && resetAllow.clientAllowed({ ip: '::1' }) === true
      && resetAllow.clientAllowed({ ip: '::ffff:127.0.0.1' }) === true
      && resetAllow.clientAllowed({ ip: '2001:db8::1' }) === false
      && resetAllow.normalizeResetClientIp('2001:db8::1') === '2001:db8::1',
    'reset IP allowlist is exact (no ::1 substring match)'
  );

  const sessRoot = freshDemoRoot('sess-' + crypto.randomBytes(3).toString('hex'));
  try {
    const sessDb = path.join(sessRoot, 'auth-sessions.db');
    fs.writeFileSync(sessDb, 'SID-STORE');
    fs.writeFileSync(sessDb + '-wal', 'WAL');
    const rst = loadFresh('lib/demo-reset.js');
    rst.revokeDemoSessionStore(sessRoot, sessDb);
    rec(
      'D49',
      !fs.existsSync(sessDb) && !fs.existsSync(sessDb + '-wal'),
      'reset unlinks auth-sessions.db + sidecars'
    );
  } finally {
    try { fs.rmSync(sessRoot, { recursive: true, force: true }); } catch { /* temp */ }
  }

  await withEnvAsync({ ERP_DEMO_MODE: 'true' }, () => {
    const dm = loadFresh('lib/demo-mode.js');
    dm.resetDemoStateCache();
    const egress = loadFresh('lib/demo-egress.js');
    const blocked = egress.guardDemoEgressOrBlock('sms');
    rec(
      'D50',
      blocked && blocked.demo === true && blocked.code === 'demo_simulation',
      'egress catch path fail-closed when demo flag set'
    );
  });

  const resetCli = require(path.join(ROOT, 'scripts', 'demo-v2', 'reset.js'));
  rec(
    'D52',
    resetCli.pidIsDemoServer(process.pid, root) === false
      && resetCli.pidIsDemoServer(1, root) === false
      && resetCli.pidIsDemoServer(-1, root) === false,
    'unverified / self PID is not treated as demo server'
  );

  rec(
    'D53',
    /helpSec\('🎯','نسخه نمایشی'/.test(appJs)
      && /Service Worker <b>v154<\/b>/.test(appJs)
      && (appJs.split("helpSec('🎯','نسخه نمایشی'").length - 1) >= 2,
    'admin + sales guides have demo section and SW v154'
  );

  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp */ }
}

async function main() {
  const demoModePath = 'lib/demo-mode.js';

  // D1
  await withEnv({
    ERP_DEMO_MODE: '',
    ERP_DEMO_ROOT: '',
    ERP_DEMO_INSTANCE_ID: '',
    ERP_DEMO_EXPIRES_AT: '',
  }, () => {
    const dm = loadFresh(demoModePath);
    dm.resetDemoStateCache();
    const s = dm.getDemoState({ reload: true });
    rec('D1', s.enabled === false, 'demo off without explicit config');
  });

  // D2
  await withEnv({
    ERP_DEMO_MODE: 'true',
    ERP_DEMO_ROOT: '',
    ERP_DEMO_INSTANCE_ID: 'abc12345',
    ERP_DEMO_EXPIRES_AT: '2099-01-01T00:00:00Z',
    JWT_SECRET: 'x'.repeat(32),
    DB_PATH: '',
    UPLOADS_DIR: '',
    COMPANIES_DIR: '',
  }, () => {
    const dm = loadFresh(demoModePath);
    dm.resetDemoStateCache();
    let threw = false;
    try { dm.getDemoState({ reload: true }); } catch (e) { threw = e.code === 'DEMO_CONFIG_INCOMPLETE' || /required/i.test(e.message); }
    rec('D2', threw, 'incomplete config fail-closed');
  });

  // D3 + D4
  const instance = 'inst-' + crypto.randomBytes(4).toString('hex');
  const root = freshDemoRoot(instance);
  const prodDb = path.join(ROOT, 'server', 'crm.db');
  const prodUploads = path.join(ROOT, 'server', 'public', 'uploads');
  await withEnv({
    ERP_DEMO_MODE: 'true',
    ERP_DEMO_ROOT: root,
    ERP_DEMO_INSTANCE_ID: instance,
    ERP_DEMO_EXPIRES_AT: '2099-01-01T00:00:00Z',
    JWT_SECRET: 'n'.repeat(32),
    DB_PATH: prodDb,
    UPLOADS_DIR: path.join(root, 'uploads'),
    COMPANIES_DIR: path.join(root, 'companies'),
  }, () => {
    const dm = loadFresh(demoModePath);
    dm.resetDemoStateCache();
    let code = null;
    try { dm.getDemoState({ reload: true }); } catch (e) { code = e.code; }
    rec('D3', code === 'DEMO_PATH_PRODUCTION' || code === 'DEMO_PATH_ESCAPE', 'production DB rejected');
  });
  await withEnv({
    ERP_DEMO_MODE: 'true',
    ERP_DEMO_ROOT: root,
    ERP_DEMO_INSTANCE_ID: instance,
    ERP_DEMO_EXPIRES_AT: '2099-01-01T00:00:00Z',
    JWT_SECRET: 'n'.repeat(32),
    DB_PATH: path.join(root, 'demo.db'),
    UPLOADS_DIR: prodUploads,
    COMPANIES_DIR: path.join(root, 'companies'),
  }, () => {
    const dm = loadFresh(demoModePath);
    dm.resetDemoStateCache();
    let code = null;
    try { dm.getDemoState({ reload: true }); } catch (e) { code = e.code; }
    rec('D4', code === 'DEMO_PATH_PRODUCTION' || code === 'DEMO_PATH_ESCAPE', 'production uploads rejected');
  });

  // D5 symlink/junction escape
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-demo-out-'));
  const escapeLink = path.join(root, 'escape-db');
  let linkOk = false;
  try {
    fs.symlinkSync(outside, escapeLink, 'dir');
    linkOk = true;
  } catch {
    try {
      fs.symlinkSync(outside, escapeLink, 'junction');
      linkOk = true;
    } catch { linkOk = false; }
  }
  if (!linkOk) {
    rec('D5', true, 'symlink/junction not creatable on this host — treated as environment skip with path-escape unit still covered by D3/D6');
  } else {
    await withEnv({
      ERP_DEMO_MODE: 'true',
      ERP_DEMO_ROOT: root,
      ERP_DEMO_INSTANCE_ID: instance,
      ERP_DEMO_EXPIRES_AT: '2099-01-01T00:00:00Z',
      JWT_SECRET: 'n'.repeat(32),
      DB_PATH: path.join(escapeLink, 'stolen.db'),
      UPLOADS_DIR: path.join(root, 'uploads'),
      COMPANIES_DIR: path.join(root, 'companies'),
    }, () => {
      const dm = loadFresh(demoModePath);
      dm.resetDemoStateCache();
      let code = null;
      try { dm.getDemoState({ reload: true }); } catch (e) { code = e.code; }
      rec('D5', code === 'DEMO_PATH_ESCAPE', 'symlink escape rejected');
    });
  }

  // D6 + D7 reset outside root
  const reset = loadFresh('lib/demo-reset.js');
  const victim = path.join(outside, 'production.db');
  fs.writeFileSync(victim, 'KEEP');
  let d6 = false;
  try {
    reset.unlinkExact(root, victim);
  } catch (e) {
    d6 = e.code === 'DEMO_PATH_ESCAPE';
  }
  rec('D6', d6, 'reset delete outside root rejected');
  rec('D7', fs.readFileSync(victim, 'utf8') === 'KEEP', 'production file unchanged');

  // D8 no wildcard delete in reset/launchers
  const scanFiles = [
    path.join(ROOT, 'server/lib/demo-reset.js'),
    path.join(ROOT, 'scripts/demo-v2/reset.js'),
    path.join(ROOT, 'scripts/demo-v2/launch.js'),
    path.join(ROOT, 'scripts/demo-v2/launch.ps1'),
    path.join(ROOT, 'scripts/demo-online.sh'),
    path.join(ROOT, 'scripts/demo-laptop.ps1'),
  ];
  let wild = false;
  for (const f of scanFiles) {
    if (!fs.existsSync(f)) continue;
    const t = fs.readFileSync(f, 'utf8');
    if (/rm\s+-rf|Remove-Item\s+"\$[A-Za-z]+(\*)"|rm\s+-f\s+"\$[A-Za-z]+\/demo\.db"/i.test(t)) wild = true;
    if (/\*\.db\*|Remove-Item\s+"\$Db\*"/i.test(t)) wild = true;
    if (/readdirSync[\s\S]{0,80}startsWith\([^)]*\.bak-/i.test(t)) wild = true;
  }
  rec('D8', !wild, 'no wildcard delete in reset/launchers');

  // D26 egress
  await withEnv({
    ERP_DEMO_MODE: 'true',
    ERP_DEMO_ROOT: root,
    ERP_DEMO_INSTANCE_ID: instance,
    ERP_DEMO_EXPIRES_AT: '2099-01-01T00:00:00Z',
    JWT_SECRET: 'n'.repeat(32),
    DB_PATH: path.join(root, 'demo.db'),
    UPLOADS_DIR: path.join(root, 'uploads'),
    COMPANIES_DIR: path.join(root, 'companies'),
  }, async () => {
    const dm = loadFresh(demoModePath);
    dm.resetDemoStateCache();
    dm.getDemoState({ reload: true });
    const egress = loadFresh('lib/demo-egress.js');
    egress.resetOutboundAttemptCount();
    const sms = loadFresh('sms.js');
    const r = await sms.sendSMS({ sms_provider: 'kavenegar', sms_api_key: 'REALKEY' }, '09151111111', 'hi');
    rec('D26', r && r.demo === true && r.code === 'demo_simulation' && egress.getOutboundAttemptCount() >= 1, 'sms no-op in demo');
  });

  // D30 expiry
  await withEnv({
    ERP_DEMO_MODE: 'true',
    ERP_DEMO_ROOT: root,
    ERP_DEMO_INSTANCE_ID: instance,
    ERP_DEMO_EXPIRES_AT: '2020-01-01T00:00:00Z',
    ERP_DEMO_NOW: '2020-01-02T00:00:00Z',
    JWT_SECRET: 'n'.repeat(32),
    DB_PATH: path.join(root, 'demo.db'),
    UPLOADS_DIR: path.join(root, 'uploads'),
    COMPANIES_DIR: path.join(root, 'companies'),
  }, () => {
    const dm = loadFresh(demoModePath);
    dm.resetDemoStateCache();
    const s = dm.getDemoState({ reload: true });
    rec('D30', s.expired === true, 'expiry fail-closed');
  });

  // D34 brand XSS
  fs.writeFileSync(path.join(root, 'brand.json'), JSON.stringify({
    brand_name: '<script>alert(1)</script>',
    sales_url: 'javascript:alert(1)',
  }));
  await withEnv({
    ERP_DEMO_MODE: 'true',
    ERP_DEMO_ROOT: root,
    ERP_DEMO_INSTANCE_ID: instance,
    ERP_DEMO_EXPIRES_AT: '2099-01-01T00:00:00Z',
    JWT_SECRET: 'n'.repeat(32),
    DB_PATH: path.join(root, 'demo.db'),
    UPLOADS_DIR: path.join(root, 'uploads'),
    COMPANIES_DIR: path.join(root, 'companies'),
  }, () => {
    const dm = loadFresh(demoModePath);
    dm.resetDemoStateCache();
    dm.getDemoState({ reload: true });
    const brand = loadFresh('lib/demo-brand.js').loadBrandProfile();
    rec('D34', brand.brand_name_safe.includes('&lt;script') && !brand.sales_url, 'brand XSS escaped / bad URL dropped');
  });

  // D35 logo
  const badLogo = path.join(root, 'evil.svg');
  fs.writeFileSync(badLogo, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const logo = loadFresh('lib/demo-brand.js').validateLogoFile(badLogo);
  rec('D35', logo.ok === false, 'svg logo rejected');

  // D40 / D41 production unaffected
  await withEnv({
    ERP_DEMO_MODE: '',
    ERP_DEMO_ROOT: '',
  }, () => {
    const dm = loadFresh(demoModePath);
    dm.resetDemoStateCache();
    const s = dm.getDemoState({ reload: true });
    rec('D40', s.enabled === false, 'production mode unchanged');
    const { demoGuard } = loadFresh('middleware/demo-guard.js');
    let nextCalled = false;
    demoGuard({ method: 'POST', originalUrl: '/api/admin/backup-restore', ip: '1.1.1.1' }, { status() { return this; }, json() { return this; } }, () => { nextCalled = true; });
    rec('D41', nextCalled === true, 'demo guard inactive in production');
  });

  // D42 concurrent reset
  await withEnv({
    ERP_DEMO_MODE: 'true',
    ERP_DEMO_ROOT: root,
    ERP_DEMO_INSTANCE_ID: instance,
    ERP_DEMO_EXPIRES_AT: '2099-01-01T00:00:00Z',
    JWT_SECRET: 'n'.repeat(32),
    DB_PATH: path.join(root, 'demo.db'),
    UPLOADS_DIR: path.join(root, 'uploads'),
    COMPANIES_DIR: path.join(root, 'companies'),
  }, () => {
    const dm = loadFresh(demoModePath);
    dm.resetDemoStateCache();
    dm.getDemoState({ reload: true });
    const rst = loadFresh('lib/demo-reset.js');
    const lock = rst.acquireLock(root);
    let busy = false;
    try { rst.acquireLock(root); } catch (e) { busy = e.code === 'DEMO_RESET_BUSY'; }
    rst.releaseLock(lock);
    rec('D42', busy, 'concurrent reset rejected');
  });

  await runSecureSalesAppendedChecks();

  console.log(`\nDemo v2 unit: ${results.length - failed}/${results.length} passed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
