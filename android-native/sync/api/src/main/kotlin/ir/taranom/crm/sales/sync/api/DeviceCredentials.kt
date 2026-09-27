package ir.taranom.crm.sales.sync.api

/**
 * هویت **دستگاه** (نه کاربر). این دو هرگز یکی نمی‌شوند: تعویض کاربر روی گوشی
 * هویت دستگاه را عوض نمی‌کند، و صف کاربر قبلی با هویت کاربر جدید ارسال نمی‌شود
 * (ADR-AND-001 §۷.۴).
 *
 * پیاده‌سازی اندرویدی باید کلیدها را در Android Keystore نگه دارد؛ کلید خصوصی
 * Ed25519 **هرگز** از دستگاه خارج نمی‌شود و در لاگ نمی‌آید (ADR §۹).
 */
interface DeviceCredentials {

    /** `device_id` صادرشده توسط مرکز؛ تا قبل از pairing `null`. */
    val deviceId: Long?

    val isPaired: Boolean get() = deviceId != null

    /** مقدار هدر `Authorization: Device <id>:<token>`؛ اگر جفت نشده `null`. */
    fun authorizationHeader(): String?

    /**
     * HMAC بدنه/مسیر برای هدر `x-sync-signature`.
     * @param canonicalPayload رشتهٔ canonical درخواست (مسیر + زمان + nonce + بدنه).
     */
    fun signRequest(canonicalPayload: ByteArray): ByteArray

    /**
     * امضای Ed25519 یک عملیات outbox برای `replay_proof`.
     *
     * ورودی باید **بایت‌به‌بایت** همان serialization پایدار سرور (`stableJson`)
     * باشد؛ هر اختلاف ترتیب کلید ⇒ رد شدن عملیات در مرکز.
     */
    fun replayProof(stableJsonBytes: ByteArray): ByteArray

    /** nonce تازه برای هدر `x-sync-nonce`. */
    fun freshNonce(): String

    /** ساعت دستگاه به ثانیهٔ یونیکس؛ اختلاف بیش از ۳۰۰ ثانیه رد می‌شود. */
    fun nowEpochSeconds(): Long
}
