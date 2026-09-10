# نقشهٔ مدرن‌سازی اپ اندروید (وضعیت ۲۰۲۶-۰۹-۱۰)

هر فاز مستقل commit می‌شود، معیار پذیرش صریح دارد و مسیر بازگشت مشخص. **هیچ فازی بیلد کامل را بدون درخواست صریح مالک
اجرا نمی‌کند**؛ اما فازهای ۲ تا ۴ برای تأیید نهایی به یک بیلد آزمایشی نیاز دارند — قبل از شروع، تأیید بگیر.

## فاز ۰ — بهداشت (بدون ریسک، اکنون)

| کار | فایل | معیار پذیرش |
|---|---|---|
| حذف بلوک `agentLog`/`fetch('http://127.0.0.1:7289/ingest/...')` | `android/app/src/main/assets/nodejs-project/main.js` | `grep -n ingest main.js` خالی؛ `test-android-platform-security.js` سبز |
| CI از Node 20 (EOL ۲۰۲۶-۰۴-۳۰) به 22 یا 24 | `.github/workflows/wave0-gate.yml` | گیت سبز روی Node جدید |
| `scripts/release.ps1` هنوز `45.90.98.99:2299 taranom-admin` | `scripts/release.ps1` | حذف یا اصلاح به سرور ایران؛ هیچ اسکریپتی APK را آپلود نکند |
| pin SHA-256 برای zip nodejs-mobile در اسکریپت بیلد | `scripts/build-android.ps1` | دانلود بدون hash صحیح شکست بخورد |
| چک هم‌ترازی ۱۶KB به تست آرتیفکت | `scripts/test-android-apk.ps1` | گزارش align هر `.so`؛ ابتدا warning، بعد از فاز ۴ fail |
| گیت سازگاری Node runtime | `eslint` + `eslint-plugin-n` با `engines.node` = نسخهٔ runtime اندروید | استفاده از API جدیدتر از runtime در `server/` خطا بدهد |

## فاز ۱ — متادیتا و مستندات

- `docs/skills/android-apk-taranom.md` → اشاره به این اسکیل به‌عنوان مرجع جاری (نه حذف؛ تاریخچهٔ باگ‌ها ارزشمند است).
- `manifest.json`: فیلدهای `sha256/size/url` اندروید همیشه پر باشند؛ `distribution` = `local` تا میزبانی HTTPS مجاز تعیین شود.

## فاز ۲ — targetSdk 36 (Android 16) و آمادگی برای 37

پیش‌نیاز: compileSdk 36 (موجود). تغییرات رفتاری که **این اپ** را می‌گیرند:

| رفتار Android 16 (targetSdk ≥ 36) | اثر روی اپ | اقدام |
|---|---|---|
| edge-to-edge اجباری؛ `windowOptOutEdgeToEdgeEnforcement` غیرفعال | WebView زیر status/navigation bar می‌رود؛ فیلدها زیر کیبورد | در `MainActivity`: `setOnApplyWindowInsetsListener` روی WebView و اعمال padding از `systemBars()`+`ime()`؛ یا تکیه بر WebView M144+ (insets داخلی) و تست روی WebView قدیمی‌تر |
| predictive back: `onBackPressed` و `KEYCODE_BACK` صدا زده نمی‌شوند | دکمهٔ برگشت دیگر `webView.goBack()` را اجرا نمی‌کند | API ≥ 33: `getOnBackInvokedDispatcher().registerOnBackInvokedCallback(PRIORITY_DEFAULT, cb)`; در cb اگر `canGoBack()` → `goBack()` وگرنه unregister و `finish()`؛ API < 33: `onBackPressed` فعلی. راه موقت: `android:enableOnBackInvokedCallback="false"` |
| بزرگ‌صفحه‌ها (sw ≥ 600dp) قفل orientation/resizability را نادیده می‌گیرند | UI تک‌فایل باید در landscape/تبلت درست باشد | تست index.html در عرض ≥ 600dp |
| ۱۶KB الزامی برای Play (برای sideload الزامی نیست ولی دستگاه‌های ۱۶KB زیاد می‌شوند) | libnode 18 با align 4KB | `pageSizeCompat` تا فاز ۴ |
| Android 17 (API 37): ECH در TLS، `MessageQueue` جدید | بی‌اثر برای WebView shell؛ ECH فقط اگر سرور پشتیبانی کند | هیچ |

معیار پذیرش: بیلد آزمایشی روی امولاتور API 36 و یک دستگاه واقعی → back درست، هیچ عنصر UI زیر bar/کیبورد، ۲۷ چک امنیتی سبز.
بازگشت: `targetSdk 34` در یک commit.

## فاز ۳ — Toolchain: AGP 9.4 / Gradle 9.6 / NDK r28 / Build-Tools 36

| مؤلفه | از → به | نکات مهاجرت |
|---|---|---|
| AGP | 8.5.2 → 9.4.0 | JDK ≥ 17 (17 نگه‌دار یا 21)؛ AGP 9 پیش‌فرض‌های جدید (built-in Kotlin—بی‌اثر برای Java خالص، `android.builtInKotlin`)، حذف برخی APIهای منسوخ DSL؛ `suppressUnsupportedCompileSdk` را پاک کن |
| Gradle wrapper | 8.7 → 9.6.x | `distributionSha256Sum` را در `gradle-wrapper.properties` اضافه کن؛ Gradle 9 روی JDK 17–25 اجرا می‌شود |
| Build-Tools | 36.1.0 → 36.x/37.x | مسیر `apksigner` در اسکریپت بیلد را پارامتری کن |
| NDK | 25.1.8937393 → 28.2.13676358 | ۱۶KB پیش‌فرض؛ `native-lib.cpp` باید بدون تغییر کامپایل شود؛ `build-better-sqlite3-android.ps1` مسیر toolchain را از `ndkVersion` بخواند |
| CMake | 3.22.1 → 3.31.x (SDK) | اختیاری؛ `externalNativeBuild.cmake.version` |
| `gradle.properties` | — | `org.gradle.configuration-cache` را بعد از سبزشدن فعال کن؛ `android.useAndroidX=false` بماند مگر برای predictive back از AndroidX استفاده کنی |

