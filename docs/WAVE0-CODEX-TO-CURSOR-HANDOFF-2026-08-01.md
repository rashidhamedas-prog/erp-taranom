# دست‌به‌دست Codex به Cursor — ادامهٔ Wave 0 پس از امضای APK/EXE

> تاریخ snapshot: 2026-08-01  
> مخزن: `rashidhamedas-prog/erp-taranom`  
> مسیر محلی: `D:\soft\Claud\porje\crm-taranom\erp-taranom1`  
> شاخهٔ الزامی: `claude/claude-md-docs-2ssrpy`  
> HEAD در لحظهٔ handoff: `acc6c10`؛ شاخه با remote-tracking محلی هم‌تراز بود  
> وضعیت: **working tree بسیار dirty و تغییرات این نوبت هنوز commit/push نشده‌اند**  
> deploy ایران: **ممنوع تا تکمیل Gate موج صفر**  
> APK/EXE کامل: **نساز مگر کاربر صریحاً اجازه دهد**  
> Wave 1–4: **شروع نکن**

---

## متن کوتاه آماده برای Cursor

این فایل را کامل بخوان و همان working tree موجود را ادامه بده. هیچ `reset`، `checkout --`، `clean`، stash خودکار، overwrite یا pull مخرب انجام نده؛ تغییرات فعلی WIP اصلی هستند. ترتیب قطعی ادامه:

1. فقط **P0-S3** را audit/fix کن و تمام تست‌های فهرست‌شده را سبز کن.
2. `SUMMARY.md` و `CHANGE-LOG.md` و plan فاز را فقط پس از سبزشدن Gate همان فاز به‌روز کن.
3. سپس **P0-C** را با backup/restore واقعاً امن و multi-company کامل کن و تست کن.
4. سپس **P0-Q1/Q2** را کامل کن؛ `xlsx` را به `exceljs` مهاجرت بده و waiver را حذف کن.
5. پس از تمام تغییرات، prepare/hash مشترک P0-B را دوباره اجرا کن تا embedded Android/Desktop drift صفر شود.
6. suite کامل را سریالی اجرا کن؛ مخصوصاً sync را هم‌زمان با suiteهای دیگر اجرا نکن.
7. در پایان فقط همان فایل‌های پروژه را stage کن، `EXECUTION-REPORT.md` بساز، commit و push را روی همین شاخه انجام بده.
8. deploy ایران، restart PM2، آپلود release و full APK/EXE build ممنوع است مگر کاربر صریحاً دستور جدید بدهد.

هیچ secret، رمز، JKS یا PFX را نخوان/چاپ/commit نکن. مقادیر واقعی `JWT_SECRET`، `DATA_ENCRYPTION_KEY`، کلید backup، keystore و PFX فقط نزد ops می‌مانند.

---

## 1) وضعیت Git و مرز مالکیت فایل‌ها

- در شروع این اجرای Codex، pull قبلی انجام شده بود و HEAD فعلی `acc6c10` است.
- هیچ commit یا push برای تغییرات زیر انجام نشده است.
- تغییرات tracked فعلی حدود 68 فایل و بیش از 4 هزار خط افزوده دارد؛ حذف زیاد `index.html` عمدی است، چون کد/CSS inline به assetهای جدا منتقل شده است.
- هشدارهای `LF will be replaced by CRLF` صرفاً line-ending محیط Windows هستند؛ آن‌ها را با rewrite سراسری تشدید نکن.

### فایل‌های untracked شخصی/عملیاتی کاربر — هرگز stage یا حذف نکن

```text
.vscode/
erp-taranom-master-roadmap-cursor.md
scripts/_deploy-pull-iran.py
scripts/_deploy-sftp-keep-products.py
scripts/_deploy-wave0-gate-sftp.py
scripts/_inspect-iran-db.py
scripts/_inspect-product-docs.py
scripts/_iran-ff-pull-after-stash.py
scripts/_iran-git-reset-hard-origin.py
scripts/_list-iran-tables.py
scripts/_verify-post-wipe.py
server/crm.db.pre-wipe-parties-2026-07-30T16-03-41-458Z.bak
```

### secret/artifactهایی که نباید وارد Git شوند

```text
android/erp-taranom.jks
android/keystore.properties
desktop/certs/
*.pfx
server/jwt-secret.txt
server/data-encryption-key.txt
.env
server/*.db*
server/private-uploads/
server/backups/
desktop/dist/
android/app/build/
```

پیش از stage از allowlist استفاده کن؛ `git add -A` کورکورانه ممنوع است.

---

## 2) منابعی که قبل از ادامه باید خوانده شوند

1. `.cursor/skills/erp-roadmap-wave0/SKILL.md` — قوانین اجرای موج صفر.
2. `docs/WAVE0-GPT-PRO-HANDOFF.md` — handoff قبلی.
3. `docs/WAVE0-SIGNING-HANDOFF-GPT.md` — وضعیت امضای APK/EXE.
4. `docs/.plans/260801-wave0-critical-path/SUMMARY.md` — plan اصلی.
5. `docs/CHANGE-LOG.md` — تاریخچه و قانون ثبت هر فاز.
6. `docs/erp-taranom-master-roadmap.md` — acceptance criteria اصلی.

