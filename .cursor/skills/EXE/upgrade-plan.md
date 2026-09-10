# نقشهٔ مدرن‌سازی نرم‌افزار دسکتاپ (وضعیت ۲۰۲۶-۰۹-۱۰)

هر فاز جدا commit می‌شود، معیار پذیرش و مسیر بازگشت دارد. **هیچ فازی `dist:win` را بدون درخواست صریح مالک اجرا نمی‌کند**؛
فازهای ۲ تا ۵ برای تأیید نهایی به یک بیلد آزمایشی نیاز دارند — قبل از شروع تأیید بگیر.

## فاز ۰ — بهداشت (اکنون، بدون بیلد)

| کار | فایل | معیار پذیرش |
|---|---|---|
| `publish.generic.url` جای‌گذار → فید واقعی (`https://github.com/<repo>/releases/download/v${version}/` یا میزبان داخلی) | `desktop/package.json` | `publish-desktop.js`/`latest.yml` و `feed_url` هم‌خوان |
| `win.publisherName` = CN دقیق گواهی | `desktop/package.json` | `test-main-hardening-static.js` (اگر چک دارد) + smoke آپدیت امضا‌شده |
| CI و مستندات از Node 20 (EOL ۲۰۲۶-۰۴-۳۰) به 22/24؛ حذف `windows-build-tools` | `.github/workflows/*.yml`, `desktop/BUILD-WINDOWS.md` | گیت‌ها سبز |
| `npm audit` در `desktop/` و `server/` (multer 1.x، helmet 7، express 4 → ارزیابی) | `package.json`ها | بدون High/Critical یا waiver ثبت‌شده در `.ai-dos` |
| `scripts/release.ps1` (سرور قدیمی `45.90.98.99`) | `scripts/release.ps1` | حذف/اصلاح؛ هیچ اسکریپتی exe به سرور نفرستد |
| `docs/DESKTOP-UPDATE.md` هنوز به `45.90.98.99` و مخزن قدیمی اشاره دارد | docs | به‌روز با سرور ایران و مخزن فعلی |

## فاز ۱ — electron-builder 26.x + electron-updater 6.8.x (بدون تغییر Electron)

- `electron-builder ^26.15` و `electron-updater ^6.8`؛ Node ≥ 20 برای builder 26 (بیلد روی 22/24).
- تغییرات مهم 24 → 26: `@electron/asar`, `electronFuses` (استفاده در فاز ۴)، `win.signtoolOptions`/`azureSignOptions`
  (جای `certificateFile/Password` مستقیم — `CSC_LINK/CSC_KEY_PASSWORD` همچنان کار می‌کند)، NSIS به‌روز.
- معیار پذیرش: `dist:win` سبز، installer نصب/آپدیت روی ماشین پاک، `latest.yml` سازگار با کلاینت‌های 6.3.x.
- بازگشت: lockfile قبلی.
- **27** (ESM، Node ≥ 22.12، `win.sign` یکپارچه، گروه‌های `nativeModules`/`asar.*`): فقط بعد از `latest` شدن؛ `npx electron-builder migrate-schema`.

## فاز ۲ — Electron 44.x (Chromium 152 / Node 24)

مرور breaking changes 32 → 44 که این پوسته را می‌گیرند:

| نسخه | تغییر | اثر/اقدام |
|---|---|---|
| 32 | حذف `File.path`; `webContents.goBack/canGoBack…` منسوخ → `navigationHistory` | فرانت از `File.path` استفاده نمی‌کند (تأیید با grep); back در پوسته نیست |
| 33 | ماژول‌های نیتیو نیاز به C++20؛ رفتار custom protocol روی ویندوز | better-sqlite3 13/sharp 0.35 سازگارند |
| 35 | `session.setPreloads` منسوخ → `registerPreloadScript` | اگر استفاده شده، مهاجرت |
| 36 | `app.commandLine` رفتار؛ حذف `systemPreferences.isAeroGlassEnabled` | grep |
| 37 | `utilityProcess` unhandled rejection/`process.exit` همگام | مهم برای فاز ۵ |
| 39 | popupهای `window.open` همیشه resizable | بی‌اثر (بلاک است) |
| 40/44 | `clipboard` در renderer منسوخ → حذف | renderer sandbox است؛ از `navigator.clipboard` استفاده کن |
| 42 | **Electron خودش را در postinstall دانلود نمی‌کند** → اولین `npx electron`/`install-electron` | اسکریپت بیلد/CI: `npx install-electron` بعد از `npm ci` یا اجرای builder |
| 44 | حذف Windows ia32؛ فقط x64/arm64 | هدف فعلی x64 است |