معیار پذیرش: `gradlew assembleRelease --no-daemon` سبز، `test-android-apk.ps1` سبز، اندازهٔ APK ± ۱۰٪.
بازگشت: revert commit toolchain (Gradle cache دست‌نخورده می‌ماند).

## فاز ۴ — Runtime: nodejs-mobile Node 24 + better-sqlite3 13 (N-API) + حذف pageSizeCompat

چرا: Node 18 از آوریل ۲۰۲۵ EOL است (OpenSSL 3.0.x بدون پچ در embed)، سقف ویژگی‌های JS سرور را پایین نگه می‌دارد، و libnode آن
۱۶KB نیست. فورک `gmaclennan/nodejs-mobile` (v24.18.0-0، ۲۰۲۶-۰۸-۱۱) با NDK r27d، ۱۶KB، مدل patches-only و تست روی دستگاه واقعی
منتشر شده، ولی **prerelease** است.

گام‌ها:
1. **PoC جدا از شاخهٔ اصلی:** دانلود `nodejs-mobile-android-24.18.0-0.zip` (SHA-256 اعلام‌شده در release) → `android/app/libnode/`.
   `lite` (بدون ICU/inspector/sqlite) برای این اپ کافی نیست اگر به `Intl` فارسی (اعداد/تاریخ) تکیه می‌کنی → **full**.
2. `nodejs-project/package.json`: `better-sqlite3` → `^13.0.3` (N-API؛ Node ≥ 22). کراس‌کامپایل با `node-gyp` + هدرهای Node 24 از zip
   (`include/`)؛ N-API یعنی `.node` بین نسخه‌های آیندهٔ Node 24/26 قابل استفاده می‌ماند. چک `DT_NEEDED libnode.so` و align `0x4000`.
3. `main.js`: حذف hackهای مخصوص Node 18 (اگر هست)؛ `process.versions.mobile` را در `/api/system/app-info` گزارش کن.
4. Manifest: بعد از تأیید align همهٔ `.so`، `android:pageSizeCompat` حذف شود؛ `extractNativeLibs=true` بماند (redirect `.node` به آن تکیه دارد).
5. سقف Node سرور: `engines.node` در `server/package.json` → `>=22`؛ گیت eslint-n به‌روز.
6. تست: امولاتور x86_64 API 36 با ۱۶KB (`-feature -PageSize16k` در AVD)، دستگاه arm64 واقعی، armeabi-v7a قدیمی.

معیار پذیرش: boot < ۱۵s روی دستگاه میانی، تست‌های sync/sms روی runtime جدید (از طریق `adb forward`)، ۲۴ ساعت پایلوت بدون crash.
بازگشت: zip 18.20.4 + better-sqlite3 9.x + `pageSizeCompat` (همه در یک commit جدا نگه داشته شود).

## فاز ۵ — توزیع و هویت توسعه‌دهنده (تصمیم مالک)

Android developer verification: از ۲۰۲۶-۰۹-۳۰ در برزیل/اندونزی/سنگاپور/تایلند برای دستگاه‌های certified (GMS) اعمال می‌شود و ۲۰۲۷
جهانی می‌شود. گوگل مسیر «advanced flow»/ADB برای کاربران آگاه، حساب‌های توزیع محدود (سقف دستگاه)، و مستثنا بودن مناطق بدون
پشتیبانی Play/GMS را اعلام کرده. وضعیت ایران را قبل از ۲۰۲۷ از صفحهٔ رسمی (resources.md) دوباره بخوان.

گزینه‌ها:
| گزینه | هزینه/ریسک | مناسب اگر |
|---|---|---|
| ادامهٔ sideload + راهنمای ADB/advanced flow برای نمایندگان | کم؛ UX سخت‌تر | ناوگان کوچک و تحت کنترل |
| حساب توزیع محدود (بدون D-U-N-S، سقف دستگاه) | متوسط؛ محدودیت تعداد | ≤ سقف اعلام‌شده دستگاه |
| verification کامل (شناسه، هزینه، شاید D-U-N-S) | تحریم/پرداخت ممکن نیست | اگر شرکت خارجی/نمایندهٔ ثبت‌شده دارید |

## فاز ۶ — CI/CD تکرارپذیر

- ورک‌فلو `android-build.yml` (پیش‌نویس در build-pipeline.md §۸) با اسکریپت bash معادل `.ps1`.
- pin کامل: `distributionSha256Sum`, hash zip nodejs-mobile, `package-lock.json` assets، نسخهٔ NDK از `ndkVersion`.
- آرتیفکت فقط داخلی؛ انتشار متادیتا با همان `generate-release.js`.

## ترتیب پیشنهادی و وابستگی

```
فاز ۰ ──▶ فاز ۱ ──▶ فاز ۳ (toolchain) ──▶ فاز ۲ (targetSdk 36) ──▶ فاز ۴ (runtime) ──▶ فاز ۶ (CI)
                                                 └────────── فاز ۵ (تصمیم توزیع، موازی) ─────────┘
```

فاز ۳ قبل از ۲ چون AGP 9 با compileSdk 37/targetSdk 36 پشتیبانی رسمی دارد و خطاهای DSL را زودتر می‌گیری.
