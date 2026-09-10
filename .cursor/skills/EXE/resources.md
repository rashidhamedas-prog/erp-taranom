# منابع همیشه‌به‌روز — اکوسیستم Electron/ویندوز

قاعده: **قبل از هر بیلد کامل و حداقل ماهانه** اسکریپت را اجرا کن و جدول‌ها را مرور کن. Electron هر ۸ هفته major جدید می‌دهد و فقط ۳
نسخهٔ آخر پشتیبانی می‌شوند؛ نگه‌داشتن نسخهٔ EOL = Chromium بدون پچ.

```powershell
$env:NODE_USE_ENV_PROXY="1"; $env:HTTPS_PROXY="http://127.0.0.1:PORT"   # فقط همین شل (Node >= 24)
node .cursor/skills/EXE/scripts/check-updates.mjs            # pinned vs latest + EOL
node .cursor/skills/EXE/scripts/check-updates.mjs --json
node .cursor/skills/EXE/scripts/check-updates.mjs --strict   # exit 1 اگر Electron/Node پین‌شده EOL باشد
```

## ۱. Electron

| منبع | آدرس | فید/API | چه چیزی را نگاه کن |
|---|---|---|---|
| Releases (رسمی) | https://releases.electronjs.org/ | JSON: https://releases.electronjs.org/releases.json (حجیم) · npm dist-tags: https://registry.npmjs.org/-/package/electron/dist-tags | آخرین stable هر خط (`44-x-y`, …) |
| Schedule / EOL | https://releases.electronjs.org/schedule | https://endoflife.date/api/electron.json | تاریخ stable/EOL، نسخهٔ Chromium/Node هر major |
| Breaking changes | https://www.electronjs.org/docs/latest/breaking-changes | — | قبل از هر ارتقای major، بخش همان نسخه |
| Blog | https://www.electronjs.org/blog | https://www.electronjs.org/blog/rss.xml | اعلام نسخه، تغییر سیاست (مثلاً حذف ia32، postinstall) |
| GitHub releases | https://github.com/electron/electron/releases | https://github.com/electron/electron/releases.atom | یادداشت‌های پچ امنیتی |
| Security advisories | https://github.com/electron/electron/security/advisories | — | CVEهای Electron (نه Chromium) |
| Security tutorial (چک‌لیست) | https://www.electronjs.org/docs/latest/tutorial/security | — | تغییر توصیه‌ها (fuses, sandbox, CSP) |
| Fuses | https://github.com/electron/fuses | https://github.com/electron/fuses/releases.atom | fuseهای جدید |
| ASAR integrity | https://www.electronjs.org/docs/latest/tutorial/asar-integrity | — | پشتیبانی ویندوز |
| Chromium schedule | https://chromiumdash.appspot.com/schedule | — | نسخهٔ Chromium در Electron بعدی |
| Chrome Releases (امنیت) | https://chromereleases.googleblog.com/ | https://chromereleases.googleblog.com/feeds/posts/default | CVE بحرانی که Electron پچ می‌کند |

## ۲. Node.js

| منبع | آدرس | فید/API | چه چیزی را نگاه کن |
|---|---|---|---|
| Releases | https://nodejs.org/en/blog/release | https://nodejs.org/en/feed/releases.xml | نسخهٔ Node داخل Electron هدف |
| Release schedule | https://github.com/nodejs/Release | https://raw.githubusercontent.com/nodejs/Release/main/schedule.json | LTS/EOL |
| Security releases | https://nodejs.org/en/blog/vulnerability | https://nodejs.org/en/feed/vulnerability.xml | CVE خط استفاده‌شده در بیلد/CI |
| endoflife.date | https://endoflife.date/nodejs | https://endoflife.date/api/nodejs.json | EOL خط CI |

## ۳. ابزار بسته‌بندی و آپدیت

| منبع | آدرس | فید/API | چه چیزی را نگاه کن |
|---|---|---|---|
| electron-builder docs | https://www.electron.build/ | — | پیکربندی `win`, `nsis`, `electronFuses`, `asar` |
| electron-builder releases | https://github.com/electron-userland/electron-builder/releases | https://github.com/electron-userland/electron-builder/releases.atom · npm: https://registry.npmjs.org/-/package/electron-builder/dist-tags | v27 stable، `migrate-schema`, تغییر امضا |
| electron-builder MIGRATION | https://github.com/electron-userland/electron-builder/blob/master/MIGRATION.md | — | مهاجرت 24→26→27 |
| electron-updater | https://www.electron.build/auto-update · https://github.com/electron-userland/electron-builder/tree/master/packages/electron-updater | npm: https://registry.npmjs.org/-/package/electron-updater/dist-tags | فرمت `latest.yml`, تأیید امضا، v7 |
| NSIS | https://nsis.sourceforge.io/News | — | نسخهٔ NSIS همراه builder |
| electron-builder-binaries (میرور) | https://github.com/electron-userland/electron-builder-binaries | — | winCodeSign/nsis |

