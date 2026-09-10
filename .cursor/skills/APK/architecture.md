# معماری اپ اندروید ERP ترنم — نسخهٔ قابل‌اجرا

ساختار این سند از اسکیل `tap-solution-architecture` پیروی می‌کند (فرضیات → زمینه → ماژول‌ها → مالکیت داده →
API/رویداد → امنیت → استقرار → توالی‌های بحرانی → تست → rollout → ریسک → تصمیم‌ها). هر «واقعیت» از کد فعلی
ریپو استخراج شده؛ هر «پیشنهاد» با برچسب **[پیشنهاد]** مشخص است.

## ۱. فرضیات و محدوده

- اپ برای **نمایندگان فروش و انبار** پوشاک ترنم است: ثبت مشتری/فاکتور/دریافت به‌صورت آفلاین و همگام‌سازی با مرکز.
- سرور مرکزی: ایران `94.249.244.208` (`/home/taranom/crm-taranom`, PM2 `erp-taranom`, دامنهٔ `erp.poshaktaranom.com`).
- دستگاه‌ها: Android ≥ 7.0 (API 24)، ABIهای `arm64-v8a` (اصلی)، `armeabi-v7a` (قدیمی)، `x86_64` (امولاتور).
- توزیع **خارج از Google Play** (sideload)؛ به دلیل تحریم، حساب Play/Azure/Google Cloud فرض نمی‌شود.
- تعداد دستگاه‌ها کم (ده‌ها، نه هزاران)؛ بیلد روی ماشین ویندوزی مالک انجام می‌شود.
- خارج از محدوده: بازنویسی نیتیو (Kotlin/Compose)، انتشار در Play، iOS.

## ۲. زمینه (C4 سطح ۱)

```
[نمایندهٔ فروش] ──لمس/UI──▶ [اپ اندروید ترنم] ──HTTPS (sync, update-check, apk)──▶ [سرور مرکزی ایران]
                                   │                                              │
                                   └── WebView ◀── 127.0.0.1:3210 ── Node embedded  └── manifest.json / api/sync
[مدیر/حسابدار] ──مرورگر──▶ [وب مرکزی]   (همان index.html؛ نقش‌ها و centralOnly)
```

## ۳. ماژول‌ها (C4 سطح ۲/۳)

| ماژول | فایل‌ها | مسئولیت | مرز/قرارداد |
|---|---|---|---|
| Shell (Activity) | `MainActivity.java` | چرخهٔ حیات، استخراج assets، راه‌اندازی Node، polling `server.ready`/health، WebView، bridge، آپدیت APK | فقط با Node از طریق argv/فایل‌های `server.ready`/`server.fail` و HTTP loopback حرف می‌زند |
| JNI Launcher | `native-lib.cpp`, `CMakeLists.txt` | `startNodeWithArguments` → `node::Start`; promote نمادهای libnode با RTLD_GLOBAL؛ preload `libbetter_sqlite3.so` | لینک `-Wl,-z,max-page-size=16384`; هیچ منطق تجاری |
| Runtime | `libnode.so` per ABI (nodejs-mobile) + `libc++_shared.so` | موتور Node/V8/OpenSSL | نسخهٔ Node = سقف ویژگی‌های JS سرور |
| Bootstrap | `assets/nodejs-project/main.js` | تنظیم env (`APP_VERSION`, `SYNC_ROLE=device`, `APP_PLATFORM=android`, `LISTEN_HOST=127.0.0.1`, `DB_PATH`, `UPLOADS_DIR`, `TMPDIR`, `JWT_SECRET`)، مسدودکردن `process.exit`، redirect بارگذاری `.node` به `nativeLibraryDir` | تنها جای تزریق پیکربندی پلتفرم |
| Server | `server/**` (کپی زمان بیلد) | همان بک‌اند مرکز؛ `centralOnly` ⇒ 403 روی دستگاه | drift صفر با `server/` ریپو (`test-embedded-release.js`) |
| Sync engine | `server/sync/*`, `server/routes/sync.js` | outbox عملیات، pull افزایشی، tombstone، محدودهٔ id دستگاه، تعارض برای بازبینی انسانی | جدول‌ها append-only |
| Frontend | `server/public/index.html` (+ `app.js`, `sw.js`) | UI تک‌فایل؛ تشخیص `APP_PLATFORM` برای bridge | فقط fetch نسبی به `/api/*` |
| Update client | `MainActivity` (`downloadVerifiedApk`) + `server/lib/app-update.js` | چک نسخه، دانلود تأییدشده، نصب | منبع حقیقت: `server/public/releases/manifest.json` روی مرکز |
| Build pipeline | `scripts/build-android.ps1`, `build-better-sqlite3-android.ps1`, `embedded-server-files.js`, تسک‌های Gradle | تولید APK تکرارپذیر | خروجی فقط محلی |