اگر اسناد موجود با این snapshot تعارض داشتند، کد و نتیجهٔ تست جدیدتر ملاک است؛ سپس سند متناقض را اصلاح کن.

---

## 3) کار کامل‌شده: P0-S2 — Android/Electron hardening

P0-S2 در سطح source gate کامل و در plan با `[x]` ثبت شده است. فایل‌های امضاشدهٔ موجود قبل از این تغییرات source ساخته شده‌اند؛ بنابراین فقط pipeline امضا را اثبات می‌کنند و RC نهایی نیستند.

### Android

- `allowBackup=false` و خاموش‌بودن cleartext عمومی.
- network security فقط برای loopback؛ host/IP تولید از cleartext حذف شده است.
- WebView debugging در release خاموش؛ هشدار root/debuggable اضافه شده است.
- `SecureSecretStore.java` با AndroidKeyStore/AES-GCM برای JWT محلی و migration حذف‌کنندهٔ plaintext.
- device credential در SQLite با AES-256-GCM و fail-closed روی tamper/wrong key.
- updater APK فقط پس از HTTPS، اندازه، SHA-256، package، version و signer continuity نصب می‌کند؛ mismatch حذف می‌شود.

فایل‌های کلیدی:

```text
android/app/src/main/AndroidManifest.xml
android/app/src/main/java/ir/taranom/crm/MainActivity.java
android/app/src/main/java/ir/taranom/crm/SecureSecretStore.java
android/app/src/main/assets/nodejs-project/main.js
scripts/test-android-platform-security.js
server/lib/app-update.js
server/scripts/test-app-update.js
server/scripts/test-release-artifact-integrity.js
server/sync/secure-kv.js
```

### Electron/Windows

- `sandbox:true`، navigation/window-open فقط loopback و `openExternal` فقط HTTPS allowlist.
- IPC sender validation، permission denial، redirect/child-window/webview attachment restrictions.
- local JWT با Electron `safeStorage`/DPAPI؛ packaged build در failure باز نمی‌شود.
- updater با HTTPS allowlist، metadata دقیق، streaming size/SHA-256 و Authenticode/publisher enforcement.
- packaged Windows به‌صورت پیش‌فرض signed-update را مطالبه می‌کند؛ رفتار env دقیقاً `0/1` است.

فایل‌های کلیدی:

```text
desktop/main.js
desktop/preload.js
desktop/security-policy.js
desktop/local-secret-store.js
desktop/scripts/test-local-secret-store.js
desktop/scripts/test-main-hardening-static.js
desktop/scripts/test-security-policy.js
```

### آخرین شواهد ثبت‌شده برای P0-S2

- Android static/security: `27/27 PASS` + Java SDK 36 compile.
- Desktop policy/secret/main: مجموع `42/42 PASS` + syntax.
- local secret/app-update/sync قبلی: green.
- prepare embedded قبلی: `204/204` در هر target و drift صفر.
- APK signer v2 و Authenticode خروجی موجود تأیید شده‌اند.

این تست‌ها بعد از اتمام P0-S3/P0-C/Q دوباره اجرا شوند، چون server/UI source تغییر کرده است.

---

## 4) کار انجام‌شده در P0-S3 — بخش‌های نسبتاً پایدار

### 4.1 CSP، Trusted Types، DOM-XSS و چاپ امن

UI بزرگ inline از `server/public/index.html` خارج و به assetهای جدا منتقل شده است:

```text
server/public/app.js
server/public/app.css
server/public/boot.js
server/public/csp-runtime.js
server/public/print-page.js
server/public/demo.js
server/public/demo.css
server/public/brochure.js
server/public/brochure.css
```

کنترل‌های پیاده‌شده:

- CSP سرور بدون `unsafe-inline` و `unsafe-eval`.
- `script-src-attr 'none'` و `style-src-attr 'none'`.
- Trusted Types policy محدود و sanitizer مرکزی برای sinkهای HTML.
- event/styleهای legacy به delegation با `data-csp-*` منتقل شده‌اند.
- private imageها با endpoint احراز‌شده، Bearer fetch، MIME/size check و Blob URL نمایش داده می‌شوند.
- query token از barcode label و parties export حذف شده است.
- `document.write` چاپ سند حذف و فقط سند server-attested باز می‌شود.
- `server/lib/secure-html-response.js` برای nonce style، header/meta یکسان، marker `X-Taranom-Safe-HTML: 1` و sandbox.
- سند چاپ فقط اجازهٔ script دقیق `/print-page.js` بدون query/hash دارد.
- `CSP.openVerifiedServerDocument` روی same-origin، marker، content-type، header=meta، directive set دقیق، nonce و markup fail-closed است.
- CDN دوربین barcode حذف شده؛ `BarcodeDetector` بومی + USB/manual fallback باقی است.

