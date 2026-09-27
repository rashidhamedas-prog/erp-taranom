# Native Windows — شکاف‌ها و قرارداد Sync (الحاق ADR)

منبع: بازبینی کد `server/sync/*` + `server/routes/sync.js` + `docs/OFFLINE-SYNC.md`  
والد: [`NATIVE-WINDOWS-DESKTOP-ARCHITECTURE.md`](./NATIVE-WINDOWS-DESKTOP-ARCHITECTURE.md)

## ۱) آنچه باید ثابت بماند (سازگاری مرکز / اندروید)

- `SYNCABLE_TABLES` فقط append-only؛ بدون reorder/حذف (`server/sync/tables.js`)
- فرمول بازهٔ شناسه دستگاه + `seedProvisionalSequences`
- outbox مرتب + idempotency key + stop-at-first-failure
- بازپخش روی هندلرهای واقعی مرکز (نه row-merge)
- `sync_seq` + tombstones؛ بدون LWW مالی
- شمارهٔ نهایی فقط `allocateNumber()` در مرکز؛ آفلاین `موقت-…`
- pairing: Ed25519 + token دستگاه؛ پیش‌شرط DB خالی برای pair اولیه
- شکل wire: push/pull headers HMAC/nonce/skew؛ multipart فایل‌ها

## ۲) آنچه می‌تواند عوض شود

- پوستهٔ UI (WPF به‌جای Electron)
- کانال محلی UI↔Domain Host: **Named Pipe** (نه HTTP localhost برای محصول)
- ارائه‌دهندهٔ secret store (سازگار با envelope فعلی یا re-pair صریح)
- نمایش وضعیت sync

## ۳) شکاف‌های حیاتی نسبت به مأموریت بومی (باید در P0/P1 بسته شوند)

| شکاف | واقعیت کد امروز | الزام مأموریت |
|---|---|---|
| اتمیسیتهٔ دامنه+outbox | capture **بعد از** commit هندلر؛ kill بین آن‌ها ⇒ از دست رفتن خاموش؛ جبران جزئی با `sync_capture_failures` + 503 | همان تراکنش: write + outbox |
| resetPairing / wipe | `resetPairing` جداول syncable + outbox را پاک می‌کند؛ شکست mid initial-pull می‌تواند wipe خودکار کند | هیچ wipe خودکار بدون تأیید صریح اپراتور؛ صف در repair حفظ شود |
| pull در برابر pending محلی | insert مرکزی می‌تواند ردیف محلی با ویرایش ارسال‌نشده را از نظر نمایش بازنویسی کند | حفظ تغییرات ارسال‌نشده؛ وضعیت تعارض صریح |
| tombstone vs pending outbox | حذف tombstone بدون چک ارجاع outbox | رد یا تعارض؛ حذف بی‌صدا ممنوع |
| موجودی مشترک | کسر موجودی فاکتور اغلب warning؛ oversell آفلاین ممکن است در replay هم «موفق» شود | سیاست سهمیه یا تعارض قطعی؛ نه پذیرش بی‌صدا |
| سقف اعتبار | عمدتاً مسیر B2B؛ فاکتور دستگاه ممکن است بدون credit check برود | ماژول سیاست مشترک همهٔ کانال‌ها |
| تعارض دستگاه | عمدتاً discard (برگشت اثر محلی)؛ مسیر «اصلاح و ارسال مجدد» ضعیف | UX اصلاح/سند جبرانی طبق مأموریت |
| base_version ناقص | بعضی مسیرهای فرعی/کلید مرکب بدون concurrency check | پوشش کامل یا رد صریح |
| توکن ۱۸۰روزه | انقضا ⇒ نیاز re-pair؛ UI باید از «آفلاین» تفکیک کند | وضعیت `auth_expired` جدا |

## ۴) مرز SyncWorker پیشنهادی

- Domain Host (Node یا بعدی C#) **تنها نویسندهٔ SQLite**
- SyncWorker داخل همان Host یا sibling با mutex ماشین‌گسترده (جلوگیری از دو نمونه)
- UI فقط وضعیت می‌خواند؛ هرگز ID یا شماره نمی‌سازد
- crash Host ⇒ UI fail-closed (نه نوشتن مستقیم DB)
- کانال محلی authenticated (نه اعتماد صرف به loopback)

## ۵) حالت‌های شکست قابل مشاهده

worker crash · صف مسدود head-of-line · deferred بی‌انتها · 401 توکن/deactivate · clock skew · فایل عقب‌تر از ردیف · مسیر بلند ویندوز

## ۶) سخت‌ممنوع برای پیاده‌سازی native

1. reorder `tables.js`
2. mint شناسه در UI
3. دور زدن `allocateNumber`
4. wipe صف در repair/pairing بدون تأیید
5. LWW مالی یا overwrite کامل DB از سرور
