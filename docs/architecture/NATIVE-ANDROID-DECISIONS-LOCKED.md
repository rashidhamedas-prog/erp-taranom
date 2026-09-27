# تصمیم‌های قفل‌شده — Android بومی فروش (مالک)

> تاریخ قفل: ۱۴۰۵/۰۷/۰۵  
> منبع: تأیید ۱۰۰٪ مالک برای اجرای تمام فازها بدون توقف برای مجوز  
> والد: [`NATIVE-ANDROID-SALES-ARCHITECTURE.md`](./NATIVE-ANDROID-SALES-ARCHITECTURE.md)

| شناسه | تصمیم | وضعیت |
|---|---|---|
| ADR-AND-001 | Kotlin + Jetpack Compose + Room؛ بدون WebView/Node نهایی | **LOCKED** |
| ADR-AND-003 | گزینه A: دامنه فروش Kotlin + outbox هم‌شکل wire مرکز | **LOCKED** |
| A3 | `applicationId` = `ir.taranom.crm` برای ارتقا in-place | **LOCKED** |
| A4 | توزیع اصلی = APK sideload؛ MDM اختیاری؛ Play بعداً | **LOCKED** |
| A6 | موجودی آفلاین = provisional + تعارض؛ سهمیه سخت در موج بعد در صورت نیاز | **LOCKED** |
| A7 | محیط محلی جدا برای دمو در v1 مجاز؛ بدون دسترسی سازمانی خودکار | **LOCKED** |
| SQLCipher | v1 = SQLCipher اختیاری معوق؛ Keystore + فایل‌های حساس AES-GCM | **LOCKED** (بررسی مجدد قبل از GA) |
| Keystore | استفاده از کلید فعلی ماشین توسعه برای بیلد؛ چرخش جداگانه ops در صورت افشا | **LOCKED برای ادامه توسعه** |
| Pairing | مسیر pair با username/password (ادمین/provision) + بستهٔ آینده؛ مسدودکننده محصول نیست | **LOCKED** |
| Capture visits/calls | اصلاح `PATH_TABLE_MAP` در scope همین مأموریت | **LOCKED** |
| AI-DOS | تسک ANDROID-NATIVE-SALES مالک `android-native/**` و docs معماری Android؛ DESKTOP-EXE به completed منتقل می‌شود اگر EXE تحویل شده | **LOCKED** |

همهٔ فازهای ۱–۵ مجاز به اجرا، commit، push، و merge به `main` هستند. آپلود APK به Iran VPS / انتشار عمومی فقط اگر مسیر `releases/` و manifest به‌روز شود — طبق همین مجوز مالک انجام می‌شود وقتی APK امضاشده آماده باشد.
