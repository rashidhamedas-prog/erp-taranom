---
name: android-apk-taranom
description: اسکیل ساخت/عیب‌یابی/سرعت/سازگاری و سینک APK اندروید برای ERP ترنم. هر بار که کار روی اپ اندروید، بیلد APK، خطای Gradle/NDK، nodejs-mobile، better-sqlite3، بوت/کرش اندروید، انتشار نسخه یا توزیع APK پیش بیاید این اسکیل را فعال کن. این اسکیل روش‌های ساخت APK را روی معماری واقعی پروژه (nodejs-mobile + WebView + سرور Node embedded) سوار می‌کند، نه اپ نیتیو Kotlin.
---

# اسکیل ساخت APK اندروید — ERP ترنم

## ⛔ هشدار بحرانی: این اپ نیتیو Kotlin/Compose نیست

راهنماهای رایج «ساخت APK با Cursor» فرض می‌کنند اپ **Kotlin + Jetpack Compose + Hilt + Room + Retrofit + Gradle Kotlin-DSL + multi-module** است. **اپ اندروید ترنم هیچ‌کدام نیست.** اگر آن الگوها را اجرا کنی، کل اپ را خراب می‌کنی. واقعیت:

| فرض راهنمای ژنریک | واقعیت ترنم |
|---|---|
| Jetpack Compose / Material3 UI | ❌ — **WebView** که `server/public/index.html` را لود می‌کند |
| Kotlin + ViewModel/UseCase/Repository | ❌ — **یک `MainActivity.java`** + بوت‌استرپ nodejs-mobile |
| Room / Retrofit / Hilt / Coil | ❌ — دیتابیس **better-sqlite3** (native، NDK)، شبکه = همان سرور Express داخل گوشی |
| Gradle **Kotlin**-DSL، Compose compiler، KSP | ❌ — **Groovy** `build.gradle`؛ بدون Compose/KSP |
| multi-module / Clean Architecture اندروید | ❌ — منطق در `server/` (Node) است؛ اندروید فقط پوسته |
| افزودن dependency اندروید (compose-bom, hilt, room…) | ❌ — **هیچ‌کدام را اضافه نکن** |

**اصلِ درست راهنما (چک‌لیست، پرامپت ساختاریافته، ADB، بهینه‌سازی Gradle، ProGuard مفهومی) معتبر است — فقط باید روی معماری زیر اجرا شود.**

---

## ۱. معماری واقعی اندروید ترنم

نسخهٔ ۲ به بعد **آفلاین‌فرست** است: یک **Node.js داخلی (nodejs-mobile)** همان بک‌اند `server/` را با `SYNC_ROLE=device` روی خود گوشی اجرا می‌کند؛ `MainActivity.java` یک WebView به `http://127.0.0.1:<port>` باز می‌کند و همان `index.html` را نشان می‌دهد. داده روی دستگاه در SQLite، همه عملیات بدون اینترنت، و همگام‌سازی خودکار هنگام اتصال (مثل نسخهٔ دسکتاپ Electron).

- **پکیج:** `ir.taranom.crm` · **نسخهٔ فعلی:** versionCode 15 / versionName 2.0.13.
- **Gradle:** Groovy · compileSdk 36 · targetSdk 34 · minSdk 24 · **ndkVersion 25.1.8937393** · ABIs: `arm64-v8a, armeabi-v7a, x86_64` (همان‌هایی که nodejs-mobile می‌دهد).
- **JDK 17**؛ امضا از `android/keystore.properties` (در `.gitignore` — **هرگز در git نیست**).
- **کد سرور** داخل `android/app/src/main/assets/nodejs-project/` (کپیِ `server/`).
- **libnode.so** per-ABI از AAR nodejs-mobile؛ **better_sqlite3.node** کراس‌کامپایل NDK.

---

## ۲. روش ساخت (تنها راه درست)

**بیلد فقط با اسکریپت، روی ویندوز:**
```
powershell -ExecutionPolicy Bypass -File scripts/build-android.ps1
```
خروجی: `server/public/releases/erp-taranom.apk` — **فقط محلی**. انتشار کامل (دسکتاپ+اندروید+آپلود) با `scripts/release.ps1`.

