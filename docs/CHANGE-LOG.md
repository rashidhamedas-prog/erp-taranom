# ┘ä╪º┌» ╪¬╪║█î█î╪▒╪º╪¬ ╪º╪╣┘à╪º┘äΓÇî╪┤╪»┘ç ΓÇö ERP ╪¬╪▒┘å┘à

╪º█î┘å ┘ü╪º█î┘ä ╪¬╪º╪▒█î╪«┌å┘ç┘ö ╪¬╪║█î█î╪▒╪º╪¬█î ╪▒╪º ┌⌐┘ç ╪»╪▒ Cursor / Claude Code ╪º╪╣┘à╪º┘ä ╪┤╪»┘ç ┘å┌»┘ç ┘à█îΓÇî╪»╪º╪▒╪».
**┘é╪¿┘ä ╪º╪▓ ╪┤╪▒┘ê╪╣ ┌⌐╪º╪▒ ╪¼╪»█î╪»╪î ╪º█î┘å ┘ü╪º█î┘ä ╪▒╪º ╪¿╪«┘ê╪º┘å█î╪»** ╪¬╪º ╪¿╪»╪º┘å█î╪» ┌å┘ç ┌å█î╪▓┘ç╪º█î█î ┘é╪¿┘ä╪º┘ï ╪º┘å╪¼╪º┘à ╪┤╪»┘ç ╪º╪│╪¬.

---

## ┘é╪º┘å┘ê┘å ╪¿╪▒╪º█î ╪»╪│╪¬█î╪º╪▒ (Cursor / Claude Code)

╪¿╪╣╪» ╪º╪▓ **┘ç╪▒ ╪¬╪│┌⌐** ┌⌐┘ç ┌⌐╪» █î╪º ╪¬┘å╪╕█î┘à╪º╪¬ ┘╛╪▒┘ê┌ÿ┘ç ╪▒╪º ╪╣┘ê╪╢ ┘à█îΓÇî┌⌐┘å╪»:

1. █î┌⌐ ┘ê╪▒┘ê╪»█î ╪¼╪»█î╪» ╪»╪▒ **╪¿╪º┘ä╪º█î ╪¿╪«╪┤ ┬½╪¬╪º╪▒█î╪«┌å┘ç┬╗** (╪▓█î╪▒ ╪º█î┘å ┘é┘ê╪º┘å█î┘å) ╪º╪╢╪º┘ü┘ç ┌⌐┘å.
2. commit ┘à╪▒╪¿┘ê╪╖┘ç ╪▒╪º ╪¿┘å┘ê█î╪│ (╪º┌»╪▒ commit ╪┤╪»┘ç).
3. ┘ê╪╢╪╣█î╪¬ deploy ╪▒┘ê█î ╪│╪▒┘ê╪▒ production (`45.90.98.99`) ╪▒╪º ┘à╪┤╪«╪╡ ┌⌐┘å: `Γ£à deploy ╪┤╪»┘ç` / `ΓÅ│ ┘å█î╪º╪▓ ╪¿┘ç pull` / `Γ¥î ╪º╪╣┘à╪º┘ä ┘å╪┤╪»┘ç`.

### 2026-08-19 — POS-01/02 dual APPROVED merge (Iran SFTP next)
- **شاخه:** `ai/UI-STITCH-IMPL` ← `ai/POS-STITCH-P8` @ `7cab828`
- **خلاصه:** پایانه SQLite با بانک فعال؛ دریافت به وجوه در راه ۱۱۱۸؛ تسویه دسته‌ای به بانک. Independent + Security محصول APPROVED. SW v165.
- **Deploy:** در جریان (SFTP overlay؛ `db.js` کامل جایگزین نمی‌شود)

### 2026-08-19 — POS Independent APPROVED (pre-merge)
- **شاخه:** `ai/POS-STITCH-P8` @ `7cab828`
- **خلاصه:** Independent تأیید کرد.
- **Deploy:** اعمال نشد (pre-merge)

### 2026-08-19 — POS-01/02 implementer (pre-merge)
- **شاخه:** `ai/POS-STITCH-P8` @ `7cab828`
- **خلاصه:** پایانه با بانک فعال؛ دریافت به وجوه در راه؛ تسویه دسته‌ای به بانک. تست ۵۵/۵۵. SW v165.

### 2026-08-19 — CON-01/02 dual APPROVED + Iran SFTP ✅
- **شاخه primary:** `claude/claude-md-docs-2ssrpy` @ `1a1bf0f` (از `ai/CON-STITCH-P7` @ `f79127c`)
- **خلاصه:** شخص اجباری، چهار مسیر تسویه، خریدار جدا، COGS ارسالی، FK سینک. Independent + Security APPROVED.
- **Deploy:** ✅ SFTP overlay به `taranom@94.249.244.208`. `db.js` کامل جایگزین نشد — پچ ستون‌های امانی. `pm2 restart erp-taranom` بدون `--update-env`. health/ready/root **200**. stamp `.sftp-deploy-stamp-stitch-v164` = `2026-08-19T02:33:45Z hash=1a1bf0f`.
- **SW:** `erp-taranom-v164`
- **تست:** CON-P7 **61/61** · SMS **22/22**

### 2026-08-19 — CON-01/02 dual APPROVED merge (Iran SFTP next)
- **شاخه:** `ai/UI-STITCH-IMPL` ← `ai/CON-STITCH-P7` @ `f79127c`
- **خلاصه:** شخص اجباری، چهار مسیر تسویه، خریدار جدا، COGS ارسالی، FK سینک. Independent + Security APPROVED. SW v164.
- **Deploy:** در جریان (SFTP overlay؛ `db.js` کامل جایگزین نمی‌شود)

### 2026-08-19 — CON Security APPROVED on f79127c
- **شاخه:** `ai/CON-STITCH-P7` @ `f79127c`
- **خلاصه:** امنیت C0/H0/M0 روی اصلاح M1–M3.
- **Deploy:** اعمال نشد (pre-merge)

### 2026-08-19 — CON M1–M3 fix (pre-merge)
- **شاخه:** `ai/CON-STITCH-P7` @ `f79127c`
- **خلاصه:** خریدار جدا برای فروش دریافتی؛ COGS فروش ارسالی؛ FK سینک. تست ۶۱/۶۱.
- **Deploy:** اعمال نشد

### 2026-08-19 — CON Independent CHANGES_REQUIRED M1–M3
- **شاخه:** `ai/CON-STITCH-P7` @ `ca6f5a2`
- **خلاصه:** فروش دریافتی طرف غلط؛ فروش ارسالی بدون COGS؛ FK سینک ناقص. اصلاح شد روی `f79127c`.
- **Deploy:** اعمال نشد

### 2026-08-19 — CON-01/02 Security APPROVED (pre-merge)
- **شاخه:** `ai/CON-STITCH-P7` @ `ca6f5a2`
- **خلاصه:** امنیت C0/H0/M0. منتظر Independent.
- **Deploy:** اعمال نشد

### 2026-08-19 — CON-01/02 implementer (pre-merge)
- **شاخه:** `ai/CON-STITCH-P7` @ `ca6f5a2`
- **خلاصه:** طرف‌حساب شخص، چهار مسیر تسویه، فقط فروش فاکتور. تست ۴۷/۴۷. SW v164.

### 2026-08-19 — HR+INV+TRS merge + Iran SFTP ✅
- **شاخه primary:** `claude/claude-md-docs-2ssrpy` @ `02872a5`
- **خلاصه:** دعوت امن، رنگ hex، جستجوی انبار ATP، پرداخت/خرج چک پس از dual APPROVED merge و deploy شد.
- **Deploy:** ✅ SFTP overlay به `taranom@94.249.244.208`. `db.js` کامل جایگزین نشد — پچ `user_invitations`. `pm2 restart erp-taranom` بدون `--update-env`. health/ready/root **200**. stamp `.sftp-deploy-stamp-stitch-v163` = `2026-08-19T01:34:41Z hash=02872a5`.
- **SW:** `erp-taranom-v163`
- **تست:** invite 51/51 · obs 12/12 · inv-p4 25/25 · cheque-out 36/36 · SMS 22/22

### 2026-08-19 — HR-02 dual APPROVED; merging HR+INV+TRS
- **شاخه:** `ai/HR-STITCH-P3` @ `6c65660` + `ai/INV-STITCH-P4` @ `d1ea078` + `ai/TRS-STITCH-P6` @ `ca4e22a`
- **خلاصه:** Independent نقش و لاگ APPROVED. rebase سه موج سپس deploy ایران.
- **Deploy:** در جریان

### 2026-08-19 — HR-02 Security APPROVED on 6c65660 (pre-merge)
- **شاخه:** `ai/HR-STITCH-P3` @ `6c65660`
- **خلاصه:** امنیت C0/H0/M0 برای لاگ و نقش دعوت. منتظر Independent.
- **Deploy:** اعمال نشد

### 2026-08-19 — HR-02 log M1 dual APPROVED (pre-merge)
- **شاخه:** `ai/HR-STITCH-P3` @ `fdb39ae` (جد فعلی `6c65660`)
- **خلاصه:** توکن دعوت در لاگ مسیر پاک شد. Independent و Security APPROVED. merge بعد از تأیید نقش روی `6c65660`.
- **Deploy:** اعمال نشد

### 2026-08-19 — HR-02 intended_role (pre-merge)
- **شاخه:** `ai/HR-STITCH-P3` @ `6c65660`
- **خلاصه:** نقش دعوت ذخیره می‌شود؛ مدیر ساخته نمی‌شود. تست ۵۱/۵۱. SW v162. منتظر re-review.
- **Deploy:** اعمال نشد

### 2026-08-19 — INV-02/03 dual APPROVED (pre-merge)
- **شاخه:** `ai/INV-STITCH-P4` @ `d1ea078`
- **خلاصه:** Independent و Security هر دو APPROVED. منتظر HR و rebase.
- **Deploy:** اعمال نشد

### 2026-08-19 — HR-02 Independent: نقش ثابت field_sales (M1)
- **شاخه:** `ai/HR-STITCH-P3` @ `fdb39ae` (بازبینی روی `bc6b975`)
- **خلاصه:** دعوت نباید همه را کارشناس فروش کند. نقش از فهرست مجاز در ساخت دعوت. اصلاح در جریان.
- **Deploy:** اعمال نشد

### 2026-08-19 — HR-02 M1 log-redact (pre-merge)
- **شاخه:** `ai/HR-STITCH-P3` @ `fdb39ae`
- **خلاصه:** توکن خام دعوت از `path` لاگ حذف شد. تست دعوت ۳۸/۳۸ و observability ۱۲/۱۲. منتظر re-review Independent.
- **Deploy:** اعمال نشد

### 2026-08-19 — INV-02/03 implementer (pre-merge)
- **شاخه:** `ai/INV-STITCH-P4` @ `d1ea078`
- **خلاصه:** اعتبار hex رنگ + جستجوی خط انبار با ATP. تست ۲۵/۲۵. منتظر dual review.
- **Deploy:** اعمال نشد

### 2026-08-19 — HR-02 Independent CHANGES_REQUIRED M1; Security APPROVED
- **شاخه:** `ai/HR-STITCH-P3` @ `bc6b975`
- **خلاصه:** امنیت C0/H0/M0. Independent: توکن خام دعوت در لاگ `path` (M1). اصلاح در جریان. merge نشد.
- **Deploy:** اعمال نشد

### 2026-08-19 — TRS-01 dual APPROVED (pre-merge)
- **شاخه:** `ai/TRS-STITCH-P6` @ `ca4e22a`
- **خلاصه:** Independent و Security هر دو APPROVED. منتظر rebase با HR/INV.
- **Deploy:** اعمال نشد

### 2026-08-19 — HR-02 invite tokens implementer (pre-merge)
- **شاخه:** `ai/HR-STITCH-P3` @ `bc6b975`
- **خلاصه:** دعوت یک‌بارمصرف با هش sha256 و انقضای ۷۲ ساعت. تست ۳۷/۳۷. SW v161. منتظر dual review.
- **Deploy:** اعمال نشد

### 2026-08-19 — TRS-01 Security APPROVED (pre-merge)
- **شاخه:** `ai/TRS-STITCH-P6` @ `ca4e22a`
- **خلاصه:** بازبین امنیت C0/H0/M0. Independent هنوز باز است.
- **Deploy:** اعمال نشد
- **SW:** بدون bump تا merge

### 2026-08-19 — UI-STITCH-IMPL merge + Iran SFTP ✅
- **شاخه primary:** `claude/claude-md-docs-2ssrpy` @ `7dd5481` ← FF `ai/UI-STITCH-IMPL`
- **خلاصه:** موج حسابداری Stitch (OPS-01، TRS-02، ACC-01..06، INV-01، ACC-04 cutoff) پس از dual APPROVED merge و deploy شد.
- **Deploy:** ✅ SFTP overlay به `taranom@94.249.244.208:/home/taranom/crm-taranom` (VPS به GitHub نمی‌رسد؛ `db.js` کامل جایگزین نشد — فقط `ensureColumn` معین گروه کالا). `pm2 restart erp-taranom` بدون `--update-env`. health/ready/root **200**. stamp `.sftp-deploy-stamp-stitch-v160` = `2026-08-19T00:19:57Z hash=7dd5481`.
- **SW:** `erp-taranom-v160`
- **Independent:** APPROVED 324293a7 · **Security:** APPROVED e235c782

### 2026-08-19 — Dual APPROVED ACC-04 on 34e1891 (pre-merge)
- **شاخه:** `ai/UI-STITCH-IMPL` محصول `34e1891`
- **خلاصه:** Independent و Security هر دو APPROVED. منتظر تأیید مالک برای merge/deploy.
- **Deploy:** اعمال نشد
- **SW:** `erp-taranom-v160`

### 2026-08-19 — Independent APPROVED ACC-04 on 34e1891 (pre-merge)
- **شاخه:** `ai/UI-STITCH-IMPL` @ `34e1891`
- **خلاصه:** بازبین مستقل H1–H3 و M1–M4 را بست. M5–M7 مشورتی. امنیت روی این نوک هنوز باز است (تأیید قبلی فقط `759a63d`).
- **Deploy:** اعمال نشد — منتظر Security + تأیید مالک برای merge
- **SW:** `erp-taranom-v160`

### 2026-08-18 — ACC-04 cutoff reconcile H1–H3 (بدون deploy ایران)
- **شاخه:** `ai/UI-STITCH-IMPL`
- **خلاصه:** مطالبات و صورت‌حساب در تاریخ قطع از دفتر کل؛ داشبورد `asOf`/`to`؛ مانده انتهای صورت‌حساب تا `to`؛ هشدار اختلاف دفتر مشتری؛ خروجی صورت‌حساب عدد دفتر کل. جستجوی دفتر کل مانده را عوض نمی‌کند. افزودن حساب در هر ستون کدینگ؛ picker دریافت/پرداخت فقط حساب برگ. SW `erp-taranom-v160`.
- **فایل‌های کلیدی:** `server/routes/accounting.js`, `server/public/app.js`, `server/public/sw.js`, `server/public/index.html`, `server/scripts/test-acc-stitch-p2.js`
- **تست:** `test-acc-stitch-p2.js` · `test-portal.js` · `node --check` · encoding
- **Deploy:** ⏭ اعمال نشد — بدون merge/SFTP/PM2 تا تأیید جداگانه مالک
- **SW:** `erp-taranom-v160`

### 2026-08-18 — UI-STITCH-IMPL Security APPROVED (pre-merge)
- **شاخه:** `ai/UI-STITCH-IMPL` @ `759a63d`
- **خلاصه:** بازبین امنیت روی موج حسابداری APPROVED شد (C0/H0/M0). بازبین مستقل هنوز باز است.
- **Deploy:** اعمال نشد — منتظر Independent + تأیید مالک برای merge
- **SW:** `erp-taranom-v159`

### 2026-08-18 — UI-STITCH-IMPL موج حسابداری OPS/TRS/ACC (بدون deploy ایران)
- **شاخه:** `ai/UI-STITCH-IMPL`
- **خلاصه:** باگ زنده OPS-01 (بدون دسترسی پورتال بعد از Reload) و TRS-02 (چک پرداختی پیش‌فرض `direction=out`). ACC-02 KPI پرداختنی از GL؛ ACC-03 دفتر کل دوره/صفحه/جستجو؛ ACC-04 مطالبات از GL + `gl_closing` صورتحساب؛ ACC-05 کدینگ چهارستون؛ ACC-06 سند آبشاری و فقط حساب برگ؛ ACC-01 تفصیلی شخص پایدار؛ INV-01 معین گروه کالا. SW `erp-taranom-v159`.
- **فایل‌های کلیدی:** `server/routes/accounting.js`, `server/routes/parties.js`, `server/routes/product-categories.js`, `server/lib/portal-users.js`, `server/public/app.js`, `server/public/app.css`, `server/public/sw.js`, `server/scripts/test-acc-stitch-p2.js`, `server/scripts/test-portal.js`
- **تست:** `test-acc-stitch-p2.js` · `test-portal.js` · `node --check` · encoding
- **Deploy:** ⏭ اعمال نشد — بدون merge/SFTP/PM2 تا تأیید جداگانه مالک
- **SW:** `erp-taranom-v159`

### 2026-08-15 — DEMO-V3 merge + Iran SFTP ✅
- **شاخه primary:** `claude/claude-md-docs-2ssrpy` @ `bb868c5` ← FF `feat/DEMO-V3-GUIDED-SALES`
- **خلاصه:** نسخه نمایشی فروش‌محور (خوش‌آمد نقش، چهار تور، محیط آزاد، دادهٔ سپیدارگل) روی `/demo.html` عمومی شد.
- **Deploy:** ✅ SFTP overlay به `taranom@94.249.244.208:/home/taranom/crm-taranom` (VPS git کثیف بود؛ pull نشد). `pm2 restart erp-taranom` بدون `--update-env`. health/demo/seed **200**. stamp `.sftp-deploy-stamp-demo-v3` = `2026-08-14T23:46:53Z hash=bb868c5`.
- **تأیید عمومی:** `https://erp.poshaktaranom.com/demo.html`
- **SW:** بدون bump (`erp-taranom-v158`) — HTML/JS شبکه-اول؛ `demo.css`/`demo.js` `?v=7`. Hard Refresh اگر صفحهٔ قبلی ماند.
- **Independent:** APPROVED e84b9701 · **Security:** APPROVED 0e9e56e1

### 2026-08-15 — DEMO-V3 dual APPROVED (pre-merge)
- **شاخه:** `feat/DEMO-V3-GUIDED-SALES` @ product `dbc2ec4` (docs stamp `f29da49`)
- **Independent:** APPROVED — [e84b9701](e84b9701-1cbe-4db1-a4c9-0d93b70ae458)
- **Security:** APPROVED — [0e9e56e1](0e9e56e1-e80e-484e-81d1-289a6d709352) C0/H0/M0/L0
- **تست:** `test-demo-v3.js` ۶۵/۶۵ · `test-demo-static.js` OK
- **Deploy:** اعمال نشد — منتظر تأیید مالک برای merge/push
- **SW:** بدون bump

### 2026-08-15 — DEMO-V3 M7 no-oversell
- **خلاصه:** پیش‌فاکتور تور کالای با موجودی کافی برمی‌دارد؛ تبدیل مقدار سند/COGS/گردش را به موجودی واقعی محدود می‌کند (بدون `Math.max` پنهان). تست `path-stock-out` دلتای دقیق را می‌سنجد.
- **بازبینی:** Independent `1e8243c` = CHANGES_REQUIRED (M7). Security `1e8243c` = APPROVED (باید روی نوک جدید تکرار شود).
- **Deploy:** اعمال نشد — بدون merge/push
- **SW:** بدون bump

### 2026-08-15 — DEMO-V3 UX follow-up (tour result + pause/resume)
- **خلاصه:** اقدام تور دیگر مرحله را عوض نمی‌کند تا نتیجه (از جمله drill-down) دیده شود؛ «مرحله بعد» جداست. توقف با نوار «ادامه تور» از سر گرفته می‌شود و رفرش تور متوقف‌شده را به برنامه برمی‌گرداند. منوی حسابداری جمع می‌شود؛ مغایرت بانکی به تراز نمی‌رود؛ تکمیل تولید BOM را مصرف می‌کند؛ هزینه سفارش = فی×مقدار؛ پیگیری به فرصت همان مشتری وصل است؛ میانگین وصول از تاریخ فاکتور/رسید.
- **Deploy:** اعمال نشد — بدون merge/push
- **SW:** بدون bump

### 2026-08-15 — DEMO-V3 review-fix (H1–H3 / M1–M6)
- **خلاصه:** پاسخ به بازبین مستقل: تحویل واقعاً روی فاکتور ثبت می‌شود؛ `init` شنونده را تکرار نمی‌کند؛ تست مسیر فروش state را assert می‌کند؛ تبدیل/وصول به مانده و سند وصل است؛ تراز از اسناد؛ شل حسابداری صفحهٔ غلط نمی‌دهد؛ حلقهٔ تور با viewport؛ شمارندهٔ مرحله دیده می‌شود؛ دیالوگ بازنشانی Escape/فوکوس/aria دارد.
- **فایل‌ها:** `demo-v3-app.js`, `demo-v3-seed.js`, `demo-v3-tour.js`, `demo.css`, `demo.js`, `test-demo-v3.js`
- **تست:** `test-demo-v3.js` ۵۲/۵۲ · `test-demo-static.js` OK
- **بازبینی:** Independent روی `3dd0d11` = CHANGES_REQUIRED؛ این commit برای re-review. Security قبلی روی `3dd0d11` بود و باید دوباره دیده شود.
- **Deploy:** اعمال نشد — بدون merge/push تا تأیید مالک
- **SW:** بدون bump

### 2026-08-15 — DEMO-V3-GUIDED-SALES (شاخه feat/DEMO-V3-GUIDED-SALES)
- **خلاصه:** نسخه نمایشی فروش‌محور با صفحه معرفی نقش، تور هدایت‌شده، دادهٔ نمونه «پوشاک نمونه سپیدارگل»، محیط آزاد و بازنشانی نام‌فضای v3. واترمارک نارنجی حذف شد.
- **فایل‌ها:** `server/public/demo.html`, `demo.css`, `demo.js`, `demo-v3-seed.js`, `demo-v3-store.js`, `demo-v3-tour.js`, `demo-v3-app.js`, `server/scripts/test-demo-v3.js`, `docs/architecture/DEMO-V3-DESIGN.md`
- **تست:** `test-demo-v3.js` ۳۴/۳۴ · `test-demo-static.js` OK · encoding PASS
- **Deploy:** اعمال نشد — بدون merge/push تا تأیید مالک
- **SW:** بدون bump

### 2026-08-14 — دمو: شل کامل حسابداری از آخرین acc-nav ✅
- **خلاصه:** `/demo.html` منوی حسابداری را از `acc-nav.js` همین نسخه می‌خواند. زدن «حسابداری» همان شل ماژول (اشخاص، کالا، انبار، بانک، فروش، چک، اسناد، تولید، حقوق، دارایی) را باز می‌کند.
- **SW:** `erp-taranom-v158`
- **Deploy:** ✅ SFTP `4a6e04e` ایران. health/demo **200**. stamp `.sftp-deploy-stamp-demo-ui-v158` = `2026-08-14T20:05:05Z`. Hard Refresh لازم است.

### 2026-08-14 — دمو: اندازه لوگو و واترمارک مثل برنامه اصلی ✅
- **خلاصه:** `logo-sm.png` بدون ارتفاع کارت ورود و سایدبار را می‌ترکاند. همان اندازه برنامه (`110px` ورود / `44px` سایدبار) در `app.css` و `demo.css`. واترمارک مورب حذف شد؛ نوار باریک بالا جای آن است.
- **SW:** `erp-taranom-v157`
- **Deploy:** ✅ SFTP `a48ec7f` ایران. health/demo **200**. stamp `.sftp-deploy-stamp-demo-ui-v157` = `2026-08-14T19:18:14Z`. Hard Refresh لازم است.

### 2026-08-14 — دموی ایستا = همان ظاهر برنامه + سازنده ریان ✅
- **خلاصه:** `/demo.html` دیگر ویترین بنفش جدا نیست. همان شل ERP (کارت ورود زمرد، سایدبار، نوار بالا، `app.css`) با دادهٔ ساختگی. تنها برند اضافه: **شرکت ترانه اندیشه پردازان ریان**.
- **فایل‌ها:** `server/public/demo.html`, `demo.css`, `demo.js`, `index.html` (سازنده روی ورود), `app.js` (راهنما), `sw.js` v156
- **SW:** `erp-taranom-v156`
- **Deploy:** ✅ SFTP overlay `785d565` به ایران. health/demo **200**. stamp `.sftp-deploy-stamp-demo-ui-v156` = `2026-08-14T10:24:44Z`. Hard Refresh لازم است.

### قالب تاریخچه

بعد از **هر تسک** که تغییر می‌دهید یک ورودی در بالای بخش «تاریخچه» اضافه کنید.

---

## قانون برای دستیار (Cursor / Claude Code)

بعد از **هر تسک** که کد یا مستندات را عوض می‌کنید:

1. یک ورودی جدید زیر **بالای بخش «تاریخچه»** (زیر این قوانین) اضافه کنید.
2. commit مربوطه را با پیام واضح بنویسید.
3. وضعیت deploy روی سرور production را مشخص کنید: `✅ deploy شد` / `⏳ نیاز به pull` / `⏭ اعمال نشد`.

### 2026-08-14 — DEMO-V2-SECURE-SALES merge + Iran SFTP + SW v155 ✅
- **شاخه primary:** `claude/claude-md-docs-2ssrpy` @ `6f4d24a` ← merge `ai/DEMO-V2-SECURE-SALES` روی CRM-PRO `1287a1a`
- **خلاصه:** نسخه نمایشی امن (static `/demo.html` + Demo Mode تعاملی) با تأیید مالک merge و deploy شد.
- **Deploy:** ✅ SFTP overlay به `taranom@94.249.244.208:/home/taranom/crm-taranom` (VPS git کثیف بود؛ pull نشد). `pm2 restart erp-taranom` بدون `--update-env`. health/ready/root/demo **200**. stamp `.sftp-deploy-stamp-demo-v2-v155` = `2026-08-14T09:51:15Z hash=6f4d24a`.
- **تأیید عمومی:** `https://erp.poshaktaranom.com/demo.html` و `https://erp.poshaktaranom.com/sw.js` = `erp-taranom-v155`
- **SW:** `erp-taranom-v155`

### 2026-08-14 — CRM-PRO-ANALYTICS merge + Iran SFTP + SW v154 ✅
- **شاخه primary:** `claude/claude-md-docs-2ssrpy` ← FF `eae0a14..d3b6136` از `ai/CRM-PRO-ANALYTICS-crm-dashboard`
- **خلاصه:** ادغام داشبورد CRM حرفه‌ای + bump Service Worker به v154 پس از تأیید مالک برای merge و deploy ایران.
- **Deploy:** ✅ SFTP overlay به `taranom@94.249.244.208:/home/taranom/crm-taranom` (VPS git کثیف بود؛ pull نشد). `pm2 restart erp-taranom` بدون `--update-env`. health/ready/root **200**. stamp `.sftp-deploy-stamp-crm-pro-v154` = `2026-08-14T05:33:42Z hash=d3b6136`.
- **تأیید عمومی:** `https://erp.poshaktaranom.com/sw.js` = `erp-taranom-v154`؛ `app.js?v=154`
- **SW:** `erp-taranom-v154`

### 2026-08-14 — CRM-PRO-ANALYTICS (شاخه ai/CRM-PRO-ANALYTICS-crm-dashboard)
- **commit:** `48ea171`
- **شاخه:** `ai/CRM-PRO-ANALYTICS-crm-dashboard`
- **خلاصه:** داشبورد CRM نموداری با داده واقعی؛ پایپ‌لاین از pipeline_stage/فرصت نه followups.status؛ جداول فرصت/فعالیت/تاریخچه مرحله + سگمنت و اتوماسیون idempotent؛ فیلتر سراسری و drill-down reconcile؛ واحد ریال. مهاجرت پس از مهر، فرصت‌های جاافتاده را بدون تکرار backfill می‌کند.
- **فایل‌های کلیدی:** server/lib/crm-pro*.js, server/lib/crm-analytics.js, server/lib/crm-analytics-scope.js, server/routes/crm.js, server/public/app.js, server/public/app.css, server/db.js, server/sync/tables.js, server/sync/capture.js
- **تست:** analytics 32/32 · RBAC 17/17 · UI smoke 17/17 · performance 8/8 · ACC-CRM dashboard 21/21 · SMS 22/22 · sync 44/44 · encoding PASS · diag mismatches=[]
- **بازبینی اول:** Reviewer CHANGES_REQUIRED + Security NOT_APPROVED — Highها بسته شد (فیلتر/دریل مشترک، GET بدون سگمنت، backfill v10، مالکیت پیگیری، اتوماسیون فقط مرکز)
- **بازبینی نهایی:** Reviewer APPROVED + Security APPROVED — تسک `active` ماند؛ completed نشد
- **Deploy:** اعمال نشد — نیاز به اجازه جداگانه مالک
- **SW:** بدون bump تا تأیید UI مرورگر

### 2026-08-14 — DEMO-V2-SECURE-SALES dual Approved (pre-merge)
- **شاخه:** `ai/DEMO-V2-SECURE-SALES` @ `af9859f` (base `eae0a14`)
- **خلاصه:** Independent + Security هر دو Approved؛ بدون یافتهٔ باز Critical/High/Medium.
- **Deploy:** بعداً با تأیید مالک merge+SFTP شد
- **SW:** سپس v155

### 2026-08-14 — MDI فقط حسابداری + نوار شناور (SW v153)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **خلاصه:** چندپنجره‌ای دوباره فقط برای زیرمنوهای حسابداری است. داشبورد CRM و داشبورد حسابداری تک‌صفحه‌ای ماندند. نوار وظایف شناور پایین صفحه است (روی محتوا، بدون کوتاه کردن سایدبار) و کلیک Chrome حفظ شد.
- **فایل‌های کلیدی:** `server/public/app.js`, `server/public/mdi.js`, `server/public/app.css`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ✅ SFTP overlay ایران؛ health/ready/root **200**؛ stamp `.sftp-deploy-stamp-mdi-v153` = `2026-08-13T22:12:55Z hash=eedd689`
- **SW:** `erp-taranom-v153`

### 2026-08-14 — MDI taskbar Chrome + کل برنامه (SW v152)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **خلاصه:** نوار چندپنجره‌ای پایین صفحه در Chrome کلیک نمی‌گرفت (لایهٔ `#mdiLayer` بدون اندازه + `pointer-events:none` hit-test زیر‌درخت را در Chromium رد می‌کرد). نوار حالا sibling مستقیم `body` است با z-index مستقل و کلیک delegated. حالت چندپنجره برای **کل برنامه** (CRM + حسابداری) فعال است و نوار با روشن بودن تنظیمات همیشه دیده می‌شود.
- **فایل‌های کلیدی:** `server/public/mdi.js`, `server/public/app.css`, `server/public/app.js`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ✅ SFTP overlay به `taranom@94.249.244.208:/home/taranom/crm-taranom` (VPS git کثیف بود؛ pull نشد). `pm2 restart erp-taranom --update-env`. health/ready/root **200**. stamp `.sftp-deploy-stamp-mdi-v152` = `2026-08-13T22:05:04Z hash=9d5319f`.
- **SW:** `erp-taranom-v152`

### 2026-08-13 — ACC-CRM-UNIFY: FF-merge primary + Iran SFTP deploy ✅
- **شاخه primary:** `claude/claude-md-docs-2ssrpy` ← FF از `ai/ACC-CRM-UNIFY-accounting-crm`
- **Tip:** `aa1ee64` (merge tip = feature tip)
- **خلاصه:** با تأیید صریح مالک: FF-merge + push primary؛ overlay SFTP به `taranom@94.249.244.208:/home/taranom/crm-taranom`؛ `pm2 restart erp-taranom` بدون `--update-env`؛ stamp `.sftp-deploy-stamp-acc-crm-unify` = `2026-08-12T21:36:19Z hash=aa1ee64`.
- **تأیید runtime:** loopback health/ready/root **200**؛ `sw.js` = `erp-taranom-v151`؛ `app.js?v=151`؛ `crm.js` + `sales-document.js` + `firmSaleTypeSql` روی VPS.
- **تأیید عمومی:** `https://erp.poshaktaranom.com/sw.js` → `CACHE = 'erp-taranom-v151'` (دیگر v148 نیست).
- **Deploy:** ✅ SFTP overlay (بدون blind git pull روی VPS کثیف)
- **SW:** `erp-taranom-v151`

### 2026-08-12 — ACC-CRM-UNIFY completed: dual Approved (no deploy)
- **شاخه:** `ai/ACC-CRM-UNIFY-accounting-crm`
- **Code tip:** `c0ed4c9` · **Stamp:** `fe2f1da`
- **خلاصه:** Independent Reviewer + Security هر دو APPROVED پس از remediation فازهای ۰–۸؛ claims آزاد شد. merge/deploy ایران فقط با مجوز صریح مالک.
- **Deploy:** ⏭ عمداً انجام نشد
- **SW:** `erp-taranom-v151`

### 2026-08-12 — ACC-CRM-UNIFY Phase 8a: review remediation (pre-approve)
- **شاخه:** `ai/ACC-CRM-UNIFY-accounting-crm`
- **Commit:** `c0ed4c9`
- **خلاصه:** رفع یافته‌های Reviewer/Security: receivables بدون ×۱۰؛ KPI تاریخ شمسی؛ cheque lifecycle idempotency داخل transaction؛ ensureAllUserParties پس از unify؛ COGS void با fallback toman؛ تست dashboard due تاریخ جلالی.
- **Deploy:** ⏭ عمداً انجام نشد
- **SW:** بدون تغییر (منطق سرور)

### 2026-08-12 — ACC-CRM-UNIFY Phase 7: full gates green (no deploy)
- **شاخه:** `ai/ACC-CRM-UNIFY-accounting-crm`
- **Commit tip:** `0d043fd`
- **خلاصه:** گیت‌های کامل روی tip تمیز: perpetual/party/dashboard/reports/phase6/sms/sync/production ALL GREEN؛ embedded diff=0؛ encoding PASS؛ بدون deploy.
- **Deploy:** ⏭ عمداً انجام نشد
- **SW:** `erp-taranom-v151`

### 2026-08-12 — ACC-CRM-UNIFY Phase 6: Medium edge cases (SW v151)
- **شاخه:** `ai/ACC-CRM-UNIFY-accounting-crm`
- **Commit:** `bce9943`
- **خلاصه:** ADR انبار با fallback صریح؛ مسدودسازی PATCH وضعیت مالی چک (فارسی/انگلیسی) + `POST /resend` پس از برگشت؛ جلوگیری از overwrite شدن `CACHE.allProducts` با subset انبار؛ KPI `new_customers` با from/to روی `created_at`؛ تست **۱۳/۱۳**.
- **فایل‌های کلیدی:** `cheque-records.js`, `crm-analytics.js`, `app.js`, `ADR-ACC-CRM-UNIFY.md`, `test-acc-crm-phase6.js`, `sw.js`, `index.html`
- **Deploy:** ⏭ عمداً انجام نشد
- **SW:** `erp-taranom-v151`

### 2026-08-12 — ACC-CRM-UNIFY Phase 5: گزارش فروش قطعی + ADR فیلترها
- **شاخه:** `ai/ACC-CRM-UNIFY-accounting-crm`
- **Commit:** `cdde2c8`
- **خلاصه:** helperهای `firmSaleTypeSql` / `commissionEligibleSql`؛ درآمد/AR/P&L/VAT/KPIها با `normal|final`؛ Moadian و pending-approval و seasonal-169 فقط `final`؛ auto-approve برای فاکتور معمولی؛ تست reconciliation **۱۵/۱۵**.
- **فایل‌های کلیدی:** `sales-document.js`, `reports.js`, `accounting.js`, `adv-reports.js`, `dashboard.js`, `admin.js`, `ai.js`, `crm-analytics.js`, `test-acc-crm-reports.js`, `ADR-ACC-CRM-UNIFY.md`
- **Deploy:** ⏭ عمداً انجام نشد
- **SW:** بدون تغییر

### 2026-08-12 — ACC-CRM-UNIFY Phase 4: migration party + E_PARTY_ALREADY_LINKED
- **شاخه:** `ai/ACC-CRM-UNIFY-accounting-crm`
- **Commit:** `294c48f`
- **خلاصه:** حذف `party_id=NULL` خاموش روی conflict؛ `runAccCrmUnifyV1` تراکنشی (keep lowest user id + audit + UNIQUE index) و stamp فقط روی موفقیت؛ تست party **۱۸/۱۸**.
- **فایل‌های کلیدی:** `user-party.js`, `db.js`, `test-acc-crm-party.js`
- **Deploy:** ⏭ عمداً انجام نشد
- **SW:** بدون تغییر

### 2026-08-12 — ACC-CRM-UNIFY Phase 3: CRM RBAC + cheque scope
- **شاخه:** `ai/ACC-CRM-UNIFY-accounting-crm`
- **Commit:** `dd511fc`
- **خلاصه:** نادیده گرفتن `user_id` کلاینت وقتی scope فعال است (شامل 0)؛ permission صریح CRM؛ KPI چک scoped؛ timeline چک با party_id/customer_id؛ تست منفی HTTP+unit **۲۱/۲۱**.
- **فایل‌های کلیدی:** `crm-analytics.js`, `crm.js`, `db.js`, `test-acc-crm-dashboard.js`
- **Deploy:** ⏭ عمداً انجام نشد
- **SW:** بدون تغییر

### 2026-08-12 — ACC-CRM-UNIFY Phase 2: واحد پول ریال + تست مبالغ دقیق
- **شاخه:** `ai/ACC-CRM-UNIFY-accounting-crm`
- **Commit:** `016e205`
- **خلاصه:** حذف `*10` نادرست خرید/برگشت؛ `cost_amount` برگشت فروش ریالی؛ تخفیف خرید با `amount_rial` همسو با JE؛ تست‌های مبلغ‌محور (avg=40000، GL=ledger، COGS، void). perpetual **۴۴/۴۴**.
- **فایل‌های کلیدی:** `purchases.js`, `sales-document.js`, `accounting.js`, `test-acc-crm-perpetual.js`
- **Deploy:** ⏭ عمداً انجام نشد
- **SW:** بدون تغییر

### 2026-08-12 — ACC-CRM-UNIFY Phase 1: بازیابی encoding فارسی index.html + guard (SW v150)
- **شاخه:** `ai/ACC-CRM-UNIFY-accounting-crm`
- **Commit:** `f83b00f`
- **خلاصه:** `index.html` از `448a8c1` با UTF-8/BOM سالم بازگردانی شد؛ فقط bump دارایی‌ها به v150. گارد `check-ui-encoding.js` (حداقل ۴۰۰ نویسه فارسی، رد `???`). اسکرین‌شات‌ها در `docs/architecture/ui-baseline/`. SW → `erp-taranom-v150` پس از تأیید UI.
- **فایل‌های کلیدی:** `server/public/index.html`, `server/public/sw.js`, `server/scripts/check-ui-encoding.js`, `server/scripts/phase1-ui-screenshots.js`, `docs/architecture/ui-baseline/*`
- **Deploy:** ⏭ عمداً انجام نشد
- **SW:** `erp-taranom-v150`

### 2026-08-12 — ACC-CRM-UNIFY Phase 0: تثبیت baseline + پورت قابل‌تنظیم (بدون deploy)
- **شاخه:** `ai/ACC-CRM-UNIFY-accounting-crm`
- **Commit:** `8fea0d4`
- **خلاصه:** پس از Reviewer=`CHANGES_REQUIRED` و Security=`NOT_APPROVED` روی `d5a2f51`، فاز ۰ remediation: helper پورت/cleanup (`test-server-boot.js`)، پورت قابل‌تنظیم در `test-acc-crm-perpetual` (`ACC_CRM_TEST_PORT`) و `test-sync` (`SYNC_TEST_PORT_BASE`)، runner سریال `run-acc-crm-baseline.js`، ثبت مالکیت/claim در AI-DOS. stamp قبلی CHANGE-LOG برای `d5a2f51` حفظ شد.
- **فایل‌های کلیدی:** `server/scripts/lib/test-server-boot.js`, `test-acc-crm-perpetual.js`, `test-sync.js`, `run-acc-crm-baseline.js`, `.ai-dos/tasks/{active.yaml,handoff.md}`, `.ai-dos/project/status.md`
- **Deploy:** ⏭ عمداً انجام نشد (مجوز مالک + dual Approved لازم)
- **SW:** بدون تغییر (Phase 0)

### 2026-08-11 — ACC-CRM-UNIFY wave0–6: فاکتور معمولی + دائمی + CRM + MDI پایین (SW v149)
- **شاخه:** `ai/ACC-CRM-UNIFY-accounting-crm`
- **Commit:** `d5a2f51`
- **خلاصه:** نوع `normal` برای فاکتور فروش؛ فروش/خرید قطعی از مسیر `postInventoryMovement`؛ محدودیت کالا به انبار مبدأ؛ سخت‌سازی `users.party_id`؛ حذف تکرار کاردکس؛ نوار MDI پایین صفحه؛ منوی پیگیری CRM + داشبورد/API واقعی؛ تست‌های `test-acc-crm-*.js`. بدون deploy تولید تا تأیید مالک + Reviewer/Security.
- **تکمیل موج ۲/۵/۶ (همین روز):** برگشت از فروش هم به مسیر دائمی وصل شد (`postSaleReturnStockMovements` + reverse از `inventory_ledger` در ابطال + بهای واقعی از میانگین انبار)؛ گارد idempotency روی سه گذار چک (`send-to-bank`/`clear`/`bounce`) با کد `E_JE_DUPLICATE`؛ redirect مسیرهای legacy در `go()` (کاردکس/فاکتور معمولی/رسمی/CRM)؛ تاریخچهٔ مشتری از `/api/crm/timeline` (فاکتور+تسویه+برگشت+پیگیری) با fallback به پیگیری‌ها. تست perpetual: **۳۴/۳۴**؛ party ۵/۵؛ dashboard ۸/۸؛ SMS ۲۲/۲۲.
- **رفع یافته‌های ممیزی دوم:** ۱) PATCH متن‌آزاد وضعیت چک برای «وصول/برگشت/واگذاری» چک دریافتی مسدود شد (`E_CHEQUE_USE_LIFECYCLE`) — گذار مالی فقط از endpointهای چرخه با سند. ۲) `wireModalChrome` دیگر `--mdi-taskbar-h` را صفر نمی‌کند (همگام با `WinMgr.syncTaskbarSpace`). ۳) timeline رویدادهای برگشت فروش و چک را هم برمی‌گرداند. ۴) `NAV_ACCOUNTING` گروه «پیگیری CRM» گرفت. ۵) scope پیگیری‌ها برای `sales_manager`/`accounting` با `crmScopeUserId` هم‌راستا شد. ۶) **سازگاری عقب‌روی گیت انبار:** بدون `warehouse_id` هدر، fallback به انبار خود کالا + معناشناسی seed قدیمی (`products.stock` = موجودی انبار خانگی)؛ `E_WH_MISMATCH` صریح همچنان 409 — رفع شکست replay دستگاه در test-sync. ۷) harness `test-sync`: حذف پروکسی از loopback + مهلت بوت قابل‌تنظیم (`SYNC_TEST_BOOT_TIMEOUT_MS`). ۸) **باگ سینک دائمی:** `tx_no` کاردکس روی دستگاه‌ها با ردیف‌های pull‌شدهٔ مرکز تصادم می‌کرد (`UNIQUE inventory_ledger.tx_no`) — دستگاه حالا مثل شماره فاکتور، `موقت-INV-…` یکتا می‌سازد و شماره واقعی را مرکز در replay صادر می‌کند. **test-sync: ۴۴/۴۴ سبز.**
- **فایل‌های کلیدی:** `server/lib/sales-document.js`, `server/lib/crm-analytics.js`, `server/routes/{invoices,purchases,crm,products,accounting,cheque-records}.js`, `server/lib/{void-invoice,user-party}.js`, `server/public/{app.js,acc-nav.js,mdi.js,app.css,sw.js,index.html}`, `server/db.js`, `server/scripts/test-acc-crm-*.js`, `docs/architecture/*`
- **Deploy:** ⏭ عمداً انجام نشد (دستور مالک: بدون deploy تا اجازه صریح)
- **SW:** `erp-taranom-v149`

### 2026-08-11 — UI fixes: کالاها rows.map + Help در پوسته + SKU + منوی تولید (SW v148)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `815171b`
- **خلاصه:** ۱) رفع `rows.map is not a function` در کالاها با `listRows()` برای envelope Wave1. ۲) افزودن «راهنما» به سایدبار پوسته حسابداری (امکانات). ۳) UI ماتریس SKU رنگ×سایز + صفحات رنگ/سایز. ۴) جلوگیری autofill admin روی جستجوی تنظیمات/رمز بکاپ. ۵) باز بودن پیش‌فرض بخش تولید + اصلاح مسیر Help.
- **فایل‌های کلیدی:** `server/public/app.js`, `server/public/acc-nav.js`, `server/public/sw.js`, `server/public/index.html`
- **Deploy:** ✅ Iran SFTP `.sftp-deploy-stamp-ui-fix-v148` @ 2026-08-11T12:43:25Z — health/ready/root 200 · SW v148
- **SW:** `erp-taranom-v148`

### 2026-08-11 — Fix P0–P5 UI/API frankenstein deploy gap (SW v147)
- **شاخه:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `9fd57cc`
- **خلاصه:** علت «UI موج‌ها عوض نشده»: SFTPهای جزئی فقط بخشی از tip را روی ایران گذاشته بودند (`app.js` جدید + ده‌ها route/lib قدیمی + `index.html`/`app.css`/`acc-nav` کهنه؛ `app.js?v=1` هرگز cache-bust نمی‌شد). resync کامل فایل‌های ناهم‌خوان + `?v=147` + SW `erp-taranom-v147` + `Cache-Control: no-store` برای shellهای UI.
- **فایل‌های کلیدی:** `server/public/{index.html,app.js,app.css,sw.js,acc-nav.js,...}`, `server/server.js`, `server/lib/production/*`, `server/lib/moadian/*`, `server/routes/*`, `scripts/_deploy-p0-p5-ui-resync-sftp.py`, `scripts/_probe-*-deploy-gap.py`
- **Deploy:** ✅ Iran SFTP resync `.sftp-deploy-stamp-p0-p5-ui-resync` @ 2026-08-11T11:34:10Z — health/ready/root 200؛ UI probe mismatches=0؛ SW `erp-taranom-v147`؛ `app.js?v=147` (بدون blind pull / بدون `--update-env` / بدون npm install)
- **SW:** `erp-taranom-v147`
- **یادداشت:** پس از deploy یک‌بار Ctrl+Shift+R؛ ماژول تولید را در تنظیمات ماژول‌ها روشن نگه دارید.

### 2026-08-10 — PROD-P5-R2 review remediation (High/Medium reopen)
- **شاخه:** `fix/PROD-P5-R2-review-remediation` (base `a152086`)
- **Commit:** `1728626`
- **خلاصه:** تکمیل نامعتبر PROD-P5 بازگشایی شد. High-1: ایزولاسیون freshDb/ERP_TEST_ISOLATION تا T2-05/07/08 و health 5201/5203 سبز شوند + رگرسیون pack_size×20/×25. High-2: sensitivity فقط in-memory priceOverrides (بدون UPDATE روی products) + تست‌های a–d. High-3: prepare/compare embedded diff=0. Medium-1: CRUD ops/outputs + auto-share + E_* فارسی + smoke نقش‌ها. Medium-2: دامنه canonical erp.poshaktaranom.com + hash/smoke scripts.
- **فایل‌های کلیدی:** server/scripts/lib/test-harness.js, server/db.js, server/lib/company-workspace.js, server/lib/production/bom.js, server/lib/production/bom-advanced.js, server/public/app.js, server/public/sw.js (v146), scripts/_probe-prod-p5-r2-hashes.py, scripts/_smoke-prod-p5-r2-roles.py, docs/08-deployment.md
- **Deploy:** ✅ Iran SFTP هدفمند — stamp `.sftp-deploy-stamp-prod-p5-r2` · primary `33ab46e` · tip `1728626` (بدون blind pull / بدون `--update-env`)؛ hash probe YES؛ health/ready/root 200
- **SW:** `erp-taranom-v146`

### 2026-08-10 — PROD-P5 Independent Review remediation (10 items + getBom R11)
- **شاخه:** `ai/PROD-P5-advanced-bom`
- **Commit:** `5fb2276` — پس از `6271a3f`؛ wrap `GET /:id` + `/tree` + `/compare`
- **خلاصه:** رفع Changes requested بازبین مستقل: `applyCostPolicy` روی `getBom`/`bomTree`/`compare`؛ تست getBom-shape؛ گیت advanced **38/38**.
- **فایل‌های کلیدی:** `server/routes/production-boms.js`, `server/scripts/test-production-bom-advanced.js`, `docs/CHANGE-LOG.md`
- **Deploy:** ✅ Iran SFTP هدفمند remedia — stamp `.sftp-deploy-stamp-prod-p5-rereview` · merge `889b61b` · tip `5fb2276` (بدون blind pull / بدون `--update-env`)
- **یادداشت:** روی tip قبلی `6271a3f` (POST/PUT R11 + tip stamps).

### 2026-08-10 — PROD-P5 Independent Review remediation (10 items)
- **شاخه:** `ai/PROD-P5-advanced-bom`
- **Commit:** `6271a3f` — روی tip `45961c4` / زنجیره: `83003d7`→`9878f11`→`ac078a7`→`45961c4`→`6271a3f`
- **خلاصه:** ۱۰ دستور اصلاحی Reviewer+Security: stamp کامل tip در CHANGE-LOG؛ تأیید R11 روی GET std-cost/ops/outputs/explode/routing؛ قفل resequence؛ wrap `applyCostPolicy` روی پاسخ POST/PUT ops/outputs + resequence؛ تست `applyCostPolicy` با `production_operator`؛ گیت‌ها سبز.
- **فایل‌های کلیدی:** `server/routes/production-boms.js`, `server/scripts/test-production-bom-advanced.js`, `docs/CHANGE-LOG.md`, `.ai-dos/tasks/*`
- **Deploy:** ⛔ blocked until independent re-review (بدون deploy جدید ایران)
- **یادداشت:** advanced **37/37** · OH 38/38 · var 27/27 · sms 22/22 · sync 44/44 · diag mismatches=[] · merge امنیت primary `c22c0fb`.

### 2026-08-10 — PROD-P5 security follow-up (R11 + resequence lock)

- **شاخه:** `ai/PROD-P5-advanced-bom` → merge به primary
- **Commit:** `ac078a7` / tip `45961c4`
- **خلاصه:** رفع یافته‌های متوسط Security Review: `applyCostPolicy` روی GET operations/routing/outputs/explode/std-cost؛ قفل `resequenceOperations` روی BOM فعال؛ تست‌ها 34/34.
- **فایل‌های کلیدی:** `server/routes/production-boms.js`, `server/lib/production/bom-advanced.js`, `server/scripts/test-production-bom-advanced.js`
- **Deploy:** ✅ Iran SFTP `c22c0fb` — root/health/ready 200; stamp `.sftp-deploy-stamp-prod-p5-sec`
- **یادداشت:** [Security Review] Approved with comments → remediated.

### 2026-08-10 — PROD-P5 merge + Iran SFTP deploy
- **شاخه:** `ai/PROD-P5-advanced-bom` → merge `4306168` به `claude/claude-md-docs-2ssrpy`
- **Commit:** `4306168` (merge اولیه ایران) · tip feature پس از امنیت: `ac078a7`+ (نه فقط `83003d7`/`9878f11`) · merge امنیت `c22c0fb`
- **خلاصه:** تکمیل ماژول ۴ BOM پیشرفته: helpers (costTree/sensitivity/…)، مسیرهای API + R11 cost policy، اصلاح PATH ops/outputs، UI چهارتب، تست §18 → **32/32** (T4-13/15 با ±۱).
- **فایل‌های کلیدی:** `server/lib/production/bom-advanced.js`, `server/routes/production-boms.js`, `server/sync/capture.js`, `server/sync/tables.js`, `server/public/app.js`, `server/scripts/test-production-bom-advanced.js`
- **Deploy:** ✅ ایران SFTP هدفمند (بدون blind pull) — stamp `.sftp-deploy-stamp-prod-p5`؛ `root/health/ready=200` روی `/` و `/health` و `/ready`؛ pm2 online؛ بدون `--update-env`
- **یادداشت:** گیت‌ها: advanced 32/32، overhead 38/38، variable 27/27، sms 22/22، sync 44/44 (retry)، diag mismatches=[]؛ پس از این merge، security follow-up `ac078a7` / `c22c0fb` tip را جلو برد — stamp کامل در ورودی remediation بالا.

### 2026-08-10 — PROD-P5 UI: تب‌های فرمول (اقلام / مسیر / خروجی / بها)
- **شاخه:** `ai/PROD-P5-advanced-bom`
- **Commit:** `83003d7`
- **خلاصه:** ویرایشگر BOM با چهار تب Module-4: اقلام، مسیر عملیات («از الگوی ترنم» + resequence)، خروجی‌های main/co/by، بهای تمام‌شده (`full-cost?qty` پیش‌فرض ۳۰۰، بدون JE). تب بها با `canPerm('production_cost','view')` / `__canSeeCost` مخفی می‌شود. Help: V4-21 (بازده سرفصل=۱۰۰ با routing)، full-cost بدون سند، co/by.
- **فایل‌های کلیدی:** `server/public/app.js`, `docs/CHANGE-LOG.md`
- **Deploy:** ⏳ pending merge
- **یادداشت:** فقط UI؛ موتور/API پیشرفته در همان شاخه؛ بدون بیلد APK/دسکتاپ.

### 2026-08-09 — Deploy ایران Wave1 merge via SFTP
- **شاخه:** `claude/claude-md-docs-2ssrpy` / `ai/W1-merge-primary-deploy`
- **Commit کد:** `f67a9fc`
- **خلاصه:** پس از merge W1 روی primary، به‌خاطر عدم resolve بودن github.com روی VPS، delta از طریق SFTP آپلود شد؛ PM2 بدون `--update-env`؛ health/ready/root=200؛ SW v145؛ stamp `.sftp-deploy-stamp-w1-merge`.
- **فایل‌های کلیدی:** `scripts/_deploy-w1-merge-sftp.py`, `server/lib/moadian/*`, `server/routes/moadian.js`, `server/public/sw.js`, `docs/WAVE1-GATE-STATUS.md`
- **Deploy:** ✅ Iran SFTP @ 2026-08-09T12:31:55Z (git HEAD روی سرور هنوز `8a5cd54` — فقط فایل‌ها sync)
- **یادداشت:** live مودیان و تأیید مشاور مالیاتی باز؛ DNS گیت‌هاب VPS هنوز خراب.

### 2026-08-09 — Merge W1 ORCH tip (امنیت/موادیان/variants) روی primary برای deploy ایران
- **شاخه:** `ai/W1-merge-primary-deploy` → `claude/claude-md-docs-2ssrpy`
- **Commit:** `6bd5884` (+ merge docs tip)
- **خلاصه:** ادغام `origin/ai/W1-ORCH-wave1-integration` (`aca247f`) روی tip primary (`ced58ef`). حفظ قابلیت‌های جدیدتر primary (W2/P3/P4) + remediation امنیتی W1 پس از merge-base `7ef8c72` (به‌ویژه `dcb9b40` SEC، تست `9053883`). ترتیب SYNCABLE: `bank_statement_lines` سپس variants؛ backfill v8.
- **فایل‌های کلیدی:** `server/db.js`, `server/routes/moadian.js`, `server/lib/moadian/*`, `server/lib/void-invoice.js`, `server/routes/product-variants.js`, `server/lib/secret-settings.js`, `docs/WAVE1-GATE-STATUS.md`
- **Deploy:** ✅ تکمیل شد با SFTP (رکورد بالا)
- **یادداشت:** این worktree ابتدا merge+push؛ سپس SFTP deploy.

### 2026-08-09 ΓÇö ╪¬╪│╪¬ ╪▒┌»╪▒╪│█î┘ê┘å path/matrix ┘╛╪│ ╪º╪▓ Approve ╪º┘à┘å█î╪¬█î
- **╪┤╪º╪«┘ç:** `ai/W1-ORCH-wave1-integration`
- **Commit:** `9053883`
- **╪«┘ä╪º╪╡┘ç:** ┘╛╪│ ╪º╪▓ Approve with comments ╪º┘à┘å█î╪¬╪î assert ╪¿╪▒╪º█î `MOADIAN_KEY_PATH_REJECTED` ┘ê ╪│┘é┘ü ┘à╪º╪¬╪▒█î╪│ █╡█░█░ ╪º╪╢╪º┘ü┘ç ╪┤╪»╪¢ gate Security Γ£à.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/scripts/test-moadian-foundation.js`, `server/scripts/test-product-variants.js`, `docs/WAVE1-GATE-STATUS.md`
- **Deploy:** Γ¥î Wave 1 ΓÇö deploy blocked

### 2026-08-09 ΓÇö ╪▒┘ü╪╣ █î╪º┘ü╪¬┘çΓÇî┘ç╪º█î ╪º┘à┘å█î╪¬█î ┘à┘ê╪¼ █î┌⌐ (SEC-001..008)
- **╪┤╪º╪«┘ç:** `ai/W1-ORCH-wave1-integration`
- **Commit:** `dcb9b40`
- **╪«┘ä╪º╪╡┘ç:** centralOnlyStrict ╪¿╪▒╪º█î submit/correct ┘à┘ê╪»█î╪º┘å╪¢ ╪▒╪» live╪¢ ┘é┘ü┘ä ╪º╪¿╪╖╪º┘ä ╪▒┘ê█î ┘ü╪º┌⌐╪¬┘ê╪▒ ┘à┘ç╪▒╪«┘ê╪▒╪»┘ç╪¢ ┘à╪│█î╪▒ ┌⌐┘ä█î╪» plaintext+allowlist╪¢ ┘à┘ê╪¼┘ê╪»█î ┘ê╪º╪▒█î╪º┘å╪¬ centralOnly╪¢ ╪│┘é┘ü ┘à╪º╪¬╪▒█î╪│ █╡█░█░╪¢ backfill v8╪¢ Help/SW v145.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/routes/moadian.js`, `server/lib/moadian/*`, `server/lib/void-invoice.js`, `server/routes/product-variants.js`, `server/db.js`, `server/lib/secret-settings.js`, `server/public/{app.js,sw.js}`
- **Deploy:** Γ¥î Wave 1 ΓÇö deploy blocked
- **█î╪º╪»╪»╪º╪┤╪¬:** ┘╛╪º╪│╪« ╪¿┘ç security Blocked╪¢ live ┘à┘ê╪»█î╪º┘å ┘ç┘à┌å┘å╪º┘å ╪º╪»╪╣╪º ┘å╪┤╪»┘ç.

### ┘ü╪▒┘à╪¬ ┘ç╪▒ ┘ê╪▒┘ê╪»█î

```markdown
### YYYY-MM-DD ΓÇö ╪╣┘å┘ê╪º┘å ┌⌐┘ê╪¬╪º┘ç
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `abc1234` (█î╪º ┬½╪¿╪»┘ê┘å commit┬╗)
- **╪«┘ä╪º╪╡┘ç:** ...
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `path/a`, `path/b`
- **Deploy:** Γ£à / ΓÅ│ / Γ¥î
- **█î╪º╪»╪»╪º╪┤╪¬:** (╪º╪«╪¬█î╪º╪▒█î ΓÇö ╪»╪│╪¬┘ê╪▒ deploy╪î ┘å┌⌐╪¬┘ç production╪î ...)
```

---

### 2026-08-09 ΓÇö Merge ┌⌐╪º┘à┘ä W1+W2+PROD-P3/P4 ╪¿╪▒╪º█î deploy ╪º█î╪▒╪º┘å
- **╪┤╪º╪«┘ç:** `ai/merge-all-deploy` ΓåÆ `claude/claude-md-docs-2ssrpy`
- **Commit:** (┘╛╪│ ╪º╪▓ push)
- **╪«┘ä╪º╪╡┘ç:** ╪º╪»╪║╪º┘à ┘à┘ê╪¼ █î┌⌐ (┘à┘ê╪»█î╪º┘å/HR snapshot/variants/pagination/E2E) ╪▒┘ê█î primary ┌⌐┘ç W2 ┘ê PROD-P3/P4 ╪▒╪º ╪»╪º╪┤╪¬╪¢ ╪¬╪▒╪¬█î╪¿ sync: `bank_statement_lines` ╪│┘╛╪│ variants + backfill v8.
- **Deploy:** ΓÅ│ ╪»╪▒ ╪¡╪º┘ä ╪º╪¼╪▒╪º
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪¿╪»┘ê┘å ┘╛╪º┌⌐ ┌⌐╪▒╪»┘å untracked┘ç╪º█î ╪¡╪│╪º╪│ VPS╪¢ sharp runtime ╪▒┘ê█î `0.33.5` ┘à█îΓÇî┘à╪º┘å╪».

### 2026-08-09 — Merge کامل W1+W2+PROD-P3/P4 برای deploy ایران
- **شاخه:** `ai/merge-all-deploy` → `claude/claude-md-docs-2ssrpy`
- **Commit:** `ced58ef`
- **خلاصه:** ادغام موج یک (مودیان/HR snapshot/variants/pagination/E2E) روی primary که W2 و PROD-P3/P4 را داشت؛ ترتیب sync: `bank_statement_lines` سپس variants + backfill v8.
- **Deploy:** ✅ Iran `ced58ef` — ff-pull + `npm install --omit=dev` + `pm2 restart` (بدون `--update-env`)؛ health/ready/root=200؛ sharp=`0.33.5`؛ SW `v144`
- **یادداشت:** untrackedهای حساس VPS (`server/_recover/` و stamps) حفظ شدند؛ `/api/license/status` بدون توکن 401 (طبیعی).

### 2026-08-09 ΓÇö Sync tip ╪º█î╪▒╪º┘å + ╪¿╪º╪▓█î╪º╪¿█î sharp@0.33.5 (waiver)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `18e2d38` / docs tip `a68d901`
- **╪«┘ä╪º╪╡┘ç:** ╪▒┘ê█î VPS `sharp@0.35.0` ╪¿┘çΓÇî╪«╪º╪╖╪▒ CPU ┘ä┘ê╪» ┘å┘à█îΓÇî╪┤╪» ΓåÆ recover ╪¿┘ç `0.33.5`. ╪│┘╛╪│ SFTP ┘ç╪»┘ü┘à┘å╪» P3+P4 ╪¿╪»┘ê┘å `npm install` ┘ê ╪¿╪»┘ê┘å `--update-env`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `scripts/_deploy-sync-tip-sftp.py`, `server/lib/production/{variance,engine,labor,overhead}.js`
- **Deploy:** Γ£à tip overlay╪¢ stamp `.sftp-deploy-stamp-sync-tip`; root/health/ready=200╪¢ SW `v144`╪¢ sharp=`0.33.5`
- **█î╪º╪»╪»╪º╪┤╪¬:** ┘é╪¿┘ä ╪º╪▓ merge ┌⌐╪º┘à┘ä╪î Git HEAD ╪▒┘ê█î VPS ╪╣┘é╪¿ΓÇî╪¬╪▒ ╪º╪▓ primary ╪¿┘ê╪»╪¢ blind pull ╪º┘å╪¼╪º┘à ┘å╪┤╪».

### 2026-08-09 ΓÇö PROD-P4: ╪│╪▒╪¿╪º╪▒ + ╪»╪│╪¬┘à╪▓╪» + ┘à╪▒╪º┌⌐╪▓ ┘ç╪▓█î┘å┘ç (╪¼╪░╪¿ ┘å╪▒╪«)
- **╪┤╪º╪«┘ç:** `ai/PROD-P4-overhead-labor` ΓåÆ merge ╪¿┘ç `claude/claude-md-docs-2ssrpy`
- **Commit:** `d0465ac` (merge tip ┘╛╪│ ╪º╪▓ push)
- **╪«┘ä╪º╪╡┘ç:** ╪¬┌⌐┘à█î┘ä ┘à┘ê╪¼ ╪¬┘ê┘ä█î╪» P4: bootstrap/┘à╪¡╪▒┌⌐ΓÇî┘ç╪º█î ╪│╪▒╪¿╪º╪▒ (toman├ù10)╪î ┌å┘ç╪º╪▒ ╪▒┘ê╪┤ ╪»╪│╪¬┘à╪▓╪»╪î API ┘å╪▒╪« ┘à╪▒╪º┌⌐╪▓ (PUT/bootstrap)╪î ╪¬╪│╪¬ΓÇî┘ç╪º█î ╪╖┘ä╪º█î█î T4-07..12 + T4-24 ΓåÆ **38/38 PASS**.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/production/overhead.js`, `server/lib/production/labor.js`, `server/routes/production-cost-centers.js`, `server/scripts/test-production-overhead-labor.js`
- **Deploy:** Γ£à Iran `a68d901` (┘é╪¿┘ä█î) ΓÇö ╪¿╪º merge ┌⌐╪º┘à┘ä ┘ç┘à█î┘å ┘å┘ê╪¿╪¬ ╪»┘ê╪¿╪º╪▒┘ç deploy ┘à█îΓÇî╪┤┘ê╪»
- **█î╪º╪»╪»╪º╪┤╪¬:** UI ┌⌐╪º┘à┘ä routing ┘à╪▒╪¿┘ê╪╖ ╪¿┘ç P5 ╪º╪│╪¬╪¢ ╪º█î┘å ┘ü╪º╪▓ ┘ü┘é╪╖ ╪¼╪░╪¿ ┘å╪▒╪«/╪»╪│╪¬┘à╪▓╪»/API ┘à╪▒╪º┌⌐╪▓.

### 2026-08-09 ΓÇö PROD-P3 ╪¬┌⌐┘à█î┘ä ╪ó┘å╪º┘ä█î╪▓ ┘à╪¬╪║█î╪▒ ╪¬┘ê┘ä█î╪» (ADR-011)
- **╪┤╪º╪«┘ç:** `ai/PROD-P3-variable-analysis` ΓåÆ merge ╪¿┘ç `claude/claude-md-docs-2ssrpy`
- **Commit:** `ecba58b` (feat) ┬╖ tip `fefedda` (merge primary)
- **╪«┘ä╪º╪╡┘ç:** ╪¬┌⌐┘à█î┘ä ┘à╪º┌ÿ┘ê┘ä █│ ╪¬┘ê┘ä█î╪»: `variance.js`╪î ╪¿╪▒┌»╪┤╪¬ ┘à┘ê╪º╪» ╪¿╪º ┘å╪▒╪« ╪│┘å╪» ╪º╪╡┘ä█î╪î ┘é┘ü┘ä `analysis_type`╪î preview╪î route┘ç╪º█î issues/return/variance-analysis + ┌»╪▓╪º╪▒╪┤ BOM revision/variance-trend╪î UI ╪¡┘ê╪º┘ä┘ç╪î Help╪î ╪¬╪│╪¬ T3 (█▓█╖/█▓█╖).
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/production/variance.js`, `server/lib/production/engine.js`, `server/routes/production-orders.js`, `server/routes/production-reports.js`, `server/public/app.js`, `server/scripts/test-production-variable.js`
- **Deploy:** Γ£à SFTP ┘ç╪»┘ü┘à┘å╪» ╪º█î╪▒╪º┘å (`fefedda` / SW `v144`) ΓÇö health+ready 200╪¢ ╪¿╪»┘ê┘å `--update-env`
- **█î╪º╪»╪»╪º╪┤╪¬:** VPS ╪¿╪»┘ê┘å blind pull╪¢ ┘ü╪º█î┘äΓÇî┘ç╪º█î P3 overlay ╪┤╪»┘å╪».

### 2026-08-09 ΓÇö Wave 2 / P2 MVP slices merged on orch branch
- **╪┤╪º╪«┘ç:** `ai/W2-ORCH-wave2`
- **Commit:** `d411f0e` (tip╪¢ merges ╪¬╪º `3b0c790` + harness/docs)
- **╪«┘ä╪º╪╡┘ç:** ╪┤╪┤ MVP ┘à┘ê╪º╪▓█î ┘à┘ê╪¼ ╪»┘ê ╪º╪»╪║╪º┘à ╪┤╪»: license Ed25519 + safe mode╪¢ onboarding bootstrap/checklist/dry-run╪¢ B2B company+credit reserve╪¢ bank statement import + 1:1 match╪¢ HR labor settings + DRAFT insurance/tax CSV╪¢ observability request-id/ready/support meta. ╪¬╪╣╪º╪▒╪╢ `db.js` (license+b2b init) ╪¡┘ä ╪┤╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/license/*`, `server/lib/onboarding/*`, `server/lib/b2b/*`, `server/lib/observability.js`, `server/lib/payroll/export-legal.js`, `server/routes/{license,onboarding,b2b,bank-reconciliation,payroll}.js`, `server/scripts/test-{license,onboarding,b2b-credit,bank-recon-import,payroll-export,observability}.js`
- **Deploy:** Γ£à Iran `b4b653b` ΓÇö stash tracked dirty ΓåÆ ff-pull ΓåÆ `npm install --omit=dev` ΓåÆ `pm2 restart` (╪¿╪»┘ê┘å `--update-env`)╪¢ health/ready/root = 200
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪«╪▒┘ê╪¼█îΓÇî┘ç╪º█î ┘é╪º┘å┘ê┘å█î ╪¡┘é┘ê┘é DRAFT ┘ê ┘å█î╪º╪▓┘à┘å╪» ┘à╪┤╪º┘ê╪▒.

### 2026-08-09 ΓÇö ╪º╪╡┘ä╪º╪¡ legacy list: ╪¿╪»┘ê┘å LIMIT ╪▒┘ê█î bare GET
- **╪┤╪º╪«┘ç:** `ai/W1-ORCH-wave1-integration`
- **Commit:** `7ef8c72`
- **╪«┘ä╪º╪╡┘ç:** ╪▒┘ü╪╣ blocker ╪¿╪º╪▓╪¿█î┘å█î ΓÇö `listQueryPlan` ┘ü┘é╪╖ ┘ê┘é╪¬█î `page`/`limit`/`pageSize`/`paginated` ┘ç╪│╪¬ SQL LIMIT ┘à█îΓÇî╪▓┘å╪»╪¢ ╪¿╪»┘ê┘å ┘╛╪º╪▒╪º┘à╪¬╪▒ = ╪ó╪▒╪º█î┘ç┘ö ┌⌐╪º┘à┘ä ╪¿╪▒╪º█î UI/sync. ╪¬╪│╪¬ pagination █│█░/█│█░.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/pagination.js`, `server/routes/{customers,orders,followups,suppliers,persons,products,invoices}.js`, `server/scripts/test-list-pagination.js`
- **Deploy:** ΓÅ│ ╪¿╪º merge ┌⌐╪º┘à┘ä ┘ç┘à█î┘å ┘å┘ê╪¿╪¬

### 2026-08-09 ΓÇö ┘à┘ê╪¼ █î┌⌐ ┘à┘ê╪º╪▓█î MVP (F1/HR1/APP1/PAGE/E2E + ORCH)
- **╪┤╪º╪«┘ç:** `ai/W1-ORCH-wave1-integration`
- **Commit:** `0785648`
- **╪«┘ä╪º╪╡┘ç:** █î┌⌐┘╛╪º╪▒┌å┘çΓÇî╪│╪º╪▓█î ┘╛┘å╪¼ ╪¿╪▒╪┤ ┘à┘ê╪º╪▓█î ┘à┘ê╪¼ █î┌⌐: foundation ┘à┘ê╪»█î╪º┘å╪î snapshot ╪¡┘é┘ê┘é╪î SKU ╪▒┘å┌»/╪│╪º█î╪▓╪î pagination ┘ä█î╪│╪¬ΓÇî┘ç╪º╪î Playwright money-cycle╪¢ schema/mount/Help/SW v144.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/moadian/**`, `server/lib/product-variants/**`, `server/lib/pagination.js`, `server/db.js`, `server/server.js`, `server/routes/{invoices,products,moadian,payroll}.js`, `e2e/money-cycle.spec.js`, `docs/WAVE1-GATE-STATUS.md`
- **Deploy:** ΓÅ│ ╪¿╪º merge ┌⌐╪º┘à┘ä ┘ç┘à█î┘å ┘å┘ê╪¿╪¬
- **█î╪º╪»╪»╪º╪┤╪¬:** live ┘à┘ê╪»█î╪º┘å ┘ê ╪¬╪ú█î█î╪» ┘à╪┤╪º┘ê╪▒ ┘à╪º┘ä█î╪º╪¬█î ╪¿╪º╪▓.

### 2026-08-09 ΓÇö W0-OPS-002 ╪¿╪│╪¬┘ç ╪¿╪º waiver ╪»╪º╪ª┘à█î sharp runtime╪¢ Wave 0 ╪«╪▒┘ê╪¼ ┌⌐╪º┘à┘ä
- **╪┤╪º╪«┘ç:** `ai/W0-OPS-002-sharp-production-deploy` ΓåÆ merge ╪¿┘ç `claude/claude-md-docs-2ssrpy`
- **Commit:** 76a241e
- **╪«┘ä╪º╪╡┘ç:** ┘à╪º┘ä┌⌐ waiver ╪»╪º╪ª┘à█î ╪¿╪»┘ê┘å ╪º┘å┘é╪╢╪º ╪¿╪▒╪º█î ┘à╪º┘å╪»┘å production ╪▒┘ê█î `sharp@0.33.5` ┘╛╪░█î╪▒┘ü╪¬ (╪│┘ê╪▒╪│/CI ┘ç┘à┌å┘å╪º┘å `0.35.0`). W0-OPS-002 completed╪¢ active claims ╪ó╪▓╪º╪»╪¢ Gate ┘à┘ê╪¼ ╪╡┘ü╪▒ ╪¿╪▒╪º█î ╪┤╪▒┘ê╪╣ P1 ╪ó┘à╪º╪»┘ç ╪º╪╣┘ä╪º┘à ╪┤╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `docs/WAVE0-GATE-STATUS.md`, `.ai-dos/tasks/active.yaml`, `.ai-dos/project/status.md`
- **Deploy:** Γ¥î ╪¬╪║█î█î╪▒ runtime ┘å╪┤╪»╪¢ production ╪╣┘à╪»╪º┘ï `0.33.5`╪¢ HTTP ╪│╪º┘ä┘à
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪º╪▒╪¬┘é╪º█î ╪¿╪╣╪»█î CPU/hypervisor ╪º╪«╪¬█î╪º╪▒█î ╪º╪│╪¬ ┘å┘ç ┘╛█î╪┤ΓÇî╪┤╪▒╪╖ P1.

### 2026-08-09 ΓÇö W0-OPS-002: ╪│╪«╪¬ΓÇî╪│╪º╪▓█î ╪º╪│┌⌐╪▒█î┘╛╪¬ ┘╛╪│ ╪º╪▓ security review
- **╪┤╪º╪«┘ç:** `ai/W0-OPS-002-sharp-production-deploy`
- **Commit:** `24eace9`
- **╪«┘ä╪º╪╡┘ç:** ┘╛╪│ ╪º╪▓ ╪¿╪º╪▓╪¿█î┘å█î ╪º┘à┘å█î╪¬█î ┘à╪│╪¬┘é┘ä: `known_hosts` ╪º╪¼╪¿╪º╪▒█î + `RejectPolicy`╪î ╪¬╪ú█î█î╪» SHA-256 ╪¿╪º┘å╪»┘ä ╪▒┘ê█î ╪│╪▒┘ê╪▒╪î ┘ê rollback ╪«┘ê╪»┌⌐╪º╪▒ ╪º┌»╪▒ smoke ╪¿╪╣╪» ╪º╪▓ `pm2 restart` ╪┤┌⌐╪│╪¬ ╪¿╪«┘ê╪▒╪». ╪¬╪│┌⌐ ┘ç┘à┌å┘å╪º┘å blocked ╪▒┘ê█î CPU ╪º╪│╪¬.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `scripts/deploy-sharp-production.ps1`, `.ai-dos/tasks/handoff.md`
- **Deploy:** Γ¥î runtime ┘ç┘à┌å┘å╪º┘å `0.33.5` (╪╣┘à╪»█î)
- **█î╪º╪»╪»╪º╪┤╪¬:** █î╪º┘ü╪¬┘ç High ┘à╪▒╪¿┘ê╪╖ ╪¿┘ç `auto-commit-deploy.mdc` ╪«╪º╪▒╪¼ ╪º╪▓ file_claims ╪º█î┘å ╪¬╪│┌⌐ ╪º╪│╪¬ ┘ê ╪¿╪º█î╪» ╪¼╪»╪º claim ╪┤┘ê╪».

### 2026-08-09 ΓÇö W0-OPS-002: ╪¬┘ä╪º╪┤ ╪º┘à┘å deploy sharp@0.35.0 (┘à╪│╪»┘ê╪» ╪▒┘ê█î CPU)
- **╪┤╪º╪«┘ç:** `ai/W0-OPS-002-sharp-production-deploy`
- **Commit:** `6c82a9d`
- **╪«┘ä╪º╪╡┘ç:** ╪º╪│┌⌐╪▒█î┘╛╪¬ deploy ╪ó┘ü┘ä╪º█î┘å ╪¿╪º backup/rollback/CPU-preflight ╪º╪╢╪º┘ü┘ç ╪┤╪»╪¢ ╪¿╪º┘å╪»┘ä Linux x64 ╪│╪º╪«╪¬┘ç ┘ê ╪▒┘ê█î VPS ╪º█î╪▒╪º┘å ╪¿╪»┘ê┘å pull/reset ┌⌐┘ê╪▒ ╪º╪╣┘à╪º┘ä ╪ó╪▓┘à╪º█î╪┤█î ╪┤╪». ╪¿╪º█î┘å╪▒█î `0.35.0` ╪¿┘çΓÇî╪«╪º╪╖╪▒ ┘å╪¿┘ê╪» x86-64-v2 ╪▒┘ê█î QEMU CPU ┘ä┘ê╪» ┘å╪┤╪»╪¢ restore ╪«┘ê╪»┌⌐╪º╪▒ runtime ╪▒╪º ╪▒┘ê█î `0.33.5` ┘å┌»┘ç ╪»╪º╪┤╪¬ (HTTP 200╪î ╪¿╪»┘ê┘å restart ┘å╪º┘à┘ê┘ü┘é).
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `scripts/deploy-sharp-production.ps1`, `.ai-dos/tasks/*`, `docs/WAVE0-GATE-STATUS.md`
- **Deploy:** Γ¥î `sharp@0.35.0` ╪▒┘ê█î runtime ╪º╪╣┘à╪º┘ä ┘å╪┤╪» (blocker ╪│╪«╪¬ΓÇî╪º┘ü╪▓╪º╪▒█î); production ╪│╪º┘ä┘à ╪▒┘ê█î `0.33.5`
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪¿╪▒╪º█î unblock ╪¿╪º█î╪» CPU ┘à┘ç┘à╪º┘å ╪»╪▒ hypervisor ╪¿┘ç `x86-64-v2`/`host` ╪º╪▒╪¬┘é╪º █î╪º╪¿╪»╪¢ ╪│┘╛╪│ ┘ç┘à╪º┘å ╪º╪│┌⌐╪▒█î┘╛╪¬ `-Deploy` ╪¬┌⌐╪▒╪º╪▒ ╪┤┘ê╪». `erp-taranom1` ┘ê VPS dirty ╪»╪│╪¬ΓÇî┘å╪«┘ê╪▒╪»┘ç ┘à╪º┘å╪»┘å╪».

### 2026-08-02 ΓÇö RC ╪º┘à╪╢╪º╪┤╪»┘ç Android 2.0.33 + Desktop 2.0.10 + deploy ┘ê╪¿
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `fbb07a3`
- **╪«┘ä╪º╪╡┘ç:** ╪¿█î┘ä╪»/╪º┘à╪╢╪º█î RC╪¢ ╪¿┘çΓÇî╪▒┘ê╪▓ `manifest.json`/`latest.yml` ╪»╪▒ ┌»█î╪¬╪¢ ╪▒╪º┘ç┘å┘à╪º █▓.█░.█│█│/█▓.█░.█▒█░╪¢ ╪¬╪│╪¬ APK OK╪¢ EXE Authenticode Valid╪¢ SW `v143`. ┘ê╪¿ ╪º█î╪▒╪º┘å SFTP ╪┤╪». **╪ó┘╛┘ä┘ê╪» ╪¿╪º█î┘å╪▒█î APK/EXE ╪¿┘ç VPS ╪¿┘çΓÇî╪«╪º╪╖╪▒ ┘é╪╖╪╣ ┘à┌⌐╪▒╪▒ SSH ╪┤┌⌐╪│╪¬ ╪«┘ê╪▒╪»** ΓÇö ┘ü╪º█î┘äΓÇî┘ç╪º ╪»╪▒ `New folder` ┘ê `server/public/releases/` ┘à╪¡┘ä█î ╪ó┘à╪º╪»┘çΓÇî╪º┘å╪»╪¢ ╪▒┘ê█î ╪º█î╪▒╪º┘å ┘à┘ê┘é╪¬ ╪»╪º┘å┘ä┘ê╪» ┘ç┘à╪º┘å █▓.█░.█│█▓/█▓.█░.█╣ ┘à╪º┘å╪»┘ç.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/releases/manifest.json`, `android/app/build.gradle`, `desktop/package.json`, `scripts/test-android-apk.ps1`, `server/public/app.js`
- **Deploy:** Γ£à ┘ê╪¿/manifest/SW╪¢ ΓÜá∩╕Å ╪¿╪º█î┘å╪▒█î RC ╪▒┘ê█î ╪º█î╪▒╪º┘å ┘ç┘å┘ê╪▓ ┘à┘å╪¬┘é┘ä ┘å╪┤╪»┘ç (SSH drop)
- **█î╪º╪»╪»╪º╪┤╪¬:** OV/EV ┘ç┘å┘ê╪▓ ┘å█î╪│╪¬. P0-C off-server ┘ê╪º┘é╪╣█î ╪¿╪º╪▓ ╪º╪│╪¬. ╪¿╪▒╪º█î ╪º┘å╪¬╪┤╪º╪▒ ╪¿╪º█î┘å╪▒█î: USB/╪│█îΓÇî╪»█î █î╪º ╪ó┘╛┘ä┘ê╪» ┘ê┘é╪¬█î SSH ┘╛╪º█î╪»╪º╪▒ ╪┤╪» (`scripts/_deploy-rc-chunked-sftp.py`).

### 2026-08-02 ΓÇö Deploy ╪º█î╪▒╪º┘å Wave0 + ╪¿╪º╪▓█î╪º╪¿█î production (DEK/ALLOWED_ORIGINS/sharp)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `6390bcc`
- **╪«┘ä╪º╪╡┘ç:** pull ╪¬╪º `6062121`╪¢ ╪º█î╪¼╪º╪» `data-encryption-key.txt`╪¢ ╪¬┌⌐┘à█î┘ä `ecosystem.config.js` ╪¿╪º `ALLOWED_ORIGINS`/`BACKUP_*`╪¢ soft-require ╪¿╪▒╪º█î `sharp` ╪¬╪º boot ╪»╪▒ ┘å╪¿┘ê╪» ╪¿╪º█î┘å╪▒█î native ┘å╪┤┌⌐┘å╪»╪¢ health HTTP █▓█░█░╪¢ SW `v142`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/ecosystem.config.js`, `server/lib/upload-policy.js`, `docs/WAVE0-GATE-STATUS.md`, `server/public/sw.js`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `94.249.244.208` ΓÇö `erp-taranom` online╪î `/api/system/health`=200
- **█î╪º╪»╪»╪º╪┤╪¬:** P0-C ops ┘ç┘å┘ê╪▓ ╪¿╪º╪▓ (╪¿╪»┘ê┘å S3/volume ╪¼╪»╪º). DNS npm ╪▒┘ê█î VPS ┌»╪º┘ç `EAI_AGAIN`╪¢ ╪¿╪º█î┘å╪▒█î sharp ╪º╪▓ tarball ┘à╪¡┘ä█î ╪»╪▒ ╪¡╪º┘ä ╪¬┌⌐┘à█î┘ä. ╪¬┘ê╪╡█î┘ç: ┌å╪▒╪«╪┤ JWT ┘╛╪│ ╪º╪▓ ┘å╪┤╪¬ ops ┘é╪¿┘ä█î.

### 2026-08-02 ΓÇö P0-C: health/alert + weekly drill CLI + S3 round-trip verify
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** acd43a5
- **╪«┘ä╪º╪╡┘ç:** `getBackupHealth` + API `/admin/backup-health`╪¢ CLI `verify-backup` ┘ê `weekly-backup-drill`╪¢ ┘à┘é╪º█î╪│┘ç fingerprint╪¢ ╪¬╪ú█î█î╪» download/SHA ┘╛╪│ ╪º╪▓ ╪ó┘╛┘ä┘ê╪» S3╪¢ UI/╪▒╪º┘ç┘å┘à╪º╪¢ DR █▒█│/█▒█│╪¢ SW `v141`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/backup.js`, `server/server.js`, `server/scripts/weekly-backup-drill.js`, `server/scripts/verify-backup.js`, `server/scripts/test-backup-dr.js`, `docs/WAVE0-OFFSITE-BACKUP-RUNBOOK.md`
- **╪¬╪│╪¬:** backup-dr █▒█│/█▒█│╪¢ offsite-policy █┤/█┤╪¢ SMS █▓█▓╪¢ sync █┤█┤
- **Deploy:** Γ£à (╪¿╪º ┘ê╪▒┘ê╪»█î ╪¿╪╣╪»█î ┘ç┘à█î┘å ╪▒┘ê╪▓)
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪¿╪▒╪º█î ╪¿╪│╪¬┘å ┌⌐╪º┘à┘ä Gate ┘ç┘å┘ê╪▓ `BACKUP_S3_URI`/volume ╪¼╪»╪º ╪▒┘ê█î ╪º█î╪▒╪º┘å + ╪½╪¿╪¬ drill ┘ê╪º┘é╪╣█î ┘ä╪º╪▓┘à ╪º╪│╪¬.

### 2026-08-01 ΓÇö P0-Q CI/E2E + P0-B re-prep + ╪│█î╪º╪│╪¬ offsite
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `f6dbc4e`
- **╪«┘ä╪º╪╡┘ç:** ┌»╪│╪¬╪▒╪┤ `wave0-gate` (auth/upload/CSP/secrets/portal/export/offsite-policy)╪¢ Playwright critical █╡/█╡ ╪¿╪º `COMPANIES_DIR` ╪º█î╪▓┘ê┘ä┘ç╪¢ ╪¬╪│╪¬ ╪│█î╪º╪│╪¬ same-device╪¢ ╪º╪╡┘ä╪º╪¡ re-login ┘╛╪│ ╪º╪▓ company switch╪¢ runbook off-server╪¢ P0-B drift=0 (█▓█▓█┤ ┘ü╪º█î┘ä)╪¢ SW `v140`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `.github/workflows/wave0-gate.yml`, `e2e/critical-paths.spec.js`, `e2e/start-e2e-server.js`, `server/scripts/test-backup-offsite-policy.js`, `docs/WAVE0-OFFSITE-BACKUP-RUNBOOK.md`
- **╪¬╪│╪¬:** Playwright █╡/█╡╪¢ financial/hostile █▓█▓/█░╪¢ companies-fiscal █▓█░/█░╪¢ offsite-policy █┤/█┤╪¢ SMS █▓█▓╪¢ sync █┤█┤╪¢ embedded drift 0
- **Deploy:** Γ¥î Wave 0 ΓÇö deploy blocked
- **█î╪º╪»╪»╪º╪┤╪¬:** off-server ┘ê╪º┘é╪╣█î ┘ç┘å┘ê╪▓ ┘å█î╪º╪▓┘à┘å╪» S3/volume ╪¼╪»╪º ╪▒┘ê█î ╪º█î╪▒╪º┘å ╪º╪│╪¬.

### 2026-08-01 ΓÇö P0-Q: ┘à┘ç╪º╪¼╪▒╪¬ `xlsx` ΓåÆ `exceljs` + ╪¡╪░┘ü waiver
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `15bc11c`
- **╪«┘ä╪º╪╡┘ç:** ┘ê╪º╪¿╪│╪¬┌»█î ╪ó╪│█î╪¿ΓÇî┘╛╪░█î╪▒ SheetJS ╪¡╪░┘ü ╪┤╪»╪¢ I/O ╪º┌⌐╪│┘ä ╪º╪▓ ╪╖╪▒█î┘é `exceljs` + `excel-safe`/`excel-io`╪¢ ┘à╪│█î╪▒┘ç╪º█î import/export ┘ê ┌»╪▓╪º╪▒╪┤ ╪¬┘ê┘ä█î╪» async╪¢ helper ┘à┘ç╪º┌⌐ ┘ê ╪º╪│┌⌐╪▒█î┘╛╪¬ΓÇî┘ç╪º ╪º╪╡┘ä╪º╪¡╪¢ waiver audit ╪«╪º┘ä█î╪¢ ╪▒╪º┘ç┘å┘à╪º█î ╪»╪º╪«┘ä ╪¿╪▒┘å╪º┘à┘ç + SW `v139`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/excel-io.js`, `server/lib/excel-safe.js`, `server/package.json`, `desktop/package.json`, `android/.../nodejs-project/package.json`, `server/public/app.js`, `server/public/sw.js`
- **╪¬╪│╪¬:** smoke write/read╪¢ `audit:gate` OK╪¢ production-export 4/4╪¢ upload/SSRF 55/55╪¢ SMS 22/22╪¢ sync 44/44
- **Deploy:** Γ¥î Wave 0 ΓÇö deploy blocked (┘ü┘é╪╖ commit/push)
- **█î╪º╪»╪»╪º╪┤╪¬:** ┌»╪│╪¬╪▒╪┤ CI/E2E ┘à╪º┘ä█î ┘ç┘å┘ê╪▓ ╪¿╪º╪▓ ╪º╪│╪¬╪¢ gate ┘ê╪º╪¿╪│╪¬┌»█î `xlsx` ╪¿╪│╪¬┘ç ╪┤╪».

### 2026-08-01 ΓÇö P0-C partial: ╪¿╪│╪¬┘ç ╪¿┌⌐╪º┘╛ v2 + verify-only ╪ó┘å┘ä╪º█î┘å
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `2b6b280`
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/backup.js`, `server/scripts/test-backup-dr.js`, `server/scripts/restore-backup.js`, `server/server.js`
- **Deploy:** Γ¥î Wave 0 ΓÇö deploy blocked
- **█î╪º╪»╪»╪º╪┤╪¬:** ┘à╪│█î╪▒ `/home/taranom/crm-offsite-backups` ╪▒┘ê█î ┘ç┘à╪º┘å VPS ┘ç┘å┘ê╪▓ off-server ┘ê╪º┘é╪╣█î ┘å█î╪│╪¬╪¢ S3 █î╪º volume ┘à╪│╪¬┘é┘ä ┘ä╪º╪▓┘à ╪º╪│╪¬.

### 2026-08-01 ΓÇö P0-S3: ╪º┘à┘å█î╪¬ ┘ê╪¿/API + ┘å╪┤╪│╪¬/tenant (Gate ┌⌐╪» ╪¿╪│╪¬┘ç)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `2b6b280`
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/auth-sessions.js`, `server/public/app.js`, `server/lib/upload-policy.js`, `server/lib/secret-settings.js`, `server/lib/secure-html-response.js`, `docs/WAVE0-CODEX-TO-CURSOR-HANDOFF-2026-08-01.md`
- **╪¬╪│╪¬:** auth 46/46╪¢ sync 44/44╪¢ upload 55/55╪¢ secrets 37/37╪¢ CSP browser 15/15╪¢ portal 64/64╪¢ B2B 34/34╪¢ SMS 22/22╪¢ P0-S2 regression ╪│╪¿╪▓
- **Deploy:** Γ¥î Wave 0 ΓÇö deploy blocked (┘ü┘é╪╖ commit/push)
- **█î╪º╪»╪»╪º╪┤╪¬:** `DATA_ENCRYPTION_KEY` ╪¿╪▒╪º█î production ╪¿╪º█î╪» ╪¼╪»╪º┌»╪º┘å┘ç provision ╪┤┘ê╪»╪¢ rollout ╪╖╪¿┘é handoff ┬º4.3.

### 2026-08-01 ΓÇö P0-S2: ╪│╪«╪¬ΓÇî╪│╪º╪▓█î ┌⌐╪º┘à┘ä Android/Electron ┘ê ╪▓┘å╪¼█î╪▒┘ç ╪ó┘╛╪»█î╪¬
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ╪»╪▒ ╪º┘å╪¬╪╕╪º╪▒ commit ┘å┘ç╪º█î█î ┘à┘ê╪¼ ╪╡┘ü╪▒
- **╪«┘ä╪º╪╡┘ç:** JWT ┘à╪¡┘ä█î ╪¿╪º AndroidKeyStore/DPAPI ┘à╪¡╪º┘ü╪╕╪¬ ┘ê ╪¬┘ê┌⌐┘å ╪»╪│╪¬┌»╪º┘ç ╪»╪▒ SQLite ╪¿╪º AES-256-GCM ╪▒┘à╪▓ ╪┤╪»╪¢ APK ┘ü┘é╪╖ ┘╛╪│ ╪º╪▓ ┌⌐┘å╪¬╪▒┘ä HTTPS╪î ╪º┘å╪»╪º╪▓┘ç╪î SHA-256╪î package/version ┘ê signer ┘å╪╡╪¿ ┘à█îΓÇî╪┤┘ê╪»╪¢ ╪»╪│┌⌐╪¬╪º┘╛ ┘ü┘é╪╖ updater/fallback ╪╡╪¡╪¬ΓÇî╪│┘å╪¼█îΓÇî╪┤╪»┘ç ╪▒╪º ╪º╪▓ IPC ┘à╪╣╪¬╪¿╪▒ ╪º╪¼╪▒╪º ┘à█îΓÇî┌⌐┘å╪» ┘ê Windows packaged ╪¿┘çΓÇî╪╡┘ê╪▒╪¬ ┘╛█î╪┤ΓÇî┘ü╪▒╪╢ ╪º┘à╪╢╪º█î updater ╪▒╪º ╪º╪¼╪¿╪º╪▒█î ┘à█îΓÇî┌⌐┘å╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `android/app/src/main/java/ir/taranom/crm/SecureSecretStore.java`, `android/app/src/main/java/ir/taranom/crm/MainActivity.java`, `desktop/local-secret-store.js`, `desktop/main.js`, `server/sync/secure-kv.js`, `server/lib/app-update.js`, `server/public/index.html`
- **╪¬╪│╪¬:** Android 27/27 + Java compile╪¢ Desktop 42/42 + syntax╪¢ local secret/app-update/sync 41/41╪¢ release checksum/feed╪¢ ╪º┘à╪╢╪º█î APK v2 ┘ê Authenticode Valid╪¢ embedded 204/204 ┘ê drift=0.
- **Deploy:** Γ¥î ╪º┘å╪¼╪º┘à ┘å╪┤╪» ΓÇö Gate ┘à┘ê╪¼ ╪╡┘ü╪▒ ┘ê ┘à┘å╪╣ ╪╡╪▒█î╪¡ deploy ╪º█î╪▒╪º┘å.
- **█î╪º╪»╪»╪º╪┤╪¬:** ┘ü╪º█î┘äΓÇî┘ç╪º█î ╪º┘à╪╢╪º╪┤╪»┘ç ┘à┘ê╪¼┘ê╪» ┘é╪¿┘ä ╪º╪▓ ╪º█î┘å ╪¬╪║█î█î╪▒╪º╪¬ source ╪│╪º╪«╪¬┘ç ╪┤╪»┘çΓÇî╪º┘å╪»╪¢ RC ┘å┘ç╪º█î█î ╪¿╪º█î╪» ┘╛╪│ ╪º╪▓ ┘╛╪º█î╪º┘å ┘à┘ê╪¼ ╪╡┘ü╪▒ ╪»┘ê╪¿╪º╪▒┘ç build/sign/verify ╪┤┘ê╪». ┘ç█î┌å ┌⌐┘ä█î╪» █î╪º ╪▒┘à╪▓ ┘ê╪º╪▒╪» Git ┘å╪┤╪».

### 2026-08-01 ΓÇö ╪º┘à╪╢╪º█î APK/EXE + ╪º┘å╪¬╪┤╪º╪▒ releases + handoff GPT
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `1ad3acf`
- **╪«┘ä╪º╪╡┘ç:** APK 2.0.32 ┘ê EXE 2.0.9 ╪º┘à╪╢╪º ┘ê ╪»╪▒ `releases/` + New folder╪¢ `manifest.json`/`latest.yml` ╪¿┘çΓÇî╪▒┘ê╪▓╪¢ ╪▒╪º┘ç┘å┘à╪º█î Help╪¢ handoff `WAVE0-SIGNING-HANDOFF-GPT.md` ╪¿╪▒╪º█î ChatGPT. ┌»┘ê╪º┘ç█î ╪¬╪¼╪º╪▒█î ┘ê█î┘å╪»┘ê╪▓ ┘ç┘å┘ê╪▓ ╪¿╪º╪▓.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `docs/WAVE0-SIGNING-HANDOFF-GPT.md`, `docs/WAVE0-SIGNING-RUNBOOK.md`, `server/public/releases/manifest.json`, `server/public/releases/latest.yml`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å ΓÇö SFTP releases (APK/EXE) + Help/SW `v136` + manifest╪¢ health 200╪¢ `BACKUP_OFFSITE_DIR` ┘à╪º┘å╪»┌»╪º╪▒. `git pull` ╪│╪▒┘ê╪▒ ╪¿╪╣╪»╪º┘ï ╪¿╪º stash `desktop/main.js` ┘ç┘àΓÇî╪¬╪▒╪º╪▓ ┘à█îΓÇî╪┤┘ê╪».
- **█î╪º╪»╪»╪º╪┤╪¬:** JKS/PFX ╪»╪▒ git ┘å█î╪│╪¬┘å╪». EXE ╪▒┘ê█î PC ╪¿█î┘ä╪» Authenticode Valid (╪«┘ê╪»╪º┘à╪╢╪º).

### 2026-08-01 ΓÇö ops: ╪ó┘üΓÇî╪│╪º█î╪¬ ╪»╪º╪ª┘à ╪º█î╪▒╪º┘å + ╪º┘à╪╢╪º█î APK/EXE (╪«┘ê╪»╪º┘à╪╢╪º)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `dfa08ca`
- **╪«┘ä╪º╪╡┘ç:** `BACKUP_OFFSITE_DIR=/home/taranom/crm-offsite-backups` ╪»╪▒ PM2 dump ┘ê environ ┘ü╪▒╪º█î┘å╪» ┘à╪º┘å╪»┌»╪º╪▒ ╪┤╪» (JWT ╪¡┘ü╪╕ ╪┤╪»). █î┌⌐ ╪¿┌⌐╪º┘╛ ╪»╪│╪¬█î `crm-backup-20260801-120822.tar.gz` ╪¿╪º ┌⌐┘╛█î ╪ó┘üΓÇî╪│╪º█î╪¬ + sha256╪¢ drill ╪º╪│╪¬╪«╪▒╪º╪¼ ╪»╪▒ `/tmp` ΓåÆ `integrity=ok`, users=1. ╪º┘à╪╢╪º█î APK ╪¿╪º JKS ╪¼╪»█î╪» ┘ê EXE ╪¿╪º PFX ╪«┘ê╪»╪º┘à╪╢╪º ╪▒┘ê█î PC ╪¿█î┘ä╪» (Valid ┘à╪¡┘ä█î╪¢ SmartScreen ╪▒┘ê█î PC ╪»█î┌»╪▒ ┘à┘à┌⌐┘å ╪º╪│╪¬ ┘å╪º╪┤┘å╪º╪│ ╪¿┘à╪º┘å╪» ╪¬╪º ┌»┘ê╪º┘ç█î ╪¬╪¼╪º╪▒█î).
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `scripts/_iran-enable-offsite-backup.py`, `scripts/_iran-verify-offsite-env.py`, `docs/WAVE0-GATE-STATUS.md`, `docs/WAVE0-SIGNING-RUNBOOK.md`
- **Deploy:** Γ£à ops ╪▒┘ê█î ╪º█î╪▒╪º┘å (PM2 env + drill╪¢ health 200)╪¢ `git pull` ╪¿┘çΓÇî╪«╪º╪╖╪▒ dirty WT ╪│╪▒┘ê╪▒ abort ╪┤╪»╪¢ SW `v135`
- **█î╪º╪»╪»╪º╪┤╪¬:** keystore/PFX ╪»╪▒ git ┘å█î╪│╪¬┘å╪». ╪¿┌⌐╪º┘╛ΓÇî┘ç╪º ┘ü╪╣┘ä╪º┘ï `.tar.gz` ╪¿╪»┘ê┘å `.enc`. ╪│╪▒┘ê╪▒ git ┘ç┘å┘ê╪▓ ╪▒┘ê█î `54848ac` ╪¬╪º stash/clean ╪┤┘ê╪» (╪º┘╛ ╪º╪▓ ┘é╪¿┘ä offsite ╪»╪▒ ┌⌐╪» ╪»╪º╪▒╪»).

### 2026-08-01 ΓÇö ╪¿╪│╪¬┘å Gate ┌⌐╪»█î ┘à┘ê╪¼ ╪╡┘ü╪▒ (deps / offsite / ┘à╪º┘ä█î / Playwright)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `262b355`
- **╪«┘ä╪º╪╡┘ç:** ╪¬╪╡┘à█î┘à ╪º╪¼╪▒╪º█î█î ╪¿╪»┘ê┘å GPT: ╪º╪▒╪¬┘é╪º█î `adm-zip`/`nodemailer`/`sharp`╪¢ waiver ╪▓┘à╪º┘åΓÇî╪»╪º╪▒ `xlsx` + `excel-safe`╪¢ `BACKUP_OFFSITE_DIR` + DR █╢/█╢ ╪º╪▓ ┌⌐┘╛█î offsite╪¢ ╪¬╪│╪¬ ┘à╪º┘ä█î+hostile ╪┤╪▒┌⌐╪¬ █▓█░/█░╪¢ Playwright login╪¢ CI `wave0-gate`╪¢ runbook ╪º┘à╪╢╪º╪¢ `unsafe-inline` ╪ó┌»╪º┘ç╪º┘å┘ç ╪¬╪╣┘ê█î┘é.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/excel-safe.js`, `server/backup.js`, `server/scripts/test-backup-dr.js`, `server/scripts/test-wave0-financial-hostile.js`, `server/scripts/check-audit-waivers.js`, `e2e/`, `docs/WAVE0-GATE-STATUS.md`, `.github/workflows/wave0-gate.yml`
- **Deploy:** Γ£à `262b355` ΓÇö ╪º█î╪▒╪º┘å╪¢ SW `v135`
- **█î╪º╪»╪»╪º╪┤╪¬:** ┘╛┘ê╪┤┘ç `/home/taranom/crm-offsite-backups` ╪│╪º╪«╪¬┘ç ╪┤╪»╪¢ ╪¿╪▒╪º█î ┘ü╪╣╪º┘äΓÇî╪│╪º╪▓█î ╪»╪º╪ª┘à `BACKUP_OFFSITE_DIR` ╪▒╪º ╪»╪▒ PM2 env ╪¿┌»╪░╪º╪▒█î╪». ╪º┘à╪╢╪º█î EXE/APK ┘ç┘å┘ê╪▓ ┌⌐┘ä█î╪» ops ┘à█îΓÇî╪«┘ê╪º┘ç╪».

### 2026-08-01 ΓÇö ╪¿╪º╪▓╪│╪º╪▓█î ╪º╪│┘å╪º╪» ┌⌐╪º┘ä╪º ┘╛╪│ ╪º╪▓ wipe (╪¬┘ü╪╡█î┘ä█î + ┌⌐╪º╪▒╪»┌⌐╪│ + ╪▒╪│█î╪» + JE)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `551de7e`
- **╪«┘ä╪º╪╡┘ç:** ╪¿╪╣╪» ╪º╪▓ keep-products-clean╪î ┌⌐╪º┘ä╪º┘ç╪º ╪¿╪»┘ê┘å ╪¬┘ü╪╡█î┘ä█î/┌⌐╪º╪▒╪»┌⌐╪│/╪▒╪│█î╪»/╪│┘å╪» ╪º┘ü╪¬╪¬╪º╪¡█î┘ç ┘à╪º┘å╪»┘ç ╪¿┘ê╪»┘å╪». ╪º╪│┌⌐╪▒█î┘╛╪¬ `rebuild-product-docs.js` ╪¿╪▒╪º█î ┘ç┘à┘ç┘ö █┤█╣█╡ ┌⌐╪º┘ä╪º ╪¬┘ü╪╡█î┘ä█î ╪│╪º╪«╪¬╪¢ ╪¿╪▒╪º█î █│█┤█┤ ┌⌐╪º┘ä╪º█î ╪»╪º╪▒╪º█î ┘à┘ê╪¼┘ê╪»█î: stock_logs + inventory_ledger + warehouse_moves (╪▒╪│█î╪» ┬½┘à┘ê╪¼┘ê╪»█î ╪º┘ê┘ä ╪»┘ê╪▒┘ç┬╗)╪¢ ╪¿╪▒╪º█î █▓█▒ ┌⌐╪º┘ä╪º ╪¿╪º ╪¿┘ç╪º: JE `opening_inventory`. ┘ç┘àΓÇî╪¬╪▒╪º╪▓█î stockΓåöwarehouse_stock=█░ mismatch.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/scripts/rebuild-product-docs.js`, `scripts/_run-rebuild-product-docs-iran.py`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** Γ£à `551de7e` ΓÇö ╪º█î╪▒╪º┘å╪¢ VERIFY: with_coa=495╪î stock_logs/ledger/moves=344╪î opening_je=21╪î health 200╪¢ SW `v134`
- **█î╪º╪»╪»╪º╪┤╪¬:** ┌⌐╪º┘ä╪º┘ç╪º█î ╪¿╪»┘ê┘å ┘à┘ê╪¼┘ê╪»█î ┘ü┘é╪╖ ╪¬┘ü╪╡█î┘ä█î ┌»╪▒┘ü╪¬┘å╪»╪¢ ╪¿╪»┘ê┘å ╪¿┘ç╪º ╪│┘å╪» ╪¡╪│╪º╪¿╪»╪º╪▒█î ╪│╪º╪«╪¬┘ç ┘å┘à█îΓÇî╪┤┘ê╪» (┘ç┘à╪º┘å ┘é╪º┘å┘ê┘å create ┘à╪¡╪╡┘ê┘ä).

### 2026-08-01 ΓÇö ┘╛╪º┌⌐ΓÇî╪│╪º╪▓█î ╪º█î╪▒╪º┘å: ┘ü┘é╪╖ ┌⌐╪º┘ä╪º + ╪╣┌⌐╪│ (keep-products-clean)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `e4ee442`
- **╪«┘ä╪º╪╡┘ç:** ┘╛╪│ ╪º╪▓ wipe ┘å╪º┘é╪╡ ┘é╪¿┘ä█î╪î ┘ç┘å┘ê╪▓ █│█░ ┘à╪┤╪¬╪▒█î + ┘à╪º┘å╪»┘ç ╪»┘ü╪¬╪▒ (~█▒█┤ ┘à█î┘ä█î╪º╪▒╪») + ┌⌐╪º╪▒╪¿╪▒╪º┘å aref/sharafi + ╪¿╪º┘å┌⌐/╪º╪│┘å╪º╪» ╪▒┘ê█î ╪º█î╪▒╪º┘å ┘à╪º┘å╪»┘ç ╪¿┘ê╪». ╪º╪│┌⌐╪▒█î┘╛╪¬ `server/scripts/keep-products-clean.js` ┘ç┘à┘ç┘ö ╪»╪º╪»┘ç┘ö ┌⌐╪│╪¿ΓÇî┘ê┌⌐╪º╪▒ ╪▒╪º ┘╛╪º┌⌐ ┌⌐╪▒╪» ┘ê **┌⌐╪º┘ä╪º (█┤█╣█╡)╪î product_images (█│█╡█▒)╪î ┌»╪▒┘ê┘ç ┌⌐╪º┘ä╪º╪î ╪º┘å╪¿╪º╪▒ ┘ê warehouse_stock** ╪▒╪º ┘å┌»┘ç ╪»╪º╪┤╪¬╪¢ ┌⌐╪»█î┘å┌» ┘╛╪º█î┘ç ╪¿╪º╪▓╪│╪º╪▓█î ╪┤╪»╪¢ ┘ü┘é╪╖ `@admin` ┘à╪º┘å╪». ╪¿┌⌐╪º┘╛: `crm.db.pre-keep-products-2026-08-01T04-03-00-942Z.bak`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/scripts/keep-products-clean.js`, `scripts/_wipe-iran-keep-products.py`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** Γ£à `e4ee442` ΓÇö ╪º█î╪▒╪º┘å╪¢ VERIFY: customers/journal/ledger/invoices/banks=0╪¢ products=495╪¢ product_images=351╪¢ users=`admin`╪¢ health 200╪¢ SW `v133`
- **█î╪º╪»╪»╪º╪┤╪¬:** █î┌⌐ party ╪│█î╪│╪¬┘à█î `USER-00001` ╪¿╪▒╪º█î ╪«┘ê╪»┘É ┌⌐╪º╪▒╪¿╪▒ admin ╪»╪▒ ╪¿┘ê╪¬ ╪│╪º╪«╪¬┘ç ┘à█îΓÇî╪┤┘ê╪» (┘à╪┤╪¬╪▒█î ┘å█î╪│╪¬). ╪»╪│╪¬┌»╪º┘çΓÇî┘ç╪º█î ╪ó┘ü┘ä╪º█î┘å ╪¿╪º█î╪» pair/sync ┘à╪¼╪»╪» ╪┤┘ê┘å╪». ╪▒┘à╪▓ admin ╪»╪│╪¬ ┘å╪«┘ê╪▒╪»┘ç ┘à╪º┘å╪».

### 2026-08-01 ΓÇö hotfix ┘ä╪º┌»█î┘å Chrome: HTTPS redirect + CSP/CORP
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `54848ac` (+ `21a4498`)
- **╪«┘ä╪º╪╡┘ç:** ╪▒┘ê█î `http://erp...` ┌⌐┘ä╪º╪»┘ü┘ä╪▒/nginx ╪¿╪º █│█░█▒╪î POST ┘ä╪º┌»█î┘å ╪▒╪º ╪«╪▒╪º╪¿ ┘à█îΓÇî┌⌐╪▒╪»╪¢ CSP `upgrade-insecure-requests` + CORP `same-origin` ┘ç┘à fetch ╪▒╪º ┘à█îΓÇî┌⌐╪┤╪¬. ╪¡╪░┘ü upgrade/HSTS ╪º╪▓ Helmet╪î CORP=cross-origin╪î redirect ╪│┘à╪¬ ┌⌐┘ä╪º█î┘å╪¬ ╪¿┘ç https╪î SW v132. ┘ç┘à┌å┘å█î┘å backtick ╪»╪º╪«┘ä help ╪¿╪º╪╣╪½ SyntaxError ┌⌐┘ä JS ╪┤╪»┘ç ╪¿┘ê╪» ┘ê ┘ü╪▒┘à ┘ê╪▒┘ê╪» ╪º╪╡┘ä╪º┘ï ┘ê╪╡┘ä ┘å┘à█îΓÇî╪┤╪» ΓÇö ╪▒┘ü╪╣ ╪┤╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/server.js`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** Γ£à `54848ac` ΓÇö ╪º█î╪▒╪º┘å╪¢ VERIFY: PARSE_OK╪î LOGIN_OK╪î ╪¿╪»┘ê┘å upgrade-insecure╪î CORP=cross-origin╪î SW `v132`

### 2026-08-01 ΓÇö hotfix ┘ä╪º┌»█î┘å ┘ê╪¿ ╪▒┘ê█î http (CORS)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `d47d148`
- **╪«┘ä╪º╪╡┘ç:** ╪¿╪º╪▓ ┌⌐╪▒╪»┘å `http://erp.poshaktaranom.com` ╪¿╪º Origin ╪║█î╪▒ ╪º╪▓ ┘ä█î╪│╪¬ https ╪¿╪º╪╣╪½ `cb(Error)` ╪»╪▒ CORS ┘ê ┘╛╪º╪│╪« █╡█░█░ ┘à█îΓÇî╪┤╪» ┘ê ┘ê╪▒┘ê╪» ╪¼┘ä┘ê ┘å┘à█îΓÇî╪▒┘ü╪¬. ┘╛╪░█î╪▒╪┤ httpΓåöhttps ┘ç┘à╪º┘å host + deny ╪¿╪»┘ê┘å █╡█░█░╪¢ ┘╛█î╪┤ΓÇî┘ü╪▒╪╢ ALLOWED_ORIGINS ┘ç╪▒ ╪»┘ê scheme. ╪▒┘à╪▓ admin ╪▒┘ê█î ╪º█î╪▒╪º┘å ╪¿┘ç `admin123` ╪▒█î╪│╪¬ ╪┤╪» (╪¿╪º must_change_password).
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/server.js`, `server/lib/security.js`
- **Deploy:** Γ£à `d47d148` ΓÇö ╪º█î╪▒╪º┘å╪¢ ┘ä╪º┌»█î┘å ╪¿╪º Origin=http ┘ê ╪▒┘à╪▓ ┘╛█î╪┤ΓÇî┘ü╪▒╪╢ ╪¬╪ú█î█î╪» ╪┤╪»╪¢ SW `v131`

### 2026-08-01 ΓÇö hotfix ┌⌐╪▒┘ê┘à: CSP script-src-attr ╪¿╪▒╪º█î onclick
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `194e1de`
- **╪«┘ä╪º╪╡┘ç:** Helmet 7 ╪¿┘çΓÇî╪╡┘ê╪▒╪¬ ┘╛█î╪┤ΓÇî┘ü╪▒╪╢ `script-src-attr 'none'` ┘à█îΓÇî┌»╪░╪º╪▒╪» ┘ê ┘ç┘à┘ç┘ö `onclick`/`onchange`┘ç╪º█î `index.html` ╪»╪▒ Chrome ╪¿┘ä╪º┌⌐ ┘à█îΓÇî╪┤╪»┘å╪» ΓåÆ UI ┬½┘ç█î┌åΓÇî┌å█î╪▓ ┌⌐╪º╪▒ ┘å┘à█îΓÇî┌⌐┘å╪»┬╗. ╪╡╪▒█î╪¡╪º┘ï `scriptSrcAttr: unsafe-inline` + `workerSrc` ╪º╪╢╪º┘ü┘ç ╪┤╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/server.js`, `server/public/index.html`
- **Deploy:** Γ£à `194e1de` ΓÇö ╪º█î╪▒╪º┘å╪¢ CSP ╪º┌⌐┘å┘ê┘å `script-src-attr 'unsafe-inline'`╪¢ health 200╪¢ SW `v130`

### 2026-08-01 ΓÇö ╪¿█î┘ä╪» ╪»╪│┌⌐╪¬╪º┘╛ 2.0.9 + ╪º┘å╪»╪▒┘ê█î╪» 2.0.32 (╪«╪▒┘ê╪¼█î New folder)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `078b868`
- **╪«┘ä╪º╪╡┘ç:** bump ┘å╪│╪«┘ç ┘╛┘ä╪¬┘ü╪▒┘àΓÇî┘ç╪º ┘╛╪│ ╪º╪▓ Wave 0╪¢ `prepare-embedded` drift=0╪¢ ╪¿█î┘ä╪» Windows NSIS ┘ê APK release╪¢ ┌⌐┘╛█î ╪¿┘ç `D:\soft\Claud\porje\crm-taranom\New folder` (┘å┘ç scp ╪¿┘ç `/releases/` ╪│╪▒┘ê╪▒). ╪º█î╪▒╪º┘å: pull ╪¬╪º `078b868`╪¢ health `/api/system/health` =200.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/releases/manifest.json`, `android/app/build.gradle`, `android/.../main.js`, `scripts/test-android-apk.ps1`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** Γ£à `078b868` ΓÇö ┘ê╪¿ ╪º█î╪▒╪º┘å online╪¢ ╪¿╪│╪¬┘çΓÇî┘ç╪º█î EXE/APK ┘ü┘é╪╖ ┘à╪¡┘ä█î ╪»╪▒ New folder (┘ü╪º█î┘ä ╪¿╪º█î┘å╪▒█î ╪▒┘ê█î ╪│╪▒┘ê╪▒ ╪ó┘╛┘ä┘ê╪» ┘å╪┤╪»)
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪«╪▒┘ê╪¼█î: `ERP-Taranom-Setup-2.0.9.exe` (~93MB)╪î `erp-taranom-2.0.32.apk` (~67MB). SW `v129`. Gate ┘à┘ê╪¼ ╪╡┘ü╪▒ (xlsx/Playwright/╪º┘à╪╢╪º/DR off-site) ┘ç┘å┘ê╪▓ ╪¿╪º╪▓ ╪º╪│╪¬.

### 2026-08-01 ΓÇö hotfix deploy: ┘╛█î╪┤ΓÇî┘ü╪▒╪╢ ALLOWED_ORIGINS ╪¬╪º ╪│╪▒┘ê█î╪│ ╪º█î╪▒╪º┘å ╪¿╪º┘ä╪º ╪¿█î╪º█î╪»
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `3eff7ab`
- **╪«┘ä╪º╪╡┘ç:** ╪¿╪╣╪» ╪º╪▓ pull Wave 0╪î PM2 ╪¿┘çΓÇî╪«╪º╪╖╪▒ ╪º╪¼╪¿╪º╪▒█î ╪¿┘ê╪»┘å `ALLOWED_ORIGINS` ╪»╪▒ production ┌⌐╪▒╪┤ ┘à█îΓÇî┌⌐╪▒╪». ┘╛█î╪┤ΓÇî┘ü╪▒╪╢ ╪»╪º┘à┘å┘ç ╪¬╪▒┘å┘à + ╪¼╪º╪¿┘çΓÇî╪¼╪º█î█î `assertSecurityConfig` ┘é╪¿┘ä ╪º╪▓ CORS.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/security.js`, `server/server.js`
- **Deploy:** Γ£à `3eff7ab` ΓÇö ╪º█î╪▒╪º┘å╪¢ health ROOT/TIME 200╪¢ SW `v128`
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪¿┘ç╪¬╪▒ ╪º╪│╪¬ `ALLOWED_ORIGINS` ╪╡╪▒█î╪¡ ╪»╪▒ PM2 ╪¬┘å╪╕█î┘à ╪┤┘ê╪». Gate ┘à┘ê╪¼ ╪╡┘ü╪▒ ┘ç┘å┘ê╪▓ ╪¿╪º╪▓ ╪º╪│╪¬.

### 2026-08-01 ΓÇö Cursor review: ╪¬╪ú█î█î╪» commit GPT Wave 0 (`6b53483`)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** (┘ç┘à█î┘å ┘ê╪▒┘ê╪»█î docs)
- **╪«┘ä╪º╪╡┘ç:** Review ┘╛╪│ ╪º╪▓ push GPT: working tree ╪¬┘à█î╪▓ (╪¿┘çΓÇî╪¼╪▓ untracked ╪┤╪«╪╡█î). ╪¬╪ú█î█î╪» ┘à╪¡┘ä█î: SMS █▓█▓/█▓█▓╪î TLS █╣/█╣╪î sync █┤█▒/█┤█▒. Gate ┘à┘ê╪¼ ╪╡┘ü╪▒ ┘ç┘à┌å┘å╪º┘å ╪¿╪º╪▓ (xlsx/audit╪î restore off-site╪î Playwright╪î ╪º┘à╪╢╪º█î updater╪î unsafe-inline). **╪¿╪»┘ê┘å deploy ╪º█î╪▒╪º┘å.**
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `docs/CHANGE-LOG.md`, `docs/.plans/260801-wave0-critical-path/SUMMARY.md`
- **Deploy:** Γ¥î Wave 0 ΓÇö deploy blocked
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪│╪▒┘ê╪▒ ╪º█î╪▒╪º┘å ┘ç┘å┘ê╪▓ ╪▒┘ê█î commit ┘é╪»█î┘à█î ╪º╪│╪¬ ╪¬╪º ╪»╪│╪¬┘ê╪▒ ╪╡╪▒█î╪¡ deploy.

### 2026-08-01 ΓÇö Wave 0 handoff execution: P0-B ΓåÆ P0-Q
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `6b53483`
- **╪«┘ä╪º╪╡┘ç:**
  - **P0-B:** pipeline █î┌⌐╪¬╪º█î prepare ╪¿╪▒╪º█î desktop/Android╪î ╪¡╪░┘ü runtime data╪î ┌⌐┘å╪¬╪▒┘ä SHA-256 ┘ê release-id ┘à╪┤╪¬╪▒┌⌐.
  - **P0-S1:** TLS-only╪î token ╪¿╪º expiry/rotation/revoke╪î nonce ╪º┘à╪╢╪º╪┤╪»┘ç ┘ê ╪¼┘ä┘ê┌»█î╪▒█î ╪º╪▓ replay╪î ┘╛┘ê╪┤╪º┘å╪»┘å credential ╪»╪▒ ╪«╪╖╪º.
  - **P0-S2:** ╪«╪º┘à┘ê╪┤ΓÇî┌⌐╪▒╪»┘å Android backup/cleartext ╪╣┘à┘ê┘à█î ┘ê WebView debug release╪¢ sandbox ┘ê navigation/openExternal allowlist ╪»╪▒ Electron.
  - **P0-S3:** CORS production fail-fast╪î CSP ╪¿╪»┘ê┘å unsafe-eval╪î rate-limit╪î logout-all ┘à╪¿╪¬┘å█î ╪¿╪▒ auth epoch╪î audit ╪╣┘à┘ä█î╪º╪¬ backup/restore ┘ê Dependabot.
  - **P0-C:** snapshot ╪º┘à┘å SQLite╪î ╪▒┘à╪▓┘å┌»╪º╪▒█î╪î SHA-256╪î ┘à╪│█î╪▒ S3-compatible╪î RPO ┘╛╪º┘å╪▓╪»┘çΓÇî╪»┘é█î┘é┘çΓÇî╪º█î ┘ê runbook╪¢ restore drill ┘à╪¡┘ä█î █╢/█╢.
  - **P0-Q1/Q2:** ┘à╪º╪¬╪▒█î╪│ ╪¬╪│╪¬ ┘ê workflow ┘à┘ê╪º╪▓█î Wave 0 ╪¿╪º timeout ┘ê artifact ┘ä╪º┌».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `scripts/prepare-embedded-server.js`, `server/routes/sync.js`, `server/sync/device-auth.js`, `android/app/src/main/AndroidManifest.xml`, `desktop/main.js`, `server/backup.js`, `.github/workflows/wave0-gate.yml`, `docs/TEST-MATRIX-WAVE0.md`, `docs/DR-RUNBOOK.md`
- **Deploy:** Γ¥î Wave 0 ΓÇö deploy ┘à╪│╪»┘ê╪»╪¢ APK/EXE ┌⌐╪º┘à┘ä ╪│╪º╪«╪¬┘ç ┘å╪┤╪»
- **█î╪º╪»╪»╪º╪┤╪¬:** Gate ┘ç┘å┘ê╪▓ ╪¿┘çΓÇî╪╣┘ä╪¬ restore ┘ê╪º┘é╪╣█î off-site╪î ╪º┘à╪╢╪º█î updater╪î Playwright ┘à╪º┘ä█î/cross-tenant╪î ┘à┘ç╪º╪¼╪▒╪¬ ┌⌐╪º┘à┘ä inline HTML ┘ê audit ┘ê╪º╪¿╪│╪¬┌»█îΓÇî┘ç╪º ╪¿╪º╪▓ ╪º╪│╪¬. `npm audit` ╪ó┘å┘ä╪º█î┘å: █╖ advisory ╪┤╪º┘à┘ä █┤ high╪¢ ╪¿╪▒╪º█î `xlsx` ╪º╪╡┘ä╪º╪¡ ┘à┘å╪¬╪┤╪▒╪┤╪»┘ç ┘ê╪¼┘ê╪» ┘å╪»╪º╪▒╪» ┘ê ╪º╪▒╪¬┘é╪º█î breaking ╪º╪¼╪¿╪º╪▒█î ╪º┘å╪¼╪º┘à ┘å╪┤╪».

### 2026-08-01 ΓÇö pairing UI: ┘ü┘é╪╖ HTTPS + handoff P0-B/S1 ╪¼╪▓╪ª█î╪º╪¬ ╪º┌⌐╪¬╪┤╪º┘ü
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `7df60c6`
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/public/sw.js`, `docs/WAVE0-GPT-PRO-HANDOFF.md`
- **Deploy:** Γ¥î Wave 0 ΓÇö deploy blocked
- **█î╪º╪»╪»╪º╪┤╪¬:** ┘ç╪│╪¬┘ç TLS URL ┘é╪¿┘ä╪º┘ï ╪»╪▒ `df1107b`╪¢ Android cleartext ┘ç┘å┘ê╪▓ ╪¿╪º╪▓ ╪º╪│╪¬.

### 2026-08-01 ΓÇö ┘à┘ê╪¼ ╪╡┘ü╪▒: P0-A ╪¿╪│╪¬┘ç + P0-S1 ╪¼╪▓╪ª█î + handoff GPT Pro
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `df1107b`
- **╪«┘ä╪º╪╡┘ç:**
  - P0-A: cycle detection ┘à╪│█î╪▒┘à╪¡┘ê╪▒╪¢ T1-28/T1-29╪¢ runner ╪¬╪º█î┘àΓÇî╪º┘ê╪¬╪¢ `test:production` ├ù█│ ╪│╪¿╪▓ (█▒█░┘½█╢/█╕┘½█╣/█╕┘½█░ ╪»┘é█î┘é┘ç).
  - P0-S1 ╪¼╪▓╪ª█î: ╪▒╪» HTTP ╪▒█î┘à┘ê╪¬ sync╪¢ `test-sync-tls-url.js`.
  - ┌»╪▓╪º╪▒╪┤ ┘å╪º╪¬┘à╪º┘à: `docs/WAVE0-GPT-PRO-HANDOFF.md` ╪¿╪▒╪º█î ╪º╪»╪º┘à┘ç ╪»╪▒ ChatGPT Pro.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/production/bom.js`, `server/scripts/run-production-tests.js`, `server/sync/client.js`, `docs/WAVE0-GPT-PRO-HANDOFF.md`
- **Deploy:** Γ¥î Wave 0 ΓÇö deploy blocked ╪¬╪º Gate
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪¿╪╣╪»█î P0-B╪¢ ╪¬┌⌐┘à█î┘ä token/revoke/nonce ╪»╪▒ P0-S1.

### 2026-08-01 ΓÇö Wave 0 execution pack (skill, agents, plan, roadmap)
- **╪┤╪º╪«┘ç:** `codex/wave0-execution-pack-260801`
- **Commit:** `31d3c8e`
- **╪«┘ä╪º╪╡┘ç:** ╪▓█î╪▒╪│╪º╪«╪¬ Cursor ╪¿╪▒╪º█î ┘à┘ê╪¼ ╪╡┘ü╪▒: ┌⌐┘╛█î `docs/erp-taranom-master-roadmap.md`╪î skill `erp-roadmap-wave0` (┘é┘ê╪º╪╣╪» ┬º3/┬º19/┬º20 + override ╪╣╪»┘à deploy ╪¬╪º gate)╪î agents `erp-wave0-executor` ┘ê `erp-p0-bom-ci`╪î plan ╪▓┘å╪»┘ç `docs/.plans/260801-wave0-critical-path/`. ╪¿╪»┘ê┘å ╪¬╪║█î█î╪▒ runtime.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `docs/erp-taranom-master-roadmap.md`, `.cursor/skills/erp-roadmap-wave0/`, `.cursor/agents/`, `docs/.plans/260801-wave0-critical-path/`
- **Deploy:** Γ¥î Wave 0 ΓÇö infrastructure-only; deploy blocked until gate
- **█î╪º╪»╪»╪º╪┤╪¬:** P0-A ╪¿╪╣╪»╪º┘ï ╪»╪▒ ┘ç┘à█î┘å ╪▒┘ê╪▓ ╪¿╪│╪¬┘ç ╪┤╪» (┘å┌»╪º┘ç ┌⌐┘å█î╪» ┘ê╪▒┘ê╪»█î ╪¿╪º┘ä╪º).

### 2026-07-30 ΓÇö ┌⌐╪»█î┘å┌» P&L + ╪º┘ü╪¬╪¬╪º╪¡█î┘ç YTD + ╪º┌⌐╪│┘ä upsert + ╪¡╪░┘ü ╪¡╪│╪º╪¿
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `a44f596`
- **╪«┘ä╪º╪╡┘ç:**
  - ╪│╪º╪«╪¬ ┌⌐┘ä/┘à╪╣█î┘å ┘ç╪▓█î┘å┘ç ┘ê ╪»╪▒╪ó┘à╪» ╪╣┘à┘ä█î╪º╪¬█î (┘à┘ê╪º╪»╪î ╪¡┘é┘ê┘é╪î ╪º╪»╪º╪▒█î╪î ╪¬┘ê╪▓█î╪╣╪î ╪│╪▒╪¿╪º╪▒╪î ┘à╪º┘ä█î╪î ╪»╪▒╪ó┘à╪» ╪╣┘à┘ä█î╪º╪¬█î) + ╪│┘å╪» ╪º┘ü╪¬╪¬╪º╪¡█î┘ç `OPEN-PL-YTD` ╪¿╪º ┘à╪º┘å╪»┘çΓÇî┘ç╪º█î ╪▒█î╪º┘ä█î ┘ê╪│╪╖ΓÇî╪│╪º┘ä (╪╖╪▒┘ü ┘à┘é╪º╪¿┘ä `3102`).
  - ┘ê╪▒┘ê╪» ╪º┌⌐╪│┘ä ╪º╪┤╪«╪º╪╡/┌⌐╪º┘ä╪º/┌⌐╪»█î┘å┌»: ╪¬┌⌐╪▒╪º╪▒█îΓÇî┘ç╪º **╪ó┘╛╪»█î╪¬** ┘à█îΓÇî╪┤┘ê┘å╪» (┘å┘ç ╪▒╪»). ┌⌐╪º┘ä╪º█î ╪¬┌⌐╪▒╪º╪▒█î: ╪╣┌⌐╪│ ┘ê ┌⌐╪» ╪¡┘ü╪╕╪¢ ┘à┘ê╪¼┘ê╪»█î ╪ó┘╛╪»█î╪¬.
  - ╪¡╪░┘ü ╪¡╪│╪º╪¿ ┌⌐╪»█î┘å┌» ╪º╪▓ API/UI (┘ü┘é╪╖ ╪¿╪»┘ê┘å ┘ü╪▒╪▓┘å╪»/┌»╪▒╪»╪┤/╪º╪¬╪╡╪º┘ä).
  - ╪º╪│┌⌐╪▒█î┘╛╪¬ `wipe-parties-tafsili.js` ╪¿╪▒╪º█î ┘╛╪º┌⌐ΓÇî╪│╪º╪▓█î ╪º╪┤╪«╪º╪╡+╪¬┘ü╪╡█î┘ä█î ┘é╪¿┘ä ╪º╪▓ ┘ê╪▒┘ê╪» ┘à╪¼╪»╪» ╪º┌⌐╪│┘ä╪¢ `seed-pl-coa-opening.js`╪¢ ╪¬╪│╪¬ `test-pl-coa-opening.js`.
  - ╪▒┘ü╪╣ ╪¿╪º┌» ╪º┌⌐╪│┘ä ┘ü┘ç╪▒╪│╪¬ ╪º╪│┘å╪º╪»: ┘à╪¿╪º┘ä╪║ ╪▒█î╪º┘ä (╪»█î┌»╪▒ ├╖█▒█░ ╪º╪╢╪º┘ü┘ç ┘å┘à█îΓÇî╪┤┘ê╪»). SW `v127`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/routes/excel.js`, `products.js`, `accounting.js`, `server/public/index.html`, `sw.js`, `server/scripts/seed-pl-coa-opening.js`, `wipe-parties-tafsili.js`, `test-pl-coa-opening.js`, `pl-coa-opening-excel-upsert.md`
- **Deploy:** Γ£à `a44f596` ΓÇö ╪º█î╪▒╪º┘å╪¢ wipe █▒█░█┤ ╪┤╪«╪╡ + seed OPEN-PL-YTD (JE 271)╪¢ root 200╪¢ SW `v127`
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪¬┘ü╪╡█î┘ä█îΓÇî┘ç╪º█î ╪»╪º╪▒╪º█î ┌»╪▒╪»╪┤ ╪│┘å╪» (┘à╪¡┌⌐ ┘é╪»█î┘à█î) ╪╣┘à╪»╪º┘ï ╪¡╪░┘ü ┘å╪┤╪»┘å╪». ╪º╪┤╪«╪º╪╡ ┘ü╪╣╪º┘ä=█░ ╪¿╪▒╪º█î ┘ê╪▒┘ê╪» ┘à╪¼╪»╪» ╪º┌⌐╪│┘ä.

## ┘ê╪╢╪╣█î╪¬ ┘ü╪╣┘ä█î (╪ó╪«╪▒█î┘å ╪¿┘çΓÇî╪▒┘ê╪▓╪▒╪│╪º┘å█î: █▒█┤█░█╡/█░█╡/█▒█▒)

| ┘à┘ê╪▒╪» | ┘à┘é╪»╪º╪▒ |
|------|--------|
| ╪┤╪º╪«┘ç┘ö ┌⌐╪º╪▒█î | `claude/claude-md-docs-2ssrpy` |
| ╪ó╪«╪▒█î┘å commit ╪▒┘ê█î GitHub | `e5e6949` (+ docs/ops ╪¿╪╣╪»█î) |
| ╪ó╪«╪▒█î┘å commit ╪▒┘ê█î ╪│╪▒┘ê╪▒ ╪º█î╪▒╪º┘å | ┌⌐╪» `262b355`+╪¢ ops ╪ó┘üΓÇî╪│╪º█î╪¬ ┘ü╪╣╪º┘ä |
| ┘ê╪╢╪╣█î╪¬ ╪│╪▒┘ê╪▒ | Γ£à online ΓÇö health 200╪¢ `BACKUP_OFFSITE_DIR` ╪▒┘ê█î PM2 |
| Gate ┘à┘ê╪¼ ╪╡┘ü╪▒ | ≡ƒƒí ╪¿╪º┘é█î: xlsx waiver╪î ╪º┘à╪╢╪º█î ╪¬╪¼╪º╪▒█î ┘ê█î┘å╪»┘ê╪▓╪î unsafe-inline╪¢ Γ£à offsite DR + Playwright + ┘à╪º┘ä█î |
| ╪│╪▒┘ê╪▒ production | ╪¬┘å┘ç╪º ╪º█î╪▒╪º┘å `94.249.244.208` ΓÇö `/home/taranom/crm-taranom` |
| SSH ┘à╪¡┘ä█î | Host `taranom-ir` ΓåÆ `~/.ssh/id_ed25519_taranom` + `IdentitiesOnly yes` (╪¿╪»┘ê┘å ┘╛╪│┘ê╪▒╪») |
| ┘à╪«╪▓┘å GitHub | Γ£à `rashidhamedas-prog/erp-taranom` |

### 2026-07-29 ΓÇö ╪▒┘ü╪╣ ┘ç┘àΓÇî┘╛┘ê╪┤╪º┘å█î ╪│╪▒╪¬█î╪¬╪▒ ╪¼╪»┘ê┘ä ╪▒┘ê█î ╪▒╪»█î┘ü ╪º┘ê┘ä (╪│╪▒╪º╪│╪▒ ┘╛╪▒┘ê┌ÿ┘ç)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `2ec18dc`
- **╪«┘ä╪º╪╡┘ç:** ╪╣┘ä╪¬: `overflow-x:auto` ╪▒┘ê█î `.tbl-wrap` ╪º╪│┌⌐╪▒┘ê┘äΓÇî┘╛┘ê╪▒╪¬ ┘à╪¡┘ä█î ┘à█îΓÇî╪│╪º╪▓╪» ┘ê `sticky; top:88px` (┘ü╪º╪╡┘ä┘ç topbar) ╪│╪▒╪¬█î╪¬╪▒ ╪▒╪º ╪»╪º╪«┘ä ╪¼╪╣╪¿┘ç █╕█╕px ┘╛╪º█î█î┘å ┘à█îΓÇî┌⌐╪┤█î╪» ┘ê ╪▒┘ê█î ╪▒╪»█î┘ü ╪º┘ê┘ä ┘à█îΓÇî┘å╪┤╪│╪¬. ╪º╪╡┘ä╪º╪¡: ╪»╪º╪«┘ä `.tbl-wrap` ┘ç┘à█î╪┤┘ç `top:0`╪¢ ╪ó┘ü╪│╪¬ topbar ┘ü┘é╪╖ ╪¿╪▒╪º█î ╪¼╪»╪º┘ê┘ä ╪¿╪»┘ê┘å wrap. SW `v126`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/public/sw.js`
- **Deploy:** Γ£à `2ec18dc` ΓÇö ╪º█î╪▒╪º┘å╪î health 200╪î SW `v126`

### 2026-07-29 ΓÇö ┌å┘å╪»╪┤╪▒┌⌐╪¬█î + ╪│╪º┘ä ┘à╪º┘ä█î ╪«╪º┘à/╪¡╪░┘ü/┘ü╪╣╪º┘äΓÇî╪│╪º╪▓█î
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `65ee5e9`
- **╪«┘ä╪º╪╡┘ç:**
  - **┌å┘å╪»╪┤╪▒┌⌐╪¬█î:** ┘ç╪▒ ╪┤╪▒┌⌐╪¬ █î┌⌐ ┘ü╪º█î┘ä SQLite ┘à╪│╪¬┘é┘ä (`data/companies/` + `registry.json`). ╪º█î╪¼╪º╪» ╪┤╪▒┌⌐╪¬ ╪«╪º┘à╪î ╪º┘å╪¬╪«╪º╪¿ ╪┤╪▒┌⌐╪¬ ┘ü╪╣╪º┘ä ╪»╪▒ ╪¬┘å╪╕█î┘à╪º╪¬ΓåÆ╪╣┘à┘ê┘à█î╪î ╪¡╪░┘ü ╪┤╪▒┌⌐╪¬ (╪¿╪º ╪▒┘à╪▓╪¢ ╪»╪▒ ╪╡┘ê╪▒╪¬ ╪»╪º╪┤╪¬┘å ╪│┘å╪» `DELETE-COMPANY`)╪î ┘å╪┤╪º┘å ╪┤╪▒┌⌐╪¬/╪│╪º┘ä ╪»╪▒ topbar.
  - **╪│╪º┘ä ┘à╪º┘ä█î:** ╪»╪▒ ┬½╪╣┘à┘ä█î╪º╪¬ ╪│╪º┘ä ┘à╪º┘ä█î┬╗ ┘ê ╪¬┘å╪╕█î┘à╪º╪¬ ╪¡╪│╪º╪¿╪»╪º╪▒█î: ╪º┘ü╪¬╪¬╪º╪¡ ╪│╪º┘ä ╪«╪º┘à (`OPEN-CLEAN-YEAR`)╪î ┘ü╪╣╪º┘äΓÇî╪│╪º╪▓█î ╪│╪º┘ä╪î ╪¡╪░┘ü ╪│╪º┘ä ╪║█î╪▒┘ü╪╣╪º┘ä╪î ┘é┘ü┘ä/╪¿╪º╪▓┌»╪┤╪º█î█î. ╪¿┌⌐╪º┘╛ ╪º╪▓ DB ┘ü╪╣╪º┘ä ╪┤╪▒┌⌐╪¬ ┌»╪▒┘ü╪¬┘ç ┘à█îΓÇî╪┤┘ê╪».
  - ╪¿┘ç╪¿┘ê╪»: ┌⌐┘╛█î ┌⌐╪º╪▒╪¿╪▒╪º┘å ╪¿┘ç ╪┤╪▒┌⌐╪¬ ╪¼╪»█î╪» ╪¿╪º upsert (╪¿╪»┘ê┘å ╪┤┌⌐╪│╪¬ FK). ┘ü┘é╪╖ ╪│╪▒┘ê╪▒ ┘à╪▒┌⌐╪▓█î╪¢ ╪»╪│╪¬┌»╪º┘ç ╪ó┘ü┘ä╪º█î┘å ╪¬┌⌐ΓÇî╪┤╪▒┌⌐╪¬█î ┘à█îΓÇî┘à╪º┘å╪».
  - ╪¬╪│╪¬: `node server/scripts/test-companies-fiscal.js` ΓåÆ █▒█╕/█▒█╕╪¢ `test-sms` █▓█▓/█▓█▓╪¢ `test-sync` █│█│/█│█│╪¢ SW `v125`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/company-workspace.js`, `server/routes/companies.js`, `server/routes/fiscal-year.js`, `server/db.js`, `server/backup.js`, `server/server.js`, `server/public/index.html`, `server/public/sw.js`, `server/scripts/test-companies-fiscal.js`
- **Deploy:** Γ£à `65ee5e9` ΓÇö ╪º█î╪▒╪º┘å╪î health 200╪î SW `v125`

### 2026-07-28 ΓÇö ╪¿╪º╪▓█î╪º╪¿█î ┘é█î┘à╪¬ ┘ê ┌⌐╪» ┌⌐╪º┘ä╪º█î ┘ê╪º█î┘╛ΓÇî╪┤╪»┘ç ╪º╪▓ ╪¿┌⌐╪º┘╛ tar.gz
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `e552a78`
- **╪«┘ä╪º╪╡┘ç:**
  - ╪¿╪º┌» ┘é╪¿┘ä█î ╪¿╪º╪▓█î╪º╪¿█î: ╪º┘ê┘ä█î┘å ┘ü╪º█î┘ä `.db` ╪«╪º┘ä█î (`crm-pre-prod-module-ΓÇª`) ╪º┘å╪¬╪«╪º╪¿ ┘à█îΓÇî╪┤╪» ┘ê ╪ó╪▒╪┤█î┘ê┘ç╪º█î `crm-backup-*.tar.gz` ┌⌐┘ç ┘é█î┘à╪¬/┌⌐╪» ╪│╪º┘ä┘à ╪»╪º╪┤╪¬┘å╪» ┘ç╪▒┌»╪▓ ╪º╪│┌⌐┘å ┘å┘à█îΓÇî╪┤╪»┘å╪» ΓåÆ ┘ü┘é╪╖ ┘à┘ê╪¼┘ê╪»█î ╪º╪▓ ╪º┘å╪¿╪º╪▒ ╪¿╪▒┌»╪┤╪¬╪î ┘é█î┘à╪¬/┌⌐╪» ┘å┘ç.
  - ╪º┘ä╪º┘å ┘ç┘à┘ç┘ö ╪¿┌⌐╪º┘╛ΓÇî┘ç╪º█î ╪«┘ê╪º┘å╪º (╪¿╪º skip ┌⌐╪▒╪»┘å ╪¼╪»┘ê┘ä ╪«╪º┘ä█î) ╪º╪»╪║╪º┘à ┘à█îΓÇî╪┤┘ê┘å╪» ┘ê ┘ü┘é╪╖ ┘ü█î┘ä╪»┘ç╪º█î ╪╡┘ü╪▒/╪«╪º┘ä█î ┘╛╪▒ ┘à█îΓÇî╪┤┘ê┘å╪»╪¢ migration █î┌⌐ΓÇî╪¿╪º╪▒┘ç┘ö `restore_product_stock_after_image_wipe_v2`.
  - ╪▒┘ê█î production ╪º╪▓ ╪¿┌⌐╪º┘╛ █▓█╢ ╪¬█î╪▒ ╪¡╪»┘ê╪» **█│█╣ ┘é█î┘à╪¬ + █│█╣ ┌⌐╪»** ┘é╪º╪¿┘ä ╪¿╪º╪▓█î╪º╪¿█î ╪º╪│╪¬╪¢ ┘╛┌⌐ΓÇî┘ç╪º█î >█▒ ╪º╪▓ ┘é╪¿┘ä ╪│╪º┘ä┘à ╪¿┘ê╪»┘å╪».
  - ╪▒╪º┘ç┘å┘à╪º + ╪»┌⌐┘à┘ç┘ö ╪¬┘å╪╕█î┘à╪º╪¬ ΓåÆ ┘╛╪┤╪¬█î╪¿╪º┘å╪¢ SW `v124`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/restore-product-fields.js`, `server/db.js`, `server/routes/admin.js`, `server/public/index.html`, `server/public/sw.js`, `server/scripts/test-product-image-stock-wipe.js`
- **Deploy:** Γ£à `100f9e9` / SFTP ΓÇö ╪º█î╪▒╪º┘å╪î SW `v124`╪¢ ┘ä╪º┌»: `priceRestored:39, codeRestored:39` ╪º╪▓ `crm-backup-20260726-000000.tar.gz`╪¢ ╪¬╪ú█î█î╪»: emptyCode=0╪î withPrice=268
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪│╪▒┘ê╪▒ ╪¿┘ç GitHub DNS ┘å╪»╪º╪▒╪»╪¢ deploy ╪¿╪º SFTP. █▓█▓█╖ ┌⌐╪º┘ä╪º█î ╪¿╪»┘ê┘å ┘é█î┘à╪¬ ╪º╪▓ ┘é╪¿┘ä ╪»╪▒ ╪¿┌⌐╪º┘╛ ┘ç┘à ╪╡┘ü╪▒ ╪¿┘ê╪»┘å╪».

### 2026-07-28 ΓÇö Deploy ╪º█î╪▒╪º┘å + ╪▒┘ü╪╣ ╪»╪▒╪«┘ê╪º╪│╪¬ ┘╛╪│┘ê╪▒╪» SSH
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `199f73d` (┌⌐╪») + ╪º█î┘å ┘ê╪▒┘ê╪»█î CHANGE-LOG
- **╪«┘ä╪º╪╡┘ç:**
  - **Deploy:** ╪▒┘ê█î `94.249.244.208` ╪º╪▓ `af00f96` ΓåÆ `199f73d` ╪¿╪º `git pull --ff-only`╪î `npm install --omit=dev`╪î `pm2 restart erp-taranom --update-env`╪¢ health HTTP **200**╪¢ SW **`erp-taranom-v123`**.
  - **╪¿╪º╪▓█î╪º╪¿█î ┘à┘ê╪¼┘ê╪»█î:** ╪»╪▒ ╪¿┘ê╪¬╪î `restore_product_stock_after_image_wipe_v1` ┘à┘ê╪¼┘ê╪»█î **█│█╣** ┌⌐╪º┘ä╪º ╪▒╪º ╪º╪▓ `warehouse_stock` ╪¿╪▒┌»╪▒╪»╪º┘å╪» (`stockFromWarehouse:39`).
  - **SSH ╪¿╪»┘ê┘å ┘╛╪│┘ê╪▒╪»:** ╪╣┘ä╪¬ ╪»╪▒╪«┘ê╪º╪│╪¬ ┘╛╪│┘ê╪▒╪» ┘å╪¿┘ê╪»┘å Host ╪»╪▒ `~/.ssh/config` ╪¿┘ê╪» (┌å┘å╪» ┌⌐┘ä█î╪» ╪º╪┤╪¬╪¿╪º┘ç ╪º┘à╪¬╪¡╪º┘å ┘à█îΓÇî╪┤╪»). ┌⌐┘ä█î╪» ╪»╪▒╪│╪¬: `id_ed25519_taranom`. ┘ê╪▒┘ê╪»: `ssh taranom-ir`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `docs/CHANGE-LOG.md`╪¢ SSH config ┘à╪¡┘ä█î ┌⌐╪º╪▒╪¿╪▒ (╪«╪º╪▒╪¼ ╪º╪▓ ┘à╪«╪▓┘å)
- **Deploy:** Γ£à `199f73d` ΓÇö ╪º█î╪▒╪º┘å╪î SW `v123`
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪º╪▓ ╪º█î┘å ┘╛╪│ `ssh taranom-ir` █î╪º `ssh taranom@94.249.244.208` ╪¿╪º ┘ç┘à╪º┘å IdentityFile ┘ê ╪¿╪»┘ê┘å ┘╛╪│┘ê╪▒╪» ┌⌐╪º╪▒ ┘à█îΓÇî┌⌐┘å╪».

### 2026-07-27 ΓÇö ╪¿╪º╪▓╪▒╪│█î ┌⌐╪º┘à┘ä ┘╛╪▒┘ê┌ÿ┘ç: █┤█│/█┤█│ ╪¬╪│╪¬ ╪│╪¿╪▓ + ╪▒┘ü╪╣ ╪┤┘à╪º╪▒╪┤ ┘ü╪º┌⌐╪¬┘ê╪▒ ╪º╪¿╪╖╪º┘ä█î ╪»╪▒ ┌»╪▓╪º╪▒╪┤ΓÇî┘ç╪º
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `3eaec49` (+ `266915b` ╪¬╪│╪¬ΓÇî┘ç╪º)
- **╪«┘ä╪º╪╡┘ç:** ╪¿╪º╪▓╪▒╪│█î ┘à╪º┌ÿ┘ê┘äΓÇî╪¿┘çΓÇî┘à╪º┌ÿ┘ê┘ä ╪¿╪º ╪º╪¼╪▒╪º█î ┘ç┘à┘ç┘ö ╪¬╪│╪¬ΓÇî┘ç╪º (█╣ ╪«╪▒╪º╪¿█î ΓåÆ ╪╡┘ü╪▒) ┘ê ╪▒┘ü╪╣ ╪¿╪º┌»ΓÇî┘ç╪º█î ┘ê╪º┘é╪╣█î:
  - **┌»╪▓╪º╪▒╪┤ΓÇî┘ç╪º (╪¿╪º┌» R13):** ┘ü╪º┌⌐╪¬┘ê╪▒/╪«╪▒█î╪» ╪º╪¿╪╖╪º┘ä█î ╪»╪▒ `reports.js` (╪«┘ä╪º╪╡┘ç/┘à╪º┘ç╪º┘å┘ç/┌⌐╪º╪▒╪┤┘å╪º╪│/╪¿╪▒╪¬╪▒█î┘å/╪¿╪»┘ç█î)╪î `accounting/general` (╪│┘ê╪» ┘ê ╪▓█î╪º┘å)╪î `admin/dashboard`╪î `adv-reports` (aging╪î ┘ü╪▒┘ê╪┤ΓÇî╪¿┘çΓÇî┌⌐╪º┘ä╪º╪î VAT╪î ┘ü╪╡┘ä█î █▒█╢█╣╪î ┘å╪│╪¿╪¬ΓÇî┘ç╪º█î ┘à╪º┘ä█î╪î KPI╪î ┌»╪▒╪»╪┤ ╪╖╪▒┘üΓÇî╪¡╪│╪º╪¿╪î `syncVatRecords`) ┘ê `rep-ledger` (╪º┘å┌»█î╪▓┘ç/╪│┘ê╪» ┘ü╪▒┘ê╪┤┘å╪»┘ç) ╪┤┘à╪▒╪»┘ç ┘à█îΓÇî╪┤╪» ΓÇö ┘ç┘à┘ç ╪¿╪º `deleted_at`/`status<>'reversed'` ┘ü█î┘ä╪¬╪▒ ╪┤╪»┘å╪».
  - **┘ç╪│╪¬┘ç┘ö ╪«╪╖╪º:** ╪«╪╖╪º┘ç╪º█î 4xx (┘à╪½┘ä ┬½╪¬╪º╪▒█î╪« ╪│┘å╪» ┘é╪¿┘ä ╪º╪▓ ╪│╪º┘ä ┘à╪º┘ä█î┬╗) ╪»█î┌»╪▒ ┬½╪«╪╖╪º█î ╪»╪º╪«┘ä█î ╪│╪▒┘ê╪▒┬╗ ┘å┘à█îΓÇî╪┤┘ê┘å╪» ΓÇö ┘╛█î╪º┘à ┘ê╪º┘é╪╣█î ╪¿┘ç ┌⌐╪º╪▒╪¿╪▒ ┘à█îΓÇî╪▒╪│╪» (`ledger.js` status=422 + ┘ç┘å╪»┘ä╪▒ ╪│╪▒╪º╪│╪▒█î).
  - **test-sync:** ╪╣┘ä╪¬ ╪┤┌⌐╪│╪¬ ┬½B pulled central product┬╗ = ┘╛╪▒┘ê╪│┘çΓÇî┘ç╪º█î █î╪¬█î┘à ╪▒┘ê█î ┘╛┘ê╪▒╪¬ΓÇî┘ç╪º█î ╪¬╪│╪¬╪¢ ┌å┌⌐ ┘╛┘ê╪▒╪¬ + kill ┘à╪╖┘à╪ª┘å + polling ╪¿╪╣╪» ╪º╪▓ pair. █│█│/█│█│ ╪│╪¿╪▓.
  - **╪¬╪│╪¬ΓÇî┘ç╪º█î ┘é╪»█î┘à█î:** ┘ç┘à┌»╪º┘àΓÇî╪│╪º╪▓█î ╪¿╪º ┌»█î╪¬ ┬½╪¬╪║█î█î╪▒ ╪▒┘à╪▓ ╪º╪¼╪¿╪º╪▒█î┬╗ (b2b╪î 1.0.9)╪î ╪▒╪¼█î╪│╪¬╪▒█î append-only (portal╪î payroll╪î update11)╪î ╪º╪│┌⌐█î┘à╪º█î Model A (payroll nav)╪î cache-bust prod-ui╪î ╪º┘å╪¿╪º╪▒ ┘ü╪▒┘ê╪┤ ┌⌐╪º╪▒╪¿╪▒ ┘à█î╪»╪º┘å█î╪î skip ╪¬┘à█î╪▓ mahak ╪¿╪»┘ê┘å DB.
  - **╪¬╪│╪¬ ╪¼╪»█î╪» `test-business-cycle.js` (█▓█╣ ╪│┘å╪¼╪┤):** ┌å╪▒╪«┘ç┘ö ┌⌐╪º┘à┘ä ╪«╪▒█î╪» ┘å╪│█î┘çΓåÆ┘╛╪▒╪»╪º╪«╪¬ΓåÆ┘ü╪▒┘ê╪┤ ╪▒╪│┘à█îΓåÆ╪¬╪│┘ê█î┘çΓåÆ┘ç╪▓█î┘å┘ç ╪¿╪º ╪¬╪╖╪¿█î┘é ╪¬╪▒╪º╪▓ ╪ó╪▓┘à╪º█î╪┤█î/╪¬╪▒╪º╪▓┘å╪º┘à┘ç/╪╡┘ê╪▒╪¬ΓÇî╪¡╪│╪º╪¿/╪º╪▒╪▓╪┤ΓÇî┌»╪░╪º╪▒█î ┘à┘ê╪¼┘ê╪»█î ┘ê ╪│┘╛╪│ ╪º╪¿╪╖╪º┘ä R13 ╪¿╪º ╪¿╪▒┌»╪┤╪¬ ┌⌐╪º┘à┘ä ┘ê ╪╡┘ü╪▒╪┤╪»┘å ┘ç┘à┘ç┘ö ┌»╪▓╪º╪▒╪┤ΓÇî┘ç╪º█î ┘ü╪▒┘ê╪┤/┘à╪º┘ä█î╪º╪¬█î.
  - **╪▒╪º┘ç┘å┘à╪º:** ╪¿╪«╪┤ ┌»╪▓╪º╪▒╪┤╪º╪¬ + SW `v123`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `routes/reports.js`, `routes/accounting.js`, `routes/adv-reports.js`, `routes/admin.js`, `lib/rep-ledger.js`, `lib/ledger.js`, `server.js`, `scripts/test-business-cycle.js`, `scripts/test-sync.js`, `public/index.html`, `public/sw.js`
- **Deploy:** Γ£à ┘ç┘à╪▒╪º┘ç ╪¿╪º deploy █▒█┤█░█╡/█░█╡/█░█╢ ╪▒┘ê█î `199f73d`
- **█î╪º╪»╪»╪º╪┤╪¬:** `node server/scripts/test-business-cycle.js` ╪º╪▓ ╪º█î┘å ┘╛╪│ ╪¿╪╣╪» ╪º╪▓ ┘ç╪▒ ╪¬╪║█î█î╪▒ ╪¡╪│╪º╪¿╪»╪º╪▒█î/┌»╪▓╪º╪▒╪┤ ╪º╪¼╪▒╪º ╪┤┘ê╪».

### 2026-07-27 ΓÇö ╪▒┘ü╪╣ ┘ê╪º█î┘╛ ┘à┘ê╪¼┘ê╪»█î/┘╛┌⌐ ┘ç┘å┌»╪º┘à ╪ó┘╛┘ä┘ê╪» ╪╣┌⌐╪│ ┌⌐╪º┘ä╪º
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy` (+ `cursor/fix-product-image-stock-wipe-f75b`)
- **Commit:** `57b6ba8` (+ follow-ups)
- **╪«┘ä╪º╪╡┘ç:** ╪¿╪º┌»: ╪ó┘╛┘ä┘ê╪» ┘ü┘ê╪▒█î ╪╣┌⌐╪│ ┌⌐╪º┘ä╪º ╪¿╪º `PUT /products/:id` ┘ü┘é╪╖ FormData ╪¬╪╡┘ê█î╪▒ ┘à█îΓÇî┘ü╪▒╪│╪¬╪º╪» ┘ê ┌å┘ê┘å ┘ü█î┘ä╪»┘ç╪º█î ╪║╪º█î╪¿ `undefined` ╪¿┘ê╪»┘å╪»╪î `parseQty(stock)` ┘à┘ê╪¼┘ê╪»█î ╪▒╪º ╪╡┘ü╪▒ ┘ê ┘é█î┘à╪¬/┌⌐╪»/█î╪º╪»╪»╪º╪┤╪¬ ╪▒╪º ┘ç┘à ╪«╪º┘ä█î ┘à█îΓÇî┌⌐╪▒╪». ╪▒┘ü╪╣: endpoint ┘ü┘é╪╖-╪¬╪╡┘ê█î╪▒ `POST /products/:id/images`╪¢ PUT ╪¼╪▓╪ª█î╪¢ ╪º╪╡┘ä╪º╪¡ `image=''`╪¢ ╪¿╪º╪▓█î╪º╪¿█î ╪º╪▓ warehouse_stock + ╪¿┌⌐╪º┘╛ `.db`/`.tar.gz`/`.zip`╪¢ ╪»┌⌐┘à┘ç┘ö ╪»╪│╪¬█î ╪»╪▒ ╪¬┘å╪╕█î┘à╪º╪¬ΓåÆ┘╛╪┤╪¬█î╪¿╪º┘å╪¢ SW `v122`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/routes/products.js`, `server/routes/admin.js`, `server/public/index.html`, `server/public/sw.js`, `server/db.js`, `server/lib/restore-product-fields.js`, `server/scripts/restore-product-stock-after-image-wipe.js`, `server/sync/capture.js`
- **Deploy:** Γ£à ┘ç┘à╪▒╪º┘ç ╪¿╪º deploy █▒█┤█░█╡/█░█╡/█░█╢ ΓÇö migration ┘à┘ê╪¼┘ê╪»█î █│█╣ ┌⌐╪º┘ä╪º ╪▒╪º ╪º╪▓ ╪º┘å╪¿╪º╪▒ ╪¿╪▒┌»╪▒╪»╪º┘å╪»
- **█î╪º╪»╪»╪º╪┤╪¬:** ┌⌐╪» ╪▒┘ê█î `origin/claude/claude-md-docs-2ssrpy` push ╪┤╪»┘ç╪¢ SSH ╪»╪▒╪│╪¬ = `id_ed25519_taranom`.

### 2026-07-26 ΓÇö R13 ╪º╪¿╪╖╪º┘ä ┌⌐╪º┘à┘ä ╪º╪│┘å╪º╪»/┘ü╪º┌⌐╪¬┘ê╪▒/╪╣┘à┘ä█î╪º╪¬
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `e0f76a0`
- **╪«┘ä╪º╪╡┘ç:** ╪│╪«╪¬ΓÇî┌»█î╪▒█î ╪º╪¿╪╖╪º┘ä ┌⌐╪º┘à┘ä (╪│┘å╪» ┘à╪╣┌⌐┘ê╪│ + ╪¿╪▒┌»╪▒╪»╪º┘å╪»┘å ╪º╪½╪▒┘ç╪º): `reverseJournalEntry` ╪¿╪»┘ê┘å `deleted_at` (╪º╪╡┘ä+┘à╪╣┌⌐┘ê╪│ ╪»╪▒ TB ╪«┘å╪½█î ┘à█îΓÇî╪┤┘ê┘å╪»)╪¢ ╪º╪¿╪╖╪º┘ä ┘╛╪▒╪»╪º╪«╪¬/╪»╪▒█î╪º┘ü╪¬ ╪¿┘ç ╪¡╪│╪º╪¿ ╪»╪▒ ┘ä█î╪│╪¬ ╪º╪│┘å╪º╪»╪¢ ╪º╪¿╪╖╪º┘ä ╪º┘ü╪¬╪¬╪º╪¡█î┘ç ╪¿╪º┘å┌⌐/╪╡┘å╪»┘ê┘é╪¢ ╪º╪¿╪╖╪º┘ä ╪º╪╣┘à╪º┘ä ╪º┘å╪¿╪º╪▒┌»╪▒╪»╪º┘å█î╪¢ ╪º╪¿╪╖╪º┘ä ┘╛╪▒╪»╪º╪«╪¬ ╪¡┘é┘ê┘é╪¢ ╪º╪¿╪╖╪º┘ä ┘╛╪▒╪»╪º╪«╪¬ ╪¬╪ú┘à█î┘å ╪¿╪º `account_code`╪¢ reverse ┘à┘ê╪¼┘ê╪»█î ╪º┘ê┘ä ╪»┘ê╪▒┘ç ┘ç┘å┌»╪º┘à ╪║█î╪▒┘ü╪╣╪º┘ä ╪┤╪«╪╡╪¢ ┘ü█î┘ä╪¬╪▒ ╪│╪▒╪¿╪º╪▒ ╪¿╪»┘ê┘å reversed. SW `v121`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `void-journal.js`, `void-settlement.js`, `accounting.js`, `banks.js`, `cash-boxes.js`, `purchases.js`, `payroll.js`, `stocktaking.js`, `cycle-count.js`, `parties-sync.js`, `expenses.js`, `index.html`, `sw.js`
- **Deploy:** Γ£à `e0f76a0` ΓÇö git pull + pm2 ┬╖ health 200 ┬╖ SW `erp-taranom-v121`

### 2026-07-26 ΓÇö ┌⌐╪º╪▒╪┤┘å╪º╪│ ┘ü╪º┌⌐╪¬┘ê╪▒╪î ╪¡┘é┘ê┘é/┘╛╪▒╪│┘å┘ä╪î ╪¿╪º┘å┌⌐ΓÇî╪╡┘å╪»┘ê┘é╪î ╪¼╪│╪¬╪¼┘ê╪î ╪»╪º╪┤╪¿┘ê╪▒╪» ╪¡╪░┘ü
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `20fe971` (+ `e406853` changelog)
- **╪«┘ä╪º╪╡┘ç:** ╪º┘å╪¬╪«╪º╪¿ ┌⌐╪º╪▒╪┤┘å╪º╪│ ╪▒┘ê█î ┘ü╪º┌⌐╪¬┘ê╪▒ ┘ü╪▒┘ê╪┤╪¢ ┘╛█î┘ê┘å╪» ┌⌐╪º╪▒┌⌐┘å╪º┘å ╪¿┘ç ┌»╪▒┘ê┘ç ╪º╪┤╪«╪º╪╡ ┬½┘╛╪▒╪│┘å┘ä┬╗ + ┌»╪▒┘ê┘ç ┌⌐╪º╪▒┌⌐┘å╪º┘å ┘ê ╪│╪º╪«╪¬╪º╪▒ ╪¡┘é┘ê┘é ┌»╪▒┘ê┘ç█î╪¢ ╪¡╪░┘ü ╪▒╪»█î┘üΓÇî┘ç╪º█î ╪¡┘é┘ê┘é + ╪½╪¿╪¬ ╪»╪│╪¬█î ╪¡┘é┘ê┘é ┘à╪º┘ç╪¢ ╪»╪º╪┤╪¿┘ê╪▒╪»/╪ó┘à╪º╪▒ ╪¿╪º ┘ü█î┘ä╪¬╪▒ `deleted_at`╪¢ ┘à┘ê╪¼┘ê╪»█î ╪▓┘å╪»┘ç ╪¿╪º┘å┌⌐╪¢ ┘à┘ê╪¼┘ê╪»█î ╪º┘ê┘ä ╪»┘ê╪▒┘ç ╪╡┘å╪»┘ê┘é╪¢ ╪¼╪│╪¬╪¼┘ê█î ┘à┘é╪º┘ê┘à ╪¿┘ç ┘╛╪▒╪º┘å╪¬╪▓/█î/┌⌐ ╪╣╪▒╪¿█î. SW `v120`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `index.html`, `sw.js`, `invoices.js`, `payroll.js`, `schema.js`, `banks.js`, `cash-boxes.js`, `products.js`, `accounting.js`, `admin.js`, `search-normalize.js`, `tables.js`, `capture.js`, `db.js`, `currency.js`
- **Deploy:** Γ£à `e406853` ΓÇö git pull + pm2 ┬╖ health 200 ┬╖ SW `erp-taranom-v120`

### 2026-07-26 ΓÇö ╪¿╪º┌»ΓÇî┘ç╪º█î UI/╪»╪º╪┤╪¿┘ê╪▒╪»/┌»╪▓╪º╪▒╪┤/╪ó┘ä╪¿┘ê┘à + ┘ü█î┌å╪▒ ┘╛█î╪º┘à┌⌐/╪»╪▒█î╪º┘ü╪¬/┘╛╪▒╪»╪º╪«╪¬/┘à╪º┘å╪»┘ç
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `175b8d6`
- **╪«┘ä╪º╪╡┘ç:** ┘ü╪º╪▓█▒: sticky ╪¿╪»┘ê┘å auto-`tbl-scroll` ┘ç┘à┘çΓÇî╪¼╪º╪¢ ┘╛╪▒╪»╪º╪«╪¬┘å█î ╪¬╪ú┘à█î┘åΓÇî┌⌐┘å┘å╪»┘ç ╪¿╪º ╪╣┘ä╪º┘à╪¬ ╪╡╪¡█î╪¡ `creditΓêÆdebit`╪¢ ╪ó┘ä╪¿┘ê┘à ┌⌐╪º┘ä╪º ╪¿╪º fetch ┌⌐╪º┘à┘ä + ╪┤┘à╪º╪▒┘å╪»┘ç LTR╪¢ ╪¼╪▒█î╪º┘å ┘å┘é╪» ┘à╪╖╪º╪¿┘é `sections`╪¢ ┘à╪╖╪º┘ä╪¿╪º╪¬ ╪¿╪º preset ┘╛█î╪┤ΓÇî┘ü╪▒╪╢ ┬½┘ç┘à┘ç┬╗. ┘ü╪º╪▓█▓: ┘à╪¬╪║█î╪▒┘ç╪º/┘é┘ê╪º┘å█î┘å SMS ╪¿╪º ╪¬╪ú╪«█î╪▒ ┘ê hook ╪º╪¬┘ê┘à╪º╪¬╪¢ ┘à╪º┘å╪»┘ç ╪º┘ê┘ä ╪»┘ê╪▒┘ç ╪¿╪»┘ç┌⌐╪º╪▒/╪¿╪│╪¬╪º┘å┌⌐╪º╪▒╪¢ ╪»╪▒█î╪º┘ü╪¬ ╪│┘çΓÇî╪¡╪º┘ä╪¬┘ç╪¢ ┘╛╪▒╪»╪º╪«╪¬ ╪¿┘ç ╪¡╪│╪º╪¿ (┌⌐┘äΓåÆ╪¬┘ü╪╡█î┘ä█î). SW `v119`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `index.html`, `sw.js`, `accounting.js`, `products.js`, `sms-module.js`, `sms-dispatch.js`, `tables.js`, `capture.js`, `db.js`
- **Deploy:** Γ£à `feef58d` ΓÇö git stash drift + pull + pm2 ┬╖ health 200 ┬╖ SW `erp-taranom-v119`

### 2026-07-26 ΓÇö ┌⌐╪º╪▒╪¬ ┬½╪¼┘à╪╣ ╪¿╪»┘ç┌⌐╪º╪▒╪º┘å┬╗ ┘à╪º┘å╪»┘ç ┌⌐╪º┘à┘ä (┘å┘ç █▒█╢ ╪º╪▓ 15.6B)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `ae46880`
- **╪«┘ä╪º╪╡┘ç:** ╪╣╪»╪» █▒█╢ ╪»╪▒ ╪»╪º╪┤╪¿┘ê╪▒╪» ╪¿╪º┌» ┘å┘à╪º█î╪┤ ╪¿┘ê╪»: ┘à╪º┘å╪»┘ç ~█▒█╡┘½█╡ ┘à█î┘ä█î╪º╪▒╪» ╪¿╪º `fmtCompact` ╪¿┘ç `15.6B` ╪¬╪¿╪»█î┘ä ┘ê ╪»╪▒ `statCard` ╪»┘ê╪¿╪º╪▒┘ç parse/round ┘à█îΓÇî╪┤╪» ΓåÆ █▒█╢. ╪º┘ä╪º┘å ┘à╪º┘å╪»┘ç┘ö ╪¼┘à╪╣ ╪¿╪»┘ç┌⌐╪º╪▒/╪¿╪│╪¬╪º┘å┌⌐╪º╪▒ ┌⌐╪º┘à┘ä ┘å╪┤╪º┘å ╪»╪º╪»┘ç ┘à█îΓÇî╪┤┘ê╪» ┘ê ┘ü┘ê┘å╪¬ ╪¿╪º `fitStatNums` ╪»╪º╪«┘ä ┌⌐╪º╪»╪▒ ╪¼╪º ┘à█îΓÇî╪┤┘ê╪»╪¢ SW `v118`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/public/sw.js`
- **Deploy:** Γ£à `ae46880` ΓÇö git pull + pm2 ┬╖ health 200 ┬╖ SW `erp-taranom-v118`

### 2026-07-26 ΓÇö ╪ó┘à╪º╪▒ ╪»╪º╪┤╪¿┘ê╪▒╪» ╪¡╪│╪º╪¿╪»╪º╪▒█î ╪º╪▓ ╪»┘ü╪¬╪▒ ┘à╪┤╪¬╪▒█î╪º┘å (┘å┘ç ┘ü┘é╪╖ ┘ü╪º┌⌐╪¬┘ê╪▒)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `34b0aa4` (+ `61ca507` changelog)
- **╪«┘ä╪º╪╡┘ç:** ┌⌐╪º╪▒╪¬ΓÇî┘ç╪º█î ╪»╪º╪┤╪¿┘ê╪▒╪» ╪¡╪│╪º╪¿╪»╪º╪▒█î ┘ç┘à┘ç ╪╡┘ü╪▒ ╪¿┘ê╪»┘å╪» ┌å┘ê┘å `/accounting/overview` ┘ü┘é╪╖ ╪º╪▓ `invoicesΓêÆsettlements` ┘à╪¡╪º╪│╪¿┘ç ┘à█îΓÇî┌⌐╪▒╪» ┘ê ╪»╪▒ go-live ┘ü╪º┌⌐╪¬┘ê╪▒ ╪▒╪│┘à█î ╪╡┘ü╪▒ ╪º╪│╪¬. ╪º┘ä╪º┘å ┘à╪╖╪º┘ä╪¿╪º╪¬/╪¿╪│╪¬╪º┘å┌⌐╪º╪▒ ╪º╪▓ `customer_ledger` ┘ê ┘╛╪▒╪»╪º╪«╪¬┘å█î ╪º╪▓ `supplier_ledger` (╪¿╪º fallback ┘é╪¿┘ä█î) ┘à█îΓÇî╪ó█î╪»╪¢ ┌⌐╪┤ ╪╡┘ü╪¡┘ç┘ö dash ┘ç┘à ╪¿╪▒╪º█î KPI ╪»┘ê╪▒ ╪▓╪»┘ç ╪┤╪»╪¢ SW `v117`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/routes/accounting.js`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** Γ£à `5b09ce2` ΓÇö git pull + pm2 ┬╖ health 200 ┬╖ SW `erp-taranom-v117` ┬╖ outstandingΓëê15,556,288,620

### 2026-07-26 ΓÇö ╪º╪╡┘ä╪º╪¡ ╪ó╪│█î╪¿ ┘╛╪│ ╪º╪▓ sync ╪º┘å╪»╪▒┘ê█î╪»/╪»╪│┌⌐╪¬╪º┘╛: ╪¿╪º╪▓┌»╪▒╪»╪º┘å█î Model A + ┘╛╪º┌⌐ΓÇî╪│╪º╪▓█î ╪»█î╪¿╪º┌»
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `fe38338`
- **╪«┘ä╪º╪╡┘ç:** ╪¿╪╣╪» ╪º╪▓ ╪»╪│╪¬┘ê╪▒ ┬½╪▒┘ü╪╣ΓÇî╪¿╪º┌»ΓÇî┘ç╪º ╪▒╪º ╪▒┘ê█î ╪º┘å╪»╪▒┘ê█î╪»/╪»╪│┌⌐╪¬╪º┘╛ ┘ç┘à ╪º╪╣┘à╪º┘ä ┌⌐┘å┬╗╪î ╪¿┘çΓÇî╪º╪┤╪¬╪¿╪º┘ç ┘à┘å┘ê█î Model A ╪¿┘ç ╪│╪º╪«╪¬╪º╪▒ ┘é╪»█î┘à█î ╪¿╪▒┌»╪▒╪»╪º┘å╪»┘ç ╪┤╪» ┘ê instrumentation ╪»█î╪¿╪º┌» ╪»╪▒ production ┘à╪º┘å╪». ╪º┘ä╪º┘å: ┘à┘å┘ê█î ┘à╪»┘ä A (╪º╪┤╪«╪º╪╡/┌⌐╪º┘ä╪º/╪º┘å╪¿╪º╪▒/ΓÇª) ╪»┘ê╪¿╪º╪▒┘ç ┘ü╪╣╪º┘ä╪î `_dbgUi` ┘ê `/api/system/debug-ingest` ╪¡╪░┘ü╪î SW ╪╣╪º╪»█î `v115`╪î ┘à╪╖╪º┘ä╪¿╪º╪¬ ledger ╪¡┘ü╪╕╪î ╪│┘ê╪▒╪│ `desktop/server` ┘ê `android/.../server` ╪»┘ê╪¿╪º╪▒┘ç ╪º╪▓ `server/` ┘ç┘à┌»╪º┘à (╪¿╪»┘ê┘å ╪│╪º╪«╪¬ apk/exe).
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `acc-nav.js`, `index.html`, `sw.js`, `server.js`, `accounting.js`
- **Deploy:** Γ£à `fe38338` ΓÇö git pull + pm2 ┬╖ health 200 ┬╖ SW `erp-taranom-v115` ┬╖ `_dbgUi=0` / `debug-ingest=0`

### 2026-07-26 ΓÇö ╪┤┌⌐╪│╪¬┘å ┌⌐╪┤ ┘à┘å┘ê█î ╪¡╪│╪º╪¿╪»╪º╪▒█î (acc-nav ┘ç┘å┘ê╪▓ vModelA ╪▒╪º ┘å╪┤╪º┘å ┘à█îΓÇî╪»╪º╪»)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `f9e1a5f`
- **╪«┘ä╪º╪╡┘ç:** ╪│╪▒┘ê╪▒ ┘à┘å┘ê█î ╪»╪▒╪│╪¬ ╪▒╪º ╪│╪▒┘ê ┘à█îΓÇî┌⌐╪▒╪» ┘ê┘ä█î `Cache-Control: max-age=86400` ╪▒┘ê█î JS ╪¿╪º╪╣╪½ ┘à╪º┘å╪»┘å ┘å╪│╪«┘ç┘ö Model A ╪»╪▒ ┘à╪▒┘ê╪▒┌»╪▒ ┘à█îΓÇî╪┤╪». `acc-nav`/`tbl-enhance`/ΓÇª ΓåÆ `no-store`╪¢ SW `v114` ┘ç┘à┘ç┘ö cache┘ç╪º ╪▒╪º ┘╛╪º┌⌐ ┘à█îΓÇî┌⌐┘å╪»╪¢ `acc-nav.js?v=77`╪¢ ╪│╪▒┌»╪▒┘ê┘ç ┬½╪º╪╖┘ä╪º╪╣╪º╪¬ ┘╛╪º█î┘ç┬╗ ┘╛█î╪┤ΓÇî┘ü╪▒╪╢ ╪¿╪º╪▓.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/server.js`, `sw.js`, `index.html`
- **Deploy:** Γ£à `f9e1a5f`

### 2026-07-26 ΓÇö ╪¿╪º╪▓┌»╪▒╪»╪º┘å█î ╪│╪▒┌»╪▒┘ê┘çΓÇî┘ç╪º█î ┘à┘å┘ê█î ╪¡╪│╪º╪¿╪»╪º╪▒█î (┘é╪¿┘ä ╪º╪▓ Model A)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `246a44c`
- **╪«┘ä╪º╪╡┘ç:** ╪¿┘çΓÇî╪»╪▒╪«┘ê╪º╪│╪¬ ┌⌐╪º╪▒╪¿╪▒╪î ╪│╪º█î╪»╪¿╪º╪▒ ╪¡╪│╪º╪¿╪»╪º╪▒█î ╪º╪▓ ┌»╪▒┘ê┘çΓÇî╪¿┘å╪»█î ┘à╪º┌ÿ┘ê┘ä█î (╪º╪┤╪«╪º╪╡/┌⌐╪º┘ä╪º/╪º┘å╪¿╪º╪▒/ΓÇª) ╪¿┘ç ╪│╪▒┌»╪▒┘ê┘çΓÇî┘ç╪º█î ┘é╪¿┘ä█î ╪¿╪▒┌»╪▒╪»╪º┘å╪»┘ç ╪┤╪»: ╪º╪╖┘ä╪º╪╣╪º╪¬ ┘╛╪º█î┘ç╪î ╪╣┘à┘ä█î╪º╪¬╪î ╪╣┘à┘ä█î╪º╪¬ ╪º┘å╪¿╪º╪▒╪î ╪╣┘à┘ä█î╪º╪¬ ╪«╪º╪╡╪î ╪╣┘à┘ä█î╪º╪¬ ╪¡╪│╪º╪¿╪»╪º╪▒█î╪î ΓÇª ╪ó█î╪¬┘àΓÇî┘ç╪º█î ╪¼╪»█î╪» (`┌»╪▓╪º╪▒╪┤ ╪¼╪º┘à╪╣ ╪º┘å╪¿╪º╪▒`╪î `┘à╪»█î╪▒█î╪¬ ╪»╪│╪¬┌»╪º┘çΓÇî┘ç╪º`) ╪¡┘ü╪╕ ╪┤╪»┘å╪». SW `v113` / `acc-nav.js?v=76`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/acc-nav.js`, `index.html`, `sw.js`
- **Deploy:** Γ£à `246a44c` ΓÇö git pull + pm2 ┬╖ health 200 ┬╖ SW `erp-taranom-v113`

### 2026-07-26 ΓÇö ┘à╪╖╪º┘ä╪¿╪º╪¬ ╪º╪▓ ┘à╪º┘å╪»┘ç┘ö ╪»┘ü╪¬╪▒ + ┘ç┘à┌»╪º┘àΓÇî╪│╪º╪▓█î ╪│┘ê╪▒╪│ ╪º┘å╪»╪▒┘ê█î╪»/╪»╪│┌⌐╪¬╪º┘╛
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `732f52f`
- **╪«┘ä╪º╪╡┘ç:** `/receivables` ╪»█î┌»╪▒ ┘ü┘é╪╖ ╪¿┘ç ┘ü╪º┌⌐╪¬┘ê╪▒ ┘à╪¬┌⌐█î ┘å█î╪│╪¬ ΓÇö `customer_ledger` ┘à┘å╪¿╪╣ ┘à╪º┘å╪»┘ç ╪º╪│╪¬ (┘à┘å╪º╪│╪¿ go-live ╪¿╪º ╪º┘ü╪¬╪¬╪º╪¡█î┘ç ┘ê `invoices=0`). ┘å╪│╪«┘çΓÇî┘ç╪º: ╪»╪│┌⌐╪¬╪º┘╛ `2.0.9`╪î ╪º┘å╪»╪▒┘ê█î╪» `2.0.31`. ╪│┘ê╪▒╪│ embed ╪¿╪º `prepare-server` + ┌⌐┘╛█î assets ┘ç┘à┌»╪º┘à ╪┤╪» (╪¿╪»┘ê┘å ╪│╪º╪«╪¬ exe/apk╪¢ ┘╛┘ê╪┤┘çΓÇî┘ç╪º█î `desktop/server` ┘ê `android/.../server` ╪»╪▒ gitignore ┘ç╪│╪¬┘å╪» ┘ê ┘ç┘å┌»╪º┘à build ╪»┘ê╪¿╪º╪▒┘ç ┌⌐┘╛█î ┘à█îΓÇî╪┤┘ê┘å╪»).
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/routes/accounting.js`, `desktop/package.json`, `android/app/build.gradle`, `android/.../main.js`
- **Deploy:** Γ£à `732f52f` ΓÇö git pull + pm2 ┬╖ health 200 ┬╖ SW `erp-taranom-v112`

### 2026-07-26 ΓÇö ╪▒┘ü╪╣ UI: ┘à╪º┘å╪»┘ç ╪¿╪│╪¬╪º┘å┌⌐╪º╪▒╪î ┘ü╪▒█î╪▓ ╪¼╪»┘ê┘ä╪î ┘à╪╖╪º┘ä╪¿╪º╪¬╪î ╪º╪┤╪«╪º╪╡╪î ╪»╪º╪┤╪¿┘ê╪▒╪»╪î ┌⌐╪º╪▒╪»┌⌐╪│
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `80e7fd1`
- **╪«┘ä╪º╪╡┘ç:** ┘à╪º┘ç█î╪¬ ┘à╪º┘å╪»┘ç ╪º╪▓ ╪╣┘ä╪º┘à╪¬ ledger (╪│╪¿╪▓/┘é╪▒┘à╪▓)╪¢ sticky ╪¿╪º `border-separate` + `tbl-scroll` ╪¿╪▒╪º█î ┌⌐╪»█î┘å┌»╪¢ ┘à╪╖╪º┘ä╪¿╪º╪¬ as-of ╪¬╪º ╪¬╪º╪▒█î╪« ┘╛╪º█î╪º┘å (┘å┘ç ┘ü┘é╪╖ ┘ü╪º┌⌐╪¬┘ê╪▒ ╪»╪º╪«┘ä ┘à╪º┘ç)╪¢ ╪º╪┤╪«╪º╪╡ ╪¿╪»┘ç┌⌐╪º╪▒/╪¿╪│╪¬╪º┘å┌⌐╪º╪▒ + ╪¼┘à╪╣ ╪»╪▒╪│╪¬╪¢ ╪º╪╣╪»╪º╪» ┌⌐╪º╪▒╪¬ ╪»╪º╪┤╪¿┘ê╪▒╪» ╪¿╪»┘ê┘å ellipsis╪¢ ┌⌐╪º╪▒╪»┌⌐╪│ ╪¿╪º `CACHE.products=[]` ╪«╪º┘ä█î ╪»█î┌»╪▒ ┌»█î╪▒ ┘å┘à█îΓÇî┌⌐┘å╪». SW `v111`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `sw.js`, `server/routes/accounting.js`
- **Deploy:** Γ£à `80e7fd1` ΓÇö git pull + pm2 ┬╖ health 200 ┬╖ SW `erp-taranom-v111`

### 2026-07-26 ΓÇö Hardening ╪º┘à┘å: SQLite timeout/PRAGMA + ╪»╪│┌⌐╪¬╪º┘╛ loopback + ┌»╪º╪▒╪» ┘╛┘ê┘ä
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `79bf68b`
- **╪«┘ä╪º╪╡┘ç:** ╪¿╪»┘ê┘å ╪¿╪º╪▓┘å┘ê█î╪│█î ┘à┘ê╪¬┘ê╪▒ ╪│█î┘å┌⌐/UUID/rename DB. `getDB()` ╪¿╪º `timeout:5000` ┘ê PRAGMA┘ç╪º█î WAL/FK ╪▒┘ê█î ┘ç╪▒ open╪¢ ╪»╪│┌⌐╪¬╪º┘╛ `LISTEN_HOST=127.0.0.1` + handlers ╪«╪╖╪º█î Node╪¢ `assertSafeRial` ╪»╪▒ `money.js` ╪¿╪▒╪º█î ╪¼┘ä┘ê┌»█î╪▒█î ╪º╪▓ ┘ü╪│╪º╪» ╪«╪º┘à┘ê╪┤ ╪º╪╣╪»╪º╪» ╪¿╪▓╪▒┌». SW/compression/╪│█î┘å┌⌐/tbl-enhance ╪╣┘à╪»╪º┘ï ╪¿╪»┘ê┘å ╪¬╪║█î█î╪▒ (╪º╪▓ ┘é╪¿┘ä ╪»╪▒╪│╪¬ ╪¿┘ê╪»┘å╪»).
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/db.js`, `server/lib/money.js`, `desktop/main.js`
- **Deploy:** Γ£à `79bf68b` ΓÇö git pull + pm2 ┬╖ health 200 ┬╖ SW `erp-taranom-v110`
- **█î╪º╪»╪»╪º╪┤╪¬:** ┘╛█î╪┤┘å┘ç╪º╪»┘ç╪º█î ┘à╪«╪▒╪¿ ┘╛┘ä┘å audit (sync_log╪î UUID PK╪î `safeIntegers` ╪│╪▒╪º╪│╪▒█î╪î `global.gc`) ╪º╪¼╪▒╪º ┘å╪┤╪»┘å╪».

### 2026-07-26 ΓÇö ╪¬╪ú█î█î╪» ╪│╪▒┘ê╪▒ + ╪▒┘ü╪╣ APK ┌»┘àΓÇî╪┤╪»┘ç ┘╛╪│ ╪º╪▓ rename
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** (docs) ┘╛╪│ ╪º╪▓ ╪º█î┘å ┘ê╪▒┘ê╪»█î
- **╪«┘ä╪º╪╡┘ç:** ╪¿╪▒╪▒╪│█î ┌⌐╪º┘à┘ä ╪º█î╪▒╪º┘å: remote=`erp-taranom`╪î HEAD ╪¬╪º `429ecdb`╪î PM2 online╪î health/UI/SW/app-info/app-update ┘ê sync/auth ╪│╪º┘ä┘à. ╪¿╪º┌»: `manifest` ╪¿┘ç `/releases/erp-taranom.apk` ╪º╪┤╪º╪▒┘ç ┘à█îΓÇî┌⌐╪▒╪» ┘ê┘ä█î ┘ü┘é╪╖ `crm-taranom.apk` ╪▒┘ê█î ╪»█î╪│┌⌐ ╪¿┘ê╪» ΓåÆ SPA ╪¿┘çΓÇî╪º╪┤╪¬╪¿╪º┘ç `index.html` (~1.2MB) ╪¿╪º HTTP 200 ┘à█îΓÇî╪»╪º╪». ╪▒┘ê█î VPS `cp crm-taranom.apk erp-taranom.apk` (┘ç╪▒ ╪»┘ê 67MB╪î md5 █î┌⌐╪│╪º┘å). ┌å┌⌐ΓÇî┘ä█î╪│╪¬ ╪¿┘ç `DEPLOY-IRAN.md` ╪º╪╢╪º┘ü┘ç ╪┤╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `scripts/DEPLOY-IRAN.md`, `docs/CHANGE-LOG.md`, VPS `server/public/releases/erp-taranom.apk`
- **Deploy:** Γ£à hotfix ┘ü╪º█î┘ä APK ╪▒┘ê█î ╪»█î╪│┌⌐ + pull docs ╪¬╪º `429ecdb` ┬╖ health 200 ┬╖ SW `erp-taranom-v110`
- **█î╪º╪»╪»╪º╪┤╪¬:** ┘à┘å╪╖┘é ╪º┘╛┘ä█î┌⌐█î╪┤┘å (DB path╪î applicationId╪î PM2 cwd╪î `server/public/index.html`) ╪º╪▓ rebrand ╪ó╪│█î╪¿ ┘å╪»█î╪»┘ç╪¢ ╪¬╪║█î█î╪▒ ┘å╪º┘à GitHub/╪▒█î┘ä█î╪▓ ┘ü┘é╪╖ ╪▒┘ê█î ╪»╪º┘å┘ä┘ê╪» ╪º┘å╪»╪▒┘ê█î╪» ╪º╪½╪▒ ╪»╪º╪┤╪¬ ┘ê ╪▒┘ü╪╣ ╪┤╪».

### 2026-07-26 ΓÇö ┘╛╪º┌⌐ΓÇî╪│╪º╪▓█î + ╪¿╪º╪▓╪¿╪▒┘å╪» CRMΓåÆERP + ┘à╪▒╪¬╪¿ΓÇî╪│╪º╪▓█î ┘à╪«╪▓┘å
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `c294063` (+ `aa13dd8` ╪╣┘å┘ê╪º┘å .cursorrules)
- **╪«┘ä╪º╪╡┘ç:** ╪▓╪¿╪º┘ä┘ç┘ö ╪¿█î┘ä╪»/┘ä╪º┌»/dump ╪¡╪░┘ü █î╪º ╪¿┘ç `D/` ┘à┘å╪¬┘é┘ä ╪┤╪»╪¢ README ╪º╪╡┘ê┘ä█î ERP╪¢ ┘å╪º┘à APK `erp-taranom.apk`╪¢ gitignore ╪│╪«╪¬ΓÇî╪¬╪▒╪¢ `scripts/DEPLOY-IRAN.md` ╪¿╪▒╪º█î ┘à╪│█î╪▒ VPS ╪½╪º╪¿╪¬. `applicationId` ┘ê `crm.db` ┘ê ┘à╪│█î╪▒ ╪»█î╪│┌⌐ ╪º█î╪▒╪º┘å ╪╣┘à╪»╪º┘ï ╪¿╪»┘ê┘å ╪¬╪║█î█î╪▒. junction ┘ä┘ê┌⌐╪º┘ä `erp-taranom` ΓåÆ `crm-taranom`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `README.md`, `.gitignore`, `server/public/releases/manifest.json`, `scripts/build-android.ps1`, `scripts/DEPLOY-IRAN.md`
- **Deploy:** Γ£à `aa13dd8` ΓÇö git pull + pm2 ┬╖ health 200 ┬╖ ┘à╪│█î╪▒ VPS ┘ç┘à┌å┘å╪º┘å `crm-taranom`
- **█î╪º╪»╪»╪º╪┤╪¬:** ┌»█î╪¬ΓÇî┘ç╪º╪¿ ╪¿┘ç `https://github.com/rashidhamedas-prog/erp-taranom` rename ╪┤╪»╪¢ remote ┘ä┘ê┌⌐╪º┘ä ┘ê ╪º█î╪▒╪º┘å ╪¿┘çΓÇî╪▒┘ê╪▓ ╪┤╪». ┘╛┘ê╪┤┘ç┘ö ╪»█î╪│┌⌐ ┘ä┘ê┌⌐╪º┘ä ╪¿┘çΓÇî╪«╪º╪╖╪▒ ┘é┘ü┘ä Cursor ┘ç┘å┘ê╪▓ `crm-taranom` + junction `erp-taranom` ╪º╪│╪¬.

### 2026-07-26 ΓÇö Online-First + ╪º╪│┘ä╪º╪¬ █▒ ┘à┘ê╪¿╪º█î┘ä/█▒ ╪»╪│┌⌐╪¬╪º┘╛ + ╪¿┘ç█î┘å┘çΓÇî╪│╪º╪▓█î ╪│█î┘å┌⌐
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `6eb8462`
- **╪«┘ä╪º╪╡┘ç:** ┘å╪┤╪│╪¬ ┘ê╪▒┘ê╪» per-slot (`mobile`/`desktop`/`web`)╪¢ ┘ç┘à╪▓┘à╪º┘å █▒ ┘à┘ê╪¿╪º█î┘ä + █▒ ╪»╪│┌⌐╪¬╪º┘╛ ┘à╪¼╪º╪▓. Online-First: ╪▒┘ê█î╪»╪º╪» online/offline/visibility + poll 10s + flush outbox 400. ┘╛┘å┘ä ┘à╪»█î╪▒█î╪¬ ╪»╪│╪¬┌»╪º┘çΓÇî┘ç╪º + ┘ä█î┘å┌⌐ ╪»╪▒ ╪¬┘å╪╕█î┘à╪º╪¬ ╪│█î╪│╪¬┘à. ╪º█î┘å╪»┌⌐╪│ΓÇî┘ç╪º█î outbox/products/customers/sync_devices. SW `v110`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/routes/auth.js`, `server/db.js`, `server/sync/client.js`, `server/public/index.html`, `sw.js`
- **Deploy:** Γ£à `6eb8462` / SW `erp-taranom-v110` ΓÇö git pull + pm2 ┬╖ health 200

### 2026-07-26 ΓÇö ╪»╪º╪┤╪¿┘ê╪▒╪» ┘à╪»█î╪▒█î╪¬: ╪¼┘à╪╣ ╪¿╪»┘ç┌⌐╪º╪▒/╪¿╪│╪¬╪º┘å┌⌐╪º╪▒ ╪¼╪»╪º + ┘ü╪▒█î╪▓ ╪│╪▒╪¬█î╪¬╪▒
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `cf79a43`
- **╪«┘ä╪º╪╡┘ç:** ┘╛┘å┘ä ┘à╪»█î╪▒█î╪¬ (╪»╪º╪┤╪¿┘ê╪▒╪» ╪º╪»┘à█î┘å/┌⌐╪º╪▒╪┤┘å╪º╪│) ┘ê ┘ä█î╪│╪¬ ┘à╪┤╪¬╪▒█î╪º┘å/╪º╪┤╪«╪º╪╡: ╪│╪¬┘ê┘åΓÇî┘ç╪º█î ╪¼╪»╪º ╪¿╪»┘ç┌⌐╪º╪▒ ┘ê ╪¿╪│╪¬╪º┘å┌⌐╪º╪▒ + ╪¼┘à╪╣ ┌»╪▓╪º╪▒╪┤ ╪¼╪»╪º┌»╪º┘å┘ç (╪»█î┌»╪▒ ╪¿╪│╪¬╪º┘å┌⌐╪º╪▒ ╪¿┘ç ╪¿╪»┘ç┌⌐╪º╪▒╪º┘å ╪º╪╢╪º┘ü┘ç ┘å┘à█îΓÇî╪┤┘ê╪»). KPI ╪¼┘à╪╣ ╪¿╪»┘ç┌⌐╪º╪▒╪º┘å/╪¿╪│╪¬╪º┘å┌⌐╪º╪▒╪º┘å. ╪│╪▒╪¬█î╪¬╪▒ ╪¼╪»╪º┘ê┘ä ╪»╪▒ ┌⌐┘ä ╪¿╪▒┘å╪º┘à┘ç sticky (╪▓█î╪▒ topbar╪¢ ╪»╪º╪«┘ä `.tbl-scroll` ╪¿╪º top:0). API `/admin/customer-balances` ┘ê `/customers/balances` ┘ü█î┘ä╪» `nature`. SW `v109` / tbl-enhance `?v=77`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `tbl-enhance.js`, `sw.js`, `routes/admin.js`, `routes/customers.js`
- **Deploy:** Γ£à `cf79a43` / SW `erp-taranom-v109` ΓÇö git pull + pm2 ┬╖ health 200

### 2026-07-26 ΓÇö ╪»╪▒╪╡╪» ┘╛┘ê╪▒╪│╪º┘å╪¬ ╪º╪╣╪┤╪º╪▒ + ╪º┘å╪¬╪«╪º╪¿ ╪¡╪│╪º╪¿ ┘à╪╣█î┘å ╪»╪▒ ╪»╪▒█î╪º┘ü╪¬/┘╛╪▒╪»╪º╪«╪¬
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `0928a3f`
- **╪«┘ä╪º╪╡┘ç:** `fmtPct`/`parsePct` ╪¿╪º ╪▒┘å╪» █│ ╪▒┘é┘à ╪º╪╣╪┤╪º╪▒╪¢ ┘å┘à╪º█î╪┤ ┘å╪▒╪« ╪º┘å┌»█î╪▓┘ç ╪»█î┌»╪▒ ╪¿╪º `fmt` (Math.round) ╪¿┘ç █╡ ╪¬╪¿╪»█î┘ä ┘å┘à█îΓÇî╪┤┘ê╪». ╪º┘å╪¬╪«╪º╪¿ ╪¡╪│╪º╪¿ ┘à╪╣█î┘å ╪»╪▒ ╪»╪▒█î╪º┘ü╪¬ ┘à╪┤╪¬╪▒█î╪î ┘╛╪▒╪»╪º╪«╪¬ ╪¿┘ç ╪┤╪«╪╡ ┘ê ┘ü█î┘ä╪¬╪▒ ┘à╪╣█î┘å ╪»╪▒ ┘╛╪▒╪»╪º╪«╪¬ ┘ç╪▓█î┘å┘ç╪¢ `account_code` ╪▒┘ê█î settlements/supplier_payments. ┘╛╪º┌⌐ΓÇî╪│╪º╪▓█î ┘ä╪º┌» ╪»█î╪¿╪º┌». SW `v108`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `tbl-enhance.js`, `sw.js`, `routes/{accounting,purchases,admin}.js`, `db.js`
- **Deploy:** Γ£à `0928a3f` / SW `erp-taranom-v108` ΓÇö ╪»╪▒ ╪¡╪º┘ä ╪¿█î┘ä╪» ╪º┘å╪»╪▒┘ê█î╪» 2.0.30 ┘ê ╪»╪│┌⌐╪¬╪º┘╛ 2.0.8

### 2026-07-26 ΓÇö ╪▒┘ü╪╣ netProps + ╪▒┘å┌» ╪╣┘å╪º┘ê█î┘å ╪│╪º█î╪»╪¿╪º╪▒
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `4ea1870`
- **╪«┘ä╪º╪╡┘ç:** `rebuildFooter` ┘à╪¬╪║█î╪▒ ╪▒╪º `netRow` ╪│╪º╪«╪¬┘ç ╪¿┘ê╪» ┘ê┘ä█î `netProps` ┘à█îΓÇî╪«┘ê╪º┘å╪» ΓåÆ ╪«╪╖╪º█î ┬½netProps is not defined┬╗ ╪»╪▒ ╪º┌⌐╪½╪▒ ╪¬╪¿ΓÇî┘ç╪º█î ╪¡╪│╪º╪¿╪»╪º╪▒█î ┘╛╪│ ╪º╪▓ enhance ╪¼╪»┘ê┘ä. ╪╣┘å╪º┘ê█î┘å ╪▓█î╪▒┌»╪▒┘ê┘ç ╪│╪º█î╪»╪¿╪º╪▒ (╪º╪╖┘ä╪º╪╣╪º╪¬ ┘╛╪º█î┘ç/╪╣┘à┘ä█î╪º╪¬/┌»╪▓╪º╪▒╪┤╪º╪¬) ╪¿╪º `color:var(--purple)` ╪▒┘ê█î ╪│╪¿╪▓ ╪│╪º█î╪»╪¿╪º╪▒ ┘å╪º┘à╪▒╪ª█î ╪¿┘ê╪»┘å╪» ΓåÆ ┌⌐┘ä╪º╪│ `.nav-acc-sub-title` ╪▒┘ê╪┤┘å. SW `v107` / tbl-enhance `?v=76`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/tbl-enhance.js`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** Γ£à `4ea1870` / SW `erp-taranom-v107` ΓÇö git pull + pm2 ┬╖ health 200
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪¿█î┘ä╪» ╪º┘å╪»╪▒┘ê█î╪»/╪»╪│┌⌐╪¬╪º┘╛ ┘╛╪│ ╪º╪▓ ╪¬╪ú█î█î╪» ┌⌐╪º╪▒╪¿╪▒

### 2026-07-26 ΓÇö ┘╛╪º┌⌐ΓÇî╪│╪º╪▓█î instrumentation ┘ä╪º┌»█î┘å
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `148e2e8`
- **╪«┘ä╪º╪╡┘ç:** ╪¡╪░┘ü ┘ä╪º┌»ΓÇî┘ç╪º█î ╪»█î╪¿╪º┌» ┘à┘ê┘é╪¬ ╪º╪▓ handler ┘ê╪▒┘ê╪» ┘╛╪│ ╪º╪▓ ╪¬╪ú█î█î╪» ╪▒┘ü╪╣ ╪¿╪º┌». SW `v106`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/public/sw.js`
- **Deploy:** Γ£à `148e2e8` / SW `erp-taranom-v106` ΓÇö git pull + pm2 ┬╖ health 200

### 2026-07-26 ΓÇö ╪▒┘ü╪╣ ┘ä╪º┌»█î┘å ╪¿█îΓÇî┘╛╪º╪│╪« (syntax ╪»╪▒ ╪ó┘╛┘ä┘ê╪» ╪╣┌⌐╪│)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `c87901f`
- **╪«┘ä╪º╪╡┘ç:** ╪«╪╖╪º█î `bindProductImageInstantUpload(${id||0})` ╪¿█î╪▒┘ê┘å ╪º╪▓ template ╪¿╪º╪╣╪½ SyntaxError ┌⌐┘ä `index.html` ┘à█îΓÇî╪┤╪»╪¢ listener ┘ä╪º┌»█î┘å ┘ç╪▒┌»╪▓ ┘ê╪╡┘ä ┘å┘à█îΓÇî╪┤╪» ┘ê ╪¿╪º ╪▓╪»┘å ┘ê╪▒┘ê╪» ┘ç█î┌å ╪º╪¬┘ü╪º┘é█î ┘å┘à█îΓÇî╪º┘ü╪¬╪º╪». ╪º╪╡┘ä╪º╪¡ ╪¿┘ç `id||0` + SW `v105`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/public/sw.js`
- **Deploy:** Γ£à `c87901f` / SW `erp-taranom-v105` ΓÇö git pull + pm2 ┬╖ health 200
- **█î╪º╪»╪»╪º╪┤╪¬:** █î┌⌐ΓÇî╪¿╪º╪▒ hard refresh / Ctrl+F5 ╪¿╪╣╪» ╪º╪▓ deploy

### 2026-07-26 ΓÇö ╪ó┘╛╪»█î╪¬ UX / Offline-First / ╪¼╪»╪º┘ê┘ä / ┘å╪º┘ê╪¿╪▒█î ┘à╪»┘ä A
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `e30b92b`
- **╪«┘ä╪º╪╡┘ç:** ╪▒┘ü╪╣ ╪¿╪º┌» ╪│╪▒┌å/┌»╪º┘ä╪▒█î/Preview ┌⌐╪º┘ä╪º ┘ê ╪º┌⌐╪│┘ä ┌å┌⌐╪¢ footer ╪¼╪»╪º┘ê┘ä ╪¿╪º ╪¼┘à╪╣/┘à█î╪º┘å┌»█î┘å/╪¬┘ü╪º╪╢┘ä ╪¿╪»┘ç┌⌐╪º╪▒-╪¿╪│╪¬╪º┘å┌⌐╪º╪▒╪¢ ╪º┌⌐╪│┘ä ╪»╪º╪▒╪º█î█î ╪½╪º╪¿╪¬╪¢ ┌»╪▓╪º╪▒╪┤ ╪¼╪º┘à╪╣ ╪º┘å╪¿╪º╪▒╪¢ ╪ó┘╛┘ä┘ê╪» ┘ü┘ê╪▒█î ╪╣┌⌐╪│╪¢ ┘à┘ê╪¼┘ê╪»█î ╪º┘ê┘ä ╪»┘ê╪▒┘ç ╪¿╪º┘å┌⌐+JE╪¢ ┘╛┘å┘ä revoke ╪»╪│╪¬┌»╪º┘çΓÇî┘ç╪º╪¢ ┘å╪º┘ê╪¿╪▒█î ┘à╪º┌ÿ┘ê┘äΓÇî┘à╪¡┘ê╪▒ ┘à╪»┘ä A╪¢ Online-First ╪▒┘ê█î ╪│█î┘å┌⌐ ┘à┘ê╪¼┘ê╪»╪¢ Single-Device login. ╪¿╪»┘ê┘å React/RxDB/exceljs.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `acc-nav.js`, `tbl-enhance.js`, `sw.js`, `server/routes/{excel,banks,warehouses,auth,cheque-records}.js`, `server/sync/{client,capture}.js`, `server/db.js`
- **Deploy:** Γ£à `e30b92b` / SW `erp-taranom-v104` ΓÇö git pull + pm2 ┬╖ health 200
- **█î╪º╪»╪»╪º╪┤╪¬:** SW `erp-taranom-v104`

### 2026-07-25 ΓÇö ╪▒┘ü╪╣ ╪«╪╖╪º█î ┌⌐╪º╪░╪¿ ╪ó┘╛┘ä┘ê╪» ╪╣┌⌐╪│ ┌⌐╪º┘ä╪º
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `3592351`
- **╪«┘ä╪º╪╡┘ç:** ╪ó┘╛┘ä┘ê╪» ╪╣┌⌐╪│ ┌»╪º┘ç█î ╪▒┘ê█î ╪│╪▒┘ê╪▒ ┘à┘ê┘ü┘é ╪¿┘ê╪» ┘ê┘ä█î UI ╪«╪╖╪º ┘à█îΓÇî╪»╪º╪» (timeout/┘╛╪▒┘ê┌⌐╪│█î █î╪º ╪«╪╖╪º█î ╪¬╪º╪▓┘çΓÇî╪│╪º╪▓█î ┘ä█î╪│╪¬). ┘ü╪┤╪▒╪»┘çΓÇî╪│╪º╪▓█î ╪¬╪╡┘ê█î╪▒ ┘é╪¿┘ä ╪º╪▓ ╪º╪▒╪│╪º┘ä╪î ┘╛╪º╪│╪« ╪º┘à┘å JSON╪î ┘ê ╪º┌»╪▒ ╪╣┌⌐╪│ ┘ê╪º┘é╪╣╪º┘ï ╪░╪«█î╪▒┘ç ╪┤╪»┘ç ╪¿╪º╪┤╪» ╪░╪«█î╪▒┘ç ┘à┘ê┘ü┘é ┘å┘à╪º█î╪┤ ╪»╪º╪»┘ç ┘à█îΓÇî╪┤┘ê╪». SW `v103`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/routes/products.js`, `server/public/sw.js`
- **Deploy:** Γ£à `3592351` / SW `erp-taranom-v103` ΓÇö reset + SFTP + pm2 ┬╖ health 200

### 2026-07-25 ΓÇö ╪│┘ê╪▒╪¬ ┌⌐╪º╪¬╪º┘ä┘ê┌» ╪¿╪▒ ╪º╪│╪º╪│ ┘à┘ê╪¼┘ê╪»█î (┘å┘ç ┘é█î┘à╪¬)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `99dcb5d` (feature `2ffd5df`)
- **╪«┘ä╪º╪╡┘ç:** ╪¬╪▒╪¬█î╪¿ ┘å┘à╪º█î╪┤ ┌⌐╪º┘ä╪º ╪»╪▒ ┌⌐╪º╪¬╪º┘ä┘ê┌»/┘à╪»█î╪▒/╪¿╪º╪▓╪º╪▒█î╪º╪¿/B2B ╪º╪▓ ╪¿█î╪┤╪¬╪▒█î┘å **┘à┘ê╪¼┘ê╪»█î** ╪¿┘ç ┌⌐┘à╪¬╪▒█î┘å ╪º╪╡┘ä╪º╪¡ ╪┤╪» (┘é╪¿┘ä╪º┘ï ╪º╪┤╪¬╪¿╪º┘ç ╪▒┘ê█î ┘é█î┘à╪¬ ╪¿┘ê╪»). SW `v102`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/routes/products.js`, `server/routes/b2b.js`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** Γ£à `99dcb5d` / SW `erp-taranom-v102` ΓÇö reset + SFTP + pm2 ┬╖ health 200
- **█î╪º╪»╪»╪º╪┤╪¬:** █î┌⌐ΓÇî╪¿╪º╪▒ hard refresh.

### 2026-07-25 ΓÇö ╪ó┘╛┘ä┘ê╪» ╪╣┌⌐╪│ ┌⌐╪º┘ä╪º + ╪│┘ê╪▒╪¬ ┘é█î┘à╪¬ ┌⌐╪º╪¬╪º┘ä┘ê┌»
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `85dad85`
- **╪«┘ä╪º╪╡┘ç:** ╪▒┘ü╪╣ ╪»┘ê╪¿╪º╪▒┘çΓÇî╪│╪º╪▓█î ╪ó┘╛┘ä┘ê╪» ┘ê ╪¡╪░┘ü ╪╣┌⌐╪│ ┘é╪¿┘ä█î ┘ç┘å┌»╪º┘à ┘ê█î╪▒╪º█î╪┤ ┌⌐╪º┘ä╪º (┘ê█î╪▒╪º█î╪┤ ╪»█î┌»╪▒ ╪╣┌⌐╪│ ╪º╪╡┘ä█î ╪▒╪º ╪¼╪º█î┌»╪▓█î┘å/╪¡╪░┘ü ┘å┘à█îΓÇî┌⌐┘å╪»╪¢ dedupe ╪»╪▒ `attachUploadedImages`╪¢ WebP ╪│╪▒█î╪╣ΓÇî╪¬╪▒ █▒█░█▓█┤px/effort2). ┘ä█î╪│╪¬ ┌⌐╪º┘ä╪º/┌⌐╪º╪¬╪º┘ä┘ê┌»/╪¿╪º╪▓╪º╪▒█î╪º╪¿/B2B ╪º╪▓ ╪¿█î╪┤╪¬╪▒█î┘å ┘é█î┘à╪¬ ╪¿┘ç ┌⌐┘à╪¬╪▒█î┘å. SW `v101`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/routes/products.js`, `server/routes/b2b.js`, `server/public/sw.js`
- **Deploy:** Γ£à `85dad85` / SW `erp-taranom-v101` ΓÇö git reset + SFTP + pm2 ┬╖ health 200
- **█î╪º╪»╪»╪º╪┤╪¬:** ┘╛╪│ ╪º╪▓ deploy █î┌⌐ΓÇî╪¿╪º╪▒ hard refresh.

### 2026-07-25 ΓÇö ╪▒┘ü╪╣ ┘ê╪▒┘ê╪» ┌⌐╪º╪▒╪¿╪▒╪º┘å (╪▒█î╪│╪¬ ╪▒┘à╪▓ ┘à╪▒┌⌐╪▓█î + ╪│╪«╪¬ΓÇî┌»█î╪▒█î ╪│█î╪º╪│╪¬ ╪▒┘à╪▓)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `545156e`
- **╪«┘ä╪º╪╡┘ç:** ╪¿╪╣╪» ╪º╪▓ go-live ╪▒┘à╪▓┘ç╪º█î ╪░╪«█î╪▒┘çΓÇî╪┤╪»┘ç ╪¿╪º ╪ó┘å┌å┘ç ┌⌐╪º╪▒╪¿╪▒╪º┘å ╪º┘à╪¬╪¡╪º┘å ┘à█îΓÇî┌⌐╪▒╪»┘å╪» ╪¼┘ê╪▒ ┘å╪¿┘ê╪» (adminΓëáadmin123╪¢ aref/sharafi ╪¿╪╣╪» ╪º╪▓ wipe ╪╣┘ê╪╢ ╪┤╪»┘ç ╪¿┘ê╪»┘å╪»). ╪▒┘à╪▓ ┘à┘ê┘é╪¬ ┘ç┘à┘ç┘ö ┌⌐╪º╪▒╪¿╪▒╪º┘å ┘ü╪╣╪º┘ä ╪▒┘ê█î ╪º█î╪▒╪º┘å ╪▒█î╪│╪¬ ┘ê ┘ä╪º┌»█î┘å HTTP 200 ╪¬╪ú█î█î╪» ╪┤╪». ┌⌐╪»: ┘å╪▒┘à╪º┘äΓÇî╪│╪º╪▓█î ╪º╪▒┘é╪º┘à ┘ü╪º╪▒╪│█î ╪»╪▒ username╪î validatePassword ┘ç┘å┌»╪º┘à ╪│╪º╪«╪¬/┘ê█î╪▒╪º█î╪┤ ┌⌐╪º╪▒╪¿╪▒╪î ╪«╪╖╪º█î ┘ê╪º╪╢╪¡ΓÇî╪¬╪▒ ╪»╪▒ ╪¿╪º╪▓┘å╪┤╪º┘å█î ╪▒┘à╪▓ UI╪î SW `v100`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/routes/auth.js`, `server/routes/admin.js`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** Γ£à `545156e` / SW `erp-taranom-v100` ΓÇö SFTP + pm2 restart + login HTTP 200
- **█î╪º╪»╪»╪º╪┤╪¬:** ┘ê╪▒┘ê╪» ┘à┘ê┘é╪¬: ┘ç┘à┘ç ┌⌐╪º╪▒╪¿╪▒╪º┘å ┘ü╪╣╪º┘ä ╪¿╪º ╪▒┘à╪▓ ┘à┘ê┘é╪¬╪¢ ╪»╪▒ ╪º┘ê┘ä█î┘å ┘ê╪▒┘ê╪» ┘ê╪¿ ╪¿╪º█î╪» ╪╣┘ê╪╢ ╪┤┘ê╪». ┘à┘ê╪¿╪º█î┘ä ╪¬╪º sync/pair ┘ç╪┤ ╪¼╪»█î╪» ╪▒╪º ┘å╪»╪º╪▒╪». ╪»┘ê ┌⌐╪º╪▒╪¿╪▒ portal ╪¿╪º username ┘à┘ê╪¿╪º█î┘ä ╪º╪▓ ╪¿┌⌐╪º┘╛ ╪»╪▒ DB ┘ü╪╣┘ä█î ┘å█î╪│╪¬┘å╪».

### 2026-07-23 ΓÇö ┘╛╪º┌⌐ΓÇî╪│╪º╪▓█î go-live + ╪¿╪º╪▓┌å█î┘å█î ┌⌐╪»█î┘å┌» ┘╛╪º█î┘ç + cascade ╪¬┘ü╪╡█î┘ä█î
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `8bb774a`
- **╪«┘ä╪º╪╡┘ç:** wipe ┌⌐╪º┘à┘ä ╪»╪º╪»┘ç┘ö ┌⌐╪│╪¿ΓÇî┘ê┌⌐╪º╪▒ + `chart_of_accounts`╪¢ `rebuildBaseCoa` (~█╖█╢ ╪¡╪│╪º╪¿ ┌⌐┘å╪¬╪▒┘ä)╪¢ `releaseTafsili` ┘ç┘å┌»╪º┘à ╪¡╪░┘ü ╪┤╪«╪╡/┌⌐╪º┘ä╪º/╪¿╪º┘å┌⌐/╪╡┘å╪»┘ê┘é/╪╖╪▒┘üΓÇî╪¡╪│╪º╪¿╪¢ ┘ü┘ä┌» ╪¼┘ä┘ê┌»█î╪▒█î ╪º╪▓ seed ╪º┘å╪¿╪º╪▒/┌»╪▒┘ê┘ç ┌⌐╪º┘ä╪º╪¢ ╪¿█î┘ä╪» ╪»╪│┌⌐╪¬╪º┘╛ 2.0.7 ┘ê ╪º┘å╪»╪▒┘ê█î╪» 2.0.29 ╪¿╪▒╪º█î ╪»╪º┘å┘ä┘ê╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/coa-map.js`, `server/scripts/go-live-clean.js`, `server/routes/products|persons|banks|cash-boxes.js`, `server/lib/parties-sync.js`, `scripts/_wipe-iran-golive.py`, `desktop/package.json`, `android/app/build.gradle`
- **Deploy:** Γ£à `8bb774a` / SW `v99` ┬╖ wipe ╪º█î╪▒╪º┘å `crm.db.pre-golive-2026-07-23T15-56-12ΓÇªbak` ┬╖ COA=82 ┬╖ customers/products/invoices=0 ┬╖ users=5 ┬╖ exe SHA256 `206B419FΓÇª` ┬╖ APK SHA256 `91C0403EΓÇª`
- **█î╪º╪»╪»╪º╪┤╪¬:** ┌⌐╪º╪▒╪¿╪▒╪º┘å ┘å┌»┘ç ╪»╪º╪┤╪¬┘ç ┘à█îΓÇî╪┤┘ê┘å╪»╪¢ ╪»╪│╪¬┌»╪º┘çΓÇî┘ç╪º█î ╪ó┘ü┘ä╪º█î┘å ┘╛╪│ ╪º╪▓ wipe ┘å█î╪º╪▓ ╪¿┘ç pair/sync ┘à╪¼╪»╪» ╪»╪º╪▒┘å╪». ╪»╪º┘å┘ä┘ê╪»: `/releases/ERP-Taranom-Setup-2.0.7.exe` ┘ê `/releases/crm-taranom.apk`.

### 2026-07-23 ΓÇö ╪¡╪░┘ü ┌»╪▒┘ê┘çΓÇî┘ç╪º█î ┌⌐╪º┘ä╪º█î ┘╛█î╪┤ΓÇî┘ü╪▒╪╢ (╪»█î┌»╪▒ ╪¿╪º╪▓ ┘å┘à█îΓÇî┌»╪▒╪»┘å╪»)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `e84dcc6`
- **╪«┘ä╪º╪╡┘ç:** ╪╣┘ä╪¬ ╪¿╪º╪▓┌»╪┤╪¬ ┌»╪▒┘ê┘çΓÇî┘ç╪º ┘╛╪│ ╪º╪▓ ╪¡╪░┘ü: `seedStandardSubgroups` ╪»╪▒ ┘ç╪▒ boot ╪¿╪º `INSERT OR IGNORE` ┘ä█î╪│╪¬ ┘à╪¡┌⌐ (┘╛╪º╪▒┌å┘ç╪î ╪«╪▒╪¼ ┌⌐╪º╪▒╪î ΓÇª) ╪▒╪º ╪»┘ê╪¿╪º╪▒┘ç ┘à█îΓÇî┌⌐╪º╪┤╪¬. seed ┌»╪▒┘ê┘çΓÇî┌⌐╪º┘ä╪º ╪¡╪░┘ü ╪┤╪»╪¢ ┘╛╪º┌⌐ΓÇî╪│╪º╪▓█î █î┌⌐ΓÇî╪¿╪º╪▒┘ç┘ö ╪▒╪»█î┘üΓÇî┘ç╪º█î `┌»╪▒┘ê┘ç ╪º╪│╪¬╪º┘å╪»╪º╪▒╪»` ╪¿╪»┘ê┘å ┌⌐╪º┘ä╪º╪¢ ╪▒┘ê█î DELETE ┘ê╪º╪¿╪│╪¬┌»█î `user_catalog_categories` ┘ê ┘ü┘ä┌» `product_categories_user_cleared`╪¢ ┘ä█î╪│╪¬ ACL/┘ü╪▒┘à ┘ç┘à┌å┘å╪º┘å ╪▓┘å╪»┘ç ╪º╪▓ API.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/currency.js`, `server/routes/product-categories.js`, `server/db.js`, `server/public/index.html`, `sw.js`, `manifest.json`
- **Deploy:** Γ£à `e84dcc6` / SW `erp-taranom-v98` ΓÇö SFTP (GitHub ╪▒┘ê█î VPS resolve ┘å╪┤╪») ┬╖ health 200 ┬╖ ╪▒┘ê█î ╪º█î╪▒╪º┘å `purged 14 auto-seeded product categories`
- **█î╪º╪»╪»╪º╪┤╪¬:** ┌»╪▒┘ê┘çΓÇî┘ç╪º█î█î ┌⌐┘ç ╪¿┘ç ┌⌐╪º┘ä╪º ┘ê╪╡┘äΓÇî╪º┘å╪» ╪╣┘à╪»╪º┘ï ┘å┌»┘ç ╪»╪º╪┤╪¬┘ç ┘à█îΓÇî╪┤┘ê┘å╪»╪¢ ┘╛╪│ ╪º╪▓ deploy █î┌⌐ΓÇî╪¿╪º╪▒ hard refresh.

### 2026-07-23 ΓÇö ╪º┘å╪»╪▒┘ê█î╪» 2.0.28 ╪¿╪▒╪º█î ╪»╪º┘å┘ä┘ê╪» ╪▒┘ê█î ╪│╪▒┘ê╪▒
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `c01c80a`
- **╪«┘ä╪º╪╡┘ç:** ╪¿█î┘ä╪» APK `2.0.28` / versionCode `30` ╪¿╪º UI ┘à┘ê╪¿╪º█î┘ä ┘à█î┘å█î┘à╪º┘ä╪¢ `manifest.json` ┘ä█î┘å┌⌐ ╪»╪º┘å┘ä┘ê╪» `server`╪¢ ╪ó┘╛┘ä┘ê╪» ╪▒┘ê█î ╪º█î╪▒╪º┘å `/releases/crm-taranom.apk` (~█╢█╢.█╡MB). API app-update ╪¿╪▒╪º█î `2.0.27` ΓåÆ `downloadable:true`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `android/app/build.gradle`, `android/.../main.js`, `server/public/releases/manifest.json`, `server/public/index.html`, `scripts/test-android-apk.ps1`
- **Deploy:** Γ£à APK ╪▒┘ê█î ╪º█î╪▒╪º┘å ┬╖ SHA256 `0900FDD5ΓÇª` ┬╖ health 200
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪¿╪»┘ê┘å keystore release ΓåÆ ╪º┘à╪╢╪º█î debug╪¢ ╪º┌»╪▒ ┘å╪╡╪¿ ┘é╪¿┘ä█î ╪¿╪º ╪º┘à╪╢╪º█î ╪»█î┌»╪▒ ╪¿╪º╪┤╪» █î┌⌐ΓÇî╪¿╪º╪▒ uninstall ┘ä╪º╪▓┘à ╪º╪│╪¬. ┘ä█î┘å┌⌐ ╪╣┘à┘ê┘à█î: `https://erp.poshaktaranom.com/releases/crm-taranom.apk`

### 2026-07-23 ΓÇö ┘à┘ê╪¿╪º█î┘ä ┘à█î┘å█î┘à╪º┘ä (╪»╪º╪┤╪¿┘ê╪▒╪» + ┘ü█î┘ä╪»┘ç╪º)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `f7181fb` (+ `bebd01d` changelog)
- **╪«┘ä╪º╪╡┘ç:** ╪¿╪º╪▓╪╖╪▒╪º╪¡█î ┘å╪│╪«┘ç ┘à┘ê╪¿╪º█î┘ä ╪¿┘ç ╪│╪¿┌⌐ ┘à█î┘å█î┘à╪º┘ä ╪¬┌⌐ΓÇî╪│╪¬┘ê┘å┘ç: KPI ╪¿┘çΓÇî╪╡┘ê╪▒╪¬ ┘ä█î╪│╪¬ ╪╣┘à┘ê╪»█î ╪¿╪»┘ê┘å ╪¿╪▒╪┤ ┘à╪¬┘å╪î ╪¼╪»╪º┘ê┘ä ╪»╪º╪┤╪¿┘ê╪▒╪» ╪¿┘ç ┌⌐╪º╪▒╪¬ (`m-stack`)╪î ╪¬╪º┘╛ΓÇî╪¿╪º╪▒ ╪«┘ä┘ê╪¬╪î ╪¿╪¼ ┘ç┘à┌»╪º┘à ┌⌐┘ê╪¬╪º┘ç╪î ┘ü█î┘ä╪¬╪▒ ╪¬┘à╪º┘àΓÇî╪╣╪▒╪╢╪î ┘ü╪▒┘àΓÇî┘ç╪º ╪¿╪º ┘ç╪»┘ü ┘ä┘à╪│█î █┤█┤px ┘ê ┘ü┘ê┘å╪¬ █▒█╢px╪¢ ╪▒╪º┘ç┘å┘à╪º█î ╪»╪º╪«┘ä ╪¿╪▒┘å╪º┘à┘ç ╪¿┘çΓÇî╪▒┘ê╪▓ ╪┤╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/public/sw.js`, `server/public/releases/manifest.json`
- **Deploy:** Γ£à `f7181fb` / SW `erp-taranom-v97` ΓÇö SFTP (GitHub ╪▒┘ê█î VPS resolve ┘å╪┤╪»)
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪¿█î┘ä╪» APK/╪»╪│┌⌐╪¬╪º┘╛ ╪º┘å╪¼╪º┘à ┘å╪┤╪» (┘ü┘é╪╖ ┘ê╪¿). ╪▒┘ê█î ┌»┘ê╪┤█î █î┌⌐ΓÇî╪¿╪º╪▒ hard refresh / ┘╛╪º┌⌐ΓÇî╪│╪º╪▓█î SW.

### 2026-07-23 ΓÇö ╪º╪╣╪┤╪º╪▒ █│ ╪▒┘é┘à╪î ╪»╪│┌⌐╪¬╪º┘╛ ┘à╪▒╪¼╪╣ ┌⌐╪º┘à┘ä╪î ╪»╪│╪¬╪▒╪│█î ╪▓┘å╪»┘ç ┌»╪▒┘ê┘ç/╪º┘å╪¿╪º╪▒
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `68c870e`
- **╪«┘ä╪º╪╡┘ç:** `round3`/`fmtQty` ╪»╪▒ UI╪¢ `centralOnly` ╪¿╪▒╪º█î ╪»╪│┌⌐╪¬╪º┘╛ ╪¿╪º╪▓ ╪┤╪» (+ `centralOnlyStrict` ╪¿╪▒╪º█î ╪¿┌⌐╪º┘╛/API/B2B/2FA)╪¢ ┌»╪▒┘ê┘ç ┌⌐╪º┘ä╪º ┘ê ╪º┘å╪¿╪º╪▒ ╪»╪▒ ┘ü╪▒┘à ┌⌐╪º╪▒╪¿╪▒/┘ü╪º┌⌐╪¬┘ê╪▒ ╪º╪▓ API ╪▓┘å╪»┘ç╪¢ capture ┌⌐╪º╪▒╪¿╪▒╪º┘å/╪¬┘å╪╕█î┘à╪º╪¬ ╪¿╪▒╪º█î ╪│█î┘å┌⌐ ╪»╪│┌⌐╪¬╪º┘╛.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/middleware/auth.js`, `server/sync/capture.js`, `server/public/index.html`, `prod-ui.js`, `product-categories.js`, `admin.js`
- **Deploy:** Γ£à `68c870e` / SW `erp-taranom-v96` ΓÇö exe 2.0.6 ╪▒┘ê█î ╪º█î╪▒╪º┘å
- **█î╪º╪»╪»╪º╪┤╪¬:** SHA256 exe `32305EC1ΓÇª` ┬╖ APK ┘à╪¡┘ä█î 2.0.27

### 2026-07-23 ΓÇö ┘╛╪º┌⌐ΓÇî╪│╪º╪▓█î ┘ç┘à┘ç┘ö ╪º┘å╪¿╪º╪▒┘ç╪º + ╪ó┘╛╪»█î╪¬ ╪»╪│┌⌐╪¬╪º┘╛ 2.0.5 / ╪º┘å╪»╪▒┘ê█î╪» 2.0.26
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `6c6a34b`
- **╪«┘ä╪º╪╡┘ç:** █▒█╕ ╪º┘å╪¿╪º╪▒ ╪¬╪╣╪▒█î┘üΓÇî╪┤╪»┘ç ╪▒┘ê█î ╪º█î╪▒╪º┘å ╪¡╪░┘ü ╪┤╪»╪¢ ┘ü┘ä┌» `warehouses_user_cleared` ┘à╪º┘å╪╣ seed ┘à╪¼╪»╪» ┘╛█î╪┤ΓÇî┘ü╪▒╪╢ (db + production schema) ┘à█îΓÇî╪┤┘ê╪»╪¢ ╪¡╪░┘ü ╪ó╪«╪▒█î┘å ╪º┘å╪¿╪º╪▒ ╪º╪▓ UI ┘ç┘à ┘ç┘à╪º┘å ┘ü┘ä┌» ╪▒╪º ┘à█îΓÇî╪▓┘å╪». ╪¿█î┘ä╪» ╪»╪│┌⌐╪¬╪º┘╛ 2.0.5 ┘ê APK 2.0.26.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/db.js`, `server/lib/production/schema.js`, `server/routes/warehouses.js`, `server/public/index.html`, `sw.js`, `manifest.json`, `desktop/package.json`, `android/app/build.gradle`
- **Deploy:** Γ£à `6c6a34b` / SW `erp-taranom-v95` ΓÇö exe ╪▒┘ê█î ╪º█î╪▒╪º┘å ╪»╪▒ `/releases/`
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪¿┌⌐╪º┘╛ DB: `crm.db.pre-wh-purge-*.bak` ┬╖ ┘╛╪│ ╪º╪▓ restart ┘ç┘à┌å┘å╪º┘å `warehouses=0` ┬╖ exe SHA256 `213F1D84ΓÇª` ┬╖ APK ┘à╪¡┘ä█î SHA256 `CF79B1F7ΓÇª`

### 2026-07-23 ΓÇö ╪ó┘╛╪»█î╪¬ ╪»╪│┌⌐╪¬╪º┘╛ ┘ê█î┘å╪»┘ê╪▓ 2.0.4
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `8674502`
- **╪«┘ä╪º╪╡┘ç:** ╪¿█î┘ä╪» ┘å╪╡╪¿ΓÇî┌⌐┘å┘å╪»┘ç Windows 2.0.4 ╪¿╪º fallback ╪ó┘╛╪»█î╪¬ ╪¿╪»┘ê┘å feed ╪º┘ä┌⌐╪¬╪▒┘ê┘å + ╪ó╪«╪▒█î┘å ╪¿┌⌐ΓÇî╪º┘å╪»╪¢ `manifest.json` / `latest.yml`╪¢ exe ╪▒┘ê█î ╪│╪▒┘ê╪▒ ╪º█î╪▒╪º┘å ╪»╪▒ `/releases/`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `desktop/package.json`, `desktop/main.js`, `server/public/releases/manifest.json`, `latest.yml`
- **Deploy:** Γ£à `8674502` ΓÇö exe ╪▒┘ê█î ╪º█î╪▒╪º┘å ╪ó┘╛┘ä┘ê╪» ╪┤╪»
- **█î╪º╪»╪»╪º╪┤╪¬:** ┘à╪│█î╪▒ ┘à╪¡┘ä█î `desktop/dist/ERP-Taranom-Setup-2.0.4.exe` ┬╖ SHA256 `13A33F42FE229E797521AD255DA5E46D5E8B1299139F754109DE2BCB348000FE`

### 2026-07-23 ΓÇö ╪¬┌⌐┘à█î┘ä: ╪¬╪┤╪«█î╪╡ ╪ó┘╛╪»█î╪¬ ╪¿╪»┘ê┘å URL + purge ┘╛┘ê█î╪º + APK 2.0.25
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `7e8a54f`
- **╪«┘ä╪º╪╡┘ç:** ╪¿╪º┌» `update_available` ┘ê┘é╪¬█î URL ╪«╪º┘ä█î ╪¿┘ê╪» (╪º┘å╪»╪▒┘ê█î╪» local) ╪▒┘ü╪╣ ╪┤╪»╪¢ ╪º╪╣┘ä╪º┘å/┘å┘ê╪¬█î┘ü ┘ê╪º┘é╪╣╪º┘ï ╪¿╪▒╪º█î ┘å╪│╪«┘ç ╪¼╪»█î╪» ╪½╪¿╪¬ ┘à█îΓÇî╪┤┘ê╪»╪¢ ╪¡╪░┘ü ┌⌐╪º╪▒╪¿╪▒ ╪¿╪º ╪¼╪º╪▒┘ê█î ┘ç┘à┘ç┘ö ╪│╪¬┘ê┘åΓÇî┘ç╪º█î ╪º╪▒╪¼╪º╪╣╪¢ ╪»╪│┌⌐╪¬╪º┘╛ ╪¿╪»┘ê┘å feed ╪¿┘ç manifest ╪¿╪▒┘à█îΓÇî┌»╪▒╪»╪»╪¢ ╪¬╪│╪¬ΓÇî┘ç╪º█î `test-app-update` / `test-purge-user`╪¢ SW v94 / ┘ê╪¿ 2.1.3 / ╪º┘å╪»╪▒┘ê█î╪» 2.0.25.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/app-update.js`, `server/lib/purge-user.js`, `server/public/index.html`, `desktop/main.js`, `android/...`, `manifest.json`
- **Deploy:** Γ£à `7e8a54f` / SW `erp-taranom-v94`
- **█î╪º╪»╪»╪º╪┤╪¬:** APK ┘ü┘é╪╖ sideload ┘à╪¡┘ä█î╪¢ ╪»╪│┌⌐╪¬╪º┘╛ installer ╪¼╪»█î╪» ╪│╪º╪«╪¬┘ç ┘å╪┤╪» (█▓.█░.█│ + fallback ╪»╪▒ ╪│┘ê╪▒╪│ ╪¿╪▒╪º█î ╪¿█î┘ä╪» ╪¿╪╣╪»█î).

### 2026-07-23 ΓÇö ╪¡╪░┘ü ┌⌐╪º┘à┘ä ┌⌐╪º╪▒╪¿╪▒ + ╪ó┘╛╪»█î╪¬ ╪»╪▒ ╪¬┘å╪╕█î┘à╪º╪¬/╪º╪╣┘ä╪º┘åΓÇî┘ç╪º + ┘å┘ê╪¬█î┘ü ╪º┘å╪»╪▒┘ê█î╪»
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `022957d`
- **╪«┘ä╪º╪╡┘ç:** `DELETE /admin/users` ╪¡╪º┘ä╪º purge ┌⌐╪º┘à┘ä ╪º╪│╪¬╪¢ ┘╛┘å┘ä ╪¿┘çΓÇî╪▒┘ê╪▓╪▒╪│╪º┘å█î ╪»╪▒ ╪¬┘å╪╕█î┘à╪º╪¬ ╪¿╪▒╪º█î ┘ç┘à┘ç ┌⌐┘ä╪º█î┘å╪¬ΓÇî┘ç╪º╪¢ ╪º╪╣┘ä╪º┘å `app_update` ╪»╪▒ ╪▓┘å┌»┘ê┘ä┘ç╪¢ AndroidBridge ┘å┘ê╪¬█î┘ü█î┌⌐█î╪┤┘å ╪│█î╪│╪¬┘à█î╪¢ ┘é╪º┘å┘ê┘å ╪¿╪»┘ê┘å ╪¿█î┘ä╪» ┌⌐╪º┘à┘ä ┘╛┘ä╪¬┘ü╪▒┘à.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/purge-user.js`, `server/routes/admin.js`, `server/lib/notifications.js`, `server/public/index.html`, `android/.../MainActivity.java`, `.cursor/rules/no-full-platform-builds.mdc`
- **Deploy:** Γ£à `022957d` / SW `erp-taranom-v93`
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪»╪│┌⌐╪¬╪º┘╛ ╪¿█î┘ä╪» ┘å╪┤╪». APK ╪ó┘╛╪»█î╪¬ 2.0.24 ┘à╪¡┘ä█î sideload.

### 2026-07-23 ΓÇö UI: ╪»┌⌐┘à┘ç Γåæ ┘ê╪º┘ä╪»╪î ╪▒█î┘ä MDI ╪¿╪º╪▒█î┌⌐╪î ╪¡╪░┘ü ╪¿╪º╪▒┌»╪░╪º╪▒█î ┌⌐╪º╪░╪¿╪î ╪ó█î┌⌐┘ê┘å ┘à█î┘å█î┘à╪º┘ä
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `8719743`
- **╪«┘ä╪º╪╡┘ç:** ╪»┌⌐┘à┘ç ┘å╪º┘ê╪¿╪▒█î ┘à╪½┘ä Up ┘ê█î┘å╪»┘ê╪▓ (╪│╪╖╪¡ ┘ê╪º┘ä╪»╪î ┘å┘ç ╪¬╪º╪▒█î╪«┌å┘ç)╪¢ ┘å┘ê╪º╪▒ MDI ┘ç┘å┌»╪º┘à ╪¿╪º╪▓ ╪┤╪»┘å ~█┤█░px╪¢ ╪¡╪░┘ü ┬½╪»╪▒ ╪¡╪º┘ä ╪¿╪º╪▒┌»╪░╪º╪▒█î┬╗ ┌»█î╪▒┌⌐╪▒╪»┘ç ╪»╪▒ ┘╛┘å╪¼╪▒┘çΓÇî┘ç╪º█î MDI╪¢ ┌⌐┘ê┌å┌⌐ΓÇî┌⌐╪▒╪»┘å ╪ó█î┌⌐┘ê┘åΓÇî┘ç╪º█î ╪»╪▒╪┤╪¬╪¢ ┘ü█î┌⌐╪│ ┘╛╪º╪▒╪│ ╪▒╪º┘ç┘å┘à╪º█î MDI (┘ê╪▒┘ê╪» ╪«╪▒╪º╪¿)╪¢ desktop **2.0.3** / android **2.0.23** / SW **v92**.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/public/mdi.js`, `server/public/sw.js`, `desktop/package.json`, `android/app/build.gradle`, `server/public/releases/manifest.json`
- **Deploy:** Γ£à `8719743` / SW `erp-taranom-v92`
- **█î╪º╪»╪»╪º╪┤╪¬:** exe: `desktop/dist/ERP-Taranom-Setup-2.0.3.exe` ┬╖ APK: `server/public/releases/crm-taranom.apk` (sideload╪¢ ╪▒┘ê█î ╪│╪▒┘ê╪▒ ╪ó┘╛┘ä┘ê╪» ┘å┘à█îΓÇî╪┤┘ê╪»).

---

### 2026-07-23 ΓÇö [Cursor] ╪¿█î┘ä╪» ╪»╪│┌⌐╪¬╪º┘╛ 2.0.2 + ╪º┘å╪»╪▒┘ê█î╪» 2.0.22
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `540d2ab`
- **╪«┘ä╪º╪╡┘ç:** ╪¿█î┘ä╪» ┘å╪╡╪¿ΓÇî┌⌐┘å┘å╪»┘ç Windows 2.0.2 ┘ê APK 2.0.22 ╪¿╪º ╪ó╪«╪▒█î┘å ╪¿┌⌐ΓÇî╪º┘å╪» (MDI ┘ä╪¿┘ç ┌å┘╛/┘ç╪º┘ê╪▒╪î ╪º╪│┘å╪º╪» ╪º╪¬┘ê┘à╪º╪¬ ╪º┌⌐╪│┘ä/╪º┘ü╪¬╪¬╪º╪¡█î┘ç╪î ╪¡╪░┘ü ┘à┘å╪╖┘é┘ç ╪«╪╖╪▒╪î SW v89). ┘à╪¬╪º╪»█î╪¬╪º `manifest.json` + `latest.yml` ╪¿┘çΓÇî╪▒┘ê╪▓ ╪┤╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `desktop/package.json`, `android/app/build.gradle`, `android/.../main.js`, `server/public/releases/{manifest.json,latest.yml}`, `scripts/test-android-apk.ps1`
- **Deploy:** Γ£à ┘à╪¬╪º╪»█î╪¬╪º ╪▒┘ê█î ╪º█î╪▒╪º┘å `540d2ab` ΓÇö exe ╪▒╪º ┌⌐╪º╪▒╪¿╪▒ ╪¿╪º SCP ╪ó┘╛┘ä┘ê╪» ┌⌐┘å╪»╪¢ APK ┘ü┘é╪╖ sideload ┘à╪¡┘ä█î
- **█î╪º╪»╪»╪º╪┤╪¬:** ┘à╪│█î╪▒ ╪»╪│┌⌐╪¬╪º┘╛: `desktop/dist/ERP-Taranom-Setup-2.0.2.exe` ΓÇö SHA256 `B974DEF2620076CD12A8324D6CD4D24E6ACCEE7BD6EB4E9099E710BD096C0378` ┬╖ APK: `server/public/releases/crm-taranom.apk` (~█╢█╢.█╡MB)

### 2026-07-23 ΓÇö [Cursor] ┘å┘ê╪º╪▒ MDI ╪¿┘ç ┘ä╪¿┘ç ┌å┘╛ + ┘ç╪º┘ê╪▒ ΓÇö SW v89
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `d4bde7d`
- **╪«┘ä╪º╪╡┘ç:** ┘å┘ê╪º╪▒ ┘ê╪╕█î┘ü┘ç┘ö ┘╛┘å╪¼╪▒┘çΓÇî┘ç╪º█î ┌å┘å╪»┌»╪º┘å┘ç ╪º╪▓ ┘╛╪º█î█î┘å ╪╡┘ü╪¡┘ç ╪¿┘ç ┘ä╪¿┘ç ┌å┘╛ ┘à┘å╪¬┘é┘ä ╪┤╪»╪¢ ┘╛█î╪┤ΓÇî┘ü╪▒╪╢ ┘ü┘é╪╖ █î┌⌐ ┘å┘ê╪º╪▒ ╪¿╪º╪▒█î┌⌐ ╪│╪¿╪▓ ╪»█î╪»┘ç ┘à█îΓÇî╪┤┘ê╪» ┘ê ╪¿╪º ┘ç╪º┘ê╪▒ ┘à┘ê╪│ ┘ü┘ç╪▒╪│╪¬ ┘╛┘å╪¼╪▒┘çΓÇî┘ç╪º ╪¿╪º╪▓ ┘à█îΓÇî╪┤┘ê╪». ┘ü╪╢╪º█î ╪▒╪▓╪▒┘ê ┘╛╪º█î█î┘å ╪¡╪░┘ü ╪┤╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/mdi.js`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `d4bde7d` ΓÇö SW `erp-taranom-v89`

### 2026-07-23 ΓÇö [Cursor] ╪¡╪░┘ü ┘à┘å╪╖┘é┘ç ╪«╪╖╪▒ + ╪º╪│┘å╪º╪» ╪º╪¬┘ê┘à╪º╪¬ ╪º┌⌐╪│┘ä/╪º┘ü╪¬╪¬╪º╪¡█î┘ç ΓÇö SW v88
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `e5d945b`
- **╪«┘ä╪º╪╡┘ç:**
  1. ╪¬╪¿ ┬½┘à┘å╪╖┘é┘ç ╪«╪╖╪▒ / ╪¡╪░┘ü ╪»█î╪¬╪º█î ╪¬╪│╪¬┬╗ ╪º╪▓ ╪¬┘å╪╕█î┘à╪º╪¬ ┘ê API `/admin/data-wipe` ╪¡╪░┘ü ╪┤╪».
  2. ╪º╪│┌⌐╪▒█î┘╛╪¬ `go-live-clean.js` ╪¿╪▒╪º█î ┘╛╪º┌⌐ΓÇî╪│╪º╪▓█î ┌⌐╪º┘à┘ä ╪»█î╪¬╪º█î ┌⌐╪│╪¿ΓÇî┘ê┌⌐╪º╪▒ (┘å┌»┘ç ╪»╪º╪┤╪¬┘å ┌⌐╪º╪▒╪¿╪▒╪º┘å/┌⌐╪»█î┘å┌») ┘é╪¿┘ä ╪º╪▓ ┘ê╪▒┘ê╪» ╪»╪º╪»┘ç ┘ê╪º┘é╪╣█î.
  3. ┘ê╪▒┘ê╪» ╪º┌⌐╪│┘ä ┘ê ┘à╪º┘å╪»┘ç/┘à┘ê╪¼┘ê╪»█î ╪º┘ê┘ä ╪»┘ê╪▒┘ç: ╪│┘å╪» ╪¡╪│╪º╪¿╪»╪º╪▒█î ╪º╪¬┘ê┘à╪º╪¬ ╪¿╪º `voucher_type=opening|auto|manual`╪¢ ┘à╪¿╪»╪ú ╪º┌⌐╪│┘ä ╪»╪▒ `src_system=excel`╪¢ ╪¿╪▒┌å╪│╪¿ΓÇî┘ç╪º█î **╪º╪¬┘ê┘à╪º╪¬ / ╪»╪│╪¬█î / ╪º┘ü╪¬╪¬╪º╪¡█î┘ç** (+ ┬½╪º┌⌐╪│┘ä┬╗) ╪»╪▒ ┘ü┘ç╪▒╪│╪¬ ╪º╪│┘å╪º╪».
  4. ╪º╪┤╪«╪º╪╡ ╪¿╪º ┘à╪º┘å╪»┘ç ╪º┘ê┘ä ╪»┘ê╪▒┘ç╪î ┌⌐╪º┘ä╪º ╪¿╪º ┘à┘ê╪¼┘ê╪»█î+╪¿┘ç╪º█î ╪¬┘à╪º┘àΓÇî╪┤╪»┘ç╪î ┌å┌⌐ ╪º┘ê┘ä ╪»┘ê╪▒┘ç╪î ╪▒╪│█î╪» ╪º┘å╪¿╪º╪▒ ╪¿╪º ╪┤╪▒╪¡ ╪º┘ê┘ä ╪»┘ê╪▒┘ç╪î ┘ê ╪º╪│┘å╪º╪» ╪º┌⌐╪│┘ä ╪¿╪º ┘å┘ê╪╣ opening ┘ç┘à┌»█î ╪│┘å╪» ╪º┘ü╪¬╪¬╪º╪¡█î┘ç ┘à█îΓÇî╪│╪º╪▓┘å╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/opening-post.js`, `server/lib/excel-origin.js`, `server/lib/ledger.js`, `server/routes/{parties,products,excel,accounting,warehouses,cheque-records}.js`, `server/public/{index.html,sw.js,i18n.js}`, `server/scripts/go-live-clean.js`, `server/scripts/test-opening-excel.js`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `e5d945b` ΓÇö `git pull` + `pm2 restart` + health 200 + SW `erp-taranom-v88` + wipe `crm.db` (╪¿┌⌐╪º┘╛ `crm.db.pre-golive-*.bak`)
- **█î╪º╪»╪»╪º╪┤╪¬:** ┘╛╪│ ╪º╪▓ wipe: customers/products/invoices/journal=0╪¢ users/COA/warehouses ╪¡┘ü╪╕ ╪┤╪». ╪ó┘à╪º╪»┘ç┘ö ┘ê╪▒┘ê╪» ╪º┌⌐╪│┘ä ┘ê╪º┘é╪╣█î.
### 2026-07-23 ΓÇö [Cursor] ╪¿█î┘ä╪» ╪»╪│┌⌐╪¬╪º┘╛ Windows 2.0.1
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `bea650a`
- **╪«┘ä╪º╪╡┘ç:** ╪¿╪▒╪▒╪│█î ┌⌐╪º┘à┘ä ┘╛┘ê╪│╪¬┘ç┘ö Electron (`main.js`/`preload.js`/`prepare-server`)╪¢ bump ┘å╪│╪«┘ç ╪¿┘ç `2.0.1`╪¢ ╪│╪º╪«╪¬ ┘å╪╡╪¿ΓÇî┌⌐┘å┘å╪»┘ç NSIS (~█╣█┤MB) ╪¿╪º ╪ó╪«╪▒█î┘å ╪¿┌⌐ΓÇî╪º┘å╪» (pairing ╪║█î╪▒┘à╪│╪»┘ê╪»╪î rollback╪î i18n╪î ΓÇª). ┘à╪¬╪º╪»█î╪¬╪º `manifest.json` + `latest.yml` ╪¿┘çΓÇî╪▒┘ê╪▓ ╪┤╪». `generate-release.js` ┘å╪º┘à ERP ┘ê ╪¡┘ü╪╕ ┘ü█î┘ä╪» android ╪▒╪º ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘à█îΓÇî┌⌐┘å╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `desktop/package.json`, `desktop/dist/ERP-Taranom-Setup-2.0.1.exe` (┘à╪¡┘ä█î╪î gitignore), `server/public/releases/{manifest.json,latest.yml}`, `scripts/generate-release.js`, `desktop/BUILD-WINDOWS.md`
- **Deploy:** ΓÅ│ ΓÇö ┌⌐╪º╪▒╪¿╪▒ exe ╪▒╪º ╪¿╪º SCP ╪▒┘ê█î ╪│╪▒┘ê╪▒ ╪º█î╪▒╪º┘å ╪ó┘╛┘ä┘ê╪» ┘à█îΓÇî┌⌐┘å╪»╪¢ ╪│┘╛╪│ `git pull` + `pm2 restart`
- **█î╪º╪»╪»╪º╪┤╪¬:** ┘à╪│█î╪▒ ┘à╪¡┘ä█î: `desktop/dist/ERP-Taranom-Setup-2.0.1.exe` ΓÇö SHA256 `9C29A827FC6DDC132CAD3930B29155F8964414F3091C78EC357AF555DE34F6F7`

### 2026-07-23 ΓÇö [Cursor] ╪▒┘ü╪╣ ┌⌐╪º┘à┘ä ╪╡┘ü╪¡┘ç ╪º╪¬╪╡╪º┘ä ╪¿┘ç ╪│╪▒┘ê╪▒ ┘à╪▒┌⌐╪▓█î (┘à┘ê╪¿╪º█î┘ä) ΓÇö SW v87 / Android 2.0.21
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `668397d`
- **╪«┘ä╪º╪╡┘ç:** pairing ╪»█î┌»╪▒ ╪¬╪º ┘╛╪º█î╪º┘å pull ┌⌐┘ä ╪»█î╪¬╪º╪¿█î╪│ ╪¿┘ä┘ê┌⌐┘ç ┘å┘à█îΓÇî╪┤┘ê╪» (╪½╪¿╪¬ ╪│╪▒█î╪╣ + ╪»╪▒█î╪º┘ü╪¬ ┘╛╪│ΓÇî╪▓┘à█î┘å┘ç ╪¿╪º ╪╡┘ü╪¡┘ç ┘╛█î╪┤╪▒┘ü╪¬). ╪º┌»╪▒ ╪»╪▒█î╪º┘ü╪¬ ╪º┘ê┘ä█î┘ç ╪┤┌⌐╪│╪¬ ╪¿╪«┘ê╪▒╪» ╪º╪¬╪╡╪º┘ä ┘å╪º┘é╪╡ rollback ┘à█îΓÇî╪┤┘ê╪» ╪¬╪º ╪¿┘åΓÇî╪¿╪│╪¬ ┬½┘é╪¿┘ä╪º┘ï ┘à╪¬╪╡┘ä┬╗ ┘å┘à╪º┘å╪». probe ╪¿╪º fallback `http://erp.poshaktaranom.com`╪î ╪¬╪┤╪«█î╪╡ `pairing_broken`╪î ╪▒╪º┘ç┘å┘à╪º█î ┘ê╪º╪╢╪¡ ┘ü█î┘ä╪»┘ç╪º (┘à╪»█î╪▒ ┘ê╪¿ Γëá admin123 ┘à╪¡┘ä█î)╪î ┘ê ┘╛█î╪º┘à ╪«╪╖╪º█î ┘ê╪▒┘ê╪» ╪¿┘ç╪¬╪▒ ╪▒┘ê█î ╪»╪│╪¬┌»╪º┘ç.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/sync/client.js`, `server/public/index.html`, `server/public/sw.js`, `server/scripts/test-sync-repair.js`, `android/app/build.gradle`, `android/.../main.js`, `server/public/releases/manifest.json`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `ffd50b4` ΓÇö `git pull` + `pm2 restart` + health 200 + SW `erp-taranom-v87`
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪¿╪▒╪º█î ┌»┘ê╪┤█î ╪¿╪º█î╪» APK **█▓.█░.█▓█▒** ┘å╪╡╪¿ ╪┤┘ê╪». ╪º┌»╪▒ ╪º╪¬╪╡╪º┘ä ┘é╪¿┘ä█î ╪«╪▒╪º╪¿ ╪º╪│╪¬: ┘ä█î┘å┌⌐ ┬½┘é╪╖╪╣ ╪º╪¬╪╡╪º┘ä ┘ê ╪º╪¬╪╡╪º┘ä ┘à╪¼╪»╪»┬╗ ╪▒┘ê█î ╪╡┘ü╪¡┘ç ┘ê╪▒┘ê╪» ΓåÆ `admin/admin123` ΓåÆ ╪º╪¬╪╡╪º┘ä ╪¬╪º╪▓┘ç ╪¿╪º ┘à╪»█î╪▒ ┘ê╪¿.

### 2026-07-23 ΓÇö [Cursor] ╪¿╪º╪▓█î╪º╪¿█î ╪º╪¬╪╡╪º┘ä ╪»╪│╪¬┌»╪º┘ç ╪ó┘ü┘ä╪º█î┘å (pairing ╪«╪▒╪º╪¿) ΓÇö SW v86 / Android 2.0.20
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `22f55d0` (+ `6a7fed6` changelog)
- **╪«┘ä╪º╪╡┘ç:** ╪»╪│╪¬┌»╪º┘çΓÇî┘ç╪º█î█î ┌⌐┘ç ┘é╪¿┘ä╪º┘ï paired ╪┤╪»┘çΓÇî╪º┘å╪» ┘ê┘ä█î ╪│█î┘å┌⌐/┘ê╪▒┘ê╪» ╪«╪▒╪º╪¿ ╪º╪│╪¬ ╪»█î┌»╪▒ ╪¿┘åΓÇî╪¿╪│╪¬ ┘å█î╪│╪¬┘å╪»: ┘à┘ç╪º╪¼╪▒╪¬ ╪«┘ê╪»┌⌐╪º╪▒ URL ╪ó┘ä┘à╪º┘å (`45.90.98.99`) ΓåÆ `https://erp.poshaktaranom.com`╪¢ ┘╛┘å┘ä ┘ç┘à┌»╪º┘àΓÇî╪│╪º╪▓█î ╪ó╪»╪▒╪│/╪┤┘å╪º╪│┘ç ╪»╪│╪¬┌»╪º┘ç + ┬½╪¬╪║█î█î╪▒ ╪ó╪»╪▒╪│┬╗ + ┬½┘é╪╖╪╣ ╪º╪¬╪╡╪º┘ä ┘ê ╪º╪¬╪╡╪º┘ä ┘à╪¼╪»╪»┬╗╪¢ ┘ä█î┘å┌⌐ ╪¿╪º╪▓█î╪º╪¿█î ╪▒┘ê█î ╪╡┘ü╪¡┘ç ┘ê╪▒┘ê╪» (╪¿╪»┘ê┘å ┘ä╪º┌»█î┘å)╪¢ ┘╛╪│ ╪º╪▓ reset ╪»┘ê╪¿╪º╪▒┘ç `admin/admin123` ┘ê pairing ╪¬╪º╪▓┘ç.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/sync/client.js`, `server/routes/sync.js`, `server/public/index.html`, `server/public/sw.js`, `server/scripts/test-sync-repair.js`, `android/app/build.gradle`, `android/.../main.js`, `server/public/releases/manifest.json`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `6a7fed6` ΓÇö `git pull` + `pm2 restart` + health 200 + SW `erp-taranom-v86`
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪¿╪▒╪º█î ┌»┘ê╪┤█î╪î APK **█▓.█░.█▓█░** ╪»┌⌐┘à┘ç┘ö ╪¿╪º╪▓█î╪º╪¿█î ╪»╪º╪«┘ä ╪º┘╛ ╪▒╪º ┘à█îΓÇî╪ó┘ê╪▒╪» (╪¿█î┘ä╪» ┘à╪¡┘ä█î ╪¿┘çΓÇî╪«╪º╪╖╪▒ timeout ╪ó█î┘å┘ç┘ö Maven ┘ü╪╣┘ä╪º┘ï ┌⌐╪º┘à┘ä ┘å╪┤╪»). **╪º┘ä╪º┘å ╪¿╪»┘ê┘å APK ╪¼╪»█î╪»:** ╪¬┘å╪╕█î┘à╪º╪¬ ┌»┘ê╪┤█î ΓåÆ ERP ╪¬╪▒┘å┘à ΓåÆ ┘╛╪º┌⌐ ┌⌐╪▒╪»┘å ╪»╪º╪»┘ç ΓåÆ ┘ê╪▒┘ê╪» `admin/admin123` ΓåÆ ╪º╪¬╪╡╪º┘ä ╪¿┘ç `https://erp.poshaktaranom.com` ╪¿╪º ╪▒┘à╪▓ ┘à╪»█î╪▒ ┘à╪▒┌⌐╪▓█î ΓåÆ ┘ê╪▒┘ê╪» ╪¿╪º ┌⌐╪º╪▒╪¿╪▒ ╪º╪╡┘ä█î.

### 2026-07-23 ΓÇö [Cursor] ╪▓╪¿╪º┘å ╪¿╪▒┘å╪º┘à┘ç (┘ü╪º/╪º┘å) + ┘ü╪º╪▒╪│█îΓÇî╪│╪º╪▓█î ╪¿╪▒┌å╪│╪¿ΓÇî┘ç╪º█î ╪º┘å┌»┘ä█î╪│█î ΓÇö SW v85
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `ddf1a57`
- **╪«┘ä╪º╪╡┘ç:** ╪¿╪▒┌å╪│╪¿ΓÇî┘ç╪º█î ╪º┘å┌»┘ä█î╪│█î UI (╪¿┘çΓÇî╪¼╪▓ ╪¬╪¿ API ╪¬┘å╪╕█î┘à╪º╪¬) ┘ü╪º╪▒╪│█î ╪┤╪»╪¢ ╪│█î╪│╪¬┘à `i18n.js` ╪¿╪º ╪│┘ê╪ª█î┌å ┬½╪▓╪¿╪º┘å ╪¿╪▒┘å╪º┘à┘ç┬╗ ╪»╪▒ ╪¬┘å╪╕█î┘à╪º╪¬ ΓåÆ ╪╣┘à┘ê┘à█î ╪º╪╢╪º┘ü┘ç ╪┤╪» ╪¬╪º ┌⌐┘ä ┘╛┘ê╪│╪¬┘ç ╪¿┘ç ╪º┘å┌»┘ä█î╪│█î ╪¿╪▒┘ê╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/i18n.js`, `server/public/index.html`, `server/public/acc-nav.js`, `server/public/sw.js`
- **Deploy:** Γ£à Iran HTTP `/` 200, SW `erp-taranom-v85`

### 2026-07-23 ΓÇö [Cursor] ┘à┘å┘ê█î ╪¡╪│╪º╪¿ (╪ó█î┌⌐┘ê┘å power) + ╪º╪╡┘ä╪º╪¡ ╪│╪▒╪▒█î╪▓ ╪ó╪»╪▒╪│ ╪¼╪»┘ê┘ä ΓÇö SW v84
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `0fea8f1`
- **╪«┘ä╪º╪╡┘ç:** ╪¿┘ä┘ê┌⌐ ┘╛╪º█î█î┘å ╪│╪º█î╪»╪¿╪º╪▒ (╪¬┘à/╪▒┘à╪▓/╪º┘à┘å█î╪¬/╪«╪▒┘ê╪¼) ╪¡╪░┘ü ┘ê ╪¿┘ç ┘à┘å┘ê█î ┌⌐╪┤┘ê█î█î ┌»┘ê╪┤┘ç ╪¿╪º ╪ó█î┌⌐┘ê┘å ╪«╪º┘à┘ê╪┤ ┘à┘å╪¬┘é┘ä ╪┤╪»╪¢ ╪│╪¬┘ê┘å ╪ó╪»╪▒╪│ ╪»╪▒ ╪¼╪»╪º┘ê┘ä ╪¿╪º clamp ╪»┘ê╪«╪╖█î ┘ê tooltip ╪¼┘ä┘ê█î ╪│╪▒╪▒█î╪▓ ╪¿┘ç ╪│╪¬┘ê┘å ╪¿╪╣╪»█î ┌»╪▒┘ü╪¬┘ç ╪┤╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/public/sw.js`, `docs/CHANGE-LOG.md`
- **Deploy:** Γ£à Iran HTTP `/` 200, SW `erp-taranom-v84`

### 2026-07-23 ΓÇö [Cursor] ╪º┘å╪¬┘é╪º┘ä ┌⌐╪º╪▒╪¿╪▒╪º┘å ┘ê API ╪¿┘ç ╪¬┘å╪╕█î┘à╪º╪¬ ΓÇö SW v83
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `858eeda`
- **╪«┘ä╪º╪╡┘ç:** ┬½┌⌐╪º╪▒╪¿╪▒╪º┘å┬╗ ┘ê ┬½API┬╗ ╪º╪▓ ┘à┘å┘ê█î ┌⌐┘å╪º╪▒█î ╪º╪╡┘ä█î ╪¡╪░┘ü ┘ê ┘ü┘é╪╖ ╪¿┘çΓÇî╪╡┘ê╪▒╪¬ ╪¬╪¿ ╪»╪º╪«┘ä ╪¬┘å╪╕█î┘à╪º╪¬ ╪»╪▒ ╪»╪│╪¬╪▒╪│ΓÇî╪º┘å╪» (┘ç┘àΓÇî╪│╪¿┌⌐ ┘╛█î╪º┘à┌⌐/┘╛╪┤╪¬█î╪¿╪º┘å). ╪▒╪º┘ç┘å┘à╪º ╪¿┘çΓÇî╪▒┘ê╪▓ ╪┤╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/public/sw.js`, `docs/CHANGE-LOG.md`
- **Deploy:** Γ£à Iran HTTP `/` 200, SW `erp-taranom-v83`

### 2026-07-23 ΓÇö [Cursor] ╪ó█î┌⌐┘ê┘å ┘à█î┘å█î┘à╪º┘ä ╪¬┘å╪╕█î┘à╪º╪¬/┌»╪▒┘ê┘çΓÇî┘ç╪º + ╪º┘å╪¬┘é╪º┘ä ┘╛█î╪º┘à┌⌐ ┘ê ┘╛╪┤╪¬█î╪¿╪º┘å ╪¿┘ç ╪¬┘å╪╕█î┘à╪º╪¬ ΓÇö SW v82
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `1473cdd`
- **╪«┘ä╪º╪╡┘ç:** ╪º┘å╪»╪º╪▓┘ç ╪ó█î┌⌐┘ê┘åΓÇî┘ç╪º█î ╪┤┘É┘ä ╪¬┘å╪╕█î┘à╪º╪¬ ┘ê ┌»╪▒┘ê┘çΓÇî┘ç╪º ┌⌐┘ê┌å┌⌐ ┘ê ┘à█î┘å█î┘à╪º┘ä ╪┤╪»╪¢ ┬½┘╛█î╪º┘à┌⌐┬╗ ┘ê ┬½┘╛╪┤╪¬█î╪¿╪º┘å┬╗ ╪º╪▓ ┘à┘å┘ê█î ┌⌐┘å╪º╪▒█î ╪º╪╡┘ä█î ╪¡╪░┘ü ┘ê ┘ü┘é╪╖ ╪¿┘çΓÇî╪╡┘ê╪▒╪¬ ╪¬╪¿ ╪»╪º╪«┘ä ╪¬┘å╪╕█î┘à╪º╪¬ ╪»╪▒ ╪»╪│╪¬╪▒╪│ΓÇî╪º┘å╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/public/sw.js`, `docs/CHANGE-LOG.md`
- **Deploy:** Γ£à Iran health 200, SW `erp-taranom-v82`

### 2026-07-23 ΓÇö [Cursor] ╪¿╪º╪▓╪╖╪▒╪º╪¡█î UX ┌»╪▒┘ê┘çΓÇî┘ç╪º ┘ê ╪▓█î╪▒┌»╪▒┘ê┘çΓÇî┘ç╪º ΓÇö SW v81
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `037fd39`
- **╪«┘ä╪º╪╡┘ç:** ╪▒╪º╪¿╪╖ ┌»╪▒┘ê┘çΓÇî┘ç╪º█î ┌⌐╪º┘ä╪º (╪»╪▒╪«╪¬ ┌»╪▒┘ê┘ç/╪▓█î╪▒┌»╪▒┘ê┘ç + ┘ü█î┘ä╪¬╪▒ + ╪¼╪│╪¬╪¼┘ê)╪î ┌»╪▒┘ê┘çΓÇî┘ç╪º█î ╪º╪┤╪«╪º╪╡ ┘ê ┌»╪▒┘ê┘çΓÇî┘ç╪º█î ┘à╪┤╪¬╪▒█î ╪¿╪º ┘ç┘à╪º┘å ╪▓╪¿╪º┘å ╪╖╪▒╪º╪¡█î ╪¬┘å╪╕█î┘à╪º╪¬ (hero╪î ╪ó┘à╪º╪▒╪î ┌⌐╪º╪▒╪¬╪î ╪│┘ê╪ª█î┌å ╪¿█î┘å ╪¿╪«╪┤ΓÇî┘ç╪º) ╪¿╪º╪▓╪╖╪▒╪º╪¡█î ╪┤╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/public/sw.js`, `docs/CHANGE-LOG.md`
- **Deploy:** Γ£à `e82d8d8` ΓÇö Iran health 200, SW `erp-taranom-v81`

### 2026-07-23 ΓÇö [Cursor] ╪¿╪º╪▓╪╖╪▒╪º╪¡█î UX ╪¬┘å╪╕█î┘à╪º╪¬ ╪¿╪▒┘å╪º┘à┘ç (╪»╪│╪¬┘çΓÇî╪¿┘å╪»█î + ╪¼╪│╪¬╪¼┘ê) ΓÇö SW v80
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `970a2c7`
- **╪«┘ä╪º╪╡┘ç:** ╪╡┘ü╪¡┘ç ╪¬┘å╪╕█î┘à╪º╪¬ ╪º╪▓ ┘ü┘ç╪▒╪│╪¬ ╪¿┘ä┘å╪» ╪┤┘ä┘ê╪║ ╪¿┘ç ╪┤┘É┘ä ╪»╪│╪¬┘çΓÇî╪¿┘å╪»█îΓÇî╪┤╪»┘ç ╪¿╪º ┘à┘å┘ê█î ┌⌐┘å╪º╪▒█î (█╕ ╪¿╪«╪┤)╪î ╪¼╪│╪¬╪¼┘ê╪î ╪│┘ê╪ª█î┌åΓÇî┘ç╪º█î ╪¬┘à█î╪▓╪î ┘ê ┘å┘ê╪º╪▒ ╪░╪«█î╪▒┘ç┘ö ┌å╪│╪¿╪º┘å ╪¬╪¿╪»█î┘ä ╪┤╪». ╪▒╪º┘ç┘å┘à╪º█î ╪»╪º╪«┘äΓÇî╪¿╪▒┘å╪º┘à┘ç ╪¿┘çΓÇî╪▒┘ê╪▓ ╪┤╪». ╪¿╪»┘ê┘å React ΓÇö Vanilla JS ┘à╪╖╪º╪¿┘é ┘à╪╣┘à╪º╪▒█î ┘╛╪▒┘ê┌ÿ┘ç.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/public/sw.js`, `docs/CHANGE-LOG.md`
- **Deploy:** Γ£à `69e351b` ΓÇö Iran health 200, SW `erp-taranom-v80`

### 2026-07-23 ΓÇö [Cursor] R13 ┘ü╪º╪▓ █▓: ╪º╪¿╪╖╪º┘ä ╪º┘å╪¿╪º╪▒╪î ┌å┌⌐╪î ╪»╪º╪▒╪º█î█î╪î ┘å╪▒╪« ╪│╪▒╪¿╪º╪▒╪î ╪«╪▒█î╪» ΓÇö SW v79
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `8d80a9e`
- **╪«┘ä╪º╪╡┘ç:** ╪¬┌⌐┘à█î┘ä ┘ü╪º╪▓ █▓ ┘é╪º┘å┘ê┘å ╪º╪¿╪╖╪º┘ä ┌⌐╪º┘à┘ä: void ╪╣┘à┘ä█î╪º╪¬ ╪º┘å╪¿╪º╪▒ (┘à┘ê╪¼┘ê╪»█î+JE ╪»╪│╪¬┘çΓÇî╪º█î)╪î ╪º╪¿╪╖╪º┘ä ┌⌐╪º┘à┘ä ┌å╪▒╪«┘ç ╪»┘ü╪¬╪▒ ┌å┌⌐╪î ╪║█î╪▒┘ü╪╣╪º┘äΓÇî╪│╪º╪▓█î/╪º╪¿╪╖╪º┘ä ╪º╪│╪¬┘ç┘ä╪º┌⌐ ╪»╪º╪▒╪º█î█î ╪½╪º╪¿╪¬╪î ┘ä╪║┘ê ┘å╪▒╪« ╪│╪▒╪¿╪º╪▒╪î ┘à╪│╪»┘ê╪»╪│╪º╪▓█î ╪º╪¿╪╖╪º┘ä ╪«╪▒█î╪» ╪▒┘ê█î ╪¿╪▒┌»╪┤╪¬/┘╛╪▒╪»╪º╪«╪¬ ┘ü╪╣╪º┘ä╪î `production.delete` ╪¿╪▒╪º█î ╪¡╪│╪º╪¿╪»╪º╪▒█î.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/void-warehouse-move.js`, `void-cheque.js`, `void-journal.js`, `routes/warehouses.js`, `cheque-records.js`, `fixed-assets.js`, `purchases.js`, `production-cost-centers.js`, `lib/rbac.js`, `public/index.html`
- **Deploy:** Γ£à `8d80a9e` ╪º█î╪▒╪º┘å ΓÇö health 200
- **SW:** `erp-taranom-v79`

### 2026-07-23 ΓÇö [Cursor] R13 ╪º╪¿╪╖╪º┘ä ┌⌐╪º┘à┘ä + ┘ä╪║┘ê ┘ü╪º┌⌐╪¬┘ê╪▒ ╪▒╪│┘à█î ╪º╪▓ ╪¬╪ú█î█î╪» ΓÇö SW v78
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `c7280db`
- **╪«┘ä╪º╪╡┘ç:** ┘é╪º┘å┘ê┘å ╪»╪º╪ª┘à█î R13 (EditΓçÆCancel ╪¿╪º reverse ┘ç┘à┘ç┘ö ╪º╪½╪▒╪º╪¬). ┘ä╪║┘ê ┘ü╪º┌⌐╪¬┘ê╪▒ ╪▒╪│┘à█î ╪¬┘ê╪│╪╖ ┘à╪»█î╪▒/╪¡╪│╪º╪¿╪»╪º╪▒█î ╪º╪▓ ╪╡┘ü╪¡┘ç┘ö ╪¬╪ú█î█î╪»: cascade ╪º╪¿╪╖╪º┘ä ╪¬╪│┘ê█î┘ç╪î ╪¿╪▒┌»╪┤╪¬ ╪¿┘ç ┘╛█î╪┤ΓÇî┘ü╪º┌⌐╪¬┘ê╪▒ ╪»╪▒ ╪╡┘ê╪▒╪¬ ╪¬╪¿╪»█î┘ä╪î ┘╛█î╪º┘à ╪»╪º╪«┘äΓÇî╪¿╪▒┘å╪º┘à┘ç ╪¿╪º ╪╣┌⌐╪│ ┘ü╪º┌⌐╪¬┘ê╪▒. ╪¿╪»┘ê┘å ╪¡╪░┘ü ┘ü█î╪▓█î┌⌐█î (R12).
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/void-invoice.js`, `server/lib/void-settlement.js`, `server/routes/invoices.js`, `server/routes/accounting.js`, `server/public/index.html`, `server/sync/capture.js`, `.cursor/rules/full-reverse-on-cancel.mdc`
- **Deploy:** Γ£à `c7280db` ╪º█î╪▒╪º┘å ΓÇö health 200
- **SW:** `erp-taranom-v78`
- **█î╪º╪»╪»╪º╪┤╪¬:** ┘ü╪º╪▓ █▓ backlog: ╪º┘å╪¿╪º╪▒ moves╪î ┌å┌⌐╪î ╪»╪º╪▒╪º█î█î ╪½╪º╪¿╪¬╪î ┘å╪▒╪« ╪│╪▒╪¿╪º╪▒.

### 2026-07-23 ΓÇö [Cursor] ┘é╪º┘ä╪¿ ┘ü╪º┌⌐╪¬┘ê╪▒ v2: █│ ╪▒╪│┘à█î + ╪╣╪º╪»█î ╪│╪º╪»┘ç + ╪¡╪▒╪º╪▒╪¬█î ΓÇö SW v77
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `d46fe60`
- **╪«┘ä╪º╪╡┘ç:** ╪╖╪▒╪º╪¡█î ╪¼╪»█î╪» ┌å╪º┘╛ ┘ü╪º┌⌐╪¬┘ê╪▒: ┘ä┘ê┌»┘ê ╪¿╪»┘ê┘å ╪¿┌⌐ ┘à╪┤┌⌐█î╪î ╪│╪¬┘ê┘å ╪¬╪«┘ü█î┘ü ╪▒╪»█î┘ü█î╪î ┌⌐╪º╪▒╪┤┘å╪º╪│ ┘ü╪▒┘ê╪┤+┘à┘ê╪¿╪º█î┘ä. ╪¡╪░┘ü ╪╣╪º╪»█î ┘ü╪┤╪▒╪»┘ç╪¢ ┘╛█î╪┤ΓÇî┘ü╪º┌⌐╪¬┘ê╪▒ ┘ü┘é╪╖ `casual-simple`╪¢ ╪▒╪│█î╪» ΓåÆ `thermal` ╪¿╪º ╪╣╪▒╪╢ █╡█╕/█╕█░mm ╪»╪▒ ╪¬┘å╪╕█î┘à╪º╪¬ ┘ê ╪»█î╪º┘ä┘ê┌» ┌å╪º┘╛.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/invoice-print.js`, `server/routes/invoices.js`, `server/routes/settings.js`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** Γ£à `d46fe60` ╪º█î╪▒╪º┘å ΓÇö health 200
- **SW:** `erp-taranom-v77`

### 2026-07-23 ΓÇö [Cursor] ╪½╪¿╪¬ ┘é╪º┘å┘ê┘å sync-hygiene ╪¿╪▒╪º█î ╪¼┘ä┘ê┌»█î╪▒█î ╪º╪▓ ╪¬┌⌐╪▒╪º╪▒ ╪¿╪º┌»ΓÇî┘ç╪º█î ╪│█î┘å┌⌐
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `a124f3b`
- **╪«┘ä╪º╪╡┘ç:** ╪»╪▒╪│ΓÇî┘ç╪º█î audit █▒█┤█░█╡/█░█╡ (PATH_TABLE_MAP╪î SYNCABLE append╪î compositeKeys╪î backfill_vN╪î files.js╪î ┘à┘à┘å┘ê╪╣█î╪¬ ingest ╪»█î╪¿╪º┌») ╪»╪▒ `.cursor/rules/sync-hygiene.mdc` + ┌»╪│╪¬╪▒╪┤ R10 ╪»╪▒ `.cursorrules` / project-conventions + ┌å┌⌐ΓÇî┘ä█î╪│╪¬ ╪»╪▒ `docs/OFFLINE-SYNC.md`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `.cursor/rules/sync-hygiene.mdc`, `docs/OFFLINE-SYNC.md`, `.cursorrules`, `.cursor/skills/project-conventions/SKILL.md`
- **Deploy:** Γ£à `a124f3b` ╪º█î╪▒╪º┘å
- **SW:** `erp-taranom-v76`

### 2026-07-23 ΓÇö [Cursor] ╪¡╪░┘ü instrumentation ╪»█î╪¿╪º┌» ╪│█î┘å┌⌐ ┘╛╪│ ╪º╪▓ ╪¬╪ú█î█î╪»
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `820287a`
- **╪«┘ä╪º╪╡┘ç:** ╪¡╪░┘ü fetch┘ç╪º█î debug session `b16e78` ╪º╪▓ `capture.js` / `client.js` ┘╛╪│ ╪º╪▓ ╪¬╪ú█î█î╪» post-fix (diag ╪╡┘ü╪▒ mismatch + test-sync 33/33). ┘à┘å╪╖┘é ┘ü█î┌⌐╪│ ╪│█î┘å┌⌐ ╪¿╪»┘ê┘å ╪¬╪║█î█î╪▒.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/sync/capture.js`, `server/sync/client.js`, `docs/CHANGE-LOG.md`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å ΓÇö health 200╪¢ SW `erp-taranom-v76`
- **SW:** `erp-taranom-v76`

### 2026-07-23 ΓÇö [Cursor] ╪¬┌⌐┘à█î┘ä ╪┤┌⌐╪º┘üΓÇî┘ç╪º█î ╪│█î┘å┌⌐ (PATH_TABLE_MAP + ╪¼╪»╪º┘ê┘ä ╪║╪º█î╪¿ + ┘ü╪º█î┘äΓÇî┘ç╪º)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `9167b3d`
- **╪«┘ä╪º╪╡┘ç:**
  1. `PATH_TABLE_MAP`: parties╪î detail-accounts/categories╪î units╪î product-categories╪î warehouses/moves╪î fixed-assets╪î production/user-cost-centers╪î reps/payments
  2. APPEND ╪¿┘ç `SYNCABLE_TABLES`: `fixed_assets`, `fixed_asset_depreciation`, `user_cost_centers` (composite), `rep_payment_submissions` + FK + `sync_seq_backfill_v4`
  3. file sync: `product_images` + ╪▒╪│█î╪»┘ç╪º█î `reps/`╪¢ ╪¡╪░┘ü ingest ╪»█î╪¿╪º┌» ┘é╪»█î┘à█î ╪º╪▓ `client.js`
  4. ╪¬╪┤╪«█î╪╡: `scripts/_diag-sync-gaps-b16e78.js` ΓÇö post-fix ╪╡┘ü╪▒ mismatch╪¢ `test-sync.js` █│█│/█│█│
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/sync/capture.js`, `server/sync/tables.js`, `server/sync/client.js`, `server/sync/files.js`, `server/db.js`, `docs/CHANGE-LOG.md`, `server/public/index.html`
- **Deploy:** Γ£à `99e1015` ╪º█î╪▒╪º┘å ΓÇö health 200╪¢ diag ╪╡┘ü╪▒ mismatch╪¢ SW `erp-taranom-v76`
- **SW:** `erp-taranom-v76` (╪¿╪»┘ê┘å bump ΓÇö ╪¬╪║█î█î╪▒ ╪╣┘à╪»╪¬╪º┘ï ╪│╪▒┘ê╪▒/╪│█î┘å┌⌐)

### 2026-07-22 ΓÇö [Cursor] █╢ ┘é╪º┘ä╪¿ ┘ü╪º┌⌐╪¬┘ê╪▒ ╪▒╪│┘à█î/┘à╪╣┘à┘ê┘ä█î + ╪¬┘å╪╕█î┘à╪º╪¬ A4/A5 ΓÇö SW v76
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** c7c7b5e
- **╪«┘ä╪º╪╡┘ç:** ┘à┘ê╪¬┘ê╪▒ ┌å╪º┘╛ `invoice-print.js` ╪¿╪º █│ ┘é╪º┘ä╪¿ ╪▒╪│┘à█î + █│ ┘à╪╣┘à┘ê┘ä█î (╪¿╪▒┘å╪» ╪¬╪▒┘å┘à)╪î ╪º┘å╪¬╪«╪º╪¿ ╪»╪▒ ╪¬┘å╪╕█î┘à╪º╪¬╪î ╪┤╪«╪╡█îΓÇî╪│╪º╪▓█î ┘ü█î┘ä╪»┘ç╪º╪î A4/A5. ┘ü╪º┌⌐╪¬┘ê╪▒ ┘å┘ç╪º█î█îΓåÆ╪▒╪│┘à█î╪î ┘╛█î╪┤ΓÇî┘ü╪º┌⌐╪¬┘ê╪▒ΓåÆ┘à╪╣┘à┘ê┘ä█î.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/invoice-print.js`, `server/routes/invoices.js`, `server/routes/settings.js`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ΓÅ│
- **SW:** `erp-taranom-v76`

### 2026-07-22 ΓÇö [Cursor] ╪▒┘ü╪╣ ╪│█î┘å┌⌐ ╪º┘å╪¿╪º╪▒/╪¼╪»╪º┘ê┘ä ╪║╪º█î╪¿ + cascade ╪¡╪░┘ü partyΓåöCRM + SW v75
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** (╪»╪▒ ╪¡╪º┘ä push)
- **╪«┘ä╪º╪╡┘ç:**
  1. ╪¿╪º┌» tombstone ╪¿╪▒╪º█î `warehouse_stock` (┌⌐┘ä█î╪» ┘à╪▒┌⌐╪¿ ╪¿╪»┘ê┘å `id`) ΓÇö `compositeKeys` + apply ╪»╪▒╪│╪¬ ╪»╪▒ `client.js`
  2. append ┘ü┘é╪╖: `party_groups` + `cheque_records` ╪¿┘ç `SYNCABLE_TABLES` (+ backfill sync_seq v3)
  3. `PATH_TABLE_MAP`: ┘à╪│█î╪▒┘ç╪º█î production/inventory/party-groups ┘é╪¿┘ä ╪º╪▓ prefix ╪╣┘à┘ê┘à█î
  4. ╪¡╪░┘ü ╪¡╪│╪º╪¿╪»╪º╪▒█î party ΓåÆ cascade CRM╪¢ ╪¡╪░┘ü CRM ΓåÆ soft-delete party╪¢ ┘ü█î┘ä╪¬╪▒ ┘ä█î╪│╪¬ΓÇî┘ç╪º╪¢ ╪│┘ê╪▒╪¬ ╪│╪¬┘ê┘å ╪¿╪º `data-sort`
  5. █î┌⌐╪»╪│╪¬ΓÇî╪│╪º╪▓█î `?v=75` ╪¿╪º SW `erp-taranom-v75`
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/sync/{tables,client,capture}.js`, `server/db.js`, `server/lib/parties-sync.js`, `server/routes/{parties,customers,followups,suppliers}.js`, `server/public/{index.html,tbl-enhance.js,sw.js}`
- **Deploy:** ΓÅ│
- **╪¬╪│╪¬:** `node scripts/debug-warehouse-stock-sync.js` (post-fix fixWorks), `node scripts/test-party-crm-delete-sync.js`
- **SW:** `erp-taranom-v75`

### 2026-07-22 ΓÇö ╪¡╪░┘ü ┌⌐╪º┘à┘ä ┘ê╪º╪¡╪» ╪╣┘à┘ä█î╪º╪¬█î ╪»╪▒ ┘╛┘ê╪▒╪¬╪º┘ä
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `f9e9282`
- **╪«┘ä╪º╪╡┘ç:** ┌⌐┘å╪º╪▒ ┘ê█î╪▒╪º█î╪┤ ┘ê╪º╪¡╪»╪î ╪»┌⌐┘à┘ç┘ö ╪¡╪░┘ü ╪º╪╢╪º┘ü┘ç ╪┤╪». `DELETE /api/portal/units/:id` ╪¿┘çΓÇî╪¼╪º█î ╪¿╪º█î┌»╪º┘å█î╪î ┘ê╪º╪¡╪» ╪▒╪º ╪¿╪º cascade ┌⌐╪º┘à┘ä (╪¿╪«╪┤ΓÇî┘ç╪º╪î ┘╛╪º╪▒╪º┘à╪¬╪▒┘ç╪º╪î ╪º╪¬╪╡╪º┘ä╪º╪¬╪î ╪º┘à┌⌐╪º┘å╪º╪¬/┘ê╪╕╪º█î┘ü/┘ê╪º┌»╪░╪º╪▒█î) ╪º╪▓ DB ┘╛╪º┌⌐ ┘à█îΓÇî┌⌐┘å╪». ╪º╪│┘å╪º╪» ╪¡╪│╪º╪¿╪»╪º╪▒█î/╪º┘å╪¿╪º╪▒ ┘é╪¿┘ä█î ╪»╪│╪¬ΓÇî┘å╪«┘ê╪▒╪»┘ç ┘à█îΓÇî┘à╪º┘å┘å╪». SW `v74`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/routes/portal.js`, `server/public/portal-ui.js`, `server/public/index.html`, `server/public/sw.js`, `server/scripts/test-portal.js`
- **Deploy:** Γ£à Iran health/root 200 ΓÇö SW `erp-taranom-v74` (git pull ╪▒┘ê█î ╪│╪▒┘ê╪▒ ╪¿┘çΓÇî╪«╪º╪╖╪▒ DNS github ╪┤┌⌐╪│╪¬╪¢ ┘ü╪º█î┘äΓÇî┘ç╪º ╪¿╪º SFTP ╪º╪╣┘à╪º┘ä ╪┤╪»)
- **SW:** `erp-taranom-v74`

### 2026-07-22 ΓÇö ╪▒┘ü╪╣ ╪│┘ê╪▒╪¬ ╪╣╪»╪»█î ╪¼╪»╪º┘ê┘ä (┘à┘ê╪¼┘ê╪»█î/┘é█î┘à╪¬ ╪¿╪º ╪▒┘é┘à ┘ü╪º╪▒╪│█î)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** (pending)
- **╪«┘ä╪º╪╡┘ç:** ╪│┘ê╪▒╪¬ ╪│╪¬┘ê┘åΓÇî┘ç╪º█î ╪╣╪»╪»█î ╪»╪▒ `tbl-enhance.js` ╪¿┘çΓÇî╪«╪º╪╖╪▒ `fmt()`/`fa-IR` (╪▒┘é┘à ┘ü╪º╪▒╪│█î) ╪¿┘çΓÇî╪╡┘ê╪▒╪¬ ╪▒╪┤╪¬┘çΓÇî╪º█î ╪¿┘ê╪»╪¢ ╪¿╪º ┘å╪▒┘à╪º┘äΓÇî╪│╪º╪▓█î ╪▒┘é┘à ┘ü╪º╪▒╪│█î/╪╣╪▒╪¿█î ┘ê ╪¼╪»╪º┌⌐┘å┘å╪»┘ç ┘ç╪▓╪º╪▒┌»╪º┘å╪î ╪│┘ê╪▒╪¬ ╪╣╪»╪»█î ╪»╪▒ ┘ç┘à┘ç ╪¼╪»╪º┘ê┘ä ╪º╪╡┘ä╪º╪¡ ╪┤╪». SW `v73`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/tbl-enhance.js`, `server/public/sw.js`, `server/public/index.html`
- **Deploy:** ΓÅ│
- **SW:** `erp-taranom-v73`

### 2026-07-22 ΓÇö ╪¬╪╡╪º┘ê█î╪▒ ┌⌐╪º┘ä╪º (╪¿┘ç█î┘å┘ç/╪ó┘ä╪¿┘ê┘à)╪î ┘à┘ê╪¼┘ê╪»█î ╪¿╪º╪▓╪º╪▒█î╪º╪¿╪î ╪º┘å╪¿╪º╪▒ ┘ü╪▒┘ê╪┤┘å╪»┘ç
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `c24b9a6`
- **╪«┘ä╪º╪╡┘ç:** ╪ó┘╛┘ä┘ê╪» ╪¬╪╡┘ê█î╪▒ ┌⌐╪º┘ä╪º ╪¿╪º sharp ╪¿┘ç WebP ╪¿┘ç█î┘å┘ç (╪¡╪»╪º┌⌐╪½╪▒ █▒█▓█╕█░px)╪¢ ┘╛█î╪┤ΓÇî┘å┘à╪º█î╪┤ ┘ê ╪ó┘ä╪¿┘ê┘à ┌å┘å╪»╪╣┌⌐╪│█î ╪¿╪▒╪º█î ┘ç┘à┘ç ┌⌐╪º╪▒╪¿╪▒╪º┘å╪¢ ╪»╪▒ ┘ü╪▒┘ê╪┤ ╪¿╪º╪▓╪º╪▒█î╪º╪¿ ┌⌐╪º┘ä╪º█î ╪¿╪»┘ê┘å ┘à┘ê╪¼┘ê╪»█î ╪¿┘ç ╪│╪¿╪» ╪º╪╢╪º┘ü┘ç ┘å┘à█îΓÇî╪┤┘ê╪» (╪«╪╖╪º█î ┌⌐╪│╪▒ ┘à┘ê╪¼┘ê╪»█î)╪¢ ╪│╪¬┘ê┘å ╪º┘å╪¬╪«╪º╪¿ ╪º┘å╪¿╪º╪▒ ╪»╪▒ ╪º┘é┘ä╪º┘à ┘ü╪º┌⌐╪¬┘ê╪▒ ┘ü╪▒┘ê╪┤┘å╪»┘çΓÇî┘ç╪º ┘à╪«┘ü█î ┘ê ┌⌐╪│╪▒ ┘ü┘é╪╖ ╪º╪▓ `sales_warehouse_id` ┌⌐╪º╪▒╪¿╪▒. SW `v71`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/routes/products.js`, `server/routes/invoices.js`, `server/public/index.html`, `server/public/marketer-ui.js`, `server/public/sw.js`
- **Deploy:** Γ£à `78a7be5` Iran health 200 ΓÇö SW `erp-taranom-v71` (sharp:ok)
- **SW:** `erp-taranom-v71`

### 2026-07-22 - ┘ü╪▒┘ê╪┤ ╪¿╪º╪▓╪º╪▒█î╪º╪¿╪î ╪¡╪▒█î┘à ┌⌐╪º╪▒╪¿╪▒╪º┘å╪î ╪º┘å╪¿╪º╪▒ ┘à╪¿╪»╪ú ┌⌐╪º╪▒╪┤┘å╪º╪│
- **╪┤╪º╪«┘ç:** claude/claude-md-docs-2ssrpy
- **Commit:** c43f066
- **╪«┘ä╪º╪╡┘ç:** ╪¡╪▒█î┘à ╪º╪╖┘ä╪º╪╣╪º╪¬ ╪┤╪«╪╡ ┌⌐╪º╪▒╪¿╪▒╪¢ ┘ü█î┘ä╪¬╪▒ ┌»╪▒┘ê┘ç/┘à┘ê╪¼┘ê╪»█î ┘ê ┘╛┌⌐ ╪»╪▒ ┘ü╪▒┘ê╪┤ ╪¿╪º╪▓╪º╪▒█î╪º╪¿╪¢ ╪º┘å╪¬┘é╪º┘ä ╪│╪¿╪» ╪¿┘ç ╪º┘é┘ä╪º┘à ┘ü╪º┌⌐╪¬┘ê╪▒╪¢ ┘à╪«┘ü█îΓÇî╪│╪º╪▓█î ┘ü█î┘ä╪»┘ç╪º█î ┘╛█î╪┤╪▒┘ü╪¬┘ç ┘ü╪º┌⌐╪¬┘ê╪▒ ╪¿╪▒╪º█î ┌⌐╪º╪▒╪┤┘å╪º╪│ ┘à█î╪»╪º┘å█î/╪»╪º╪«┘ä█î╪¢ ╪º┘å╪¿╪º╪▒ ┘à╪¿╪»╪ú ┘╛█î╪┤ΓÇî┘ü╪▒╪╢ ╪»╪▒ ╪¬╪╣╪▒█î┘ü ┌⌐╪º╪▒╪¿╪▒╪¢ ╪¡╪░┘ü ┌⌐╪º╪¬╪º┘ä┘ê┌»/┘ü╪▒┘ê╪┤ ╪¿╪º╪▓╪º╪▒█î╪º╪¿ ╪º╪▓ ┘à┘å┘ê█î ┘à╪»█î╪▒ ╪│█î╪│╪¬┘à ┘ê ╪¡╪│╪º╪¿╪»╪º╪▒█î
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** server/public/index.html, server/public/marketer-ui.js, server/routes/parties.js, server/routes/admin.js, server/routes/invoices.js, server/routes/auth.js, server/db.js, server/public/sw.js
- **Deploy:** Γ£à 7e6585 Iran health 200 ΓÇö SW erp-taranom-v69
- **SW:** erp-taranom-v69

### 2026-07-22 - ╪▒┘ü╪╣ ┌⌐╪┤ ┘ü╪▒┘ê╪┤ ╪¿╪º╪▓╪º╪▒█î╪º╪¿ (┘ü█î┘ä╪¬╪▒/┘╛┌⌐/╪│╪¿╪»ΓåÆ┘ü╪º┌⌐╪¬┘ê╪▒)
- **╪┤╪º╪«┘ç:** claude/claude-md-docs-2ssrpy
- **Commit:** 46a3239
- **╪«┘ä╪º╪╡┘ç:** ╪╣┘ä╪¬: SW ┘é╪»█î┘à█î marketer-ui.js ╪▒╪º cache-first ┘å┌»┘ç ┘à█îΓÇî╪»╪º╪┤╪¬. network-first ╪¿╪▒╪º█î JS/CSS + ?v=69╪¢ ┘ü█î┘ä╪¬╪▒ ┌»╪▒┘ê┘ç/┘à┘ê╪¼┘ê╪»█î ┘ê pack_size╪¢ ╪º┘å╪¬┘é╪º┘ä ┘é╪╖╪╣█î ╪│╪¿╪» ╪¿┘ç ╪º┘é┘ä╪º┘à ┘ü╪º┌⌐╪¬┘ê╪▒ ╪¿╪º __pendingMarketerInvRows
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** server/public/marketer-ui.js, server/public/sw.js, server/public/index.html
- **Deploy:** Γ£à 46a3239 Iran health 200 ΓÇö SW erp-taranom-v69
- **SW:** erp-taranom-v69

## ╪¬╪º╪▒█î╪«┌å┘ç

### 2026-07-22 ΓÇö ╪▒┘ü╪╣ ┬½╪»╪│╪¬╪▒╪│█î ┘å╪»╪º╪▒█î╪»┬╗ ┘ü╪º┌⌐╪¬┘ê╪▒╪│╪º╪▓ ╪¿╪▒╪º█î ┌⌐╪º╪▒╪┤┘å╪º╪│ ┘ü╪▒┘ê╪┤
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `c087fe6`
- **╪«┘ä╪º╪╡┘ç:** GET ╪¿╪º┘å┌⌐/╪╡┘å╪»┘ê┘é/╪»╪│╪¬┘ç ┌å┌⌐/┘à╪▒┌⌐╪▓ ┘ç╪▓█î┘å┘ç ╪¿╪▒╪º█î ┘ç┘à┘ç┘ö ┌⌐╪º╪▒╪¿╪▒╪º┘å ┘ä╪º┌»█î┘åΓÇî╪┤╪»┘ç ╪¿╪º╪▓ ╪┤╪»╪¢ ┘ä┘ê╪» ┘à╪¬╪º█î ┘ü╪º┌⌐╪¬┘ê╪▒╪│╪º╪▓ soft-fail + silent. ┌⌐╪º╪▒╪┤┘å╪º╪│ ┘à█î╪»╪º┘å█î ┘à█îΓÇî╪¬┘ê╪º┘å╪» ╪º╪▓ ┘ü╪▒┘ê╪┤ ╪¿╪º╪▓╪º╪▒█î╪º╪¿ ┘ü╪º┌⌐╪¬┘ê╪▒╪│╪º╪▓ ╪▒╪º ╪¿╪º╪▓ ┌⌐┘å╪». SW `v67`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `routes/{banks,cash-boxes,check-categories,accounting}.js`, `public/index.html`, `public/sw.js`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `94.249.244.208` ΓÇö HEAD=`86dfdfb` (╪┤╪º┘à┘ä `c087fe6`)╪î `pm2 restart`╪î health █▓█░█░╪î SW `v67`
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `04d5d0d`
- **╪«┘ä╪º╪╡┘ç:** ┌⌐╪º╪▒╪¬ ┌⌐╪º┘ä╪º ╪»╪▒ ┘ü╪▒┘ê╪┤ ╪¿╪º╪▓╪º╪▒█î╪º╪¿ ┘ç┘à╪º┘å ┘é╪º┘ä╪¿ ┌⌐╪º╪¬╪º┘ä┘ê┌»╪¢ ╪º┘ü╪▓┘ê╪»┘å ╪¿┘ç ╪│╪¿╪» ╪¿╪º `pack_size`╪¢ ┘à┘å┘ê█î ┌⌐╪º╪¬╪º┘ä┘ê┌»/╪¿╪º╪▓╪º╪▒█î╪º╪¿ ╪¿╪▒╪º█î ╪º╪»┘à█î┘å╪¢ ╪»┌⌐┘à┘ç ╪│╪▒█î╪╣ ┬½╪»╪│╪¬╪▒╪│█î ┌⌐╪º┘à┘ä ┘ü╪º┌⌐╪¬┘ê╪▒┬╗ ╪»╪▒ RBAC╪¢ ┌»█î╪¬ `invoices.create` ╪▒┘ê█î UI ┘ê API. SW `v66`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `public/marketer-ui.js`, `public/index.html`, `routes/invoices.js`, `public/sw.js`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `94.249.244.208` ΓÇö HEAD=`b2f55ca` (╪┤╪º┘à┘ä `04d5d0d`)╪î `pm2 restart`╪î health █▓█░█░╪î SW `v66`

### 2026-07-22 ΓÇö ╪¿╪º╪▓╪╖╪▒╪º╪¡█î UI: Soft Bento (┘å┘à┘ê┘å┘ç C)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `b7f4b29`
- **╪«┘ä╪º╪╡┘ç:** ╪º╪╣┘à╪º┘ä ┘╛┘ê╪│╪¬┘ç Soft Bento ╪¿╪º ┘ç┘à╪º┘å ┘╛╪º┘ä╪¬ ╪▓┘à╪▒╪» ┘à╪»╪▒┘å: ╪│╪º█î╪»╪¿╪º╪▒ ╪╣┘à█î┘éΓÇî╪¬╪▒╪î ╪¬╪º┘╛ΓÇî╪¿╪º╪▒ ╪┤┘å╪º┘ê╪▒ ╪│┘ü█î╪»╪î ┘å┘ê╪º╪▒ KPI ┘é┘ç╪▒┘à╪º┘å ╪»╪▒ ╪»╪º╪┤╪¿┘ê╪▒╪»╪î ┘╛┘å┘ä/╪»┌⌐┘à┘ç ┌»╪▒╪»╪¬╪▒. SW `v65`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/public/sw.js`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `94.249.244.208` ΓÇö HEAD=`73a4fb1` (╪┤╪º┘à┘ä `b7f4b29`)╪î `pm2 restart`╪î health █▓█░█░╪î SW `v65`

### 2026-07-22 ΓÇö ┘╛█î╪┤ΓÇî┘å┘à╪º█î╪┤ █│ ┌»╪▓█î┘å┘ç ╪¿╪º╪▓╪╖╪▒╪º╪¡█î UI (╪¿╪»┘ê┘å ╪º╪╣┘à╪º┘ä)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `48e0661`
- **╪«┘ä╪º╪╡┘ç:** ╪│┘ç ┘å┘à┘ê┘å┘ç HTML ╪¿╪º╪▓╪╖╪▒╪º╪¡█î ┘à╪»╪▒┘å/┘à█î┘å█î┘à╪º┘ä ╪¿╪º ┘╛╪º┘ä╪¬ ┬½╪▓┘à╪▒╪» ┘à╪»╪▒┘å┬╗ ╪¿╪▒╪º█î ╪¬╪ú█î█î╪» ┌⌐╪º╪▒╪¿╪▒: A Soft Shell╪î B Ultra Minimal╪î C Soft Bento. ┘ç┘å┘ê╪▓ ╪▒┘ê█î `index.html` ╪º╪╣┘à╪º┘ä ┘å╪┤╪»┘ç.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `docs/design/redesign-previews/{index,A-soft-shell,B-ultra-minimal,C-soft-bento}.html`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `94.249.244.208` ΓÇö HEAD=`e38befc`╪î health █▓█░█░ (docs-only╪¢ SW ╪¿╪»┘ê┘å ╪¬╪║█î█î╪▒ `v64`)
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪│┘ç┘à█î┘ç ╪▒╪º█î┌»╪º┘å 21st AI ╪¬┘à╪º┘à ╪¿┘ê╪»╪¢ ┘å┘à┘ê┘å┘çΓÇî┘ç╪º ┘à╪¡┘ä█î ╪│╪º╪«╪¬┘ç ╪┤╪». ┘à┘å╪¬╪╕╪▒ ╪º┘å╪¬╪«╪º╪¿ A/B/C ┘é╪¿┘ä ╪º╪▓ ┘╛█î╪º╪»┘çΓÇî╪│╪º╪▓█î UI.

### 2026-07-22 ΓÇö ┘ü╪º╪▒╪│█îΓÇî╪│╪º╪▓█î ┌⌐╪º┘à┘ä ┘à╪º╪¬╪▒█î╪│ ╪»╪│╪¬╪▒╪│█î ┌⌐╪º╪▒╪¿╪▒╪º┘å
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `5fdebe0`
- **╪«┘ä╪º╪╡┘ç:** ╪»╪▒ ╪¬╪╣╪▒█î┘ü ┌⌐╪º╪▒╪¿╪▒╪º┘å ΓåÆ ┬½╪»╪│╪¬╪▒╪│█îΓÇî┘ç╪º┬╗╪î ┘å╪º┘à ╪¿╪«╪┤ΓÇî┘ç╪º (customers/ΓÇª) ┘ê ╪╣┘à┘ä█î╪º╪¬ (view/create/ΓÇª) ╪¿┘ç ┘ü╪º╪▒╪│█î ┘å┘à╪º█î╪┤ ╪»╪º╪»┘ç ┘à█îΓÇî╪┤┘ê╪». SW `v64`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `public/index.html`, `public/sw.js`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `94.249.244.208` ΓÇö HEAD=`5fdebe0`╪î `pm2 restart`╪î health █▓█░█░╪î SW `v64`

### 2026-07-22 ΓÇö ┘╛█î╪º┘à┌⌐ ╪▒┘à╪▓ ┘à┘ê┘é╪¬ ┘╛┘ê╪▒╪¬╪º┘ä ╪º╪«╪¬█î╪º╪▒█î
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `a27172b`
- **╪«┘ä╪º╪╡┘ç:** ┌å┌⌐ΓÇî╪¿╪º┌⌐╪│ ┬½╪º╪▒╪│╪º┘ä ╪▒┘à╪▓ ┘à┘ê┘é╪¬ ╪¿╪º ┘╛█î╪º┘à┌⌐┬╗ ╪»╪▒ ┘ü╪▒┘à ╪º╪┤╪«╪º╪╡ (┘╛█î╪┤ΓÇî┘ü╪▒╪╢ ╪«╪º┘à┘ê╪┤). ╪¿╪»┘ê┘å ┘╛█î╪º┘à┌⌐ ╪▒┘à╪▓ ╪º┘ê┘ä█î┘ç `12345` + ╪¬╪║█î█î╪▒ ╪º╪¼╪¿╪º╪▒█î ╪»╪▒ ╪º┘ê┘ä█î┘å ┘ê╪▒┘ê╪». API `send_sms` ╪▒┘ê█î `/portal/access` ┘ê ╪│╪º╪«╪¬ ┘ê╪º╪¡╪»/╪¿╪«╪┤. SW `v63`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `lib/portal-users.js`, `routes/portal.js`, `public/index.html`, `public/portal-ui.js`, `public/sw.js`, `scripts/test-portal.js`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `94.249.244.208` ΓÇö HEAD=`a27172b`╪î `pm2 restart`╪î health █▓█░█░╪î SW `v63`

### 2026-07-22 ΓÇö ┘ü█î┘ä╪¬╪▒ ┘ü╪▒┘ê╪┤ ╪¿╪º╪▓╪º╪▒█î╪º╪¿ + ┘à╪¡╪»┘ê╪»█î╪¬ ┌»╪▒┘ê┘ç ┌⌐╪º┘ä╪º (is_shared)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `4aaefd1`
- **╪«┘ä╪º╪╡┘ç:** ┘ü╪▒┘ê╪┤ ╪¿╪º╪▓╪º╪▒█î╪º╪¿ ┘ç┘à╪º┘å ┘ü█î┘ä╪¬╪▒┘ç╪º█î ┌⌐╪º╪¬╪º┘ä┘ê┌» (╪¼╪│╪¬╪¼┘ê/┌»╪▒┘ê┘ç/┘à┘ê╪¼┘ê╪»█î╪î ╪¿╪»┘ê┘å ╪º┘å╪¿╪º╪▒). ╪¿╪º╪▓┌»╪▒╪»╪º┘å█î ┘ü█î┘ä╪¬╪▒ `is_shared` ╪¿╪▒╪º█î ┌⌐╪º╪▒╪¿╪▒╪º┘å ╪╣╪º╪»█î ╪»╪▒ ┘ä█î╪│╪¬ ┌⌐╪º┘ä╪º/┌»╪▒┘ê┘ç/╪¿╪º╪▒┌⌐╪» + ACL ╪º╪«╪¬█î╪º╪▒█î `user_catalog_categories`. ╪░╪«█î╪▒┘ç┘ö ┘ê╪º┘é╪╣█î `is_shared` ╪»╪▒ POST/PUT. SW `v62`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `lib/product-visibility.js`, `routes/{products,product-categories}.js`, `public/marketer-ui.js`, `public/{index.html,sw.js}`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `94.249.244.208` ΓÇö HEAD=`4aaefd1`╪î `pm2 restart`╪î health █▓█░█░╪î SW `v62`

### 2026-07-22 ΓÇö ╪»╪│╪¬╪▒╪│█î ┘╛┘ê╪▒╪¬╪º┘ä ╪º╪▓ ╪¬┘å╪╕█î┘à╪º╪¬ ╪º╪┤╪«╪º╪╡
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `9df765d`
- **╪«┘ä╪º╪╡┘ç:** ╪»╪▒ ┘ü╪▒┘à ╪º╪╖┘ä╪º╪╣╪º╪¬ ╪º╪┤╪«╪º╪╡ (`partyModal`) ┘ê ╪º╪┤╪«╪º╪╡ (`personModal`) ┘ü█î┘ä╪» ┬½╪»╪│╪¬╪▒╪│█î ┘╛┘ê╪▒╪¬╪º┘ä ╪╣┘à┘ä█î╪º╪¬█î┬╗ ╪º╪╢╪º┘ü┘ç ╪┤╪» ╪¬╪º ┘å┘é╪┤ ┘à╪»█î╪▒ ┘ê╪º╪¡╪»/╪¿╪«╪┤ (█î╪º ╪¿╪»┘ê┘å ╪»╪│╪¬╪▒╪│█î) ╪º╪▓ ┘ç┘à╪º┘å╪¼╪º ╪¬┘å╪╕█î┘à ╪┤┘ê╪». API `GET/PUT /api/portal/access` + helper `setPortalAccess`╪¢ ╪»╪▒ ╪╡┘ê╪▒╪¬ ┘å█î╪º╪▓ ╪▒╪»█î┘ü `persons` ╪º╪▓ ╪▒┘ê█î ╪¬┘ä┘ü┘å ╪│╪º╪«╪¬┘ç ┘à█îΓÇî╪┤┘ê╪»╪¢ ╪▒┘à╪▓ ┘à┘ê┘é╪¬ ┘ü┘é╪╖ ╪¿╪º SMS. SW `v61`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `lib/portal-users.js`, `routes/portal.js`, `public/index.html`, `public/sw.js`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `94.249.244.208` ΓÇö HEAD=`9df765d`╪î `pm2 restart`╪î health █▓█░█░╪î SW `v61`
- **█î╪º╪»╪»╪º╪┤╪¬:** ┘å╪º┘à ┌⌐╪º╪▒╪¿╪▒█î ┘ê╪▒┘ê╪» = ╪¬┘ä┘ü┘å╪¢ ┘╛╪│ ╪º╪▓ ╪º╪╣╪╖╪º╪î ╪┤╪«╪╡ ╪»╪▒ ┘ä█î╪│╪¬ ┘à╪│╪ª┘ê┘ä ┘ê╪º╪¡╪»/╪¿╪«╪┤ ┘╛┘ê╪▒╪¬╪º┘ä ┘é╪º╪¿┘ä ╪º┘å╪¬╪«╪º╪¿ ╪º╪│╪¬.

### 2026-07-22 ΓÇö ╪º╪¼╪▒╪º█î ┌⌐╪º┘à┘ä update.md (┘ê╪╕╪º█î┘ü █▒ΓÇô█╣)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `e256235`
- **╪«┘ä╪º╪╡┘ç:** █▒) ╪▒┘ü╪╣ ┌⌐╪┤ ╪«╪º┘ä█î ╪º┘å╪¿╪º╪▒/┌»╪▒┘ê┘ç ┌⌐╪º┘ä╪º. █▓) API ┘à┘ê╪¼┘ê╪»█î ┘ê╪¿ΓÇî╪│╪º█î╪¬ `/api/v1/stock` + webhook/push ┘ê┘ê┌⌐╪º┘à╪▒╪│. █│) ╪┤┘à╪º╪▒╪┤ ╪»┘é█î┘é ┌»╪▒┘ê┘ç ╪º╪┤╪«╪º╪╡ ╪¿╪»┘ê┘å ╪»┘ê╪¿╪º╪▒┘çΓÇî╪┤┘à╪º╪▒█î. █┤) ╪¡╪░┘ü ┘ü█î┘ä╪¬╪▒ ╪º┘å╪¿╪º╪▒ ╪º╪▓ ┌⌐╪º╪¬╪º┘ä┘ê┌» + ACL ┌»╪▒┘ê┘ç ┌⌐╪º┘ä╪º per-user. █╡) ┌å┘å╪»╪¬╪╡┘ê█î╪▒█î ┌⌐╪º┘ä╪º. █╢) z-index ╪▒█î╪│┘╛╪º┘å╪│█î┘ê (toast/╪º╪╣┘ä╪º┘å ╪¿╪º┘ä╪º█î taskbar). █╖) ╪▒┘ê╪¿█î┌⌐╪º ┘ç┘å┌»╪º┘à ╪¬╪ú█î█î╪» ┘ü╪º┌⌐╪¬┘ê╪▒. █╕) ┘à╪º┌ÿ┘ê┘ä ┘à╪│╪¬┘é┘ä ┘╛█î╪º┘à┌⌐ (┘é╪º┘ä╪¿/┌»╪▓█î┘å┘ç/╪▓┘à╪º┘åΓÇî╪¿┘å╪»█î). █╣) ┌»╪▒┘ê┘ç ╪¿╪º╪▓╪º╪▒█î╪º╪¿ + ┌»╪▒╪»╪┤ ┌⌐╪º╪¬╪º┘ä┘ê┌»ΓåÆ╪│╪¿╪»ΓåÆ┘ü╪º┌⌐╪¬┘ê╪▒. SW `v60`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `lib/update-md-schema.js`, `lib/website-stock-sync.js`, `lib/rubika.js`, `routes/{api_v1,party-groups,products,accounting,auth,sms-module,settings}.js`, `public/{index.html,marketer-ui.js,sw.js}`, `sync/tables.js`, `server.js`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `94.249.244.208` ΓÇö HEAD=`e256235`╪î `pm2 restart`╪î health █▓█░█░╪î smoke tables OK╪î SW `v60`

### 2026-07-22 ΓÇö ╪▒┘ü╪╣ ╪¿╪º┌» ┘å┘à╪º█î╪┤ ╪º┘å╪¿╪º╪▒┘ç╪º ┘ê ┌»╪▒┘ê┘çΓÇî┘ç╪º█î ┌⌐╪º┘ä╪º ╪»╪▒ ╪¿╪«╪┤ΓÇî┘ç╪º█î ┘à╪¬╪╡┘ä
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ╪¿╪»┘ê┘å commit
- **╪«┘ä╪º╪╡┘ç:** ┌⌐╪┤ master-data ╪¿╪º ╪ó╪▒╪º█î┘ç┘ö ╪«╪º┘ä█î (`[]`) ╪¿┘çΓÇî╪º╪┤╪¬╪¿╪º┘ç ┬½╪¿╪º╪▒┌»╪░╪º╪▒█îΓÇî╪┤╪»┘ç┬╗ ╪¬┘ä┘é█î ┘à█îΓÇî╪┤╪» ┘ê ╪¬╪º ┘ê█î╪▒╪º█î╪┤ ╪»╪│╪¬█î ╪»┘ê╪¿╪º╪▒┘ç fetch ┘å┘à█îΓÇî╪┤╪». ╪╣┘ä╪¬ ╪º╪╡┘ä█î ┌»╪▒┘ê┘çΓÇî┘ç╪º: ╪╡┘ü╪¡┘ç ┌⌐╪º┘ä╪º/┌⌐╪º╪¬╪º┘ä┘ê┌» ╪¿╪º `canEdit=false` ┘à┘é╪»╪º╪▒ `CACHE.productCategories=[]` ┘à█îΓÇî┌»╪░╪º╪┤╪¬. ╪º╪╡┘ä╪º╪¡: `ensureWarehouses` / `ensureProductCategories` ╪»╪▒ ┘ç┘à┘ç┘ö ┘à╪│█î╪▒┘ç╪º█î dropdown╪î ╪╣╪»┘à poison ╪¿╪º `[]` ╪▒┘ê█î ╪«╪╖╪º╪î ┘ç┘à█î╪┤┘ç ╪¿╪º╪▒┌»╪░╪º╪▒█î ┌»╪▒┘ê┘çΓÇî┘ç╪º ╪»╪▒ `productsPage`╪î invalidate ┌⌐╪º┘à┘ä ┘╛╪│ ╪º╪▓ CRUD ┌»╪▒┘ê┘ç ┌⌐╪º┘ä╪º. SW `v59`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/public/portal-ui.js`, `server/public/sw.js`
- **Deploy:** ΓÅ│ ┘å█î╪º╪▓ ╪¿┘ç pull
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪¿╪»┘ê┘å ┘ê█î╪▒╪º█î╪┤ ╪»╪│╪¬█î ╪º┘å╪¿╪º╪▒/┌»╪▒┘ê┘ç╪î dropdown┘ç╪º ╪»╪▒ ┘ü╪º┌⌐╪¬┘ê╪▒╪î ╪«╪▒█î╪»╪î ┘╛╪▒╪¬╪º┘ä╪î ╪│╪º╪«╪¬ ╪│╪▒█î╪╣ ┌⌐╪º┘ä╪º ┘ê ΓÇª ╪¿╪º█î╪» ┘╛╪▒ ╪┤┘ê┘å╪».

### 2026-07-22 ΓÇö ╪¬┌⌐┘à█î┘ä ╪┤┌⌐╪º┘üΓÇî┘ç╪º█î ╪º╪│┘╛┌⌐ ┘╛┘ê╪▒╪¬╪º┘ä ┌⌐╪º╪▒┘à┘å╪»╪º┘å v2.0
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `b77549d`
- **╪«┘ä╪º╪╡┘ç:** ╪▒┘à╪▓ ┘à┘ê┘é╪¬ ╪¬╪╡╪º╪»┘ü█î + SMS ┘ç┘å┌»╪º┘à ╪│╪º╪«╪¬ ┌⌐╪º╪▒╪¿╪▒ ┘à╪»█î╪▒╪¢ ╪│╪¬┘ê┘å `review_requested_at` ┘ê cron ╪│╪º╪╣╪¬█î auto-approve ╪¿╪º╪▓╪¿█î┘å█î (┘╛█î╪┤ΓÇî┘ü╪▒╪╢ █╖█▓h)╪¢ ╪¬╪¿╪»█î┘ä ╪¿╪º `product_name` ΓåÆ ┌⌐╪º┘ä╪º█î `approval_status=pending` + ╪¬╪ú█î█î╪» ╪º╪»┘à█î┘å╪¢ ┘ü█î┘ä╪¬╪▒ ┌⌐╪º┘ä╪º┘ç╪º█î pending ╪º╪▓ ┌⌐╪º╪¬╪º┘ä┘ê┌» ┘ü╪▒┘ê╪┤╪¢ ╪▒┘ü╪╣ ╪º┘å╪¬┘é╪º┘ä ┌⌐╪º┘ä╪º ╪¿█î┘å ╪¿╪«╪┤ΓÇî┘ç╪º ┘╛╪│ ╪º╪▓ ╪¬╪¿╪»█î┘ä╪¢ ╪¬╪│╪¬ E2E ┌⌐╪º┘à┘ä ╪»╪▒ `test-portal.js` (█╡█╡ assertion)╪¢ Help + SPEC status╪¢ ┘é╪º┘å┘ê┘å auto commit/deploy╪¢ SW v58
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `lib/portal-schema.js`, `lib/portal-users.js`, `lib/portal-jobs.js`, `routes/portal.js`, `routes/products.js`, `server.js`, `public/portal-ui.js`, `public/index.html`, `public/sw.js`, `scripts/test-portal.js`, `docs/PORTAL-KARMANDAN-SPEC.md`, `.cursor/rules/auto-commit-deploy.mdc`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `b77549d` ΓÇö `git pull` + `pm2 restart erp-taranom` (online) ┬╖ health/root 200 ┬╖ SW `v58`
- **█î╪º╪»╪»╪º╪┤╪¬:** `node server/scripts/test-portal.js` ╪│╪¿╪▓ (█╡█╡/█╡█╡)

### 2026-07-21 ΓÇö ╪¬┌⌐┘à█î┘ä UI┘ç╪º█î ╪¼╪º ┘à╪º┘å╪»┘ç (┘╛╪▒╪¬╪º┘ä + ╪¬╪╖╪¿█î┘é/╪¿┘ê╪»╪¼┘ç + ┘ê╪º┌»╪░╪º╪▒█î)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `600e98c` (docs `1f1b09c`)
- **╪«┘ä╪º╪╡┘ç:** ┘ä█î╪│╪¬ ╪º┘à┌⌐╪º┘å╪º╪¬/┘ê╪╕╪º█î┘ü ╪»┘╛╪º╪▒╪¬┘à╪º┘å╪¢ ┘ê╪º┌»╪░╪º╪▒█î ┘à┘ê┘é╪¬ ┘à╪»█î╪▒ ╪¿╪«╪┤ + ╪¼╪»┘ê┘ä `op_dept_delegations` (╪│█î┘å┌⌐ APPEND)╪¢ ╪º╪╣┘ä╪º┘å ╪▓┘å┌»┘ê┘ä┘ç ╪¿╪▒╪º█î unit/dept manager╪¢ SMS ╪º╪«╪¬█î╪º╪▒█î ╪▒┘ê█î ╪▒┘ê█î╪»╪º╪» ┘╛╪▒╪¬╪º┘ä╪¢ ╪▒╪»█î┘ü/╪¬╪╖╪¿█î┘é ┘à╪║╪º█î╪▒╪¬ ╪¿╪º┘å┌⌐█î╪¢ ┘ê█î╪▒╪º█î╪┤ ╪▒╪»█î┘ü ╪¿┘ê╪»╪¼┘ç╪¢ ┘ü█î┘ä╪¬╪▒ ╪º╪┤╪«╪º╪╡/╪º┘å╪¿╪º╪▒ ┘ê╪º╪¡╪»╪¢ ┘ê╪º┌»╪░╪º╪▒█î ┌å┌⌐ ╪¿╪º select ╪¿╪º┘å┌⌐╪¢ SW v57
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `portal-ui.js`, `routes/portal.js`, `portal-schema.js`, `sync/tables.js`, `index.html`, `sw.js`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `1f1b09c` / health 200 / SW v57

---

### 2026-07-21 ΓÇö UI ┌⌐╪º┘à┘ä ┘ê╪º╪¡╪» ╪╣┘à┘ä█î╪º╪¬█î / ╪»┘╛╪º╪▒╪¬┘à╪º┘å / ┘╛╪º╪▒╪º┘à╪¬╪▒ ┘╛╪▒╪¬╪º┘ä
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `2df35ac`
- **╪«┘ä╪º╪╡┘ç:** ┘ü╪▒┘à ┘ê╪º╪¡╪» ╪¿╪º ┘à╪│╪ª┘ê┘ä █▒ΓÇô█│╪î ╪º╪┤╪«╪º╪╡ ╪»╪▒ ╪¼╪▒█î╪º┘å╪î ┘å┘ê╪╣ ╪«╪▒┘ê╪¼█î╪î ╪º╪¬╪╡╪º┘ä╪º╪¬ ┘à╪º┌ÿ┘ê┘ä╪¢ ╪º┘ü╪▓┘ê╪»┘å/┘ê█î╪▒╪º█î╪┤/╪¼╪º╪¿╪¼╪º█î█î ╪»┘╛╪º╪▒╪¬┘à╪º┘å╪¢ ┘╛╪º╪▒╪º┘à╪¬╪▒ ╪¿╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐╪º┘ä╪º╪¢ module_links ╪»╪▒ API╪¢ SW v56
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `portal-ui.js`, `routes/portal.js`, `sw.js`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å health 200 / SW v56

---

- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `37cfaf0`
- **╪«┘ä╪º╪╡┘ç:** ╪¼╪º█î┌»╪▓█î┘å█î prompt ┘╛┘ê╪▒╪¬╪º┘ä ╪¿╪º ┘à┘ê╪»╪º┘ä╪¢ ╪»╪▒█î╪º┘ü╪¬ ╪º╪▒╪▓█î ╪¿╪º ┘å╪▒╪« ╪«┘ê╪»┌⌐╪º╪▒ ┘ê ╪½╪¿╪¬ fx_rate_rial╪¢ ┘ü█î┘ä╪» costing_method ╪▒┘ê█î ┌⌐╪º┘ä╪º╪¢ █î┌⌐┘å┘ê╪º╪«╪¬ΓÇî╪│╪º╪▓█î ╪¿╪▒┌å╪│╪¿ ┬½┌⌐╪º┘ä╪º┬╗╪¢ SW v55
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `portal-ui.js`, `accounting.js`, `products.js`, `index.html`, `sw.js`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å health 200 / SW v55

---

- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `147efa2`
- **╪«┘ä╪º╪╡┘ç:** ╪¿╪º╪▒┌»╪░╪º╪▒█î ╪º┘ê┘ä█î┘ç lazy╪¢ ╪¬┘ê╪╢█î╪¡╪º╪¬ ╪▒╪»█î┘ü ╪»╪▒ ┌å╪º┘╛ ┘ü╪º┌⌐╪¬┘ê╪▒╪¢ ╪¬╪«┘ü█î┘ü ┘¬Γåö┘à╪¿┘ä╪║ ╪»┘ê╪╖╪▒┘ü┘ç (╪▒╪»█î┘ü+┌⌐┘ä) ┘ê ╪¼┘à╪╣ ╪¬╪«┘ü█î┘ü ╪▒╪»█î┘üΓÇî┘ç╪º╪¢ ╪º┘å╪¿╪º╪▒┌»╪▒╪»╪º┘å█î █│ ╪┤┘à╪º╪▒╪┤+╪¬┌»╪¢ ╪»╪▒█î╪º┘ü╪¬ ╪¿╪º ┘ê╪º╪▒█î╪▓ ╪¿╪º┘å┌⌐█î╪¢ ╪»╪│╪¬┘ç ┘ç╪▓█î┘å┘ç ╪│┘ä╪│┘ä┘çΓÇî┘à╪▒╪º╪¬╪¿█î╪¢ ╪│┘à╪¬/╪¼╪º█î┌»╪º┘ç╪¢ ┘╛┘ê╪▒╪¬╪º┘ä (┘╛╪▒╪»╪º╪«╪¬ ╪»╪▒ ╪º┘å╪¬╪╕╪º╪▒ ╪¡╪│╪º╪¿╪»╪º╪▒█î╪î ┘ç╪▓█î┘å┘ç ╪«╪▒┘ê╪¼█î╪î ╪º┘à┌⌐╪º┘å╪º╪¬/┘ê╪╕╪º█î┘ü) + ╪¼╪»╪º┘ê┘ä ╪│█î┘å┌⌐ APPEND╪¢ ┘å╪▒╪« ╪º╪▒╪▓ live ╪º╪▓ tgju
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `sw.js`, `portal-ui.js`, `acc-nav.js`, `routes/invoices.js`, `purchases.js`, `accounting.js`, `portal.js`, `lib/portal-schema.js`, `lib/fx-rate.js`, `sync/tables.js`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `b04a062` / health 200 / SW v54
- **█î╪º╪»╪»╪º╪┤╪¬:** `SYNCABLE_TABLES` ┘ü┘é╪╖ append ΓÇö ╪¼╪»╪º┘ê┘ä `op_dept_*` / `op_parameter_extra_costs` / `op_field_followups` / `expense_categories`

---

## ╪¬╪º╪▒█î╪«┌å┘ç

### █▒█┤█░█╡/█░█┤/█│█░ ΓÇö [Cursor] UI ╪º┘é┘ä╪º┘à ┘ü╪º┌⌐╪¬┘ê╪▒ ┘ü╪▒┘ê╪┤/╪«╪▒█î╪» (╪¼╪»┘ê┘ä ╪¡╪▒┘ü┘çΓÇî╪º█î)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `ae87c36`
- **╪«┘ä╪º╪╡┘ç:** ╪¿╪«╪┤ ╪º┘é┘ä╪º┘à ┘ü╪º┌⌐╪¬┘ê╪▒ ┘ü╪▒┘ê╪┤ ~█│├ù ╪¿╪▓╪▒┌»ΓÇî╪¬╪▒ ╪¿╪º ╪¼╪»┘ê┘ä ╪»╪º╪▒╪º█î ╪│╪▒╪│╪¬┘ê┘å (┌⌐╪º┘ä╪º/╪¬╪╣╪»╪º╪»/┘ü█î/╪¬╪«┘ü█î┘ü/╪º┘å╪¿╪º╪▒/╪¼┘à╪╣)╪¢ ┘ç┘à╪º┘å ╪º┘ä┌»┘ê ┘ê ╪º┘à┌⌐╪º┘å╪º╪¬ ┘ç┘àΓÇî╪¬╪▒╪º╪▓ ╪▒┘ê█î ┘ü╪º┌⌐╪¬┘ê╪▒ ╪«╪▒█î╪» (╪¬╪«┘ü█î┘ü ╪▒╪»█î┘ü╪î ╪¬┘ê╪╢█î╪¡╪º╪¬╪î ╪º┘å╪¿╪º╪▒ ┘à┘é╪╡╪»╪î ┘ü█î┘ä╪»┘ç╪º█î ┌å┌⌐╪î ╪¿╪º╪▒┌⌐╪»╪î ╪¼┘à╪╣ ╪▓┘å╪»┘ç ┌⌐╪▒╪º█î┘ç). ╪¿┌⌐ΓÇî╪º┘å╪» ╪«╪▒█î╪»: ╪░╪«█î╪▒┘ç ┌å┌⌐ + ╪º┘å╪¿╪º╪▒ per-row.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/routes/purchases.js`, `docs/CHANGE-LOG.md`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `ae87c36` ΓÇö PM2 online ┬╖ root 200

### █▒█┤█░█╡/█░█┤/█│█░ ΓÇö [Cursor] ╪º╪¼╪▒╪º█î ┌⌐╪º┘à┘ä ╪┤┌⌐╪º┘ü ╪¡╪│╪º╪¿╪»╪º╪▒█î + ┘╛╪▒╪¬╪º┘ä ┌⌐╪º╪▒┘à┘å╪»╪º┘å (╪¿╪º ╪│█î┘å┌⌐)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `e5713fa`
- **╪«┘ä╪º╪╡┘ç:** ╪º╪╣┘à╪º┘ä ╪»┘ê ╪»╪│╪¬┘ê╪▒ Desktop (`updte hesabdari.md` / `PORTALKARMANDANSPEC.md`) ╪▒┘ê█î ┌⌐╪» ┘ê╪º┘é╪╣█î ╪¿╪º ╪º┘ä╪▓╪º┘à offline-sync:
  - **┘╛╪▒╪¬╪º┘ä:** ╪¼╪»╪º┘ê┘ä `op_*` + RBAC ┘å┘é╪┤ΓÇî┘ç╪º█î `unit_manager`/`department_manager` + `routes/portal.js` (┘ê╪º╪¡╪»/╪¿╪«╪┤/┘╛╪º╪▒╪º┘à╪¬╪▒╪î ┘é┘ü┘ä ╪¬╪▒╪¬█î╪¿█î╪î ╪º┘å╪¬┘é╪º┘ä ╪º┘å╪¿╪º╪▒╪î ┘╛╪▒╪»╪º╪«╪¬ΓåÆ╪│┘å╪»╪î ╪¬╪¿╪»█î┘äΓåÆproduction_run) + UI `portal-ui.js` + ╪│╪º╪«╪¬ ╪«┘ê╪»┌⌐╪º╪▒ ┌⌐╪º╪▒╪¿╪▒ (`ensurePersonUser` + `must_change_password`).
  - **╪┤┌⌐╪º┘ü ╪¡╪│╪º╪¿╪»╪º╪▒█î ┘ü╪º╪▓█▒ΓÇô█┤:** ┘ü█î┘ä╪»┘ç╪º█î ┘à┘ê╪»█î╪º┘å (`moadian_invoice_type`, `tax_stuff_id`)╪î ┌»╪▓╪º╪▒╪┤ VAT ┘ü╪╡┘ä█î ┘ê ┘à╪º╪»┘ç █▒█╢█╣╪î ╪¼╪▒█î╪º┘å ┘å┘é╪» ╪│┘çΓÇî╪¿╪«╪┤█î╪î ╪º┘å╪»┘ê╪«╪¬┘ç ┘é╪º┘å┘ê┘å█î / ╪░╪«█î╪▒┘ç ┘à.┘à / NRV╪î ┘à╪║╪º█î╪▒╪¬ ╪¿╪º┘å┌⌐█î╪î ┌å╪▒╪«┘ç ┌å┌⌐ (┘ê╪º┌»╪░╪º╪▒█î/┘ê╪╡┘ê┘ä/╪¿╪▒┌»╪┤╪¬)╪î ╪º╪│╪¬┘ç┘ä╪º┌⌐ ┘å╪▓┘ê┘ä█î + ┘ê╪º┌»╪░╪º╪▒█î ╪»╪º╪▒╪º█î█î╪î ╪░╪«█î╪▒┘ç ┘à╪º┘ç╪º┘å┘ç ╪│┘å┘ê╪º╪¬/╪╣█î╪»█î╪î ╪¿┘ê╪»╪¼┘çΓÇî╪¿┘å╪»█î + ┘å╪│╪¿╪¬ΓÇî┘ç╪º/KPI.
  - **╪│█î┘å┌⌐:** ╪¼╪»╪º┘ê┘ä ╪¼╪»█î╪» ┘ü┘é╪╖ ╪¿┘ç **╪º┘å╪¬┘ç╪º█î** `SYNCABLE_TABLES` + FK_COLUMNS + `capture.js` path map╪¢ ┘╛█î┌⌐╪▒╪¿┘å╪»█î ┘ê╪º╪¡╪»/╪¿╪«╪┤ `centralOnly`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `lib/portal-schema.js`, `lib/gap-accounting-schema.js`, `routes/portal.js`, `routes/bank-reconciliation.js`, `routes/budgeting.js`, `routes/reserves.js`, `sync/tables.js`, `sync/capture.js`, `coa-map.js`, `rbac.js`, `portal-ui.js`, `acc-nav.js`, `index.html`, `scripts/test-portal.js`, `scripts/test-accounting-gap.js`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `e5713fa` ΓÇö `git pull` + `pm2 restart erp-taranom` (online) ┬╖ root HTTP 200 ┬╖ mount `/api/portal`
- **╪¬╪│╪¬:** `test-portal` 22 ┬╖ `test-accounting-gap` 18 ┬╖ `test-update11-schema` ┬╖ `test-sms` 22 ┬╖ `test-sync` 33 ΓÇö ┘ç┘à┘ç ╪│╪¿╪▓
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪º╪▒╪│╪º┘ä ┘ê╪º┘é╪╣█î SDK ┘à┘ê╪»█î╪º┘å ┘ç┘å┘ê╪▓ ╪ó╪»╪º┘╛╪¬╪▒ stub/┘é╪º╪¿┘äΓÇî╪¬╪╣┘ê█î╪╢ ╪º╪│╪¬ (╪╡┘ü + ╪º┘å┘ê╪º╪╣ ╪╡┘ê╪▒╪¬╪¡╪│╪º╪¿ + ┘ü█î┘ä╪»┘ç╪º ╪ó┘à╪º╪»┘ç). ╪¿┌⌐╪º┘╛ DB ┘é╪¿┘ä ╪º╪▓ restart: `server/backups/crm-pre-portal-gap-root.bin`.

### █▒█┤█░█╡/█░█┤/█│█░ ΓÇö [Cursor] ╪▒┘ü╪╣ ┘ç┘à┌»╪º┘àΓÇî╪│╪º╪▓█î ╪º┘å╪»╪▒┘ê█î╪»Γåö╪│╪▒┘ê╪▒ ╪º█î╪▒╪º┘å (2.0.19)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `246e8a3`
- **╪«┘ä╪º╪╡┘ç:** ╪╣┘ä╪¬ ╪º╪╡┘ä█î ╪▒┘ê█î ╪º┘å╪»╪▒┘ê█î╪»: `network_security_config` ┘ü┘é╪╖ IP ┘é╪»█î┘à█î ╪ó┘ä┘à╪º┘å (`45.90.98.99`) ╪▒╪º ╪¿╪▒╪º█î HTTP ┘à╪¼╪º╪▓ ┘à█îΓÇî┌⌐╪▒╪» ┘ê URL ┘╛█î╪┤ΓÇî┘ü╪▒╪╢ pairing ┘ç┘à╪º┘å ╪¿┘ê╪» ΓÇö ╪│╪▒┘ê╪▒ ┘ü╪╣┘ä█î ╪º█î╪▒╪º┘å (`94.249.244.208` / `erp.poshaktaranom.com`) ╪¿┘ä╪º┌⌐ █î╪º ╪º╪┤╪¬╪¿╪º┘ç ╪¿┘ê╪». ┘ç┘à┌å┘å█î┘å overflow ╪┤┘å╪º╪│┘ç ┘à┘ê┘é╪¬ ╪¿╪▒╪º█î ╪¼╪»╪º┘ê┘ä Update 11 (╪º█î┘å╪»┌⌐╪│ ΓëÑ100)╪î `sync_seq_backfill_v2` ╪¿╪▒╪º█î seed┘ç╪º█î ╪¿█îΓÇîseq╪î ┘ê PATH/FK/id ┘å╪▒╪« ╪º╪▒╪▓ ╪¿╪▒╪º█î capture.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `network_security_config.xml`, `sync/tables.js`, `sync/capture.js`, `db.js`, `fx-rate.js`, `index.html`, `build.gradle`
- **Deploy:** Γ£à ╪│╪▒┘ê╪▒ ╪º█î╪▒╪º┘å `43019e4` (PM2 online╪î health 200) ┬╖ ΓÅ│ ┘å╪╡╪¿ APK ┘à╪¡┘ä█î █▓.█░.█▒█╣ ╪▒┘ê█î ┌»┘ê╪┤█î

### █▒█┤█░█╡/█░█┤/█│█░ ΓÇö [Cursor] ╪º┘å╪»╪▒┘ê█î╪» 2.0.18 + ┘ä╪║┘ê ┌⌐╪º┘à┘ä import ┘à╪¡┌⌐
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `426733c`
- **╪«┘ä╪º╪╡┘ç:**
  - **┘ä╪║┘ê import ┘à╪¡┌⌐:** `server/lib/mahak-import.js` ┘ü┘é╪╖ stub ┘ä╪║┘ê╪¢ ╪º╪│┌⌐╪▒█î┘╛╪¬ΓÇî┘ç╪º/xlsx ┘à╪¡┌⌐ ╪º╪▓ APK ╪¡╪░┘ü╪¢ ╪¿╪»┘ê┘å `MAHAK_IMPORT_DIR` ╪▒┘ê█î ╪º┘å╪»╪▒┘ê█î╪».
  - **╪º┘å╪»╪▒┘ê█î╪» █▓.█░.█▒█╕:** dlopen SQLite ╪º╪▓ `nativeLibraryDir`╪î `preloadSqliteNative`╪î TMPDIR ┘é╪º╪¿┘äΓÇî┘å┘ê╪┤╪¬┘å ╪»╪▒ dataDir╪î ┘╛┌å thirty-two╪î exclude ╪¬╪│╪¬/xlsx╪î adm-zip ╪¿╪▒╪º█î backup╪î MDI taskbar spacing╪î SW v52.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `android/**`, `scripts/build-android.ps1`, `scripts/test-android-apk.ps1`, `server/lib/mahak-import.js`, `manifest.json`, `mdi.js`, `sw.js`
- **Deploy:** ΓÅ│ APK ┘à╪¡┘ä█î █▓.█░.█▒█╕ ΓÇö ┘å╪╡╪¿ ┘ü┘é╪╖ ╪º╪▓ ┘ü╪º█î┘ä ┘à╪¡┘ä█î

### █▒█┤█░█╡/█░█┤/█│█░ ΓÇö [Cursor] Update 11 ΓÇö ╪¡╪│╪º╪¿╪»╪º╪▒█î/╪¬┘ê┘ä█î╪»/╪º┘å╪¿╪º╪▒ + ╪│█î┘å┌⌐ ╪¼╪»╪º┘ê┘ä ╪¼╪»█î╪»
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `69d2171`
- **╪«┘ä╪º╪╡┘ç:** ╪º╪╣┘à╪º┘ä ╪º╪│┘╛┌⌐ Update 11: ╪▒┘ü╪╣ ┘å╪º┘╛╪»█î╪» ╪┤╪»┘å ┌»╪▒┘ê┘çΓÇî┘ç╪º█î ┌⌐╪º┘ä╪º (B1)╪î ╪¼╪»╪º╪│╪º╪▓█î ╪¬╪¿ ┘╛█î╪┤ΓÇî┘ü╪º┌⌐╪¬┘ê╪▒/┘ü╪º┌⌐╪¬┘ê╪▒ ╪▒╪│┘à█î (B2)╪î round3 ╪º╪╣╪┤╪º╪▒╪î ╪º╪▒╪▓/┘å╪▒╪« (`/api/fx`)╪î ╪¬┘ü╪╡█î┘ä█î█▓ (╪º╪▓ UI ╪¬╪º `postToLedger`/`createJournalEntry`)╪î ╪│┘à╪¬ ╪º╪┤╪«╪º╪╡╪î pricing_rules╪î ┘ü╪º┌⌐╪¬┘ê╪▒ (╪¬┘ê╪╢█î╪¡╪º╪¬/╪¬╪«┘ü█î┘ü ┘à╪¿┘ä╪║█î/╪│╪▒╪┤┌⌐┘å/╪»╪▒╪ó┘à╪»)╪î ╪º┘å╪¿╪º╪▒ ┘à┘å┘ü█î ┘ê costing╪î ╪º┘å╪¿╪º╪▒┌»╪▒╪»╪º┘å█î ╪│┘çΓÇî╪┤┘à╪º╪▒╪┤█î╪î ╪»╪º╪┤╪¿┘ê╪▒╪» ╪¡╪│╪º╪¿╪î suggest-child COA╪î ╪¼╪│╪¬╪¼┘ê█î omnibox ╪¿╪º ╪¿╪º╪▓ ┌⌐╪▒╪»┘å ┌»╪▒┘ê┘ç ┌⌐╪º┘ä╪º (P5)╪î ╪│┘ê╪▒╪¬/┘ü█î┘ä╪¬╪▒ ╪╣┘à┘ê┘à█î ╪¼╪»╪º┘ê┘ä (P4). ╪¼╪»╪º┘ê┘ä ╪¼╪»█î╪» ╪»╪▒ ╪º┘å╪¬┘ç╪º█î `sync/tables.js`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/update11-schema.js`, `server/lib/round3.js`, `server/lib/fx-rate.js`, `server/lib/ledger.js`, `server/routes/fx.js`, `server/routes/pricing-rules.js`, `server/routes/invoices.js`, `server/routes/product-categories.js`, `server/routes/search.js`, `server/sync/tables.js`, `server/public/index.html`, `server/public/acc-nav.js`, `server/public/tbl-enhance.js`
- **Deploy:** ΓÅ│ ┘å█î╪º╪▓ ╪¿┘ç pull
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪¬╪│╪╣█î╪▒ ┘╛╪º█î╪º┘åΓÇî╪»┘ê╪▒┘ç (coa_fx_gain/loss) ┌⌐┘ä█î╪» COA ╪ó┘à╪º╪»┘ç ╪º╪│╪¬╪¢ UI ╪¬╪│╪╣█î╪▒ ┌⌐╪º┘à┘ä ┘ü╪º╪▓ ╪¿╪╣╪». ┘é╪¿┘ä ╪º╪▓ production ╪▒┘ê█î DB ╪▓┘å╪»┘ç ╪¿┌⌐╪º┘╛ ╪¿┌»█î╪▒█î╪» (D1). ╪¬╪│╪¬ΓÇî┘ç╪º: `test-update11-schema` + `test-sync` (33) + `test-sms` (22) ╪│╪¿╪▓.

### █▒█┤█░█╡/█░█┤/█│█░ ΓÇö [Claude Code] ≡ƒô¥ ╪º╪│┘╛┌⌐ ╪¼╪º┘à╪╣ ╪¿┘ç╪¿┘ê╪» ╪¡╪│╪º╪¿╪»╪º╪▒█î/╪¬┘ê┘ä█î╪»/╪º┘å╪¿╪º╪▒ (█▓█│ ┘à┘ê╪▒╪» ┘à╪º┘ä┌⌐) ╪¿╪▒╪º█î Cursor
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ┘ç┘à█î┘å ┌⌐╪º┘à█î╪¬
- **╪«┘ä╪º╪╡┘ç:** ╪¿╪│╪¬┘ç┘ö █▓█│┘à┘ê╪▒╪»█î┘É ╪º╪╡┘ä╪º╪¡╪º╪¬/┘é╪º╪¿┘ä█î╪¬ΓÇî┘ç╪º█î ┘à╪º┘ä┌⌐ ╪▒╪º ╪¿┘ç█î┘å┘ç╪î ┌⌐╪º┘à┘ä ┘ê ╪º╪╡┘ê┘ä█î ┌⌐╪▒╪»┘à (╪¿╪▒ ┘à╪¿┘å╪º█î ┌⌐╪» ┘ê╪º┘é╪╣█î + ╪º╪│╪¬╪º┘å╪»╪º╪▒╪»┘ç╪º█î ╪¡╪│╪º╪¿╪»╪º╪▒█î) ┘ê ╪»╪▒ `docs/ACCOUNTING-IMPROVEMENTS-SPEC.md` ╪¿╪▒╪º█î ╪º╪¼╪▒╪º█î Cursor ┌»╪░╪º╪┤╪¬┘à. **┘ü┘é╪╖ ╪│┘å╪» ╪╖╪▒╪¡ ╪º╪¼╪▒╪º╪¢ ┌⌐╪»█î ╪¬╪║█î█î╪▒ ┘å┌⌐╪▒╪».**
  - **╪»┘ê ╪¿╪º┌» ╪¿╪º ╪▒█î╪┤┘ç┘ö ┘╛█î╪»╪º╪┤╪»┘ç:** (B1) ┘å╪º┘╛╪»█î╪»╪┤╪»┘å ┌»╪▒┘ê┘çΓÇî┘ç╪º█î ┌⌐╪º┘ä╪º ΓÇö ╪╣┘ä╪¬: `addProductGroupVisibility`/┘ü█î┘ä╪¬╪▒ `is_shared/created_by` ╪º╪«█î╪▒┘É Cursor╪î ╪¿╪▒╪º█î ┌⌐╪º╪▒╪¿╪▒ ╪║█î╪▒ admin/accounting ┌»╪▒┘ê┘çΓÇî┘ç╪º ╪▒╪º ┘à╪«┘ü█î ┘à█îΓÇî┌⌐┘å╪»╪¢ ╪▒╪º┘çΓÇî╪¡┘ä: ┌»╪▒┘ê┘çΓÇî┘ç╪º ╪▒╪º ╪│╪▒╪º╪│╪▒█î/╪¿╪▒┌å╪│╪¿ ┌»╪▓╪º╪▒╪┤█î ┌⌐┘å + backfill `is_shared=1`. (B2) ┘å┘à╪º█î╪┤ ┘ü╪º┌⌐╪¬┘ê╪▒ ╪▒╪│┘à█î ╪»╪▒ ┘ü┘ç╪▒╪│╪¬ ┘╛█î╪┤ΓÇî┘ü╪º┌⌐╪¬┘ê╪▒ ΓÇö ╪▒┘ü╪╣ ┘ü█î┘ä╪¬╪▒ `type`.
  - **╪º╪▒╪¬┘é╪º█î ┘à╪»┘ä ╪»╪º╪»┘ç:** ┘à┘ê╪¼┘ê╪»█î ╪º╪╣╪┤╪º╪▒█î ╪¬╪º █│ ╪▒┘é┘à (INTEGERΓåÆREAL + parseFloat)╪î ╪╡┘å╪»┘ê┘é/╪¿╪º┘å┌⌐ ╪º╪▒╪▓█î + ┘å╪▒╪« ╪º╪▒╪▓ ┘à╪▒╪¼╪╣ + ╪¬╪│╪╣█î╪▒ (╪º╪│╪¬╪º┘å╪»╪º╪▒╪» █▒█╢)╪î ╪¬┘ü╪╡█î┘ä█î ╪│╪╖╪¡ ╪»┘ê╪î ┌⌐╪»█î┘å┌» ╪│┘ä╪│┘ä┘çΓÇî┘à╪▒╪º╪¬╪¿█î ┘é╪º╪¿┘äΓÇî╪▒┘ç┌»█î╪▒█î.
  - **┌⌐╪º┘ä╪º/┘ü╪º┌⌐╪¬┘ê╪▒/╪º┘å╪¿╪º╪▒/╪«╪▓╪º┘å┘ç:** ┌»╪▒┘ê┘çΓÇî┘ç╪º ╪¿┘çΓÇî╪╣┘å┘ê╪º┘å ╪¿╪▒┌å╪│╪¿ ┌»╪▓╪º╪▒╪┤█î╪î ┬½╪│┘à╪¬/╪¼╪º█î┌»╪º┘ç┬╗ ╪¼╪»█î╪»╪î ┬½┘à╪¡╪╡┘ê┘ä ╪¼╪»█î╪»┬╗ΓåÆ┬½┌⌐╪º┘ä╪º█î ╪¼╪»█î╪»┬╗╪î ┘ü█î┘ä╪¬╪▒/╪│┘ê╪▒╪¬ ┘ç┘à┘ç┘ö ╪│╪¬┘ê┘åΓÇî┘ç╪º╪î ╪¬┘ê╪╢█î╪¡ per-╪▒╪»█î┘ü ┘ü╪º┌⌐╪¬┘ê╪▒╪î ╪¬╪«┘ü█î┘ü ┘à╪¿┘ä╪║█î per-╪▒╪»█î┘ü╪î ╪│╪▒╪┤┌⌐┘å ┘ç╪▓█î┘å┘ç (allocation)╪î ╪º┘ü╪▓┘ê╪»┘å ╪»╪▒╪ó┘à╪» ╪»╪▒ ┘ü╪º┌⌐╪¬┘ê╪▒╪î ┘à┘ê╪¼┘ê╪»█î ┘à┘å┘ü█î per-╪º┘å╪¿╪º╪▒╪î ╪│╪╖╪¡ ╪▒█î╪º┘ä█îΓÇî┌⌐╪▒╪»┘å (╪º┘å╪¿╪º╪▒/┌⌐╪º┘ä╪º)╪î ╪»╪▒█î╪º┘ü╪¬ = ┘╛╪▒╪»╪º╪«╪¬╪î ╪▒╪»█î┘ü ┌å┌⌐╪î ┘ç╪▓█î┘å┘ç ╪¿╪º ┘à╪╣█î┘å/┌⌐┘ä╪î ╪¼╪│╪¬╪¼┘ê+╪»╪º╪┤╪¿┘ê╪▒╪» ╪»┘ü╪¬╪▒ ┌⌐┘ä╪î ╪│┘çΓÇî╪┤┘à╪º╪▒╪┤█î┘É ╪º┘å╪¿╪º╪▒┌»╪▒╪»╪º┘å█î + ╪¬┌»╪î ┘é█î┘à╪¬ΓÇî┌»╪░╪º╪▒█î ╪«┘ê╪»┌⌐╪º╪▒ ╪¬┘ê┘ä█î╪» (╪¿┘ç╪ºΓåÆ╪╣┘à╪»┘ç/╪¬┌⌐ ╪¿╪º ┘ü╪▒┘à┘ê┘ä).
  - ┘å┘é╪┤┘ç┘ö ╪▒╪º┘ç █╖ ┘ü╪º╪▓█î + ┘ç╪┤╪»╪º╪▒ ┘à┘ç╪º╪¼╪▒╪¬ INTEGERΓåÆREAL ╪▒┘ê█î DB ╪▓┘å╪»┘ç┘ö ┘à╪¡┌⌐ + ┌⌐┘ä█î╪»┘ç╪º█î coa ╪¼╪»█î╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `docs/ACCOUNTING-IMPROVEMENTS-SPEC.md`
- **Deploy:** ΓÇö (┘ü┘é╪╖ ╪│┘å╪»).

### █▒█┤█░█╡/█░█┤/█│█░ ΓÇö [Claude Code] ≡ƒñû ╪º╪│┌⌐█î┘ä ╪│╪º╪«╪¬/╪╣█î╪¿ΓÇî█î╪º╪¿█î APK ╪º┘å╪»╪▒┘ê█î╪» ╪¿╪▒╪º█î Cursor (┘à┘å╪╖╪¿┘é ╪¿╪▒ nodejs-mobile ┘ê╪º┘é╪╣█î)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ┘ç┘à█î┘å ┌⌐╪º┘à█î╪¬
- **╪«┘ä╪º╪╡┘ç:** ┘à╪º┘ä┌⌐ █î┌⌐ ╪▒╪º┘ç┘å┘à╪º█î ┌ÿ┘å╪▒█î┌⌐ ┬½╪│╪º╪«╪¬ APK ╪¿╪º Cursor┬╗ (┘ü╪▒╪╢ Kotlin/Jetpack Compose/Hilt/Room/Retrofit/Gradle-KTS/multi-module) ╪»╪º╪» ┌⌐┘ç ┌⌐╪º┘à┘ä╪º┘ï ╪¿╪º ╪º┘å╪»╪▒┘ê█î╪» ╪º█î┘å ┘╛╪▒┘ê┌ÿ┘ç ┘å╪º╪│╪º╪▓┌»╪º╪▒ ╪º╪│╪¬. ╪ó┘å ╪▒╪º ╪¿┘ç `docs/skills/android-apk-taranom.md` ╪¬╪¿╪»█î┘ä ┌⌐╪▒╪»┘à ΓÇö ┘à┘å╪╖╪¿┘é ╪¿╪▒ ┘à╪╣┘à╪º╪▒█î ┘ê╪º┘é╪╣█î. **┘ü┘é╪╖ ╪º╪│┌⌐█î┘ä/╪│┘å╪»╪¢ ┘ç█î┌å ┌⌐╪»█î ╪¬╪║█î█î╪▒ ┘å┌⌐╪▒╪».**
  - ╪¬┘ê╪╡█î┘çΓÇî┘ç╪º█î ┘å█î╪¬█î┘ê ╪«┘å╪½█î ╪┤╪»: ╪º┘å╪»╪▒┘ê█î╪» ╪¬╪▒┘å┘à **WebView + nodejs-mobile** ╪º╪│╪¬ (╪│╪▒┘ê╪▒ `server/` ╪▒┘ê█î ┌»┘ê╪┤█î ╪¿╪º `SYNC_ROLE=device`)╪î `MainActivity.java` + WebView╪î ╪»█î╪¬╪º╪¿█î╪│ **better-sqlite3 (NDK)**╪î **Groovy** Gradle ΓÇö ┘å┘ç Compose/Kotlin/Room/Hilt.
  - ┘ê╪º┘é╪╣█î╪¬ΓÇî┘ç╪º ┘à╪│╪¬┘å╪» ╪┤╪»: `ir.taranom.crm`╪î versionCode 15/2.0.13╪î compileSdk 36/target 34/min 24╪î ndk 25.1╪î ABIs arm64/armv7/x86_64╪î ╪º┘à╪╢╪º ╪º╪▓ `keystore.properties` (╪«╪º╪▒╪¼ git).
  - **╪¿╪º┌»ΓÇî┘ç╪º█î ┘ê╪º┘é╪╣█î┘É ╪½╪¿╪¬ΓÇî╪┤╪»┘ç ┘ê ╪▒┘ü╪╣╪┤╪º┘å**: BOM ╪»╪▒ local.properties (WriteAllText ╪¿╪»┘ê┘å BOM)╪î Duplicate resources ╪º╪▓ `.gz/.br` (╪¡╪░┘ü ┘é╪¿┘ä ╪¿█î┘ä╪»)╪î nested 300MB APK (╪«╪º╪▒╪¼ΓÇî┌⌐╪▒╪»┘å APK ┘é╪¿┘ä█î)╪î ╪╡┘ü╪¡┘ç┘ö ╪│┘ü█î╪» ╪¿┘ê╪¬ (poll █▒█░ ╪»┘é█î┘é┘çΓÇî╪º█î)╪î ┌⌐╪▒╪┤ `process.exit` (2.0.12)╪î `dlopen` V8/RTLD_GLOBAL better-sqlite3 (2.0.13)╪î ps1 ┘ü┘é╪╖ ASCII╪î ╪¬╪ú█î█î╪» ELF.
  - ╪│█î╪º╪│╪¬ ╪│╪º╪«╪¬/╪¬┘ê╪▓█î╪╣: ┘ü┘é╪╖ `scripts/build-android.ps1`╪¢ APK ╪¿┘ç `releases/` ┘à╪¡┘ä█î╪î **┘ç╪▒┌»╪▓ scp ╪¿┘ç production**╪¢ APK ╪»╪▒ git ┘å┘ç.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `docs/skills/android-apk-taranom.md`
- **Deploy:** ΓÇö (┘ü┘é╪╖ ╪º╪│┌⌐█î┘ä/╪│┘å╪»).

### █▒█┤█░█╡/█░█┤/█│█░ ΓÇö [Claude Code] ≡ƒÄ¿ ╪º╪│┌⌐█î┘ä ╪╖╪▒╪º╪¡█î UI ╪¿╪▒╪º█î Cursor (┘à┘å╪╖╪¿┘é ╪¿╪▒ ╪¬┌⌐ΓÇî┘ü╪º█î┘ä/RTL/╪¬┘à ┘╛╪▒┘ê┌ÿ┘ç)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ┘ç┘à█î┘å ┌⌐╪º┘à█î╪¬
- **╪«┘ä╪º╪╡┘ç:** ┘à╪º┘ä┌⌐ █î┌⌐ ╪▒╪º┘ç┘å┘à╪º█î ┌ÿ┘å╪▒█î┌⌐ ┬½prompt ╪╖╪▒╪º╪¡█î ╪¿╪º Cursor┬╗ (┘ü╪▒╪╢ React/Tailwind/Storybook/Material You) ╪»╪º╪». ╪ó┘å ╪▒╪º ╪¬╪¡┘ä█î┘ä ┘ê **╪¿┘ç █î┌⌐ ╪º╪│┌⌐█î┘ä ╪╖╪▒╪º╪¡█î ┘à┘å╪╖╪¿┘é ╪¿╪▒ ┘à╪╣┘à╪º╪▒█î ┘ê╪º┘é╪╣█î ┘╛╪▒┘ê┌ÿ┘ç** ╪¬╪¿╪»█î┘ä ┌⌐╪▒╪»┘à: `docs/skills/ui-design-taranom.md`. **┘ü┘é╪╖ ╪│┘å╪»/╪º╪│┌⌐█î┘ä ╪º╪│╪¬╪¢ ┘ç█î┌å ┌⌐╪»█î ╪¬╪║█î█î╪▒ ┘å┌⌐╪▒╪».**
  - ╪¬┘ê╪╡█î┘çΓÇî┘ç╪º█î ┘å╪º╪│╪º╪▓┌»╪º╪▒ ╪«┘å╪½█î ╪┤╪» (╪¿╪»┘ê┘å React/Tailwind/Storybook/CDN ┘ü┘ê┘å╪¬ ΓÇö ┌å┘ê┘å ╪º┘╛ **╪¬┌⌐ΓÇî┘ü╪º█î┘ä vanilla╪î RTL╪î ╪ó┘ü┘ä╪º█î┘åΓÇî┘ü╪▒╪│╪¬** ╪º╪│╪¬).
  - **╪¬┘ê┌⌐┘åΓÇî┘ç╪º█î ┘ê╪º┘é╪╣█î ╪¬┘à** (╪▓┘à╪▒╪» ┘à╪»╪▒┘å ╪▒┘ê╪┤┘å + ╪┤╪¿ ┘à╪«┘à┘ä█î ╪¬╪º╪▒█î┌⌐) ╪º╪▓ `index.html` ╪º╪│╪¬╪«╪▒╪º╪¼ ┘ê ┘à╪│╪¬┘å╪» ╪┤╪» ╪¬╪º Cursor ╪▒┘å┌» hardcode ┘å┌⌐┘å╪» ┘ê ╪º╪▓ `:root` ╪º╪│╪¬┘ü╪º╪»┘ç ┌⌐┘å╪».
  - ╪º┘ä┌»┘ê┘ç╪º█î ┘à┘ê╪¼┘ê╪» ┘à╪│╪¬┘å╪» ╪┤╪» (`.btn`, `.overlay`+`openModal`, ╪¼╪»┘ê┘ä `--th-bg/--row-hover`, `.badge` ╪¿╪º ╪¼┘ü╪¬ΓÇî╪¬┘ê┌⌐┘å ┘ê╪╢╪╣█î╪¬, `toast`, `fmt`, `toEnDigits`, `ROUTES`/`acc-nav`/`loadAccTab`) + ┘é┘ê╪º╪╣╪» RTL/┌å╪º┘╛/╪»╪│╪¬╪▒╪│ΓÇî┘╛╪░█î╪▒█î/╪▒█î╪│┘╛╪º┘å╪│█î┘ê + IIFE-wrap + ╪º┘ä╪▓╪º┘à Help/CHANGE-LOG/╪¬╪│╪¬.
  - ┘é╪º┘ä╪¿ ╪¿╪▒█î┘ü ╪│╪º╪«╪¬╪º╪▒█î╪º┘ü╪¬┘ç + Chain-of-Thought + ╪¡┘ä┘é┘ç┘ö ╪¿┘ç╪¿┘ê╪» + ┘å┘à┘ê┘å┘ç┘ö ┘╛╪▒╪º┘à┘╛╪¬ ╪ó┘à╪º╪»┘ç (╪¬╪¿ ┘à╪║╪º█î╪▒╪¬ ╪¿╪º┘å┌⌐█î) ╪¿╪▒╪º█î Cursor.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `docs/skills/ui-design-taranom.md`
- **Deploy:** ΓÇö (┘ü┘é╪╖ ╪º╪│┌⌐█î┘ä/╪│┘å╪»).

### █▒█┤█░█╡/█░█┤/█│█░ ΓÇö [Claude Code] ≡ƒôè ╪¬╪¡┘ä█î┘ä ╪┤┌⌐╪º┘ü ╪¡╪│╪º╪¿╪»╪º╪▒█î ╪»╪▒ ╪¿╪▒╪º╪¿╪▒ █╣ ╪º╪│╪¬╪º┘å╪»╪º╪▒╪» ╪¡╪│╪º╪¿╪»╪º╪▒█î ╪º█î╪▒╪º┘å (╪│┘å╪» ╪¿╪▒╪º█î Cursor)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ┘ç┘à█î┘å ┌⌐╪º┘à█î╪¬
- **╪«┘ä╪º╪╡┘ç:** ╪¿╪▒┘å╪º┘à┘ç ╪▒╪º ╪¿╪º █╣ ╪¡┘ê╪▓┘ç┘ö ╪¬╪«╪╡╪╡█î ╪¡╪│╪º╪¿╪»╪º╪▒█î ╪º█î╪▒╪º┘å (╪╣┘à┘ê┘à█î/┘à╪º┘ä█î/╪º┘å╪¿╪º╪▒/╪«╪▓╪º┘å┘ç/┘ü╪▒┘ê╪┤/╪¡┘é┘ê┘é/╪»╪º╪▒╪º█î█î ╪½╪º╪¿╪¬/╪¿┘ç╪º█î ╪¬┘à╪º┘àΓÇî╪┤╪»┘ç/╪¿┘ê╪»╪¼┘ç) ┘à╪╖╪º╪¿┘é╪¬ ╪»╪º╪»┘à ┘ê ╪┤┌⌐╪º┘üΓÇî┘ç╪º ╪▒╪º ╪»╪▒ `docs/ACCOUNTING-GAP-ANALYSIS.md` ╪¿╪▒╪º█î ╪º╪¼╪▒╪º█î Cursor ┌»╪░╪º╪┤╪¬┘à. **┘ü┘é╪╖ ╪│┘å╪» ╪¬╪¡┘ä█î┘ä ╪º╪│╪¬╪¢ ┘ç█î┌å ┌⌐╪»█î ╪¬╪║█î█î╪▒ ┘å┌⌐╪▒╪».**
  - **█î╪º┘ü╪¬┘ç┘ö ┌⌐┘ä█î╪»█î:** ┘╛╪º█î┘ç┘ö ╪»┘ü╪¬╪▒╪»╪º╪▒█î ╪»┘ê╪╖╪▒┘ü┘ç╪î ┌⌐╪»█î┘å┌» ┘à╪¡┌⌐╪î ╪º╪▒╪▓█î╪º╪¿█î ┘à┘ê╪¼┘ê╪»█î (FIFO/┘à█î╪º┘å┌»█î┘å/┘ê█î┌ÿ┘ç)╪î ╪¿┘ç╪º█î ╪¬┘à╪º┘àΓÇî╪┤╪»┘ç┘ö ╪¬┘ê┘ä█î╪» ┘ê ┘╛┘ä┌⌐╪º┘å ┘à╪º┘ä█î╪º╪¬ ╪¡┘é┘ê┘é **┘é┘ê█î ┘ê ┘à┘ê╪¼┘ê╪»** ╪º╪│╪¬╪¢ ┘ê ┘ä╪º█î┘ç┘ö `coa-map` ╪¿█î╪┤╪¬╪▒ ╪¡╪│╪º╪¿ΓÇî┘ç╪º█î ┘ä╪º╪▓┘à ╪▒╪º ╪º╪▓ ┘é╪¿┘ä ╪»╪º╪▒╪».
  - **╪┤┌⌐╪º┘üΓÇî┘ç╪º█î ╪º╪╡┘ä█î (╪º┘ê┘ä┘ê█î╪¬ΓÇî╪¿┘å╪»█îΓÇî╪┤╪»┘ç):** ≡ƒö┤ ╪º┘å╪╖╪¿╪º┘é ┘à╪º┘ä█î╪º╪¬█î ΓÇö ╪│╪º┘à╪º┘å┘ç ┘à┘ê╪»█î╪º┘å ┘ê╪º┘é╪╣█î + ╪º┘å┘ê╪º╪╣ ╪╡┘ê╪▒╪¬╪¡╪│╪º╪¿ █▒/█▓/█│ + ╪┤┘å╪º╪│┘ç┘ö ┌⌐╪º┘ä╪º + ╪º╪╕┘ç╪º╪▒┘å╪º┘à┘ç┘ö ┘ü╪╡┘ä█î ╪º╪▒╪▓╪┤ ╪º┘ü╪▓┘ê╪»┘ç + ┘à╪º╪»┘ç █▒█╢█╣ (┘ü╪╣┘ä╪º┘ï moadian ┘ü┘é╪╖ mock ╪º╪│╪¬)╪¢ ≡ƒƒá ╪╡┘ê╪▒╪¬ΓÇî┘ç╪º█î ┘à╪º┘ä█î ΓÇö ╪¼╪▒█î╪º┘å ┘ê╪¼┘ê┘ç ┘å┘é╪» ╪│┘çΓÇî╪¿╪«╪┤█î╪î ╪º┘å╪»┘ê╪«╪¬┘ç┘ö ┘é╪º┘å┘ê┘å█î █╡┘¬╪î ╪░╪«█î╪▒┘ç┘ö ┘à╪╖╪º┘ä╪¿╪º╪¬ ┘à╪┤┌⌐┘ê┌⌐ΓÇî╪º┘ä┘ê╪╡┘ê┘ä╪î ╪░╪«█î╪▒┘ç┘ö ┌⌐╪º┘ç╪┤ ╪º╪▒╪▓╪┤ ┘à┘ê╪¼┘ê╪»█î (NRV)╪¢ ≡ƒƒá ╪«╪▓╪º┘å┘ç ΓÇö ╪╡┘ê╪▒╪¬ ┘à╪║╪º█î╪▒╪¬ ╪¿╪º┘å┌⌐█î + ┌å╪▒╪«┘ç┘ö ┌⌐╪º┘à┘ä ┌å┌⌐ (╪»╪▒ ╪¼╪▒█î╪º┘å ┘ê╪╡┘ê┘ä/╪¿╪▒┌»╪┤╪¬)╪¢ ≡ƒƒá ╪»╪º╪▒╪º█î█î ╪½╪º╪¿╪¬ ΓÇö ╪º╪│╪¬┘ç┘ä╪º┌⌐ ┘å╪▓┘ê┘ä█î + ┘ê╪º┌»╪░╪º╪▒█î/╪º╪│┘é╪º╪╖ + ╪¬╪¼╪»█î╪» ╪º╪▒╪▓█î╪º╪¿█î╪¢ ≡ƒƒá ╪¡┘é┘ê┘é ΓÇö ╪░╪«█î╪▒┘ç┘ö ┘à╪º┘ç╪º┘å┘ç┘ö ╪│┘å┘ê╪º╪¬/╪╣█î╪»█î + ┘à╪▓╪º█î╪º█î ╪º┘ä╪▓╪º┘à█î + ╪╢╪▒╪º█î╪¿ ╪º╪╢╪º┘ü┘çΓÇî┌⌐╪º╪▒█î/╪┤╪¿ΓÇî┌⌐╪º╪▒█î╪¢ ≡ƒƒó ┘à╪º┌ÿ┘ê┘ä ╪¿┘ê╪»╪¼┘ç/┌»╪▓╪º╪▒╪┤ ┘à╪»█î╪▒█î╪¬█î/┘å╪│╪¿╪¬ΓÇî┘ç╪º█î ┘à╪º┘ä█î (╪¬┘é╪▒█î╪¿╪º┘ï ╪║╪º█î╪¿).
  - ┘å┘é╪┤┘ç┘ö ╪▒╪º┘ç █┤ ┘ü╪º╪▓█î + ┌⌐┘ä█î╪»┘ç╪º█î coa ╪¼╪»█î╪» ┘╛█î╪┤┘å┘ç╪º╪»█î (`coa_cheques_in_collection`, `coa_legal_reserve`, `coa_doubtful_debts`, `coa_inventory_writedown`, `coa_revaluation_surplus`) ╪»╪▒ ╪│┘å╪» ╪ó┘à╪»┘ç.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `docs/ACCOUNTING-GAP-ANALYSIS.md`
- **Deploy:** ΓÇö (┘ü┘é╪╖ ╪│┘å╪»).

### █▒█┤█░█╡/█░█┤/█│█░ ΓÇö [Claude Code] ≡ƒôï ╪º╪│┘╛┌⌐┘É ┘à┘å╪╖╪¿┘éΓÇî╪┤╪»┘ç┘ö ┬½┘╛╪▒╪¬╪º┘ä ┌⌐╪º╪▒┘à┘å╪»╪º┘å ┘ê ╪«╪╖ ╪¬┘ê┘ä█î╪»┬╗ ╪¿╪▒╪º█î ╪º╪¼╪▒╪º ╪¬┘ê╪│╪╖ Cursor
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ┘ç┘à█î┘å ┌⌐╪º┘à█î╪¬
- **╪«┘ä╪º╪╡┘ç:** ┘à╪º┘ä┌⌐ █î┌⌐ ╪º╪│┘╛┌⌐ ┌ÿ┘å╪▒█î┌⌐ ERP (┘╛╪▒╪¬╪º┘ä ┘ê╪º╪¡╪» ╪╣┘à┘ä█î╪º╪¬█î/╪«╪╖ ╪¬┘ê┘ä█î╪» ╪¿╪º ┌»╪▒╪»╪┤ΓÇî┌⌐╪º╪▒ ╪¬╪▒╪¬█î╪¿█î ┘╛╪º╪▒╪º┘à╪¬╪▒ ╪¿█î┘å ╪¿╪«╪┤ΓÇî┘ç╪º╪î ╪│╪º╪«╪¬ ╪«┘ê╪»┌⌐╪º╪▒ ┌⌐╪º╪▒╪¿╪▒╪î ╪│┘å╪» ╪¬┘ê┘ä█î╪»/╪¡╪│╪º╪¿╪»╪º╪▒█î ╪«┘ê╪»┌⌐╪º╪▒) ╪»╪º╪» ┌⌐┘ç ┘ü╪▒╪╢ΓÇî┘ç╪º█î ┘å╪º╪│╪º╪▓┌»╪º╪▒ ╪¿╪º ┘╛╪▒┘ê┌ÿ┘ç ╪»╪º╪┤╪¬ (UUID╪î PostgreSQL╪î Prisma╪î NestJS/React╪î WebSocket╪î ╪¼╪»┘ê┘ä ┌⌐╪º╪▒╪¿╪▒ ╪¼╪»╪º╪î timestamp ISO). ╪ó┘å ╪▒╪º **╪¿╪º╪▓┘å┘ê█î╪│█î ┘ê ┘à┘å╪╖╪¿┘é ╪¿╪▒ ┘à╪╣┘à╪º╪▒█î ┘ê╪º┘é╪╣█î** ┌⌐╪▒╪»┘à ┘ê ╪»╪▒ `docs/PORTAL-KARMANDAN-SPEC.md` ┌»╪░╪º╪┤╪¬┘à ╪¬╪º Cursor ╪º╪¼╪▒╪º ┌⌐┘å╪». **╪º█î┘å ╪│┘å╪» ╪╡╪▒┘ü╪º┘ï ╪╖╪▒╪¡ ╪º╪¼╪▒╪º ╪º╪│╪¬╪¢ ┘ç█î┌å ┌⌐╪»█î ╪º╪▓ ╪º█î┘å ┘à╪º┌ÿ┘ê┘ä ┘ç┘å┘ê╪▓ ┘╛█î╪º╪»┘ç ┘å╪┤╪»┘ç.**
  - ╪º╪╡┘ä╪º╪¡█î┘çΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î: better-sqlite3 ╪¿┘çΓÇî╪¼╪º█î PostgreSQL/Prisma╪¢ INTEGER PK + ╪¿╪º╪▓┘ç┘ö id ╪»╪│╪¬┌»╪º┘ç ╪¿┘çΓÇî╪¼╪º█î UUID╪¢ ╪º╪│╪¬┘ü╪º╪»┘ç┘ö ┘à╪¼╪»╪» ╪º╪▓ `users`+`must_change_password` ╪¿┘çΓÇî╪¼╪º█î ╪¼╪»┘ê┘ä ┌⌐╪º╪▒╪¿╪▒ ╪¼╪»█î╪»╪¢ ╪▒█î╪º┘ä ╪╡╪¡█î╪¡╪¢ epoch╪¢ ╪º╪╣┘ä╪º┘å/SMS ╪¿┘çΓÇî╪¼╪º█î WebSocket╪¢ ╪º╪│╪¬┘ü╪º╪»┘ç┘ö ┘à╪¼╪»╪» ╪º╪▓ ┘à╪º┌ÿ┘ê┘äΓÇî┘ç╪º█î ┘à┘ê╪¼┘ê╪» ╪¬┘ê┘ä█î╪»/╪º┘å╪¿╪º╪▒(`warehouse_stock`)/╪¡╪│╪º╪¿╪»╪º╪▒█î(`createJournalEntry`+`coa-map`)/followups╪¢ **╪º┘ü╪▓┘ê╪»┘å ╪¼╪»┘ê┘äΓÇî┘ç╪º█î ╪¼╪»█î╪» ╪¿┘ç ╪º┘å╪¬┘ç╪º█î `sync/tables.js` (APPEND-ONLY) ╪¿╪▒╪º█î ╪│╪º╪▓┌»╪º╪▒█î ╪ó┘ü┘ä╪º█î┘å**╪¢ resource ╪¼╪»█î╪» `'portal'` ╪»╪▒ RBAC╪¢ ┘é┘ü┘ä ╪¬╪▒╪¬█î╪¿█î ╪¿╪«╪┤ΓÇî┘ç╪º.
  - ┘à╪»┘ä ╪»╪º╪»┘ç ┘╛█î╪┤┘å┘ç╪º╪»█î: `op_units`, `op_unit_warehouses`, `op_unit_persons`, `op_departments`, `op_parameters`, `op_parameter_items`, `op_parameter_dept_log` (SQL ┌⌐╪º┘à┘ä ╪»╪▒ ╪│┘å╪»).
  - ╪¬╪▒╪¬█î╪¿ ╪º╪¼╪▒╪º█î █▒█▒ ┘à╪▒╪¡┘ä┘çΓÇî╪º█î + Edge Case┘ç╪º + ╪¿╪«╪┤ ╪º┘à┘å█î╪¬ + ╪º┘ä╪▓╪º┘à ╪¬╪│╪¬/Help/CHANGE-LOG ╪¿╪▒╪º█î Cursor ╪»╪▒ ╪│┘å╪» ╪ó┘à╪»┘ç.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `docs/PORTAL-KARMANDAN-SPEC.md`
- **Deploy:** ΓÇö (┘ü┘é╪╖ ╪│┘å╪»╪¢ ╪¿╪»┘ê┘å ╪¬╪║█î█î╪▒ ┌⌐╪»/╪▒┘ü╪¬╪º╪▒).

### █▒█┤█░█╡/█░█┤/█│█░ ΓÇö [Cursor] ╪▒█î╪¿╪▒┘å╪» ┘à╪¡╪╡┘ê┘ä ╪¿┘ç ERP ╪¬╪▒┘å┘à (erp-taranom)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `8563ec8`
- **╪«┘ä╪º╪╡┘ç:** ┘å╪º┘à ┘å┘à╪º█î╪┤█î/┘╛┌⌐█î╪¼/PM2 ╪º╪▓ CRM ╪¬╪▒┘å┘à ╪¿┘ç **ERP ╪¬╪▒┘å┘à / erp-taranom**╪¢ ╪»╪º┘à┘å┘ç `erp.poshaktaranom.com`╪¢ ┘à╪│█î╪▒ ╪»█î╪│┌⌐ ┘ê keystore ╪╣┘à╪»╪º┘ï `crm-taranom` ┘à╪º┘å╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/{index.html,manifest.json,sw.js}`, `server/ecosystem.config.js`, `server/package.json`, `desktop/*`, `android/*/strings.xml`, `docs/*`, `scripts/release.ps1`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å ΓÇö PM2 `erp-taranom`╪î ╪╣┘å┘ê╪º┘å ┘ê PWA ╪¬╪ú█î█î╪» ╪┤╪»
- **█î╪º╪»╪»╪º╪┤╪¬:** ┘╛┘ê╪┤┘ç `/home/taranom/crm-taranom` ┘ê `crm-taranom.jks` ╪╣┘à╪»╪º┘ï ╪¬╪║█î█î╪▒ ┘å┌⌐╪▒╪».

### █▒█┤█░█╡/█░█┤/█│█░ ΓÇö [Cursor] ╪▒┘ü╪╣ dlopen better-sqlite3 ΓÇö ╪º┘å╪»╪▒┘ê█î╪» 2.0.13
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ╪¿╪»┘ê┘å commit
- **╪«┘ä╪º╪╡┘ç:**
  - **╪¿╪º┌» 2.0.12:** `dlopen failed: cannot locate symbol "_ZN2v811HandleScopeC1EPNS_7IsolateE"` ┘ç┘å┌»╪º┘à ┘ä┘ê╪» `better-sqlite3`.
  - **╪▒█î╪┤┘ç:** ╪º┘å╪»╪▒┘ê█î╪» `libnode` ╪▒╪º `RTLD_LOCAL` ╪¿╪º╪▒ ┘à█îΓÇî┌⌐┘å╪»╪¢ ╪¿╪»┘ê┘å `DT_NEEDED=libnode` ┘å┘à╪º╪» V8 ╪»█î╪»┘ç ┘å┘à█îΓÇî╪┤┘ê╪». JNI ╪»╪º╪«┘ä APK ┘ç┘à ┘é╪»█î┘à█îΓÇî╪¬╪▒ ╪º╪▓ prebuilt ╪¿┘ê╪».
  - **╪▒┘ü╪╣:** `promoteNodeSymbols()` / `dlopen(libnode, RTLD_GLOBAL)`╪¢ ┘ç┘à┌»╪º┘àΓÇî╪│╪º╪▓█î jni╪¢ ┘ä█î┘å┌⌐ ╪╡╪▒█î╪¡ ╪»╪▒ ╪º╪│┌⌐╪▒█î┘╛╪¬ ╪¿█î┘ä╪»╪¢ ┘å╪│╪«┘ç **█▓.█░.█▒█│**.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `native-lib.cpp`, `MainActivity.java`, `main.js`, `build.gradle`, `scripts/build-better-sqlite3-android.ps1`
- **Deploy:** ΓÅ│ APK ┘à╪¡┘ä█î

### █▒█┤█░█╡/█░█┤/█│█░ ΓÇö [Cursor] ╪º╪¿╪▓╪º╪▒ ╪¬╪│╪¬ ╪º╪»┘à█î┘å + ┌⌐╪º┘ä╪º┘ç╪º + ┘à╪º┘ä┌⌐█î╪¬ ┘à╪┤╪¬╪▒█î
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `3821d1b`
- **╪«┘ä╪º╪╡┘ç:**
  - ┘╛╪º┌⌐ΓÇî╪│╪º╪▓█î ╪»█î╪¬╪º█î ╪¬╪│╪¬ ╪¿┘ç ╪¬┘ü┌⌐█î┌⌐ ╪¿╪«╪┤ (╪¬╪▒╪º┌⌐┘å╪┤ / ┌⌐╪º┘à┘ä) ╪¿╪º ╪¬╪ú█î█î╪» WIPE-* + ╪▒┘à╪▓ ΓÇö ┘ü┘é╪╖ admin ┘à╪▒┌⌐╪▓█î
  - ┌⌐╪º┘ä╪º┘ç╪º ╪»╪▒ ╪¡╪│╪º╪¿╪»╪º╪▒█î: layout ╪┤╪¿█î┘ç ╪º╪┤╪«╪º╪╡ (┌»╪▒┘ê┘ç ╪▒╪º╪│╪¬╪î ╪¼╪»┘ê┘ä ┌å┘╛) + ╪º┘å╪¬╪«╪º╪¿/╪¡╪░┘ü ┌»╪▒┘ê┘ç█î
  - ERP ┘à╪¡╪╡┘ê┘ä╪º╪¬ ┘ü┘é╪╖ ┘à╪┤╪º┘ç╪»┘ç╪¢ CRUD ┘ü┘é╪╖ ╪º╪▓ ╪¡╪│╪º╪¿╪»╪º╪▒█î (`adminOrAccounting`)
  - ┘à╪º┘ä┌⌐█î╪¬ ┘à╪┤╪¬╪▒█î ╪¿╪º `created_by`╪¢ ┌⌐╪º╪▒╪┤┘å╪º╪│ ╪¬╪«╪╡█î╪╡ΓÇî█î╪º┘ü╪¬┘ç ┘ü┘é╪╖ ┘à╪┤╪º┘ç╪»┘ç (+ ┘╛█î┌»█î╪▒█î/┘ü╪º┌⌐╪¬┘ê╪▒)╪¢ ┘à╪º┘å╪»┘ç ┘ü┘é╪╖ admin
  - ┘å┘à╪º█î╪┤ ┘à╪º┘ç█î╪¬ ┘ê ┘à╪º┘å╪»┘ç ╪▓┘å╪»┘ç ╪»╪▒ ┘ä█î╪│╪¬/┘à┘ê╪»╪º┘ä ERP ┘à╪┤╪¬╪▒█î╪º┘å╪¢ sync `account_nature` ╪º╪▓ parties
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/routes/data-wipe.js`, `server/server.js`, `server/db.js`, `server/routes/customers.js`, `server/routes/parties.js`, `server/routes/products.js`, `server/lib/parties-sync.js`, `server/public/index.html`, `docs/CHANGE-LOG.md`
- **Deploy:** Γ£à SCP ╪▒┘ê█î ╪º█î╪▒╪º┘å + Cloudflare ╪¿╪▒╪º█î `erp.poshaktaranom.com`
- **█î╪º╪»╪»╪º╪┤╪¬:** ┘╛╪│ ╪º╪▓ ╪¿┘ê╪¬╪î `created_by` ╪¿╪▒╪º█î ╪▒┌⌐┘ê╪▒╪»┘ç╪º█î ┘é╪»█î┘à█î ╪º╪▓ `user_id` ┘╛╪▒ ┘à█îΓÇî╪┤┘ê╪».

### █▒█┤█░█╡/█░█┤/█▓█╣ ΓÇö [Cursor] █î┌⌐┘╛╪º╪▒┌å┘çΓÇî╪│╪º╪▓█î ┘à┘ê█î╪▒┌»█î ┘ê╪º╪¡╪» ┘╛┘ê┘ä ╪▒█î╪º┘ä
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ╪¿╪»┘ê┘å commit
- **╪«┘ä╪º╪╡┘ç:** ╪¡╪░┘ü ┘å╪º╪│╪º╪▓┌»╪º╪▒█î ╪¬┘ê┘à╪º┘å/╪▒█î╪º┘ä ╪»╪▒ ┌⌐┘ä CRM ΓÇö UI ┘ê ╪░╪«█î╪▒┘ç ┘ç┘à█î╪┤┘ç ╪▒█î╪º┘ä╪¢ `postToLedger` ┘ç┘à┌å┘å╪º┘å ╪¬┘ê┘à╪º┘å ┘à█îΓÇî┌»█î╪▒╪» (`rial/10` / `rialToLedger`). ╪▒┘ü╪╣ `/10`┘ç╪º█î ┘ü╪▒╪º┘å╪¬ (┘ê╪╡┘ê┘ä╪î ┘ç╪▓█î┘å┘ç╪î ╪¡┘é┘ê┘é╪î ┌⌐╪▒╪º█î┘ç╪î ┘╛╪▒╪»╪º╪«╪¬ ╪¬╪ú┘à█î┘åΓÇî┌⌐┘å┘å╪»┘ç)╪î ╪º╪╡┘ä╪º╪¡ `*_rial` ┘ü╪º┌⌐╪¬┘ê╪▒/╪«╪▒█î╪»╪î JE ╪º┘å╪¬┘é╪º┘ä/┘à╪┤┘ê┘é/╪│┘å╪» ╪»╪│╪¬█î/┘å┘à╪º█î┘å╪»┘ç╪î ┌»╪▓╪º╪▒╪┤ΓÇî┘ç╪º█î ╪»┘ü╪¬╪▒┌⌐┘ä/╪¬╪▒╪º╪▓/╪¬┘ê┘ä█î╪» ╪▒┘ê█î `debit_rial` (╪¿╪»┘ê┘å `debit*10`)╪î ╪¿┌⌐ΓÇî┘ü█î┘ä `journal_rial_backfill_v1`╪î ╪¿╪▒┌å╪│╪¿ΓÇî┘ç╪º ┘ê ╪º╪╣┘ä╪º┘åΓÇî┘ç╪º ╪▒█î╪º┘ä╪î SW `v49`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `lib/money.js`, `db.js`, `routes/invoices.js`, `purchases.js`, `accounting.js`, `expenses.js`, `transfers.js`, `payroll.js`, `rep-management.js`, `lib/production/{close,engine,reports,health-check}.js`, `public/index.html`, `prod-ui.js`, `sw.js`
- **Deploy:** ΓÅ│ ┘å█î╪º╪▓ ╪¿┘ç pull ╪▒┘ê█î ╪º█î╪▒╪º┘å
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪º╪│┘å╪º╪» ┘é╪»█î┘à█î ┌⌐┘ç ╪¿╪º FE `/10` ╪¿╪╣╪» ╪º╪▓ migration ╪½╪¿╪¬ ╪┤╪»┘çΓÇî╪º┘å╪» ┘à┘à┌⌐┘å ╪º╪│╪¬ ┘à┘é█î╪º╪│ ┘å╪º╪»╪▒╪│╪¬ ╪»╪º╪┤╪¬┘ç ╪¿╪º╪┤┘å╪» ΓÇö ╪»╪▒ ╪╡┘ê╪▒╪¬ ┘å█î╪º╪▓ ╪º╪│┌⌐╪▒█î┘╛╪¬ ╪¬╪╖╪¿█î┘é ╪¼╪»╪º┌»╪º┘å┘ç.

### █▒█┤█░█╡/█░█┤/█▓█╣ ΓÇö [Cursor] ╪▒┘ü╪╣ ╪¿╪│╪¬┘ç ╪┤╪»┘å ┘å╪º┌»┘ç╪º┘å█î ╪¿┘ê╪¬ ╪º┘å╪»╪▒┘ê█î╪» 2.0.12
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ╪¿╪»┘ê┘å commit
- **╪«┘ä╪º╪╡┘ç:**
  - ┘╛╪│ ╪º╪▓ splash ┬½╪▒╪º┘çΓÇî╪º┘å╪»╪º╪▓█î ╪│╪▒┘ê╪▒ ╪»╪º╪«┘ä█î┬╗ ╪º┘╛ ┘ü┘ê╪▒╪º┘ï ╪¿╪│╪¬┘ç ┘à█îΓÇî╪┤╪».
  - **╪╣┘ä╪¬:** `process.exit()` ╪»╪▒ bootstrap ╪º┘å╪»╪▒┘ê█î╪» ┌⌐┘ä ┘╛╪▒┘ê╪│┘ç ╪▒╪º ┘à█îΓÇî┌⌐╪┤╪»╪¢ SQLite ┘ü┘é╪╖ ╪º╪▓ assets ┘ä┘ê╪» ┘à█îΓÇî╪┤╪».
  - **╪▒┘ü╪╣:** ┘à╪│╪»┘ê╪» ┌⌐╪▒╪»┘å `process.exit`╪¢ `server.fail` + ┘å┘à╪º█î╪┤ ╪«╪╖╪º╪¢ `libbetter_sqlite3.so` ╪»╪▒ jniLibs╪¢ preload STL/SQLite╪¢ ┘å╪│╪«┘ç **█▓.█░.█▒█▓**.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `main.js`, `MainActivity.java`, `android/app/build.gradle`, `scripts/test-android-apk.ps1`
- **Deploy:** ΓÅ│ APK ┘à╪¡┘ä█î ΓÇö ╪¡╪░┘ü ┘å╪│╪«┘ç ┘é╪¿┘ä█î ┘ê ┘å╪╡╪¿ █▓.█░.█▒█▓

### █▒█┤█░█╡/█░█┤/█▓█╣ ΓÇö [Cursor] ╪¡╪░┘ü/╪º╪¿╪╖╪º┘ä ┌»╪▒┘ê┘ç█î ╪¿╪º ╪º┘å╪¬╪«╪º╪¿ ╪│╪╖╪▒ ╪»╪▒ ┘ä█î╪│╪¬ΓÇî┘ç╪º
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `c264da4` (+ `be64a0d` changelog)
- **╪«┘ä╪º╪╡┘ç:** ╪¿╪º ╪º┘å╪¬╪«╪º╪¿ █î┌⌐ █î╪º ┌å┘å╪» ╪│╪╖╪▒╪î ┘å┘ê╪º╪▒ ┬½╪¡╪░┘ü/╪º╪¿╪╖╪º┘ä ╪º┘å╪¬╪«╪º╪¿ΓÇî╪┤╪»┘çΓÇî┘ç╪º┬╗ ╪╕╪º┘ç╪▒ ┘à█îΓÇî╪┤┘ê╪»╪¢ ╪º╪│╪¬┘å╪¿╪º╪╖ ╪º╪▓ `data-bulk-delete` █î╪º ╪»┌⌐┘à┘ç ┘é╪▒┘à╪▓ ╪▒╪»█î┘ü╪¢ ┘╛┘ê╪┤╪┤ ┘ü╪º┌⌐╪¬┘ê╪▒ CRM╪î ╪º╪┤╪«╪º╪╡╪î ╪«╪▒█î╪»╪î ╪¿╪º┘å┌⌐╪î ╪╡┘å╪»┘ê┘é╪î ╪º┘å╪¿╪º╪▒╪î ╪¿╪▒┌»╪┤╪¬ΓÇî┘ç╪º ┘ê ╪¼╪»╪º┘ê┘ä ╪¡╪│╪º╪¿╪»╪º╪▒█î ┘à╪┤╪º╪¿┘ç.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/tbl-enhance.js`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `94.249.244.208` ΓÇö HEAD=`be64a0d`╪î bundle + pm2╪î health █▓█░█░╪î SW `v48`

### █▒█┤█░█╡/█░█┤/█▓█╣ ΓÇö [Cursor] ╪▒╪» ╪¬┌⌐╪▒╪º╪▒█î ╪º┌⌐╪│┘ä + ╪¬┘å╪╕█î┘à MDI ╪»╪▒ ╪¬┘å╪╕█î┘à╪º╪¬
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `c3a1c73`
- **╪«┘ä╪º╪╡┘ç:** ┘ê╪▒┘ê╪» ╪º┌⌐╪│┘ä ╪º╪┤╪«╪º╪╡/┌⌐╪º┘ä╪º/┌⌐╪»█î┘å┌» ╪¬┌⌐╪▒╪º╪▒█îΓÇî┘ç╪º ╪▒╪º ╪▒╪» ┘à█îΓÇî┌⌐┘å╪» ┘ê ╪¬╪╣╪»╪º╪» ╪▒╪º ╪º╪╣┘ä╪º┘à ┘à█îΓÇî┌⌐┘å╪»╪¢ API ┘ç┘à █┤█░█╣ ╪¿╪▒╪º█î ╪¬┌⌐╪▒╪º╪▒█î ┘à█îΓÇî╪»┘ç╪». ┘ü╪╣╪º┘ä/╪║█î╪▒┘ü╪╣╪º┘ä ┘╛┘å╪¼╪▒┘ç ┌å┘å╪»┌»╪º┘å┘ç ╪»╪▒ ╪¬┘å╪╕█î┘à╪º╪¬ ╪│█î╪│╪¬┘à.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/routes/excel.js`, `parties.js`, `products.js`, `server/public/index.html`, `sw.js`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `94.249.244.208` ΓÇö HEAD=`c3a1c73`╪î bundle + pm2╪î health █▓█░█░╪î SW `v47`

### █▒█┤█░█╡/█░█┤/█▓█╣ ΓÇö [Cursor] ╪▒┘ü╪╣ ╪º┌⌐╪│┘ä ╪▒█î╪º┘ä╪î ╪¼╪│╪¬╪¼┘ê╪î ╪¡╪░┘ü ┌⌐╪º┘ä╪º╪î MDI╪î ╪│┘ê╪▒╪¬/┘ü█î┘ä╪¬╪▒╪î ╪º╪¿╪╖╪º┘ä ╪º╪│┘å╪º╪»
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `e89ebc6` (+ `b017e88` changelog╪î + SW `v46`)
- **╪«┘ä╪º╪╡┘ç:**
  - ╪º┌⌐╪│┘ä ┌⌐╪º┘ä╪º┘ç╪º ╪»█î┌»╪▒ `/10` ┘å┘à█îΓÇî┌⌐┘å╪»╪¢ ╪º╪┤╪«╪º╪╡ ╪│┘é┘ü ╪º╪╣╪¬╪¿╪º╪▒ ╪▒╪º ╪¿┘çΓÇî╪╡┘ê╪▒╪¬ ╪▒█î╪º┘ä ┘å┘à╪º█î╪┤/╪░╪«█î╪▒┘ç ┘à█îΓÇî┌⌐┘å┘å╪»╪¢ ╪▒╪»█î┘üΓÇî┘ç╪º█î ╪«╪º┘ä█î ┘ü█î┘ä╪¬╪▒ ┘ê ┌»╪▓╪º╪▒╪┤ ┘à┘ê┘ü┘é/┘å╪º┘à┘ê┘ü┘é ┘ê╪º╪╢╪¡ΓÇî╪¬╪▒ ╪┤╪».
  - ╪¡╪░┘ü ┌⌐╪º┘ä╪º ┘╛╪│ ╪º╪▓ ┘ê╪▒┘ê╪» ╪º┌⌐╪│┘ä ╪¿╪º ┘╛╪º┌⌐ΓÇî╪│╪º╪▓█î `warehouse_stock`/`stock_logs` ┘ê ╪¼┘ä┘ê┌»█î╪▒█î ╪º╪▓ ╪¡╪░┘ü ╪»╪▒ ╪╡┘ê╪▒╪¬ ╪º╪│╪¬┘ü╪º╪»┘ç ╪»╪▒ ┘ü╪º┌⌐╪¬┘ê╪▒.
  - ╪¼╪│╪¬╪¼┘ê█î ╪º╪┤╪«╪º╪╡: `oninput`+debounce╪î `limit=200`╪î ┘å╪▒┘à╪º┘äΓÇî╪│╪º╪▓█î █î/┌⌐╪¢ F10 ┘ü┘ê┌⌐┘ê╪│ ╪¼╪│╪¬╪¼┘ê.
  - ╪¿╪▒┌»╪┤╪¬ ╪º╪▓ ╪«╪▒█î╪»: ┘à┘ê╪¼┘ê╪»█î ┘é╪º╪¿┘äΓÇî╪¿╪▒┌»╪┤╪¬ ╪»█î┌»╪▒ ╪º╪¿╪╖╪º┘äΓÇî╪┤╪»┘çΓÇî┘ç╪º ╪▒╪º ┘å┘à█îΓÇî╪┤┘à╪º╪▒╪»╪¢ ┘ä█î╪│╪¬ ╪│┘ü╪º╪▒╪┤╪º╪¬ CRUD╪¢ ┘ü╪º┌⌐╪¬┘ê╪▒ ┘ü╪▒┘ê╪┤ ╪¡╪│╪º╪¿╪»╪º╪▒█î ┘ê█î╪▒╪º█î╪┤/╪º╪¿╪╖╪º┘ä ╪¿╪º ╪»╪│╪¬╪▒╪│█î.
  - ╪¼╪»╪º┘ê┘ä: ╪│┘ê╪▒╪¬ ┌⌐┘ä█î┌⌐ ╪▒┘ê█î ╪╣┘å┘ê╪º┘å╪î ┘ü█î┘ä╪¬╪▒ ╪▒╪º╪│╪¬ΓÇî┌⌐┘ä█î┌⌐╪î ╪º┘å╪¬╪«╪º╪¿ ┌å┘å╪»╪¬╪º█î█î╪¢ ┘╛┘å╪¼╪▒┘çΓÇî┘ç╪º█î MDI ╪┤╪¿█î┘ç ┘ê█î┘å╪»┘ê╪▓ ╪¿╪▒╪º█î ╪▓█î╪▒┘à┘å┘ê┘ç╪º█î ╪¡╪│╪º╪¿╪»╪º╪▒█î (`mdi.js`).
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/routes/excel.js`, `products.js`, `parties.js`, `purchases.js`, `accounting.js`, `server/public/index.html`, `mdi.js`, `tbl-enhance.js`, `sw.js`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `94.249.244.208` ΓÇö HEAD=`c42a4d2`╪î bundle + `pm2 restart`╪î health █▓█░█░╪î SW `v46`╪î `mdi.js`/`tbl-enhance.js` ╪¬╪ú█î█î╪» ╪┤╪»
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪¡╪º┘ä╪¬ ┘╛┘å╪¼╪▒┘ç ╪¿╪º ╪»┌⌐┘à┘ç ┘å┘ê╪º╪▒ ┘╛╪º█î█î┘å ╪«╪º┘à┘ê╪┤ ┘à█îΓÇî╪┤┘ê╪» (`localStorage crm_mdi=0`).

### █▒█┤█░█╡/█░█┤/█▓█╣ ΓÇö [Cursor] ╪▒┘ü╪╣ ┌⌐╪▒╪┤ ┘ü┘ê╪▒█î ╪º┘å╪»╪▒┘ê█î╪» 2.0.10 ΓÇö ╪│╪º╪▓┌»╪º╪▒█î ╪╡┘ü╪¡┘ç █▒█╢KB (╪│╪º┘à╪│┘ê┘å┌»)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ╪¿╪»┘ê┘å commit
- **╪«┘ä╪º╪╡┘ç:**
  - **╪▒█î╪┤┘ç┘ö ┌⌐╪▒╪┤:** ╪▒┘ê█î ╪»╪│╪¬┌»╪º┘çΓÇî┘ç╪º█î ╪º┘å╪»╪▒┘ê█î╪» █▒█╡+ ╪¿╪º ╪╡┘ü╪¡┘ç ╪¡╪º┘ü╪╕┘ç █▒█╢KB (┘à╪«╪╡┘ê╪╡╪º┘ï ╪│╪º┘à╪│┘ê┘å┌»)╪î `libnode.so` / `libnative-lib.so` / `better_sqlite3` ╪¿╪º ELF Align=`0x1000` (█┤KB) ╪»╪▒ `dlopen` ┘à█îΓÇî╪¬╪▒┌⌐┘å╪» ΓåÆ ╪»█î╪º┘ä┘ê┌» Device Care ┬½Something went wrong / this app has a bug┬╗.
  - **╪▒┘ü╪╣ ┘ü┘ê╪▒█î:** `android:pageSizeCompat="enabled"` ╪»╪▒ Manifest (╪¡╪º┘ä╪¬ ╪│╪º╪▓┌»╪º╪▒█î ╪│█î╪│╪¬┘à).
  - **╪│╪«╪¬ΓÇî╪│╪º╪▓█î:** `System.loadLibrary` ╪º╪▓ static initializer ╪¿┘ç `onCreate` ╪¿╪º catch ┘à┘å╪¬┘é┘ä ╪┤╪» ╪¬╪º ╪¿┘çΓÇî╪¼╪º█î ╪»█î╪º┘ä┘ê┌» ╪│█î╪│╪¬┘à╪î ╪╡┘ü╪¡┘ç┘ö ╪«╪╖╪º█î ╪»╪º╪«┘ä ╪º┘╛ ┘å╪┤╪º┘å ╪»╪º╪»┘ç ╪┤┘ê╪»╪¢ ┘ä█î┘å┌⌐╪▒ `native-lib` ╪¿╪º `-Wl,-z,max-page-size=16384`╪¢ ┘å╪│╪«┘ç **█▓.█░.█▒█░** / versionCode **█▒█▓**.
  - **█î╪º╪»╪»╪º╪┤╪¬ ╪¿┘ä┘å╪»┘à╪»╪¬:** ┘╛█î╪┤ΓÇî╪│╪º╪«╪¬┘ç┘ö nodejs-mobile ┘ç┘å┘ê╪▓ █┤KB ╪º╪│╪¬ ΓÇö ╪¿╪º╪▓╪│╪º╪▓█î `libnode` ╪¿╪º NDK r28+ ╪»╪▒ ╪ó█î┘å╪»┘ç ┘ä╪º╪▓┘à ╪º╪│╪¬.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `AndroidManifest.xml`, `MainActivity.java`, `CMakeLists.txt`, `main.js`, `android/app/build.gradle`, `manifest.json`, `scripts/test-android-apk.ps1`
- **Deploy:** ΓÅ│ APK ┘à╪¡┘ä█î ΓÇö sideload╪¢ ╪│╪▒┘ê╪▒ APK ╪│╪▒┘ê ┘å┘à█îΓÇî┌⌐┘å╪»
- **█î╪º╪»╪»╪º╪┤╪¬ ┘å╪╡╪¿:** ┘å╪│╪«┘ç ┘é╪¿┘ä█î ╪▒╪º ╪¡╪░┘ü ┌⌐┘å█î╪» ┘ê `erp-taranom.apk` ┘å╪│╪«┘ç █▓.█░.█▒█░ ╪▒╪º ╪¬╪º╪▓┘ç ┘å╪╡╪¿ ┌⌐┘å█î╪».

### █▒█┤█░█╡/█░█┤/█▓█╣ ΓÇö [Cursor] ╪º┌⌐╪│┘ä ┘à█î┘å█î┘à╪º┘ä╪î ╪»█î╪» ┌»╪▒┘ê┘ç ┌⌐╪º┘ä╪º╪î ┌⌐╪º╪▒╪¿╪▒=╪┤╪«╪╡╪î █î┌⌐┘╛╪º╪▒┌å┘çΓÇî╪│╪º╪▓█î ╪¡╪│╪º╪¿╪»╪º╪▒█î
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `e393e2d`
- **╪«┘ä╪º╪╡┘ç:** ╪»┌⌐┘à┘çΓÇî┘ç╪º█î ╪º┌⌐╪│┘ä ┘à█î┘å█î┘à╪º┘ä (┘ê╪▒┘ê╪»█î/┘é╪º┘ä╪¿/╪«╪▒┘ê╪¼█î)╪¢ ┘é╪▒╪º╪▒╪»╪º╪» ┌⌐╪º┘à┘ä █▓█░ entity ╪º┌⌐╪│┘ä╪¢ ┌⌐┘å╪¬╪▒┘ä `is_shared` ╪¿╪▒╪º█î ┌»╪▒┘ê┘ç ┌⌐╪º┘ä╪º╪¢ ╪º╪¬╪╡╪º┘ä ┌⌐╪º╪▒╪¿╪▒ ╪¿┘ç `parties`╪¢ ╪¬┘à╪º┘à ╪╣┘à┘ä█î╪º╪¬ ┘à╪º┘ä█î ╪¬╪¼╪º╪▒█î ╪º╪▓ `postToLedger` ╪¿╪º ╪º╪¿╪╖╪º┘ä R12╪¢ ╪º╪╡┘ä╪º╪¡ ╪¬╪¿╪»█î┘ä ╪▒█î╪º┘ä/╪¬┘ê┘à╪º┘å ╪»╪▒ UI.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/routes/excel.js`, `server/lib/user-party.js`, `server/routes/accounting.js`, `server/routes/invoices.js`, `server/routes/purchases.js`, `server/public/index.html`, `server/public/sw.js`, `server/scripts/test-excel-user-integration.js`
- **Deploy:** ΓÅ│ ┘å█î╪º╪▓ ╪¿┘ç pull ╪▒┘ê█î ╪º█î╪▒╪º┘å
- **█î╪º╪»╪»╪º╪┤╪¬:** `test:excel-user-integration`╪î `test:payroll-accounting`╪î `test:inventory` ╪│╪¿╪▓╪¢ SW ╪¿┘ç `v45`.

### █▒█┤█░█╡/█░█┤/█▓█╕ ΓÇö [Cursor] █î┌⌐┘╛╪º╪▒┌å┘çΓÇî╪│╪º╪▓█î ╪¡┘é┘ê┘é ┘ê ┌»╪▓╪º╪▒╪┤╪º╪¬ ┘à╪º┘ä█î ╪º█î╪▒╪º┘å
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `14d2d4b`
- **╪«┘ä╪º╪╡┘ç:** ┘╛╪▒┘ê┘å╪»┘ç ┌⌐╪º╪▒┌⌐┘å╪º┘å ╪▒┘ê█î ╪¼╪»┘ê┘ä ╪º╪┤╪«╪º╪╡ ┘à┘ê╪¼┘ê╪» ╪º╪»╪║╪º┘à ╪┤╪»╪¢ ╪»┘ê╪▒┘ç╪î ╪│╪º╪«╪¬╪º╪▒ ╪¡┘é┘ê┘é╪î ┘╛┘ä┌⌐╪º┘å ┘à╪º╪»┘ç █╕█┤╪î ┘╛╪▒╪»╪º╪▓╪┤ ┘à╪º┘ç╪º┘å┘ç/╪▒┘ê╪▓╪º┘å┘ç/╪│╪º╪╣╪¬█î╪î ╪¿█î┘à┘ç █╖┘¬ ┘ê █▓█│┘¬ ┘╛█î┌⌐╪▒╪¿┘å╪»█îΓÇî┘╛╪░█î╪▒╪î ╪╣█î╪»█î ┘ê ╪│┘å┘ê╪º╪¬╪î ╪º╪│┘å╪º╪» ╪«┘ê╪»┌⌐╪º╪▒ ┘ê ╪º╪¿╪╖╪º┘ä ┘à╪╣┌⌐┘ê╪│ ╪º╪╢╪º┘ü┘ç ╪┤╪». ┌⌐╪»█î┘å┌» ┘ê ╪º╪│┘å╪º╪» ┘à┘ê╪¼┘ê╪» ╪¬┘ê╪│╪╣┘ç █î╪º┘ü╪¬┘å╪» ┘ê VAT╪î ┌»╪▓╪º╪▒╪┤ ┘╛┘ê█î╪º ┘ê ╪¿┘ç╪º█î ╪╡┘å╪╣╪¬█î ╪¿╪»┘ê┘å ╪º█î╪¼╪º╪» ┘à╪»┘ä ┘à┘ê╪º╪▓█î ╪¿┘ç ┌»╪▓╪º╪▒╪┤╪º╪¬ ┘╛█î╪┤╪▒┘ü╪¬┘ç ┘à╪¬╪╡┘ä ╪┤╪»┘å╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/payroll/`, `server/routes/payroll.js`, `server/lib/accounting/reporting-schema.js`, `server/routes/adv-reports.js`, `server/public/acc-nav.js`, `server/public/index.html`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `94.249.244.208` ΓÇö HEAD=`14d2d4b`╪î pm2 restart╪î health █▓█░█░╪î SW `v44`
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪¬┘à╪º┘à ┘╛┘ê┘äΓÇî┘ç╪º█î ╪¼╪»█î╪» `INTEGER` ╪▒█î╪º┘ä ╪º╪│╪¬╪¢ ┘å╪▒╪«ΓÇî┘ç╪º█î ┘é╪º┘å┘ê┘å█î ╪│╪º┘ä╪º┘å┘ç ╪»╪▒ ╪»╪º╪»┘ç ╪░╪«█î╪▒┘ç ┘à█îΓÇî╪┤┘ê┘å╪». `test:payroll-accounting`╪î ┌⌐┘ä `test:production` ┘ê `test:inventory` ╪│╪¿╪▓ ┘ç╪│╪¬┘å╪».

### █▒█┤█░█╡/█░█┤/█▓█╕ ΓÇö [Cursor] ┘ê╪▒┘ê╪»╪î ╪«╪▒┘ê╪¼█î ┘ê ┘é╪º┘ä╪¿ ╪º┌⌐╪│┘ä █î┌⌐┘╛╪º╪▒┌å┘ç
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `8ce2260`
- **╪«┘ä╪º╪╡┘ç:** ╪│┘ç ┌»╪▓█î┘å┘ç ┘à╪│╪¬┘é┘ä ┬½┘ê╪▒┘ê╪» ╪º╪▓ ╪╖╪▒█î┘é ╪º┌⌐╪│┘ä┬╗╪î ┬½┘é╪º┘ä╪¿ ┘ü╪º█î┘ä ┘ê╪▒┘ê╪»█î┬╗ ┘ê ┬½╪«╪▒┘ê╪¼█î ╪º┌⌐╪│┘ä┬╗ ╪¿╪▒╪º█î ╪º╪╖┘ä╪º╪╣╪º╪¬ ╪º╪┤╪«╪º╪╡╪î ┌⌐╪º┘ä╪º┘ç╪º╪î ┌å┌⌐ΓÇî┘ç╪º█î ╪º┘ê┘ä ╪»┘ê╪▒┘ç╪î ╪»╪▒█î╪º┘ü╪¬ ┘ê ┘╛╪▒╪»╪º╪«╪¬╪î ┘ç╪▓█î┘å┘çΓÇî┘ç╪º╪î ╪│╪╖┘ê╪¡ ┌⌐╪»█î┘å┌»╪î ┘ü╪º┌⌐╪¬┘ê╪▒┘ç╪º ┘ê ╪¿╪▒┌»╪┤╪¬ΓÇî┘ç╪º╪î ╪│┘ç ╪╣┘à┘ä█î╪º╪¬ ┘à╪│╪¬┘é┘ä ╪º┘å╪¿╪º╪▒╪î ╪»┘ê ╪¼┘ç╪¬ ┌⌐╪º┘ä╪º█î ╪º┘à╪º┘å█î ┘ê ┘ü┘ç╪▒╪│╪¬ ╪º╪│┘å╪º╪» ╪º╪╢╪º┘ü┘ç ╪┤╪». ┘à╪¿╪º┘ä╪║ ┘ü╪º█î┘äΓÇî┘ç╪º ┘ü┘é╪╖ ╪▒█î╪º┘ä ┘ç╪│╪¬┘å╪» ┘ê ╪½╪¿╪¬ ╪º╪│┘å╪º╪» ╪º╪▓ API ╪▒╪│┘à█î ┘ç╪▒ ┘à╪º┌ÿ┘ê┘ä ╪º┘å╪¼╪º┘à ┘à█îΓÇî╪┤┘ê╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/routes/excel.js`, `server/server.js`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `94.249.244.208` ΓÇö HEAD=`8ce2260`╪î pm2 restart╪î health █▓█░█░╪î SW `v43`
- **█î╪º╪»╪»╪º╪┤╪¬:** █▓█░ ┘é╪▒╪º╪▒╪»╪º╪» ┘à╪│╪¬┘é┘ä╪î █┤█░ ╪»╪º┘å┘ä┘ê╪» ┘é╪º┘ä╪¿/╪«╪▒┘ê╪¼█î╪î █▓█░ ╪º╪╣╪¬╪¿╪º╪▒╪│┘å╪¼█î ┘ü╪º█î┘ä ┘ê ╪½╪¿╪¬ end-to-end ╪¬╪╣╪»╪º╪» █▓█▒ ╪╣┘à┘ä█î╪º╪¬ ╪▒╪│┘à█î ╪▒┘ê█î ╪»█î╪¬╪º╪¿█î╪│ ╪º█î╪▓┘ê┘ä┘ç ╪ó╪▓┘à╪º█î╪┤ ╪┤╪»╪¢ SW ╪¿┘ç `v43` ╪º┘ü╪▓╪º█î╪┤ █î╪º┘ü╪¬.

### █▒█┤█░█╡/█░█┤/█▓█╖ ΓÇö [Cursor] ┘å┘à╪º█î┘å╪»┌»╪º┘å ┘ü╪▒┘ê╪┤ + ┘é┘ê╪º┘å█î┘å █î┌⌐┘╛╪º╪▒┌å┘ç (╪▒█î╪º┘ä / ╪¼╪»╪º┌⌐┘å┘å╪»┘ç / ╪ó█î┌⌐┘ê┘å / AI)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `f509621`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `94.249.244.208` ΓÇö HEAD=`f509621`╪î pm2 restart╪î health █▓█░█░╪î SW `v42`

### █▒█┤█░█╡/█░█┤/█▓█╖ ΓÇö [Cursor] ╪¬┌⌐┘à█î┘ä UI ╪╣┘à┘ä█î╪º╪¬ ╪¬┘ê┘ä█î╪» (BOM + ╪│┘ü╪º╪▒╪┤ + ╪▒┘ü╪╣ ┘å┘é╪╡ΓÇî┘ç╪º)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `e25bfcb` (+ `87ea258` changelog)
- **╪«┘ä╪º╪╡┘ç:**
  - **BOM:** ╪º█î╪¼╪º╪» ┘╛█î╪┤ΓÇî┘å┘ê█î╪│╪î ┘ê█î╪▒╪º█î╪┤ ╪º┘é┘ä╪º┘à╪î ┘ü╪╣╪º┘äΓÇî╪│╪º╪▓█î ╪¿╪º `valid_from`╪î ╪¡╪░┘ü ┘╛█î╪┤ΓÇî┘å┘ê█î╪│╪î ┘å╪│╪«┘ç ╪¼╪»█î╪»╪î ┘ç╪┤╪»╪º╪▒ ┌⌐╪º┘ä╪º┘ç╪º█î ╪¿╪»┘ê┘å BOM.
  - **╪│┘ü╪º╪▒╪┤:** ╪º┘å╪¬╪«╪º╪¿ BOM/╪º┘å╪¿╪º╪▒/┘à╪▒┌⌐╪▓ ┘ç╪▓█î┘å┘ç╪¢ ┘ä╪║┘ê draft/released╪¢ ╪▒╪│█î╪» ╪¼╪▓╪ª█î/┘å┘ç╪º█î█î ╪¿╪º ┘à┘é╪»╪º╪▒ ╪¿╪º┘é█î┘à╪º┘å╪»┘ç╪¢ ╪¡╪░┘ü ╪»╪│╪¬┘à╪▓╪» hard-code╪¢ ╪º╪¿╪╖╪º┘ä ┘ü┘é╪╖ completed + ╪¿╪º╪▓┌»╪┤╪º█î█î closed.
  - **┘å╪▒╪« ╪│╪▒╪¿╪º╪▒:** ┘à╪¡╪▒┌⌐ΓÇî┘ç╪º█î ╪╡╪¡█î╪¡ (`direct_labor_rial` ┘ê ΓÇª)╪¢ ┘ê█î╪▒╪º█î╪┤ ╪▒╪»█î┘ü╪¢ ┘å┘à╪º█î╪┤ ╪»╪│╪¬┘à╪▓╪» ┘à╪º┘ç╪º┘å┘ç.
  - **┘à╪▒╪¡┘ä┘çΓÇî╪º█î:** ╪º┘ä┌»┘ê█î ╪¡┘ê╪º┘ä┘ç ┘à┘ê╪º╪» ┘à╪▒╪¡┘ä┘ç╪¢ ╪«╪▒┘ê╪¼█î ╪¿╪º ┘╛█î╪┤ΓÇî┘ü╪▒╪╢ qty_in╪¢ ┘╛█î┘à╪º┘å┌⌐╪º╪▒ ╪¿╪º dropdown╪¢ ┌⌐╪º╪▒┘à╪▓╪» ╪«╪º┘ä█î = ╪º╪▓ BOM╪¢ skip ┘à╪▒╪¡┘ä┘ç.
  - **╪¿╪│╪¬┘å ╪»┘ê╪▒┘ç:** ╪¿╪»┘ê┘å open ╪«┘ê╪»┌⌐╪º╪▒ ┘ç┘å┌»╪º┘à ╪¿╪º╪▓ ╪┤╪»┘å ╪╡┘ü╪¡┘ç╪¢ ╪»┌⌐┘à┘ç ╪¿╪º╪▓┌»╪┤╪º█î█î╪¢ ┘╛█î╪┤ΓÇî╪¿╪▒╪▒╪│█î ╪º╪«╪¬█î╪º╪▒█î.
  - API: `GET .../stages/:id/issue-template`╪¢ fallback ╪»╪│╪¬┘à╪▓╪» ╪º╪▓ `monthly_labor_rate_rial`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/public/sw.js`, `server/lib/production/labor.js`, `server/lib/production/engine-advanced.js`, `server/routes/production-execution.js`, `docs/CHANGE-LOG.md`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `94.249.244.208` ΓÇö HEAD=`87ea258`╪î pm2 restart╪î health █▓█░█░╪î SW `v41`

### █▒█┤█░█╡/█░█┤/█▓█╖ ΓÇö [Cursor] ┘à╪º┌ÿ┘ê┘ä ╪º┘å╪¿╪º╪▒ ╪│╪º╪▓┘à╪º┘å█î (ledger / batch / reservation / landed cost)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `a0bc2f8`
- **╪«┘ä╪º╪╡┘ç:**
  - ┘ä╪º█î┘ç┘ö `server/lib/inventory/*` + API `/api/inventory` + ┘à┘å┘ê█î ┬½╪╣┘à┘ä█î╪º╪¬ ╪º┘å╪¿╪º╪▒┬╗ (╪¿┌å/╪│╪▒█î╪º┘ä╪î ╪▒╪▓╪▒┘ê╪î landed cost╪î ┌⌐╪º╪▒╪»┌⌐╪│╪î ╪▒╪│█î╪»/╪¡┘ê╪º┘ä┘ç).
  - ╪º┘å╪¿╪º╪▒┌»╪▒╪»╪º┘å█î ┘ê ╪╣┘à┘ä█î╪º╪¬ ╪º┘å╪¿╪º╪▒ ╪¿┘ç ledger ╪¼╪»█î╪» ┘ê╪╡┘ä ╪┤╪»╪¢ ╪¼╪»╪º┘ê┘ä sync APPEND-ONLY.
  - ╪¬╪│╪¬ ╪»┘ê╪»: `node scripts/test-inventory-smoke.js` ΓåÆ **█▓█┤/█▓█┤**.
  - ┘ç┘àΓÇî╪¬╪▒╪º╪▓╪│╪º╪▓█î ┘é╪¿┘ä█î ┘ä┘ê┌⌐╪º┘ä ╪¬╪º `7947c11` + ╪º╪│┌⌐╪▒█î┘╛╪¬ΓÇî┘ç╪º█î ┘à╪¡┌⌐ ┘å┌»┘ç ╪»╪º╪┤╪¬┘ç ╪┤╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/inventory/*`, `server/routes/inventory.js`, `server/routes/warehouses.js`, `server/public/acc-nav.js`, `server/public/index.html`, `server/sync/tables.js`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `94.249.244.208` ΓÇö HEAD=`e7c8ede`╪î pm2 restart╪î health █▓█░█░╪î `lib/inventory/schema.js` + SW `v40`

### █▒█┤█░█╡/█░█┤/█▓█╢ ΓÇö [Cursor] pm2 restart production ╪¿╪▒╪º█î ╪º╪╣┘à╪º┘ä ╪¬╪║█î█î╪▒╪º╪¬ UI
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `d7bee5e` (docs) ΓÇö ┌⌐╪» ╪º╪▓ ┘é╪¿┘ä ╪▒┘ê█î ╪│╪▒┘ê╪▒ ╪»╪▒ `7947c11` ╪¿┘ê╪»
- **╪«┘ä╪º╪╡┘ç:** ╪¿┘ç ╪»╪▒╪«┘ê╪º╪│╪¬ ┘à╪º┘ä┌⌐╪î ╪▒┘ê█î ╪│╪▒┘ê╪▒ ╪º█î╪▒╪º┘å `pm2 restart erp-taranom --update-env` ╪º╪¼╪▒╪º ╪┤╪». health `/api/system/time` ╪│╪¿╪▓╪î ┘ü╪▒╪ó█î┘å╪» online. ┘à╪º╪▒┌⌐╪▒┘ç╪º█î ┌⌐┘ä█î╪»█î ╪»╪▒ ┘ü╪º█î┘ä ┘à╪│╪¬┘é╪▒ ╪¬╪ú█î█î╪» ╪┤╪»: `seedQty`╪î `cheque_row`╪î ┬½╪½╪¿╪¬ ┌å┌⌐ ╪¿╪╣╪»█î┬╗╪î `z-index:3000` ╪¿╪▒╪º█î ╪»█î╪¬ΓÇî┘╛█î┌⌐╪▒.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `docs/CHANGE-LOG.md`
- **Deploy:** Γ£à restart ╪º┘å╪¼╪º┘à ╪┤╪»

### █▒█┤█░█╡/█░█┤/█▓█╖ ΓÇö [Cursor] ┘ç┘àΓÇî╪¬╪▒╪º╪▓╪│╪º╪▓█î ┘ä┘ê┌⌐╪º┘ä + deploy bundle ╪º█î╪▒╪º┘å ╪¬╪º `7947c11`
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `7947c11` (fast-forward ┘ä┘ê┌⌐╪º┘ä ╪º╪▓ `13dbcaf`)
- **╪«┘ä╪º╪╡┘ç:**
  - workspace ┘ä┘ê┌⌐╪º┘ä ╪º╪▓ `13dbcaf` ╪¿┘ç `7947c11` ┘ç┘àΓÇî╪¬╪▒╪º╪▓ ╪┤╪»╪¢ UI ┌å┌⌐ (`stlSyncChequesFromDom` / `oninput` / SW `v39`) ╪▒┘ê█î ╪»█î╪│┌⌐ ┘à╪¡┘ä█î ╪¬╪ú█î█î╪» ╪┤╪».
  - ╪│╪▒┘ê╪▒ ╪º█î╪▒╪º┘å ╪¿╪º **git bundle** ╪º╪▓ `ae016a3` ΓåÆ `7947c11` + `pm2 restart`╪¢ health █▓█░█░.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/public/sw.js`, `docs/CHANGE-LOG.md`
- **Deploy:** Γ£à ╪º█î╪▒╪º┘å `94.249.244.208` ΓÇö HEAD=`7947c11`

### █▒█┤█░█╡/█░█┤/█▓█╖ ΓÇö [Claude Code] ≡ƒÉ₧ ╪▒┘ü╪╣ ╪¿╪º┌» ┘ê╪º┘é╪╣█î ┘å╪º┘ç┘à╪º┘ç┘å┌»█î ┘à┘ê╪¼┘ê╪»█î ╪º┘å╪¿╪º╪▒ (products.stock Γçä warehouse_stock) + ╪¿╪º╪▓╪¿█î┘å█î ┌⌐╪º┘à┘ä ┘╛╪▒┘ê┌ÿ┘ç
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ┘ç┘à█î┘å ┌⌐╪º┘à█î╪¬
- **╪«┘ä╪º╪╡┘ç:**
  - **╪¿╪º┌» ╪º╪╡┘ä█î (╪▒┘ü╪╣ ╪┤╪»):** ┘à╪│█î╪▒ ╪│╪º╪«╪¬ ┘à╪¡╪╡┘ê┘ä `POST /api/products` ┘ç┘å┌»╪º┘à ╪½╪¿╪¬ ┘à╪¡╪╡┘ê┘ä ╪¿╪º ┘à┘ê╪¼┘ê╪»█î ╪º┘ê┘ä█î┘ç╪î **┘ç█î┌å ╪▒╪»█î┘ü `warehouse_stock` ┘å┘à█îΓÇî╪│╪º╪«╪¬** (╪¿╪▒╪«┘ä╪º┘ü `PUT` ┌⌐┘ç ┘à█îΓÇî╪│╪º╪«╪¬). ┌å┘ê┘å ┌⌐╪│╪▒ ┘à┘ê╪¼┘ê╪»█î ┘ü╪º┌⌐╪¬┘ê╪▒ ╪▒╪│┘à█î ╪º╪▓ `warehouse_stock` ┘à█îΓÇî╪«┘ê╪º┘å┘Ä╪»╪î ╪º┘ê┘ä█î┘å ┘ü╪º┌⌐╪¬┘ê╪▒ ╪▒╪»█î┘ü ╪▒╪º ╪¿╪º qty=0 ┘à█îΓÇî╪│╪º╪«╪¬ ┘ê ╪º╪▓ ╪╡┘ü╪▒ ┌⌐┘à ┘à█îΓÇî┌⌐╪▒╪» ΓåÆ `warehouse_stock=0` ╪»╪▒ ╪¡╪º┘ä█î ┌⌐┘ç `products.stock` ┘à┘é╪»╪º╪▒ ┘ê╪º┘é╪╣█î ╪▒╪º ┘å╪┤╪º┘å ┘à█îΓÇî╪»╪º╪» ΓåÆ **┘ç┘à┘ç┘ö ┘ü╪▒┘ê╪┤ΓÇî┘ç╪º█î ╪¿╪╣╪»█î ╪º╪▓ ╪ó┘å ╪º┘å╪¿╪º╪▒ ╪¿╪º ┘╛█î╪º┘à ┬½┘à┘ê╪¼┘ê╪»█î ╪º┘å╪¿╪º╪▒ ┌⌐╪º┘ü█î ┘å█î╪│╪¬ (┘à┘ê╪¼┘ê╪»: █░)┬╗ ╪▒╪» ┘à█îΓÇî╪┤╪».** ╪¡╪º┘ä╪º ┘ç┘å┌»╪º┘à ╪│╪º╪«╪¬╪î ┘à┘ê╪¼┘ê╪»█î ╪º┘ê┘ä█î┘ç ╪»╪▒ ╪º┘å╪¿╪º╪▒ ┘╛█î╪┤ΓÇî┘ü╪▒╪╢ seed ┘à█îΓÇî╪┤┘ê╪».
  - **╪¿╪º┌» ┘ç┘àΓÇî╪«╪º┘å┘ê╪º╪»┘ç (╪▒┘ü╪╣ ╪┤╪»):** `PATCH /products/:id/stock` ┘ü┘é╪╖ `products.stock` ╪▒╪º ╪╣┘ê╪╢ ┘à█îΓÇî┌⌐╪▒╪»╪¢ ╪¡╪º┘ä╪º ┘ç┘à╪º┘å ╪»┘ä╪¬╪º ╪▒┘ê█î `warehouse_stock` ╪º┘å╪¿╪º╪▒┘É ┘à╪¡╪╡┘ê┘ä ┘ç┘à ╪º╪╣┘à╪º┘ä ┘à█îΓÇî╪┤┘ê╪» ╪¬╪º ╪º╪▓ ┘ç┘à ╪¼╪»╪º ┘å█î┘ü╪¬┘å╪».
  - ┘à╪│█î╪▒┘ç╪º█î ╪»╪▒╪│╪¬ (╪¿╪»┘ê┘å ╪¬╪║█î█î╪▒╪î ╪¿╪▒╪▒╪│█î ┘ê ╪¬╪ú█î█î╪» ╪┤╪»): ╪º╪¿╪╖╪º┘ä ┘ü╪º┌⌐╪¬┘ê╪▒╪î ╪º┘å╪¿╪º╪▒┌»╪▒╪»╪º┘å█î╪î ╪«╪▒█î╪»╪î ╪º┘å╪¬┘é╪º┘ä ╪º┘å╪¿╪º╪▒ ΓÇö ┘ç╪▒ ╪»┘ê ╪¼╪»┘ê┘ä ╪▒╪º ┘ç┘à╪º┘ç┘å┌» ┘å┌»┘ç ┘à█îΓÇî╪»╪º╪▒┘å╪».
  - **╪¿╪▒╪▒╪│█î ┌⌐╪º┘à┘ä ┘╛╪▒┘ê┌ÿ┘ç:** `node --check` ╪▒┘ê█î ┘ç┘à┘ç┘ö ┘ü╪º█î┘äΓÇî┘ç╪º█î ╪¿┌⌐ΓÇî╪º┘å╪» ╪│╪¿╪▓╪¢ boot + login ╪│╪º┘ä┘à╪¢ `npm audit` ΓåÆ xlsx@0.18.5 ╪»┘ê ╪ó╪│█î╪¿ΓÇî┘╛╪░█î╪▒█î high ╪¿╪»┘ê┘å patch ╪▒╪│┘à█î (prototype pollution + ReDoS) ┘ê node-cron@3 ┘ê╪º╪¿╪│╪¬┘ç ╪¿┘ç uuid ╪ó╪│█î╪¿ΓÇî┘╛╪░█î╪▒ (moderate) ΓÇö ┌»╪▓╪º╪▒╪┤ ╪¿┘ç ┘à╪º┘ä┌⌐╪î ╪▒┘ü╪╣ ┘å█î╪º╪▓┘à┘å╪» ╪¬╪╡┘à█î┘à (breaking). `mssql` ┘ü┘é╪╖ ╪»╪▒ `lib/mahak-import.js` ╪¿┘çΓÇî╪╡┘ê╪▒╪¬ lazy/optional ╪º╪│╪¬┘ü╪º╪»┘ç ┘à█îΓÇî╪┤┘ê╪».
  - **╪¿╪º┘é█îΓÇî┘à╪º┘å╪»┘ç ╪¿╪▒╪º█î ╪¿╪▒╪▒╪│█î ╪¿╪╣╪»█î (drift ╪º╪¡╪¬┘à╪º┘ä█î ┘à┘ê╪¼┘ê╪»█î╪î ┘ü╪▒┌⌐╪º┘å╪│ ┘╛╪º█î█î┘åΓÇî╪¬╪▒):** `orders.js:maybeDeductStock` (╪│┘ü╪º╪▒╪┤ done)╪î `consignments.js`╪î `production.js`╪î `accounting.js` ╪¬╪╣╪»█î┘ä ┘à┘ê╪¼┘ê╪»█î ΓÇö ┘ç╪▒┌⌐╪»╪º┘à `products.stock` ╪▒╪º ╪¼╪»╪º ╪º╪▓ `warehouse_stock` ╪¬╪║█î█î╪▒ ┘à█îΓÇî╪»┘ç┘å╪»╪¢ ┘å█î╪º╪▓ ╪¿┘ç ┘à┘à█î╪▓█î ┘à┘ê╪▒╪»█î ╪»╪º╪▒┘å╪».
  - **╪¬╪│╪¬:** sync **█│█│/█│█│**╪î SMS **█▓█▓/█▓█▓**╪î ┌⌐┘ä `npm run test:production` **█▒█╕ ╪º╪│┌⌐╪▒█î┘╛╪¬ ╪│╪¿╪▓ (EXIT=0)**. ╪│┘å╪º╪▒█î┘ê█î █╖ sync (oversell) ┌⌐┘ç ┘é╪¿┘ä╪º┘ï ╪¿┘çΓÇî╪«╪º╪╖╪▒ ┘ç┘à█î┘å drift ┘à█îΓÇî╪┤┌⌐╪│╪¬╪î ╪º┌⌐┘å┘ê┘å ╪»╪▒╪│╪¬ ╪¬╪╣╪º╪▒╪╢ ╪▒╪º ┘å╪┤╪º┘å ┘à█îΓÇî╪»┘ç╪».
  - ┘å┌⌐╪¬┘ç┘ö ┘ç┘à╪º┘ç┘å┌»█î: ╪º╪╡┘ä╪º╪¡ stale┘ö ╪¬╪│╪¬ sync ╪¿╪▒╪º█î VAT ╪▒╪º Cursor ╪»╪▒ `e488a30` ╪¿╪º ╪¬╪╖╪¿█î┘é ╪▒┘ê█î `subtotal` (┘à╪│╪¬┘é┘ä ╪º╪▓ VAT) ╪º┘å╪¼╪º┘à ╪»╪º╪»┘ç ╪¿┘ê╪»╪¢ ╪¬╪║█î█î╪▒ ┘à┘ê╪º╪▓█î ┘à┘å revert ╪┤╪» ╪¬╪º ┘╛┘ê╪┤╪┤ VAT+sync ╪¡┘ü╪╕ ╪┤┘ê╪».
  - Help ╪»╪▒ ╪º█î┘å ╪¬╪║█î█î╪▒ ┘å█î╪º╪▓ ╪¿┘ç ╪¿┘çΓÇî╪▒┘ê╪▓╪▒╪│╪º┘å█î ┘å╪»╪º╪▒╪» (╪▒┘ü╪╣ ╪¿╪º┌» ╪»╪º╪«┘ä█î╪î ╪¿╪»┘ê┘å ╪│╪╖╪¡ ┌⌐╪º╪▒╪¿╪▒█î ╪¼╪»█î╪»).
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/routes/products.js`
- **Deploy:** Γ£à ╪¿╪º `pm2 restart` / bundle ╪▒┘ê█î `7947c11` ╪º╪╣┘à╪º┘ä ╪┤╪».

### █▒█┤█░█╡/█░█┤/█▓█╢ ΓÇö [Cursor] ╪¿╪│╪¬┘ç┘ö ╪º╪╡┘ä╪º╪¡╪º╪¬ UI ╪¡╪│╪º╪¿╪»╪º╪▒█î (instructions_7685): ┌å┌⌐╪î ┘à╪¡╪╡┘ê┘ä╪î ╪¼╪│╪¬╪¼┘ê╪î z-index
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `81a96fd` (╪¿┌⌐ΓÇî╪º┘å╪») + `869e9bd` (┘ü╪▒╪º┘å╪¬ΓÇî╪º┘å╪»)
- **╪«┘ä╪º╪╡┘ç:**
  - **╪▒┘ü╪╣ ╪│╪▒╪º╪│╪▒█î z-index (█▓.█│ ┘ê ╪¿╪º┌» █▒.█▒):** ╪¬┘é┘ê█î┘à ╪¼┘ä╪º┘ä█î (`.dp`/`.dp-overlay`) ┘ê ╪¬┘ê╪│╪¬ΓÇî┘ç╪º ╪▓█î╪▒ ┘à┘ê╪»╪º┘ä (█▒█▒█░█░) ╪▒┘å╪»╪▒ ┘à█îΓÇî╪┤╪»┘å╪»╪¢ ╪¿┘ç ╪¿╪º┘ä╪º█î ┘à┘ê╪»╪º┘ä ┘à┘å╪¬┘é┘ä ╪┤╪»┘å╪» (dp=3000╪î toasts=3200). ╪¬╪ú█î█î╪»╪┤╪»┘ç ╪¿╪º ╪¬╪│╪¬ GUI: ╪¬┘é┘ê█î┘à ╪¡╪º┘ä╪º **╪▒┘ê█î** ┘à┘ê╪»╪º┘ä ╪¿╪º╪▓ ┘à█îΓÇî╪┤┘ê╪».
  - **█▒.█▒ ╪¬╪º╪▒█î╪« ╪¬┘ê┘ä╪»:** ┘ü█î┘ä╪» `╪¬╪º╪▒█î╪« ╪¬┘ê┘ä╪»` ╪º╪▓ ┘é╪¿┘ä ╪»╪▒ ┘ü╪▒┘à ╪º╪┤╪«╪º╪╡ ╪¿┘ê╪»╪¢ ╪¿╪º╪▓┘ç┘ö ╪│╪º┘ä ╪»█î╪¬ΓÇî┘╛█î┌⌐╪▒ ╪º╪▓ █▒█│█░█░ ╪¬╪º ╪º┘à╪▒┘ê╪▓ ╪º╪│╪¬ (╪¬╪ú█î█î╪»╪┤╪»┘ç). ┘å┌⌐╪¬┘ç: ┘ü╪▒┘à ╪┤╪«╪╡ ╪¼╪»█î╪» ┘å█î╪º╪▓ ╪»╪º╪▒╪» ╪º┘ê┘ä █î┌⌐ ┬½┌»╪▒┘ê┘ç ╪º╪┤╪«╪º╪╡┬╗ ╪º┘å╪¬╪«╪º╪¿ ╪┤┘ê╪» (╪»┌⌐┘à┘ç ╪¬╪º ╪ó┘å ╪▓┘à╪º┘å disabled ╪º╪│╪¬).
  - **█▒.█▒ ┌»╪▒┘ê┘ç ╪º╪┤╪«╪º╪╡:** ╪ó█î╪¬┘à ┬½┌»╪▒┘ê┘çΓÇî┘ç╪º█î ╪º╪┤╪«╪º╪╡┬╗ ╪¿┘ç ┘à┘å┘ê█î ┬½╪º╪╖┘ä╪º╪╣╪º╪¬ ┘╛╪º█î┘ç┬╗ ╪º╪╢╪º┘ü┘ç ╪┤╪» ╪¬╪º ┘ê█î╪▒╪º█î╪┤/╪¡╪░┘ü ╪»╪▒ ╪»╪│╪¬╪▒╪│ ╪¿╪º╪┤╪» (backend DELETE ╪¿╪º ┘à╪¡╪º┘ü╪╕╪¬ ┬½╪»╪▒ ╪¡╪º┘ä ╪º╪│╪¬┘ü╪º╪»┘ç┬╗ ╪º╪▓ ┘é╪¿┘ä ╪¿┘ê╪»).
  - **█▒.█▓ ┘à╪¡╪╡┘ê┘ä:** ╪»┌⌐┘à┘ç┘ö ┬½Γ₧ò ┘à╪¡╪╡┘ê┘ä ╪¼╪»█î╪»┬╗ ╪¿┘ç view ┌⌐╪º┘ä╪º┘ç╪º█î ╪¡╪│╪º╪¿╪»╪º╪▒█î ╪º╪╢╪º┘ü┘ç ╪┤╪»╪¢ ┌⌐╪» ┘à╪¡╪╡┘ê┘ä ╪»╪▒ ╪╡┘ê╪▒╪¬ ╪«╪º┘ä█î ╪¿┘ê╪»┘å ╪«┘ê╪»┌⌐╪º╪▒ (`K-00001`) ┘ê ┌⌐╪» ╪¬┘ü╪╡█î┘ä█î ╪¡╪│╪º╪¿╪»╪º╪▒█î ╪«┘ê╪»┌⌐╪º╪▒ (`allocTafsili`).
  - **█▒.█│ ┘╛╪▒╪»╪º╪«╪¬ ┘ç╪▓█î┘å┘ç:** ╪»┌⌐┘à┘ç┘ö inline ┬½Γ₧ò ╪»╪│╪¬┘ç┘ö ╪¼╪»█î╪»┬╗ ╪»╪▒ ┘à┘ê╪»╪º┘ä ┘ç╪▓█î┘å┘ç + ┌»╪│╪¬╪▒╪┤ ╪»╪│╪¬┘çΓÇî┘ç╪º█î ┘╛█î╪┤ΓÇî┘ü╪▒╪╢ (idempotent). picker ╪¡╪│╪º╪¿ ┘ç╪▓█î┘å┘ç ╪º╪▓ ┘é╪¿┘ä z-index 9999 ╪»╪º╪┤╪¬.
  - **█▒.█│ ╪½╪¿╪¬ ┌å┌⌐:** ┌»╪▓█î┘å┘ç┘ö ┬½┌å┘å╪» ┌å┌⌐ ╪»╪▒ █î┌⌐ ╪│┘å╪»┬╗ ╪¿╪º ╪¼╪▒█î╪º┘å **┬½Γ₧ò ╪½╪¿╪¬ ┌å┌⌐ ╪¿╪╣╪»█î┬╗** ╪¼╪º█î┌»╪▓█î┘å ╪┤╪»: ┘ç╪▒ ┌å┌⌐ █î┌⌐ ┌⌐╪º╪▒╪¬ ╪¿╪º ┘ç┘à┘ç┘ö ┘ü█î┘ä╪»┘ç╪º (┘å╪º┘à ╪¿╪º┘å┌⌐╪î ╪┤┘à╪º╪▒┘ç ╪¡╪│╪º╪¿╪î ╪┤╪╣╪¿┘ç╪î ╪┤╪¿╪º╪î ╪┤┘à╪º╪▒┘ç ┌å┌⌐╪î ╪┤┘å╪º╪│┘ç ╪╡█î╪º╪»╪î ┘à╪¿┘ä╪║╪î ╪│╪▒╪▒╪│█î╪»╪î ╪╡╪º╪»╪▒┌⌐┘å┘å╪»┘ç╪î ╪¬┘ê╪╢█î╪¡╪º╪¬) + **╪┤┘à╪º╪▒┘ç┘ö ╪▒╪»█î┘ü ╪«┘ê╪»┌⌐╪º╪▒**. ╪│╪¬┘ê┘å `settlements.cheque_row` ╪º╪╢╪º┘ü┘ç ┘ê ╪»╪▒ `settlements/batch` ╪░╪«█î╪▒┘ç ┘à█îΓÇî╪┤┘ê╪».
  - **█▓.█▓ ╪¼╪│╪¬╪¼┘ê█î ┘╛█î╪┤╪▒┘ü╪¬┘ç (Ctrl+K):** ╪¿┘çΓÇî╪¼╪º█î █▒█│ ╪╡┘ü╪¡┘ç┘ö ╪½╪º╪¿╪¬╪î ╪¡╪º┘ä╪º **┘ç┘à┘ç┘ö ╪¿╪«╪┤ΓÇî┘ç╪º/╪▓█î╪▒┘à┘å┘ê┘ç╪º** (┘à┘å┘ê█î ╪º╪╡┘ä█î + ┌⌐┘ä ╪▓█î╪▒┘à╪º┌ÿ┘ê┘äΓÇî┘ç╪º█î `ACC_NAV_SECTIONS`) ╪º█î┘å╪»┌⌐╪│ ┘ê ┘à╪│╪¬┘é█î┘à╪º┘ï ┘é╪º╪¿┘ä ┘å╪º┘ê╪¿╪▒█îΓÇî╪º┘å╪» (┘ê╪▒┘ê╪» ╪«┘ê╪»┌⌐╪º╪▒ ╪¿┘ç ┘╛┘ê╪│╪¬┘ç┘ö ╪¡╪│╪º╪¿╪»╪º╪▒█î ╪¿╪▒╪º█î ╪ó█î╪¬┘àΓÇî┘ç╪º█î `acc-*`).
  - **█▓.█▒ ┌⌐╪»┘ç╪º█î ╪«┘ê╪»┌⌐╪º╪▒:** ┘à╪¡╪╡┘ê┘ä (K-00001)╪î ╪┤╪«╪╡ (P-00001╪î ╪º╪▓ ┘é╪¿┘ä)╪î ┌»╪▒┘ê┘ç ╪º╪┤╪«╪º╪╡ (MAX+1╪î ╪º╪▓ ┘é╪¿┘ä)╪î ┘ê ┌⌐╪»┘ç╪º█î ┌⌐┘ä/┘à╪╣█î┘å/╪¬┘ü╪╡█î┘ä█î (`allocTafsili`) ┘ç┘à┌»█î ╪«┘ê╪»┌⌐╪º╪▒.
  - ╪▒╪º┘ç┘å┘à╪º█î ╪»╪º╪«┘ä ╪¿╪▒┘å╪º┘à┘ç (╪¿╪«╪┤ ┬½┘é╪º╪¿┘ä█î╪¬ΓÇî┘ç╪º█î ╪¼╪»█î╪»┬╗) + SW ╪¿┘ç `v38`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/public/acc-nav.js`, `server/public/sw.js`, `server/db.js`, `server/routes/accounting.js`, `server/routes/products.js`
- **┘ê╪╢╪╣█î╪¬ ╪¬╪│╪¬:** SMS 22/22╪î Sync 33/33╪î ╪¬╪│╪¬ ╪¬┘ê┘ä█î╪» █┤█▓█╖ ╪│╪¿╪▓╪î ┘╛╪º╪▒╪│ ┘ü╪▒╪º┘å╪¬ ╪│╪º┘ä┘à. GUI: ╪▒┘ü╪╣ z-index ╪¬┘é┘ê█î┘à ┘ê ╪¿╪º╪▓┘ç┘ö █▒█│█░█░ **╪¬╪ú█î█î╪» ╪¿╪╡╪▒█î ╪┤╪»**╪¢ backend ╪½╪¿╪¬ ┌å┘å╪» ┌å┌⌐ ╪¿╪º `cheque_row` ┘ê ┘ç┘à┘ç┘ö ┘ü█î┘ä╪»┘ç╪º **╪¿╪º curl ╪¬╪ú█î█î╪» ╪┤╪»** (█▓ ┌å┌⌐╪î installment_group ┘à╪┤╪¬╪▒┌⌐). ╪»┘à┘ê█î ┌⌐╪º┘à┘ä ╪░╪«█î╪▒┘ç┘ö ┌å┌⌐ ╪º╪▓ ┘à╪│█î╪▒ GUI ╪¿┘çΓÇî╪«╪º╪╖╪▒ ╪»╪┤┘ê╪º╪▒█î computerUse ╪»╪▒ ┘╛╪▒┌⌐╪▒╪»┘å ┘ü█î┘ä╪» ┘å╪º┘à ╪¿╪º┘å┌⌐ ╪▒╪»█î┘ü ╪»┘ê┘à ┘ê ╪º┘å╪¬╪«╪º╪¿ ┘à╪┤╪¬╪▒█î (┌⌐╪┤ ┘é╪»█î┘à█î╪î ╪▒┘ü╪╣ ╪¿╪º reload) ╪¿┘çΓÇî╪╖┘ê╪▒ ┌⌐╪º┘à┘ä ╪╢╪¿╪╖ ┘å╪┤╪» ΓÇö ┘à┘å╪╖┘é ╪»╪▒╪│╪¬ ╪º╪│╪¬.
- **Deploy:** Γ£à ╪▒┘ê█î production ╪º█î╪▒╪º┘å (`94.249.244.208`) ΓÇö HEAD `7947c11`╪î bundle + `pm2 restart`╪î health █▓█░█░.

### █▒█┤█░█╡/█░█┤/█▓█╢ ΓÇö [Cursor] ╪¬╪ú█î█î╪» ╪│┘ä╪º┘à╪¬ ╪┤╪º╪«┘ç + ╪▒┘ü╪╣ ╪¿╪º┌» divergence ┘à┘ê╪¼┘ê╪»█î ╪º┘å╪¿╪º╪▒ (╪│╪¿╪▓╪│╪º╪▓█î ┘à╪¼╪»╪» test-sync)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ╪º█î┘å ╪¼┘ä╪│┘ç (╪│┘ç ┌⌐╪º┘à█î╪¬: fix invoices╪î test-sync╪î docs)
- **╪«┘ä╪º╪╡┘ç:**
  - **╪º╪¼╪▒╪º█î ┌⌐╪º┘à┘ä ╪¬╪│╪¬ΓÇî┘ç╪º ╪▒┘ê█î ╪º█î┘å ╪┤╪º╪«┘ç:** `test-sms` **█▓█▓/█▓█▓**╪î `test-sync` **█│█│/█│█│**╪î ┘à╪¼┘à┘ê╪╣┘ç┘ö ┌⌐╪º┘à┘ä ╪¬┘ê┘ä█î╪» **█▒█╕ suite / █┤█▓█╖ assertion ╪│╪¿╪▓** (`npm run test:production`)╪î ┌å┌⌐ ┘å╪¡┘ê█î ┘ç┘à┘ç┘ö ┘ü╪º█î┘äΓÇî┘ç╪º█î ╪¿┌⌐ΓÇî╪º┘å╪»╪î ┘ê ┘╛╪º╪▒╪│ ╪º╪│┌⌐╪▒█î┘╛╪¬ΓÇî┘ç╪º█î ┘ü╪▒╪º┘å╪¬ (`index.html` inline + `prod-ui.js` + `acc-nav.js` + `sw.js`).
  - **≡ƒÉ₧ ╪¿╪º┌» ┘ê╪º┘é╪╣█î ┌⌐╪┤┘ü ┘ê ╪▒┘ü╪╣ΓÇî╪┤╪»┘ç ╪»╪▒ `deductStock` (`routes/invoices.js`):** ┘à╪│█î╪▒ ╪¿╪▒╪▒╪│█î ┘à┘ê╪¼┘ê╪»█î╪î ┘å╪¿┘ê╪»┘É ╪▒╪»█î┘ü `warehouse_stock` ╪▒╪º ┬½┌⌐┘ä `products.stock` ╪▒┘ê█î ╪º┘å╪¿╪º╪▒ ╪«╪º┘å┌»█î ┘à╪¡╪╡┘ê┘ä┬╗ ┘ü╪▒╪╢ ┘à█îΓÇî┌⌐╪▒╪»╪î ┘ê┘ä█î ┘à╪│█î╪▒ ┌⌐╪│╪▒╪î ╪▒╪»█î┘ü ╪▒╪º ╪¿╪º `qty=0` ┘à█îΓÇî╪│╪º╪«╪¬ ┘ê ┌⌐╪│╪▒ ╪▒╪º ╪¿┘ç ╪╡┘ü╪▒ clamp ┘à█îΓÇî┌⌐╪▒╪» ΓåÆ **╪º┘ê┘ä█î┘å ┘ü╪▒┘ê╪┤ ┘ç╪▒ ┘à╪¡╪╡┘ê┘ä█î ┌⌐┘ç ┘ç┘å┘ê╪▓ ╪▒╪»█î┘ü `warehouse_stock` ┘å╪»╪º╪┤╪¬╪î ┘à┘ê╪¼┘ê╪»█î ╪º┘å╪¿╪º╪▒╪┤ ╪▒╪º ╪¿┘çΓÇî╪º╪┤╪¬╪¿╪º┘ç ╪╡┘ü╪▒ ┘à█îΓÇî┌⌐╪▒╪»** ╪»╪▒ ╪¡╪º┘ä█î ┌⌐┘ç `products.stock` ┘à╪½╪¿╪¬ ┘à█îΓÇî┘à╪º┘å╪». ┘å╪¬█î╪¼┘ç: ┘ü╪▒┘ê╪┤ΓÇî┘ç╪º█î ╪¿╪╣╪»█î ┘ç┘à╪º┘å ┌⌐╪º┘ä╪º ╪¿╪º ┬½┘à┘ê╪¼┘ê╪»█î ╪º┘å╪¿╪º╪▒ ┌⌐╪º┘ü█î ┘å█î╪│╪¬ (┘à┘ê╪¼┘ê╪»: 0)┬╗ ╪▒╪» ┘à█îΓÇî╪┤╪»┘å╪». ╪▒┘ü╪╣: ╪▒╪»█î┘ü ╪¼╪»█î╪» ╪¿╪º ┘ç┘à╪º┘å ┘à┘é╪»╪º╪▒ fallback ┘à╪│█î╪▒ ╪«┘ê╪º┘å╪»┘å (`prod.stock` ╪º┌»╪▒ ╪º┘å╪¿╪º╪▒ ╪«╪º┘å┌»█î ╪¿╪º╪┤╪») ┘à┘é╪»╪º╪▒╪»┘ç█î ┘à█îΓÇî╪┤┘ê╪»╪î ╪│┘╛╪│ ┌⌐╪│╪▒ ╪º┘å╪¼╪º┘à ┘à█îΓÇî┌»█î╪▒╪». ╪¿╪»┘ê┘å ╪▒┌»╪▒╪│█î┘ê┘å ╪¿╪▒╪º█î ┘à╪¡╪╡┘ê┘ä╪º╪¬█î ┌⌐┘ç ╪▒╪»█î┘ü ╪º┘å╪¿╪º╪▒ ┘ê╪º┘é╪╣█î ╪»╪º╪▒┘å╪» (ON CONFLICT DO NOTHING).
  - **╪▒┘ü╪╣ ╪¬╪│╪¬ ┌⌐┘ç┘å┘ç (`scripts/test-sync.js`):** ╪º╪▓ ┘ü╪º╪▓ █│ ╪¡╪│╪º╪¿╪»╪º╪▒█î╪î ┘ü█î┘ä╪» `final` ┘ü╪º┌⌐╪¬┘ê╪▒ ╪┤╪º┘à┘ä VAT ┘╛█î╪┤ΓÇî┘ü╪▒╪╢ ╪º╪│╪¬╪¢ ╪│┘å╪º╪▒█î┘ê █│ ╪¿┘çΓÇî╪¼╪º█î `final === 250000` ╪¡╪º┘ä╪º ╪¿╪▒ ╪º╪│╪º╪│ `subtotal === 250000` (┘à╪│╪¬┘é┘ä ╪º╪▓ VAT) ┘ü╪º┌⌐╪¬┘ê╪▒ ╪▒╪º ┘à█îΓÇî█î╪º╪¿╪». ╪º█î┘å ╪¬┘å┘ç╪º █î┌⌐ ╪º╪╡┘ä╪º╪¡ ╪º┘å╪¬╪╕╪º╪▒ ╪¬╪│╪¬ ╪º╪│╪¬╪î ┘å┘ç ╪¬╪║█î█î╪▒ ╪▒┘ü╪¬╪º╪▒.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/routes/invoices.js`, `server/scripts/test-sync.js`, `docs/CHANGE-LOG.md`
- **Deploy:** Γ£à ╪▒┘ê█î production ╪º█î╪▒╪º┘å (`94.249.244.208`) ΓÇö HEAD ╪º┘ä╪º┘å `ae016a3`╪î `pm2 restart` ╪º┘å╪¼╪º┘à ╪┤╪»╪î health █▓█░█░╪î ╪▒┘ü╪╣ `seedQty` ╪»╪▒ ┘ü╪º█î┘ä ┘à╪│╪¬┘é╪▒ ╪¬╪ú█î█î╪» ╪┤╪».
- **ΓÜá∩╕Å █î╪º╪»╪»╪º╪┤╪¬ ┘à┘ç┘à ops (╪│╪▒┘ê╪▒ ╪¿┘ç GitHub ╪»╪│╪¬╪▒╪│█î ┘å╪»╪º╪▒╪»):** ╪▒┘ê█î ╪│╪▒┘ê╪▒ ╪º█î╪▒╪º┘å╪î DNS ┘å╪º┘à `github.com` ╪▒╪º resolve ┘å┘à█îΓÇî┌⌐┘å╪» (┘ü█î┘ä╪¬╪▒█î┘å┌»)╪î ┘╛╪│ `scripts/deploy-production.sh` ╪▒┘ê█î ┘à╪▒╪¡┘ä┘ç┘ö `git pull` ╪┤┌⌐╪│╪¬ ┘à█îΓÇî╪«┘ê╪▒╪». ╪▒╪º┘çΓÇî╪¡┘ä ╪º╪│╪¬┘ü╪º╪»┘çΓÇî╪┤╪»┘ç: ╪º┘å╪¬┘é╪º┘ä ┌⌐╪º┘à█î╪¬ΓÇî┘ç╪º ╪¿╪º **git bundle** ╪º╪▓ ┘à╪¡█î╪╖█î ┌⌐┘ç ╪¿┘ç GitHub ╪»╪│╪¬╪▒╪│█î ╪»╪º╪▒╪» ΓåÆ `git bundle create up.bundle <base>..HEAD` ╪│┘╛╪│ `scp` ╪¿┘ç ╪│╪▒┘ê╪▒ ┘ê `git pull /tmp/up.bundle <branch>` (fast-forward)╪î ╪¿╪╣╪» `pm2 restart erp-taranom --update-env`. ┌å┘ê┘å ╪º█î┘å ╪¬╪║█î█î╪▒╪º╪¬ ┘ê╪º╪¿╪│╪¬┌»█î ╪¼╪»█î╪» ┘å╪»╪º╪┤╪¬┘å╪»╪î `npm install` ┘ä╪º╪▓┘à ┘å╪¿┘ê╪». ╪¿╪▒╪º█î ╪▒┘ü╪╣ ╪▒█î╪┤┘çΓÇî╪º█î: DNS/┘╛╪▒┘ê┌⌐╪│█î ╪│╪▒┘ê╪▒ ╪¿╪▒╪º█î github ╪¬┘å╪╕█î┘à ╪┤┘ê╪».
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪¬╪║█î█î╪▒ █î┌⌐ ╪▒┘ü╪╣ ╪╡╪¡╪¬ ╪º╪│╪¬ ┘å┘ç ┘é╪º╪¿┘ä█î╪¬ ╪¼╪»█î╪»╪î ┘╛╪│ ╪¿╪«╪┤ ╪▒╪º┘ç┘å┘à╪º█î ╪»╪º╪«┘ä ╪¿╪▒┘å╪º┘à┘ç ┘å█î╪º╪▓ ╪¿┘ç ╪º┘ü╪▓┘ê╪»┘å ┘å╪»╪º╪▒╪».

### █▒█┤█░█╡/█░█┤/█▓█╢ ΓÇö [Cursor] ┘ç┘à┌»╪º┘àΓÇî╪│╪º╪▓█î CHANGE-LOG ╪¿╪º ┌⌐╪» ╪┤╪º╪«┘ç (╪¿╪º╪▓╪│╪º╪▓█î ┘ê╪▒┘ê╪»█îΓÇî┘ç╪º█î ╪¼╪º┘à╪º┘å╪»┘ç)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ┘ç┘à█î┘å commit (┘ü┘é╪╖ ┘à╪│╪¬┘å╪»╪º╪¬)
- **╪«┘ä╪º╪╡┘ç:** ┘ä╪º┌» ╪¬╪║█î█î╪▒╪º╪¬ ╪¿╪º HEAD ╪┤╪º╪«┘ç (`13dbcaf`) ╪º╪▓ ╪╣┘é╪¿ΓÇî┘à╪º┘å╪»┌»█î ╪»╪▒╪ó┘à╪». █▒█│ ┌⌐╪º┘à█î╪¬ ╪½╪¿╪¬ΓÇî┘å╪┤╪»┘ç (╪º╪▓ `9e183e0` ╪¬╪º `13dbcaf` ΓÇö ╪┤╪º┘à┘ä ┘à╪º┌ÿ┘ê┘ä ┌⌐╪º┘à┘ä ╪¿┘ç╪º█î ╪¬┘à╪º┘àΓÇî╪┤╪»┘ç┘ö ╪¬┘ê┘ä█î╪»╪î UI ╪¬┘ê┘ä█î╪»╪î ╪▒╪º┘çΓÇî╪º┘å╪»╪º╪▓█î VPS ╪º█î╪▒╪º┘å╪î ╪¼╪▒█î╪º┘åΓÇî┘ç╪º█î ┘ü╪▒┘ê╪┤/╪«╪▒█î╪» ╪º█î╪▒╪º┘å█î╪î ┘ê ╪º╪╡┘ä╪º╪¡╪º╪¬ UI ╪¡╪│╪º╪¿╪»╪º╪▒█î crm.docx) ╪┤┘å╪º╪│╪º█î█î ┘ê ┘ê╪▒┘ê╪»█î ╪¬╪º╪▒█î╪«┌å┘çΓÇî╪┤╪º┘å ╪¿╪º╪▓╪│╪º╪▓█î ╪┤╪». ╪¼╪»┘ê┘ä ┬½┘ê╪╢╪╣█î╪¬ ┘ü╪╣┘ä█î┬╗ ┘ç┘à ╪¿┘çΓÇî╪▒┘ê╪▓ ╪┤╪» (╪ó╪«╪▒█î┘å commit╪î SW `v37`╪î ╪│╪▒┘ê╪▒ ╪¬┘å┘ç╪º ╪º█î╪▒╪º┘å).
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `docs/CHANGE-LOG.md`
- **Deploy:** Γ¥î ┘ä╪º╪▓┘à ┘å█î╪│╪¬ (┘ü┘é╪╖ ┘à╪│╪¬┘å╪»╪º╪¬)

> **█î╪º╪»╪»╪º╪┤╪¬ ┘ç┘à╪º┘ç┘å┌»█î (╪½╪¿╪¬ΓÇî╪┤╪»┘ç █▒█┤█░█╡/█░█┤/█▓█╢):** ┘ê╪▒┘ê╪»█îΓÇî┘ç╪º█î ╪▓█î╪▒ ╪¿╪▒╪º█î ┌⌐╪º┘à█î╪¬ΓÇî┘ç╪º█î█î ╪¿╪º╪▓╪│╪º╪▓█î ╪┤╪»┘å╪» ┌⌐┘ç ┌⌐╪» ╪ó┘åΓÇî┘ç╪º ╪»╪▒ ╪┤╪º╪«┘ç ╪¿┘ê╪» ┘ê┘ä█î ┘ê╪▒┘ê╪»█î ╪¬╪º╪▒█î╪«┌å┘ç ┘å╪»╪º╪┤╪¬┘å╪» (╪º╪▓ `9e183e0` ╪¬╪º `13dbcaf`). ╪«┘ä╪º╪╡┘çΓÇî┘ç╪º ╪º╪▓ ┘╛█î╪º┘à ┌⌐╪º┘à█î╪¬ ┘ê ╪ó┘à╪º╪▒ ┘ü╪º█î┘äΓÇî┘ç╪º ╪º╪│╪¬╪«╪▒╪º╪¼ ╪┤╪»┘çΓÇî╪º┘å╪». ┘ê╪╢╪╣█î╪¬ deploy ╪º╪▓ ╪º█î┘å ┘à╪¡█î╪╖ (Cloud Agent╪î ╪¿╪»┘ê┘å SSH ╪¿┘ç ╪│╪▒┘ê╪▒) ┘é╪º╪¿┘ä ╪¬╪ú█î█î╪» ┘å╪¿┘ê╪» ┘ê ╪¿╪º ΓÅ│ (┘å█î╪º╪▓ ╪¿┘ç ╪¬╪ú█î█î╪» ╪▒┘ê█î ╪│╪▒┘ê╪▒) ╪╣┘ä╪º┘à╪¬ ╪«┘ê╪▒╪»┘ç ┘à┌»╪▒ ╪¼╪º█î█î ┌⌐┘ç ╪«┘ä╪º┘ü ╪ó┘å ┘à╪│╪¬┘å╪» ╪º╪│╪¬.

### █▒█┤█░█╡/█░█┤/█▓█╢ ΓÇö [Cursor] ╪º╪╡┘ä╪º╪¡╪º╪¬ UI ╪¡╪│╪º╪¿╪»╪º╪▒█î (╪╖╪¿┘é crm.docx): ╪º╪┤╪«╪º╪╡╪î ╪»╪▒█î╪º┘ü╪¬ΓÇî┘ç╪º╪î ╪º┘å╪¿╪º╪▒╪î ╪º╪│┘å╪º╪»
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `13dbcaf`
- **╪«┘ä╪º╪╡┘ç:**
  - ╪│╪º╪«╪¬ ╪«┘ê╪»┌⌐╪º╪▒ ╪¡╪│╪º╪¿ CoA ╪▒┘ê█î ╪º╪┤╪«╪º╪╡/┘à╪¡╪╡┘ê┘ä╪º╪¬ (`parties`/`products`) + ┘ç┘à┌»╪º┘àΓÇî╪│╪º╪▓█î `parties-sync`.
  - **█┤ ┘å┘ê╪╣ ╪»╪▒█î╪º┘ü╪¬/┘╛╪▒╪»╪º╪«╪¬** + ╪▒╪│█î╪»┘ç╪º█î ┌å┘å╪»-┌å┌⌐█î (multi-check).
  - ╪º┘å╪¿╪º╪▒ **╪¿┘çΓÇî╪º╪▓╪º█î ┘ç╪▒ ╪│╪╖╪▒ ┘ü╪º┌⌐╪¬┘ê╪▒** + ╪º╪│┘å╪º╪» ╪º┘å╪¿╪º╪▒ ┌å┘å╪»-╪│╪╖╪▒█î╪¢ ╪»╪│╪¬┘çΓÇî╪¿┘å╪»█î ┘ç╪▓█î┘å┘çΓÇî┘ç╪º.
  - ┘╛╪º┌⌐ΓÇî╪│╪º╪▓█î ┘å╪º┘ê╪¿╪▒█î (`acc-nav.js`) + ╪º┘å╪¬╪«╪º╪¿┌»╪▒/UX ╪│┘å╪» (voucher picker).
  - ╪º╪│┌⌐╪▒█î┘╛╪¬ ┌⌐┘à┌⌐█î █î┌⌐ΓÇî╪¿╪º╪▒┘à╪╡╪▒┘ü `scripts/_patch_crm_docx_ui.py` ╪¿╪▒╪º█î ╪º╪╣┘à╪º┘ä ╪¬╪║█î█î╪▒╪º╪¬ UI╪¢ SW bump.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/public/acc-nav.js`, `server/routes/{accounting,expenses,invoices,parties,products,warehouses}.js`, `server/lib/{coa-map,parties-sync}.js`, `server/db.js`
- **Deploy:** ΓÅ│ ┘å█î╪º╪▓ ╪¿┘ç ╪¬╪ú█î█î╪» ╪▒┘ê█î ╪│╪▒┘ê╪▒

### █▒█┤█░█╡/█░█┤/█▓█╢ ΓÇö [Cursor] ┘à╪º┌ÿ┘ê┘ä ┌⌐╪º┘à┘ä ╪¿┘ç╪º█î ╪¬┘à╪º┘àΓÇî╪┤╪»┘ç┘ö ╪¬┘ê┘ä█î╪» (P0ΓÇôP10) + UI + ╪¬╪│╪¬ΓÇî┘ç╪º
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `6e2ff80` (┘╛╪º█î┘ç) ┬╖ `0275b8b` ┬╖ `e2d7c86` ┬╖ `e49e01b` ┬╖ `8d41c9d` ┬╖ `a537a15` ┬╖ `868a583`
- **╪«┘ä╪º╪╡┘ç:**
  - **`6e2ff80` ΓÇö ┘╛╪º█î┘ç┘ö ┘à╪º┌ÿ┘ê┘ä ╪¬┘ê┘ä█î╪»:** BOM╪î ╪¿┘ç╪º█î ╪¬┘à╪º┘àΓÇî╪┤╪»┘ç┘ö ╪½╪º╪¿╪¬/┘à╪¬╪║█î╪▒╪î ╪º╪¼╪▒╪º█î ┌å┘å╪»┘à╪▒╪¡┘ä┘çΓÇî╪º█î╪î MRP╪î ╪¿╪│╪¬┘å ╪»┘ê╪▒┘ç ╪¿╪º ╪¬╪│┘ç█î┘à ADR-005╪î ┌»╪▓╪º╪▒╪┤ΓÇî┘ç╪º ╪¿╪º ╪»╪º╪┤╪¿┘ê╪▒╪» Chart.js ┘ê ╪¿╪▒┌»┘ç┘ö ╪¿┘ç╪º█î ╪¬┘à╪º┘àΓÇî╪┤╪»┘ç┘ö A4╪î ╪¡╪░┘ü ╪¿┘ç╪º█î ╪¬┘à╪º┘àΓÇî╪┤╪»┘ç ╪»╪▒ RBAC (cost stripping)╪î workflow CI╪î ┘ê cron ╪│┘ä╪º┘à╪¬ ╪┤╪¿╪º┘å┘ç. ┘à╪│╪¬┘å╪»╪º╪¬ ┌⌐╪º┘à┘ä ╪»╪▒ `docs/Production/*` (█▓█░ ╪│┘å╪»). **`server/sync/tables.js` ┘ü┘é╪╖ append ╪┤╪»** (╪¼╪»┘ê┘äΓÇî┘ç╪º█î ╪¼╪»█î╪» ╪¬┘ê┘ä█î╪»).
  - **`0275b8b`:** ╪¿╪▒╪▒╪│█îΓÇî┌»╪▒ ╪ó┘à╪º╪»┌»█î go-live ┘ç┘ü╪¬┘ç┘ö ╪º┘ê┘ä (┘à╪▒╪º┌⌐╪▓ ┘ç╪▓█î┘å┘ç╪î ╪º┘å╪¿╪º╪▒┘ç╪º╪î ╪¬┘å╪╕█î┘à╪º╪¬ CoA╪î ╪┤┌⌐╪º┘ü BOM/┘å╪▒╪«ΓÇî┘ç╪º) ╪¿╪º `--fix` ╪º╪«╪¬█î╪º╪▒█î.
  - **`e2d7c86`:** ╪¬┌⌐┘à█î┘ä ╪╡┘ü╪¡╪º╪¬ UI ╪╖╪¿┘é `ui.md` ΓÇö ╪│█î╪│╪¬┘à ╪╖╪▒╪º╪¡█î `prod-ui`╪î ╪¬╪¿ΓÇî┘ç╪º█î ╪¿╪▒╪ó┘ê╪▒╪»/┌⌐╪º┘å╪¿╪º┘å/╪º┘å╪¡╪▒╪º┘ü/MRP/┘å╪▒╪«ΓÇî┘ç╪º╪î ╪¼╪▒█î╪º┘åΓÇî┘ç╪º█î ┘à╪▒╪¡┘ä┘ç/╪¡┘ê╪º┘ä┘ç ╪│┘ü╪º╪▒╪┤╪î ╪º┌⌐╪┤┘åΓÇî┘ç╪º█î BOM routing╪î ╪º╪¬╪╡╪º┘ä `canSeeCost`.
  - **`e49e01b`:** ┌»╪│╪¬╪▒╪┤ ┘╛┘ê╪┤╪┤ ╪¬╪│╪¬ ΓÇö smoke API╪î ┘à╪º╪¬╪▒█î╪│ ╪»╪│╪¬╪▒╪│█î╪î BOM╪î ╪¬╪¡┘ä█î┘ä ╪½╪º╪¿╪¬/┘à╪¬╪║█î╪▒ ┘╛█î╪┤╪▒┘ü╪¬┘ç╪î ╪¿╪▒╪ó┘ê╪▒╪»╪î ┌»╪▓╪º╪▒╪┤ΓÇî┘ç╪º╪î ╪│┘ä╪º┘à╪¬╪î smoke UI.
  - **`8d41c9d`:** health-check ╪¬┘ê┘ä█î╪» + API/UI `user_cost_centers`╪î ┌⌐┘å╪¬╪▒┘ä ╪»╪│╪¬┘à╪▓╪» ┘╛█î┘à╪º┘å┌⌐╪º╪▒█î ╪▒┘ê█î ┘à┘ê╪»╪º┘ä ┘à╪▒╪¡┘ä┘ç╪î ┘ê `reverseStage` (PRD-99) ╪¿╪▒╪º█î ╪ó╪«╪▒█î┘å ┘à╪▒╪¡┘ä┘ç┘ö ┌⌐╪º┘à┘äΓÇî╪┤╪»┘ç.
  - **`a537a15`:** ╪º╪│╪¬┘ü╪º╪»┘ç ╪º╪▓ `cost_centers.active` (┘å┘ç `is_active`)╪î ╪¿╪º╪▓ ┌⌐╪▒╪»┘å ╪«┘ê╪»┌⌐╪º╪▒ ╪»┘ê╪▒┘ç ╪»╪▒ precheck ╪¿╪│╪¬┘å╪î ┘à┘é╪º┘ê┘àΓÇî╪│╪º╪▓█î ╪»╪º╪┤╪¿┘ê╪▒╪» ╪»╪▒ ╪»╪º╪»┘ç┘ö ╪«╪º┘ä█î╪î ╪¿┘ç╪¿┘ê╪» UX/╪«╪╖╪º█î ╪º█î╪¼╪º╪» ╪│┘ü╪º╪▒╪┤╪î ╪¡╪░┘ü ╪¬╪¿ ┘é╪»█î┘à█î ╪¬┘ê┘ä█î╪».
  - **`868a583`:** ╪¿╪º╪▓┘å╪┤╪│╪¬┌»█î VPS ╪ó┘ä┘à╪º┘å ╪º╪▓ ┘à╪│╪¬┘å╪»╪º╪¬╪¢ ╪º█î╪▒╪º┘å `94.249.244.208` ╪¬┘å┘ç╪º ╪│╪▒┘ê╪▒ production.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/production/*` (bom, costing, engine, close, mrp, reports, schema, ...)╪î `server/routes/production-*.js`╪î `server/public/{prod-ui.js,prod-ui.css,acc-nav.js,index.html}`╪î `server/scripts/test-production-*.js`╪î `docs/Production/*`╪î `.github/workflows/production-tests.yml`╪î `server/sync/tables.js`
- **Deploy:** ΓÅ│ ┘å█î╪º╪▓ ╪¿┘ç ╪¬╪ú█î█î╪» ╪▒┘ê█î ╪│╪▒┘ê╪▒ ΓÇö `npm install` ┘ä╪º╪▓┘à (┘ê╪º╪¿╪│╪¬┌»█îΓÇî┘ç╪º█î ╪¼╪»█î╪» ╪»╪▒ `server/package.json`)

### █▒█┤█░█╡/█░█┤/█▓█╡ ΓÇö [Cursor] ╪▒╪º┘çΓÇî╪º┘å╪»╪º╪▓█î VPS ╪º█î╪▒╪º┘å + ┘à╪│█î╪▒┘ç╪º█î ┘é╪º╪¿┘äΓÇî╪¡┘à┘ä PM2
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `332f84d`
- **╪«┘ä╪º╪╡┘ç:** ╪º╪│┌⌐╪▒█î┘╛╪¬ΓÇî┘ç╪º█î bootstrap ┘ê ╪│╪«╪¬ΓÇî╪│╪º╪▓█î ╪│╪▒┘ê╪▒ ╪º█î╪▒╪º┘å (`bootstrap-iran-vps.sh`, `fresh-harden.py`, `ubuntu-harden.sh`, ╪║█î╪▒┘ü╪╣╪º┘äΓÇî╪│╪º╪▓█î ╪▒┘à╪▓ SSH╪î unban ┌⌐┘å╪│┘ê┘ä)╪î ┘à╪│█î╪▒┘ç╪º█î deploy ┘é╪º╪¿┘äΓÇî╪¡┘à┘ä PM2╪î ┘ê ┘å┘à┘ê┘å┘ç┘ö `ssh-config-taranom-ir`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `scripts/bootstrap-iran-vps.sh`, `scripts/fresh-harden.py`, `scripts/ubuntu-harden.sh`, `scripts/deploy-production.sh`, `server/ecosystem.config.js`, `docs/SECURITY-HARDENING.md`
- **Deploy:** ΓÅ│ ╪º╪¼╪▒╪º ╪▒┘ê█î ╪│╪▒┘ê╪▒ ╪º█î╪▒╪º┘å (ops)

### █▒█┤█░█╡/█░█┤/█▓█┤ ΓÇö [Cursor] ┘à┘å┘ê█î ╪¡╪│╪º╪¿╪»╪º╪▒█î + ╪¼╪▒█î╪º┘åΓÇî┘ç╪º█î ┘ü╪▒┘ê╪┤/╪«╪▒█î╪» ╪º█î╪▒╪º┘å█î + ╪▒┘ü╪╣ ╪¿╪º┌»
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `09d6479` ┬╖ `3a85bf9` ┬╖ `373cffc`
- **╪«┘ä╪º╪╡┘ç:**
  - `09d6479`: ╪¿╪º╪▓╪╖╪▒╪º╪¡█î ┘à┘å┘ê█î ╪¡╪│╪º╪¿╪»╪º╪▒█î + ╪¼╪▒█î╪º┘åΓÇî┘ç╪º█î ┘ü╪▒┘ê╪┤/╪«╪▒█î╪» ╪º█î╪▒╪º┘å█î + ╪▒┘ü╪╣ ┌å┘å╪» ╪¿╪º┌».
  - `3a85bf9`: ╪▒┘ü╪╣ ┘à┘å┘ê█î ╪¡╪│╪º╪¿╪»╪º╪▒█î╪î UX ┌»╪▒┘ê┘çΓÇî┘ç╪º█î ╪º╪┤╪«╪º╪╡ (`party_groups`)╪î ┘ê API ╪│┘ü╪º╪▒╪┤ΓÇî┘ç╪º.
  - `373cffc`: seed ┌⌐╪▒╪»┘å `party_groups` ╪»╪▒ ╪¡╪º┘ä╪¬ standard + █î┌⌐┘╛╪º╪▒┌å┘çΓÇî╪│╪º╪▓█î UX ┘à╪º┌ÿ┘ê┘ä ╪º╪┤╪«╪º╪╡.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/routes/{parties,orders}.js`, `server/routes/party-groups.js`
- **Deploy:** ΓÅ│ ┘å█î╪º╪▓ ╪¿┘ç ╪¬╪ú█î█î╪» ╪▒┘ê█î ╪│╪▒┘ê╪▒

### █▒█┤█░█╡/█░█┤/█▓█┤ ΓÇö [Cursor] ╪º╪¬╪╡╪º┘ä postToLedger ╪¿┘ç ┘ü╪º┌⌐╪¬┘ê╪▒/╪«╪▒█î╪» + ┘é┘ü┘ä ╪│╪º┘ä ┘à╪º┘ä█î + ╪¿╪º╪▓█î╪º╪¿█î ╪¿┌⌐╪º┘╛ + UI █î┌⌐┘╛╪º╪▒┌å┌»█î
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `9e183e0`
- **╪«┘ä╪º╪╡┘ç:** ╪│█î┘àΓÇî┌⌐╪┤█î `postToLedger` ╪¿╪▒╪º█î ┘ü╪º┌⌐╪¬┘ê╪▒┘ç╪º ┘ê ╪«╪▒█î╪»┘ç╪º (┘╛╪│╪¬ ╪«┘ê╪»┌⌐╪º╪▒ ╪│┘å╪» ╪¡╪│╪º╪¿╪»╪º╪▒█î)╪î ┘é┘ü┘ä ╪│╪º┘ä ┘à╪º┘ä█î (fiscal lock)╪î ╪¿╪º╪▓█î╪º╪¿█î ╪¿┌⌐╪º┘╛ (backup restore)╪î ┘ê UI ╪¿╪▒╪▒╪│█î █î┌⌐┘╛╪º╪▒┌å┌»█î (integrity UI).
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/routes/{invoices,purchases,fiscal-year}.js`, `server/lib/ledger.js`, `server/backup.js`, `server/public/index.html`
- **Deploy:** ΓÅ│ ┘å█î╪º╪▓ ╪¿┘ç ╪¬╪ú█î█î╪» ╪▒┘ê█î ╪│╪▒┘ê╪▒
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪º█î┘å ┘ê╪▒┘ê╪»█î ╪¿╪╣╪»╪º┘ï ╪¿╪º╪▓╪│╪º╪▓█î ╪┤╪» ΓÇö ┘é╪¿┘ä╪º┘ï ┘ü┘é╪╖ ╪»╪▒ ╪¼╪»┘ê┘ä ┬½┘ê╪╢╪╣█î╪¬ ┘ü╪╣┘ä█î┬╗ ╪¿┘çΓÇî╪╣┘å┘ê╪º┘å ╪ó╪«╪▒█î┘å commit ╪░┌⌐╪▒ ╪┤╪»┘ç ╪¿┘ê╪».

### █▒█┤█░█┤/█░█┤/█▓█╕ ΓÇö [Cursor] ┘ü╪º╪▓ █│ΓÇô█╕ ┘à╪º┌ÿ┘ê┘ä ╪¡╪│╪º╪¿╪»╪º╪▒█î (VAT╪î ┘à┘ê╪»█î╪º┘å╪î ┌»╪▓╪º╪▒╪┤╪º╪¬╪î HR╪î ╪»╪º╪▒╪º█î█î ╪½╪º╪¿╪¬╪î backup)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `cdae070`
- **╪«┘ä╪º╪╡┘ç:**
  - **┘ü╪º╪▓ █│:** VAT ╪»╪▒ ┘ü╪º┌⌐╪¬┘ê╪▒ ┘ü╪▒┘ê╪┤/╪«╪▒█î╪» + ╪╡┘ü **┘à┘ê╪»█î╪º┘å** + ╪¡╪│╪º╪¿ΓÇî┘ç╪º█î 2103/1108
  - **┘ü╪º╪▓ █┤:** ┌»╪▓╪º╪▒╪┤ VAT + ┌»╪▒╪»╪┤ ╪º╪┤╪«╪º╪╡ + vatOutput ╪»╪▒ ╪│┘ê╪» ┘ê ╪▓█î╪º┘å
  - **┘ü╪º╪▓ █╡:** ╪º┘å╪¿╪º╪▒ ╪»╪▒ ╪«╪▒█î╪» + `/cash-boxes/petty-cash/summary`
  - **┘ü╪º╪▓ █╢:** ┘ü█î┘ä╪»┘ç╪º█î HR ╪▒┘ê█î persons + `/payroll/monthly-batch`
  - **┘ü╪º╪▓ █╖:** CRUD ╪»╪º╪▒╪º█î█î ╪½╪º╪¿╪¬ + ╪º╪│╪¬┘ç┘ä╪º┌⌐ ┘à╪º┘ç╪º┘å┘ç
  - **┘ü╪º╪▓ █╕:** activity log ╪»╪▒ audit + ┘é┘ü┘ä ╪│╪º┘ä ┘à╪º┘ä█î + backup restore
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/vat.js`, `server/routes/moadian.js`, `server/routes/fixed-assets.js`, `server/routes/invoices.js`, `server/routes/purchases.js`
- **Deploy:** Γ£à production (health 200, test 10/10)

### █▒█┤█░█┤/█░█┤/█▓█┤ ΓÇö [Cursor] ┘ü╪º╪▓ █▓ ╪º╪╖┘ä╪º╪╣╪º╪¬ ┘╛╪º█î┘ç + deploy ┘ü╪º╪▓ █▒
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `475aafb`
- **╪«┘ä╪º╪╡┘ç:**
  - **units_of_measure** + API `/api/units`
  - ╪º┘å╪¿╪º╪▒ ╪»┘ê ┘ê╪º╪¡╪»█î (┌⌐╪º╪▒┌»╪º┘ç/╪»┘ü╪¬╪▒ ╪¬┘ê╪▓█î╪╣) ╪¿╪º entity ┘ê warehouse_type
  - UI **╪º╪┤╪«╪º╪╡ █î┌⌐┘╛╪º╪▒┌å┘ç** (`acc-parties`) + ┘à╪«┘ü█îΓÇî╪│╪º╪▓█î ┘à┘å┘ê█î ┘à╪¡┌⌐ ╪»╪▒ ╪¡╪º┘ä╪¬ standard
  - hotfix: `currency.js`, `party-groups.js`, `cheque-records.js` ╪¿╪▒╪º█î boot ╪│╪▒┘ê╪▒
- **Deploy:** Γ£à production (`475aafb` ΓÇö health 200)

### █▒█┤█░█┤/█░█┤/█▓█┤ ΓÇö [Cursor] ┘ü╪º╪▓ █▒ ┘à╪º┌ÿ┘ê┘ä ╪¡╪│╪º╪¿╪»╪º╪▒█î (┘╛╪º█î┘ç + parties + dashboard)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `b5776d7`, `710bf84`
- **Deploy:** Γ£à production
- **╪«┘ä╪º╪╡┘ç:**
  - ┘à╪┤╪«╪╡╪º╪¬ ╪¬╪╖╪¿█î┘éΓÇî█î╪º┘ü╪¬┘ç: `docs/ACCOUNTING-MODULE-SPEC-ADAPTED.md` (╪▒█î╪º┘ä INTEGER╪î ╪¡╪░┘ü ┘à╪¡┌⌐╪î ╪º╪»╪║╪º┘à parties)
  - ╪¼╪»┘ê┘ä **`parties`** + dual-write ╪º╪▓ customers/suppliers
  - **`detail_accounts`** / **`detail_categories`** (┌⌐╪»█î┘å┌» ╪│╪╖╪¡ █┤)
  - ┘à┘ê╪¬┘ê╪▒ **`postToLedger`**, **`integrity-check`**, API **`/api/dashboard/*`**
  - ╪▒┘ü╪╣ ╪¿╪º┌» CoA (5101/3201) + soft-delete ╪»╪▒ ╪¬╪▒╪º╪▓ ╪ó╪▓┘à╪º█î╪┤█î
  - ┘à╪▒╪º┌⌐╪▓ ┘ç╪▓█î┘å┘ç seed: ┌⌐╪º╪▒┌»╪º┘ç ┘å┘ê╪¿╪▒╪¬ / ╪»┘ü╪¬╪▒ ╪¬┘ê╪▓█î╪╣ ┌⌐█î┘à█î╪º
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/db.js`, `server/lib/ledger.js`, `server/routes/parties.js`, `server/routes/dashboard.js`

### █▒█┤█░█┤/█░█┤/█▓█╕ ΓÇö [Cursor] ╪¬┌⌐┘à█î┘ä UI/┘ü█î┘ä╪»┘ç╪º█î ┘à╪¡┌⌐ + ╪»┘ü╪¬╪▒ ┌å┌⌐ + enrich pipeline
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ╪¿╪»┘ê┘å commit
- **╪«┘ä╪º╪╡┘ç:**
  - **╪»┘ü╪¬╪▒ ┌å┌⌐ ┘à╪¡┌⌐** (`acc-mahak-cheques`): ┘ä█î╪│╪¬ ┌å┌⌐ΓÇî┘ç╪º█î ╪»╪▒█î╪º┘ü╪¬█î/┘╛╪▒╪»╪º╪«╪¬█î ╪º╪▓ `full data.xlsx` + ┘ê█î╪▒╪º█î╪┤ ┘ê╪╢╪╣█î╪¬
  - **┘ü╪▒┘àΓÇî┘ç╪º█î ┘à╪¡┌⌐:** ┘ü█î┘ä╪»┘ç╪º█î ╪º╪┤╪«╪º╪╡/┘ü╪▒┘ê╪┤┘å╪»┘ç/╪┤╪«╪╡/╪¿╪º┘å┌⌐ ╪»╪▒ UI + ╪░╪«█î╪▒┘ç ╪»╪▒ API
  - **┌»╪▒┘ê┘çΓÇî┘ç╪º█î ╪º╪┤╪«╪º╪╡ ┘ê ┌⌐╪º┘ä╪º** ╪»╪▒ ┘à┘å┘ê█î ╪¡╪│╪º╪¿╪»╪º╪▒█î + `party_groups` / `product_categories`
  - **`import-mahak-full-data.js`** + ┘ü╪º╪▓ █╡ ╪»╪▒ `mahak-go-live.js` + `mahak-enrich-production.js`
  - ╪│╪¬┘ê┘å **╪│┘å╪» ┘à╪¡┌⌐** ╪»╪▒ ╪¿╪▒┌»╪┤╪¬ ┘ü╪▒┘ê╪┤/╪«╪▒█î╪»╪î ┘ü╪º┌⌐╪¬┘ê╪▒╪î ╪»╪▒█î╪º┘ü╪¬╪î ╪º┘å╪¿╪º╪▒
  - SW ΓåÆ **v32**
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/scripts/import-mahak-full-data.js`, `server/scripts/mahak-enrich-production.js`, `server/lib/currency.js`, `server/routes/cheque-records.js`, `server/routes/party-groups.js`
- **Deploy:** ΓÅ│ ┘å█î╪º╪▓ ╪¿┘ç push + pull ╪▒┘ê█î ╪│╪▒┘ê╪▒

### █▒█┤█░█┤/█░█┤/█▓█╕ ΓÇö [Cursor] ╪¬┌⌐┘à█î┘ä ╪¿╪º╪▓╪│╪º╪▓█î ΓÇö █▒█╡█│█░/█▒█╡█│█░ ╪│┘å╪» ┘à╪¬╪╡┘ä
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `25094b0`
- **╪«┘ä╪º╪╡┘ç:** ┘╛╪▒╪»╪º╪«╪¬/╪»╪▒█î╪º┘ü╪¬ ┌å┌⌐█î╪î ╪º█î╪¼╪º╪» ╪«┘ê╪»┌⌐╪º╪▒ ┘à╪┤╪¬╪▒█î╪î ╪º╪¬╪╡╪º┘ä █▒█░█░┘¬ ╪º╪│┘å╪º╪»: █▓█░█╕ ┘ü╪º┌⌐╪¬┘ê╪▒╪î █▒█╖█╣ ╪»╪▒█î╪º┘ü╪¬╪î █│█╣ ╪«╪▒█î╪»╪î █▓█╕█╖ ┘╛╪▒╪»╪º╪«╪¬ ╪¬╪ú┘à█î┘å╪î █▓█▓█┤ ┘ç╪▓█î┘å┘ç╪î █▒█▒█╕ ╪¡┘ê╪º┘ä┘ç/╪▒╪│█î╪» ╪º┘å╪¿╪º╪▒.
- **Deploy:** Γ£à production

### █▒█┤█░█┤/█░█┤/█▓█╕ ΓÇö [Cursor] ╪¿╪º╪▓╪│╪º╪▓█î ╪º╪│┘å╪º╪» ╪╣┘à┘ä█î╪º╪¬█î ┘à╪¡┌⌐ (┘ü╪▒┘ê╪┤/╪«╪▒█î╪»/╪º┘å╪¿╪º╪▒/╪»╪▒█î╪º┘ü╪¬/┘╛╪▒╪»╪º╪«╪¬)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `66664aa`
- **╪«┘ä╪º╪╡┘ç:** `import-mahak-documents.js` ΓÇö █▓█░█╢ ┘ü╪º┌⌐╪¬┘ê╪▒ ┘ü╪▒┘ê╪┤╪î █▒█╡█│ ╪»╪▒█î╪º┘ü╪¬╪î █│█╣ ╪«╪▒█î╪»╪î █▓█╕█╣ ┘╛╪▒╪»╪º╪«╪¬ ╪¬╪ú┘à█î┘å╪î █▓█▓█┤ ┘ç╪▓█î┘å┘ç╪î █▒█▒█╕ ╪¡┘ê╪º┘ä┘ç/╪▒╪│█î╪» ╪º┘å╪¿╪º╪▒╪î █╡ ╪º┘å╪¬┘é╪º┘ä ╪¿╪º┘å┌⌐█î╪¢ ╪º╪¬╪╡╪º┘ä █▒█░█│█▓ ╪│┘å╪» ╪¡╪│╪º╪¿╪»╪º╪▒█î ╪¿┘ç `ref_type` ╪╣┘à┘ä█î╪º╪¬█î.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/scripts/import-mahak-documents.js`, `server/lib/mahak-import-helpers.js`, `server/scripts/mahak-classify-vouchers.js`
- **Deploy:** Γ£à production ΓÇö ┘ê╪▒┘ê╪»: `admin`/`admin123`

### █▒█┤█░█┤/█░█┤/█▓█╕ ΓÇö [Cursor] import ┘à╪¡┌⌐: ┘à╪┤╪¬╪▒█î╪î ╪¬╪ú┘à█î┘åΓÇî┌⌐┘å┘å╪»┘ç╪î ╪»╪│╪¬┘çΓÇî╪¿┘å╪»█î ┌⌐╪º┘ä╪º
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `104e8bd`
- **╪«┘ä╪º╪╡┘ç:** ╪¬╪¡┘ä█î┘ä ╪╣┘à█î┘é ╪▒┘ê╪▓┘å╪º┘à┘ç + ┌⌐╪»█î┘å┌»╪¢ ╪º█î╪¼╪º╪» **█╕█╡ ┘à╪┤╪¬╪▒█î** ┘ê **█╖█░ ╪¬╪ú┘à█î┘åΓÇî┌⌐┘å┘å╪»┘ç** ╪º╪▓ ╪º╪┤╪«╪º╪╡ ┘à╪¡┌⌐ ╪¿╪º `coa_code` ┘ê ┘à╪º┘å╪»┘ç ╪º╪▓ ┌»╪▒╪»╪┤ ╪¡╪│╪º╪¿╪¢ ╪»╪│╪¬┘çΓÇî╪¿┘å╪»█î ┘à┘ê╪º╪» ╪º┘ê┘ä█î┘ç/┘à╪¡╪╡┘ê┘ä ┘å┘ç╪º█î█î╪¢ `mahak-analyze.js` + `mahak-import-helpers.js`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/scripts/import-mahak-journal.js`, `server/lib/mahak-import-helpers.js`, `server/scripts/mahak-analyze.js`
- **Deploy:** Γ£à production ΓÇö ┘ê╪▒┘ê╪»: `admin`/`admin123`
- **█î╪º╪»╪»╪º╪┤╪¬:** █▒█╡█│█░ ╪│┘å╪»╪î █╡█╣█░█╡ ╪ó╪▒╪¬█î┌⌐┘ä╪î █╡█▓█│ ┌⌐╪º┘ä╪º╪î █╖█▒┘¼█╕█│█▒ ┘à┘ê╪¼┘ê╪»█î ΓÇö ╪¬╪▒╪º╪▓ █╡█░┘¼█╣█╣█╕┘¼█╢█┤█│┘¼█╕█╕█╣ ╪¬┘ê┘à╪º┘å

### █▒█┤█░█┤/█░█┤/█▓█╖ ΓÇö [Cursor] go-live ┘à╪¡┌⌐ ╪º╪▓ ╪╡┘ü╪▒ (╪│┘ç ┘ü╪º█î┘ä Excel)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `3866833`
- **╪«┘ä╪º╪╡┘ç:** `mahak-go-live.js` ΓÇö wipe + import journal + stock. production: █▒█╡█│█░ ╪│┘å╪»╪î █╡█╣█░█╡ ╪ó╪▒╪¬█î┌⌐┘ä╪î █▒┘¼█▒█▓█┤ ╪¡╪│╪º╪¿╪î █╡█▓█│ ┌⌐╪º┘ä╪º╪î █╖█▒┘¼█╕█│█▒ ┘à┘ê╪¼┘ê╪»█î╪î `coa_mode=mahak`, ╪¬╪▒╪º╪▓ █╡█░┘¼█╣█╣█╕┘¼█╢█┤█│┘¼█╕█╕█╣ ╪¬┘ê┘à╪º┘å.
- **Deploy:** Γ£à ΓÇö ┘ê╪▒┘ê╪»: `admin`/`admin123`
- **█î╪º╪»╪»╪º╪┤╪¬:** ┘à╪┤╪¬╪▒█î╪º┘å CRM=█░ (╪º╪┤╪«╪º╪╡ ┘à╪¡┌⌐ ┘ü┘é╪╖ ╪¡╪│╪º╪¿ ╪¬┘ü╪╡█î┘ä█î ╪»╪▒ ┌⌐╪»█î┘å┌»)

### █▒█┤█░█┤/█░█┤/█▓█╖ ΓÇö [Cursor] ╪▒┘ü╪╣ ╪«╪╖╪º█î ╪»╪º╪«┘ä█î ╪│╪▒┘ê╪▒ + ╪¬┘ä╪º╪┤ ╪¿╪º╪▓█î╪º╪¿█î ┘à╪¡┌⌐
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `b4e6d0d`
- **╪«┘ä╪º╪╡┘ç:**
  - **╪«╪╖╪º█î ╪»╪º╪«┘ä█î:** `notifications.js` ╪¼╪»┘ê┘ä ╪º╪┤╪¬╪¿╪º┘ç `rep_payments` ΓåÆ `rep_payment_submissions` ΓÇö ╪▒┘ü╪╣ ┘ê deploy ╪┤╪».
  - **┌⌐╪»█î┘å┌»/╪º╪│┘å╪º╪» ┘à╪¡┌⌐ ┘å█î╪│╪¬:** ╪¿╪▒╪º█î ╪▒┘ü╪╣ 502 DB ╪¿┘ç pre-mahak ╪¿╪▒┌»╪┤╪¬╪¢ import ┘à╪¡┌⌐ (█▒█╡█│█░ ╪│┘å╪») ╪»╪▒ `crm.db.corrupted-` ╪¿┘ê╪»╪î `.recover` ┘å╪º┘à┘ê┘ü┘é.
  - **DB ┘ü╪╣┘ä█î:** integrity ok╪î `journal_entries=42`╪î `mahak=0` ΓÇö ╪º┌⌐╪│┘ä ┘à╪¡┌⌐ ╪▒┘ê█î ╪│╪▒┘ê╪▒ █î╪º┘ü╪¬ ┘å╪┤╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/routes/notifications.js`, `server/scripts/recover-production-db.sh`
- **Deploy:** Γ£à pull + pm2 restart
- **█î╪º╪»╪»╪º╪┤╪¬:** `coding_hesbha.xlsx` + `daftar_roznameh.xlsx` (+ `mojodi.xlsx`) ╪▒╪º ╪▒┘ê█î ╪│╪▒┘ê╪▒ ╪¿┌»╪░╪º╪▒█î╪» ΓåÆ `import-mahak-journal.js`

- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `57f5544`
- **╪«┘ä╪º╪╡┘ç:**
  - **╪▒█î╪┤┘ç 502:** `crm.db` ╪«╪▒╪º╪¿ (`SQLITE_CORRUPT: database disk image is malformed`) ΓÇö PM2 ╪¿█î╪┤ ╪º╪▓ █╡█▒┘¼█░█░█░ ╪¿╪º╪▒ restart ΓåÆ ┘╛┘ê╪▒╪¬ 3000 ╪¿╪º┘ä╪º ┘å┘à█îΓÇî╪ó┘à╪» ΓåÆ nginx/Chrome 502.
  - **╪▒┘ü╪╣ production:** ╪¿╪º╪▓█î╪º╪¿█î DB ╪º╪▓ `crm-pre-mahak.db` (integrity ok) + `pm2 restart` ΓåÆ `http://45.90.98.99:3000` ┘ê `/api/system/health` ┘ç╪▒ ╪»┘ê **200**.
  - **APK:** ┘ü╪º█î┘ä ╪«╪▒╪º╪¿/partial (`apk.part0`/`apk.part1` ~█╢MB) ┘ê `erp-taranom.apk` ╪º╪▓ `/releases/` ╪│╪▒┘ê╪▒ ╪¡╪░┘ü ╪┤╪».
  - **╪│█î╪º╪│╪¬ ╪¼╪»█î╪»:** APK ┘ü┘é╪╖ build ┘à╪¡┘ä█î ΓÇö `release.ps1`╪î `finalize-android-release.ps1`╪î `deploy-production.sh`╪î `android/BUILD.md`╪î `CLAUDE.md` ╪¿┘çΓÇî╪▒┘ê╪▓ ╪┤╪»╪¢ `manifest.json` ╪º┘å╪»╪▒┘ê█î╪» `url: ""` + `distribution: local`╪¢ `app-update.js` ╪¿╪»┘ê┘å URL ╪ó┘╛╪»█î╪¬ ╪º╪╣┘ä╪º┘à ┘å┘à█îΓÇî┌⌐┘å╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `scripts/release.ps1`, `scripts/finalize-android-release.ps1`, `scripts/deploy-production.sh`, `scripts/generate-release.js`, `scripts/check-db-integrity.js`, `server/lib/app-update.js`, `server/public/releases/manifest.json`, `android/BUILD.md`, `CLAUDE.md`
- **Deploy:** Γ£à DB ╪¿╪º╪▓█î╪º╪¿█î + ╪│╪▒┘ê╪▒ ╪ó┘å┘ä╪º█î┘å ΓÇö ΓÅ│ `git pull` ╪¿╪▒╪º█î manifest/╪º╪│┌⌐╪▒█î┘╛╪¬ΓÇî┘ç╪º█î ╪¼╪»█î╪»
- **█î╪º╪»╪»╪º╪┤╪¬:** ┘à┘ç╪º╪¼╪▒╪¬ ┘à╪¡┌⌐ (█▒█╢:█▓█┤) ╪º╪¡╪¬┘à╪º┘ä╪º┘ï DB ╪▒╪º ╪«╪▒╪º╪¿ ┌⌐╪▒╪» ΓÇö ╪»╪º╪»┘ç┘ö post-mahak ╪»╪▒ `crm.db.corrupted` ╪¿╪º┘é█î ╪º╪│╪¬╪¢ mahak ╪▒╪º ╪»┘ê╪¿╪º╪▒┘ç ╪¿╪º ╪º╪¡╪¬█î╪º╪╖ ╪º╪¼╪▒╪º ┌⌐┘å█î╪».

### █▒█┤█░█┤/█░█┤/█▓█╖ ΓÇö [Cursor] ╪▒┘ü╪╣ ╪¿┘å█î╪º╪»█î ╪º┘å╪»╪▒┘ê█î╪» 2.0.9 ΓÇö ╪¿┘ê╪¬ ┘é╪º╪¿┘äΓÇî╪º╪╣╪¬┘à╪º╪» ╪▒┘ê█î ╪│╪º┘à╪│┘ê┘å┌»/┘å┘ê┌⌐█î╪º
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ┬½╪¿╪»┘ê┘å commit┬╗
- **╪«┘ä╪º╪╡┘ç:**
  - **MainActivity:** WebView ╪│╪º╪▓┌»╪º╪▒ (mixed content╪î database╪î safe browsing off)╪î WebChromeClient/WebViewClient ╪¿╪º ┘å┘à╪º█î╪┤ ╪«╪╖╪º╪î ╪º╪│┘╛┘ä╪┤ ┘╛█î╪┤╪▒┘ü╪¬┘ç ╪»╪▒ ╪º╪│╪¬╪«╪▒╪º╪¼ assets╪î ╪º╪╣╪¬╪¿╪º╪▒╪│┘å╪¼█î projectIsValid╪î health poll ╪¿┘ç `/api/system/health` + `server.ready`╪î ┘å┘à╪º█î╪┤ boot.log ╪»╪▒ ╪╡┘ü╪¡┘ç ╪«╪╖╪º╪î Node ╪»╪▒ thread ╪¼╪»╪º.
  - **main.js:** fallback ╪¿┘ç╪¬╪▒ better-sqlite3 ╪¿╪▒╪º█î ┘ç┘à┘ç ABI┘ç╪º╪î `LISTEN_HOST=127.0.0.1`╪î ┘å╪│╪«┘ç 2.0.9.
  - **server.js:** endpoint `/api/system/health` + ┘å┘ê╪┤╪¬┘å `server.ready` ╪¿╪▒╪º█î ╪º┘å╪»╪▒┘ê█î╪».
  - **index.html:** ╪║█î╪▒┘ü╪╣╪º┘äΓÇî╪│╪º╪▓█î Service Worker ╪»╪▒ WebView ╪º┘å╪»╪▒┘ê█î╪» (╪╣┘ä╪¬ cache/hang)╪î ╪▒╪º┘ç┘å┘à╪º ╪¿┘çΓÇî╪▒┘ê╪▓.
  - **Build:** AGP 8.5.2 + Gradle 8.7 + mirror Aliyun (╪»╪│╪¬╪▒╪│█î Google Maven)╪î NDK 25.1.8937393╪î prune node_modules.
  - **APK 2.0.9** (versionCode 11) ╪│╪º╪«╪¬┘ç ┘ê **█▓█│/█▓█│ assertion ╪│╪¿╪▓** ΓÇö 60MB SHA256 `C4C5F47EΓÇª`
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `MainActivity.java`, `main.js`, `server.js`, `index.html`, `android/build.gradle`, `settings.gradle`, `manifest.json`, `scripts/build-android.ps1`, `scripts/test-android-apk.ps1`
- **Commit:** `3fec142`
- **Deploy:** Γ£à ┌⌐╪» + manifest ╪▒┘ê█î ╪│╪▒┘ê╪▒ (`git pull` + `pm2 restart`) ΓÇö ΓÅ│ APK 2.0.9 ┘ç┘å┘ê╪▓ hash ┘é╪»█î┘à█î ╪▒┘ê█î ╪│╪▒┘ê╪▒╪¢ scp/sftp ┘é╪╖╪╣ ┘à█îΓÇî╪┤┘ê╪» ΓÇö ╪ó┘╛┘ä┘ê╪» ┘à╪¡┘ä█î ┘ä╪º╪▓┘à
- **█î╪º╪»╪»╪º╪┤╪¬ ┘å╪╡╪¿:** ┌⌐╪º╪▒╪¿╪▒╪º┘å ╪¿╪º█î╪» **┘å╪│╪«┘ç ┘é╪¿┘ä█î ╪▒╪º ╪¡╪░┘ü** ┘ê APK 2.0.9 ╪▒╪º ╪¬╪º╪▓┘ç ┘å╪╡╪¿ ┌⌐┘å┘å╪». ╪º┘ê┘ä█î┘å ╪¿╪º╪▓ ┌⌐╪▒╪»┘å █▓ΓÇô█╡ ╪»┘é█î┘é┘ç ╪╖┘ê┘ä ┘à█îΓÇî┌⌐╪┤╪».

- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `79a44f7` (+ debug-sign fallback ╪»╪▒ `android/app/build.gradle`)
- **╪«┘ä╪º╪╡┘ç:**
  - APK **2.0.8** (┌⌐╪» 1.0.11) ╪º┘à╪╢╪º ┘ê ╪º╪╣╪¬╪¿╪º╪▒╪│┘å╪¼█î ╪┤╪» ΓÇö **█▒█╖/█▒█╖ assertion ╪│╪¿╪▓** (`test-android-apk.ps1`).
  - manifest ╪º┘å╪»╪▒┘ê█î╪» ΓåÆ `2.0.8` / versionCode `10`╪¢ APK ╪▒┘ê█î `/releases/erp-taranom.apk` (~62MB).
  - API ╪ó┘╛╪»█î╪¬: `2.0.7 ΓåÆ 2.0.8` ┘ü╪╣╪º┘ä.
  - ╪▒┌»╪▒╪│█î┘ê┘å: SMS 22/22╪î barcode 12/12╪î fiscal-year 4/4.
  - `android/build.gradle`: `maven.google.com` ╪¿╪▒╪º█î AGP╪¢ `android/app/build.gradle`: fallback ╪º┘à╪╢╪º█î debug ╪º┌»╪▒ keystore ┘å╪¿╪º╪┤╪».
  - **┘à┘ç╪º╪¼╪▒╪¬ ┘à╪¡┌⌐ go-live:** ┘ü╪º█î┘äΓÇî┘ç╪º█î Excel ┘à╪¡┘ä█î █î╪º┘ü╪¬ ┘å╪┤╪» ΓÇö ╪»╪│╪¬ ┘à╪º┘ä┌⌐ (`docs/MAHAK-MIGRATION.md` ┬º█╡).
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/releases/manifest.json`, `android/build.gradle`, `android/app/build.gradle`, `server/public/index.html`
- **Deploy:** Γ£à scp APK + manifest + git pull + pm2 restart

### █▒█┤█░█┤/█░█┤/█▓█╢ ΓÇö [Cursor] ╪º┘å╪¬╪┤╪º╪▒ ┘å┘ç╪º█î█î 1.0.11 ΓÇö installer ╪»╪│┌⌐╪¬╪º┘╛ ╪│╪º╪«╪¬┘ç + deploy
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `dc97a18`
- **╪«┘ä╪º╪╡┘ç:**
  - **╪»╪│┌⌐╪¬╪º┘╛:** `ERP-Taranom-Setup-1.0.11.exe` (~93MB) ╪¿╪º electron-builder ╪│╪º╪«╪¬┘ç ╪┤╪» ΓÇö ╪┤╪º┘à┘ä ┘ç┘à┘ç ╪¬╪║█î█î╪▒╪º╪¬ 1.0.11 + Mahak phase 2 UI.
  - **manifest.json + latest.yml** ╪¿┘ç 1.0.11 ╪¿┘çΓÇî╪▒┘ê╪▓ ╪┤╪»╪¢ installer ╪▒┘ê█î `/releases/` ╪ó┘╛┘ä┘ê╪» ╪┤╪».
  - **╪º┘å╪»╪▒┘ê█î╪»:** APK release ╪¿╪º ┌⌐╪» ╪¼╪»█î╪» ╪│╪º╪«╪¬┘ç ╪┤╪» (`app-release-unsigned.apk` ~62MB) ΓÇö ╪¿╪»┘ê┘å `android/keystore.properties` ╪º┘à╪╢╪º ┘å╪┤╪»╪¢ manifest ╪º┘å╪»╪▒┘ê█î╪» ┘ü╪╣┘ä╪º┘ï 2.0.7 ┘à╪º┘å╪» ╪¬╪º ╪º┘à╪╢╪º ╪┤┘ê╪».
  - **build-android.ps1:** ┘╛╪┤╪¬█î╪¿╪º┘å█î ╪º╪▓ `app-release-unsigned.apk` + ╪º┘à╪╢╪º█î ╪«┘ê╪»┌⌐╪º╪▒ ╪º┌»╪▒ keystore ┘à┘ê╪¼┘ê╪» ╪¿╪º╪┤╪».
  - ╪▒╪º┘ç┘å┘à╪º: ╪¿╪«╪┤ ┬½╪¿┘çΓÇî╪▒┘ê╪▓╪▒╪│╪º┘å█î ╪»╪│┌⌐╪¬╪º┘╛ 1.0.11┬╗ ╪º╪╢╪º┘ü┘ç ╪┤╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `desktop/package.json`, `desktop/dist/`, `server/public/releases/{manifest.json,latest.yml}`, `scripts/build-android.ps1`, `server/public/index.html`
- **Deploy:** Γ£à installer ╪ó┘╛┘ä┘ê╪» + git pull + pm2 restart ΓÇö API ╪ó┘╛╪»█î╪¬: 1.0.10ΓåÆ1.0.11
- **█î╪º╪»╪»╪º╪┤╪¬ ╪º┘å╪»╪▒┘ê█î╪»:** `android/keystore.properties` ╪¿╪│╪º╪▓█î╪» ΓåÆ `scripts/build-android.ps1` ΓåÆ scp `erp-taranom.apk` ΓåÆ manifest android ╪▒╪º 2.0.8/10 ┌⌐┘å█î╪».

### █▒█┤█░█┤/█░█┤/█▓█╢ ΓÇö [Cursor] ╪¬┌⌐┘à█î┘ä UI ┘ü╪º╪▓ █▓ ┘à╪¡┌⌐ + deploy production
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `3218acd`
- **╪«┘ä╪º╪╡┘ç:**
  - **┘╛┘å┘ä ┬½ΓÜÖ∩╕Å ┘å┌»╪º╪┤╪¬ ┌⌐╪»█î┘å┌»┬╗** ╪»╪▒ ╪¬┘å╪╕█î┘à╪º╪¬: ┘ê█î╪▒╪º█î╪┤ █▒█▓ ┌⌐┘ä█î╪» coa_* + checkbox ╪│┘å╪» COGS╪¢ `saveSettings()` ╪░╪«█î╪▒┘ç ┘à█îΓÇî┌⌐┘å╪»╪¢ `clearCoaCache()` ╪¿╪╣╪» ╪º╪▓ PUT.
  - **┘ü╪▒┘àΓÇî┘ç╪º:** ┘å┘à╪º█î╪┤ readonly ┌⌐╪» ╪¬┘ü╪╡█î┘ä█î + ╪»┌⌐┘à┘ç ┬½≡ƒöù ╪º╪¬╪╡╪º┘ä ╪¿┘ç ╪¡╪│╪º╪¿ ┘à┘ê╪¼┘ê╪»┬╗ ╪¿╪▒╪º█î ┘à╪┤╪¬╪▒█î/┘à╪¡╪╡┘ê┘ä/╪¬╪ú┘à█î┘åΓÇî┌⌐┘å┘å╪»┘ç/╪¿╪º┘å┌⌐/╪╡┘å╪»┘ê┘é╪¢ API ╪¼╪»█î╪» `PATCH /accounting/link-coa`.
  - **┌⌐╪»█î┘å┌»:** ╪│╪¬┘ê┘åΓÇî┘ç╪º█î ╪│╪╖╪¡/┘à╪º┘ç█î╪¬/┘å┘ê╪╣ ╪¬┘ü╪╡█î┘ä█î ╪»╪▒ ╪¼╪»┘ê┘ä COA.
  - **╪│╪º┘ä ┘à╪º┘ä█î:** Factory Reset ╪»╪▒ `coa_mode=mahak` █î╪º ╪¿╪º ╪º╪│┘å╪º╪» `src_system=mahak` ┘à╪│╪»┘ê╪» ╪┤╪».
  - **`coa_mode`** ╪»╪▒ `/settings/modules` ╪¿╪▒╪º█î ┌⌐╪º╪▒╪¿╪▒╪º┘å ╪¡╪│╪º╪¿╪»╪º╪▒█î (╪¿╪»┘ê┘å ╪»╪│╪¬╪▒╪│█î ┌⌐╪º┘à┘ä ╪¬┘å╪╕█î┘à╪º╪¬).
  - **`test-mahak-phase2.js`:** handle `must_change_password` ╪¿╪╣╪» ╪º╪▓ login.
  - SW ΓåÆ **v30**╪¢ ╪▒╪º┘ç┘å┘à╪º ╪¿┘çΓÇî╪▒┘ê╪▓.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/public/sw.js`, `server/routes/{settings,accounting,fiscal-year}.js`, `server/scripts/test-mahak-phase2.js`
- **Deploy:** Γ£à pull + pm2 restart (`3218acd` ╪▒┘ê█î `45.90.98.99`)
- **█î╪º╪»╪»╪º╪┤╪¬:** go-live ╪»█î╪¬╪º╪¿█î╪│ ┘à╪¡┌⌐ (importer ╪▒┘ê█î ╪│╪▒┘ê╪▒) ┘ç┘å┘ê╪▓ ╪»╪│╪¬ ┘à╪º┘ä┌⌐ ΓÇö ╪╖╪¿┘é `docs/MAHAK-MIGRATION.md` ╪¿╪«╪┤ █╡.

### █▒█┤█░█┤/█░█┤/█▓█╢ ΓÇö [Claude Code] Γ£à ┘ü╪º╪▓ █▓ ┘à┘ç╪º╪¼╪▒╪¬ ┘à╪¡┌⌐ ┌⌐╪º┘à┘ä ╪┤╪» ΓÇö ╪╣┘à┘ä█î╪º╪¬ ╪¼╪º╪▒█î ╪▒┘ê█î ┌⌐╪»█î┘å┌» ┘à╪¡┌⌐ + COGS ╪«┘ê╪»┌⌐╪º╪▒ (█▒█┤/█▒█┤ ╪¬╪│╪¬ E2E ╪│╪¿╪▓)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ┘ç┘à█î┘å ┌⌐╪º┘à█î╪¬
- **╪«┘ä╪º╪╡┘ç:**
  - **╪¬╪▓╪▒█î┘é coa-map ╪¿┘ç ╪╣┘à┘ä█î╪º╪¬ ╪¼╪º╪▒█î:** ┘ü╪º┌⌐╪¬┘ê╪▒ (╪»╪▒█î╪º┘ü╪¬┘å█î/┘ü╪▒┘ê╪┤/╪¬╪«┘ü█î┘ü + ╪º╪¿╪╖╪º┘ä + ╪¬╪¿╪»█î┘ä)╪î ╪»╪▒█î╪º┘ü╪¬ΓÇî┘ç╪º (█┤ ╪│╪º█î╪¬ 1103 ╪»╪▒ accounting.js ΓåÆ ╪¬┘ü╪╡█î┘ä█î ┘à╪┤╪¬╪▒█î)╪î ╪«╪▒█î╪» (┘╛╪▒╪»╪º╪«╪¬┘å█î ╪¬╪ú┘à█î┘åΓÇî┌⌐┘å┘å╪»┘ç/┘à┘ê╪¼┘ê╪»█î╪î █╖ ╪│╪º█î╪¬)╪î ╪¡┘é┘ê┘é (█╖█░█▒/█▓█░█┤/501)╪î ┘ê `resolveCashAccount` ΓåÆ ╪º┘ê┘ä `coa_code` ╪¿╪º┘å┌⌐/╪╡┘å╪»┘ê┘é. ┘ç┘à┘ç backward-compatible: ╪¿╪»┘ê┘å coa_mode=mahak ╪▒┘ü╪¬╪º╪▒ ┘é╪»█î┘à█î ╪╣█î┘å╪º┘ï ╪¡┘ü╪╕ (fallback ╪¿┘ç 1103/2101/...).
  - **╪│┘å╪» COGS ╪«┘ê╪»┌⌐╪º╪▒ (╪¬╪╡┘à█î┘à █╕):** `postCogsVoucher` ╪»╪▒ invoices.js ΓÇö ┘ü╪º┌⌐╪¬┘ê╪▒ ╪▒╪│┘à█î: Dr ╪¿┘ç╪º█î ╪¬┘à╪º┘àΓÇî╪┤╪»┘ç (801) / Cr ╪¬┘ü╪╡█î┘ä█î ┘ç╪▒ ┌⌐╪º┘ä╪º╪¢ ╪»╪▒ ╪º╪¿╪╖╪º┘ä ┘ê ╪¬╪¿╪»█î┘ä ┘╛█î╪┤ΓÇî┘ü╪º┌⌐╪¬┘ê╪▒ ┘ç┘à ╪»┘é█î┘é╪º┘ï ┘à╪╣┌⌐┘ê╪│/╪½╪¿╪¬. ┘ü┘é╪╖ mahak-mode + `feature_cogs_voucher=1`.
  - **╪¬┘ü╪╡█î┘ä█îΓÇî╪│╪º╪▓ ╪«┘ê╪»┌⌐╪º╪▒ (`allocTafsili` ╪»╪▒ coa-map):** ┘à╪┤╪¬╪▒█î/╪¬╪ú┘à█î┘åΓÇî┌⌐┘å┘å╪»┘ç/┘à╪¡╪╡┘ê┘ä (┘ç╪▒ ╪»┘ê ┘à╪│█î╪▒ ╪│╪º╪«╪¬)/╪¿╪º┘å┌⌐/╪╡┘å╪»┘ê┘é ╪¼╪»█î╪» ΓåÆ ╪¡╪│╪º╪¿ ╪¬┘ü╪╡█î┘ä█î █▒█▓╪▒┘é┘à█î ╪▓█î╪▒ ┘à╪╣█î┘å ┘å┌»╪º╪┤╪¬ΓÇî╪┤╪»┘ç (╪┤┘à╪º╪▒┘ç ╪º╪▓ MAX ╪│╪▒╪º╪│╪▒█î+1).
  - ┌⌐┘ä█î╪»┘ç╪º█î `coa_*` ┘ê `feature_cogs_voucher` ╪¿┘ç ALLOWED_KEYS ╪¬┘å╪╕█î┘à╪º╪¬ ╪º╪╢╪º┘ü┘ç ╪┤╪».
  - **╪¬╪│╪¬:** `scripts/test-mahak-phase2.js` ╪¼╪»█î╪» ΓÇö E2E ╪▒┘ê█î ┌⌐┘╛█î DB ┘ê╪º┘é╪╣█î ┘à╪¡┌⌐: **█▒█┤/█▒█┤ ╪│╪¿╪▓** (╪¬┘ü╪╡█î┘ä█î ┘à╪┤╪¬╪▒█î 203004960031╪î ╪│┘å╪» ┘ü╪▒┘ê╪┤ ╪▒┘ê█î 601╪î COGS ╪¿╪º ┘à╪¿┘ä╪║ cost├ùqty╪î ╪»╪▒█î╪º┘ü╪¬ ╪¿┘ç ╪¬┘ü╪╡█î┘ä█î ╪╡┘å╪»┘ê┘é 206003500001╪î ╪º╪¿╪╖╪º┘ä ┘à╪╣┌⌐┘ê╪│╪î ╪¬╪▒╪º╪▓ ┘à╪¬┘ê╪º╪▓┘å ╪»╪▒ ┘ç╪▒ ┘à╪▒╪¡┘ä┘ç). ╪▒┌»╪▒╪│█î┘ê┘å: SMS **22/22** + Sync **33/33** ╪│╪¿╪▓. ╪▒╪º┘ç┘å┘à╪º█î ╪º╪»┘à█î┘å ╪¿╪«╪┤ ┬½╪¡╪º┘ä╪¬ ┌⌐╪»█î┘å┌» ┘à╪¡┌⌐┬╗ + SW ΓåÆ `v29`.
  - ┘å┌⌐╪¬┘ç ╪¿╪º╪▓ (cosmetic): ┘å╪º┘à ╪¡╪│╪º╪¿ΓÇî┘ç╪º█î ╪│╪╖╪¡ █│ ╪│╪º╪«╪¬┘çΓÇî╪┤╪»┘ç ╪¬┘ê╪│╪╖ importer ┌»╪º┘ç█î ╪º╪▓ ╪┤█î╪¬ ┘à╪╣█î┘å┘É ┘ç┘àΓÇî┌⌐╪» ╪º╪┤╪¬╪¿╪º┘ç ╪¿╪▒╪»╪º╪┤╪¬┘ç ┘à█îΓÇî╪┤┘ê╪» (┌⌐╪» ╪»╪▒╪│╪¬ ╪º╪│╪¬╪î ┘ü┘é╪╖ ╪¿╪▒┌å╪│╪¿) ΓÇö ╪º╪╡┘ä╪º╪¡ ╪»╪▒ ╪º╪¼╪▒╪º█î ╪¿╪╣╪»█î importer.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/coa-map.js`, `server/routes/{invoices,accounting,purchases,payroll,customers,suppliers,products,banks,cash-boxes,settings}.js`, `server/db.js`, `server/scripts/test-mahak-phase2.js`, `server/public/{index.html,sw.js}`
- **Deploy:** ΓÅ│ pull + pm2 restart (┌⌐╪»)╪¢ **go-live ╪»█î╪¬╪º╪¿█î╪│ ┘à╪¡┌⌐** ╪╖╪¿┘é MAHAK-MIGRATION.md ╪¿╪«╪┤ █╡ ΓÇö ╪»╪│╪¬┘ê╪▒┘ç╪º ╪»╪▒ ┘╛█î╪º┘à Claude ╪¿┘ç ┘à╪º┘ä┌⌐.

### █▒█┤█░█┤/█░█┤/█▓█╢ ΓÇö [Claude Code] ┘ê╪▒┘ê╪» ┘à┘ê╪¼┘ê╪»█î ┘à╪¡┌⌐ (┘ü╪º╪▓ █▒ ╪¬┌⌐┘à█î┘ä) + ≡ƒôï ┌»╪▓╪º╪▒╪┤ ┌⌐╪º┘à┘ä ╪¬╪¡┘ê█î┘ä ╪¿┘ç Cursor
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ┘ç┘à█î┘å ┌⌐╪º┘à█î╪¬
- **╪«┘ä╪º╪╡┘ç:**
  - **`scripts/import-mahak-stock.js` ╪¼╪»█î╪»:** ┘ê╪▒┘ê╪» ╪¬╪╣╪»╪º╪» ┘à┘ê╪¼┘ê╪»█î ╪º╪▓ ┘ü╪º█î┘ä mojodi.xlsx ┘à╪¡┌⌐ (join ╪¿╪º ┬½┌⌐╪» ╪╣┘à┘ä█î╪º╪¬█î┬╗ ╪┤█î╪¬ ╪¬┘ü╪╡█î┘ä█î╪î ┘ü┘é╪╖ ┘å┘ê╪╣ ┌⌐╪º┘ä╪º┘ç╪º). ╪º╪¼╪▒╪º█î ┘ê╪º┘é╪╣█î: **█│█╡█▓/█│█╡█▓ ┘é┘ä┘à ╪¬╪╖╪¿█î┘é╪î ╪╡┘ü╪▒ ╪¿╪»┘ê┘å ╪¬╪╖╪¿█î┘é**╪¢ █▒█╖█▒ ┌⌐╪º┘ä╪º█î ╪«╪º╪▒╪¼ ╪º╪▓ ┘ü╪º█î┘ä ΓåÆ ┘à┘ê╪¼┘ê╪»█î ╪╡┘ü╪▒╪¢ ╪¿┘ç╪º█î ┘ê╪º╪¡╪» █▓█╕█╖ ┘é┘ä┘à ╪º╪▓ ╪º╪▒╪▓╪┤ ╪º┘ü╪¬╪¬╪º╪¡█î┘ç ├╖ ╪¬╪╣╪»╪º╪»╪¢ ╪¼┘à╪╣ ┘à┘ê╪¼┘ê╪»█î █╖█▒┘¼█╕█│█▒ ╪╣╪»╪»╪¢ `needs_qty` ┘ç┘à┘ç ┘╛╪º┌⌐ ╪┤╪». ┌»╪▓╪º╪▒╪┤: mahak-stock-report.md ┌⌐┘å╪º╪▒ DB.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/scripts/import-mahak-stock.js`
- **Deploy:** ╪╖╪¿┘é runbook ┘╛╪º█î█î┘å ΓÇö ┘å┘ç ╪«┘ê╪»┌⌐╪º╪▒.

#### ≡ƒôï ┘ê╪╢╪╣█î╪¬ ┌⌐╪º┘à┘ä ┘à┘ç╪º╪¼╪▒╪¬ ┘à╪¡┌⌐ ╪¿╪▒╪º█î Cursor (╪º┌»╪▒ Claude ╪»╪▒ ╪»╪│╪¬╪▒╪│ ┘å╪¿┘ê╪» ╪º╪▓ ╪º█î┘å╪¼╪º ╪º╪»╪º┘à┘ç ╪¿╪»┘ç)

**Γ£à ╪º┘å╪¼╪º┘àΓÇî╪┤╪»┘ç ┘ê ╪¬╪│╪¬ΓÇî╪┤╪»┘ç (┘ü╪º╪▓ █▒):**
1. ╪¬╪╡┘à█î┘à╪º╪¬ █╕┌»╪º┘å┘ç┘ö ┘à╪º┘ä┌⌐ ╪»╪▒ `docs/MAHAK-MIGRATION.md` ╪¿╪«╪┤ █▓ ΓÇö **╪║█î╪▒┘é╪º╪¿┘ä ╪¬╪║█î█î╪▒ ╪¿╪»┘ê┘å ╪¬╪ú█î█î╪» ┘à╪¼╪»╪»**.
2. Schema (db.js): coa_code ├ù█╢ ╪¼╪»┘ê┘ä╪î needs_qty╪î src_system/src_doc_no/src_atf╪î level/nature/tafsili_type.
3. `lib/coa-map.js`: ┘å┌»╪º╪┤╪¬ ╪¡╪│╪º╪¿ΓÇî┘ç╪º█î ┌⌐┘å╪¬╪▒┘ä█î ╪º╪▓ settings ╪¿╪º fallback ╪¿┘ç ┌⌐╪»┘ç╪º█î ┘é╪»█î┘à█î (┌⌐╪┤ █▒█╡╪½╪º┘å█î┘çΓÇî╪º█î ΓÇö ╪¿╪╣╪» ╪º╪▓ ╪¬╪║█î█î╪▒ settings╪î `clearCoaCache()`).
4. `scripts/import-mahak-journal.js` ΓÇö ┘å╪¬█î╪¼┘ç┘ö ╪º╪¼╪▒╪º█î ┘ê╪º┘é╪╣█î: █▒┘¼█╡█│█░ ╪│┘å╪»/█╡┘¼█╣█░█╡ ╪ó╪▒╪¬█î┌⌐┘ä╪î ╪¬╪▒╪º╪▓ █╡█░┘¼█╣█╣█╕┘¼█╢█┤█│┘¼█╕█╕█╣=█╡█░┘¼█╣█╣█╕┘¼█╢█┤█│┘¼█╕█╕█╣ ╪¬┘ê┘à╪º┘å╪î █┤█│ ╪¬╪╣╪»█î┘ä ╪¿┘ç 906001╪î ┌⌐╪»█î┘å┌» █▒┘¼█▒█▓█┤ ╪¡╪│╪º╪¿╪î █╡█▓█│ ┘à╪¡╪╡┘ê┘ä/█▒█│ ╪¿╪º┘å┌⌐/█▓ ╪╡┘å╪»┘ê┘é/█▒█╡ ╪º┘å╪¿╪º╪▒╪î settings ┌⌐┘ä█î╪»┘ç╪º█î coa_* + coa_mode=mahak + feature_cogs_voucher=1 ╪│╪¬ ┘à█îΓÇî╪┤┘ê╪». ╪▒╪º╪│╪¬█îΓÇî╪ó╪▓┘à╪º█î█î ╪»╪º╪«┘ä ╪¬╪▒╪º┌⌐┘å╪┤ (╪«╪╖╪º=rollback ┌⌐╪º┘à┘ä).
5. `scripts/import-mahak-stock.js` ΓÇö ╪¿╪º┘ä╪º.
6. DB ╪¬╪│╪¬ΓÇî╪┤╪»┘ç ╪»╪▒ scratchpad ╪¼┘ä╪│┘ç┘ö Claude ╪º╪│╪¬╪¢ **╪▒┘ê█î ╪│╪▒┘ê╪▒ ╪¿╪º█î╪» ╪º╪▓ ┘å┘ê ╪¿╪º ┘ü╪º█î┘äΓÇî┘ç╪º█î ┘à╪º┘ä┌⌐ ╪º╪¼╪▒╪º ╪┤┘ê╪»** (┘ü╪º█î┘äΓÇî┘ç╪º█î ╪º┌⌐╪│┘ä ╪╣┘à╪»╪º┘ï ╪»╪▒ git ┘å█î╪│╪¬┘å╪» ΓÇö ╪¡╪º┘ê█î ╪º╪╖┘ä╪º╪╣╪º╪¬ ┘à╪º┘ä█î╪¢ ┘à╪º┘ä┌⌐ ┘à╪¡┘ä█î ╪»╪º╪▒╪»).

**Γ£à ╪º┘å╪¼╪º┘àΓÇî╪┤╪»┘ç (┘ü╪º╪▓ █▓ ΓÇö backend Claude + UI Cursor):**
1. ╪¬╪▓╪▒█î┘é `coa-map.acct()` ╪¿┘ç route┘ç╪º + COGS ╪«┘ê╪»┌⌐╪º╪▒ + allocTafsili (commit `41d3bab`).
2. UI: ┘╛┘å┘ä ┘å┌»╪º╪┤╪¬ ┌⌐╪»█î┘å┌» + ┌⌐╪» ╪¬┘ü╪╡█î┘ä█î ╪»╪▒ ┘ü╪▒┘àΓÇî┘ç╪º + link-coa + ╪│╪¬┘ê┘åΓÇî┘ç╪º█î COA + SW v30.
3. **Go-live:** runbook ╪¿╪«╪┤ █╡ ΓÇö ╪¿┌⌐ΓÇî╪ó┘╛ DB ┘ü╪╣┘ä█î╪î ╪º╪¼╪▒╪º█î ╪»┘ê importer ╪▒┘ê█î ╪│╪▒┘ê╪▒╪î ╪│┘ê█î█î┌å DB_PATH╪î ┌å┌⌐ΓÇî┘ä█î╪│╪¬ ┘╛╪░█î╪▒╪┤ ╪¡╪│╪º╪¿╪»╪º╪▒ (╪¿╪«╪┤ █╢).

**ΓÅ│ ┘à╪º┘å╪»┘ç (╪»╪│╪¬ ┘à╪º┘ä┌⌐ / ops):**
- ╪º╪¼╪▒╪º█î importer┘ç╪º ╪▒┘ê█î production ╪¿╪º ┘ü╪º█î┘äΓÇî┘ç╪º█î Excel ┘à╪¡┘ä█î
- rebuild ╪º┘å╪»╪▒┘ê█î╪» ╪¿╪▒╪º█î 1.0.11+Mahak

**~~ΓÅ│ ┘à╪º┘å╪»┘ç┘ö ┘ü╪º╪▓ █▓ (┘é╪»█î┘à█î ΓÇö ╪º┘å╪¼╪º┘à ╪┤╪»)~~**

**ΓÜá∩╕Å ╪»╪º┘àΓÇî┘ç╪º█î█î ┌⌐┘ç Claude ╪¿┘ç ╪ó┘åΓÇî┘ç╪º ╪«┘ê╪▒╪» (╪¬┌⌐╪▒╪º╪▒ ┘å┌⌐┘å):** (█▒) ┘ü╪º█î┘äΓÇî┘ç╪º█î page-script ╪¡╪¬┘à╪º┘ï IIFE ΓÇö barcode-input ╪┤┘à╪º ┌⌐┘ä ╪╡┘ü╪¡┘ç ╪▒╪º ┌⌐╪┤╪¬┘ç ╪¿┘ê╪»╪î ┘ü█î┌⌐╪│ ╪┤╪»╪¢ (█▓) ├╖█▒█░ ╪▒█î╪º┘äΓåÆ╪¬┘ê┘à╪º┘å ┘ü┘é╪╖ ╪»╪▒ ╪│╪╖╪¡ ╪ó╪▒╪¬█î┌⌐┘ä╪î ┘ç╪▒┌»╪▓ ╪▒┘ê█î ╪¼┘à╪╣╪¢ (█│) ┬½┌⌐╪» ╪╣┘à┘ä█î╪º╪¬█î┬╗ ╪¬┘ü╪╡█î┘ä█î ┘à╪¡┌⌐ per-type ╪º╪│╪¬ ┘å┘ç █î┌⌐╪¬╪º ΓÇö ┘ç┘à█î╪┤┘ç ╪¿╪º ┘å┘ê╪╣ ┘ü█î┘ä╪¬╪▒ ┌⌐┘å╪¢ (█┤) gate ╪¬╪║█î█î╪▒ ╪▒┘à╪▓ ╪º╪¼╪¿╪º╪▒█î 1.0.11 ╪▒┘ê█î DB ╪¬╪º╪▓┘ç ┘ü╪╣╪º┘ä ╪º╪│╪¬ (admin/admin123 ΓåÆ ┘à┘ê╪»╪º┘ä ╪¬╪║█î█î╪▒ ╪▒┘à╪▓).

### █▒█┤█░█┤/█░█┤/█▓█╢ ΓÇö [Claude Code] ≡ƒÜ¿ ┘ç╪º╪¬ΓÇî┘ü█î┌⌐╪│ ┘ê╪▒┘ê╪» (barcode-input) + ╪º╪¼╪▒╪º█î ┘ü╪º╪▓ █▒ ┘à┘ç╪º╪¼╪▒╪¬ ┘à╪¡┌⌐ (importer ╪¬╪ú█î█î╪»╪┤╪»┘ç)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ┘ç┘à█î┘å ┌⌐╪º┘à█î╪¬
- **╪«┘ä╪º╪╡┘ç:**
  - **≡ƒÜ¿ ╪¿╪º┌» ╪¿╪¡╪▒╪º┘å█î 1.0.11:** `lib/barcode-input.js` ╪»╪▒ ╪│╪╖╪¡ global ╪╡┘ü╪¡┘ç `const api` ╪º╪╣┘ä╪º┘å ┘à█îΓÇî┌⌐╪▒╪» ΓåÆ ╪¬╪╡╪º╪»┘à ╪¿╪º ╪¬╪º╪¿╪╣ `api()` ╪¿╪▒┘å╪º┘à┘ç ΓåÆ ┬½Identifier api has already been declared┬╗ ΓåÆ **┌⌐┘ä JS ╪╡┘ü╪¡┘ç ┘à█îΓÇî┘à╪▒╪» ┘ê ┘ê╪▒┘ê╪» ┌⌐╪º╪▒ ┘å┘à█îΓÇî┌⌐╪▒╪»** (╪¬╪│╪¬ Node ╪│╪¿╪▓ ╪¿┘ê╪» ┌å┘ê┘å ┘ü┘é╪╖ ╪»╪▒ ┘à╪▒┘ê╪▒┌»╪▒ ╪▒╪« ┘à█îΓÇî╪»┘ç╪»). ┘ü█î┌⌐╪│: ┌⌐┘ä ┘ü╪º█î┘ä ╪»╪▒ IIFE ┘╛█î┌å█î╪»┘ç ╪┤╪»╪¢ █▒█▓/█▒█▓ ╪¬╪│╪¬ ╪¿╪º╪▒┌⌐╪» ╪│╪¿╪▓. **ΓÜá∩╕Å ╪º┌»╪▒ production ╪▒┘ê█î 516a088 ╪º╪│╪¬ ╪º┘ä╪º┘å ╪╡┘ü╪¡┘ç ┘ê╪▒┘ê╪» ┘à╪▒╪»┘ç ╪º╪│╪¬ ΓÇö ┘ü┘ê╪▒╪º┘ï pull+restart ┌⌐┘å█î╪».**
  - **┘à┘ç╪º╪¼╪▒╪¬ ┘à╪¡┌⌐ ΓÇö ┘ü╪º╪▓ █▒ ╪º╪¼╪▒╪º ┘ê ╪¬╪ú█î█î╪» ╪┤╪»:**
    - schema: `coa_code` ╪▒┘ê█î customers/suppliers/products/banks/cash_boxes/persons + `needs_qty` + `src_system/src_doc_no/src_atf` ╪▒┘ê█î journal_entries + `level/nature/tafsili_type` ╪▒┘ê█î chart_of_accounts.
    - `lib/coa-map.js`: ┘ä╪º█î┘ç┘ö ┘å┌»╪º╪┤╪¬ ╪¡╪│╪º╪¿ΓÇî┘ç╪º█î ┌⌐┘å╪¬╪▒┘ä█î (settings-driven╪î fallback ╪¿┘ç ┌⌐╪»┘ç╪º█î ┘é╪»█î┘à█î ΓÇö backward compatible).
    - `scripts/import-mahak-journal.js`: ┘ê╪▒┘ê╪» ┌⌐╪º┘à┘ä ╪»╪▒ █î┌⌐ ╪¬╪▒╪º┌⌐┘å╪┤ + ╪▒╪º╪│╪¬█îΓÇî╪ó╪▓┘à╪º█î█î ╪»╪º╪«┘ä█î (rollback ╪«┘ê╪»┌⌐╪º╪▒ ╪»╪▒ ╪«╪╖╪º) + ┌»╪▓╪º╪▒╪┤ md.
    - **╪º╪¼╪▒╪º█î ┘ê╪º┘é╪╣█î ┘à┘ê┘ü┘é ╪▒┘ê█î ┘ü╪º█î┘äΓÇî┘ç╪º█î ┘à╪º┘ä┌⌐:** █▒┘¼█╡█│█░ ╪│┘å╪» / █╡┘¼█╣█░█╡ ╪ó╪▒╪¬█î┌⌐┘ä (█┤█│ ╪¬╪╣╪»█î┘ä ┌⌐╪│╪▒█î ╪¿┘ç █╣█░█╢) ΓÇö **╪¿╪»┘ç┌⌐╪º╪▒=╪¿╪│╪¬╪º┘å┌⌐╪º╪▒=█╡█░┘¼█╣█╣█╕┘¼█╢█┤█│┘¼█╕█╕█╣ ╪¬┘ê┘à╪º┘å** Γ£à╪¢ ┌⌐╪»█î┘å┌» █▒┘¼█▒█▓█┤ ╪¡╪│╪º╪¿ █┤╪│╪╖╪¡█î╪î █╡█▓█│ ┘à╪¡╪╡┘ê┘ä (needs_qty)╪î █▒█│ ╪¿╪º┘å┌⌐╪î █▓ ╪╡┘å╪»┘ê┘é╪î █▒█╡ ╪º┘å╪¿╪º╪▒. ┌»╪▒╪»╪┤ ┘ç╪▒ █▒█┤ ╪¡╪│╪º╪¿ ┌⌐┘ä == ┘à┘å╪¿╪╣. UI ╪¬╪│╪¬ ╪┤╪»: ┬½┘à╪¬┘ê╪º╪▓┘å Γ£ô┬╗.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/barcode-input.js`, `server/db.js`, `server/lib/coa-map.js`, `server/scripts/import-mahak-journal.js`
- **Deploy:** ΓÅ│ **┘ç╪º╪¬ΓÇî┘ü█î┌⌐╪│ ┘ü┘ê╪▒█î ┘ä╪º╪▓┘à** (pull + pm2 restart). ┘à┘ç╪º╪¼╪▒╪¬ ┘à╪¡┌⌐ ╪╖╪¿┘é ╪¿╪«╪┤ █╡ ╪│┘å╪» ╪º╪¼╪▒╪º ┘à█îΓÇî╪┤┘ê╪»╪î ┘å┘ç ╪«┘ê╪»┌⌐╪º╪▒.
- **█î╪º╪»╪»╪º╪┤╪¬ ╪¿╪▒╪º█î Cursor:** ┘ü╪º╪▓ █▓ ┘à┘ç╪º╪¼╪▒╪¬ ┘à╪º┘å╪»┘ç: ╪¬╪▓╪▒█î┘é coa-map ╪¿┘ç route┘ç╪º + ╪│┘å╪» COGS ╪«┘ê╪»┌⌐╪º╪▒ ╪»╪▒ ┘ü╪º┌⌐╪¬┘ê╪▒ + ╪¬┘ü╪╡█î┘ä█îΓÇî╪│╪º╪▓ + ┘╛┘å┘ä ┘å┌»╪º╪┤╪¬ ΓÇö ╪╖╪¿┘é MAHAK-MIGRATION.md ╪¿╪«╪┤ █│.█▓ ╪¬╪º █│.█╡. ┘é╪º┘å┘ê┘å: ┘ü╪º█î┘äΓÇî┘ç╪º█î page-script ╪¡╪¬┘à╪º┘ï IIFE.

### █▒█┤█░█┤/█░█┤/█▓█╢ ΓÇö [Claude Code] ╪│┘å╪» ╪º╪¼╪▒╪º█î█î ┘à┘ç╪º╪¼╪▒╪¬ ┌⌐╪º┘à┘ä ╪¡╪│╪º╪¿╪»╪º╪▒█î ┘à╪¡┌⌐ ΓåÆ ╪¬╪▒┘å┘à (docs/MAHAK-MIGRATION.md)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ┘ç┘à█î┘å ┌⌐╪º┘à█î╪¬ (┘ü┘é╪╖ ╪│┘å╪» ΓÇö ┌⌐╪» ╪¿╪╣╪» ╪º╪▓ ╪º█î┘å ╪│┘å╪» ┘╛█î╪º╪»┘ç ┘à█îΓÇî╪┤┘ê╪»)
- **╪«┘ä╪º╪╡┘ç:** ┌⌐╪º╪▒╪¿╪▒ ┌⌐╪»█î┘å┌» ┌⌐╪º┘à┘ä ┘à╪¡┌⌐ (█┤█╕ ┌⌐┘ä/█▒█╡█░ ┘à╪╣█î┘å/█╖█╣█╡ ╪¬┘ü╪╡█î┘ä█î) + ╪»┘ü╪¬╪▒ ╪▒┘ê╪▓┘å╪º┘à┘ç (█▒┘¼█╡█│█░ ╪│┘å╪»/█╡┘¼█╕█╢█┤ ╪ó╪▒╪¬█î┌⌐┘ä ╪º╪▓ █▒█┤█░█╡/█░█▒/█░█▒) ╪▒╪º ╪»╪º╪». ╪¬╪¡┘ä█î┘ä ┌⌐╪º┘à┘ä ╪º┘å╪¼╪º┘à ┘ê █╕ ╪¬╪╡┘à█î┘à ┌⌐┘ä█î╪»█î ╪¿╪º AskUserQuestion ╪º╪▓ ┘à╪º┘ä┌⌐ ┌»╪▒┘ü╪¬┘ç ╪┤╪»: ╪▒█î╪º┘ä├╖█▒█░╪î **┌⌐╪»█î┘å┌» ┘à╪¡┌⌐ ┘à╪¿┘å╪º**╪î ╪»█î╪¬╪º╪¿█î╪│ ╪¬╪º╪▓┘ç╪î ╪¬╪╣╪»█î┘ä ╪«┘ê╪»┌⌐╪º╪▒ █│█╖ ╪│┘å╪» ┘å╪º┘à╪¬╪▒╪º╪▓ ╪¿┘ç █╣█░█╢╪î ╪º╪┤╪«╪º╪╡ ┘ü┘é╪╖ ╪¬┘ü╪╡█î┘ä█î╪î ┌⌐╪º┘ä╪º┘ç╪º ┘à╪¡╪╡┘ê┘ä ┌⌐╪º┘à┘ä (╪¬╪╣╪»╪º╪» ╪¿╪╣╪»╪º┘ï)╪î ╪│┘å╪» █▒█┤█░█┤ ┘ê╪º╪▒╪» ╪┤┘ê╪»╪î **COGS ╪«┘ê╪»┌⌐╪º╪▒ ┘à╪½┘ä ┘à╪¡┌⌐ ╪º╪▓ ╪º█î┘å ╪¿┘ç ╪¿╪╣╪»**. ╪│┘å╪» ╪┤╪º┘à┘ä: schema ╪¼╪»█î╪» (coa_code ╪▒┘ê█î █╢ ╪¼╪»┘ê┘ä + src_doc_no + ╪»╪▒╪«╪¬ COA)╪î ┘ä╪º█î┘ç┘ö `lib/coa-map.js` (┘å┌»╪º╪┤╪¬ ╪¡╪│╪º╪¿ΓÇî┘ç╪º█î ┌⌐┘å╪¬╪▒┘ä█î╪î backward-compatible)╪î ╪¬┘ü╪╡█î┘ä█îΓÇî╪│╪º╪▓ ╪«┘ê╪»┌⌐╪º╪▒╪î ╪│┘å╪» COGS ╪»╪▒ ┘ü╪º┌⌐╪¬┘ê╪▒╪î ╪º┘ä┌»┘ê╪▒█î╪¬┘à ┌⌐╪º┘à┘ä importer ╪¿╪º ╪▒╪º╪│╪¬█îΓÇî╪ó╪▓┘à╪º█î█î/rollback╪î ╪¬╪▒╪¬█î╪¿ ╪º╪¼╪▒╪º ┘ê ┌å┌⌐ΓÇî┘ä█î╪│╪¬ ┘╛╪░█î╪▒╪┤ ╪¡╪│╪º╪¿╪»╪º╪▒.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `docs/MAHAK-MIGRATION.md`
- **Deploy:** Γ¥î (╪│┘å╪»). ΓÜá∩╕Å ┘ü╪º█î┘äΓÇî┘ç╪º█î ╪º┌⌐╪│┘ä ┘à╪º┘ä█î **╪»╪▒ git ┘é╪▒╪º╪▒ ┘å┘à█îΓÇî┌»█î╪▒┘å╪»** ΓÇö ┘à╪│█î╪▒ ┘à╪¡┘ä█î ╪¿┘ç importer ╪»╪º╪»┘ç ┘à█îΓÇî╪┤┘ê╪».
- **█î╪º╪»╪»╪º╪┤╪¬ ╪¿╪▒╪º█î Cursor:** ┘╛█î╪º╪»┘çΓÇî╪│╪º╪▓█î ╪╖╪¿┘é ╪│┘å╪»╪î ╪¿╪«╪┤ █│ ┘ê █┤. ΓÜá∩╕Å ╪¿╪º ╪¬╪║█î█î╪▒╪º╪¬ 1.0.11 ╪┤┘à╪º (soft-delete ╪│┘å╪»╪î ╪│╪º┘ä ┘à╪º┘ä█î) ╪¿╪º█î╪» ┘ç┘à╪º┘ç┘å┌» ╪┤┘ê╪» ΓÇö importer ╪º╪│┘å╪º╪» `src_system='mahak'` ┘à█îΓÇî╪│╪º╪▓╪» ┘ê rollover ╪│╪º┘ä ┘à╪º┘ä█î ┘å╪¿╪º█î╪» ╪ó┘åΓÇî┘ç╪º ╪▒╪º ╪»╪│╪¬┌⌐╪º╪▒█î ┌⌐┘å╪».

### █▒█┤█░█┤/█░█┤/█▓█╢ ΓÇö [Cursor] ┘å╪│╪«┘ç 1.0.11 ┌⌐╪º┘à┘ä (┘ü╪º╪▓ █▒ΓÇô█┤)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `516a088`
- **╪«┘ä╪º╪╡┘ç:**
  - **┘ü╪º╪▓ █▒:** debounce ╪¿╪º╪▒┌⌐╪» + wedge╪¢ backup ┘ü┘é╪╖ central.
  - **┘ü╪º╪▓ █▓:** ╪¡╪░┘ü API/UI ┌»╪▒╪»╪┤ ╪¡╪│╪º╪¿ (ledger)╪¢ soft-delete ┘ü╪º┌⌐╪¬┘ê╪▒/╪│┘å╪» ╪»╪│╪¬█î╪¢ ╪│╪º┘ä ┘à╪º┘ä█î rollover + factory reset╪¢ ╪º┘å╪¿╪º╪▒┌»╪▒╪»╪º┘å█î ╪¿┘ç ┘à┘å┘ê█î ╪¡╪│╪º╪¿╪»╪º╪▒█î + ╪│┘å╪» GL.
  - **┘ü╪º╪▓ █│:** Command Palette Ctrl+K╪¢ ┘ê█î╪¼╪¬ ╪º┘é╪»╪º┘à╪º╪¬ + ╪º╪╣┘ä╪º┘åΓÇî┘ç╪º╪¢ ╪│╪º╪«╪¬ ╪│╪▒█î╪╣ ┘à╪¡╪╡┘ê┘ä ╪»╪▒ ┘ü╪º┌⌐╪¬┘ê╪▒.
  - **┘ü╪º╪▓ █┤:** RBAC ┘à╪º╪¬╪▒█î╪│ per-user╪¢ ┘à╪┤╪º┘ê╪▒ AI ┘ü┘é╪╖ ┘à╪»█î╪▒ (admin/sales_manager).
  - ╪¬╪│╪¬: barcode 12/12╪î fiscal 4/4╪î SMS 22/22. SW ΓåÆ v28.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/lib/rbac.js`, `server/routes/{notifications,search,fiscal-year,rbac}.js`, `server/services/ai.js`, `server/db.js`, `server/scripts/test-fiscal-year.js`
- **Deploy:** Γ£à pull + pm2 restart ╪│╪▒┘ê╪▒ production

### █▒█┤█░█╡/█░█┤/█▓█▓ ΓÇö ╪º╪│┌⌐╪▒█î┘╛╪¬ deploy ╪«┘ê╪»┌⌐╪º╪▒ + keystore example
- **╪┤╪º╪«┘ç:** `cursor/deploy-automation-605f`
- **Commit:** `80ee40b`
- **╪«┘ä╪º╪╡┘ç:** `scripts/deploy-production.sh` (git pull + jwt-secret + npm + pm2 + health check)╪î ╪¿┘çΓÇî╪▒┘ê╪▓╪▒╪│╪º┘å█î `.github/workflows/deploy.yml` ╪¿╪º bootstrap inline╪î `android/keystore.properties.example`
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `scripts/deploy-production.sh`, `.github/workflows/deploy.yml`, `android/keystore.properties.example`, `docs/PROJECT-HANDOFF.md`
- **Deploy:** ΓÅ│ ┘å█î╪º╪▓ ╪¿┘ç merge + ╪º╪¼╪▒╪º█î workflow █î╪º SSH
- **█î╪º╪»╪»╪º╪┤╪¬:** `bash scripts/deploy-production.sh` ╪▒┘ê█î ╪│╪▒┘ê╪▒ █î╪º GitHub Actions ┬½Deploy ERP ╪¬╪▒┘å┘à┬╗

### █▒█┤█░█╡/█░█┤/█▓█▓ ΓÇö ╪│╪«╪¬ΓÇî╪│╪º╪▓█î ╪º┘à┘å█î╪¬█î (╪¿┘å╪» ┬½╪¿┬╗ handoff) + merge ╪¿╪º v4
- **╪┤╪º╪«┘ç:** `cursor/security-hardening-605f` ΓåÆ `claude/claude-md-docs-2ssrpy`
- **Commit:** `f8ba6f4` (merge ╪¿┘ç `claude/claude-md-docs-2ssrpy`)
- **╪«┘ä╪º╪╡┘ç:**
  - ╪¬╪║█î█î╪▒ ╪º╪¼╪¿╪º╪▒█î ╪▒┘à╪▓ ┘╛█î╪┤ΓÇî┘ü╪▒╪╢/┘à┘ê┘é╪¬ ╪»╪▒ ╪º┘ê┘ä█î┘å ┘ê╪▒┘ê╪» (╪│╪º╪▓┌»╪º╪▒ ╪¿╪º 2FA v4): ╪│╪¬┘ê┘å `users.must_change_password`╪î ┌»█î╪¬ 403 ╪»╪▒ `auth` (┘ü┘é╪╖ ┘à╪▒┌⌐╪▓█î)╪î ┘à┘ê╪»╪º┘ä ┘ü╪▒╪º┘å╪¬╪¢ ┘╛╪▒┌å┘à ┘é╪¿┘ä ╪º╪▓ ┘à╪▒╪¡┘ä┘ç 2FA ╪¿╪▒╪º█î ╪▒┘à╪▓ `admin123`
  - ╪▒┘à╪▓┘å┌»╪º╪▒█î ╪¿┌⌐╪º┘╛ AES-256-GCM + `server/scripts/decrypt-backup.js`
  - ╪¡╪░┘ü ╪º╪│╪▒╪º╪▒ ╪º╪▓ ┘à╪«╪▓┘å (keystore╪î JWT ┘ç╪º╪▒╪»┌⌐╪») + `docs/SECURITY-HARDENING.md`
  - merge ╪¿╪º v4: 2FA/TOTP╪î ┘╛┘ê╪▒╪¬╪º┘ä B2B╪î ╪º┘å╪¿╪º╪▒┌»╪▒╪»╪º┘å█î╪î audit log╪î ΓÇª
  - `test-v4-features.js` ╪¿╪º ╪¬╪║█î█î╪▒ ╪º╪¼╪¿╪º╪▒█î ╪▒┘à╪▓ ╪│╪º╪▓┌»╪º╪▒ ╪┤╪» (`loginAdmin` helper)
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/middleware/auth.js`, `server/routes/{auth,twofa,admin}.js`, `server/backup.js`, `server/public/index.html`, `server/scripts/test-v4-features.js`, `docs/SECURITY-HARDENING.md`
- **Deploy:** Γ¥î ╪º╪╣┘à╪º┘ä ┘å╪┤╪»┘ç ΓÇö `jwt-secret.txt` ┘é╪¿┘ä ╪º╪▓ restart ╪º┘ä╪▓╪º┘à█î
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪¿╪╣╪» ╪º╪▓ deploy╪î admin ┘à┘ê╪»╪º┘ä ╪¬╪║█î█î╪▒ ╪▒┘à╪▓ ┘à█îΓÇî╪¿█î┘å╪»╪¢ ┘ç┘à┘ç ╪¿╪º ╪¬╪║█î█î╪▒ JWT █î┌⌐ΓÇî╪¿╪º╪▒ re-login

### █▒█┤█░█┤/█░█┤/█▓█┤ ΓÇö [Claude Code] ┘å╪│╪«┘ç ╪»┘à┘ê ╪¿╪▒╪º█î ┘╛╪▒╪▓┘å╪¬ ΓÇö seed ┌⌐╪º┘à┘ä + ╪»┘à┘ê█î ╪ó┘å┘ä╪º█î┘å (:3001) + ╪»┘à┘ê█î ┘ä┘╛ΓÇî╪¬╪º┘╛
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ┘ç┘à█î┘å ┌⌐╪º┘à█î╪¬
- **╪«┘ä╪º╪╡┘ç:** ╪¿┘ç ╪»╪▒╪«┘ê╪º╪│╪¬ ┌⌐╪º╪▒╪¿╪▒╪î ┘å╪│╪«┘ç ╪»┘à┘ê ┬½╪»┘é█î┘é╪º┘ï ┘ç┘à╪º┘å ╪¿╪▒┘å╪º┘à┘ç┬╗ ΓÇö ┘ç┘à╪º┘å ┌⌐╪»╪î ╪»█î╪¬╪º╪¿█î╪│ ╪¼╪»╪º ╪¿╪º ╪»╪º╪»┘ç ┘å┘à╪º█î╪┤█î ╪║┘å█î:
  - **`server/scripts/seed-demo.js`:** ╪│╪▒┘ê╪▒ ┘ê╪º┘é╪╣█î ╪▒╪º ╪▒┘ê█î DB ╪«╪º┘ä█î ╪¿┘ê╪¬ ┘à█îΓÇî┌⌐┘å╪» ┘ê ╪º╪▓ **API┘ç╪º█î ┘ê╪º┘é╪╣█î** ╪»╪º╪»┘ç ┘à█îΓÇî╪│╪º╪▓╪» (╪»┘ü╪º╪¬╪▒ ╪¬╪▒╪º╪▓ ┘à█îΓÇî┘à╪º┘å╪» ΓÇö ╪¬╪│╪¬ ╪┤╪»: ╪¿╪»┘ç┌⌐╪º╪▒=╪¿╪│╪¬╪º┘å┌⌐╪º╪▒=█▒█╣┘½█╕ ┘à█î┘ä█î╪º╪▒╪» Γ£à): █┤ ┌⌐╪º╪▒╪¿╪▒ (demo/sara/reza/maryam ΓÇö ╪▒┘à╪▓ ┘ç┘à┘ç `demo1234`)╪î █▓ ╪¿╪º┘å┌⌐ + █▓ ╪╡┘å╪»┘ê┘é (╪¬┘å╪«┘ê╪º┘ç)╪î █▓ ╪º┘å╪¿╪º╪▒╪î █╡ ╪¬╪ú┘à█î┘åΓÇî┌⌐┘å┘å╪»┘ç╪î █╢ ╪»╪│╪¬┘ç ┘à╪¡╪╡┘ê┘ä + █╢█░ ┘à╪¡╪╡┘ê┘ä╪î █▒█╡ ┘ü╪º┌⌐╪¬┘ê╪▒ ╪«╪▒█î╪» (╪┤╪º╪▒┌ÿ ┘à┘ê╪¼┘ê╪»█î)╪î █┤█░ ┘à╪┤╪¬╪▒█î╪î █╢█░ ┘╛█î┌»█î╪▒█î/┘╛╪º█î┘╛ΓÇî┘ä╪º█î┘å╪î **█▒█▓█╡ ┘ü╪º┌⌐╪¬┘ê╪▒ ╪▒╪│┘à█î + █▓█╡ ┘╛█î╪┤ΓÇî┘ü╪º┌⌐╪¬┘ê╪▒** ╪»╪▒ ╪¿╪º╪▓┘ç █│ ┘à╪º┘ç╪î █╣█▓ ╪»╪▒█î╪º┘ü╪¬ (┘å┘é╪»/╪¿╪º┘å┌⌐/┌å┌⌐ ╪¿╪º ╪│╪▒╪▒╪│█î╪»)╪î █╕ ┘ç╪▓█î┘å┘ç╪î █╢ ╪│╪▒█î ╪¬┘ê┘ä█î╪»╪î █╡ ┌⌐╪º╪▒┘à┘å╪» + ╪¡┘é┘ê┘é (╪¿╪╣╪╢█î ┘╛╪▒╪»╪º╪«╪¬ΓÇî╪┤╪»┘ç)╪î █î╪º╪»╪ó┘ê╪▒┘ç╪º. ╪¬╪╡╪º╪»┘ü█îΓÇî╪│╪º╪▓█î deterministic (seed ╪½╪º╪¿╪¬) ΓÇö ┘ç╪▒ ╪¿╪º╪▒ ┘ç┘à╪º┘å ╪»┘à┘ê.
  - **`scripts/demo-online.sh`:** ╪▒┘ê█î ╪│╪▒┘ê╪▒ production █î┌⌐ instance ╪»┘ê┘à PM2 ╪¿╪º ┘å╪º┘à `erp-taranom-demo` ╪▒┘ê█î ┘╛┘ê╪▒╪¬ **3001** ╪¿╪º┘ä╪º ┘à█îΓÇî╪ó┘ê╪▒╪» (DB/uploads ╪¼╪»╪º ΓÇö ╪¿╪▒┘å╪º┘à┘ç ╪º╪╡┘ä█î ╪»╪│╪¬ΓÇî┘å╪«┘ê╪▒╪»┘ç). ╪º╪¼╪▒╪º█î ┘à╪¼╪»╪» = ╪▒█î╪│╪¬ ╪»┘à┘ê╪¢ ┘à┘å╪º╪│╪¿ cron ╪┤╪¿╪º┘å┘ç.
  - **`scripts/demo-laptop.ps1`:** ╪»┘à┘ê█î ╪ó┘ü┘ä╪º█î┘å ╪▒┘ê█î ┘ä┘╛ΓÇî╪¬╪º┘╛ ┘ê█î┘å╪»┘ê╪▓█î ΓÇö ╪¡╪º┘ä╪¬ central (┘ç┘à┘ç ┘à╪º┌ÿ┘ê┘äΓÇî┘ç╪º ╪º╪▓ ╪¼┘à┘ä┘ç ╪¬┘å╪╕█î┘à╪º╪¬/┌⌐╪º╪▒╪¿╪▒╪º┘å ╪»█î╪»┘ç ┘à█îΓÇî╪┤┘ê╪»╪î ╪¿╪▒╪«┘ä╪º┘ü build ╪»╪│┌⌐╪¬╪º┘╛ ┌⌐┘ç device ╪º╪│╪¬) ╪▒┘ê█î `http://127.0.0.1:3002`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/scripts/seed-demo.js`, `scripts/demo-online.sh`, `scripts/demo-laptop.ps1`
- **Deploy:** ΓÅ│ ╪¿╪▒╪º█î ╪»┘à┘ê█î ╪ó┘å┘ä╪º█î┘å: `bash scripts/demo-online.sh` ╪▒┘ê█î ╪│╪▒┘ê╪▒ (+ ╪¿╪º╪▓ ╪¿┘ê╪»┘å ┘╛┘ê╪▒╪¬ 3001)
- **█î╪º╪»╪»╪º╪┤╪¬:** SMS ╪»╪▒ ╪»┘à┘ê ╪¿┘çΓÇî╪╖┘ê╪▒ ╪╖╪¿█î╪╣█î ╪«╪º┘à┘ê╪┤ ╪º╪│╪¬ (╪¬┘å╪╕█î┘à╪º╪¬ ┘╛█î╪º┘à┌⌐ ╪«╪º┘ä█î) ΓÇö ╪¿┘ç ┘à╪┤╪¬╪▒█î ┘ê╪º┘é╪╣█î ┌å█î╪▓█î ╪º╪▒╪│╪º┘ä ┘å┘à█îΓÇî╪┤┘ê╪».

### █▒█┤█░█┤/█░█┤/█▓█┤ ΓÇö [Cursor] ╪▒┘ü╪╣ ┌⌐╪▒╪┤ ┘ü┘ê╪▒█î ╪º┘å╪»╪▒┘ê█î╪» 2.0.7 ΓÇö APK ╪¬┘ê╪»╪▒╪¬┘ê █▓█╣█┤MB ╪¡╪░┘ü ╪┤╪»
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** (┘ç┘à█î┘å session)
- **╪«┘ä╪º╪╡┘ç:**
  - **╪▒█î╪┤┘ç┘ö ┌⌐╪▒╪┤ ┘ü┘ê╪▒█î:** `copyServerSources` ┘ü╪º█î┘ä `erp-taranom.apk` (█▓█╣█┤MB) ╪▒╪º ╪»╪º╪«┘ä assets ╪¿╪│╪¬┘çΓÇî╪¿┘å╪»█î ┘à█îΓÇî┌⌐╪▒╪» ΓåÆ ╪º┘ê┘ä█î┘å ╪º╪│╪¬╪«╪▒╪º╪¼ OOM/┌⌐╪▒╪┤ ΓåÆ ╪¿╪▒┘å╪º┘à┘ç ┘ü┘ê╪▒╪º┘ï ╪¿╪│╪¬┘ç ┘à█îΓÇî╪┤╪».
  - **╪▒┘ü╪╣:** exclude ┌⌐┘ä `public/releases/**`╪¢ ┘é╪¿┘ä ╪º╪▓ build ╪¼╪º╪¿╪¼╪º█î█î APK ╪º╪▓ ┘╛┘ê╪┤┘ç server╪¢ `MainActivity` ╪¿╪º ┌⌐┘╛█î iterative + catch ╪«╪╖╪º (╪¿╪»┘ê┘å RuntimeException ╪▒┘ê█î thread)╪¢ `largeHeap` + `extractNativeLibs`╪¢ `main.js` ╪¿╪º boot.log ┘ê throw ╪º┌»╪▒ sqlite ┘å╪¿╪º╪┤╪».
  - **╪¬╪│╪¬:** `scripts/test-android-apk.ps1` (█▒█┤ assertion: ╪¿╪»┘ê┘å nested apk╪î ELF libnode+sqlite╪î ┘å╪│╪«┘ç 2.0.7╪î ╪¡╪¼┘à <250MB) ΓÇö ┘ç┘à┘ç ╪│╪¿╪▓. SMS 22/22 ╪│╪¿╪▓. APK ╪¼╪»█î╪» **█╢█▓MB** SHA256 `265EDC4BΓÇª`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `android/app/build.gradle`, `MainActivity.java`, `main.js`, `AndroidManifest.xml`, `scripts/test-android-apk.ps1`, `scripts/build-android.ps1`
- **Deploy:** Γ£à APK 2.0.7 ╪ó┘╛┘ä┘ê╪» (`SHA256=265EDC4BΓÇª`, 62MB) + commit `72118af` + pm2

### █▒█┤█░█┤/█░█┤/█▓█┤ ΓÇö [Cursor] ╪º┘å╪¬╪┤╪º╪▒ ╪º┘å╪»╪▒┘ê█î╪» 2.0.6 ΓÇö ╪▒┘ü╪╣ ╪¿┘ê╪¬ SQLite (better-sqlite3 path)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** (┘ç┘à█î┘å session)
- **╪«┘ä╪º╪╡┘ç:**
  - **╪¿╪º┌» 2.0.5:** APK ╪»╪º╪▒╪º█î `prebuilt/android/*/better_sqlite3.node` ╪¿┘ê╪» ┘ê┘ä█î `bindings()` ┘ü┘é╪╖ `build/Release/` ╪▒╪º ┘à█îΓÇî╪«┘ê╪º┘å╪» ΓåÆ ╪│╪▒┘ê╪▒ Node ┌⌐╪▒╪┤ ΓåÆ ╪º┘╛ ╪º╪¼╪▒╪º ┘å┘à█îΓÇî╪┤╪».
  - **╪▒┘ü╪╣:** `main.js` ╪»╪▒ runtime ╪¿╪º█î┘å╪▒█î ABI ╪»╪▒╪│╪¬ ╪▒╪º ┌⌐┘╛█î ┘à█îΓÇî┌⌐┘å╪»╪¢ rebuild ╪¿╪º prebuilt ┘ç╪▒ █│ ABI╪¢ ┘å╪│╪«┘ç **2.0.6 (vc8)**.
  - **APK ╪¼╪»█î╪»:** SHA256 `6247752DΓÇª`, ~█│█┤█▒MB ΓÇö ELF ╪│╪¿╪▓ (libnode + █│ prebuilt + fix ╪»╪▒ main.js).
  - ╪▒╪º┘ç┘å┘à╪º█î ╪»╪º╪«┘ä ╪¿╪▒┘å╪º┘à┘ç: █î╪º╪»╪ó┘ê╪▒█î ┬½╪º┘ê┘ä█î┘å ╪º╪¼╪▒╪º█î ╪º┘å╪»╪▒┘ê█î╪» ┌å┘å╪» ╪»┘é█î┘é┘ç ╪╖┘ê┘ä ┘à█îΓÇî┌⌐╪┤╪»┬╗.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `android/.../main.js`, `android/app/build.gradle`, `scripts/build-android.ps1`, `scripts/build-better-sqlite3-android.ps1`, `server/public/releases/manifest.json`, `server/public/index.html`
- **Deploy:** Γ£à APK 2.0.6 ╪ó┘╛┘ä┘ê╪» ╪┤╪» (`SHA256=6247752DΓÇª`) + commit `2696eda` + pull/pm2 ╪│╪▒┘ê╪▒

### █▒█┤█░█┤/█░█┤/█▓█┤ ΓÇö [Claude Code] ╪º┘å╪¬╪┤╪º╪▒ 1.0.10 ╪º┘å╪¼╪º┘à ╪┤╪»: exe + APK ╪│╪º╪«╪¬┘ç ┘ê ╪ó┘╛┘ä┘ê╪» ╪┤╪» ΓÇö ┘ü┘é╪╖ pull ╪│╪▒┘ê╪▒ ┘à╪º┘å╪»┘ç
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `57f25f9` (┘à╪¬╪º╪»█î╪¬╪º ΓÇö ╪¬┘ê╪│╪╖ release.ps1 ╪▒┘ê█î ╪│█î╪│╪¬┘à ┌⌐╪º╪▒╪¿╪▒) + ┘ç┘à█î┘å ┌⌐╪º┘à█î╪¬ (fix)
- **╪«┘ä╪º╪╡┘ç:**
  - ┌⌐╪º╪▒╪¿╪▒ `release.ps1` ╪▒╪º ╪º╪¼╪▒╪º ┌⌐╪▒╪»: **╪»╪│┌⌐╪¬╪º┘╛ `ERP-Taranom-Setup-1.0.10.exe` (█╣█│MB) ╪│╪º╪«╪¬┘ç ╪┤╪»** Γ£à ┘ê **APK ╪º┘å╪»╪▒┘ê█î╪» 2.0.5 (█▓█▓█░MB) ╪│╪º╪«╪¬┘ç ╪┤╪»** Γ£à ΓÇö ╪¿╪º╪▓╪▒╪│█î ELF ╪│╪¿╪▓ (█│ ┘à╪º┌ÿ┘ê┘ä better_sqlite3 + libnode ┘ç╪▒ █│ ABI╪¢ SHA256 `61856EB8...`). ┘ç╪▒ ╪»┘ê ╪¿╪º scp ╪▒┘ê█î `/releases/` ╪│╪▒┘ê╪▒ ╪ó┘╛┘ä┘ê╪» ╪┤╪»┘å╪».
  - ╪»┘ê ╪¿╪º┌» build ╪¡█î┘å ╪▒╪º┘ç ╪▒┘ü╪╣ ╪┤╪»: (█▒) ╪º╪│┌⌐╪▒█î┘╛╪¬ΓÇî┘ç╪º█î ps1 ╪¿╪º█î╪» ASCII ╪«╪º┘ä╪╡ ╪¿╪º╪┤┘å╪» (PS 5.1 + ╪¿╪»┘ê┘å BOM ΓåÆ em-dash ╪¿╪º█î╪¬ ┘å┘é┘äΓÇî┘é┘ê┘ä ┘ç┘ê╪┤┘à┘å╪» ╪»╪º╪▒╪» ┘ê parser ┘à█îΓÇî╪┤┌⌐┘å╪»)╪¢ (█▓) ┘ü╪º█î┘äΓÇî┘ç╪º█î `.gz` ╪»╪º╪«┘ä node_modules (bcryptjs) ╪¿╪º AAPT ╪¬╪»╪º╪«┘ä ┬½Duplicate resources┬╗ ┘à█îΓÇî╪»┘ç┘å╪» ΓåÆ ┘é╪¿┘ä ╪º╪▓ build ╪¡╪░┘ü ┘à█îΓÇî╪┤┘ê┘å╪».
  - **┘é╪»┘à ╪ó╪«╪▒ (deploy ┘ê╪¿) ╪«╪╖╪º ╪»╪º╪»:** ╪▒┘ê█î production ┘ü╪º█î┘ä `manifest.json` ╪¬╪║█î█î╪▒ ┘à╪¡┘ä█î ╪»╪│╪¬█î ╪»╪º╪┤╪¬ ┘ê pull ╪▒╪º ╪¿┘ä╪º┌⌐ ┌⌐╪▒╪». `release.ps1` ╪º╪╡┘ä╪º╪¡ ╪┤╪»: ┘é╪¿┘ä ╪º╪▓ pull╪î ┘ü┘é╪╖ ╪»┘ê ┘ü╪º█î┘ä ┘à╪¬╪º╪»█î╪¬╪º█î releases ╪▒╪º `git checkout --` ┘à█îΓÇî┌⌐┘å╪» (git ┘à┘å╪¿╪╣ ╪¡┘é█î┘é╪¬ ╪ó┘åΓÇî┘ç╪º╪│╪¬). ╪»╪│╪¬┘ê╪▒ █î┌⌐ΓÇî╪«╪╖█î ╪▒┘ü╪╣ ╪¿┘ç ┌⌐╪º╪▒╪¿╪▒ ╪»╪º╪»┘ç ╪┤╪».
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `scripts/release.ps1`, `scripts/build-android.ps1`, `server/public/releases/{manifest.json,latest.yml}`
- **Deploy:** ΓÅ│ ┘ü┘é╪╖ `git pull` ╪│╪▒┘ê╪▒ ┘à╪º┘å╪»┘ç (exe/apk ╪º╪▓ ┘é╪¿┘ä ╪▒┘ê█î ╪│╪▒┘ê╪▒ ┘ç╪│╪¬┘å╪»)
- **█î╪º╪»╪»╪º╪┤╪¬ ╪¿╪▒╪º█î Cursor:** ╪▒┘ê█î production ┘ü╪º█î┘äΓÇî┘ç╪º█î releases ╪▒╪º ╪»█î┌»╪▒ ╪»╪│╪¬█î ┘ê█î╪▒╪º█î╪┤ ┘å┌⌐┘å█î╪» ΓÇö ┘ç┘à█î╪┤┘ç ╪º╪▓ ┘à╪│█î╪▒ git + release.ps1.

### █▒█┤█░█┤/█░█┤/█▓█┤ ΓÇö [Cursor] ╪¬╪┤╪«█î╪╡ ╪¿╪º┌» ╪¿╪¡╪▒╪º┘å█î ╪¿┘ê╪¬ ╪º┘å╪»╪▒┘ê█î╪»: better-sqlite3 ╪»╪▒ ┘à╪│█î╪▒ ╪º╪┤╪¬╪¿╪º┘ç (2.0.5)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **╪«┘ä╪º╪╡┘ç:** APK 2.0.5 (`SHA256=61856eb8ΓÇª`) ELF ┘à╪╣╪¬╪¿╪▒ ╪»╪º╪┤╪¬ ┘ê┘ä█î `build/Release/better_sqlite3.node` ┘å╪»╪º╪┤╪¬ ΓÇö ╪▒┘ü╪╣ ╪»╪▒ 2.0.6 ╪¿╪º┘ä╪º.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `android/.../nodejs-project/main.js`
- **Deploy:** Γ¥î ΓåÆ ╪¼╪º█î┌»╪▓█î┘å ╪¿╪º 2.0.6

### █▒█┤█░█┤/█░█┤/█▓█┤ ΓÇö [Claude Code] ╪▒┘ü╪╣ ┬½╪¿╪▒┘å╪º┘à┘ç ╪º┘å╪»╪▒┘ê█î╪» ╪¿╪º┘ä╪º ┘å┘à█îΓÇî╪ó█î╪»┬╗: ╪╡╪¿╪▒ ╪¿┘ê╪¬ ╪º╪▓ ~█│█░ ╪½╪º┘å█î┘ç ╪¿┘ç █▒█░ ╪»┘é█î┘é┘ç + ╪º╪│┘╛┘ä╪┤
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ┘ç┘à█î┘å ┌⌐╪º┘à█î╪¬
- **╪«┘ä╪º╪╡┘ç:**
  - ╪▒█î╪┤┘ç┘ö ╪º╪¡╪¬┘à╪º┘ä█î ┌»╪▓╪º╪▒╪┤ ┌⌐╪º╪▒╪¿╪▒ ┘╛█î╪»╪º ╪┤╪»: ╪º┘ê┘ä█î┘å ╪º╪¼╪▒╪º█î APK ┘ç╪▓╪º╪▒╪º┘å ┘ü╪º█î┘ä nodejs-project ╪▒╪º ╪º╪│╪¬╪«╪▒╪º╪¼ ┘à█îΓÇî┌⌐┘å╪» (┌å┘å╪» ╪»┘é█î┘é┘ç ╪▒┘ê█î ╪¡╪º┘ü╪╕┘ç ┌⌐┘å╪»)╪î ┘ê┘ä█î `loadWhenReady` ┘é╪»█î┘à█î ┘ü┘é╪╖ █▓█░├ù█▒.█╡╪½╪º┘å█î┘ç (~█│█░s) ╪¬┘ä╪º╪┤ ┘à█îΓÇî┌⌐╪▒╪» ┘ê ╪¿╪╣╪» **╪¿╪▒╪º█î ┘ç┘à█î╪┤┘ç ╪╡┘ü╪¡┘ç ╪«╪º┘ä█î** ┘à█îΓÇî┘à╪º┘å╪».
  - ╪¡╪º┘ä╪º: ╪º╪│┘╛┘ä╪┤ ┘ü╪º╪▒╪│█î ┬½╪»╪▒ ╪¡╪º┘ä ╪ó┘à╪º╪»┘çΓÇî╪│╪º╪▓█î... ╪º┘ê┘ä█î┘å ╪º╪¼╪▒╪º ┘à┘à┌⌐┘å ╪º╪│╪¬ ┌å┘å╪» ╪»┘é█î┘é┘ç ╪╖┘ê┘ä ╪¿┌⌐╪┤╪»┬╗ ┘ü┘ê╪▒╪º┘ï ┘å┘à╪º█î╪┤ ╪»╪º╪»┘ç ┘à█îΓÇî╪┤┘ê╪»╪¢ █î┌⌐ thread ┘╛╪│ΓÇî╪▓┘à█î┘å┘ç ╪¬╪º █▒█░ ╪»┘é█î┘é┘ç ╪│╪▒┘ê╪▒ ╪»╪º╪«┘ä█î ╪▒╪º poll ┘à█îΓÇî┌⌐┘å╪» (HttpURLConnection╪î ┘ç╪▒ █▒ ╪½╪º┘å█î┘ç) ┘ê ╪¿┘çΓÇî┘à╪¡╪╢ HTTP 200 ╪¿╪▒┘å╪º┘à┘ç ╪▒╪º load ┘à█îΓÇî┌⌐┘å╪»╪¢ ╪º┌»╪▒ ┘ç╪▒┌»╪▓ ╪¿╪º┘ä╪º ┘å█î╪º┘à╪» ╪╡┘ü╪¡┘ç ╪«╪╖╪º█î ╪╡╪º╪»┘é╪º┘å┘ç.
  - hash ┌⌐╪º╪▒╪¿╪▒ (`43563CC8...`) ┘å╪┤╪º┘å ╪»╪º╪» APK ┘à╪¡┘ä█î ┘ç┘à╪º┘å build ┘à╪▒╪»┘ç┘ö ┘é╪¿┘ä█î **┘å█î╪│╪¬** ΓÇö ┘╛╪│ ╪º█î┘å ╪│┘å╪º╪▒█î┘ê█î ╪¿┘ê╪¬┘É ┌⌐┘å╪» ┘à╪¡╪¬┘à┘äΓÇî╪¬╪▒█î┘å ╪╣┘ä╪¬ ╪º╪│╪¬. Play Protect ┘ç┘à ┘å╪╡╪¿ ╪▒╪º ╪¿┘ä╪º┌⌐ ┘à█îΓÇî┌⌐╪▒╪» (╪▒╪º┘ç┘å┘à╪º█î█î ╪┤╪»: More details ΓåÆ Install anyway).
  - `git pull` ┌⌐╪º╪▒╪¿╪▒ ╪¿┘çΓÇî╪«╪º╪╖╪▒ ╪¬╪║█î█î╪▒╪º╪¬ uncommitted ╪┤┘à╪º (Cursor) ╪▒╪» ╪┤╪»: `android/app/build.gradle`, `docs/CHANGE-LOG.md`, `scripts/build-android.ps1`, `manifest.json` ΓÇö ╪¿┘ç ┌⌐╪º╪▒╪¿╪▒ ┌»┘ü╪¬┘ç ╪┤╪» stash ┌⌐┘å╪» (`git stash push -m cursor-wip-before-1.0.10`). ΓÜá∩╕Å **Cursor:** stash ╪▒╪º ╪¿╪▒╪▒╪│█î/╪º╪»╪║╪º┘à ┌⌐┘å ┘ê ┘ä╪╖┘ü╪º┘ï ┌⌐╪º╪▒┘ç╪º ╪▒╪º commit ┌⌐┘å.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `android/app/src/main/java/ir/taranom/crm/MainActivity.java`
- **Deploy:** Γ¥î ╪»╪▒ build ╪º┘å╪»╪▒┘ê█î╪» 2.0.5 (╪º╪▓ ╪╖╪▒█î┘é `scripts/release.ps1`) ╪º╪╣┘à╪º┘ä ┘à█îΓÇî╪┤┘ê╪»

### █▒█┤█░█┤/█░█┤/█▓█┤ ΓÇö [Claude Code] ╪▓█î╪▒╪│╪º╪«╪¬ ╪º┘å╪¬╪┤╪º╪▒ 1.0.10 ΓÇö ╪º╪│┌⌐╪▒█î┘╛╪¬ █î┌⌐ΓÇî╪»╪│╪¬┘ê╪▒█î release.ps1 + bump ┘å╪│╪«┘çΓÇî┘ç╪º
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ┘ç┘à█î┘å ┌⌐╪º┘à█î╪¬
- **╪«┘ä╪º╪╡┘ç:**
  - **┘å╪│╪«┘çΓÇî┘ç╪º bump ╪┤╪»:** ╪»╪│┌⌐╪¬╪º┘╛ `1.0.10` (desktop/package.json)╪î ╪º┘å╪»╪▒┘ê█î╪» `2.0.5` / versionCode `7` (build.gradle). ┘à╪¡╪¬┘ê╪º█î 1.0.10: ╪¬┘à ╪▓┘à╪▒╪»/╪┤╪¿ ┘à╪«┘à┘ä█î╪î ╪º╪╣╪»╪º╪» ╪º┘å┌»┘ä█î╪│█î ╪«┘ê╪»┌⌐╪º╪▒╪î UX ╪¼╪»█î╪» ╪ó┘╛╪»█î╪¬ (┘╛█î╪┤╪▒┘ü╪¬ ╪»╪º┘å┘ä┘ê╪»+┘å╪╡╪¿ ╪«┘ê╪»┌⌐╪º╪▒ ╪º┘å╪»╪▒┘ê█î╪»)╪î ╪ó█î┌⌐┘ê┘å ┘ê╪º┘é╪╣█î ┘ä┘ê┌»┘ê╪î SW v26.
  - **`scripts/release.ps1` ╪¼╪»█î╪»:** ╪º┘å╪¬╪┤╪º╪▒ ┌⌐╪º┘à┘ä ╪¿╪º █î┌⌐ ╪»╪│╪¬┘ê╪▒ ╪▒┘ê█î ╪│█î╪│╪¬┘à ┘ê█î┘å╪»┘ê╪▓: git pull ΓåÆ build ╪»╪│┌⌐╪¬╪º┘╛ ΓåÆ build ╪º┘å╪»╪▒┘ê█î╪» ΓåÆ **╪▒╪º╪│╪¬█îΓÇî╪ó╪▓┘à╪º█î█î ELF ╪»╪º╪«┘ä APK** (libnode ┘ç╪▒ █│ ABI + ┘à╪º┌ÿ┘ê┘äΓÇî┘ç╪º█î better_sqlite3 ΓÇö j┘ä┘ê┌»█î╪▒█î ╪º╪▓ ╪¬┌⌐╪▒╪º╪▒ ┘ü╪º╪¼╪╣┘ç APK ┘à╪▒╪»┘ç) ΓåÆ ╪¬┘ê┘ä█î╪» manifest/latest.yml (generate-release) ΓåÆ commit+push ┘à╪¬╪º╪»█î╪¬╪º ΓåÆ scp ┘å╪╡╪¿ΓÇî┌⌐┘å┘å╪»┘çΓÇî┘ç╪º ╪¿┘ç ╪│╪▒┘ê╪▒ ΓåÆ ssh deploy ┘ê╪¿ (pull+npm install+pm2 restart) + health-check. ┘ç╪▒ ┘à╪▒╪¡┘ä┘ç exit code ┌å┌⌐ ┘à█îΓÇî┌⌐┘å╪».
  - `generate-release.js`: notes ┘å╪│╪«┘ç ╪º╪▓ ╪ó╪▒┌»┘ê┘à╪º┘å/┘╛█î╪┤ΓÇî┘ü╪▒╪╢ █▒.█░.█▒█░.
  - **╪¬╪┤╪«█î╪╡ ┘à╪┤┌⌐┘ä ┬½╪¿╪▒┘å╪º┘à┘ç ╪¿╪º┘ä╪º ┘å┘à█îΓÇî╪ó█î╪»┬╗ ╪▒┘ê█î ┌»┘ê╪┤█î ┌⌐╪º╪▒╪¿╪▒:** ╪╣┌⌐╪│ ┘å╪┤╪º┘å ╪»╪º╪» Google Play Protect ┘å╪╡╪¿ ╪▒╪º ╪¿┘ä╪º┌⌐ ┌⌐╪▒╪»┘ç (┬½developer ┘å╪º╪┤┘å╪º╪│┬╗) ΓÇö ┘à╪┤┌⌐┘ä ┌⌐╪» ┘å█î╪│╪¬╪¢ ╪▒╪º┘ç ╪╣╪¿┘ê╪▒ ╪¿┘ç ┌⌐╪º╪▒╪¿╪▒ ╪»╪º╪»┘ç ╪┤╪». ┘à╪┤┌⌐┘ê┌⌐ ╪»┘ê┘à: APK ╪▒┘ê█î ╪│╪▒┘ê╪▒ ┘à┘à┌⌐┘å ╪º╪│╪¬ ┘ç┘à╪º┘å build ┘à╪▒╪»┘ç┘ö ELF-MISSING ╪¿╪º╪┤╪» ΓÇö ┘à┘å╪¬╪╕╪▒ SHA256 ╪º╪▓ ┌⌐╪º╪▒╪¿╪▒.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `scripts/release.ps1`, `scripts/generate-release.js`, `desktop/package.json`, `android/app/build.gradle`
- **Deploy:** ΓÅ│ ╪º╪¼╪▒╪º█î `scripts/release.ps1` ╪▒┘ê█î ╪│█î╪│╪¬┘à ┌⌐╪º╪▒╪¿╪▒ = ╪º┘å╪¬╪┤╪º╪▒ ┌⌐╪º┘à┘ä 1.0.10 (┘ê╪¿+╪»╪│┌⌐╪¬╪º┘╛+╪º┘å╪»╪▒┘ê█î╪»)
- **█î╪º╪»╪»╪º╪┤╪¬ ╪¿╪▒╪º█î Cursor:** ╪º╪▓ ╪º█î┘å ╪¿┘ç ╪¿╪╣╪» ╪º┘å╪¬╪┤╪º╪▒ ┘ü┘é╪╖ ╪¿╪º `release.ps1` ╪º┘å╪¼╪º┘à ╪┤┘ê╪» ΓÇö manifest/latest.yml/exe/apk ╪▒╪º ╪»█î┌»╪▒ ╪»╪│╪¬█î ┘ê ╪¼╪»╪º ╪º╪▓ ┘ç┘à ╪¿┘çΓÇî╪▒┘ê╪▓ ┘å┌⌐┘å█î╪» (╪▒█î╪┤┘ç┘ö ╪¡┘ä┘é┘ç┘ö ╪ó┘╛╪»█î╪¬ ┌⌐╪º╪░╪¿ ┘ê APK ┘à╪▒╪»┘ç ┘ç┘à█î┘å ┘å╪º┘ç┘à╪º┘ç┘å┌»█î ╪»╪│╪¬█î ╪¿┘ê╪»).

### █▒█┤█░█┤/█░█┤/█▓█┤ ΓÇö [Claude Code] ╪ó█î┌⌐┘ê┘å ╪º┘å╪»╪▒┘ê█î╪» ╪º╪▓ ┘ä┘ê┌»┘ê█î ┘ê╪º┘é╪╣█î ╪¬╪▒┘å┘à (┌»╪▓╪º╪▒╪┤ ┌⌐╪º╪▒╪¿╪▒: ╪ó█î┌⌐┘ê┘å ┘ä┘ê┌»┘ê ┘å╪¿┘ê╪»)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ┘ç┘à█î┘å ┌⌐╪º┘à█î╪¬
- **╪«┘ä╪º╪╡┘ç:**
  - ╪ó█î┌⌐┘ê┘å ┘ä╪º┘å┌å╪▒ ╪º┘å╪»╪▒┘ê█î╪» █î┌⌐ ┘ê┌⌐╪¬┘ê╪▒ ╪╣┘à┘ê┘à█î ╪»╪│╪¬█î ╪¿┘ê╪»╪î ┘å┘ç ┘ä┘ê┌»┘ê█î ╪¿╪▒┘å╪». ╪º╪▓ `server/public/logo.png` (█│█░█░█░├ù█│█░█░█░ ╪┤┘ü╪º┘ü) ╪¿╪º sharp ╪ó█î┌⌐┘ê┘å ┘ê╪º┘é╪╣█î ╪│╪º╪«╪¬┘ç ╪┤╪»: `ic_launcher.png` + `ic_launcher_round.png` ╪¿╪▒╪º█î █╡ ┌å┌»╪º┘ä█î (mdpi ╪¬╪º xxxhdpi╪î ╪▓┘à█î┘å┘ç ╪│┘ü█î╪» ┌»╪▒╪») + `ic_launcher_foreground.png` ╪¿╪▒╪º█î adaptive icon (╪º┘å╪»╪▒┘ê█î╪» █╕+╪î ╪▓┘à█î┘å┘ç ╪│┘ü█î╪» `@color/iconBackground`).
  - ┌»╪▓╪º╪▒╪┤ ╪»█î┌»╪▒ ┌⌐╪º╪▒╪¿╪▒: APK ┘å╪╡╪¿ ┘à█îΓÇî╪┤┘ê╪» ┘ê┘ä█î **╪¿╪▒┘å╪º┘à┘ç ╪º╪╡┘ä╪º┘ï ╪¿╪º┘ä╪º ┘å┘à█îΓÇî╪ó█î╪»** ΓÇö ┘à╪┤┌⌐┘ê┌⌐ ╪¿┘ç ╪ó┘╛┘ä┘ê╪» ┘ç┘à╪º┘å APK ┌⌐┘ç┘å┘çΓÇî╪º█î ┌⌐┘ç ELF ┘ç╪▒ █│ ABI ╪ó┘å MISSING ╪¿┘ê╪» (`SHA256=5341B460...`, █▓█▓█▓MB). ╪»╪│╪¬┘ê╪▒ ╪¬╪┤╪«█î╪╡ ╪¿┘ç ┌⌐╪º╪▒╪¿╪▒ ╪»╪º╪»┘ç ╪┤╪»╪¢ ╪│╪▒┘ê╪▒ ╪º╪▓ ╪º█î┘å ┘à╪¡█î╪╖ ┘é╪º╪¿┘ä ╪»╪│╪¬╪▒╪│█î ┘å█î╪│╪¬ (┘╛╪▒┘ê┌⌐╪│█î).
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `android/app/src/main/res/mipmap-*/ic_launcher*.png`, `mipmap-anydpi-v26/*.xml`, `values/colors.xml`
- **Deploy:** Γ¥î ┘å█î╪º╪▓ ╪¿┘ç build ╪º┘å╪»╪▒┘ê█î╪» ╪¿╪╣╪»█î (2.0.5)
- **█î╪º╪»╪»╪º╪┤╪¬ ╪¿╪▒╪º█î Cursor:** ┘é╪¿┘ä ╪º╪▓ build ╪¿╪╣╪»█î ╪¡╪¬┘à╪º┘ï `git pull` ΓÇö ╪ó█î┌⌐┘ê┘åΓÇî┘ç╪º + ╪¬╪║█î█î╪▒╪º╪¬ MainActivity (┘╛█î╪┤╪▒┘ü╪¬ ╪»╪º┘å┘ä┘ê╪»/┘å╪╡╪¿ ╪«┘ê╪»┌⌐╪º╪▒) + fix ┘ç╪º█î `build-android.ps1` (BOM/exit-code) ┘ç┘à┘ç ╪»╪▒ git ┘ç╪│╪¬┘å╪». ╪º┌»╪▒ APK ╪▒┘ê█î ╪│╪▒┘ê╪▒ ┘ç┘à╪º┘å ┘ü╪º█î┘ä █▓█│█▓┘¼█╖█┤█╖┘¼█▒█╣█╣ ╪¿╪º█î╪¬█î ╪º╪│╪¬╪î ╪«╪▒╪º╪¿ ╪º╪│╪¬ ┘ê ╪¿╪º█î╪» rebuild+re-upload ╪┤┘ê╪».

### █▒█┤█░█┤/█░█┤/█▓█┤ ΓÇö [Claude Code] ┘╛█î╪º╪»┘çΓÇî╪│╪º╪▓█î ┌⌐╪º┘à┘ä ╪¬┘à: ┬½╪▓┘à╪▒╪» ┘à╪»╪▒┘å┬╗ (╪▒┘ê╪┤┘å╪î ┘╛█î╪┤ΓÇî┘ü╪▒╪╢) + ┬½╪┤╪¿ ┘à╪«┘à┘ä█î┬╗ (╪»╪º╪▒┌⌐ΓÇî┘à┘ê╪»)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ┘ç┘à█î┘å ┌⌐╪º┘à█î╪¬
- **╪«┘ä╪º╪╡┘ç:** ╪º╪¼╪▒╪º█î ┌⌐╪º┘à┘ä `docs/design/THEME-IMPLEMENTATION.md` (╪º╪│┘╛┌⌐█î ┌⌐┘ç ╪¿╪▒╪º█î Cursor ┘å┘ê╪┤╪¬┘ç ╪┤╪»┘ç ╪¿┘ê╪» ΓÇö ┌å┘ê┘å ┌⌐╪º╪▒╪¿╪▒ ╪«┘ê╪º╪│╪¬ ╪«┘ê╪» Claude ╪º╪¼╪▒╪º ┌⌐┘å╪»):
  - **╪¬┘ê┌⌐┘åΓÇî┘ç╪º:** ╪¿┘ä┘ê┌⌐ `:root` ╪¿╪º╪▓┘å┘ê█î╪│█î ╪┤╪» (┘╛╪º┘ä╪¬ ╪▓┘à╪▒╪» ┘à╪»╪▒┘å) + ╪¿┘ä┘ê┌⌐ `html[data-theme=dark]` (╪┤╪¿ ┘à╪«┘à┘ä█î: ╪│╪¿╪▓ ┘å╪ª┘ê┘å█î `#3DDC8C`╪î ╪╖┘ä╪º█î█î `#E7C876`╪î ╪▓┘à█î┘å┘ç `#0D1512`) + ╪¬┘ê┌⌐┘åΓÇî┘ç╪º█î ╪¼╪»█î╪»: `--on-accent`, `--side-bg`, `--shadow-card`, `--input-bg`, `--th-bg`, `--row-hover`, `--well`, `--chat-bg`, `--bub-me` ┘ê █╡ ╪«╪º┘å┘ê╪º╪»┘ç ┌å█î┘╛ ┘à╪╣┘å╪º█î█î (`--ok/bad/amber/info/violet-bg/fg`).
  - **╪¼╪º╪▒┘ê█î ┘ç╪º╪▒╪»┌⌐╪»:** ┘ç┘à┘ç ╪│╪╖╪¡ΓÇî┘ç╪º█î `#fff`/┘╛╪º╪│╪¬┘ä█î ╪¿┘ä┘ê┌⌐ `<style>` ╪¿┘ç ╪¬┘ê┌⌐┘å ╪¬╪¿╪»█î┘ä ╪┤╪» (┘à┘ê╪»╪º┘äΓÇî┘ç╪º╪î ┘ü╪▒┘àΓÇî┘ç╪º╪î ╪¼╪»┘ê┘äΓÇî┘ç╪º╪î ╪»█î╪¬ΓÇî┘╛█î┌⌐╪▒╪î ┌⌐╪º┘å╪¿╪º┘å╪î ┌å╪¬ ╪¬┘ä┌»╪▒╪º┘à█î╪î ┘╛┘ê╪▒╪¬╪º┘ä B2B╪î ╪¬╪º█î┘àΓÇî┘ä╪º█î┘å...). ┘à╪¬┘å ╪▒┘ê█î ╪»┌⌐┘à┘çΓÇî┘ç╪º█î accent ΓåÆ `var(--on-accent)` (╪»╪▒ ╪»╪º╪▒┌⌐ ╪¬█î╪▒┘ç ┘à█îΓÇî╪┤┘ê╪» ┌å┘ê┘å ╪│╪¿╪▓ ┘å╪ª┘ê┘å█î ╪▒┘ê╪┤┘å ╪º╪│╪¬).
  - **╪│┘ê█î█î┌å:** ╪»┌⌐┘à┘ç ┬½≡ƒîÖ/ΓÿÇ∩╕Å┬╗ ╪»╪▒ foot ╪│╪º█î╪»╪¿╪º╪▒ + ┌»┘ê╪┤┘ç ╪╡┘ü╪¡┘ç ┘ê╪▒┘ê╪»╪¢ ╪░╪«█î╪▒┘ç ╪»╪▒ `localStorage['crm_theme']`╪¢ ╪º╪│┌⌐╪▒█î┘╛╪¬ ╪╢╪»-FOUC ╪º┘ê┘ä `<head>`╪¢ `meta theme-color` ┘ç┘à┌»╪º┘à.
  - **╪º┘à╪╢╪º┘ç╪º:** ┌⌐╪º╪▒╪¬ ╪ó┘à╪º╪▒ ╪º┘ê┘ä ┌»╪▒╪º╪»█î╪º┘å ╪¿╪▒┘å╪» (┘ç╪▒ ╪»┘ê ╪¬┘à)╪¢ ╪»╪▒ ╪»╪º╪▒┌⌐: ┘ç╪º┘ä┘ç┘ö ╪│╪¿╪▓ radial ╪▒┘ê█î body╪î ┌»╪▒╪º╪»█î╪º┘å ┌⌐╪º╪▒╪¬ΓÇî┘ç╪º╪î ╪»╪▒╪«╪┤╪┤ ┘ä┘ê┌»┘ê.
  - **┘å┘à┘ê╪»╪º╪▒:** `drawChart` ╪¬┘àΓÇî╪ó┌»╪º┘ç ╪┤╪» (╪¿┘å┘ü╪┤ ┘ç╪º╪▒╪»┌⌐╪» ┘é╪»█î┘à█î `#7C3AED` ╪¡╪░┘ü!) + `rebuildChartsForTheme()` ┘ç┘å┌»╪º┘à ╪│┘ê█î█î┌å.
  - **┌å╪º┘╛:** ╪»╪▒ `@media print` ╪¬┘ê┌⌐┘åΓÇî┘ç╪º█î ╪»╪º╪▒┌⌐ ╪¿┘ç ╪▒┘ê╪┤┘å ╪¿╪▒┘à█îΓÇî┌»╪▒╪»┘å╪» ΓÇö ┘ü╪º┌⌐╪¬┘ê╪▒/┌»╪▓╪º╪▒╪┤ ┘ç┘à█î╪┤┘ç ╪▒┘ê╪┤┘å ┌å╪º┘╛ ┘à█îΓÇî╪┤┘ê╪».
  - **╪¬╪│╪¬:** ╪º╪│┌⌐╪▒█î┘åΓÇî╪┤╪º╪¬ Playwright ╪º╪▓ ┘ê╪▒┘ê╪»/╪»╪º╪┤╪¿┘ê╪▒╪»/┘à╪┤╪¬╪▒█î╪º┘å/┘ü╪º┌⌐╪¬┘ê╪▒/┘à┘ê╪»╪º┘ä/╪┤┘ä ╪¡╪│╪º╪¿╪»╪º╪▒█î/┌»╪▓╪º╪▒╪┤╪º╪¬ ╪»╪▒ ┘ç╪▒ ╪»┘ê ╪¬┘à ΓÇö ╪¿╪»┘ê┘å ┘ä┌⌐┘ç ╪│┘ü█î╪» █î╪º ┘à╪¬┘å ┌⌐┘àΓÇî┌⌐┘å╪¬╪▒╪º╪│╪¬╪¢ ╪¬┘à ╪¿╪╣╪» ╪º╪▓ reload ╪¡┘ü╪╕ ┘à█îΓÇî╪┤┘ê╪» (anti-FOUC)╪¢ parse ╪º╪│┌⌐╪▒█î┘╛╪¬ ╪│╪¿╪▓. ╪▒╪º┘ç┘å┘à╪º ╪¿┘çΓÇî╪▒┘ê╪▓ ╪┤╪»╪¢ SW ΓåÆ `v26`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/public/sw.js`
- **Deploy:** Γ£à pull + pm2 restart ╪│╪▒┘ê╪▒ production restart
- **█î╪º╪»╪»╪º╪┤╪¬ ╪¿╪▒╪º█î Cursor:** ╪¬┘à token-┘à╪¡┘ê╪▒ ╪º╪│╪¬ ΓÇö ╪º╪▓ ╪º█î┘å ╪¿┘ç ╪¿╪╣╪» **┘ç█î┌å ╪▒┘å┌» ╪│╪╖╪¡█î ╪▒╪º ┘ç╪º╪▒╪»┌⌐╪» ┘å┌⌐┘å█î╪»**╪¢ ╪º╪▓ ╪¬┘ê┌⌐┘åΓÇî┘ç╪º█î `:root` ╪º╪│╪¬┘ü╪º╪»┘ç ┌⌐┘å█î╪» ┘ê┌»╪▒┘å┘ç ╪»╪▒ ╪»╪º╪▒┌⌐ΓÇî┘à┘ê╪» ┘ä┌⌐┘ç ┘à█îΓÇî╪┤┘ê╪». ╪¿╪▒╪º█î ╪▒┘å┌» ┘à╪¬┘å ╪▒┘ê█î ╪»┌⌐┘à┘ç ╪│╪¿╪▓ ╪º╪▓ `var(--on-accent)` ╪º╪│╪¬┘ü╪º╪»┘ç ┌⌐┘å█î╪» ┘å┘ç `#fff`.

### █▒█┤█░█┤/█░█┤/█▓█┤ ΓÇö [Claude Code] ╪º╪╣╪»╪º╪» ╪º┘å┌»┘ä█î╪│█î ╪«┘ê╪»┌⌐╪º╪▒ + UX ╪¼╪»█î╪» ╪ó┘╛╪»█î╪¬ (╪»┌⌐┘à┘ç ╪¬╪¿╪»█î┘äΓÇî╪┤┘ê┘å╪»┘ç + ┘╛█î╪┤╪▒┘ü╪¬ ╪»╪º┘å┘ä┘ê╪») + ╪▒┘ü╪╣ ╪¡┘ä┘é┘ç ╪ó┘╛╪»█î╪¬ ┌⌐╪º╪░╪¿ ╪»╪│┌⌐╪¬╪º┘╛
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ┘ç┘à█î┘å ┌⌐╪º┘à█î╪¬
- **╪«┘ä╪º╪╡┘ç:**
  - **╪º╪╣╪»╪º╪» ╪º┘å┌»┘ä█î╪│█î ╪«┘ê╪»┌⌐╪º╪▒:** listener ╪│╪▒╪º╪│╪▒█î ΓÇö ╪»╪▒ ┘ü█î┘ä╪»┘ç╪º█î ╪╣╪»╪»█î (type number/tel╪î inputmode numeric/decimal╪î class money╪î data-jdate╪î id┘ç╪º█î phone/qty/price/barcode/...) ╪▒┘é┘à ┘ü╪º╪▒╪│█î/╪╣╪▒╪¿█î ┘ç┘à╪º┘å ┘ä╪¡╪╕┘ç ╪¬╪º█î┘╛ ╪¿┘ç ╪º┘å┌»┘ä█î╪│█î ╪¬╪¿╪»█î┘ä ┘à█îΓÇî╪┤┘ê╪» (╪¿╪º ╪¡┘ü╪╕ caret). ┘à╪¬┘å ╪ó╪▓╪º╪» (textarea/█î╪º╪»╪»╪º╪┤╪¬) ╪»╪│╪¬ ┘å┘à█îΓÇî╪«┘ê╪▒╪». ┘é╪¿┘ä╪º┘ï ┘ü█î┘ä╪» money ╪▒┘é┘à ┘ü╪º╪▒╪│█î ╪▒╪º ┌⌐┘ä╪º┘ï ╪¡╪░┘ü ┘à█îΓÇî┌⌐╪▒╪» ΓÇö ╪¡╪º┘ä╪º ┘à█îΓÇî┘╛╪░█î╪▒╪».
  - **UX ╪ó┘╛╪»█î╪¬ ╪»╪│┌⌐╪¬╪º┘╛:** ┘╛┘å┘ä ╪¿┘çΓÇî╪▒┘ê╪▓╪▒╪│╪º┘å█î ╪¡╪º┘ä╪º **█î┌⌐ ╪»┌⌐┘à┘ç ╪¬╪¿╪»█î┘äΓÇî╪┤┘ê┘å╪»┘ç** ╪»╪º╪▒╪»: ┬½≡ƒöä ╪¿╪▒╪▒╪│█î┬╗ ΓåÆ (╪»╪▒ ╪¡╪º┘ä ╪»╪º┘å┘ä┘ê╪» + ┘å┘ê╪º╪▒ ┘╛█î╪┤╪▒┘ü╪¬ ╪¿╪º ┬½X ╪º╪▓ Y ┘à┌»╪º╪¿╪º█î╪¬ ΓÇö ╪¡╪»┘ê╪» N ╪½╪º┘å█î┘ç/╪»┘é█î┘é┘ç ┘à╪º┘å╪»┘ç┬╗) ΓåÆ ┬½≡ƒÜÇ ┘å╪╡╪¿ ┘å╪│╪«┘ç X ┘ê ╪▒╪º┘çΓÇî╪º┘å╪»╪º╪▓█î ┘à╪¼╪»╪»┬╗. `desktop/main.js` ┘ç┘à transferred/total/bps ╪▒╪º ╪º╪▓ electron-updater ╪¿┘ç UI ┘à█îΓÇî┘ü╪▒╪│╪¬╪» (**┘å█î╪º╪▓ ╪¿┘ç build ╪»╪│┌⌐╪¬╪º┘╛ ╪¼╪»█î╪» ╪¿╪▒╪º█î ETA╪¢ UI ╪¿╪º build┘ç╪º█î ┘é╪»█î┘à█î ┘ç┘à ╪│╪º╪▓┌»╪º╪▒ ╪º╪│╪¬ ΓÇö ┘ü┘é╪╖ ╪»╪▒╪╡╪» ┘å╪┤╪º┘å ┘à█îΓÇî╪»┘ç╪»**).
  - **UX ╪ó┘╛╪»█î╪¬ ╪º┘å╪»╪▒┘ê█î╪»:** `MainActivity` ╪»╪º┘å┘ä┘ê╪» APK ╪▒╪º ╪º╪▓ DownloadManager ╪▒╪╡╪» ┘ê ┘╛█î╪┤╪▒┘ü╪¬ ╪▒╪º ╪¿┘ç `window.onApkDownloadProgress` ┘à█îΓÇî┘ü╪▒╪│╪¬╪» (┘à┌»╪º╪¿╪º█î╪¬/╪»╪▒╪╡╪»/╪▓┘à╪º┘å ╪¿╪º┘é█îΓÇî┘à╪º┘å╪»┘ç ╪»╪▒ ╪¿┘å╪▒) ┘ê ┘╛╪│ ╪º╪▓ ┘╛╪º█î╪º┘å ╪»╪º┘å┘ä┘ê╪»╪î ┘╛┘å╪¼╪▒┘ç ┘å╪╡╪¿ **╪«┘ê╪»┌⌐╪º╪▒** ╪¿╪º╪▓ ┘à█îΓÇî╪┤┘ê╪» (permission ╪¼╪»█î╪» `REQUEST_INSTALL_PACKAGES` ╪»╪▒ manifest). **┘å█î╪º╪▓ ╪¿┘ç build ╪º┘å╪»╪▒┘ê█î╪» ╪¿╪╣╪»█î.**
  - **╪▒┘ü╪╣ ╪¡┘ä┘é┘ç ╪ó┘╛╪»█î╪¬ ┌⌐╪º╪░╪¿:** `manifest.json` ╪º╪»╪╣╪º█î desktop=1.0.9 ╪»╪º╪┤╪¬ ┘ê┘ä█î url ╪¿┘ç exe ┘å╪│╪«┘ç 1.0.8 ╪º╪┤╪º╪▒┘ç ┘à█îΓÇî┌⌐╪▒╪» (installer 1.0.9 ┘ç╪▒┌»╪▓ ╪│╪º╪«╪¬┘ç ┘å╪┤╪»┘ç) ΓåÆ ┌⌐╪º╪▒╪¿╪▒ ╪ó┘╛╪»█î╪¬ ┘à█îΓÇî╪▓╪»╪î 1.0.8 ┘å╪╡╪¿ ┘à█îΓÇî╪┤╪» ┘ê ╪»┘ê╪¿╪º╪▒┘ç ┘╛█î╪º┘à ╪ó┘╛╪»█î╪¬ ┘à█îΓÇî┌»╪▒┘ü╪¬. ┘å╪│╪«┘ç ╪¿┘ç `1.0.8` ╪╡╪º╪»┘é╪º┘å┘ç ╪┤╪».
  - **╪¬╪│╪¬:** curl ╪▒┘ê█î `/api/system/app-update` (╪│┘ç ╪│┘å╪º╪▒█î┘ê) + █▒█╢ assertion ╪¼╪»█î╪» Playwright (state machine ╪»┌⌐┘à┘ç╪î ╪¿╪▒┌å╪│╪¿ MB/ETA╪î callback ╪º┘å╪»╪▒┘ê█î╪»╪î ╪¬╪¿╪»█î┘ä ╪º╪▒┘é╪º┘à money/jdate/tel ┘ê ┘à╪╡┘ê┘å ┘à╪º┘å╪»┘å textarea) + █▓█▓ ╪¬╪│╪¬ SMS ╪│╪¿╪▓ + parse ╪º╪│┌⌐╪▒█î┘╛╪¬. ╪▒╪º┘ç┘å┘à╪º█î ╪º╪»┘à█î┘å/┘ü╪▒┘ê╪┤ ╪¿┘çΓÇî╪▒┘ê╪▓ ╪┤╪»╪¢ SW ΓåÆ `v25`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/public/sw.js`, `server/public/releases/manifest.json`, `desktop/main.js`, `android/.../MainActivity.java`, `android/app/src/main/AndroidManifest.xml`
- **Deploy:** Γ£à pull + pm2 restart ╪│╪▒┘ê╪▒ production restart (┘ü╪▒╪º┘å╪¬/manifest). ╪»╪│┌⌐╪¬╪º┘╛ ┘ê ╪º┘å╪»╪▒┘ê█î╪» ╪»╪▒ build ╪¿╪╣╪»█î.
- **█î╪º╪»╪»╪º╪┤╪¬ ╪¿╪▒╪º█î Cursor:** ΓÜá∩╕Å installer ╪»╪│┌⌐╪¬╪º┘╛ **1.0.9 ┘ç┘å┘ê╪▓ ╪│╪º╪«╪¬┘ç ┘å╪┤╪»┘ç** ΓÇö ╪¿╪╣╪» ╪º╪▓ build ╪¡╪¬┘à╪º┘ï manifest+latest.yml ╪▒╪º ╪¿╪º ┘ç┘à bump ┌⌐┘å█î╪» (╪▒█î╪┤┘ç ╪¡┘ä┘é┘ç ╪ó┘╛╪»█î╪¬ ┌⌐╪º╪░╪¿ ┘ç┘à█î┘å ┘å╪º┘ç┘à╪º┘ç┘å┌»█î ╪¿┘ê╪»). ╪»╪▒ build ╪¿╪╣╪»█î ╪º┘å╪»╪▒┘ê█î╪»╪î ╪¬╪║█î█î╪▒╪º╪¬ MainActivity/manifest ┘à┘å ┘ç┘à ╪│┘ê╪º╪▒ ┘à█îΓÇî╪┤┘ê╪».

### █▒█┤█░█┤/█░█┤/█▓█┤ ΓÇö [Claude Code] ╪▒┘ü╪╣ ╪┤┌⌐╪│╪¬ build ╪º┘å╪»╪▒┘ê█î╪» ╪▒┘ê█î ╪│█î╪│╪¬┘à ┌⌐╪º╪▒╪¿╪▒ (SDK location + ┌»╪▓╪º╪▒╪┤ succes ┌⌐╪º╪░╪¿)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ┘ç┘à█î┘å ┌⌐╪º┘à█î╪¬
- **╪«┘ä╪º╪╡┘ç:** ┌⌐╪º╪▒╪¿╪▒ `finalize-android-release.ps1` ╪▒╪º ╪º╪¼╪▒╪º ┌⌐╪▒╪» ┘ê build ╪¿╪º `SDK location not found` ╪┤┌⌐╪│╪¬ ╪«┘ê╪▒╪» ┘ê┘ä█î ╪º╪│┌⌐╪▒█î┘╛╪¬ APK ┌⌐┘ç┘å┘ç ╪▒╪º `BUILD=SUCCESS` ┌»╪▓╪º╪▒╪┤ ┌⌐╪▒╪» (┌å┌⌐ ELF ╪¼┘ä┘ê█î ╪ó┘╛┘ä┘ê╪» ╪▒╪º ┌»╪▒┘ü╪¬ ΓÇö ┘ç╪▒ █│ ABI MISSING). ╪▒█î╪┤┘çΓÇî┘ç╪º ┘ê ╪º╪╡┘ä╪º╪¡ ╪»╪▒ `scripts/build-android.ps1`:
  - `local.properties` ╪¿╪º `Set-Content -Encoding UTF8` ┘å┘ê╪┤╪¬┘ç ┘à█îΓÇî╪┤╪» ΓåÆ ╪»╪▒ PowerShell 5 **BOM** ╪»╪º╪▒╪» ┘ê Gradle ┌⌐┘ä█î╪» `sdk.dir` ╪▒╪º ┘å┘à█îΓÇî╪¿█î┘å╪». ╪¡╪º┘ä╪º ╪¿╪º `[IO.File]::WriteAllText` ╪¿╪»┘ê┘å BOM ┘ê ╪¿╪º `/` ┘å┘ê╪┤╪¬┘ç ┘à█îΓÇî╪┤┘ê╪».
  - `$env:ANDROID_HOME` ┘ç┘à ╪╡╪▒█î╪¡╪º┘ï ╪│╪¬ ┘à█îΓÇî╪┤┘ê╪» (┘à╪│█î╪▒ ╪»┘ê┘à ╪¬╪┤╪«█î╪╡ SDK ╪¿╪▒╪º█î Gradle).
  - exit code ┌»╪▒█î╪»┘ä ┌å┌⌐ ┘à█îΓÇî╪┤┘ê╪» (`$LASTEXITCODE`) ┘ê APK ┘é╪»█î┘à█î **┘é╪¿┘ä ╪º╪▓** build ╪¡╪░┘ü ┘à█îΓÇî╪┤┘ê╪» ΓåÆ ╪»█î┌»╪▒ success ┌⌐╪º╪░╪¿ ┘à┘à┌⌐┘å ┘å█î╪│╪¬.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `scripts/build-android.ps1`
- **Deploy:** Γ¥î ╪▒╪¿╪╖█î ╪¿┘ç ╪│╪▒┘ê╪▒ ┘å╪»╪º╪▒╪» (╪º╪│┌⌐╪▒█î┘╛╪¬ build ┘ê█î┘å╪»┘ê╪▓)
- **█î╪º╪»╪»╪º╪┤╪¬ ╪¿╪▒╪º█î Cursor:** ΓÜá∩╕Å `scripts/finalize-android-release.ps1` ┘ê ┘å╪│╪«┘ç┘ö ┘à╪¡┘ä█î `build-android.ps1` ╪┤┘à╪º (┘╛█î╪º┘à ┬½better-sqlite3 Android ELF modules present┬╗ ╪»╪º╪▒╪») **╪»╪▒ git ┘å█î╪│╪¬┘å╪»** ΓÇö ┘ä╪╖┘ü╪º┘ï ╪╖╪¿┘é ┘é╪º┘å┘ê┘å CLAUDE.md commit ┌⌐┘å█î╪» ┘ê ┘ç┘à█î┘å ╪»┘ê fix (BOM + exit code) ╪▒╪º ╪º┌»╪▒ ┘å╪│╪«┘ç┘ö ┘à╪¡┘ä█îΓÇî╪¬╪º┘å ╪¼╪»╪º╪│╪¬ ╪º╪╣┘à╪º┘ä/merge ┌⌐┘å█î╪». ╪╢┘à┘å ╪º█î┘å┌⌐┘ç ELF ╪│┘ç ABI ╪»╪▒ APK ┌⌐┘ç┘å┘ç MISSING ╪¿┘ê╪» ΓÇö ╪¿╪╣╪» ╪º╪▓ build ┘à┘ê┘ü┘é ╪¡╪¬┘à╪º┘ï ╪«╪▒┘ê╪¼█î ┌å┌⌐ ELF ╪¿╪▒╪▒╪│█î ╪┤┘ê╪».

### █▒█┤█░█┤/█░█┤/█▓█┤ ΓÇö ╪▒┘ü╪╣ ╪º╪│┌⌐╪▒┘ê┘ä ┘╛█î╪º┘àΓÇî┘ç╪º + build ╪º┘å╪»╪▒┘ê█î╪» 2.0.4
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `d5e079b`
- **╪«┘ä╪º╪╡┘ç:**
  - **┘╛█î╪º┘àΓÇî┘ç╪º:** ╪º╪│┌⌐╪▒┘ê┘ä ╪╣┘à┘ê╪»█î ╪»╪▒ ┘╛┘å╪¼╪▒┘ç ┘à┌⌐╪º┘ä┘à┘ç (`min-height:0` + `overflow-y:auto`)╪¢ ╪¡╪¿╪º╪¿ ┘╛█î╪º┘à `fit-content`╪¢ ╪¡┘ü╪╕ ┘à┘ê┘é╪╣█î╪¬ ╪º╪│┌⌐╪▒┘ê┘ä ┘ç┘å┌»╪º┘à polling╪¢ SW ΓåÆ `v24`.
  - **╪º┘å╪»╪▒┘ê█î╪» 2.0.4:** Gradle wrapper + JDK 17 + libnode ╪º╪▓ zip ╪▒╪│┘à█î nodejs-mobile╪¢ `buildConfig` ┘ü╪╣╪º┘ä╪¢ exclude ┘ü╪º█î┘äΓÇî┘ç╪º█î `.exe` ╪»╪│┌⌐╪¬╪º┘╛ ╪º╪▓ assets (╪▒┘ü╪╣ OOM █▓GB)╪¢ APK release ╪│╪º╪«╪¬┘ç ┘ê ╪ó┘╛┘ä┘ê╪» ╪¿┘ç `/releases/erp-taranom.apk` (~148MB).
  - **╪º╪│┌⌐╪▒█î┘╛╪¬:** `scripts/build-android.ps1` ╪¿╪▒╪º█î build┘ç╪º█î ╪¿╪╣╪»█î.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/public/sw.js`, `android/app/build.gradle`, `android/gradle.properties`, `android/gradlew*`, `scripts/build-android.ps1`, `server/public/releases/manifest.json`
- **Deploy:** Γ£à ┘ê╪¿ (pull+pm2) + APK ╪▒┘ê█î ╪│╪▒┘ê╪▒

### █▒█┤█░█┤/█░█┤/█▓█┤ ΓÇö [Claude Code] ╪º╪│┘╛┌⌐ ┌⌐╪º┘à┘ä ╪¬┘à ┬½╪▓┘à╪▒╪» ┘à╪»╪▒┘å + ╪┤╪¿ ┘à╪«┘à┘ä█î┬╗ ╪¿╪▒╪º█î ╪º╪¼╪▒╪º ╪¬┘ê╪│╪╖ Cursor
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `dc602ed` (┘ü┘é╪╖ docs ΓÇö ┌⌐╪» ╪¿╪▒┘å╪º┘à┘ç ╪»╪│╪¬ ┘å╪«┘ê╪▒╪»┘ç)
- **╪«┘ä╪º╪╡┘ç:**
  - ┌⌐╪º╪▒╪¿╪▒ ╪¬╪▒┌⌐█î╪¿ ╪¬╪ú█î█î╪»╪┤╪»┘ç ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐╪▒╪»: **╪¿┘ê╪▒╪» █▒ (╪▓┘à╪▒╪» ┘à╪»╪▒┘å) ╪¬┘à ╪º╪╡┘ä█î ╪▒┘ê╪┤┘å + ╪¿┘ê╪▒╪» █▓ (╪┤╪¿ ┘à╪«┘à┘ä█î) ╪»╪º╪▒┌⌐ΓÇî┘à┘ê╪»**.
  - ╪│┘å╪» ╪º╪¼╪▒╪º█î█î ┌⌐╪º┘à┘ä ╪¿╪▒╪º█î Cursor ┘å┘ê╪┤╪¬┘ç ╪┤╪»: `docs/design/THEME-IMPLEMENTATION.md` ΓÇö ╪┤╪º┘à┘ä ╪¬┘ê┌⌐┘åΓÇî┘ç╪º█î ┌⌐╪º┘à┘ä CSS ┘ç╪▒ ╪»┘ê ╪¬┘à╪î ╪¿┘ä┘ê┌⌐ `html[data-theme=dark]`╪î ╪º╪│┌⌐╪▒█î┘╛╪¬ ╪╢╪»-FOUC╪î ╪│┘ê█î█î┌å ≡ƒîÖ (localStorage `crm_theme`)╪î ╪¼╪»┘ê┘ä ┘╛╪º┌⌐ΓÇî╪│╪º╪▓█î ╪▒┘å┌»ΓÇî┘ç╪º█î ┘ç╪º╪▒╪»┌⌐╪»╪î helper ╪¬┘àΓÇî╪ó┌»╪º┘ç Chart.js╪î ┌å╪º┘╛┘É ┘ç┘à█î╪┤┘çΓÇî╪▒┘ê╪┤┘å╪î bump SW╪î ┘ê ┌å┌⌐ΓÇî┘ä█î╪│╪¬ QA.
  - ┘ü╪º█î┘äΓÇî┘ç╪º█î ┘à╪▒╪¼╪╣ ┌»╪▒╪º┘ü█î┌⌐█î ╪»╪▒ repo: `docs/design/board1-modern-emerald.png`, `docs/design/board2-velvet-night.png`, `docs/design/design-boards-reference.html`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `docs/design/THEME-IMPLEMENTATION.md`, `docs/design/*.png`, `docs/design/design-boards-reference.html`
- **Deploy:** Γ¥î ┘ä╪º╪▓┘à ┘å█î╪│╪¬ (╪º╪¼╪▒╪º ╪¿╪º Cursor ╪º╪│╪¬)


### █▒█┤█░█┤/█░█┤/█▓█┤ ΓÇö ┘å╪│╪«┘ç 1.0.9 (┘ü╪º┌⌐╪¬┘ê╪▒╪î ┌⌐╪º╪¬╪º┘ä┘ê┌»╪î ┘╛█î╪º┘àΓÇî┘ç╪º╪î AI ┌⌐╪º╪▒╪¿╪▒╪î ╪ó█î┌⌐┘ê┘åΓÇî┘ç╪º)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `843ecd2`
- **╪«┘ä╪º╪╡┘ç:** ┘╛█î╪º╪»┘çΓÇî╪│╪º╪▓█î ┌⌐╪º┘à┘ä `update1.0.9.md`:
  - **┬º1 ┘ü╪º┌⌐╪¬┘ê╪▒:** ╪¡╪░┘ü ┘ü█î┘ä╪» ┌⌐╪º┘å╪º┘ä ┘ü╪▒┘ê╪┤ ╪º╪▓ UI╪¢ `resolveSalesChannel()` ╪»╪▒ backend ╪º╪▓ ┘å┘é╪┤ ┌⌐╪º╪▒╪¿╪▒ (┘à█î╪»╪º┘å█îΓåÆfield╪î ╪¬┘ä┘ü┘å█îΓåÆphone)╪¢ ╪¡╪░┘ü ┬½╪│╪º╪«╪¬ ┘à╪¡╪╡┘ê┘ä┬╗ ╪º╪▓ ┘ü╪º┌⌐╪¬┘ê╪▒╪│╪º╪▓╪¢ `/products/quick` ┘ü┘é╪╖ admin.
  - **┬º2 ┌⌐╪º╪¬╪º┘ä┘ê┌»:** `GET /warehouses` ╪¿╪▒╪º█î ┘ç┘à┘ç ┌⌐╪º╪▒╪¿╪▒╪º┘å auth╪¢ ╪¬╪▒╪¬█î╪¿ route┘ç╪º█î ┘à╪¡╪╡┘ê┘ä╪º╪¬ (`/categories`╪î `/by-barcode` ┘é╪¿┘ä ╪º╪▓ `/:id`).
  - **┬º3 ┘╛█î╪º┘àΓÇî┘ç╪º:** API `/messages/threads`╪î `/thread/:peer`╪î `/thread/:peer/read`╪¢ UI ╪¬┘ä┌»╪▒╪º┘à█î ╪¿╪º polling╪î ╪¡╪¿╪º╪¿╪î ╪¬█î┌⌐ ╪»┘ê╪¿┘ä.
  - **┬º4 ╪¡╪│╪º╪¿ ┘à┘å:** `clamp()` + `fitStatNums()` ╪¿╪▒╪º█î ╪º╪╣╪»╪º╪» ╪¿╪▓╪▒┌» ╪»╪▒ ┌⌐╪º╪▒╪¬ΓÇî┘ç╪º█î ╪ó┘à╪º╪▒.
  - **┬º5 ┘╛╪▒╪»╪º╪«╪¬ ┘à╪╣┘ä┘é:** ╪º╪│┌⌐╪▒█î┘╛╪¬ `cleanup-aref-pending.js`╪¢ ╪¡╪░┘ü ╪¬╪│┘ê█î┘ç ╪¬╪ú█î█î╪»╪┤╪»┘ç ΓåÆ ┘ê╪╢╪╣█î╪¬ `rep_payment_submissions` ╪¿┘ç rejected.
  - **┬º6 AI ┌⌐╪º╪▒╪¿╪▒:** `GET /api/ai/my-summary` + `buildMySummary()` ┘ü┘é╪╖ ╪»╪º╪»┘ç┘ö `user_id` ╪«┘ê╪» ┌⌐╪º╪▒╪¿╪▒.
  - **┬º7 ╪ó█î┌⌐┘ê┘åΓÇî┘ç╪º:** Lucide SVG ╪»╪▒ ┘à┘å┘ê ┘ê ┌⌐╪º╪▒╪¬ΓÇî┘ç╪º█î ╪ó┘à╪º╪▒ (`lucide()` + `EMO_LU`).
  - **╪¬╪│╪¬:** `scripts/test-1.0.9.js` (█▓█▒ assertion). ╪▒╪º┘ç┘å┘à╪º█î ╪º╪»┘à█î┘å/┘ü╪▒┘ê╪┤ ╪¿┘çΓÇî╪▒┘ê╪▓ ╪┤╪»╪¢ SW ΓåÆ `v23`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/routes/invoices.js`, `server/routes/products.js`, `server/routes/warehouses.js`, `server/routes/messages.js`, `server/routes/accounting.js`, `server/routes/ai.js`, `server/services/ai.js`, `server/scripts/test-1.0.9.js`, `server/scripts/cleanup-aref-pending.js`, `server/public/sw.js`
- **Deploy:** Γ£à deploy ╪┤╪»┘ç (pull + pm2 restart ΓÇö aref: ┌⌐╪º╪▒╪¿╪▒ #3 █î╪º┘ü╪¬ ╪┤╪»╪î ╪▒┌⌐┘ê╪▒╪» pending ┘å╪»╪º╪┤╪¬)

### █▒█┤█░█┤/█░█┤/█▓█┤ ΓÇö ┘╛┘ê╪▒╪¬╪º┘ä ┘à╪┤╪¬╪▒█î╪º┘å B2B (╪º┘å╪¬┘é╪º┘ä ╪º╪▓ ERP v4 ΓÇö ┘ü┘é╪╖ ┘à╪▒┌⌐╪▓█î)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `3acd305`
- **╪«┘ä╪º╪╡┘ç:** ┘╛┘ê╪▒╪¬╪º┘ä ╪│┘ü╪º╪▒╪┤ ╪ó┘å┘ä╪º█î┘å ┘à╪┤╪¬╪▒█î╪º┘å ╪╣┘à╪»┘ç ΓÇö ┌⌐╪º┘à┘ä╪º┘ï ╪º┘ü╪▓┘ê╪»┘å█î╪î ╪¿╪»┘ê┘å ╪»╪│╪¬ ╪▓╪»┘å ╪¿┘ç ╪¼╪▒█î╪º┘åΓÇî┘ç╪º█î ┘à┘ê╪¼┘ê╪»:
  - **Backend:** ╪¼╪»╪º┘ê┘ä `b2b_portal_accounts` + `b2b_portal_orders` (╪«╪º╪▒╪¼ ╪º╪▓ SYNCABLE_TABLES ΓÇö ┘ü┘é╪╖ ┘à╪▒┌⌐╪▓█î)╪¢ ╪│╪¬┘ê┘å `customers.b2b_enabled` (╪º╪▓ ╪╖╪▒█î┘é sync ┘à╪╣┘à┘ê┘ä█î ┘à╪┤╪¬╪▒█î ╪¿┘ç ╪»╪│╪¬┌»╪º┘çΓÇî┘ç╪º ┘à█îΓÇî╪▒╪│╪»╪î ┘ü┘é╪╖ ╪¿╪▒╪º█î ┘å┘à╪º█î╪┤ ╪¿╪▒┌å╪│╪¿)╪¢ route ╪¼╪»█î╪» `routes/b2b.js` ╪¿╪º `centralOnly` ╪▒┘ê█î ┌⌐┘ä router: ┘ê╪▒┘ê╪» ╪¿╪º ┘à┘ê╪¿╪º█î┘ä+╪▒┘à╪▓ █î╪º OTP ┘╛█î╪º┘à┌⌐█î (┘╛╪º╪│╪« uniform ΓÇö ╪¿╪»┘ê┘å ╪º┘ü╪┤╪º█î ┘ê╪¼┘ê╪» ╪┤┘à╪º╪▒┘ç)╪î ┌⌐╪º╪¬╪º┘ä┘ê┌»╪î ╪½╪¿╪¬ ╪│┘ü╪º╪▒╪┤╪î ╪¬╪º╪▒█î╪«┌å┘ç ╪│┘ü╪º╪▒╪┤/┘ü╪º┌⌐╪¬┘ê╪▒╪î ╪╡┘ê╪▒╪¬╪¡╪│╪º╪¿ ╪▓┘å╪»┘ç (┘ç┘à╪º┘å `buildStatement` ╪¡╪│╪º╪¿╪»╪º╪▒█î ΓÇö export ╪┤╪»).
  - **╪¼╪»╪º╪│╪º╪▓█î ╪¬┘ê┌⌐┘å:** ╪¬┘ê┌⌐┘å ┘╛┘ê╪▒╪¬╪º┘ä `scope:'b2b'` ╪»╪º╪▒╪»╪¢ middleware ╪»╪º╪«┘ä█î `auth` ┘ç╪▒ ╪¬┘ê┌⌐┘å ╪»╪º╪▒╪º█î scope ╪▒╪º ╪▒╪» ┘à█îΓÇî┌⌐┘å╪» (╪¬┘ê┌⌐┘åΓÇî┘ç╪º█î staff ┘à┘ê╪¼┘ê╪» ╪¿╪»┘ê┘å scope ┘ç╪│╪¬┘å╪» ΓåÆ backward compatible) ┘ê `b2bAuth` ┘ü┘é╪╖ scope='b2b' ┘à█îΓÇî┘╛╪░█î╪▒╪» ΓÇö ╪¬╪│╪¬ ╪»┘ê╪╖╪▒┘ü┘ç ╪»╪º╪▒╪».
  - **┌»╪▒╪»╪┤ ╪│┘ü╪º╪▒╪┤:** ╪│┘ü╪º╪▒╪┤ ┘╛┘ê╪▒╪¬╪º┘ä ΓåÆ ┘╛█î╪┤ΓÇî┘ü╪º┌⌐╪¬┘ê╪▒ ╪¿╪º ╪┤┘à╪º╪▒┘ç ╪º╪¬┘à█î┌⌐ (`allocateNumber` ΓÇö ┘å┘ç COUNT+1 ┘à╪½┘ä v4) ╪¿┘ç ┘å╪º┘à ┌⌐╪º╪▒╪┤┘å╪º╪│┘É ┘à╪┤╪¬╪▒█î + ┘╛█î╪º┘à ╪»╪º╪«┘ä█î ╪¿┘ç ╪º┘ê╪¢ ┘é█î┘à╪¬ ┘ç┘à█î╪┤┘ç server-side ╪º╪▓ ╪¼╪»┘ê┘ä ┘à╪¡╪╡┘ê┘ä╪º╪¬ (┘é█î┘à╪¬ ┌⌐┘ä╪º█î┘å╪¬ ┘å╪º╪»█î╪»┘ç ┌»╪▒┘ü╪¬┘ç ┘à█îΓÇî╪┤┘ê╪» ΓÇö ╪¬╪│╪¬ ╪»╪º╪▒╪»)╪¢ ╪¬╪ú█î█î╪» = ╪¬╪¿╪»█î┘ä ┘ç┘à╪º┘å ┘╛█î╪┤ΓÇî┘ü╪º┌⌐╪¬┘ê╪▒ ╪¿┘ç ╪▒╪│┘à█î ╪º╪▓ ┘à╪│█î╪▒ ┘à┘ê╪¼┘ê╪» (┘à┘ê╪¼┘ê╪»█î/╪»┘ü╪¬╪▒/╪│┘å╪» ┘ç┘à╪º┘åΓÇî╪¼╪º).
  - **Frontend:** ╪╡┘ü╪¡┘ç ┘╛┘ê╪▒╪¬╪º┘ä `#portal` (┘ê╪▒┘ê╪»╪î ┌⌐╪º╪¬╪º┘ä┘ê┌» ╪¿╪º ╪¬╪╡┘ê█î╪▒ ┘ê ╪│╪¿╪» ╪¿╪º +/ΓêÆ╪î ╪│┘ü╪º╪▒╪┤╪º╪¬ ┘à┘å╪î ╪╡┘ê╪▒╪¬╪¡╪│╪º╪¿ ╪¿╪º ┘à╪º┘å╪»┘ç ╪¿╪»┘ç┌⌐╪º╪▒/╪¿╪│╪¬╪º┘å┌⌐╪º╪▒)╪¢ ┘ä█î┘å┌⌐ ┬½┘ê╪▒┘ê╪» ┘╛┘ê╪▒╪¬╪º┘ä ┘à╪┤╪¬╪▒█î╪º┘å┬╗ ╪»╪▒ ╪╡┘ü╪¡┘ç ┘ê╪▒┘ê╪» (┘ü┘é╪╖ ┘ê┘é╪¬█î feature ╪▒┘ê╪┤┘å ╪º╪│╪¬ ΓÇö ╪º╪▓ `app-info` ┌⌐┘ç ┘ü█î┘ä╪» ╪¿┘ê┘ä█î┘å `b2b_portal` ┌»╪▒┘ü╪¬)╪¢ ╪¿╪«╪┤ ┬½≡ƒ¢Æ ┘╛┘ê╪▒╪¬╪º┘ä B2B┬╗ ╪»╪▒ ┘ü╪▒┘à ┘ê█î╪▒╪º█î╪┤ ┘à╪┤╪¬╪▒█î (╪º╪»┘à█î┘å╪î ╪║█î╪▒ device)╪¢ ┘à┘å┘ê█î ╪º╪»┘à█î┘å ┬½≡ƒ¢Æ ╪│┘ü╪º╪▒╪┤╪º╪¬ B2B┬╗╪¢ ╪¿╪▒┌å╪│╪¿ ╪ó╪¿█î B2B ╪»╪▒ ┘ä█î╪│╪¬ ┘à╪┤╪¬╪▒█î╪º┘å╪¢ ┘╛┘å┘ä ╪¬┘å╪╕█î┘à╪º╪¬ ╪¿╪º ┌⌐┘ä█î╪» `feature_b2b_portal`.
  - **╪º█î┘à┘å█î:** rate-limit ╪▒┘ê█î `/api/b2b/auth/*`╪¢ `/api/b2b` ╪»╪▒ BLOCKLIST ╪│█î┘å┌⌐╪¢ ┌⌐┘ä█î╪»┘ç╪º█î `feature_*`/`ai_*` ╪¿┘ç ALLOWED_KEYS ╪¬┘å╪╕█î┘à╪º╪¬ ╪º╪╢╪º┘ü┘ç ╪┤╪» (┘é╪¿┘ä╪º┘ï ╪░╪«█î╪▒┘ç AI ┘ç┘à silently drop ┘à█îΓÇî╪┤╪» ΓÇö ╪▒┘ü╪╣ ╪┤╪»)╪¢ ╪▒┘ê█î device build ┘ç┘à┘ç endpoint┘ç╪º 403 ┘ê ┘à┘å┘ê/┘ä█î┘å┌⌐ ┘à╪«┘ü█î.
  - **╪¬╪│╪¬:** `scripts/test-b2b.js` ╪¼╪»█î╪» (█▓█╣ assertion: ┘ü┘ä┌»╪î provisioning╪î ┘ê╪▒┘ê╪»/OTP╪î ╪¼╪»╪º╪│╪º╪▓█î ╪¬┘ê┌⌐┘å ╪»┘ê╪╖╪▒┘ü┘ç╪î ┘é█î┘à╪¬ server-side╪î ╪╡┘ü ╪º╪»┘à█î┘å╪î ┘ä╪║┘ê ╪»╪│╪¬╪▒╪│█î). ┘ç╪▒ █┤ suite ╪│╪¿╪▓: 22 sms + 25 sync + 24 v4 + 29 b2b. ╪▒╪º┘ç┘å┘à╪º█î ╪º╪»┘à█î┘å/┘ü╪▒┘ê╪┤ ╪¿┘çΓÇî╪▒┘ê╪▓ ╪┤╪»╪¢ SW ΓåÆ `v22`.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/routes/b2b.js`, `server/db.js`, `server/middleware/auth.js`, `server/server.js`, `server/routes/settings.js`, `server/routes/accounting.js`, `server/sync/capture.js`, `server/public/index.html`, `server/scripts/test-b2b.js`
- **Deploy:** Γ£à deploy ╪┤╪»┘ç (pull + pm2 restart ΓÇö ╪¼╪»╪º┘ê┘ä ╪│╪º╪«╪¬┘ç ╪┤╪»┘å╪»╪î endpoint ┘ç╪º verify ╪┤╪»┘å╪»: login ╪¿╪»┘ê┘å ┘ü┘ä┌» ΓåÆ 403 ╪╡╪¡█î╪¡╪î admin/orders ╪¿╪»┘ê┘å ╪¬┘ê┌⌐┘å ΓåÆ 401╪î app-info ┘ü█î┘ä╪» `b2b_portal` ╪¿╪▒┘à█îΓÇî┌»╪▒╪»╪º┘å╪». dependency ╪¼╪»█î╪»█î ┘å╪»╪º╪▒╪».)
- **█î╪º╪»╪»╪º╪┤╪¬:** ┘╛┘ê╪▒╪¬╪º┘ä ┘ç┘å┘ê╪▓ **╪«╪º┘à┘ê╪┤** ╪º╪│╪¬ ΓÇö ╪¿╪▒╪º█î ┘ü╪╣╪º┘äΓÇî╪│╪º╪▓█î: ╪¬┘å╪╕█î┘à╪º╪¬ ΓåÆ ┬½┘╛┘ê╪▒╪¬╪º┘ä ┘à╪┤╪¬╪▒█î╪º┘å B2B┬╗ ΓåÆ ┘ü╪╣╪º┘äΓÇî╪│╪º╪▓█î + ╪░╪«█î╪▒┘ç╪î ╪│┘╛╪│ ╪¿╪▒╪º█î ┘ç╪▒ ┘à╪┤╪¬╪▒█î ╪º╪▓ ┘ü╪▒┘à ┘ê█î╪▒╪º█î╪┤ ╪º┘ê ╪»╪│╪¬╪▒╪│█î ┘ê ╪▒┘à╪▓ ╪¬╪╣█î█î┘å ┌⌐┘å█î╪». ╪ó╪»╪▒╪│ ┘╛┘ê╪▒╪¬╪º┘ä: `/#portal`.

### █▒█┤█░█┤/█░█┤/█▓█│ ΓÇö ╪º┘å╪¬┘é╪º┘ä ┘à╪▓█î╪¬ΓÇî┘ç╪º█î CRM v4: ╪º┘à┘å█î╪¬ 2FA + ╪»╪│╪¬█î╪º╪▒ AI + ╪¿╪º╪▒┌⌐╪» ┘à╪¡╪╡┘ê┘ä╪º╪¬
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `87a6469`
- **╪«┘ä╪º╪╡┘ç:** ╪ó┘å╪º┘ä█î╪▓ ┌⌐╪º┘à┘ä ┘╛╪▒┘ê┌ÿ┘ç `crm v4` ┘ê ╪º┘å╪¬┘é╪º┘ä █│ ┘à╪▓█î╪¬ ╪º╪╡┘ä█î ╪ó┘å (╪¿╪»┘ê┘å multi-tenancy/B2B/┘à┘ê╪»█î╪º┘å/puppeteer ┌⌐┘ç ╪¿┘ç ┘à╪╣┘à╪º╪▒█î ╪ó╪│█î╪¿ ┘à█îΓÇî╪▓╪»┘å╪»):
  - **2FA (TOTP):** ╪¼╪»┘ê┘ä `two_factor_auth` (╪«╪º╪▒╪¼ ╪º╪▓ sync ΓÇö ┘ü┘é╪╖ ┘à╪▒┌⌐╪▓█î)╪î route ╪¼╪»█î╪» `/api/auth/2fa/*` (setup/verify/recovery-code/disable/status/admin-reset/admin-status)╪î ╪▒┘à╪▓┘å┌»╪º╪▒█î ╪º╪│╪▒╪º╪▒ ╪¿╪º AES-256-GCM (`services/crypto.js`)╪î ┘à╪▒╪¡┘ä┘ç ┌⌐╪» █╢ ╪▒┘é┘à█î ╪»╪▒ ┘ê╪▒┘ê╪» + ┌⌐╪»┘ç╪º█î ╪¿╪º╪▓█î╪º╪¿█î █î┌⌐ΓÇî╪¿╪º╪▒┘à╪╡╪▒┘ü╪î ┘╛┘å┘ä ┬½≡ƒöÉ ╪º┘à┘å█î╪¬┬╗ ╪»╪▒ ╪│╪º█î╪»╪¿╪º╪▒╪î rate-limit ╪▒┘ê█î verify. ╪»╪│╪¬┌»╪º┘çΓÇî┘ç╪º█î ╪ó┘ü┘ä╪º█î┘å: ┘ê╪▒┘ê╪» ╪¿╪»┘ê┘å 2FA (╪¼╪»┘ê┘ä ╪«╪º┘ä█î)╪î ┘à╪»█î╪▒█î╪¬ 2FA ┘ü┘é╪╖ ╪º╪▓ ┘ê╪¿ (`centralOnly`).
  - **╪»╪│╪¬█î╪º╪▒ ┘ü╪▒┘ê╪┤ AI:** ╪│╪¬┘ê┘å `customers.churn_score` + ╪¼╪»┘ê┘ä `ai_insights`╪¢ ╪│╪▒┘ê█î╪│ heuristic (╪▒█î╪│┌⌐ ╪▒█î╪▓╪┤ █░-█▒█░█░╪î ┘ü╪▒╪╡╪¬ ┘ü╪▒┘ê╪┤ ┘à╪¼╪»╪» ╪¿╪▒ ╪º╪│╪º╪│ ╪º┘ä┌»┘ê█î ╪«╪▒█î╪»╪î ╪º┘é╪»╪º┘à ╪▒┘ê╪▓╪º┘å┘ç ┘ç╪▒ ┌⌐╪º╪▒╪┤┘å╪º╪│╪î ╪«┘ä╪º╪╡┘ç ┘ç┘ü╪¬┌»█î ┘à╪»█î╪▒) ╪¿╪»┘ê┘å ┘å█î╪º╪▓ ╪¿┘ç API ╪«╪º╪▒╪¼█î╪¢ ┘ä╪º█î┘ç ╪º╪«╪¬█î╪º╪▒█î Claude API (╪¬┘å╪╕█î┘à╪º╪¬: `feature_ai_assistant`, `ai_api_key`, `ai_model`)╪¢ cron ╪┤╪¿╪º┘å┘ç █░█▓:█░█░ ┘ü┘é╪╖ ┘à╪▒┌⌐╪▓█î╪¢ ╪╡┘ü╪¡┘ç ┬½≡ƒñû ╪»╪│╪¬█î╪º╪▒ AI┬╗ ╪»╪▒ ┘à┘å┘ê█î ╪º╪»┘à█î┘å ┘ê ┘ü╪▒┘ê╪┤╪¢ ╪¿╪▒┌å╪│╪¿ ┘é╪▒┘à╪▓ ╪▒█î╪│┌⌐ ╪»╪▒ ┘ä█î╪│╪¬ ┘à╪┤╪¬╪▒█î╪º┘å.
  - **╪¿╪º╪▒┌⌐╪» ┘à╪¡╪╡┘ê┘ä╪º╪¬:** ╪│╪¬┘ê┘å `products.barcode`╪¢ ╪¬┘ê┘ä█î╪» EAN-13 ╪º╪│╪¬╪º┘å╪»╪º╪▒╪» (deterministic ΓåÆ ╪│╪º╪▓┌»╪º╪▒ ╪¿╪º replay ╪│█î┘å┌⌐)╪¢ `/by-barcode/:code`╪¢ ╪╡┘ü╪¡┘ç ┌å╪º┘╛ ╪¿╪▒┌å╪│╪¿ 58├ù40mm (╪¬┘ê┌⌐┘å ╪º╪▓ query)╪¢ ╪º╪│┌⌐┘å╪▒ ╪»┘ê╪▒╪¿█î┘å (html5-qrcode ╪¿╪º lazy-load CDN ┘ê ┘ê╪▒┘ê╪» ╪»╪│╪¬█î ╪¼╪º█î┌»╪▓█î┘å) ╪»╪▒ ┘ü╪º┌⌐╪¬┘ê╪▒╪│╪º╪▓ (╪º┘ü╪▓┘ê╪»┘å ┘à╪│╪¬┘é█î┘à ╪¿┘ç ╪│╪¿╪») ┘ê ╪╡┘ü╪¡┘ç ┘à╪¡╪╡┘ê┘ä╪º╪¬╪¢ ┘╛╪┤╪¬█î╪¿╪º┘å█î ╪¿╪º╪▒┌⌐╪» ╪»╪▒ ╪¼╪│╪¬╪¼┘ê/╪º┌⌐╪│┘ä.
  - **╪│╪º█î╪▒:** audit ┘ê╪▒┘ê╪» ┘à┘ê┘ü┘é/┘å╪º┘à┘ê┘ü┘é╪¢ `/api/ai` ╪»╪▒ BLOCKLIST ╪│█î┘å┌⌐╪¢ ╪▒╪º┘ç┘å┘à╪º█î ╪º╪»┘à█î┘å ┘ê ┘ü╪▒┘ê╪┤ (█│ ╪¿╪«╪┤ ╪¼╪»█î╪» ┘ç╪▒┌⌐╪»╪º┘à)╪¢ SW bump ╪¿┘ç `v21`╪¢ ┘ê╪º╪¿╪│╪¬┌»█î ╪¼╪»█î╪» `otplib@12` (┘ç╪▒ █│ package.json).
  - **╪¬╪│╪¬:** `scripts/test-v4-features.js` ╪¼╪»█î╪» (█▓█┤ assertion end-to-end ╪▒┘ê█î ╪│╪▒┘ê╪▒ ┘ê╪º┘é╪╣█î: ┌å╪▒╪«┘ç ┌⌐╪º┘à┘ä 2FA╪î ╪º╪╣╪¬╪¿╪º╪▒ check-digit ╪¿╪º╪▒┌⌐╪»╪î ╪¬╪¡┘ä█î┘ä AI). ┘ç╪▒ █│ suite ╪│╪¿╪▓: 22 sms + 25 sync + 24 v4.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/routes/twofa.js`, `server/routes/ai.js`, `server/services/ai.js`, `server/services/crypto.js`, `server/routes/auth.js`, `server/routes/products.js`, `server/db.js`, `server/server.js`, `server/sync/capture.js`, `server/public/index.html`, `server/scripts/test-v4-features.js`
- **Deploy:** Γ£à deploy ╪┤╪»┘ç (pull + npm install + pm2 restart ΓÇö HTTP 200╪î endpoint┘ç╪º█î 2fa/ai ╪▒┘ê█î production mount ╪┤╪»┘å╪»╪î SW v21 ╪│╪▒┘ê ┘à█îΓÇî╪┤┘ê╪»)
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪▒┘ê█î ╪│╪▒┘ê╪▒ ╪¿╪╣╪» ╪º╪▓ pull ╪¡╪¬┘à╪º┘ï `npm install` ╪º╪¼╪▒╪º ╪┤┘ê╪» (otplib ╪¼╪»█î╪» ╪º╪│╪¬).
### █▒█┤█░█┤/█░█┤/█▓█│ ΓÇö [Claude Code] ┘ç┘à╪º┘ç┘å┌»█î ╪¿╪º Cursor + ┘é╪º┘å┘ê┘å █î╪º╪»╪»╪º╪┤╪¬ΓÇî┌»╪░╪º╪▒█î ┘à╪┤╪¬╪▒┌⌐
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** ┘ç┘à█î┘å ┌⌐╪º┘à█î╪¬ (┘ü┘é╪╖ ┘à╪│╪¬┘å╪»╪º╪¬ ΓÇö ╪¿╪»┘ê┘å ╪¬╪║█î█î╪▒ ┌⌐╪»)
- **╪«┘ä╪º╪╡┘ç:**
  - Claude Code ╪¿┘ç ╪ó╪«╪▒█î┘å ┌⌐╪º╪▒ Cursor ┘ç┘à┌»╪º┘à ╪┤╪» (rebase ╪▒┘ê█î `0919817` ΓÇö ╪┤╪º┘à┘ä 1.0.7╪î 1.0.8╪î ╪º┘å╪¿╪º╪▒┌»╪▒╪»╪º┘å█î╪î ╪ó┌⌐╪º╪▒╪»╪ª┘ê┘å ╪│╪º█î╪»╪¿╪º╪▒).
  - ╪┤╪º╪«┘ç┘ö ┘à╪¡┘ä█î ╪▓╪º╪ª╪» `spec1000-phaseG-backup` (┘╛█î╪º╪»┘çΓÇî╪│╪º╪▓█î ┘à┘ê╪º╪▓█î ┘ü╪▒╪º┘å┘å┌⌐┘ê ╪¬┘ê╪│╪╖ Claude) ╪¡╪░┘ü ╪┤╪» ΓÇö ┘å╪│╪«┘ç┘ö Cursor ╪»╪▒ `server/lib/farankenou.js` ┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬.
  - ┘é╪º┘å┘ê┘å ╪¼╪»█î╪» ╪»╪▒ `CLAUDE.md`: ┘ç┘à╪º┘ç┘å┌»█î ╪»┘ê╪╖╪▒┘ü┘ç┘ö Cursor Γçä Claude Code ΓÇö ╪¿╪╣╪» ╪º╪▓ ┘ç╪▒ ╪¬╪│┌⌐╪î ┘ê╪▒┘ê╪»█î ╪»╪▒ ┘ç┘à█î┘å ┘ü╪º█î┘ä + commit/push ╪º╪¼╪¿╪º╪▒█î. git ╪¬┘å┘ç╪º ┌⌐╪º┘å╪º┘ä ┘à╪┤╪¬╪▒┌⌐ ╪º╪│╪¬.
  - ╪«╪º╪▒╪¼ ╪º╪▓ repo: █┤ ╪¿┘ê╪▒╪» ╪╖╪▒╪º╪¡█î UI (╪▓┘à╪▒╪» ┘à╪»╪▒┘å╪î ╪┤╪¿ ┘à╪«┘à┘ä█î╪î ┌⌐╪º╪║╪░ ┘ê ┘à╪▒┌⌐╪¿╪î ┌⌐┘ê╪º╪▒╪¬╪▓ ╪╡┘å╪╣╪¬█î) ╪¿┘çΓÇî╪╡┘ê╪▒╪¬ Artifact ╪¿┘ç ┌⌐╪º╪▒╪¿╪▒ ╪¬╪¡┘ê█î┘ä ╪┤╪». ╪¬┘ê╪╡█î┘ç┘ö Claude: ┬½╪▓┘à╪▒╪» ┘à╪»╪▒┘å┬╗ ╪¬┘à ╪º╪╡┘ä█î + ┬½╪┤╪¿ ┘à╪«┘à┘ä█î┬╗ ╪»╪º╪▒┌⌐ΓÇî┘à┘ê╪». ┘ç┘å┘ê╪▓ ┘ç█î┌åΓÇî┌⌐╪»╪º┘à ┘╛█î╪º╪»┘ç ┘å╪┤╪»┘ç ΓÇö ┘à┘å╪¬╪╕╪▒ ╪¬╪╡┘à█î┘à ┌⌐╪º╪▒╪¿╪▒.
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `CLAUDE.md`, `docs/CHANGE-LOG.md`
- **Deploy:** Γ¥î ┘ä╪º╪▓┘à ┘å█î╪│╪¬ (┘ü┘é╪╖ ┘à╪│╪¬┘å╪»╪º╪¬)
- **█î╪º╪»╪»╪º╪┤╪¬ ╪¿╪▒╪º█î Cursor:** ╪º┌»╪▒ ┌⌐╪º╪▒ uncommitted ╪»╪º╪▒█î╪»╪î ┘é╪¿┘ä ╪º╪▓ ╪¬╪│┌⌐ ╪¿╪╣╪»█î Claude ╪¡╪¬┘à╪º┘ï push ┌⌐┘å█î╪» ΓÇö Claude ┘ü┘é╪╖ git ╪▒╪º ┘à█îΓÇî╪¿█î┘å╪». (╪º█î┘å rebase ┘ê╪│╪╖ push ╪┤┘à╪º ╪º╪¬┘ü╪º┘é ╪º┘ü╪¬╪º╪» ΓÇö ┘ç╪▒ ╪»┘ê ┘ê╪▒┘ê╪»█î ╪¡┘ü╪╕ ╪┤╪».)

### █▒█┤█░█┤/█░█┤/█▓█│ ΓÇö ╪¿╪º╪▓╪╖╪▒╪º╪¡█î ╪¬█î╪¬╪▒┘ç╪º█î ╪│╪▒┘ü╪╡┘ä ┘à┘å┘ê█î ╪¡╪│╪º╪¿╪»╪º╪▒█î
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `927ef3b`
- **╪«┘ä╪º╪╡┘ç:**
  - ╪│╪▒┘ü╪╡┘äΓÇî┘ç╪º█î ╪ó┌⌐╪º╪▒╪»╪ª┘ê┘å ┘à┘å┘ê█î ╪¡╪│╪º╪¿╪»╪º╪▒█î ╪º╪▓ 10px ╪«╪º┌⌐╪│╪¬╪▒█î uppercase ╪¿┘ç ┌⌐╪º╪▒╪¬ΓÇî┘ç╪º█î ┘à╪»╪▒┘å ╪¬╪¿╪»█î┘ä ╪┤╪»: ┘ü┘ê┘å╪¬ 13.5px ┘ê╪▓┘å 800╪î ╪▒┘å┌» ╪│┘ü█î╪» ╪¿╪º ┌⌐┘å╪¬╪▒╪º╪│╪¬ ╪¿╪º┘ä╪º ╪▒┘ê█î ╪│╪º█î╪»╪¿╪º╪▒ ╪¬█î╪▒┘ç╪î ┘╛╪│ΓÇî╪▓┘à█î┘å┘ç ╪┤█î╪┤┘çΓÇî╪º█î ┌»╪▒╪» (border-radius 11px)
  - ╪¡╪º┘ä╪¬ ╪¿╪º╪▓: ┌»╪▒╪º╪»█î╪º┘å ╪╖┘ä╪º█î█î + ┘à╪¬┘å ┌⌐╪▒┘à╪¢ hover ╪▒┘ê╪┤┘åΓÇî╪¬╪▒╪¢ ┘ü┘ä╪┤ `Γû╛` ╪¿╪º ┌å╪▒╪«╪┤ ╪º┘å█î┘à█î╪┤┘å█î (rotate 90┬░ ╪»╪▒ ╪¡╪º┘ä╪¬ ╪¿╪│╪¬┘ç)
  - ╪▒┘ü╪╣ hover ┘å╪º┘à╪▒╪ª█î ┘é╪¿┘ä█î (`var(--purple)` ╪│╪¿╪▓ ╪¬█î╪▒┘ç ╪▒┘ê█î ┘╛╪│ΓÇî╪▓┘à█î┘å┘ç ╪│╪¿╪▓ ╪¬█î╪▒┘ç)
  - ╪▒╪º┘ç┘å┘à╪º█î ╪º╪»┘à█î┘å ╪¿┘çΓÇî╪▒┘ê╪▓ ╪┤╪»╪¢ SW bump ╪¿┘ç `v20`
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/public/sw.js`
- **Deploy:** ΓÅ│

### █▒█┤█░█┤/█░█┤/█▓█│ ΓÇö ┘å╪│╪«┘ç 1.0.8 (┘ê╪¿ + ╪»╪│┌⌐╪¬╪º┘╛) ┘ê 2.0.3 (╪º┘å╪»╪▒┘ê█î╪»)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `66e3c56`
- **╪«┘ä╪º╪╡┘ç:**
  - **UI:** ╪º╪╣╪»╪º╪» ┌⌐╪º┘à┘ä ╪»╪º╪┤╪¿┘ê╪▒╪» + ┘ü┘ê┘å╪¬ adaptive╪¢ accordion ┘à┘å┘ê█î ╪¡╪│╪º╪¿╪»╪º╪▒█î (┘╛█î╪┤ΓÇî┘ü╪▒╪╢ ╪¿╪│╪¬┘ç)╪¢ ╪╣┘å┘ê╪º┘å ┬½╪½╪¿╪¬ ╪»╪▒█î╪º┘ü╪¬ ╪º╪▓ ┘à╪┤╪¬╪▒█î┬╗
  - **╪¿╪º┌»:** lightbox ╪▒╪│█î╪» ┘å┘à╪º█î┘å╪»┘ç (┘à╪│█î╪▒ upload)╪¢ ╪¼╪│╪¬╪¼┘ê█î ┘à╪┤╪¬╪▒█î ┘å╪º┘à+┘ü╪▒┘ê╪┤┌»╪º┘ç╪¢ dropdown GL ┘ç╪▓█î┘å┘ç╪¢ followups sub-group (`_fupCustGroups`)
  - **┘ê█î┌ÿ┌»█î:** widget ╪¬╪│┘ê█î┘çΓÇî┘ç╪º█î ┘à┘å╪¬╪╕╪▒ ╪¬╪ú█î█î╪»╪¢ ┘ü█î┘ä╪¬╪▒ ┘à┘à█î╪▓█î (╪¬╪º╪▒█î╪« ╪º┘à╪▒┘ê╪▓ + ┌⌐╪º╪▒╪¿╪▒)╪¢ ┘à╪▒╪¬╪¿ΓÇî╪│╪º╪▓█î followups ┘å╪▓┘ê┘ä█î╪¢ sync ╪«┘ê╪»┌⌐╪º╪▒ debounced 2s
  - **┘à╪º┌ÿ┘ê┘ä ╪¼╪»█î╪»:** ╪º┘å╪¿╪º╪▒┌»╪▒╪»╪º┘å█î (`stocktaking_sessions` + `stocktaking_items` + UI + API)
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/routes/stocktaking.js`, `server/db.js`, `server/sync/tables.js`, `server/public/sw.js`
- **Deploy:** Γ£à ┘ê╪¿ + installer ╪»╪│┌⌐╪¬╪º┘╛ 1.0.8 (~97MB) ╪▒┘ê█î production ΓÇö ΓÅ│ APK ╪º┘å╪»╪▒┘ê█î╪» 2.0.3 (┘å█î╪º╪▓ Android Studio + libnode)

### █▒█┤█░█┤/█░█┤/█▓█▒ ΓÇö ╪º┘å╪¬╪┤╪º╪▒ ╪»╪│┌⌐╪¬╪º┘╛ 1.0.7 (build + deploy)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `eb50d4b`
- **╪«┘ä╪º╪╡┘ç:**
  - build: `ERP Taranom Setup 1.0.7.exe` (~93MB)
  - manifest + latest.yml ╪¿┘çΓÇî╪▒┘ê╪▓ ΓÇö ╪»╪º┘å┘ä┘ê╪» ╪º╪▓ `/releases/` ╪│╪▒┘ê╪▒ production
  - ╪▒┘ü╪╣ crash `rep_territories` ╪»╪▒ initDB
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `desktop/dist/`, `server/public/releases/manifest.json`, `server/public/releases/latest.yml`
- **Deploy:** Γ£à ┌⌐╪º┘à┘ä ΓÇö metadata + exe ╪▒┘ê█î production (97082265 bytes)
- **█î╪º╪»╪»╪º╪┤╪¬:** ┘å╪╡╪¿ ╪¬╪º╪▓┘ç █î╪º ╪¼╪º█î┌»╪▓█î┘å█î 1.0.6

### █▒█┤█░█┤/█░█┤/█▓█▒ ΓÇö ╪▒┘ü╪╣ ╪«╪╖╪º█î ╪»╪│┌⌐╪¬╪º┘╛: no such table rep_territories
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `5158586`
- **╪«┘ä╪º╪╡┘ç:**
  - `ensureColumn` ╪▒┘ê█î `rep_territories` **┘é╪¿┘ä ╪º╪▓** `CREATE TABLE` ╪º╪¼╪▒╪º ┘à█îΓÇî╪┤╪» ΓåÆ initDB ╪▒┘ê█î DB ╪¬╪º╪▓┘ç ╪»╪│┌⌐╪¬╪º┘╛ crash
  - ╪│╪¬┘ê┘åΓÇî┘ç╪º█î `rep_id` ┘ê `cities` ╪¿┘ç ╪¬╪╣╪▒█î┘ü ╪¼╪»┘ê┘ä ┘à┘å╪¬┘é┘ä ╪┤╪»╪¢ migration ╪¿╪╣╪» ╪º╪▓ CREATE
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/db.js`
- **Deploy:** ΓÅ│ ┘ê╪¿ + **┘å█î╪º╪▓ ╪¿┘ç rebuild ╪»╪│┌⌐╪¬╪º┘╛ 1.0.7**
- **█î╪º╪»╪»╪º╪┤╪¬:** ┘å╪│╪«┘ç ╪»╪│┌⌐╪¬╪º┘╛ ┘ü╪╣┘ä█î 1.0.6 ╪º█î┘å ╪¿╪º┌» ╪▒╪º ╪»╪º╪▒╪» ΓÇö installer ╪¼╪»█î╪» ┘ä╪º╪▓┘à ╪º╪│╪¬

### █▒█┤█░█┤/█░█┤/█▓█▒ ΓÇö ╪▒┘ü╪╣ 502 + ╪¿┘ç█î┘å┘çΓÇî╪│╪º╪▓█î ╪¿┘å█î╪º╪»█î ╪│╪▒╪╣╪¬ ┘ê╪¿ ┘ê ╪¡╪│╪º╪¿╪»╪º╪▒█î
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `b921b73`
- **╪«┘ä╪º╪╡┘ç:**
  - **╪▒┘ü╪╣ 502:** import ┌»┘àΓÇî╪┤╪»┘ç `adminOnly` ╪»╪▒ `invoices.js` ΓÇö PM2 ╪»╪▒ crash loop ╪¿┘ê╪» (█┤█╡█░k+ restart)
  - **╪¡╪│╪º╪¿╪»╪º╪▒█î:** ╪»╪º╪┤╪¿┘ê╪▒╪» acc-dash ╪»█î┌»╪▒ trial-balance ┘ê suppliers/list ╪▒╪º ╪¿┘ä┘ê┌⌐ ┘å┘à█îΓÇî┌⌐┘å╪»╪¢ overview ╪║┘å█îΓÇî╪┤╪»┘ç ╪¿╪º `trialBalanced` + `totalPayable`
  - **SQL:** query ╪¬╪ú┘à█î┘åΓÇî┌⌐┘å┘å╪»┌»╪º┘å ╪º╪▓ correlated subquery ╪¿┘ç JOIN ╪¬╪¿╪»█î┘ä ╪┤╪»
  - **boot admin:** `/settings` ╪¿┘çΓÇî╪╡┘ê╪▒╪¬ lazy load (┘à╪│╪»┘ê╪» ┘å┌⌐╪▒╪»┘å login)
  - SW bump ╪¿┘ç `v18`
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/routes/invoices.js`, `server/routes/accounting.js`, `server/routes/suppliers.js`, `server/public/index.html`, `server/public/sw.js`
- **Deploy:** Γ£à production (`6350292` ΓÇö PM2 stable, HTTP 200)
- **█î╪º╪»╪»╪º╪┤╪¬:** `git pull origin claude/claude-md-docs-2ssrpy && cd server && pm2 restart erp-taranom`

### █▒█┤█░█┤/█░█┤/█▓█░ ΓÇö ╪▓█î╪▒╪│╪º╪«╪¬ ╪¿┘çΓÇî╪▒┘ê╪▓╪▒╪│╪º┘å█î ╪»╪│┌⌐╪¬╪º┘╛ (GitHub Releases╪î ╪¿╪»┘ê┘å SCP)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `a69f5d8`
- **╪«┘ä╪º╪╡┘ç:**
  - ╪▒┘ü╪╣ installer bloated: ╪¡╪░┘ü exe┘ç╪º█î ┘é╪»█î┘à█î ╪º╪▓ ╪¿╪│╪¬┘ç ┘å╪╡╪¿ (█╣█│MB ╪¿┘çΓÇî╪¼╪º█î █▒.█▒GB)
  - exe ╪»█î┌»╪▒ ╪▒┘ê█î ╪│╪▒┘ê╪▒ production ╪ó┘╛┘ä┘ê╪» ┘å┘à█îΓÇî╪┤┘ê╪» ΓÇö ┘ü┘é╪╖ manifest + latest.yml
  - ┘ä█î┘å┌⌐ ╪»╪º┘å┘ä┘ê╪» ╪º╪▓ GitHub Releases ╪»╪▒ manifest.desktop.url
  - `update-feed` ╪º╪▓ feed_url ╪«╪º╪▒╪¼█î ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘à█îΓÇî┌⌐┘å╪»
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `desktop/scripts/prepare-server.js`, `scripts/publish-desktop.js`, `docs/DESKTOP-UPDATE.md`, `server/server.js`
- **Deploy:** Γ£à production (`a69f5d8`)
- **█î╪º╪»╪»╪º╪┤╪¬:** `gh release create v1.0.6 ...` ΓÇö ╪▒╪º┘ç┘å┘à╪º ╪»╪▒ docs/DESKTOP-UPDATE.md

### █▒█┤█░█┤/█░█┤/█▓█░ ΓÇö ╪¿┘çΓÇî╪▒┘ê╪▓╪▒╪│╪º┘å█î 1.0.6 (update1.0.6.md ΓÇö █▒█┤ ┘à┘ê╪▒╪»)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `41be9d1`
- **╪«┘ä╪º╪╡┘ç:**
  - ╪»╪│┌⌐╪¬╪º┘╛: ╪¬╪ú█î█î╪» ╪«╪▒┘ê╪¼╪¢ ┘╛╪┤╪¬█î╪¿╪º┘å ┘à╪¡┘ä█î ╪¿╪»┘ê┘å ╪«╪╖╪º█î centralOnly
  - UX: fmtCompact ╪»╪▒ statCard╪¢ ╪│╪¬┘ê┘åΓÇî┘ç╪º█î ╪º╪│╪¬╪º┘å╪»╪º╪▒╪» ┘à╪┤╪¬╪▒█î + tel: ┘à┘ê╪¿╪º█î┘ä
  - ┘╛█î┌»█î╪▒█î: ┘à╪º┘å╪»┘ç ╪¡╪│╪º╪¿ ╪»╪▒ ┘à╪▒╪¡┘ä┘ç╪¢ kanban ╪│╪¬┘ê┘å ╪│╪▒┘å╪«╪¢ ┘ä█î╪│╪¬ accordion ┘à╪┤╪¬╪▒█î
  - ╪º┌⌐╪│┘ä ┘ü┘é╪╖ admin╪¢ ┌»╪▓╪º╪▒╪┤ top10╪¢ ┘ü╪º┌⌐╪¬┘ê╪▒ ╪¿╪º ┘å╪º┘à ┌⌐╪º┘à┘ä╪¢ ┘å┘é╪┤ ╪»┘ü╪¬╪▒ ┘╛╪«╪┤
  - ┘╛█î╪º┘àΓÇî┘ç╪º: checkbox + ┘╛┘ê╪┤┘ç ┌⌐╪º╪▒╪¿╪▒╪¢ ╪¬┘å╪╕█î┘à╪º╪¬ module_reps╪¢ ACC_NAV ╪»╪│╪¬┘çΓÇî╪¿┘å╪»█î
  - ┘╛╪▒╪»╪º╪«╪¬ ┘à█î╪»╪º┘å█î: rep_payment_submissions + ╪¬╪ú█î█î╪» ╪¡╪│╪º╪¿╪»╪º╪▒
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/db.js`, `server/routes/rep-management.js`, `desktop/main.js`
- **Deploy:** Γ£à production (`41be9d1`)
- **█î╪º╪»╪»╪º╪┤╪¬:** `git pull && cd server && pm2 restart erp-taranom`

### █▒█┤█░█┤/█░█┤/█▒█╣ ΓÇö ╪¿┘ç█î┘å┘çΓÇî╪│╪º╪▓█î ╪│╪▒╪╣╪¬ ┘å╪º┘ê╪¿╪▒█î ┘ê ╪¿╪º╪▒┌»╪░╪º╪▒█î ╪╡┘ü╪¡╪º╪¬
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `dc95426`
- **╪«┘ä╪º╪╡┘ç:**
  - ┘ü╪▒╪º┘å╪¬: ┘ä╪º█î┘ç cache ╪¿╪▒╪º█î API ┘ê HTML ╪»╪º╪┤╪¿┘ê╪▒╪»/┌»╪▓╪º╪▒╪┤╪º╪¬╪¢ reuse ┘╛┘å┘ä ╪¡╪│╪º╪¿╪»╪º╪▒█î ╪¿█î┘å ╪¬╪¿ΓÇî┘ç╪º╪¢ debounce ╪¼╪│╪¬╪¼┘ê╪¢ fetch █î┌⌐ΓÇî╪¿╪º╪▒┘ç ┘╛█î╪º┘àΓÇî┘ç╪º/█î╪º╪»╪ó┘ê╪▒┘ç╪º
  - ╪¿┌⌐ΓÇî╪º┘å╪»: index┘ç╪º█î ╪¼╪»█î╪» SQLite╪¢ cache ┘ê╪╢╪╣█î╪¬ ┌⌐╪º╪▒╪¿╪▒ ┘ü╪╣╪º┘ä ╪»╪▒ auth (█│█░╪½╪º┘å█î┘ç)╪¢ ╪▒┘ü╪╣ N+1 ╪»╪▒ `/reports/salesperson`╪¢ `seedWarehouseStock` ┘ü┘é╪╖ █î┌⌐ΓÇî╪¿╪º╪▒
  - Service Worker: bump ╪¿┘ç `erp-taranom-v8`
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/public/index.html`, `server/db.js`, `server/middleware/auth.js`, `server/routes/reports.js`, `server/public/sw.js`
- **Deploy:** Γ£à production (`dc95426` ΓÇö HTTP 200)
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪│╪▒┘ê╪▒ API ╪º╪▓ ┘é╪¿┘ä ╪│╪▒█î╪╣ ╪¿┘ê╪» (~█╡ms)╪¢ ┌»┘ä┘ê┌»╪º┘ç ╪º╪╡┘ä█î ┘ü╪▒╪º┘å╪¬ ┘ê query┘ç╪º█î ╪¬┌⌐╪▒╪º╪▒█î ╪¿┘ê╪»

---

### █▒█┤█░█┤/█░█┤/█▒█╕ ΓÇö ╪º┘à┘å█î╪¬╪î ┘ü╪▒╪º┘à┘ê╪┤█î ╪▒┘à╪▓╪î ╪¿┌⌐ΓÇî╪ó┘╛ ┘╛█î╪┤╪▒┘ü╪¬┘ç╪î ┘ê╪º╪▒╪»╪º╪¬ ┘à╪¡┌⌐╪î ╪▒┘ü╪╣ build ╪»╪│┌⌐╪¬╪º┘╛
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `f322106`
- **╪«┘ä╪º╪╡┘ç:**
  - ╪▒┘ü╪╣ build ╪»╪│┌⌐╪¬╪º┘╛: `better-sqlite3` v11 + `electron-updater`
  - ╪º┘à┘å█î╪¬: `JWT_SECRET` ╪º╪¼╪¿╪º╪▒█î ╪»╪▒ production╪î ╪│█î╪º╪│╪¬ ╪▒┘à╪▓ █╕+ ╪¡╪▒┘ü ┘ê ╪╣╪»╪» (`lib/security.js`)
  - ┘ü╪▒╪º┘à┘ê╪┤█î ╪▒┘à╪▓: OTP ┘╛█î╪º┘à┌⌐█î ╪º╪▓ ╪╡┘ü╪¡┘ç ┘ê╪▒┘ê╪»
  - ╪¿┌⌐ΓÇî╪ó┘╛: ┌å╪▒╪«╪┤█î (█▒█┤ ┘å╪│╪«┘ç)╪î ZIP ╪▒┘ê█î ┘ê█î┘å╪»┘ê╪▓ / tar.gz ╪▒┘ê█î ┘ä█î┘å┘ê┌⌐╪│╪î ╪┤╪º┘à┘ä DB + uploads
  - ┘ê╪º╪▒╪»╪º╪¬ ┘à╪¡┌⌐: ╪ó┘╛┘ä┘ê╪» FullBackup.zip╪î ╪¬╪¡┘ä█î┘ä .bak╪î import ╪º╪▓ SQL Server
  - ╪▒╪º┘ç┘å┘à╪º█î ╪»╪º╪«┘ä ╪¿╪▒┘å╪º┘à┘ç ╪¿┘çΓÇî╪▒┘ê╪▓ ╪┤╪»
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/lib/security.js`, `server/backup.js`, `server/routes/auth.js`, `server/routes/import.js`, `server/lib/mahak-import.js`, `desktop/package.json`, `docs/MAHAK-IMPORT.md`
- **Deploy:** ΓÅ│
- **█î╪º╪»╪»╪º╪┤╪¬:** ┘ê╪º╪▒╪»╪º╪¬ ┌⌐╪º┘à┘ä ┘à╪¡┌⌐ ┘å█î╪º╪▓ ╪¿┘ç SQL Server + restore ┘ü╪º█î┘äΓÇî┘ç╪º█î .bak ╪»╪º╪▒╪»

---

- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `391fd66`
- **╪«┘ä╪º╪╡┘ç:**
  - ╪╣┌⌐╪│ ┘à╪¡╪╡┘ê┘ä╪º╪¬ ╪»╪▒ ┘å╪│╪«┘ç┘ö ╪ó┘ü┘ä╪º█î┘å (╪»╪│┌⌐╪¬╪º┘╛/┘à┘ê╪¿╪º█î┘ä) ╪º╪▓ ╪│╪▒┘ê╪▒ ┘à╪▒┌⌐╪▓█î pull ┘à█îΓÇî╪┤┘ê╪» (`server/sync/files.js`)
  - ╪»╪▒╪«┘ê╪º╪│╪¬ `/uploads/...` ╪º┌»╪▒ ┘ü╪º█î┘ä ┘à╪¡┘ä█î ┘å╪¿╪º╪┤╪»╪î ╪º╪▓ ┘à╪▒┌⌐╪▓ ╪»╪º┘å┘ä┘ê╪» ┘à█îΓÇî┌⌐┘å╪» (middleware ╪»╪▒ `server.js`)
  - UI: retry ╪╣┌⌐╪│╪î ╪»┌⌐┘à┘ç ┬½╪»╪▒█î╪º┘ü╪¬ ╪¬╪╡╪º┘ê█î╪▒┬╗ ╪»╪▒ ┘╛┘å┘ä sync╪î badge ┬½X ╪¬╪╡┘ê█î╪▒ ╪»╪▒ ╪º┘å╪¬╪╕╪º╪▒┬╗
  - Service Worker ╪»█î┌»╪▒ `/uploads/` ╪▒╪º cache ┘å┘à█îΓÇî┌⌐┘å╪» (`sw.js` v7)
  - auto-update ╪»╪│┌⌐╪¬╪º┘╛ ╪¿╪º `electron-updater` (`desktop/main.js`)
  - ╪º╪╣┘ä╪º┘å ┘å╪│╪«┘ç┘ö ╪¼╪»█î╪» ╪º┘å╪»╪▒┘ê█î╪» + ╪»╪º┘å┘ä┘ê╪» APK ╪»╪▒ Downloads (`MainActivity.java`)
  - manifest ┘å╪│╪«┘çΓÇî┘ç╪º: `server/public/releases/manifest.json` + ╪º╪│┌⌐╪▒█î┘╛╪¬ `scripts/generate-release.js`
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/sync/files.js`, `server/sync/client.js`, `server/server.js`, `server/routes/sync.js`, `server/public/index.html`, `desktop/main.js`, `android/.../MainActivity.java`, `server/lib/app-update.js`
- **Deploy:** ΓÅ│ ╪▒┘ê█î GitHub push ╪┤╪» ΓÇö ╪│╪▒┘ê╪▒ ╪¿╪º█î╪» `git pull` ╪¿╪▓┘å╪»
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪¿╪▒╪º█î auto-update ╪»╪│┌⌐╪¬╪º┘╛╪î ┘ü╪º█î┘äΓÇî┘ç╪º█î `.exe` ┘ê `latest.yml` ╪▒╪º ╪»╪▒ `server/public/releases/` ╪ó┘╛┘ä┘ê╪» ┌⌐┘å█î╪»

---

### █▒█┤█░█┤/█░█┤/█▒█╕ ΓÇö ╪¿┘ç█î┘å┘çΓÇî╪│╪º╪▓█î ╪╣┘à┘ä┌⌐╪▒╪» + ╪▒┘ü╪╣ crash ╪¿┘ê╪¬ production
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `5d797cb` (┘ê `abe33d1`, `8119a5d`)
- **╪«┘ä╪º╪╡┘ç:**
  - SQLite tuning (WAL, cache, mmap)╪î index┘ç╪º█î ╪¼╪»█î╪»╪î batch query ╪¿┘çΓÇî╪¼╪º█î N+1
  - ┘ä█î╪│╪¬ ┘ü╪º┌⌐╪¬┘ê╪▒┘ç╪º ╪¿╪»┘ê┘å `rows` ╪│┘å┌»█î┘å╪¢ ╪¼╪▓╪ª█î╪º╪¬ ╪¿╪º `GET /invoices/:id`
  - `seedWarehouseStock()` ╪º┘à┘å ╪¿╪º JS loop (╪¿╪»┘ê┘å SQL ╪┤┌⌐╪│╪¬┘ç ╪▒┘ê█î `warehouses` ┘é╪»█î┘à█î)
  - `repairWarehousesSchema()` / `repairProductCategoriesSchema()` ╪¿╪▒╪º█î DB legacy
  - sync trigger ╪»╪▒╪│╪¬ ╪¿╪▒╪º█î `warehouse_stock` (┌⌐┘ä█î╪» composite)
  - ┘ü╪▒╪º┘å╪¬: cache/debounce╪î `loadInitial` ╪│╪¿┌⌐ΓÇî╪¬╪▒ ╪¿╪▒╪º█î ┘å┘é╪┤ accounting
- **┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ä█î╪»█î:** `server/db.js`, `server/routes/{customers,invoices,accounting,admin,warehouses,cash-boxes}.js`, `server/public/index.html`
- **Deploy:** Γ£à ╪▒┘ê█î production pull ╪┤╪» (`6a9f240` ΓåÆ `5d797cb`)
- **█î╪º╪»╪»╪º╪┤╪¬:** ╪«╪╖╪º█î ┘é╪»█î┘à█î `SqliteError: no such column: id` ╪»╪▒ ┘ä╪º┌» PM2 ┘à╪▒╪¿┘ê╪╖ ╪¿┘ç restart┘ç╪º█î ┘é╪¿┘ä ╪¿┘ê╪»╪¢ ╪¿╪╣╪» ╪º╪▓ repair ╪»╪│╪¬█î╪î `warehouses` ╪│╪¬┘ê┘å `id` ╪»╪º╪▒╪»

---

### █▒█┤█░█┤/█░█┤/█▒█╖ ΓÇö ┘ü╪º╪▓┘ç╪º█î B ╪¬╪º F (update1000)
- **╪┤╪º╪«┘ç:** `claude/claude-md-docs-2ssrpy`
- **Commit:** `6a9f240`
- **╪«┘ä╪º╪╡┘ç:** ╪»╪▒╪«╪¬ COA╪î ┘à╪╖╪º┘ä╪¿╪º╪¬ ╪¿┘ç ╪¬┘ü┌⌐█î┌⌐ ┘ü╪º┌⌐╪¬┘ê╪▒╪î UX ╪«╪▒█î╪»/╪º┘å╪¿╪º╪▒╪î ╪│╪▒╪¿╪º╪▒ ╪¬┘ê┘ä█î╪» ╪«┘ê╪»┌⌐╪º╪▒
- **Deploy:** Γ£à ┘╛╪º█î╪»╪º╪▒ ╪▒┘ê█î production (rollback ┘é╪¿┘ä█î ╪¿┘ç ╪º█î┘å commit)

---

### █▒█┤█░█┤/█░█┤/█▒█╖ ΓÇö ╪¿┘ç█î┘å┘çΓÇî╪│╪º╪▓█î ╪º┘ê┘ä█î┘ç┘ö ╪│╪▒╪╣╪¬ ╪¿╪º╪▒┌»╪░╪º╪▒█î
- **Commit:** `7228ce6`
- **╪«┘ä╪º╪╡┘ç:** JOIN balance ┘à╪┤╪¬╪▒█î╪î receivables batch╪î `/cash-boxes/balances`, index┘ç╪º╪î cache ┘ü╪▒╪º┘å╪¬
- **Deploy:** Γ£à (╪»╪º╪«┘ä ╪┤╪º╪«┘ç┘ö ┘ü╪╣┘ä█î)

---

## ┌⌐╪º╪▒┘ç╪º█î ╪º┘å╪¼╪º┘àΓÇî┘å╪┤╪»┘ç / ╪»╪▒ ╪╡┘ü

- [ ] ≡ƒöö **█î╪º╪»╪ó┘ê╪▒█î ╪╡╪▒█î╪¡ ┘à╪º┘ä┌⌐ (█▒█┤█░█╡/█░█┤/█▓█╢): ┬½┘ê┘é╪¬█î ╪»╪º┘à┘å┘ç ╪▒╪º ╪»╪º╪»┘à ╪º█î┘å ┘à┘ê╪▒╪» ╪▒╪º █î╪º╪»╪ó┘ê╪▒█î ┌⌐┘å.┬╗** ΓÇö ╪¿┘çΓÇî┘à╪¡╪╢ ╪º█î┘å┌⌐┘ç ┘à╪º┘ä┌⌐ **╪»╪º┘à┘å┘ç** ╪▒╪º ╪º╪▒╪º╪ª┘ç ╪»╪º╪»╪î ╪º█î┘å ╪¿╪│╪¬┘ç┘ö ┌⌐╪º╪▒ ╪»╪º┘à┘å┘çΓÇî┘à╪¡┘ê╪▒ ╪▒┘ê█î ╪│╪▒┘ê╪▒ ╪º█î╪▒╪º┘å `94.249.244.208` ╪º┘å╪¼╪º┘à ╪┤┘ê╪»:
  1. **HTTPS**: Nginx + certbot ╪╖╪¿┘é `docs/SECURITY-HARDENING.md` ╪¿╪«╪┤ ┬½╪»┬╗ ╪¿╪▒╪º█î ╪»╪º┘à┘å┘ç┘ö `.ir`.
  2. **╪▒┘ü╪╣ ╪»╪│╪¬╪▒╪│█î ╪│╪▒┘ê╪▒ ╪¿┘ç GitHub**: ╪│╪▒┘ê╪▒ `github.com` ╪▒╪º resolve ┘å┘à█îΓÇî┌⌐┘å╪» (┘ü█î┘ä╪¬╪▒█î┘å┌») ΓåÆ ╪¬┘å╪╕█î┘à DNS ╪¬┘à█î╪▓/┘╛╪▒┘ê┌⌐╪│█î ╪¬╪º `scripts/deploy-production.sh` ┘à╪│╪¬┘é█î┘à `git pull` ┌⌐┘å╪» (┘ü╪╣┘ä╪º┘ï deploy ┘ü┘é╪╖ ╪¿╪º git bundle ┘à┘à┌⌐┘å ╪º╪│╪¬).
  - (╪»╪│╪¬█î╪º╪▒ ╪¿╪╣╪»█î: ╪º█î┘å ╪ó█î╪¬┘à ╪▒╪º ╪»╪▒ ╪º╪¿╪¬╪»╪º█î ┘╛╪º╪│╪« ╪¿┘ç ┘à╪º┘ä┌⌐╪î ┘ê┘é╪¬█î ╪»╪º┘à┘å┘ç ╪▒╪º ╪»╪º╪»╪î ┘ü╪╣╪º┘ä╪º┘å┘ç █î╪º╪»╪ó┘ê╪▒█î ┌⌐┘å.)
- [ ] ≡ƒöÉ **┌å╪▒╪«╪┤ ┌⌐┘ä█î╪» SSH**: ┌⌐┘ä█î╪» `taranom-crm-admin@Taranom` (ed25519) ╪»╪▒ ┌å╪¬ ╪º┘ü╪┤╪º ╪┤╪» ΓÇö ╪º╪▓ `~/.ssh/authorized_keys` ╪│╪▒┘ê╪▒ ╪¡╪░┘ü ┘ê ┌⌐┘ä█î╪» ╪¼╪»█î╪» ╪¼╪º█î┌»╪▓█î┘å ╪┤┘ê╪»╪¢ ┌⌐┘ä█î╪» ┘ü┘é╪╖ ╪º╪▓ ╪╖╪▒█î┘é Secrets ╪»╪º╪»┘ç ╪┤┘ê╪».
- [ ] ┘╛╪│ ╪º╪▓ deploy: ╪▒┘à╪▓┘å┌»╪º╪▒█î ╪¿┌⌐╪º┘╛ ╪º╪▓ ┘╛┘å┘ä ┬½┘╛╪┤╪¬█î╪¿╪º┘å┬╗ + ┌å╪▒╪«╪┤ keystore ╪º┘å╪»╪▒┘ê█î╪» (`keystore.properties.example`)
- [ ] pagination ╪¿╪▒╪º█î ┘ä█î╪│╪¬ΓÇî┘ç╪º█î ╪¿╪▓╪▒┌»
- [ ] merge ╪┤╪º╪«┘ç ╪¿┘ç `main`

---

## ╪»╪│╪¬┘ê╪▒ deploy ╪º╪│╪¬╪º┘å╪»╪º╪▒╪» (╪│╪▒┘ê╪▒)

```bash
# █î┌⌐ΓÇî╪«╪╖█î (╪¬┘ê╪╡█î┘çΓÇî╪┤╪»┘ç ΓÇö ╪┤╪º┘à┘ä jwt-secret ┘ê health check):
bash /home/taranom-admin/crm-taranom/scripts/deploy-production.sh

# █î╪º ╪»╪│╪¬█î:
cd /home/taranom-admin/crm-taranom
git fetch origin
git checkout claude/claude-md-docs-2ssrpy
git pull origin claude/claude-md-docs-2ssrpy
cd server
# ┘ü┘é╪╖ ╪º┌»╪▒ jwt-secret.txt ┘å╪»╪º╪▒█î╪»:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > jwt-secret.txt && chmod 600 jwt-secret.txt
npm install --omit=dev
pm2 restart erp-taranom --update-env
curl -s http://127.0.0.1:3000/api/system/time
```

**┘ç╪▒┌»╪▓** `git reset --hard` ╪▒┘ê█î production ┘å╪▓┘å█î╪» ┘à┌»╪▒ ╪¿╪▒╪º█î rollback ╪ó┌»╪º┘ç╪º┘å┘ç.
# 2026-08-08 ΓÇö P0-C ┘ê╪º┘é╪╣█î + ╪º┘å╪¬╪┤╪º╪▒ RC 2.0.33/2.0.10

- CI dependency gate ┘╛╪│ ╪º╪▓ advisory ╪¼╪»█î╪» ╪¿╪º ╪º╪▒╪¬┘é╪º█î `sharp` ╪º╪▓ 0.33.5 ╪¿┘ç 0.35.0 ╪¿╪│╪¬┘ç ╪┤╪»╪¢ audit ╪¿╪»┘ê┘å high/critical╪î upload security 55/55 ┘ê sync-file 19/19.
- GitHub Wave 0 Gate ╪º╪¼╪▒╪º█î `31265434377`: ┘ç╪▒ █╖ job ╪│╪¿╪▓╪¢ task ┘ç┘ü╪¬┌»█î restore ┘å█î╪▓ ┘å╪╡╪¿ ┘ê ╪º╪¼╪▒╪º█î ╪»╪│╪¬█î ╪ó┘å ╪¿╪º ┘å╪¬█î╪¼┘ç █░ ╪¬╪ú█î█î╪» ╪┤╪».
- deploy ┘ç╪»┘ü┘à┘å╪» `sharp@0.35.0` ╪▒┘ê█î VPS ╪¿┘çΓÇî╪╣┘ä╪¬ registry/DNS ┌»█î╪▒ ┌⌐╪▒╪»╪¢ ┘é╪¿┘ä ╪º╪▓ restart ┘à╪¬┘ê┘é┘ü ╪┤╪» ┘ê ╪¿╪º backup/cache ╪¿┘ç 0.33.5 ╪│╪º┘ä┘à rollback ╪┤╪» (`SHARP_ROLLBACK_OK`╪î PM2 online╪î HTTP 200). deploy production ┘å╪│╪«┘ç ╪º┘à┘å ╪¿┘ç Cursor ┘ê╪º┌»╪░╪º╪▒ ╪┤╪».
- ╪¿┌⌐╪º┘╛ ╪▒┘à╪▓ΓÇî╪┤╪»┘ç production ╪¿┘ç Windows off-server ┘à┘å╪¬┘é┘ä ╪┤╪»╪¢ sidecar-before/after╪î SHA-256╪î receipt╪î lock╪î retention ┘ê atomic promotion.
- ┌⌐┘ä█î╪» pull ╪¼╪»╪º ┘ê ┘╛█î╪┤ΓÇî┘ü╪▒╪╢ ╪┤╪» ┘ê ╪▒┘ê█î VPS ┘ü┘é╪╖ ╪¿┘ç wrapper ╪▒█î╪┤┘çΓÇî┘à╪º┘ä┌⌐ ┘à╪¡╪»┘ê╪» ╪º╪│╪¬╪¢ key/DB/.env/private uploads/SFTP/upload/delete ╪»╪▒ ╪¬╪│╪¬ ┘à┘å┘ü█î ╪▒╪» ╪┤╪»┘å╪».
- Scheduled Task ┘╛╪º┘å╪▓╪»┘çΓÇî╪»┘é█î┘é┘çΓÇî╪º█î Limited ╪º╪¼╪▒╪º ╪┤╪» (`LastTaskResult=0`)╪¢ ╪¿┘çΓÇî╪»┘ä█î┘ä ┘å╪¿┘ê╪» elevation ┘ü╪╣┘ä█î fallback ╪ó┘å Interactive ╪º╪│╪¬.
- restore ┘ê╪º┘é╪╣█î ┘ü╪º█î┘ä `crm-backup-20260808-151500.zip.enc` ╪¿╪º fingerprint ╪¿╪▒╪º╪¿╪▒ ┘ê RTO ╪¬╪«┘à█î┘å█î █│ ╪½╪º┘å█î┘ç Pass ╪┤╪».
- provision ┌⌐┘ä█î╪» fail-closed ╪┤╪»: remote file/PM2 hash ╪¿╪º DPAPI ┘à╪¡┘ä█î ╪¬╪╖╪¿█î┘é ╪»╪º╪»┘ç ┘à█îΓÇî╪┤┘ê╪»╪¢ missing/mismatch ╪º╪¼╪º╪▓┘ç overwrite ┘å╪»╪º╪▒╪» ┘ê rotation ╪║█î╪▒┘ü╪╣╪º┘ä ╪º╪│╪¬.
- uploader ╪¿╪º█î┘å╪▒█î ╪¿╪º host pinning╪î resume digest-scoped╪î hash ┘╛█î╪┤ ╪º╪▓ promote╪î rollback ┘ê HTTP hash ╪╣┘à┘ä█î╪º╪¬█î ╪┤╪»╪¢ APK 2.0.33 ┘ê EXE 2.0.10 ┘à┘å╪¬╪┤╪▒ ╪┤╪»┘å╪».
- ╪¬╪│╪¬ΓÇî┘ç╪º: artifact real PASS╪¢ offsite 25/25╪¢ policy 4/4╪¢ DR 14/14╪¢ uploader 3/3╪¢ embedded 224/224 ┘ç╪▒ ┘ç╪»┘ü╪î drift=0╪¢ `git diff --check` PASS.
