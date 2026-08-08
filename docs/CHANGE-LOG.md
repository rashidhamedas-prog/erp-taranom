# لاگ تغییرات اعمال‌شده — ERP ترنم

این فایل تاریخچهٔ تغییراتی را که در Cursor / Claude Code اعمال شده نگه می‌دارد.
**قبل از شروع کار جدید، این فایل را بخوانید** تا بدانید چه چیزهایی قبلاً انجام شده است.

---

## قانون برای دستیار (Cursor / Claude Code)

بعد از **هر تسک** که کد یا تنظیمات پروژه را عوض می‌کند:

1. یک ورودی جدید در **بالای بخش «تاریخچه»** (زیر این قوانین) اضافه کن.
2. commit مربوطه را بنویس (اگر commit شده).
3. وضعیت deploy روی سرور production (`45.90.98.99`) را مشخص کن: `✅ deploy شده` / `⏳ نیاز به pull` / `❌ اعمال نشده`.

### فرمت هر ورودی

```markdown
### YYYY-MM-DD — عنوان کوتاه
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `abc1234` (یا «بدون commit»)
- **خلاصه:** ...
- **فایل‌های کلیدی:** `path/a`, `path/b`
- **Deploy:** ✅ / ⏳ / ❌
- **یادداشت:** (اختیاری — دستور deploy، نکته production، ...)
```

---

### 2026-08-02 — RC امضاشده Android 2.0.33 + Desktop 2.0.10 + deploy وب
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `fbb07a3`
- **خلاصه:** بیلد/امضای RC؛ به‌روز `manifest.json`/`latest.yml` در گیت؛ راهنما ۲.۰.۳۳/۲.۰.۱۰؛ تست APK OK؛ EXE Authenticode Valid؛ SW `v143`. وب ایران SFTP شد. **آپلود باینری APK/EXE به VPS به‌خاطر قطع مکرر SSH شکست خورد** — فایل‌ها در `New folder` و `server/public/releases/` محلی آماده‌اند؛ روی ایران موقت دانلود همان ۲.۰.۳۲/۲.۰.۹ مانده.
- **فایل‌های کلیدی:** `server/public/releases/manifest.json`, `android/app/build.gradle`, `desktop/package.json`, `scripts/test-android-apk.ps1`, `server/public/app.js`
- **Deploy:** ✅ وب/manifest/SW؛ ⚠️ باینری RC روی ایران هنوز منتقل نشده (SSH drop)
- **یادداشت:** OV/EV هنوز نیست. P0-C off-server واقعی باز است. برای انتشار باینری: USB/سی‌دی یا آپلود وقتی SSH پایدار شد (`scripts/_deploy-rc-chunked-sftp.py`).

### 2026-08-02 — Deploy ایران Wave0 + بازیابی production (DEK/ALLOWED_ORIGINS/sharp)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `6390bcc`
- **خلاصه:** pull تا `6062121`؛ ایجاد `data-encryption-key.txt`؛ تکمیل `ecosystem.config.js` با `ALLOWED_ORIGINS`/`BACKUP_*`؛ soft-require برای `sharp` تا boot در نبود باینری native نشکند؛ health HTTP ۲۰۰؛ SW `v142`.
- **فایل‌های کلیدی:** `server/ecosystem.config.js`, `server/lib/upload-policy.js`, `docs/WAVE0-GATE-STATUS.md`, `server/public/sw.js`
- **Deploy:** ✅ ایران `94.249.244.208` — `erp-taranom` online، `/api/system/health`=200
- **یادداشت:** P0-C ops هنوز باز (بدون S3/volume جدا). DNS npm روی VPS گاه `EAI_AGAIN`؛ باینری sharp از tarball محلی در حال تکمیل. توصیه: چرخش JWT پس از نشت ops قبلی.

### 2026-08-02 — P0-C: health/alert + weekly drill CLI + S3 round-trip verify
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** acd43a5
- **خلاصه:** `getBackupHealth` + API `/admin/backup-health`؛ CLI `verify-backup` و `weekly-backup-drill`؛ مقایسه fingerprint؛ تأیید download/SHA پس از آپلود S3؛ UI/راهنما؛ DR ۱۳/۱۳؛ SW `v141`.
- **فایل‌های کلیدی:** `server/backup.js`, `server/server.js`, `server/scripts/weekly-backup-drill.js`, `server/scripts/verify-backup.js`, `server/scripts/test-backup-dr.js`, `docs/WAVE0-OFFSITE-BACKUP-RUNBOOK.md`
- **تست:** backup-dr ۱۳/۱۳؛ offsite-policy ۴/۴؛ SMS ۲۲؛ sync ۴۴
- **Deploy:** ✅ (با ورودی بعدی همین روز)
- **یادداشت:** برای بستن کامل Gate هنوز `BACKUP_S3_URI`/volume جدا روی ایران + ثبت drill واقعی لازم است.

### 2026-08-01 — P0-Q CI/E2E + P0-B re-prep + سیاست offsite
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `f6dbc4e`
- **خلاصه:** گسترش `wave0-gate` (auth/upload/CSP/secrets/portal/export/offsite-policy)؛ Playwright critical ۵/۵ با `COMPANIES_DIR` ایزوله؛ تست سیاست same-device؛ اصلاح re-login پس از company switch؛ runbook off-server؛ P0-B drift=0 (۲۲۴ فایل)؛ SW `v140`.
- **فایل‌های کلیدی:** `.github/workflows/wave0-gate.yml`, `e2e/critical-paths.spec.js`, `e2e/start-e2e-server.js`, `server/scripts/test-backup-offsite-policy.js`, `docs/WAVE0-OFFSITE-BACKUP-RUNBOOK.md`
- **تست:** Playwright ۵/۵؛ financial/hostile ۲۲/۰؛ companies-fiscal ۲۰/۰؛ offsite-policy ۴/۴؛ SMS ۲۲؛ sync ۴۴؛ embedded drift 0
- **Deploy:** ❌ Wave 0 — deploy blocked
- **یادداشت:** off-server واقعی هنوز نیازمند S3/volume جدا روی ایران است.

### 2026-08-01 — P0-Q: مهاجرت `xlsx` → `exceljs` + حذف waiver
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `15bc11c`
- **خلاصه:** وابستگی آسیب‌پذیر SheetJS حذف شد؛ I/O اکسل از طریق `exceljs` + `excel-safe`/`excel-io`؛ مسیرهای import/export و گزارش تولید async؛ helper مهاک و اسکریپت‌ها اصلاح؛ waiver audit خالی؛ راهنمای داخل برنامه + SW `v139`.
- **فایل‌های کلیدی:** `server/lib/excel-io.js`, `server/lib/excel-safe.js`, `server/package.json`, `desktop/package.json`, `android/.../nodejs-project/package.json`, `server/public/app.js`, `server/public/sw.js`
- **تست:** smoke write/read؛ `audit:gate` OK؛ production-export 4/4؛ upload/SSRF 55/55؛ SMS 22/22؛ sync 44/44
- **Deploy:** ❌ Wave 0 — deploy blocked (فقط commit/push)
- **یادداشت:** گسترش CI/E2E مالی هنوز باز است؛ gate وابستگی `xlsx` بسته شد.

### 2026-08-01 — P0-C partial: بسته بکاپ v2 + verify-only آنلاین
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `2b6b280`
- **فایل‌های کلیدی:** `server/backup.js`, `server/scripts/test-backup-dr.js`, `server/scripts/restore-backup.js`, `server/server.js`
- **Deploy:** ❌ Wave 0 — deploy blocked
- **یادداشت:** مسیر `/home/taranom/crm-offsite-backups` روی همان VPS هنوز off-server واقعی نیست؛ S3 یا volume مستقل لازم است.

### 2026-08-01 — P0-S3: امنیت وب/API + نشست/tenant (Gate کد بسته)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `2b6b280`
- **فایل‌های کلیدی:** `server/lib/auth-sessions.js`, `server/public/app.js`, `server/lib/upload-policy.js`, `server/lib/secret-settings.js`, `server/lib/secure-html-response.js`, `docs/WAVE0-CODEX-TO-CURSOR-HANDOFF-2026-08-01.md`
- **تست:** auth 46/46؛ sync 44/44؛ upload 55/55؛ secrets 37/37؛ CSP browser 15/15؛ portal 64/64؛ B2B 34/34؛ SMS 22/22؛ P0-S2 regression سبز
- **Deploy:** ❌ Wave 0 — deploy blocked (فقط commit/push)
- **یادداشت:** `DATA_ENCRYPTION_KEY` برای production باید جداگانه provision شود؛ rollout طبق handoff §4.3.

### 2026-08-01 — P0-S2: سخت‌سازی کامل Android/Electron و زنجیره آپدیت
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** در انتظار commit نهایی موج صفر
- **خلاصه:** JWT محلی با AndroidKeyStore/DPAPI محافظت و توکن دستگاه در SQLite با AES-256-GCM رمز شد؛ APK فقط پس از کنترل HTTPS، اندازه، SHA-256، package/version و signer نصب می‌شود؛ دسکتاپ فقط updater/fallback صحت‌سنجی‌شده را از IPC معتبر اجرا می‌کند و Windows packaged به‌صورت پیش‌فرض امضای updater را اجباری می‌کند.
- **فایل‌های کلیدی:** `android/app/src/main/java/ir/taranom/crm/SecureSecretStore.java`, `android/app/src/main/java/ir/taranom/crm/MainActivity.java`, `desktop/local-secret-store.js`, `desktop/main.js`, `server/sync/secure-kv.js`, `server/lib/app-update.js`, `server/public/index.html`
- **تست:** Android 27/27 + Java compile؛ Desktop 42/42 + syntax؛ local secret/app-update/sync 41/41؛ release checksum/feed؛ امضای APK v2 و Authenticode Valid؛ embedded 204/204 و drift=0.
- **Deploy:** ❌ انجام نشد — Gate موج صفر و منع صریح deploy ایران.
- **یادداشت:** فایل‌های امضاشده موجود قبل از این تغییرات source ساخته شده‌اند؛ RC نهایی باید پس از پایان موج صفر دوباره build/sign/verify شود. هیچ کلید یا رمز وارد Git نشد.

### 2026-08-01 — امضای APK/EXE + انتشار releases + handoff GPT
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `1ad3acf`
- **خلاصه:** APK 2.0.32 و EXE 2.0.9 امضا و در `releases/` + New folder؛ `manifest.json`/`latest.yml` به‌روز؛ راهنمای Help؛ handoff `WAVE0-SIGNING-HANDOFF-GPT.md` برای ChatGPT. گواهی تجاری ویندوز هنوز باز.
- **فایل‌های کلیدی:** `docs/WAVE0-SIGNING-HANDOFF-GPT.md`, `docs/WAVE0-SIGNING-RUNBOOK.md`, `server/public/releases/manifest.json`, `server/public/releases/latest.yml`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ✅ ایران — SFTP releases (APK/EXE) + Help/SW `v136` + manifest؛ health 200؛ `BACKUP_OFFSITE_DIR` ماندگار. `git pull` سرور بعداً با stash `desktop/main.js` هم‌تراز می‌شود.
- **یادداشت:** JKS/PFX در git نیستند. EXE روی PC بیلد Authenticode Valid (خودامضا).

### 2026-08-01 — ops: آف‌سایت دائم ایران + امضای APK/EXE (خودامضا)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `dfa08ca`
- **خلاصه:** `BACKUP_OFFSITE_DIR=/home/taranom/crm-offsite-backups` در PM2 dump و environ فرایند ماندگار شد (JWT حفظ شد). یک بکاپ دستی `crm-backup-20260801-120822.tar.gz` با کپی آف‌سایت + sha256؛ drill استخراج در `/tmp` → `integrity=ok`, users=1. امضای APK با JKS جدید و EXE با PFX خودامضا روی PC بیلد (Valid محلی؛ SmartScreen روی PC دیگر ممکن است ناشناس بماند تا گواهی تجاری).
- **فایل‌های کلیدی:** `scripts/_iran-enable-offsite-backup.py`, `scripts/_iran-verify-offsite-env.py`, `docs/WAVE0-GATE-STATUS.md`, `docs/WAVE0-SIGNING-RUNBOOK.md`
- **Deploy:** ✅ ops روی ایران (PM2 env + drill؛ health 200)؛ `git pull` به‌خاطر dirty WT سرور abort شد؛ SW `v135`
- **یادداشت:** keystore/PFX در git نیستند. بکاپ‌ها فعلاً `.tar.gz` بدون `.enc`. سرور git هنوز روی `54848ac` تا stash/clean شود (اپ از قبل offsite در کد دارد).

### 2026-08-01 — بستن Gate کدی موج صفر (deps / offsite / مالی / Playwright)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `262b355`
- **خلاصه:** تصمیم اجرایی بدون GPT: ارتقای `adm-zip`/`nodemailer`/`sharp`؛ waiver زمان‌دار `xlsx` + `excel-safe`؛ `BACKUP_OFFSITE_DIR` + DR ۶/۶ از کپی offsite؛ تست مالی+hostile شرکت ۲۰/۰؛ Playwright login؛ CI `wave0-gate`؛ runbook امضا؛ `unsafe-inline` آگاهانه تعویق.
- **فایل‌های کلیدی:** `server/lib/excel-safe.js`, `server/backup.js`, `server/scripts/test-backup-dr.js`, `server/scripts/test-wave0-financial-hostile.js`, `server/scripts/check-audit-waivers.js`, `e2e/`, `docs/WAVE0-GATE-STATUS.md`, `.github/workflows/wave0-gate.yml`
- **Deploy:** ✅ `262b355` — ایران؛ SW `v135`
- **یادداشت:** پوشه `/home/taranom/crm-offsite-backups` ساخته شد؛ برای فعال‌سازی دائم `BACKUP_OFFSITE_DIR` را در PM2 env بگذارید. امضای EXE/APK هنوز کلید ops می‌خواهد.

### 2026-08-01 — بازسازی اسناد کالا پس از wipe (تفصیلی + کاردکس + رسید + JE)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `551de7e`
- **خلاصه:** بعد از keep-products-clean، کالاها بدون تفصیلی/کاردکس/رسید/سند افتتاحیه مانده بودند. اسکریپت `rebuild-product-docs.js` برای همهٔ ۴۹۵ کالا تفصیلی ساخت؛ برای ۳۴۴ کالای دارای موجودی: stock_logs + inventory_ledger + warehouse_moves (رسید «موجودی اول دوره»)؛ برای ۲۱ کالا با بها: JE `opening_inventory`. هم‌ترازی stock↔warehouse_stock=۰ mismatch.
- **فایل‌های کلیدی:** `server/scripts/rebuild-product-docs.js`, `scripts/_run-rebuild-product-docs-iran.py`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ✅ `551de7e` — ایران؛ VERIFY: with_coa=495، stock_logs/ledger/moves=344، opening_je=21، health 200؛ SW `v134`
- **یادداشت:** کالاهای بدون موجودی فقط تفصیلی گرفتند؛ بدون بها سند حسابداری ساخته نمی‌شود (همان قانون create محصول).

### 2026-08-01 — پاک‌سازی ایران: فقط کالا + عکس (keep-products-clean)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `e4ee442`
- **خلاصه:** پس از wipe ناقص قبلی، هنوز ۳۰ مشتری + مانده دفتر (~۱۴ میلیارد) + کاربران aref/sharafi + بانک/اسناد روی ایران مانده بود. اسکریپت `server/scripts/keep-products-clean.js` همهٔ دادهٔ کسب‌وکار را پاک کرد و **کالا (۴۹۵)، product_images (۳۵۱)، گروه کالا، انبار و warehouse_stock** را نگه داشت؛ کدینگ پایه بازسازی شد؛ فقط `@admin` ماند. بکاپ: `crm.db.pre-keep-products-2026-08-01T04-03-00-942Z.bak`.
- **فایل‌های کلیدی:** `server/scripts/keep-products-clean.js`, `scripts/_wipe-iran-keep-products.py`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ✅ `e4ee442` — ایران؛ VERIFY: customers/journal/ledger/invoices/banks=0؛ products=495؛ product_images=351؛ users=`admin`؛ health 200؛ SW `v133`
- **یادداشت:** یک party سیستمی `USER-00001` برای خودِ کاربر admin در بوت ساخته می‌شود (مشتری نیست). دستگاه‌های آفلاین باید pair/sync مجدد شوند. رمز admin دست نخورده ماند.

### 2026-08-01 — hotfix لاگین Chrome: HTTPS redirect + CSP/CORP
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `54848ac` (+ `21a4498`)
- **خلاصه:** روی `http://erp...` کلادفلر/nginx با ۳۰۱، POST لاگین را خراب می‌کرد؛ CSP `upgrade-insecure-requests` + CORP `same-origin` هم fetch را می‌کشت. حذف upgrade/HSTS از Helmet، CORP=cross-origin، redirect سمت کلاینت به https، SW v132. همچنین backtick داخل help باعث SyntaxError کل JS شده بود و فرم ورود اصلاً وصل نمی‌شد — رفع شد.
- **فایل‌های کلیدی:** `server/server.js`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ✅ `54848ac` — ایران؛ VERIFY: PARSE_OK، LOGIN_OK، بدون upgrade-insecure، CORP=cross-origin، SW `v132`

### 2026-08-01 — hotfix لاگین وب روی http (CORS)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `d47d148`
- **خلاصه:** باز کردن `http://erp.poshaktaranom.com` با Origin غیر از لیست https باعث `cb(Error)` در CORS و پاسخ ۵۰۰ می‌شد و ورود جلو نمی‌رفت. پذیرش http↔https همان host + deny بدون ۵۰۰؛ پیش‌فرض ALLOWED_ORIGINS هر دو scheme. رمز admin روی ایران به `admin123` ریست شد (با must_change_password).
- **فایل‌های کلیدی:** `server/server.js`, `server/lib/security.js`
- **Deploy:** ✅ `d47d148` — ایران؛ لاگین با Origin=http و رمز پیش‌فرض تأیید شد؛ SW `v131`

### 2026-08-01 — hotfix کروم: CSP script-src-attr برای onclick
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `194e1de`
- **خلاصه:** Helmet 7 به‌صورت پیش‌فرض `script-src-attr 'none'` می‌گذارد و همهٔ `onclick`/`onchange`های `index.html` در Chrome بلاک می‌شدند → UI «هیچ‌چیز کار نمی‌کند». صریحاً `scriptSrcAttr: unsafe-inline` + `workerSrc` اضافه شد.
- **فایل‌های کلیدی:** `server/server.js`, `server/public/index.html`
- **Deploy:** ✅ `194e1de` — ایران؛ CSP اکنون `script-src-attr 'unsafe-inline'`؛ health 200؛ SW `v130`

### 2026-08-01 — بیلد دسکتاپ 2.0.9 + اندروید 2.0.32 (خروجی New folder)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `078b868`
- **خلاصه:** bump نسخه پلتفرم‌ها پس از Wave 0؛ `prepare-embedded` drift=0؛ بیلد Windows NSIS و APK release؛ کپی به `D:\soft\Claud\porje\crm-taranom\New folder` (نه scp به `/releases/` سرور). ایران: pull تا `078b868`؛ health `/api/system/health` =200.
- **فایل‌های کلیدی:** `server/public/releases/manifest.json`, `android/app/build.gradle`, `android/.../main.js`, `scripts/test-android-apk.ps1`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ✅ `078b868` — وب ایران online؛ بسته‌های EXE/APK فقط محلی در New folder (فایل باینری روی سرور آپلود نشد)
- **یادداشت:** خروجی: `ERP-Taranom-Setup-2.0.9.exe` (~93MB)، `erp-taranom-2.0.32.apk` (~67MB). SW `v129`. Gate موج صفر (xlsx/Playwright/امضا/DR off-site) هنوز باز است.

### 2026-08-01 — hotfix deploy: پیش‌فرض ALLOWED_ORIGINS تا سرویس ایران بالا بیاید
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `3eff7ab`
- **خلاصه:** بعد از pull Wave 0، PM2 به‌خاطر اجباری بودن `ALLOWED_ORIGINS` در production کرش می‌کرد. پیش‌فرض دامنه ترنم + جابه‌جایی `assertSecurityConfig` قبل از CORS.
- **فایل‌های کلیدی:** `server/lib/security.js`, `server/server.js`
- **Deploy:** ✅ `3eff7ab` — ایران؛ health ROOT/TIME 200؛ SW `v128`
- **یادداشت:** بهتر است `ALLOWED_ORIGINS` صریح در PM2 تنظیم شود. Gate موج صفر هنوز باز است.

### 2026-08-01 — Cursor review: تأیید commit GPT Wave 0 (`6b53483`)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** (همین ورودی docs)
- **خلاصه:** Review پس از push GPT: working tree تمیز (به‌جز untracked شخصی). تأیید محلی: SMS ۲۲/۲۲، TLS ۹/۹، sync ۴۱/۴۱. Gate موج صفر همچنان باز (xlsx/audit، restore off-site، Playwright، امضای updater، unsafe-inline). **بدون deploy ایران.**
- **فایل‌های کلیدی:** `docs/CHANGE-LOG.md`, `docs/.plans/260801-wave0-critical-path/SUMMARY.md`
- **Deploy:** ❌ Wave 0 — deploy blocked
- **یادداشت:** سرور ایران هنوز روی commit قدیمی است تا دستور صریح deploy.

### 2026-08-01 — Wave 0 handoff execution: P0-B → P0-Q
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `6b53483`
- **خلاصه:**
  - **P0-B:** pipeline یکتای prepare برای desktop/Android، حذف runtime data، کنترل SHA-256 و release-id مشترک.
  - **P0-S1:** TLS-only، token با expiry/rotation/revoke، nonce امضاشده و جلوگیری از replay، پوشاندن credential در خطا.
  - **P0-S2:** خاموش‌کردن Android backup/cleartext عمومی و WebView debug release؛ sandbox و navigation/openExternal allowlist در Electron.
  - **P0-S3:** CORS production fail-fast، CSP بدون unsafe-eval، rate-limit، logout-all مبتنی بر auth epoch، audit عملیات backup/restore و Dependabot.
  - **P0-C:** snapshot امن SQLite، رمزنگاری، SHA-256، مسیر S3-compatible، RPO پانزده‌دقیقه‌ای و runbook؛ restore drill محلی ۶/۶.
  - **P0-Q1/Q2:** ماتریس تست و workflow موازی Wave 0 با timeout و artifact لاگ.
- **فایل‌های کلیدی:** `scripts/prepare-embedded-server.js`, `server/routes/sync.js`, `server/sync/device-auth.js`, `android/app/src/main/AndroidManifest.xml`, `desktop/main.js`, `server/backup.js`, `.github/workflows/wave0-gate.yml`, `docs/TEST-MATRIX-WAVE0.md`, `docs/DR-RUNBOOK.md`
- **Deploy:** ❌ Wave 0 — deploy مسدود؛ APK/EXE کامل ساخته نشد
- **یادداشت:** Gate هنوز به‌علت restore واقعی off-site، امضای updater، Playwright مالی/cross-tenant، مهاجرت کامل inline HTML و audit وابستگی‌ها باز است. `npm audit` آنلاین: ۷ advisory شامل ۴ high؛ برای `xlsx` اصلاح منتشرشده وجود ندارد و ارتقای breaking اجباری انجام نشد.