مراحل داخل اسکریپت (که Cursor باید حفظ کند، نه بازنویسی):
1. `ANDROID_HOME` + JDK 17 + sdkmanager.
2. استخراج `libnode` (bin/ + include/) از AAR به `app/libnode/`.
3. کراس‌کامپایل `better-sqlite3` برای NDK (`scripts/build-better-sqlite3-android.ps1`) → prebuilt `arm64-v8a/better_sqlite3.node`.
4. `npm install --omit=dev` در `nodejs-project`.
5. حذف `*.gz`/`*.br` از assets (پیشگیری از Duplicate resources).
6. هرس bloat در node_modules (سرعت extraction روی گوشی کم‌رم).
7. نوشتن `local.properties` **بدون BOM**.
8. خارج‌کردن APK قبلی از درخت سرور (پیشگیری از nested packaging).
9. پاک‌کردن artifactهای کهنه + `assembleRelease` + بررسی exit code.

> ⚠️ **قواعد ۱ و ۵ و ۷ و ۸ باگ‌های واقعیِ ثبت‌شده‌اند** (پایین). این اسکریپت را ساده‌سازی/بازنویسی نکن؛ فقط با درک این باگ‌ها ویرایش کن. همهٔ `.ps1`ها باید **ASCII خالص** باشند (کاراکترهای فارسی/em-dash/emoji پارسر PowerShell 5.1 را می‌شکنند).

---

## ۳. باگ‌های واقعی و رفعشان (این‌ها را بلد باش)

| علامت | ریشه | رفع |
|---|---|---|
| Gradle: **SDK location not found** | `local.properties` با BOM (از `Set-Content -Encoding UTF8`) — `java.util.Properties` نمی‌خواند | `[IO.File]::WriteAllText($localProps, "sdk.dir=.../`n")` (بدون BOM) + `ANDROID_HOME` |
| AAPT: **Duplicate resources** (bcryptjs) | AAPT پسوند `.gz` را حذف می‌کند → `foo.js` و `foo.js.gz` تصادم | حذف همهٔ `*.gz`/`*.br` از `nodejs-project` قبل از بیلد |
| APK غول‌پیکر / **nested 300MB APK** | کپی‌شدن APK قبلی داخل درخت سرور در بیلد بعدی | خارج‌کردن APK قبلی از `server/public/releases/` قبل از copyServerSources |
| بیلد «موفق» ولی اپ کهنه/خراب | artifact کهنه باقی می‌ماند و success گزارش می‌شود | پاک‌کردن APKهای قبلی + بررسی `$LASTEXITCODE`/`throw` |
| **صفحهٔ سفید دائمی** بعد از باز شدن | تایم‌اوت کوتاه poll بوت سرور (۳۰ ثانیه) | splash + poll تا ~۱۰ دقیقه در `MainActivity.java` |
| **کرش آنی بوت** (2.0.12) | `process.exit()` در bootstrap کل پروسه را می‌کشد؛ SQLite فقط از assets | حذف `process.exit`؛ مسیر درست SQLite (`main.js`) |
| `dlopen ... _ZN2v811HandleScope...` (better-sqlite3، 2.0.13) | اندروید `libnode` را `RTLD_LOCAL` بار می‌کند؛ نماد V8 دیده نمی‌شود | `dlopen(libnode, RTLD_GLOBAL)`/`promoteNodeSymbols()` + `DT_NEEDED=libnode` + همگام‌سازی jni با prebuilt (`native-lib.cpp`) |
| ELF ناقص/ساختگی در APK | jniLib یا `.node` غلط بسته شده | تأیید ELF بعد از بیلد (بخش ۴) |

---

## ۴. تأیید و تست APK (اجباری قبل از تحویل)

- **بررسی ELF داخل APK:** وجود `lib/<abi>/libnode.so` برای هر سه ABI + فایل `better_sqlite3.node` با magic ELF `7F 45 4C 46`.
- اسکریپت تست: `scripts/test-android-apk.ps1` (بررسی nested-apk، prebuilt، اندازه، ELF).
- نصب و اجرای واقعی: `adb install -r server/public/releases/erp-taranom.apk` → اپ باید باز شود، سرور داخلی بوت شود، login کار کند.
- چون این محیط (Claude Code ریموت) به گوشی/سرور دسترسی ندارد و بیلد اندروید فقط روی ویندوزِ مالک ممکن است، **بیلد و تست نهایی سمت مالک انجام می‌شود**؛ Cursor باید اسکریپت‌ها و کد را درست نگه دارد و لاگ بیلد را تحلیل کند.

