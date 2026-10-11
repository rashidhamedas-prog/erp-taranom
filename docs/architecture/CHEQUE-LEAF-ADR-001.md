# ADR-CHEQUE-LEAF-001 — مودال برگه چک (مشاهده) + تاریخچه

**Status:** Accepted (۱۴۰۵/۰۷/۱۹)  
**Supersedes open decisions in:** `CHEQUE-LEAF-STATUS-RESEARCH.md` §۱۰ #1–2  
**Depends on:** ADR-ACC-CRM-UNIFY §13, Treasury ADR-001, `cheque-lifecycle.js`

## Decision

1. **نقش مودال وضعیت = فقط مشاهده.** برگهٔ مشخصات + وضعیت حال (برچسب انسانی + `lifecycle_status`) + تاریخچهٔ زمانی با لینک/جزئیات سند حسابداری. عملیات واگذاری/وصول/خرج/برگشت **داخل مودال نیست** — همان دکمه‌های ردیف دفتر چک می‌مانند.
2. **ظاهر برگه = ERP خوانا** با فیلدها در جایگاه‌های مشخص (نه facsimile چک بانکی ایران).
3. **تاریخچه P0:** بازسازی از `journal_entries` (+ settlement مرتبط) و `audit_log` — بدون جدول `cheque_events` در این موج.
4. **API:** `GET /api/cheque-records/:id` و `GET /api/cheque-records/:id/history` (خواندنی؛ بدون JE جدید).
5. **PATCH `/:id/status`:** همچنان فقط یادداشت غیرمالی؛ از مودال مشاهده فراخوانی نمی‌شود.

## In scope (P0)

- Backend history builder + routes
- UI: دکمه وضعیت → مودال برگه + timeline
- Help + SW bump + regression test

## Out of scope

- هاب عملیات داخل مودال (P1 اگر بعداً خواسته شود)
- Facsimile بانکی، پیوست تصویر، `cheque_events`، auto-leaf دسته، whitelist ۲۱۰۹ (موج‌های بعدی تحقیق)

## Consequences

- UX واضح‌تر بدون افزایش سطح ریسک حسابداری
- برچسب مراحل تاریخچه از `ref_type` (به‌خاطر overload `collection_je_id`)
