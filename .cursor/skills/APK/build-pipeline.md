# خط تولید APK — اجرا، تأیید، انتشار، عیب‌یابی

این سند «چطور» است. سیاست‌ها (بدون بیلد مگر درخواست صریح، بدون آپلود APK، بدون راز در git) در `SKILL.md`.

## ۱. پیش‌نیازهای ماشین بیلد (ویندوز)

| نیاز | چطور بررسی/نصب |
|---|---|
| JDK 17 (Microsoft OpenJDK یا Temurin) | `java -version`؛ اسکریپت در نبود آن `winget install Microsoft.OpenJDK.17` را می‌زند |
| Android SDK + cmdline-tools | `%LOCALAPPDATA%\Android\Sdk` یا `ANDROID_HOME`; اسکریپت `platforms;android-36 build-tools;36.1.0 ndk;25.1.8937393 cmake;3.22.1` را نصب می‌کند |
| Node ≥ 18 + npm | برای اسکریپت‌های `scripts/*.js` و npm install assets |
| Python 3 (node-gyp) + Visual Studio Build Tools *لازم نیست* | کراس‌کامپایل با clang NDK انجام می‌شود، نه MSVC؛ node-gyp فقط به Python نیاز دارد |
| اینترنت/پروکسی | دانلود Gradle، وابستگی‌های Maven (میرور aliyun در `android/build.gradle`)، zip nodejs-mobile از GitHub |
| فضای دیسک | ≥ 10 GB (NDK، Gradle cache، `.cxx`) |
| adb (platform-tools) | برای نصب/لاگ دستگاه |

پروکسی برای Node/npm در همان شل (قانون کاربر): `$env:HTTP_PROXY="http://127.0.0.1:PORT"; $env:HTTPS_PROXY=$env:HTTP_PROXY`.
برای Gradle: `android/gradle.properties` یا `~/.gradle/gradle.properties` (`systemProp.https.proxyHost/Port`) — رمز پروکسی commit نشود.

## ۲. Version bump (هم‌زمان، قبل از بیلد)

1. `android/app/build.gradle`: `versionCode` +1 (عدد صحیح، همیشه افزایشی)، `versionName` = نسخهٔ semver (مثلاً `2.0.34`).
2. `android/app/src/main/assets/nodejs-project/main.js`: `APP_VERSION = '2.0.34'`.
3. `scripts/test-android-apk.ps1`: marker `APP_VERSION = '2.0.34'` (تست شکست می‌خورد اگر جا بماند — عمدی است).
4. `server/public/releases/manifest.json` → بخش `android` بعد از بیلد (بخش ۶).
5. `docs/CHANGE-LOG.md` ورودی جدید.

