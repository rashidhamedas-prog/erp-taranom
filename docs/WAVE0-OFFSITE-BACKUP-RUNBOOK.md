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
1. بکاپ تازه بگیرید.
2. روی ماشین ایزوله: `node server/scripts/restore-backup.js --verify <file>` سپس restore CLI.
3. تعداد فاکتور + تراز آزمایشی را با pre-backup مقایسه کنید.
4. نتیجه را در `docs/WAVE0-GATE-STATUS.md` ثبت کنید.

## تست سیاست (بدون S3 واقعی)
```bash
node server/scripts/test-backup-offsite-policy.js
```
