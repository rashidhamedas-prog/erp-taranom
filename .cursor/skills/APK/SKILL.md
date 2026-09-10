---
name: apk
description: >-
  Builds, verifies, signs and releases the ERP Taranom Android app (APK): a hardened
  WebView shell around an embedded nodejs-mobile Node.js server (server/ + Express +
  better-sqlite3 cross-compiled with the NDK) with offline sync and verified in-app
  self-update from server/public/releases/manifest.json. Covers toolchain pinning
  (JDK/AGP/Gradle/NDK/compileSdk/targetSdk), 16 KB page-size and ABI checks, keystore
  handling, version bumps, embedded-server drift checks, sideload distribution, the
  no-build-without-explicit-request policy, the Android modernization plan (targetSdk 36+,
  AGP 9.x, Node 24 nodejs-mobile, N-API better-sqlite3, developer verification) and a
  curated list of always-updated upstream sources with an update-check script. Use when
  the user mentions APK, Android, اندروید, نسخه اندروید, assembleRelease, build-android.ps1,
  nodejs-mobile, libnode, better_sqlite3.node, keystore/JKS, MainActivity, WebView, or
  Android update/install problems.
---

# APK — ساخت اپلیکیشن اندروید ERP ترنم

این اسکیل مرجع کامل «چطور اپ اندروید ترنم ساخته، تأیید، امضا و منتشر می‌شود» است.
معماری تفصیلی در [architecture.md](architecture.md)، اجرای گام‌به‌گام و عیب‌یابی در
[build-pipeline.md](build-pipeline.md)، نقشهٔ مدرن‌سازی در [upgrade-plan.md](upgrade-plan.md)
و منابع همیشه‌به‌روز در [resources.md](resources.md) است.

## ۱. واقعیت معماری (اول این را بپذیر)

اپ اندروید **نه Kotlin/Compose است، نه Capacitor/React Native.** یک پوستهٔ `WebView` سخت‌شده است که
همان سرور `server/` (Node/Express + better-sqlite3) را با `nodejs-mobile` داخل پروسهٔ اپ اجرا می‌کند:

```
MainActivity (Java, WebView سخت‌شده)
  └─ JNI native-lib.cpp → node::Start(libnode.so)   ← nodejs-mobile
       └─ assets/nodejs-project/main.js  (bootstrap: env + redirect .node → libbetter_sqlite3.so)
            └─ server/server.js  (کپی بایت‌به‌بایت از server/ در زمان بیلد)
                 ├─ SQLite در filesDir (DB_PATH) + uploads + backups
                 ├─ SYNC_ROLE=device → sync با مرکز (outbox/pull, docs/OFFLINE-SYNC.md)
                 └─ HTTP فقط روی 127.0.0.1:3210 → WebView همان را لود می‌کند
```

پیامدها:
- هر تغییر «قابلیت» اپ = تغییر در `server/` یا `server/public/index.html` است، **نه در Java**. Java فقط
  برای پوسته (boot، امنیت WebView، آپدیت APK، bridge) دست‌کاری می‌شود.
- کد سرور باید روی **Node نسخهٔ runtime اندروید** اجرا شود (اکنون Node 18.20.4). تا ارتقای runtime، از
  APIهای جدیدتر از Node 18 (`toSorted`, `Object.groupBy`, `Promise.withResolvers`, `node:sqlite`) استفاده نکن.
- ماژول نیتیو `better-sqlite3` باید با **همان NDK/ABI و همان libnode** کراس‌کامپایل شود؛ نصب npm معمولی روی
  اندروید کار نمی‌کند.

## ۲. خط‌های قرمز (قبل از هر اقدام)

1. **بیلد کامل ممنوع مگر درخواست صریح.** `build-android.ps1` / `assembleRelease` / `finalize-android-release.ps1`
   فقط وقتی کاربر صریحاً بگوید «نسخه/آپدیت اندروید بساز». (`.cursor/rules/no-full-platform-builds.mdc`)
   در غیر این صورت: تغییر در سورس + متادیتای `server/public/releases/manifest.json` + commit/deploy وب.
