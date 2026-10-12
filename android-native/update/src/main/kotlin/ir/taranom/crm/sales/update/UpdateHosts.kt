package ir.taranom.crm.sales.update

/**
 * میزبان‌های مجاز دانلود APK — همان allowlist legacy
 * (`MainActivity.APK_UPDATE_HOSTS`).
 */
object UpdateHosts {
    val ALLOWED: Set<String> = setOf(
        "erptaranom.com",
        "www.erptaranom.com",
    )

    const val MAX_APK_SIZE_BYTES: Long = 512L * 1024L * 1024L

    fun normalizedSha256(value: String?): String? {
        val digest = value?.trim()?.lowercase().orEmpty()
        return if (digest.matches(Regex("^[a-f0-9]{64}$"))) digest else null
    }

    fun normalizedSize(value: Long?): Long? =
        if (value != null && value > 0 && value <= MAX_APK_SIZE_BYTES) value else null

    /**
     * URL دانلود APK فقط HTTPS روی میزبان allowlist و مسیر `.apk`.
     * هم‌تراز `isAllowedApkUpdateUrl` در MainActivity legacy.
     */
    fun isAllowedApkUpdateUrl(value: String?): Boolean {
        if (value.isNullOrBlank() || value.length > 2048) return false
        return try {
            val uri = java.net.URI(value)
            val host = uri.host?.lowercase().orEmpty()
            val path = uri.path?.lowercase().orEmpty()
            uri.scheme.equals("https", ignoreCase = true) &&
                (uri.port == -1 || uri.port == 443) &&
                uri.userInfo == null &&
                uri.fragment == null &&
                host in ALLOWED &&
                path.endsWith(".apk")
        } catch (_: Exception) {
            false
        }
    }

    /**
     * مسیر نسبی `/releases/...` را نسبت به baseUrl مرکز به URL مطلق تبدیل می‌کند
     * (مثل `resolveReleaseUrl` سرور).
     */
    fun resolveReleaseUrl(value: String?, baseUrl: String?): String? {
        val candidate = value?.trim().orEmpty()
        if (candidate.isEmpty()) return null
        return try {
            when {
                candidate.startsWith("http://", ignoreCase = true) ||
                    candidate.startsWith("https://", ignoreCase = true) ->
                    java.net.URI(candidate).toString()
                candidate.startsWith("/") && !baseUrl.isNullOrBlank() -> {
                    val base = java.net.URI(baseUrl)
                    if (base.scheme != "http" && base.scheme != "https") return null
                    base.resolve(candidate).toString()
                }
                else -> null
            }
        } catch (_: Exception) {
            null
        }
    }
}
