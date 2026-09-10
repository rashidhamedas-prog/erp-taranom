# منابع همیشه‌به‌روز — اکوسیستم اندروید/nodejs-mobile

قاعده: **قبل از هر بیلد کامل و حداقل ماهانه** اسکریپت را اجرا کن و جدول‌های زیر را بخوان. هر تغییر مهم را در `docs/CHANGE-LOG.md`
(بخش «رصد ابزار») و در جدول نسخه‌های `SKILL.md` بازتاب بده.

```powershell
$env:NODE_USE_ENV_PROXY="1"; $env:HTTPS_PROXY="http://127.0.0.1:PORT"   # فقط در همان شل
node .cursor/skills/APK/scripts/check-updates.mjs            # جدول pinned vs latest + EOL
node .cursor/skills/APK/scripts/check-updates.mjs --json     # خروجی ماشین‌خوان
node .cursor/skills/APK/scripts/check-updates.mjs --strict   # exit 1 اگر مؤلفه‌ای EOL/عقب‌افتادهٔ major باشد
```

## ۱. پلتفرم اندروید

| منبع | آدرس | فید | چه چیزی را نگاه کن |
|---|---|---|---|
| نسخه‌های Android (release notes, behavior changes) | https://developer.android.com/about/versions | — (صفحهٔ هر نسخه: `/about/versions/<N>/behavior-changes-<N>`) | تغییرات «همهٔ اپ‌ها» و «targetSdk ≥ N»؛ تاریخ stable |
| Android Developers Blog | https://android-developers.googleblog.com/ | https://android-developers.googleblog.com/feeds/posts/default | اعلام نسخه، مهلت‌های policy، ۱۶KB، verification |
| Android Security Bulletins | https://source.android.com/docs/security/bulletin | — (ماهانه، اول هر ماه) | CVEهای WebView/Framework که به کاربران توضیح می‌دهی |
| Google Play target API policy | https://support.google.com/googleplay/android-developer/answer/11926878 | — | مهلت targetSdk (حتی برای sideload شاخص خوبی است) |
| Play policy تغییرات | https://support.google.com/googleplay/android-developer/answer/9934569 | — | تاریخ‌های اجرا |
| ۱۶KB page size | https://developer.android.com/guide/practices/page-sizes | — | الزامات، ابزار تست، `pageSizeCompat` |
| Developer verification | https://developer.android.com/developer-verification | — | زمان‌بندی منطقه‌ای، advanced flow، حساب توزیع محدود، معافیت‌ها |
| WebView در Android (insets/IME) | https://developer.android.com/develop/ui/views/layout/webapps/understand-window-insets | — | milestoneهای M136/M139/M144 |
| Chromium/WebView schedule | https://chromiumdash.appspot.com/schedule | — | نسخهٔ WebView دستگاه‌ها |
| Chrome Releases (امنیت WebView) | https://chromereleases.googleblog.com/ | https://chromereleases.googleblog.com/feeds/posts/default | CVE بحرانی که به آپدیت WebView از Play وابسته است |
| endoflife.date Android | https://endoflife.date/android | https://endoflife.date/api/android.json | نسخه‌های پشتیبانی‌شده |

## ۲. ابزار بیلد

| منبع | آدرس | فید/API | چه چیزی را نگاه کن |
|---|---|---|---|
| AGP release notes | https://developer.android.com/build/releases/gradle-plugin | metadata: https://dl.google.com/dl/android/maven2/com/android/tools/build/gradle/maven-metadata.xml | حداقل Gradle/JDK/Build-Tools، NDK پیش‌فرض، DSL منسوخ |
| AGP past releases / نقشهٔ سازگاری | https://developer.android.com/build/releases/past-releases | — | جدول AGP ↔ Gradle ↔ SDK Build Tools |
| Android Studio release updates | https://androidstudio.googleblog.com/ | https://androidstudio.googleblog.com/feeds/posts/default | نسخهٔ Stable/AGP همراه |
| Gradle releases | https://gradle.org/releases/ | https://github.com/gradle/gradle/releases.atom · JSON: https://services.gradle.org/versions/current | breaking changes، JDK پشتیبانی‌شده |
| NDK | https://github.com/android/ndk/releases | https://github.com/android/ndk/releases.atom · https://developer.android.com/ndk/downloads/revision_history | LTS/r-release، تغییر clang/lld، پیش‌فرض ۱۶KB |
| SDK Build-Tools / cmdline-tools | https://developer.android.com/tools/releases/build-tools | — | apksigner/zipalign |
| Google Maven index | https://maven.google.com/web/index.html | — | نسخه‌های دقیق artifactها |
| JDK (Microsoft OpenJDK / Temurin) | https://learn.microsoft.com/java/openjdk/download · https://adoptium.net/temurin/releases/ | https://api.adoptium.net/v3/info/available_releases | LTS جاری (17/21/25) |
| Google Play Console / Play App Signing (اگر روزی Play) | https://support.google.com/googleplay/android-developer/answer/9842756 | — | — |

