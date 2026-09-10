---
name: exe
description: >-
  Builds, hardens, signs and releases the ERP Taranom Windows desktop app (EXE/NSIS
  installer): an Electron shell running the embedded server/ (Express + better-sqlite3 +
  sharp) in-process on a loopback port with SYNC_ROLE=device, a sandboxed renderer, a
  DPAPI-protected JWT secret, and electron-updater self-update (generic feed, manifest
  fallback with SHA-256/size, signed-update enforcement). Covers electron-builder config,
  native-module rebuilds, code signing (PFX/CSC_LINK, OV token, SmartScreen), release
  metadata (latest.yml, manifest.json), embedded-server drift checks, the
  no-build-without-explicit-request policy, the modernization plan (Electron 44+,
  electron-builder 26/27, better-sqlite3 13 N-API, ASAR + fuses, utilityProcess) and
  always-updated upstream sources with an update-check script. Use when the user mentions
  EXE, installer, desktop, Windows app, دسکتاپ, نسخه ویندوز, Electron, electron-builder,
  electron-updater, NSIS, dist:win, code signing, or desktop update problems.
---

# EXE — ساخت نرم‌افزار دسکتاپ ویندوز ERP ترنم

مرجع «چطور نسخهٔ ویندوز ترنم ساخته، سخت‌سازی، امضا و منتشر می‌شود». معماری تفصیلی در
[architecture.md](architecture.md)، اجرای گام‌به‌گام و عیب‌یابی در [build-pipeline.md](build-pipeline.md)،
نقشهٔ مدرن‌سازی در [upgrade-plan.md](upgrade-plan.md) و منابع همیشه‌به‌روز در [resources.md](resources.md).
خواهر این اسکیل برای اندروید: `.cursor/skills/APK/`.

## ۱. واقعیت معماری

دسکتاپ **یک wrapper سادهٔ وب نیست**؛ Electron همان سرور `server/` را داخل پروسهٔ main اجرا می‌کند و renderer فقط
`http://127.0.0.1:<port>` را می‌بیند:

```
Electron main (desktop/main.js)
  ├─ REQUIRE_SIGNED_UPDATES / env: SYNC_ROLE=device, APP_PLATFORM=desktop, LISTEN_HOST=127.0.0.1, PORT=<آزاد>
  ├─ JWT_SECRET ← local-secret-store.js (safeStorage/DPAPI envelope در userData/jwt-secret.dpapi)
  ├─ require('./server/server.js')   ← کپی بایت‌به‌بایت server/ (drift = 0)
  │     ├─ SQLite %APPDATA%/erp-taranom-desktop/crm.db + uploads/ + backups/
  │     └─ sync با مرکز (outbox/pull) — docs/OFFLINE-SYNC.md
  ├─ BrowserWindow (contextIsolation, sandbox, webSecurity, permission=deny, navigation guard) → loadURL(loopback)
  ├─ preload.js → window.desktopAPI (IPC: desktop:get-update-status | check-update | install-update)
  └─ electron-updater (generic feed از /api/system/update-feed) + fallback manifest (SHA-256/size) + verifyUpdateCodeSignature
```

پیامدها:
- تغییر «قابلیت» = تغییر در `server/` یا `server/public/index.html`؛ `desktop/*.js` فقط پوسته/امنیت/آپدیت است.
- Node موجود در Electron نسخهٔ runtime سرور روی دسکتاپ است (Electron 31 → Node 20؛ Electron 44 → Node 24). سقف مشترک با
  اندروید (Node 18 تا ارتقای runtime آن) را رعایت کن.
- ماژول‌های نیتیو (`better-sqlite3`, `sharp`) باید برای ABI Electron ساخته/دانلود شوند (`npmRebuild`/`install-app-deps`).

## ۲. خط‌های قرمز

1. **بیلد کامل ممنوع مگر درخواست صریح.** `npm run dist:win` / `build-desktop-signed.ps1` فقط وقتی کاربر بگوید «نسخهٔ
   دسکتاپ/installer بساز». در غیر این صورت: تغییر سورس + متادیتای `manifest.json` + commit/deploy وب.
