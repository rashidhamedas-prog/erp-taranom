# ساخت اپلیکیشن اندروید (ERP ترنم — نسخه آفلاین)

**نسخه ۲ (این نسخه):** اپلیکیشن دیگر پوستهٔ آنلاین TWA نیست. یک **Node.js داخلی** (nodejs-mobile) همان بک‌اند سرور مرکزی را با `SYNC_ROLE=device` روی خود گوشی اجرا می‌کند: همه داده‌ها روی دستگاه ذخیره می‌شود، همه عملیات **بدون اینترنت** انجام می‌شود و به‌محض اتصال، تغییرات خودکار با سرور مرکزی همگام می‌شود — دقیقاً مثل نسخه دسکتاپ ویندوز.

## پیش‌نیازها

- **Android Studio** (Hedgehog یا جدیدتر) + **Android SDK 34**
- **NDK** (نسخه پیشنهادی 25.x) و **CMake 3.22.1** — از SDK Manager نصب کنید
- **Node.js 18** روی سیستم توسعه (برای آماده‌سازی node_modules)
- **Java JDK 17**

## مرحله ۱ — دریافت nodejs-mobile

1. از صفحه Releases پروژه nodejs-mobile ( github.com/nodejs-mobile/nodejs-mobile ) آخرین نسخه `nodejs-mobile-v*-android.zip` را دانلود کنید (شامل AAR است)
2. فایل AAR داخل آن را با نام **`nodejs-mobile.aar`** در مسیر `android/app/libs/` قرار دهید
3. تسک‌های Gradle (`extractNodeLibs` / `layoutNodeLibs`) به‌طور خودکار `libnode.so` و هدرها را برای CMake استخراج می‌کنند

## مرحله ۲ — آماده‌سازی node_modules (یک‌بار برای هر نسخه nodejs-mobile)

بک‌اند به `better-sqlite3` (ماژول Native) نیاز دارد که باید برای اندروید کراس‌کامپایل شود:

```bash
cd android/app/src/main/assets/nodejs-project
npm install --omit=dev            # نصب وابستگی‌های خالص جاوااسکریپت

# کراس‌کامپایل better-sqlite3 برای هر ABI (مثال: arm64-v8a)
# مطابق مستندات nodejs-mobile «Native Modules»:
export ANDROID_NDK_HOME=/path/to/ndk/25.2.9519653
export TOOLCHAIN=$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64
export TARGET=aarch64-linux-android
export API=24
export AR=$TOOLCHAIN/bin/llvm-ar
export CC=$TOOLCHAIN/bin/$TARGET$API-clang
export CXX=$TOOLCHAIN/bin/$TARGET$API-clang++
export LINK=$CXX
npm rebuild better-sqlite3 --build-from-source \
  --arch=arm64 --platform=android \
  --nodedir=/path/to/nodejs-mobile/headers
```

> ⚠️ این سخت‌ترین بخش ساخت است. راه ساده‌تر: از **پلاگین nodejs-mobile-react-native** فقط برای تسک Gradle آمادهٔ «BuildNativeModules» آن استفاده کنید، یا باینری از پیش‌ساختهٔ better-sqlite3 برای nodejs-mobile را از جامعه کاربری بردارید. جزئیات: مستندات رسمی nodejs-mobile → «Node.js native modules».

نکته: `sharp` عمداً در package.json اندروید حذف شده — کد سرور آن را اختیاری می‌داند و بدون آن، تصاویر بدون فشرده‌سازی ذخیره می‌شوند.

## مرحله ۳ — ساخت APK

1. پوشه `android/` را در Android Studio باز کنید و منتظر Gradle Sync بمانید
2. تسک `copyServerSources` به‌طور خودکار آخرین سورس `server/` را داخل assets کپی می‌کند
3. `Build → Generate Signed Bundle / APK → APK`
4. Keystore و رمزهایش **در گیت نیستند** (و نباید باشند). فایل `android/keystore.properties` را محلی بسازید (این فایل در `.gitignore` است):

