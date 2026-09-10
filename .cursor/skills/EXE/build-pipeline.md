# خط تولید EXE — اجرا، امضا، انتشار، عیب‌یابی

سیاست‌ها (بدون بیلد مگر درخواست صریح، installer خارج از سرور production، بدون راز در git) در `SKILL.md`.

## ۱. پیش‌نیازهای ماشین بیلد (ویندوز x64)

| نیاز | بررسی/نصب |
|---|---|
| Node.js LTS (22 یا 24) + npm | `node -v`; مستندات قدیمی «Node 20» را نادیده بگیر (EOL) |
| Visual Studio Build Tools 2022 (Desktop development with C++) + Python 3 | فقط اگر prebuilt برای ABI Electron نبود؛ `windows-build-tools` منسوخ است — استفاده نکن |
| دسترسی شبکه/پروکسی | دانلود Electron (GitHub)، prebuildهای better-sqlite3/sharp، NSIS/winCodeSign از GitHub electron-builder-binaries |
| گواهی امضا | `desktop/certs/taranom-codesign.pfx` + `desktop/certs/csc-password.txt` (gitignored) یا `CSC_KEY_PASSWORD` |
| فضای دیسک | ≥ 5 GB (`node_modules`, `dist`, کش electron-builder در `%LOCALAPPDATA%/electron-builder/Cache`) |

پروکسی در همان شل: `$env:HTTP_PROXY="http://127.0.0.1:PORT"; $env:HTTPS_PROXY=$env:HTTP_PROXY`. میرور Electron در نبود دسترسی:
`$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"` و برای builder `$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"`.

## ۲. Version bump

1. `desktop/package.json` → `version` (semver؛ `productName` = `ERP Taranom`, `appId` = `ir.taranom.crm.desktop` ثابت بمانند).
2. بعد از بیلد: `latest.yml` + `manifest.json desktop.*` (بخش ۵).
3. `docs/CHANGE-LOG.md`.

## ۳. اجرای بیلد

```powershell
cd desktop
npm ci                                  # postinstall: electron-builder install-app-deps (rebuild نیتیو برای Electron)
npm run prepare-server                  # scripts/embedded-server-files.js copyRuntime('desktop') → desktop/server/
node ..\scripts\compare-embedded-hash.js  # drift = 0
node ..\scripts\test-embedded-release.js
node scripts\test-main-hardening-static.js; node scripts\test-security-policy.js; node scripts\test-local-secret-store.js
node ..\scripts\test-platform-security.js
cd ..
powershell -ExecutionPolicy Bypass -File scripts\build-desktop-signed.ps1   # CSC_LINK/CSC_KEY_PASSWORD → npm run dist:win
```

`dist:win` = `npm run prepare-server && electron-builder --win nsis --x64`. خروجی: `desktop/dist/ERP Taranom Setup <v>.exe`,
`latest.yml`, `*.blockmap`, پوشهٔ `win-unpacked/` (برای smoke بدون نصب).

بدون امضا (فقط تست داخلی): `cd desktop && npm run dist:win` — installer بدون امضا هرگز منتشر نشود.

نکات پیکربندی فعلی (`desktop/package.json build`):
- `asar:false`, `npmRebuild:true`, `buildDependenciesFromSource:false`.
- `files`: `main.js, preload.js, security-policy.js, local-secret-store.js, server/**/* (بدون node_modules/db/backups), node_modules/**/*`.
- `win.target nsis x64`, `nsis.oneClick=false`, `allowToChangeInstallationDirectory`, `unicode`, `installerLanguages en_US`.
- `publish.generic.url` هنوز جای‌گذار است (`https://example.com/releases/`) → با فید واقعی جایگزین شود (فاز ۰ upgrade-plan).
- **`win.publisherName` تعریف نشده** → برای `REQUIRE_SIGNED_UPDATES` باید دقیقاً CN گواهی (`Poshak Taranom` یا نام OV) باشد.

## ۴. تأیید

```powershell
Get-AuthenticodeSignature "desktop\dist\ERP Taranom Setup <v>.exe" | Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
# انتظار: Status Valid (self-signed فقط وقتی گواهی در Trusted Root ماشین است)، TimeStamper موجود
node server\scripts\test-release-artifact-integrity.js
& "desktop\dist\win-unpacked\ERP Taranom.exe"           # smoke بدون نصب
```