2. **installer روی سرور production کپی نمی‌شود** (حجم ~۱۰۰MB+، SCP ناپایدار). میزبان فایل: GitHub Releases یا میزبان HTTPS
   مجاز؛ فقط `manifest.json` و `latest.yml` با git به سرور می‌روند.
3. **راز ممنوع در git:** `desktop/certs/*.pfx`, `csc-password.txt`, `CSC_KEY_PASSWORD`, `GH_TOKEN`, `JWT_SECRET`. امضا فقط از
   `scripts/build-desktop-signed.ps1` (رمز چاپ نمی‌شود).
4. **امنیت renderer را شل نکن:** `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`, permission handler = deny،
   `setWindowOpenHandler` + `will-navigate` فقط loopback/`ALLOWED_EXTERNAL_HOSTS` → مرورگر خارجی. هر تغییر باید
   `desktop/scripts/test-main-hardening-static.js`, `test-security-policy.js`, `test-local-secret-store.js`, `scripts/test-platform-security.js` را سبز نگه دارد.
5. **آپدیت امضا‌شده:** `REQUIRE_SIGNED_UPDATES` پیش‌فرض روشن در بیلد production؛ `publisherName` در `build.win` باید با CN گواهی
   یکی باشد وگرنه نصب آپدیت رد می‌شود. گواهی self-signed فقط با نصب دستی در Trusted Root/Publishers هر کلاینت کار می‌کند.
6. **`.ps1` فقط ASCII**؛ فارسی در `.md`.
7. **نسخه هم‌زمان:** `desktop/package.json version` + `manifest.json desktop.{version,url,feed_url,sha256,size,notes}` + `latest.yml`
   (تولید با `scripts/generate-release.js`/`publish-desktop.js`) + `release_id` مشترک (`test-embedded-release.js`).
8. تغییر رفتار = راهنمای داخل برنامه (`renderAdminGuide/renderSalesGuide`) + ورودی `docs/CHANGE-LOG.md`.

## ۳. نقشهٔ فایل‌ها

| مسیر | نقش |
|---|---|
| `desktop/package.json` | نسخه، `electron`/`electron-builder`/`electron-updater`/`better-sqlite3`/`sharp`, اسکریپت‌ها (`prepare-server`, `dist:win`, `publish:win`), پیکربندی `build` (appId `ir.taranom.crm.desktop`, `asar:false`, `npmRebuild`, NSIS x64, `publish.generic`) |
| `desktop/main.js` | راه‌اندازی سرور embedded روی پورت آزاد، BrowserWindow سخت‌شده، updater state machine، IPC |
| `desktop/preload.js` | `contextBridge` → `window.desktopAPI` (فقط توابع لازم) |
| `desktop/security-policy.js` | `isLoopbackUrl`, `isAllowedExternalUrl`, `ALLOWED_EXTERNAL_HOSTS`, `createUpdateIntegrityVerifier`, `evaluateUpdateInstallPolicy` |
| `desktop/local-secret-store.js` | `getOrCreateLocalJwtSecret` با `safeStorage` (DPAPI) — envelope `jwt-secret.dpapi` |
| `desktop/scripts/prepare-server.js` | wrapper → `scripts/embedded-server-files.js copyRuntime('desktop')` → `desktop/server/` (gitignored) |
| `desktop/scripts/test-*.js` | تست‌های سخت‌سازی/سیاست/secret store |
| `desktop/BUILD-WINDOWS.md`, `docs/DESKTOP-UPDATE.md`, `docs/WAVE0-SIGNING-RUNBOOK.md` | مستندات بیلد/انتشار/امضا (بعضی نکات قدیمی: Node 20, windows-build-tools) |
| `scripts/build-desktop-signed.ps1` | `CSC_LINK`=PFX + رمز از فایل gitignored → `npm run dist:win` |
| `scripts/generate-release.js`, `scripts/publish-desktop.js` | `latest.yml` (sha512/size) + `manifest.json`; اشاره به GitHub Releases |
| `scripts/{embedded-server-files,prepare-embedded-server,compare-embedded-hash,test-embedded-release}.js` | کپی/مقایسهٔ سرور embedded؛ drift صفر؛ `release_id` |
| `scripts/test-platform-security.js`, `server/scripts/test-release-artifact-integrity.js` | سیاست URL دسکتاپ/اندروید؛ یکپارچگی آرتیفکت/manifest |
| `server/lib/app-update.js`, `server/server.js` (`/api/system/app-info|app-update|update-feed`) | منبع حقیقت نسخه/فید |

