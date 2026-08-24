'use strict';
/**
 * Deterministic V2 interactive-demo seed.
 * Boots the real server and drives HTTP APIs. Never logs passwords.
 *
 *   seedDemoV2(absoluteDbPath)
 *   seedDemoV2({ dbPath, timeoutMs })
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { todayJalali, addDaysToJalali } = require('../../jalali');
const { pickFreePort, killProcessTree } = require('./test-server-boot');
const { validateDemoInvariants } = require('../validate-demo-invariants');

const FORBIDDEN_PASSWORDS = /^(demo1234|admin123)$/i;
const FORBIDDEN_SECRETS = /^(demo-seed-secret|laptop-demo-secret)$/i;
const DEMO_USERS = [
  { username: 'demo_manager', name: 'مدیر نمایش', role: 'sales_manager', phone: '09151110001' },
  { username: 'demo_accountant', name: 'حسابدار نمایش', role: 'accounting', phone: '09151110002' },
  { username: 'demo_sales', name: 'کارشناس فروش نمایش', role: 'field_sales', phone: '09151110003' },
  { username: 'demo_production', name: 'مدیر تولید نمایش', role: 'production_manager', phone: '09151110004' },
];

function generatePassword() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const all = letters + digits;
  const bytes = crypto.randomBytes(18);
  let s = '';
  for (let i = 0; i < 14; i++) s += all[bytes[i] % all.length];
  if (!/[A-Za-z]/.test(s)) s = `A${s.slice(1)}`;
  if (!/\d/.test(s)) s = `${s.slice(0, -1)}7`;
  return s;
}

function validatePresenterPassword(raw) {
  const p = String(raw || '');
  if (p.length < 10) return 'ERP_DEMO_SEED_PASSWORD must be at least 10 characters';
  if (p.length > 128) return 'ERP_DEMO_SEED_PASSWORD is too long';
  if (!/[A-Za-z\u0600-\u06FF]/.test(p) || !/\d/.test(p)) {
    return 'ERP_DEMO_SEED_PASSWORD must include a letter and a digit';
  }
  if (FORBIDDEN_PASSWORDS.test(p)) return 'ERP_DEMO_SEED_PASSWORD rejects a well-known password';
  return null;
}

function presenterPassword() {
  const fromEnv = String(process.env.ERP_DEMO_SEED_PASSWORD || '').trim();
  if (fromEnv) {
    const err = validatePresenterPassword(fromEnv);
    if (err) throw Object.assign(new Error(err), { code: 'DEMO_PASSWORD_INVALID' });
    return fromEnv;
  }
  return generatePassword();
}

function resolveDemoRoot(dbPath) {
  if (process.env.ERP_DEMO_ROOT && String(process.env.ERP_DEMO_ROOT).trim()) {
    return path.resolve(String(process.env.ERP_DEMO_ROOT).trim());
  }
  let dir = path.dirname(path.resolve(dbPath));
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.erp-demo-root'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(path.resolve(dbPath));
}

function writeSecretsFile(root, payload, fileName = 'credentials.json') {
  const dir = path.join(root, 'secrets');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, fileName);
  const tmp = path.join(dir, `.${fileName}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* windows */ }
  fs.renameSync(tmp, dest);
  try { fs.chmodSync(dest, 0o600); } catch { /* windows */ }
  return dest;
}

function childJwtSecret() {
  const raw = String(process.env.JWT_SECRET || '').trim();
  if (raw && raw.length >= 32 && !FORBIDDEN_SECRETS.test(raw)) return raw;
  return crypto.randomBytes(32).toString('hex');
}