```properties
storeFile=erp-taranom.jks
storePassword=<رمز keystore>
keyAlias=erp-taranom
keyPassword=<رمز کلید>
```

فایل `.jks` را هم کنار آن در پوشه `android/` قرار دهید (مسیر `storeFile` نسبت به پوشه `android/` است). به‌جای فایل properties می‌توانید متغیرهای محیطی `CRM_KEYSTORE_FILE` / `CRM_KEYSTORE_PASSWORD` / `CRM_KEY_ALIAS` / `CRM_KEY_PASSWORD` را ست کنید. اگر هیچ‌کدام تنظیم نشود، بیلد release بدون امضا ساخته می‌شود.

> ⚠️ **چرخش keystore الزامی است**: keystore قبلی و رمز آن در تاریخچه گیت این مخزن افشا شده‌اند. یک keystore جدید بسازید و نسخه‌های بعدی را با آن امضا کنید (کاربران باید نسخه قدیمی را یک‌بار حذف و نسخه جدید را نصب کنند، چون امضا عوض می‌شود):
>
> ```bash
> keytool -genkeypair -v -keystore erp-taranom.jks -alias erp-taranom \
>   -keyalg RSA -keysize 2048 -validity 10000
> ```

یا از خط فرمان:

```bash
cd android
./gradlew assembleRelease
# خروجی: app/build/outputs/apk/release/app-release.apk
```

## توزیع APK (سیاست ۱۴۰۴/۰۴/۲۴)

**APK هرگز روی سرور production آپلود نمی‌شود.** دلایل: فایل ~۶۰MB، آپلود ناپایدار (قطع scp)، و APK خراب روی سرور باعث بنر آپدیت شکسته می‌شد.

1. `scripts/build-android.ps1` را روی ویندوز اجرا کنید
2. خروجی: `server/public/releases/erp-taranom.apk` (فقط محلی)
3. نصب روی گوشی: USB / sideload / ارسال مستقیم — **نه** از `http://45.90.98.99/releases/`
4. `manifest.json` اندروید `url` خالی دارد (`distribution: local`) تا بنر آپدیت لینک شکسته نشان ندهد

## راه‌اندازی اولیه (کاربر نهایی)

1. APK را نصب و باز کنید — چند ثانیه اول، سرور داخلی بالا می‌آید
2. ورود با کاربر پیش‌فرض: `admin` / `admin123`
3. پنجره «اتصال به سرور مرکزی» → آدرس `https://erp.poshaktaranom.com` + نام کاربری/رمز مدیر (یک‌بار، با اینترنت)
4. اگر پیام «قبلاً متصل شده» دیدید یا سینک کار نکرد: در صفحه ورود «قطع اتصال و اتصال مجدد» را بزنید، یا دادهٔ اپ را پاک کنید و از نو وصل شوید
5. از این پس با نام کاربری اصلی خودتان وارد می‌شوید و برنامه کاملاً آفلاین کار می‌کند؛ نشانگر بالای صفحه وضعیت همگام‌سازی را نشان می‌دهد

## معماری

```
MainActivity (WebView) ──► http://127.0.0.1:3210
        │
        └─ nodejs-mobile (libnode.so) ─► assets/nodejs-project/main.js
                                          └─ server/server.js  (SYNC_ROLE=device)
                                              ├─ SQLite:  <files>/crm-data/crm.db
                                              ├─ آپلودها: <files>/crm-data/uploads/
                                              └─ sync client ⇄ سرور مرکزی
```

## نکات

- دادهٔ برنامه در حافظه داخلی خود اپ است (`/data/data/ir.taranom.crm/files/crm-data`) و با حذف اپ پاک می‌شود — قبل از حذف، همگام‌سازی کامل بگیرید
- فایل `assetlinks.json` روی سرور مرکزی برای نسخه TWA قبلی بود؛ نگه داشتن آن ضرری ندارد
- نسخه قبلی (TWA فقط-آنلاین) در تاریخچه گیت موجود است