## ۴. ماژول‌های نیتیو

| منبع | آدرس | فید/API | چه چیزی را نگاه کن |
|---|---|---|---|
| better-sqlite3 | https://github.com/WiseLibs/better-sqlite3/releases | https://github.com/WiseLibs/better-sqlite3/releases.atom · npm: https://registry.npmjs.org/-/package/better-sqlite3/dist-tags | حداقل Node/Electron، N-API، prebuild |
| sharp | https://sharp.pixelplumbing.com/changelog · https://github.com/lovell/sharp/releases | https://github.com/lovell/sharp/releases.atom · npm: https://registry.npmjs.org/-/package/sharp/dist-tags | prebuilt win32-x64، libvips |
| @electron/rebuild | https://github.com/electron/rebuild/releases | https://github.com/electron/rebuild/releases.atom | فقط اگر rebuild لازم شد |
| node-gyp | https://github.com/nodejs/node-gyp/releases | https://github.com/nodejs/node-gyp/releases.atom | VS/Python لازم |
| SQLite | https://www.sqlite.org/changes.html | — | تغییر رفتار WAL/JSON در نسخهٔ bundled |

## ۵. ویندوز، امضا و اعتماد

| منبع | آدرس | چه چیزی را نگاه کن |
|---|---|---|
| Windows release health | https://learn.microsoft.com/windows/release-health/ | مشکلات شناخته‌شده |
| Windows lifecycle (10/11) | https://learn.microsoft.com/lifecycle/products/?terms=windows | پایان پشتیبانی/ESU |
| Code signing options for Windows apps | https://learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options | مقایسهٔ Trusted/Artifact Signing، OV، EV، محدودیت جغرافیایی |
| Azure Artifact Signing (Trusted Signing) | https://learn.microsoft.com/azure/trusted-signing/ | تغییر کشورهای مجاز (اکنون برای این شرکت غیرقابل‌استفاده) |
| SmartScreen | https://learn.microsoft.com/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/ | رفتار شهرت |
| CA/Browser Forum Code Signing BRs | https://cabforum.org/working-groups/code-signing/documents/ | الزام کلید در سخت‌افزار، طول کلید |
| SignTool | https://learn.microsoft.com/windows/win32/seccrypto/signtool | پارامترهای timestamp/SHA-256 |
| Electron on Windows on ARM | https://www.electronjs.org/docs/latest/tutorial/windows-arm | arm64 |

## ۶. امنیت عمومی

| منبع | آدرس | چه چیزی را نگاه کن |
|---|---|---|
| GitHub Advisory DB (npm) | https://github.com/advisories?query=ecosystem%3Anpm | وابستگی‌های `desktop/` و `server/` |
| Electronegativity | https://github.com/doyensec/electronegativity | اسکن پیکربندی Electron |
| OWASP Desktop App Security Top 10 | https://owasp.org/www-project-desktop-app-security-top-10/ | چک‌لیست |

## ۷. سیگنال → اقدام

| سیگنال | اقدام |
|---|---|
| Electron major جدید stable | breaking-changes همان major را بخوان؛ اگر نسخهٔ ما از پنجرهٔ ۳ نسخه خارج شد → فاز ۲ upgrade-plan اولویت بالا |
| Electron patch امنیتی در خط ما | بیلد و انتشار در ≤ ۲ هفته (با درخواست مالک) |
| Chrome CVE «exploited in the wild» | منتظر پچ Electron؛ همان بالا |
| electron-builder major | MIGRATION.md + `migrate-schema`؛ ابتدا در شاخهٔ جدا |
| electron-updater تغییر فرمت `latest.yml`/تأیید امضا | تست آپدیت از نسخهٔ نصب‌شدهٔ قدیمی به جدید |
| better-sqlite3 major / تغییر `engines.node` | فقط همراه Electron با Node سازگار؛ smoke DB |
| sharp major | تست آپلود/thumbnail؛ waiver را بازبینی کن |
| Node EOL خط CI | `.github/workflows/*.yml` را به LTS بعدی ببر |
| Windows 10 خارج از ESU | تصمیم دربارهٔ پشتیبانی؛ Electron هنوز Win10+ |
| تغییر سیاست Artifact Signing (کشورها) | اگر ایران/شرکت مجاز شد، مهاجرت از OV/self-signed |

## ۸. یادداشت شفافیت

- اسکریپت فقط می‌خواند؛ منابع unreachable را جدا گزارش می‌کند (پروکسی لازم است).
- جدول نسخه‌ها در `SKILL.md` snapshot تاریخ‌دار است؛ خروجی اسکریپت و صفحات بالا منبع حقیقت‌اند.
