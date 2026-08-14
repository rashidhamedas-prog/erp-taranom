# Runbook — DEMO-V2-SECURE-SALES

نسخهٔ نمایشی امن برای جلسهٔ فروش. دو سطح جدا که نباید به هم وصل شوند.

این سند **رمز، توکن یا کلید واقعی ندارد.** اعتبارنامه‌ها فقط در فایل `0600` روی ریشهٔ دمو نوشته می‌شوند.

## Static در برابر Interactive

| | Static Showcase | Interactive Sales Demo |
|---|---|---|
| فایل‌ها | `server/public/demo.html` + `demo.js` + `demo.css` | Express + SQLite روی ریشهٔ ایزوله |
| شبکه / DB | هیچ `fetch` / XHR / WebSocket | API واقعی، فقط اگر env کامل باشد |
| ورود | ندارد | چهار نقش RBAC واقعی (نه admin عمومی) |
| واترمارک | «داده‌ها کاملاً ساختگی هستند» | همان + نشان نسخه نمایشی |
| فعال‌سازی | باز کردن HTML | فقط `ERP_DEMO_MODE=true` در محیط فرایند |

Static را از Interactive جدا نگه دارید. Query / cookie / هدر نمی‌تواند Demo Mode را روشن کند.

## متغیرهای محیط (Interactive)

وقتی `ERP_DEMO_MODE=true` است همهٔ این‌ها اجباری و fail-closed هستند:

| متغیر | معنی |
|---|---|
| `ERP_DEMO_MODE` | فقط `true` / `1` |
| `ERP_DEMO_ROOT` | مسیر مطلق ریشهٔ دمو |
| `ERP_DEMO_INSTANCE_ID` | شناسهٔ ۸–۱۲۸ کاراکتری؛ باید با مارکر یکی باشد |
| `ERP_DEMO_EXPIRES_AT` | ISO-8601؛ پس از انقضا نوشتن قطع می‌شود |
| `JWT_SECRET` | حداقل ۳۲ کاراکتر؛ `demo-seed-secret` و `laptop-demo-secret` رد می‌شوند |
| `DB_PATH` | داخل ریشه؛ نه `server/crm.db` |
| `UPLOADS_DIR` | داخل ریشه؛ نه `server/public/uploads` |
| `COMPANIES_DIR` | داخل ریشه |

اختیاری: `ERP_DEMO_RESET_TOKEN` (≥۳۲)، `ERP_DEMO_SALES_URL` (فقط https)، `LISTEN_HOST` (پیش‌فرض `127.0.0.1`)، `PORT`، `ERP_DEMO_SEED_PASSWORD` (رمز مشترک ارائه‌دهنده؛ حداقل ۱۰، حرف+عدد)، `ERP_DEMO_SEED_TIMEOUT_MS` (پیش‌فرض ۱۸۰۰۰۰).

مارکر: `<ERP_DEMO_ROOT>/.erp-demo-root` با همان instance id.

`ERP_DEMO_NOW` فقط برای تست ساعت/انقضا.

## Provision (سرور را روشن نمی‌کند)

ریشه باید مطلق باشد و نباید درایو، home یا ریشهٔ ریپو باشد.

```text
node scripts/demo-v2/provision.js <absolute-demo-root>
```

می‌سازد:

- پوشه‌های `data` / `uploads` / `companies` / `private-uploads` / `backups` / `tmp` / `logs` / `secrets`
- `.erp-demo-root`
- `secrets/credentials.json` (حالت ۶۰۰ — فقط رمز ارائه‌دهنده)
- `secrets/operator-admin.json` (حالت ۶۰۰ — رمز bootstrap admin؛ بعد از seed)
- `secrets/demo.env` (حالت ۶۰۰ — **هرگز commit نشود**)

`JWT_SECRET` از `ERP_DEMO_JWT_SECRET` می‌آید یا تولید می‌شود — `JWT_SECRET` شل والد کپی نمی‌شود.
`LISTEN_HOST` پیش‌فرض `127.0.0.1` است مگر `ERP_DEMO_BIND_PUBLIC=true`.
`BACKUP_S3_URI` / `BACKUP_OFFSITE_DIR` در دمو ممنوع‌اند.

## Seed

وابستگی‌ها باید در `server/` نصب باشند (`npm install --omit=dev`). سپس:

```text
node server/scripts/seed-demo.js <absolute-db-path>
```

- اگر فایل DB از قبل باشد **رد می‌کند**.
- `ERP_TEST_ISOLATION=1`
- اگر `JWT_SECRET` نباشد یا ضعیف/شناخته‌شده باشد، برای فرایند فرزند یک مقدار ephemeral با `crypto.randomBytes` می‌سازد.
- پورت آزاد با `pickFreePort` (هرگز ۴۴۹۹ ثابت نیست).
- صبر می‌کند تا `GET /api/system/ready` مقدار `{ok:true,ready:true}` بدهد.
- فرزند در `finally` با `killProcessTree` کشته می‌شود؛ stdout/stderr گرفته می‌شود؛ سقف زمانی پیش‌فرض ۱۸۰ ثانیه.
- رمزها در لاگ چاپ نمی‌شوند — فقط مسیر فایل secrets.

اگر `ERP_DEMO_SEED_PASSWORD` نباشد، یک رمز تولید و **فقط** در `<demo-root>/secrets/credentials.json` نوشته می‌شود. رمز bootstrap `admin` جداگانه در `secrets/operator-admin.json` است.