### 2026-08-01 — pairing UI: فقط HTTPS + handoff P0-B/S1 جزئیات اکتشاف
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `7df60c6`
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/sw.js`, `docs/WAVE0-GPT-PRO-HANDOFF.md`
- **Deploy:** ❌ Wave 0 — deploy blocked
- **یادداشت:** هسته TLS URL قبلاً در `df1107b`؛ Android cleartext هنوز باز است.

### 2026-08-01 — موج صفر: P0-A بسته + P0-S1 جزئی + handoff GPT Pro
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `df1107b`
- **خلاصه:**
  - P0-A: cycle detection مسیرمحور؛ T1-28/T1-29؛ runner تایم‌اوت؛ `test:production` ×۳ سبز (۱۰٫۶/۸٫۹/۸٫۰ دقیقه).
  - P0-S1 جزئی: رد HTTP ریموت sync؛ `test-sync-tls-url.js`.
  - گزارش ناتمام: `docs/WAVE0-GPT-PRO-HANDOFF.md` برای ادامه در ChatGPT Pro.
- **فایل‌های کلیدی:** `server/lib/production/bom.js`, `server/scripts/run-production-tests.js`, `server/sync/client.js`, `docs/WAVE0-GPT-PRO-HANDOFF.md`
- **Deploy:** ❌ Wave 0 — deploy blocked تا Gate
- **یادداشت:** بعدی P0-B؛ تکمیل token/revoke/nonce در P0-S1.

### 2026-08-01 — Wave 0 execution pack (skill, agents, plan, roadmap)
- **شاخه:** `codex/wave0-execution-pack-260801`
- **Commit:** `31d3c8e`
- **خلاصه:** زیرساخت Cursor برای موج صفر: کپی `docs/erp-taranom-master-roadmap.md`، skill `erp-roadmap-wave0` (قواعد §3/§19/§20 + override عدم deploy تا gate)، agents `erp-wave0-executor` و `erp-p0-bom-ci`، plan زنده `docs/.plans/260801-wave0-critical-path/`. بدون تغییر runtime.
- **فایل‌های کلیدی:** `docs/erp-taranom-master-roadmap.md`, `.cursor/skills/erp-roadmap-wave0/`, `.cursor/agents/`, `docs/.plans/260801-wave0-critical-path/`
- **Deploy:** ❌ Wave 0 — infrastructure-only; deploy blocked until gate
- **یادداشت:** P0-A بعداً در همین روز بسته شد (نگاه کنید ورودی بالا).

### 2026-07-30 — کدینگ P&L + افتتاحیه YTD + اکسل upsert + حذف حساب
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `a44f596`
- **خلاصه:**
  - ساخت کل/معین هزینه و درآمد عملیاتی (مواد، حقوق، اداری، توزیع، سربار، مالی، درآمد عملیاتی) + سند افتتاحیه `OPEN-PL-YTD` با مانده‌های ریالی وسط‌سال (طرف مقابل `3102`).
  - ورود اکسل اشخاص/کالا/کدینگ: تکراری‌ها **آپدیت** می‌شوند (نه رد). کالای تکراری: عکس و کد حفظ؛ موجودی آپدیت.
  - حذف حساب کدینگ از API/UI (فقط بدون فرزند/گردش/اتصال).
  - اسکریپت `wipe-parties-tafsili.js` برای پاک‌سازی اشخاص+تفصیلی قبل از ورود مجدد اکسل؛ `seed-pl-coa-opening.js`؛ تست `test-pl-coa-opening.js`.
  - رفع باگ اکسل فهرست اسناد: مبالغ ریال (دیگر ÷۱۰ اضافه نمی‌شود). SW `v127`.
- **فایل‌های کلیدی:** `server/routes/excel.js`, `products.js`, `accounting.js`, `server/public/index.html`, `sw.js`, `server/scripts/seed-pl-coa-opening.js`, `wipe-parties-tafsili.js`, `test-pl-coa-opening.js`, `pl-coa-opening-excel-upsert.md`
- **Deploy:** ✅ `a44f596` — ایران؛ wipe ۱۰۴ شخص + seed OPEN-PL-YTD (JE 271)؛ root 200؛ SW `v127`
- **یادداشت:** تفصیلی‌های دارای گردش سند (محک قدیمی) عمداً حذف نشدند. اشخاص فعال=۰ برای ورود مجدد اکسل.

## وضعیت فعلی (آخرین به‌روزرسانی: ۱۴۰۵/۰۵/۱۱)

| مورد | مقدار |
|------|--------|
| شاخهٔ کاری | `claude/claude-md-docs-2ssrpy` |
| آخرین commit روی GitHub | `e5e6949` (+ docs/ops بعدی) |
| آخرین commit روی سرور ایران | کد `262b355`+؛ ops آف‌سایت فعال |
| وضعیت سرور | ✅ online — health 200؛ `BACKUP_OFFSITE_DIR` روی PM2 |
| Gate موج صفر | 🟡 باقی: xlsx waiver، امضای تجاری ویندوز، unsafe-inline؛ ✅ offsite DR + Playwright + مالی |
| سرور production | تنها ایران `94.249.244.208` — `/home/taranom/crm-taranom` |
| SSH محلی | Host `taranom-ir` → `~/.ssh/id_ed25519_taranom` + `IdentitiesOnly yes` (بدون پسورد) |
| مخزن GitHub | ✅ `rashidhamedas-prog/erp-taranom` |

### 2026-07-29 — رفع هم‌پوشانی سرتیتر جدول روی ردیف اول (سراسر پروژه)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `2ec18dc`
- **خلاصه:** علت: `overflow-x:auto` روی `.tbl-wrap` اسکرول‌پورت محلی می‌سازد و `sticky; top:88px` (فاصله topbar) سرتیتر را داخل جعبه ۸۸px پایین می‌کشید و روی ردیف اول می‌نشست. اصلاح: داخل `.tbl-wrap` همیشه `top:0`؛ آفست topbar فقط برای جداول بدون wrap. SW `v126`.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ✅ `2ec18dc` — ایران، health 200، SW `v126`

### 2026-07-29 — چندشرکتی + سال مالی خام/حذف/فعال‌سازی
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `65ee5e9`
- **خلاصه:**
  - **چندشرکتی:** هر شرکت یک فایل SQLite مستقل (`data/companies/` + `registry.json`). ایجاد شرکت خام، انتخاب شرکت فعال در تنظیمات→عمومی، حذف شرکت (با رمز؛ در صورت داشتن سند `DELETE-COMPANY`)، نشان شرکت/سال در topbar.
  - **سال مالی:** در «عملیات سال مالی» و تنظیمات حسابداری: افتتاح سال خام (`OPEN-CLEAN-YEAR`)، فعال‌سازی سال، حذف سال غیرفعال، قفل/بازگشایی. بکاپ از DB فعال شرکت گرفته می‌شود.
  - بهبود: کپی کاربران به شرکت جدید با upsert (بدون شکست FK). فقط سرور مرکزی؛ دستگاه آفلاین تک‌شرکتی می‌ماند.
  - تست: `node server/scripts/test-companies-fiscal.js` → ۱۸/۱۸؛ `test-sms` ۲۲/۲۲؛ `test-sync` ۳۳/۳۳؛ SW `v125`.
- **فایل‌های کلیدی:** `server/lib/company-workspace.js`, `server/routes/companies.js`, `server/routes/fiscal-year.js`, `server/db.js`, `server/backup.js`, `server/server.js`, `server/public/index.html`, `server/public/sw.js`, `server/scripts/test-companies-fiscal.js`
- **Deploy:** ✅ `65ee5e9` — ایران، health 200، SW `v125`

### 2026-07-28 — بازیابی قیمت و کد کالای وایپ‌شده از بکاپ tar.gz
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `e552a78`
- **خلاصه:**
  - باگ قبلی بازیابی: اولین فایل `.db` خالی (`crm-pre-prod-module-…`) انتخاب می‌شد و آرشیوهای `crm-backup-*.tar.gz` که قیمت/کد سالم داشتند هرگز اسکن نمی‌شدند → فقط موجودی از انبار برگشت، قیمت/کد نه.
  - الان همهٔ بکاپ‌های خوانا (با skip کردن جدول خالی) ادغام می‌شوند و فقط فیلدهای صفر/خالی پر می‌شوند؛ migration یک‌بارهٔ `restore_product_stock_after_image_wipe_v2`.
  - روی production از بکاپ ۲۶ تیر حدود **۳۹ قیمت + ۳۹ کد** قابل بازیابی است؛ پک‌های >۱ از قبل سالم بودند.
  - راهنما + دکمهٔ تنظیمات → پشتیبان؛ SW `v124`.
- **فایل‌های کلیدی:** `server/lib/restore-product-fields.js`, `server/db.js`, `server/routes/admin.js`, `server/public/index.html`, `server/public/sw.js`, `server/scripts/test-product-image-stock-wipe.js`
- **Deploy:** ✅ `100f9e9` / SFTP — ایران، SW `v124`؛ لاگ: `priceRestored:39, codeRestored:39` از `crm-backup-20260726-000000.tar.gz`؛ تأیید: emptyCode=0، withPrice=268
- **یادداشت:** سرور به GitHub DNS ندارد؛ deploy با SFTP. ۲۲۷ کالای بدون قیمت از قبل در بکاپ هم صفر بودند.

### 2026-07-28 — Deploy ایران + رفع درخواست پسورد SSH
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `199f73d` (کد) + این ورودی CHANGE-LOG
- **خلاصه:**
  - **Deploy:** روی `94.249.244.208` از `af00f96` → `199f73d` با `git pull --ff-only`، `npm install --omit=dev`، `pm2 restart erp-taranom --update-env`؛ health HTTP **200**؛ SW **`erp-taranom-v123`**.
  - **بازیابی موجودی:** در بوت، `restore_product_stock_after_image_wipe_v1` موجودی **۳۹** کالا را از `warehouse_stock` برگرداند (`stockFromWarehouse:39`).
  - **SSH بدون پسورد:** علت درخواست پسورد نبودن Host در `~/.ssh/config` بود (چند کلید اشتباه امتحان می‌شد). کلید درست: `id_ed25519_taranom`. ورود: `ssh taranom-ir`.
- **فایل‌های کلیدی:** `docs/CHANGE-LOG.md`؛ SSH config محلی کاربر (خارج از مخزن)
- **Deploy:** ✅ `199f73d` — ایران، SW `v123`
- **یادداشت:** از این پس `ssh taranom-ir` یا `ssh taranom@94.249.244.208` با همان IdentityFile و بدون پسورد کار می‌کند.

### 2026-07-27 — بازرسی کامل پروژه: ۴۳/۴۳ تست سبز + رفع شمارش فاکتور ابطالی در گزارش‌ها
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `3eaec49` (+ `266915b` تست‌ها)
- **خلاصه:** بازرسی ماژول‌به‌ماژول با اجرای همهٔ تست‌ها (۹ خرابی → صفر) و رفع باگ‌های واقعی:
  - **گزارش‌ها (باگ R13):** فاکتور/خرید ابطالی در `reports.js` (خلاصه/ماهانه/کارشناس/برترین/بدهی)، `accounting/general` (سود و زیان)، `admin/dashboard`، `adv-reports` (aging، فروش‌به‌کالا، VAT، فصلی ۱۶۹، نسبت‌های مالی، KPI، گردش طرف‌حساب، `syncVatRecords`) و `rep-ledger` (انگیزه/سود فروشنده) شمرده می‌شد — همه با `deleted_at`/`status<>'reversed'` فیلتر شدند.
  - **هستهٔ خطا:** خطاهای 4xx (مثل «تاریخ سند قبل از سال مالی») دیگر «خطای داخلی سرور» نمی‌شوند — پیام واقعی به کاربر می‌رسد (`ledger.js` status=422 + هندلر سراسری).
  - **test-sync:** علت شکست «B pulled central product» = پروسه‌های یتیم روی پورت‌های تست؛ چک پورت + kill مطمئن + polling بعد از pair. ۳۳/۳۳ سبز.
  - **تست‌های قدیمی:** همگام‌سازی با گیت «تغییر رمز اجباری» (b2b، 1.0.9)، رجیستری append-only (portal، payroll، update11)، اسکیمای Model A (payroll nav)، cache-bust prod-ui، انبار فروش کاربر میدانی، skip تمیز mahak بدون DB.
  - **تست جدید `test-business-cycle.js` (۲۹ سنجش):** چرخهٔ کامل خرید نسیه→پرداخت→فروش رسمی→تسویه→هزینه با تطبیق تراز آزمایشی/ترازنامه/صورت‌حساب/ارزش‌گذاری موجودی و سپس ابطال R13 با برگشت کامل و صفرشدن همهٔ گزارش‌های فروش/مالیاتی.
  - **راهنما:** بخش گزارشات + SW `v123`.
- **فایل‌های کلیدی:** `routes/reports.js`, `routes/accounting.js`, `routes/adv-reports.js`, `routes/admin.js`, `lib/rep-ledger.js`, `lib/ledger.js`, `server.js`, `scripts/test-business-cycle.js`, `scripts/test-sync.js`, `public/index.html`, `public/sw.js`
- **Deploy:** ✅ همراه با deploy ۱۴۰۵/۰۵/۰۶ روی `199f73d`
- **یادداشت:** `node server/scripts/test-business-cycle.js` از این پس بعد از هر تغییر حسابداری/گزارش اجرا شود.

### 2026-07-27 — رفع وایپ موجودی/پک هنگام آپلود عکس کالا
- **شاخه:** `claude/claude-md-docs-2ssrpy` (+ `cursor/fix-product-image-stock-wipe-f75b`)
- **Commit:** `57b6ba8` (+ follow-ups)
- **خلاصه:** باگ: آپلود فوری عکس کالا با `PUT /products/:id` فقط FormData تصویر می‌فرستاد و چون فیلدهای غایب `undefined` بودند، `parseQty(stock)` موجودی را صفر و قیمت/کد/یادداشت را هم خالی می‌کرد. رفع: endpoint فقط-تصویر `POST /products/:id/images`؛ PUT جزئی؛ اصلاح `image=''`؛ بازیابی از warehouse_stock + بکاپ `.db`/`.tar.gz`/`.zip`؛ دکمهٔ دستی در تنظیمات→پشتیبان؛ SW `v122`.
- **فایل‌های کلیدی:** `server/routes/products.js`, `server/routes/admin.js`, `server/public/index.html`, `server/public/sw.js`, `server/db.js`, `server/lib/restore-product-fields.js`, `server/scripts/restore-product-stock-after-image-wipe.js`, `server/sync/capture.js`
- **Deploy:** ✅ همراه با deploy ۱۴۰۵/۰۵/۰۶ — migration موجودی ۳۹ کالا را از انبار برگرداند
- **یادداشت:** کد روی `origin/claude/claude-md-docs-2ssrpy` push شده؛ SSH درست = `id_ed25519_taranom`.

### 2026-07-26 — R13 ابطال کامل اسناد/فاکتور/عملیات
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `e0f76a0`
- **خلاصه:** سخت‌گیری ابطال کامل (سند معکوس + برگرداندن اثرها): `reverseJournalEntry` بدون `deleted_at` (اصل+معکوس در TB خنثی می‌شوند)؛ ابطال پرداخت/دریافت به حساب در لیست اسناد؛ ابطال افتتاحیه بانک/صندوق؛ ابطال اعمال انبارگردانی؛ ابطال پرداخت حقوق؛ ابطال پرداخت تأمین با `account_code`؛ reverse موجودی اول دوره هنگام غیرفعال شخص؛ فیلتر سربار بدون reversed. SW `v121`.
- **فایل‌های کلیدی:** `void-journal.js`, `void-settlement.js`, `accounting.js`, `banks.js`, `cash-boxes.js`, `purchases.js`, `payroll.js`, `stocktaking.js`, `cycle-count.js`, `parties-sync.js`, `expenses.js`, `index.html`, `sw.js`
- **Deploy:** ✅ `e0f76a0` — git pull + pm2 · health 200 · SW `erp-taranom-v121`

### 2026-07-26 — کارشناس فاکتور، حقوق/پرسنل، بانک‌صندوق، جستجو، داشبورد حذف
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `20fe971` (+ `e406853` changelog)
- **خلاصه:** انتخاب کارشناس روی فاکتور فروش؛ پیوند کارکنان به گروه اشخاص «پرسنل» + گروه کارکنان و ساختار حقوق گروهی؛ حذف ردیف‌های حقوق + ثبت دستی حقوق ماه؛ داشبورد/آمار با فیلتر `deleted_at`؛ موجودی زنده بانک؛ موجودی اول دوره صندوق؛ جستجوی مقاوم به پرانتز/ی/ک عربی. SW `v120`.
- **فایل‌های کلیدی:** `index.html`, `sw.js`, `invoices.js`, `payroll.js`, `schema.js`, `banks.js`, `cash-boxes.js`, `products.js`, `accounting.js`, `admin.js`, `search-normalize.js`, `tables.js`, `capture.js`, `db.js`, `currency.js`
- **Deploy:** ✅ `e406853` — git pull + pm2 · health 200 · SW `erp-taranom-v120`

### 2026-07-26 — باگ‌های UI/داشبورد/گزارش/آلبوم + فیچر پیامک/دریافت/پرداخت/مانده
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `175b8d6`
- **خلاصه:** فاز۱: sticky بدون auto-`tbl-scroll` همه‌جا؛ پرداختنی تأمین‌کننده با علامت صحیح `credit−debit`؛ آلبوم کالا با fetch کامل + شمارنده LTR؛ جریان نقد مطابق `sections`؛ مطالبات با preset پیش‌فرض «همه». فاز۲: متغیرها/قوانین SMS با تأخیر و hook اتومات؛ مانده اول دوره بدهکار/بستانکار؛ دریافت سه‌حالته؛ پرداخت به حساب (کل→تفصیلی). SW `v119`.
- **فایل‌های کلیدی:** `index.html`, `sw.js`, `accounting.js`, `products.js`, `sms-module.js`, `sms-dispatch.js`, `tables.js`, `capture.js`, `db.js`
- **Deploy:** ✅ `feef58d` — git stash drift + pull + pm2 · health 200 · SW `erp-taranom-v119`

### 2026-07-26 — کارت «جمع بدهکاران» مانده کامل (نه ۱۶ از 15.6B)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `ae46880`
- **خلاصه:** عدد ۱۶ در داشبورد باگ نمایش بود: مانده ~۱۵٫۵ میلیارد با `fmtCompact` به `15.6B` تبدیل و در `statCard` دوباره parse/round می‌شد → ۱۶. الان ماندهٔ جمع بدهکار/بستانکار کامل نشان داده می‌شود و فونت با `fitStatNums` داخل کادر جا می‌شود؛ SW `v118`.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ✅ `ae46880` — git pull + pm2 · health 200 · SW `erp-taranom-v118`

### 2026-07-26 — آمار داشبورد حسابداری از دفتر مشتریان (نه فقط فاکتور)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `34b0aa4` (+ `61ca507` changelog)
- **خلاصه:** کارت‌های داشبورد حسابداری همه صفر بودند چون `/accounting/overview` فقط از `invoices−settlements` محاسبه می‌کرد و در go-live فاکتور رسمی صفر است. الان مطالبات/بستانکار از `customer_ledger` و پرداختنی از `supplier_ledger` (با fallback قبلی) می‌آید؛ کش صفحهٔ dash هم برای KPI دور زده شد؛ SW `v117`.
- **فایل‌های کلیدی:** `server/routes/accounting.js`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ✅ `5b09ce2` — git pull + pm2 · health 200 · SW `erp-taranom-v117` · outstanding≈15,556,288,620

### 2026-07-26 — اصلاح آسیب پس از sync اندروید/دسکتاپ: بازگردانی Model A + پاک‌سازی دیباگ
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `fe38338`
- **خلاصه:** بعد از دستور «رفع‌باگ‌ها را روی اندروید/دسکتاپ هم اعمال کن»، به‌اشتباه منوی Model A به ساختار قدیمی برگردانده شد و instrumentation دیباگ در production ماند. الان: منوی مدل A (اشخاص/کالا/انبار/…) دوباره فعال، `_dbgUi` و `/api/system/debug-ingest` حذف، SW عادی `v115`، مطالبات ledger حفظ، سورس `desktop/server` و `android/.../server` دوباره از `server/` همگام (بدون ساخت apk/exe).
- **فایل‌های کلیدی:** `acc-nav.js`, `index.html`, `sw.js`, `server.js`, `accounting.js`
- **Deploy:** ✅ `fe38338` — git pull + pm2 · health 200 · SW `erp-taranom-v115` · `_dbgUi=0` / `debug-ingest=0`

### 2026-07-26 — شکستن کش منوی حسابداری (acc-nav هنوز vModelA را نشان می‌داد)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `f9e1a5f`
- **خلاصه:** سرور منوی درست را سرو می‌کرد ولی `Cache-Control: max-age=86400` روی JS باعث ماندن نسخهٔ Model A در مرورگر می‌شد. `acc-nav`/`tbl-enhance`/… → `no-store`؛ SW `v114` همهٔ cacheها را پاک می‌کند؛ `acc-nav.js?v=77`؛ سرگروه «اطلاعات پایه» پیش‌فرض باز.
- **فایل‌های کلیدی:** `server/server.js`, `sw.js`, `index.html`
- **Deploy:** ✅ `f9e1a5f`

### 2026-07-26 — بازگردانی سرگروه‌های منوی حسابداری (قبل از Model A)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `246a44c`
- **خلاصه:** به‌درخواست کاربر، سایدبار حسابداری از گروه‌بندی ماژولی (اشخاص/کالا/انبار/…) به سرگروه‌های قبلی برگردانده شد: اطلاعات پایه، عملیات، عملیات انبار، عملیات خاص، عملیات حسابداری، … آیتم‌های جدید (`گزارش جامع انبار`، `مدیریت دستگاه‌ها`) حفظ شدند. SW `v113` / `acc-nav.js?v=76`.
- **فایل‌های کلیدی:** `server/public/acc-nav.js`, `index.html`, `sw.js`
- **Deploy:** ✅ `246a44c` — git pull + pm2 · health 200 · SW `erp-taranom-v113`

### 2026-07-26 — مطالبات از ماندهٔ دفتر + همگام‌سازی سورس اندروید/دسکتاپ
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `732f52f`
- **خلاصه:** `/receivables` دیگر فقط به فاکتور متکی نیست — `customer_ledger` منبع مانده است (مناسب go-live با افتتاحیه و `invoices=0`). نسخه‌ها: دسکتاپ `2.0.9`، اندروید `2.0.31`. سورس embed با `prepare-server` + کپی assets همگام شد (بدون ساخت exe/apk؛ پوشه‌های `desktop/server` و `android/.../server` در gitignore هستند و هنگام build دوباره کپی می‌شوند).
- **فایل‌های کلیدی:** `server/routes/accounting.js`, `desktop/package.json`, `android/app/build.gradle`, `android/.../main.js`
- **Deploy:** ✅ `732f52f` — git pull + pm2 · health 200 · SW `erp-taranom-v112`

### 2026-07-26 — رفع UI: مانده بستانکار، فریز جدول، مطالبات، اشخاص، داشبورد، کاردکس
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `80e7fd1`
- **خلاصه:** ماهیت مانده از علامت ledger (سبز/قرمز)؛ sticky با `border-separate` + `tbl-scroll` برای کدینگ؛ مطالبات as-of تا تاریخ پایان (نه فقط فاکتور داخل ماه)؛ اشخاص بدهکار/بستانکار + جمع درست؛ اعداد کارت داشبورد بدون ellipsis؛ کاردکس با `CACHE.products=[]` خالی دیگر گیر نمی‌کند. SW `v111`.
- **فایل‌های کلیدی:** `server/public/index.html`, `sw.js`, `server/routes/accounting.js`
- **Deploy:** ✅ `80e7fd1` — git pull + pm2 · health 200 · SW `erp-taranom-v111`

### 2026-07-26 — Hardening امن: SQLite timeout/PRAGMA + دسکتاپ loopback + گارد پول
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `79bf68b`
- **خلاصه:** بدون بازنویسی موتور سینک/UUID/rename DB. `getDB()` با `timeout:5000` و PRAGMAهای WAL/FK روی هر open؛ دسکتاپ `LISTEN_HOST=127.0.0.1` + handlers خطای Node؛ `assertSafeRial` در `money.js` برای جلوگیری از فساد خاموش اعداد بزرگ. SW/compression/سینک/tbl-enhance عمداً بدون تغییر (از قبل درست بودند).
- **فایل‌های کلیدی:** `server/db.js`, `server/lib/money.js`, `desktop/main.js`
- **Deploy:** ✅ `79bf68b` — git pull + pm2 · health 200 · SW `erp-taranom-v110`
- **یادداشت:** پیشنهادهای مخرب پلن audit (sync_log، UUID PK، `safeIntegers` سراسری، `global.gc`) اجرا نشدند.

### 2026-07-26 — تأیید سرور + رفع APK گم‌شده پس از rename
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** (docs) پس از این ورودی
- **خلاصه:** بررسی کامل ایران: remote=`erp-taranom`، HEAD تا `429ecdb`، PM2 online، health/UI/SW/app-info/app-update و sync/auth سالم. باگ: `manifest` به `/releases/erp-taranom.apk` اشاره می‌کرد ولی فقط `crm-taranom.apk` روی دیسک بود → SPA به‌اشتباه `index.html` (~1.2MB) با HTTP 200 می‌داد. روی VPS `cp crm-taranom.apk erp-taranom.apk` (هر دو 67MB، md5 یکسان). چک‌لیست به `DEPLOY-IRAN.md` اضافه شد.
- **فایل‌های کلیدی:** `scripts/DEPLOY-IRAN.md`, `docs/CHANGE-LOG.md`, VPS `server/public/releases/erp-taranom.apk`
- **Deploy:** ✅ hotfix فایل APK روی دیسک + pull docs تا `429ecdb` · health 200 · SW `erp-taranom-v110`
- **یادداشت:** منطق اپلیکیشن (DB path، applicationId، PM2 cwd، `server/public/index.html`) از rebrand آسیب ندیده؛ تغییر نام GitHub/ریلیز فقط روی دانلود اندروید اثر داشت و رفع شد.

### 2026-07-26 — پاک‌سازی + بازبرند CRM→ERP + مرتب‌سازی مخزن
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `c294063` (+ `aa13dd8` عنوان .cursorrules)
- **خلاصه:** زبالهٔ بیلد/لاگ/dump حذف یا به `D/` منتقل شد؛ README اصولی ERP؛ نام APK `erp-taranom.apk`؛ gitignore سخت‌تر؛ `scripts/DEPLOY-IRAN.md` برای مسیر VPS ثابت. `applicationId` و `crm.db` و مسیر دیسک ایران عمداً بدون تغییر. junction لوکال `erp-taranom` → `crm-taranom`.
- **فایل‌های کلیدی:** `README.md`, `.gitignore`, `server/public/releases/manifest.json`, `scripts/build-android.ps1`, `scripts/DEPLOY-IRAN.md`
- **Deploy:** ✅ `aa13dd8` — git pull + pm2 · health 200 · مسیر VPS همچنان `crm-taranom`
- **یادداشت:** گیت‌هاب به `https://github.com/rashidhamedas-prog/erp-taranom` rename شد؛ remote لوکال و ایران به‌روز شد. پوشهٔ دیسک لوکال به‌خاطر قفل Cursor هنوز `crm-taranom` + junction `erp-taranom` است.

### 2026-07-26 — Online-First + اسلات ۱ موبایل/۱ دسکتاپ + بهینه‌سازی سینک
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `6eb8462`
- **خلاصه:** نشست ورود per-slot (`mobile`/`desktop`/`web`)؛ همزمان ۱ موبایل + ۱ دسکتاپ مجاز. Online-First: رویداد online/offline/visibility + poll 10s + flush outbox 400. پنل مدیریت دستگاه‌ها + لینک در تنظیمات سیستم. ایندکس‌های outbox/products/customers/sync_devices. SW `v110`.
- **فایل‌های کلیدی:** `server/routes/auth.js`, `server/db.js`, `server/sync/client.js`, `server/public/index.html`, `sw.js`
- **Deploy:** ✅ `6eb8462` / SW `erp-taranom-v110` — git pull + pm2 · health 200

### 2026-07-26 — داشبورد مدیریت: جمع بدهکار/بستانکار جدا + فریز سرتیتر
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `cf79a43`
- **خلاصه:** پنل مدیریت (داشبورد ادمین/کارشناس) و لیست مشتریان/اشخاص: ستون‌های جدا بدهکار و بستانکار + جمع گزارش جداگانه (دیگر بستانکار به بدهکاران اضافه نمی‌شود). KPI جمع بدهکاران/بستانکاران. سرتیتر جداول در کل برنامه sticky (زیر topbar؛ داخل `.tbl-scroll` با top:0). API `/admin/customer-balances` و `/customers/balances` فیلد `nature`. SW `v109` / tbl-enhance `?v=77`.
- **فایل‌های کلیدی:** `server/public/index.html`, `tbl-enhance.js`, `sw.js`, `routes/admin.js`, `routes/customers.js`
- **Deploy:** ✅ `cf79a43` / SW `erp-taranom-v109` — git pull + pm2 · health 200

### 2026-07-26 — درصد پورسانت اعشار + انتخاب حساب معین در دریافت/پرداخت
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `0928a3f`
- **خلاصه:** `fmtPct`/`parsePct` با رند ۳ رقم اعشار؛ نمایش نرخ انگیزه دیگر با `fmt` (Math.round) به ۵ تبدیل نمی‌شود. انتخاب حساب معین در دریافت مشتری، پرداخت به شخص و فیلتر معین در پرداخت هزینه؛ `account_code` روی settlements/supplier_payments. پاک‌سازی لاگ دیباگ. SW `v108`.
- **فایل‌های کلیدی:** `server/public/index.html`, `tbl-enhance.js`, `sw.js`, `routes/{accounting,purchases,admin}.js`, `db.js`
- **Deploy:** ✅ `0928a3f` / SW `erp-taranom-v108` — در حال بیلد اندروید 2.0.30 و دسکتاپ 2.0.8

### 2026-07-26 — رفع netProps + رنگ عناوین سایدبار
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `4ea1870`
- **خلاصه:** `rebuildFooter` متغیر را `netRow` ساخته بود ولی `netProps` می‌خواند → خطای «netProps is not defined» در اکثر تب‌های حسابداری پس از enhance جدول. عناوین زیرگروه سایدبار (اطلاعات پایه/عملیات/گزارشات) با `color:var(--purple)` روی سبز سایدبار نامرئی بودند → کلاس `.nav-acc-sub-title` روشن. SW `v107` / tbl-enhance `?v=76`.
- **فایل‌های کلیدی:** `server/public/tbl-enhance.js`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ✅ `4ea1870` / SW `erp-taranom-v107` — git pull + pm2 · health 200
- **یادداشت:** بیلد اندروید/دسکتاپ پس از تأیید کاربر

### 2026-07-26 — پاک‌سازی instrumentation لاگین
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `148e2e8`
- **خلاصه:** حذف لاگ‌های دیباگ موقت از handler ورود پس از تأیید رفع باگ. SW `v106`.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ✅ `148e2e8` / SW `erp-taranom-v106` — git pull + pm2 · health 200

### 2026-07-26 — رفع لاگین بی‌پاسخ (syntax در آپلود عکس)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `c87901f`
- **خلاصه:** خطای `bindProductImageInstantUpload(${id||0})` بیرون از template باعث SyntaxError کل `index.html` می‌شد؛ listener لاگین هرگز وصل نمی‌شد و با زدن ورود هیچ اتفاقی نمی‌افتاد. اصلاح به `id||0` + SW `v105`.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ✅ `c87901f` / SW `erp-taranom-v105` — git pull + pm2 · health 200
- **یادداشت:** یک‌بار hard refresh / Ctrl+F5 بعد از deploy

### 2026-07-26 — آپدیت UX / Offline-First / جداول / ناوبری مدل A
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `e30b92b`
- **خلاصه:** رفع باگ سرچ/گالری/Preview کالا و اکسل چک؛ footer جداول با جمع/میانگین/تفاضل بدهکار-بستانکار؛ اکسل دارایی ثابت؛ گزارش جامع انبار؛ آپلود فوری عکس؛ موجودی اول دوره بانک+JE؛ پنل revoke دستگاه‌ها؛ ناوبری ماژول‌محور مدل A؛ Online-First روی سینک موجود؛ Single-Device login. بدون React/RxDB/exceljs.
- **فایل‌های کلیدی:** `server/public/index.html`, `acc-nav.js`, `tbl-enhance.js`, `sw.js`, `server/routes/{excel,banks,warehouses,auth,cheque-records}.js`, `server/sync/{client,capture}.js`, `server/db.js`
- **Deploy:** ✅ `e30b92b` / SW `erp-taranom-v104` — git pull + pm2 · health 200
- **یادداشت:** SW `erp-taranom-v104`

### 2026-07-25 — رفع خطای کاذب آپلود عکس کالا
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `3592351`
- **خلاصه:** آپلود عکس گاهی روی سرور موفق بود ولی UI خطا می‌داد (timeout/پروکسی یا خطای تازه‌سازی لیست). فشرده‌سازی تصویر قبل از ارسال، پاسخ امن JSON، و اگر عکس واقعاً ذخیره شده باشد ذخیره موفق نمایش داده می‌شود. SW `v103`.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/routes/products.js`, `server/public/sw.js`
- **Deploy:** ✅ `3592351` / SW `erp-taranom-v103` — reset + SFTP + pm2 · health 200

### 2026-07-25 — سورت کاتالوگ بر اساس موجودی (نه قیمت)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `99dcb5d` (feature `2ffd5df`)
- **خلاصه:** ترتیب نمایش کالا در کاتالوگ/مدیر/بازاریاب/B2B از بیشترین **موجودی** به کمترین اصلاح شد (قبلاً اشتباه روی قیمت بود). SW `v102`.
- **فایل‌های کلیدی:** `server/routes/products.js`, `server/routes/b2b.js`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ✅ `99dcb5d` / SW `erp-taranom-v102` — reset + SFTP + pm2 · health 200
- **یادداشت:** یک‌بار hard refresh.

### 2026-07-25 — آپلود عکس کالا + سورت قیمت کاتالوگ
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `85dad85`
- **خلاصه:** رفع دوباره‌سازی آپلود و حذف عکس قبلی هنگام ویرایش کالا (ویرایش دیگر عکس اصلی را جایگزین/حذف نمی‌کند؛ dedupe در `attachUploadedImages`؛ WebP سریع‌تر ۱۰۲۴px/effort2). لیست کالا/کاتالوگ/بازاریاب/B2B از بیشترین قیمت به کمترین. SW `v101`.
- **فایل‌های کلیدی:** `server/routes/products.js`, `server/routes/b2b.js`, `server/public/sw.js`
- **Deploy:** ✅ `85dad85` / SW `erp-taranom-v101` — git reset + SFTP + pm2 · health 200
- **یادداشت:** پس از deploy یک‌بار hard refresh.

### 2026-07-25 — رفع ورود کاربران (ریست رمز مرکزی + سخت‌گیری سیاست رمز)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `545156e`
- **خلاصه:** بعد از go-live رمزهای ذخیره‌شده با آنچه کاربران امتحان می‌کردند جور نبود (admin≠admin123؛ aref/sharafi بعد از wipe عوض شده بودند). رمز موقت همهٔ کاربران فعال روی ایران ریست و لاگین HTTP 200 تأیید شد. کد: نرمال‌سازی ارقام فارسی در username، validatePassword هنگام ساخت/ویرایش کاربر، خطای واضح‌تر در بازنشانی رمز UI، SW `v100`.
- **فایل‌های کلیدی:** `server/routes/auth.js`, `server/routes/admin.js`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ✅ `545156e` / SW `erp-taranom-v100` — SFTP + pm2 restart + login HTTP 200
- **یادداشت:** ورود موقت: همه کاربران فعال با رمز موقت؛ در اولین ورود وب باید عوض شود. موبایل تا sync/pair هش جدید را ندارد. دو کاربر portal با username موبایل از بکاپ در DB فعلی نیستند.

### 2026-07-23 — پاک‌سازی go-live + بازچینی کدینگ پایه + cascade تفصیلی
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `8bb774a`
- **خلاصه:** wipe کامل دادهٔ کسب‌وکار + `chart_of_accounts`؛ `rebuildBaseCoa` (~۷۶ حساب کنترل)؛ `releaseTafsili` هنگام حذف شخص/کالا/بانک/صندوق/طرف‌حساب؛ فلگ جلوگیری از seed انبار/گروه کالا؛ بیلد دسکتاپ 2.0.7 و اندروید 2.0.29 برای دانلود.
- **فایل‌های کلیدی:** `server/lib/coa-map.js`, `server/scripts/go-live-clean.js`, `server/routes/products|persons|banks|cash-boxes.js`, `server/lib/parties-sync.js`, `scripts/_wipe-iran-golive.py`, `desktop/package.json`, `android/app/build.gradle`
- **Deploy:** ✅ `8bb774a` / SW `v99` · wipe ایران `crm.db.pre-golive-2026-07-23T15-56-12…bak` · COA=82 · customers/products/invoices=0 · users=5 · exe SHA256 `206B419F…` · APK SHA256 `91C0403E…`
- **یادداشت:** کاربران نگه داشته می‌شوند؛ دستگاه‌های آفلاین پس از wipe نیاز به pair/sync مجدد دارند. دانلود: `/releases/ERP-Taranom-Setup-2.0.7.exe` و `/releases/crm-taranom.apk`.

### 2026-07-23 — حذف گروه‌های کالای پیش‌فرض (دیگر باز نمی‌گردند)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `e84dcc6`
- **خلاصه:** علت بازگشت گروه‌ها پس از حذف: `seedStandardSubgroups` در هر boot با `INSERT OR IGNORE` لیست محک (پارچه، خرج کار، …) را دوباره می‌کاشت. seed گروه‌کالا حذف شد؛ پاک‌سازی یک‌بارهٔ ردیف‌های `گروه استاندارد` بدون کالا؛ روی DELETE وابستگی `user_catalog_categories` و فلگ `product_categories_user_cleared`؛ لیست ACL/فرم همچنان زنده از API.
- **فایل‌های کلیدی:** `server/lib/currency.js`, `server/routes/product-categories.js`, `server/db.js`, `server/public/index.html`, `sw.js`, `manifest.json`
- **Deploy:** ✅ `e84dcc6` / SW `erp-taranom-v98` — SFTP (GitHub روی VPS resolve نشد) · health 200 · روی ایران `purged 14 auto-seeded product categories`
- **یادداشت:** گروه‌هایی که به کالا وصل‌اند عمداً نگه داشته می‌شوند؛ پس از deploy یک‌بار hard refresh.

### 2026-07-23 — اندروید 2.0.28 برای دانلود روی سرور
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `c01c80a`
- **خلاصه:** بیلد APK `2.0.28` / versionCode `30` با UI موبایل مینیمال؛ `manifest.json` لینک دانلود `server`؛ آپلود روی ایران `/releases/crm-taranom.apk` (~۶۶.۵MB). API app-update برای `2.0.27` → `downloadable:true`.
- **فایل‌های کلیدی:** `android/app/build.gradle`, `android/.../main.js`, `server/public/releases/manifest.json`, `server/public/index.html`, `scripts/test-android-apk.ps1`
- **Deploy:** ✅ APK روی ایران · SHA256 `0900FDD5…` · health 200
- **یادداشت:** بدون keystore release → امضای debug؛ اگر نصب قبلی با امضای دیگر باشد یک‌بار uninstall لازم است. لینک عمومی: `https://erp.poshaktaranom.com/releases/crm-taranom.apk`

