# طرح فازبندی بازنویسی دسکتاپ بومی ERP ترنم

> منبع: برنامه‌ریز ECC · ۱۴۰۵/۰۷/۰۵  
> والد: [`NATIVE-WINDOWS-DESKTOP-ARCHITECTURE.md`](./NATIVE-WINDOWS-DESKTOP-ARCHITECTURE.md)  
> Inventory: [`NATIVE-WINDOWS-CAPABILITY-INVENTORY.md`](./NATIVE-WINDOWS-CAPABILITY-INVENTORY.md)  
> Sync gaps: [`NATIVE-WINDOWS-SYNC-GAPS.md`](./NATIVE-WINDOWS-SYNC-GAPS.md)

## ۰. اندازهٔ واقعی سیستم (مبنای تخمین)

| سطح | اندازه |
|---|---|
| `server/routes/*.js` | ۸۱ فایل |
| endpoint کل / mutating | ~۸۷۹ / ~۴۷۳ |
| `server/lib` | ~۱۱۰ فایل |
| `server/db.js` | ~۱۴۴KB |
| `SYNCABLE_TABLES` | ~۱۷۰ (append-only) |
| فرانت | `app.js` ~۲۴٬۰۰۰ خط |
| تست‌ها | ~۱۶۷ `test-*.js` |

Parity کامل در یک پرش غیرممکن است → قرارداد عملیات ثابت + fixture طلایی + موج ماژولی.

---

## ۱. ADRها (قفل ۱۴۰۵/۰۷/۰۵)

| ADR | پیشنهاد اول برنامه‌ریز | **قفل نهایی** |
|---|---|---|
| ADR-01 UI | .NET 9 + WPF | **.NET 8 LTS + WPF** |
| ADR-02 داده | SQLite همان اسکیما | تأیید |
| **ADR-03 دامنه** | Full C# از روز اول | **گزینه A — Node Host** سپس پورت C# ([DECISIONS-LOCKED](./NATIVE-WINDOWS-DECISIONS-LOCKED.md)) |
| ADR-04 سینک | outbox HTTP ثابت | تأیید |
| ADR-05 شناسه | بازهٔ فعلی | تأیید |
| ADR-06 احراز/لایسنس | DPAPI + JWT | + Ed25519 آفلاین، grace ۳۰روز، Brand Pack OEM |
| ADR-07 بسته | MSI/WiX | Electron پل موقت؛ GA بومی + update امضا |