function prng(seed) {
  let s = seed;
  return {
    rnd() { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; },
    ri(min, max) { return min + Math.floor(this.rnd() * (max - min + 1)); },
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function redact(text) {
  return String(text || '')
    .replace(/("password"\s*:\s*")[^"]+"/gi, '$1***"')
    .replace(/(password=)[^\s&]+/gi, '$1***');
}

async function waitReady(base, child, getLogs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode != null) {
      throw new Error(`server exited early code=${child.exitCode}\n${redact(getLogs()).slice(-2000)}`);
    }
    try {
      const r = await fetch(`${base}/api/system/ready`, { signal: AbortSignal.timeout(1500) });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data && data.ok === true && data.ready === true) return;
    } catch { /* retry */ }
    await sleep(400);
  }
  throw new Error(`server did not become ready\n${redact(getLogs()).slice(-2000)}`);
}

function normalizeOpts(dbPathOrOpts, maybeOpts) {
  if (dbPathOrOpts && typeof dbPathOrOpts === 'object' && !Array.isArray(dbPathOrOpts)) {
    return { dbPath: dbPathOrOpts.dbPath, timeoutMs: dbPathOrOpts.timeoutMs };
  }
  return { dbPath: dbPathOrOpts, timeoutMs: maybeOpts && maybeOpts.timeoutMs };
}

