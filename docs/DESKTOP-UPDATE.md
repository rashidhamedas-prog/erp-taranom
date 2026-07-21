# به‌روزرسانی نسخه دسکتاپ (بدون آپلود exe روی سرور)

فایل نصب ویندوز (~۲۰۰–۴۰۰MB) **دیگر روی سرور production آپلود نمی‌شود**.
فقط فایل‌های سبک (`manifest.json`، `latest.yml`) با `git pull` منتشر می‌شوند.

## چرا؟
- آپلود SCP چندصد مگابایت به `45.90.98.99` کند و ناپایدار است.
- قبلاً exeهای قدیمی داخل بسته نصب کپی می‌شد و حجم به ۱GB+ می‌رسید (رفع شد).

## روش پیشنهادی: GitHub Releases

### ۱. ساخت نسخه
```powershell
cd desktop
npm run dist:win
npm run publish:win
```
این کار `manifest.json` و `latest.yml` را به‌روز می‌کند **بدون** کپی exe به `server/public/releases/`.

### ۲. انتشار روی GitHub
```powershell
# یک‌بار: gh auth login
gh release create v1.0.6 `
  "desktop/dist/ERP Taranom Setup 1.0.6.exe" `
  "server/public/releases/latest.yml" `
  --repo rashidhamedas-prog/erp-taranom `
  --title "ERP Taranom Desktop 1.0.6"
```

### ۳. به‌روزرسانی manifest (در صورت نیاز)
در `server/public/releases/manifest.json`:
```json
"desktop": {
  "version": "1.0.6",
  "url": "https://github.com/rashidhamedas-prog/erp-taranom/releases/download/v1.0.6/ERP-Taranom-Setup-1.0.6.exe",
  "feed_url": "https://github.com/rashidhamedas-prog/erp-taranom/releases/download/v1.0.6/",
  "notes": "..."
}
```

### ۴. Deploy متادیتا روی سرور
```bash
git add server/public/releases/manifest.json server/public/releases/latest.yml
git commit -m "chore: desktop 1.0.6 metadata"
git push
# روی سرور:
git pull && cd server && pm2 restart erp-taranom
```

## جایگزین‌ها
- لینک مستقیم Google Drive / CDN در فیلد `desktop.url`
- متغیر محیطی سرور: `DESKTOP_UPDATE_FEED_URL` برای electron-updater

## کاربر نهایی
- برنامه دسکتاپ از API سرور مرکزی لینک دانلود را می‌گیرد.
- به‌روزرسانی خودکار electron-updater از `feed_url` (GitHub) انجام می‌شود.