2. **APK هرگز به سرور production کپی نمی‌شود** (`scp`/SFTP به `/releases/` ممنوع). توزیع = sideload
   (USB/انتقال فایل) یا میزبانی جدا؛ فقط متادیتا (`manifest.json`) روی سرور می‌رود.
3. **راز ممنوع در git:** `android/keystore.properties`, `*.jks`, `*.keystore`, رمزها، `JWT_SECRET`. امضا فقط از
   `keystore.properties` (gitignored) یا `CRM_KEYSTORE_FILE/CRM_KEYSTORE_PASSWORD/CRM_KEY_ALIAS/CRM_KEY_PASSWORD`.
   کی‌استور قدیمی لو رفته و باطل است؛ فقط `android/erp-taranom.jks` جدید (`docs/WAVE0-SIGNING-RUNBOOK.md`).
4. **فایل‌های `.ps1` فقط ASCII** (PowerShell 5 با UTF-8 بدون BOM خراب می‌شود). فارسی را در `.md` بنویس.
5. **هیچ `fetch` دیباگ/ingest در کد production نماند** (sync-hygiene). بلوک `agentLog` باقی‌مانده در
   `assets/nodejs-project/main.js` باید حذف شود (بخش ۷).
6. **سینک را نشکن:** `server/sync/tables.js` append-only؛ API جدید → `PATH_TABLE_MAP`؛ اپ device هرگز نباید مسیرهای
   `centralOnly` را صدا بزند.
7. **نسخه را بدون هم‌زمانی بالا نبر:** هر انتشار = `versionCode`+`versionName` (`android/app/build.gradle`) +
   `APP_VERSION` در `assets/nodejs-project/main.js` + marker در `scripts/test-android-apk.ps1` + `manifest.json`.
8. تغییر رفتار = به‌روزرسانی راهنمای داخل برنامه (`renderAdminGuide/renderSalesGuide`) + ورودی `docs/CHANGE-LOG.md`.

## ۳. نقشهٔ فایل‌ها

| مسیر | نقش |
|---|---|
| `android/app/build.gradle` | compileSdk/targetSdk/minSdk، `versionCode/versionName`، ABIها، امضا، تسک‌های `extractNodeLibs`, `layoutNodeLibs`, `copyLibcxxShared`, `copyBetterSqlite3Jni`, `copyServerSources` |
| `android/build.gradle`, `gradle/wrapper/gradle-wrapper.properties`, `gradle.properties` | AGP، Gradle wrapper، حافظهٔ JVM، `useAndroidX=false` |
| `android/app/src/main/AndroidManifest.xml` | `allowBackup=false`, `usesCleartextTraffic=false`, `networkSecurityConfig`, `extractNativeLibs=true`, `pageSizeCompat`, مجوزها |
| `android/app/src/main/java/.../MainActivity.java` | WebView سخت‌شده، boot pipeline، `server.ready` polling، آپدیت APK تأییدشده (`APK_UPDATE_HOSTS`, SHA-256, size, package, versionCode, signer) |
| `android/app/src/main/cpp/{native-lib.cpp,CMakeLists.txt}` | JNI → `node::Start`, RTLD_GLOBAL، `-Wl,-z,max-page-size=16384` |
| `android/app/src/main/assets/nodejs-project/{main.js,package.json}` | bootstrap و وابستگی‌های runtime اندروید (کپی `server/` زیر آن gitignored است) |
| `scripts/build-android.ps1` | **تنها مسیر رسمی بیلد** (JDK 17، sdkmanager، دانلود nodejs-mobile، کراس‌کامپایل، prune، `assembleRelease`, apksigner) |
| `scripts/build-better-sqlite3-android.ps1` | کراس‌کامپایل per-ABI با node-gyp + clang NDK؛ چک `DT_NEEDED=libnode.so` |
| `scripts/test-android-apk.ps1` | تأیید APK: بدون APK تودرتو، ELF per-ABI، `libc++_shared`, `libbetter_sqlite3`, marker نسخه |
| `scripts/test-android-platform-security.js` | ۲۷ چک استاتیک امنیتی (manifest/Java/main.js) |
| `scripts/finalize-android-release.ps1` | بیلد + `android-build-report.txt` (SHA-256/size/ELF) — فقط محلی |
| `scripts/{embedded-server-files,prepare-embedded-server,compare-embedded-hash,test-embedded-release}.js` | کپی/مقایسهٔ بایت‌به‌بایت `server/` در دو پلتفرم؛ drift باید صفر باشد؛ `release_id` مشترک |
| `server/lib/app-update.js`, `server/server.js` (`/api/system/app-info|app-update|update-feed`) | منطق نسخه/آپدیت؛ `manifest.json` منبع حقیقت |
| `docs/skills/android-apk-taranom.md`, `docs/WAVE0-SIGNING-RUNBOOK.md`, `docs/OFFLINE-SYNC.md` | تاریخچهٔ باگ‌های واقعی، امضا، سینک |

