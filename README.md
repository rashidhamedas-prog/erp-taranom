# ERP ترنم (ERP Taranom)

سیستم یکپارچهٔ مدیریت مشتریان عمده + حسابداری کامل برای پوشاک ترنم.

| | |
|---|---|
| محصول | **ERP ترنم** |
| دامنهٔ production | `https://erp.poshaktaranom.com` |
| مخزن | `rashidhamedas-prog/erp-taranom` |
| شاخهٔ کاری | `claude/claude-md-docs-2ssrpy` |

## ساختار مخزن

```text
erp-taranom/
  android/     # اپ اندروید (WebView + nodejs-mobile)
  desktop/     # نسخه ویندوز (Electron)
  server/      # Node.js + Express + better-sqlite3 + UI
  docs/        # مستندات (سینک، تولید، CHANGE-LOG)
  scripts/     # بیلد/انتشار/دیپلوی
```

## پشتهٔ فنی (عمداً ساده)

- Backend: Node.js / Express / **better-sqlite3** (بدون ORM / TypeScript)
- Frontend: Vanilla JS در `server/public/index.html` (بدون React/Vue)
- آفلاین: همان سرور داخل اپ موبایل/دسکتاپ با `SYNC_ROLE=device` — جزئیات در [`docs/OFFLINE-SYNC.md`](docs/OFFLINE-SYNC.md)

## اجرای سریع (وب مرکزی)

```bash
cd server
npm install
node server.js
# http://127.0.0.1:3000
```

## کلاینت‌ها

| پلتفرم | خروجی |
|--------|--------|
| دسکتاپ | `ERP-Taranom-Setup-*.exe` در `/releases/` |
| اندروید | `erp-taranom.apk` (لینک سازگار قدیمی: `crm-taranom.apk`) |

- بیلد اندروید: `scripts/build-android.ps1`
- انتشار کامل: `scripts/release.ps1`

> **توجه:** `applicationId` اندروید فعلاً `ir.taranom.crm` می‌ماند تا آپدیت نصب‌های موجود نشکند. نام فایل DB سرور (`crm.db`) و مسیر دیسک ایران `/home/taranom/crm-taranom` عمداً در این فاز ثابت است.

## مستندات اجباری برای توسعه‌دهنده

- قوانین طلایی تولید/حسابداری: `.cursorrules` و `docs/Production/`
- لاگ تغییرات: [`docs/CHANGE-LOG.md`](docs/CHANGE-LOG.md)
- راهنمای Claude/Cursor: [`CLAUDE.md`](CLAUDE.md)

## پاک‌سازی محلی

فایل‌های غیرضروری/آرشیو شخصی در پوشهٔ والد `../D/` نگه‌داری می‌شوند و در گیت نیستند.