**نکتهٔ مهم:** در `server/server.js` مقدار زیر عمدی و با Chrome واقعی تست شده است:

```js
frameSrc: ["'self'", 'blob:']
```

`'self'` به‌تنهایی Blob iframe چاپ/اسکرین‌شات invoice را block می‌کند. remote frame همچنان مجاز نیست؛ این policy را بدون جایگزین تست‌شده به `none` برنگردان.

خروجی گزارش‌شدهٔ agent این بخش:

- `test-csp-dom-xss.js`: PASS برای 17 source عمومی + 5 مولد HTML.
- `test-csp-browser.js`: `15/15 PASS` روی Chrome نصب‌شدهٔ Windows.
- `test-secure-html-response.js`: `10/10 PASS`.
- syntax assetهای تغییرکرده: PASS.

Root نیز `test-secure-html-response.js` را `10/10` دیده است. بااین‌حال پس از تکمیل auth و هر تغییر UI، هر سه تست را دوباره اجرا کن.

### 4.2 Upload، private media، SSRF و sync file

فایل‌های جدید/کلیدی:

```text
server/lib/upload-policy.js
server/lib/private-uploads.js
server/lib/safe-outbound-request.js
server/sync/multipart-policy.js
server/sync/files.js
server/scripts/test-upload-ssrf-sync-security.js
server/scripts/test-sync-file-security.js
```

کنترل‌های پیاده‌شده:

- uploadها memory-based و دارای سقف تعداد/اندازهٔ فایل و مجموع request هستند.
- filename، extension، declared MIME و magic واقعی با هم اعتبارسنجی می‌شوند.
- تصویر decode/re-encode می‌شود؛ ابعاد/pixel bomb محدود است.
- XLSX از نظر ZIP traversal/bomb، macro و external link بررسی می‌شود.
- PDF فعال/رمزشده/object-stream محافظه‌کارانه رد می‌شود.
- ذخیرهٔ private با نام تصادفی، `wx`، mode محدود و cleanup در شکست DB انجام می‌شود.
- `PRIVATE_UPLOADS_DIR` باید خارج از `server/public` باشد.
- دسته‌های `messages/vouchers/reps/rubika` private هستند؛ `/uploads` عمومی فقط تصویر محصول با basename امن را می‌دهد.
- legacy private file در اولین دسترسی به root خصوصی migrate می‌شود؛ guard عمومی جلوی bypass را می‌گیرد.
- sync file فقط برای filename واقعاً referenced در DB کار می‌کند و پاسخ unauthorized/not-found یکنواخت است.
- SSRF فقط HTTPS روی 443، DNS تماماً public، IP pin، redirect revalidation و حذف credential header در redirect را می‌پذیرد.

شواهدی که Root مستقیماً دیده است:

- `node server/scripts/test-upload-ssrf-sync-security.js` → `55/55 PASS`.
- `node server/scripts/test-sync-file-security.js` → `19/19 PASS`.

مورد باقی‌مانده برای P0-C: کل `PRIVATE_UPLOADS_ROOT` و زیرپوشهٔ `sync-pending` و همچنین legacy private directoryهای هنوز migrate‌نشده باید در backup امن پوشش داده شوند.

### 4.3 Secret settings و رمزنگاری در حالت سکون

فایل‌های اصلی:

```text
server/services/crypto.js
server/lib/secret-settings.js
server/ecosystem.config.js
server/routes/settings.js
server/routes/sms-module.js
server/routes/moadian.js
server/services/ai.js
server/lib/rubika.js
server/lib/sms-dispatch.js
server/lib/website-stock-sync.js
server/lib/portal-users.js
server/sms.js
server/scripts/test-secret-settings-security.js
```

کنترل‌های پیاده‌شده:

- envelope نسخه‌دار `enc:v2` با AES-256-GCM، nonce تصادفی و purpose-bound AAD.
- `DATA_ENCRYPTION_KEY` مستقل از JWT؛ production بدون آن fail-fast می‌شود.
- migration خودکار plaintext تاریخی و envelope قدیمی مبتنی بر JWT به v2.
- tamper، wrong key، wrong purpose و envelope ناشناخته fail-closed هستند.
- API هیچ secret plaintext برنمی‌گرداند؛ mask `********` و `<key>_has_value` می‌دهد.
- ارسال mask/blank مقدار قبلی را حفظ می‌کند؛ فقط `null` پاک‌کردن صریح است.
- consumerهای SMS، Woo/webhook، Rubika، AI، Moadian و backup fallback به helper مرکزی منتقل شده‌اند.
- لاگ‌های provider که احتمال credential leak داشتند حذف/عمومی شده‌اند.
- `.gitignore` شامل `server/data-encryption-key.txt` و `server/private-uploads/` شده است.

خروجی گزارش‌شدهٔ agent:

- secret settings: `37/37 PASS`.
- SMS: `22/22 PASS`.
- B2B در همان snapshot: `34/34 PASS`.
- syntax: `19/19 PASS`.
- `git diff --check`: PASS.

### rollout اجباری secret settings — فعلاً اجرا نکن

قبل از هر restart/deploy production:

1. ops یک `DATA_ENCRYPTION_KEY` مستقل حداقل 32-byte را خارج از Git provision و backup کند.
2. همان `JWT_SECRET` فعلی حفظ شود.
3. برنامه ابتدا با data key جدید و JWT فعلی در staging/maintenance بالا بیاید.
4. دسترسی admin به settings/migration test اجرا شود تا plaintext و legacy envelopeها به v2 تبدیل شوند.
5. ciphertextها و سلامت consumerها بررسی شوند.
6. فقط پس از پایان migration می‌توان JWT را جداگانه rotate کرد.

هیچ مقدار واقعی را در docs/chat/log ننویس.

### 4.4 حذف رمز قابل‌حدس پورتال

در `server/lib/portal-users.js` رمز ثابت `12345` حذف شد:

- رمز اولیه همیشه با CSPRNG و 14 کاراکتر دارای upper/lower/digit ساخته می‌شود.
- در مسیر بدون SMS حتی temp password به caller داخلی برگردانده نمی‌شود.
- کاربر بدون SMS باید password recovery تأییدشده یا reset مدیر را انجام دهد.
- متن‌های `server/public/app.js` و `server/public/portal-ui.js` اصلاح شدند.
- `server/scripts/test-portal.js` برای رد `12345/admin123` و عدم افشای temp password اصلاح شد.

**وضعیت تست:** اجرای قبل از اصلاح harness برابر `37 pass / 26 fail` بود؛ failureهای workflow به این علت بود که test هنوز JWT خام بدون server-side sid می‌ساخت. Harness سپس به `issueStaffSession(...)` تغییر کرد، اما بعد از این patch دوباره اجرا نشد. Cursor باید test را rerun و هر regression واقعی را رفع کند.

---

## 5) P0-S3 احراز هویت/نشست/sync — کد زیاد نوشته شده ولی Gate هنوز باز است

این بخش در زمان درخواست handoff متوقف شد. **آن را completed فرض نکن.** Agent فایل‌ها را نوشته و چند تست را اجرا کرده، ولی آخرین تغییرات tenant/recovery به‌طور یکپارچه تأیید نشده‌اند.

### پیاده‌سازی فعلی

```text
server/lib/security.js
server/lib/auth-sessions.js
server/lib/company-switch-guard.js
server/middleware/auth.js
server/routes/auth.js
server/routes/b2b.js
server/routes/twofa.js
server/routes/companies.js
server/db.js
server/sync/device-auth.js
server/sync/capture.js
server/sync/client.js
server/routes/sync.js
```

- حذف JWT fallback و الزام secret قوی در production.
- CORS با Origin دقیق و HTTPS-only در production.
- staff/B2B session پایدار با sid تصادفی و ذخیرهٔ hash در DB جدا.
- issuer/audience مجزا و binding به `company_id` و `auth_epoch`.
- challenge یک‌بارمصرف 2FA و cleanup دوره‌ای.
- Bearer parser دقیق و انتقال `next()` بیرون `try/catch`.
- login ضد user-enumeration با dummy bcrypt.
- persistent rate-limit بر اساس identity و IP؛ login موفق فقط identity bucket را پاک می‌کند.
- bootstrap دیتابیس production تازه فقط با `BOOTSTRAP_ADMIN_PASSWORD` قوی و بدون چاپ رمز.
- recovery code جدید با HMAC و prefix `h1:`؛ migration/consume یک‌بارهٔ SHA-256 قدیمی.
- company switch guard برای drain درخواست‌ها، revoke نشست‌ها و rollback registry/DB handle.
- Ed25519 device attestation برای replay؛ canonical envelope شامل device/seq/method/path/user/body/file hash/field.
- capture failure دیگر 2xx خاموش نیست؛ `503 / SYNC_CAPTURE_REPAIR_QUEUED` و repair queue پایدار دارد.

### تست‌هایی که agent پیش از آخرین تغییرات یا در snapshotهای میانی گزارش کرده است

- auth session migration: `9/9 PASS`.
- auth session cleanup: `8/8 PASS`.
- middleware downstream error flow: `1/1 PASS`.
- production bootstrap admin: `3/3 PASS`.
- sync replay attestation: `8/8 PASS`.
- sync capture repair: `2/2 PASS`.
- auth session security: `44/44 PASS`، اما قبل از آخرین تغییرات tenant/recovery.
- B2B: `30/30 PASS` در snapshot قبل؛ secret agent بعداً `34/34` گزارش کرد، ولی root rerun نداشت.
- login-rate persistence یک‌بار `4/4 PASS` گزارش شده، اما پس از تغییرات بعدی regression زیر دیده شد.

