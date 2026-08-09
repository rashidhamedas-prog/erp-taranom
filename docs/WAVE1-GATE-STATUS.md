# وضعیت Gate موج یک — 2026-08-09

## Merge به primary (آمادهٔ pull ایران)

- **تاریخ:** 2026-08-09
- **شاخهٔ merge:** `ai/W1-merge-primary-deploy` → هدف push: `claude/claude-md-docs-2ssrpy`
- **Base:** `ced58ef` + **W1 ORCH:** `aca247f` (پس از merge-base `7ef8c72`؛ SEC `dcb9b40` / تست `9053883`)
- **وضعیت:** کد روی primary ادغام می‌شود؛ **deploy ایران توسط عامل دیگر** (این تسک فقط merge+push)
- **یادداشت gate:** Security Approve w/ comments؛ live مودیان و ممیزی مالی هنوز خارج از این merge


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
