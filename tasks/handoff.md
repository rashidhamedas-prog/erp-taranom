# Handoff

## هدف اصلی
بستن P0-C واقعی و تحویل امن RC موج صفر.

## کارهای انجام‌شده
- بکاپ production رمز‌شده، pull واقعی Windows، DPAPI و restore drill.
- wrapper محدود backup؛ تست‌های دسترسی منفی و دانلود مثبت.
- Scheduled Task پانزده‌دقیقه‌ای با اجرای واقعی موفق.
- uploader امن و انتشار APK 2.0.33 / EXE 2.0.10.
- provision fail-closed در برابر overwrite/rotation ناخواسته.

## وضعیت فعلی
P0-C و P0-Q2 operational بسته‌اند؛ GitHub Wave 0 Gate هر ۷ job را سبز کرد.

## تست‌ها و نتایج واقعی
- offsite contract 25/25؛ policy 4/4؛ DR 14/14؛ uploader 3/3.
- artifact integrity واقعی PASS؛ embedded desktop/android هرکدام 224 و diff=0.
- actual restore `ok=true`, fingerprints match, RTO estimate 3s.
- actual release: stage/verify/promote/HTTP-hash PASS.

## ریسک باقی‌مانده
- Windows self-signed باعث SmartScreen احتمالی است؛ blocker P0 نیست.
- release admin key باید در hardening بعدی با publisher محدود جایگزین شود.
- task Interactive در logout RPO را تضمین نمی‌کند.

## مرحله دقیق بعدی
Cursor ابتدا `sharp@0.35.0` را با bundle/cache آفلاین یا registry پایدار روی VPS deploy و smoke کند. production فعلاً سالم و rollback‌شده روی 0.33.5 است. سپس dirty VPS/local worktree را بدون overwrite reconcile کند. موج ۱–۴ فقط با انتخاب مالک.