## ۴. مالکیت داده (روی دستگاه)

| داده | مسیر | مالک | پشتیبان/انتقال |
|---|---|---|---|
| SQLite (`crm.db` + WAL) | `filesDir/data/` (`DB_PATH`) | Server | بکاپ داخلی برنامه؛ `allowBackup=false` (بکاپ ابری خاموش) |
| Uploads/تصاویر | `filesDir/uploads/` | Server (`files.js`) | با sync فایل‌ها |
| JWT secret | AndroidKeyStore (AES-GCM) → argv به Node | Shell | هرگز در SharedPreferences خام/لاگ |
| assets استخراج‌شده | `filesDir/nodejs-project/` (+ نسخه‌گذاری با hash) | Shell | بازنویسی در هر نصب/آپدیت |
| APK دانلودی | `cacheDir`/`externalCacheDir` | Shell | حذف بعد از نصب |
| فلگ‌های boot | `server.ready`, `server.fail` | Server ↔ Shell | پاک‌سازی در هر شروع |

id ردیف‌های ساخته‌شده روی دستگاه در **بازهٔ رزرو‌شدهٔ بالا** (`sync/tables.js`) است؛ remap در مرکز.

## ۵. APIها و رویدادها

- **HTTP محلی:** `http://127.0.0.1:3210/api/*` (فقط loopback؛ `network_security_config` اجازهٔ cleartext فقط برای loopback).
- **Bridge JS→Java (`AndroidBridge`):** `notifyUpdate(json)`, `downloadVerifiedApk(url, sha256, size, versionCode)`.
  **[پیشنهاد]** هر متد جدید bridge: ورودی‌ها را در Java اعتبارسنجی کن، هرگز مسیر فایل خام از JS نگیر.
- **Java→JS:** `evaluateJavascript` برای وضعیت آپدیت/دانلود (درصد، خطا).
- **آپدیت:** `GET /api/system/app-info`, `GET /api/system/app-update?platform=android&current=`, فید دسکتاپ `/api/system/update-feed`.
- **سینک:** `POST /api/sync/push` (outbox replay در مرکز از طریق loopback HTTP روی route واقعی)، `GET /api/sync/pull?since=`.
- **رویدادهای Shell:** `onPageFinished` → پنهان‌کردن splash؛ `onRenderProcessGone` → reload؛ back → `webView.goBack()`
  (**[پیشنهاد]** مهاجرت به `OnBackInvokedDispatcher` برای targetSdk 36).

## ۶. امنیت (کنترل‌های فعلی + پیشنهاد)

| تهدید | کنترل فعلی | وضعیت/پیشنهاد |
|---|---|---|
| اپ تقلبی/آپدیت جعلی | HTTPS + allowlist میزبان + SHA-256 + size + package + versionCode + مقایسهٔ signer digest قبل از نصب | ✅؛ **[پیشنهاد]** pin کردن digest signer در `BuildConfig` نه رشتهٔ دستی |
| دسترسی محلی به DB/Secret | `allowBackup=false`، JWT در KeyStore، `filesDir` خصوصی | ✅؛ **[پیشنهاد]** SQLCipher/`PRAGMA` رمزنگاری در آینده در صورت نیاز حسابداری |
| WebView ناامن | JS فقط برای origin loopback، `setAllowFileAccess(false)`, `setAllowContentAccess(false)`, بدون `file://`, mixed-content ممنوع، لینک خارجی → مرورگر | ✅ (۲۷ چک `test-android-platform-security.js`) |
| MITM شبکه | `usesCleartextTraffic=false`; sync فقط HTTPS | ✅؛ **[پیشنهاد]** certificate pinning اختیاری برای دامنهٔ مرکز (با برنامهٔ چرخش) |
| Runtime قدیمی (Node 18 EOL) | — | ⚠️ ریسک باز → فاز ۴ upgrade-plan |
| لو رفتن کی‌استور | کی‌استور جدید، gitignore، README | ✅؛ **[پیشنهاد]** نگهداری در password manager + نسخهٔ آفلاین |
| debug leftovers | sync-hygiene | ⚠️ بلوک `agentLog` در `main.js` باید حذف شود |
| مجوزها | INTERNET, ACCESS_NETWORK_STATE, POST_NOTIFICATIONS, VIBRATE, REQUEST_INSTALL_PACKAGES | حداقلی ✅ |

