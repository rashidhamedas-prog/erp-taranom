const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const { initDB, getDB, isDevice } = require('./db');
const { todayJalali, nowHHMM } = require('./jalali');
const { sendSMS } = require('./sms');
const { hashKey } = require('./routes/api_keys');
const { runBackup, listBackups, resolveBackupFile, getLatestBackupFile, restoreBackup } = require('./backup');
const { assertSecurityConfig } = require('./lib/security');

const app = express();
app.set('trust proxy', 1); // trust Nginx reverse proxy
const PORT = process.env.PORT || 3000;

// Gzip compression — shrinks JSON/HTML responses for faster load (graceful if not installed)
try {
  const compression = require('compression');
  app.use(compression());
} catch { /* compression optional — run without it if the module is missing */ }

// Ensure uploads directory exists
const { UPLOADS_ROOT } = require('./paths');
for (const sub of ['products', 'messages', 'vouchers', 'reps']) {
  fs.mkdirSync(path.join(UPLOADS_ROOT, sub), { recursive: true });
}

// Security headers (helmet if available, manual fallback)
let helmet = null;
try { helmet = require('helmet'); } catch {}
if (helmet) {
  app.use(helmet({
    contentSecurityPolicy: false, // SPA manages its own CSP
    crossOriginEmbedderPolicy: false,
  }));
} else {
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '0'); // modern browsers ignore it; rely on CSP
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
  });
}

// CORS — restrict to same origin in production, allow dev origins
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    // Same-origin requests (origin===undefined) and explicitly listed origins are allowed
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('CORS origin not allowed'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Barcode wedge/debounce helpers (browser + unit tests share this file)
app.get('/barcode-input.js', (req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname, 'lib', 'barcode-input.js'));
});

// Static assets (includes /logo.png if present; /uploads served separately below)
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('assetlinks.json')) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));
// Device builds: pull missing uploads from central on first request
if (isDevice()) {
  const { uploadFallbackMiddleware } = require('./sync/files');
  const { getConfig } = require('./sync/client');
  const { getDB } = require('./db');
  app.use('/uploads', uploadFallbackMiddleware(() => getConfig(getDB())));
}
// Uploaded images are content-addressed by unique filename → safe to cache long-term
app.use('/uploads', express.static(UPLOADS_ROOT, {
  maxAge: '30d',
  immutable: true,
}));

// Per-process secret marking loopback replay requests (sync engine): the
// central push endpoint re-executes device operations against its own routes;
// those internal requests must not consume the public rate-limit budget.
const INTERNAL_REPLAY_TOKEN = crypto.randomBytes(24).toString('hex');
app.set('internalReplayToken', INTERNAL_REPLAY_TOKEN);

// General API rate limit (generous — protects against runaway loops)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 1000, standardHeaders: true, legacyHeaders: false,
  skip: (req) => req.headers['x-internal-replay'] === INTERNAL_REPLAY_TOKEN
});
app.use('/api', limiter);

// Strict rate limit on authentication endpoints — brute-force protection
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'تعداد تلاش‌های ورود بیش از حد مجاز است. ۱۵ دقیقه دیگر تلاش کنید.' },
  skipSuccessfulRequests: true,
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/forgot', authLimiter);
app.use('/api/auth/forgot-reset', authLimiter);
app.use('/api/auth/2fa/verify', authLimiter);
app.use('/api/auth/2fa/recovery-code', authLimiter);
app.use('/api/b2b/auth', authLimiter);

assertSecurityConfig();
initDB();

// Device builds record every successful mutating API call into the sync
// outbox for later replay against central (see sync/capture.js).
if (isDevice()) {
  const { captureMiddleware } = require('./sync/capture');
  app.use(captureMiddleware);
}

