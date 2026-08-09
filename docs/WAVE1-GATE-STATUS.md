# وضعیت Gate موج یک — 2026-08-09

| Gate | وضعیت | شواهد |
|---|---|---|
| P0-F1 مودیان foundation | ✅ MVP | `ai/W1-F1-moadian` — stub/sandbox + queue + lock hook؛ live ادعا نشده |
| P0-HR1 پارامتر/snapshot حقوق | ✅ MVP | `ai/W1-HR1-payroll-params` — snapshot دوره؛ retro کامل بعدی |
| P0-APP1 رنگ/سایز/SKU | ✅ MVP API | `ai/W1-APP1-product-variants` — ۲۴ SKU + stock isolation؛ UI ماتریس بعدی |
| Pagination لیست‌های اصلی | ✅ | customers/orders/followups/suppliers/persons + products/invoices |
| Playwright مسیر پولی | ✅ spec+CI | `e2e/money-cycle.spec.js` + `wave1-e2e.yml` |
| Integration ORCH | ✅ | merges روی `ai/W1-ORCH-wave1-integration` |
| تأیید مشاور مالیاتی | ⏳ | باز برای Gate نهایی موج یک |
| Deploy ایران | ❌ | مسدود تا تأیید مالک / dirty VPS |

## شاخه‌ها

- ORCH: `ai/W1-ORCH-wave1-integration`
- F1 / HR1 / APP1 / PAGE / E2E: push شده روی origin

## یادداشت

مودیان live و تأیید مشاور مالیاتی هنوز باز است. UI ماتریس کامل SKU و retro حقوق کامل در برش بعدی.
