# Runbook — برگشت رسمی JE 1016 (اصلاحیهٔ تطبیق #1)

> ## ⛔ STOP — اجرا فقط توسط حامد
> این سند فقط **آماده‌سازی** است. هیچ ایجنت/اسکریپتی `POST …/fixes/1/reverse` را اجرا نمی‌کند.
> تصمیم و اجرای نهایی فقط با حامد است (تصمیم الزام‌آور: «JE1016 از مسیر رسمی برگردد؛ آماده کن و STOP»).

## ۱. زمینه
| مورد | مقدار |
|------|--------|
| اصلاحیه | `subledger_recon_fixes` **#1** — code `inventory_vs_gl`، target `1104`، amount −1,796,860,352، je_id **1016**، status `posted`، reversed_at NULL |
| سند | JE **1016** — `inventory_recon_adjust`، ۱۴۰۵/۰۸/۰۴، Dr 3102 / Cr 1104 = **1,796,860,352** ریال |
| خارج از دامنه | اصلاحیه **#2** (JE 1017، target 1110، 667,952,064) — **دست نخورد** |
| پیش‌نویس دستی P3 | `voucher_drafts` #1 (برگشت JE1016) پس از deploy این PR با پیشوند «⛔ منسوخ» علامت می‌خورد و ثبتش ۴۰۹ `E_P3_DRAFT_SUPERSEDED` می‌دهد. **آن را ثبت نکنید.** |

مسیر واقعی API (router روی `/api/accounting/subledger-recon` mount است):
`POST /api/accounting/subledger-recon/fixes/1/reverse` — مجوز `acc_subledger_recon:delete`، فقط سرور مرکزی.

### رفتار مسیر رسمی (`reverseFix` در `server/lib/subledger-recon.js`)
در **یک** `db.transaction`:
1. `reverseJournalEntry(1016)` — چون سال مالی ۱۴۰۵ باز است، حالت **soft-void** (سیاست v285):
   JE 1016 ← `status='reversed'`، `deleted_at=now`، شرح + « [ابطال] — <علت>». **سند ابطالی جدا ساخته نمی‌شود**؛
   پس `reversed_by_je_id` خالی می‌ماند (این باگ نیست؛ فقط در دورهٔ بسته سند معکوس با پیوند `reversed_by_je_id/reverses_je_id` ساخته می‌شود).
2. `subledger_recon_fixes#1` ← `status='reversed'`، `reversed_at`، `reversed_by`.
3. `audit_log` ← `action='recon_fix_reverse'`، `entity='subledger_recon_fix'`، `entity_id=1`.

- **leaf enforcement:** در حالت soft-void هیچ سطری post نمی‌شود ⇒ `ledger_leaf_enforcement` (روی prod = `warn`) مانع نیست. فقط اگر سال مالی بسته بود و حالت counter-voucher می‌شد، سطر 1104 (غیربرگ) در حالت `enforce` رد می‌شد — پیش‌نمایش این را در `leaf_enforcement_not_blocking` گزارش می‌کند. تنظیم leaf تغییر داده نشد.
- **محافظ جدید (این PR):** `reverseJournalEntry` در حالت soft-void سندهایی با `ref_type LIKE '%_reversal' AND ref_id = <ref_id سند>` را **حذف فیزیکی** می‌کند. چون ref_id سند 1016 = شمارهٔ اصلاحیه (1) است، هر سند `*_reversal` نامرتبط با ref_id=1 قربانی می‌شد. اکنون `reverseFix` در این حالت با ۴۰۹ `E_RECON_REVERSE_COLLATERAL` متوقف می‌شود (بدون هیچ نوشتن).

## ۲. پیش‌شرط‌ها (همه باید برقرار باشد)
1. این PR (P3-fix) merge و روی سرور ایران deploy شده باشد (پیش‌نمایش + محافظ collateral).
2. **بکاپ تازه** درست قبل از اجرا: `cp server/crm.db /home/taranom/backups/crm.db.<YYYYMMDD-HHMMSS>` (+ `-wal`/`-shm`) — توسط اپراتور.
3. پیش‌نمایش فقط‌خواندنی را بگیرید و بررسی کنید `ready: true`:
   ```
   GET /api/accounting/subledger-recon/fixes/1/reverse-preview
   ```
   (همان مجوز ابطال؛ هیچ نوشتنی ندارد — در تست `total_changes()` قبل = بعد.)
   باید باشد: `fix_posted` ✓، `fix_not_reversed` ✓، `je_alive` ✓ (JE 1016 `approved`)، `period_open` ✓، `no_purge_collateral` ✓ (فهرست خالی)، `leaf_enforcement_not_blocking` ✓، `mode: "soft_void"`.
4. اعداد پیش‌نمایش با بخش ۴ همخوان باشد (۱۰,۸۸۳,۲۱۸,۷۹۰ → ۱۲,۶۸۰,۰۷۹,۱۴۲). اگر نبود ⇒ STOP و بررسی.
5. هیچ پیش‌نویس P3 دیگری هم‌زمان ثبت نشود (اثرشان جداست؛ ترتیب را حامد تعیین کند).

## ۳. مراحل اجرا (فقط حامد)
**UI:** حسابداری ← «مغایرت‌گیری زیرسیستم‌ها با دفتر کل» ← بخش «فهرست اصلاحیه‌ها» ← ردیف **#1** (inventory_vs_gl / 1104 / −1,796,860,352 / #1016) ← دکمهٔ **ابطال** ← علت را وارد کنید، مثلاً: «برگشت JE1016 — تصمیم حامد P3-fix».
> مراقب باشید ردیف **#2** (JE 1017 / 1110) را نزنید.

