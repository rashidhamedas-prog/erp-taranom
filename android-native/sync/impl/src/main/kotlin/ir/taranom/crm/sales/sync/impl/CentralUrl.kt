package ir.taranom.crm.sales.sync.impl

import java.net.URI

object CentralUrl {
    /** Production central from `server/sync/client.js`. */
    const val PRODUCTION = "https://erp.poshaktaranom.com"

    private val LEGACY_HOSTS = setOf("45.90.98.99")

    fun normalize(url: String?): String {
        if (url.isNullOrBlank()) return ""
        var u = url.trim().trimEnd('/')
        if (!u.startsWith("http://", ignoreCase = true) && !u.startsWith("https://", ignoreCase = true)) {
            u = "https://$u"
        }
        return u.trimEnd('/')
    }

    fun assertAllowed(url: String): String {
        val u = normalize(url)
        require(u.isNotBlank()) { "آدرس سرور مرکزی نامعتبر است" }
        val uri = URI(u)
        val host = uri.host?.lowercase() ?: throw IllegalArgumentException("آدرس سرور مرکزی نامعتبر است")
        if (host in LEGACY_HOSTS) return PRODUCTION
        val loopback = host == "127.0.0.1" || host == "localhost" || host == "::1"
        if (uri.scheme.equals("http", ignoreCase = true) && !loopback) {
            throw IllegalArgumentException(
                "اتصال ریموت فقط با HTTPS مجاز است — HTTP برای سرور غیرمحلی پذیرفته نمی‌شود",
            )
        }
        return u
    }

    fun upgradeHttp(url: String): String {
        val u = normalize(url)
        if (u.isEmpty()) return u
        val uri = URI(u)
        val host = uri.host?.lowercase() ?: return u
        val loopback = host == "127.0.0.1" || host == "localhost" || host == "::1"
        if (uri.scheme.equals("http", ignoreCase = true) && !loopback) {
            return assertAllowed(u.replaceFirst("http://", "https://", ignoreCase = true))
        }
        return assertAllowed(u)
    }
}
