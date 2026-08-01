# گزارش کارهای ناتمام — موج صفر ERP ترنم (برای ChatGPT Pro)

> تاریخ: ۱۴۰۵/۰۵/۱۰ — 2026-08-01  
> مخزن: `D:\soft\Claud\porje\crm-taranom\erp-taranom1`  
> شاخه کاری: `claude/claude-md-docs-2ssrpy`  
> نقشه راه: `docs/erp-taranom-master-roadmap.md`  
> Plan: `docs/.plans/260801-wave0-critical-path/SUMMARY.md`  
> Skill: `.cursor/skills/erp-roadmap-wave0/SKILL.md`  
> **Deploy تولید تا Gate موج صفر ممنوع است.**

این فایل کارهایی است که در جلسه Cursor شروع/نیمه‌کاره ماندند یا عمداً به دست ChatGPT Pro سپرده می‌شوند. هر بخش: هدف، وضعیت فعلی، فایل‌ها، دستور تأیید، و کار باقی‌مانده.

---

## ✅ انجام‌شده در این جلسه (زمینه)

1. **بسته اجرایی موج صفر** merge شد: skill، agents، plan فازبه‌فاز، کپی roadmap.
2. **P0-A بسته شد ✅:**
   - `detectCircular` با visited-set مسیرمحور در `server/lib/production/bom.js`.
   - تست‌های T1-28 / T1-29 → BOM **۲۹/۲۹**.
   - Runner: `server/scripts/run-production-tests.js`.
   - `test:production` ×۳: EXIT=0 در **۱۰٫۶ / ۸٫۹ / ۸٫۰** دقیقه.
3. **P0-S1 جزئی:** رد HTTP ریموت؛ `test-sync-tls-url.js` ۷/۷.
4. **رگرسیون:** `test-sms` ۲۲/۲۲؛ `test-sync` ۳۳/۳۳.

---

## ❌ / ⏳ باقی‌مانده — اولویت‌دار برای ChatGPT Pro

### 1) P0-A — ~~بستن گیت~~ ✅ انجام شد

فقط اگر روی ماشین دیگر تکرار نشد: یک‌بار `npm run test:production` را تأیید کن. فاز در SUMMARY با `[x]` علامت خورده.

---

### 2) P0-B — حذف source drift وب/دسکتاپ/اندروید

**وضعیت:** فقط اکتشاف؛ کد prepare/hash مشترک کامل نشده.

**کار:**
- `server/` را SoT اعلام و enforce کن.
- اسکریپت prepare یکپارچه برای `desktop/` و `android/` (کپی بدون db/uploads/node_modules/log).
- مقایسه SHA-256 فایل‌های runtime پس از prepare → اختلاف صفر.
- CI fail روی drift در `db.js`، routes، lib، sync، UI، SW.
- نسخه واحد از release manifest.
- **بدون** `npm run dist:win` / APK کامل مگر کاربر صریح بخواهد (قانون پروژه).

**مرجع:** `docs/.plans/260801-wave0-critical-path/P0-B-source-drift.md` + roadmap §P0-B.

---

### 3) P0-S1 — تکمیل TLS sync

**وضعیت:** هسته URL انجام شد؛ بقیه باز است.

**باقی:**
- [ ] device token rotation / revoke / expiry
- [ ] mask توکن در log/UI/خطا
- [ ] replay nonce/idempotency + محدودیت زمانی
- [ ] ثبت certificate failure به‌عنوان خطای امنیتی
- [ ] تست MITM با cert نامعتبر
- [ ] سخت‌سازی Android `usesCleartextTraffic` وابسته به P0-S2
- [ ] اطمینان از اینکه همه مسیرهای pair در UI از `assertCentralUrlAllowed` عبور می‌کنند (بررسی `index.html` pairing form)

**تأیید فوری:**
```powershell
node server/scripts/test-sync-tls-url.js
node server/scripts/test-sync.js
```

---

### 4) P0-S2 — سخت‌سازی Android + Electron

**وضعیت:** اجرا نشده.

**کار (خلاصه roadmap):**
- Android: `allowBackup=false` یا data extraction rules؛ خاموش کردن cleartext عمومی؛ WebView debug off در release؛ Keystore برای token؛ checksum APK update.
- Electron: sandbox، navigation allowlist، `openExternal` فقط https+دامنه، CSP renderer، updater signature، DPAPI برای secret.

**مرجع:** `P0-S2-platform-hardening.md`

---