Smoke نصب روی ماشین/VM پاک:
1. نصب → اجرا → پنجره در < 10s؛ `%APPDATA%/erp-taranom-desktop/crm.db` و `jwt-secret.dpapi` ساخته شده باشند.
2. ورود، ساخت مشتری/فاکتور آفلاین، وصل شبکه → سینک؛ چاپ فاکتور (Chromium print) ؛ آپلود تصویر (sharp).
3. آپدیت: نسخهٔ قبلی نصب → `manifest.json`/`latest.yml` جدید روی سرور تست → اعلان → دانلود → نصب بدون هشدار غیرمنتظره.
4. `Get-Process | ? {$_.Name -like 'ERP Taranom*'}` بعد از خروج خالی باشد (بدون پروسهٔ یتیم).

**[پیشنهاد]** Playwright Electron: `const app = await _electron.launch({ executablePath: 'desktop/dist/win-unpacked/ERP Taranom.exe' })`
→ `firstWindow()` → انتظار عنصر ورود.

## ۵. متادیتا و انتشار

```powershell
# latest.yml (sha512/size) + manifest.json (فیلدهای web/android حفظ می‌شود)
node scripts\generate-release.js server\public\releases <desktopVersion> [androidVersion] [androidVersionCode] [notes]
# یا مسیر آمادهٔ دسکتاپ (نام‌های legacy را هم پیدا می‌کند):
node scripts\publish-desktop.js <desktopVersion> --github=rashidhamedas-prog/erp-taranom
```

آپلود باینری (نه به سرور production):

```powershell
gh release create v<v> "desktop\dist\ERP Taranom Setup <v>.exe" server\public\releases\latest.yml `
  --repo rashidhamedas-prog/erp-taranom --title "ERP Taranom Desktop <v>"