### 2026-07-23 — موبایل مینیمال (داشبورد + فیلدها)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `f7181fb` (+ `bebd01d` changelog)
- **خلاصه:** بازطراحی نسخه موبایل به سبک مینیمال تک‌ستونه: KPI به‌صورت لیست عمودی بدون برش متن، جداول داشبورد به کارت (`m-stack`)، تاپ‌بار خلوت، بج همگام کوتاه، فیلتر تمام‌عرض، فرم‌ها با هدف لمسی ۴۴px و فونت ۱۶px؛ راهنمای داخل برنامه به‌روز شد.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/sw.js`, `server/public/releases/manifest.json`
- **Deploy:** ✅ `f7181fb` / SW `erp-taranom-v97` — SFTP (GitHub روی VPS resolve نشد)
- **یادداشت:** بیلد APK/دسکتاپ انجام نشد (فقط وب). روی گوشی یک‌بار hard refresh / پاک‌سازی SW.

### 2026-07-23 — اعشار ۳ رقم، دسکتاپ مرجع کامل، دسترسی زنده گروه/انبار
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `68c870e`
- **خلاصه:** `round3`/`fmtQty` در UI؛ `centralOnly` برای دسکتاپ باز شد (+ `centralOnlyStrict` برای بکاپ/API/B2B/2FA)؛ گروه کالا و انبار در فرم کاربر/فاکتور از API زنده؛ capture کاربران/تنظیمات برای سینک دسکتاپ.
- **فایل‌های کلیدی:** `server/middleware/auth.js`, `server/sync/capture.js`, `server/public/index.html`, `prod-ui.js`, `product-categories.js`, `admin.js`
- **Deploy:** ✅ `68c870e` / SW `erp-taranom-v96` — exe 2.0.6 روی ایران
- **یادداشت:** SHA256 exe `32305EC1…` · APK محلی 2.0.27

### 2026-07-23 — پاک‌سازی همهٔ انبارها + آپدیت دسکتاپ 2.0.5 / اندروید 2.0.26
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `6c6a34b`
- **خلاصه:** ۱۸ انبار تعریف‌شده روی ایران حذف شد؛ فلگ `warehouses_user_cleared` مانع seed مجدد پیش‌فرض (db + production schema) می‌شود؛ حذف آخرین انبار از UI هم همان فلگ را می‌زند. بیلد دسکتاپ 2.0.5 و APK 2.0.26.
- **فایل‌های کلیدی:** `server/db.js`, `server/lib/production/schema.js`, `server/routes/warehouses.js`, `server/public/index.html`, `sw.js`, `manifest.json`, `desktop/package.json`, `android/app/build.gradle`
- **Deploy:** ✅ `6c6a34b` / SW `erp-taranom-v95` — exe روی ایران در `/releases/`
- **یادداشت:** بکاپ DB: `crm.db.pre-wh-purge-*.bak` · پس از restart همچنان `warehouses=0` · exe SHA256 `213F1D84…` · APK محلی SHA256 `CF79B1F7…`

### 2026-07-23 — آپدیت دسکتاپ ویندوز 2.0.4
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `8674502`
- **خلاصه:** بیلد نصب‌کننده Windows 2.0.4 با fallback آپدیت بدون feed الکترون + آخرین بک‌اند؛ `manifest.json` / `latest.yml`؛ exe روی سرور ایران در `/releases/`.
- **فایل‌های کلیدی:** `desktop/package.json`, `desktop/main.js`, `server/public/releases/manifest.json`, `latest.yml`
- **Deploy:** ✅ `8674502` — exe روی ایران آپلود شد
- **یادداشت:** مسیر محلی `desktop/dist/ERP-Taranom-Setup-2.0.4.exe` · SHA256 `13A33F42FE229E797521AD255DA5E46D5E8B1299139F754109DE2BCB348000FE`

### 2026-07-23 — تکمیل: تشخیص آپدیت بدون URL + purge پویا + APK 2.0.25
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `7e8a54f`
- **خلاصه:** باگ `update_available` وقتی URL خالی بود (اندروید local) رفع شد؛ اعلان/نوتیف واقعاً برای نسخه جدید ثبت می‌شود؛ حذف کاربر با جاروی همهٔ ستون‌های ارجاع؛ دسکتاپ بدون feed به manifest برمی‌گردد؛ تست‌های `test-app-update` / `test-purge-user`؛ SW v94 / وب 2.1.3 / اندروید 2.0.25.
- **فایل‌های کلیدی:** `server/lib/app-update.js`, `server/lib/purge-user.js`, `server/public/index.html`, `desktop/main.js`, `android/...`, `manifest.json`
- **Deploy:** ✅ `7e8a54f` / SW `erp-taranom-v94`
- **یادداشت:** APK فقط sideload محلی؛ دسکتاپ installer جدید ساخته نشد (۲.۰.۳ + fallback در سورس برای بیلد بعدی).

### 2026-07-23 — حذف کامل کاربر + آپدیت در تنظیمات/اعلان‌ها + نوتیف اندروید
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `022957d`
- **خلاصه:** `DELETE /admin/users` حالا purge کامل است؛ پنل به‌روزرسانی در تنظیمات برای همه کلاینت‌ها؛ اعلان `app_update` در زنگوله؛ AndroidBridge نوتیفیکیشن سیستمی؛ قانون بدون بیلد کامل پلتفرم.
- **فایل‌های کلیدی:** `server/lib/purge-user.js`, `server/routes/admin.js`, `server/lib/notifications.js`, `server/public/index.html`, `android/.../MainActivity.java`, `.cursor/rules/no-full-platform-builds.mdc`
- **Deploy:** ✅ `022957d` / SW `erp-taranom-v93`
- **یادداشت:** دسکتاپ بیلد نشد. APK آپدیت 2.0.24 محلی sideload.

### 2026-07-23 — UI: دکمه ↑ والد، ریل MDI باریک، حذف بارگذاری کاذب، آیکون مینیمال
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `8719743`
- **خلاصه:** دکمه ناوبری مثل Up ویندوز (سطح والد، نه تاریخچه)؛ نوار MDI هنگام باز شدن ~۴۰px؛ حذف «در حال بارگذاری» گیرکرده در پنجره‌های MDI؛ کوچک‌کردن آیکون‌های درشت؛ فیکس پارس راهنمای MDI (ورود خراب)؛ desktop **2.0.3** / android **2.0.23** / SW **v92**.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/mdi.js`, `server/public/sw.js`, `desktop/package.json`, `android/app/build.gradle`, `server/public/releases/manifest.json`
- **Deploy:** ✅ `8719743` / SW `erp-taranom-v92`
- **یادداشت:** exe: `desktop/dist/ERP-Taranom-Setup-2.0.3.exe` · APK: `server/public/releases/crm-taranom.apk` (sideload؛ روی سرور آپلود نمی‌شود).

---

### 2026-07-23 — [Cursor] بیلد دسکتاپ 2.0.2 + اندروید 2.0.22
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `540d2ab`
- **خلاصه:** بیلد نصب‌کننده Windows 2.0.2 و APK 2.0.22 با آخرین بک‌اند (MDI لبه چپ/هاور، اسناد اتومات اکسل/افتتاحیه، حذف منطقه خطر، SW v89). متادیتا `manifest.json` + `latest.yml` به‌روز شد.
- **فایل‌های کلیدی:** `desktop/package.json`, `android/app/build.gradle`, `android/.../main.js`, `server/public/releases/{manifest.json,latest.yml}`, `scripts/test-android-apk.ps1`
- **Deploy:** ✅ متادیتا روی ایران `540d2ab` — exe را کاربر با SCP آپلود کند؛ APK فقط sideload محلی
- **یادداشت:** مسیر دسکتاپ: `desktop/dist/ERP-Taranom-Setup-2.0.2.exe` — SHA256 `B974DEF2620076CD12A8324D6CD4D24E6ACCEE7BD6EB4E9099E710BD096C0378` · APK: `server/public/releases/crm-taranom.apk` (~۶۶.۵MB)

### 2026-07-23 — [Cursor] نوار MDI به لبه چپ + هاور — SW v89
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `d4bde7d`
- **خلاصه:** نوار وظیفهٔ پنجره‌های چندگانه از پایین صفحه به لبه چپ منتقل شد؛ پیش‌فرض فقط یک نوار باریک سبز دیده می‌شود و با هاور موس فهرست پنجره‌ها باز می‌شود. فضای رزرو پایین حذف شد.
- **فایل‌های کلیدی:** `server/public/mdi.js`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ✅ ایران `d4bde7d` — SW `erp-taranom-v89`

### 2026-07-23 — [Cursor] حذف منطقه خطر + اسناد اتومات اکسل/افتتاحیه — SW v88
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `e5d945b`
- **خلاصه:**
  1. تب «منطقه خطر / حذف دیتای تست» از تنظیمات و API `/admin/data-wipe` حذف شد.
  2. اسکریپت `go-live-clean.js` برای پاک‌سازی کامل دیتای کسب‌وکار (نگه داشتن کاربران/کدینگ) قبل از ورود داده واقعی.
  3. ورود اکسل و مانده/موجودی اول دوره: سند حسابداری اتومات با `voucher_type=opening|auto|manual`؛ مبدأ اکسل در `src_system=excel`؛ برچسب‌های **اتومات / دستی / افتتاحیه** (+ «اکسل») در فهرست اسناد.
  4. اشخاص با مانده اول دوره، کالا با موجودی+بهای تمام‌شده، چک اول دوره، رسید انبار با شرح اول دوره، و اسناد اکسل با نوع opening همگی سند افتتاحیه می‌سازند.
- **فایل‌های کلیدی:** `server/lib/opening-post.js`, `server/lib/excel-origin.js`, `server/lib/ledger.js`, `server/routes/{parties,products,excel,accounting,warehouses,cheque-records}.js`, `server/public/{index.html,sw.js,i18n.js}`, `server/scripts/go-live-clean.js`, `server/scripts/test-opening-excel.js`
- **Deploy:** ✅ ایران `e5d945b` — `git pull` + `pm2 restart` + health 200 + SW `erp-taranom-v88` + wipe `crm.db` (بکاپ `crm.db.pre-golive-*.bak`)
- **یادداشت:** پس از wipe: customers/products/invoices/journal=0؛ users/COA/warehouses حفظ شد. آمادهٔ ورود اکسل واقعی.
### 2026-07-23 — [Cursor] بیلد دسکتاپ Windows 2.0.1
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `bea650a`
- **خلاصه:** بررسی کامل پوستهٔ Electron (`main.js`/`preload.js`/`prepare-server`)؛ bump نسخه به `2.0.1`؛ ساخت نصب‌کننده NSIS (~۹۴MB) با آخرین بک‌اند (pairing غیرمسدود، rollback، i18n، …). متادیتا `manifest.json` + `latest.yml` به‌روز شد. `generate-release.js` نام ERP و حفظ فیلد android را پشتیبانی می‌کند.
- **فایل‌های کلیدی:** `desktop/package.json`, `desktop/dist/ERP-Taranom-Setup-2.0.1.exe` (محلی، gitignore), `server/public/releases/{manifest.json,latest.yml}`, `scripts/generate-release.js`, `desktop/BUILD-WINDOWS.md`
- **Deploy:** ⏳ — کاربر exe را با SCP روی سرور ایران آپلود می‌کند؛ سپس `git pull` + `pm2 restart`
- **یادداشت:** مسیر محلی: `desktop/dist/ERP-Taranom-Setup-2.0.1.exe` — SHA256 `9C29A827FC6DDC132CAD3930B29155F8964414F3091C78EC357AF555DE34F6F7`

### 2026-07-23 — [Cursor] رفع کامل صفحه اتصال به سرور مرکزی (موبایل) — SW v87 / Android 2.0.21
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `668397d`
- **خلاصه:** pairing دیگر تا پایان pull کل دیتابیس بلوکه نمی‌شود (ثبت سریع + دریافت پس‌زمینه با صفحه پیشرفت). اگر دریافت اولیه شکست بخورد اتصال ناقص rollback می‌شود تا بن‌بست «قبلاً متصل» نماند. probe با fallback `http://erp.poshaktaranom.com`، تشخیص `pairing_broken`، راهنمای واضح فیلدها (مدیر وب ≠ admin123 محلی)، و پیام خطای ورود بهتر روی دستگاه.
- **فایل‌های کلیدی:** `server/sync/client.js`, `server/public/index.html`, `server/public/sw.js`, `server/scripts/test-sync-repair.js`, `android/app/build.gradle`, `android/.../main.js`, `server/public/releases/manifest.json`
- **Deploy:** ✅ ایران `ffd50b4` — `git pull` + `pm2 restart` + health 200 + SW `erp-taranom-v87`
- **یادداشت:** برای گوشی باید APK **۲.۰.۲۱** نصب شود. اگر اتصال قبلی خراب است: لینک «قطع اتصال و اتصال مجدد» روی صفحه ورود → `admin/admin123` → اتصال تازه با مدیر وب.

### 2026-07-23 — [Cursor] بازیابی اتصال دستگاه آفلاین (pairing خراب) — SW v86 / Android 2.0.20
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `22f55d0` (+ `6a7fed6` changelog)
- **خلاصه:** دستگاه‌هایی که قبلاً paired شده‌اند ولی سینک/ورود خراب است دیگر بن‌بست نیستند: مهاجرت خودکار URL آلمان (`45.90.98.99`) → `https://erp.poshaktaranom.com`؛ پنل همگام‌سازی آدرس/شناسه دستگاه + «تغییر آدرس» + «قطع اتصال و اتصال مجدد»؛ لینک بازیابی روی صفحه ورود (بدون لاگین)؛ پس از reset دوباره `admin/admin123` و pairing تازه.
- **فایل‌های کلیدی:** `server/sync/client.js`, `server/routes/sync.js`, `server/public/index.html`, `server/public/sw.js`, `server/scripts/test-sync-repair.js`, `android/app/build.gradle`, `android/.../main.js`, `server/public/releases/manifest.json`
- **Deploy:** ✅ ایران `6a7fed6` — `git pull` + `pm2 restart` + health 200 + SW `erp-taranom-v86`
- **یادداشت:** برای گوشی، APK **۲.۰.۲۰** دکمهٔ بازیابی داخل اپ را می‌آورد (بیلد محلی به‌خاطر timeout آینهٔ Maven فعلاً کامل نشد). **الان بدون APK جدید:** تنظیمات گوشی → ERP ترنم → پاک کردن داده → ورود `admin/admin123` → اتصال به `https://erp.poshaktaranom.com` با رمز مدیر مرکزی → ورود با کاربر اصلی.

### 2026-07-23 — [Cursor] زبان برنامه (فا/ان) + فارسی‌سازی برچسب‌های انگلیسی — SW v85
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `ddf1a57`
- **خلاصه:** برچسب‌های انگلیسی UI (به‌جز تب API تنظیمات) فارسی شد؛ سیستم `i18n.js` با سوئیچ «زبان برنامه» در تنظیمات → عمومی اضافه شد تا کل پوسته به انگلیسی برود.
- **فایل‌های کلیدی:** `server/public/i18n.js`, `server/public/index.html`, `server/public/acc-nav.js`, `server/public/sw.js`
- **Deploy:** ✅ Iran HTTP `/` 200, SW `erp-taranom-v85`

### 2026-07-23 — [Cursor] منوی حساب (آیکون power) + اصلاح سرریز آدرس جدول — SW v84
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `0fea8f1`
- **خلاصه:** بلوک پایین سایدبار (تم/رمز/امنیت/خروج) حذف و به منوی کشویی گوشه با آیکون خاموش منتقل شد؛ ستون آدرس در جداول با clamp دوخطی و tooltip جلوی سرریز به ستون بعدی گرفته شد.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/sw.js`, `docs/CHANGE-LOG.md`
- **Deploy:** ✅ Iran HTTP `/` 200, SW `erp-taranom-v84`

### 2026-07-23 — [Cursor] انتقال کاربران و API به تنظیمات — SW v83
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `858eeda`
- **خلاصه:** «کاربران» و «API» از منوی کناری اصلی حذف و فقط به‌صورت تب داخل تنظیمات در دسترس‌اند (هم‌سبک پیامک/پشتیبان). راهنما به‌روز شد.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/sw.js`, `docs/CHANGE-LOG.md`
- **Deploy:** ✅ Iran HTTP `/` 200, SW `erp-taranom-v83`

### 2026-07-23 — [Cursor] آیکون مینیمال تنظیمات/گروه‌ها + انتقال پیامک و پشتیبان به تنظیمات — SW v82
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `1473cdd`
- **خلاصه:** اندازه آیکون‌های شِل تنظیمات و گروه‌ها کوچک و مینیمال شد؛ «پیامک» و «پشتیبان» از منوی کناری اصلی حذف و فقط به‌صورت تب داخل تنظیمات در دسترس‌اند.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/sw.js`, `docs/CHANGE-LOG.md`
- **Deploy:** ✅ Iran health 200, SW `erp-taranom-v82`

### 2026-07-23 — [Cursor] بازطراحی UX گروه‌ها و زیرگروه‌ها — SW v81
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `037fd39`
- **خلاصه:** رابط گروه‌های کالا (درخت گروه/زیرگروه + فیلتر + جستجو)، گروه‌های اشخاص و گروه‌های مشتری با همان زبان طراحی تنظیمات (hero، آمار، کارت، سوئیچ بین بخش‌ها) بازطراحی شد.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/sw.js`, `docs/CHANGE-LOG.md`
- **Deploy:** ✅ `e82d8d8` — Iran health 200, SW `erp-taranom-v81`

### 2026-07-23 — [Cursor] بازطراحی UX تنظیمات برنامه (دسته‌بندی + جستجو) — SW v80
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `970a2c7`
- **خلاصه:** صفحه تنظیمات از فهرست بلند شلوغ به شِل دسته‌بندی‌شده با منوی کناری (۸ بخش)، جستجو، سوئیچ‌های تمیز، و نوار ذخیرهٔ چسبان تبدیل شد. راهنمای داخل‌برنامه به‌روز شد. بدون React — Vanilla JS مطابق معماری پروژه.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/sw.js`, `docs/CHANGE-LOG.md`
- **Deploy:** ✅ `69e351b` — Iran health 200, SW `erp-taranom-v80`

### 2026-07-23 — [Cursor] R13 فاز ۲: ابطال انبار، چک، دارایی، نرخ سربار، خرید — SW v79
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `8d80a9e`
- **خلاصه:** تکمیل فاز ۲ قانون ابطال کامل: void عملیات انبار (موجودی+JE دسته‌ای)، ابطال کامل چرخه دفتر چک، غیرفعال‌سازی/ابطال استهلاک دارایی ثابت، لغو نرخ سربار، مسدودسازی ابطال خرید روی برگشت/پرداخت فعال، `production.delete` برای حسابداری.
- **فایل‌های کلیدی:** `server/lib/void-warehouse-move.js`, `void-cheque.js`, `void-journal.js`, `routes/warehouses.js`, `cheque-records.js`, `fixed-assets.js`, `purchases.js`, `production-cost-centers.js`, `lib/rbac.js`, `public/index.html`
- **Deploy:** ✅ `8d80a9e` ایران — health 200
- **SW:** `erp-taranom-v79`

### 2026-07-23 — [Cursor] R13 ابطال کامل + لغو فاکتور رسمی از تأیید — SW v78
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `c7280db`
- **خلاصه:** قانون دائمی R13 (Edit⇒Cancel با reverse همهٔ اثرات). لغو فاکتور رسمی توسط مدیر/حسابداری از صفحهٔ تأیید: cascade ابطال تسویه، برگشت به پیش‌فاکتور در صورت تبدیل، پیام داخل‌برنامه با عکس فاکتور. بدون حذف فیزیکی (R12).
- **فایل‌های کلیدی:** `server/lib/void-invoice.js`, `server/lib/void-settlement.js`, `server/routes/invoices.js`, `server/routes/accounting.js`, `server/public/index.html`, `server/sync/capture.js`, `.cursor/rules/full-reverse-on-cancel.mdc`
- **Deploy:** ✅ `c7280db` ایران — health 200
- **SW:** `erp-taranom-v78`
- **یادداشت:** فاز ۲ backlog: انبار moves، چک، دارایی ثابت، نرخ سربار.

### 2026-07-23 — [Cursor] قالب فاکتور v2: ۳ رسمی + عادی ساده + حرارتی — SW v77
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `d46fe60`
- **خلاصه:** طراحی جدید چاپ فاکتور: لوگو بدون بک مشکی، ستون تخفیف ردیفی، کارشناس فروش+موبایل. حذف عادی فشرده؛ پیش‌فاکتور فقط `casual-simple`؛ رسید → `thermal` با عرض ۵۸/۸۰mm در تنظیمات و دیالوگ چاپ.
- **فایل‌های کلیدی:** `server/lib/invoice-print.js`, `server/routes/invoices.js`, `server/routes/settings.js`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ✅ `d46fe60` ایران — health 200
- **SW:** `erp-taranom-v77`

### 2026-07-23 — [Cursor] ثبت قانون sync-hygiene برای جلوگیری از تکرار باگ‌های سینک
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `a124f3b`
- **خلاصه:** درس‌های audit ۱۴۰۵/۰۵ (PATH_TABLE_MAP، SYNCABLE append، compositeKeys، backfill_vN، files.js، ممنوعیت ingest دیباگ) در `.cursor/rules/sync-hygiene.mdc` + گسترش R10 در `.cursorrules` / project-conventions + چک‌لیست در `docs/OFFLINE-SYNC.md`.
- **فایل‌های کلیدی:** `.cursor/rules/sync-hygiene.mdc`, `docs/OFFLINE-SYNC.md`, `.cursorrules`, `.cursor/skills/project-conventions/SKILL.md`
- **Deploy:** ✅ `a124f3b` ایران
- **SW:** `erp-taranom-v76`

### 2026-07-23 — [Cursor] حذف instrumentation دیباگ سینک پس از تأیید
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `820287a`
- **خلاصه:** حذف fetchهای debug session `b16e78` از `capture.js` / `client.js` پس از تأیید post-fix (diag صفر mismatch + test-sync 33/33). منطق فیکس سینک بدون تغییر.
- **فایل‌های کلیدی:** `server/sync/capture.js`, `server/sync/client.js`, `docs/CHANGE-LOG.md`
- **Deploy:** ✅ ایران — health 200؛ SW `erp-taranom-v76`
- **SW:** `erp-taranom-v76`

### 2026-07-23 — [Cursor] تکمیل شکاف‌های سینک (PATH_TABLE_MAP + جداول غایب + فایل‌ها)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `9167b3d`
- **خلاصه:**
  1. `PATH_TABLE_MAP`: parties، detail-accounts/categories، units، product-categories، warehouses/moves، fixed-assets، production/user-cost-centers، reps/payments
  2. APPEND به `SYNCABLE_TABLES`: `fixed_assets`, `fixed_asset_depreciation`, `user_cost_centers` (composite), `rep_payment_submissions` + FK + `sync_seq_backfill_v4`
  3. file sync: `product_images` + رسیدهای `reps/`؛ حذف ingest دیباگ قدیمی از `client.js`
  4. تشخیص: `scripts/_diag-sync-gaps-b16e78.js` — post-fix صفر mismatch؛ `test-sync.js` ۳۳/۳۳
- **فایل‌های کلیدی:** `server/sync/capture.js`, `server/sync/tables.js`, `server/sync/client.js`, `server/sync/files.js`, `server/db.js`, `docs/CHANGE-LOG.md`, `server/public/index.html`
- **Deploy:** ✅ `99e1015` ایران — health 200؛ diag صفر mismatch؛ SW `erp-taranom-v76`
- **SW:** `erp-taranom-v76` (بدون bump — تغییر عمدتاً سرور/سینک)

### 2026-07-22 — [Cursor] ۶ قالب فاکتور رسمی/معمولی + تنظیمات A4/A5 — SW v76
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** c7c7b5e
- **خلاصه:** موتور چاپ `invoice-print.js` با ۳ قالب رسمی + ۳ معمولی (برند ترنم)، انتخاب در تنظیمات، شخصی‌سازی فیلدها، A4/A5. فاکتور نهایی→رسمی، پیش‌فاکتور→معمولی.
- **فایل‌های کلیدی:** `server/lib/invoice-print.js`, `server/routes/invoices.js`, `server/routes/settings.js`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ⏳
- **SW:** `erp-taranom-v76`

### 2026-07-22 — [Cursor] رفع سینک انبار/جداول غایب + cascade حذف party↔CRM + SW v75
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** (در حال push)
- **خلاصه:**
  1. باگ tombstone برای `warehouse_stock` (کلید مرکب بدون `id`) — `compositeKeys` + apply درست در `client.js`
  2. append فقط: `party_groups` + `cheque_records` به `SYNCABLE_TABLES` (+ backfill sync_seq v3)
  3. `PATH_TABLE_MAP`: مسیرهای production/inventory/party-groups قبل از prefix عمومی
  4. حذف حسابداری party → cascade CRM؛ حذف CRM → soft-delete party؛ فیلتر لیست‌ها؛ سورت ستون با `data-sort`
  5. یکدست‌سازی `?v=75` با SW `erp-taranom-v75`
- **فایل‌های کلیدی:** `server/sync/{tables,client,capture}.js`, `server/db.js`, `server/lib/parties-sync.js`, `server/routes/{parties,customers,followups,suppliers}.js`, `server/public/{index.html,tbl-enhance.js,sw.js}`
- **Deploy:** ⏳
- **تست:** `node scripts/debug-warehouse-stock-sync.js` (post-fix fixWorks), `node scripts/test-party-crm-delete-sync.js`
- **SW:** `erp-taranom-v75`

### 2026-07-22 — حذف کامل واحد عملیاتی در پورتال
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `f9e9282`
- **خلاصه:** کنار ویرایش واحد، دکمهٔ حذف اضافه شد. `DELETE /api/portal/units/:id` به‌جای بایگانی، واحد را با cascade کامل (بخش‌ها، پارامترها، اتصالات، امکانات/وظایف/واگذاری) از DB پاک می‌کند. اسناد حسابداری/انبار قبلی دست‌نخورده می‌مانند. SW `v74`.
- **فایل‌های کلیدی:** `server/routes/portal.js`, `server/public/portal-ui.js`, `server/public/index.html`, `server/public/sw.js`, `server/scripts/test-portal.js`
- **Deploy:** ✅ Iran health/root 200 — SW `erp-taranom-v74` (git pull روی سرور به‌خاطر DNS github شکست؛ فایل‌ها با SFTP اعمال شد)
- **SW:** `erp-taranom-v74`

### 2026-07-22 — رفع سورت عددی جداول (موجودی/قیمت با رقم فارسی)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** (pending)
- **خلاصه:** سورت ستون‌های عددی در `tbl-enhance.js` به‌خاطر `fmt()`/`fa-IR` (رقم فارسی) به‌صورت رشته‌ای بود؛ با نرمال‌سازی رقم فارسی/عربی و جداکننده هزارگان، سورت عددی در همه جداول اصلاح شد. SW `v73`.
- **فایل‌های کلیدی:** `server/public/tbl-enhance.js`, `server/public/sw.js`, `server/public/index.html`
- **Deploy:** ⏳
- **SW:** `erp-taranom-v73`

### 2026-07-22 — تصاویر کالا (بهینه/آلبوم)، موجودی بازاریاب، انبار فروشنده
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `c24b9a6`
- **خلاصه:** آپلود تصویر کالا با sharp به WebP بهینه (حداکثر ۱۲۸۰px)؛ پیش‌نمایش و آلبوم چندعکسی برای همه کاربران؛ در فروش بازاریاب کالای بدون موجودی به سبد اضافه نمی‌شود (خطای کسر موجودی)؛ ستون انتخاب انبار در اقلام فاکتور فروشنده‌ها مخفی و کسر فقط از `sales_warehouse_id` کاربر. SW `v71`.
- **فایل‌های کلیدی:** `server/routes/products.js`, `server/routes/invoices.js`, `server/public/index.html`, `server/public/marketer-ui.js`, `server/public/sw.js`
- **Deploy:** ✅ `78a7be5` Iran health 200 — SW `erp-taranom-v71` (sharp:ok)
- **SW:** `erp-taranom-v71`

### 2026-07-22 - فروش بازاریاب، حریم کاربران، انبار مبدأ کارشناس
- **شاخه:** claude/claude-md-docs-2ssrpy
- **Commit:** c43f066
- **خلاصه:** حریم اطلاعات شخص کاربر؛ فیلتر گروه/موجودی و پک در فروش بازاریاب؛ انتقال سبد به اقلام فاکتور؛ مخفی‌سازی فیلدهای پیشرفته فاکتور برای کارشناس میدانی/داخلی؛ انبار مبدأ پیش‌فرض در تعریف کاربر؛ حذف کاتالوگ/فروش بازاریاب از منوی مدیر سیستم و حسابداری
- **فایل‌های کلیدی:** server/public/index.html, server/public/marketer-ui.js, server/routes/parties.js, server/routes/admin.js, server/routes/invoices.js, server/routes/auth.js, server/db.js, server/public/sw.js
- **Deploy:** ✅ 7e6585 Iran health 200 — SW erp-taranom-v69
- **SW:** erp-taranom-v69

### 2026-07-22 - رفع کش فروش بازاریاب (فیلتر/پک/سبد→فاکتور)
- **شاخه:** claude/claude-md-docs-2ssrpy
- **Commit:** 46a3239
- **خلاصه:** علت: SW قدیمی marketer-ui.js را cache-first نگه می‌داشت. network-first برای JS/CSS + ?v=69؛ فیلتر گروه/موجودی و pack_size؛ انتقال قطعی سبد به اقلام فاکتور با __pendingMarketerInvRows
- **فایل‌های کلیدی:** server/public/marketer-ui.js, server/public/sw.js, server/public/index.html
- **Deploy:** ✅ 46a3239 Iran health 200 — SW erp-taranom-v69
- **SW:** erp-taranom-v69

## تاریخچه

### 2026-07-22 — رفع «دسترسی ندارید» فاکتورساز برای کارشناس فروش
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `c087fe6`
- **خلاصه:** GET بانک/صندوق/دسته چک/مرکز هزینه برای همهٔ کاربران لاگین‌شده باز شد؛ لود متای فاکتورساز soft-fail + silent. کارشناس میدانی می‌تواند از فروش بازاریاب فاکتورساز را باز کند. SW `v67`.
- **فایل‌های کلیدی:** `routes/{banks,cash-boxes,check-categories,accounting}.js`, `public/index.html`, `public/sw.js`
- **Deploy:** ✅ ایران `94.249.244.208` — HEAD=`86dfdfb` (شامل `c087fe6`)، `pm2 restart`، health ۲۰۰، SW `v67`
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `04d5d0d`
- **خلاصه:** کارت کالا در فروش بازاریاب همان قالب کاتالوگ؛ افزودن به سبد با `pack_size`؛ منوی کاتالوگ/بازاریاب برای ادمین؛ دکمه سریع «دسترسی کامل فاکتور» در RBAC؛ گیت `invoices.create` روی UI و API. SW `v66`.
- **فایل‌های کلیدی:** `public/marketer-ui.js`, `public/index.html`, `routes/invoices.js`, `public/sw.js`
- **Deploy:** ✅ ایران `94.249.244.208` — HEAD=`b2f55ca` (شامل `04d5d0d`)، `pm2 restart`، health ۲۰۰، SW `v66`

### 2026-07-22 — بازطراحی UI: Soft Bento (نمونه C)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `b7f4b29`
- **خلاصه:** اعمال پوسته Soft Bento با همان پالت زمرد مدرن: سایدبار عمیق‌تر، تاپ‌بار شناور سفید، نوار KPI قهرمان در داشبورد، پنل/دکمه گردتر. SW `v65`.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ✅ ایران `94.249.244.208` — HEAD=`73a4fb1` (شامل `b7f4b29`)، `pm2 restart`، health ۲۰۰، SW `v65`

### 2026-07-22 — پیش‌نمایش ۳ گزینه بازطراحی UI (بدون اعمال)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `48e0661`
- **خلاصه:** سه نمونه HTML بازطراحی مدرن/مینیمال با پالت «زمرد مدرن» برای تأیید کاربر: A Soft Shell، B Ultra Minimal، C Soft Bento. هنوز روی `index.html` اعمال نشده.
- **فایل‌های کلیدی:** `docs/design/redesign-previews/{index,A-soft-shell,B-ultra-minimal,C-soft-bento}.html`
- **Deploy:** ✅ ایران `94.249.244.208` — HEAD=`e38befc`، health ۲۰۰ (docs-only؛ SW بدون تغییر `v64`)
- **یادداشت:** سهمیه رایگان 21st AI تمام بود؛ نمونه‌ها محلی ساخته شد. منتظر انتخاب A/B/C قبل از پیاده‌سازی UI.

### 2026-07-22 — فارسی‌سازی کامل ماتریس دسترسی کاربران
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `5fdebe0`
- **خلاصه:** در تعریف کاربران → «دسترسی‌ها»، نام بخش‌ها (customers/…) و عملیات (view/create/…) به فارسی نمایش داده می‌شود. SW `v64`.
- **فایل‌های کلیدی:** `public/index.html`, `public/sw.js`
- **Deploy:** ✅ ایران `94.249.244.208` — HEAD=`5fdebe0`، `pm2 restart`، health ۲۰۰، SW `v64`

### 2026-07-22 — پیامک رمز موقت پورتال اختیاری
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `a27172b`
- **خلاصه:** چک‌باکس «ارسال رمز موقت با پیامک» در فرم اشخاص (پیش‌فرض خاموش). بدون پیامک رمز اولیه `12345` + تغییر اجباری در اولین ورود. API `send_sms` روی `/portal/access` و ساخت واحد/بخش. SW `v63`.
- **فایل‌های کلیدی:** `lib/portal-users.js`, `routes/portal.js`, `public/index.html`, `public/portal-ui.js`, `public/sw.js`, `scripts/test-portal.js`
- **Deploy:** ✅ ایران `94.249.244.208` — HEAD=`a27172b`، `pm2 restart`، health ۲۰۰، SW `v63`

### 2026-07-22 — فیلتر فروش بازاریاب + محدودیت گروه کالا (is_shared)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `4aaefd1`
- **خلاصه:** فروش بازاریاب همان فیلترهای کاتالوگ (جستجو/گروه/موجودی، بدون انبار). بازگردانی فیلتر `is_shared` برای کاربران عادی در لیست کالا/گروه/بارکد + ACL اختیاری `user_catalog_categories`. ذخیرهٔ واقعی `is_shared` در POST/PUT. SW `v62`.
- **فایل‌های کلیدی:** `lib/product-visibility.js`, `routes/{products,product-categories}.js`, `public/marketer-ui.js`, `public/{index.html,sw.js}`
- **Deploy:** ✅ ایران `94.249.244.208` — HEAD=`4aaefd1`، `pm2 restart`، health ۲۰۰، SW `v62`

### 2026-07-22 — دسترسی پورتال از تنظیمات اشخاص
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `9df765d`
- **خلاصه:** در فرم اطلاعات اشخاص (`partyModal`) و اشخاص (`personModal`) فیلد «دسترسی پورتال عملیاتی» اضافه شد تا نقش مدیر واحد/بخش (یا بدون دسترسی) از همانجا تنظیم شود. API `GET/PUT /api/portal/access` + helper `setPortalAccess`؛ در صورت نیاز ردیف `persons` از روی تلفن ساخته می‌شود؛ رمز موقت فقط با SMS. SW `v61`.
- **فایل‌های کلیدی:** `lib/portal-users.js`, `routes/portal.js`, `public/index.html`, `public/sw.js`
- **Deploy:** ✅ ایران `94.249.244.208` — HEAD=`9df765d`، `pm2 restart`، health ۲۰۰، SW `v61`
- **یادداشت:** نام کاربری ورود = تلفن؛ پس از اعطا، شخص در لیست مسئول واحد/بخش پورتال قابل انتخاب است.

### 2026-07-22 — اجرای کامل update.md (وظایف ۱–۹)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `e256235`
- **خلاصه:** ۱) رفع کش خالی انبار/گروه کالا. ۲) API موجودی وب‌سایت `/api/v1/stock` + webhook/push ووکامرس. ۳) شمارش دقیق گروه اشخاص بدون دوباره‌شماری. ۴) حذف فیلتر انبار از کاتالوگ + ACL گروه کالا per-user. ۵) چندتصویری کالا. ۶) z-index ریسپانسیو (toast/اعلان بالای taskbar). ۷) روبیکا هنگام تأیید فاکتور. ۸) ماژول مستقل پیامک (قالب/گزینه/زمان‌بندی). ۹) گروه بازاریاب + گردش کاتالوگ→سبد→فاکتور. SW `v60`.
- **فایل‌های کلیدی:** `lib/update-md-schema.js`, `lib/website-stock-sync.js`, `lib/rubika.js`, `routes/{api_v1,party-groups,products,accounting,auth,sms-module,settings}.js`, `public/{index.html,marketer-ui.js,sw.js}`, `sync/tables.js`, `server.js`
- **Deploy:** ✅ ایران `94.249.244.208` — HEAD=`e256235`، `pm2 restart`، health ۲۰۰، smoke tables OK، SW `v60`

### 2026-07-22 — رفع باگ نمایش انبارها و گروه‌های کالا در بخش‌های متصل
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** بدون commit
- **خلاصه:** کش master-data با آرایهٔ خالی (`[]`) به‌اشتباه «بارگذاری‌شده» تلقی می‌شد و تا ویرایش دستی دوباره fetch نمی‌شد. علت اصلی گروه‌ها: صفحه کالا/کاتالوگ با `canEdit=false` مقدار `CACHE.productCategories=[]` می‌گذاشت. اصلاح: `ensureWarehouses` / `ensureProductCategories` در همهٔ مسیرهای dropdown، عدم poison با `[]` روی خطا، همیشه بارگذاری گروه‌ها در `productsPage`، invalidate کامل پس از CRUD گروه کالا. SW `v59`.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/portal-ui.js`, `server/public/sw.js`
- **Deploy:** ⏳ نیاز به pull
- **یادداشت:** بدون ویرایش دستی انبار/گروه، dropdownها در فاکتور، خرید، پرتال، ساخت سریع کالا و … باید پر شوند.

