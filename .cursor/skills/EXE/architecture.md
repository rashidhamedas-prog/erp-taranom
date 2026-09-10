# معماری نرم‌افزار دسکتاپ ویندوز ERP ترنم — نسخهٔ قابل‌اجرا

ساختار مطابق اسکیل `tap-solution-architecture`. «واقعیت» = از کد فعلی؛ **[پیشنهاد]** = تغییر پیشنهادی با معیار پذیرش در
`upgrade-plan.md`.

## ۱. فرضیات و محدوده

- کاربران: مدیر/حسابدار/فروش در دفتر مشهد و نمایندگان با لپ‌تاپ؛ نیاز به کار آفلاین و سینک با مرکز ایران (`94.249.244.208`).
- سیستم‌عامل: Windows 10/11 x64 (Windows 10 در ESU؛ Electron ≥ 44 فقط 64بیت). arm64 فعلاً خارج از محدوده.
- توزیع خارج از Microsoft Store؛ حساب Azure/Store به‌دلیل تحریم فرض نمی‌شود.
- بیلد روی ماشین ویندوزی مالک؛ installer روی GitHub Releases یا میزبان HTTPS جایگزین.
- خارج از محدوده: macOS/Linux (هدف `dist:linux AppImage` وجود دارد ولی پشتیبانی نمی‌شود)، MSIX/Store.

## ۲. زمینه (C4 سطح ۱)

```
[کاربر دفتر/نماینده] ──UI──▶ [ERP Taranom.exe (Electron)] ──HTTPS sync/update-check──▶ [سرور مرکزی ایران]
                                   │ renderer ⇄ 127.0.0.1:<port> ⇄ server embedded          │ manifest.json, update-feed
                                   └──HTTPS──▶ [GitHub Releases / میزبان installer] (latest.yml + Setup.exe)
```

## ۳. ماژول‌ها

| ماژول | فایل‌ها | مسئولیت | مرز/قرارداد |
|---|---|---|---|
| Main / Bootstrap | `desktop/main.js` | تنظیم env، انتخاب پورت آزاد loopback، `require('./server/server.js')`، ساخت پنجره، updater، IPC | تنها جای دسترسی به Node/OS |
| Security policy | `desktop/security-policy.js` | `isLoopbackUrl`, `isAllowedExternalUrl`, allowlist میزبان‌ها، verifier یکپارچگی آپدیت، سیاست نصب | خالص و قابل تست (بدون Electron) |
| Secret store | `desktop/local-secret-store.js` | JWT secret با `safeStorage` (DPAPI) در `userData/jwt-secret.dpapi`؛ تولید در اولین اجرا | هرگز plaintext روی دیسک |
| Preload | `desktop/preload.js` | `contextBridge.exposeInMainWorld('desktopAPI', {...})` | فقط توابع لازم؛ بدون `ipcRenderer` خام |
| Renderer | `server/public/index.html` (+`app.js`, `sw.js`) | UI تک‌فایل؛ تشخیص `APP_PLATFORM=desktop` برای آپدیت | فقط fetch نسبی؛ بدون Node |
| Embedded server | `desktop/server/**` (کپی زمان بیلد) | همان بک‌اند مرکز با `SYNC_ROLE=device`; `centralOnly` ⇒ 403 | drift صفر با `server/` |
| Sync engine | `server/sync/*` | outbox/pull/tombstone/تعارض | append-only |
| Updater | `main.js` + electron-updater | فید generic از `/api/system/update-feed`; fallback manifest؛ تأیید امضا؛ نصب | `REQUIRE_SIGNED_UPDATES` |
| Packaging | electron-builder (`desktop/package.json build`) | NSIS x64، rebuild نیتیو، فایل‌های شامل/مستثنا | `asar:false` فعلاً |
| Release tooling | `scripts/generate-release.js`, `scripts/publish-desktop.js`, `scripts/build-desktop-signed.ps1` | `latest.yml`, `manifest.json`, امضا | متادیتا در git، باینری خارج از git |

## ۴. مالکیت داده (روی کلاینت)

| داده | مسیر | مالک | نکته |
|---|---|---|---|
| SQLite | `%APPDATA%/erp-taranom-desktop/crm.db` (+`-wal`,`-shm`) | Server | بکاپ درون‌برنامه؛ قفل WAL اگر دو نسخه هم‌زمان اجرا شوند |
| Uploads | `%APPDATA%/erp-taranom-desktop/uploads/` | Server | sync فایل‌ها |
| Backups | `%APPDATA%/erp-taranom-desktop/backups/` | Server | **[پیشنهاد]** رمزنگاری بکاپ (اولویت handoff) |
| JWT secret | `%APPDATA%/erp-taranom-desktop/jwt-secret.dpapi` | Main | بسته به کاربر ویندوز (DPAPI) |
| Cache/Logs Electron | `%APPDATA%/erp-taranom-desktop/{Cache,logs}` | Electron | پاک‌کردن امن |
| Installer دانلودی | `%LOCALAPPDATA%/erp-taranom-desktop-updater/pending/` | electron-updater | حذف پس از نصب |