## ۷. استقرار و توزیع

- **محیط بیلد:** ویندوز، JDK 17، Android SDK (`platforms;android-36`, `build-tools;36.1.0`, `ndk;25.1.8937393`, `cmake;3.22.1`),
  Node ≥ 18 (برای اسکریپت‌ها)، اینترنت (پروکسی) برای Gradle/nodejs-mobile.
- **خروجی:** `server/public/releases/erp-taranom.apk` (gitignored). **هیچ‌گاه** روی سرور production کپی نمی‌شود.
- **متادیتا:** `manifest.json` روی سرور مرکزی؛ `url` باید به میزبانی HTTPS مجاز (`APK_UPDATE_HOSTS`) اشاره کند.
- **توزیع دستگاه:** USB/انتقال فایل + «نصب از منابع ناشناس» برای اپ فایل‌منیجر؛ یا دانلود درون‌برنامه از میزبان مجاز.
- **[پیشنهاد] CI:** GitHub Actions `ubuntu-latest` + `android-actions/setup-android` + کش Gradle/NDK؛ کی‌استور به‌صورت base64 در Secrets؛
  آرتیفکت با retention کوتاه؛ هیچ آپلودی به سرور.

## ۸. توالی‌های بحرانی

### ۸.۱ Boot
1. `onCreate` → `System.loadLibrary("c++_shared")`, `node`, `native-lib`.
2. استخراج `nodejs-project` از assets به `filesDir` (اگر hash تغییر کرده) → حذف `server.ready/server.fail`.
3. `launchNodeServer(argv=[node, main.js, dataDir, port, nativeLibDir, jwtSecret])` روی thread جدا.
4. `main.js`: env → `ensureBetterSqlite3Native()` → `require('./server/server.js')` → listen 127.0.0.1:3210 → `server.ready`.
5. Shell: poll `server.ready` + `GET /api/system/health` (تا 600s) → `webView.loadUrl`.
6. شکست: `server.fail` با متن خطا → صفحهٔ خطا با گزینهٔ «تلاش مجدد/ارسال لاگ».

### ۸.۲ آپدیت درون‌برنامه
UI → `/api/system/app-update` → `notifyUpdate` → دانلود با `HttpsURLConnection` (فقط allowlist) → نوشتن در cache →
تأیید SHA-256/size → `PackageManager.getPackageArchiveInfo` (package/versionCode) → مقایسهٔ signer با اپ فعلی →
`ACTION_INSTALL_PACKAGE` (FileProvider) → کاربر تأیید سیستم → نصب.

### ۸.۳ بارگذاری ماژول نیتیو
`require('better-sqlite3')` → `bindings` → hook در `main.js` → `process.dlopen(nativeLibraryDir/libbetter_sqlite3.so)`;
پیش‌نیاز: `DT_NEEDED=libnode.so` و نمادهای libnode با RTLD_GLOBAL (JNI) تا نمادهای V8/N-API resolve شوند.

### ۸.۴ سینک با تعارض
outbox دستگاه → push → مرکز عملیات را روی route واقعی replay می‌کند → تعارض = `sync_conflicts` برای بازبینی انسانی؛
هیچ اعمال خودکار. دستگاه بعد از ack، pull افزایشی می‌گیرد.

## ۹. تست و کیفیت (گیت‌های اجباری)

