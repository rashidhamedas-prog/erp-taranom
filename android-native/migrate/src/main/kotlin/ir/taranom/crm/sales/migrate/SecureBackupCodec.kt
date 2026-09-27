package ir.taranom.crm.sales.migrate

import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * بکاپ امن دستگاه فروش — AES-256-GCM با کلید مشتق از passphrase کاربر.
 *
 * **قرارداد امنیتی:**
 * - HMAC/device_token/کلید خصوصی Ed25519 / JWT هرگز در payload نیستند.
 * - `device_id` فقط به‌صورت hint غیرمخفی برای تطبیق restore؛ restore روی دستگاه
 *   با device_id متفاوت fail-closed است مگر re-pair صریح بعدی.
 * - passphrase حداقل ۱۶ کاراکتر (PBKDF2 120k iteration).
 */
object SecureBackupCodec {

    const val FORMAT = "taranom-sales-backup-v1"
    private const val PBKDF2_ITERATIONS = 120_000
    private const val KEY_BITS = 256
    private const val GCM_TAG_BITS = 128
    private const val MIN_PASSPHRASE = 16

    data class Envelope(
        val format: String,
        val saltB64: String,
        val ivB64: String,
        val ciphertextB64: String,
    )

    fun exportEncrypted(payloadJson: String, passphrase: CharArray): Envelope {
        require(passphrase.size >= MIN_PASSPHRASE) {
            FailClosedRules.BACKUP_PASSPHRASE_WEAK
        }
        assertNoSecrets(payloadJson)
        val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val key = deriveKey(passphrase, salt)
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
        cipher.updateAAD(FORMAT.toByteArray(Charsets.UTF_8))
        val ct = cipher.doFinal(payloadJson.toByteArray(Charsets.UTF_8))
        return Envelope(
            format = FORMAT,
            saltB64 = b64(salt),
            ivB64 = b64(iv),
            ciphertextB64 = b64(ct),
        )
    }

    fun importDecrypted(envelope: Envelope, passphrase: CharArray): String {
        require(envelope.format == FORMAT) { "unsupported_backup_format" }
        require(passphrase.size >= MIN_PASSPHRASE) {
            FailClosedRules.BACKUP_PASSPHRASE_WEAK
        }
        val salt = ub64(envelope.saltB64)
        val iv = ub64(envelope.ivB64)
        val ct = ub64(envelope.ciphertextB64)
        val key = deriveKey(passphrase, salt)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        try {
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
            cipher.updateAAD(FORMAT.toByteArray(Charsets.UTF_8))
            val plain = cipher.doFinal(ct)
            val json = String(plain, Charsets.UTF_8)
            assertNoSecrets(json)
            return json
        } catch (e: Exception) {
            throw SecurityException(FailClosedRules.BACKUP_TAMPERED, e)
        }
    }

    fun buildPayloadJson(
        deviceIdHint: Long?,
        customersJson: String,
        outboxJson: String,
        createdAtEpochMs: Long,
    ): String {
        // JSON دستی حداقلی — بدون کلیدهای secret.
        val idPart = deviceIdHint?.let { "\"device_id_hint\":$it," } ?: "\"device_id_hint\":null,"
        return """{"format":"$FORMAT",$idPart"created_at":$createdAtEpochMs,"customers":$customersJson,"outbox":$outboxJson,"secrets_exported":false}"""
    }

    fun assertNoSecrets(payload: String) {
        val lower = payload.lowercase()
        for (key in ForbiddenSecretKeys.KEYS) {
            if (lower.contains("\"${key.lowercase()}\"")) {
                error(FailClosedRules.SECRET_KEY_IN_EXPORT)
            }
        }
        if (lower.contains("enc:v1:")) {
            error(FailClosedRules.SECRET_VALUE_PLAINTEXT)
        }
        if (Regex("\"device_token\"\\s*:").containsMatchIn(lower)) {
            error(FailClosedRules.SECRET_KEY_IN_EXPORT)
        }
        if (Regex("\"replay_private").containsMatchIn(lower)) {
            error(FailClosedRules.SECRET_KEY_IN_EXPORT)
        }
    }

    /** سریال‌سازی envelope به یک خط برای فایل `.tsbak`. */
    fun serializeEnvelope(envelope: Envelope): String =
        """{"format":"${envelope.format}","salt":"${envelope.saltB64}","iv":"${envelope.ivB64}","ciphertext":"${envelope.ciphertextB64}"}"""

    fun parseEnvelope(text: String): Envelope {
        // پارس سبک با regex برای فیلدهای ثابت.
        fun field(name: String): String {
            val m = Regex("\"$name\"\\s*:\\s*\"([^\"]*)\"").find(text)
                ?: error("envelope_missing_$name")
            return m.groupValues[1]
        }
        return Envelope(
            format = field("format"),
            saltB64 = field("salt"),
            ivB64 = field("iv"),
            ciphertextB64 = field("ciphertext"),
        )
    }

    private fun deriveKey(passphrase: CharArray, salt: ByteArray): SecretKeySpec {
        val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        val spec = PBEKeySpec(passphrase, salt, PBKDF2_ITERATIONS, KEY_BITS)
        try {
            val encoded = factory.generateSecret(spec).encoded
            return SecretKeySpec(encoded, "AES")
        } finally {
            spec.clearPassword()
        }
    }

    private fun b64(bytes: ByteArray): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    private fun ub64(value: String): ByteArray =
        Base64.getUrlDecoder().decode(value)
}

/**
 * فیلتر صریح ردیف‌های kv قبل از هر export — دفاع در عمق.
 */
object SecureBackupKvFilter {
    fun allowKey(key: String): Boolean =
        key in ForbiddenSecretKeys.IDENTITY_SAFE && !ForbiddenSecretKeys.isForbidden(key)
}