گام‌ها:
1. `electron` → `44.x` دقیق (بدون `^`)، `npm ci`, `npx install-electron`.
2. `npm start` → لاگ main بدون خطا؛ ۳ تست پوسته سبز.
3. `better-sqlite3` → `^13.0.3` (فاز ۳ را هم‌زمان انجام بده؛ v11 با Node 24 rebuild می‌خواهد).
4. smoke کامل (build-pipeline §۴) + چاپ فاکتور (تغییرات PDF/print Chromium).
5. `engines.node` سرور: Electron 44 = Node 24 ولی اندروید هنوز Node 18 → سقف مشترک را رعایت کن.

معیار پذیرش: boot < 10s، همهٔ smokeها، آپدیت از نسخهٔ Electron 31 به 44 روی ماشین پایلوت بدون خطا. بازگشت: revert lockfile + package.json.
کادنس: هر ۸ هفته یک major؛ فقط ۳ نسخهٔ آخر پشتیبانی → **حداقل هر ۶ ماه** یک ارتقای Electron.

## فاز ۳ — better-sqlite3 13 (N-API) + sharp 0.35

- better-sqlite3 13.x: N-API → prebuilt برای Node ≥ 22 و Electron بدون rebuild؛ اگر `install` هنوز `node-gyp rebuild` را اجرا کرد،
  `npm ci --ignore-scripts` + prebuilt دانلود دستی یا VS Build Tools. `npmRebuild` را می‌توان `false` کرد (تست کن).
- sharp 0.35.x: prebuilt `@img/sharp-win32-x64`; waiver `W0-OPS-002-SHARP-RUNTIME-0335` را با نتیجهٔ تست بازبینی/ببند.
- معیار پذیرش: تست‌های سرور روی Electron (`ELECTRON_RUN_AS_NODE=1` فقط در dev) یا smoke اپ؛ آپلود تصویر و thumbnail.

## فاز ۴ — ASAR + fuses (سخت‌سازی یکپارچگی)

پیکربندی هدف:

```json
"asar": true,
"asarUnpack": ["server/public/**", "**/*.node", "node_modules/sharp/**", "node_modules/@img/**"],
"electronFuses": {
  "runAsNode": false,
  "enableCookieEncryption": true,
  "enableNodeOptionsEnvironmentVariable": false,
  "enableNodeCliInspectArguments": false,
  "enableEmbeddedAsarIntegrityValidation": true,
  "onlyLoadAppFromAsar": true
}
```

ریسک: سرور با `express.static`/`sendFile`/`fs` روی `server/public`, `releases`, قالب‌های چاپ کار می‌کند؛ Electron `fs` را برای asar
شفاف می‌کند ولی نوشتن داخل asar ممکن نیست → هر مسیر نوشتنی باید `userData` باشد (اکنون DB/uploads/backups هستند؛ `releases/` را بررسی کن).
معیار پذیرش: `npx @electron/fuses read --app "dist/win-unpacked/ERP Taranom.exe"` مطابق جدول؛ smoke کامل؛ `ELECTRON_RUN_AS_NODE=1` بی‌اثر.
بازگشت: `asar:false` + حذف `electronFuses`.

## فاز ۵ — سرور در `utilityProcess`

- `desktop/server-entry.js` → `utilityProcess.fork(entry, [], { env, stdio: 'pipe' })`؛ health-check `/api/system/health`؛ restart با backoff؛
  renderer «اتصال مجدد».
- مزیت: crash سرور پنجره را نمی‌بندد؛ CPU سنگین (بکاپ/اکسل) UI را قفل نمی‌کند؛ محدودسازی حافظه.
- نکته E37: `process.exit()` در utility process همگام است؛ unhandled rejection → پروسه می‌میرد → باید restart شود.
- معیار پذیرش: kill پروسهٔ سرور → بازگشت خودکار < 5s بدون ازدست‌رفتن outbox.

## فاز ۶ — امضا و توزیع (تصمیم مالک)

- گواهی OV روی توکن سخت‌افزاری از CA/فروشنده‌ای که به شرکت خدمات می‌دهد؛ `publisherName` = نام سازمان روی گواهی؛ timestamp.
- میزبان installer/فید قابل‌دسترس در ایران (HTTPS، allowlist در `security-policy.js`)؛ GitHub به‌عنوان mirror دوم.
- (اختیاری) هدف `arm64` اگر دستگاه Snapdragon در ناوگان است؛ Electron 44 arm64 دارد؛ NSIS دو معماری.

## ترتیب پیشنهادی

```
فاز ۰ ──▶ فاز ۱ (builder 26) ──▶ فاز ۲+۳ (Electron 44 + better-sqlite3 13 + sharp 0.35، یک بیلد آزمایشی) ──▶ فاز ۴ (ASAR/fuses)
                                                                                                        └──▶ فاز ۵ (utilityProcess)
فاز ۶ (امضا/میزبان) موازی و مستقل — هرچه زودتر بهتر چون شهرت SmartScreen زمان‌بر است.
```
