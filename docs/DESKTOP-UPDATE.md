# به‌روزرسانی نسخه دسکتاپ (بدون آپلود exe روی سرور)

فایل نصب ویندوز (~۲۰۰–۴۰۰MB) **دیگر روی سرور production آپلود نمی‌شود**.
فقط فایل‌های سبک (`manifest.json`، `latest.yml`) با `git pull` منتشر می‌شوند.

خروجی بیلد محلی مالک: `D:\proje\ERP EXE\` (مثلاً `ERP Taranom Setup 2.0.12.exe` + `SHA256.txt`).

## چرا؟
- آپلود SCP چندصد مگابایت به VPS کند و ناپایدار است.
- قبلاً exeهای قدیمی داخل بسته نصب کپی می‌شد و حجم به ۱GB+ می‌رسید (رفع شد).

## روش پیشنهادی: GitHub Releases

### ۱. ساخت نسخه
```powershell
cd desktop
# یا از ریشه: powershell -File scripts/build-desktop-signed.ps1
npm run dist:win
# کپی اختیاری:
Copy-Item "dist\ERP Taranom Setup <v>.exe" "D:\proje\ERP EXE\" -Force
npm run publish:win
```
این کار `manifest.json` و `latest.yml` را به‌روز می‌کند **بدون** کپی exe به `server/public/releases/`.

### ۲. انتشار روی GitHub
```powershell
# یک‌بار: gh auth login
gh release create v2.0.12 `
  "D:\proje\ERP EXE\ERP Taranom Setup 2.0.12.exe" `
  "desktop/dist/latest.yml" `
  --repo rashidhamedas-prog/erp-taranom `
  --title "ERP Taranom Desktop 2.0.12"
```

### ۳. به‌روزرسانی manifest (در صورت نیاز)
در `server/public/releases/manifest.json`:
```json
"desktop": {
  "version": "2.0.12",
  "url": "https://github.com/rashidhamedas-prog/erp-taranom/releases/download/v2.0.12/ERP-Taranom-Setup-2.0.12.exe",
  "feed_url": "https://github.com/rashidhamedas-prog/erp-taranom/releases/download/v2.0.12/",
  "sha256": "<hex lowercase>",
  "size": 100727928,
  "notes": "..."
}
```

دسکتاپ از نسخهٔ ۲.۰.۱۲ به بعد URLهای GitHub Releases همین ریپو را برای دانلود آپدیت می‌پذیرد (`isAllowedUpdateUrl`)؛ `shell.openExternal` همچنان فقط دامنهٔ ترنم است.

### ۴. Deploy متادیتا روی سرور
```bash
git add server/public/releases/manifest.json server/public/releases/latest.yml
git commit -m "chore: desktop 2.0.12 metadata"
git push
# روی سرور:
git pull && cd server && pm2 restart erp-taranom
```

## جایگزین‌ها
- لینک مستقیم Google Drive / CDN زیر دامنهٔ `*.poshaktaranom.com` در فیلد `desktop.url`
- متغیر محیطی سرور: `DESKTOP_UPDATE_FEED_URL` برای electron-updater

## کاربر نهایی
- برنامه دسکتاپ از API سرور مرکزی لینک دانلود را می‌گیرد.
- به‌روزرسانی خودکار electron-updater از `feed_url` انجام می‌شود؛ پس از دانلود در نخستین نقطهٔ امن (بدون تراکنش API در حال اجرا) نصب می‌شود.
- دادهٔ محلی در `%APPDATA%\ERP Taranom\` است و با ارتقای باینری پاک نمی‌شود.