### failureها و کارهای دقیق باقی‌مانده

1. **Regression فعلی مهم:** valid login در آخرین اجرای یکپارچه `HTTP 500` داده است. علت نهایی و رفع تأیید نشده است. خروجی body/stderr را در test نمایان کن و root cause را رفع کن؛ test قبلی سبز را دلیل سلامت current tree ندان.
2. `test-company-switch-safety.js` ساخته شده ولی اجرا نشده:
   - وقتی request دیگری فعال است، switch باید `COMPANY_SWITCH_BUSY` بدهد و registry/DB دست‌نخورده بماند.
   - failure تزریقی در بازکردن DB مقصد باید registry و live handle را کامل rollback کند.
3. `test-cross-company-session-isolation.js` ساخته شده ولی اجرا نشده؛ numeric user/account id یکسان بین شرکت‌ها نباید token/session را قابل استفاده کند.
4. این queryها را به‌جای اتکا به random id، صریحاً با `company_id` محدود و تست کن:
   - `failLoginChallenge`
   - `consumeLoginChallenge`
   - `revokeCurrentB2BSession`
5. شرط‌های `UPDATE staff_sessions` و mirror `DELETE user_device_sessions` اکنون `company_id` دارند؛ regression cross-company availability را تست کن.
6. تست recovery-code برای HMAC جدید، timing-safe compare، legacy migration و حذف کد مصرف‌شده هنوز افزوده/اجرا نشده است.
7. full sync آخرین بار `43/44 PASS` بود؛ failure conflict-discard به internal replay header مربوط بود. کد اصلاح شده اما suite rerun نشده است.
8. `test-auth-session-security.js` و `test-b2b.js` بعد از آخرین تغییرات باید دوباره اجرا شوند.
9. تمام مسیرهای تغییر role/password/disable/delete باید session staff/B2B مرتبط را revoke کنند و تست منفی داشته باشند.
10. bootstrap production را روی DB موجود و DB تازه جدا تست کن؛ existing production نباید reset شود.
11. company switch guard را از نظر request drain، timeout و عدم lock دائمی پس از exception بررسی کن.
12. sync capture repair باید دقیقاً یک outbox signed بسازد؛ failure queue نباید duplicate یا replay بدون proof ایجاد کند.

---

## 6) ترتیب و فرمان‌های الزامی برای بستن P0-S3

همه را از root مخزن اجرا کن. sync و serverهای portدار را **سریالی** اجرا کن. اگر یک test fail شد، ادامهٔ فاز را متوقف و همان failure را رفع کن؛ exit code را با command chain مخفی نکن.

### syntax/diff

```powershell
git diff --check
node --check server/server.js
node --check server/lib/auth-sessions.js
node --check server/lib/company-switch-guard.js
node --check server/lib/secret-settings.js
node --check server/lib/secure-html-response.js
node --check server/lib/upload-policy.js
node --check server/lib/safe-outbound-request.js
node --check server/middleware/auth.js
node --check server/routes/auth.js
node --check server/routes/b2b.js
node --check server/routes/twofa.js
node --check server/routes/companies.js
node --check server/routes/sync.js
node --check server/sync/capture.js
node --check server/sync/client.js
node --check server/public/csp-runtime.js
node --check server/public/app.js
```

### auth/session/company

```powershell
node server/scripts/test-auth-session-migration.js
node server/scripts/test-auth-session-cleanup.js
node server/scripts/test-auth-middleware-error-flow.js
node server/scripts/test-auth-login-rate-persistence.js
node server/scripts/test-production-bootstrap-admin.js
node server/scripts/test-auth-session-security.js
node server/scripts/test-company-switch-safety.js
node server/scripts/test-cross-company-session-isolation.js
node server/scripts/test-b2b.js
node server/scripts/test-portal.js
```

### sync/upload/private/SSRF

```powershell
node server/scripts/test-sync-replay-attestation.js
node server/scripts/test-sync-capture-repair.js
node server/scripts/test-upload-ssrf-sync-security.js
node server/scripts/test-sync-file-security.js
node server/scripts/test-sync-tls-url.js
node server/scripts/test-sync.js
```

### secrets/CSP/browser

```powershell
node server/scripts/test-secret-settings-security.js
node server/scripts/test-sms.js
node server/scripts/test-secure-html-response.js
node server/scripts/test-csp-dom-xss.js
node server/scripts/test-csp-browser.js
```

### P0-S2 regression

```powershell
node scripts/test-platform-security.js
node scripts/test-android-platform-security.js
node desktop/scripts/test-security-policy.js
node desktop/scripts/test-local-secret-store.js
node desktop/scripts/test-main-hardening-static.js
node server/scripts/test-local-secret-at-rest.js
node server/scripts/test-app-update.js
node server/scripts/test-release-artifact-integrity.js
```

پس از سبزشدن همه:

- `docs/.plans/260801-wave0-critical-path/P0-S3-web-api-security.md` را از حالت ناقص خارج کن.
- ورودی P0-S3 را بالای `docs/CHANGE-LOG.md` اضافه کن.
- `SUMMARY.md` و `WAVE0-GATE-STATUS.md` را با عدد واقعی تست‌ها به‌روز کن.
- فقط سپس وارد P0-C شو.

---

## 7) P0-C — کار بعدی: backup/restore/DR را از نو harden کن

`server/backup.js` فعلی فقط یک patch کوچک برای خواندن secret setting گرفته و طراحی قدیمی آن هنوز برای Gate واقعی کافی نیست. اسناد قبلی بیش از واقعیت آن را complete نشان می‌دهند.

### نقص‌های قطعی backup فعلی

- فقط DB شرکت فعال را snapshot می‌کند؛ تمام DBهای registry را پوشش نمی‌دهد.
- فقط `UPLOADS_ROOT` عمومی را می‌گیرد؛ `PRIVATE_UPLOADS_ROOT` و `sync-pending` جدید را از دست می‌دهد.
- encryption اختیاری است و حتی production می‌تواند backup plaintext بسازد.
- backup password می‌تواند داخل همان business DB ذخیره شود؛ استقلال کلید از VPS/DB رعایت نمی‌شود.
- retention فقط count-based حدود 14 فایل است و sidecar/latest orphan ممکن است باقی بماند.
- live restore endpoint روی process فعال DB را overwrite می‌کند و safe/atomic نیست.
- extraction archive قدیمی سطح حملهٔ traversal/zip bomb دارد.
- offsite filesystem فقط متفاوت‌بودن path را چک می‌کند، نه host/device/volume متفاوت.
- مسیر موجود `/home/taranom/crm-offsite-backups` ظاهراً روی همان VPS است؛ این **off-server واقعی نیست** و نباید Gate را سبز کند مگر mount مستقل/NAS/host دوم اثبات شود.
- S3 sidecar upload/download verification و نتیجهٔ هر مرحله کامل کنترل نمی‌شود.
- status پایدار، alert شکست، disk monitor و weekly isolated restore drill واقعی ندارد.
- fingerprint مالی/تعداد فاکتور/مشتری/trial balance قبل و بعد restore ثبت و مقایسه نمی‌شود.

### طراحی پیشنهادی/معیار پذیرش P0-C

1. فرمت backup نسخه‌دار و authenticated بساز؛ کل package قبل از خروج AES-256-GCM شود. کلید backup باید مستقل از `JWT_SECRET` و `DATA_ENCRYPTION_KEY` و خارج از VPS باشد. production بدون کلید یا مقصد off-server fail-closed شود.
2. از registry تمام شرکت‌ها را بخوان و برای هر DB snapshot WAL-safe با `better-sqlite3.backup()` بساز؛ registry portable و pathهای مطلق را به logical path امن تبدیل کن.
3. موارد زیر را package کن:
   - snapshot تمام company DBها؛
   - registry و metadata لازم؛
   - public product images؛
   - تمام `PRIVATE_UPLOADS_ROOT` شامل messages/vouchers/reps/rubika؛
   - `sync-pending`؛
   - legacy private uploadهایی که هنوز migrate نشده‌اند.
4. session DB، local device secret، JKS/PFX، env، logs، node_modules و binaries را backup نکن.
5. manifest شامل release id، timestamp، company id/name/code، relative path، size و SHA-256 تک‌تک فایل‌ها باشد.
6. برای هر DB `integrity_check` و fingerprint کسب‌وکار ثبت کن: حداقل invoice count، customer count، journal count و trial-balance debit/credit/balance.
7. verify ابتدا GCM/tag و hash/size/path limits را چک کند، سپس DBها را readonly باز و integrity/fingerprint را مقایسه کند؛ wrong key/tamper/truncation/path traversal/duplicate path/oversize باید fail-closed باشند.
8. API آنلاین `/api/admin/backup-restore` فقط upload+**verify** انجام دهد؛ restore واقعی فقط با CLI maintenance/offline، service-stopped confirmation و targetهای صریح انجام شود.
9. restore ابتدا staging dir امن با permission محدود بسازد، pre-restore recovery copy بگیرد، همه‌چیز را verify کند و سپس atomic swap انجام دهد؛ failure باید سیستم قبلی را سالم نگه دارد.
10. full restore و single-company restore هر دو پشتیبانی شوند؛ بعد از restore sessionها revoke و device policy طبق runbook اعمال شود.
11. retention پیشنهادی GFS: تمام 15 دقیقه‌ای‌های 24 ساعت، روزانه 31، هفتگی 12، ماهانه 12؛ archive/sidecar/status همیشه با هم prune شوند.
12. offsite:
    - ترجیح S3-compatible روی host مستقل؛ archive+manifest/checksum آپلود و یک نمونه download+verify شود.
    - filesystem فقط وقتی device/volume مستقل اثبات شود؛ same-device production رد شود. override فقط در test.
