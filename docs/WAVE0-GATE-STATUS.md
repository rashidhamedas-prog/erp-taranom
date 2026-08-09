# وضعیت Gate موج صفر — 2026-08-08

| Gate | وضعیت | شواهد |
|---|---|---|
| P0-B source drift | ✅ | prepare/hash و drift gate موجود |
| P0-S1 sync/TLS | ✅ | TLS-only، rotation/revoke/nonce و تست‌های sync |
| P0-S2 Android/Electron | ✅ source + signed RC | APK 2.0.33 و EXE 2.0.10؛ امضای فعلی محلی/خودامضا برای Windows |
| P0-S3 web/API/auth | ✅ | CSP/TT، secrets v2، upload/SSRF، session/tenant tests |
| P0-C backup/DR | ✅ operational | backup رمز‌شده production، pull واقعی خارج VPS، receipt/SHA-256، drill واقعی Windows و RTO 3s |
| P0-Q1 test pyramid | ✅ | suiteهای Wave-0 و negative tests |
| P0-Q2 delivery controls | ✅ | Wave 0 Gate هر ۷ job سبز؛ RC feed deploy + HTTP smoke؛ rollback/versioned checks |
| گواهی تجاری Windows | ⚪ waiver | مانع P0 نیست؛ EXE خودامضا است و روی PC دیگر احتمال Unknown Publisher/SmartScreen دارد |
| موج ۱–۴ | ❌ | شروع نشده |

## شواهد P0-C

- `crm-backup-20260808-153000.zip.enc` از VPS با wrapper فقط‌خواندنی به `D:\ERP-Taranom-Offsite` منتقل شد.
- SHA-256: `2166FB8E9C0F75719F7B87DFA4A01D4F72DA442C4D0553DB53F92986C5A1B866`؛ اندازه: 12,268,025 bytes.
- restore ایزوله: `ok=true`، fingerprint برابر، `companies_package_verified=1`، RTO تخمینی ۳ ثانیه.
- task پانزده‌دقیقه‌ای و task هفتگی drill هر دو با نتیجه ۰ اجرا شدند. به‌دلیل نبود elevation فعلی، taskها فقط هنگام login کاربر اجرا می‌شوند.

## نتیجه خروج Wave 0

Gate کد، امنیت، بکاپ/DR، باینری و CI موج صفر کامل است. اجرای GitHub Actions شماره `31265434377` برای commit `7460857` هر ۷ job را سبز کرد.

### W0-OPS-002 — sharp production (blocked)

- Source همچنان `sharp@0.35.0` است؛ runtime production عمداً روی `0.33.5` سالم مانده است.
- Cursor باندل آفلاین Linux x64 ساخت و بدون `git pull`/`reset` روی VPS کثیف (`6390bcc`) اعمال را آزمود؛ قبل از `pm2 restart` شکست خورد و restore خودکار module+pin را به `0.33.5` برگرداند (`REQUIRE_OK`, HTTP 200).
- علت قطعی: CPU مهمان `QEMU Virtual CPU version 2.5+` فاقد پرچم‌های x86-64-v2 (`popcnt`/`sse4_1`/`sse4_2`/`ssse3`) است. خطای sharp: `Unsupported CPU: Prebuilt binaries for Linux x64 require v2 microarchitecture`. مسیر wasm هم SSE4.1 می‌خواهد و روی این CPU در دسترس نیست.
- Unblock: ارتقای نوع CPU در hypervisor (مثلاً `x86-64-v2`/`host`) سپس `scripts/deploy-sharp-production.ps1 -Deploy`.
- نصب Administrator/S4U، خرید OV/EV، immutable cold copy و restricted release-publisher hardening اختیاری/بعدی‌اند.

## Exception منقضی‌شده انتشار RC

- ID: `W0-OPS-001-RELEASE-PUBLISHER`
- Scope: فقط APK 2.0.33 و EXE 2.0.10؛ مالک سامانه انتشار را درخواست و اجرای production uploader را تأیید کرد.
- Risk: کلید admin فعلی broad و با `NOPASSWD sudo` دارای اثر بالقوه بحرانی است.
- Controls: pinned known_hosts، `IdentitiesOnly`، forwarding disabled، ACL خصوصی کلید، stage/hash/rollback و HTTP re-hash.
- Expiry: بلافاصله پس از انتشار موفق 2026-08-08؛ استفاده بعدی تحت این exception مجاز نیست.
- Remediation: کلید/account مستقل `release-publisher`، incoming directory و promote script محدود سمت سرور.
