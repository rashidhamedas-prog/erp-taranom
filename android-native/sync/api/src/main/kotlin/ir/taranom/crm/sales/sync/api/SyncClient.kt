package ir.taranom.crm.sales.sync.api

import ir.taranom.crm.sales.core.model.OutboxOp

/** نتیجهٔ pairing (پاسخ [SyncEndpoints.PAIR]). */
data class PairResult(
    val deviceId: Long,
    val deviceToken: String,
    val centralUrl: String,
    val tokenExpiresAt: Long? = null,
)

/** سرنوشت یک عملیات پس از بازپخش در مرکز. */
sealed interface OpOutcome {
    val seq: Long

    /** مرکز پذیرفت. [centralIds] نگاشت شناسهٔ provisional → شناسهٔ واقعی. */
    data class Accepted(
        override val seq: Long,
        val centralIds: Map<Long, Long> = emptyMap(),
        /** شمارهٔ رسمی صادرشده (`T-xxxx`) اگر سند شماره‌دار بود. */
        val assignedDocumentNumber: String? = null,
        val resultJson: String? = null,
    ) : OpOutcome

    /**
     * مرکز رد کرد (موجودی، نسخهٔ قدیمی، مجوز). سند محلی **حذف نمی‌شود**؛
     * منتظر تصمیم انسان می‌ماند (ADR §۸.۱ — بدون LWW مالی).
     */
    data class Conflict(
        override val seq: Long,
        val reason: String,
        val centralVersion: Long? = null,
    ) : OpOutcome

    /** مرکز فعلاً پردازش نکرد؛ همان عملیات بعداً دوباره فرستاده می‌شود. */
    data class Deferred(
        override val seq: Long,
        val reason: String,
    ) : OpOutcome
}

/**
 * نتیجهٔ push. مرکز عملیات را به ترتیب پردازش می‌کند و با اولین
 * conflict/defer متوقف می‌شود، پس [outcomes] می‌تواند کوتاه‌تر از ورودی باشد.
 */
data class PushResult(
    val outcomes: List<OpOutcome>,
    val stoppedAtSeq: Long? = null,
)

/** یک ردیف دریافتی از مرکز. */
data class PulledRow(
    val table: String,
    val primaryKey: String,
    val syncSeq: Long,
    val json: String?,
    /** `true` = سنگ‌قبر (حذف در مرکز). */
    val deleted: Boolean = false,
)

data class PullResult(
    val rows: List<PulledRow>,
    val nextSyncSeq: Long,
    val hasMore: Boolean,
)

data class RemoteFile(
    val subdir: String,
    val fileName: String,
    val sizeBytes: Long,
    val sha256: String?,
)

/**
 * کلاینت همگام‌سازی — قرارداد wire با `server/sync/client.js` / `routes/sync.js`.
 *
 * سه قاعدهٔ رفتاری که پیاده‌سازی باید تضمین کند:
 * 1. ترتیب صف حفظ شود و با اولین `Conflict`/`Deferred` ارسال متوقف شود.
 * 2. کلید ایدمپوتنسی هر عملیات `"<device_id>:<outbox_seq>"` باشد.
 * 3. خطای شبکه ≠ خطای احراز هویت: UI باید `آفلاین` را از `auth_expired` جدا نشان دهد.
 */
interface SyncClient {

    /**
     * [SyncEndpoints.PAIR] — admin username/password + Ed25519 public key.
     * Fail-closed if credentials missing after pair.
     */
    suspend fun pair(
        centralUrl: String,
        username: String,
        password: String,
        deviceName: String,
    ): PairResult

    /** [SyncEndpoints.PUSH] — ارسال صف به ترتیب `seq`. */
    suspend fun push(ops: List<OutboxOp>): PushResult

    /** [SyncEndpoints.PULL] — تغییرات مرکز از `sinceSyncSeq` به بعد. */
    suspend fun pull(sinceSyncSeq: Long, limit: Int): PullResult

    /** [SyncEndpoints.ROW] — خواندن نسخهٔ مرکزی یک ردیف برای نمایش تعارض. */
    suspend fun fetchRow(table: String, primaryKey: String): PulledRow?

    /** [SyncEndpoints.FILES] — دریافت باینری فایل (query `path=subdir/name`). */
    suspend fun downloadFile(subdir: String, fileName: String): ByteArray

    /** [SyncEndpoints.REPLAY_MULTIPART] — بازپخش عملیات با پیوست. */
    suspend fun replayMultipart(op: OutboxOp, fileBytes: ByteArray, fileName: String): OpOutcome
}