## ۴. نسخه‌ها — پین فعلی در مقابل آخرین پایدار

آخرین بررسی: **۲۰۲۶-۰۹-۱۰**. قبل از هر تصمیم ارتقا، جدول را با اسکریپت تازه کن:

```powershell
# پشت VPN/پروکسی محلی (Node >= 24): پورت را از پروکسی سیستم ویندوز بردار
$env:NODE_USE_ENV_PROXY="1"; $env:HTTPS_PROXY="http://127.0.0.1:PORT"
node .cursor/skills/APK/scripts/check-updates.mjs
```

| مؤلفه | پین فعلی ریپو | آخرین پایدار | نکته |
|---|---|---|---|
| AGP | 8.5.2 | 9.4.0 (Gradle ≥ 9.6.0، JDK ≥ 17، Build-Tools 36.0.0، NDK پیش‌فرض 28.2.13676358، حداکثر API 37) | دو نسخهٔ اصلی عقب؛ AGP 10 فقط Variant API جدید |
| Gradle wrapper | 8.7 | 9.7.x (حداقل AGP 9.4: 9.6.0) | همراه AGP |
| compileSdk / targetSdk / minSdk | 36 / **34** / 24 | 37 (Android 17، ژوئن ۲۰۲۶) / Play ≥ 36 از ۳۱ اوت ۲۰۲۶ / — | targetSdk 34 قدیمی؛ رفتن به 36 = edge-to-edge اجباری + predictive back (بخش ۷) |
| NDK | 25.1.8937393 | r30 آخرین؛ 28.2.13676358 پیش‌فرض AGP 9.4؛ fork nodejs-mobile با r27d ساخته شده | از r28 هم‌ترازی ۱۶KB پیش‌فرض است |
| Build-Tools / CMake | 36.1.0 / 3.22.1 | 36.x–37.x / 3.31.x | اختیاری |
| JDK | 17 | 17 حداقل AGP 9.x؛ 21 LTS توصیهٔ runtime | `winget Microsoft.OpenJDK.17` در اسکریپت |
| nodejs-mobile | v18.20.4 رسمی (سازمان غیرفعال؛ Node 18 EOL آوریل ۲۰۲۵) | fork `gmaclennan/nodejs-mobile` v24.18.0-0 (۲۰۲۶-۰۸-۱۱، prerelease، NDK r27d، ۱۶KB، `process.versions.mobile`) | ریسک امنیتی OpenSSL/Node 18؛ مهاجرت برنامه‌ریزی‌شده |
| better-sqlite3 (اندروید) | ^9.4.3 کراس‌کامپایل | 13.0.3 (N-API از 13.0.0؛ Node ≥ 22) | فقط همراه ارتقای runtime به Node 24 |
| WebView | سیستم (Chromium، آپدیت از Play) | M144+: insets برای همهٔ WebViewها | با targetSdk 36 باید insets را مدیریت کنی |

## ۵. گردش کارها

### ۵.۱ تغییر قابلیت بدون بیلد (پیش‌فرض)

1. تغییر در `server/` / `server/public/index.html`; تست‌ها: `node server/scripts/test-sms.js`, `node server/scripts/test-sync.js`.
2. پارس فرانت با `new Function()`؛ راهنمای داخل برنامه؛ `docs/CHANGE-LOG.md`.
3. اگر کد سرور عوض شد: `node scripts/prepare-embedded-server.js all && node scripts/compare-embedded-hash.js`
   و `node scripts/test-embedded-release.js` (drift = 0). این کپی‌ها gitignored هستند ولی CI (`wave0-gate.yml`) چک می‌کند.
