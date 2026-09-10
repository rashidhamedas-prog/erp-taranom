# مشارکت در ERP ترنم

مخزن خصوصی محصول است، نه پروژهٔ متن‌باز. قبل از هر تغییر [`docs/PROJECT-HANDOFF.md`](docs/PROJECT-HANDOFF.md) و [`docs/github.md`](docs/github.md) را بخوانید.

## مدل شاخه

| شاخه | نقش |
|------|-----|
| `main` | شاخهٔ رسمی GitHub. PR و CI روی همین است. |
| `claude/claude-md-docs-2ssrpy` | نام قدیمی؛ باید با `main` هم‌تِیپ بماند تا checkout سرور ایران نشکند. |
| `feat/…` `fix/…` `chore/…` `ai/…` | کار کوتاه‌عمر. بعد از merge پاک می‌شود. |

شاخهٔ کاری جدید را همیشه از `origin/main` بسازید:

```bash
git fetch origin
git checkout -b feat/SHORT-NAME origin/main
```

مستقیم روی `main` کامیت نکنید مگر hotfix اضطراری با هماهنگی مالک.

## چک‌لیست قبل از PR

1. راهنمای داخل برنامه (`ROUTES.help`) اگر رفتار محصول عوض شده.
2. ورودی در [`docs/CHANGE-LOG.md`](docs/CHANGE-LOG.md).
3. بعد از تغییر بک‌اند: `node server/scripts/test-sms.js` و `node server/scripts/test-sync.js`.
4. فرانت: بلوک اسکریپت `server/public/app.js` با `new Function` پارس شود.
5. جدول/API جدید: چک‌لیست سینک در `.cursor/rules/sync-hygiene.mdc`.
6. هیچ راز، فایل `motefareqe/`، اسکریپت یک‌بارمصرف `_deploy-*` / `_diag-*` در کامیت نباشد.
7. ابطال کامل (R13) برای هر عملیات قابل‌ویرایش ادمین/حسابداری.

قالب PR در [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) است.

## پشته (عمداً ساده)

Node.js + Express + better-sqlite3. بدون TypeScript / ORM / React. فرانت‌اند vanilla در `server/public/`.

## استقرار

Production فقط ایران است. دیپلوی خودکار با push به `main` **خاموش** است. جزئیات: [`docs/08-deployment.md`](docs/08-deployment.md) و [`scripts/DEPLOY-IRAN.md`](scripts/DEPLOY-IRAN.md).