13. backup lock برای جلوگیری از overlap، atomic temp→rename، latest pointer امن و cleanup tempهای crash‌شده.
14. status JSON پایدار: started/succeeded/failed، duration، size، checksum، offsite result، latest age، disk free و آخرین drill.
15. alert در failure، backup قدیمی‌تر از 20 دقیقه، disk free زیر threshold و drill هفتگی missing/failed.
16. weekly isolated restore از **نسخهٔ offsite** انجام و نتیجه/RTO/fingerprint ثبت شود؛ به DB production دست نزند.

### فایل‌های محتمل P0-C

```text
server/backup.js
server/server.js
server/scripts/test-backup-dr.js
server/scripts/restore-backup.js          # پیشنهاد: CLI offline
server/scripts/verify-backup.js           # پیشنهاد
server/lib/backup-package.js              # پیشنهاد
server/package.json
docs/DR-RUNBOOK.md
docs/.plans/260801-wave0-critical-path/P0-C-backup-restore.md
docs/CHANGE-LOG.md
docs/.plans/260801-wave0-critical-path/SUMMARY.md
docs/WAVE0-GATE-STATUS.md
```

### تست‌های P0-C که باید اضافه/سبز شوند

- multi-company: همهٔ DBها و registry بازیابی شوند.
- private media و `sync-pending` دقیقاً با hash یکسان برگردند.
- active WAL writes در snapshot consistency ایجاد نکنند.
- tamper، wrong key، truncated package، path traversal، symlink و duplicate path رد شوند.
- fingerprint مالی و counts قبل/بعد برابر باشند.
- live restore API نتواند production DB را overwrite کند.
- offline restore failure rollback کامل داشته باشد.
- same-device filesystem در production رد شود.
- S3 upload failure، sidecar failure و download mismatch backup را failed کنند.
- GFS retention و sidecar pruning قطعی باشند.
- weekly drill از offsite و RTO اندازه‌گیری شود.

تا این acceptanceها سبز نشده‌اند، P0-C را `[x]` نکن.

---

## 8) P0-Q1/Q2 — تست، dependency و CI/CD

P0-Q قبلی partial است؛ CI فعلی فقط login Playwright و چند suite پایه دارد.

### 8.1 حذف waiver امنیتی `xlsx`

- در snapshot فعلی `82` استفادهٔ `XLSX.*` در server وجود دارد.
- `xlsx` در server، desktop و embedded Android dependency است و advisory بدون fix منتشرشده دارد.
- آن را به `exceljs` مهاجرت بده؛ فقط package را عوض نکن، رفتار import/export و workbook security را تست کن.
- فایل‌های runtime و اسکریپت‌های Mahak را inventory کن؛ helper مشترک برای cell/range/date/number/formula بساز.
- external links، formulas، macros/active content، oversized sheets و zip bombs همچنان باید policy امن داشته باشند.
- پس از migration، `xlsx` را از همهٔ package/lockها و waiver حذف و `npm audit` را دوباره اجرا کن.
- embedded allowlist/hash را پس از dependency/source تغییر به‌روز کن.

### 8.2 Test pyramid

- همهٔ تست‌های P0-S3 و P0-C بالا را در CI jobهای جدا با timeout و artifact log اضافه کن.
- Playwright فقط login کافی نیست؛ حداقل این مسیرهای critical را پوشش بده:
  - login/forced password/2FA/logout-all؛
  - invoice create/finalize/payment/void و تراز سند؛
  - خرید/موجودی/انتقال و عدم موجودی منفی؛
  - role/RBAC/IDOR و cross-company؛
  - portal/B2B login و دسترسی tenant؛
  - private attachment access؛
  - sync offline→reconnect→conflict/retry؛
  - backup verify/drill.
- migration test را روی DB قدیمی fixture و DB تازه اجرا کن.
- production suite را پس از تغییرات حداقل یک‌بار کامل اجرا کن؛ P0-A قبلاً ×3 سبز شده و تکرار ×3 فقط اگر code production core تغییر کرده باشد.

### 8.3 CI/CD

- `.github/workflows/wave0-gate.yml` را با CSP browser، auth/session، upload/SSRF، secrets، P0-C و Excel migration گسترش بده.
- هر pipeline باید exit code واقعی test را حفظ کند و log را `if: always()` artifact کند.
- CodeQL/dependency review/secret scan یا معادل read-only اضافه کن.
- artifactهای source/manifest/SBOM/checksum versioned و immutable باشند؛ binary build فعلاً ممنوع است.
- staging workflow و production approval/rollback را می‌توان تعریف کرد، ولی job deploy را disabled/manual نگه دار تا کاربر صریح اجازه دهد.
- production environment باید protected/manual approval داشته باشد؛ direct deploy از branch ممنوع.
- rollback باید به artifact دقیق قبلی + DB pre-backup سازگار اشاره کند.

### acceptance P0-Q