## ۳. Runtime و ماژول‌های نیتیو

| منبع | آدرس | فید/API | چه چیزی را نگاه کن |
|---|---|---|---|
| nodejs-mobile (رسمی) | https://github.com/nodejs-mobile/nodejs-mobile | https://github.com/nodejs-mobile/nodejs-mobile/releases.atom · PRها: https://github.com/nodejs-mobile/nodejs-mobile/pulls | آیا سازمان دوباره فعال شد/Node 24 merge شد |
| nodejs-mobile (fork فعال) | https://github.com/gmaclennan/nodejs-mobile | https://github.com/gmaclennan/nodejs-mobile/releases.atom · API: https://api.github.com/repos/gmaclennan/nodejs-mobile/releases | خروج از prerelease، NDK استفاده‌شده، تغییر minSdk، فایل‌های `PATCHES.md`/`EMBEDDING.md` |
| Node.js releases | https://nodejs.org/en/blog/release | https://nodejs.org/en/feed/releases.xml · schedule: https://raw.githubusercontent.com/nodejs/Release/main/schedule.json | نسخهٔ LTS، تاریخ EOL خط runtime |
| Node.js security releases | https://nodejs.org/en/blog/vulnerability | https://nodejs.org/en/feed/vulnerability.xml | CVE در خطی که embed شده |
| endoflife.date Node | https://endoflife.date/nodejs | https://endoflife.date/api/nodejs.json | EOL خط ۱۸/۲۲/۲۴ |
| better-sqlite3 | https://github.com/WiseLibs/better-sqlite3/releases | https://github.com/WiseLibs/better-sqlite3/releases.atom · npm: https://registry.npmjs.org/-/package/better-sqlite3/dist-tags | حداقل Node، N-API، SQLite bundled، prebuild |
| SQLite changes | https://www.sqlite.org/changes.html | — | تغییر رفتار WAL/JSON |
| node-gyp | https://github.com/nodejs/node-gyp/releases | https://github.com/nodejs/node-gyp/releases.atom | نیاز Python/Make |
| GitHub Advisory DB (npm) | https://github.com/advisories?query=ecosystem%3Anpm | — | وابستگی‌های `nodejs-project/package.json` (`npm audit`) |

## ۴. امنیت موبایل

| منبع | آدرس | چه چیزی را نگاه کن |
|---|---|---|
| OWASP MASVS / MASTG | https://mas.owasp.org/ | چک‌لیست storage/network/platform برای WebView shell |
| Android app security best practices | https://developer.android.com/privacy-and-security/security-tips | WebView، IPC، storage |
| Network security config | https://developer.android.com/privacy-and-security/security-config | تغییرات cleartext/pinning |

## ۵. سیگنال → اقدام

| سیگنال | اقدام در این پروژه |
|---|---|
| Android نسخهٔ جدید stable | صفحهٔ behavior changes را برای «همهٔ اپ‌ها» و «targetSdk» بخوان → ورودی در upgrade-plan فاز ۲ |
| AGP major جدید | جدول سازگاری Gradle/JDK → فاز ۳؛ AGP 10 = Variant API جدید (برای این پروژه اثر کم) |
| NDK r-release جدید | فقط با بیلد آزمایشی better-sqlite3 + native-lib؛ `ndkVersion` را pin کن |
| nodejs-mobile fork از prerelease خارج شد | فاز ۴ را زمان‌بندی کن |
| Node.js security release در خط embed | ارزیابی CVE: اگر HTTP/TLS/OpenSSL → اولویت بیلد جدید بعد از ارتقای runtime |
| better-sqlite3 major جدید | چک `engines.node`/N-API → فقط همراه runtime سازگار |
| Chrome/WebView CVE بحرانی | کاری در APK لازم نیست (WebView از Play آپدیت می‌شود) — به کاربران یادآوری آپدیت WebView |
| Play target API deadline | برای sideload اجباری نیست؛ ولی نشانگر رفتارهای جدید دستگاه‌ها |
| developer verification: تغییر زمان‌بندی/معافیت | تصمیم مالک (فاز ۵) را بازبینی کن |
| Gradle major جدید | فقط همراه AGP سازگار؛ `distributionSha256Sum` به‌روز |

## ۶. یادداشت شفافیت

- اسکریپت `check-updates.mjs` فقط **می‌خواند** و چیزی را تغییر نمی‌دهد؛ اگر شبکه/پروکسی نبود، هر منبع را جدا «unreachable» گزارش می‌کند.
- نسخه‌های «آخرین» در `SKILL.md` یک snapshot تاریخ‌دار است؛ منبع حقیقت، خروجی اسکریپت و صفحات بالا هستند.