4. اگر نسخهٔ اپ باید اعلام شود (بدون بیلد): فقط `manifest.json` (`android.version/versionCode/notes`) را به‌روز کن —
   اعلان در زنگولهٔ اعلان‌ها از `/api/system/app-update` می‌آید.
5. commit + push + deploy وب (قانون auto-commit-deploy).

### ۵.۲ بیلد کامل APK (فقط با درخواست صریح)

چک‌لیست را کپی کن و پیش برو:

```
- [ ] Preflight: JDK 17 در PATH، ANDROID_HOME، فضای دیسک > 10GB، پروکسی برای دانلود nodejs-mobile/Gradle
- [ ] Version bump هم‌زمان: build.gradle (versionCode+1, versionName) + main.js APP_VERSION + test-android-apk.ps1 marker
- [ ] راز: keystore.properties موجود و gitignored؛ هیچ رمزی در خروجی/لاگ چاپ نشود
- [ ] node scripts/prepare-embedded-server.js android  → drift صفر (test-embedded-release.js)
- [ ] powershell -ExecutionPolicy Bypass -File scripts/build-android.ps1   (خروجی: server/public/releases/erp-taranom.apk)
- [ ] powershell -File scripts/test-android-apk.ps1   و   node scripts/test-android-platform-security.js
- [ ] apksigner verify --print-certs   → signer = کی‌استور جدید (نه کی‌استور لو‌رفته)
- [ ] هم‌ترازی ۱۶KB: llvm-readelf -l lib/arm64-v8a/*.so | LOAD align 0x4000 (تا حذف pageSizeCompat)
- [ ] Smoke روی دستگاه: adb install -r; adb logcat -s ERPTaranom NodeJS AndroidRuntime; adb forward tcp:3210 tcp:3210 → GET /api/system/health
- [ ] Smoke عملکردی: ورود، ساخت فاکتور آفلاین، سینک با مرکز، آپدیت درون‌برنامه (اگر manifest جدید است)
- [ ] manifest.json: android.version/versionCode/url/sha256/size/notes (node scripts/generate-release.js ... یا دستی) — APK خودش آپلود نمی‌شود
- [ ] CHANGE-LOG + commit (بدون APK/لاگ/کی‌استور) + push
```

جزئیات هر گام، خطاهای شناخته‌شده و راه‌حل در [build-pipeline.md](build-pipeline.md).

### ۵.۳ جریان آپدیت درون‌برنامه (چه چیزی را نشکنی)

`index.html` → `GET /api/system/app-update?platform=android&current=<ver>` → اگر `update_available`،
`AndroidBridge.notifyUpdate` → کاربر تأیید → `downloadVerifiedApk(url, sha256, size, versionCode)`:
فقط از میزبان‌های `APK_UPDATE_HOSTS` (erp.poshaktaranom.com / poshaktaranom.com) و HTTPS، حداکثر `MAX_APK_SIZE_BYTES`،
تطبیق SHA-256 + اندازه + package + versionCode + اثر انگشت signer، بعد `ACTION_INSTALL_PACKAGE`.
هر تغییر در این زنجیره باید `test-android-platform-security.js` را سبز نگه دارد.

## ۶. عیب‌یابی سریع (کامل در build-pipeline.md)

| نشانه | علت رایج | اقدام |
|---|---|---|
| اپ باز می‌شود و سفید می‌ماند / timeout ۶۰۰s | `server.fail` یا crash در Node قبل از `server.ready` | `adb logcat` فیلتر `NodeJS`; فایل `server.fail` در filesDir؛ اغلب ماژول نیتیو |
| `dlopen ... better_sqlite3.node ... cannot locate symbol` | `.node` بدون `DT_NEEDED=libnode.so` یا از libnode متفاوت | بیلد مجدد با `build-better-sqlite3-android.ps1` مقابل همان zip nodejs-mobile |
| `libc++_shared.so not found` (Android 15+) | namespace isolation | تسک `copyLibcxxShared` باید per-ABI کپی کند |
| OOM/crash در اولین اجرا | APK تودرتو داخل assets (`releases/*.apk` کپی شده) | prune در `embedded-server-files.js`؛ چک `test-android-apk.ps1` |
| نصب روی Pixel 8+/دستگاه ۱۶KB شکست یا crash | `.so` با align 4KB و بدون `pageSizeCompat` | `-Wl,-z,max-page-size=16384`; NDK ≥ r28؛ runtime ۱۶KB (fork) |
| Gradle OOM/کند روی ماشین ضعیف | `-Xmx1536m`, `workers.max=1` | همان تنظیمات را نگه دار؛ `--no-daemon --rerun-tasks` |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | signer فرق دارد (کی‌استور قدیمی/دیباگ) | یک‌بار uninstall؛ همیشه با JKS جدید امضا کن |
| آپدیت درون‌برنامه رد می‌شود | sha256/size/versionCode در manifest با فایل نمی‌خواند یا میزبان مجاز نیست | `manifest.json` را از فایل نهایی بازتولید کن |