## ۴. نسخه‌ها — پین فعلی در مقابل آخرین پایدار

آخرین بررسی: **۲۰۲۶-۰۹-۱۰**. قبل از تصمیم ارتقا تازه کن:

```powershell
$env:NODE_USE_ENV_PROXY="1"; $env:HTTPS_PROXY="http://127.0.0.1:PORT"   # فقط همین شل (Node >= 24)
node .cursor/skills/EXE/scripts/check-updates.mjs [--json] [--strict]
```

| مؤلفه | پین فعلی | آخرین پایدار | نکته |
|---|---|---|---|
| Electron | ^31.3.0 (EOL؛ Chromium 126، Node 20) | 44.3.0 (Chromium 152، Node 24.18)؛ پشتیبانی رسمی فقط ۳ نسخهٔ آخر (42/43/44)؛ 45 در ۲۰ اکتبر ۲۰۲۶ | ۱۳ major عقب → upgrade-plan فاز ۲؛ 44 فقط 64بیت (ia32 حذف شد) |
| electron-builder | ^24.13.3 | 26.15.3 (`latest`)؛ 27.0.0-alpha (ESM، Node ≥ 22.12، `win.sign` یکپارچه، `migrate-schema`) | 26.x اکنون؛ 27 بعد از stable |
| electron-updater | ^6.3.9 | 6.8.9 (7.0 alpha) | همراه builder |
| better-sqlite3 (desktop) | 11.10.0 | 13.0.3 — N-API از 13.0.0 (بدون rebuild برای Electron؛ Node ≥ 22) | همراه Electron ≥ 43 |
| sharp | ^0.33.3 | 0.35.4 | prebuilt libvips؛ waiver `W0-OPS-002-SHARP-RUNTIME-0335` را بازبینی کن |
| Node (بیلد/CI) | 20 در CI و مستندات (EOL ۲۰۲۶-۰۴-۳۰) | 24 Active LTS؛ 22 Maintenance؛ 26 → LTS اکتبر ۲۰۲۶ | CI → 22/24 |
| هدف ویندوز | Windows 10+ x64 | Electron: Win10+ (x64/arm64) | Win10 در ESU؛ arm64 اختیاری |
| امضا | PFX self-signed CN=Poshak Taranom | Azure Artifact Signing برای سازمان‌های خارج US/CA/EU/UK/… در دسترس نیست → OV روی توکن سخت‌افزاری | SmartScreen با شهرت تدریجی |

## ۵. گردش کارها

### ۵.۱ تغییر قابلیت بدون بیلد (پیش‌فرض)

1. تغییر در `server/` / `index.html` → `node server/scripts/test-sms.js`, `node server/scripts/test-sync.js`, پارس فرانت با `new Function()`.
2. اگر سرور عوض شد: `node scripts/prepare-embedded-server.js all && node scripts/compare-embedded-hash.js && node scripts/test-embedded-release.js`.
3. اگر پوسته عوض شد (`desktop/*.js`): `node desktop/scripts/test-main-hardening-static.js && node desktop/scripts/test-security-policy.js && node desktop/scripts/test-local-secret-store.js && node scripts/test-platform-security.js`.
4. اعلام نسخه بدون بیلد: فقط `manifest.json desktop.*` (اعلان در زنگولهٔ برنامه از `/api/system/app-update`).
5. راهنما + CHANGE-LOG + commit/push + deploy وب.

