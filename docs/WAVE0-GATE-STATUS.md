# وضعیت Gate موج صفر — 2026-08-09

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
| sharp runtime production | ⚪ waiver دائمی | سورس/CI روی `0.35.0`؛ runtime VPS عمداً `0.33.5` (CPU بدون x86-64-v2) |
| موج ۱–۴ | ⏳ آماده شروع | Gate موج صفر بسته؛ اولویت P1 با مالک |

## شواهد P0-C

- `crm-backup-20260808-153000.zip.enc` از VPS با wrapper فقط‌خواندنی به `D:\ERP-Taranom-Offsite` منتقل شد.
- SHA-256: `2166FB8E9C0F75719F7B87DFA4A01D4F72DA442C4D0553DB53F92986C5A1B866`؛ اندازه: 12,268,025 bytes.
- restore ایزوله: `ok=true`، fingerprint برابر، `companies_package_verified=1`، RTO تخمینی ۳ ثانیه.
- task پانزده‌دقیقه‌ای و task هفتگی drill هر دو با نتیجه ۰ اجرا شدند. تازمانی که elevation/S4U نصب نشود، taskها فقط هنگام login کاربر اجرا می‌شوند.

## نتیجه خروج Wave 0

Gate کد، امنیت، بکاپ/DR، باینری و CI موج صفر کامل است. اجرای GitHub Actions شماره `31265434377` برای commit `7460857` هر ۷ job را سبز کرد. W0-OPS-001 و W0-OPS-002 بسته‌اند. **موج صفر از نظر خروج رسمی تمام است؛ می‌توان سراغ P1 رفت.**

### Waiver دائمی — sharp production runtime

- **ID:** `W0-OPS-002-SHARP-RUNTIME-0335`
- **Owner acceptance:** 2026-08-09 — مالک صریحاً waiver را **بدون تاریخ انقضا** پذیرفت.
- **Scope:** فقط runtime production VPS ایران (`94.249.244.208`) برای بستهٔ `sharp`؛ سورس و CI همچنان `sharp@0.35.0` می‌مانند.
- **Allowed state:** `package.json` روی VPS و `node_modules/sharp` = `0.33.5` با `REQUIRE_OK` و HTTP 200.
- **Reason:** مهمان QEMU فاقد x86-64-v2 (`popcnt`/`sse4_1`/`sse4_2`/`ssse3`) است؛ باینری `0.35.0` و wasm (نیازمند SSE4.1) لود نمی‌شوند.
- **Risk accepted:** advisory `sharp <0.35.0` / GHSA-f88m-g3jw-g9cj روی مسیر پردازش تصویر غیرقابل‌اعتماد (کرش process / اثر integrity-availability). لایهٔ اعتبارسنجی آپلود موجود کاهش‌دهنده است، جایگزین پچ نیست.
- **Expiry:** **ندارد** (permanent per owner).
- **Optional remediation (نه blocker P0/P1):** ارتقای CPU hypervisor به `x86-64-v2`/`host` سپس `scripts/deploy-sharp-production.ps1 -Deploy`.
- **Do not claim:** «production روی 0.35.0 پچ شده» تا وقتی runtime واقعاً 0.35.0 نشود.

### W0-OPS-002 — بسته با waiver

- اسکریپت deploy آفلاین با backup/rollback/CPU-preflight/known_hosts/hash verify ساخته شد.
- دو apply آزمایشی قبل از restart شکست و restore خودکار شد؛ production سالم روی `0.33.5` ماند.
- Reviewer: Approved with comments. Security: blocked disposition approved؛ completion فقط با waiver مالک (اکنون ثبت شد).

### Hardening اختیاری بعدی (مانع P1 نیست)

- نصب Administrator/S4U برای Scheduled Task هنگام logout
- OV/EV تجاری Windows
- immutable/cold offsite
- restricted release-publisher
- هم‌تراز کردن قانون `auto-commit-deploy.mdc` با ممنوعیت `--update-env` / blind pull روی VPS کثیف

## Exception منقضی‌شده انتشار RC

- ID: `W0-OPS-001-RELEASE-PUBLISHER`
- Scope: فقط APK 2.0.33 و EXE 2.0.10؛ مالک سامانه انتشار را درخواست و اجرای production uploader را تأیید کرد.
- Risk: کلید admin فعلی broad و با `NOPASSWD sudo` دارای اثر بالقوه بحرانی است.
- Controls: pinned known_hosts، `IdentitiesOnly`، forwarding disabled، ACL خصوصی کلید، stage/hash/rollback و HTTP re-hash.
- Expiry: بلافاصله پس از انتشار موفق 2026-08-08؛ استفاده بعدی تحت این exception مجاز نیست.
- Remediation: کلید/account مستقل `release-publisher`، incoming directory و promote script محدود سمت سرور.
