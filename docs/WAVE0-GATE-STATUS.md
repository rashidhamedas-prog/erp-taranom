# وضعیت Gate موج صفر — 2026-08-01 (پس از handoff Codex→Cursor)

| Gate | وضعیت | شواهد |
|------|--------|--------|
| P0-S2 platform | ✅ source | Android 27/27؛ desktop 42/42؛ signed binaries فعلی RC نهایی نیستند |
| P0-S3 web/API/auth | ✅ | CSP/upload/SSRF/secrets/sessions/tenant؛ sync 44/44 |
| P0-C backup/DR | 🟡 code↑ | health/drill/fingerprint/S3 verify در کد؛ DR ۱۳/۱۳؛ same-VPS هنوز off-server واقعی نیست |
| P0-Q deps/`xlsx` | ✅ | `xlsx` حذف؛ `exceljs@4`؛ audit بدون waiver |
| P0-Q CI/E2E | ✅ code | wave0-gate گسترش؛ Playwright ۵/۵ (login+invoice+tenant+B2B+private) |
| P0-B drift | ✅ | prepare ۲۲۶ فایل؛ SHA-256 diff=0 |
| Playwright | ✅ | critical-paths + login؛ COMPANIES_DIR ایزوله |
| امضای تجاری ویندوز | 🟡 | خودامضا Valid محلی؛ OV/EV لازم |
| موج ۱–۴ | ❌ | شروع نشده |
| Deploy ایران | ❌ | تا Gate کامل Wave 0 ممنوع |

## باقی‌ماندهٔ کوتاه

1. تکمیل P0-C ops: `BACKUP_S3_URI` یا volume جدا + drill هفتگی (`docs/WAVE0-OFFSITE-BACKUP-RUNBOOK.md`)
2. امضای تجاری OV/EV ویندوز
3. RC نهایی APK/EXE فقط با اجازهٔ کاربر
4. Deploy ایران فقط پس از بستن ops gate