### ۵.۲ بیلد کامل installer (فقط با درخواست صریح)

```
- [ ] Preflight: Node LTS (22/24) + npm، VS Build Tools 2022 (C++ workload) + Python 3 برای rebuild احتمالی، پروکسی برای دانلود Electron/prebuilds
- [ ] Version bump: desktop/package.json version (semver) — هم‌زمان با manifest/latest.yml بعد از بیلد
- [ ] cd desktop && npm ci   (postinstall: electron-builder install-app-deps → rebuild نیتیو برای Electron)
- [ ] npm run prepare-server && node ../scripts/compare-embedded-hash.js   (drift = 0)
- [ ] تست‌های پوسته (۵.۱ گام ۳) + node server/scripts/test-release-artifact-integrity.js
- [ ] امضا: powershell -File scripts/build-desktop-signed.ps1   (یا npm run dist:win بدون امضا فقط برای تست داخلی)
- [ ] تأیید امضا: Get-AuthenticodeSignature "desktop/dist/ERP Taranom Setup <v>.exe"  → Status Valid و Subject = publisherName
- [ ] Smoke: نصب روی VM/ماشین پاک → اولین اجرا < 10s، %APPDATA%/erp-taranom-desktop/crm.db ساخته شود، ورود، فاکتور آفلاین، سینک
- [ ] Smoke آپدیت: نسخهٔ قبلی نصب → manifest جدید → دانلود/تأیید امضا/نصب بدون هشدار غیرمنتظره
- [ ] متادیتا: node scripts/generate-release.js server/public/releases <v> ...  و  node scripts/publish-desktop.js <v>  → latest.yml + manifest.json
- [ ] آپلود exe (+ latest.yml) به GitHub Releases: gh release create v<v> ...  — نه به سرور production
- [ ] CHANGE-LOG + commit (manifest/latest.yml/package.json فقط) + push + deploy وب
```

جزئیات، پارامترها و خطاهای شناخته‌شده در [build-pipeline.md](build-pipeline.md).

### ۵.۳ جریان آپدیت (چه چیزی را نشکنی)

`main.js` → `GET /api/system/update-feed` (loopback) → `autoUpdater.setFeedURL({provider:'generic', url})` → `checkForUpdates`
→ `latest.yml` (sha512) → دانلود → `verifyUpdateCodeSignature(publishers)` → `quitAndInstall`. اگر فید نبود: fallback به
`manifest.json desktop.url` با تأیید SHA-256 + size (`createUpdateIntegrityVerifier`) و باز هم تأیید امضا قبل از `spawn(installer)`.
`allowDowngrade=false`, `autoInstallOnAppQuit=false`, `disableWebInstaller=true` را تغییر نده.

## ۶. عیب‌یابی سریع (کامل در build-pipeline.md)

| نشانه | علت رایج | اقدام |
|---|---|---|
| `NODE_MODULE_VERSION mismatch` هنگام اجرا | better-sqlite3/sharp برای Node سیستم ساخته شده نه Electron | `npx electron-builder install-app-deps` یا `@electron/rebuild`; با better-sqlite3 13 (N-API) نیاز نیست |
| `dist:win` روی دانلود Electron گیر می‌کند | GitHub مسدود | `ELECTRON_MIRROR`/پروکسی؛ Electron ≥ 42 باینری را در اولین اجرا می‌گیرد نه postinstall |
| پنجره سفید / `ERR_CONNECTION_REFUSED` | سرور embedded بالا نیامد (پورت، DB قفل، ماژول نیتیو) | لاگ main (`%APPDATA%/erp-taranom-desktop/logs`)؛ `crm.db-wal` قفل توسط نسخهٔ دیگر |
| SmartScreen «Unknown publisher» | self-signed یا شهرت صفر | OV cert + امضای پیوستهٔ همهٔ نسخه‌ها؛ timestamp RFC 3161 |
| آپدیت دانلود شد ولی نصب رد شد | `publisherName` ≠ CN، یا گواهی در Trusted Root کلاینت نیست | تطبیق `build.win.publisherName`; نصب گواهی؛ یا OV |
| `sha512 checksum mismatch` | `latest.yml` از فایل دیگری تولید شده | `generate-release.js` روی همان exe نهایی (بعد از امضا) |
| دانلود آپدیت از GitHub در ایران شکست | فیلترینگ | میزبان HTTPS جایگزین در `desktop.url/feed_url` (تصمیم مالک) |
| `asar` فعال شد و `sendFile`/`fs` سرور خراب | مسیرهای داخل asar | `asarUnpack` برای `server/public/**` و `*.node`; یا `asar:false` فعلی |

