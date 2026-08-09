# وضعیت Gate موج یک — 2026-08-09

## Deploy ایران (SFTP) — انجام شد

- **تاریخ:** 2026-08-09T12:31:55Z
- **کد مرجع:** `f67a9fc` (primary پس از merge W1)
- **روش:** SFTP delta (VPS DNS گیت‌هاب ندارد؛ `git pull` ممکن نیست)
- **تأیید:** health/ready/root = **200** · SW **`erp-taranom-v145`** · stamp `.sftp-deploy-stamp-w1-merge`
- **Git HEAD روی VPS:** `8a5cd54` (طبیعی — SFTP commit را عوض نمی‌کند؛ فایل‌های کد به‌روزند)

| Gate | وضعیت | شواهد |
|---|---|---|
| P0-F1 مودیان foundation | ✅ MVP | stub/sandbox + lock؛ live رد می‌شود |
| P0-HR1 پارامتر/snapshot حقوق | ✅ MVP | snapshot دوره |
| P0-APP1 رنگ/سایز/SKU | ✅ MVP API | ۲۴ SKU + `centralOnly` stock |
| Pagination | ✅ Approved | bare GET کامل (`listQueryPlan`) |
| Playwright مسیر پولی | ✅ spec+CI | money-cycle + workflow |
| Integration ORCH | ✅ | merge به primary `f67a9fc` |
| Security F1/APP1 | ✅ Approve w/ comments | SEC-001..008 |
| Deploy ایران | ✅ SFTP | hash=`f67a9fc` · SW v145 · health 200 |
| تأیید مشاور مالیاتی | ⏳ | برای live مودیان / Gate نهایی قانونی |
| Live مودیان | ❌ | عمداً خاموش تا SDK واقعی |

## یادداشت باز (غیرمسدودکنندهٔ runtime)

- DNS `github.com` روی VPS خراب → فعلاً فقط SFTP
- sharp runtime روی VPS ممکن است ناقص باشد (waiver دائمی 0.33.5 قبلاً ثبت شده)
- live مودیان و مشاور مالیاتی هنوز باز است
