package ir.taranom.crm.sales.core.model

/**
 * یک عملیات در صف خروجی. شکل آن باید **عیناً** همان wire فعلی باشد تا مرکز
 * بتواند از مسیر هندلر واقعی Express بازپخش کند
 * (`{method, path, body, user_id, base_version, replay_proof, …}`) — ADR §۸.
 *
 * دو قاعدهٔ غیرقابل‌مذاکره:
 * 1. نوشتن دامنه + درج این ردیف در **یک تراکنش** (شکاف capture-after-commit
 *    موتور Node نباید در کلاینت بومی تکرار شود).
 * 2. ترتیب [seq] حفظ می‌شود و با اولین conflict، پردازش صف متوقف می‌ماند.
 */
data class OutboxOp(
    val seq: Long,
    val method: String,
    val path: String,
    val bodyJson: String,
    /** هویت کاربرِ ثبت‌کننده؛ بازپخش با همین هویت انجام می‌شود (نه کاربر فعلی). */
    val userId: Long,
    /** نسخهٔ ردیف پایه هنگام ثبت — مبنای تشخیص تعارض در مرکز. */
    val baseVersion: Long? = null,
    /** ردیف‌های ساخته/تغییرکردهٔ محلی؛ کلاینت بومی خودش تولید می‌کند. */
    val capturedRowsJson: String? = null,
    /** امضای Ed25519 هر عملیات. کلید خصوصی هرگز از دستگاه خارج نمی‌شود. */
    val replayProof: String? = null,
    val status: OutboxStatus = OutboxStatus.PENDING,
    val attemptCount: Int = 0,
    val lastError: String? = null,
    val createdAtEpochMs: Long = 0,
) {
    /** کلید ایدمپوتنسی مرکز: `"<device_id>:<outbox_seq>"`. */
    fun idempotencyKey(deviceId: Long): String = "$deviceId:$seq"
}