async function seedDemoV2(dbPathOrOpts, maybeOpts) {
  const opts = normalizeOpts(dbPathOrOpts, maybeOpts);
  const dbPath = path.resolve(opts.dbPath || '');
  if (!dbPath || !path.isAbsolute(dbPath)) {
    throw Object.assign(new Error('seed requires an absolute DB path'), { code: 'DEMO_DB_PATH' });
  }
  if (fs.existsSync(dbPath)) {
    throw Object.assign(new Error(`${dbPath} already exists — refuse to overwrite`), { code: 'DEMO_DB_EXISTS' });
  }

  const timeoutMs = Number(opts.timeoutMs || process.env.ERP_DEMO_SEED_TIMEOUT_MS || 180000);
  const presenterPass = presenterPassword();
  const demoRoot = resolveDemoRoot(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const port = await pickFreePort(Number(process.env.ERP_DEMO_SEED_PORT || 0) || 0, { allowFallback: true });
  const base = `http://127.0.0.1:${port}`;
  const rng = prng(42);
  const today = todayJalali();
  const daysAgo = (n) => addDaysToJalali(today, -n);

  let token = '';
  async function api(method, p, body) {
    const r = await fetch(base + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (r.status < 200 || r.status >= 300) {
      const err = new Error(`${method} ${p} → ${r.status}: ${data.error || JSON.stringify(data)}`);
      err.status = r.status;
      err.data = data;
      throw err;
    }
    return data;
  }
  async function tryApi(method, p, body) {
    try { return { ok: true, data: await api(method, p, body) }; }
    catch (e) { return { ok: false, error: e }; }
  }

  let bootstrapPass = 'admin123';
  const childEnv = {
    ...process.env,
    DB_PATH: dbPath,
    PORT: String(port),
    LISTEN_HOST: '127.0.0.1',
    JWT_SECRET: childJwtSecret(),
    UPLOADS_DIR: process.env.UPLOADS_DIR || path.join(path.dirname(dbPath), 'uploads'),
    COMPANIES_DIR: process.env.COMPANIES_DIR || path.join(path.dirname(dbPath), 'companies'),
    PRIVATE_UPLOADS_DIR: process.env.PRIVATE_UPLOADS_DIR || path.join(path.dirname(dbPath), 'private-uploads'),
    AUTH_SESSION_DB_PATH: process.env.AUTH_SESSION_DB_PATH || path.join(path.dirname(dbPath), 'auth-sessions.db'),
    BACKUP_DIR: process.env.BACKUP_DIR || path.join(path.dirname(dbPath), 'backups'),
    SYNC_ROLE: 'central',
    ERP_TEST_ISOLATION: '1',
    ERP_DEMO_MODE: 'false',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
  delete childEnv.HTTP_PROXY;
  delete childEnv.HTTPS_PROXY;
  delete childEnv.http_proxy;
  delete childEnv.https_proxy;
  delete childEnv.ALL_PROXY;
  delete childEnv.all_proxy;
  if (String(childEnv.NODE_ENV || '').toLowerCase() === 'production') {
    bootstrapPass = generatePassword();
    childEnv.BOOTSTRAP_ADMIN_PASSWORD = bootstrapPass;
  }
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete process.env[k];
  }

  let child = null;
  let stdout = '';
  let stderr = '';
  const started = Date.now();

  const work = (async () => {
    console.log('==> demo-v2 seed: booting isolated server');
    child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.js')], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 200000) stdout = stdout.slice(-100000); });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 200000) stderr = stderr.slice(-100000); });

    await waitReady(base, child, () => stderr + '\n' + stdout, Math.min(90000, timeoutMs));

    let login = await api('POST', '/api/auth/login', { username: 'admin', password: bootstrapPass });
    if (login.must_change_password && login.token) {
      token = login.token;
      const sessionAdminPass = generatePassword();
      await api('POST', '/api/auth/change-password', { oldPass: bootstrapPass, newPass: sessionAdminPass });
      bootstrapPass = sessionAdminPass;
      login = await api('POST', '/api/auth/login', { username: 'admin', password: bootstrapPass });
    }
    token = login.token;
    if (!token) throw new Error('admin login failed');

    const moadian = await tryApi('PUT', '/api/settings', { moadian_enabled: '1', module_moadian: '1' });
    if (!moadian.ok) console.log('  (moadian setting skipped)');

    const bank = await api('POST', '/api/banks', {
      name: 'بانک ملت — جاری نمایش', account_number: '4587-221001', branch: 'شعبه احمدآباد مشهد',
    });
    await api('POST', '/api/cash-boxes', { name: 'صندوق فروشگاه نمایش' });

    let warehouses = [];
    try { warehouses = await api('GET', '/api/warehouses'); } catch { warehouses = []; }
    if (!Array.isArray(warehouses)) warehouses = warehouses.rows || [];
    if (warehouses.length < 1) {
      warehouses.push(await api('POST', '/api/warehouses', {
        name: 'انبار مرکزی نمایش', code: 'WH-DEMO-1', is_default: 1,
      }));
    }
    if (warehouses.length < 2) {
      const extra = await tryApi('POST', '/api/warehouses', { name: 'انبار نمایشگاه', code: 'WH-DEMO-2' });
      if (extra.ok) warehouses.push(extra.data);
    }
    const fgWh = warehouses.find((w) => w.is_default || w.warehouse_type === 'finished_goods') || warehouses[0];
    const fgWhId = fgWh && fgWh.id;

    const userIds = {};
    for (const u of DEMO_USERS) {
      const body = {
        name: u.name, username: u.username, password: presenterPass, role: u.role, phone: u.phone,
      };
      if (u.role === 'field_sales' && fgWhId) body.sales_warehouse_id = fgWhId;
      userIds[u.username] = (await api('POST', '/api/admin/users', body)).id;
    }
    const salesId = userIds.demo_sales;
    console.log('✓ users / treasury / warehouses');

    const suppliers = [];
    for (const name of ['پارچه‌سرای ابریشم', 'نساجی خاوران']) {
      suppliers.push((await api('POST', '/api/suppliers', { name, phone: `0513${rng.ri(1000000, 9999999)}` })).id);
    }

    const catalog = [
      { name: 'مانتو کرپ مدل آیلین', price: 18900000, cost: 9800000 },
      { name: 'مانتو لینن مدل رز', price: 16500000, cost: 8600000 },
      { name: 'شومیز حریر مدل ترمه', price: 7200000, cost: 3800000 },
      { name: 'شلوار مازراتی مدل نیلا', price: 6400000, cost: 3100000 },
      { name: 'پیراهن نخی مدل گلاره', price: 8100000, cost: 4200000 },
      { name: 'ست راحتی مدل یاس', price: 5400000, cost: 2700000 },
      { name: 'مانتو ژاکارد مدل افرا', price: 21400000, cost: 11200000 },
      { name: 'شال نخی مدل دلسا', price: 2100000, cost: 900000 },
    ];
    const products = [];
    for (let i = 0; i < catalog.length; i++) {
      const p = catalog[i];
      const row = await api('POST', '/api/products', {
        name: p.name, code: `D-${101 + i}`, category: 'پوشاک',
        price: p.price, cost: p.cost, stock: 0, unit: 'عدد', warehouse_id: fgWhId,
      });
      products.push({ id: row.id, price: p.price, cost: p.cost });
    }

    const purchase = await api('POST', '/api/purchases', {
      supplier_id: suppliers[0], date: daysAgo(20), warehouse_id: fgWhId, pay_type: 'credit',
      rows: products.map((pr) => ({ product_id: pr.id, qty: 20, price: pr.cost, warehouse_id: fgWhId })),
      note: 'خرید اولیه نمایش',
    });
    console.log('✓ suppliers / products / purchase stock');

    const shops = [
      { biz: 'بوتیک گلاره', owner: 'خانم احمدی', city: 'مشهد' },
      { biz: 'پوشاک نگین', owner: 'خانم رضایی', city: 'نیشابور' },
      { biz: 'مزون آوا', owner: 'خانم کریمی', city: 'سبزوار' },
      { biz: 'گالری سُها', owner: 'آقای موسوی', city: 'گرگان' },
      { biz: 'فروشگاه پرنیان', owner: 'خانم صادقی', city: 'مشهد' },
    ];
    const customers = [];
    for (const s of shops) {
      customers.push((await api('POST', '/api/customers', {
        ...s, phone: `0915${rng.ri(1000000, 9999999)}`, type: 'بوتیک', status: 'active',
        assigned_to: salesId, auto_followup: 0,
      })).id);
    }

    const stages = ['lead', 'contact', 'proposal', 'negotiation', 'won'];
    for (let i = 0; i < stages.length; i++) {
      await api('POST', '/api/followups', {
        cust_id: customers[i % customers.length], date: daysAgo(rng.ri(1, 12)),
        type: 'call', subject: 'پیگیری کالکشن نمایش', note: 'تماس نمایشی — داده ساختگی است.',
        status: i === 4 ? 'done' : 'open', priority: i < 2 ? 'high' : 'mid',
        pipeline_stage: stages[i], assigned_to: salesId,
      });
    }
    console.log('✓ customers / followups');

    const mkRows = (prod, qty) => [{ product_id: prod.id, qty, price: prod.price, warehouse_id: fgWhId }];
    await api('POST', '/api/invoices', {
      cust_id: customers[0], type: 'proforma', date: daysAgo(8), warehouse_id: fgWhId, pay_type: 'credit',
      rows: mkRows(products[2], 1),
    });
    await api('POST', '/api/invoices', {
      cust_id: customers[1], type: 'proforma', date: daysAgo(6), warehouse_id: fgWhId, pay_type: 'credit',
      rows: mkRows(products[3], 1),
    });
    const normals = [];
    for (let i = 0; i < 3; i++) {
      normals.push(await api('POST', '/api/invoices', {
        cust_id: customers[i], type: 'normal', date: daysAgo(5 - i), warehouse_id: fgWhId, pay_type: 'credit',
        rows: mkRows(products[0], 2), expert_user_id: salesId,
      }));
    }
    const finals = [];
    for (let i = 0; i < 2; i++) {
      finals.push(await api('POST', '/api/invoices', {
        cust_id: customers[i + 2], type: 'final', date: daysAgo(3 - i), warehouse_id: fgWhId, pay_type: 'credit',
        rows: mkRows(products[1], 2), expert_user_id: salesId,
      }));
    }
    console.log('✓ invoices: 2 proforma + 3 normal + 2 final');

    await api('POST', '/api/purchases/returns', {
      supplier_id: suppliers[0], purchase_invoice_id: purchase.id, date: daysAgo(2),
      note: 'برگشت نمایشی یک قلم',
      rows: [{ product_id: products[3].id, qty: 1, warehouse_id: fgWhId }],
    });
    await api('POST', '/api/accounting/sales-returns', {
      cust_id: finals[0].cust_id || customers[2], invoice_id: finals[0].id, warehouse_id: fgWhId, date: daysAgo(1),
      rows: [{ product_id: products[1].id, qty: 1 }],
    });
    const voided = await api('DELETE', `/api/invoices/${normals[2].id}`);
    if (!voided || voided.ok !== true) throw new Error('void invoice failed');
    console.log('✓ purchase return / sales return / void');

    const chequeClear = await api('POST', '/api/cheque-records', {
      direction: 'in', cheque_number: '880011', issue_date: daysAgo(18), receive_date: daysAgo(17),
      due_date: daysAgo(4), bank_name: 'ملت', party_id: (await api('GET', `/api/parties?search=${encodeURIComponent(shops[0].biz)}&limit=5`)).data[0].id,
      amount: 45000000,
      opening: true, note: 'چک وصول نمایش',
    });
    await api('POST', `/api/cheque-records/${chequeClear.id}/send-to-bank`, {
      collection_bank_id: bank.id, date: daysAgo(3),
    });
    await api('POST', `/api/cheque-records/${chequeClear.id}/clear`, { bank_id: bank.id, date: daysAgo(2) });

    const chequeBounce = await api('POST', '/api/cheque-records', {
      direction: 'in', cheque_number: '880022', issue_date: daysAgo(16), receive_date: daysAgo(15),
      due_date: daysAgo(3), bank_name: 'ملی', party_id: (await api('GET', `/api/parties?search=${encodeURIComponent(shops[1].biz)}&limit=5`)).data[0].id,
      amount: 28000000,
      opening: true, note: 'چک برگشتی نمایش',
    });
    await api('POST', `/api/cheque-records/${chequeBounce.id}/send-to-bank`, {
      collection_bank_id: bank.id, date: daysAgo(2),
    });
    await api('POST', `/api/cheque-records/${chequeBounce.id}/bounce`, { date: daysAgo(1) });
    await api('POST', `/api/cheque-records/${chequeBounce.id}/resend`, { date: today });
    console.log('✓ cheque lifecycle');

    const bomCreated = await tryApi('POST', '/api/production/boms', {
      product_id: products[6].id, name: 'فرمول مانتو افرا', base_qty: 1, yield_percent: 100,
      lines: [{ component_product_id: products[7].id, qty_per_base: 1, line_type: 'material' }],
    });
    if (!bomCreated.ok) {
      console.log('  (BOM skipped:', bomCreated.error && bomCreated.error.message, ')');
    } else {
      const bomId = bomCreated.data.id;
      const act = await tryApi('POST', `/api/production/boms/${bomId}/activate`, { valid_from: daysAgo(10) });
      if (!act.ok) console.log('  (BOM activate skipped:', act.error && act.error.message, ')');
      const po = await tryApi('POST', '/api/production/orders', {
        product_id: products[6].id, qty_planned: 2, bom_id: bomId, date: today,
        warehouse_fg_id: fgWhId, note: 'سفارش تولید نمایش',
      });
      if (!po.ok) console.log('  (production order skipped:', po.error && po.error.message, ')');
      else console.log('✓ BOM + production order');
    }

    let empCat = null;
    const cat = await tryApi('POST', '/api/persons/categories', { name: 'کارمند' });
    if (cat.ok) empCat = cat.data.id;
    const period = today.slice(0, 7);
    for (const s of [{ name: 'فاطمه یزدانی', rate: 850000 }, { name: 'علی رستمی', rate: 900000 }]) {
      const person = await api('POST', '/api/persons', {
        name: s.name, category_id: empCat || undefined, phone: `0915${rng.ri(1000000, 9999999)}`,
        hourly_rate: s.rate, overtime_rate: Math.round(s.rate * 1.4),
      });
      await api('POST', '/api/payroll', {
        person_id: person.id, period_label: period, regular_hours: 176, overtime_hours: 8,
        hourly_rate: s.rate, overtime_rate: Math.round(s.rate * 1.4),
        bonuses: 0, insurance_deduction: 2400000, tax_deduction: 800000, date: today,
      });
    }
    console.log('✓ payroll');
  })();

  try {
    await Promise.race([
      work,
      sleep(timeoutMs).then(() => {
        throw Object.assign(new Error('seed timed out'), { code: 'DEMO_SEED_TIMEOUT' });
      }),
    ]);
    if (Date.now() - started > timeoutMs) {
      throw Object.assign(new Error('seed timed out'), { code: 'DEMO_SEED_TIMEOUT' });
    }
  } catch (e) {
    if (stderr) console.error(redact(stderr).slice(-2000));
    throw e;
  } finally {
    await killProcessTree(child, { graceMs: 2000 });
  }

  const rotatedAdmin = generatePassword();
  const sqlite = new Database(dbPath);
  try {
    sqlite.prepare(
      "UPDATE users SET password=?, must_change_password=1 WHERE username='admin'"
    ).run(bcrypt.hashSync(rotatedAdmin, 10));
    sqlite.prepare('UPDATE users SET auth_epoch=COALESCE(auth_epoch,0)+1').run();
    sqlite.prepare(`
      UPDATE users SET must_change_password=0
      WHERE username IN ('demo_manager','demo_accountant','demo_sales','demo_production')
    `).run();
    try { sqlite.prepare('DELETE FROM staff_sessions').run(); } catch { /* optional */ }
    const sessionDb = process.env.AUTH_SESSION_DB_PATH || path.join(demoRoot, 'auth-sessions.db');
    try {
      const { exactSqliteSidecars, assertSafeDeleteTarget } = require('../../lib/demo-paths');
      for (const f of exactSqliteSidecars(sessionDb)) {
        if (!fs.existsSync(f)) continue;
        const abs = assertSafeDeleteTarget(demoRoot, f);
        fs.unlinkSync(abs);
      }
    } catch { /* session store absent or outside demo root */ }
  } finally {
    sqlite.close();
  }

  const secretsPath = writeSecretsFile(demoRoot, {
    generated_at: new Date().toISOString(),
    presenter_usernames: DEMO_USERS.map((u) => u.username),
    presenter_password: presenterPass,
    note: 'Presenter login only. Bootstrap admin is in operator-admin.json — do not project this file.',
  });
  const operatorPath = writeSecretsFile(demoRoot, {
    generated_at: new Date().toISOString(),
    bootstrap_admin_username: 'admin',
    bootstrap_admin_password: rotatedAdmin,
    note: 'Operator-only. Never print, commit, or project these values.',
  }, 'operator-admin.json');
  console.log('==> credentials written (not printed):', secretsPath);
  console.log('==> operator admin file written (not printed):', operatorPath);

  const inv = validateDemoInvariants(dbPath);
  const fails = inv.failures || inv.errors || [];
  if (!inv.ok) {
    throw Object.assign(new Error('demo invariants failed: ' + fails.join('; ')), {
      code: 'DEMO_INVARIANTS',
      failures: fails,
    });
  }
  console.log('==> demo-v2 seed ready:', dbPath);
  return { dbPath, secretsPath, secretsFile: secretsPath, invariants: inv };
}

module.exports = {
  DEMO_USERS,
  generatePassword,
  presenterPassword,
  resolveDemoRoot,
  seedDemoV2,
  validatePresenterPassword,
  writeSecretsFile,
};