## ۷. تصمیم‌های معماری و کارهای باز

ثبت‌شده: Electron + سرور embedded در main؛ renderer sandbox و loopback-only؛ electron-updater generic + fallback manifest؛
امضای اجباری آپدیت؛ داده در `userData`; بیلد فقط محلی؛ `asar:false` (به‌دلیل دسترسی فایل سرور).

پیشنهادها (جزئیات/معیار در [upgrade-plan.md](upgrade-plan.md)):
1. **بهداشت فوری:** `publish.url` جای‌گذار `https://example.com/releases/` → فید واقعی؛ `publisherName` در `build.win`؛ CI/مستندات از
   Node 20 به 22/24؛ `windows-build-tools` (منسوخ) از مستندات حذف؛ `npm audit` (multer 1.x, helmet 7 …).
2. **Electron 44.x** (Chromium 152 / Node 24): تغییرات شکنندهٔ 32→44 مرور شود (E32 حذف `File.path`, E33 C++20 برای نیتیو، E35
   `setPreloads` منسوخ، E42 دانلود Electron بدون postinstall، E44 حذف ia32 و clipboard در renderer).
3. **electron-builder 26.x** اکنون، **27** بعد از stable (`npx electron-builder migrate-schema`); electron-updater 6.8.x.
4. **better-sqlite3 13 (N-API)** → حذف rebuild؛ **sharp 0.35** → بازبینی waiver.
5. **ASAR + `asarUnpack` + Electron fuses** (`runAsNode:false`, `enableNodeOptionsEnvironmentVariable:false`,
   `enableNodeCliInspectArguments:false`, `enableEmbeddedAsarIntegrityValidation:true`, `onlyLoadAppFromAsar:true`) — آزمایشی.
6. **سرور در `utilityProcess`** به‌جای main (ایزولاسیون crash/CPU؛ restart بدون بستن پنجره) — آزمایشی.
7. **امضای OV روی توکن سخت‌افزاری** (Azure Artifact Signing برای این شرکت در دسترس نیست) + timestamp؛ SmartScreen تدریجی.
8. **arm64 Windows** به‌عنوان هدف دوم (`--arm64`) فقط اگر دستگاه Snapdragon در ناوگان است (x64 روی Prism هم اجرا می‌شود).

## ۸. منابع همیشه‌به‌روز (خلاصه)

فهرست کامل با فید RSS/Atom/JSON و «سیگنال → اقدام» در [resources.md](resources.md): Electron releases/schedule/breaking-changes/
security advisories، Chromium schedule + Chrome Releases، Node.js releases/security/EOL، electron-builder/electron-updater
releases + MIGRATION، better-sqlite3، sharp، @electron/fuses، NSIS، Windows release health/lifecycle، Microsoft code-signing/
SmartScreen، OWASP، GitHub Advisory DB.

## ۹. الگوی درخواست به Cursor

```
/exe  — «نسخهٔ جدید دسکتاپ بساز» ⇒ چک‌لیست ۵.۲ کامل؛ exe به GitHub Releases؛ فقط متادیتا commit
/exe  — «فقط رفتار X را عوض کن» ⇒ گردش ۵.۱ (بدون بیلد)
/exe  — «ارتقای Electron/builder/امضا» ⇒ upgrade-plan.md فاز مربوطه با معیار پذیرش و rollback
```
