# ERP ترنم (ERP Taranom)

سیستم یکپارچهٔ **CRM عمده + حسابداری دوطرفه** برای پوشاک ترنم (مشهد). یک کدبیس، سه اجرا: وب مرکزی، ویندوز (Electron)، اندروید (WebView + nodejs-mobile).

[![CI](https://github.com/rashidhamedas-prog/erp-taranom/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/rashidhamedas-prog/erp-taranom/actions/workflows/ci.yml)
[![Production tests](https://github.com/rashidhamedas-prog/erp-taranom/actions/workflows/production-tests.yml/badge.svg?branch=main)](https://github.com/rashidhamedas-prog/erp-taranom/actions/workflows/production-tests.yml)

| | |
|---|---|
| محصول | **ERP ترنم** |
| دامنه | `https://erp.poshaktaranom.com` |
| مخزن | [`rashidhamedas-prog/erp-taranom`](https://github.com/rashidhamedas-prog/erp-taranom) |
| شاخهٔ رسمی | **`main`** |
| مجوز | اختصاصی — [`LICENSE`](LICENSE) |

## معماری

```text
                    HTTPS (Cloudflare Full strict)
                              │
                    erp.poshaktaranom.com
                              │
              Iran VPS  ·  PM2 `erp-taranom`
                              │
                    server/  (Express + SQLite)
                     ├─ routes/     API
                     ├─ lib/         حسابداری، تولید، انبار
                     ├─ sync/        همگام‌سازی آفلاین (operation replay)
                     └─ public/      UI وانیلا (بدون React)

   desktop/ (Electron, SYNC_ROLE=device)     android/ (nodejs-mobile)
              └── همان سرور تعبیه‌شده؛ pull افزایشی با sync_seq
```

پشته عمداً ساده است: Node.js / Express / **better-sqlite3** (بدون ORM و TypeScript). جزئیات: [`docs/PROJECT-HANDOFF.md`](docs/PROJECT-HANDOFF.md)، همگام‌سازی: [`docs/OFFLINE-SYNC.md`](docs/OFFLINE-SYNC.md).

## ساختار مخزن

```text
android/     اپ اندروید
desktop/     نسخه ویندوز
server/      API + SQLite + UI
docs/        معماری، CHANGE-LOG، امنیت، GitHub
scripts/     بیلد و دیپلوی رسمی (نه اسکریپت‌های یک‌بارمصرف _deploy-*)
.github/     CI، قالب Issue/PR، CODEOWNERS
```

## اجرای محلی

```bash
cd server
npm install
# JWT_SECRET را برای production تنظیم کنید؛ در توسعه مقدار موقت کافی است
node server.js
# http://127.0.0.1:3000
```

## کیفیت

```bash
node --check server/server.js
node server/scripts/test-sms.js
node server/scripts/test-sync.js
npm --prefix server run test:production
```

CI کامل روی push/PR به `main` اجرا می‌شود. نقشهٔ ورک‌فلوها: [`docs/github.md`](docs/github.md).

## کلاینت‌ها

| پلتفرم | خروجی |
|--------|--------|
| دسکتاپ | `ERP-Taranom-Setup-*.exe` در `/releases/` |
| اندروید | `erp-taranom.apk` |

بیلد کامل APK/EXE فقط با درخواست صریح مالک. `applicationId` اندروید `ir.taranom.crm` می‌ماند تا نصب‌های موجود نشکنند. مسیر دیسک ایران `/home/taranom/crm-taranom` عمداً ثابت است.

## مشارکت و امنیت

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — مدل شاخه و چک‌لیست PR
- [`SECURITY.md`](SECURITY.md) — گزارش آسیب‌پذیری
- [`docs/github.md`](docs/github.md) — مدل GitHub
- [`docs/CHANGE-LOG.md`](docs/CHANGE-LOG.md) — تاریخچهٔ اعمال‌شده

## استقرار

Production فقط سرور ایران است. Push به `main` دیپلوی نمی‌کند. دیپلوی دستی: Actions → **Deploy Iran** یا overlay هدفمند طبق [`docs/08-deployment.md`](docs/08-deployment.md).
