package ir.taranom.crm.sales.update

import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URI
import java.nio.charset.StandardCharsets

/**
 * واکشی `releases/manifest.json` از میزبان allowlist و ارزیابی آپدیت.
 *
 * مسیر پیش‌فرض: `{baseUrl}/releases/manifest.json`
 * (همان فایلی که `server/lib/app-update.js` می‌خواند).
 */
class ManifestUpdateChecker(
    private val httpGet: (String) -> String = ::defaultHttpGet,
) {

    fun check(
        baseUrl: String,
        currentVersion: String,
        currentVersionCode: Long,
    ): UpdateCheckResult {
        val manifestUrl = resolveManifestUrl(baseUrl)
        require(isAllowedManifestUrl(manifestUrl)) { "manifest_host_not_allowed" }
        val body = httpGet(manifestUrl)
        val manifest = ManifestParser.parse(body)
        return ApkUpdateEvaluator.evaluate(
            manifest = manifest,
            currentVersion = currentVersion,
            currentVersionCode = currentVersionCode,
            baseUrl = baseUrl,
        )
    }

    companion object {
        fun resolveManifestUrl(baseUrl: String): String {
            val base = URI(baseUrl.trimEnd('/') + "/")
            return base.resolve("releases/manifest.json").toString()
        }

        fun isAllowedManifestUrl(url: String): Boolean {
            return try {
                val uri = URI(url)
                val host = uri.host?.lowercase().orEmpty()
                uri.scheme.equals("https", ignoreCase = true) &&
                    (uri.port == -1 || uri.port == 443) &&
                    uri.userInfo == null &&
                    host in UpdateHosts.ALLOWED &&
                    uri.path?.endsWith("/releases/manifest.json") == true
            } catch (_: Exception) {
                false
            }
        }

        fun defaultHttpGet(url: String): String {
            val conn = (URI(url).toURL().openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 15_000
                readTimeout = 30_000
                instanceFollowRedirects = false
                setRequestProperty("Accept", "application/json")
            }
            try {
                val code = conn.responseCode
                if (code != 200) error("manifest_http_$code")
                return BufferedReader(
                    InputStreamReader(conn.inputStream, StandardCharsets.UTF_8),
                ).use { it.readText() }
            } finally {
                conn.disconnect()
            }
        }
    }
}
