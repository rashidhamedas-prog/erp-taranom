package ir.taranom.crm.sales.update

/**
 * شکل `server/public/releases/manifest.json` — منبع حقیقت نسخهٔ اندروید
 * (هم‌تراز `server/lib/app-update.js`).
 */
data class ReleaseManifest(
    val releaseId: String? = null,
    val web: PlatformRelease? = null,
    val desktop: PlatformRelease? = null,
    val android: PlatformRelease? = null,
)

data class PlatformRelease(
    val version: String = "0",
    val versionCode: Long? = null,
    val url: String? = null,
    val distribution: String? = null,
    val sha256: String? = null,
    val sha512: String? = null,
    val size: Long? = null,
    val notes: String? = null,
    val feedUrl: String? = null,
)

/**
 * پاسخ بررسی آپدیت — هم‌شکل فیلدهای `buildUpdateResponse` سمت سرور.
 */
data class UpdateCheckResult(
    val platform: String,
    val current: String,
    val latestVersion: String,
    val versionCode: Long?,
    val updateAvailable: Boolean,
    val downloadable: Boolean,
    val distribution: String,
    val url: String?,
    val notes: String,
    val sha256: String?,
    val size: Long?,
    val integrityRequired: Boolean,
    val integrityValid: Boolean,
)