```

`manifest.json`:

```json
"desktop": {
  "version": "<v>",
  "url": "https://github.com/rashidhamedas-prog/erp-taranom/releases/download/v<v>/ERP-Taranom-Setup-<v>.exe",
  "feed_url": "https://github.com/rashidhamedas-prog/erp-taranom/releases/download/v<v>/",
  "sha256": "<hex>", "size": 123456789,
  "notes": "خلاصه برای کاربر"
}
```

- `feed_url` باید همان پوشه‌ای باشد که `latest.yml` و exe در آن است (electron-updater generic).
- نام فایل در `latest.yml` (`url:`) باید با نام آپلودشده یکی باشد (فاصله در نام → `%20`؛ `publish-desktop.js` نام بدون فاصله می‌سازد).
- بعد از commit متادیتا: deploy وب (`git pull` + `pm2 restart erp-taranom`) تا `/api/system/update-feed` نسخهٔ جدید بدهد.
- `release_id` (web/desktop/android) باید در سه نسخهٔ `app-update.js` یکی باشد → `test-embedded-release.js`.

## ۶. امضا و SmartScreen

| گزینه | وضعیت برای این شرکت | پیامد |
|---|---|---|
| Self-signed PFX (فعلی، CN=Poshak Taranom) | در دسترس | SmartScreen «Unknown publisher»; electron-updater فقط اگر گواهی در Trusted Root/Publishers کلاینت نصب باشد نصب را قبول می‌کند |
| Azure Artifact Signing (Trusted Signing) | Public Trust فقط برای سازمان‌های US/CA/EU/UK/AU/NZ/JP/KR/SG/CH/NO/IL و افراد US/CA → **در دسترس نیست** | — |
| OV code-signing از CA (DigiCert/Sectigo/GlobalSign/Certum…) روی توکن سخت‌افزاری یا HSM ابری (الزام CA/B Forum از ژوئن ۲۰۲۳) | نیاز به واسطهٔ خرید؛ نام سازمان روی گواهی | SmartScreen با شهرت تدریجی (چند هفته/چند هزار نصب)؛ امضای پیوسته با همان هویت |
| EV | همان مسیر OV، گران‌تر؛ مزیت شهرت فوری SmartScreen دیگر تضمین نمی‌شود | — |

پیکربندی electron-builder 26 برای توکن/HSM: `win.signtoolOptions.certificateSubjectName` (گواهی در store ویندوز از توکن) یا
`sign` hook سفارشی که `signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /sha1 <thumbprint>` را صدا می‌زند.
در v27 کلید یکپارچهٔ `win.sign` با `type: signtool | hsm | pkcs11 | azure`. همیشه timestamp RFC 3161.

## ۷. عیب‌یابی تفصیلی

| خطا/نشانه | ریشه | راه‌حل |
|---|---|---|
| `Error: Cannot find module 'better_sqlite3.node'` / `NODE_MODULE_VERSION 125 vs 118` | ماژول برای Node سیستم ساخته شده | `npx electron-builder install-app-deps`; پاک‌کردن `node_modules/better-sqlite3/build`; با v13 (N-API) نیاز به rebuild نیست |
| `sharp: Could not load the "sharp" module using the win32-x64 runtime` | prebuilt libvips دانلود نشده/`@img/sharp-win32-x64` نیست | `npm ci` با پروکسی؛ `SHARP_IGNORE_GLOBAL_LIBVIPS=1`; واکر `W0-OPS-002-SHARP-RUNTIME-0335` |
| دانلود `electron-v31.x-win32-x64.zip` timeout | GitHub | `ELECTRON_MIRROR`; در Electron ≥ 42 دانلود در اولین `npx electron`، `npx install-electron` |
| `winCodeSign` / `nsis` دانلود نمی‌شود | electron-builder-binaries روی GitHub | `ELECTRON_BUILDER_BINARIES_MIRROR`; کش `%LOCALAPPDATA%\electron-builder\Cache` |
| `Cannot compute electron version` | `electron` در devDependencies با `^` نامعتبر/نصب نشده | `npm ci`; pin دقیق نسخه |
| `sha512 checksum mismatch` هنگام آپدیت | `latest.yml` از فایل دیگر | `generate-release.js` روی exe نهایی امضا‌شده |
| `New version X is not signed by the application owner` / نصب رد شد | `publisherName` ≠ CN یا امضا نامعتبر | `build.win.publisherName` = CN دقیق؛ گواهی معتبر/نصب‌شده |
| SmartScreen پس از OV هم هشدار می‌دهد | شهرت هنوز ساخته نشده | امضای پیوسته؛ timestamp؛ زمان |
| پنجره سفید، DevTools: `ERR_CONNECTION_REFUSED` | سرور embedded بالا نیامد | لاگ main؛ `EADDRINUSE` (پورت آزاد انتخاب می‌شود—بعید)، `SQLITE_BUSY` (نسخهٔ دوم)، ماژول نیتیو |
| `A JavaScript error occurred in the main process` در اولین اجرا پس از آپدیت Electron | تغییر شکنندهٔ API (مثلاً `setPreloads`, `File.path`) | breaking-changes همان major؛ `test-main-hardening-static.js` |
| ASAR فعال → `ENOENT` برای `server/public/...` یا `.node` | فایل داخل asar | `asarUnpack: ["server/public/**", "**/*.node", "node_modules/sharp/**", "node_modules/@img/**"]` |
| installer با `unicode:true` و زبان فارسی خراب | NSIS RTL | `installerLanguages` فقط `en_US` (فعلی) |
| `.ps1` خطای پارس | کاراکتر غیر ASCII | فقط ASCII |

## ۸. CI پیشنهادی (بدون امضا — نیاز به تأیید مالک)

```yaml
# .github/workflows/desktop-build.yml (پیش‌نویس)
on: { workflow_dispatch: {} }
jobs:
  win:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm, cache-dependency-path: desktop/package-lock.json }
      - run: node scripts/prepare-embedded-server.js desktop && node scripts/test-embedded-release.js
      - run: cd desktop && npm ci
      - run: cd desktop && node scripts/test-main-hardening-static.js && node scripts/test-security-policy.js && node scripts/test-local-secret-store.js
      - run: cd desktop && npx electron-builder --win nsis --x64 --publish never
        env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
      - uses: actions/upload-artifact@v4
        with: { name: erp-taranom-desktop-unsigned, path: desktop/dist/*.exe, retention-days: 7 }
```

امضا فقط محلی با توکن سخت‌افزاری (کلید خصوصی نباید در CI باشد)، یا PKCS#11/HSM ابری اگر روزی فراهم شد.