نقش‌ها (RBAC واقعی، بدون حساب admin عمومی):

| کاربر | نقش |
|---|---|
| `demo_manager` | `sales_manager` |
| `demo_accountant` | `accounting` |
| `demo_sales` | `field_sales` |
| `demo_production` | `production_manager` |

پس از seed، رمز bootstrap `admin` تصادفی می‌شود (`auth_epoch++`) و `must_change_password=0` فقط برای همان چهار کاربر دمو پاک می‌شود. سپس `validate-demo-invariants.js` اجرا می‌شود؛ خروج غیرصفر یعنی شکست.

دادهٔ کوچک و منسجم: ۱ بانک، ۱ صندوق، ۱–۲ انبار، ۲ تأمین‌کننده، حدود ۸ کالا با موجودی از خرید، ۴–۶ مشتری روی `demo_sales`، پیگیری با مرحله، ۲ پیش‌فاکتور، ۳ عادی، ۲ نهایی (صف مودیان بدون ارسال واقعی)، ۱ برگشت خرید، ۱ برگشت فروش، ۱ ابطال (بدون حذف فیزیکی)، چرخهٔ چک، در صورت وجود API یک BOM + یک سفارش تولید، ۲ ردیف حقوق. مبالغ API به **ریال**. PRNG با seed=۴۲.

## Start / Stop

```text
node scripts/demo-v2/launch.js <absolute-demo-root>
powershell -File scripts/demo-v2/launch.ps1 <absolute-demo-root>
```

`secrets/demo.env` را بار می‌کند و پیش‌فرض به `127.0.0.1` گوش می‌دهد. برای توقف: بستن فرایند یا `taskkill` / SIGTERM روی pid داخل `logs/demo-v2.pid`.

`--pm2` فقط نام allowlistشدهٔ `erp-taranom-demo-v2` را می‌سازد. **هرگز** `pm2 delete erp-taranom`، `pm2 --update-env` یا `pm2 save` استفاده نشود.

اسکریپت‌های قدیمی `scripts/demo-online.sh` و `scripts/demo-laptop.ps1` بازنشسته و fail-closed هستند.

## Reset

```text
node scripts/demo-v2/reset.js <absolute-demo-root>
```

نیاز به Demo Mode + مارکر. Seed در `tmp/reset-*`، اعتبارسنجی، جابه‌جایی اتمی فایل‌های دقیق SQLite (بدون glob). فرایند فقط `erp-taranom-demo-v2`. پس از موفقیت دوباره `launch.js` را بزنید.

## انقضا

بعد از `ERP_DEMO_EXPIRES_AT` نوشتن‌ها `403` می‌شوند؛ خواندن امن و `/api/system/ready` می‌مانند. انقضای دمو از لایسنس تجاری جدا و fail-closed است.

## HTTPS در staging

این لانچر TLS صادر نمی‌کند. اگر جلسه از شبکه دیده می‌شود، یک reverse proxy با HTTPS جلوی bind لوکال بگذارید. در env و اسکریپت IP عمومی نگذارید. `ERP_DEMO_SALES_URL` فقط `https:` است.

## Rollback

- قبل از merge: رها کردن شاخهٔ `ai/DEMO-V2-SECURE-SALES`
- بعد از merge (خارج از این تسک): revert همان merge
- زمان اجرا: بازگرداندن `demo.db.bak-*` از مسیر reset؛ **هرگز** Production را لمس نکنید

## چک‌لیست قبل از جلسه

1. ریشهٔ دمو خارج از ریپو/home است و مارکر با instance id یکی است.
2. `secrets/demo.env` و `credentials.json` روی دیسک‌اند (۶۰۰) و در git نیستند.
3. Seed + invariants سبز شده‌اند.
4. `LISTEN_HOST=127.0.0.1` مگر پشت HTTPS.
5. انقضا بعد از جلسه است.
6. Static showcase جدا باز می‌شود (بدون credential).
7. چهار کاربر دمو از فایل secrets وارد می‌شوند — admin عمومی ارائه نمی‌شود.
8. SMS / AI / وب‌هوک واقعی در env جلسه نیست (egress دمو no-op است، ولی نشت نکنید).

## چک‌لیست بعد از جلسه

1. فرایند `erp-taranom-demo-v2` را ببندید (نه `erp-taranom`).
2. در صورت نیاز `reset.js` برای پاک‌کردن دادهٔ جلسه.
3. فایل secrets را از پروژکتور/اشتراک صفحه دور نگه دارید؛ در صورت لو رفتن reset + provision مجدد.
4. بکاپ `.bak-*` را فقط بعد از reset موفق پاک کنید (خود reset این کار را می‌کند مگر `keepBackup`).

## محدودیت‌ها

- لایسنس تجاری fail-open وقتی لایسنس فعال نیست (از قبل موجود؛ اینجا پنهان نشده)
- `sales_manager` می‌تواند سند مالی **داخل DB دمو** بزند (عمدی)
- توکن reset در صورت نشت فقط همان instance دمو را پاک می‌کند
- HTTPS را این تسک provision نمی‌کند
- Desktop Hub / pairing موبایل خارج از محدوده است
- BOM / سفارش تولید اگر مسیر API نباشد با لاگ رد می‌شود

## مدل تهدید

جزئیات: `docs/architecture/DEMO-V2-THREAT-MODEL.md` و `docs/architecture/DEMO-V2-DESIGN.md`.