## ۵. APIها و رویدادها

- **HTTP محلی:** `http://127.0.0.1:<port>/api/*` (پورت آزاد در هر اجرا؛ renderer آدرس را از main می‌گیرد).
- **IPC (main ⇄ renderer):** `desktop:get-update-status`, `desktop:check-update`, `desktop:install-update` — همه `ipcMain.handle`
  با بررسی `event.senderFrame` روی loopback. **[پیشنهاد]** هر IPC جدید: schema ورودی + sender check.
- **Updater events:** `checking-for-update`, `update-available`, `download-progress`, `update-downloaded`, `error` → وضعیت به renderer.
- **آپدیت سرور:** `GET /api/system/app-update?platform=desktop&current=<v>` (اعلان)، `GET /api/system/update-feed` (URL فید)،
  `manifest.json desktop.{version,url,feed_url,sha256,size,notes}`.
- **سینک:** `POST /api/sync/push`, `GET /api/sync/pull`.

## ۶. امنیت

| تهدید | کنترل فعلی | وضعیت/پیشنهاد |
|---|---|---|
| RCE از محتوای وب | `contextIsolation`, `sandbox`, `nodeIntegration:false`, `webSecurity`, بدون `remote` | ✅؛ **[پیشنهاد]** CSP سخت‌تر برای loopback origin در `helmet` |
| ناوبری/پنجرهٔ ناخواسته | `will-navigate` guard، `setWindowOpenHandler` → `shell.openExternal` فقط allowlist | ✅ |
| مجوزهای Chromium | `setPermissionRequestHandler` → deny | ✅ |
| آپدیت جعلی | فید فقط از سرور خودی؛ sha512 در `latest.yml`; SHA-256/size در manifest؛ `verifyUpdateCodeSignature` با `publisherName`; `allowDowngrade=false` | ✅ مشروط به `publisherName` صحیح و گواهی معتبر |
| دستکاری باینری روی دیسک | امضای Authenticode installer | ⚠️ `asar:false` ⇒ کد JS بدون integrity؛ **[پیشنهاد]** ASAR + `enableEmbeddedAsarIntegrityValidation` + `onlyLoadAppFromAsar` |
| اجرای Electron به‌عنوان Node (`ELECTRON_RUN_AS_NODE`) / `NODE_OPTIONS` / `--inspect` | — | **[پیشنهاد]** fuses: `runAsNode:false`, `enableNodeOptionsEnvironmentVariable:false`, `enableNodeCliInspectArguments:false` |
| Secret محلی | DPAPI envelope | ✅ |
| Chromium/Node قدیمی (Electron 31 EOL) | — | ⚠️ ریسک باز → فاز ۲ upgrade-plan |
| Supply chain npm | `npm ci` با lockfile؛ `check-audit-waivers.js` | **[پیشنهاد]** `--ignore-scripts` در CI + `npm audit` منظم؛ pin `electron` دقیق |
| SmartScreen/اعتماد کاربر | self-signed | **[پیشنهاد]** OV روی توکن سخت‌افزاری + timestamp |

## ۷. استقرار و توزیع

- **محیط بیلد:** Windows x64، Node LTS (22/24)، npm، VS Build Tools 2022 (Desktop C++) + Python 3 (فقط اگر rebuild نیتیو لازم شد)،
  دسترسی به GitHub/npm (پروکسی).
- **خروجی:** `desktop/dist/ERP Taranom Setup <v>.exe` (+ `latest.yml`, `*.blockmap`). gitignored.
- **میزبانی:** GitHub Releases (`rashidhamedas-prog/erp-taranom` طبق `publish-desktop.js`) → `desktop.url/feed_url` در manifest.
  ⚠️ دسترسی کاربران ایرانی به GitHub ممکن است مسدود باشد → **[تصمیم]** میزبان HTTPS داخلی/ابری با allowlist.
- **سرور مرکزی:** فقط `manifest.json` + `latest.yml` (git pull + pm2 restart).
- **[پیشنهاد] CI:** GitHub Actions `windows-latest`: `npm ci --ignore-scripts` → `install-app-deps` → `dist:win` بدون امضا → آرتیفکت؛
  امضا فقط محلی با توکن (کلید نباید در CI باشد) یا با PKCS#11 اگر HSM ابری داشتید.

## ۸. توالی‌های بحرانی

### ۸.۱ راه‌اندازی
`app.whenReady` → `REQUIRE_SIGNED_UPDATES` resolve → پورت آزاد → env → JWT از DPAPI → `require(server.js)` (listen 127.0.0.1) →
`BrowserWindow` → `loadURL(http://127.0.0.1:<port>/)` → اگر شکست: dialog + retry/exit.

