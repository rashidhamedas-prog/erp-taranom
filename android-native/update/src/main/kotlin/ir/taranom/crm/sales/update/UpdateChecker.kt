package ir.taranom.crm.sales.update

/**
 * Compares installed versionCode with [ReleaseManifest.android].
 * Download/install is performed by app-layer PackageInstaller; this module is pure policy.
 */
object UpdateChecker {

    fun check(
        manifest: ReleaseManifest,
        installedVersionName: String,
        installedVersionCode: Long,
    ): UpdateCheckResult {
        val android = manifest.android
        val latestCode = android?.versionCode
        val latestName = android?.version ?: "0"
        val url = android?.url
        val sha = android?.sha256
        val available = when {
            latestCode != null -> latestCode > installedVersionCode
            else -> compareVersionNames(latestName, installedVersionName) > 0
        }
        val integrityValid = !sha.isNullOrBlank() && sha.matches(Regex("^[a-f0-9]{64}$", RegexOption.IGNORE_CASE))
        val downloadable = available && !url.isNullOrBlank() && integrityValid
        return UpdateCheckResult(
            platform = "android",
            current = installedVersionName,
            latestVersion = latestName,
            versionCode = latestCode,
            updateAvailable = available,
            downloadable = downloadable,
            distribution = android?.distribution ?: "apk",
            url = url,
            notes = android?.notes.orEmpty(),
            sha256 = sha,
            size = android?.size,
            integrityRequired = true,
            integrityValid = integrityValid,
        )
    }

    /** Simple dotted numeric compare; non-numeric segments → 0. */
    fun compareVersionNames(a: String, b: String): Int {
        val pa = a.split('.', '-', '+').map { it.toIntOrNull() ?: 0 }
        val pb = b.split('.', '-', '+').map { it.toIntOrNull() ?: 0 }
        val n = maxOf(pa.size, pb.size)
        for (i in 0 until n) {
            val da = pa.getOrElse(i) { 0 }
            val db = pb.getOrElse(i) { 0 }
            if (da != db) return da.compareTo(db)
        }
        return 0
    }
}