- CI روی PR/branch سبز و همهٔ jobها timeout دارند.
- failure log قابل دانلود است.
- embedded drift عمداً با mismatch fail می‌شود.
- high/critical dependency بدون waiver معتبر صفر است؛ waiver `xlsx` حذف شده است.
- critical financial/tenant/browser paths اتوماتیک هستند.
- هیچ deploy واقعی در جریان آزمون انجام نشده است.

---

## 9) P0-B را در پایان دوباره هم‌تراز کن

به‌دلیل اضافه‌شدن assetهای CSP و تغییر server source، embedded copies فعلی باید دوباره prepare شوند. **APK/EXE build لازم نیست.**

```powershell
node scripts/prepare-embedded-server.js all
node scripts/compare-embedded-hash.js
node scripts/test-embedded-release.js
node scripts/test-platform-security.js
```

انتظار: تعداد file هر دو target یکسان و SHA-256 drift صفر. generated embedded folders طبق pipeline مدیریت شوند؛ دستی copy نکن.

---

## 10) وضعیت امضا و release boundary

طبق `docs/WAVE0-SIGNING-HANDOFF-GPT.md`:

- APK `2.0.32 / versionCode 34` با JKS محلی جدید امضا و `apksigner verify` شده است.
- SHA-256 خروجی امضاشدهٔ موجود: `CF60CF86B49508721C7E70986996514734902CE0AE423B3C73800B38257F0C90`.
- EXE installer `2.0.9` با PFX خودامضا روی PC build و Authenticode محلی `Valid` شده است.
- SHA-256 خروجی موجود: `940922969311FA7D187C7638E2A912A204F0989149B1F3BC2C2719B80A866C22`.
- گواهی تجاری OV/EV ویندوز هنوز وجود ندارد؛ SmartScreen روی PC دیگر ممکن است Unknown Publisher نشان دهد.
- چون JKS عوض شده، upgrade روی نصب Android قدیمی ممکن است یک‌بار uninstall/reinstall بخواهد.

اما این binaryها **قبل از P0-S2/P0-S3 فعلی ساخته شده‌اند**. پس از بسته‌شدن Wave 0، RC نهایی باید با source نهایی دوباره build/sign/verify شود؛ فقط با اجازهٔ صریح کاربر. سپس update E2E موفق و رد unsigned fallback با `REQUIRE_SIGNED_UPDATES=1` تست شود.

---

## 11) اسناد و گزارش نهایی مورد انتظار

پس از هر فاز:

1. plan همان فاز را با checkbox و عدد واقعی test به‌روز کن.
2. `SUMMARY.md` را به‌روز کن.
3. ورودی جدید را بالای تاریخچهٔ `CHANGE-LOG.md` اضافه کن.
4. `WAVE0-GATE-STATUS.md` را بدون خوش‌بینی کاذب به‌روز کن؛ same-VPS directory را off-server حساب نکن.
5. در پایان `EXECUTION-REPORT.md` بساز که شامل این‌ها باشد:
   - commit/branch؛
   - تغییرات هر فاز؛
   - جدول command، pass/fail، count و مدت؛
   - waivers/ops blockers؛
   - deploy/build انجام‌نشده؛
   - فهرست artifact/checksum؛
   - rollback و rollout prerequisites.

### تصمیم Gate

Wave 0 فقط وقتی complete است که:

- P0-S3 current tree بدون login 500 و با تمام تست‌های امنیت/tenant/sync سبز باشد؛
- backup واقعاً encrypted، multi-company، off-server و restore-drilled باشد؛
- full/critical suite و CI سبز باشد؛
- drift صفر باشد؛
- dependency high/critical بدون waiver باز نماند؛
- signed final RC و production rollout هنوز طبق اجازهٔ کاربر جداگانه انجام شوند.

---

## 12) وضعیت دقیق در لحظهٔ تحویل

| بخش | وضعیت |
|---|---|
| P0-B قبلی | کامل؛ ولی prepare/hash نهایی پس از تغییرات جدید لازم است |
| P0-S1 | قبلاً کامل؛ sync regression نهایی لازم است |
| P0-S2 source | کامل و مستند |
| P0-S3 CSP/upload/secrets | پیاده‌سازی زیاد و تست‌های بخشی سبز؛ rerun یکپارچه لازم |
| P0-S3 auth/session/company/sync | **باز و uncertified**؛ login 500 و تست‌های نهایی بالا باید حل شوند |
| Portal default password | کد اصلاح شده؛ test کامل rerun نشده |
| P0-C | طراحی قدیمی ناکافی؛ اجرای کامل طبق بخش 7 لازم |
| P0-Q1/Q2 | partial؛ ExcelJS، E2E و CI کامل لازم |
| Docs P0-S3/C/Q | تا Gate واقعی سبز نشده، completed علامت نخورد |
| Commit/push این نوبت | انجام نشده |
| Deploy ایران | انجام نشده و ممنوع |
| Full APK/EXE build | انجام نشده و ممنوع مگر دستور صریح |

پایان handoff.
