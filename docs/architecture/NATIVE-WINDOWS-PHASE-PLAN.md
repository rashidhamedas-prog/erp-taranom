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

## ۱. ADRهای پیشنهادی برنامه‌ریز (نیازمند تصویب مالک)

| ADR | پیشنهاد برنامه‌ریز | وضعیت نسبت به ADR والد |
|---|---|---|
| ADR-01 UI | .NET 9 + **WPF** + MVVM | هم‌راستا (والد: .NET 8 WPF؛ نسخهٔ LTS قابل تأیید) |
| ADR-02 داده | SQLite + همان اسکیما بدون انشعاب | هم‌راستا |
| **ADR-03 دامنه** | **پورت کامل به C# از روز اول** (بدون Node sidecar) | **تعارض** با والد: Primary = WPF+Headless Node؛ Fallback = Full C# |
| ADR-04 سینک | حفظ شکل HTTP outbox برای سازگاری سه‌طرفه | هم‌راستا |
| ADR-05 شناسه | همان فرمول بازه + ترتیب tables.js | هم‌راستا |
| ADR-06 احراز | DPAPI + JWT محلی + همان hash رمز | هم‌راستا |
| ADR-07 بسته | MSI/WiX + کانال update جدا از Electron | هم‌راستا (والد: Velopack/NSIS هم مجاز) |

**تصمیم مالک الزامی برای ADR-03:**  
- **گزینه A (والد/ارزیابی فناوری):** Node Host فاز ۱ → پورت تدریجی C# با golden parity (کم‌ریسک‌تر برای زمان تا اولین air-gap).  
- **گزینه B (برنامه‌ریز):** Full C# از فاز ۱؛ شرط استقلال بدون `node.exe` سخت‌گیرانه‌تر؛ ریسک parity بالاتر تا fixtureها کامل شوند.

ممنوعیت سخت مشترک: بدون WebView2/CEF، بدون listen TCP برای UI، بدون تغییر ترتیب `tables.js`، بدون نوشتن DB خارج تراکنش دامنه.

---

## فاز ۰ — انجماد + fixture طلایی — **L**

1. هفت ADR امضا‌شده (به‌ویژه ۰۱ و ۰۳).
2. Snapshot اسکیما + `schema_hash` + دروازهٔ CI drift.
3. `OPERATION-CONTRACT.md` تولیدشده از ۴۷۳ مسیر mutating + `PATH_TABLE_MAP` (artifact commit‌شده).
4. هارنس fixture: request/actor/clock → DB delta (اولویت: مشتری/سفارش/فاکتور/JE/موجودی/R13).
5. fixture پول/VAT/گردکردن جدا.
6. fixture چاپ (paper-ISO / density).
7. ماتریس RBAC داده‌ای.
8. Runner دوگانه Node vs C# (یا Node Host) با نرخ parity per-module.
9. اسکلت `win-native/` + CI.
10. ماتریس موج‌ها از inventory.

**خروج:** ADR قفل؛ ≥۱۵۰ fixture برش عمودی؛ runner سبز روی مرجع Node.

---

## فاز ۱ — برش عمودی بومی — **XL**

مشتری → سفارش → فاکتور → JE+انبار → گزارش محلی → sync  
+ R13 از روز اول · شماره موقت · چاپ · Auth آفلاین · MSI حداقلی  

**خروج:** parity ۱۰۰٪ روی fixtureهای slice؛ air-gap PASS؛ interop بومی+Electron+اندروید بدون رگرسیون `test-sync.js`؛ بدون listen/UI وب (و بدون `node.exe` **فقط اگر ADR-03=B**).

---

## موج‌های ۲..۱۱

| موج | دامنه | تلاش |
|---|---|---|
| ۲ | کالا/variant/انبار کامل | L |
| ۳ | خزانه/چک/تسویه | XL |
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
