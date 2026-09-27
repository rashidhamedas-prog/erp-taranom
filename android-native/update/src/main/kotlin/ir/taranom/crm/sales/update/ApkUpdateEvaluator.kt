package ir.taranom.crm.sales.update

/**
 * پارس سبک JSON برای `releases/manifest.json` بدون وابستگی به کتابخانهٔ JSON.
 * فقط کلیدهای شناخته‌شدهٔ پلتفرم‌ها خوانده می‌شوند؛ فیلدهای ناشناخته نادیده.
 */
object ManifestParser {

    fun parse(json: String): ReleaseManifest {
        val root = JsonLite.objectMap(json)
        return ReleaseManifest(
            releaseId = root["releaseId"]?.asString(),
            web = root["web"]?.asObject()?.let { parsePlatform(it) },
            desktop = root["desktop"]?.asObject()?.let { parsePlatform(it) },
            android = root["android"]?.asObject()?.let { parsePlatform(it) },
        )
    }

    private fun parsePlatform(map: Map<String, JsonLite.Node>): PlatformRelease =
        PlatformRelease(
            version = map["version"]?.asString() ?: "0",
            versionCode = map["versionCode"]?.asLong(),
            url = map["url"]?.asString()?.takeIf { it.isNotBlank() },
            distribution = map["distribution"]?.asString(),
            sha256 = map["sha256"]?.asString(),
            sha512 = map["sha512"]?.asString(),
            size = map["size"]?.asLong(),
            notes = map["notes"]?.asString(),
            feedUrl = map["feed_url"]?.asString(),
        )
}

/**
 * ارزیابی آپدیت اندروید — پورت منطقی `buildUpdateResponse(platform='android', …)`.
 */
object ApkUpdateEvaluator {

    fun evaluate(
        manifest: ReleaseManifest,
        currentVersion: String,
        currentVersionCode: Long,
        baseUrl: String?,
    ): UpdateCheckResult {
        val latest = manifest.android ?: PlatformRelease()
        val latestVersion = latest.version.ifBlank { "0" }
        val hasUrl = !latest.url.isNullOrBlank()
        val newerByName = VersionCompare.compare(currentVersion, latestVersion) < 0
        val newerByCode = latest.versionCode != null && latest.versionCode > currentVersionCode
        // سرور فقط با compareVersion تصمیم می‌گیرد؛ کلاینت بومی versionCode را هم
        // به‌عنوان سیگنال کمکی برای APK امضاشده لحاظ می‌کند (fail-open برای اعلام،
        // fail-closed برای دانلود).
        val updateAvailable = newerByName || newerByCode
        val sha256 = UpdateHosts.normalizedSha256(latest.sha256)
        val size = UpdateHosts.normalizedSize(latest.size)
        val integrityRequired = hasUrl
        val integrityValid = sha256 != null && size != null
        val resolved = if (hasUrl) UpdateHosts.resolveReleaseUrl(latest.url, baseUrl) else null
        val urlAllowed = resolved != null && UpdateHosts.isAllowedApkUpdateUrl(resolved)
        val distribution = latest.distribution
            ?: if (!hasUrl) "local" else "server"
        return UpdateCheckResult(
            platform = "android",
            current = currentVersion,
            latestVersion = latestVersion,
            versionCode = latest.versionCode,
            updateAvailable = updateAvailable,
            downloadable = updateAvailable && urlAllowed && (!integrityRequired || integrityValid),
            distribution = distribution,
            url = if (urlAllowed) resolved else null,
            notes = latest.notes.orEmpty(),
            sha256 = sha256,
            size = size,
            integrityRequired = integrityRequired,
            integrityValid = integrityValid,
        )
    }

    /**
     * گیت دانلود: حتی اگر UI «آپدیت موجود» نشان دهد، بدون SHA/size/host مجاز
     * دانلود شروع نمی‌شود (fail-closed).
     */
    fun assertDownloadable(result: UpdateCheckResult): Result<Unit> = when {
        !result.updateAvailable -> Result.failure(IllegalStateException("no_update"))
        !result.downloadable -> Result.failure(IllegalStateException("not_downloadable"))
        result.url.isNullOrBlank() -> Result.failure(IllegalStateException("url_missing"))
        !UpdateHosts.isAllowedApkUpdateUrl(result.url) ->
            Result.failure(SecurityException("url_not_allowed"))
        result.sha256 == null -> Result.failure(SecurityException("invalid_sha256"))
        result.size == null -> Result.failure(SecurityException("invalid_size"))
        else -> Result.success(Unit)
    }
}
