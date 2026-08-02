# وضعیت Gate موج صفر — 2026-08-01 (پس از handoff Codex→Cursor)

| Gate | وضعیت | شواهد |
|------|--------|--------|
| P0-S2 platform | ✅ source | Android 27/27؛ desktop 42/42؛ signed binaries فعلی RC نهایی نیستند |
| P0-S3 web/API/auth | ✅ | CSP/upload/SSRF/secrets/sessions/tenant؛ sync 44/44 |
| P0-C backup/DR | 🟡 ops open | کد+deploy؛ `BACKUP_ALLOW_SAME_DEVICE=1` موقت؛ **بدون** S3/volume جدا هنوز Gate کامل نیست |
| P0-Q deps/`xlsx` | ✅ | `xlsx` حذف؛ `exceljs@4`؛ audit بدون waiver |
| P0-Q CI/E2E | ✅ code | wave0-gate گسترش؛ Playwright ۵/۵ (login+invoice+tenant+B2B+private) |
| P0-B drift | ✅ | prepare ۲۲۶ فایل؛ SHA-256 diff=0 |
| Playwright | ✅ | critical-paths + login؛ COMPANIES_DIR ایزوله |
| امضای تجاری ویندوز | 🟡 | خودامضا Valid محلی (RC 2.0.10)؛ OV/EV لازم |
| موج ۱–۴ | ❌ | شروع نشده |
| Deploy ایران | ✅ | وب `5cb88ce`/SFTP؛ health ۲۰۰؛ SW v143 + RC releases |
| RC APK/EXE | ✅ | Android 2.0.33 / Desktop 2.0.10 امضاشده محلی |

## باقی‌ماندهٔ کوتاه

1. تکمیل P0-C ops: `BACKUP_S3_URI` یا volume جدا + drill هفتگی — same-VPS کافی نیست (DNS npm/GitHub روی VPS ضعیف)
2. امضای تجاری OV/EV ویندوز
3. چرخش `JWT_SECRET` پس از نشت تصادفی در لاگ‌های ops قبلی