### 2026-07-22 — تکمیل شکاف‌های اسپک پورتال کارمندان v2.0
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `b77549d`
- **خلاصه:** رمز موقت تصادفی + SMS هنگام ساخت کاربر مدیر؛ ستون `review_requested_at` و cron ساعتی auto-approve بازبینی (پیش‌فرض ۷۲h)؛ تبدیل با `product_name` → کالای `approval_status=pending` + تأیید ادمین؛ فیلتر کالاهای pending از کاتالوگ فروش؛ رفع انتقال کالا بین بخش‌ها پس از تبدیل؛ تست E2E کامل در `test-portal.js` (۵۵ assertion)؛ Help + SPEC status؛ قانون auto commit/deploy؛ SW v58
- **فایل‌های کلیدی:** `lib/portal-schema.js`, `lib/portal-users.js`, `lib/portal-jobs.js`, `routes/portal.js`, `routes/products.js`, `server.js`, `public/portal-ui.js`, `public/index.html`, `public/sw.js`, `scripts/test-portal.js`, `docs/PORTAL-KARMANDAN-SPEC.md`, `.cursor/rules/auto-commit-deploy.mdc`
- **Deploy:** ✅ ایران `b77549d` — `git pull` + `pm2 restart erp-taranom` (online) · health/root 200 · SW `v58`
- **یادداشت:** `node server/scripts/test-portal.js` سبز (۵۵/۵۵)

### 2026-07-21 — تکمیل UIهای جا مانده (پرتال + تطبیق/بودجه + واگذاری)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `600e98c` (docs `1f1b09c`)
- **خلاصه:** لیست امکانات/وظایف دپارتمان؛ واگذاری موقت مدیر بخش + جدول `op_dept_delegations` (سینک APPEND)؛ اعلان زنگوله برای unit/dept manager؛ SMS اختیاری روی رویداد پرتال؛ ردیف/تطبیق مغایرت بانکی؛ ویرایش ردیف بودجه؛ فیلتر اشخاص/انبار واحد؛ واگذاری چک با select بانک؛ SW v57
- **فایل‌های کلیدی:** `portal-ui.js`, `routes/portal.js`, `portal-schema.js`, `sync/tables.js`, `index.html`, `sw.js`
- **Deploy:** ✅ ایران `1f1b09c` / health 200 / SW v57

---

### 2026-07-21 — UI کامل واحد عملیاتی / دپارتمان / پارامتر پرتال
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `2df35ac`
- **خلاصه:** فرم واحد با مسئول ۱–۳، اشخاص در جریان، نوع خروجی، اتصالات ماژول؛ افزودن/ویرایش/جابجایی دپارتمان؛ پارامتر با انتخاب کالا؛ module_links در API؛ SW v56
- **فایل‌های کلیدی:** `portal-ui.js`, `routes/portal.js`, `sw.js`
- **Deploy:** ✅ ایران health 200 / SW v56

---

- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `37cfaf0`
- **خلاصه:** جایگزینی prompt پورتال با مودال؛ دریافت ارزی با نرخ خودکار و ثبت fx_rate_rial؛ فیلد costing_method روی کالا؛ یکنواخت‌سازی برچسب «کالا»؛ SW v55
- **فایل‌های کلیدی:** `portal-ui.js`, `accounting.js`, `products.js`, `index.html`, `sw.js`
- **Deploy:** ✅ ایران health 200 / SW v55

---

- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `147efa2`
- **خلاصه:** بارگذاری اولیه lazy؛ توضیحات ردیف در چاپ فاکتور؛ تخفیف ٪↔مبلغ دوطرفه (ردیف+کل) و جمع تخفیف ردیف‌ها؛ انبارگردانی ۳ شمارش+تگ؛ دریافت با واریز بانکی؛ دسته هزینه سلسله‌مراتبی؛ سمت/جایگاه؛ پورتال (پرداخت در انتظار حسابداری، هزینه خروجی، امکانات/وظایف) + جداول سینک APPEND؛ نرخ ارز live از tgju
- **فایل‌های کلیدی:** `server/public/index.html`, `sw.js`, `portal-ui.js`, `acc-nav.js`, `routes/invoices.js`, `purchases.js`, `accounting.js`, `portal.js`, `lib/portal-schema.js`, `lib/fx-rate.js`, `sync/tables.js`
- **Deploy:** ✅ ایران `b04a062` / health 200 / SW v54
- **یادداشت:** `SYNCABLE_TABLES` فقط append — جداول `op_dept_*` / `op_parameter_extra_costs` / `op_field_followups` / `expense_categories`

---

## تاریخچه

