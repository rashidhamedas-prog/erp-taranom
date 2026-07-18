# واردات داده از محک (Mahak)

## فرمت FullBackup.zip

فایل `FullBackup.zip` محک یک آرشیو ZIP است که **چند فایل `.bak` (SQL Server)** داخلش دارد — مستقیماً قابل خواندن در SQLite نیست.

مراحل رسمی محک:
1. ZIP را extract کنید
2. هر فایل `.bak` را روی **SQL Server** بازگردانی (Restore) کنید
3. از Tool_pack یا SSMS استفاده کنید

## واردات به CRM ترنم

### مرحله ۱ — آپلود در برنامه
مدیر → **پشتیبان** → بخش «واردات از محک» → فایل `FullBackup.zip` را آپلود کنید.

### مرحله ۲ — بازگردانی روی SQL Server (یک‌بار)
روی ویندوز با SQL Server Express:

```powershell
# مثال — نام دیتابیس و مسیر .bak را عوض کنید
sqlcmd -S localhost -Q "RESTORE DATABASE mahak_main FROM DISK='C:\path\to\Backup-mahakXX.bak' WITH REPLACE"
```

### مرحله ۳ — تنظیم اتصال در سرور CRM

در `server/.env` یا متغیرهای PM2:

```
MAHAK_MSSQL_SERVER=localhost
MAHAK_MSSQL_DATABASE=mahak_main
MAHAK_MSSQL_USER=sa
MAHAK_MSSQL_PASSWORD=YourPassword
```

یا یک خط اتصال:

```
MAHAK_MSSQL_CONNECTION=Server=localhost;Database=mahak_main;User Id=sa;Password=...;Encrypt=false;TrustServerCertificate=true
```

سپس `npm install mssql` در پوشه `server`.

### مرحله ۴ — اجرای واردات
دکمه **«اجرای واردات»** در پنل پشتیبان — مشتریان و محصولات (تا ۵۰۰۰ ردیف اول هر جدول شناسایی‌شده) وارد می‌شوند.

## محدودیت‌های فعلی

- فاکتورها، اسناد حسابداری و گردش کامل مالی هنوز به‌صورت خودکار map نشده‌اند
- جداول محک بین نسخه‌ها متفاوت است — ممکن است نیاز به تنظیم دستی mapping باشد
- برای واردات ۱۰۰٪، خروجی Excel از محک + import دستی هم گزینه است

## تحلیل محلی (CLI)

```bash
node server/scripts/mahak-analyze-zip.js "d:\soft\FullBackup.zip"
```
