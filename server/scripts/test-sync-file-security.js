'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-sync-files-'));
process.env.UPLOADS_DIR = path.join(testRoot, 'public-uploads');
process.env.PRIVATE_UPLOADS_DIR = path.join(testRoot, 'private-uploads');

const Database = require('better-sqlite3');
const sharp = require('sharp');
const {
  PRIVATE_UPLOADS_ROOT,
} = require('../lib/private-uploads');
const {
  collectNeededFiles,
  pullOneFile,
  skipMissingFile,
  isReferencedFile,
  parseFileReference,
  resolveReferencedFile,
  localFilePath,
  uploadFallbackMiddleware,
  _test,
} = require('../sync/files');

let passed = 0;
let failed = 0;

function ok(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function rejects(name, action, expectedCode) {
  try {
    await action();
    ok(name, false, 'no error was raised');
  } catch (error) {
    ok(name, error && error.code === expectedCode, `received ${error && (error.code || error.message)}`);
  }
}

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE products (id INTEGER PRIMARY KEY, image TEXT);
    CREATE TABLE product_images (id INTEGER PRIMARY KEY, filename TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, image TEXT);
    CREATE TABLE journal_entries (id INTEGER PRIMARY KEY, attachment TEXT);
    CREATE TABLE rep_payment_submissions (id INTEGER PRIMARY KEY, receipt_file TEXT);
    CREATE TABLE rep_expenses (id INTEGER PRIMARY KEY, receipt_file TEXT);
    CREATE TABLE users (id INTEGER PRIMARY KEY, contract_file TEXT);
    CREATE TABLE rep_visit_logs (id INTEGER PRIMARY KEY, photo_file TEXT, signature_file TEXT);
  `);
  return db;
}

async function runMiddleware(middleware, request) {
  let nextCalls = 0;
  const response = {
    end() {},
    sendFile() { throw new Error('sendFile must not run in this negative test'); },
  };
  await middleware(request, response, () => { nextCalls += 1; });
  return nextCalls;
}

async function main() {
  console.log('\n══ P0-S3 sync file authorization / private storage ══\n');
  const db = createDb();
  const originalFetch = global.fetch;
  try {
    fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });
    fs.mkdirSync(PRIVATE_UPLOADS_ROOT, { recursive: true });
    const image = await sharp({
      create: { width: 16, height: 12, channels: 4, background: '#78350f' },
    }).webp().toBuffer();

    ok('مسیر محصول زیر uploads عمومی باقی می‌ماند',
      localFilePath('products', 'p_public.webp').startsWith(path.resolve(process.env.UPLOADS_DIR) + path.sep));
    ok('مسیر پیام/سند/نماینده زیر PRIVATE_UPLOADS_ROOT است',
      ['messages', 'vouchers', 'reps'].every((category) =>
        localFilePath(category, `${category}.webp`).startsWith(path.resolve(PRIVATE_UPLOADS_ROOT) + path.sep)));
    ok('path traversal، مسیر چندبخشی و percent-encoding رد می‌شوند',
      !parseFileReference('messages/../secret.webp')
      && !parseFileReference('messages/a/b.webp')
      && !parseFileReference('messages/%2e%2e.webp'));

    const privateMessageDir = path.join(PRIVATE_UPLOADS_ROOT, 'messages');
    fs.mkdirSync(privateMessageDir, { recursive: true });
    fs.writeFileSync(path.join(privateMessageDir, 'guessed.webp'), image);
    ok('فایل موجود ولی بدون مرجع DB قابل enumerate/resolve نیست',
      !isReferencedFile(db, 'messages', 'guessed.webp')
      && resolveReferencedFile(db, 'messages', 'guessed.webp') === null);

    db.prepare('INSERT INTO messages (image) VALUES (?)').run('authorized.webp');
    fs.writeFileSync(path.join(privateMessageDir, 'authorized.webp'), image);
    ok('فایل خصوصی فقط پس از مرجع واقعی DB resolve می‌شود',
      resolveReferencedFile(db, 'messages', 'authorized.webp') === path.join(privateMessageDir, 'authorized.webp'));

    const legacyMessageDir = path.join(process.env.UPLOADS_DIR, 'messages');
    fs.mkdirSync(legacyMessageDir, { recursive: true });
    const legacyPath = path.join(legacyMessageDir, 'legacy.webp');
    fs.writeFileSync(legacyPath, image);
    db.prepare('INSERT INTO messages (image) VALUES (?)').run('legacy.webp');
    const migratedPath = resolveReferencedFile(db, 'messages', 'legacy.webp');
    ok('legacy حساس فقط بعد از DB-reference از public به private مهاجرت می‌کند',
      migratedPath === path.join(privateMessageDir, 'legacy.webp')
      && fs.existsSync(migratedPath) && !fs.existsSync(legacyPath));

    db.prepare('INSERT INTO users (contract_file) VALUES (?)').run('contract.pdf');
    db.prepare('INSERT INTO rep_visit_logs (photo_file,signature_file) VALUES (?,?)')
      .run('visit.webp', 'signature.webp');
    const needed = collectNeededFiles(db).map((file) => `${file.subdir}/${file.name}`);
    ok('قرارداد، عکس بازدید و امضا در inventory همگام‌سازی فایل پوشش دارند',
      needed.includes('reps/contract.pdf')
      && needed.includes('reps/visit.webp')
      && needed.includes('reps/signature.webp'));

    const cfg = { centralUrl: 'https://central.example', deviceId: 7, deviceToken: 'test-device-token' };
    let fetchCalls = 0;
    global.fetch = async () => {
      fetchCalls += 1;
      return new Response('', { status: 404 });
    };
    ok('pull مستقیم نام حدس‌زده‌شده پیش از شبکه رد می‌شود',
      await pullOneFile(db, cfg, 'products', 'not-referenced.webp') === false && fetchCalls === 0);

    const fallback = uploadFallbackMiddleware(() => cfg, () => db);
    const nextCalls = await runMiddleware(fallback, { method: 'GET', path: '/products/not-referenced.webp' });
    ok('fallback عمومی نیز نام بدون DB-reference را به مرکز ارسال نمی‌کند', nextCalls === 1 && fetchCalls === 0);

    db.prepare('INSERT INTO products (image) VALUES (?)').run('missing.webp');
    const firstMissing = await pullOneFile(db, cfg, 'products', 'missing.webp');
    const secondMissing = await pullOneFile(db, cfg, 'products', 'missing.webp');
    ok('404 مرکز وارد حلقه درخواست فوری نمی‌شود (negative cache)',
      firstMissing === false && secondMissing === false && fetchCalls === 1);

    db.prepare('INSERT INTO products (image) VALUES (?)').run('download.webp');
    global.fetch = async () => {
      fetchCalls += 1;
      return new Response(image, {
        status: 200,
        headers: { 'content-type': 'image/webp', 'content-length': String(image.length) },
      });
    };
    const productPulled = await pullOneFile(db, cfg, 'products', 'download.webp');
    ok('محصول reference‌شده پس از magic/decode check اتمیک در public ذخیره می‌شود',
      productPulled && fs.readFileSync(localFilePath('products', 'download.webp')).equals(image));

    db.prepare('INSERT INTO messages (image) VALUES (?)').run('download-private.webp');
    const privatePulled = await pullOneFile(db, cfg, 'messages', 'download-private.webp');
    ok('پیام reference‌شده فقط در private ذخیره می‌شود',
      privatePulled
      && fs.existsSync(localFilePath('messages', 'download-private.webp'))
      && !fs.existsSync(path.join(process.env.UPLOADS_DIR, 'messages', 'download-private.webp')));

    db.prepare('INSERT INTO products (image) VALUES (?)').run('bad-magic.webp');
    global.fetch = async () => new Response(Buffer.from('<html>not an image</html>'), {
      status: 200,
      headers: { 'content-type': 'image/webp' },
    });
    await rejects('پاسخ مرکز با magic/MIME جعلی ذخیره نمی‌شود',
      () => pullOneFile(db, cfg, 'products', 'bad-magic.webp'), 'UPLOAD_KIND_REJECTED');
    ok('شکست اعتبارسنجی فایل ناقص/orphan باقی نمی‌گذارد',
      !fs.existsSync(localFilePath('products', 'bad-magic.webp')));

    db.prepare('INSERT INTO journal_entries (attachment) VALUES (?)').run('oversize.pdf');
    global.fetch = async () => new Response('x', {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-length': String(9 * 1024 * 1024) },
    });
    await rejects('Content-Length بیش از سقف پیش از buffer شدن رد می‌شود',
      () => pullOneFile(db, cfg, 'vouchers', 'oversize.pdf'), 'SYNC_FILE_SIZE_REJECTED');
    ok('پاسخ oversized هیچ فایل مقصدی ایجاد نمی‌کند',
      !fs.existsSync(localFilePath('vouchers', 'oversize.pdf')));

    db.prepare('INSERT INTO products (image) VALUES (?)').run('skip-me.webp');
    ok('فقط فایل reference‌شده قابل skip است و نام حدس‌زده‌شده نیست',
      skipMissingFile(db, 'products', 'skip-me.webp') === true
      && skipMissingFile(db, 'products', 'unknown.webp') === false);
    ok('skip پایدار، فایل مفقود را از چرخه pull بعدی خارج می‌کند',
      !collectNeededFiles(db).some((file) => file.subdir === 'products' && file.name === 'skip-me.webp'));

    ok('نوشتن اتمیک فایل موقت باقی نمی‌گذارد',
      !fs.readdirSync(path.join(process.env.UPLOADS_DIR, 'products')).some((name) => name.startsWith('.sync-')));
    _test.negativeMissingFiles.clear();
  } finally {
    global.fetch = originalFetch;
    db.close();
    try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch { /* exact test temp root */ }
  }

  console.log(`\n${failed ? '❌' : '🎉'} ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  failed += 1;
  console.error('  ❌ unexpected failure:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
  try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch { /* exact test temp root */ }
});