### ۱۴۰۵/۰۴/۳۰ — [Cursor] UI اقلام فاکتور فروش/خرید (جدول حرفه‌ای)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `ae87c36`
- **خلاصه:** بخش اقلام فاکتور فروش ~۳× بزرگ‌تر با جدول دارای سرستون (کالا/تعداد/فی/تخفیف/انبار/جمع)؛ همان الگو و امکانات هم‌تراز روی فاکتور خرید (تخفیف ردیف، توضیحات، انبار مقصد، فیلدهای چک، بارکد، جمع زنده کرایه). بک‌اند خرید: ذخیره چک + انبار per-row.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/routes/purchases.js`, `docs/CHANGE-LOG.md`
- **Deploy:** ✅ ایران `ae87c36` — PM2 online · root 200

### ۱۴۰۵/۰۴/۳۰ — [Cursor] اجرای کامل شکاف حسابداری + پرتال کارمندان (با سینک)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `e5713fa`
- **خلاصه:** اعمال دو دستور Desktop (`updte hesabdari.md` / `PORTALKARMANDANSPEC.md`) روی کد واقعی با الزام offline-sync:
  - **پرتال:** جداول `op_*` + RBAC نقش‌های `unit_manager`/`department_manager` + `routes/portal.js` (واحد/بخش/پارامتر، قفل ترتیبی، انتقال انبار، پرداخت→سند، تبدیل→production_run) + UI `portal-ui.js` + ساخت خودکار کاربر (`ensurePersonUser` + `must_change_password`).
  - **شکاف حسابداری فاز۱–۴:** فیلدهای مودیان (`moadian_invoice_type`, `tax_stuff_id`)، گزارش VAT فصلی و ماده ۱۶۹، جریان نقد سه‌بخشی، اندوخته قانونی / ذخیره م.م / NRV، مغایرت بانکی، چرخه چک (واگذاری/وصول/برگشت)، استهلاک نزولی + واگذاری دارایی، ذخیره ماهانه سنوات/عیدی، بودجه‌بندی + نسبت‌ها/KPI.
  - **سینک:** جداول جدید فقط به **انتهای** `SYNCABLE_TABLES` + FK_COLUMNS + `capture.js` path map؛ پیکربندی واحد/بخش `centralOnly`.
- **فایل‌های کلیدی:** `lib/portal-schema.js`, `lib/gap-accounting-schema.js`, `routes/portal.js`, `routes/bank-reconciliation.js`, `routes/budgeting.js`, `routes/reserves.js`, `sync/tables.js`, `sync/capture.js`, `coa-map.js`, `rbac.js`, `portal-ui.js`, `acc-nav.js`, `index.html`, `scripts/test-portal.js`, `scripts/test-accounting-gap.js`
- **Deploy:** ✅ ایران `e5713fa` — `git pull` + `pm2 restart erp-taranom` (online) · root HTTP 200 · mount `/api/portal`
- **تست:** `test-portal` 22 · `test-accounting-gap` 18 · `test-update11-schema` · `test-sms` 22 · `test-sync` 33 — همه سبز
- **یادداشت:** ارسال واقعی SDK مودیان هنوز آداپتر stub/قابل‌تعویض است (صف + انواع صورتحساب + فیلدها آماده). بکاپ DB قبل از restart: `server/backups/crm-pre-portal-gap-root.bin`.

### ۱۴۰۵/۰۴/۳۰ — [Cursor] رفع همگام‌سازی اندروید↔سرور ایران (2.0.19)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `246e8a3`
- **خلاصه:** علت اصلی روی اندروید: `network_security_config` فقط IP قدیمی آلمان (`45.90.98.99`) را برای HTTP مجاز می‌کرد و URL پیش‌فرض pairing همان بود — سرور فعلی ایران (`94.249.244.208` / `erp.poshaktaranom.com`) بلاک یا اشتباه بود. همچنین overflow شناسه موقت برای جداول Update 11 (ایندکس ≥100)، `sync_seq_backfill_v2` برای seedهای بی‌seq، و PATH/FK/id نرخ ارز برای capture.
- **فایل‌های کلیدی:** `network_security_config.xml`, `sync/tables.js`, `sync/capture.js`, `db.js`, `fx-rate.js`, `index.html`, `build.gradle`
- **Deploy:** ✅ سرور ایران `43019e4` (PM2 online، health 200) · ⏳ نصب APK محلی ۲.۰.۱۹ روی گوشی

### ۱۴۰۵/۰۴/۳۰ — [Cursor] اندروید 2.0.18 + لغو کامل import محک
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `426733c`
- **خلاصه:**
  - **لغو import محک:** `server/lib/mahak-import.js` فقط stub لغو؛ اسکریپت‌ها/xlsx محک از APK حذف؛ بدون `MAHAK_IMPORT_DIR` روی اندروید.
  - **اندروید ۲.۰.۱۸:** dlopen SQLite از `nativeLibraryDir`، `preloadSqliteNative`، TMPDIR قابل‌نوشتن در dataDir، پچ thirty-two، exclude تست/xlsx، adm-zip برای backup، MDI taskbar spacing، SW v52.
- **فایل‌های کلیدی:** `android/**`, `scripts/build-android.ps1`, `scripts/test-android-apk.ps1`, `server/lib/mahak-import.js`, `manifest.json`, `mdi.js`, `sw.js`
- **Deploy:** ⏳ APK محلی ۲.۰.۱۸ — نصب فقط از فایل محلی

### ۱۴۰۵/۰۴/۳۰ — [Cursor] Update 11 — حسابداری/تولید/انبار + سینک جداول جدید
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `69d2171`
- **خلاصه:** اعمال اسپک Update 11: رفع ناپدید شدن گروه‌های کالا (B1)، جداسازی تب پیش‌فاکتور/فاکتور رسمی (B2)، round3 اعشار، ارز/نرخ (`/api/fx`)، تفصیلی۲ (از UI تا `postToLedger`/`createJournalEntry`)، سمت اشخاص، pricing_rules، فاکتور (توضیحات/تخفیف مبلغی/سرشکن/درآمد)، انبار منفی و costing، انبارگردانی سه‌شمارشی، داشبورد حساب، suggest-child COA، جستجوی omnibox با باز کردن گروه کالا (P5)، سورت/فیلتر عمومی جداول (P4). جداول جدید در انتهای `sync/tables.js`.
- **فایل‌های کلیدی:** `server/lib/update11-schema.js`, `server/lib/round3.js`, `server/lib/fx-rate.js`, `server/lib/ledger.js`, `server/routes/fx.js`, `server/routes/pricing-rules.js`, `server/routes/invoices.js`, `server/routes/product-categories.js`, `server/routes/search.js`, `server/sync/tables.js`, `server/public/index.html`, `server/public/acc-nav.js`, `server/public/tbl-enhance.js`
- **Deploy:** ⏳ نیاز به pull
- **یادداشت:** تسعیر پایان‌دوره (coa_fx_gain/loss) کلید COA آماده است؛ UI تسعیر کامل فاز بعد. قبل از production روی DB زنده بکاپ بگیرید (D1). تست‌ها: `test-update11-schema` + `test-sync` (33) + `test-sms` (22) سبز.

### ۱۴۰۵/۰۴/۳۰ — [Claude Code] 📝 اسپک جامع بهبود حسابداری/تولید/انبار (۲۳ مورد مالک) برای Cursor
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:** بستهٔ ۲۳موردیِ اصلاحات/قابلیت‌های مالک را بهینه، کامل و اصولی کردم (بر مبنای کد واقعی + استانداردهای حسابداری) و در `docs/ACCOUNTING-IMPROVEMENTS-SPEC.md` برای اجرای Cursor گذاشتم. **فقط سند طرح اجرا؛ کدی تغییر نکرد.**
  - **دو باگ با ریشهٔ پیداشده:** (B1) ناپدیدشدن گروه‌های کالا — علت: `addProductGroupVisibility`/فیلتر `is_shared/created_by` اخیرِ Cursor، برای کاربر غیر admin/accounting گروه‌ها را مخفی می‌کند؛ راه‌حل: گروه‌ها را سراسری/برچسب گزارشی کن + backfill `is_shared=1`. (B2) نمایش فاکتور رسمی در فهرست پیش‌فاکتور — رفع فیلتر `type`.
  - **ارتقای مدل داده:** موجودی اعشاری تا ۳ رقم (INTEGER→REAL + parseFloat)، صندوق/بانک ارزی + نرخ ارز مرجع + تسعیر (استاندارد ۱۶)، تفصیلی سطح دو، کدینگ سلسله‌مراتبی قابل‌رهگیری.
  - **کالا/فاکتور/انبار/خزانه:** گروه‌ها به‌عنوان برچسب گزارشی، «سمت/جایگاه» جدید، «محصول جدید»→«کالای جدید»، فیلتر/سورت همهٔ ستون‌ها، توضیح per-ردیف فاکتور، تخفیف مبلغی per-ردیف، سرشکن هزینه (allocation)، افزودن درآمد در فاکتور، موجودی منفی per-انبار، سطح ریالی‌کردن (انبار/کالا)، دریافت = پرداخت، ردیف چک، هزینه با معین/کل، جستجو+داشبورد دفتر کل، سه‌شمارشیِ انبارگردانی + تگ، قیمت‌گذاری خودکار تولید (بها→عمده/تک با فرمول).
  - نقشهٔ راه ۷ فازی + هشدار مهاجرت INTEGER→REAL روی DB زندهٔ محک + کلیدهای coa جدید.
- **فایل‌های کلیدی:** `docs/ACCOUNTING-IMPROVEMENTS-SPEC.md`
- **Deploy:** — (فقط سند).

### ۱۴۰۵/۰۴/۳۰ — [Claude Code] 🤖 اسکیل ساخت/عیب‌یابی APK اندروید برای Cursor (منطبق بر nodejs-mobile واقعی)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:** مالک یک راهنمای ژنریک «ساخت APK با Cursor» (فرض Kotlin/Jetpack Compose/Hilt/Room/Retrofit/Gradle-KTS/multi-module) داد که کاملاً با اندروید این پروژه ناسازگار است. آن را به `docs/skills/android-apk-taranom.md` تبدیل کردم — منطبق بر معماری واقعی. **فقط اسکیل/سند؛ هیچ کدی تغییر نکرد.**
  - توصیه‌های نیتیو خنثی شد: اندروید ترنم **WebView + nodejs-mobile** است (سرور `server/` روی گوشی با `SYNC_ROLE=device`)، `MainActivity.java` + WebView، دیتابیس **better-sqlite3 (NDK)**، **Groovy** Gradle — نه Compose/Kotlin/Room/Hilt.
  - واقعیت‌ها مستند شد: `ir.taranom.crm`، versionCode 15/2.0.13، compileSdk 36/target 34/min 24، ndk 25.1، ABIs arm64/armv7/x86_64، امضا از `keystore.properties` (خارج git).
  - **باگ‌های واقعیِ ثبت‌شده و رفعشان**: BOM در local.properties (WriteAllText بدون BOM)، Duplicate resources از `.gz/.br` (حذف قبل بیلد)، nested 300MB APK (خارج‌کردن APK قبلی)، صفحهٔ سفید بوت (poll ۱۰ دقیقه‌ای)، کرش `process.exit` (2.0.12)، `dlopen` V8/RTLD_GLOBAL better-sqlite3 (2.0.13)، ps1 فقط ASCII، تأیید ELF.
  - سیاست ساخت/توزیع: فقط `scripts/build-android.ps1`؛ APK به `releases/` محلی، **هرگز scp به production**؛ APK در git نه.
- **فایل‌های کلیدی:** `docs/skills/android-apk-taranom.md`
- **Deploy:** — (فقط اسکیل/سند).

### ۱۴۰۵/۰۴/۳۰ — [Claude Code] 🎨 اسکیل طراحی UI برای Cursor (منطبق بر تک‌فایل/RTL/تم پروژه)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:** مالک یک راهنمای ژنریک «prompt طراحی با Cursor» (فرض React/Tailwind/Storybook/Material You) داد. آن را تحلیل و **به یک اسکیل طراحی منطبق بر معماری واقعی پروژه** تبدیل کردم: `docs/skills/ui-design-taranom.md`. **فقط سند/اسکیل است؛ هیچ کدی تغییر نکرد.**
  - توصیه‌های ناسازگار خنثی شد (بدون React/Tailwind/Storybook/CDN فونت — چون اپ **تک‌فایل vanilla، RTL، آفلاین‌فرست** است).
  - **توکن‌های واقعی تم** (زمرد مدرن روشن + شب مخملی تاریک) از `index.html` استخراج و مستند شد تا Cursor رنگ hardcode نکند و از `:root` استفاده کند.
  - الگوهای موجود مستند شد (`.btn`, `.overlay`+`openModal`, جدول `--th-bg/--row-hover`, `.badge` با جفت‌توکن وضعیت, `toast`, `fmt`, `toEnDigits`, `ROUTES`/`acc-nav`/`loadAccTab`) + قواعد RTL/چاپ/دسترس‌پذیری/ریسپانسیو + IIFE-wrap + الزام Help/CHANGE-LOG/تست.
  - قالب بریف ساختاریافته + Chain-of-Thought + حلقهٔ بهبود + نمونهٔ پرامپت آماده (تب مغایرت بانکی) برای Cursor.
- **فایل‌های کلیدی:** `docs/skills/ui-design-taranom.md`
- **Deploy:** — (فقط اسکیل/سند).

### ۱۴۰۵/۰۴/۳۰ — [Claude Code] 📊 تحلیل شکاف حسابداری در برابر ۹ استاندارد حسابداری ایران (سند برای Cursor)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:** برنامه را با ۹ حوزهٔ تخصصی حسابداری ایران (عمومی/مالی/انبار/خزانه/فروش/حقوق/دارایی ثابت/بهای تمام‌شده/بودجه) مطابقت دادم و شکاف‌ها را در `docs/ACCOUNTING-GAP-ANALYSIS.md` برای اجرای Cursor گذاشتم. **فقط سند تحلیل است؛ هیچ کدی تغییر نکرد.**
  - **یافتهٔ کلیدی:** پایهٔ دفترداری دوطرفه، کدینگ محک، ارزیابی موجودی (FIFO/میانگین/ویژه)، بهای تمام‌شدهٔ تولید و پلکان مالیات حقوق **قوی و موجود** است؛ و لایهٔ `coa-map` بیشتر حساب‌های لازم را از قبل دارد.
  - **شکاف‌های اصلی (اولویت‌بندی‌شده):** 🔴 انطباق مالیاتی — سامانه مودیان واقعی + انواع صورتحساب ۱/۲/۳ + شناسهٔ کالا + اظهارنامهٔ فصلی ارزش افزوده + ماده ۱۶۹ (فعلاً moadian فقط mock است)؛ 🟠 صورت‌های مالی — جریان وجوه نقد سه‌بخشی، اندوختهٔ قانونی ۵٪، ذخیرهٔ مطالبات مشکوک‌الوصول، ذخیرهٔ کاهش ارزش موجودی (NRV)؛ 🟠 خزانه — صورت مغایرت بانکی + چرخهٔ کامل چک (در جریان وصول/برگشت)؛ 🟠 دارایی ثابت — استهلاک نزولی + واگذاری/اسقاط + تجدید ارزیابی؛ 🟠 حقوق — ذخیرهٔ ماهانهٔ سنوات/عیدی + مزایای الزامی + ضرایب اضافه‌کاری/شب‌کاری؛ 🟢 ماژول بودجه/گزارش مدیریتی/نسبت‌های مالی (تقریباً غایب).
  - نقشهٔ راه ۴ فازی + کلیدهای coa جدید پیشنهادی (`coa_cheques_in_collection`, `coa_legal_reserve`, `coa_doubtful_debts`, `coa_inventory_writedown`, `coa_revaluation_surplus`) در سند آمده.
- **فایل‌های کلیدی:** `docs/ACCOUNTING-GAP-ANALYSIS.md`
- **Deploy:** — (فقط سند).

### ۱۴۰۵/۰۴/۳۰ — [Claude Code] 📋 اسپکِ منطبق‌شدهٔ «پرتال کارمندان و خط تولید» برای اجرا توسط Cursor
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:** مالک یک اسپک ژنریک ERP (پرتال واحد عملیاتی/خط تولید با گردش‌کار ترتیبی پارامتر بین بخش‌ها، ساخت خودکار کاربر، سند تولید/حسابداری خودکار) داد که فرض‌های ناسازگار با پروژه داشت (UUID، PostgreSQL، Prisma، NestJS/React، WebSocket، جدول کاربر جدا، timestamp ISO). آن را **بازنویسی و منطبق بر معماری واقعی** کردم و در `docs/PORTAL-KARMANDAN-SPEC.md` گذاشتم تا Cursor اجرا کند. **این سند صرفاً طرح اجرا است؛ هیچ کدی از این ماژول هنوز پیاده نشده.**
  - اصلاحیه‌های کلیدی: better-sqlite3 به‌جای PostgreSQL/Prisma؛ INTEGER PK + بازهٔ id دستگاه به‌جای UUID؛ استفادهٔ مجدد از `users`+`must_change_password` به‌جای جدول کاربر جدید؛ ریال صحیح؛ epoch؛ اعلان/SMS به‌جای WebSocket؛ استفادهٔ مجدد از ماژول‌های موجود تولید/انبار(`warehouse_stock`)/حسابداری(`createJournalEntry`+`coa-map`)/followups؛ **افزودن جدول‌های جدید به انتهای `sync/tables.js` (APPEND-ONLY) برای سازگاری آفلاین**؛ resource جدید `'portal'` در RBAC؛ قفل ترتیبی بخش‌ها.
  - مدل داده پیشنهادی: `op_units`, `op_unit_warehouses`, `op_unit_persons`, `op_departments`, `op_parameters`, `op_parameter_items`, `op_parameter_dept_log` (SQL کامل در سند).
  - ترتیب اجرای ۱۱ مرحله‌ای + Edge Caseها + بخش امنیت + الزام تست/Help/CHANGE-LOG برای Cursor در سند آمده.
- **فایل‌های کلیدی:** `docs/PORTAL-KARMANDAN-SPEC.md`
- **Deploy:** — (فقط سند؛ بدون تغییر کد/رفتار).

### ۱۴۰۵/۰۴/۳۰ — [Cursor] ریبرند محصول به ERP ترنم (erp-taranom)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `8563ec8`
- **خلاصه:** نام نمایشی/پکیج/PM2 از CRM ترنم به **ERP ترنم / erp-taranom**؛ دامنه `erp.poshaktaranom.com`؛ مسیر دیسک و keystore عمداً `crm-taranom` ماند.
- **فایل‌های کلیدی:** `server/public/{index.html,manifest.json,sw.js}`, `server/ecosystem.config.js`, `server/package.json`, `desktop/*`, `android/*/strings.xml`, `docs/*`, `scripts/release.ps1`
- **Deploy:** ✅ ایران — PM2 `erp-taranom`، عنوان و PWA تأیید شد
- **یادداشت:** پوشه `/home/taranom/crm-taranom` و `crm-taranom.jks` عمداً تغییر نکرد.

### ۱۴۰۵/۰۴/۳۰ — [Cursor] رفع dlopen better-sqlite3 — اندروید 2.0.13
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** بدون commit
- **خلاصه:**
  - **باگ 2.0.12:** `dlopen failed: cannot locate symbol "_ZN2v811HandleScopeC1EPNS_7IsolateE"` هنگام لود `better-sqlite3`.
  - **ریشه:** اندروید `libnode` را `RTLD_LOCAL` بار می‌کند؛ بدون `DT_NEEDED=libnode` نماد V8 دیده نمی‌شود. JNI داخل APK هم قدیمی‌تر از prebuilt بود.
  - **رفع:** `promoteNodeSymbols()` / `dlopen(libnode, RTLD_GLOBAL)`؛ همگام‌سازی jni؛ لینک صریح در اسکریپت بیلد؛ نسخه **۲.۰.۱۳**.
- **فایل‌های کلیدی:** `native-lib.cpp`, `MainActivity.java`, `main.js`, `build.gradle`, `scripts/build-better-sqlite3-android.ps1`
- **Deploy:** ⏳ APK محلی

### ۱۴۰۵/۰۴/۳۰ — [Cursor] ابزار تست ادمین + کالاها + مالکیت مشتری
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `3821d1b`
- **خلاصه:**
  - پاک‌سازی دیتای تست به تفکیک بخش (تراکنش / کامل) با تأیید WIPE-* + رمز — فقط admin مرکزی
  - کالاها در حسابداری: layout شبیه اشخاص (گروه راست، جدول چپ) + انتخاب/حذف گروهی
  - ERP محصولات فقط مشاهده؛ CRUD فقط از حسابداری (`adminOrAccounting`)
  - مالکیت مشتری با `created_by`؛ کارشناس تخصیص‌یافته فقط مشاهده (+ پیگیری/فاکتور)؛ مانده فقط admin
  - نمایش ماهیت و مانده زنده در لیست/مودال ERP مشتریان؛ sync `account_nature` از parties
- **فایل‌های کلیدی:** `server/routes/data-wipe.js`, `server/server.js`, `server/db.js`, `server/routes/customers.js`, `server/routes/parties.js`, `server/routes/products.js`, `server/lib/parties-sync.js`, `server/public/index.html`, `docs/CHANGE-LOG.md`
- **Deploy:** ✅ SCP روی ایران + Cloudflare برای `erp.poshaktaranom.com`
- **یادداشت:** پس از بوت، `created_by` برای رکوردهای قدیمی از `user_id` پر می‌شود.

### ۱۴۰۵/۰۴/۲۹ — [Cursor] یکپارچه‌سازی مویرگی واحد پول ریال
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** بدون commit
- **خلاصه:** حذف ناسازگاری تومان/ریال در کل CRM — UI و ذخیره همیشه ریال؛ `postToLedger` همچنان تومان می‌گیرد (`rial/10` / `rialToLedger`). رفع `/10`های فرانت (وصول، هزینه، حقوق، کرایه، پرداخت تأمین‌کننده)، اصلاح `*_rial` فاکتور/خرید، JE انتقال/مشوق/سند دستی/نماینده، گزارش‌های دفترکل/تراز/تولید روی `debit_rial` (بدون `debit*10`)، بک‌فیل `journal_rial_backfill_v1`، برچسب‌ها و اعلان‌ها ریال، SW `v49`.
- **فایل‌های کلیدی:** `lib/money.js`, `db.js`, `routes/invoices.js`, `purchases.js`, `accounting.js`, `expenses.js`, `transfers.js`, `payroll.js`, `rep-management.js`, `lib/production/{close,engine,reports,health-check}.js`, `public/index.html`, `prod-ui.js`, `sw.js`
- **Deploy:** ⏳ نیاز به pull روی ایران
- **یادداشت:** اسناد قدیمی که با FE `/10` بعد از migration ثبت شده‌اند ممکن است مقیاس نادرست داشته باشند — در صورت نیاز اسکریپت تطبیق جداگانه.

### ۱۴۰۵/۰۴/۲۹ — [Cursor] رفع بسته شدن ناگهانی بوت اندروید 2.0.12
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** بدون commit
- **خلاصه:**
  - پس از splash «راه‌اندازی سرور داخلی» اپ فوراً بسته می‌شد.
  - **علت:** `process.exit()` در bootstrap اندروید کل پروسه را می‌کشد؛ SQLite فقط از assets لود می‌شد.
  - **رفع:** مسدود کردن `process.exit`؛ `server.fail` + نمایش خطا؛ `libbetter_sqlite3.so` در jniLibs؛ preload STL/SQLite؛ نسخه **۲.۰.۱۲**.
- **فایل‌های کلیدی:** `main.js`, `MainActivity.java`, `android/app/build.gradle`, `scripts/test-android-apk.ps1`
- **Deploy:** ⏳ APK محلی — حذف نسخه قبلی و نصب ۲.۰.۱۲

### ۱۴۰۵/۰۴/۲۹ — [Cursor] حذف/ابطال گروهی با انتخاب سطر در لیست‌ها
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `c264da4` (+ `be64a0d` changelog)
- **خلاصه:** با انتخاب یک یا چند سطر، نوار «حذف/ابطال انتخاب‌شده‌ها» ظاهر می‌شود؛ استنباط از `data-bulk-delete` یا دکمه قرمز ردیف؛ پوشش فاکتور CRM، اشخاص، خرید، بانک، صندوق، انبار، برگشت‌ها و جداول حسابداری مشابه.
- **فایل‌های کلیدی:** `server/public/tbl-enhance.js`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ✅ ایران `94.249.244.208` — HEAD=`be64a0d`، bundle + pm2، health ۲۰۰، SW `v48`

### ۱۴۰۵/۰۴/۲۹ — [Cursor] رد تکراری اکسل + تنظیم MDI در تنظیمات
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `c3a1c73`
- **خلاصه:** ورود اکسل اشخاص/کالا/کدینگ تکراری‌ها را رد می‌کند و تعداد را اعلام می‌کند؛ API هم ۴۰۹ برای تکراری می‌دهد. فعال/غیرفعال پنجره چندگانه در تنظیمات سیستم.
- **فایل‌های کلیدی:** `server/routes/excel.js`, `parties.js`, `products.js`, `server/public/index.html`, `sw.js`
- **Deploy:** ✅ ایران `94.249.244.208` — HEAD=`c3a1c73`، bundle + pm2، health ۲۰۰، SW `v47`

### ۱۴۰۵/۰۴/۲۹ — [Cursor] رفع اکسل ریال، جستجو، حذف کالا، MDI، سورت/فیلتر، ابطال اسناد
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `e89ebc6` (+ `b017e88` changelog، + SW `v46`)
- **خلاصه:**
  - اکسل کالاها دیگر `/10` نمی‌کند؛ اشخاص سقف اعتبار را به‌صورت ریال نمایش/ذخیره می‌کنند؛ ردیف‌های خالی فیلتر و گزارش موفق/ناموفق واضح‌تر شد.
  - حذف کالا پس از ورود اکسل با پاک‌سازی `warehouse_stock`/`stock_logs` و جلوگیری از حذف در صورت استفاده در فاکتور.
  - جستجوی اشخاص: `oninput`+debounce، `limit=200`، نرمال‌سازی ی/ک؛ F10 فوکوس جستجو.
  - برگشت از خرید: موجودی قابل‌برگشت دیگر ابطال‌شده‌ها را نمی‌شمارد؛ لیست سفارشات CRUD؛ فاکتور فروش حسابداری ویرایش/ابطال با دسترسی.
  - جداول: سورت کلیک روی عنوان، فیلتر راست‌کلیک، انتخاب چندتایی؛ پنجره‌های MDI شبیه ویندوز برای زیرمنوهای حسابداری (`mdi.js`).
- **فایل‌های کلیدی:** `server/routes/excel.js`, `products.js`, `parties.js`, `purchases.js`, `accounting.js`, `server/public/index.html`, `mdi.js`, `tbl-enhance.js`, `sw.js`
- **Deploy:** ✅ ایران `94.249.244.208` — HEAD=`c42a4d2`، bundle + `pm2 restart`، health ۲۰۰، SW `v46`، `mdi.js`/`tbl-enhance.js` تأیید شد
- **یادداشت:** حالت پنجره با دکمه نوار پایین خاموش می‌شود (`localStorage crm_mdi=0`).

### ۱۴۰۵/۰۴/۲۹ — [Cursor] رفع کرش فوری اندروید 2.0.10 — سازگاری صفحه ۱۶KB (سامسونگ)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** بدون commit
- **خلاصه:**
  - **ریشهٔ کرش:** روی دستگاه‌های اندروید ۱۵+ با صفحه حافظه ۱۶KB (مخصوصاً سامسونگ)، `libnode.so` / `libnative-lib.so` / `better_sqlite3` با ELF Align=`0x1000` (۴KB) در `dlopen` می‌ترکند → دیالوگ Device Care «Something went wrong / this app has a bug».
  - **رفع فوری:** `android:pageSizeCompat="enabled"` در Manifest (حالت سازگاری سیستم).
  - **سخت‌سازی:** `System.loadLibrary` از static initializer به `onCreate` با catch منتقل شد تا به‌جای دیالوگ سیستم، صفحهٔ خطای داخل اپ نشان داده شود؛ لینکر `native-lib` با `-Wl,-z,max-page-size=16384`؛ نسخه **۲.۰.۱۰** / versionCode **۱۲**.
  - **یادداشت بلندمدت:** پیش‌ساختهٔ nodejs-mobile هنوز ۴KB است — بازسازی `libnode` با NDK r28+ در آینده لازم است.
- **فایل‌های کلیدی:** `AndroidManifest.xml`, `MainActivity.java`, `CMakeLists.txt`, `main.js`, `android/app/build.gradle`, `manifest.json`, `scripts/test-android-apk.ps1`
- **Deploy:** ⏳ APK محلی — sideload؛ سرور APK سرو نمی‌کند
- **یادداشت نصب:** نسخه قبلی را حذف کنید و `erp-taranom.apk` نسخه ۲.۰.۱۰ را تازه نصب کنید.

### ۱۴۰۵/۰۴/۲۹ — [Cursor] اکسل مینیمال، دید گروه کالا، کاربر=شخص، یکپارچه‌سازی حسابداری
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `e393e2d`
- **خلاصه:** دکمه‌های اکسل مینیمال (ورودی/قالب/خروجی)؛ قرارداد کامل ۲۰ entity اکسل؛ کنترل `is_shared` برای گروه کالا؛ اتصال کاربر به `parties`؛ تمام عملیات مالی تجاری از `postToLedger` با ابطال R12؛ اصلاح تبدیل ریال/تومان در UI.
- **فایل‌های کلیدی:** `server/routes/excel.js`, `server/lib/user-party.js`, `server/routes/accounting.js`, `server/routes/invoices.js`, `server/routes/purchases.js`, `server/public/index.html`, `server/public/sw.js`, `server/scripts/test-excel-user-integration.js`
- **Deploy:** ⏳ نیاز به pull روی ایران
- **یادداشت:** `test:excel-user-integration`، `test:payroll-accounting`، `test:inventory` سبز؛ SW به `v45`.

### ۱۴۰۵/۰۴/۲۸ — [Cursor] یکپارچه‌سازی حقوق و گزارشات مالی ایران
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `14d2d4b`
- **خلاصه:** پرونده کارکنان روی جدول اشخاص موجود ادغام شد؛ دوره، ساختار حقوق، پلکان ماده ۸۴، پردازش ماهانه/روزانه/ساعتی، بیمه ۷٪ و ۲۳٪ پیکربندی‌پذیر، عیدی و سنوات، اسناد خودکار و ابطال معکوس اضافه شد. کدینگ و اسناد موجود توسعه یافتند و VAT، گزارش پویا و بهای صنعتی بدون ایجاد مدل موازی به گزارشات پیشرفته متصل شدند.
- **فایل‌های کلیدی:** `server/lib/payroll/`, `server/routes/payroll.js`, `server/lib/accounting/reporting-schema.js`, `server/routes/adv-reports.js`, `server/public/acc-nav.js`, `server/public/index.html`
- **Deploy:** ✅ ایران `94.249.244.208` — HEAD=`14d2d4b`، pm2 restart، health ۲۰۰، SW `v44`
- **یادداشت:** تمام پول‌های جدید `INTEGER` ریال است؛ نرخ‌های قانونی سالانه در داده ذخیره می‌شوند. `test:payroll-accounting`، کل `test:production` و `test:inventory` سبز هستند.

### ۱۴۰۵/۰۴/۲۸ — [Cursor] ورود، خروجی و قالب اکسل یکپارچه
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `8ce2260`
- **خلاصه:** سه گزینه مستقل «ورود از طریق اکسل»، «قالب فایل ورودی» و «خروجی اکسل» برای اطلاعات اشخاص، کالاها، چک‌های اول دوره، دریافت و پرداخت، هزینه‌ها، سطوح کدینگ، فاکتورها و برگشت‌ها، سه عملیات مستقل انبار، دو جهت کالای امانی و فهرست اسناد اضافه شد. مبالغ فایل‌ها فقط ریال هستند و ثبت اسناد از API رسمی هر ماژول انجام می‌شود.
- **فایل‌های کلیدی:** `server/routes/excel.js`, `server/server.js`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ✅ ایران `94.249.244.208` — HEAD=`8ce2260`، pm2 restart، health ۲۰۰، SW `v43`
- **یادداشت:** ۲۰ قرارداد مستقل، ۴۰ دانلود قالب/خروجی، ۲۰ اعتبارسنجی فایل و ثبت end-to-end تعداد ۲۱ عملیات رسمی روی دیتابیس ایزوله آزمایش شد؛ SW به `v43` افزایش یافت.

### ۱۴۰۵/۰۴/۲۷ — [Cursor] نمایندگان فروش + قوانین یکپارچه (ریال / جداکننده / آیکون / AI)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `f509621`
- **Deploy:** ✅ ایران `94.249.244.208` — HEAD=`f509621`، pm2 restart، health ۲۰۰، SW `v42`

### ۱۴۰۵/۰۴/۲۷ — [Cursor] تکمیل UI عملیات تولید (BOM + سفارش + رفع نقص‌ها)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `e25bfcb` (+ `87ea258` changelog)
- **خلاصه:**
  - **BOM:** ایجاد پیش‌نویس، ویرایش اقلام، فعال‌سازی با `valid_from`، حذف پیش‌نویس، نسخه جدید، هشدار کالاهای بدون BOM.
  - **سفارش:** انتخاب BOM/انبار/مرکز هزینه؛ لغو draft/released؛ رسید جزئی/نهایی با مقدار باقیمانده؛ حذف دستمزد hard-code؛ ابطال فقط completed + بازگشایی closed.
  - **نرخ سربار:** محرک‌های صحیح (`direct_labor_rial` و …)؛ ویرایش ردیف؛ نمایش دستمزد ماهانه.
  - **مرحله‌ای:** الگوی حواله مواد مرحله؛ خروجی با پیش‌فرض qty_in؛ پیمانکار با dropdown؛ کارمزد خالی = از BOM؛ skip مرحله.
  - **بستن دوره:** بدون open خودکار هنگام باز شدن صفحه؛ دکمه بازگشایی؛ پیش‌بررسی اختیاری.
  - API: `GET .../stages/:id/issue-template`؛ fallback دستمزد از `monthly_labor_rate_rial`.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/sw.js`, `server/lib/production/labor.js`, `server/lib/production/engine-advanced.js`, `server/routes/production-execution.js`, `docs/CHANGE-LOG.md`
- **Deploy:** ✅ ایران `94.249.244.208` — HEAD=`87ea258`، pm2 restart، health ۲۰۰، SW `v41`

### ۱۴۰۵/۰۴/۲۷ — [Cursor] ماژول انبار سازمانی (ledger / batch / reservation / landed cost)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `a0bc2f8`
- **خلاصه:**
  - لایهٔ `server/lib/inventory/*` + API `/api/inventory` + منوی «عملیات انبار» (بچ/سریال، رزرو، landed cost، کاردکس، رسید/حواله).
  - انبارگردانی و عملیات انبار به ledger جدید وصل شد؛ جداول sync APPEND-ONLY.
  - تست دود: `node scripts/test-inventory-smoke.js` → **۲۴/۲۴**.
  - هم‌ترازسازی قبلی لوکال تا `7947c11` + اسکریپت‌های محک نگه داشته شد.
- **فایل‌های کلیدی:** `server/lib/inventory/*`, `server/routes/inventory.js`, `server/routes/warehouses.js`, `server/public/acc-nav.js`, `server/public/index.html`, `server/sync/tables.js`
- **Deploy:** ✅ ایران `94.249.244.208` — HEAD=`e7c8ede`، pm2 restart، health ۲۰۰، `lib/inventory/schema.js` + SW `v40`

### ۱۴۰۵/۰۴/۲۶ — [Cursor] pm2 restart production برای اعمال تغییرات UI
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `d7bee5e` (docs) — کد از قبل روی سرور در `7947c11` بود
- **خلاصه:** به درخواست مالک، روی سرور ایران `pm2 restart erp-taranom --update-env` اجرا شد. health `/api/system/time` سبز، فرآیند online. مارکرهای کلیدی در فایل مستقر تأیید شد: `seedQty`، `cheque_row`، «ثبت چک بعدی»، `z-index:3000` برای دیت‌پیکر.
- **فایل‌های کلیدی:** `docs/CHANGE-LOG.md`
- **Deploy:** ✅ restart انجام شد

### ۱۴۰۵/۰۴/۲۷ — [Cursor] هم‌ترازسازی لوکال + deploy bundle ایران تا `7947c11`
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `7947c11` (fast-forward لوکال از `13dbcaf`)
- **خلاصه:**
  - workspace لوکال از `13dbcaf` به `7947c11` هم‌تراز شد؛ UI چک (`stlSyncChequesFromDom` / `oninput` / SW `v39`) روی دیسک محلی تأیید شد.
  - سرور ایران با **git bundle** از `ae016a3` → `7947c11` + `pm2 restart`؛ health ۲۰۰.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/sw.js`, `docs/CHANGE-LOG.md`
- **Deploy:** ✅ ایران `94.249.244.208` — HEAD=`7947c11`

### ۱۴۰۵/۰۴/۲۷ — [Claude Code] 🐞 رفع باگ واقعی ناهماهنگی موجودی انبار (products.stock ⇄ warehouse_stock) + بازبینی کامل پروژه
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:**
  - **باگ اصلی (رفع شد):** مسیر ساخت محصول `POST /api/products` هنگام ثبت محصول با موجودی اولیه، **هیچ ردیف `warehouse_stock` نمی‌ساخت** (برخلاف `PUT` که می‌ساخت). چون کسر موجودی فاکتور رسمی از `warehouse_stock` می‌خوانَد، اولین فاکتور ردیف را با qty=0 می‌ساخت و از صفر کم می‌کرد → `warehouse_stock=0` در حالی که `products.stock` مقدار واقعی را نشان می‌داد → **همهٔ فروش‌های بعدی از آن انبار با پیام «موجودی انبار کافی نیست (موجود: ۰)» رد می‌شد.** حالا هنگام ساخت، موجودی اولیه در انبار پیش‌فرض seed می‌شود.
  - **باگ هم‌خانواده (رفع شد):** `PATCH /products/:id/stock` فقط `products.stock` را عوض می‌کرد؛ حالا همان دلتا روی `warehouse_stock` انبارِ محصول هم اعمال می‌شود تا از هم جدا نیفتند.
  - مسیرهای درست (بدون تغییر، بررسی و تأیید شد): ابطال فاکتور، انبارگردانی، خرید، انتقال انبار — هر دو جدول را هماهنگ نگه می‌دارند.
  - **بررسی کامل پروژه:** `node --check` روی همهٔ فایل‌های بک‌اند سبز؛ boot + login سالم؛ `npm audit` → xlsx@0.18.5 دو آسیب‌پذیری high بدون patch رسمی (prototype pollution + ReDoS) و node-cron@3 وابسته به uuid آسیب‌پذیر (moderate) — گزارش به مالک، رفع نیازمند تصمیم (breaking). `mssql` فقط در `lib/mahak-import.js` به‌صورت lazy/optional استفاده می‌شود.
  - **باقی‌مانده برای بررسی بعدی (drift احتمالی موجودی، فرکانس پایین‌تر):** `orders.js:maybeDeductStock` (سفارش done)، `consignments.js`، `production.js`، `accounting.js` تعدیل موجودی — هرکدام `products.stock` را جدا از `warehouse_stock` تغییر می‌دهند؛ نیاز به ممیزی موردی دارند.
  - **تست:** sync **۳۳/۳۳**، SMS **۲۲/۲۲**، کل `npm run test:production` **۱۸ اسکریپت سبز (EXIT=0)**. سناریوی ۷ sync (oversell) که قبلاً به‌خاطر همین drift می‌شکست، اکنون درست تعارض را نشان می‌دهد.
  - نکتهٔ هماهنگی: اصلاح staleٔ تست sync برای VAT را Cursor در `e488a30` با تطبیق روی `subtotal` (مستقل از VAT) انجام داده بود؛ تغییر موازی من revert شد تا پوشش VAT+sync حفظ شود.
  - Help در این تغییر نیاز به به‌روزرسانی ندارد (رفع باگ داخلی، بدون سطح کاربری جدید).
- **فایل‌های کلیدی:** `server/routes/products.js`
- **Deploy:** ✅ با `pm2 restart` / bundle روی `7947c11` اعمال شد.

### ۱۴۰۵/۰۴/۲۶ — [Cursor] بستهٔ اصلاحات UI حسابداری (instructions_7685): چک، محصول، جستجو، z-index
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `81a96fd` (بک‌اند) + `869e9bd` (فرانت‌اند)
- **خلاصه:**
  - **رفع سراسری z-index (۲.۳ و باگ ۱.۱):** تقویم جلالی (`.dp`/`.dp-overlay`) و توست‌ها زیر مودال (۱۱۰۰) رندر می‌شدند؛ به بالای مودال منتقل شدند (dp=3000، toasts=3200). تأییدشده با تست GUI: تقویم حالا **روی** مودال باز می‌شود.
  - **۱.۱ تاریخ تولد:** فیلد `تاریخ تولد` از قبل در فرم اشخاص بود؛ بازهٔ سال دیت‌پیکر از ۱۳۰۰ تا امروز است (تأییدشده). نکته: فرم شخص جدید نیاز دارد اول یک «گروه اشخاص» انتخاب شود (دکمه تا آن زمان disabled است).
  - **۱.۱ گروه اشخاص:** آیتم «گروه‌های اشخاص» به منوی «اطلاعات پایه» اضافه شد تا ویرایش/حذف در دسترس باشد (backend DELETE با محافظت «در حال استفاده» از قبل بود).
  - **۱.۲ محصول:** دکمهٔ «➕ محصول جدید» به view کالاهای حسابداری اضافه شد؛ کد محصول در صورت خالی بودن خودکار (`K-00001`) و کد تفصیلی حسابداری خودکار (`allocTafsili`).
  - **۱.۳ پرداخت هزینه:** دکمهٔ inline «➕ دستهٔ جدید» در مودال هزینه + گسترش دسته‌های پیش‌فرض (idempotent). picker حساب هزینه از قبل z-index 9999 داشت.
  - **۱.۳ ثبت چک:** گزینهٔ «چند چک در یک سند» با جریان **«➕ ثبت چک بعدی»** جایگزین شد: هر چک یک کارت با همهٔ فیلدها (نام بانک، شماره حساب، شعبه، شبا، شماره چک، شناسه صیاد، مبلغ، سررسید، صادرکننده، توضیحات) + **شمارهٔ ردیف خودکار**. ستون `settlements.cheque_row` اضافه و در `settlements/batch` ذخیره می‌شود.
  - **۲.۲ جستجوی پیشرفته (Ctrl+K):** به‌جای ۱۳ صفحهٔ ثابت، حالا **همهٔ بخش‌ها/زیرمنوها** (منوی اصلی + کل زیرماژول‌های `ACC_NAV_SECTIONS`) ایندکس و مستقیماً قابل ناوبری‌اند (ورود خودکار به پوستهٔ حسابداری برای آیتم‌های `acc-*`).
  - **۲.۱ کدهای خودکار:** محصول (K-00001)، شخص (P-00001، از قبل)، گروه اشخاص (MAX+1، از قبل)، و کدهای کل/معین/تفصیلی (`allocTafsili`) همگی خودکار.
  - راهنمای داخل برنامه (بخش «قابلیت‌های جدید») + SW به `v38`.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/acc-nav.js`, `server/public/sw.js`, `server/db.js`, `server/routes/accounting.js`, `server/routes/products.js`
- **وضعیت تست:** SMS 22/22، Sync 33/33، تست تولید ۴۲۷ سبز، پارس فرانت سالم. GUI: رفع z-index تقویم و بازهٔ ۱۳۰۰ **تأیید بصری شد**؛ backend ثبت چند چک با `cheque_row` و همهٔ فیلدها **با curl تأیید شد** (۲ چک، installment_group مشترک). دموی کامل ذخیرهٔ چک از مسیر GUI به‌خاطر دشواری computerUse در پرکردن فیلد نام بانک ردیف دوم و انتخاب مشتری (کش قدیمی، رفع با reload) به‌طور کامل ضبط نشد — منطق درست است.
- **Deploy:** ✅ روی production ایران (`94.249.244.208`) — HEAD `7947c11`، bundle + `pm2 restart`، health ۲۰۰.

### ۱۴۰۵/۰۴/۲۶ — [Cursor] تأیید سلامت شاخه + رفع باگ divergence موجودی انبار (سبزسازی مجدد test-sync)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** این جلسه (سه کامیت: fix invoices، test-sync، docs)
- **خلاصه:**
  - **اجرای کامل تست‌ها روی این شاخه:** `test-sms` **۲۲/۲۲**، `test-sync` **۳۳/۳۳**، مجموعهٔ کامل تولید **۱۸ suite / ۴۲۷ assertion سبز** (`npm run test:production`)، چک نحوی همهٔ فایل‌های بک‌اند، و پارس اسکریپت‌های فرانت (`index.html` inline + `prod-ui.js` + `acc-nav.js` + `sw.js`).
  - **🐞 باگ واقعی کشف و رفع‌شده در `deductStock` (`routes/invoices.js`):** مسیر بررسی موجودی، نبودِ ردیف `warehouse_stock` را «کل `products.stock` روی انبار خانگی محصول» فرض می‌کرد، ولی مسیر کسر، ردیف را با `qty=0` می‌ساخت و کسر را به صفر clamp می‌کرد → **اولین فروش هر محصولی که هنوز ردیف `warehouse_stock` نداشت، موجودی انبارش را به‌اشتباه صفر می‌کرد** در حالی که `products.stock` مثبت می‌ماند. نتیجه: فروش‌های بعدی همان کالا با «موجودی انبار کافی نیست (موجود: 0)» رد می‌شدند. رفع: ردیف جدید با همان مقدار fallback مسیر خواندن (`prod.stock` اگر انبار خانگی باشد) مقداردهی می‌شود، سپس کسر انجام می‌گیرد. بدون رگرسیون برای محصولاتی که ردیف انبار واقعی دارند (ON CONFLICT DO NOTHING).
  - **رفع تست کهنه (`scripts/test-sync.js`):** از فاز ۳ حسابداری، فیلد `final` فاکتور شامل VAT پیش‌فرض است؛ سناریو ۳ به‌جای `final === 250000` حالا بر اساس `subtotal === 250000` (مستقل از VAT) فاکتور را می‌یابد. این تنها یک اصلاح انتظار تست است، نه تغییر رفتار.
- **فایل‌های کلیدی:** `server/routes/invoices.js`, `server/scripts/test-sync.js`, `docs/CHANGE-LOG.md`
- **Deploy:** ✅ روی production ایران (`94.249.244.208`) — HEAD الان `ae016a3`، `pm2 restart` انجام شد، health ۲۰۰، رفع `seedQty` در فایل مستقر تأیید شد.
- **⚠️ یادداشت مهم ops (سرور به GitHub دسترسی ندارد):** روی سرور ایران، DNS نام `github.com` را resolve نمی‌کند (فیلترینگ)، پس `scripts/deploy-production.sh` روی مرحلهٔ `git pull` شکست می‌خورد. راه‌حل استفاده‌شده: انتقال کامیت‌ها با **git bundle** از محیطی که به GitHub دسترسی دارد → `git bundle create up.bundle <base>..HEAD` سپس `scp` به سرور و `git pull /tmp/up.bundle <branch>` (fast-forward)، بعد `pm2 restart erp-taranom --update-env`. چون این تغییرات وابستگی جدید نداشتند، `npm install` لازم نبود. برای رفع ریشه‌ای: DNS/پروکسی سرور برای github تنظیم شود.
- **یادداشت:** تغییر یک رفع صحت است نه قابلیت جدید، پس بخش راهنمای داخل برنامه نیاز به افزودن ندارد.

### ۱۴۰۵/۰۴/۲۶ — [Cursor] همگام‌سازی CHANGE-LOG با کد شاخه (بازسازی ورودی‌های جامانده)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین commit (فقط مستندات)
- **خلاصه:** لاگ تغییرات با HEAD شاخه (`13dbcaf`) از عقب‌ماندگی درآمد. ۱۳ کامیت ثبت‌نشده (از `9e183e0` تا `13dbcaf` — شامل ماژول کامل بهای تمام‌شدهٔ تولید، UI تولید، راه‌اندازی VPS ایران، جریان‌های فروش/خرید ایرانی، و اصلاحات UI حسابداری crm.docx) شناسایی و ورودی تاریخچه‌شان بازسازی شد. جدول «وضعیت فعلی» هم به‌روز شد (آخرین commit، SW `v37`، سرور تنها ایران).
- **فایل‌های کلیدی:** `docs/CHANGE-LOG.md`
- **Deploy:** ❌ لازم نیست (فقط مستندات)

> **یادداشت هماهنگی (ثبت‌شده ۱۴۰۵/۰۴/۲۶):** ورودی‌های زیر برای کامیت‌هایی بازسازی شدند که کد آن‌ها در شاخه بود ولی ورودی تاریخچه نداشتند (از `9e183e0` تا `13dbcaf`). خلاصه‌ها از پیام کامیت و آمار فایل‌ها استخراج شده‌اند. وضعیت deploy از این محیط (Cloud Agent، بدون SSH به سرور) قابل تأیید نبود و با ⏳ (نیاز به تأیید روی سرور) علامت خورده مگر جایی که خلاف آن مستند است.

### ۱۴۰۵/۰۴/۲۶ — [Cursor] اصلاحات UI حسابداری (طبق crm.docx): اشخاص، دریافت‌ها، انبار، اسناد
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `13dbcaf`
- **خلاصه:**
  - ساخت خودکار حساب CoA روی اشخاص/محصولات (`parties`/`products`) + همگام‌سازی `parties-sync`.
  - **۴ نوع دریافت/پرداخت** + رسیدهای چند-چکی (multi-check).
  - انبار **به‌ازای هر سطر فاکتور** + اسناد انبار چند-سطری؛ دسته‌بندی هزینه‌ها.
  - پاک‌سازی ناوبری (`acc-nav.js`) + انتخابگر/UX سند (voucher picker).
  - اسکریپت کمکی یک‌بارمصرف `scripts/_patch_crm_docx_ui.py` برای اعمال تغییرات UI؛ SW bump.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/acc-nav.js`, `server/routes/{accounting,expenses,invoices,parties,products,warehouses}.js`, `server/lib/{coa-map,parties-sync}.js`, `server/db.js`
- **Deploy:** ⏳ نیاز به تأیید روی سرور

### ۱۴۰۵/۰۴/۲۶ — [Cursor] ماژول کامل بهای تمام‌شدهٔ تولید (P0–P10) + UI + تست‌ها
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `6e2ff80` (پایه) · `0275b8b` · `e2d7c86` · `e49e01b` · `8d41c9d` · `a537a15` · `868a583`
- **خلاصه:**
  - **`6e2ff80` — پایهٔ ماژول تولید:** BOM، بهای تمام‌شدهٔ ثابت/متغیر، اجرای چندمرحله‌ای، MRP، بستن دوره با تسهیم ADR-005، گزارش‌ها با داشبورد Chart.js و برگهٔ بهای تمام‌شدهٔ A4، حذف بهای تمام‌شده در RBAC (cost stripping)، workflow CI، و cron سلامت شبانه. مستندات کامل در `docs/Production/*` (۲۰ سند). **`server/sync/tables.js` فقط append شد** (جدول‌های جدید تولید).
  - **`0275b8b`:** بررسی‌گر آمادگی go-live هفتهٔ اول (مراکز هزینه، انبارها، تنظیمات CoA، شکاف BOM/نرخ‌ها) با `--fix` اختیاری.
  - **`e2d7c86`:** تکمیل صفحات UI طبق `ui.md` — سیستم طراحی `prod-ui`، تب‌های برآورد/کانبان/انحراف/MRP/نرخ‌ها، جریان‌های مرحله/حواله سفارش، اکشن‌های BOM routing، اتصال `canSeeCost`.
  - **`e49e01b`:** گسترش پوشش تست — smoke API، ماتریس دسترسی، BOM، تحلیل ثابت/متغیر پیشرفته، برآورد، گزارش‌ها، سلامت، smoke UI.
  - **`8d41c9d`:** health-check تولید + API/UI `user_cost_centers`، کنترل دستمزد پیمانکاری روی مودال مرحله، و `reverseStage` (PRD-99) برای آخرین مرحلهٔ کامل‌شده.
  - **`a537a15`:** استفاده از `cost_centers.active` (نه `is_active`)، باز کردن خودکار دوره در precheck بستن، مقاوم‌سازی داشبورد در دادهٔ خالی، بهبود UX/خطای ایجاد سفارش، حذف تب قدیمی تولید.
  - **`868a583`:** بازنشستگی VPS آلمان از مستندات؛ ایران `94.249.244.208` تنها سرور production.
- **فایل‌های کلیدی:** `server/lib/production/*` (bom, costing, engine, close, mrp, reports, schema, ...)، `server/routes/production-*.js`، `server/public/{prod-ui.js,prod-ui.css,acc-nav.js,index.html}`، `server/scripts/test-production-*.js`، `docs/Production/*`، `.github/workflows/production-tests.yml`، `server/sync/tables.js`
- **Deploy:** ⏳ نیاز به تأیید روی سرور — `npm install` لازم (وابستگی‌های جدید در `server/package.json`)

### ۱۴۰۵/۰۴/۲۵ — [Cursor] راه‌اندازی VPS ایران + مسیرهای قابل‌حمل PM2
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `332f84d`
- **خلاصه:** اسکریپت‌های bootstrap و سخت‌سازی سرور ایران (`bootstrap-iran-vps.sh`, `fresh-harden.py`, `ubuntu-harden.sh`, غیرفعال‌سازی رمز SSH، unban کنسول)، مسیرهای deploy قابل‌حمل PM2، و نمونهٔ `ssh-config-taranom-ir`.
- **فایل‌های کلیدی:** `scripts/bootstrap-iran-vps.sh`, `scripts/fresh-harden.py`, `scripts/ubuntu-harden.sh`, `scripts/deploy-production.sh`, `server/ecosystem.config.js`, `docs/SECURITY-HARDENING.md`
- **Deploy:** ⏳ اجرا روی سرور ایران (ops)

### ۱۴۰۵/۰۴/۲۴ — [Cursor] منوی حسابداری + جریان‌های فروش/خرید ایرانی + رفع باگ
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `09d6479` · `3a85bf9` · `373cffc`
- **خلاصه:**
  - `09d6479`: بازطراحی منوی حسابداری + جریان‌های فروش/خرید ایرانی + رفع چند باگ.
  - `3a85bf9`: رفع منوی حسابداری، UX گروه‌های اشخاص (`party_groups`)، و API سفارش‌ها.
  - `373cffc`: seed کردن `party_groups` در حالت standard + یکپارچه‌سازی UX ماژول اشخاص.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/routes/{parties,orders}.js`, `server/routes/party-groups.js`
- **Deploy:** ⏳ نیاز به تأیید روی سرور

### ۱۴۰۵/۰۴/۲۴ — [Cursor] اتصال postToLedger به فاکتور/خرید + قفل سال مالی + بازیابی بکاپ + UI یکپارچگی
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `9e183e0`
- **خلاصه:** سیم‌کشی `postToLedger` برای فاکتورها و خریدها (پست خودکار سند حسابداری)، قفل سال مالی (fiscal lock)، بازیابی بکاپ (backup restore)، و UI بررسی یکپارچگی (integrity UI).
- **فایل‌های کلیدی:** `server/routes/{invoices,purchases,fiscal-year}.js`, `server/lib/ledger.js`, `server/backup.js`, `server/public/index.html`
- **Deploy:** ⏳ نیاز به تأیید روی سرور
- **یادداشت:** این ورودی بعداً بازسازی شد — قبلاً فقط در جدول «وضعیت فعلی» به‌عنوان آخرین commit ذکر شده بود.

### ۱۴۰۴/۰۴/۲۸ — [Cursor] فاز ۳–۸ ماژول حسابداری (VAT، مودیان، گزارشات، HR، دارایی ثابت، backup)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `cdae070`
- **خلاصه:**
  - **فاز ۳:** VAT در فاکتور فروش/خرید + صف **مودیان** + حساب‌های 2103/1108
  - **فاز ۴:** گزارش VAT + گردش اشخاص + vatOutput در سود و زیان
  - **فاز ۵:** انبار در خرید + `/cash-boxes/petty-cash/summary`
  - **فاز ۶:** فیلدهای HR روی persons + `/payroll/monthly-batch`
  - **فاز ۷:** CRUD دارایی ثابت + استهلاک ماهانه
  - **فاز ۸:** activity log در audit + قفل سال مالی + backup restore
- **فایل‌های کلیدی:** `server/lib/vat.js`, `server/routes/moadian.js`, `server/routes/fixed-assets.js`, `server/routes/invoices.js`, `server/routes/purchases.js`
- **Deploy:** ✅ production (health 200, test 10/10)

### ۱۴۰۴/۰۴/۲۴ — [Cursor] فاز ۲ اطلاعات پایه + deploy فاز ۱
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `475aafb`
- **خلاصه:**
  - **units_of_measure** + API `/api/units`
  - انبار دو واحدی (کارگاه/دفتر توزیع) با entity و warehouse_type
  - UI **اشخاص یکپارچه** (`acc-parties`) + مخفی‌سازی منوی محک در حالت standard
  - hotfix: `currency.js`, `party-groups.js`, `cheque-records.js` برای boot سرور
- **Deploy:** ✅ production (`475aafb` — health 200)

### ۱۴۰۴/۰۴/۲۴ — [Cursor] فاز ۱ ماژول حسابداری (پایه + parties + dashboard)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `b5776d7`, `710bf84`
- **Deploy:** ✅ production
- **خلاصه:**
  - مشخصات تطبیق‌یافته: `docs/ACCOUNTING-MODULE-SPEC-ADAPTED.md` (ریال INTEGER، حذف محک، ادغام parties)
  - جدول **`parties`** + dual-write از customers/suppliers
  - **`detail_accounts`** / **`detail_categories`** (کدینگ سطح ۴)
  - موتور **`postToLedger`**, **`integrity-check`**, API **`/api/dashboard/*`**
  - رفع باگ CoA (5101/3201) + soft-delete در تراز آزمایشی
  - مراکز هزینه seed: کارگاه نوبرت / دفتر توزیع کیمیا
- **فایل‌های کلیدی:** `server/db.js`, `server/lib/ledger.js`, `server/routes/parties.js`, `server/routes/dashboard.js`

### ۱۴۰۴/۰۴/۲۸ — [Cursor] تکمیل UI/فیلدهای محک + دفتر چک + enrich pipeline
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** بدون commit
- **خلاصه:**
  - **دفتر چک محک** (`acc-mahak-cheques`): لیست چک‌های دریافتی/پرداختی از `full data.xlsx` + ویرایش وضعیت
  - **فرم‌های محک:** فیلدهای اشخاص/فروشنده/شخص/بانک در UI + ذخیره در API
  - **گروه‌های اشخاص و کالا** در منوی حسابداری + `party_groups` / `product_categories`
  - **`import-mahak-full-data.js`** + فاز ۵ در `mahak-go-live.js` + `mahak-enrich-production.js`
  - ستون **سند محک** در برگشت فروش/خرید، فاکتور، دریافت، انبار
  - SW → **v32**
- **فایل‌های کلیدی:** `server/public/index.html`, `server/scripts/import-mahak-full-data.js`, `server/scripts/mahak-enrich-production.js`, `server/lib/currency.js`, `server/routes/cheque-records.js`, `server/routes/party-groups.js`
- **Deploy:** ⏳ نیاز به push + pull روی سرور

### ۱۴۰۴/۰۴/۲۸ — [Cursor] تکمیل بازسازی — ۱۵۳۰/۱۵۳۰ سند متصل
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `25094b0`
- **خلاصه:** پرداخت/دریافت چکی، ایجاد خودکار مشتری، اتصال ۱۰۰٪ اسناد: ۲۰۸ فاکتور، ۱۷۹ دریافت، ۳۹ خرید، ۲۸۷ پرداخت تأمین، ۲۲۴ هزینه، ۱۱۸ حواله/رسید انبار.
- **Deploy:** ✅ production

### ۱۴۰۴/۰۴/۲۸ — [Cursor] بازسازی اسناد عملیاتی محک (فروش/خرید/انبار/دریافت/پرداخت)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `66664aa`
- **خلاصه:** `import-mahak-documents.js` — ۲۰۶ فاکتور فروش، ۱۵۳ دریافت، ۳۹ خرید، ۲۸۹ پرداخت تأمین، ۲۲۴ هزینه، ۱۱۸ حواله/رسید انبار، ۵ انتقال بانکی؛ اتصال ۱۰۳۲ سند حسابداری به `ref_type` عملیاتی.
- **فایل‌های کلیدی:** `server/scripts/import-mahak-documents.js`, `server/lib/mahak-import-helpers.js`, `server/scripts/mahak-classify-vouchers.js`
- **Deploy:** ✅ production — ورود: `admin`/`admin123`

### ۱۴۰۴/۰۴/۲۸ — [Cursor] import محک: مشتری، تأمین‌کننده، دسته‌بندی کالا
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `104e8bd`
- **خلاصه:** تحلیل عمیق روزنامه + کدینگ؛ ایجاد **۸۵ مشتری** و **۷۰ تأمین‌کننده** از اشخاص محک با `coa_code` و مانده از گردش حساب؛ دسته‌بندی مواد اولیه/محصول نهایی؛ `mahak-analyze.js` + `mahak-import-helpers.js`.
- **فایل‌های کلیدی:** `server/scripts/import-mahak-journal.js`, `server/lib/mahak-import-helpers.js`, `server/scripts/mahak-analyze.js`
- **Deploy:** ✅ production — ورود: `admin`/`admin123`
- **یادداشت:** ۱۵۳۰ سند، ۵۹۰۵ آرتیکل، ۵۲۳ کالا، ۷۱٬۸۳۱ موجودی — تراز ۵۰٬۹۹۸٬۶۴۳٬۸۸۹ تومان

### ۱۴۰۴/۰۴/۲۷ — [Cursor] go-live محک از صفر (سه فایل Excel)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `3866833`
- **خلاصه:** `mahak-go-live.js` — wipe + import journal + stock. production: ۱۵۳۰ سند، ۵۹۰۵ آرتیکل، ۱٬۱۲۴ حساب، ۵۲۳ کالا، ۷۱٬۸۳۱ موجودی، `coa_mode=mahak`, تراز ۵۰٬۹۹۸٬۶۴۳٬۸۸۹ تومان.
- **Deploy:** ✅ — ورود: `admin`/`admin123`
- **یادداشت:** مشتریان CRM=۰ (اشخاص محک فقط حساب تفصیلی در کدینگ)

### ۱۴۰۴/۰۴/۲۷ — [Cursor] رفع خطای داخلی سرور + تلاش بازیابی محک
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `b4e6d0d`
- **خلاصه:**
  - **خطای داخلی:** `notifications.js` جدول اشتباه `rep_payments` → `rep_payment_submissions` — رفع و deploy شد.
  - **کدینگ/اسناد محک نیست:** برای رفع 502 DB به pre-mahak برگشت؛ import محک (۱۵۳۰ سند) در `crm.db.corrupted-` بود، `.recover` ناموفق.
  - **DB فعلی:** integrity ok، `journal_entries=42`، `mahak=0` — اکسل محک روی سرور یافت نشد.
- **فایل‌های کلیدی:** `server/routes/notifications.js`, `server/scripts/recover-production-db.sh`
- **Deploy:** ✅ pull + pm2 restart
- **یادداشت:** `coding_hesbha.xlsx` + `daftar_roznameh.xlsx` (+ `mojodi.xlsx`) را روی سرور بگذارید → `import-mahak-journal.js`

- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `57f5544`
- **خلاصه:**
  - **ریشه 502:** `crm.db` خراب (`SQLITE_CORRUPT: database disk image is malformed`) — PM2 بیش از ۵۱٬۰۰۰ بار restart → پورت 3000 بالا نمی‌آمد → nginx/Chrome 502.
  - **رفع production:** بازیابی DB از `crm-pre-mahak.db` (integrity ok) + `pm2 restart` → `http://45.90.98.99:3000` و `/api/system/health` هر دو **200**.
  - **APK:** فایل خراب/partial (`apk.part0`/`apk.part1` ~۶MB) و `erp-taranom.apk` از `/releases/` سرور حذف شد.
  - **سیاست جدید:** APK فقط build محلی — `release.ps1`، `finalize-android-release.ps1`، `deploy-production.sh`، `android/BUILD.md`، `CLAUDE.md` به‌روز شد؛ `manifest.json` اندروید `url: ""` + `distribution: local`؛ `app-update.js` بدون URL آپدیت اعلام نمی‌کند.
- **فایل‌های کلیدی:** `scripts/release.ps1`, `scripts/finalize-android-release.ps1`, `scripts/deploy-production.sh`, `scripts/generate-release.js`, `scripts/check-db-integrity.js`, `server/lib/app-update.js`, `server/public/releases/manifest.json`, `android/BUILD.md`, `CLAUDE.md`
- **Deploy:** ✅ DB بازیابی + سرور آنلاین — ⏳ `git pull` برای manifest/اسکریپت‌های جدید
- **یادداشت:** مهاجرت محک (۱۶:۲۴) احتمالاً DB را خراب کرد — دادهٔ post-mahak در `crm.db.corrupted` باقی است؛ mahak را دوباره با احتیاط اجرا کنید.

### ۱۴۰۴/۰۴/۲۷ — [Cursor] رفع بنیادی اندروید 2.0.9 — بوت قابل‌اعتماد روی سامسونگ/نوکیا
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** «بدون commit»
- **خلاصه:**
  - **MainActivity:** WebView سازگار (mixed content، database، safe browsing off)، WebChromeClient/WebViewClient با نمایش خطا، اسپلش پیشرفته در استخراج assets، اعتبارسنجی projectIsValid، health poll به `/api/system/health` + `server.ready`، نمایش boot.log در صفحه خطا، Node در thread جدا.
  - **main.js:** fallback بهتر better-sqlite3 برای همه ABIها، `LISTEN_HOST=127.0.0.1`، نسخه 2.0.9.
  - **server.js:** endpoint `/api/system/health` + نوشتن `server.ready` برای اندروید.
  - **index.html:** غیرفعال‌سازی Service Worker در WebView اندروید (علت cache/hang)، راهنما به‌روز.
  - **Build:** AGP 8.5.2 + Gradle 8.7 + mirror Aliyun (دسترسی Google Maven)، NDK 25.1.8937393، prune node_modules.
  - **APK 2.0.9** (versionCode 11) ساخته و **۲۳/۲۳ assertion سبز** — 60MB SHA256 `C4C5F47E…`
- **فایل‌های کلیدی:** `MainActivity.java`, `main.js`, `server.js`, `index.html`, `android/build.gradle`, `settings.gradle`, `manifest.json`, `scripts/build-android.ps1`, `scripts/test-android-apk.ps1`
- **Commit:** `3fec142`
- **Deploy:** ✅ کد + manifest روی سرور (`git pull` + `pm2 restart`) — ⏳ APK 2.0.9 هنوز hash قدیمی روی سرور؛ scp/sftp قطع می‌شود — آپلود محلی لازم
- **یادداشت نصب:** کاربران باید **نسخه قبلی را حذف** و APK 2.0.9 را تازه نصب کنند. اولین باز کردن ۲–۵ دقیقه طول می‌کشد.

- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `79a44f7` (+ debug-sign fallback در `android/app/build.gradle`)
- **خلاصه:**
  - APK **2.0.8** (کد 1.0.11) امضا و اعتبارسنجی شد — **۱۷/۱۷ assertion سبز** (`test-android-apk.ps1`).
  - manifest اندروید → `2.0.8` / versionCode `10`؛ APK روی `/releases/erp-taranom.apk` (~62MB).
  - API آپدیت: `2.0.7 → 2.0.8` فعال.
  - رگرسیون: SMS 22/22، barcode 12/12، fiscal-year 4/4.
  - `android/build.gradle`: `maven.google.com` برای AGP؛ `android/app/build.gradle`: fallback امضای debug اگر keystore نباشد.
  - **مهاجرت محک go-live:** فایل‌های Excel محلی یافت نشد — دست مالک (`docs/MAHAK-MIGRATION.md` §۵).
- **فایل‌های کلیدی:** `server/public/releases/manifest.json`, `android/build.gradle`, `android/app/build.gradle`, `server/public/index.html`
- **Deploy:** ✅ scp APK + manifest + git pull + pm2 restart

### ۱۴۰۴/۰۴/۲۶ — [Cursor] انتشار نهایی 1.0.11 — installer دسکتاپ ساخته + deploy
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `dc97a18`
- **خلاصه:**
  - **دسکتاپ:** `ERP-Taranom-Setup-1.0.11.exe` (~93MB) با electron-builder ساخته شد — شامل همه تغییرات 1.0.11 + Mahak phase 2 UI.
  - **manifest.json + latest.yml** به 1.0.11 به‌روز شد؛ installer روی `/releases/` آپلود شد.
  - **اندروید:** APK release با کد جدید ساخته شد (`app-release-unsigned.apk` ~62MB) — بدون `android/keystore.properties` امضا نشد؛ manifest اندروید فعلاً 2.0.7 ماند تا امضا شود.
  - **build-android.ps1:** پشتیبانی از `app-release-unsigned.apk` + امضای خودکار اگر keystore موجود باشد.
  - راهنما: بخش «به‌روزرسانی دسکتاپ 1.0.11» اضافه شد.
- **فایل‌های کلیدی:** `desktop/package.json`, `desktop/dist/`, `server/public/releases/{manifest.json,latest.yml}`, `scripts/build-android.ps1`, `server/public/index.html`
- **Deploy:** ✅ installer آپلود + git pull + pm2 restart — API آپدیت: 1.0.10→1.0.11
- **یادداشت اندروید:** `android/keystore.properties` بسازید → `scripts/build-android.ps1` → scp `erp-taranom.apk` → manifest android را 2.0.8/10 کنید.

### ۱۴۰۴/۰۴/۲۶ — [Cursor] تکمیل UI فاز ۲ محک + deploy production
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `3218acd`
- **خلاصه:**
  - **پنل «⚙️ نگاشت کدینگ»** در تنظیمات: ویرایش ۱۲ کلید coa_* + checkbox سند COGS؛ `saveSettings()` ذخیره می‌کند؛ `clearCoaCache()` بعد از PUT.
  - **فرم‌ها:** نمایش readonly کد تفصیلی + دکمه «🔗 اتصال به حساب موجود» برای مشتری/محصول/تأمین‌کننده/بانک/صندوق؛ API جدید `PATCH /accounting/link-coa`.
  - **کدینگ:** ستون‌های سطح/ماهیت/نوع تفصیلی در جدول COA.
  - **سال مالی:** Factory Reset در `coa_mode=mahak` یا با اسناد `src_system=mahak` مسدود شد.
  - **`coa_mode`** در `/settings/modules` برای کاربران حسابداری (بدون دسترسی کامل تنظیمات).
  - **`test-mahak-phase2.js`:** handle `must_change_password` بعد از login.
  - SW → **v30**؛ راهنما به‌روز.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/sw.js`, `server/routes/{settings,accounting,fiscal-year}.js`, `server/scripts/test-mahak-phase2.js`
- **Deploy:** ✅ pull + pm2 restart (`3218acd` روی `45.90.98.99`)
- **یادداشت:** go-live دیتابیس محک (importer روی سرور) هنوز دست مالک — طبق `docs/MAHAK-MIGRATION.md` بخش ۵.

### ۱۴۰۴/۰۴/۲۶ — [Claude Code] ✅ فاز ۲ مهاجرت محک کامل شد — عملیات جاری روی کدینگ محک + COGS خودکار (۱۴/۱۴ تست E2E سبز)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:**
  - **تزریق coa-map به عملیات جاری:** فاکتور (دریافتنی/فروش/تخفیف + ابطال + تبدیل)، دریافت‌ها (۴ سایت 1103 در accounting.js → تفصیلی مشتری)، خرید (پرداختنی تأمین‌کننده/موجودی، ۷ سایت)، حقوق (۷۰۱/۲۰۴/501)، و `resolveCashAccount` → اول `coa_code` بانک/صندوق. همه backward-compatible: بدون coa_mode=mahak رفتار قدیمی عیناً حفظ (fallback به 1103/2101/...).
  - **سند COGS خودکار (تصمیم ۸):** `postCogsVoucher` در invoices.js — فاکتور رسمی: Dr بهای تمام‌شده (801) / Cr تفصیلی هر کالا؛ در ابطال و تبدیل پیش‌فاکتور هم دقیقاً معکوس/ثبت. فقط mahak-mode + `feature_cogs_voucher=1`.
  - **تفصیلی‌ساز خودکار (`allocTafsili` در coa-map):** مشتری/تأمین‌کننده/محصول (هر دو مسیر ساخت)/بانک/صندوق جدید → حساب تفصیلی ۱۲رقمی زیر معین نگاشت‌شده (شماره از MAX سراسری+1).
  - کلیدهای `coa_*` و `feature_cogs_voucher` به ALLOWED_KEYS تنظیمات اضافه شد.
  - **تست:** `scripts/test-mahak-phase2.js` جدید — E2E روی کپی DB واقعی محک: **۱۴/۱۴ سبز** (تفصیلی مشتری 203004960031، سند فروش روی 601، COGS با مبلغ cost×qty، دریافت به تفصیلی صندوق 206003500001، ابطال معکوس، تراز متوازن در هر مرحله). رگرسیون: SMS **22/22** + Sync **33/33** سبز. راهنمای ادمین بخش «حالت کدینگ محک» + SW → `v29`.
  - نکته باز (cosmetic): نام حساب‌های سطح ۳ ساخته‌شده توسط importer گاهی از شیت معینِ هم‌کد اشتباه برداشته می‌شود (کد درست است، فقط برچسب) — اصلاح در اجرای بعدی importer.
- **فایل‌های کلیدی:** `server/lib/coa-map.js`, `server/routes/{invoices,accounting,purchases,payroll,customers,suppliers,products,banks,cash-boxes,settings}.js`, `server/db.js`, `server/scripts/test-mahak-phase2.js`, `server/public/{index.html,sw.js}`
- **Deploy:** ⏳ pull + pm2 restart (کد)؛ **go-live دیتابیس محک** طبق MAHAK-MIGRATION.md بخش ۵ — دستورها در پیام Claude به مالک.

### ۱۴۰۴/۰۴/۲۶ — [Claude Code] ورود موجودی محک (فاز ۱ تکمیل) + 📋 گزارش کامل تحویل به Cursor
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:**
  - **`scripts/import-mahak-stock.js` جدید:** ورود تعداد موجودی از فایل mojodi.xlsx محک (join با «کد عملیاتی» شیت تفصیلی، فقط نوع کالاها). اجرای واقعی: **۳۵۲/۳۵۲ قلم تطبیق، صفر بدون تطبیق**؛ ۱۷۱ کالای خارج از فایل → موجودی صفر؛ بهای واحد ۲۸۷ قلم از ارزش افتتاحیه ÷ تعداد؛ جمع موجودی ۷۱٬۸۳۱ عدد؛ `needs_qty` همه پاک شد. گزارش: mahak-stock-report.md کنار DB.
- **فایل‌های کلیدی:** `server/scripts/import-mahak-stock.js`
- **Deploy:** طبق runbook پایین — نه خودکار.

#### 📋 وضعیت کامل مهاجرت محک برای Cursor (اگر Claude در دسترس نبود از اینجا ادامه بده)

**✅ انجام‌شده و تست‌شده (فاز ۱):**
1. تصمیمات ۸گانهٔ مالک در `docs/MAHAK-MIGRATION.md` بخش ۲ — **غیرقابل تغییر بدون تأیید مجدد**.
2. Schema (db.js): coa_code ×۶ جدول، needs_qty، src_system/src_doc_no/src_atf، level/nature/tafsili_type.
3. `lib/coa-map.js`: نگاشت حساب‌های کنترلی از settings با fallback به کدهای قدیمی (کش ۱۵ثانیه‌ای — بعد از تغییر settings، `clearCoaCache()`).
4. `scripts/import-mahak-journal.js` — نتیجهٔ اجرای واقعی: ۱٬۵۳۰ سند/۵٬۹۰۵ آرتیکل، تراز ۵۰٬۹۹۸٬۶۴۳٬۸۸۹=۵۰٬۹۹۸٬۶۴۳٬۸۸۹ تومان، ۴۳ تعدیل به 906001، کدینگ ۱٬۱۲۴ حساب، ۵۲۳ محصول/۱۳ بانک/۲ صندوق/۱۵ انبار، settings کلیدهای coa_* + coa_mode=mahak + feature_cogs_voucher=1 ست می‌شود. راستی‌آزمایی داخل تراکنش (خطا=rollback کامل).
5. `scripts/import-mahak-stock.js` — بالا.
6. DB تست‌شده در scratchpad جلسهٔ Claude است؛ **روی سرور باید از نو با فایل‌های مالک اجرا شود** (فایل‌های اکسل عمداً در git نیستند — حاوی اطلاعات مالی؛ مالک محلی دارد).

**✅ انجام‌شده (فاز ۲ — backend Claude + UI Cursor):**
1. تزریق `coa-map.acct()` به routeها + COGS خودکار + allocTafsili (commit `41d3bab`).
2. UI: پنل نگاشت کدینگ + کد تفصیلی در فرم‌ها + link-coa + ستون‌های COA + SW v30.
3. **Go-live:** runbook بخش ۵ — بک‌آپ DB فعلی، اجرای دو importer روی سرور، سوییچ DB_PATH، چک‌لیست پذیرش حسابدار (بخش ۶).

**⏳ مانده (دست مالک / ops):**
- اجرای importerها روی production با فایل‌های Excel محلی
- rebuild اندروید برای 1.0.11+Mahak

**~~⏳ ماندهٔ فاز ۲ (قدیمی — انجام شد)~~**

**⚠️ دام‌هایی که Claude به آن‌ها خورد (تکرار نکن):** (۱) فایل‌های page-script حتماً IIFE — barcode-input شما کل صفحه را کشته بود، فیکس شد؛ (۲) ÷۱۰ ریال→تومان فقط در سطح آرتیکل، هرگز روی جمع؛ (۳) «کد عملیاتی» تفصیلی محک per-type است نه یکتا — همیشه با نوع فیلتر کن؛ (۴) gate تغییر رمز اجباری 1.0.11 روی DB تازه فعال است (admin/admin123 → مودال تغییر رمز).

### ۱۴۰۴/۰۴/۲۶ — [Claude Code] 🚨 هات‌فیکس ورود (barcode-input) + اجرای فاز ۱ مهاجرت محک (importer تأییدشده)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:**
  - **🚨 باگ بحرانی 1.0.11:** `lib/barcode-input.js` در سطح global صفحه `const api` اعلان می‌کرد → تصادم با تابع `api()` برنامه → «Identifier api has already been declared» → **کل JS صفحه می‌مرد و ورود کار نمی‌کرد** (تست Node سبز بود چون فقط در مرورگر رخ می‌دهد). فیکس: کل فایل در IIFE پیچیده شد؛ ۱۲/۱۲ تست بارکد سبز. **⚠️ اگر production روی 516a088 است الان صفحه ورود مرده است — فوراً pull+restart کنید.**
  - **مهاجرت محک — فاز ۱ اجرا و تأیید شد:**
    - schema: `coa_code` روی customers/suppliers/products/banks/cash_boxes/persons + `needs_qty` + `src_system/src_doc_no/src_atf` روی journal_entries + `level/nature/tafsili_type` روی chart_of_accounts.
    - `lib/coa-map.js`: لایهٔ نگاشت حساب‌های کنترلی (settings-driven، fallback به کدهای قدیمی — backward compatible).
    - `scripts/import-mahak-journal.js`: ورود کامل در یک تراکنش + راستی‌آزمایی داخلی (rollback خودکار در خطا) + گزارش md.
    - **اجرای واقعی موفق روی فایل‌های مالک:** ۱٬۵۳۰ سند / ۵٬۹۰۵ آرتیکل (۴۳ تعدیل کسری به ۹۰۶) — **بدهکار=بستانکار=۵۰٬۹۹۸٬۶۴۳٬۸۸۹ تومان** ✅؛ کدینگ ۱٬۱۲۴ حساب ۴سطحی، ۵۲۳ محصول (needs_qty)، ۱۳ بانک، ۲ صندوق، ۱۵ انبار. گردش هر ۱۴ حساب کل == منبع. UI تست شد: «متوازن ✓».
- **فایل‌های کلیدی:** `server/lib/barcode-input.js`, `server/db.js`, `server/lib/coa-map.js`, `server/scripts/import-mahak-journal.js`
- **Deploy:** ⏳ **هات‌فیکس فوری لازم** (pull + pm2 restart). مهاجرت محک طبق بخش ۵ سند اجرا می‌شود، نه خودکار.
- **یادداشت برای Cursor:** فاز ۲ مهاجرت مانده: تزریق coa-map به routeها + سند COGS خودکار در فاکتور + تفصیلی‌ساز + پنل نگاشت — طبق MAHAK-MIGRATION.md بخش ۳.۲ تا ۳.۵. قانون: فایل‌های page-script حتماً IIFE.

### ۱۴۰۴/۰۴/۲۶ — [Claude Code] سند اجرایی مهاجرت کامل حسابداری محک → ترنم (docs/MAHAK-MIGRATION.md)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت (فقط سند — کد بعد از این سند پیاده می‌شود)
- **خلاصه:** کاربر کدینگ کامل محک (۴۸ کل/۱۵۰ معین/۷۹۵ تفصیلی) + دفتر روزنامه (۱٬۵۳۰ سند/۵٬۸۶۴ آرتیکل از ۱۴۰۵/۰۱/۰۱) را داد. تحلیل کامل انجام و ۸ تصمیم کلیدی با AskUserQuestion از مالک گرفته شد: ریال÷۱۰، **کدینگ محک مبنا**، دیتابیس تازه، تعدیل خودکار ۳۷ سند نامتراز به ۹۰۶، اشخاص فقط تفصیلی، کالاها محصول کامل (تعداد بعداً)، سند ۱۴۰۴ وارد شود، **COGS خودکار مثل محک از این به بعد**. سند شامل: schema جدید (coa_code روی ۶ جدول + src_doc_no + درخت COA)، لایهٔ `lib/coa-map.js` (نگاشت حساب‌های کنترلی، backward-compatible)، تفصیلی‌ساز خودکار، سند COGS در فاکتور، الگوریتم کامل importer با راستی‌آزمایی/rollback، ترتیب اجرا و چک‌لیست پذیرش حسابدار.
- **فایل‌های کلیدی:** `docs/MAHAK-MIGRATION.md`
- **Deploy:** ❌ (سند). ⚠️ فایل‌های اکسل مالی **در git قرار نمی‌گیرند** — مسیر محلی به importer داده می‌شود.
- **یادداشت برای Cursor:** پیاده‌سازی طبق سند، بخش ۳ و ۴. ⚠️ با تغییرات 1.0.11 شما (soft-delete سند، سال مالی) باید هماهنگ شود — importer اسناد `src_system='mahak'` می‌سازد و rollover سال مالی نباید آن‌ها را دستکاری کند.

### ۱۴۰۴/۰۴/۲۶ — [Cursor] نسخه 1.0.11 کامل (فاز ۱–۴)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `516a088`
- **خلاصه:**
  - **فاز ۱:** debounce بارکد + wedge؛ backup فقط central.
  - **فاز ۲:** حذف API/UI گردش حساب (ledger)؛ soft-delete فاکتور/سند دستی؛ سال مالی rollover + factory reset؛ انبارگردانی به منوی حسابداری + سند GL.
  - **فاز ۳:** Command Palette Ctrl+K؛ ویجت اقدامات + اعلان‌ها؛ ساخت سریع محصول در فاکتور.
  - **فاز ۴:** RBAC ماتریس per-user؛ مشاور AI فقط مدیر (admin/sales_manager).
  - تست: barcode 12/12، fiscal 4/4، SMS 22/22. SW → v28.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/lib/rbac.js`, `server/routes/{notifications,search,fiscal-year,rbac}.js`, `server/services/ai.js`, `server/db.js`, `server/scripts/test-fiscal-year.js`
- **Deploy:** ✅ pull + pm2 restart سرور production

### ۱۴۰۵/۰۴/۲۲ — اسکریپت deploy خودکار + keystore example
- **شاخه:** `cursor/deploy-automation-605f`
- **Commit:** `80ee40b`
- **خلاصه:** `scripts/deploy-production.sh` (git pull + jwt-secret + npm + pm2 + health check)، به‌روزرسانی `.github/workflows/deploy.yml` با bootstrap inline، `android/keystore.properties.example`
- **فایل‌های کلیدی:** `scripts/deploy-production.sh`, `.github/workflows/deploy.yml`, `android/keystore.properties.example`, `docs/PROJECT-HANDOFF.md`
- **Deploy:** ⏳ نیاز به merge + اجرای workflow یا SSH
- **یادداشت:** `bash scripts/deploy-production.sh` روی سرور یا GitHub Actions «Deploy ERP ترنم»

### ۱۴۰۵/۰۴/۲۲ — سخت‌سازی امنیتی (بند «ب» handoff) + merge با v4
- **شاخه:** `cursor/security-hardening-605f` → `claude/claude-md-docs-2ssrpy`
- **Commit:** `f8ba6f4` (merge به `claude/claude-md-docs-2ssrpy`)
- **خلاصه:**
  - تغییر اجباری رمز پیش‌فرض/موقت در اولین ورود (سازگار با 2FA v4): ستون `users.must_change_password`، گیت 403 در `auth` (فقط مرکزی)، مودال فرانت؛ پرچم قبل از مرحله 2FA برای رمز `admin123`
  - رمزنگاری بکاپ AES-256-GCM + `server/scripts/decrypt-backup.js`
  - حذف اسرار از مخزن (keystore، JWT هاردکد) + `docs/SECURITY-HARDENING.md`
  - merge با v4: 2FA/TOTP، پورتال B2B، انبارگردانی، audit log، …
  - `test-v4-features.js` با تغییر اجباری رمز سازگار شد (`loginAdmin` helper)
- **فایل‌های کلیدی:** `server/middleware/auth.js`, `server/routes/{auth,twofa,admin}.js`, `server/backup.js`, `server/public/index.html`, `server/scripts/test-v4-features.js`, `docs/SECURITY-HARDENING.md`
- **Deploy:** ❌ اعمال نشده — `jwt-secret.txt` قبل از restart الزامی
- **یادداشت:** بعد از deploy، admin مودال تغییر رمز می‌بیند؛ همه با تغییر JWT یک‌بار re-login

### ۱۴۰۴/۰۴/۲۴ — [Claude Code] نسخه دمو برای پرزنت — seed کامل + دموی آنلاین (:3001) + دموی لپ‌تاپ
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:** به درخواست کاربر، نسخه دمو «دقیقاً همان برنامه» — همان کد، دیتابیس جدا با داده نمایشی غنی:
  - **`server/scripts/seed-demo.js`:** سرور واقعی را روی DB خالی بوت می‌کند و از **APIهای واقعی** داده می‌سازد (دفاتر تراز می‌ماند — تست شد: بدهکار=بستانکار=۱۹٫۸ میلیارد ✅): ۴ کاربر (demo/sara/reza/maryam — رمز همه `demo1234`)، ۲ بانک + ۲ صندوق (تنخواه)، ۲ انبار، ۵ تأمین‌کننده، ۶ دسته محصول + ۶۰ محصول، ۱۵ فاکتور خرید (شارژ موجودی)، ۴۰ مشتری، ۶۰ پیگیری/پایپ‌لاین، **۱۲۵ فاکتور رسمی + ۲۵ پیش‌فاکتور** در بازه ۳ ماه، ۹۲ دریافت (نقد/بانک/چک با سررسید)، ۸ هزینه، ۶ سری تولید، ۵ کارمند + حقوق (بعضی پرداخت‌شده)، یادآورها. تصادفی‌سازی deterministic (seed ثابت) — هر بار همان دمو.
  - **`scripts/demo-online.sh`:** روی سرور production یک instance دوم PM2 با نام `erp-taranom-demo` روی پورت **3001** بالا می‌آورد (DB/uploads جدا — برنامه اصلی دست‌نخورده). اجرای مجدد = ریست دمو؛ مناسب cron شبانه.
  - **`scripts/demo-laptop.ps1`:** دموی آفلاین روی لپ‌تاپ ویندوزی — حالت central (همه ماژول‌ها از جمله تنظیمات/کاربران دیده می‌شود، برخلاف build دسکتاپ که device است) روی `http://127.0.0.1:3002`.
- **فایل‌های کلیدی:** `server/scripts/seed-demo.js`, `scripts/demo-online.sh`, `scripts/demo-laptop.ps1`
- **Deploy:** ⏳ برای دموی آنلاین: `bash scripts/demo-online.sh` روی سرور (+ باز بودن پورت 3001)
- **یادداشت:** SMS در دمو به‌طور طبیعی خاموش است (تنظیمات پیامک خالی) — به مشتری واقعی چیزی ارسال نمی‌شود.

### ۱۴۰۴/۰۴/۲۴ — [Cursor] رفع کرش فوری اندروید 2.0.7 — APK تودرتو ۲۹۴MB حذف شد
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** (همین session)
- **خلاصه:**
  - **ریشهٔ کرش فوری:** `copyServerSources` فایل `erp-taranom.apk` (۲۹۴MB) را داخل assets بسته‌بندی می‌کرد → اولین استخراج OOM/کرش → برنامه فوراً بسته می‌شد.
  - **رفع:** exclude کل `public/releases/**`؛ قبل از build جابجایی APK از پوشه server؛ `MainActivity` با کپی iterative + catch خطا (بدون RuntimeException روی thread)؛ `largeHeap` + `extractNativeLibs`؛ `main.js` با boot.log و throw اگر sqlite نباشد.
  - **تست:** `scripts/test-android-apk.ps1` (۱۴ assertion: بدون nested apk، ELF libnode+sqlite، نسخه 2.0.7، حجم <250MB) — همه سبز. SMS 22/22 سبز. APK جدید **۶۲MB** SHA256 `265EDC4B…`.
- **فایل‌های کلیدی:** `android/app/build.gradle`, `MainActivity.java`, `main.js`, `AndroidManifest.xml`, `scripts/test-android-apk.ps1`, `scripts/build-android.ps1`
- **Deploy:** ✅ APK 2.0.7 آپلود (`SHA256=265EDC4B…`, 62MB) + commit `72118af` + pm2

### ۱۴۰۴/۰۴/۲۴ — [Cursor] انتشار اندروید 2.0.6 — رفع بوت SQLite (better-sqlite3 path)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** (همین session)
- **خلاصه:**
  - **باگ 2.0.5:** APK دارای `prebuilt/android/*/better_sqlite3.node` بود ولی `bindings()` فقط `build/Release/` را می‌خواند → سرور Node کرش → اپ اجرا نمی‌شد.
  - **رفع:** `main.js` در runtime باینری ABI درست را کپی می‌کند؛ rebuild با prebuilt هر ۳ ABI؛ نسخه **2.0.6 (vc8)**.
  - **APK جدید:** SHA256 `6247752D…`, ~۳۴۱MB — ELF سبز (libnode + ۳ prebuilt + fix در main.js).
  - راهنمای داخل برنامه: یادآوری «اولین اجرای اندروید چند دقیقه طول می‌کشد».
- **فایل‌های کلیدی:** `android/.../main.js`, `android/app/build.gradle`, `scripts/build-android.ps1`, `scripts/build-better-sqlite3-android.ps1`, `server/public/releases/manifest.json`, `server/public/index.html`
- **Deploy:** ✅ APK 2.0.6 آپلود شد (`SHA256=6247752D…`) + commit `2696eda` + pull/pm2 سرور

### ۱۴۰۴/۰۴/۲۴ — [Claude Code] انتشار 1.0.10 انجام شد: exe + APK ساخته و آپلود شد — فقط pull سرور مانده
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `57f25f9` (متادیتا — توسط release.ps1 روی سیستم کاربر) + همین کامیت (fix)
- **خلاصه:**
  - کاربر `release.ps1` را اجرا کرد: **دسکتاپ `ERP-Taranom-Setup-1.0.10.exe` (۹۳MB) ساخته شد** ✅ و **APK اندروید 2.0.5 (۲۲۰MB) ساخته شد** ✅ — بازرسی ELF سبز (۳ ماژول better_sqlite3 + libnode هر ۳ ABI؛ SHA256 `61856EB8...`). هر دو با scp روی `/releases/` سرور آپلود شدند.
  - دو باگ build حین راه رفع شد: (۱) اسکریپت‌های ps1 باید ASCII خالص باشند (PS 5.1 + بدون BOM → em-dash بایت نقل‌قول هوشمند دارد و parser می‌شکند)؛ (۲) فایل‌های `.gz` داخل node_modules (bcryptjs) با AAPT تداخل «Duplicate resources» می‌دهند → قبل از build حذف می‌شوند.
  - **قدم آخر (deploy وب) خطا داد:** روی production فایل `manifest.json` تغییر محلی دستی داشت و pull را بلاک کرد. `release.ps1` اصلاح شد: قبل از pull، فقط دو فایل متادیتای releases را `git checkout --` می‌کند (git منبع حقیقت آن‌هاست). دستور یک‌خطی رفع به کاربر داده شد.
- **فایل‌های کلیدی:** `scripts/release.ps1`, `scripts/build-android.ps1`, `server/public/releases/{manifest.json,latest.yml}`
- **Deploy:** ⏳ فقط `git pull` سرور مانده (exe/apk از قبل روی سرور هستند)
- **یادداشت برای Cursor:** روی production فایل‌های releases را دیگر دستی ویرایش نکنید — همیشه از مسیر git + release.ps1.

### ۱۴۰۴/۰۴/۲۴ — [Cursor] تشخیص باگ بحرانی بوت اندروید: better-sqlite3 در مسیر اشتباه (2.0.5)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **خلاصه:** APK 2.0.5 (`SHA256=61856eb8…`) ELF معتبر داشت ولی `build/Release/better_sqlite3.node` نداشت — رفع در 2.0.6 بالا.
- **فایل‌های کلیدی:** `android/.../nodejs-project/main.js`
- **Deploy:** ❌ → جایگزین با 2.0.6

### ۱۴۰۴/۰۴/۲۴ — [Claude Code] رفع «برنامه اندروید بالا نمی‌آید»: صبر بوت از ~۳۰ ثانیه به ۱۰ دقیقه + اسپلش
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:**
  - ریشهٔ احتمالی گزارش کاربر پیدا شد: اولین اجرای APK هزاران فایل nodejs-project را استخراج می‌کند (چند دقیقه روی حافظه کند)، ولی `loadWhenReady` قدیمی فقط ۲۰×۱.۵ثانیه (~۳۰s) تلاش می‌کرد و بعد **برای همیشه صفحه خالی** می‌ماند.
  - حالا: اسپلش فارسی «در حال آماده‌سازی... اولین اجرا ممکن است چند دقیقه طول بکشد» فوراً نمایش داده می‌شود؛ یک thread پس‌زمینه تا ۱۰ دقیقه سرور داخلی را poll می‌کند (HttpURLConnection، هر ۱ ثانیه) و به‌محض HTTP 200 برنامه را load می‌کند؛ اگر هرگز بالا نیامد صفحه خطای صادقانه.
  - hash کاربر (`43563CC8...`) نشان داد APK محلی همان build مردهٔ قبلی **نیست** — پس این سناریوی بوتِ کند محتمل‌ترین علت است. Play Protect هم نصب را بلاک می‌کرد (راهنمایی شد: More details → Install anyway).
  - `git pull` کاربر به‌خاطر تغییرات uncommitted شما (Cursor) رد شد: `android/app/build.gradle`, `docs/CHANGE-LOG.md`, `scripts/build-android.ps1`, `manifest.json` — به کاربر گفته شد stash کند (`git stash push -m cursor-wip-before-1.0.10`). ⚠️ **Cursor:** stash را بررسی/ادغام کن و لطفاً کارها را commit کن.
- **فایل‌های کلیدی:** `android/app/src/main/java/ir/taranom/crm/MainActivity.java`
- **Deploy:** ❌ در build اندروید 2.0.5 (از طریق `scripts/release.ps1`) اعمال می‌شود

### ۱۴۰۴/۰۴/۲۴ — [Claude Code] زیرساخت انتشار 1.0.10 — اسکریپت یک‌دستوری release.ps1 + bump نسخه‌ها
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:**
  - **نسخه‌ها bump شد:** دسکتاپ `1.0.10` (desktop/package.json)، اندروید `2.0.5` / versionCode `7` (build.gradle). محتوای 1.0.10: تم زمرد/شب مخملی، اعداد انگلیسی خودکار، UX جدید آپدیت (پیشرفت دانلود+نصب خودکار اندروید)، آیکون واقعی لوگو، SW v26.
  - **`scripts/release.ps1` جدید:** انتشار کامل با یک دستور روی سیستم ویندوز: git pull → build دسکتاپ → build اندروید → **راستی‌آزمایی ELF داخل APK** (libnode هر ۳ ABI + ماژول‌های better_sqlite3 — jلوگیری از تکرار فاجعه APK مرده) → تولید manifest/latest.yml (generate-release) → commit+push متادیتا → scp نصب‌کننده‌ها به سرور → ssh deploy وب (pull+npm install+pm2 restart) + health-check. هر مرحله exit code چک می‌کند.
  - `generate-release.js`: notes نسخه از آرگومان/پیش‌فرض ۱.۰.۱۰.
  - **تشخیص مشکل «برنامه بالا نمی‌آید» روی گوشی کاربر:** عکس نشان داد Google Play Protect نصب را بلاک کرده («developer ناشناس») — مشکل کد نیست؛ راه عبور به کاربر داده شد. مشکوک دوم: APK روی سرور ممکن است همان build مردهٔ ELF-MISSING باشد — منتظر SHA256 از کاربر.
- **فایل‌های کلیدی:** `scripts/release.ps1`, `scripts/generate-release.js`, `desktop/package.json`, `android/app/build.gradle`
- **Deploy:** ⏳ اجرای `scripts/release.ps1` روی سیستم کاربر = انتشار کامل 1.0.10 (وب+دسکتاپ+اندروید)
- **یادداشت برای Cursor:** از این به بعد انتشار فقط با `release.ps1` انجام شود — manifest/latest.yml/exe/apk را دیگر دستی و جدا از هم به‌روز نکنید (ریشهٔ حلقهٔ آپدیت کاذب و APK مرده همین ناهماهنگی دستی بود).

### ۱۴۰۴/۰۴/۲۴ — [Claude Code] آیکون اندروید از لوگوی واقعی ترنم (گزارش کاربر: آیکون لوگو نبود)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:**
  - آیکون لانچر اندروید یک وکتور عمومی دستی بود، نه لوگوی برند. از `server/public/logo.png` (۳۰۰۰×۳۰۰۰ شفاف) با sharp آیکون واقعی ساخته شد: `ic_launcher.png` + `ic_launcher_round.png` برای ۵ چگالی (mdpi تا xxxhdpi، زمینه سفید گرد) + `ic_launcher_foreground.png` برای adaptive icon (اندروید ۸+، زمینه سفید `@color/iconBackground`).
  - گزارش دیگر کاربر: APK نصب می‌شود ولی **برنامه اصلاً بالا نمی‌آید** — مشکوک به آپلود همان APK کهنه‌ای که ELF هر ۳ ABI آن MISSING بود (`SHA256=5341B460...`, ۲۲۲MB). دستور تشخیص به کاربر داده شد؛ سرور از این محیط قابل دسترسی نیست (پروکسی).
- **فایل‌های کلیدی:** `android/app/src/main/res/mipmap-*/ic_launcher*.png`, `mipmap-anydpi-v26/*.xml`, `values/colors.xml`
- **Deploy:** ❌ نیاز به build اندروید بعدی (2.0.5)
- **یادداشت برای Cursor:** قبل از build بعدی حتماً `git pull` — آیکون‌ها + تغییرات MainActivity (پیشرفت دانلود/نصب خودکار) + fix های `build-android.ps1` (BOM/exit-code) همه در git هستند. اگر APK روی سرور همان فایل ۲۳۲٬۷۴۷٬۱۹۹ بایتی است، خراب است و باید rebuild+re-upload شود.

### ۱۴۰۴/۰۴/۲۴ — [Claude Code] پیاده‌سازی کامل تم: «زمرد مدرن» (روشن، پیش‌فرض) + «شب مخملی» (دارک‌مود)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:** اجرای کامل `docs/design/THEME-IMPLEMENTATION.md` (اسپکی که برای Cursor نوشته شده بود — چون کاربر خواست خود Claude اجرا کند):
  - **توکن‌ها:** بلوک `:root` بازنویسی شد (پالت زمرد مدرن) + بلوک `html[data-theme=dark]` (شب مخملی: سبز نئونی `#3DDC8C`، طلایی `#E7C876`، زمینه `#0D1512`) + توکن‌های جدید: `--on-accent`, `--side-bg`, `--shadow-card`, `--input-bg`, `--th-bg`, `--row-hover`, `--well`, `--chat-bg`, `--bub-me` و ۵ خانواده چیپ معنایی (`--ok/bad/amber/info/violet-bg/fg`).
  - **جاروی هاردکد:** همه سطح‌های `#fff`/پاستلی بلوک `<style>` به توکن تبدیل شد (مودال‌ها، فرم‌ها، جدول‌ها، دیت‌پیکر، کانبان، چت تلگرامی، پورتال B2B، تایم‌لاین...). متن روی دکمه‌های accent → `var(--on-accent)` (در دارک تیره می‌شود چون سبز نئونی روشن است).
  - **سوییچ:** دکمه «🌙/☀️» در foot سایدبار + گوشه صفحه ورود؛ ذخیره در `localStorage['crm_theme']`؛ اسکریپت ضد-FOUC اول `<head>`؛ `meta theme-color` همگام.
  - **امضاها:** کارت آمار اول گرادیان برند (هر دو تم)؛ در دارک: هالهٔ سبز radial روی body، گرادیان کارت‌ها، درخشش لوگو.
  - **نمودار:** `drawChart` تم‌آگاه شد (بنفش هاردکد قدیمی `#7C3AED` حذف!) + `rebuildChartsForTheme()` هنگام سوییچ.
  - **چاپ:** در `@media print` توکن‌های دارک به روشن برمی‌گردند — فاکتور/گزارش همیشه روشن چاپ می‌شود.
  - **تست:** اسکرین‌شات Playwright از ورود/داشبورد/مشتریان/فاکتور/مودال/شل حسابداری/گزارشات در هر دو تم — بدون لکه سفید یا متن کم‌کنتراست؛ تم بعد از reload حفظ می‌شود (anti-FOUC)؛ parse اسکریپت سبز. راهنما به‌روز شد؛ SW → `v26`.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ✅ pull + pm2 restart سرور production restart
- **یادداشت برای Cursor:** تم token-محور است — از این به بعد **هیچ رنگ سطحی را هاردکد نکنید**؛ از توکن‌های `:root` استفاده کنید وگرنه در دارک‌مود لکه می‌شود. برای رنگ متن روی دکمه سبز از `var(--on-accent)` استفاده کنید نه `#fff`.

### ۱۴۰۴/۰۴/۲۴ — [Claude Code] اعداد انگلیسی خودکار + UX جدید آپدیت (دکمه تبدیل‌شونده + پیشرفت دانلود) + رفع حلقه آپدیت کاذب دسکتاپ
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:**
  - **اعداد انگلیسی خودکار:** listener سراسری — در فیلدهای عددی (type number/tel، inputmode numeric/decimal، class money، data-jdate، idهای phone/qty/price/barcode/...) رقم فارسی/عربی همان لحظه تایپ به انگلیسی تبدیل می‌شود (با حفظ caret). متن آزاد (textarea/یادداشت) دست نمی‌خورد. قبلاً فیلد money رقم فارسی را کلاً حذف می‌کرد — حالا می‌پذیرد.
  - **UX آپدیت دسکتاپ:** پنل به‌روزرسانی حالا **یک دکمه تبدیل‌شونده** دارد: «🔄 بررسی» → (در حال دانلود + نوار پیشرفت با «X از Y مگابایت — حدود N ثانیه/دقیقه مانده») → «🚀 نصب نسخه X و راه‌اندازی مجدد». `desktop/main.js` هم transferred/total/bps را از electron-updater به UI می‌فرستد (**نیاز به build دسکتاپ جدید برای ETA؛ UI با buildهای قدیمی هم سازگار است — فقط درصد نشان می‌دهد**).
  - **UX آپدیت اندروید:** `MainActivity` دانلود APK را از DownloadManager رصد و پیشرفت را به `window.onApkDownloadProgress` می‌فرستد (مگابایت/درصد/زمان باقی‌مانده در بنر) و پس از پایان دانلود، پنجره نصب **خودکار** باز می‌شود (permission جدید `REQUEST_INSTALL_PACKAGES` در manifest). **نیاز به build اندروید بعدی.**
  - **رفع حلقه آپدیت کاذب:** `manifest.json` ادعای desktop=1.0.9 داشت ولی url به exe نسخه 1.0.8 اشاره می‌کرد (installer 1.0.9 هرگز ساخته نشده) → کاربر آپدیت می‌زد، 1.0.8 نصب می‌شد و دوباره پیام آپدیت می‌گرفت. نسخه به `1.0.8` صادقانه شد.
  - **تست:** curl روی `/api/system/app-update` (سه سناریو) + ۱۶ assertion جدید Playwright (state machine دکمه، برچسب MB/ETA، callback اندروید، تبدیل ارقام money/jdate/tel و مصون ماندن textarea) + ۲۲ تست SMS سبز + parse اسکریپت. راهنمای ادمین/فروش به‌روز شد؛ SW → `v25`.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/sw.js`, `server/public/releases/manifest.json`, `desktop/main.js`, `android/.../MainActivity.java`, `android/app/src/main/AndroidManifest.xml`
- **Deploy:** ✅ pull + pm2 restart سرور production restart (فرانت/manifest). دسکتاپ و اندروید در build بعدی.
- **یادداشت برای Cursor:** ⚠️ installer دسکتاپ **1.0.9 هنوز ساخته نشده** — بعد از build حتماً manifest+latest.yml را با هم bump کنید (ریشه حلقه آپدیت کاذب همین ناهماهنگی بود). در build بعدی اندروید، تغییرات MainActivity/manifest من هم سوار می‌شود.

### ۱۴۰۴/۰۴/۲۴ — [Claude Code] رفع شکست build اندروید روی سیستم کاربر (SDK location + گزارش succes کاذب)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت
- **خلاصه:** کاربر `finalize-android-release.ps1` را اجرا کرد و build با `SDK location not found` شکست خورد ولی اسکریپت APK کهنه را `BUILD=SUCCESS` گزارش کرد (چک ELF جلوی آپلود را گرفت — هر ۳ ABI MISSING). ریشه‌ها و اصلاح در `scripts/build-android.ps1`:
  - `local.properties` با `Set-Content -Encoding UTF8` نوشته می‌شد → در PowerShell 5 **BOM** دارد و Gradle کلید `sdk.dir` را نمی‌بیند. حالا با `[IO.File]::WriteAllText` بدون BOM و با `/` نوشته می‌شود.
  - `$env:ANDROID_HOME` هم صریحاً ست می‌شود (مسیر دوم تشخیص SDK برای Gradle).
  - exit code گریدل چک می‌شود (`$LASTEXITCODE`) و APK قدیمی **قبل از** build حذف می‌شود → دیگر success کاذب ممکن نیست.
- **فایل‌های کلیدی:** `scripts/build-android.ps1`
- **Deploy:** ❌ ربطی به سرور ندارد (اسکریپت build ویندوز)
- **یادداشت برای Cursor:** ⚠️ `scripts/finalize-android-release.ps1` و نسخهٔ محلی `build-android.ps1` شما (پیام «better-sqlite3 Android ELF modules present» دارد) **در git نیستند** — لطفاً طبق قانون CLAUDE.md commit کنید و همین دو fix (BOM + exit code) را اگر نسخهٔ محلی‌تان جداست اعمال/merge کنید. ضمن اینکه ELF سه ABI در APK کهنه MISSING بود — بعد از build موفق حتماً خروجی چک ELF بررسی شود.

### ۱۴۰۴/۰۴/۲۴ — رفع اسکرول پیام‌ها + build اندروید 2.0.4
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `d5e079b`
- **خلاصه:**
  - **پیام‌ها:** اسکرول عمودی در پنجره مکالمه (`min-height:0` + `overflow-y:auto`)؛ حباب پیام `fit-content`؛ حفظ موقعیت اسکرول هنگام polling؛ SW → `v24`.
  - **اندروید 2.0.4:** Gradle wrapper + JDK 17 + libnode از zip رسمی nodejs-mobile؛ `buildConfig` فعال؛ exclude فایل‌های `.exe` دسکتاپ از assets (رفع OOM ۲GB)؛ APK release ساخته و آپلود به `/releases/erp-taranom.apk` (~148MB).
  - **اسکریپت:** `scripts/build-android.ps1` برای buildهای بعدی.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/sw.js`, `android/app/build.gradle`, `android/gradle.properties`, `android/gradlew*`, `scripts/build-android.ps1`, `server/public/releases/manifest.json`
- **Deploy:** ✅ وب (pull+pm2) + APK روی سرور

### ۱۴۰۴/۰۴/۲۴ — [Claude Code] اسپک کامل تم «زمرد مدرن + شب مخملی» برای اجرا توسط Cursor
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `dc602ed` (فقط docs — کد برنامه دست نخورده)
- **خلاصه:**
  - کاربر ترکیب تأییدشده را انتخاب کرد: **بورد ۱ (زمرد مدرن) تم اصلی روشن + بورد ۲ (شب مخملی) دارک‌مود**.
  - سند اجرایی کامل برای Cursor نوشته شد: `docs/design/THEME-IMPLEMENTATION.md` — شامل توکن‌های کامل CSS هر دو تم، بلوک `html[data-theme=dark]`، اسکریپت ضد-FOUC، سوییچ 🌙 (localStorage `crm_theme`)، جدول پاک‌سازی رنگ‌های هاردکد، helper تم‌آگاه Chart.js، چاپِ همیشه‌روشن، bump SW، و چک‌لیست QA.
  - فایل‌های مرجع گرافیکی در repo: `docs/design/board1-modern-emerald.png`, `docs/design/board2-velvet-night.png`, `docs/design/design-boards-reference.html`.
- **فایل‌های کلیدی:** `docs/design/THEME-IMPLEMENTATION.md`, `docs/design/*.png`, `docs/design/design-boards-reference.html`
- **Deploy:** ❌ لازم نیست (اجرا با Cursor است)


### ۱۴۰۴/۰۴/۲۴ — نسخه 1.0.9 (فاکتور، کاتالوگ، پیام‌ها، AI کاربر، آیکون‌ها)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `843ecd2`
- **خلاصه:** پیاده‌سازی کامل `update1.0.9.md`:
  - **§1 فاکتور:** حذف فیلد کانال فروش از UI؛ `resolveSalesChannel()` در backend از نقش کاربر (میدانی→field، تلفنی→phone)؛ حذف «ساخت محصول» از فاکتورساز؛ `/products/quick` فقط admin.
  - **§2 کاتالوگ:** `GET /warehouses` برای همه کاربران auth؛ ترتیب routeهای محصولات (`/categories`، `/by-barcode` قبل از `/:id`).
  - **§3 پیام‌ها:** API `/messages/threads`، `/thread/:peer`، `/thread/:peer/read`؛ UI تلگرامی با polling، حباب، تیک دوبل.
  - **§4 حساب من:** `clamp()` + `fitStatNums()` برای اعداد بزرگ در کارت‌های آمار.
  - **§5 پرداخت معلق:** اسکریپت `cleanup-aref-pending.js`؛ حذف تسویه تأییدشده → وضعیت `rep_payment_submissions` به rejected.
  - **§6 AI کاربر:** `GET /api/ai/my-summary` + `buildMySummary()` فقط دادهٔ `user_id` خود کاربر.
  - **§7 آیکون‌ها:** Lucide SVG در منو و کارت‌های آمار (`lucide()` + `EMO_LU`).
  - **تست:** `scripts/test-1.0.9.js` (۲۱ assertion). راهنمای ادمین/فروش به‌روز شد؛ SW → `v23`.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/routes/invoices.js`, `server/routes/products.js`, `server/routes/warehouses.js`, `server/routes/messages.js`, `server/routes/accounting.js`, `server/routes/ai.js`, `server/services/ai.js`, `server/scripts/test-1.0.9.js`, `server/scripts/cleanup-aref-pending.js`, `server/public/sw.js`
- **Deploy:** ✅ deploy شده (pull + pm2 restart — aref: کاربر #3 یافت شد، رکورد pending نداشت)

### ۱۴۰۴/۰۴/۲۴ — پورتال مشتریان B2B (انتقال از ERP v4 — فقط مرکزی)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `3acd305`
- **خلاصه:** پورتال سفارش آنلاین مشتریان عمده — کاملاً افزودنی، بدون دست زدن به جریان‌های موجود:
  - **Backend:** جداول `b2b_portal_accounts` + `b2b_portal_orders` (خارج از SYNCABLE_TABLES — فقط مرکزی)؛ ستون `customers.b2b_enabled` (از طریق sync معمولی مشتری به دستگاه‌ها می‌رسد، فقط برای نمایش برچسب)؛ route جدید `routes/b2b.js` با `centralOnly` روی کل router: ورود با موبایل+رمز یا OTP پیامکی (پاسخ uniform — بدون افشای وجود شماره)، کاتالوگ، ثبت سفارش، تاریخچه سفارش/فاکتور، صورتحساب زنده (همان `buildStatement` حسابداری — export شد).
  - **جداسازی توکن:** توکن پورتال `scope:'b2b'` دارد؛ middleware داخلی `auth` هر توکن دارای scope را رد می‌کند (توکن‌های staff موجود بدون scope هستند → backward compatible) و `b2bAuth` فقط scope='b2b' می‌پذیرد — تست دوطرفه دارد.
  - **گردش سفارش:** سفارش پورتال → پیش‌فاکتور با شماره اتمیک (`allocateNumber` — نه COUNT+1 مثل v4) به نام کارشناسِ مشتری + پیام داخلی به او؛ قیمت همیشه server-side از جدول محصولات (قیمت کلاینت نادیده گرفته می‌شود — تست دارد)؛ تأیید = تبدیل همان پیش‌فاکتور به رسمی از مسیر موجود (موجودی/دفتر/سند همان‌جا).
  - **Frontend:** صفحه پورتال `#portal` (ورود، کاتالوگ با تصویر و سبد با +/−، سفارشات من، صورتحساب با مانده بدهکار/بستانکار)؛ لینک «ورود پورتال مشتریان» در صفحه ورود (فقط وقتی feature روشن است — از `app-info` که فیلد بولین `b2b_portal` گرفت)؛ بخش «🛒 پورتال B2B» در فرم ویرایش مشتری (ادمین، غیر device)؛ منوی ادمین «🛒 سفارشات B2B»؛ برچسب آبی B2B در لیست مشتریان؛ پنل تنظیمات با کلید `feature_b2b_portal`.
  - **ایمنی:** rate-limit روی `/api/b2b/auth/*`؛ `/api/b2b` در BLOCKLIST سینک؛ کلیدهای `feature_*`/`ai_*` به ALLOWED_KEYS تنظیمات اضافه شد (قبلاً ذخیره AI هم silently drop می‌شد — رفع شد)؛ روی device build همه endpointها 403 و منو/لینک مخفی.
  - **تست:** `scripts/test-b2b.js` جدید (۲۹ assertion: فلگ، provisioning، ورود/OTP، جداسازی توکن دوطرفه، قیمت server-side، صف ادمین، لغو دسترسی). هر ۴ suite سبز: 22 sms + 25 sync + 24 v4 + 29 b2b. راهنمای ادمین/فروش به‌روز شد؛ SW → `v22`.
- **فایل‌های کلیدی:** `server/routes/b2b.js`, `server/db.js`, `server/middleware/auth.js`, `server/server.js`, `server/routes/settings.js`, `server/routes/accounting.js`, `server/sync/capture.js`, `server/public/index.html`, `server/scripts/test-b2b.js`
- **Deploy:** ✅ deploy شده (pull + pm2 restart — جداول ساخته شدند، endpoint ها verify شدند: login بدون فلگ → 403 صحیح، admin/orders بدون توکن → 401، app-info فیلد `b2b_portal` برمی‌گرداند. dependency جدیدی ندارد.)
- **یادداشت:** پورتال هنوز **خاموش** است — برای فعال‌سازی: تنظیمات → «پورتال مشتریان B2B» → فعال‌سازی + ذخیره، سپس برای هر مشتری از فرم ویرایش او دسترسی و رمز تعیین کنید. آدرس پورتال: `/#portal`.

### ۱۴۰۴/۰۴/۲۳ — انتقال مزیت‌های CRM v4: امنیت 2FA + دستیار AI + بارکد محصولات
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `87a6469`
- **خلاصه:** آنالیز کامل پروژه `crm v4` و انتقال ۳ مزیت اصلی آن (بدون multi-tenancy/B2B/مودیان/puppeteer که به معماری آسیب می‌زدند):
  - **2FA (TOTP):** جدول `two_factor_auth` (خارج از sync — فقط مرکزی)، route جدید `/api/auth/2fa/*` (setup/verify/recovery-code/disable/status/admin-reset/admin-status)، رمزنگاری اسرار با AES-256-GCM (`services/crypto.js`)، مرحله کد ۶ رقمی در ورود + کدهای بازیابی یک‌بارمصرف، پنل «🔐 امنیت» در سایدبار، rate-limit روی verify. دستگاه‌های آفلاین: ورود بدون 2FA (جدول خالی)، مدیریت 2FA فقط از وب (`centralOnly`).
  - **دستیار فروش AI:** ستون `customers.churn_score` + جدول `ai_insights`؛ سرویس heuristic (ریسک ریزش ۰-۱۰۰، فرصت فروش مجدد بر اساس الگوی خرید، اقدام روزانه هر کارشناس، خلاصه هفتگی مدیر) بدون نیاز به API خارجی؛ لایه اختیاری Claude API (تنظیمات: `feature_ai_assistant`, `ai_api_key`, `ai_model`)؛ cron شبانه ۰۲:۰۰ فقط مرکزی؛ صفحه «🤖 دستیار AI» در منوی ادمین و فروش؛ برچسب قرمز ریسک در لیست مشتریان.
  - **بارکد محصولات:** ستون `products.barcode`؛ تولید EAN-13 استاندارد (deterministic → سازگار با replay سینک)؛ `/by-barcode/:code`؛ صفحه چاپ برچسب 58×40mm (توکن از query)؛ اسکنر دوربین (html5-qrcode با lazy-load CDN و ورود دستی جایگزین) در فاکتورساز (افزودن مستقیم به سبد) و صفحه محصولات؛ پشتیبانی بارکد در جستجو/اکسل.
  - **سایر:** audit ورود موفق/ناموفق؛ `/api/ai` در BLOCKLIST سینک؛ راهنمای ادمین و فروش (۳ بخش جدید هرکدام)؛ SW bump به `v21`؛ وابستگی جدید `otplib@12` (هر ۳ package.json).
  - **تست:** `scripts/test-v4-features.js` جدید (۲۴ assertion end-to-end روی سرور واقعی: چرخه کامل 2FA، اعتبار check-digit بارکد، تحلیل AI). هر ۳ suite سبز: 22 sms + 25 sync + 24 v4.
- **فایل‌های کلیدی:** `server/routes/twofa.js`, `server/routes/ai.js`, `server/services/ai.js`, `server/services/crypto.js`, `server/routes/auth.js`, `server/routes/products.js`, `server/db.js`, `server/server.js`, `server/sync/capture.js`, `server/public/index.html`, `server/scripts/test-v4-features.js`
- **Deploy:** ✅ deploy شده (pull + npm install + pm2 restart — HTTP 200، endpointهای 2fa/ai روی production mount شدند، SW v21 سرو می‌شود)
- **یادداشت:** روی سرور بعد از pull حتماً `npm install` اجرا شود (otplib جدید است).
### ۱۴۰۴/۰۴/۲۳ — [Claude Code] هماهنگی با Cursor + قانون یادداشت‌گذاری مشترک
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** همین کامیت (فقط مستندات — بدون تغییر کد)
- **خلاصه:**
  - Claude Code به آخرین کار Cursor همگام شد (rebase روی `0919817` — شامل 1.0.7، 1.0.8، انبارگردانی، آکاردئون سایدبار).
  - شاخهٔ محلی زائد `spec1000-phaseG-backup` (پیاده‌سازی موازی فراننکو توسط Claude) حذف شد — نسخهٔ Cursor در `server/lib/farankenou.js` معتبر است.
  - قانون جدید در `CLAUDE.md`: هماهنگی دوطرفهٔ Cursor ⇄ Claude Code — بعد از هر تسک، ورودی در همین فایل + commit/push اجباری. git تنها کانال مشترک است.
  - خارج از repo: ۴ بورد طراحی UI (زمرد مدرن، شب مخملی، کاغذ و مرکب، کوارتز صنعتی) به‌صورت Artifact به کاربر تحویل شد. توصیهٔ Claude: «زمرد مدرن» تم اصلی + «شب مخملی» دارک‌مود. هنوز هیچ‌کدام پیاده نشده — منتظر تصمیم کاربر.
- **فایل‌های کلیدی:** `CLAUDE.md`, `docs/CHANGE-LOG.md`
- **Deploy:** ❌ لازم نیست (فقط مستندات)
- **یادداشت برای Cursor:** اگر کار uncommitted دارید، قبل از تسک بعدی Claude حتماً push کنید — Claude فقط git را می‌بیند. (این rebase وسط push شما اتفاق افتاد — هر دو ورودی حفظ شد.)

### ۱۴۰۴/۰۴/۲۳ — بازطراحی تیترهای سرفصل منوی حسابداری
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `927ef3b`
- **خلاصه:**
  - سرفصل‌های آکاردئون منوی حسابداری از 10px خاکستری uppercase به کارت‌های مدرن تبدیل شد: فونت 13.5px وزن 800، رنگ سفید با کنتراست بالا روی سایدبار تیره، پس‌زمینه شیشه‌ای گرد (border-radius 11px)
  - حالت باز: گرادیان طلایی + متن کرم؛ hover روشن‌تر؛ فلش `▾` با چرخش انیمیشنی (rotate 90° در حالت بسته)
  - رفع hover نامرئی قبلی (`var(--purple)` سبز تیره روی پس‌زمینه سبز تیره)
  - راهنمای ادمین به‌روز شد؛ SW bump به `v20`
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ⏳

### ۱۴۰۴/۰۴/۲۳ — نسخه 1.0.8 (وب + دسکتاپ) و 2.0.3 (اندروید)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `66e3c56`
- **خلاصه:**
  - **UI:** اعداد کامل داشبورد + فونت adaptive؛ accordion منوی حسابداری (پیش‌فرض بسته)؛ عنوان «ثبت دریافت از مشتری»
  - **باگ:** lightbox رسید نماینده (مسیر upload)؛ جستجوی مشتری نام+فروشگاه؛ dropdown GL هزینه؛ followups sub-group (`_fupCustGroups`)
  - **ویژگی:** widget تسویه‌های منتظر تأیید؛ فیلتر ممیزی (تاریخ امروز + کاربر)؛ مرتب‌سازی followups نزولی؛ sync خودکار debounced 2s
  - **ماژول جدید:** انبارگردانی (`stocktaking_sessions` + `stocktaking_items` + UI + API)
- **فایل‌های کلیدی:** `server/public/index.html`, `server/routes/stocktaking.js`, `server/db.js`, `server/sync/tables.js`, `server/public/sw.js`
- **Deploy:** ✅ وب + installer دسکتاپ 1.0.8 (~97MB) روی production — ⏳ APK اندروید 2.0.3 (نیاز Android Studio + libnode)

### ۱۴۰۴/۰۴/۲۱ — انتشار دسکتاپ 1.0.7 (build + deploy)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `eb50d4b`
- **خلاصه:**
  - build: `ERP Taranom Setup 1.0.7.exe` (~93MB)
  - manifest + latest.yml به‌روز — دانلود از `/releases/` سرور production
  - رفع crash `rep_territories` در initDB
- **فایل‌های کلیدی:** `desktop/dist/`, `server/public/releases/manifest.json`, `server/public/releases/latest.yml`
- **Deploy:** ✅ کامل — metadata + exe روی production (97082265 bytes)
- **یادداشت:** نصب تازه یا جایگزینی 1.0.6

### ۱۴۰۴/۰۴/۲۱ — رفع خطای دسکتاپ: no such table rep_territories
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `5158586`
- **خلاصه:**
  - `ensureColumn` روی `rep_territories` **قبل از** `CREATE TABLE` اجرا می‌شد → initDB روی DB تازه دسکتاپ crash
  - ستون‌های `rep_id` و `cities` به تعریف جدول منتقل شد؛ migration بعد از CREATE
- **فایل‌های کلیدی:** `server/db.js`
- **Deploy:** ⏳ وب + **نیاز به rebuild دسکتاپ 1.0.7**
- **یادداشت:** نسخه دسکتاپ فعلی 1.0.6 این باگ را دارد — installer جدید لازم است

### ۱۴۰۴/۰۴/۲۱ — رفع 502 + بهینه‌سازی بنیادی سرعت وب و حسابداری
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `b921b73`
- **خلاصه:**
  - **رفع 502:** import گم‌شده `adminOnly` در `invoices.js` — PM2 در crash loop بود (۴۵۰k+ restart)
  - **حسابداری:** داشبورد acc-dash دیگر trial-balance و suppliers/list را بلوک نمی‌کند؛ overview غنی‌شده با `trialBalanced` + `totalPayable`
  - **SQL:** query تأمین‌کنندگان از correlated subquery به JOIN تبدیل شد
  - **boot admin:** `/settings` به‌صورت lazy load (مسدود نکردن login)
  - SW bump به `v18`
- **فایل‌های کلیدی:** `server/routes/invoices.js`, `server/routes/accounting.js`, `server/routes/suppliers.js`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ✅ production (`6350292` — PM2 stable, HTTP 200)
- **یادداشت:** `git pull origin claude/claude-md-docs-2ssrpy && cd server && pm2 restart erp-taranom`

### ۱۴۰۴/۰۴/۲۰ — زیرساخت به‌روزرسانی دسکتاپ (GitHub Releases، بدون SCP)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `a69f5d8`
- **خلاصه:**
  - رفع installer bloated: حذف exeهای قدیمی از بسته نصب (۹۳MB به‌جای ۱.۱GB)
  - exe دیگر روی سرور production آپلود نمی‌شود — فقط manifest + latest.yml
  - لینک دانلود از GitHub Releases در manifest.desktop.url
  - `update-feed` از feed_url خارجی پشتیبانی می‌کند
- **فایل‌های کلیدی:** `desktop/scripts/prepare-server.js`, `scripts/publish-desktop.js`, `docs/DESKTOP-UPDATE.md`, `server/server.js`
- **Deploy:** ✅ production (`a69f5d8`)
- **یادداشت:** `gh release create v1.0.6 ...` — راهنما در docs/DESKTOP-UPDATE.md

### ۱۴۰۴/۰۴/۲۰ — به‌روزرسانی 1.0.6 (update1.0.6.md — ۱۴ مورد)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `41be9d1`
- **خلاصه:**
  - دسکتاپ: تأیید خروج؛ پشتیبان محلی بدون خطای centralOnly
  - UX: fmtCompact در statCard؛ ستون‌های استاندارد مشتری + tel: موبایل
  - پیگیری: مانده حساب در مرحله؛ kanban ستون سرنخ؛ لیست accordion مشتری
  - اکسل فقط admin؛ گزارش top10؛ فاکتور با نام کامل؛ نقش دفتر پخش
  - پیام‌ها: checkbox + پوشه کاربر؛ تنظیمات module_reps؛ ACC_NAV دسته‌بندی
  - پرداخت میدانی: rep_payment_submissions + تأیید حسابدار
- **فایل‌های کلیدی:** `server/public/index.html`, `server/db.js`, `server/routes/rep-management.js`, `desktop/main.js`
- **Deploy:** ✅ production (`41be9d1`)
- **یادداشت:** `git pull && cd server && pm2 restart erp-taranom`

### ۱۴۰۴/۰۴/۱۹ — بهینه‌سازی سرعت ناوبری و بارگذاری صفحات
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `dc95426`
- **خلاصه:**
  - فرانت: لایه cache برای API و HTML داشبورد/گزارشات؛ reuse پنل حسابداری بین تب‌ها؛ debounce جستجو؛ fetch یک‌باره پیام‌ها/یادآورها
  - بک‌اند: indexهای جدید SQLite؛ cache وضعیت کاربر فعال در auth (۳۰ثانیه)؛ رفع N+1 در `/reports/salesperson`؛ `seedWarehouseStock` فقط یک‌بار
  - Service Worker: bump به `erp-taranom-v8`
- **فایل‌های کلیدی:** `server/public/index.html`, `server/db.js`, `server/middleware/auth.js`, `server/routes/reports.js`, `server/public/sw.js`
- **Deploy:** ✅ production (`dc95426` — HTTP 200)
- **یادداشت:** سرور API از قبل سریع بود (~۵ms)؛ گلوگاه اصلی فرانت و queryهای تکراری بود

---

### ۱۴۰۴/۰۴/۱۸ — امنیت، فراموشی رمز، بک‌آپ پیشرفته، واردات محک، رفع build دسکتاپ
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `f322106`
- **خلاصه:**
  - رفع build دسکتاپ: `better-sqlite3` v11 + `electron-updater`
  - امنیت: `JWT_SECRET` اجباری در production، سیاست رمز ۸+ حرف و عدد (`lib/security.js`)
  - فراموشی رمز: OTP پیامکی از صفحه ورود
  - بک‌آپ: چرخشی (۱۴ نسخه)، ZIP روی ویندوز / tar.gz روی لینوکس، شامل DB + uploads
  - واردات محک: آپلود FullBackup.zip، تحلیل .bak، import از SQL Server
  - راهنمای داخل برنامه به‌روز شد
- **فایل‌های کلیدی:** `server/lib/security.js`, `server/backup.js`, `server/routes/auth.js`, `server/routes/import.js`, `server/lib/mahak-import.js`, `desktop/package.json`, `docs/MAHAK-IMPORT.md`
- **Deploy:** ⏳
- **یادداشت:** واردات کامل محک نیاز به SQL Server + restore فایل‌های .bak دارد

---

- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `391fd66`
- **خلاصه:**
  - عکس محصولات در نسخهٔ آفلاین (دسکتاپ/موبایل) از سرور مرکزی pull می‌شود (`server/sync/files.js`)
  - درخواست `/uploads/...` اگر فایل محلی نباشد، از مرکز دانلود می‌کند (middleware در `server.js`)
  - UI: retry عکس، دکمه «دریافت تصاویر» در پنل sync، badge «X تصویر در انتظار»
  - Service Worker دیگر `/uploads/` را cache نمی‌کند (`sw.js` v7)
  - auto-update دسکتاپ با `electron-updater` (`desktop/main.js`)
  - اعلان نسخهٔ جدید اندروید + دانلود APK در Downloads (`MainActivity.java`)
  - manifest نسخه‌ها: `server/public/releases/manifest.json` + اسکریپت `scripts/generate-release.js`
- **فایل‌های کلیدی:** `server/sync/files.js`, `server/sync/client.js`, `server/server.js`, `server/routes/sync.js`, `server/public/index.html`, `desktop/main.js`, `android/.../MainActivity.java`, `server/lib/app-update.js`
- **Deploy:** ⏳ روی GitHub push شد — سرور باید `git pull` بزند
- **یادداشت:** برای auto-update دسکتاپ، فایل‌های `.exe` و `latest.yml` را در `server/public/releases/` آپلود کنید

---

### ۱۴۰۴/۰۴/۱۸ — بهینه‌سازی عملکرد + رفع crash بوت production
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `5d797cb` (و `abe33d1`, `8119a5d`)
- **خلاصه:**
  - SQLite tuning (WAL, cache, mmap)، indexهای جدید، batch query به‌جای N+1
  - لیست فاکتورها بدون `rows` سنگین؛ جزئیات با `GET /invoices/:id`
  - `seedWarehouseStock()` امن با JS loop (بدون SQL شکسته روی `warehouses` قدیمی)
  - `repairWarehousesSchema()` / `repairProductCategoriesSchema()` برای DB legacy
  - sync trigger درست برای `warehouse_stock` (کلید composite)
  - فرانت: cache/debounce، `loadInitial` سبک‌تر برای نقش accounting
- **فایل‌های کلیدی:** `server/db.js`, `server/routes/{customers,invoices,accounting,admin,warehouses,cash-boxes}.js`, `server/public/index.html`
- **Deploy:** ✅ روی production pull شد (`6a9f240` → `5d797cb`)
- **یادداشت:** خطای قدیمی `SqliteError: no such column: id` در لاگ PM2 مربوط به restartهای قبل بود؛ بعد از repair دستی، `warehouses` ستون `id` دارد

---

### ۱۴۰۴/۰۴/۱۷ — فازهای B تا F (update1000)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `6a9f240`
- **خلاصه:** درخت COA، مطالبات به تفکیک فاکتور، UX خرید/انبار، سربار تولید خودکار
- **Deploy:** ✅ پایدار روی production (rollback قبلی به این commit)

---

### ۱۴۰۴/۰۴/۱۷ — بهینه‌سازی اولیهٔ سرعت بارگذاری
- **Commit:** `7228ce6`
- **خلاصه:** JOIN balance مشتری، receivables batch، `/cash-boxes/balances`, indexها، cache فرانت
- **Deploy:** ✅ (داخل شاخهٔ فعلی)

---

## کارهای انجام‌نشده / در صف

- [ ] 🔔 **یادآوری صریح مالک (۱۴۰۵/۰۴/۲۶): «وقتی دامنه را دادم این مورد را یادآوری کن.»** — به‌محض اینکه مالک **دامنه** را ارائه داد، این بستهٔ کار دامنه‌محور روی سرور ایران `94.249.244.208` انجام شود:
  1. **HTTPS**: Nginx + certbot طبق `docs/SECURITY-HARDENING.md` بخش «د» برای دامنهٔ `.ir`.
  2. **رفع دسترسی سرور به GitHub**: سرور `github.com` را resolve نمی‌کند (فیلترینگ) → تنظیم DNS تمیز/پروکسی تا `scripts/deploy-production.sh` مستقیم `git pull` کند (فعلاً deploy فقط با git bundle ممکن است).
  - (دستیار بعدی: این آیتم را در ابتدای پاسخ به مالک، وقتی دامنه را داد، فعالانه یادآوری کن.)
- [ ] 🔐 **چرخش کلید SSH**: کلید `taranom-crm-admin@Taranom` (ed25519) در چت افشا شد — از `~/.ssh/authorized_keys` سرور حذف و کلید جدید جایگزین شود؛ کلید فقط از طریق Secrets داده شود.
- [ ] پس از deploy: رمزنگاری بکاپ از پنل «پشتیبان» + چرخش keystore اندروید (`keystore.properties.example`)
- [ ] pagination برای لیست‌های بزرگ
- [ ] merge شاخه به `main`

---

## دستور deploy استاندارد (سرور)

```bash
# یک‌خطی (توصیه‌شده — شامل jwt-secret و health check):
bash /home/taranom-admin/crm-taranom/scripts/deploy-production.sh

# یا دستی:
cd /home/taranom-admin/crm-taranom
git fetch origin
git checkout claude/claude-md-docs-2ssrpy
git pull origin claude/claude-md-docs-2ssrpy
cd server
# فقط اگر jwt-secret.txt ندارید:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > jwt-secret.txt && chmod 600 jwt-secret.txt
npm install --omit=dev
pm2 restart erp-taranom --update-env
curl -s http://127.0.0.1:3000/api/system/time
```

**هرگز** `git reset --hard` روی production نزنید مگر برای rollback آگاهانه.
# 2026-08-08 — P0-C واقعی + انتشار RC 2.0.33/2.0.10

- CI dependency gate پس از advisory جدید با ارتقای `sharp` از 0.33.5 به 0.35.0 بسته شد؛ audit بدون high/critical، upload security 55/55 و sync-file 19/19.
- بکاپ رمز‌شده production به Windows off-server منتقل شد؛ sidecar-before/after، SHA-256، receipt، lock، retention و atomic promotion.
- کلید pull جدا و پیش‌فرض شد و روی VPS فقط به wrapper ریشه‌مالک محدود است؛ key/DB/.env/private uploads/SFTP/upload/delete در تست منفی رد شدند.
- Scheduled Task پانزده‌دقیقه‌ای Limited اجرا شد (`LastTaskResult=0`)؛ به‌دلیل نبود elevation فعلی fallback آن Interactive است.
- restore واقعی فایل `crm-backup-20260808-151500.zip.enc` با fingerprint برابر و RTO تخمینی ۳ ثانیه Pass شد.
- provision کلید fail-closed شد: remote file/PM2 hash با DPAPI محلی تطبیق داده می‌شود؛ missing/mismatch اجازه overwrite ندارد و rotation غیرفعال است.
- uploader باینری با host pinning، resume digest-scoped، hash پیش از promote، rollback و HTTP hash عملیاتی شد؛ APK 2.0.33 و EXE 2.0.10 منتشر شدند.
- تست‌ها: artifact real PASS؛ offsite 25/25؛ policy 4/4؛ DR 14/14؛ uploader 3/3؛ embedded 224/224 هر هدف، drift=0؛ `git diff --check` PASS.