### ۸.۲ آپدیت
timer/کاربر → `/api/system/update-feed` → `setFeedURL(generic)` → `checkForUpdates` → `update-available` → `autoDownload` →
`update-downloaded` → `verifyUpdateCodeSignature(publishers, path)` → UI «نصب» → `quitAndInstall(false,true)`.
fallback: `manifest.json desktop.url` → دانلود → SHA-256/size → امضا → `spawn(installer)`.

### ۸.۳ Single instance / قفل DB
**[پیشنهاد]** `app.requestSingleInstanceLock()` قبل از listen؛ نسخهٔ دوم پنجرهٔ اول را focus کند (جلوگیری از `SQLITE_BUSY`).

### ۸.۴ Crash سرور embedded
اکنون crash سرور = crash main. **[پیشنهاد]** `utilityProcess.fork(server-entry)` + health-check + restart با backoff؛ renderer پیام
«اتصال مجدد» نشان دهد.

## ۹. تست و کیفیت

| گیت | فرمان | چه چیزی را می‌گیرد |
|---|---|---|
| بک‌اند | `node server/scripts/test-sms.js`, `node server/scripts/test-sync.js` | رگرسیون |
| پوسته | `node desktop/scripts/test-main-hardening-static.js`, `test-security-policy.js`, `test-local-secret-store.js` | شل‌شدن امنیت، secret store |
| سیاست پلتفرم | `node scripts/test-platform-security.js` | URL policy، manifest اندروید |
| Drift | `node scripts/test-embedded-release.js`, `node scripts/compare-embedded-hash.js` | کپی سرور و `release_id` |
| آرتیفکت | `node server/scripts/test-release-artifact-integrity.js` | manifest/latest.yml/hash |
| امضا | `Get-AuthenticodeSignature <exe>` → `Valid` | گواهی/timestamp |
| **[پیشنهاد]** E2E Electron | Playwright `_electron.launch` روی build unpacked | boot، ورود، فاکتور آفلاین |
| **[پیشنهاد]** Fuses | `npx @electron/fuses read --app dist/win-unpacked/ERP\ Taranom.exe` | fuses مطابق سیاست |

## ۱۰. Rollout و Rollback

- **Rollout:** نصب روی ۱ ماشین پایلوت (نسخهٔ قبلی نصب) → آپدیت درون‌برنامه → ۲۴ ساعت → انتشار manifest/latest.yml برای همه.
- **Rollback:** `manifest.json` و `latest.yml` را به نسخهٔ قبلی برگردان؛ `allowDowngrade=false` یعنی کلاینت‌های آپدیت‌شده خودکار
  برنمی‌گردند → نصب دستی نسخهٔ قبلی (DB سازگار به عقب تضمین نمی‌شود → بکاپ قبل از هر آپدیت).
- **Electron major upgrade:** پایلوت با فلگ `REQUIRE_SIGNED_UPDATES=1` و ماشین پاک؛ نگه‌داشتن installer قبلی.

## ۱۱. ریسک‌ها

| ریسک | احتمال/اثر | کاهش |
|---|---|---|
| Electron 31 EOL (CVEهای Chromium بدون پچ) | بالا/بالا | فاز ۲؛ سطح حمله محدود (فقط loopback) ولی PDF/print/رندر محتوا هنوز Chromium است |
| SmartScreen و self-signed | بالا/متوسط | OV cert؛ آموزش کاربر؛ امضای پیوسته |
| میزبانی GitHub برای کاربران ایران | بالا/بالا | میزبان جایگزین + allowlist؛ fallback manifest |
| `asar:false` → دستکاری آسان | متوسط/متوسط | ASAR+fuses آزمایشی |
| ماژول نیتیو ناسازگار بعد از ارتقای Electron | متوسط/بالا | better-sqlite3 13 N-API؛ sharp prebuilt؛ smoke boot |
| بیلد فقط روی یک ماشین | متوسط/بالا | CI بدون امضا + این اسکیل |

## ۱۲. تصمیم‌های نیازمند تأیید مالک

1. زمان ارتقای Electron به 44.x (همراه builder 26 و better-sqlite3 13) و پذیرش یک دور تست کامل.
2. خرید گواهی OV (توکن سخت‌افزاری) یا ادامهٔ self-signed با نصب دستی گواهی روی کلاینت‌ها.
3. میزبان installer/فید برای کاربران ایران (GitHub در مقابل میزبان داخلی HTTPS).
4. فعال‌کردن ASAR + fuses (نیاز به تست مسیرهای فایل سرور) و انتقال سرور به `utilityProcess`.
5. هدف arm64 Windows.
6. رمزنگاری بکاپ‌های محلی (اولویت امنیتی handoff).
