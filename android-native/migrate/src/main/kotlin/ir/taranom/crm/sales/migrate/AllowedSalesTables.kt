package ir.taranom.crm.sales.migrate

/**
 * جداول فروش مجاز برای کپی به Room در موج مهاجرت.
 *
 * عمداً محدود: حسابداری/تولید/HR کپی نمی‌شود. جدول‌های هویت/رمز جداگانه
 * با [ForbiddenSecretKeys] فیلتر می‌شوند — هرگز به‌صورت خام در بکاپ یا Room.
 */
object AllowedSalesTables {
    /** جداول دامنهٔ فروش که به Room اسکلت map می‌شوند. */
    val COPY_TO_ROOM: Set<String> = setOf(
        "customers",
        "sync_outbox",
    )

    /** جداول فقط‌خواندنی برای تشخیص pairing (بدون کپی secret). */
    val IDENTITY_PROBE: Set<String> = setOf(
        "sync_local_kv",
    )

    val ALL_READABLE: Set<String> = COPY_TO_ROOM + IDENTITY_PROBE
}

/**
 * کلیدهای `sync_local_kv` که **هرگز** نباید plaintext از دستگاه خارج شوند
 * یا بدون re-wrap وارد بکاپ/Room شوند.
 */
object ForbiddenSecretKeys {
    val KEYS: Set<String> = setOf(
        "device_token",
        "device_hmac_key",
        "hmac_key",
        "replay_private_key",
        "replay_secret",
        "jwt_secret",
        "SYNC_LOCAL_ENCRYPTION_KEY",
    )

    /** کلیدهای غیرمحرمانه که فقط برای تطبیق هویت خوانده می‌شوند. */
    val IDENTITY_SAFE: Set<String> = setOf(
        "device_id",
        "central_url",
    )

    fun isForbidden(key: String): Boolean {
        val k = key.trim().lowercase()
        return KEYS.any { it.lowercase() == k } ||
            k.contains("private") ||
            k.contains("token") ||
            k.contains("hmac") ||
            k.contains("secret") ||
            k.startsWith("enc:v1")
    }
}
