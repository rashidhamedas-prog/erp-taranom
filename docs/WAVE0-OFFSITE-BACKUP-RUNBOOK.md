# Runbook — بکاپ off-server واقعی (P0-C)

هدف: کپی بکاپ رمزشده خارج از دیسک همان VPS اپلیکیشن.

## گزینه‌ها

### A) S3-compatible (ترجیحی)
روی PM2 / env production:

```bash
BACKUP_S3_URI=s3://BUCKET/erp-taranom/backups
# AWS CLI روی سرور نصب و credential محدود فقط PutObject
# یا endpoint سازگار (Liara/Arvan/MinIO) با aws configure
```

هر `runBackup()` موفق فایل `.zip.enc` + `.sha256` را آپلود می‌کند.

### B) مسیر فایل روی volume جدا
```bash
BACKUP_OFFSITE_DIR=/mnt/backup-volume/crm-offsite
# نباید همان device با BACKUP_DIR باشد
# BACKUP_ALLOW_SAME_DEVICE فقط برای drill محلی — در production ممنوع
```

پوشهٔ فعلی `/home/taranom/crm-offsite-backups` روی همان VPS **Gate را نمی‌بندد**.

## Drill هفتگی
1. بکاپ تازه بگیرید (یا از آخرین فایل offsite استفاده کنید).
2. روی ماشین ایزوله / همین سرور با مسیر موقت:
   ```bash
   cd server
   BACKUP_OFFSITE_DIR=/path/to/offsite npm run backup:weekly-drill
   # یا: npm run backup:weekly-drill -- --file /path/to/crm-backup-....zip.enc
   ```
3. نتیجه در `backups/backup-status.json` → `last_drill` و API `/api/admin/backup-health` ثبت می‌شود.
4. تعداد فاکتور/مشتری/journal و تراز آزمایشی با fingerprint پکیج مقایسه می‌شود.
5. نتیجه را در `docs/WAVE0-GATE-STATUS.md` ثبت کنید.

## تأیید بدون restore
```bash
npm run backup:verify -- --file /path/to/crm-backup-....zip.enc
```

## تست سیاست (بدون S3 واقعی)
```bash
node server/scripts/test-backup-offsite-policy.js
node server/scripts/test-backup-dr.js
```