---

## ۵. نسخه‌گذاری و توزیع (سیاست سخت‌گیرانه)

- هر انتشار: **افزایش `versionCode` و `versionName`** در `android/app/build.gradle` + به‌روزرسانی `manifest.json`/`sw.js` وب اگر لازم بود.
- امضا: از `android/keystore.properties` یا متغیرهای محیطی `CRM_KEYSTORE_*` — **کلید/رمز هرگز در git یا در پاسخ API نباشد**.
- **APK به `server/public/releases/` روی همان هاست آپلود می‌شود** (مالک از آن‌جا دانلود می‌کند). **هرگز APK را با scp به مسیر production `/releases/` نبر**؛ توزیع به دستگاه‌ها فقط USB/انتقال مستقیم/دانلود از هاست.
- APK را در git کامیت نکن.

---

## ۶. آنچه از راهنمای ژنریک هنوز مفید است

- **دستورات ADB** (نصب/لاگ/دیباگ) معتبرند: `adb install -r`, `adb logcat`, `adb devices`, `adb shell dumpsys meminfo ir.taranom.crm`.
- **مفهوم** minSdk/targetSdk، ProGuard/shrink، بهینه‌سازی Gradle (`org.gradle.parallel/caching/daemon`) — با احتیاط و بدون تغییر ABI/NDK.
- چک‌لیست قبل از انتشار (نسخه، امضا، تست روی دستگاه، اندازهٔ APK).
- **بقیهٔ راهنما (Compose/Hilt/Room/Retrofit/Kotlin-DSL/multi-module/CI اندروید نیتیو) را نادیده بگیر.**

---

## ۷. الگوی پرامپت درست برای Cursor روی این اپ

```
زمینه: اپ اندروید ترنم = WebView + nodejs-mobile (سرور Node/Express embedded)، نه نیتیو Kotlin.
کار: <مثلاً «رفع کرش بوت روی اندروید ۹»>.
قیود:
- کد اندروید فقط MainActivity.java + بوت‌استرپ nodejs-mobile؛ منطق در server/ است.
- دیتابیس better-sqlite3 (NDK)؛ به مسیر SQLite و RTLD_GLOBAL دست نزن مگر با دلیل.
- بیلد فقط با scripts/build-android.ps1؛ .ps1 باید ASCII خالص باشد.
- local.properties بدون BOM؛ *.gz/*.br حذف؛ APK قبلی از درخت سرور خارج.
- versionCode/versionName را بالا ببر؛ APK فقط به releases محلی، نه production.
- بعد از تغییر: تأیید ELF + adb install تست + به‌روزرسانی BUILD.md/Help/CHANGE-LOG.
خروجی: تغییر حداقلی + تحلیل لاگ بیلد، بدون افزودن هیچ dependency اندروید نیتیو.
```

---

## ۸. قواعد مخزن (بعد از هر تغییر)

- **Help** (`renderAdminGuide`/`renderSalesGuide`) + `docs/CHANGE-LOG.md` + `android/BUILD.md` را به‌روز کن (اگر رویه عوض شد).
- تست‌های بک‌اند سبز بماند (`test-sms`/`test-sync`/`test:production`) چون همان سرور روی گوشی اجرا می‌شود.
- commit و push روی `claude/claude-md-docs-2ssrpy`؛ آرایهٔ `sync/tables.js` **APPEND-ONLY**.
- بدون افزودن وابستگی/CDN جدید (آفلاین‌فرست).

> جمع‌بندی: قدرت این اپ در **اشتراک کامل بک‌اند بین وب/دسکتاپ/اندروید** است. کار اندروید یعنی درست نگه‌داشتنِ پوستهٔ nodejs-mobile/WebView و زنجیرهٔ بیلد (libnode + better-sqlite3 + assets)، نه ساختن یک اپ نیتیو. تمام «مشکل APK»های واقعیِ این پروژه در بخش ۳ فهرست شده‌اند.
