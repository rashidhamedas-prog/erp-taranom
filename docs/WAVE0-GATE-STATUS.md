# وضعیت Gate موج صفر — تصمیم و اجرا (2026-08-01)

## تصمیم فنی اتخاذشده

به‌جای انتظار ChatGPT یا کلیدهای ops، هر چیزی که **بدون باکت S3 / گواهی امضا** قابل بستن بود بسته شد؛ بقیه با runbook + waiver زمان‌دار مشخص شد.

| Gate | وضعیت | شواهد |
|------|--------|--------|
| وابستگی high (`npm audit`) | ✅ با waiver زمان‌دار `xlsx` تا ۲۰۲۶-۱۰-۰۱ | `npm run audit:gate` — adm-zip/nodemailer/sharp ارتقا یافت؛ `excel-safe.js` |
| restore off-site | ✅ مسیر خودکار filesystem + drill | `BACKUP_OFFSITE_DIR` در `backup.js`؛ `test-backup-dr.js` ۶/۶ از کپی offsite |
| مالی + hostile cross-tenant | ✅ | `test-wave0-financial-hostile.js` ۲۰/۰ |
| Playwright login | ✅ | `e2e/login.spec.js` + job در `wave0-gate.yml` |
| امضای updater/APK | 🟡 خودامضا روی PC بیلد؛ گواهی تجاری هنوز لازم | JKS release + PFX self-signed؛ `apksigner`/`Get-AuthenticodeSignature` Valid روی همان ماشین |
| حذف کامل `unsafe-inline` | 🟡 تعویق آگاهانه | تک‌فایل + هزاران onclick؛ حذف الان وب را دوباره می‌کشد |
| موج ۱–۴ | ❌ عمداً شروع نشده | قانون roadmap تا Gate کامل |

## کار ops باقی‌مانده (کوتاه)

1. ~~روی ایران: `BACKUP_OFFSITE_DIR` در PM2~~ ✅ `=/home/taranom/crm-offsite-backups` (dump + process environ؛ cron داخلی `*/15`)
2. ~~restore واقعی از offsite~~ ✅ drill 2026-08-01: checksum match + `integrity_check=ok` + users=1 (بدون دست‌زدن به DB تولید)
3. گواهی **تجاری** ویندوز (OV/EV) برای SmartScreen روی PCهای دیگر؛ keystore اندروید release ساخته شد (sideload اگر امضای قبلی فرق دارد)
4. جایگزینی `xlsx` → `exceljs` قبل از انقضای waiver (۲۰۲۶-۱۰-۰۱)

## دستورهای تأیید محلی

```powershell
cd server
npm run audit:gate
npm run test:backup-dr
npm run test:wave0-financial
cd ..\e2e
npm test
```