## ۳. اجرای بیلد (ترتیب واقعی اسکریپت `scripts/build-android.ps1`)

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-android.ps1
```

مراحل داخل اسکریپت (برای تشخیص محل خطا):

1. **JDK/SDK:** یافتن java، نصب پکیج‌های SDK، قبول لایسنس.
2. **libnode:** اگر `android/app/libnode/bin/arm64-v8a/libnode.so` نیست → دانلود zip nodejs-mobile (نسخهٔ پین‌شده در اسکریپت)
   → کپی `bin/` و `include/` به `android/app/libnode/` (Gradle: `jniLibs.srcDirs += ['libnode/bin']`).
3. **better-sqlite3:** اگر `.node` per-ABI موجود نیست → `scripts/build-better-sqlite3-android.ps1`:
   `npm install --omit=dev` در `nodejs-project`، برای هر ABI `CC/CXX` = clang NDK (`<target><api>-clang.cmd`)،
   `LDFLAGS='-shared -Wl,-z,max-page-size=16384 -Wl,--no-as-needed -L<libnode> -lnode'`,
   `npx node-gyp@10.2.0 rebuild --release --arch=<arch> -f make` → خروجی `prebuilt/android/<abi>/better_sqlite3.node`
   → چک `llvm-readelf -d` باید `NEEDED libnode.so` داشته باشد (وگرنه FATAL).
4. **npm install assets** (فقط اگر `node_modules` یا `thirty-two` ناقص است) → **prune** (حذف تست/داک/`.md`/باینری‌های غیرلازم؛
   هرگز `.js` زیر `lib/` پاک نمی‌شود) → شیم `thirty-two/index.js` → smoke `require('thirty-two'); require('otplib'); require('adm-zip')`.
5. **کپی سرور:** تسک Gradle `copyServerSources` → `node scripts/prepare-embedded-server.js android` (کپی `server/` با قواعد
   `embedded-server-files.js`: بدون `node_modules`, `*.db*`, `backups`, `uploads`, `releases/*.apk|*.exe`).
6. **گارد APK تودرتو:** APK قبلی از `server/public/releases` خارج می‌شود تا داخل assets بسته نشود (علت OOM تاریخی).
7. **Gradle:** تولید wrapper در نبود، پاک‌کردن `mergeReleaseAssets` کهنه، `gradlew.bat assembleRelease --no-daemon --rerun-tasks`
   (تنظیمات کم‌حافظه: `-Xmx1536m`, `org.gradle.parallel=false`, `workers.max=1`).
8. **امضا:** اگر Gradle امضا نکرده باشد، `apksigner sign --ks <jks> ...` با مقادیر `keystore.properties` (چاپ نمی‌شود).
9. **خروجی:** `server/public/releases/erp-taranom.apk` (+ کپی legacy) → `scripts/test-android-apk.ps1` اجرا می‌شود.

`scripts/finalize-android-release.ps1` همین بیلد را صدا می‌زند و `android-build-report.txt` (SHA-256/size/ELF per ABI) می‌نویسد.

## ۴. تأیید (همه باید سبز باشند)

```powershell
powershell -ExecutionPolicy Bypass -File scripts/test-android-apk.ps1        # ELF, libc++, better_sqlite3, no nested apk, version marker
node scripts/test-android-platform-security.js                               # 27 static checks
node scripts/test-embedded-release.js                                        # drift = 0, release_id
& "$env:ANDROID_HOME\build-tools\36.1.0\apksigner.bat" verify --print-certs server\public\releases\erp-taranom.apk
```

هم‌ترازی ۱۶KB (تا زمانی که `pageSizeCompat` حذف نشده، اطلاع‌رسانی است؛ بعد از حذف، اجباری):

```powershell
$re = "$env:ANDROID_HOME\ndk\25.1.8937393\toolchains\llvm\prebuilt\windows-x86_64\bin\llvm-readelf.exe"
Expand-Archive server\public\releases\erp-taranom.apk $env:TEMP\apk -Force
Get-ChildItem $env:TEMP\apk\lib\arm64-v8a\*.so | % { "$($_.Name)"; & $re -l $_.FullName | Select-String 'LOAD' }
# انتظار: Align 0x4000 برای همهٔ LOAD
```

Smoke روی دستگاه/امولاتور:

```powershell
adb install -r server\public\releases\erp-taranom.apk
adb logcat -c; adb logcat -s ERPTaranom NodeJS AndroidRuntime chromium
adb forward tcp:3210 tcp:3210
curl http://127.0.0.1:3210/api/system/health          # پس از boot؛ باید 200 و نسخهٔ جدید
adb forward --remove tcp:3210
```

سناریوهای عملکردی حداقلی: ورود با کاربر فروش → ساخت مشتری/فاکتور در حالت پرواز → روشن‌کردن شبکه → سینک موفق و
دیده‌شدن رکورد در مرکز → بررسی اعلان آپدیت (اگر `manifest.json` نسخهٔ بالاتر اعلام کند).

## ۵. توزیع

- **مجاز:** انتقال فایل با USB/پیام‌رسان داخلی، یا میزبانی روی HTTPS مجاز که در `APK_UPDATE_HOSTS` است.
- **ممنوع:** `scp`/SFTP به `/home/taranom/crm-taranom/server/public/releases/` روی production.
- برای نصب اولیه روی دستگاه جدید: فعال‌کردن نصب از منبع ناشناس برای فایل‌منیجر؛ signer باید کی‌استور جدید باشد.

## ۶. متادیتای انتشار (`server/public/releases/manifest.json`)

```json
{
  "android": {
    "version": "2.0.34",
    "versionCode": 36,
    "url": "https://erp.poshaktaranom.com/releases/erp-taranom.apk",
    "sha256": "<hex از Get-FileHash>",
    "size": 123456789,
    "distribution": "local",
    "notes": "خلاصهٔ تغییرات برای کاربر"
  }
}
```

- `node scripts/generate-release.js server/public/releases <desktopVersion> <androidVersion> <androidVersionCode> [notes]` فیلدهای
  موجود را حفظ می‌کند؛ `sha256/size` اندروید را از `android-build-report.txt` بردار.
- `release_id` باید در سه نسخهٔ `app-update.js` (ریپو، دسکتاپ، اندروید) یکی باشد → `test-embedded-release.js`.
- فقط این فایل (و نه APK) با commit/deploy وب به سرور می‌رود.

## ۷. عیب‌یابی تفصیلی

| خطا/نشانه | ریشه | راه‌حل |
|---|---|---|
| `Unsupported class file major version` / Gradle با JDK 21 شکست | AGP 8.5.2 با JDK جدید ناسازگار | JDK 17 در `JAVA_HOME`; یا ارتقای AGP (upgrade-plan فاز ۳) |
| `Could not resolve com.android.tools.build:gradle` | پروکسی/میرور | پروکسی Gradle؛ میرور aliyun در `android/build.gradle` |
| دانلود nodejs-mobile timeout | GitHub مسدود | zip را دستی بگیر و در `android/app/libnode/` قرار بده (bin/ + include/) |
| `node-gyp` → `gyp ERR! find Python` | Python نیست | `winget install Python.Python.3.12` |
| `better_sqlite3 missing DT_NEEDED libnode.so` | LDFLAGS اعمال نشده | مسیر `-L<libnode>` و `-lnode`; `--no-as-needed`; وجود `libnode.so` برای همان ABI |
| `dlopen failed: cannot locate symbol "_ZN2v8..."` روی دستگاه | `.node` مقابل libnode متفاوت ساخته شده | zip nodejs-mobile و `.node` را با هم بازسازی کن؛ RTLD_GLOBAL در JNI |
| `libc++_shared.so` not found | تسک `copyLibcxxShared` اجرا نشده/NDK path | `ndk/<ver>/toolchains/llvm/prebuilt/windows-x86_64/sysroot/usr/lib/<triple>/libc++_shared.so` |
| `INSTALL_FAILED_INVALID_APK` یا crash بلافاصله | ELF per-ABI ناقص، APK تودرتو، `extractNativeLibs=false` | `test-android-apk.ps1`؛ گارد APK تودرتو؛ manifest |
| اپ روی دستگاه ۱۶KB (Pixel 8+/2026) نصب نمی‌شود | align 4KB بدون compat | `pageSizeCompat="enabled"` (موقت) → runtime ۱۶KB |
| WebView سفید ولی سرور بالا است | mixed content / CSP / URL غیر loopback | `network_security_config`; آدرس `http://127.0.0.1:3210` |
| `server.fail` با `SQLITE_CANTOPEN` | `DB_PATH` پوشه ندارد/مجوز | `main.js` باید `mkdir -p` کند؛ مسیر `filesDir/data` |
| آپدیت درون‌برنامه «hash mismatch» | فایل روی میزبان با manifest فرق دارد | manifest را از فایل نهایی (بعد از امضا) بازتولید کن |
| آپدیت «signer mismatch» | APK با کی‌استور دیگر امضا شده | همان JKS جدید؛ اگر عمداً چرخش کلید، نیازمند uninstall و توزیع دستی |
| `INSTALL_FAILED_VERSION_DOWNGRADE` | versionCode کمتر/مساوی | versionCode را افزایشی نگه دار |
| Gradle `Daemon disappeared`/OOM | RAM کم | همان تنظیمات `gradle.properties`; بستن IDE؛ `--no-daemon` |
| `.ps1` با کاراکتر عجیب یا خطای پارس | UTF-8 با کاراکتر غیر ASCII | `.ps1` فقط ASCII |

## ۸. CI پیشنهادی (اجرا نشده — نیاز به تأیید مالک)

```yaml
# .github/workflows/android-build.yml (پیش‌نویس)
on: { workflow_dispatch: {} }
jobs:
  apk:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: 17 }
      - uses: android-actions/setup-android@v3
      - run: sdkmanager "platforms;android-36" "build-tools;36.1.0" "ndk;25.1.8937393" "cmake;3.22.1"
      - run: node scripts/prepare-embedded-server.js android && node scripts/test-embedded-release.js
      # کراس‌کامپایل better-sqlite3 با اسکریپت bash معادل (باید نوشته شود) + دانلود nodejs-mobile با SHA-256 پین‌شده
      - run: echo "$KEYSTORE_B64" | base64 -d > android/erp-taranom.jks
        env: { KEYSTORE_B64: ${{ secrets.ANDROID_KEYSTORE_B64 }} }
      - run: cd android && ./gradlew assembleRelease --no-daemon
        env:
          CRM_KEYSTORE_FILE: ${{ github.workspace }}/android/erp-taranom.jks
          CRM_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          CRM_KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
          CRM_KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}
      - uses: actions/upload-artifact@v4
        with: { name: erp-taranom-apk, path: android/app/build/outputs/apk/release/*.apk, retention-days: 7 }
```

نکته: اسکریپت‌های `.ps1` فعلی روی Linux اجرا نمی‌شوند؛ برای CI باید معادل bash (یا `pwsh`) نوشته و ابتدا محلی تأیید شود.