| گیت | فرمان | چه چیزی را می‌گیرد |
|---|---|---|
| بک‌اند | `node server/scripts/test-sms.js`, `node server/scripts/test-sync.js` | رگرسیون منطق/سینک |
| فرانت | پارس `<script>` با `new Function()` | خطای نحوی |
| Drift | `node scripts/test-embedded-release.js` | اختلاف کپی سرور با ریپو، `release_id` |
| امنیت پلتفرم | `node scripts/test-android-platform-security.js` | manifest/WebView/update policy |
| آرتیفکت | `scripts/test-android-apk.ps1` | ELF per-ABI، libc++, نبود APK تودرتو، marker نسخه |
| امضا | `apksigner verify --print-certs` | signer درست |
| **[پیشنهاد]** ۱۶KB | `llvm-readelf -l` روی هر `.so` → `LOAD` align `0x4000` | سازگاری دستگاه‌های ۱۶KB |
| **[پیشنهاد]** Smoke دستگاه | `adb forward tcp:3210 tcp:3210` + اسکریپت health/login | boot واقعی روی ABI هدف |
| **[پیشنهاد]** سازگاری Node runtime | `eslint-plugin-n` با `engines.node` = نسخهٔ runtime اندروید | استفاده از API جدیدتر از runtime |

## ۱۰. Rollout و Rollback

- **Rollout:** ابتدا ۱–۲ دستگاه پایلوت (`adb install -r`) → ۲۴ ساعت مشاهدهٔ سینک/لاگ → انتشار `manifest.json` برای همه.
- **Rollback:** `manifest.json` را به نسخهٔ قبلی برگردان (اعلان آپدیت متوقف می‌شود)؛ برای دستگاه‌های آپدیت‌شده،
  نصب APK قبلی فقط با uninstall (Android downgrade را رد می‌کند) → قبل از uninstall، بکاپ درون‌برنامه و push کامل outbox.
- **مهاجرت اسکیما:** `initDB()` idempotent است؛ downgrade سرور با DB جدید تضمین نمی‌شود → همیشه بکاپ قبل از آپدیت.

## ۱۱. ریسک‌ها

| ریسک | احتمال/اثر | کاهش |
|---|---|---|
| Node 18 embedded بدون پچ امنیتی | بالا/بالا | فاز ۴ upgrade-plan؛ تا آن زمان حداقل سطح حمله (loopback-only، بدون ورودی خارجی مستقیم) |
| فورک nodejs-mobile جوان (prerelease) | متوسط/بالا | پایلوت روی امولاتور + ۲ دستگاه؛ نگه‌داشتن مسیر بازگشت به 18.20.4؛ pin با SHA-256 zip |
| targetSdk 34 و رفتارهای جدید Android 16/17 | متوسط/متوسط | فاز ۲؛ تست predictive back/insets |
| developer verification (۲۰۲۷ جهانی) | نامشخص/بالا | تصمیم مالک؛ گزینه‌های ADB/limited-distribution/verification |
| بیلد فقط روی یک ماشین | متوسط/بالا | CI پیشنهادی + مستندسازی نسخه‌های ابزار (این اسکیل) |
| کی‌استور از دست برود | کم/بحرانی | نسخهٔ آفلاین + password manager؛ بدون آن آپدیت درجا ناممکن است |

## ۱۲. تصمیم‌های نیازمند تأیید مالک

1. زمان‌بندی مهاجرت runtime به Node 24 (fork) و پذیرش ریسک prerelease.
2. targetSdk 36 اکنون یا هم‌زمان با ارتقای toolchain؟ (ترجیح: هم‌زمان، یک بیلد آزمایشی).
3. راهبرد developer verification برای ۲۰۲۷ (ADB/advanced flow، حساب توزیع محدود، یا verification کامل اگر ممکن).
4. حذف `armeabi-v7a` برای کوچک‌کردن APK (فقط اگر هیچ دستگاه ۳۲بیتی در ناوگان نیست).
5. راه‌اندازی CI اندروید و محل نگهداری کی‌استور (Secrets مخزن خصوصی).
6. certificate pinning برای دامنهٔ مرکز (نیاز به برنامهٔ چرخش گواهی).
