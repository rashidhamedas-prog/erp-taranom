# وضعیت Gate موج صفر — 2026-08-01 (پس از handoff Codex→Cursor)

| Gate | وضعیت | شواهد |
|------|--------|--------|
| P0-S2 platform | ✅ source | Android 27/27؛ desktop 42/42؛ signed binaries فعلی RC نهایی نیستند |
| P0-S3 web/API/auth | ✅ | CSP/upload/SSRF/secrets/sessions/tenant؛ sync 44/44 |
| P0-C backup/DR | 🟡 partial v2 | encrypt+multi-db+private+verify-only+CLI؛ DR ۱۱/۱۱؛ same-VPS هنوز off-server واقعی نیست |
| P0-Q deps/`xlsx` | ✅ code | `xlsx` حذف؛ `exceljs@4`؛ audit gate بدون waiver؛ CI/E2E گسترش هنوز باز |
| Playwright | 🟡 | فعلاً login؛ مسیرهای مالی/tenant باقی |
| امضای تجاری ویندوز | 🟡 | خودامضا Valid محلی؛ OV/EV لازم |
| موج ۱–۴ | ❌ | شروع نشده |
| Deploy ایران | ❌ | تا Gate کامل Wave 0 ممنوع |

## باقی‌ماندهٔ کوتاه

1. تکمیل P0-C (off-server واقعی S3/volume جدا — same-VPS کافی نیست)
2. P0-Q باقی: CI گسترش + E2E critical مالی/tenant (exceljs بسته شد)
3. P0-B prepare/hash پس از تغییرات source
4. RC نهایی APK/EXE فقط با اجازهٔ کاربر
