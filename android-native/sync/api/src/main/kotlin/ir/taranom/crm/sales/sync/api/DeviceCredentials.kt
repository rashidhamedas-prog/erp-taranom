package ir.taranom.crm.sales.sync.api

/**
 * هویت **دستگاه** (نه کاربر). این دو هرگز یکی نمی‌شوند: تعویض کاربر روی گوشی
 * هویت دستگاه را عوض نمی‌کند، و صف کاربر قبلی با هویت کاربر جدید ارسال نمی‌شود
 * (ADR-AND-001 §۷.۴).
 *
 * پیاده‌سازی باید توکن و کلید خصوصی Ed25519 را در ذخیره‌گاه امن نگه دارد
 * (EncryptedSharedPreferences / Android Keystore). کلید خصوصی **هرگز** از
 * دستگاه خارج نمی‌شود و در لاگ نمی‌آید (ADR §۹).
 *
 * Missing credentials ⇒ fail closed (هیچ درخواست sync بدون امضا ارسال نشود).
 */
interface DeviceCredentials {

    /** `device_id` صادرشده توسط مرکز؛ تا قبل از pairing `null`. */
    val deviceId: Long?

    /** Base URL of central (https://…); null if unpaired. */
    val centralUrl: String?

    val isPaired: Boolean
        get() = deviceId != null && !centralUrl.isNullOrBlank() && hasDeviceToken()

    fun hasDeviceToken(): Boolean

    /** `Authorization: Device <id>:<token>`؛ اگر جفت نشده `null`. */
    fun authorizationHeader(): String?

    /**
     * HMAC-SHA256 hex of `"$timestamp:$nonce"` keyed by SHA-256(device_token),
     * matching `server/sync/device-auth.js` `signature()`.
     */
    fun hmacSignature(timestampSec: Long, nonce: String): String

    /**
     * Ed25519 `replay_proof` (base64url) over canonical stableJson envelope.
     * @throws IllegalStateException if signing key missing (fail closed)
     */
    fun signReplayProof(
        seq: Long,
        method: String,
        path: String,
        userId: Long,
        body: Map<String, Any?>,
        fileHash: String = "",
        fileField: String = "",
    ): String

    /** PEM SPKI public key for pairing ceremony. */
    fun replayPublicKeyPem(): String

    /** nonce تازه برای هدر `x-sync-nonce` (۳۶ hex char = ۱۸ بایت). */
    fun freshNonce(): String

    /** ساعت دستگاه به ثانیهٔ یونیکس؛ اختلاف بیش از ۳۰۰ ثانیه رد می‌شود. */
    fun nowEpochSeconds(): Long
}
