# Task فعال

## شناسه
W1-ORCH (+ W1-F1, W1-HR1, W1-APP1, W1-PAGE, W1-E2E)

## عنوان
موج یک موازی — انطباق و بازار پوشاک (MVP)

## هدف
اجرای هم‌زمان پنج برش موج یک با مالکیت جدا طبق AI-DOS و یکپارچه‌سازی توسط orchestrator.

## محدوده مجاز
- F1: lib/moadian + routes/moadian + tests
- HR1: lib/payroll + routes/payroll + tests
- APP1: product-variants + products + sync append + tests
- PAGE: pagination helper + customers/orders/followups/suppliers/persons
- E2E: e2e money-cycle + CI workflow
- ORCH: db.js, app.js/Help, CHANGE-LOG, invoices hooks, merge gate

## خارج از محدوده
- Deploy ایران / blind pull VPS
- P1-A بازنویسی کامل فرانت
- ادعای live مودیان بدون sandbox/کلید

## وضعیت
Claimed — parallel implementation