گزینهٔ B (Full C# از فاز ۱) فقط اگر stop-gate R1 یا شکست بسته‌بندی Host فعال شود.

ممنوعیت سخت مشترک: بدون WebView2/CEF، بدون listen TCP برای UI، بدون تغییر ترتیب `tables.js`، بدون نوشتن DB خارج تراکنش دامنه.

---

## فاز ۰ — انجماد + fixture طلایی — **L**

| # | مورد | وضعیت ۱۴۰۵/۰۷/۰۵ |
|---|---|---|
| 1 | هفت ADR امضا‌شده (به‌ویژه ۰۱ و ۰۳) | ✅ DECISIONS-LOCKED |
| 2 | Snapshot اسکیما + `schema_hash` | ✅ `docs/native/schema.v1.*` (مولد `scripts/native/schema-hash.js`) — CI drift هنوز باز |
| 3 | `OPERATION-CONTRACT` از capture/tables | ✅ `docs/native/OPERATION-CONTRACT.*` (۱۷۰ جدول / ≈۴۷۳ mutating) |
| 4 | هارنس fixture طلایی (مشتری/سفارش/فاکتور/JE/موجودی/R13) | ✅ golden-vertical ۲۱ + **golden-expanded ۱۴۲** |
| 5 | fixture پول/VAT/گردکردن | ✅ در golden |
| 6 | fixture چاپ (paper-ISO / density) | ✅ print-smoke |
| 7 | ماتریس RBAC داده‌ای | ✅ داخل golden-expanded (نقش‌ها + admin resources) |
| 8 | Runner دوگانه Node vs Host | ✅ invoke-slice + airgap-smoke روی pipe |
| 9 | اسکلت `win-native/` + Brand Pack | ✅ Host 0.3 + WPF Login/Customers |
| 10 | ماتریس موج‌ها از inventory | ✅ WAVE-MATRIX |

**خروج هدف فاز ۰:** ADR قفل؛ ≥۱۵۰ fixture؛ runner سبز.  
**وضعیت:** ✅ مجموع assertهای golden ≈۱۶۳ + print/pipe/airgap — `scripts/native/run-all-gates.js` سبز.

---

## فاز ۱ — برش عمودی بومی — **XL**

| # | مورد | وضعیت |
|---|---|---|
| 1 | Domain Host Named Pipe + متادیتا | ✅ |
| 2 | `api.call` / auth / idempotency | ✅ |
| 3 | SyncWorker + backup.local | ✅ v0.3 |
| 4 | WPF Login + Customers روی pipe | ✅ سورس (نیاز .NET 8 SDK برای بیلد) |
| 5 | air-gap smoke خودکار | ✅ `test-airgap-smoke` |
| 6 | MSI امضا / installer بومی | ⏳ (Electron پل تا GA) |
| 7 | صفحات کامل فروش/گزارش WPF | ⏳ موج بعدی UI |

**خروج:** parity ۱۰۰٪ روی fixtureهای slice؛ air-gap PASS؛ interop بومی+Electron+اندروید بدون رگرسیون `test-sync.js`؛ بدون listen/UI وب (و بدون `node.exe` **فقط اگر ADR-03=B**).

---

## موج‌های ۲..۱۱

| موج | دامنه | تلاش |
|---|---|---|
| ۲ | کالا/variant/انبار کامل | L | ✅ smoke pipe `test-wave2-stock` (۱۲) — UI کامل بعدی |
| ۳ | خزانه/چک/تسویه | XL | ✅ smoke pipe `test-wave3-treasury` (۸) — چک lifecycle بعدی |
| ۴ | خرید/RFQ/امانت | L |
| ۵ | حسابداری کامل/سال مالی/چندشرکتی | XL |
| ۶ | تولید/BOM/بهای تمام‌شده | XL |
| ۷ | گزارش/Excel/چاپ تخصصی | L |
| ۸ | CRM/POS/صف بیرونی | M |
| ۹ | حقوق/دارایی/بودجه | M |
| ۱۰ | تنظیمات/RBAC/مودیان/ایمپورت/بکاپ محلی | L |
| ۱۱ | بازنشستگی Electron | M |

قاعدهٔ هر موج: fixture → دامنه parity ۱۰۰٪ → UI → sync-hygiene → گزارش → air-gap ماژول → عرضه.  
از پایان موج ۳: Electron فقط نگه‌داری (بدون قابلیت جدید مگر همزمان در بومی).

---

## جریان‌های موازی

Domain/Data · UI · Sync · Installer/Updater · Tests/QA · Docs — هر موج یک شاخه/`file_claims`.

---

## آزمون Air-Gapped (۱۲ گام — خلاصه)

VM تمیز، شبکه قطع، installer امضا: نصب → bootstrap → چرخه فروش+انبار+R13 → گزارش+چاپ → backup/restore → اثبات بدون listen/`node.exe`/ترافیک → kill mid-tx → reconnect+push+تعارض oversell → interop سه‌طرفه → uninstall امن.

جزئیات اجرایی در اجرای واقعی فاز ۱ به‌صورت چک‌لیست PASS/FAIL امضا می‌شود.

---

## مهاجرت از Electron

پیش‌شرط: outbox خالی و تأییدشده. هم‌زیستی مسیر داده جدا → Migration Wizard (کپی DB+uploads، rewrap DPAPI، حفظ device_id) → Electron فقط‌خواندنی → rollback با snapshot → موج ۱۱ بازنشستگی.

---

## Stop-gateهای کلیدی

| # | محرک | اقدام |
|---|---|---|
| R1 | parity JE/موجودی < ۱۰۰٪ پایان فاز ۱ | توقف؛ بازبینی ADR-03 (ادامه پورت / قواعد‌به‌داده / sidecar موقت با مهلت) |
| R2 | اختلاف ریالی | صفر تحمل |
| R3 | drift `schema_hash` | CI fail |
| R4 | drift قرارداد sync | موج بسته نشود |
| R8 | outbox غیرخالی هنگام مهاجرت | رد سخت |
| R9 | feature جدید Electron بعد موج ۳ | ممنوع مگر همزمان بومی |
| R12 | بیلد installer بدون دستور مالک | ممنوع (قاعده پروژه) |

---

## نخستین اقدام‌ها (بدون بیلد محصول)

1. تصویب ADR-01 و **ADR-03** توسط مالک.
2. ابزار `schema_hash`.
3. تولید OPERATION-CONTRACT از capture/tables/routes.
4. انتخاب و ضبط ۱۵۰ fixture برش عمودی.
5. سند چک‌لیست air-gap قابل‌امضا در `docs/native/` یا همین پوشه.
