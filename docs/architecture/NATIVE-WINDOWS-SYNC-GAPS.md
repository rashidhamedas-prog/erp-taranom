# Native Windows — قرارداد و شکاف‌های Sync

> منبع تفصیلی: [بازبینی Sync](b657850d-a7a4-484a-b506-623b24d916df) · ۱۴۰۵/۰۷/۰۵  
> والد: [`NATIVE-WINDOWS-DESKTOP-ARCHITECTURE.md`](./NATIVE-WINDOWS-DESKTOP-ARCHITECTURE.md)  
> کد: `docs/OFFLINE-SYNC.md`, `server/sync/{tables,capture,client}.js`, `server/routes/sync.js`

**حکم سازگاری:** سینک = بازپخش عملیات، نه ادغام ردیف. UI بومی **هرگز مستقیم روی SQLite ننویسد**؛ تنها نویسندهٔ DB = Domain Host (Node با `SYNC_ROLE=device` یا معادل C# که همان قرارداد capture/outbox را پیاده کند). کانال UI↔Host می‌تواند Named Pipe یا loopback **authenticated** باشد — نه به‌عنوان «سایت محصول»، فقط به‌عنوان API دامنه.

---

## ۱) قرارداد فعلی (باید ثابت بماند)

### نقش‌ها
- `SYNC_ROLE=central|device` — mount جدا؛ capture و client loop فقط روی device.

### Pairing و هویت
- `POST /api/sync/pair` با admin + `replay_public_key`؛ توکن ~۱۸۰ روز؛ Ed25519 روی دستگاه؛ ذخیرهٔ امن در `sync_local_kv` (AES-GCM/HKDF).
- Pairing فقط روی DB خالی؛ سپس `seedProvisionalSequences`.

### ترانسپورت
- `Authorization: Device <id>:<token>` + HMAC (`x-sync-time` / `nonce` / `signature`)؛ skew ≤۵ دقیقه؛ nonce یک‌بارمصرف.
- ریموت فقط HTTPS؛ loopback HTTP فقط برای تست/بازپخش مرکز.

### Capture → Push
- هر mutating موفق ۲xx → `sync_outbox` (method/path/body/user/base_version/entity/replay_proof).
- بلاک‌لیست: auth/users/sync/api-keys/messages/v1/ai/b2b/onboarding/excel/backup/import/export/backfill/`/stock$` و …
- Push ترتیبی ≤۴۰۰؛ کلید ایدمپوتنسی `deviceId:seq`؛ stop-at-first-failure؛ وضعیت‌ها: `applied` | `conflict` | `deferred`.
- مرکز: verify امضا → idempotency → remap id → optimistic `version` → loopback به هندلر واقعی با JWT کاربر + `x-internal-replay`.

### Pull
- `since` / `sync_seq` + tombstones؛ `INSERT OR REPLACE`؛ مکان‌نمای اسکالر `last_pull_seq`.
- شناسه دستگاه: `1e12 + deviceId×1e8 + tableIndex×1e6` — ترتیب `tables.js` تغییر نکند.
- شمارهٔ نهایی فقط `allocateNumber()` مرکز؛ آفلاین `موقت-…`.

### تعارض
- بدون LWW؛ `sync_conflicts` + تصمیم انسان؛ discard = reverse محلی (نه تغییر مرکز).

---

## ۲) آنچه می‌تواند عوض شود

- پوستهٔ UI (WPF)
- کانال وضعیت (poll → event/IPC)
- زمان‌بندی/backoff
- ارائه‌دهندهٔ secret (DPAPI) با سازگاری envelope یا re-pair صریح
- UX تعارض و فایل‌های عقب‌مانده

---

## ۳) شکاف‌های حیاتی (دروازهٔ P0/P1)

| # | شکاف | واقعیت کد | الزام بومی |
|---|---|---|---|
| الف | اتمیسیته outbox | capture **بعد از** commit هندلر؛ kill بین آن‌ها ⇒ گم‌شدن خاموش؛ جبران جزئی `sync_capture_failures`+503 | outbox داخل همان تراکنش + reconcile در boot |
| ب | LWW ناقص | `base_version` فقط برای بعضی `/:id`؛ زیرمنبع/کلید مرکب بدون concurrency؛ pull می‌تواند روی pending محلی بنشیند | concurrency کامل یا رد صریح؛ حفظ pending در pull |
| پ | wipe کامل | `resetPairing` همهٔ syncable+outbox؛ شکست mid initial-pull → reset خودکار | فقط با تأیید اپراتور؛ صف در repair حفظ |
| ت | رد بدون تخریب بی‌صدا | tombstone بدون چک outbox معلق؛ FK remap با `foreign_keys=OFF`؛ تعارض عمدتاً فقط discard | tombstone↔pending = تعارض؛ مسیر اصلاح/retry |
| ث | موجودی/اعتبار | فاکتور اغلب `allowNegative`/هشدار؛ oversell آفلاین ممکن است در مرکز هم apply شود؛ `credit_limit` عمدتاً B2B و بلاک‌لیست capture | سیاست مشترک قطعی همهٔ کانال‌ها (سهمیه یا تعارض) |
| ج | فرعی | رشد بی‌سقف `sync_applied_ops`؛ انقضای توکن بدون rotate سمت دستگاه؛ UI نباید «اصلاح مستقیم stock» داشته باشد | هشدار `auth_expired`؛ بدون دکمهٔ stock patch |

---

## ۴) مرز SyncWorker

1. Host محلی = تنها نویسندهٔ SQLite + مالک capture/client.
2. UI = نمایش/فرمان؛ بدون mint id و بدون `allocateNumber` محلی نهایی.
3. سرپرستی: spawn، health، restart، mutex تک‌نمونهٔ ماشین.
4. کانال محلی authenticated (نه اعتماد صرف به پورت تصادفی).
5. جدا نگه داشتن مسیر نوشتن (capture) از حلقهٔ sync (client).

---

## ۵) حالت‌های خرابی قابل مشاهده در UI

| حالت | رفتار درست |
|---|---|
| Host down | fail-closed / فقط‌خواندنی — نه نوشتن مستقیم DB |
| DPAPI/پروفایل خراب | `SYNC_REPAIR_REQUIRED` → اتصال مجدد صریح، نه wipe |
| انسداد سر صف | نمایش op مسدودکننده + سن قدیمی‌ترین pending |
| deferred بی‌انتها | سقف/هشدار |
| 401 توکن/deactivate | تفکیک از «آفلاین» |
| clock skew >۵دقیقه | هشدار همگام‌سازی ساعت |
| nonce 409 | retryable |
| pull نیمه‌کاره | resume صفحه؛ تحمل FK موقت |
| files_missing | نمایش شکسته + skip مجاز |
| دو نمونه Host | mutex — ممنوع |

---

## ۶) سه خط قرمز

1. هرگز ترتیب `SYNCABLE_TABLES` را عوض نکنید.  
2. هرگز UI بومی id نسازد.  
3. هرگز شمارهٔ سند نهایی بیرون از `allocateNumber` مرکز تولید نشود.
