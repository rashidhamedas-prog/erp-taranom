# وضعیت Gate موج یک — 2026-08-09

| Gate | وضعیت | شواهد |
|---|---|---|
| P0-F1 مودیان foundation | ✅ MVP | stub/sandbox + queue + lock؛ live رد می‌شود (`MOADIAN_LIVE_UNAVAILABLE`) |
| P0-HR1 پارامتر/snapshot حقوق | ✅ MVP | snapshot دوره؛ retro کامل بعدی |
| P0-APP1 رنگ/سایز/SKU | ✅ MVP API | ۲۴ SKU + stock isolation؛ stock واریانت `centralOnly` |
| Pagination لیست‌های اصلی | ✅ Approved | bare GET = کاتالوگ کامل (`7ef8c72`); re-review مستقل Approve |
| Playwright مسیر پولی | ✅ spec+CI | `e2e/money-cycle.spec.js` + `wave1-e2e.yml` |
| Integration ORCH | ✅ | `ai/W1-ORCH-wave1-integration` |
| Security F1/APP1 | ✅ Approve w/ comments | SEC-001..008 @ `dcb9b40`؛ بدون High باقی‌مانده |
| تأیید مشاور مالیاتی | ⏳ | لازم برای Gate نهایی |
| Deploy ایران | ❌ | مسدود تا تأیید مالک / dirty VPS |

## شاخه‌ها

- ORCH: `ai/W1-ORCH-wave1-integration`
- F1 / HR1 / APP1 / PAGE / E2E: push روی origin

## یادداشت

- LIMIT blocker: `7ef8c72` — **Approve** ([LIMIT fix independent review](42283476-259e-4017-bb57-ceab1f1ccdf1))
- Security: **Approve with comments** ([Security re-check SEC fixes](bb7a9718-bc4e-427b-9bc0-f3fb8aae96f3)) — تست‌های path/matrix cap اضافه شد
- live مودیان و مشاور مالیاتی هنوز باز است؛ Iran deploy عمداً ❌
