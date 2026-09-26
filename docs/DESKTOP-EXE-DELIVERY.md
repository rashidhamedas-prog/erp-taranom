# تحویل EXE دسکتاپ ERP ترنم — گزارش وضعیت

**نسخهٔ هدف:** `2.0.12`  
**شاخه:** `ai/DESKTOP-EXE-DELIVER`  
**Worktree:** `D:/proje/erp-taranom-desktop-exe`  
**خروجی نصب‌کننده:** `D:/proje/ERP EXE`  
**مجوز این نوبت:** توسعه + تست + ساخت. **انتشار عمومی / آپلود به VPS ایران بدون تأیید جداگانه انجام نمی‌شود.**

## تمایز سه‌گانه (اجباری)

| برچسب | معنی | وضعیت این تحویل |
|---|---|---|
| **build موفق** | `electron-builder` بدون خطا installer ساخت | پس از اجرای pipeline در همین سند پر می‌شود |
| **installer قابل اجرا** | NSIS روی ویندوز x64 نصب/اجرا می‌شود؛ سرور embedded بالا می‌آید | smoke جزئی؛ نه همهٔ سناریوهای پذیرش |
| **نسخهٔ آمادهٔ انتشار** | feed عمومی + OV/شهرت SmartScreen + آزمون پذیرش کامل + تأیید مالک | **خیر — آمادهٔ انتشار عمومی نیست** |

## معماری (تأیید شده از کد)

Electron main سرور `server/` را با `SYNC_ROLE=device` روی `127.0.0.1` اجرا می‌کند؛ renderer فقط loopback را می‌بیند. داده در `%APPDATA%/erp-taranom-desktop/` است. آپدیت: electron-updater + fallback manifest با SHA-256 و تأیید Authenticode وقتی `REQUIRE_SIGNED_UPDATES=1`.

## شکاف‌هایی که در این نوبت بسته شد

1. `build.win.publisherName = ["Poshak Taranom"]` هم‌تراز CN گواهی.
2. `publish.generic.url` از placeholder به `https://erp.poshaktaranom.com/releases/`.
3. `isAllowedUpdateUrl` برای GitHub Releases همین ریپو (بدون باز کردن `shell.openExternal` به github).
4. نقطهٔ امن نصب: شمارش mutationهای API + `POST /api/system/desktop-safe-point` (WAL checkpoint) + نصب خودکار پس از `update-downloaded` بدون تأیید اضافه؛ outbox مانع نصب نیست (در userData می‌ماند).
5. bump نسخه به `2.0.12`.

## امضا و SmartScreen

- گواهی: self-signed `CN=Poshak Taranom` (PFX محلی gitignored).
- Authenticode روی ماشین بیلد ممکن است `UnknownError` (زنجیرهٔ root محلی) گزارش دهد؛ این با OV یکی نیست.
- **ادعای «بدون هشدار SmartScreen برای همهٔ کاربران» نمی‌شود.**

## آزمون‌ها

| آزمون | نتیجه |
|---|---|
| `desktop/scripts/test-security-policy.js` | **19/19 PASS** |
| `desktop/scripts/test-main-hardening-static.js` | **16/16 PASS** |
| `desktop/scripts/test-local-secret-store.js` | **8/8 PASS** |
| `scripts/test-platform-security.js` | **7/7 PASS** |
| `scripts/compare-embedded-hash.js` (هدف desktop) | **drift=0** (android در این نوبت prepare نشد) |
| `node server/scripts/test-sms.js` | **22/22 PASS** |
| `node server/scripts/test-sync.js` | **NOT PASS روی این میزبان** (ABI better-sqlite3 در node_modules مشترک) — PASS اعلام نشد |
| Smoke `win-unpacked` EXE | **PASS** — loopback، `%APPDATA%\ERP Taranom\crm.db` + `jwt-secret.dpapi`، فونت محلی، update-feed 200 |
| نصب کامل NSIS + همهٔ سناریوهای §۱۳ مأموریت | **UNVERIFIED در این نوبت** |
| صف ۱۰هزار عملیات / toxiproxy / benchmark p95 | **UNVERIFIED** |

## مسیر بیلد تکرارپذیر

```powershell
cd D:\proje\erp-taranom-desktop-exe\desktop
# در صورت نیاز پروکسی فقط همین شل:
# $env:HTTP_PROXY="http://127.0.0.1:PORT"; $env:HTTPS_PROXY=$env:HTTP_PROXY
npm ci
npm run prepare-server
node ..\scripts\compare-embedded-hash.js
node scripts\test-security-policy.js
node scripts\test-main-hardening-static.js
node scripts\test-local-secret-store.js
cd ..
powershell -ExecutionPolicy Bypass -File scripts\build-desktop-signed.ps1
# کپی به مقصد مالک:
New-Item -ItemType Directory -Force -Path "D:\proje\ERP EXE" | Out-Null
Copy-Item "desktop\dist\ERP Taranom Setup 2.0.12.exe" "D:\proje\ERP EXE\" -Force
Copy-Item "desktop\dist\latest.yml" "D:\proje\ERP EXE\" -Force
```

## تحویل فایل‌ها (پس از بیلد)

- `D:\proje\ERP EXE\ERP Taranom Setup 2.0.12.exe`
- `D:\proje\ERP EXE\latest.yml`
- `D:\proje\ERP EXE\SHA256.txt` (تولید پس از بیلد)
- `D:\proje\ERP EXE\DELIVERY-NOTES.md` (خلاصهٔ همین گزارش)

## ریسک‌ها

| ریسک | اثر | وضعیت |
|---|---|---|
| ABI better-sqlite3 ↔ Electron 31 | اجرا fail | mitigated با install-app-deps؛ تأیید در smoke |
| داده کنار exe | از دست رفتن ارتقا | mitigated — userData |
| capture ناقص API | از دست رفتن عملیات آفلاین | موتور موجود + hygiene؛ ماتریس کامل پذیرش UNVERIFIED |
| GitHub فیلتر در ایران | آپدیت دانلود نشود | feed می‌تواند روی دامنهٔ ترنم باشد؛ مالک تصمیم میزبان |
| self-signed | SmartScreen | documented؛ OV خارج از این نوبت |
| بدون انتشار feed عمومی | کلاینت‌های قدیمی آپدیت نمی‌گیرند | عمدی تا تأیید مالک |

## گام بعدی برای «آمادهٔ انتشار»

1. تأیید مالک برای `gh release create` و به‌روزرسانی `manifest.json` با URL واقعی.
2. deploy فقط متادیتا روی ایران (نه باینری).
3. smoke نصب روی VM پاک + سناریوهای crash/idempotency.
4. خرید/فعال‌سازی گواهی OV در صورت نیاز سازمانی.