## ۷. تصمیم‌های معماری و کارهای باز

ثبت‌شده (تغییر نده مگر با ADR جدید): پوستهٔ WebView + nodejs-mobile؛ یک کدبیس سرور برای مرکز/دسکتاپ/اندروید؛
loopback-only cleartext؛ آپدیت APK فقط با تأیید چندلایه؛ توزیع sideload؛ `extractNativeLibs=true` + `useLegacyPackaging`.

پیشنهادهای مدرن‌سازی (ترتیب و معیار پذیرش در [upgrade-plan.md](upgrade-plan.md)):
1. **بهداشت فوری:** حذف بلوک `agentLog`/ingest از `main.js`؛ CI از Node 20 (EOL) به 22/24؛ `scripts/release.ps1`
   هنوز سرور قدیمی (`45.90.98.99`) را دارد → ایران `94.249.244.208` یا حذف.
2. **targetSdk 36 (+37):** edge-to-edge بدون opt-out (insets برای WebView)، `onBackPressed` دیگر صدا زده نمی‌شود →
   `OnBackInvokedDispatcher` (API 33+) با fallback، بزرگ‌صفحه‌ها قفل orientation را نادیده می‌گیرند.
3. **Toolchain:** AGP 9.4 + Gradle 9.6 + NDK r28 + Build-Tools 36؛ `gradle.properties` را برای AGP 9 بازبینی کن.
4. **Runtime:** nodejs-mobile Node 24 (fork) + better-sqlite3 13 N-API rebuild + حذف `pageSizeCompat` بعد از تأیید هم‌ترازی؛
   بعد از آن سقف Node سرور از 18 به 22+ می‌رود.
5. **توزیع/هویت توسعه‌دهنده:** Android developer verification (از ۲۰۲۶-۰۹-۳۰ در BR/ID/SG/TH، جهانی ۲۰۲۷؛ مسیرهای
   ADB/advanced-flow و حساب توزیع محدود؛ مناطق بدون GMS/تحریمی مستثنا) → **نیاز به تصمیم مالک**.
6. **CI/CD تکرارپذیر:** بیلد اندروید روی GitHub Actions (ubuntu + NDK) با کی‌استور در Secrets، آرتیفکت فقط داخلی.

## ۸. منابع همیشه‌به‌روز (خلاصه)

فهرست کامل با فید RSS/Atom، «چه چیزی را نگاه کن» و «چه سیگنالی = اقدام» در [resources.md](resources.md).
حداقل ماهانه یا قبل از هر بیلد: Android release notes/behavior changes، AGP + Android Studio release notes،
NDK releases، Gradle releases، Play policy/target API، developer verification، nodejs-mobile (رسمی + fork)،
better-sqlite3 releases، Node.js release schedule/security، Android Security Bulletins، Chromium/WebView schedule.

## ۹. الگوی درخواست به Cursor (برای کاربر)

```
/apk  — «نسخهٔ جدید اندروید بساز» ⇒ چک‌لیست ۵.۲ کامل، بدون آپلود APK، فقط manifest + CHANGE-LOG
/apk  — «فقط رفتار X را در اپ عوض کن» ⇒ گردش ۵.۱ (بدون بیلد)
/apk  — «ارتقای targetSdk/AGP/runtime» ⇒ upgrade-plan.md فاز مربوطه با معیار پذیرش و rollback
```
