'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const sharp = require('sharp');
const XLSX = require('xlsx');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-wave0-upload-'));
process.env.PRIVATE_UPLOADS_DIR = path.join(tempRoot, 'private');

const {
  PROFILES,
  validateUploadedFile,
  createSecureUpload,
  assertNoClientFileReferences,
} = require('../lib/upload-policy');
const {
  PRIVATE_UPLOADS_ROOT,
  persistPrivateUpload,
  persistPrivateUploadWithCommit,
  blockSensitivePublicUploads,
} = require('../lib/private-uploads');
const {
  validateOutboundUrl,
  assertPublicAddress,
  resolvePublicTarget,
  safeRequestJSON,
  sanitizeRedirectHeaders,
  _test: outboundTest,
} = require('../lib/safe-outbound-request');
const {
  validateRelayUserId,
  matchMultipartRelay,
  selectClientRelayField,
} = require('../sync/multipart-policy');

let passed = 0;
let failed = 0;

function ok(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function rejects(name, fn, code) {
  try {
    await fn();
    ok(name, false, 'خطایی رخ نداد');
  } catch (error) {
    ok(name, String(error.code || error.message).includes(code), `دریافت: ${error.code || error.message}`);
  }
}

function file(buffer, originalname, mimetype) {
  return { buffer, size: buffer.length, originalname, mimetype, fieldname: 'file' };
}

async function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

async function close(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
}

async function main() {
  console.log('\n══ P0-S3 upload / SSRF / multipart relay security ══\n');

  const png = await sharp({ create: { width: 20, height: 10, channels: 4, background: '#7c3aed' } }).png().toBuffer();
  const validImage = await validateUploadedFile(file(png, 'receipt.png', 'image/png'), 'messageImage');
  ok('تصویر واقعی decode و به WebP بدون metadata بازنویسی می‌شود',
    validImage.uploadValidated && validImage.mimetype === 'image/webp'
      && validImage.buffer.toString('ascii', 0, 4) === 'RIFF');

  await rejects('PNG polyglot با payload انتهایی رد می‌شود',
    () => validateUploadedFile(file(Buffer.concat([png, Buffer.from('<script>alert(1)</script>')]), 'evil.png', 'image/png'), 'messageImage'),
    'UPLOAD_POLYGLOT');
  await rejects('MIME جعلی مخالف magic-byte رد می‌شود',
    () => validateUploadedFile(file(png, 'photo.png', 'text/plain'), 'messageImage'),
    'UPLOAD_MIME_MISMATCH');
  await rejects('نام traversal حتی با storage حافظه‌ای رد می‌شود',
    () => validateUploadedFile(file(png, '../photo.png', 'image/png'), 'messageImage'),
    'UPLOAD_PATH_TRAVERSAL');
  await rejects('فایل بزرگ‌تر از سقف قبل از decode رد می‌شود',
    () => validateUploadedFile(file(Buffer.alloc(PROFILES.messageImage.maxBytes + 1), 'large.jpg', 'image/jpeg'), 'messageImage'),
    'UPLOAD_TOO_LARGE');

  const hugeDimension = await sharp({ create: { width: 10_001, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer();
  await rejects('تصویر با عرض بیش از سقف dimension رد می‌شود',
    () => validateUploadedFile(file(hugeDimension, 'wide.png', 'image/png'), 'messageImage'),
    'UPLOAD_IMAGE_DIMENSIONS');

  const benignPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'latin1');
  const safePdf = await validateUploadedFile(file(benignPdf, 'contract.pdf', 'application/pdf'), 'document');
  ok('PDF ساده با magic/MIME/EOF معتبر پذیرفته می‌شود', safePdf.detectedKind === 'pdf' && safePdf.extension === '.pdf');
  const activePdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Open#41ction 2 0 R /JavaScript (x) >>\nendobj\n%%EOF\n', 'latin1');
  await rejects('PDF دارای OpenAction/JavaScript حتی با hex escape رد می‌شود',
    () => validateUploadedFile(file(activePdf, 'active.pdf', 'application/pdf'), 'document'),
    'UPLOAD_ACTIVE_PDF');
  const opaquePdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /ObjStm >>\nendobj\n%%EOF\n', 'latin1');
  await rejects('PDF دارای object stream غیرقابل بازرسی fail-closed می‌شود',
    () => validateUploadedFile(file(opaquePdf, 'opaque.pdf', 'application/pdf'), 'document'),
    'UPLOAD_UNINSPECTABLE_PDF');

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['name'], ['safe']]), 'Sheet1');
  const xlsx = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const safeXlsx = await validateUploadedFile(file(xlsx, 'import.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'xlsx');
  ok('XLSX واقعی با workbook داخلی پذیرفته می‌شود', safeXlsx.detectedKind === 'xlsx');
  await rejects('فایل متن با نام/MIME اکسل (magic mismatch) رد می‌شود',
    () => validateUploadedFile(file(Buffer.from('not a workbook'), 'fake.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'xlsx'),
    'UPLOAD_KIND_REJECTED');
  await rejects('XLSX دارای payload پس از EOCD به‌عنوان polyglot رد می‌شود',
    () => validateUploadedFile(file(Buffer.concat([xlsx, Buffer.from('<html>')]), 'poly.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'xlsx'),
    'UPLOAD_POLYGLOT');

  const columns = Array.from({ length: 33 }, (_, index) => index === 0 ? 'employeeNo' : `c${index}`);
  const values = Array.from({ length: 33 }, (_, index) => String(index + 1));
  const lwte = Buffer.from(`${columns.join('\t')}\r\n${values.join('\t')}\r\n`, 'utf8');
  const safeLwte = await validateUploadedFile(file(lwte, 'attendance.lwte', 'text/plain'), 'lwte');
  ok('فایل LWTE فقط با grammar متنی tabular پذیرفته می‌شود', safeLwte.detectedKind === 'lwte');
  await rejects('LWTE باینری/بدون ستون کافی رد می‌شود',
    () => validateUploadedFile(file(Buffer.from([0, 1, 2, 3]), 'bad.lwte', 'application/octet-stream'), 'lwte'),
    'UPLOAD_BAD_LWTE');

  await rejects('مرجع receipt_file جعل‌شده از body رد می‌شود',
    async () => assertNoClientFileReferences({ receipt_file: '../../x' }, ['receipt_file']),
    'UPLOAD_FORGED_REFERENCE');

  const storedName = persistPrivateUpload(validImage, 'messages', 'msg');
  const storedPath = path.join(PRIVATE_UPLOADS_ROOT, 'messages', storedName);
  const publicRoot = path.resolve(__dirname, '..', 'public');
  ok('فایل حساس با نام تصادفی و خارج از public ذخیره می‌شود',
    fs.existsSync(storedPath) && !storedName.includes('receipt')
      && !PRIVATE_UPLOADS_ROOT.startsWith(publicRoot + path.sep));
  const beforeRollback = fs.readdirSync(path.join(PRIVATE_UPLOADS_ROOT, 'messages')).length;
  await rejects('شکست DB/commit فایل خصوصی تازه را rollback می‌کند', async () => {
    persistPrivateUploadWithCommit(validImage, 'messages', 'msg', () => {
      const error = new Error('simulated database failure');
      error.code = 'SIMULATED_DB_FAILURE';
      throw error;
    });
  }, 'SIMULATED_DB_FAILURE');
  ok('پس از rollback فایل orphan باقی نمی‌ماند',
    fs.readdirSync(path.join(PRIVATE_UPLOADS_ROOT, 'messages')).length === beforeRollback);

  const staticRoot = path.join(tempRoot, 'public');
  fs.mkdirSync(path.join(staticRoot, 'uploads', 'messages'), { recursive: true });
  fs.mkdirSync(path.join(staticRoot, 'uploads', 'products'), { recursive: true });
  fs.writeFileSync(path.join(staticRoot, 'uploads', 'messages', 'legacy.webp'), validImage.buffer);
  fs.writeFileSync(path.join(staticRoot, 'uploads', 'products', 'p_safe.webp'), validImage.buffer);
  fs.writeFileSync(path.join(staticRoot, 'uploads', 'products', 'evil.svg'), '<svg onload=alert(1)>');
  const app = express();
  app.post('/api/image', createSecureUpload('messageImage').single('file'), (req, res) => res.json({ mime: req.file.mimetype }));
  app.use('/uploads', blockSensitivePublicUploads);
  app.use(express.static(staticRoot));
  app.use((_req, res) => res.sendStatus(404));
  const server = await listen(app);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const privateResponse = await fetch(`${base}/uploads/messages/legacy.webp`);
    ok('مسیر عمومی legacy پیام حتی اگر فایل موجود باشد 404 است', privateResponse.status === 404);
    const productResponse = await fetch(`${base}/uploads/products/p_safe.webp`);
    ok('فقط تصویر محصول با basename/پسوند امن عمومی است', productResponse.status === 200);
    const svgResponse = await fetch(`${base}/uploads/products/evil.svg`);
    ok('SVG/HTML در uploads محصولات fail-closed است', svgResponse.status === 404);
    const privateRootResponse = await fetch(`${base}/private-uploads/messages/${storedName}`);
    ok('مسیر private-uploads از static public قابل دریافت نیست', privateRootResponse.status === 404);
    const postProduct = await fetch(`${base}/uploads/products/p_safe.webp`, { method: 'POST' });
    ok('method غیر GET/HEAD روی uploads عمومی رد می‌شود', postProduct.status === 404);

    const goodForm = new FormData();
    goodForm.append('file', new Blob([png], { type: 'image/png' }), 'good.png');
    const goodUpload = await fetch(`${base}/api/image`, { method: 'POST', body: goodForm });
    const goodBody = await goodUpload.json();
    ok('middleware واقعی multipart فایل معتبر را normalize می‌کند', goodUpload.status === 200 && goodBody.mime === 'image/webp');
    const badForm = new FormData();
    badForm.append('file', new Blob([Buffer.concat([png, Buffer.from('<script>')])], { type: 'image/png' }), 'bad.png');
    const badUpload = await fetch(`${base}/api/image`, { method: 'POST', body: badForm });
    ok('middleware واقعی multipart polyglot را با 400 رد می‌کند', badUpload.status === 400);
  } finally {
    await close(server);
  }

  for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '::1', '::ffff:127.0.0.1',
    '64:ff9b::7f00:1', '64:ff9b:1::1', '2001::1', '2002:7f00:1::']) {
    await rejects(`SSRF IP غیرعمومی/transition رد می‌شود: ${address}`,
      async () => assertPublicAddress(address), 'OUTBOUND_PRIVATE_ADDRESS');
  }
  ok('IPv4 و IPv6 global-unicast پذیرفته می‌شوند',
    assertPublicAddress('93.184.216.34') === 4 && assertPublicAddress('2606:4700:4700::1111') === 6);
  await rejects('HTTP خروجی رد می‌شود', async () => validateOutboundUrl('http://example.com/hook'), 'OUTBOUND_HTTPS_REQUIRED');
  await rejects('credential داخل URL رد می‌شود', async () => validateOutboundUrl('https://u:p@example.com/hook'), 'OUTBOUND_CREDENTIALS_REJECTED');
  await rejects('پورت غیر 443 رد می‌شود', async () => validateOutboundUrl('https://example.com:8443/hook'), 'OUTBOUND_PORT_REJECTED');
  await rejects('IPv6 literal خصوصی در خود URL پیش از DNS رد می‌شود',
    async () => validateOutboundUrl('https://[::1]/hook'), 'OUTBOUND_PRIVATE_ADDRESS');
  const directIpv6 = await resolvePublicTarget('https://[2606:4700:4700::1111]/hook');
  ok('IPv6 literal عمومی بدون DNS و با hostname بدون bracket pin می‌شود',
    directIpv6.family === 6 && directIpv6.hostname === '2606:4700:4700::1111');
  await rejects('DNS rebinding با حتی یک پاسخ private رد می‌شود',
    () => resolvePublicTarget('https://rebind.example/hook', async () => [
      { address: '93.184.216.34', family: 4 }, { address: '10.0.0.8', family: 4 },
    ]), 'OUTBOUND_PRIVATE_ADDRESS');
  const pinned = await resolvePublicTarget('https://pin.example/hook', async () => [{ address: '93.184.216.34', family: 4 }]);
  ok('DNS عمومی به IP بازرسی‌شده pin می‌شود', pinned.address === '93.184.216.34' && pinned.url.hostname === 'pin.example');

  let redirectDispatches = 0;
  await rejects('redirect به loopback پیش از dispatch دوم دوباره validate و رد می‌شود',
    () => safeRequestJSON('https://public.example/hook', 'POST', { ok: true }, {}, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      dispatch: async () => {
        redirectDispatches += 1;
        return { status: 302, headers: { location: 'https://127.0.0.1/private' }, body: '' };
      },
    }), 'OUTBOUND_PRIVATE_ADDRESS');
  ok('redirect خصوصی فقط یک dispatch داشته است', redirectDispatches === 1);

  const seenHeaders = [];
  await safeRequestJSON('https://one.example/hook', 'POST', { ok: true }, {
    Authorization: 'Basic safe-test', 'X-Webhook-Secret': 'safe-test', Host: '127.0.0.1',
    Connection: 'keep-alive', 'Content-Length': '1', 'Transfer-Encoding': 'chunked',
  }, {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    dispatch: async (_target, request) => {
      seenHeaders.push(request.headers);
      if (seenHeaders.length === 1) return { status: 307, headers: { location: 'https://two.example/next' }, body: '' };
      return { status: 200, headers: {}, body: '{}' };
    },
  });
  ok('Host/Content-Length/Connection/Transfer-Encoding caller حذف می‌شوند',
    !Object.keys(outboundTest.sanitizeCallerHeaders({ Host: 'x', 'Content-Length': '1', Connection: 'x', 'Transfer-Encoding': 'x' })).length);
  ok('credential headers روی redirect بین originها حذف می‌شوند',
    seenHeaders.length === 2 && !seenHeaders[1].Authorization && !seenHeaders[1]['X-Webhook-Secret']);
  ok('sanitizeRedirectHeaders credential را فقط برای same-origin نگه می‌دارد',
    sanitizeRedirectHeaders({ Authorization: 'x' }, new URL('https://a.example/x'), new URL('https://a.example/y')).Authorization === 'x');

  const relayOk = matchMultipartRelay({
    path: '/api/accounting/vouchers/42/attachment', method: 'POST', field: 'file', userId: 7, userRole: 'accounting',
  });
  ok('sync multipart فقط rule دقیق path/method/field/role را می‌پذیرد', relayOk.name === 'voucher-attachment');
  await rejects('sync multipart method خارج allowlist رد می‌شود',
    async () => matchMultipartRelay({ path: '/api/accounting/vouchers/42/attachment', method: 'DELETE', field: 'file', userId: 7, userRole: 'accounting' }),
    'SYNC_MULTIPART_METHOD_REJECTED');
  await rejects('sync multipart field اشتباه رد می‌شود',
    async () => matchMultipartRelay({ path: '/api/accounting/vouchers/42/attachment', method: 'POST', field: 'image', userId: 7, userRole: 'accounting' }),
    'SYNC_MULTIPART_RULE_REJECTED');
  await rejects('sync multipart role اشتباه رد می‌شود',
    async () => matchMultipartRelay({ path: '/api/accounting/vouchers/42/attachment', method: 'POST', field: 'file', userId: 7, userRole: 'field_sales' }),
    'SYNC_MULTIPART_ROLE_REJECTED');
  await rejects('sync multipart path encoded/traversal رد می‌شود',
    async () => matchMultipartRelay({ path: '/api/products/%2e%2e/settings', method: 'POST', field: 'image', userId: 7, userRole: 'admin' }),
    'SYNC_MULTIPART_PATH_REJECTED');
  await rejects('sync multipart user_id با canonical integer نبودن رد می‌شود',
    async () => validateRelayUserId('007'), 'SYNC_MULTIPART_USER_REJECTED');
  ok('کلاینت sync فقط field قطعی allowlist را انتخاب می‌کند',
    selectClientRelayField('/api/reps/payments', 'POST').field === 'receipt');
  await rejects('کلاینت sync برای route چندفیلدی مبهم fail-closed است',
    async () => selectClientRelayField('/api/reps/12/visits', 'POST'), 'SYNC_MULTIPART_AMBIGUOUS_FIELD');

  console.log(`\n${failed ? '❌' : '🎉'} ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((error) => {
    failed += 1;
    console.error('  ❌ خطای پیش‌بینی‌نشده:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* exact temp test root */ }
  });