**API معادل:**
```
POST /api/accounting/subledger-recon/fixes/1/reverse
Content-Type: application/json
Authorization: Bearer <توکن حامد>

{"reason":"برگشت JE1016 — تصمیم حامد P3-fix"}
```
پاسخ موفق: `{"ok":true,"fix":{"id":1,"status":"reversed","reversed_at":<epoch>,"reversed_by":<id حامد>,…}}`
پاسخ‌های توقف: ۴۰۹ `E_RECON_FIX_REVERSED` (قبلاً ابطال شده)، ۴۰۹ `E_RECON_REVERSE_COLLATERAL` (سند نامرتبط در خطر حذف — STOP و گزارش)، ۴۰۳ (مجوز).

## ۴. نتایج مورد انتظار
| شاخص | قبل | بعد |
|------|-----|-----|
| مانده GL درخت 1104 (1104 + 110401 + …) | 10,883,218,790 | **12,680,079,142** (+1,796,860,352) |
| کاردکس انبار 34+35 | 10,997,256,853 | 10,997,256,853 (بدون تغییر) |
| gap = GL − کاردکس(34+35) | −114,038,063 | **+1,682,822,289** |
| JE 1016 | `approved` | `reversed` + `deleted_at` + «[ابطال]» |
| fix #1 | `posted` | `reversed` + reversed_at/by |
| fix #2 / JE 1017 | posted | **بدون تغییر** |
| تعداد ردیف `journal_entries` | N | N (soft-void سند جدید نمی‌سازد؛ بدون حذف) |
| 3102 | — | −1,796,860,352 اثر (برداشته شدن بدهکار JE1016) |

## ۵. پرس‌وجوهای تأیید (فقط‌خواندنی، `sqlite3 -readonly server/crm.db`)
```sql
-- JE 1016 و پیوندها
SELECT id, status, deleted_at, reversed_by_je_id, reverses_je_id, description FROM journal_entries WHERE id IN (1016, 1017);
-- اصلاحیه‌ها (#2 نباید تغییر کند)
SELECT id, code, target, amount_rial, je_id, status, reversed_at, reversed_by FROM subledger_recon_fixes WHERE id IN (1, 2);
-- audit
SELECT id, user_id, action, entity, entity_id, detail, created_at FROM audit_log
 WHERE action='recon_fix_reverse' AND entity='subledger_recon_fix' AND entity_id=1;
-- مانده درخت 1104 (سندهای زنده)
SELECT SUM(COALESCE(NULLIF(jl.debit_rial,0), ROUND(jl.debit), 0) - COALESCE(NULLIF(jl.credit_rial,0), ROUND(jl.credit), 0)) AS gl_1104_subtree
FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
WHERE COALESCE(je.deleted_at,0)=0 AND COALESCE(je.status,'approved') NOT IN ('reversed','void')
  AND (jl.account_code = '1104' OR jl.account_code LIKE '1104%');
-- کاردکس 34+35 (همان فرمول layer-reconcile)
SELECT SUM(CASE WHEN COALESCE(qty_in,0)>0 THEN COALESCE(amount_rial,0)
                WHEN COALESCE(qty_out,0)>0 THEN -COALESCE(amount_rial,0)
                ELSE COALESCE(amount_rial,0) END) AS kardex_34_35
FROM inventory_ledger
WHERE status='posted' AND reversed_of IS NULL AND COALESCE(event_type,'') <> 'reversal'
  AND COALESCE(event_type,'') NOT GLOB '*_reversal' AND warehouse_id IN (34, 35);
-- هیچ سندی حذف فیزیکی نشده (قبل و بعد مقایسه شود)
SELECT COUNT(*), MAX(id) FROM journal_entries;
```
همچنین پس از اجرا دوباره `GET …/fixes/1/reverse-preview` ⇒ `fix_not_reversed=false`، `je_alive=false`، `ready=false` (یعنی دیگر قابل تکرار نیست).

## ۶. بازگشت (rollback)
ابطال اصلاحیه در سیستم «برگشت از ابطال» (un-void) ندارد و **ویرایش مستقیم DB (برگرداندن status) ممنوع است**. راه رسمی:
1. **ترجیحی — سند دستی جبرانی (maker-checker):** اگر حامد تصمیم گرفت اثر JE1016 دوباره برقرار شود، یک پیش‌نویس سند دستی
   **Dr 3102 / Cr 110401 = 1,796,860,352** (حساب برگ 110401، نه 1104) با شرح «اعادهٔ اثر JE1016 پس از ابطال اصلاحیه #1» ساخته شود
   و کاربر دیگری «ثبت پیش‌نویس» کند. این سند قابل ابطال عادی (R13) است و مانده/gap را دقیقاً به قبل برمی‌گرداند (درخت 1104 = 10,883,218,790، gap = −114,038,063).
2. **فقط در دقایق اول و بدون هیچ تراکنش بعدی:** بازگردانی بکاپ پیش‌شرط ۲ توسط اپراتور (pm2 stop → جایگزینی crm.db/wal/shm → pm2 start بدون `--update-env` → health 200). اگر بعد از ابطال هر سند/فروش دیگری ثبت شده، این گزینه ممنوع است (از دست رفتن داده).
3. ساختن اصلاحیهٔ جدید `inventory_vs_gl` از `POST …/inventory_vs_gl/fix` **راه rollback نیست** — مبلغ آن از اختلاف لحظه‌ای محاسبه می‌شود، نه 1,796,860,352.

## ۷. ممنوع
- اجرای این runbook توسط هر کسی جز حامد؛ ثبت پیش‌نویس منسوخ #1؛ دست‌زدن به fix #2 / JE 1017؛
  تغییر `ledger_leaf_enforcement`؛ حذف فیزیکی؛ ویرایش مستقیم DB.

> ## ⛔ STOP — اجرا فقط توسط حامد