### 5) P0-S3 — امنیت وب و API

**وضعیت:** اجرا نشده.

**کار کلیدی:** CSP واقعی (بدون unsafe-eval در صورت امکان)، sanitizer برای `innerHTML`، CORS fail-fast بدون `ALLOWED_ORIGINS`، upload MIME/signature، rate-limit OTP/pair/upload، session revocation، secret fallback حذف، Dependabot.

**مرجع:** `P0-S3-web-api-security.md`

---

### 6) P0-C — backup / restore / DR

**وضعیت:** اجرا نشده.

**کار:** RPO≤15m / RTO≤4h؛ snapshot WAL-safe؛ رمزنگاری با کلید خارج VPS؛ مقصد S3-compatible؛ retention؛ integrity_check؛ restore drill هفتگی؛ runbook؛ مانیتور disk/backup fail.

**مرجع:** `P0-C-backup-restore.md`

---

### 7) P0-Q1 / P0-Q2 — هرم تست و CI/CD

**وضعیت:** runner تایم‌اوت برای production اضافه شد؛ Playwright کامل، parallel CI، staging gate، drift check، و production approval هنوز نیست.

**کار:** Playwright مسیرهای مالی؛ CI با timeout per job؛ security scan؛ source-drift check از P0-B؛ smoke پس از deploy؛ rollback.

**مرجع:** `P0-Q1-test-pyramid.md`, `P0-Q2-ci-cd.md`

---

### 8) موج‌های ۱–۴ و بقیه roadmap

**وضعیت:** عمداً شروع نشده (قانون skill: یک فاز؛ بعد از Gate موج صفر).

شامل: مودیان، SKU رنگ/سایز، حقوق پارامتریک، B2B شرکتی، طاقه/برش، license، PostgreSQL، …

**تا Gate موج صفر این‌ها را شروع نکن.**

---

## محدودیت‌ها / مشکلات جلسه Cursor

| مشکل | اثر | پیشنهاد برای GPT Pro |
|------|-----|----------------------|
| API limit روی Opus/GPT در `/best-of-n` | دو run اول شکست؛ برنده Composer | نیازی به تکرار best-of-n نیست؛ pack اعمال شده |
| `test-sync` همزمان با suite | ECONNREFUSED :4100 | suite و sync را سریالی اجرا کن |
| BOM ایزوله ~۲–۳ دقیقه به‌خاطر `initDB` | suite کامل ~۱۰–۱۱ دقیقه | timeout پیش‌فرض ۳۶۰s کافی است؛ کاهش initDB اختیاری |
| Deploy auto rule با roadmap تضاد دارد | skill Wave 0 deploy را block کرده | تا Gate، **Iran deploy نکن** |
| بیلد کامل APK/EXE ممنوع تا دستور کاربر | P0-B فقط prepare+hash | smoke exe/APK را بعد از تأیید کاربر |

---

## چک‌لیست شروع سریع برای ChatGPT Pro

```text
[ ] git status روی claude/claude-md-docs-2ssrpy؛ خواندن docs/CHANGE-LOG.md بالا
[ ] تأیید 3× npm run test:production + sms + sync + test-sync-tls-url
[ ] بستن P0-A در SUMMARY + CHANGE-LOG
[ ] پیاده‌سازی P0-B prepare + SHA-256 zero-diff
[ ] تکمیل P0-S1 (token/revoke/nonce) سپس P0-S2 → P0-S3 → P0-C → P0-Q
[ ] هیچ pm2/Iran deploy تا Gate موج صفر
[ ] Help داخل برنامه فقط اگر رفتار کاربر عوض شد
[ ] SYNCABLE_TABLES فقط append؛ allocateNumber؛ db.transaction؛ R13 reverse
```

---

## مسیرهای کلیدی که این جلسه لمس شد

- `.cursor/skills/erp-roadmap-wave0/*`
- `.cursor/agents/erp-wave0-executor.md`, `erp-p0-bom-ci.md`
- `docs/erp-taranom-master-roadmap.md`
- `docs/.plans/260801-wave0-critical-path/*`
- `server/lib/production/bom.js`
- `server/scripts/test-production-bom.js`
- `server/scripts/run-production-tests.js`
- `server/package.json` (`test:production`)
- `server/sync/client.js`
- `server/scripts/test-sync-tls-url.js`

---

*پایان گزارش — هر فاز را با معیار پذیرش roadmap ببند؛ «وجود UI/route» کافی نیست.*
