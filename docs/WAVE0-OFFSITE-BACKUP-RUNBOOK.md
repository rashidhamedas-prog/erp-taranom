# Runbook — بکاپ واقعی خارج از VPS (P0-C)

## معماری فعال

- VPS هر ۱۵ دقیقه یک بسته immutable با نام `crm-backup-YYYYMMDD-HHMMSS.zip.enc` و sidecar‌ SHA-256 می‌سازد.
- کلید رمزنگاری production از فایل gitignored `server/backup-encryption-key.txt` خوانده می‌شود.
- کامپیوتر ویندوز با کلید SSH اختصاصی و wrapper ریشه‌مالکِ فقط‌خواندنی، آخرین بسته را در `D:\ERP-Taranom-Offsite` می‌کشد.
- انتقال sidecar-before → archive → sidecar-after است؛ نام، SHA-256 و عدم تغییر sidecar قبل از atomic promotion کنترل می‌شود.
- رمز بکاپ در Scheduled Task یا آرگومان‌ها نیست. نسخه recovery آن با DPAPI کاربر ویندوز در `%LOCALAPPDATA%\ERP-Taranom\OffsiteAgent\backup-key.dpapi` نگهداری می‌شود.

## نصب یا ترمیم Windows agent

کلید عمومی `id_ed25519_taranom_backup` روی VPS فقط به wrapper ریشه‌مالک متصل است؛ `-d` ساده یا SFTP کاربر admin confinement محسوب نمی‌شود:

```text
restrict,command="/usr/local/sbin/erp-taranom-backup-reader" ssh-ed25519 ... erp-taranom-offsite-readonly
```

منبع audited آن `scripts/erp-taranom-backup-reader.sh` است. هنگام نصب باید با مالک/مجوز `root:root 0755` در `/usr/local/sbin/erp-taranom-backup-reader` کپی و SHA-256 فایل local/production دقیقاً برابر شود. hash تأییدشده production در 2026-08-08: `d28baf01768fdf21c51bc1a606c89b68b0b563eec8540f444d7f390e22e2afe6`.

سپس از PowerShell اجرا شود:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-offsite-backup-task.ps1 `
  -IdentityFile "$env:USERPROFILE\.ssh\id_ed25519_taranom_backup" `
  -KnownHostsFile "$env:USERPROFILE\.ssh\known_hosts" `
  -Destination "D:\ERP-Taranom-Offsite"
```

Installer ابتدا S4U محدود را امتحان می‌کند. بدون دسترسی Administrator به حالت `Interactive` می‌رود؛ در این حالت pull فقط هنگام login همان کاربر اجرا می‌شود. نتیجه سالم Scheduled Task برابر `LastTaskResult=0` است.

## اجرای فوری و drill

```powershell
powershell -ExecutionPolicy Bypass -File scripts\pull-offsite-backup.ps1 `
  -IdentityFile "$env:USERPROFILE\.ssh\id_ed25519_taranom_backup"

powershell -ExecutionPolicy Bypass -File scripts\run-offsite-restore-drill.ps1 `
  -Destination "D:\ERP-Taranom-Offsite"
```

Drill باید checksum و receipt را کنترل، بسته را با DPAPI باز، SQLite را در مسیر موقت restore و fingerprintهای مالی/شرکت‌ها را مقایسه کند. نتیجه در `D:\ERP-Taranom-Offsite\.drill-status\backup-status.json` نوشته می‌شود و دیتابیس production تغییر نمی‌کند.

## شواهد عملیاتی 2026-08-08

- backup production: `crm-backup-20260808-153000.zip.enc`
- Windows copy: 12,268,025 bytes؛ SHA-256 `2166FB8E9C0F75719F7B87DFA4A01D4F72DA442C4D0553DB53F92986C5A1B866`
- list/download بکاپ استاندارد: قبول؛ shell/SFTP و دریافت key/DB/.env/private uploads و upload/delete: همگی رد شدند.
- restore drill: `ok=true`، fingerprint برابر، package شرکت‌ها ۱، RTO تخمینی ۳ ثانیه.
- Scheduled Task: `ERP-Taranom-Offsite-Pull`، هر ۱۵ دقیقه، Limited/Interactive، اجرای واقعی `LastTaskResult=0`.

## تست و پایش

```powershell
node server/scripts/test-offsite-pull-contract.js
node server/scripts/test-backup-offsite-policy.js
node server/scripts/test-backup-dr.js
Get-ScheduledTaskInfo ERP-Taranom-Offsite-Pull
```

ریسک باقیمانده: این مقصد off-server است ولی immutable/air-gapped نیست؛ بدافزار همان حساب ویندوز می‌تواند نسل‌های محلی را حذف کند. برای بلوغ بالاتر، یک کپی دوره‌ای cold/immutable و اجرای task در حالت S4U با Administrator اضافه شود.
