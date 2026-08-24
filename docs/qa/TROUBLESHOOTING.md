# QA troubleshooting

## Exit 2 فوری

- `NODE_ENV` برابر `test` نیست.
- `DB_PATH` یا `COMPANIES_DIR` زیر tmp/`artifacts/qa` نیست یا شبیه `server/crm.db` / VPS است.
- `baseURL` غیر loopback است.
- سرور تست بالا نیامد (پورت، `better-sqlite3` نصب‌نشده).

## سرور health timeout

- `npm.cmd --prefix server install --omit=dev`
- لاگ: `artifacts/qa/<id>/logs/server.log` و `fatal.log`
- پراکسی سیستم را برای Node روی loopback خالی کنید (harness خودش `HTTP(S)_PROXY` را حذف می‌کند).

## Playwright BLOCKED

وابستگی جدید اضافه نشده. در `e2e/`: `npm.cmd install` سپس `npx playwright install chromium`. یا `--skip-e2e`.

## EADDRINUSE

هارنس پورت آزاد انتخاب می‌کند. اگر گیر کرد، process درخت Node قبلی را ببندید.

## تکرار اجرا / داده تکراری

هر run یک tmp DB جدید می‌سازد؛ شماره اسناد از `allocateNumber` روی DB خالی است. Idempotent.

## recon FAIL

`reconciliation.json` را ببینید. JE نامتوازن یا موجودی ledger≠warehouse یعنی باگ محصول — با `qa-fix` در claim جدا.

## پاک‌سازی اشتباه

`run-clean.js` بدون `--yes` کار نمی‌کند و مسیر Production-like را رد می‌کند.
