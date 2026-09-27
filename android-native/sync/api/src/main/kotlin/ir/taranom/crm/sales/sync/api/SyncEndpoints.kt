package ir.taranom.crm.sales.sync.api

/**
 * قرارداد wire همگام‌سازی — مستند از `docs/OFFLINE-SYNC.md` و
 * `docs/architecture/NATIVE-ANDROID-EVIDENCE.md §B`.
 *
 * **هیچ پروتکل انشعابی برای اندروید مجاز نیست** (ADR-AND-001 §۱.۲): دستگاه بومی
 * باید دقیقاً همان مسیرها/هدرها را بزند که دستگاه فعلی nodejs-mobile می‌زند، تا
 * مرکز بتواند عملیات را از مسیر همان هندلر واقعی Express بازپخش کند.
 */
object SyncEndpoints {

    /**
     * جفت‌سازی دستگاه: کلید عمومی Ed25519 دستگاه ثبت و `device_id` + token صادر
     * می‌شود.
     *
     * توجه (مسدودکنندهٔ شناخته‌شده): امروز این مسیر روی مرکز **admin-only** است؛
     * برای فروشندهٔ میدانی یا باید بستهٔ provisioning امضاشده بیاید یا قرارداد با
     * تسک جداگانهٔ سرور عوض شود — تصمیم مالک (ADR §۱۴ بند ۸).
     */
    const val PAIR = "/api/sync/pair"

    /** ارسال صف outbox به ترتیب `seq`؛ توقف با اولین conflict/defer. */
    const val PUSH = "/api/sync/push"

    /** دریافت افزایشی تغییرات مرکز از `sync_seq` آخر + tombstoneها. */
    const val PULL = "/api/sync/pull"

    /** خواندن یک ردیف مشخص از مرکز (بازسازی/بررسی تعارض). */
    const val ROW = "/api/sync/row"

    /** فهرست فایل‌های قابل دریافت (تصویر کالا، رسید). */
    const val FILES = "/api/sync/files"

    /** بازپخش عملیاتی که بدنهٔ multipart دارد (آپلود پیوست). */
    const val REPLAY_MULTIPART = "/api/sync/replay-multipart"

    /** هدرهای اجباری هر درخواست sync. */
    object Headers {
        /** `Authorization: Device <device_id>:<token>` */
        const val AUTHORIZATION = "Authorization"
        const val AUTHORIZATION_SCHEME = "Device"

        /** مهر زمانی یونیکس (ثانیه)؛ اختلاف مجاز ±۳۰۰ ثانیه. */
        const val TIME = "x-sync-time"

        /** nonce یک‌بارمصرف ضد-replay. */
        const val NONCE = "x-sync-nonce"

        /** HMAC درخواست با کلید مشترک دستگاه. */
        const val SIGNATURE = "x-sync-signature"
    }

    /** حداکثر اختلاف ساعت پذیرفته‌شدهٔ مرکز (ثانیه). */
    const val MAX_CLOCK_SKEW_SECONDS = 300L
}