app.use('/api/sync', require('./routes/sync'));
app.use('/api/auth/2fa', require('./routes/twofa'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/search', require('./routes/search'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/fiscal-year', require('./routes/fiscal-year'));
app.use('/api/rbac', require('./routes/rbac'));
app.use('/api/b2b', require('./routes/b2b'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/followups', require('./routes/followups'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/products', require('./routes/products'));
app.use('/api/product-categories', require('./routes/product-categories'));
app.use('/api/party-groups', require('./routes/party-groups'));
app.use('/api/admin', require('./routes/admin'));

// Manual backup endpoint — registered before admin router catch-all.
// Central-only: device/desktop builds sync data but cannot dump the DB here.
const { auth, adminOnly, centralOnly } = require('./middleware/auth');
app.post('/api/admin/backup-now', auth, adminOnly, centralOnly, async (req, res) => {
  const result = await runBackup();
  res.json({ ...result, role: 'central' });
});

app.get('/api/admin/backups', auth, adminOnly, centralOnly, (req, res) => {
  res.json(listBackups());
});

app.get('/api/admin/backup-download', auth, adminOnly, centralOnly, async (req, res) => {
  let filePath = getLatestBackupFile();
  if (!fs.existsSync(filePath)) {
    const result = await runBackup();
    if (!result.ok) return res.status(500).json({ error: result.error });
    filePath = getLatestBackupFile();
  }
  const base = path.basename(filePath);
  res.download(filePath, base);
});

app.get('/api/admin/backup-download/:name', auth, adminOnly, centralOnly, (req, res) => {
  const filePath = resolveBackupFile(req.params.name);
  if (!filePath) return res.status(404).json({ error: 'فایل پشتیبان یافت نشد' });
  res.download(filePath, req.params.name);
});

const multer = require('multer');
const backupUpload = multer({ dest: path.join(__dirname, 'backups'), limits: { fileSize: 512 * 1024 * 1024 } });
app.post('/api/admin/backup-restore', auth, adminOnly, centralOnly, backupUpload.single('backup'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایل پشتیبان الزامی است' });
  try {
    const result = restoreBackup(req.file.path);
    try { fs.unlinkSync(req.file.path); } catch { /* */ }
    res.json({ success: true, data: result, message: 'بازیابی انجام شد — PM2 را مجدداً راه‌اندازی کنید' });
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch { /* */ }
    res.status(500).json({ error: e.message || 'خطا در بازیابی' });
  }
});

app.use('/api/import', require('./routes/import'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/reminders', require('./routes/reminders'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/reps', require('./routes/rep-management'));
app.use('/api/accounting', require('./routes/accounting'));
app.use('/api/suppliers', require('./routes/suppliers'));
app.use('/api/purchases', require('./routes/purchases'));
app.use('/api/banks', require('./routes/banks'));
app.use('/api/check-categories', require('./routes/check-categories'));
app.use('/api/cash-boxes', require('./routes/cash-boxes'));
app.use('/api/transfers', require('./routes/transfers'));
app.use('/api/expenses', require('./routes/expenses'));
app.use('/api/persons', require('./routes/persons'));
app.use('/api/trust-checks', require('./routes/trust-checks'));
app.use('/api/cheque-records', require('./routes/cheque-records'));
app.use('/api/warehouses', require('./routes/warehouses'));
app.use('/api/stocktaking', require('./routes/stocktaking'));
app.use('/api/consignments', require('./routes/consignments'));
app.use('/api/adv-reports', require('./routes/adv-reports'));
app.use('/api/production', require('./routes/production'));
app.use('/api/payroll', require('./routes/payroll'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/parties', require('./routes/parties'));
app.use('/api/detail-accounts', require('./routes/detail-accounts'));
app.use('/api/units', require('./routes/units'));
app.use('/api/moadian', require('./routes/moadian'));
app.use('/api/fixed-assets', require('./routes/fixed-assets'));
app.use('/api/activity-log', require('./routes/activity-log'));
app.use('/api/api-keys', require('./routes/api_keys').router);
app.use('/api/v1', require('./routes/api_v1'));

// Server time endpoint — returns Unix timestamp (UTC) for reliable client clock sync
app.get('/api/system/time', (req, res) => {
  res.json({ ts: Date.now() });
});

const { runIntegrityCheck, getLastIntegrityResult } = require('./lib/integrity-check');
const { auth: authMw, adminOnly: adminOnlyMw } = require('./middleware/auth');

app.post('/api/system/integrity-check', authMw, adminOnlyMw, (req, res) => {
  const { getDB } = require('./db');
  res.json({ success: true, data: runIntegrityCheck(getDB()) });
});
app.get('/api/system/integrity-check/last-result', authMw, adminOnlyMw, (req, res) => {
  const { getDB } = require('./db');
  const data = getLastIntegrityResult(getDB());
  res.json({ success: true, data });
});

// Lightweight health check — used by Android WebView boot poll
app.get('/api/system/health', (req, res) => {
  res.json({
    ok: true,
    role: isDevice() ? 'device' : 'central',
    platform: process.env.APP_PLATFORM || (isDevice() ? 'device' : 'web'),
    version: process.env.APP_VERSION || '0',
  });
});

const { readManifest, buildUpdateResponse } = require('./lib/app-update');

// App version info (bundled manifest — used by offline builds to know their own version)
app.get('/api/system/app-info', (req, res) => {
  const manifest = readManifest();
  const platform = process.env.APP_PLATFORM || (isDevice() ? 'device' : 'web');
  const version = process.env.APP_VERSION || manifest.web?.version || '0';
  // b2b_portal: lets the login page show/hide the customer portal link
  // (no secrets — just a boolean feature flag; portal only exists on central)
  let b2bPortal = false;
  if (!isDevice()) {
    try {
      const row = getDB().prepare("SELECT value FROM settings WHERE key='feature_b2b_portal'").get();
      b2bPortal = row?.value === '1';
    } catch { /* db not ready */ }
  }
  res.json({ manifest, role: isDevice() ? 'device' : 'central', platform, version, b2b_portal: b2bPortal });
});

// Check for newer desktop/android/web builds
app.get('/api/system/app-update', async (req, res) => {
  const platform = req.query.platform || 'web';
  const current = req.query.version || '0';
  if (isDevice()) {
    try {
      const client = require('./sync/client');
      const remote = await client.fetchCentralAppUpdate(platform, current);
      if (remote) return res.json(remote);
      return res.json(client.getLocalAppUpdate(platform, current));
    } catch { /* fall through */ }
  }
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  res.json(buildUpdateResponse(platform, current, readManifest(), base));
});

// Feed URL for electron-updater (desktop auto-update)
app.get('/api/system/update-feed', async (req, res) => {
  if (isDevice()) {
    try {
      const client = require('./sync/client');
      const url = await client.fetchCentralUpdateFeedUrl();
      return res.json({ url });
    } catch { return res.json({ url: null }); }
  }
  const manifest = readManifest();
  const external = process.env.DESKTOP_UPDATE_FEED_URL || manifest.desktop?.feed_url;
  if (external) return res.json({ url: external });
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  res.json({ url: base.replace(/\/$/, '') + '/releases/' });
});

// Serve .well-known/assetlinks.json explicitly (TWA domain verification)
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', '.well-known', 'assetlinks.json'));
});

// SPA fallback for non-API GET requests — no-cache so updates are always picked up
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/.well-known/')) return next();
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function getSMSSettings() {
  try {
    const db = getDB();
    const rows = db.prepare("SELECT key,value FROM settings WHERE key IN ('sms_provider','sms_api_key','sms_from')").all();
    const s = {};
    for (const r of rows) s[r.key] = r.value;
    return s;
  } catch { return {}; }
}

function logSMS(db, userId, custId, phone, body, status) {
  try {
    db.prepare('INSERT INTO sms_log (user_id,cust_id,phone,body,status) VALUES (?,?,?,?,?)')
      .run(userId || null, custId || null, phone, body, status);
  } catch {}
}

// ── Daily cron: batch SMS for today's follow-ups (no scheduled time) ─────────
async function runFollowupSMSBatch() {
  try {
    const db = getDB();
    const today = todayJalali();
    const settings = getSMSSettings();
    if (!settings.sms_api_key) return;

    // Followups due today with no specific time and SMS not yet sent
    const followups = db.prepare(
      "SELECT f.*,c.biz as cust_biz,c.owner as cust_owner,u.phone as user_phone,u.id as uid FROM followups f LEFT JOIN customers c ON f.cust_id=c.id LEFT JOIN users u ON f.user_id=u.id WHERE f.next_date=? AND (f.next_time IS NULL OR f.next_time='') AND f.status='open' AND f.sms_sent=0"
    ).all(today);

    // Group by user
    const byUser = {};
    for (const f of followups) {
      if (!f.uid || !f.user_phone) continue;
      if (!byUser[f.uid]) byUser[f.uid] = { phone: f.user_phone, items: [] };
      byUser[f.uid].items.push(f);
    }

    for (const [uid, group] of Object.entries(byUser)) {
      const lines = group.items.map(f => `• ${f.cust_biz || '-'}${f.cust_owner ? ' - ' + f.cust_owner : ''}`).join('\n');
      const text = `پیگیری‌های امروز\n\n${lines}`;
      const result = await sendSMS(settings, group.phone, text);
      const status = result.ok ? 'sent' : 'failed';
      // Mark all as sent regardless of result to avoid spam on retry
      const ids = group.items.map(f => f.id);
      db.prepare(`UPDATE followups SET sms_sent=1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      for (const f of group.items) {
        logSMS(db, uid, f.cust_id, group.phone, text, status);
      }
      console.log(`📱 SMS دسته‌ای برای کاربر ${uid}: ${group.items.length} پیگیری → ${status}`);
    }
  } catch (e) {
    console.error('cron followup-sms error:', e.message);
  }
}

// ── Per-minute cron: send SMS 1 hour BEFORE the scheduled follow-up time ──────
async function runTimedFollowupSMS() {
  try {
    const db = getDB();
    const today = todayJalali();
    const now = nowHHMM();
    const settings = getSMSSettings();
    if (!settings.sms_api_key) return;

    // Compute what next_time value we're looking for: 1 hour from now
    const [h, m] = now.split(':').map(Number);
    const targetH = h + 1;
    if (targetH >= 24) return; // skip: reminder would land past midnight
    const targetTime = `${String(targetH).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

    const followups = db.prepare(
      "SELECT f.*,c.biz as cust_biz,c.owner as cust_owner,u.phone as user_phone,u.id as uid FROM followups f LEFT JOIN customers c ON f.cust_id=c.id LEFT JOIN users u ON f.user_id=u.id WHERE f.next_date=? AND f.next_time=? AND f.status='open' AND f.sms_sent=0"
    ).all(today, targetTime);

    for (const f of followups) {
      if (!f.uid || !f.user_phone) continue;
      const text = `یادآور پیگیری (۱ ساعت دیگر)\n\n• ${f.cust_biz || '-'}${f.cust_owner ? ' - ' + f.cust_owner : ''}\nساعت پیگیری: ${targetTime}`;
      const result = await sendSMS(settings, f.user_phone, text);
      db.prepare('UPDATE followups SET sms_sent=1 WHERE id=?').run(f.id);
      logSMS(db, f.uid, f.cust_id, f.user_phone, text, result.ok ? 'sent' : 'failed');
      console.log(`📱 SMS ۱ ساعت قبل از پیگیری ${f.id} (ساعت ${targetTime}): ${result.ok ? 'ارسال شد' : 'خطا'}`);
    }
  } catch (e) {
    console.error('cron timed-sms error:', e.message);
  }
}

// ── Daily cron: flag silent customers (no order in 30+ days) ─────────────────
function runSilentCustomerCheck() {
  try {
    const db = getDB();
    const cutoff = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
    const today = todayJalali();
    const time = nowHHMM();
    const customers = db.prepare('SELECT * FROM customers').all();
    let created = 0;
    for (const c of customers) {
      const lastOrder = db.prepare('SELECT created_at FROM orders WHERE cust_id=? ORDER BY created_at DESC LIMIT 1').get(c.id);
      const isSilent = lastOrder && lastOrder.created_at < cutoff;
      if (!isSilent) continue;
      const existing = db.prepare(
        "SELECT id FROM followups WHERE cust_id=? AND status='open' AND subject LIKE '%مشتری خاموش%'"
      ).get(c.id);
      if (existing) continue;
      db.prepare(
        'INSERT INTO followups (user_id,cust_id,date,time,type,subject,note,status,priority) VALUES (?,?,?,?,?,?,?,?,?)'
      ).run(c.user_id, c.id, today, time, '🔔 سیستمی', `مشتری خاموش - ${c.biz}`,
            'بیش از ۳۰ روز است سفارشی ثبت نکرده است. لطفاً پیگیری شود.', 'open', 'high');
      created++;
    }
    if (created) console.log(`🔔 ${created} پیگیری خودکار برای مشتریان خاموش ساخته شد`);
  } catch (e) {
    console.error('cron silent-check error:', e.message);
  }
}

// ── Daily cron: active customers with no final invoice in 14 days → 'followup' ──
function runActiveToFollowupCheck() {
  try {
    const db = getDB();
    const cutoff = Math.floor(Date.now() / 1000) - 14 * 24 * 3600;
    const customers = db.prepare("SELECT * FROM customers WHERE status='active'").all();
    let updated = 0;
    for (const c of customers) {
      const lastInv = db.prepare("SELECT created_at FROM invoices WHERE cust_id=? AND type='final' ORDER BY created_at DESC LIMIT 1").get(c.id);
      if (!lastInv || lastInv.created_at < cutoff) {
        db.prepare("UPDATE customers SET status='followup' WHERE id=?").run(c.id);
        updated++;
      }
    }
    if (updated) console.log(`🔄 ${updated} مشتری فعال بدون خرید ۱۴ روزه به وضعیت پیگیری تغییر یافت`);
  } catch (e) {
    console.error('cron active-to-followup error:', e.message);
  }
}

// Cron jobs run ONLY on the central server. Device instances (offline-first
// desktop/mobile builds, SYNC_ROLE=device) must never send SMS, mutate
// customer statuses on a schedule, or run the tar-based backup — those are
// central responsibilities, and running them per-device would duplicate SMS
// sends and create diverging automated edits that fight the sync engine.
if (!isDevice()) {
  // Daily at 08:00: batch SMS + silent customer check + active→followup + rep alerts
  cron.schedule('0 8 * * *', () => {
    runFollowupSMSBatch();
    runSilentCustomerCheck();
    runActiveToFollowupCheck();
    try {
      const { runRepDailyAlerts } = require('./lib/rep-ledger');
      const n = runRepDailyAlerts(getDB());
      if (n) console.log(`📣 ${n} اعلان نماینده ارسال شد`);
    } catch (e) { console.error('cron rep-alerts error:', e.message); }
  });

  // Every minute: timed follow-up SMS
  cron.schedule('* * * * *', runTimedFollowupSMS);

  // Daily at 00:00: full app backup → local file + Gmail
  cron.schedule('0 0 * * *', runBackup);

  // Daily at 02:00: AI churn scoring + insights (heuristics always; Claude narratives if configured)
  cron.schedule('0 2 * * *', async () => {
    try {
      const { runNightlyAnalysis } = require('./services/ai');
      await runNightlyAnalysis(getDB());
    } catch (e) { console.error('cron ai-analysis error:', e.message); }
  });
}

// Global error handler — never leak stack traces to clients
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('unhandled error:', err.message);
  res.status(err.status || 500).json({ error: 'خطای داخلی سرور' });
});

app.listen(PORT, process.env.LISTEN_HOST || '0.0.0.0', () => {
  console.log(`CRM ترنم نسخه ۳ روی پورت ${PORT} اجرا شد`);
  if (process.env.APP_PLATFORM === 'android' && process.env.DB_PATH) {
    try {
      const ready = path.join(path.dirname(process.env.DB_PATH), 'server.ready');
      fs.writeFileSync(ready, String(Date.now()));
    } catch (e) { console.error('server.ready write failed:', e.message); }
  }
  if (isDevice()) {
    // Offline-first device: background sync loop (push outbox → pull changes)
    const { startClientLoop } = require('./sync/client');
    startClientLoop(parseInt(process.env.SYNC_INTERVAL_MS) || 60000);
    console.log('🔄 حالت دستگاه آفلاین فعال است — همگام‌سازی خودکار با سرور مرکزی');
  }
});
