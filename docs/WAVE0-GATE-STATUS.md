# وضعیت Gate موج صفر — 2026-08-08

| Gate | وضعیت | شواهد |
|---|---|---|
| P0-B source drift | ✅ | prepare/hash و drift gate موجود |
| P0-S1 sync/TLS | ✅ | TLS-only، rotation/revoke/nonce و تست‌های sync |
| P0-S2 Android/Electron | ✅ source + signed RC | APK 2.0.33 و EXE 2.0.10؛ امضای فعلی محلی/خودامضا برای Windows |
| P0-S3 web/API/auth | ✅ | CSP/TT، secrets v2، upload/SSRF، session/tenant tests |
| P0-C backup/DR | ✅ operational | backup رمز‌شده production، pull واقعی خارج VPS، receipt/SHA-256، drill واقعی Windows و RTO 3s |
| P0-Q1 test pyramid | ✅ | suiteهای Wave-0 و negative tests |
| P0-Q2 delivery controls | 🟡 local ready | آپلودر resume/verify/atomic/rollback آماده؛ CI remote/staging evidence هنوز باید روی branch ثبت شود |
| گواهی تجاری Windows | ⚪ waiver | مانع P0 نیست؛ EXE خودامضا است و روی PC دیگر احتمال Unknown Publisher/SmartScreen دارد |
| موج ۱–۴ | ❌ | شروع نشده |

## شواهد P0-C

- `crm-backup-20260808-153000.zip.enc` از VPS با wrapper فقط‌خواندنی به `D:\ERP-Taranom-Offsite` منتقل شد.
- SHA-256: `2166FB8E9C0F75719F7B87DFA4A01D4F72DA442C4D0553DB53F92986C5A1B866`؛ اندازه: 12,268,025 bytes.
- restore ایزوله: `ok=true`، fingerprint برابر، `companies_package_verified=1`، RTO تخمینی ۳ ثانیه.
- task پانزده‌دقیقه‌ای واقعی با نتیجه ۰ اجرا شد. به‌دلیل نبود elevation فعلی، task فقط هنگام login کاربر اجرا می‌شود.

## موارد باقی‌مانده برای خروج نهایی Wave 0

1. دریافت نتیجه CI remote روی branch و ثبت evidence مربوط P0-Q2.
2. اختیاری: نصب task به‌صورت Administrator/S4U و خرید OV/EV؛ این دو blocker کد یا backup نیستند.

## Exception منقضی‌شده انتشار RC

- ID: `W0-OPS-001-RELEASE-PUBLISHER`
- Scope: فقط APK 2.0.33 و EXE 2.0.10؛ مالک سامانه انتشار را درخواست و اجرای production uploader را تأیید کرد.
- Risk: کلید admin فعلی broad و با `NOPASSWD sudo` دارای اثر بالقوه بحرانی است.
- Controls: pinned known_hosts، `IdentitiesOnly`، forwarding disabled، ACL خصوصی کلید، stage/hash/rollback و HTTP re-hash.
- Expiry: بلافاصله پس از انتشار موفق 2026-08-08؛ استفاده بعدی تحت این exception مجاز نیست.
- Remediation: کلید/account مستقل `release-publisher`، incoming directory و promote script محدود سمت سرور.
